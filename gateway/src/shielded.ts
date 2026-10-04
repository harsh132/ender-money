/**
 * The shielded-pool core: register, quote and submit, the same for HTTPS and
 * SMS (like core.ts for public sends). Design and threat model:
 * docs/splitkey-spike.md; the reference is spikes/nova-splitkey/src/gateway.mjs.
 *
 * The gateway holds each user's proving keys (nk, viewing key, authority
 * PUBLIC key), never the authority private key: it can rebuild, prove and
 * relay exactly what the phone signed, and nothing else.
 */
import {
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  hexToBytes,
  isAddress,
  isAddressEqual,
  numberToBytes,
  parseEventLogs,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { inCurve } from '../../protocol/babyjub';
import { AUSD_DECIMALS, AUSD_EIP712, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../protocol/networks';
import { shieldedPoolAbi } from '../../protocol/pool';
import { CIRCUITS, eligible, planCircuit, settle } from '../../protocol/select';
import {
  buildDeposit,
  buildTx,
  depositTx,
  FIELD_SIZE,
  owner,
  packAddress,
  proofArgs,
  provingKeys,
  quoteSeed,
  receiveAuth,
  shieldedKeysFromSeed,
  sign,
  verifySig,
  withdrawOutputs,
  witnessInput,
  witnessJson,
  type Domain,
  type Note,
  type Owner,
  type ProvingKeys,
  type Recipient,
  type Tx,
} from '../../protocol/shielded';
import { b64, formatReply, isPhone, REF_MOD, SESSION_ID_ALPHABET, unb64, withRetrieverHash } from '../../protocol/sms';
import { publicClient } from './chain';
import { GatewayError } from './core';
import type { Env } from './env';
import { canText, sendSms } from './outbound';
import { catchUp, ingest, poolOf, treeFor } from './pool';
import { prove, warm, type Circuit } from './prover';

/** Quote lifetime, and the deadline signed into the transaction: SMS round trips plus proving. */
const QUOTE_TTL_SECONDS = 600;
/** Ref collisions (positions 2^18 apart) are tried exhaustively up to this many combinations. */
const MAX_COMBOS = 64;
/** How long a repeated submit waits for the one in flight (proving takes up to ~5 s, the receipt up to 30 s). */
const IN_FLIGHT_WAIT_MS = 60_000;
const now = () => Math.floor(Date.now() / 1000);
const sum = (ns: Array<{ amount: bigint }>) => ns.reduce((s, n) => s + n.amount, 0n);

export type ShieldedKind = 'pay' | 'withdraw' | 'shield' | 'merge';

// ---------------------------------------------------------------- keys at rest

const aesKey = async (secret: string | undefined) => {
  if (!secret) throw new Error('SHIELDED_KEY_SECRET is not set');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

/** AES-256-GCM under SHIELDED_KEY_SECRET; aad binds the ciphertext to its row and field. base64(iv 12 | ciphertext). */
export const sealKey = async (secret: string | undefined, plaintext: string, aad: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(secret), new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return btoa(String.fromCharCode(...out));
};

export const openKey = async (secret: string | undefined, sealed: string, aad: string) => {
  const b = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: new TextEncoder().encode(aad) },
    await aesKey(secret),
    b.subarray(12),
  );
  return new TextDecoder().decode(pt);
};

type UserRow = { phone: string; network: NetworkName; ax: string; ay: string; nk: string; view_sk: string; owner_key: string; enc_pk: Hex; eoa: Address };
export type ShieldedUser = { phone: string; keys: ProvingKeys; me: Owner; eoa: Address };

const openUser = async (env: Env, r: UserRow): Promise<ShieldedUser> => {
  const aad = (f: string) => `${r.phone}|${r.network}|${f}`;
  const [nk, viewSk] = await Promise.all([openKey(env.SHIELDED_KEY_SECRET, r.nk, aad('nk')), openKey(env.SHIELDED_KEY_SECRET, r.view_sk, aad('view'))]);
  const keys: ProvingKeys = { nk: BigInt(nk), viewSk: hexToBytes(viewSk as Hex), Ax: BigInt(r.ax), Ay: BigInt(r.ay) };
  return { phone: r.phone, keys, me: owner(keys), eoa: r.eoa };
};

/** Every registered user on the network, keys opened (trial decryption). */
export const usersFor = async (env: Env, network: NetworkName) => {
  const { results } = await env.DB.prepare('SELECT * FROM shielded_users WHERE network = ?').bind(network).all<UserRow>();
  return Promise.all(results.map((r) => openUser(env, r)));
};

const userRow = (env: Env, phone: string, network: NetworkName) =>
  env.DB.prepare('SELECT * FROM shielded_users WHERE phone = ? AND network = ?').bind(phone, network).first<UserRow>();

const userFor = async (env: Env, phone: string, network: NetworkName) => {
  const r = await userRow(env, phone, network);
  if (!r) throw new GatewayError('NOUSER', 403);
  return openUser(env, r);
};

const recipientOf = (r: Pick<UserRow, 'owner_key' | 'enc_pk'>): Recipient => ({ ownerKey: BigInt(r.owner_key), encPk: hexToBytes(r.enc_pk) });
const packedOwner = (r: Pick<UserRow, 'owner_key' | 'enc_pk'>) => b64(packAddress(recipientOf(r) as { ownerKey: bigint; encPk: Uint8Array }));

/** The gateway's own shielded keys: they own (and sign for) the zero-value dummy inputs of deposits. */
const authority = (env: Env) => {
  const seed = env.GATEWAY_SHIELDED_SEED;
  if (!seed || !/^(0x)?([0-9a-fA-F]{2}){32,}$/.test(seed)) throw new Error('GATEWAY_SHIELDED_SEED is not set (hex, 32+ bytes)');
  const user = shieldedKeysFromSeed(hexToBytes(seed.startsWith('0x') ? (seed as Hex) : `0x${seed}`));
  const keys = provingKeys(user);
  return { authSk: user.authSk, keys, me: owner(keys) };
};

const domainOf = (network: NetworkName): Domain => ({ chainId: NETWORKS[network].chain.id, pool: poolOf(network).pool });

// ---------------------------------------------------------------- register, notes, address

const decimal = (s: unknown, max: bigint) => {
  if (typeof s !== 'string' || !/^\d{1,78}$/.test(s) || BigInt(s) >= max) throw new GatewayError('bad-keys');
  return BigInt(s);
};

/**
 * Online onboarding: the app hands over nk, the viewing key and the authority
 * public key (decimal strings; viewSk is the 32 key bytes as a big-endian
 * integer). Deposits must come from the number's linked wallet. Idempotent;
 * different keys for a registered number are refused.
 */
export const register = async (env: Env, phone: string, network: NetworkName, raw: Record<string, unknown> | undefined) => {
  poolOf(network);
  const Ax = decimal(raw?.Ax, FIELD_SIZE);
  const Ay = decimal(raw?.Ay, FIELD_SIZE);
  if (!inCurve([Ax, Ay])) throw new GatewayError('bad-keys');
  const keys: ProvingKeys = { Ax, Ay, nk: decimal(raw?.nk, FIELD_SIZE), viewSk: numberToBytes(decimal(raw?.viewSk, 1n << 256n), { size: 32 }) };
  const me = owner(keys);
  const ownerB64 = b64(packAddress(me));

  const link = await env.DB.prepare('SELECT address FROM links WHERE phone = ?').bind(phone).first<{ address: Address }>();
  if (!link) throw new GatewayError('not-registered', 403);
  const eoa = link.address.toLowerCase();

  const existing = await userRow(env, phone, network);
  if (existing) {
    if (existing.owner_key !== me.ownerKey.toString() || existing.enc_pk !== bytesToHex(me.encPk)) throw new GatewayError('key-changed', 409);
    if (existing.eoa !== eoa) await env.DB.prepare('UPDATE shielded_users SET eoa = ? WHERE phone = ? AND network = ?').bind(eoa, phone, network).run();
    return { owner: ownerB64 };
  }
  const aad = (f: string) => `${phone}|${network}|${f}`;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO shielded_users (phone, network, ax, ay, nk, view_sk, owner_key, enc_pk, eoa, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      phone,
      network,
      Ax.toString(),
      Ay.toString(),
      await sealKey(env.SHIELDED_KEY_SECRET, keys.nk.toString(), aad('nk')),
      await sealKey(env.SHIELDED_KEY_SECRET, bytesToHex(keys.viewSk), aad('view')),
      me.ownerKey.toString(),
      bytesToHex(me.encPk),
      eoa,
      now(),
    )
    .run();
  if (inserted.meta.changes !== 1) throw new GatewayError('key-in-use', 409); // the same keys under another number
  return { owner: ownerB64 };
};

/** The number's whole index (spent included) and the tree root, for the app to resync its cache. */
export const notes = async (env: Env, phone: string, network: NetworkName) => {
  poolOf(network);
  if (!(await userRow(env, phone, network))) throw new GatewayError('NOUSER', 403);
  await catchUp(env, network);
  const [{ results }, tree] = await Promise.all([
    env.DB.prepare('SELECT pos, amount, blinding, spent FROM shielded_notes WHERE phone = ? AND network = ? ORDER BY pos')
      .bind(phone, network)
      .all<{ pos: number; amount: string; blinding: string; spent: number }>(),
    treeFor(env, network, []),
  ]);
  return { notes: results.map((n) => ({ pos: n.pos, amount: n.amount, blinding: n.blinding, spent: n.spent === 1 })), root: tree.root.toString() };
};

/** A registered number's shielded address, so the app can pin a contact's key online. */
export const shieldedAddress = async (env: Env, network: NetworkName, phone: string) => {
  poolOf(network);
  const r = await userRow(env, phone, network);
  if (!r) throw new GatewayError('NOUSER', 404);
  return { owner: packedOwner(r) };
};

// ---------------------------------------------------------------- pure checks (unit-tested)

export type Resolved = { nIns: number; ins: Note[]; tx: Tx; tried: number } | { err: 'REF' | 'BADSIG' };

/**
 * SIG refs (tree position mod 2^18) to the user's eligible notes, then the
 * transaction the signature verifies. The selection rule is the phone's
 * policy, not checked here: any 1-12 distinct notes go in the smallest
 * circuit that holds them. Colliding refs: every combination (at most 64) is
 * rebuilt and the one the signature verifies is kept.
 */
export const resolveRefs = (
  notes: Note[],
  refs: number[],
  T: bigint,
  build: (ins: Note[], nIns: number) => Tx,
  verify: (msg: bigint) => boolean,
): Resolved => {
  const nIns = CIRCUITS.find((c) => c >= refs.length);
  if (!refs.length || !nIns || new Set(refs).size !== refs.length) return { err: 'REF' };
  const cands = refs.map((r) => notes.filter((n) => n.pos % REF_MOD === r));
  if (cands.some((c) => !c.length)) return { err: 'REF' };
  let combos: Note[][] = [[]];
  for (const c of cands) combos = combos.flatMap((pre) => c.map((n) => [...pre, n]));
  // ponytail: brute force, capped; collisions need 262,144+ leaves. A longer ref (4 chars) if trees get that big.
  if (combos.length > MAX_COMBOS) return { err: 'REF' };
  let tried = 0;
  for (const ins of combos) {
    if (sum(ins) < T) continue;
    tried++;
    const tx = build(ins, nIns);
    if (verify(tx.msg)) return { nIns, ins, tx, tried };
  }
  return { err: 'BADSIG' };
};

/**
 * Policy, before every proof: inputs belong to one registered user (resolved
 * from that user's own notes) or are the gateway's zero-value deposit dummies;
 * every non-null output is a registered user's note. Value only moves between
 * registered users; withdrawals still go to any address.
 */
export const checkOwners = (tx: Tx, gatewayInputs: boolean, registered: (ownerKey: bigint) => boolean) => {
  if (gatewayInputs && tx.ins.some((i) => i.amount > 0n)) throw new GatewayError('POLICY', 403);
  if (tx.outs.some((o) => o.to.encPk !== null && !registered(o.to.ownerKey))) throw new GatewayError('POLICY', 403);
};

const policy = async (env: Env, network: NetworkName, tx: Tx, gatewayInputs: boolean) => {
  const keys = [...new Set(tx.outs.filter((o) => o.to.encPk !== null).map((o) => o.to.ownerKey.toString()))];
  const { results } = keys.length
    ? await env.DB.prepare(`SELECT owner_key FROM shielded_users WHERE network = ? AND owner_key IN (${keys.map(() => '?').join(',')})`)
        .bind(network, ...keys)
        .all<{ owner_key: string }>()
    : { results: [] };
  const registered = new Set(results.map((r) => r.owner_key));
  checkOwners(tx, gatewayInputs, (k) => registered.has(k.toString()));
};

// ---------------------------------------------------------------- quote

type QuoteRow = {
  id: string;
  phone: string;
  network: NetworkName;
  kind: ShieldedKind;
  to_phone: string | null;
  to_address: Address | null;
  amount: string;
  fee: string;
  exp: number;
  state: 'open' | 'sending' | 'sent';
  ins: string | null;
  tx_hash: Hex | null;
  p: number | null;
  error: string | null;
};

/** Unspent notes of at least 0.001 AUSD that no other quote of this number is spending right now. */
const eligibleNotes = async (env: Env, phone: string, network: NetworkName, exceptQuote = '') => {
  const [{ results }, busy] = await Promise.all([
    env.DB.prepare('SELECT pos, amount, blinding FROM shielded_notes WHERE phone = ? AND network = ? AND spent = 0')
      .bind(phone, network)
      .all<{ pos: number; amount: string; blinding: string }>(),
    // A claim past its deadline can't land any more, so it stops reserving (a run killed mid-proof never strands notes).
    env.DB.prepare(`SELECT ins FROM shielded_quotes WHERE phone = ? AND state = 'sending' AND ins IS NOT NULL AND id != ? AND exp > ?`)
      .bind(phone, exceptQuote, now())
      .all<{ ins: string }>(),
  ]);
  const reserved = new Set(busy.results.flatMap((q) => JSON.parse(q.ins) as number[]));
  return eligible(
    results.map((n) => ({ pos: n.pos, amount: BigInt(n.amount), blinding: BigInt(n.blinding) })),
    reserved,
  );
};

const newId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length]).join('');

export type ShieldedQuoteRequest = { network: NetworkName; kind: ShieldedKind; to?: string; amount?: string };

/**
 * PAY (to a registered number), withdraw (to a 0x address), SHIELD (deposit
 * from the number's own wallet) and MERGE (0 to self). Answers FUNDS / MERGE
 * before quoting, as the phone's selection rule would. `to` in the result:
 * the recipient's packed shielded address (base64) for pay, the address for
 * withdraw, absent otherwise.
 */
export const quote = async (env: Env, phone: string, req: ShieldedQuoteRequest, waitUntil: (p: Promise<unknown>) => void = () => {}) => {
  const { network, kind } = req;
  poolOf(network);
  const user = await userRow(env, phone, network);
  if (!user) throw new GatewayError('NOUSER', 403);

  let amount = 0n;
  if (kind !== 'merge') {
    if (typeof req.amount !== 'string' || !/^\d+(\.\d{1,6})?$/.test(req.amount)) throw new GatewayError('bad-amount');
    amount = parseUnits(req.amount, AUSD_DECIMALS);
    if (amount <= 0n) throw new GatewayError('bad-amount');
  }
  const fee = parseUnits(env.FEE_AUSD, AUSD_DECIMALS);

  let toPhone: string | null = null;
  let toAddress: Address | null = null;
  let to: string | undefined;
  if (kind === 'pay') {
    if (typeof req.to !== 'string' || !isPhone(req.to)) throw new GatewayError('bad-recipient');
    const r = await userRow(env, req.to, network);
    if (!r) throw new GatewayError('NOUSER', 404);
    toPhone = req.to;
    to = packedOwner(r);
  } else if (kind === 'withdraw') {
    if (typeof req.to !== 'string' || !isAddress(req.to)) throw new GatewayError('bad-recipient');
    toAddress = req.to.toLowerCase() as Address;
    to = toAddress;
  } else if (kind !== 'shield' && kind !== 'merge') throw new GatewayError('bad-request');

  let circuit: Circuit = 2;
  if (kind === 'shield') {
    if (!user.eoa) throw new GatewayError('NOEOA', 409);
    const balance = await publicClient(env, network).readContract({ address: NETWORKS[network].ausd, abi: erc20Abi, functionName: 'balanceOf', args: [user.eoa] });
    if (balance < amount + fee) throw new GatewayError('FUNDS', 402);
  } else {
    await catchUp(env, network);
    const plan = planCircuit(await eligibleNotes(env, phone, network), amount + fee);
    if (plan.err) throw new GatewayError(plan.err, 402);
    circuit = plan.circuit as Circuit;
  }

  const exp = now() + QUOTE_TTL_SECONDS;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId();
    // Ids share the SMS SIG namespace with public sessions; skip any a session already uses.
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO shielded_quotes (id, phone, network, kind, to_phone, to_address, amount, fee, exp, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = ?)`,
    )
      .bind(id, phone, network, kind, toPhone, toAddress, amount.toString(), fee.toString(), exp, now(), id)
      .run();
    if (inserted.meta.changes !== 1) continue;
    waitUntil(warm(env, circuit).catch((e) => console.warn('prover warm failed', e instanceof Error ? e.message : e)));
    return { id, exp, fee: formatUnits(fee, AUSD_DECIMALS), ...(to ? { to } : {}) };
  }
  throw new GatewayError('busy', 503);
};

/** The quote's kind, if `id` is this number's shielded quote: routes a public-shaped SMS SIG (a deposit's) by kind. */
export const quoteKind = async (env: Env, phone: string, id: string) =>
  (await env.DB.prepare('SELECT kind FROM shielded_quotes WHERE id = ? AND phone = ?').bind(id, phone).first<{ kind: ShieldedKind }>())?.kind;

// ---------------------------------------------------------------- submit

export type SubmitRequest = { id: string; refs?: number[]; sig?: Uint8Array; signature?: Hex };
export type SubmitResult = { tx: Hex; p?: number; pending?: true; kind: ShieldedKind; amount: string; to: string };

const resultOf = (q: QuoteRow): SubmitResult => ({
  tx: q.tx_hash!,
  ...(q.p !== null ? { p: q.p } : {}),
  ...(q.state !== 'sent' ? { pending: true as const } : {}),
  kind: q.kind,
  amount: formatUnits(BigInt(q.amount), AUSD_DECIMALS),
  to: q.to_phone ?? q.to_address ?? q.phone,
});

const firstLeaf = (network: NetworkName, logs: Log[]) => {
  const pool = poolOf(network).pool.toLowerCase();
  const leaf = parseEventLogs({ abi: shieldedPoolAbi, eventName: 'NewCommitment', logs: logs.filter((l) => l.address.toLowerCase() === pool) })[0];
  return leaf ? Number(leaf.args.index) : null;
};

/** A landed transaction: index its logs now (leaves, nullifiers, notes) and close the quote. */
const finalize = async (env: Env, q: QuoteRow, txHash: Hex) => {
  const receipt = await publicClient(env, q.network).getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    // Reverted on-chain: nothing was spent, so the quote reopens for a retry.
    await env.DB.prepare(`UPDATE shielded_quotes SET state = 'open', tx_hash = NULL, ins = NULL, error = 'failed' WHERE id = ?`).bind(q.id).run();
    throw new GatewayError('failed');
  }
  await ingest(env, q.network, receipt.logs);
  const p = firstLeaf(q.network, receipt.logs);
  await env.DB.prepare(`UPDATE shielded_quotes SET state = 'sent', tx_hash = ?, p = ?, ins = NULL WHERE id = ?`).bind(txHash, p, q.id).run();
  return { ...q, state: 'sent' as const, tx_hash: txHash, p };
};

/**
 * Sign and settle (`/shielded/submit` and SMS SIG). Claims the quote, rebuilds
 * what was signed from the gateway's own record, checks the signature, the
 * policy, proves, relays through the network's Sponsor (one sender, one nonce
 * sequence) and indexes the receipt. Any refusal reopens the quote, so a
 * corrected retry before expiry works; a repeat after success returns the
 * same transaction.
 */
export const submit = async (env: Env, phone: string, req: SubmitRequest, waited = 0): Promise<SubmitResult> => {
  const q = await env.DB.prepare(
    `UPDATE shielded_quotes SET state = 'sending', error = NULL WHERE id = ? AND phone = ? AND state = 'open' AND exp > ? RETURNING *`,
  )
    .bind(req.id, phone, now())
    .first<QuoteRow>();
  if (!q) {
    const existing = await env.DB.prepare('SELECT * FROM shielded_quotes WHERE id = ? AND phone = ?').bind(req.id, phone).first<QuoteRow>();
    if (!existing) throw new GatewayError('UNKNOWN', 404);
    if (existing.tx_hash) {
      // A send that timed out: if it has landed since, settle it now.
      if (existing.state === 'sending') return resultOf(await finalize(env, existing, existing.tx_hash).catch(() => existing));
      return resultOf(existing);
    }
    // Another submit of this quote (the app's HTTPS call and its SMS fallback, or a retry) is proving or sending:
    // wait for its outcome rather than fail. If it was refused, the quote reopens and this one tries itself.
    if (existing.state === 'sending' && existing.exp > now() && waited < IN_FLIGHT_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 500));
      return submit(env, phone, req, waited + 500);
    }
    if (existing.state === 'sending') throw new GatewayError('in-progress', 409);
    throw new GatewayError('EXPIRED', 410);
  }
  try {
    const sent = q.kind === 'shield' ? await deposit(env, q, req) : await transfer(env, q, req);
    return resultOf(sent);
  } catch (e) {
    const code = e instanceof GatewayError ? e.code : 'internal';
    await env.DB.prepare(`UPDATE shielded_quotes SET state = 'open', ins = NULL, error = ? WHERE id = ? AND tx_hash IS NULL`).bind(code, q.id).run();
    throw e;
  }
};

/** proofArgs with outputCommitments as the ABI's 2-tuple. */
const poolArgs = (...a: Parameters<typeof proofArgs>) => {
  const args = proofArgs(...a);
  return { ...args, outputCommitments: [args.outputCommitments[0]!, args.outputCommitments[1]!] as const };
};

/** pool.transact or depositWithAuthorization, sent directly by the gateway key (the pool checks msg.sender). */
const relay = async (env: Env, q: QuoteRow, data: Hex): Promise<QuoteRow> => {
  const r = await env.SPONSOR.get(env.SPONSOR.idFromName(q.network)).submit(q.network, { kind: 'direct', target: poolOf(q.network).pool, data });
  if (r.txHash) {
    // Sent: record the hash first, so a failure below never reopens a quote whose transaction exists.
    await env.DB.prepare('UPDATE shielded_quotes SET tx_hash = ? WHERE id = ?').bind(r.txHash, q.id).run();
    if (r.ok) return finalize(env, q, r.txHash);
    // Receipt not seen yet: the quote stays claimed; a repeated submit settles it.
    if (r.error === 'timeout') return { ...q, tx_hash: r.txHash };
    if (r.error === 'failed') return finalize(env, q, r.txHash); // reopens it
  }
  throw new GatewayError(r.error, r.error === 'send-failed' ? 503 : 400);
};

const transfer = async (env: Env, q: QuoteRow, req: SubmitRequest) => {
  const { sig, refs } = req;
  if (!sig || sig.length !== 64 || !refs?.length || refs.some((r) => !Number.isInteger(r) || r < 0 || r >= REF_MOD)) throw new GatewayError('bad-request');
  const network = q.network;
  const user = await userFor(env, q.phone, network);
  let recipient: Recipient | null = null;
  if (q.kind === 'pay') {
    const r = await userRow(env, q.to_phone!, network);
    if (!r) throw new GatewayError('NOUSER', 404);
    recipient = recipientOf(r);
  }
  await catchUp(env, network);

  const amount = BigInt(q.amount);
  const fee = BigInt(q.fee);
  const domain = domainOf(network);
  // The same build the phone did: change under 0.001 AUSD goes to the fee; a change-free withdrawal has two null outputs.
  const build = (ins: Note[], nIns: number) => {
    const s = settle(sum(ins), amount, fee);
    const change = { amount: s.change, to: user.me };
    const common = { me: user.me, nIns, inputs: ins, fee: s.fee, relayer: FEE_RECIPIENT, deadline: q.exp, domain };
    if (q.kind === 'withdraw') return buildTx({ ...common, outputs: withdrawOutputs(change), extAmount: -amount, recipient: q.to_address! });
    return buildTx({ ...common, outputs: [{ amount, to: recipient ?? user.me }, change] });
  };
  const r = resolveRefs(await eligibleNotes(env, q.phone, network, q.id), refs, amount + fee, build, (msg) => verifySig(sig, msg, user.keys));
  if ('err' in r) throw new GatewayError(r.err);
  await env.DB.prepare('UPDATE shielded_quotes SET ins = ? WHERE id = ?').bind(JSON.stringify(r.ins.map((n) => n.pos)), q.id).run();

  await policy(env, network, r.tx, false);
  const input = witnessInput(r.tx, await treeFor(env, network, r.ins.map((n) => n.pos)), user.keys, sig);
  const { proof } = await prove(env, r.nIns as Circuit, witnessJson(input));
  const data = encodeFunctionData({ abi: shieldedPoolAbi, functionName: 'transact', args: [poolArgs(proof, input), r.tx.extData] });
  const sent = await relay(env, q, data);

  if (q.kind === 'pay' && q.to_phone !== q.phone && sent.state === 'sent' && sent.p !== null) {
    await gotAlert(env, q.to_phone!, sent.tx_hash!, { amount: formatUnits(amount, AUSD_DECIMALS), from: q.phone, p: sent.p, blinding: r.tx.outs[0]!.blinding }).catch((e) =>
      console.error('got alert failed', e instanceof Error ? e.message : e),
    );
  }
  return sent;
};

const deposit = async (env: Env, q: QuoteRow, req: SubmitRequest) => {
  const signature = req.signature;
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new GatewayError('bad-request');
  const network = q.network;
  const { pool } = poolOf(network);
  const user = await userFor(env, q.phone, network);
  if (!user.eoa) throw new GatewayError('NOEOA', 409);
  const amount = BigInt(q.amount);

  // The deposit the phone built alone (same inputs, same bytes); the EIP-3009 nonce pins extData and both outputs.
  const dep = buildDeposit({
    me: user.me,
    outputs: [
      { amount, to: user.me },
      { amount: 0n, to: user.me },
    ],
    fee: BigInt(q.fee),
    relayer: FEE_RECIPIENT,
    deadline: q.exp,
    seed: quoteSeed(q.id, q.exp),
    domain: domainOf(network),
  });
  const auth = receiveAuth({ address: NETWORKS[network].ausd, ...AUSD_EIP712 }, NETWORKS[network].chain.id, {
    from: user.eoa,
    to: pool,
    value: dep.value,
    validBefore: q.exp,
    nonce: dep.nonce,
  });
  // Cheap pre-check before proving: the wallet's own key signed (also true for a 7702 account's root key).
  const signer = await recoverTypedDataAddress({ ...auth, signature }).catch(() => null);
  if (!signer || !isAddressEqual(signer, user.eoa)) throw new GatewayError('BADSIG');
  // Deposits only from a registered user's wallet: user.eoa is, by construction; checked again against the table.
  const registered = await env.DB.prepare('SELECT 1 FROM shielded_users WHERE network = ? AND eoa = ?').bind(network, user.eoa.toLowerCase()).first();
  if (!registered) throw new GatewayError('POLICY', 403);

  await catchUp(env, network);
  const gw = authority(env);
  const tx = depositTx(gw.me, dep);
  await policy(env, network, tx, true);
  const input = witnessInput(tx, await treeFor(env, network, []), gw.keys, sign(gw.authSk, tx.msg));
  const { proof } = await prove(env, 2, witnessJson(input));
  const data = encodeFunctionData({
    abi: shieldedPoolAbi,
    functionName: 'depositWithAuthorization',
    args: [poolArgs(proof, input), tx.extData, user.eoa, signature],
  });
  return relay(env, q, data);
};

/** `Got …` to the recipient of a private payment the gateway relayed, if they take texts (one per tx, alerts_sent). */
const gotAlert = async (env: Env, to: string, txHash: Hex, got: { amount: string; from: string; p: number; blinding: bigint }) => {
  const link = await env.DB.prepare('SELECT alerts FROM links WHERE phone = ?').bind(to).first<{ alerts: number }>();
  if (!link?.alerts || !canText(to)) return;
  const fresh = await env.DB.prepare('INSERT OR IGNORE INTO alerts_sent (tx_hash, phone) VALUES (?, ?)').bind(txHash, to).run();
  if (fresh.meta.changes !== 1) return;
  await sendSms(env, to, withRetrieverHash(formatReply({ kind: 'got', ...got }), env.SMS_RETRIEVER_HASH));
};

/** base64 (padded or not) of a 64-byte signature, as /shielded/submit takes it. */
export const sigFromBase64 = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9+/]{86}(==)?$/.test(s) ? unb64(s.replace(/=+$/, ''), 64) : null);

/**
 * Private balance (the shielded pool, testnet only): key derivation, the
 * routing rule, quote checks, the note cache and building what the phone
 * signs. Pure (no React Native imports), so it runs under `bun test`.
 * Protocol: ../../../protocol/shielded.ts; design: docs/splitkey-spike.md.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { formatUnits, parseUnits, stringToBytes, type Address, type Hex, type LocalAccount } from 'viem';
import { AUSD_DECIMALS, AUSD_EIP712, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../../protocol/networks';
import { CIRCUITS, eligible, planCircuit, selectNotes, settle } from '../../../protocol/select';
import {
  buildDeposit,
  buildTx,
  owner,
  provingKeys,
  quoteSeed,
  receiveAuth,
  shieldedKeysFromSeed,
  sign,
  unpackAddress,
  withdrawOutputs,
  type Note,
  type User,
} from '../../../protocol/shielded';
import { decodePrivateAddress } from '../../../protocol/recipient';
import { b64, type Reply } from '../../../protocol/sms';
import { MAX_FEE } from './config';
import type { State } from './store';

const units = (s: string) => parseUnits(s, AUSD_DECIMALS);

// ---------------------------------------------------------------- keys

/**
 * The shielded keys come from the same passkey PRF output as the wallet key,
 * under their own HKDF label (the wallet key goes PRF -> BIP-39 instead).
 */
export const shieldedUser = (prfOutput: Uint8Array): User => {
  const seed = hkdf(sha256, prfOutput, undefined, stringToBytes('ender/shielded/v1/seed'), 32);
  try {
    return shieldedKeysFromSeed(seed);
  } finally {
    seed.fill(0);
  }
};

export const POOL_NETWORKS = (Object.keys(NETWORKS) as NetworkName[]).filter((n) => NETWORKS[n].pool);
export const hasPool = (n: NetworkName) => !!NETWORKS[n].pool;
const domainOf = (n: NetworkName) => ({ chainId: NETWORKS[n].chain.id, pool: NETWORKS[n].pool! });

// ---------------------------------------------------------------- the note cache

/** One note, as persisted (bigints as decimal strings; amount in AUSD base units). */
export type CachedNote = { pos: number; amount: string; blinding: string; spent: boolean };

/** A private payment, shield or merge that was signed and is waiting for its Sent / Shielded (matched by id). */
export type Awaiting = {
  id: string;
  kind: 'pay' | 'withdraw' | 'shield' | 'merge';
  /** AUSD, as the user typed it (`0` for a merge); matches an older gateway's id-less Sent / Shielded. */
  amount: string;
  /** Tree positions of the real inputs: excluded from selection until settled. */
  ins: number[];
  /** Outputs that come back to us: index in the transaction, amount (base units), blinding. */
  outs: { i: number; amount: string; blinding: string }[];
  exp: number;
  phone?: string;
  /** The recipient's shielded address (base64), pinned to `phone` once the payment settles. */
  pin?: string;
};

export type Cache = { notes: CachedNote[]; awaiting: Awaiting[]; pins: Record<string, string> };

export const toNotes = (ns: CachedNote[]) => ns.map((n) => ({ pos: n.pos, amount: BigInt(n.amount), blinding: BigInt(n.blinding), spent: n.spent }));
export const pendingOf = (awaiting: Awaiting[]) => new Set(awaiting.flatMap((a) => a.ins));

/** Notes the selection rule may use: unspent, at least 0.001 AUSD, not an input of a payment still waiting. */
export const usable = (c: Pick<Cache, 'notes' | 'awaiting'>) => eligible(toNotes(c.notes), pendingOf(c.awaiting));

/** Private balance shown to the user (AUSD): notes under 0.001 don't count. */
export const privateBalance = (notes: CachedNote[]) => formatUnits(eligible(toNotes(notes)).reduce((s, n) => s + n.amount, 0n), AUSD_DECIMALS);

const addNote = (notes: CachedNote[], n: CachedNote) => (notes.some((x) => x.pos === n.pos) ? notes : [...notes, n].sort((a, b) => a.pos - b.pos));

/** A payment settled: its inputs are spent, our outputs land at p + i, the recipient's key is pinned. */
export const settleAwaiting = (c: Cache, a: Awaiting, p?: number): Cache => {
  let notes = c.notes.map((n) => (a.ins.includes(n.pos) ? { ...n, spent: true } : n));
  if (p !== undefined) for (const o of a.outs) notes = addNote(notes, { pos: p + o.i, amount: o.amount, blinding: o.blinding, spent: false });
  return {
    notes,
    awaiting: c.awaiting.filter((x) => x !== a),
    pins: a.pin && a.phone ? { ...c.pins, [a.phone]: a.pin } : c.pins,
  };
};

/**
 * An SMS reply: Sent / Shielded (the waiting payment with that id), Got (a
 * note someone sent us). Returns the settled payment too, so the caller can
 * mark it in Activity. Anything else: unchanged. An older gateway's id-less
 * Sent / Shielded falls back to the oldest waiting one of that kind and amount.
 */
export const applyReply = (c: Cache, r: Reply): { cache: Cache; settled?: Awaiting } => {
  if (r.kind === 'got')
    return { cache: { ...c, notes: addNote(c.notes, { pos: r.p, amount: units(r.amount).toString(), blinding: r.blinding.toString(), spent: false }) } };
  if (r.kind !== 'sent' && r.kind !== 'shielded') return { cache: c };
  const a = c.awaiting.find((x) =>
    r.id ? x.id === r.id : (x.kind === 'shield') === (r.kind === 'shielded') && units(x.amount) === units(r.amount),
  );
  return a ? { cache: settleAwaiting(c, a, r.p), settled: a } : { cache: c };
};

/**
 * The network a text names: `[Test] ` testnet, no tag mainnet. The app's mode
 * is display only. A private-only text (private Q, Shielded, Got) without a
 * tag came from an older gateway: the network with the pool.
 */
export const textNetwork = (r: Reply): NetworkName => {
  const named: NetworkName = r.test ? 'testnet' : 'mainnet';
  return (r.kind === 'shieldedQuote' || r.kind === 'shielded' || r.kind === 'got') && !hasPool(named) ? POOL_NETWORKS[0]! : named;
};

/**
 * The note cache a private text (Sent, Shielded, Got) goes to: the network
 * it names; with no pool there (an older gateway didn't tag private texts),
 * the network that has one. Never the network the app happens to show.
 */
export const notesNetwork = (r: Reply): NetworkName => {
  const named: NetworkName = r.test ? 'testnet' : 'mainnet';
  return hasPool(named) ? named : POOL_NETWORKS[0]!;
};

/**
 * A Sent / Shielded / Got text, filed under the network it names: the state
 * patch for that network's notes, waiting payments and pins, and the payment
 * it settled. Nothing when that network has no registered private balance.
 */
export const fileReply = (s: Pick<State, 'notes' | 'awaiting' | 'shieldedPins' | 'shielded'>, r: Reply) => {
  const network = notesNetwork(r);
  if (!s.shielded?.registered.includes(network)) return undefined;
  const { cache, settled } = applyReply({ notes: s.notes[network] ?? [], awaiting: s.awaiting[network] ?? [], pins: s.shieldedPins }, r);
  const patch = { notes: { ...s.notes, [network]: cache.notes }, awaiting: { ...s.awaiting, [network]: cache.awaiting }, shieldedPins: cache.pins };
  return { network, patch, settled };
};

/** One payment spends at most this many notes (the largest circuit); past it, Home offers a merge. */
export const MERGE_OVER = CIRCUITS[CIRCUITS.length - 1]!;
/** Home's Merge pill: a network with a pool and more usable notes than one payment can spend. */
export const canMerge = (network: NetworkName, c: Pick<Cache, 'notes' | 'awaiting'>) => hasPool(network) && usable(c).length > MERGE_OVER;

/**
 * Online resync: the gateway's index replaces the cache. A waiting payment
 * whose inputs are now spent (or whose output appeared) settled; one past its
 * deadline that didn't never will.
 */
export const resync = (c: Cache, server: CachedNote[], now = Date.now()) => {
  const settled: Awaiting[] = [];
  const expired: Awaiting[] = [];
  const awaiting = c.awaiting.filter((a) => {
    const done =
      (a.ins.length > 0 && a.ins.every((pos) => server.find((n) => n.pos === pos)?.spent)) ||
      a.outs.some((o) => server.some((n) => n.blinding === o.blinding));
    if (done) settled.push(a);
    else if (a.exp * 1000 < now) expired.push(a);
    return !done && a.exp * 1000 >= now;
  });
  const pins = settled.reduce((p, a) => (a.pin && a.phone ? { ...p, [a.phone]: a.pin } : p), c.pins);
  return { cache: { notes: server, awaiting, pins }, settled, expired };
};

// ---------------------------------------------------------------- routing

/**
 * Private when the recipient can take it (an Ender number with a shielded
 * address, or any 0x address as a withdrawal) and the private notes alone can
 * pay amount + fee under the selection rule. Otherwise public, as before.
 * No mixing: a payment is all private or all public. A wallet whose notes
 * need a merge first (ERR MERGE) pays publicly.
 */
export const chooseRoute = ({
  recipientPrivate,
  cache,
  amount,
  deliver = 'AUSD',
}: {
  recipientPrivate: boolean;
  cache: Pick<Cache, 'notes' | 'awaiting'>;
  amount: string;
  deliver?: 'AUSD' | 'CTK';
}): 'private' | 'public' => {
  if (!recipientPrivate || deliver === 'CTK') return 'public';
  return planCircuit(usable(cache), units(amount) + units(MAX_FEE)).err ? 'public' : 'private';
};

// ---------------------------------------------------------------- quotes

/** to: a 0x address (withdraw), the number or the private address (ender1…) paid (pay). A merge pays 0 to ourselves. */
export type PrivateDraft = { kind: 'pay' | 'withdraw' | 'shield' | 'merge'; amount: string; to?: string; phone?: string };
/** to: the recipient's 64-byte shielded address (pay), a 0x address (withdraw), none (shield, merge). */
export type ShieldedQuote = { id: string; exp: number; fee: string; to?: Address | Uint8Array };
export type Refusal = { code: string; message: string };

/** What the phone checks before signing (docs/splitkey-spike.md "What the phone checks"). Returns why it refuses, if it does. */
export const checkShieldedQuote = (d: PrivateDraft, q: ShieldedQuote, pinned?: string, now = Date.now()): Refusal | undefined => {
  const t = Math.floor(now / 1000);
  if (q.exp <= t) return { code: 'expired', message: 'That quote has expired. Try again.' };
  if (q.exp > t + 3600) return { code: 'bad-quote', message: "The quote's deadline is out of range. Nothing was sent." };
  if (units(q.fee) > units(MAX_FEE)) return { code: 'fee-too-high', message: `The fee came back as $${q.fee}. Nothing was sent.` };
  const mismatch = { code: 'recipient-mismatch', message: 'The gateway quoted a different recipient. Nothing was sent.' };
  if (d.kind === 'shield' || d.kind === 'merge') return q.to === undefined ? undefined : mismatch;
  if (d.kind === 'withdraw') return typeof q.to === 'string' && q.to.toLowerCase() === d.to?.toLowerCase() ? undefined : mismatch;
  if (!(q.to instanceof Uint8Array) || q.to.length !== 64) return mismatch;
  // Paid to a private address: the quote must name exactly that key.
  const named = d.to ? decodePrivateAddress(d.to) : null;
  if (named && b64(named) !== b64(q.to)) return mismatch;
  if (pinned && pinned !== b64(q.to))
    return { code: 'KEY CHANGED', message: "This contact's private address changed since you last paid them. Nothing was sent." };
  return undefined;
};

// ---------------------------------------------------------------- signing

const sum = (ns: { amount: bigint }[]) => ns.reduce((s, n) => s + n.amount, 0n);

/**
 * Pick the notes, build the transaction the gateway will rebuild, sign it with
 * the authority key. The heavy part (Poseidon, BabyJubJub): run it after the
 * UI has painted. rng: tests only.
 */
export const signPrivate = (
  user: User,
  cache: Pick<Cache, 'notes' | 'awaiting'>,
  d: PrivateDraft,
  q: ShieldedQuote,
  network: NetworkName,
  rng?: (k: number) => number,
): { err: 'FUNDS' | 'MERGE' } | { refs: number[]; sig: Uint8Array; awaiting: Awaiting } => {
  const me = owner(provingKeys(user));
  const fee = units(q.fee);
  const amount = units(d.amount);
  const sel = selectNotes(usable(cache), amount + fee, rng);
  if (sel.err) return { err: sel.err };
  const inputs: Note[] = sel.ins.map(({ pos, amount, blinding }) => ({ pos, amount, blinding }));
  const s = settle(sum(inputs), amount, fee);
  const change = { amount: s.change, to: me };
  const common = { me, nIns: sel.circuit, inputs, fee: s.fee, relayer: FEE_RECIPIENT, deadline: q.exp, domain: domainOf(network) };
  const tx =
    d.kind === 'withdraw'
      ? buildTx({ ...common, outputs: withdrawOutputs(change), extAmount: -amount, recipient: d.to as Address })
      : // A merge: 0 to ourselves (as the gateway rebuilds it), the inputs less the fee come back as one note at p+1.
        buildTx({ ...common, outputs: [{ amount, to: d.kind === 'merge' ? me : unpackAddress(q.to as Uint8Array) }, change] });
  const refs = inputs.map((n) => n.pos);
  const outs = tx.outs.flatMap((o, i) => (o.to === me && o.amount > 0n ? [{ i, amount: o.amount.toString(), blinding: o.blinding.toString() }] : []));
  return {
    refs,
    sig: sign(user.authSk, tx.msg),
    awaiting: {
      id: q.id,
      kind: d.kind,
      amount: d.amount,
      ins: refs,
      outs,
      exp: q.exp,
      ...(d.kind === 'pay' ? { phone: d.phone, pin: b64(q.to as Uint8Array) } : {}),
    },
  };
};

/**
 * A shield: the phone builds the deposit alone and its root key signs AUSD's
 * ReceiveWithAuthorization{from: wallet, to: pool, value: amount + fee, nonce}.
 */
export const signShield = async (user: User, account: LocalAccount, amount: string, q: ShieldedQuote, network: NetworkName) => {
  const me = owner(provingKeys(user));
  const net = NETWORKS[network];
  const domain = domainOf(network);
  const dep = buildDeposit({
    me,
    outputs: [{ amount: units(amount), to: me }, { amount: 0n, to: me }],
    fee: units(q.fee),
    relayer: FEE_RECIPIENT,
    deadline: q.exp,
    seed: quoteSeed(q.id, q.exp),
    domain,
  });
  const signature: Hex = await account.signTypedData!(
    receiveAuth({ address: net.ausd, ...AUSD_EIP712 }, domain.chainId, { from: account.address, to: domain.pool, value: dep.value, validBefore: q.exp, nonce: dep.nonce }),
  );
  const awaiting: Awaiting = { id: q.id, kind: 'shield', amount, ins: [], outs: [{ i: 0, amount: units(amount).toString(), blinding: dep.outs[0]!.blinding.toString() }], exp: q.exp };
  return { signature, awaiting };
};

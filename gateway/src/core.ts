/**
 * The session core: account, quote and sign, the same for HTTPS and SMS.
 * Callers pass the phone number they've authenticated (JWT claim or SMS
 * sender); everything else is checked here.
 */
import { encodeFunctionData, formatUnits, isAddress, parseUnits, recoverTypedDataAddress, type Address, type Hex, type SignedAuthorization } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import {
  caliburAbi,
  encodeExecute,
  erc20Abi,
  isDelegatedToCalibur,
  pairAbi,
  signedBatchTypedData,
  swapWithFee,
  transferWithFee,
  whitelisterAbi,
  type Call,
} from '../../protocol/calibur';
import { AUSD_DECIMALS, CALIBUR, CTK_DECIMALS, FEE_RECIPIENT, MULTICALL3, NETWORKS, type NetworkName } from '../../protocol/networks';
import { enderId, parseEnderId } from '../../protocol/names';
import { isPhone, SESSION_ID_ALPHABET, type Deliver } from '../../protocol/sms';
import { publicClient, tokenSenders } from './chain';
import { inrPerUsd } from './fx';
import type { Env } from './env';

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

const QUOTE_TTL_SECONDS = 300;
const now = () => Math.floor(Date.now() / 1000);

type Link = { phone: string; address: Address; network: NetworkName; label: string | null };
type SessionRow = {
  id: string;
  phone: string;
  network: NetworkName;
  from_address: Address;
  to_address: Address;
  amount: string;
  fee: string;
  deliver: Deliver;
  /** CTK base units the recipient gets at least, for CTK delivery. */
  min_out: string | null;
  nonce: string;
  deadline: number;
  state: 'open' | 'sending' | 'sent';
  tx_hash: Hex | null;
  error: string | null;
  expires_at: number;
};

export type Quote = {
  id: string;
  network: NetworkName;
  from: Address;
  to: Address;
  amount: string;
  fee: string;
  /** CTK the recipient gets, for CTK delivery. */
  out?: string;
  nonce: string;
  deadline: number;
  calls: Array<{ to: Address; value: string; data: Hex }>;
};

const linkFor = async (env: Env, phone: string): Promise<Link> => {
  const link = await env.DB.prepare('SELECT phone, address, network, label FROM links WHERE phone = ?').bind(phone).first<Link>();
  if (!link) throw new GatewayError('not-registered', 403);
  return link;
};

/** Remember the network the phone last used, so the SMS path follows it. */
const useNetwork = async (env: Env, link: Link, network: NetworkName | undefined) => {
  if (!network || network === link.network) return link.network;
  await env.DB.prepare('UPDATE links SET network = ? WHERE phone = ?').bind(network, link.phone).run();
  return network;
};

const callsFor = (env: Env, s: Pick<SessionRow, 'network' | 'to_address' | 'amount' | 'fee' | 'deliver' | 'min_out' | 'deadline'>): Call[] => {
  const net = NETWORKS[s.network];
  if (s.deliver === 'CTK')
    return swapWithFee(net.ausd, net.pair!, net.ctk!, s.to_address, BigInt(s.amount), BigInt(s.min_out!), BigInt(s.deadline), FEE_RECIPIENT, BigInt(s.fee));
  return transferWithFee(net.ausd, s.to_address, BigInt(s.amount), FEE_RECIPIENT, BigInt(s.fee));
};

const toQuote = (env: Env, s: SessionRow): Quote => ({
  id: s.id,
  network: s.network,
  from: s.from_address,
  to: s.to_address,
  amount: formatUnits(BigInt(s.amount), AUSD_DECIMALS),
  fee: formatUnits(BigInt(s.fee), AUSD_DECIMALS),
  ...(s.min_out ? { out: formatUnits(BigInt(s.min_out), CTK_DECIMALS) } : {}),
  nonce: s.nonce,
  deadline: s.deadline,
  calls: callsFor(env, s).map((c) => ({ to: c.to, value: c.value.toString(), data: c.data })),
});

/** Balance, Calibur nonce and delegation status in one batched round trip. */
const readAccount = async (env: Env, network: NetworkName, address: Address) => {
  const pub = publicClient(env, network);
  const [[balance, seq], code] = await Promise.all([
    pub.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: [
        { address: NETWORKS[network].ausd, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
        { address, abi: caliburAbi, functionName: 'getSeq', args: [0n] },
      ],
    }),
    pub.getCode({ address }),
  ]);
  if (balance.status !== 'success') throw new GatewayError('rpc-unavailable', 503);
  return {
    balance: balance.result,
    nonce: seq.status === 'success' ? seq.result : 0n,
    delegated: isDelegatedToCalibur(code),
  };
};

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const newSessionId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length]).join('');
};

// ---------------------------------------------------------------- account

export const account = async (env: Env, phone: string, requested?: NetworkName) => {
  const link = await linkFor(env, phone);
  const network = await useNetwork(env, link, requested);
  const [a, inr] = await Promise.all([readAccount(env, network, link.address), inrPerUsd()]);
  return {
    address: link.address,
    /** The Ender ID; null for an account made before names (the app then asks for one). */
    name: link.label ? enderId(link.label) : null,
    network,
    balance: formatUnits(a.balance, AUSD_DECIMALS),
    nonce: a.nonce.toString(),
    delegated: a.delegated,
    inr,
  };
};

// ---------------------------------------------------------------- quote

export type QuoteRequest = { network?: NetworkName; to: string; amount: string; deliver?: Deliver };

export const quote = async (env: Env, phone: string, req: QuoteRequest): Promise<Quote> => {
  const link = await linkFor(env, phone);
  const network = await useNetwork(env, link, req.network);
  const deliver = req.deliver ?? 'AUSD';
  // CTK delivery uses Agora's testnet pair; the mainnet pair needs Agora KYC.
  if (deliver === 'CTK' && !NETWORKS[network].pair) throw new GatewayError('unsupported');
  if (!/^\d+(\.\d{1,6})?$/.test(req.amount)) throw new GatewayError('bad-amount');
  const amount = parseUnits(req.amount, AUSD_DECIMALS);
  if (amount <= 0n) throw new GatewayError('bad-amount');

  let to: Address;
  const label = parseEnderId(req.to);
  if (isAddress(req.to)) to = req.to.toLowerCase() as Address;
  else if (isPhone(req.to)) {
    const recipient = await env.DB.prepare('SELECT address FROM links WHERE phone = ?').bind(req.to).first<{ address: Address }>();
    if (!recipient) throw new GatewayError('not-on-ender', 404);
    to = recipient.address;
  } else if (label) {
    const recipient = await env.DB.prepare('SELECT address FROM links WHERE label = ?').bind(label).first<{ address: Address }>();
    if (!recipient) throw new GatewayError('unknown-name', 404);
    to = recipient.address;
  } else throw new GatewayError('bad-recipient');
  if (to === link.address.toLowerCase()) throw new GatewayError('self-transfer');
  // What it was asked for when a number or an Ender ID, which its Sent text names (sms.ts); null for an address.
  const recipient = isAddress(req.to) ? null : label ? enderId(label) : req.to;

  // A repeated request (say, the same SEND delivered twice) gets the quote that's still open.
  const requestHash = await sha256([phone, network, to, amount, deliver].join('|'));
  const open = await env.DB.prepare(
    `SELECT * FROM sessions WHERE phone = ? AND request_hash = ? AND state = 'open' AND expires_at > ? LIMIT 1`,
  )
    .bind(phone, requestHash, now())
    .first<SessionRow>();
  if (open) return toQuote(env, open);

  const fee = parseUnits(env.FEE_AUSD, AUSD_DECIMALS);
  const a = await readAccount(env, network, link.address);
  if (!a.delegated) throw new GatewayError('not-delegated', 409);
  if (a.balance < amount + fee) throw new GatewayError('low-balance', 402);

  const minOut = deliver === 'CTK' ? await ctkQuote(env, network, link.address, amount) : null;

  const deadline = now() + QUOTE_TTL_SECONDS;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newSessionId();
    const row: SessionRow = {
      id,
      phone,
      network,
      from_address: link.address.toLowerCase() as Address,
      to_address: to,
      amount: amount.toString(),
      fee: fee.toString(),
      deliver,
      min_out: minOut?.toString() ?? null,
      nonce: a.nonce.toString(),
      deadline,
      state: 'open',
      tx_hash: null,
      error: null,
      expires_at: deadline,
    };
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO sessions (id, phone, network, from_address, to_address, amount, fee, deliver, min_out, nonce, deadline, request_hash, expires_at, recipient)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, phone, network, row.from_address, to, row.amount, row.fee, deliver, row.min_out, row.nonce, deadline, requestHash, deadline, recipient)
      .run();
    if (inserted.meta.changes === 1) return toQuote(env, row);
  }
  throw new GatewayError('busy', 503);
};

/**
 * The pair's fixed-price output for `amount`, after making sure the sender may
 * swap. The first CTK quote whitelists the sender through the testnet
 * whitelister (permissionless, gateway pays), which takes one batch.
 */
const ctkQuote = async (env: Env, network: NetworkName, from: Address, amount: bigint) => {
  const net = NETWORKS[network];
  const pub = publicClient(env, network);
  const allowed = () => pub.readContract({ address: net.pair!, abi: pairAbi, functionName: 'hasRole', args: ['APPROVED_SWAPPER', from] });
  if (!(await allowed())) {
    const result = await env.SPONSOR.get(env.SPONSOR.idFromName(network)).submit(network, {
      kind: 'plain',
      target: net.whitelister!,
      data: encodeFunctionData({ abi: whitelisterAbi, functionName: 'setApprovedSwapper', args: [from] }),
    });
    if (!result.ok || !(await allowed())) throw new GatewayError('swap-unavailable', 503);
  }
  const amounts = await pub.readContract({ address: net.pair!, abi: pairAbi, functionName: 'getAmountsOut', args: [amount, [net.ausd, net.ctk!]] });
  const out = amounts[amounts.length - 1]!;
  if (out <= 0n) throw new GatewayError('swap-unavailable', 503);
  return out;
};

// ---------------------------------------------------------------- sign

export type SignResult = { id: string; txHash: Hex; amount: string; to: Address; pending?: true };

export const sign = async (env: Env, phone: string, id: string, signature: Hex): Promise<SignResult> => {
  // Claim the session in one statement: of two racing signs, only one gets a row back.
  const session = await env.DB.prepare(
    `UPDATE sessions SET state = 'sending', error = NULL
     WHERE id = ? AND phone = ? AND state = 'open' AND expires_at > ? RETURNING *`,
  )
    .bind(id, phone, now())
    .first<SessionRow>();

  if (!session) {
    const existing = await env.DB.prepare('SELECT state, tx_hash, amount, to_address, expires_at FROM sessions WHERE id = ? AND phone = ?')
      .bind(id, phone)
      .first<Pick<SessionRow, 'state' | 'tx_hash' | 'amount' | 'to_address' | 'expires_at'>>();
    if (!existing) throw new GatewayError('unknown-session', 404);
    if (existing.tx_hash) {
      const amount = formatUnits(BigInt(existing.amount), AUSD_DECIMALS);
      return { id, txHash: existing.tx_hash, amount, to: existing.to_address, ...(existing.state === 'sending' ? { pending: true as const } : {}) };
    }
    if (existing.state === 'sending') throw new GatewayError('in-progress', 409);
    throw new GatewayError('expired', 410);
  }

  const reopen = async (code: string, status = 400) => {
    await env.DB.prepare(`UPDATE sessions SET state = 'open', error = ? WHERE id = ?`).bind(code, id).run();
    return new GatewayError(code, status);
  };

  // Rebuild what the user signed from our own record, never from the message.
  const calls = callsFor(env, session);
  const nonce = BigInt(session.nonce);
  const deadline = BigInt(session.deadline);
  const typed = signedBatchTypedData(session.from_address, NETWORKS[session.network].chain.id, calls, nonce, deadline);
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typed, signature });
  } catch {
    throw await reopen('bad-sig');
  }
  if (signer.toLowerCase() !== session.from_address) throw await reopen('bad-sig');

  const a = await readAccount(env, session.network, session.from_address);
  if (a.balance < BigInt(session.amount) + BigInt(session.fee)) throw await reopen('low-balance', 402);

  const sponsor = env.SPONSOR.get(env.SPONSOR.idFromName(session.network));
  const result = await sponsor.submit(session.network, {
    kind: 'call',
    account: session.from_address,
    data: encodeExecute(calls, nonce, deadline, signature),
  });

  if (result.ok) {
    await env.DB.prepare(`UPDATE sessions SET state = 'sent', tx_hash = ? WHERE id = ?`).bind(result.txHash, id).run();
    return { id, txHash: result.txHash, amount: formatUnits(BigInt(session.amount), AUSD_DECIMALS), to: session.to_address };
  }
  if (result.error === 'timeout') {
    // Sent but unconfirmed: keep it claimed so nobody sends it twice; a retry reports the hash.
    await env.DB.prepare('UPDATE sessions SET tx_hash = ? WHERE id = ?').bind(result.txHash ?? null, id).run();
    return { id, txHash: result.txHash!, amount: formatUnits(BigInt(session.amount), AUSD_DECIMALS), to: session.to_address, pending: true };
  }
  throw await reopen(result.error, result.error === 'send-failed' ? 503 : 400);
};

// ---------------------------------------------------------------- delegation

/**
 * Queue a signup's 7702 authorization; it rides in the next batch with
 * whatever transfers are waiting. Checked here first, since an invalid one is
 * silently skipped on-chain and would otherwise look like a success.
 */
export const delegate = async (env: Env, network: NetworkName, address: Address, authorization: SignedAuthorization) => {
  if (authorization.address.toLowerCase() !== CALIBUR.toLowerCase()) throw new GatewayError('bad-delegate');
  if (authorization.chainId !== NETWORKS[network].chain.id) throw new GatewayError('bad-chain');
  const pub = publicClient(env, network);
  const [authority, nonce, code] = await Promise.all([
    recoverAuthorizationAddress({ authorization }),
    pub.getTransactionCount({ address }),
    pub.getCode({ address }),
  ]);
  if (authority.toLowerCase() !== address.toLowerCase()) throw new GatewayError('bad-sig');
  if (isDelegatedToCalibur(code)) return { network, delegated: true as const };
  if (code && code !== '0x') throw new GatewayError('has-code', 409);
  if (authorization.nonce !== nonce) throw new GatewayError('bad-nonce');

  const sponsor = env.SPONSOR.get(env.SPONSOR.idFromName(network));
  const result = await sponsor.submit(network, { kind: 'delegation', account: address, authorization });
  if (!result.ok) throw new GatewayError(`delegation-${result.error}`, 502);
  return { network, delegated: true as const, txHash: result.txHash };
};

// ---------------------------------------------------------------- status and housekeeping

export const txStatus = async (env: Env, phone: string, id: string) => {
  const s = await env.DB.prepare(
    'SELECT id, network, state, tx_hash, error, amount, to_address, expires_at FROM sessions WHERE id = ? AND phone = ?',
  )
    .bind(id, phone)
    .first<Pick<SessionRow, 'id' | 'network' | 'state' | 'tx_hash' | 'error' | 'amount' | 'to_address' | 'expires_at'> & { state: string }>();
  if (!s) throw new GatewayError('unknown-session', 404);
  return {
    id: s.id,
    network: s.network,
    status: s.state === 'open' && s.expires_at <= now() ? 'expired' : s.state,
    txHash: s.tx_hash,
    error: s.error,
    amount: formatUnits(BigInt(s.amount), AUSD_DECIMALS),
    to: s.to_address,
  };
};

/**
 * Every minute: settle sessions stuck in `sending` and drop stale rows.
 * A session past its signed deadline can never execute (Calibur reverts), so
 * one without a landed transaction by then has failed for good.
 */
export const reconcile = async (env: Env) => {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM otps WHERE expires_at < ? AND window_start < ?').bind(t, t - 3600),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? AND state != 'sending'`).bind(t - 86_400),
  ]);
  const { results } = await env.DB.prepare(
    `SELECT id, network, from_address, tx_hash, deadline FROM sessions WHERE state = 'sending' LIMIT 50`,
  ).all<Pick<SessionRow, 'id' | 'network' | 'from_address' | 'tx_hash' | 'deadline'>>();
  for (const s of results) {
    let state: 'sent' | 'failed' | undefined;
    let error: string | null = null;
    if (s.tx_hash) {
      const receipt = await publicClient(env, s.network)
        .getTransactionReceipt({ hash: s.tx_hash })
        .catch(() => undefined);
      if (receipt) [state, error] = tokenSenders(receipt, NETWORKS[s.network].ausd).has(s.from_address) ? ['sent', null] : ['failed', 'failed'];
      else if (t > s.deadline + 120) [state, error] = ['failed', 'dropped'];
    } else if (t > s.deadline + 60) [state, error] = ['failed', 'send-failed'];
    if (state) await env.DB.prepare('UPDATE sessions SET state = ?, error = ? WHERE id = ?').bind(state, error, s.id).run();
  }
};

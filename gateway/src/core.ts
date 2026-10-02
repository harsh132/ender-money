/**
 * The session core: account, quote and sign, the same for HTTPS and SMS.
 * Callers pass the phone number they've authenticated (JWT claim or SMS
 * sender); everything else is checked here.
 */
import { formatUnits, isAddress, parseUnits, recoverTypedDataAddress, type Address, type Hex, type SignedAuthorization } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { caliburAbi, encodeExecute, erc20Abi, isDelegatedToCalibur, signedBatchTypedData, transferWithFee, type Call } from '../../protocol/calibur';
import { AUSD_DECIMALS, CALIBUR, FEE_RECIPIENT, MULTICALL3, NETWORKS, type NetworkName } from '../../protocol/networks';
import { isPhone, SESSION_ID_ALPHABET, type Deliver } from '../../protocol/sms';
import { publicClient } from './chain';
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

type Link = { phone: string; address: Address; network: NetworkName };
type SessionRow = {
  id: string;
  phone: string;
  network: NetworkName;
  from_address: Address;
  to_address: Address;
  amount: string;
  fee: string;
  deliver: Deliver;
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
  nonce: string;
  deadline: number;
  calls: Array<{ to: Address; value: string; data: Hex }>;
};

const linkFor = async (env: Env, phone: string): Promise<Link> => {
  const link = await env.DB.prepare('SELECT phone, address, network FROM links WHERE phone = ?').bind(phone).first<Link>();
  if (!link) throw new GatewayError('not-registered', 403);
  return link;
};

/** Remember the network the phone last used, so the SMS path follows it. */
const useNetwork = async (env: Env, link: Link, network: NetworkName | undefined) => {
  if (!network || network === link.network) return link.network;
  await env.DB.prepare('UPDATE links SET network = ? WHERE phone = ?').bind(network, link.phone).run();
  return network;
};

const callsFor = (env: Env, s: Pick<SessionRow, 'network' | 'to_address' | 'amount' | 'fee'>): Call[] =>
  transferWithFee(NETWORKS[s.network].ausd, s.to_address, BigInt(s.amount), FEE_RECIPIENT, BigInt(s.fee));

const toQuote = (env: Env, s: SessionRow): Quote => ({
  id: s.id,
  network: s.network,
  from: s.from_address,
  to: s.to_address,
  amount: formatUnits(BigInt(s.amount), AUSD_DECIMALS),
  fee: formatUnits(BigInt(s.fee), AUSD_DECIMALS),
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
  // ponytail: CTK delivery (Instant Settlement swap) lands on 10 Oct.
  if (deliver !== 'AUSD') throw new GatewayError('unsupported');
  if (!/^\d+(\.\d{1,6})?$/.test(req.amount)) throw new GatewayError('bad-amount');
  const amount = parseUnits(req.amount, AUSD_DECIMALS);
  if (amount <= 0n) throw new GatewayError('bad-amount');

  let to: Address;
  if (isAddress(req.to)) to = req.to.toLowerCase() as Address;
  else if (isPhone(req.to)) {
    const recipient = await env.DB.prepare('SELECT address FROM links WHERE phone = ?').bind(req.to).first<{ address: Address }>();
    if (!recipient) throw new GatewayError('not-on-ender', 404);
    to = recipient.address;
  } else throw new GatewayError('bad-recipient');
  if (to === link.address.toLowerCase()) throw new GatewayError('self-transfer');

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
      nonce: a.nonce.toString(),
      deadline,
      state: 'open',
      tx_hash: null,
      error: null,
      expires_at: deadline,
    };
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO sessions (id, phone, network, from_address, to_address, amount, fee, deliver, nonce, deadline, request_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, phone, network, row.from_address, to, row.amount, row.fee, deliver, row.nonce, deadline, requestHash, deadline)
      .run();
    if (inserted.meta.changes === 1) return toQuote(env, row);
  }
  throw new GatewayError('busy', 503);
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

/**
 * Auto-bridge (protocol/bridge.ts): tokens at a user's own address on
 * Ethereum, Base, Arbitrum or Polygon become AUSD at the same address on
 * Monad mainnet, through Relay. Those chains' Alchemy webhooks (alchemy.ts)
 * note what arrived in foreign_balances; the app, online and unlocked, lists
 * them and bridges each:
 *
 *   prepare: the live balance, a draft Relay quote without our fee, its batch
 *            simulated for gas, and from that our app fee in bps (bridgeFee);
 *            plus the nonces the app signs with.
 *   submit:  the Calibur batch the app signed (approve + Relay deposit, from
 *            the quote it fetched itself with that fee) and, on a chain where
 *            the address isn't delegated yet, its 7702 authorization. Checked,
 *            simulated and sent as one transaction from the gateway key, which
 *            pays the gas.
 *
 * The gateway never chooses what the user signs: it only names a fee the app
 * bounds (BRIDGE_MAX_BPS) and nonces; the app builds the Relay request itself
 * (recipient: itself, AUSD on Monad, the fee to BRIDGE_FEE_RECIPIENT). Nor
 * does it front a delegation: the authorization rides in the bridge's own
 * transaction, so gas is only spent when the bridge (and its fee) happens.
 */
import {
  encodeFunctionData,
  isAddress,
  isHex,
  parseAbi,
  recoverTypedDataAddress,
  size,
  type Address,
  type Hex,
  type PublicClient,
  type SignedAuthorization,
} from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import {
  BRIDGE_FEE_RECIPIENT,
  checkBridgeCalls,
  NATIVE,
  quoteCalls,
  RELAY_API,
  relayQuote,
  RelayError,
  type RelayQuote,
} from '../../protocol/bridge';
import { caliburAbi, encodeExecute, erc20Abi, isDelegatedToCalibur, signedBatchTypedData, type Call } from '../../protocol/calibur';
import { BRIDGE_CHAINS, bridgeChainOf, CALIBUR, MULTICALL3, type BridgeChainName } from '../../protocol/networks';
import { parseAuthorization } from './auth';
import { publicClient, sponsorAddress } from './chain';
import { GatewayError } from './core';
import type { Env } from './env';

/**
 * Calibur's own work in `execute` (signature, nonce, decoding the batch) beyond what Multicall3 spends running the same
 * calls. About 10k on a Base fork (bridge.e2e.test.ts); the rest is margin.
 */
const CALIBUR_GAS = 20_000n;
/** EIP-7702's charge per authorization (PER_EMPTY_ACCOUNT_COST), when the transaction delegates the address. */
const DELEGATION_GAS = 25_000n;
/** Bytes of a type-4 transaction beyond its calldata, and per authorization; for Base's L1 data fee. */
const TX_BYTES = 120;
const AUTH_BYTES = 110;
/** A prepared bridge must be submitted within this; the signed batch's deadline is at most this far off. */
const PREPARE_TTL = 600;
const MAX_DEADLINE = 900;
/** How long a balance that wasn't bridged waits before it is listed again, unless more arrives first. */
const WAIT_FEE = 3600;
const WAIT_SKIP = 7 * 86_400;

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- fee

export type FeeConfig = { markup: number; flatUsd: number; maxPct: number; minUsd: number };

export const feeConfig = (env: Env): FeeConfig => ({
  markup: Number(env.BRIDGE_GAS_MARKUP ?? '1.3'),
  flatUsd: Number(env.BRIDGE_FEE_FLAT_USD ?? '0'),
  maxPct: Number(env.BRIDGE_MAX_FEE_PCT ?? '5'),
  minUsd: Number(env.BRIDGE_MIN_USD ?? '1'),
});

/**
 * Our Relay app fee, sized to our gas: fee_usd = cost × markup × native_usd +
 * flat, where cost is gas × gas price (+ Base's L1 data fee) in wei, and
 * bps = ceil(fee_usd / amount_usd × 10,000), at least 1. `maxCost` (wei) is
 * what the fee pays for: submit refuses a transaction that costs more.
 * Skipped when the amount is under minUsd or the fee over maxPct.
 */
export const bridgeFee = (
  o: { costWei: bigint; nativeUsd: number; amountUsd: number },
  c: FeeConfig,
): { bps: number; feeUsd: number; maxCost: bigint } | { skip: 'too-small' | 'fee-too-high' } => {
  if (!(o.amountUsd >= c.minUsd)) return { skip: 'too-small' };
  const feeUsd = (Number(o.costWei) / 1e18) * c.markup * o.nativeUsd + c.flatUsd;
  // The epsilon keeps float noise (0.1 + 0.2) from rounding up a whole bps.
  const bps = Math.max(1, Math.ceil((feeUsd / o.amountUsd) * 10_000 - 1e-9));
  if (!Number.isFinite(bps)) throw new GatewayError('bad-price', 503);
  if (bps > c.maxPct * 100) return { skip: 'fee-too-high' };
  return { bps, feeUsd, maxCost: (o.costWei * BigInt(Math.round(c.markup * 1000))) / 1000n };
};

// ---------------------------------------------------------------- chain reads

const multicall3Abi = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)',
]);

/**
 * Gas for the user's calls before they've signed anything: Multicall3's code,
 * put at their address by a state override, runs the calls as them. Calibur's
 * own work and a delegation are added on top.
 */
const simulateGas = async (pub: PublicClient, from: Address, user: Address, calls: Call[], delegate: boolean) => {
  const code = await pub.getCode({ address: MULTICALL3 });
  const value = calls.reduce((s, c) => s + c.value, 0n);
  const gas = await pub.estimateGas({
    account: from,
    to: user,
    value,
    data: encodeFunctionData({
      abi: multicall3Abi,
      functionName: 'aggregate3Value',
      args: [calls.map((c) => ({ target: c.to, allowFailure: false, value: c.value, callData: c.data }))],
    }),
    stateOverride: [
      { address: user, code },
      { address: from, balance: value + 10n ** 24n },
    ],
  });
  return gas + CALIBUR_GAS + (delegate ? DELEGATION_GAS : 0n);
};

const OP_GAS_ORACLE: Address = '0x420000000000000000000000000000000000000F';
const oracleAbi = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)']);

/** Base (OP Stack) bills the transaction's L1 data on top of its gas: the oracle's upper bound for this size. */
const l1Fee = async (pub: PublicClient, chain: BridgeChainName, data: Hex, delegate: boolean) =>
  chain !== 'base'
    ? 0n
    : pub.readContract({
        address: OP_GAS_ORACLE,
        abi: oracleAbi,
        functionName: 'getL1FeeUpperBound',
        args: [BigInt(size(data) + TX_BYTES + (delegate ? AUTH_BYTES : 0))],
      });

/** The chain's coin in USD, from Relay's price feed. */
const nativeUsd = async (chainId: number) => {
  const response = await fetch(`${RELAY_API}/currencies/token/price?address=${NATIVE}&chainId=${chainId}`).catch(() => undefined);
  const price = response?.ok ? Number(((await response.json()) as { price?: unknown }).price) : NaN;
  if (!(price > 0)) throw new GatewayError('relay-unavailable', 503);
  return price;
};

/** The gateway key can't pay this: a clear refusal, and a log line for whoever funds it. */
const requireFunds = async (pub: PublicClient, env: Env, chain: BridgeChainName, need: bigint) => {
  const balance = await pub.getBalance({ address: sponsorAddress(env) });
  if (balance >= need) return;
  console.error(`bridge: the gateway key is low on ${chain} (${balance} wei, needs ${need})`);
  throw new GatewayError('sponsor-low', 503);
};

const linkOf = async (env: Env, account: string) => {
  const link = await env.DB.prepare('SELECT address FROM links WHERE address = ?').bind(account).first<{ address: Address }>();
  if (!link) throw new GatewayError('not-registered', 403);
  return link.address.toLowerCase() as Address;
};

// ---------------------------------------------------------------- GET /bridge/pending

/** Balances to bridge: what arrived on the four chains and isn't waiting out a refusal. */
export const pending = async (env: Env, account: string) => {
  const address = await linkOf(env, account);
  const { results } = await env.DB.prepare('SELECT chain_id, token FROM foreign_balances WHERE address = ? AND retry_at <= ? ORDER BY seen_at LIMIT 20')
    .bind(address, now())
    .all<{ chain_id: number; token: Address }>();
  return { items: results.map((r) => ({ chainId: r.chain_id, token: r.token })) };
};

// ---------------------------------------------------------------- POST /bridge/prepare

export type Prepared = {
  id: string;
  chainId: number;
  token: Address;
  /** Base units: the whole balance, all of which goes. */
  amount: string;
  amountUsd: number;
  /** Our Relay app fee. */
  bps: number;
  feeRecipient: Address;
  /** Calibur nonce for the batch. */
  nonce: string;
  delegated: boolean;
  /** The address's transaction count there: the nonce of the 7702 authorization, when not delegated. */
  authNonce: number;
};

const parseChain = (chainId: unknown) => {
  const chain = bridgeChainOf(chainId);
  if (!chain) throw new GatewayError('bad-chain');
  return chain;
};

export const prepare = async (env: Env, account: string, req: { chainId?: unknown; token?: unknown }): Promise<Prepared> => {
  const user = await linkOf(env, account);
  const chain = parseChain(req.chainId);
  const chainId = BRIDGE_CHAINS[chain].chain.id;
  if (typeof req.token !== 'string' || !isAddress(req.token)) throw new GatewayError('bad-token');
  const token = req.token.toLowerCase() as Address;
  const pub = publicClient(env, chain) as PublicClient;

  /** Not bridged now: listed again after `seconds`, or as soon as more arrives. */
  const wait = async (seconds: number, code: string, status = 422) => {
    await env.DB.prepare('UPDATE foreign_balances SET retry_at = ? WHERE address = ? AND chain_id = ? AND token = ?').bind(now() + seconds, user, chainId, token).run();
    return new GatewayError(code, status);
  };

  const [amount, code, authNonce, seq] = await Promise.all([
    token === NATIVE ? pub.getBalance({ address: user }) : pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [user] }),
    pub.getCode({ address: user }),
    pub.getTransactionCount({ address: user }),
    // An undelegated address has no Calibur yet: nonce 0.
    pub.readContract({ address: user, abi: caliburAbi, functionName: 'getSeq', args: [0n] }).catch(() => 0n),
  ]);
  const delegated = isDelegatedToCalibur(code);
  if (!delegated && code && code !== '0x') throw await wait(WAIT_SKIP, 'has-code', 409);
  if (amount === 0n) {
    await env.DB.prepare('DELETE FROM foreign_balances WHERE address = ? AND chain_id = ? AND token = ?').bind(user, chainId, token).run();
    throw new GatewayError('nothing-to-bridge', 404);
  }

  let draft: RelayQuote;
  try {
    draft = await relayQuote({ user, originChainId: chainId, token, amount });
  } catch (e) {
    if (e instanceof RelayError && e.status === 400) throw await wait(WAIT_SKIP, 'unsupported-token');
    throw new GatewayError('relay-unavailable', 503);
  }
  const calls = quoteCalls(draft);
  if (!calls || checkBridgeCalls({ user, token, amount }, calls)) throw await wait(WAIT_SKIP, 'unsupported-route');

  let gas: bigint;
  try {
    gas = await simulateGas(pub, sponsorAddress(env), user, calls, !delegated);
  } catch {
    throw await wait(WAIT_FEE, 'reverted');
  }
  const draftData = encodeExecute(calls, seq, 0n, `0x${'11'.repeat(65)}`);
  const [gasPrice, l1, usd] = await Promise.all([pub.getGasPrice(), l1Fee(pub, chain, draftData, !delegated), nativeUsd(chainId)]);
  const fee = bridgeFee({ costWei: gas * gasPrice + l1, nativeUsd: usd, amountUsd: Number(draft.details.currencyIn.amountUsd) }, feeConfig(env));
  if ('skip' in fee) throw await wait(fee.skip === 'too-small' ? WAIT_SKIP : WAIT_FEE, fee.skip);
  // Room for the gas price to double before the transaction goes.
  await requireFunds(pub, env, chain, fee.maxCost * 2n);

  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    // Prepared and never submitted: gone with this address's next prepare.
    env.DB.prepare(`DELETE FROM bridges WHERE address = ? AND state = 'prepared' AND created_at < ?`).bind(user, now() - PREPARE_TTL),
    env.DB.prepare(
      `INSERT INTO bridges (id, address, chain_id, token, amount, bps, nonce, delegate, max_cost, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
    ).bind(id, user, chainId, token, amount.toString(), fee.bps, seq.toString(), delegated ? 0 : 1, fee.maxCost.toString(), now()),
  ]);
  return {
    id,
    chainId,
    token,
    amount: amount.toString(),
    amountUsd: Number(draft.details.currencyIn.amountUsd),
    bps: fee.bps,
    feeRecipient: (env.BRIDGE_FEE_RECIPIENT as Address | undefined) ?? BRIDGE_FEE_RECIPIENT,
    nonce: seq.toString(),
    delegated,
    authNonce,
  };
};

// ---------------------------------------------------------------- POST /bridge/submit

type BridgeRow = {
  id: string;
  address: Address;
  chain_id: number;
  token: Address;
  amount: string;
  bps: number;
  nonce: string;
  delegate: number;
  max_cost: string;
};

export type SubmitRequest = {
  id?: unknown;
  calls?: unknown;
  nonce?: unknown;
  deadline?: unknown;
  signature?: unknown;
  authorization?: unknown;
  requestId?: unknown;
};

const parseCalls = (calls: unknown): Call[] => {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 2) throw new GatewayError('bad-calls');
  return calls.map((c: { to?: unknown; value?: unknown; data?: unknown }) => {
    if (typeof c?.to !== 'string' || !isAddress(c.to) || typeof c.value !== 'string' || !/^\d+$/.test(c.value) || !isHex(c.data)) throw new GatewayError('bad-calls');
    return { to: c.to, value: BigInt(c.value), data: c.data };
  });
};

/**
 * Check what the app signed against the prepared bridge (its token, whole
 * amount, nonce; only the token's approve and Relay's contracts), simulate the
 * exact transaction (with the authorization, if any) and send it from the
 * gateway key. Refuses if it would revert, or cost more than the fee pays for
 * (the app prepares again), or the gateway key can't pay.
 */
export const submit = async (env: Env, account: string, req: SubmitRequest): Promise<{ txHash: Hex; pending?: true }> => {
  const user = await linkOf(env, account);
  if (typeof req.id !== 'string') throw new GatewayError('bad-request');
  const calls = parseCalls(req.calls);
  if (typeof req.nonce !== 'string' || !/^\d+$/.test(req.nonce) || !Number.isInteger(req.deadline)) throw new GatewayError('bad-request');
  if (!isHex(req.signature) || req.signature.length !== 132) throw new GatewayError('bad-request');
  const signature = req.signature;
  const requestId = isHex(req.requestId) && req.requestId.length === 66 ? req.requestId : null;

  // Claimed in one statement: of two racing submits, only one gets the row.
  const row = await env.DB.prepare(
    `UPDATE bridges SET state = 'sending' WHERE id = ? AND address = ? AND state = 'prepared' AND created_at > ? RETURNING *`,
  )
    .bind(req.id, user, now() - PREPARE_TTL)
    .first<BridgeRow>();
  if (!row) throw new GatewayError('unknown-bridge', 404);
  const fail = async (code: string, status = 400) => {
    await env.DB.prepare(`UPDATE bridges SET state = 'failed', error = ? WHERE id = ?`).bind(code, row.id).run();
    return new GatewayError(code, status);
  };

  const chain = bridgeChainOf(row.chain_id)!;
  const deadline = req.deadline as number;
  if (deadline <= now() || deadline > now() + MAX_DEADLINE) throw await fail('bad-deadline');
  if (req.nonce !== row.nonce) throw await fail('bad-nonce');
  const refused = checkBridgeCalls({ user, token: row.token, amount: BigInt(row.amount) }, calls);
  if (refused) throw await fail(refused);
  const nonce = BigInt(row.nonce);
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...signedBatchTypedData(user, row.chain_id, calls, nonce, BigInt(deadline)), signature });
  } catch {
    throw await fail('bad-sig');
  }
  if (signer.toLowerCase() !== user) throw await fail('bad-sig');

  const pub = publicClient(env, chain) as PublicClient;
  let authorizationList: SignedAuthorization[] | undefined;
  if (row.delegate) {
    let authorization: SignedAuthorization;
    try {
      authorization = parseAuthorization(req.authorization);
    } catch {
      throw await fail('bad-authorization');
    }
    if (authorization.address.toLowerCase() !== CALIBUR.toLowerCase()) throw await fail('bad-delegate');
    if (authorization.chainId !== row.chain_id) throw await fail('bad-chain');
    const [authority, txCount] = await Promise.all([recoverAuthorizationAddress({ authorization }).catch(() => undefined), pub.getTransactionCount({ address: user })]);
    if (authority?.toLowerCase() !== user) throw await fail('bad-sig');
    if (authorization.nonce !== txCount) throw await fail('bad-nonce');
    authorizationList = [authorization];
  }

  const data = encodeExecute(calls, nonce, BigInt(deadline), signature);
  const sponsor = sponsorAddress(env);
  let gas: bigint;
  try {
    gas = await pub.estimateGas({ account: sponsor, to: user, data, authorizationList });
  } catch (e) {
    console.warn('bridge: reverts', e instanceof Error ? e.message.split('\n')[0] : e);
    throw await fail('reverted');
  }
  const [gasPrice, l1] = await Promise.all([pub.getGasPrice(), l1Fee(pub, chain, data, !!authorizationList)]);
  const cost = gas * gasPrice + l1;
  if (cost > BigInt(row.max_cost)) throw await fail('gas-rose', 409);
  try {
    await requireFunds(pub, env, chain, cost * 2n);
  } catch (e) {
    throw await fail(e instanceof GatewayError ? e.code : 'rpc-unavailable', 503);
  }

  const result = await env.SPONSOR.get(env.SPONSOR.idFromName(chain)).submit(chain, { kind: 'direct', target: user, data, authorizationList });
  if (result.ok) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE bridges SET state = 'sent', tx_hash = ?, request_id = ? WHERE id = ?`).bind(result.txHash, requestId, row.id),
      env.DB.prepare('DELETE FROM foreign_balances WHERE address = ? AND chain_id = ? AND token = ?').bind(user, row.chain_id, row.token),
    ]);
    return { txHash: result.txHash };
  }
  if (result.error === 'timeout') {
    // Sent, not yet seen landing: Relay's status tells the app how it ends.
    await env.DB.prepare('UPDATE bridges SET tx_hash = ?, request_id = ? WHERE id = ?').bind(result.txHash ?? null, requestId, row.id).run();
    return { txHash: result.txHash!, pending: true };
  }
  throw await fail(result.error, result.error === 'send-failed' ? 503 : 400);
};

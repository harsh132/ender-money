/**
 * Auto-bridge, the app's side (wallet.ts autoBridge, protocol/bridge.ts): when
 * it runs, what it accepts from the gateway, and what it signs. Nothing here
 * touches the app's runtime, so the gateway's fork test signs with it too.
 */
import type { Address, LocalAccount } from 'viem';
import { BRIDGE_FEE_RECIPIENT, BRIDGE_MAX_BPS, checkBridgeQuote, quoteCalls, quoteRequestId, type RelayQuote } from '../../../protocol/bridge';
import { signedBatchTypedData } from '../../../protocol/calibur';
import { bridgeChainOf, CALIBUR, type NetworkName } from '../../../protocol/networks';

/** POST /bridge/prepare's answer. */
export type BridgePrepared = {
  id: string;
  chainId: number;
  token: Address;
  /** Base units: the whole balance there. */
  amount: string;
  amountUsd: number;
  /** The Relay app fee the gateway asks for, paying its gas. */
  bps: number;
  feeRecipient: Address;
  /** Calibur nonce on that chain. */
  nonce: string;
  delegated: boolean;
  /** Our transaction count there: the 7702 authorization's nonce. */
  authNonce: number;
};

/** How long the signed batch stays valid. */
export const BRIDGE_DEADLINE_S = 600;

/** Online, the spending key in memory, and the app showing mainnet: Relay bridges into Monad mainnet only, so Test mode has none. */
export const shouldAutoBridge = (o: { on: boolean; network: NetworkName; online: boolean; unlocked: boolean }) => o.on && o.network === 'mainnet' && o.online && o.unlocked;

/** Settings' Auto-bridge: on unless switched off (so older installs are on). */
export const autoBridgeOn = (s: { autoBridge?: boolean }) => s.autoBridge !== false;

/** What the gateway may ask: a chain we bridge from, at most BRIDGE_MAX_BPS, to the fee recipient we ship. Returns why not, or null. */
export const checkPrepared = (p: BridgePrepared): string | null => {
  if (!bridgeChainOf(p.chainId)) return 'bad-chain';
  if (!Number.isInteger(p.bps) || p.bps < 0 || p.bps > BRIDGE_MAX_BPS) return 'fee-too-high';
  if (p.feeRecipient?.toLowerCase() !== BRIDGE_FEE_RECIPIENT.toLowerCase()) return 'wrong-fee-recipient';
  return null;
};

/**
 * Sign a bridge from the Relay quote we fetched ourselves: it must pass
 * checkBridgeQuote (to us, AUSD on Monad, the whole prepared amount, Relay's
 * contracts only). Then the Calibur batch of its steps (domain: the origin
 * chain) and, where that chain has no delegation yet, the 7702 authorization.
 * Throws with the reason; the result is POST /bridge/submit's body.
 */
export const signBridge = async (account: LocalAccount, p: BridgePrepared, q: RelayQuote, nowS = Math.floor(Date.now() / 1000)) => {
  const refused = checkPrepared(p) ?? checkBridgeQuote(q, { user: account.address, chainId: p.chainId, token: p.token, amount: BigInt(p.amount) });
  if (refused) throw new Error(refused);
  const calls = quoteCalls(q)!;
  const deadline = nowS + BRIDGE_DEADLINE_S;
  const signature = await account.signTypedData!(signedBatchTypedData(account.address, p.chainId, calls, BigInt(p.nonce), BigInt(deadline)));
  const a = p.delegated ? undefined : await account.signAuthorization!({ contractAddress: CALIBUR, chainId: p.chainId, nonce: p.authNonce });
  return {
    id: p.id,
    calls: calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data })),
    nonce: p.nonce,
    deadline,
    signature,
    ...(a ? { authorization: { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity! } } : {}),
    ...(quoteRequestId(q) ? { requestId: quoteRequestId(q) } : {}),
  };
};

export type BridgeSubmit = Awaited<ReturnType<typeof signBridge>>;

/** Relay's status as the bridge's Activity status; undefined while it is still on its way. */
export const bridgeOutcome = (status: string): 'sent' | 'failed' | undefined =>
  status === 'success' ? 'sent' : status === 'refund' || status === 'failure' ? 'failed' : undefined;

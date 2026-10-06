/**
 * Auto-bridge: tokens that reach a user's own address on Ethereum, Base,
 * Arbitrum or Polygon are swapped and bridged by Relay (relay.link) into AUSD
 * at the same address on Monad mainnet. Shared by the app, which fetches the
 * Relay quote it signs and checks it, and the gateway, which checks the batch
 * it pays gas for (gateway/src/bridge.ts, docs/gateway.md "Auto-bridge").
 */
import { decodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { erc20Abi, type Call } from './calibur';
import { FEE_RECIPIENT, NETWORKS } from './networks';

export const RELAY_API = 'https://api.relay.link';

/** Relay's (and our) name for a chain's own coin: ETH, POL. */
export const NATIVE: Address = zeroAddress;

/**
 * Where Relay pays our app fee (USDC, accrued off-chain, claimed by this
 * address). Shipped in the app, which puts it in the quote it signs; the
 * gateway's BRIDGE_FEE_RECIPIENT must match, or the app refuses to bridge.
 */
export const BRIDGE_FEE_RECIPIENT: Address = FEE_RECIPIENT;

/** The app never signs a bridge whose app fee is above this, whatever the gateway asks (5%). */
export const BRIDGE_MAX_BPS = 500;

/**
 * Relay's contracts, at the same address on all four chains (GET /chains:
 * protocol.v2.depository, contracts.approvalProxy, erc20Router, relayReceiver).
 * A bridge batch calls one of them, after at most the token's approve to it.
 */
export const RELAY_DEPOSITORY: Address = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
export const RELAY_CONTRACTS: readonly Address[] = [
  RELAY_DEPOSITORY,
  '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
  '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',
  '0xa5f565650890fba1824ee0f21ebbbf660a179934',
];

const depositoryAbi = parseAbi([
  'function depositNative(address depositor, bytes32 id) payable',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
]);

type Amount = { currency: { chainId: number; address: string }; amount: string; amountFormatted: string; amountUsd: string };

/** The parts of Relay's POST /quote answer we read. */
export type RelayQuote = {
  requestId?: Hex;
  steps: Array<{ id: string; kind: string; requestId?: Hex; items: Array<{ data: { to: Address; data: Hex; value: string; chainId: number } }> }>;
  details: { sender: string; recipient: string; currencyIn: Amount; currencyOut: Amount };
};

/** Relay answered with an error; 400 for a token or amount it can't route (INVALID_INPUT_CURRENCY, NO_SWAP_ROUTES_FOUND). */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

/**
 * EXACT_INPUT quote for the whole `amount` of `token`, into AUSD on Monad
 * mainnet at the user's own address. `bps`: our app fee, to BRIDGE_FEE_RECIPIENT.
 */
export const relayQuote = async (r: { user: Address; originChainId: number; token: Address; amount: bigint; bps?: number }): Promise<RelayQuote> => {
  const response = await fetch(`${RELAY_API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: r.user,
      recipient: r.user,
      originChainId: r.originChainId,
      destinationChainId: NETWORKS.mainnet.chain.id,
      originCurrency: r.token,
      destinationCurrency: NETWORKS.mainnet.ausd,
      amount: r.amount.toString(),
      tradeType: 'EXACT_INPUT',
      ...(r.bps ? { appFees: [{ recipient: BRIDGE_FEE_RECIPIENT, fee: String(r.bps) }] } : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as RelayQuote & { errorCode?: string };
  if (!response.ok) throw new RelayError(json.errorCode ?? `http-${response.status}`, response.status);
  return json;
};

/** GET /intents/status/v3: `success` once AUSD landed (txHashes: the Monad fill); `refund` / `failure` when it won't. */
export const relayStatus = async (requestId: string) => {
  const response = await fetch(`${RELAY_API}/intents/status/v3?requestId=${requestId}`);
  if (!response.ok) throw new RelayError(`http-${response.status}`, response.status);
  return (await response.json()) as { status: string; txHashes?: string[] };
};

export const quoteRequestId = (q: RelayQuote) => q.requestId ?? q.steps.at(-1)?.requestId;

/** The quote's steps as one batch (approve, deposit); null when a step is anything but a plain transaction (a permit, say). */
export const quoteCalls = (q: RelayQuote): Call[] | null => {
  if (!q.steps?.length || q.steps.some((s) => s.kind !== 'transaction' || s.items.length !== 1)) return null;
  return q.steps.map((s) => {
    const { to, data, value } = s.items[0]!.data;
    return { to, data, value: BigInt(value ?? 0) };
  });
};

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/**
 * A bridge batch moves the whole `amount` of `token` into Relay and nothing
 * else: the native coin as the deposit's value, or a token through approve
 * (to the deposit's target, at most `amount`) then the deposit. A deposit to
 * the depository itself must name the user (its refund address) and the
 * token and amount. Returns why not, or null.
 */
export const checkBridgeCalls = (o: { user: Address; token: Address; amount: bigint }, calls: Call[]): string | null => {
  const native = same(o.token, NATIVE);
  const deposit = calls.at(-1);
  if (!deposit || calls.length !== (native ? 1 : 2) || !RELAY_CONTRACTS.some((r) => same(deposit.to, r))) return 'bad-target';
  if (deposit.value !== (native ? o.amount : 0n)) return 'bad-value';
  if (!native) {
    const approve = calls[0]!;
    if (!same(approve.to, o.token) || approve.value !== 0n) return 'bad-target';
    try {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: approve.data });
      if (functionName !== 'approve' || !same(args[0] as Address, deposit.to) || (args[1] as bigint) > o.amount) return 'bad-approve';
    } catch {
      return 'bad-approve';
    }
  }
  if (same(deposit.to, RELAY_DEPOSITORY)) {
    try {
      const d = decodeFunctionData({ abi: depositoryAbi, data: deposit.data });
      const ok =
        d.functionName === 'depositNative'
          ? native && same(d.args[0], o.user)
          : !native && same(d.args[0], o.user) && same(d.args[1], o.token) && d.args[2] === o.amount;
      if (!ok) return 'bad-deposit';
    } catch {
      return 'bad-deposit';
    }
  }
  return null;
};

/**
 * The app's check of the quote it is about to sign: from and to the user's own
 * address, the whole amount of that token on that chain in, AUSD on Monad
 * mainnet out, and a batch checkBridgeCalls accepts. Returns why not, or null.
 */
export const checkBridgeQuote = (q: RelayQuote, o: { user: Address; chainId: number; token: Address; amount: bigint }): string | null => {
  const { details } = q;
  if (!details || !same(details.sender, o.user) || !same(details.recipient, o.user)) return 'wrong-recipient';
  const out = details.currencyOut?.currency;
  if (out?.chainId !== NETWORKS.mainnet.chain.id || !same(out.address, NETWORKS.mainnet.ausd)) return 'wrong-destination';
  const input = details.currencyIn;
  if (input?.currency.chainId !== o.chainId || !same(input.currency.address, o.token) || input.amount !== o.amount.toString()) return 'wrong-input';
  if (q.steps?.some((s) => s.items.some((i) => i.data.chainId !== o.chainId))) return 'wrong-chain';
  const calls = quoteCalls(q);
  return calls ? checkBridgeCalls(o, calls) : 'bad-steps';
};

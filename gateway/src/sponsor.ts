import { DurableObject } from 'cloudflare:workers';
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type SignedAuthorization,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isDelegatedToCalibur } from '../../protocol/calibur';
import { MULTICALL3, NETWORKS, type NetworkName } from '../../protocol/networks';
import { chainOf, publicClient, tokenSenders, type ChainName } from './chain';
import type { Env } from './env';

/** A user's signed Calibur `execute` call, or a signup's 7702 authorization. */
export type SponsorItem =
  | { kind: 'call'; account: Address; data: Hex }
  /** A gateway-side call (e.g. the testnet swap whitelister); succeeds if the batch does. */
  | { kind: 'plain'; target: Address; data: Hex }
  /**
   * A gateway-side call that must come from the gateway key itself (msg.sender), not through Multicall3: the
   * shielded pool's transact / depositWithAuthorization, or an auto-bridge (bridge.ts): the user's Calibur `execute`
   * on their own address, with their 7702 authorization when they aren't delegated there yet. Sent alone, in queue
   * order; succeeds if it doesn't revert.
   */
  | { kind: 'direct'; target: Address; data: Hex; authorizationList?: SignedAuthorization[] }
  | { kind: 'delegation'; account: Address; authorization: SignedAuthorization };

export type SponsorResult =
  | { ok: true; txHash: Hex }
  /** reverted: dropped before sending; failed: landed without effect; timeout: sent, receipt not seen yet. */
  | { ok: false; error: 'reverted' | 'failed' | 'timeout' | 'send-failed'; txHash?: Hex };

type Pending = { item: SponsorItem; resolve: (r: SponsorResult) => void };

const MAX_BATCH = 50;
const RECEIPT_TIMEOUT_MS = 30_000;
/** Monad bills the gas limit, so keep the margin thin. */
const GAS_MARGIN_PERCENT = 105n;

const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

const aggregate3 = (calls: Pending[]) =>
  encodeFunctionData({
    abi: multicall3Abi,
    functionName: 'aggregate3',
    args: [
      calls.map((p) => {
        const item = p.item as Extract<SponsorItem, { kind: 'call' | 'plain' }>;
        return { target: item.kind === 'plain' ? item.target : item.account, allowFailure: true, callData: item.data };
      }),
    ],
  });

/**
 * The gateway key on one network: the only sender, so the only nonce owner.
 * Also one per auto-bridge chain (named after it), which only gets direct items.
 *
 * Queued items go out as one EIP-7702 transaction to Multicall3: the calldata
 * runs every queued user's Calibur `execute`, and the authorization list
 * carries every queued signup's delegation. Flush when idle: if nothing is in
 * flight, send at once (a batch of one); whatever arrives meanwhile goes in the
 * next batch the moment this one lands. One batch in flight means the nonce
 * just goes up by one per batch.
 *
 * ponytail: the queue lives in memory. If the object is evicted mid-batch the
 * waiting callers get an error and the user retries before the deadline; the
 * signature is single-use on-chain, so a retry can never double-spend.
 */
export class Sponsor extends DurableObject<Env> {
  private queue: Pending[] = [];
  private busy = false;
  private network?: ChainName;

  submit(network: ChainName, item: SponsorItem): Promise<SponsorResult> {
    this.network ??= network;
    if (this.network !== network) throw new Error(`sponsor for ${this.network} got ${network}`);
    const result = new Promise<SponsorResult>((resolve) => this.queue.push({ item, resolve }));
    void this.pump();
    return result;
  }

  private async pump(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    // A direct item goes alone; a batch stops before the next one, so queue order (and the nonce order) holds.
    const direct = this.queue.findIndex((p) => p.item.kind === 'direct');
    const batch = this.queue.splice(0, direct === 0 ? 1 : direct > 0 ? Math.min(direct, MAX_BATCH) : MAX_BATCH);
    try {
      await (batch[0]!.item.kind === 'direct' ? this.sendDirect(batch[0]!) : this.send(batch));
    } catch (error) {
      console.error('sponsor: batch failed', error instanceof Error ? error.message : error);
      // Resolving twice is a no-op, so this only reaches callers send() hadn't answered.
      for (const p of batch) p.resolve({ ok: false, error: 'send-failed' });
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private async sendDirect(p: Pending) {
    const { target, data, authorizationList } = p.item as Extract<SponsorItem, { kind: 'direct' }>;
    const pub = publicClient(this.env, this.network!);
    const gateway = privateKeyToAccount(this.env.GATEWAY_PRIVATE_KEY as Hex);
    try {
      await pub.call({ account: gateway.address, to: target, data, authorizationList });
    } catch (error) {
      console.warn('sponsor: direct call reverts', error instanceof Error ? error.message.split('\n')[0] : error);
      return p.resolve({ ok: false, error: 'reverted' });
    }
    const [gas, fees, nonce] = await Promise.all([
      pub.estimateGas({ account: gateway.address, to: target, data, authorizationList }),
      pub.estimateFeesPerGas(),
      pub.getTransactionCount({ address: gateway.address, blockTag: 'pending' }),
    ]);
    const serializedTransaction = await gateway.signTransaction({
      chainId: chainOf(this.network!).id,
      nonce,
      to: target,
      data,
      value: 0n,
      gas: (gas * GAS_MARGIN_PERCENT) / 100n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      ...(authorizationList ? { type: 'eip7702' as const, authorizationList } : { type: 'eip1559' as const }),
    });
    const txHash = await pub.sendRawTransaction({ serializedTransaction });
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
      p.resolve(receipt.status === 'success' ? { ok: true, txHash } : { ok: false, error: 'failed', txHash });
    } catch {
      p.resolve({ ok: false, error: 'timeout', txHash });
    }
  }

  private async send(batch: Pending[]) {
    const network = this.network as NetworkName;
    const net = NETWORKS[network];
    const pub = publicClient(this.env, network);
    const gateway = privateKeyToAccount(this.env.GATEWAY_PRIVATE_KEY as Hex);

    const delegations = batch.filter((p) => p.item.kind === 'delegation');
    const authorizationList = delegations.map((p) => (p.item as { authorization: SignedAuthorization }).authorization);
    const auth = authorizationList.length ? authorizationList : undefined;
    let calls = batch.filter((p) => p.item.kind !== 'delegation');

    // Simulate the whole batch and drop any call that would fail, so one user can't sink the rest.
    if (calls.length) {
      const { data } = await pub.call({ account: gateway.address, to: MULTICALL3, data: aggregate3(calls), authorizationList: auth });
      const results = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: data! });
      const failed = calls.filter((_, i) => !results[i]?.success);
      for (const p of failed) p.resolve({ ok: false, error: 'reverted' });
      calls = calls.filter((_, i) => results[i]?.success);
    }
    if (calls.length === 0 && delegations.length === 0) return;

    const data = aggregate3(calls);
    const [gas, fees, nonce] = await Promise.all([
      pub.estimateGas({ account: gateway.address, to: MULTICALL3, data, authorizationList: auth }),
      pub.estimateFeesPerGas(),
      pub.getTransactionCount({ address: gateway.address, blockTag: 'pending' }),
    ]);
    const serializedTransaction = await gateway.signTransaction({
      chainId: net.chain.id,
      nonce,
      to: MULTICALL3,
      data,
      value: 0n,
      gas: (gas * GAS_MARGIN_PERCENT) / 100n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      ...(auth ? { type: 'eip7702' as const, authorizationList: auth } : { type: 'eip1559' as const }),
    });
    const txHash = await pub.sendRawTransaction({ serializedTransaction });

    let receipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    } catch {
      for (const p of [...calls, ...delegations]) p.resolve({ ok: false, error: 'timeout', txHash });
      return;
    }

    // Per-user outcome: Multicall3's per-call results aren't in the receipt, but every
    // successful transfer emits an AUSD Transfer from the user's own address.
    const senders = tokenSenders(receipt, net.ausd);
    const landed = receipt.status === 'success';
    for (const p of calls) {
      const ok = p.item.kind === 'call' ? senders.has(p.item.account.toLowerCase()) : landed;
      p.resolve(ok ? { ok: true, txHash } : { ok: false, error: 'failed', txHash });
    }
    // Delegations leave no log; the account's code says whether it took.
    for (const p of delegations) {
      const code = await pub.getCode({ address: (p.item as { account: Address }).account });
      p.resolve(isDelegatedToCalibur(code) ? { ok: true, txHash } : { ok: false, error: 'failed', txHash });
    }
  }
}

/**
 * Batching check on testnet with throwaway users (keys live only in memory):
 *
 *   fund N new addresses from the demo user (gateway pays)
 *   -> N signups at once      (delegations should share one batch)
 *   -> N transfers at once    (the first goes alone, the rest share the next batch)
 *
 *   bun run burst [N] [--gateway http://127.0.0.1:8787]
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { caliburAbi, encodeExecute, erc20Abi, signedBatchTypedData, transferWithFee } from '../protocol/calibur';
import { AUSD_DECIMALS, CALIBUR, FEE_RECIPIENT, NETWORKS } from '../protocol/networks';

const args = process.argv.slice(2);
const gi = args.indexOf('--gateway');
const base = gi >= 0 ? args.splice(gi, 2)[1]! : 'http://127.0.0.1:8787';
const N = Number(args[0] ?? 3);
const net = NETWORKS.testnet;
const recipient = process.env.GATEWAY_ADDRESS as Address;

const pub = createPublicClient({ chain: net.chain, transport: http() });
const gateway = createWalletClient({ account: privateKeyToAccount(process.env.GATEWAY_PRIVATE_KEY as Hex), chain: net.chain, transport: http() });
const users = Array.from({ length: N }, (_, i) => ({ account: privateKeyToAccount(generatePrivateKey()), phone: `+91980000${String(100 + i)}` }));

const post = async <T>(path: string, payload: unknown, token?: string): Promise<T> => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${body.error}`);
  return body;
};
const short = (h: string) => `${h.slice(0, 10)}...`;

// 1. Fund them from the demo user in one Calibur batch the gateway sends directly (the Sponsor queue is idle meanwhile).
const demo = privateKeyToAccount(process.env.DEMO_USER_PRIVATE_KEY as Hex);
const seq = await pub.readContract({ address: demo.address, abi: caliburAbi, functionName: 'getSeq', args: [0n] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const funding = users.map((u) => ({
  to: net.ausd,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [u.account.address, parseUnits('0.05', AUSD_DECIMALS)] }),
}));
const fundSig = await demo.signTypedData(signedBatchTypedData(demo.address, net.chain.id, funding, seq, deadline));
const fundHash = await gateway.sendTransaction({ to: demo.address, data: encodeExecute(funding, seq, deadline, fundSig) });
await pub.waitForTransactionReceipt({ hash: fundHash });
console.log(`fund       ${N} users x 0.05 AUSD  ${net.explorer}/tx/${fundHash}`);

// 2. Signups at once.
const signups = await Promise.all(
  users.map(async (u) => {
    const { v: _v, ...authorization } = await createWalletClient({ account: u.account, chain: net.chain, transport: http() }).signAuthorization({
      contractAddress: CALIBUR,
      chainId: net.chain.id,
      nonce: 0,
    });
    return post<{ txHash: Hex }>('/dev/delegate', { network: 'testnet', address: u.account.address, authorization });
  }),
);
console.log(`delegate   ${signups.map((s) => short(s.txHash)).join('  ')}`);

// 3. Transfers at once.
const tokens = await Promise.all(users.map((u) => post<{ token: string }>('/dev/link', { phone: u.phone, address: u.account.address, network: 'testnet' })));
const started = Date.now();
const sent = await Promise.all(
  users.map(async (u, i) => {
    type Quote = { id: string; fee: string; nonce: string; deadline: number };
    const q = await post<Quote>('/tx/quote', { network: 'testnet', to: recipient, amount: '0.01' }, tokens[i]!.token);
    const calls = transferWithFee(net.ausd, recipient, parseUnits('0.01', AUSD_DECIMALS), FEE_RECIPIENT, parseUnits(q.fee, AUSD_DECIMALS));
    const signature = await u.account.signTypedData(signedBatchTypedData(u.account.address, net.chain.id, calls, BigInt(q.nonce), BigInt(q.deadline)));
    return post<{ txHash: Hex }>('/tx/sign', { id: q.id, signature }, tokens[i]!.token);
  }),
);
console.log(`transfer   ${sent.map((s) => short(s.txHash)).join('  ')}  (${Date.now() - started}ms for all)`);
for (const h of new Set([...signups, ...sent].map((s) => s.txHash))) console.log(`           ${net.explorer}/tx/${h}`);

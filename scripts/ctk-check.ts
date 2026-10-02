/**
 * Local-currency delivery on testnet, end to end against a DEV gateway:
 * quote with deliver=CTK (first time whitelists the sender), sign the swap
 * batch the app would build, submit, and check the recipient got the CTK.
 *
 *   bun run ctk-check [--gateway http://127.0.0.1:8787]
 */
import { createPublicClient, http, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signedBatchTypedData, swapWithFee } from '../protocol/calibur';
import { AUSD_DECIMALS, CTK_DECIMALS, FEE_RECIPIENT, NETWORKS } from '../protocol/networks';

const args = process.argv.slice(2);
const gi = args.indexOf('--gateway');
const base = gi >= 0 ? args.splice(gi, 2)[1]! : 'http://127.0.0.1:8787';
const net = NETWORKS.testnet;
const demo = privateKeyToAccount(process.env.DEMO_USER_PRIVATE_KEY as Hex);
const recipient = process.env.GATEWAY_ADDRESS as Address;

const api = async <T>(method: string, path: string, body?: unknown, token?: string): Promise<T> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  console.log(`${method} ${path} ${res.status}${json.error ? ` ${json.error}` : ''}`);
  if (!res.ok) throw new Error(json.error);
  return json;
};

const ctk = parseAbi(['function balanceOf(address) view returns (uint256)']);
const pub = createPublicClient({ chain: net.chain, transport: http() });
const before = await pub.readContract({ address: net.ctk!, abi: ctk, functionName: 'balanceOf', args: [recipient] });

const { token } = await api<{ token: string }>('POST', '/dev/link', { phone: '+919800000001', address: demo.address, network: 'testnet' });
const q = await api<{ id: string; fee: string; out: string; nonce: string; deadline: number; to: Address }>(
  'POST', '/tx/quote', { network: 'testnet', to: recipient, amount: '0.01', deliver: 'CTK' }, token,
);
console.log(`quote ${q.id}: 0.01 AUSD -> ${q.out} CTK, fee ${q.fee}`);
const calls = swapWithFee(net.ausd, net.pair!, net.ctk!, q.to, parseUnits('0.01', AUSD_DECIMALS), parseUnits(q.out, CTK_DECIMALS), BigInt(q.deadline), FEE_RECIPIENT, parseUnits(q.fee, AUSD_DECIMALS));
const signature = await demo.signTypedData(signedBatchTypedData(demo.address, net.chain.id, calls, BigInt(q.nonce), BigInt(q.deadline)));
const sent = await api<{ txHash: Hex }>('POST', '/tx/sign', { id: q.id, signature }, token);
const after = await pub.readContract({ address: net.ctk!, abi: ctk, functionName: 'balanceOf', args: [recipient] });
console.log(`sent ${net.explorer}/tx/${sent.txHash}\nrecipient CTK +${Number(after - before) / 1e18}`);

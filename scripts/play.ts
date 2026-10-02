/**
 * Plays the app against a gateway over HTTPS, with the demo user's key standing
 * in for the passkey-derived one:
 *
 *   link (dev only) -> account -> quote -> check the calls -> sign -> account
 *
 *   bun run play [testnet|mainnet] [amount] [--gateway http://localhost:8787]
 *
 * The recipient is the gateway address, so the AUSD stays in our wallets.
 */
import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signedBatchTypedData, transferWithFee } from '../protocol/calibur';
import { AUSD_DECIMALS, NETWORKS, type NetworkName } from '../protocol/networks';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const base = flag('--gateway') ?? 'http://localhost:8787';
const network = (args[0] ?? 'testnet') as NetworkName;
const amount = args[1] ?? '0.10';
if (!(network in NETWORKS)) throw new Error('usage: play [testnet|mainnet] [amount] [--gateway url]');

const user = privateKeyToAccount(process.env.DEMO_USER_PRIVATE_KEY as Hex);
const recipient = process.env.GATEWAY_ADDRESS as Address;
const PHONE = '+919800000001';

const call = async <T>(method: string, path: string, token?: string, payload?: unknown): Promise<T> => {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = (await res.json()) as T & { error?: string };
  console.log(`${method.padEnd(4)} ${path.padEnd(28)} ${res.status} ${Date.now() - started}ms`);
  if (!res.ok) throw new Error(`${path}: ${body.error}`);
  return body;
};

type Account = { address: Address; balance: string; nonce: string; delegated: boolean };
type Quote = { id: string; to: Address; amount: string; fee: string; feeRecipient: Address; nonce: string; deadline: number; calls: Array<{ to: Address; value: string; data: Hex }> };

const { token } = await call<{ token: string }>('POST', '/dev/link', undefined, { phone: PHONE, address: user.address, network });
const before = await call<Account>('GET', `/account?network=${network}`, token);
console.log(`         ${before.address} ${before.balance} AUSD, nonce ${before.nonce}, delegated ${before.delegated}`);

const q = await call<Quote>('POST', '/tx/quote', token, { network, to: recipient, amount });
console.log(`         quote ${q.id}: ${q.amount} AUSD + ${q.fee} fee, nonce ${q.nonce}`);

// The app never signs calls it didn't build itself: rebuild them from the readable fields and compare.
const fee = parseUnits(q.fee, AUSD_DECIMALS);
const expected = transferWithFee(NETWORKS[network].ausd, recipient, parseUnits(amount, AUSD_DECIMALS), q.feeRecipient, fee);
const same = JSON.stringify(expected.map((c) => [c.to.toLowerCase(), c.value.toString(), c.data])) === JSON.stringify(q.calls.map((c) => [c.to.toLowerCase(), c.value, c.data]));
if (!same || q.to.toLowerCase() !== recipient.toLowerCase()) throw new Error('quoted calls differ from what the app would build');
console.log('         calls match the readable fields');

const signature = await user.signTypedData(
  signedBatchTypedData(user.address, NETWORKS[network].chain.id, expected, BigInt(q.nonce), BigInt(q.deadline)),
);
const signed = await call<{ txHash: Hex; pending?: boolean }>('POST', '/tx/sign', token, { id: q.id, signature });
console.log(`         ${NETWORKS[network].explorer}/tx/${signed.txHash}${signed.pending ? ' (pending)' : ''}`);

const after = await call<Account>('GET', `/account?network=${network}`, token);
console.log(`         balance ${before.balance} -> ${after.balance} AUSD (spent ${formatUnits(parseUnits(before.balance, 6) - parseUnits(after.balance, 6), 6)})`);

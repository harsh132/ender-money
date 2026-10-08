/**
 * A brand-new user through real onboarding, then their first transfers:
 *
 *   /auth/challenge -> /auth/verify (new account, random Ender ID) -> sign 7702 authorizations
 *   -> /wallet/create -> add a phone number (OTP) -> fund from the demo user -> transfer over
 *   HTTPS -> /tx/:id -> transfer by SMS -> sign in again (existing)
 *
 *   bun run signup [--gateway http://127.0.0.1:8787]
 *
 * Needs a DEV gateway (the OTP comes back as devCode) with SIGNUP_NETWORKS=testnet.
 * The new key lives only in memory.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { caliburAbi, encodeExecute, erc20Abi, signedBatchTypedData, transferWithFee } from '../protocol/calibur';
import { AUSD_DECIMALS, CALIBUR, FEE_RECIPIENT, NETWORKS } from '../protocol/networks';
import { loginMessage } from '../protocol/auth';
import { formatCommand, parseReply } from '../protocol/sms';

const args = process.argv.slice(2);
const gi = args.indexOf('--gateway');
const base = gi >= 0 ? args.splice(gi, 2)[1]! : 'http://127.0.0.1:8787';
const net = NETWORKS.testnet;
const recipient = process.env.GATEWAY_ADDRESS as Address;
const user = privateKeyToAccount(generatePrivateKey());
const phone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const api = async <T>(method: string, path: string, payload?: unknown, token?: string): Promise<T> => {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = (await res.json()) as T & { error?: string };
  console.log(`${method.padEnd(4)} ${path.padEnd(18)} ${res.status} ${String(Date.now() - started).padStart(5)}ms${body.error ? `  ${body.error}` : ''}`);
  if (!res.ok) throw new Error(`${path}: ${body.error}`);
  return body;
};

console.log(`new user  ${user.address}  ${phone}`);

// Onboarding: sign in by signature, which creates the account.
const signIn = async () => {
  const c = await api<{ nonce: string; expires: number }>('POST', '/auth/challenge', { address: user.address });
  const signature = await user.signMessage({ message: loginMessage({ address: user.address, ...c }) });
  return api<{ token: string; name: string; created: boolean }>('POST', '/auth/verify', { address: user.address, signature });
};
const verified = await signIn();
if (!verified.created) throw new Error('expected a new account');
console.log(`          Ender ID ${verified.name}`);
const token = verified.token;
const { v: _v, ...authorization } = await createWalletClient({ account: user, chain: net.chain, transport: http() }).signAuthorization({
  contractAddress: CALIBUR,
  chainId: net.chain.id,
  nonce: 0,
});
const created = await api<{ delegations: Array<{ txHash?: Hex }> }>(
  'POST',
  '/wallet/create',
  { authorizations: { testnet: authorization } },
  token,
);
console.log(`          delegated: ${net.explorer}/tx/${created.delegations[0]?.txHash}`);

// A phone number, for the SMS path.
const start = await api<{ devCode?: string; queued: boolean }>('POST', '/account/phone/start', { phone }, token);
if (!start.devCode) throw new Error('gateway is not in DEV mode');
await api('POST', '/account/phone/verify', { phone, code: start.devCode === '000000' ? '111111' : '000000' }, token).catch(() => {}); // a wrong guess first
await api('POST', '/account/phone/verify', { phone, code: start.devCode }, token);

// Fund it from the demo user (a one-off Calibur batch the gateway key sends directly).
const pub = createPublicClient({ chain: net.chain, transport: http() });
const demo = privateKeyToAccount(process.env.DEMO_USER_PRIVATE_KEY as Hex);
const seq = await pub.readContract({ address: demo.address, abi: caliburAbi, functionName: 'getSeq', args: [0n] });
const fundDeadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const funding = [
  { to: net.ausd, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [user.address, parseUnits('0.1', AUSD_DECIMALS)] }) },
];
const fundSig = await demo.signTypedData(signedBatchTypedData(demo.address, net.chain.id, funding, seq, fundDeadline));
const gateway = createWalletClient({ account: privateKeyToAccount(process.env.GATEWAY_PRIVATE_KEY as Hex), chain: net.chain, transport: http() });
await pub.waitForTransactionReceipt({ hash: await gateway.sendTransaction({ to: demo.address, data: encodeExecute(funding, seq, fundDeadline, fundSig) }) });
console.log('          funded with 0.1 AUSD');

// First transfer over HTTPS, then its status.
type Quote = { id: string; fee: string; nonce: string; deadline: number };
const q = await api<Quote>('POST', '/tx/quote', { network: 'testnet', to: recipient, amount: '0.02' }, token);
const calls = transferWithFee(net.ausd, recipient, parseUnits('0.02', AUSD_DECIMALS), FEE_RECIPIENT, parseUnits(q.fee, AUSD_DECIMALS));
const sig = await user.signTypedData(signedBatchTypedData(user.address, net.chain.id, calls, BigInt(q.nonce), BigInt(q.deadline)));
const sent = await api<{ txHash: Hex }>('POST', '/tx/sign', { id: q.id, signature: sig }, token);
const status = await api<{ status: string; network: string }>('GET', `/tx/${q.id}`, undefined, token);
console.log(`          https: ${status.status} on ${status.network}  ${net.explorer}/tx/${sent.txHash}`);

// Second transfer by SMS, as if the user had gone offline.
const text = async (body: string) => {
  const { reply } = await api<{ reply: { body: string } | null }>('POST', '/dev/sms', { from: phone, body });
  console.log(`          > ${body.slice(0, 50)}${body.length > 50 ? '...' : ''}\n          < ${reply?.body}`);
  const parsed = reply ? parseReply(reply.body) : null;
  if (!parsed || parsed.kind === 'error') throw new Error(`gateway said: ${reply?.body}`);
  return parsed;
};
const sq = await text(formatCommand({ kind: 'send', to: recipient.toLowerCase(), amount: '0.03', deliver: 'AUSD' }, 'testnet'));
if (sq.kind !== 'quote') throw new Error('expected a quote');
const smsCalls = transferWithFee(net.ausd, recipient, parseUnits('0.03', AUSD_DECIMALS), FEE_RECIPIENT, parseUnits(sq.fee, AUSD_DECIMALS));
const smsSig = await user.signTypedData(signedBatchTypedData(user.address, net.chain.id, smsCalls, sq.nonce, BigInt(sq.expires)));
await text(formatCommand({ kind: 'sig', id: sq.id, signature: smsSig }, 'testnet'));

// Signing in again finds the account.
const back = await signIn();
console.log(`          sign in again: created=${back.created} ${back.name}`);

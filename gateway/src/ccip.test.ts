/**
 * ENS over CCIP-Read, ported from ender-backend's ccip.test.ts. The unit tests
 * check every answer the way EnderResolver.resolveCallback does; the last one
 * runs the real contract on anvil (bytecode from ender-backend/contracts/out,
 * fixtures/EnderResolver.bytecode) with viem following the OffchainLookup to
 * this gateway served locally. Skipped without anvil.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  recoverAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { d1, mockWorkers } from './test-env';

mockWorkers();
const { handleCcip, makeSignatureHash, resolve, SIGNATURE_TTL_SECONDS } = await import('./ccip');
const worker = (await import('./index')).default;
type Env = import('./env').Env;

const RESOLVER = '0x1111111111111111111111111111111111111111' as const;
const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const SIGNER = privateKeyToAccount(SIGNER_KEY).address;
const NODE = keccak256('0xdead');
const ALICE = { phone: '+919800000001', address: '0x7e9bce1e34dadc99a83da4edcdb56d288afa84c5' as Address, label: 'alice' };

const abi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function addr(bytes32 node) returns (address)',
  'function addr(bytes32 node, uint256 coinType) returns (bytes)',
  'function text(bytes32 node, string key) returns (string)',
  'function name(bytes32 node) returns (string)',
]);

const dnsName = (name: string): Hex =>
  toHex(new Uint8Array([...name.split('.').flatMap((l) => [l.length, ...new TextEncoder().encode(l)]), 0]));
const call = (name: string, inner: Hex): Hex => encodeFunctionData({ abi, functionName: 'resolve', args: [dnsName(name), inner] });
const addr = (): Hex => encodeFunctionData({ abi, functionName: 'addr', args: [NODE] });
const addrFor = (coinType: bigint): Hex => encodeFunctionData({ abi, functionName: 'addr', args: [NODE, coinType] });
const text = (key: string): Hex => encodeFunctionData({ abi, functionName: 'text', args: [NODE, key] });

let env: Env;
beforeEach(async () => {
  env = { DB: d1(), RESOLVER_ADDRESS: RESOLVER, RESOLVER_SIGNER_KEY: SIGNER_KEY, IP_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  await env.DB.prepare('INSERT INTO links (phone, address, network, created_at, label) VALUES (?, ?, ?, 0, ?)').bind(ALICE.phone, ALICE.address, 'mainnet', ALICE.label).run();
});

/** What `EnderResolver.resolveCallback` checks, so passing means the contract accepts it. */
const verify = async (request: Hex, payload: Hex, target: Address = RESOLVER) => {
  const [result, expires, signature] = decodeAbiParameters([{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }], payload);
  return { result, expires, recovered: await recoverAddress({ hash: makeSignatureHash({ target, expires, request, result }), signature }) };
};
const answer = async (name: string, inner: Hex) => {
  const request = call(name, inner);
  const { result, recovered } = await verify(request, await resolve(env, request));
  expect(recovered).toBe(SIGNER);
  return result;
};
const asAddress = (r: Hex) => decodeAbiParameters([{ type: 'address' }], r)[0].toLowerCase();
const asBytes = (r: Hex) => decodeAbiParameters([{ type: 'bytes' }], r)[0];
const asString = (r: Hex) => decodeAbiParameters([{ type: 'string' }], r)[0];

test('the digest matches the contract (vector pinned in EnderResolver.t.sol)', () => {
  expect(makeSignatureHash({ target: RESOLVER, expires: 1234567890n, request: '0xdeadbeef', result: '0xc0ffee' })).toBe(
    '0x74b1fac9ddad4c6896423518c4e67dbca7ada50ea377519627d27490de7162db',
  );
});

test('addr(node) is the public address, signed so the contract accepts it; any case', async () => {
  expect(asAddress(await answer('alice.ender.my', addr()))).toBe(ALICE.address);
  expect(asAddress(await answer('ALICE.Ender.MY', addr()))).toBe(ALICE.address);
});

test('every EVM coin type (60, Monad 0x80000000|143, the ENSIP-19 default) is the same address, as bytes', async () => {
  for (const coinType of [60n, 0x80000000n | 143n, 0x80000000n, 0x80002105n]) expect(asBytes(await answer('alice.ender.my', addrFor(coinType)))).toBe(ALICE.address);
  // Not EVM: Bitcoin, and anything past the ENSIP-11 range.
  for (const coinType of [0n, 501n, 0x100000000n]) expect(asBytes(await answer('alice.ender.my', addrFor(coinType)))).toBe('0x');
});

test('text "url" is the pay page, name() the name, other records empty', async () => {
  expect(asString(await answer('alice.ender.my', text('url')))).toBe('https://alice.ender.my');
  expect(asString(await answer('alice.ender.my', encodeFunctionData({ abi, functionName: 'name', args: [NODE] })))).toBe('alice.ender.my');
  expect(asString(await answer('alice.ender.my', text('avatar')))).toBe('');
});

test('an unknown name is a signed zero address / empty record, not an error', async () => {
  expect(asAddress(await answer('nobody.ender.my', addr()))).toBe(zeroAddress);
  expect(asBytes(await answer('nobody.ender.my', addrFor(60n)))).toBe('0x');
  expect(asString(await answer('nobody.ender.my', text('url')))).toBe('');
});

test('refuses another parent, a nested name and the bare parent', async () => {
  await expect(resolve(env, call('alice.ender.eth', addr()))).rejects.toThrow(/Unknown parent/);
  await expect(resolve(env, call('a.alice.ender.my', addr()))).rejects.toThrow(/Unknown parent/);
  await expect(resolve(env, call('ender.my', addr()))).rejects.toThrow(/Unknown parent/);
});

test('a signature is bound to its request, its resolver, and expires within the TTL', async () => {
  const request = call('alice.ender.my', addr());
  const payload = await resolve(env, request);
  expect((await verify(call('nobody.ender.my', addr()), payload)).recovered).not.toBe(SIGNER);
  expect((await verify(request, payload, '0x2222222222222222222222222222222222222222')).recovered).not.toBe(SIGNER);
  const { expires } = await verify(request, payload);
  expect(Number(expires) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(SIGNATURE_TTL_SECONDS);
});

const http_ = (path: string, init?: RequestInit) => {
  const url = new URL(`https://api.ender.money${path}`);
  return handleCcip(new Request(url, init), url, env);
};

test('templated GET and POST, readable cross-origin; relayed by the DNS resolver still signed for ours', async () => {
  const request = call('alice.ender.my', addr());
  const get = await http_(`/ccip/${RESOLVER}/${request}.json`);
  expect(get.status).toBe(200);
  expect(get.headers.get('access-control-allow-origin')).toBe('*');
  const post = await http_('/ccip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender: RESOLVER, data: request }) });
  expect(post.status).toBe(200);
  // ENS's OffchainDNSResolver re-raises our lookup as its own sender.
  const relayed = await http_(`/ccip/0xF142B308cF687d4358410a4cB885513b30A42025/${request}.json`);
  expect((await verify(request, ((await relayed.json()) as { data: Hex }).data)).recovered).toBe(SIGNER);
});

test('bad calldata is 400, unconfigured 503, and the route is rate-limited per IP', async () => {
  const request = call('alice.ender.my', addr());
  expect((await http_(`/ccip/${RESOLVER}/not-hex.json`)).status).toBe(400);
  expect((await http_(`/ccip/${RESOLVER}/0xdeadbeef.json`)).status).toBe(400);
  const limited = { ...env, IP_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: !key.startsWith('ccip:') }) } } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  expect((await worker.fetch!(new Request(`https://api.ender.money/ccip/${RESOLVER}/${request}.json`) as never, limited, ctx)).status).toBe(429);
  env = { ...env, RESOLVER_ADDRESS: '' };
  expect((await http_(`/ccip/${RESOLVER}/${request}.json`)).status).toBe(503);
});

// ---------------------------------------------------------------- the real contract

const ANVIL = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
const BYTECODE = readFileSync(join(import.meta.dir, 'fixtures', 'EnderResolver.bytecode'), 'utf8').trim() as Hex;
const PORT = 18571;
let anvil: ReturnType<typeof spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!existsSync(ANVIL)) return;
  anvil = spawn(ANVIL, ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  const pub = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${PORT}`) });
  for (let i = 0; i < 50; i++) if (await pub.getChainId().catch(() => 0)) break; else await Bun.sleep(100);
});
afterAll(() => {
  anvil?.kill();
  void server?.stop(true);
});

test.skipIf(!existsSync(ANVIL))('EnderResolver on anvil accepts the gateway answer through viem CCIP-Read, and refuses another signer', async () => {
  const rpc = http(`http://127.0.0.1:${PORT}`);
  const deployer = mnemonicToAccount('test test test test test test test test test test test junk'); // anvil's dev account
  const wallet = createWalletClient({ account: deployer, chain: foundry, transport: rpc });
  const pub = createPublicClient({ chain: foundry, transport: rpc });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  server = Bun.serve({ port: 0, fetch: (req) => worker.fetch!(req as never, env, ctx) as unknown as Promise<Response> });
  const deployAbi = parseAbi(['constructor(string[] urls, address[] signers)']);
  const hash = await wallet.deployContract({
    abi: deployAbi,
    bytecode: BYTECODE,
    args: [[`http://127.0.0.1:${server.port}/ccip/{sender}/{data}.json`], [SIGNER]],
  });
  const resolver = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  env = { ...env, RESOLVER_ADDRESS: resolver };

  const lookup = (inner: Hex) => pub.readContract({ address: resolver, abi, functionName: 'resolve', args: [dnsName('alice.ender.my'), inner] });
  expect(asAddress(await lookup(addr()))).toBe(ALICE.address);
  expect(asBytes(await lookup(addrFor(0x80000000n | 143n)))).toBe(ALICE.address);
  expect(asString(await lookup(text('url')))).toBe('https://alice.ender.my');

  env = { ...env, RESOLVER_SIGNER_KEY: `0x${'42'.repeat(32)}` };
  await expect(lookup(addr())).rejects.toThrow(/UntrustedSigner|revert/i);
});

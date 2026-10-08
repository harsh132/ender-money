/**
 * Auto-bridge end to end on an anvil fork of Base, against Relay's real API:
 * a fresh EOA holds USDC (written into the token's storage), the gateway
 * prepares (a real draft quote, the batch simulated on the fork), the app's
 * code fetches the real quote with our fee and signs the authorization and the
 * batch, and the gateway's submit sends it through the real Sponsor. The one
 * transaction must land, delegate the address to Calibur and move the USDC
 * into Relay's contract. (Relay never sees the fork, so nothing is bridged.)
 *
 * Opt-in: BRIDGE_E2E=1 with anvil installed. BRIDGE_FORK_URL picks the Base
 * RPC to fork (default https://mainnet.base.org).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { relayQuote } from '../../protocol/bridge';
import { erc20Abi, isDelegatedToCalibur } from '../../protocol/calibur';
import { signBridge } from '../../app/src/lib/bridge';
import { d1, mockWorkers } from './test-env';

const ANVIL = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
const PORT = 18571;
const RPC = `http://127.0.0.1:${PORT}`;
const ready = process.env.BRIDGE_E2E === '1' && existsSync(ANVIL);
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** FiatToken v2.2 keeps balances (and the blacklist bit) in the mapping at slot 9. */
const USDC_BALANCES_SLOT = 9n;
const AMOUNT = 25_000_000n; // 25 USDC

mockWorkers();
const { Sponsor } = await import('./sponsor');
const bridge = await import('./bridge');
type Env = import('./env').Env;

const pub = createPublicClient({ chain: base, transport: http(RPC) });
const rpc = (method: string, params: unknown[]) =>
  fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());

let anvil: ReturnType<typeof spawn> | undefined;

beforeAll(async () => {
  if (!ready) return;
  anvil = spawn(ANVIL, ['--fork-url', process.env.BRIDGE_FORK_URL ?? 'https://mainnet.base.org', '--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    if (await pub.getChainId().then(() => true, () => false)) break;
    if (i > 600) throw new Error('anvil did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}, 90_000);

afterAll(() => {
  anvil?.kill();
});

test.skipIf(!ready)(
  'one sponsored type-4 transaction delegates the fresh EOA and deposits its USDC with Relay',
  async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const gatewayKey = generatePrivateKey();
    const me = user.address.toLowerCase() as Address;
    // USDC for the user, gas for the gateway key; the user has no ETH at all.
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [user.address, USDC_BALANCES_SLOT]));
    await rpc('anvil_setStorageAt', [USDC, slot, pad(toHex(AMOUNT), { size: 32 })]);
    await rpc('anvil_setBalance', [privateKeyToAccount(gatewayKey).address, toHex(10n ** 18n)]);
    expect(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })).toBe(AMOUNT);

    const sponsors = new Map<string, InstanceType<typeof Sponsor>>();
    const env = { DB: d1(), GATEWAY_PRIVATE_KEY: gatewayKey, RPC_BASE: RPC } as unknown as Env;
    (env as { SPONSOR: unknown }).SPONSOR = {
      idFromName: (n: string) => n,
      get: (n: string) => sponsors.get(n) ?? sponsors.set(n, new Sponsor({} as DurableObjectState, env)).get(n)!,
    };
    await env.DB.prepare('INSERT INTO links (address, network, created_at) VALUES (?, ?, 0)').bind(me, 'mainnet').run();

    const p = await bridge.prepare(env, me, { chainId: 8453, token: USDC });
    expect(p).toMatchObject({ amount: AMOUNT.toString(), delegated: false, nonce: '0', authNonce: 0 });
    const q = await relayQuote({ user: user.address, originChainId: 8453, token: USDC, amount: AMOUNT, bps: p.bps });
    const body = await signBridge(user as Parameters<typeof signBridge>[0], p, q); // the app resolves its own copy of viem
    const target = body.calls.at(-1)!.to;
    const before = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [target] });

    const { txHash } = await bridge.submit(env, me, body);
    const receipt = await pub.getTransactionReceipt({ hash: txHash as Hex });
    const prepared = await env.DB.prepare('SELECT max_cost FROM bridges').first<{ max_cost: string }>();
    console.log(`bridge e2e: ${p.bps} bps, gas used ${receipt.gasUsed}, fee pays for up to ${prepared!.max_cost} wei, cost ${receipt.gasUsed * receipt.effectiveGasPrice} wei + L1`);
    expect(receipt.status).toBe('success');
    expect(receipt.type).toBe('eip7702');
    expect(isDelegatedToCalibur(await pub.getCode({ address: user.address }))).toBe(true);
    expect(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })).toBe(0n);
    expect(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [target] })).toBe(before + AMOUNT);
    expect(await pub.getBalance({ address: user.address })).toBe(0n);
  },
  120_000,
);

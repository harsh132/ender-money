/**
 * Alchemy webhooks with fetch mocked: Alchemy's Notify API, a JSON-RPC
 * stand-in that answers eth_call (balanceOf, for alerts) and what
 * /wallet/create reads, and an Ethereum one for reverse ENS (the Universal
 * Resolver's answer per address). No real network calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { decodeFunctionData, encodeAbiParameters, pad, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CALIBUR, NETWORKS } from '../../protocol/networks';
import { d1, mockWorkers, relayStub, type Sent } from './test-env';

mockWorkers();
const { alchemyWebhook, syncAlchemy, WEBHOOK_CAPACITY } = await import('./alchemy');
const { ALERT_MAX_AGE } = await import('./activity');
const { ENS_TTL_SECONDS } = await import('./names');
const { createWallet } = await import('./auth');
const { openKey } = await import('./shielded');
type Env = import('./env').Env;

const ALICE = { phone: '+919800000001', address: '0x1111111111111111111111111111111111111111' as Address };
const BOB = { phone: '+919800000002', address: '0x2222222222222222222222222222222222222222' as Address };
const STRANGER = '0x3333333333333333333333333333333333333333' as Address;
const OTHER_TOKEN = '0x4444444444444444444444444444444444444444' as Address;
const SIGNING_KEY = 'whsec_test';
const AUSD = NETWORKS.testnet.ausd;

// ---------------------------------------------------------------- fetch stand-in

type Notify = { method: string; path: string; body: Record<string, unknown> };
let notifyCalls: Notify[];
let notifyDown: boolean;
/** Reverse ENS as the Universal Resolver answers it (already forward-verified), per lowercase address. */
let ens: Map<string, string>;
let ensCalls: number;
let ensDown: boolean;
const UR = parseAbi(['function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) returns (string, address, address)']);

const rpc = (method: string): unknown => {
  switch (method) {
    case 'eth_call':
      return encodeAbiParameters([{ type: 'uint256' }], [45_200_000n]);
    case 'eth_getTransactionCount':
      return '0x0';
    case 'eth_getCode':
      return `0xef0100${CALIBUR.slice(2)}`;
  }
  throw { code: -32601, message: `no ${method}` };
};

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://dashboard.alchemy.com/api/')) {
      const path = url.split('/api/')[1]!;
      notifyCalls.push({ method: init!.method!, path, body: JSON.parse(String(init!.body)) });
      if (notifyDown) return new Response('down', { status: 503 });
      if (path === 'create-webhook') return Response.json({ data: { id: `wh_${notifyCalls.length}`, signing_key: SIGNING_KEY } });
      return Response.json({});
    }
    if (url.startsWith('http://eth.test/')) {
      ensCalls++;
      if (ensDown) return new Response('down', { status: 503 });
      const req = JSON.parse(String(init!.body));
      const { args } = decodeFunctionData({ abi: UR, data: req.params[0].data });
      const name = ens.get(String(args[0]).toLowerCase()) ?? '';
      return Response.json({ jsonrpc: '2.0', id: req.id, result: encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'address' }], [name, zeroAddress, zeroAddress]) });
    }
    if (url.startsWith('http://rpc.test/')) {
      const req = JSON.parse(String(init!.body));
      try {
        return Response.json({ jsonrpc: '2.0', id: req.id, result: rpc(req.method) });
      } catch (error) {
        return Response.json({ jsonrpc: '2.0', id: req.id, error });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------- env

let env: Env;
let sent: Sent;

beforeEach(() => {
  notifyCalls = [];
  notifyDown = false;
  ens = new Map();
  ensCalls = 0;
  ensDown = false;
  sent = [];
  env = {
    DB: d1(),
    RELAY: relayStub(sent),
    JWT_SECRET: 'unit-test-jwt',
    SHIELDED_KEY_SECRET: 'unit-test-secret',
    ALCHEMY_AUTH_TOKEN: 'token',
    ALCHEMY_WEBHOOK_URL: 'https://gateway.test/webhooks/alchemy',
    RPC_MAINNET: 'http://rpc.test/mainnet',
    RPC_TESTNET: 'http://rpc.test/testnet',
    ETH_RPC_URL: 'http://eth.test/',
    SMS_RETRIEVER_HASH: 'FA+9qCX9VSu',
  } as unknown as Env;
});

const link = (who: { phone: string; address: Address }, createdAt = 0) =>
  env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, ?)').bind(who.phone, who.address, 'testnet', createdAt).run();
const rows = <T>(sql: string, ...params: Array<string | number>) => env.DB.prepare(sql).bind(...params).all<T>().then((r) => r.results);
const pushed = (network: string) => rows<{ address: string }>('SELECT address FROM alchemy_addresses WHERE network = ? ORDER BY address', network).then((r) => r.map((x) => x.address));

// ---------------------------------------------------------------- webhook management

describe('syncAlchemy', () => {
  test('first sync creates one webhook per network (Monad and the four auto-bridge chains) with every linked address, key sealed', async () => {
    await link(ALICE);
    await link(BOB, 1);
    await syncAlchemy(env);
    expect(notifyCalls).toEqual(
      ['MONAD_MAINNET', 'MONAD_TESTNET', 'ETH_MAINNET', 'BASE_MAINNET', 'ARB_MAINNET', 'MATIC_MAINNET'].map((network) => ({
        method: 'POST',
        path: 'create-webhook',
        body: { network, webhook_type: 'ADDRESS_ACTIVITY', webhook_url: 'https://gateway.test/webhooks/alchemy', addresses: [ALICE.address, BOB.address] },
      })),
    );
    const hooks = await rows<{ id: string; network: string; signing_key: string; addresses: number }>('SELECT * FROM alchemy_webhooks ORDER BY id');
    expect(hooks.map((h) => [h.id, h.network, h.addresses])).toEqual([
      ['wh_1', 'mainnet', 2],
      ['wh_2', 'testnet', 2],
      ['wh_3', 'ethereum', 2],
      ['wh_4', 'base', 2],
      ['wh_5', 'arbitrum', 2],
      ['wh_6', 'polygon', 2],
    ]);
    for (const h of hooks) {
      expect(h.signing_key).not.toContain(SIGNING_KEY);
      expect(await openKey(env.SHIELDED_KEY_SECRET, h.signing_key, `alchemy|${h.id}`)).toBe(SIGNING_KEY);
    }
    expect(await pushed('testnet')).toEqual([ALICE.address, BOB.address]);

    // Nothing new, nothing sent.
    notifyCalls = [];
    await syncAlchemy(env);
    expect(notifyCalls).toEqual([]);
  });

  test('/wallet/create pushes the new address onto the existing webhooks', async () => {
    await link(BOB);
    await syncAlchemy(env);
    notifyCalls = [];

    const owner = privateKeyToAccount(generatePrivateKey());
    const authorizations = Object.fromEntries(
      await Promise.all(
        (['mainnet', 'testnet'] as const).map(async (n) => [
          n,
          await owner.signAuthorization({ contractAddress: CALIBUR, chainId: NETWORKS[n].chain.id, nonce: 0 }),
        ]),
      ),
    );
    await createWallet(env, ALICE.phone, { address: owner.address, authorizations, name: 'alice' });

    const me = owner.address.toLowerCase();
    const hooks = [1, 2, 3, 4, 5, 6].map((i) => `wh_${i}`);
    expect(notifyCalls).toEqual(
      hooks.map((webhook_id) => ({ method: 'PATCH', path: 'update-webhook-addresses', body: { webhook_id, addresses_to_add: [me], addresses_to_remove: [] } })),
    );
    expect(await rows('SELECT id, addresses FROM alchemy_webhooks ORDER BY id')).toEqual(hooks.map((id) => ({ id, addresses: 2 })));
  });

  test('a full webhook takes what fits and the rest starts a new one', async () => {
    await env.DB.prepare('INSERT INTO alchemy_webhooks (id, network, signing_key, addresses, created_at) VALUES (?, ?, ?, ?, 0)')
      .bind('wh_full', 'testnet', 'k', WEBHOOK_CAPACITY - 1)
      .run();
    await link(ALICE);
    await link(BOB, 1);
    await syncAlchemy(env);
    const testnet = notifyCalls.filter((c) => c.path === 'update-webhook-addresses' || c.body.network === 'MONAD_TESTNET');
    expect(testnet.map((c) => [c.path, c.body.addresses_to_add ?? c.body.addresses])).toEqual([
      ['update-webhook-addresses', [ALICE.address]],
      ['create-webhook', [BOB.address]],
    ]);
    expect(await pushed('testnet')).toEqual([ALICE.address, BOB.address]);
  });

  test('a failure leaves the addresses for the cron, and never throws', async () => {
    await link(ALICE);
    notifyDown = true;
    await syncAlchemy(env);
    expect(await pushed('testnet')).toEqual([]);
    notifyDown = false;
    await syncAlchemy(env);
    expect(await pushed('testnet')).toEqual([ALICE.address]);
  });

  test('without a token nothing is made', async () => {
    await link(ALICE);
    await syncAlchemy({ ...env, ALCHEMY_AUTH_TOKEN: undefined });
    expect(notifyCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------- deliveries

const hmac = async (body: string, key: string) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const deliver = async (payload: unknown, signature?: string | null) => {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {};
  const sig = signature === undefined ? await hmac(body, SIGNING_KEY) : signature;
  if (sig !== null) headers['x-alchemy-signature'] = sig;
  const waits: Promise<unknown>[] = [];
  const response = await alchemyWebhook(new Request('https://gateway.test/webhooks/alchemy', { method: 'POST', headers, body }), env, {
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  } as unknown as ExecutionContext);
  await Promise.all(waits);
  return response;
};

const token = (o: { hash: string; from: Address; to: Address; contract?: Address; value?: bigint; logIndex?: number; removed?: boolean }) => ({
  blockNum: '0xf4240',
  hash: o.hash,
  fromAddress: o.from,
  toAddress: o.to,
  value: 10,
  asset: 'AUSD',
  category: 'token',
  rawContract: { address: o.contract ?? AUSD.toLowerCase(), rawValue: toHex(o.value ?? 10_000_000n, { size: 32 }), decimals: 6 },
  log: { address: o.contract ?? AUSD, blockNumber: '0xf4240', logIndex: toHex(o.logIndex ?? 0), removed: o.removed ?? false },
});

const delivery = (activity: unknown[], createdAt = new Date().toISOString()) => ({
  webhookId: 'wh_2', // testnet's, as made by syncAlchemy
  id: 'whevt_1',
  createdAt,
  type: 'ADDRESS_ACTIVITY',
  event: { network: 'MONAD_TESTNET', activity },
});

const tx = (n: number) => pad(toHex(n)) as Hex;

describe('POST /webhooks/alchemy', () => {
  beforeEach(async () => {
    await link(ALICE);
    await link(BOB, 1);
    await syncAlchemy(env);
  });

  test('records AUSD transfers touching a linked address and alerts the recipient once', async () => {
    const payload = delivery([
      token({ hash: tx(1), from: STRANGER, to: ALICE.address }),
      // Not AUSD.
      token({ hash: tx(2), from: STRANGER, to: ALICE.address, contract: OTHER_TOKEN }),
      // Taken back by a reorg.
      token({ hash: tx(3), from: STRANGER, to: ALICE.address, removed: true }),
      // Nobody of ours.
      token({ hash: tx(4), from: STRANGER, to: STRANGER }),
      // Native MON, not a token.
      { ...token({ hash: tx(5), from: STRANGER, to: ALICE.address }), category: 'external' },
    ]);
    const response = await deliver(payload);
    expect(response.status).toBe(200);
    expect(await response.json<{ recorded: number }>()).toEqual({ recorded: 1 });
    expect(await rows('SELECT network, tx_hash, log_index, from_address, to_address, amount, block FROM transfers')).toEqual([
      { network: 'testnet', tx_hash: tx(1), log_index: 0, from_address: STRANGER, to_address: ALICE.address, amount: '10000000', block: 1_000_000 },
    ]);
    expect(sent).toEqual([{ to: ALICE.phone, body: `[Test] Received 10 AUSD from=${STRANGER} balance=45.2 tx=0x0000...01${'\n'}FA+9qCX9VSu` }]);

    // Delivered again: no new row, no second text.
    expect((await deliver(payload)).status).toBe(200);
    expect((await rows('SELECT * FROM transfers')).length).toBe(1);
    expect(sent.length).toBe(1);
  });

  test('the alert names the sender by Ender ID, else full address; never by number, even when they are on Ender', async () => {
    const bob = '0x7e9bce1e34dadc99a83da4edcdb56d288afa84c5' as Address;
    await env.DB.prepare('UPDATE links SET address = ? WHERE phone = ?').bind(bob, BOB.phone).run();
    expect((await deliver(delivery([token({ hash: tx(7), from: bob, to: ALICE.address })]))).status).toBe(200);
    expect(sent).toEqual([{ to: ALICE.phone, body: `[Test] Received 10 AUSD from=0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5 balance=45.2 tx=0x0000...07${'\n'}FA+9qCX9VSu` }]);
    // With an Ender ID: the ID, ahead of any ENS name (not even asked for).
    ens.set(bob, 'bob.eth');
    await env.DB.prepare('UPDATE links SET label = ? WHERE phone = ?').bind('bobby', BOB.phone).run();
    ensCalls = 0;
    await deliver(delivery([token({ hash: tx(8), from: bob, to: ALICE.address })]));
    expect(sent[1]!.body).toBe(`[Test] Received 10 AUSD from=bobby.ender.my balance=45.2 tx=0x0000...08${'\n'}FA+9qCX9VSu`);
    expect(ensCalls).toBe(0);
    for (const s of sent) expect(s.body).not.toContain('98000');
  });

  test('a sender with a verified ENS name shows by it, cached a week; unusable names and RPC failures show the address', async () => {
    ens.set(STRANGER, 'stranger.eth');
    await deliver(delivery([token({ hash: tx(1), from: STRANGER, to: ALICE.address })]));
    expect(sent[0]!.body).toBe(`[Test] Received 10 AUSD from=stranger.eth balance=45.2 tx=0x0000...01${'\n'}FA+9qCX9VSu`);
    expect(await rows('SELECT address, name FROM ens_names')).toEqual([{ address: STRANGER, name: 'stranger.eth' }]);
    // Cached: no second lookup, even with the RPC down.
    ensDown = true;
    await deliver(delivery([token({ hash: tx(2), from: STRANGER, to: ALICE.address })]));
    expect(sent[1]!.body).toContain('from=stranger.eth ');
    expect(ensCalls).toBe(1);
    // A week on it is rechecked; a failed recheck keeps the cached name.
    await env.DB.prepare('UPDATE ens_names SET checked_at = checked_at - ?').bind(ENS_TTL_SECONDS).run();
    await deliver(delivery([token({ hash: tx(3), from: STRANGER, to: ALICE.address })]));
    expect(sent[2]!.body).toContain('from=stranger.eth ');
    expect(ensCalls).toBe(2);

    // RPC down and nothing cached: the address, and the alert still goes.
    const other = '0x5555555555555555555555555555555555555555' as Address;
    await deliver(delivery([token({ hash: tx(4), from: other, to: ALICE.address })]));
    expect(sent[3]!.body).toContain(`from=${other} `);
    ensDown = false;
    // Over 40 characters, non-ASCII, or a two-septet character: the address (cached as no name).
    const names = [`${'x'.repeat(37)}.eth`, 'café.eth', 'a^b.eth'];
    for (const [i, name] of names.entries()) {
      const from = toHex(0x6000 + i, { size: 20 }) as Address; // digits only: the same in EIP-55
      ens.set(from, name);
      await deliver(delivery([token({ hash: tx(10 + i), from, to: ALICE.address })]));
      expect(sent.at(-1)!.body).toContain(`from=${from} `);
    }
    expect(await rows('SELECT name FROM ens_names WHERE address LIKE ?', '%600_')).toEqual([{ name: null }, { name: null }, { name: null }]);
    expect(sent).toHaveLength(4 + names.length);
  });

  test('a stale delivery is recorded without a text', async () => {
    const old = new Date(Date.now() - (ALERT_MAX_AGE + 60) * 1000).toISOString();
    expect((await deliver(delivery([token({ hash: tx(1), from: STRANGER, to: ALICE.address })], old))).status).toBe(200);
    expect((await rows('SELECT * FROM transfers')).length).toBe(1);
    expect(sent).toEqual([]);
  });

  test('a valid delivery with nothing of ours is still 200', async () => {
    const response = await deliver(delivery([token({ hash: tx(4), from: STRANGER, to: STRANGER })]));
    expect(response.status).toBe(200);
    expect(await response.json<{ recorded: number }>()).toEqual({ recorded: 0 });
  });

  test('bad, missing or foreign signatures write nothing', async () => {
    const payload = delivery([token({ hash: tx(1), from: STRANGER, to: ALICE.address })]);
    expect((await deliver(payload, await hmac(JSON.stringify(payload), 'whsec_forged'))).status).toBe(401);
    expect((await deliver(payload, null)).status).toBe(401);
    expect((await deliver({ ...payload, webhookId: 'wh_unknown' })).status).toBe(401);
    expect(await rows('SELECT * FROM transfers')).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('POST /webhooks/alchemy on an auto-bridge chain', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
  const base = (activity: unknown[]) => ({ ...delivery(activity), webhookId: 'wh_4', event: { network: 'BASE_MAINNET', activity } });
  const native = (to: Address, value = 10n ** 15n, category = 'external') => ({
    hash: tx(20),
    fromAddress: STRANGER,
    toAddress: to,
    category,
    asset: 'ETH',
    rawContract: { rawValue: toHex(value), decimals: 18 },
  });

  beforeEach(async () => {
    await link(ALICE);
    await link(BOB, 1);
    await syncAlchemy(env);
  });

  test('incoming tokens and coins to a linked address are noted per (address, chain, token); nothing else, no texts', async () => {
    const response = await deliver(
      base([
        token({ hash: tx(1), from: STRANGER, to: ALICE.address, contract: USDC }),
        // The same token again in this delivery: one row.
        token({ hash: tx(2), from: STRANGER, to: ALICE.address, contract: USDC, logIndex: 1 }),
        native(ALICE.address),
        // From a contract (internal) to Bob.
        native(BOB.address, 5n, 'internal'),
        // Outgoing, a stranger's, an NFT, a reorged log, nothing moved.
        token({ hash: tx(3), from: ALICE.address, to: STRANGER, contract: USDC }),
        token({ hash: tx(4), from: STRANGER, to: STRANGER, contract: USDC }),
        { ...token({ hash: tx(5), from: STRANGER, to: ALICE.address, contract: OTHER_TOKEN }), erc721TokenId: '0x1' },
        token({ hash: tx(6), from: STRANGER, to: ALICE.address, contract: OTHER_TOKEN, removed: true }),
        native(ALICE.address, 0n),
      ]),
    );
    expect(response.status).toBe(200);
    expect(await response.json<{ recorded: number }>()).toEqual({ recorded: 3 });
    expect(await rows('SELECT address, chain_id, token, retry_at FROM foreign_balances ORDER BY address, token')).toEqual([
      { address: ALICE.address, chain_id: 8453, token: '0x0000000000000000000000000000000000000000', retry_at: 0 },
      { address: ALICE.address, chain_id: 8453, token: USDC, retry_at: 0 },
      { address: BOB.address, chain_id: 8453, token: '0x0000000000000000000000000000000000000000', retry_at: 0 },
    ]);
    // Not AUSD on Monad: no transfer row, no alert.
    expect(await rows('SELECT * FROM transfers')).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a new transfer clears the wait on a balance that was skipped', async () => {
    await env.DB.prepare('INSERT INTO foreign_balances (address, chain_id, token, seen_at, retry_at) VALUES (?, 8453, ?, 0, 9999999999)').bind(ALICE.address, USDC).run();
    await deliver(base([token({ hash: tx(1), from: STRANGER, to: ALICE.address, contract: USDC })]));
    expect(await rows('SELECT retry_at FROM foreign_balances')).toEqual([{ retry_at: 0 }]);
  });

  test("signed with the Base webhook's own key only", async () => {
    const payload = base([native(ALICE.address)]);
    expect((await deliver(payload, await hmac(JSON.stringify(payload), 'whsec_forged'))).status).toBe(401);
    expect(await rows('SELECT * FROM foreign_balances')).toEqual([]);
  });
});

/**
 * Alchemy webhooks with fetch mocked: Alchemy's Notify API and a JSON-RPC
 * stand-in that answers eth_call (balanceOf, for alerts) and what
 * /wallet/create reads. No real network calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeAbiParameters, pad, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CALIBUR, NETWORKS } from '../../protocol/networks';
import { d1, mockWorkers, relayStub, type Sent } from './test-env';

mockWorkers();
const { alchemyWebhook, syncAlchemy, WEBHOOK_CAPACITY } = await import('./alchemy');
const { ALERT_MAX_AGE } = await import('./activity');
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
    SMS_RETRIEVER_HASH: 'FA+9qCX9VSu',
  } as unknown as Env;
});

const link = (who: { phone: string; address: Address }, createdAt = 0) =>
  env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, ?)').bind(who.phone, who.address, 'testnet', createdAt).run();
const rows = <T>(sql: string, ...params: Array<string | number>) => env.DB.prepare(sql).bind(...params).all<T>().then((r) => r.results);
const pushed = (network: string) => rows<{ address: string }>('SELECT address FROM alchemy_addresses WHERE network = ? ORDER BY address', network).then((r) => r.map((x) => x.address));

// ---------------------------------------------------------------- webhook management

describe('syncAlchemy', () => {
  test('first sync creates one webhook per network with every linked address, key sealed', async () => {
    await link(ALICE);
    await link(BOB, 1);
    await syncAlchemy(env);
    expect(notifyCalls).toEqual([
      {
        method: 'POST',
        path: 'create-webhook',
        body: { network: 'MONAD_MAINNET', webhook_type: 'ADDRESS_ACTIVITY', webhook_url: 'https://gateway.test/webhooks/alchemy', addresses: [ALICE.address, BOB.address] },
      },
      {
        method: 'POST',
        path: 'create-webhook',
        body: { network: 'MONAD_TESTNET', webhook_type: 'ADDRESS_ACTIVITY', webhook_url: 'https://gateway.test/webhooks/alchemy', addresses: [ALICE.address, BOB.address] },
      },
    ]);
    const hooks = await rows<{ id: string; network: string; signing_key: string; addresses: number }>('SELECT * FROM alchemy_webhooks ORDER BY network');
    expect(hooks.map((h) => [h.id, h.network, h.addresses])).toEqual([
      ['wh_1', 'mainnet', 2],
      ['wh_2', 'testnet', 2],
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
    await createWallet(env, ALICE.phone, { address: owner.address, authorizations });

    const me = owner.address.toLowerCase();
    expect(notifyCalls).toEqual([
      { method: 'PATCH', path: 'update-webhook-addresses', body: { webhook_id: 'wh_1', addresses_to_add: [me], addresses_to_remove: [] } },
      { method: 'PATCH', path: 'update-webhook-addresses', body: { webhook_id: 'wh_2', addresses_to_add: [me], addresses_to_remove: [] } },
    ]);
    expect(await rows('SELECT id, addresses FROM alchemy_webhooks ORDER BY id')).toEqual([
      { id: 'wh_1', addresses: 2 },
      { id: 'wh_2', addresses: 2 },
    ]);
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

  test('the alert names the sender by full address, never by number, even when they are on Ender', async () => {
    const bob = '0x7e9bce1e34dadc99a83da4edcdb56d288afa84c5' as Address;
    await env.DB.prepare('UPDATE links SET address = ? WHERE phone = ?').bind(bob, BOB.phone).run();
    expect((await deliver(delivery([token({ hash: tx(7), from: bob, to: ALICE.address })]))).status).toBe(200);
    expect(sent).toEqual([{ to: ALICE.phone, body: `[Test] Received 10 AUSD from=0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5 balance=45.2 tx=0x0000...07${'\n'}FA+9qCX9VSu` }]);
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

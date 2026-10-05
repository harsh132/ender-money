/**
 * Ender IDs on the gateway, no chain: label rules, signup with a name (required,
 * unique under a race, carried by a relink), the one-time claim, lookups (public
 * by name, signed-in by number, rate-limited, never a phone number), the pay
 * page, and SEND / PAY to a name by SMS. JSON-RPC is a stand-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { bytesToBigInt, encodeAbiParameters } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MAX_LABEL, RESERVED_LABELS, validateLabel } from '../../protocol/names';
import { CALIBUR, NETWORKS } from '../../protocol/networks';
import { encodePrivateAddress, shortPrivateAddress } from '../../protocol/recipient';
import { newUser, owner, packAddress, provingKeys } from '../../protocol/shielded';
import { b64, parseReply } from '../../protocol/sms';
import { d1, mockWorkers } from './test-env';

mockWorkers();
const worker = (await import('./index')).default;
const { createWallet } = await import('./auth');
const { claim } = await import('./names');
const { register } = await import('./shielded');
const { handleInbound, sentTo } = await import('./sms');
const { signJwt } = await import('./jwt');
type Env = import('./env').Env;

const ALICE = '+919800000001';
const BOB = '+919800000002';
const CAROL = '+919800000003';

// ---------------------------------------------------------------- JSON-RPC stand-in: delegated accounts with 45.2 AUSD

const rpc = (method: string): unknown => {
  switch (method) {
    case 'eth_call': // Multicall3 aggregate3: [balanceOf, getSeq]
      return encodeAbiParameters(
        [{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }],
        [[[true, encodeAbiParameters([{ type: 'uint256' }], [45_200_000n])], [true, encodeAbiParameters([{ type: 'uint256' }], [7n])]]],
      );
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
    if (!url.startsWith('http://rpc.test/')) throw new Error(`unexpected fetch ${url}`);
    const req = JSON.parse(String(init!.body));
    const one = (r: { id: number; method: string }) => {
      try {
        return { jsonrpc: '2.0', id: r.id, result: rpc(r.method) };
      } catch (error) {
        return { jsonrpc: '2.0', id: r.id, error };
      }
    };
    return Response.json(Array.isArray(req) ? req.map(one) : one(req));
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------- env

let env: Env;
let hits: Map<string, number>;
const LIMIT = 5;
beforeEach(() => {
  hits = new Map();
  env = {
    DB: d1(),
    JWT_SECRET: 'unit-test-jwt',
    FEE_AUSD: '0.01',
    SHIELDED_KEY_SECRET: 'unit-test-secret',
    RPC_MAINNET: 'http://rpc.test/mainnet',
    RPC_TESTNET: 'http://rpc.test/testnet',
    IP_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        hits.set(key, (hits.get(key) ?? 0) + 1);
        return { success: hits.get(key)! <= LIMIT };
      },
    },
  } as unknown as Env;
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = async (path: string, init: RequestInit & { as?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.as) headers.set('authorization', `Bearer ${await signJwt(env.JWT_SECRET, { phone: init.as, address: '' }, 600)}`);
  const res = await worker.fetch!(new Request(path.startsWith('http') ? path : `https://api.ender.money${path}`, { ...init, headers }) as never, env, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON or HTML, checked by each test
  return { status: res.status, body: (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as any };
};

const signUp = async (phone: string, req: { name?: unknown; relink?: boolean } = {}, key = generatePrivateKey()) => {
  const account = privateKeyToAccount(key);
  const authorizations = Object.fromEntries(
    await Promise.all(
      (['mainnet', 'testnet'] as const).map(async (n) => [n, await account.signAuthorization({ contractAddress: CALIBUR, chainId: NETWORKS[n].chain.id, nonce: 0 })]),
    ),
  );
  return createWallet(env, phone, { address: account.address, authorizations, ...req });
};
const link = (phone: string, address: string, label: string | null) =>
  env.DB.prepare('INSERT INTO links (phone, address, network, created_at, label) VALUES (?, ?, ?, 0, ?)').bind(phone, address, 'mainnet', label).run();
const labelOf = async (phone: string) => (await env.DB.prepare('SELECT label FROM links WHERE phone = ?').bind(phone).first<{ label: string | null }>())?.label;

// ---------------------------------------------------------------- rules

test('label rules: 5-30 of a-z 0-9 and interior single hyphens, any case, not reserved', () => {
  for (const ok of ['harsh', 'Harsh', 'h4rsh-p', 'a1b2c', 'x'.repeat(MAX_LABEL)]) expect(validateLabel(ok)).toBeUndefined();
  expect(validateLabel('abcd')).toBe('too-short');
  expect(validateLabel('x'.repeat(MAX_LABEL + 1))).toBe('too-long');
  for (const bad of ['har sh', 'harsh.ender', 'hаrsh' /* Cyrillic а */, 'harsh_p', 'härsh', '@harsh']) expect(validateLabel(bad)).toBe('characters');
  for (const bad of ['-harsh', 'harsh-', 'ha--rsh', 'xn--abc']) expect(validateLabel(bad)).toBe('hyphens');
  for (const r of RESERVED_LABELS.filter((l) => l.length >= 5)) expect(validateLabel(r)).toBe('reserved');
  expect(validateLabel('Admin')).toBe('reserved');
});

test('GET /names/check: reasons, taken (any case), per-IP limit', async () => {
  await link(BOB, '0x000000000000000000000000000000000000b0b0', 'bobby');
  expect((await call('/names/check?label=harsh')).body).toEqual({ available: true });
  expect((await call('/names/check?label=BOBBY')).body).toEqual({ available: false, reason: 'taken' });
  expect((await call('/names/check?label=ab')).body).toEqual({ available: false, reason: 'too-short' });
  expect((await call('/names/check?label=support')).body).toEqual({ available: false, reason: 'reserved' });
  expect((await call('/names/check?label=a-')).body).toEqual({ available: false, reason: 'hyphens' });
  expect((await call('/names/check?label=harsh')).status).toBe(429); // the 6th call from this IP
});

// ---------------------------------------------------------------- signup

describe('/wallet/create', () => {
  test('a new account must bring a valid, free name; it is stored lowercase', async () => {
    await expect(signUp(ALICE)).rejects.toThrow('name-required');
    await expect(signUp(ALICE, { name: 'ab' })).rejects.toThrow('bad-name');
    await expect(signUp(ALICE, { name: 7 })).rejects.toThrow('bad-name');
    expect((await signUp(ALICE, { name: 'Alice' })).name).toBe('alice.ender.my');
    expect(await labelOf(ALICE)).toBe('alice');
    await expect(signUp(BOB, { name: 'ALICE' })).rejects.toThrow('name-taken');
    expect(await labelOf(BOB)).toBeUndefined();
  });

  test('two signups racing for one name: one gets it, the other name-taken and no link', async () => {
    const results = await Promise.allSettled([signUp(ALICE, { name: 'samename' }), signUp(BOB, { name: 'samename' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('name-taken');
    const rows = (await env.DB.prepare('SELECT phone, label FROM links').all<{ phone: string; label: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('samename');
  });

  test('a relink keeps the name (number first, else the wallet), ignoring a new one', async () => {
    const key = generatePrivateKey();
    await signUp(ALICE, { name: 'alice' }, key);
    // Change number: the wallet moves to a new number, and the name with it.
    expect((await signUp(CAROL, { relink: true, name: 'carol' }, key)).name).toBe('alice.ender.my');
    expect(await labelOf(ALICE)).toBeUndefined();
    // Lost passkey: a fresh wallet takes the number over, and the name with it.
    expect((await signUp(CAROL, { relink: true })).name).toBe('alice.ender.my');
    expect((await env.DB.prepare('SELECT count(*) AS n FROM links').first<{ n: number }>())!.n).toBe(1);
  });

  test('a relink of an account without a name needs none', async () => {
    await link(ALICE, privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), null);
    expect((await signUp(ALICE, { relink: true })).name).toBeNull();
  });
});

// ---------------------------------------------------------------- one-time claim

test('POST /account/name: once, unique, signed in only', async () => {
  await link(ALICE, '0x000000000000000000000000000000000000a11c', null);
  await link(BOB, '0x000000000000000000000000000000000000b0b0', null);
  expect((await call('/account/name', { method: 'POST', body: JSON.stringify({ name: 'alice' }) })).status).toBe(401);
  expect((await call('/account/name', { method: 'POST', as: ALICE, body: JSON.stringify({ name: 'no' }) })).body).toEqual({ error: 'bad-name' });
  expect((await call('/account/name', { method: 'POST', as: ALICE, body: JSON.stringify({ name: 'Alice' }) })).body).toEqual({ name: 'alice.ender.my' });
  const again = await call('/account/name', { method: 'POST', as: ALICE, body: JSON.stringify({ name: 'other' }) });
  expect([again.status, again.body]).toEqual([409, { error: 'name-already-set' }]);
  const taken = await call('/account/name', { method: 'POST', as: BOB, body: JSON.stringify({ name: 'alice' }) });
  expect([taken.status, taken.body]).toEqual([409, { error: 'name-taken' }]);
  await expect(claim(env, CAROL, 'carol')).rejects.toThrow('not-registered');
  expect(await labelOf(ALICE)).toBe('alice');
  // Racing claims for one name: exactly one wins.
  await link(CAROL, '0x000000000000000000000000000000000000ca01', null);
  const race = await Promise.allSettled([claim(env, BOB, 'shared'), claim(env, CAROL, 'shared')]);
  expect(race.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
});

// ---------------------------------------------------------------- lookups and the page

describe('lookups', () => {
  const bobKeys = provingKeys(newUser());
  const bobPrivate = encodePrivateAddress(packAddress(owner(bobKeys)));
  const BOB_ADDRESS = '0x000000000000000000000000000000000000b0b0';
  beforeEach(async () => {
    await link(ALICE, '0x000000000000000000000000000000000000a11c', 'alice');
    await link(BOB, BOB_ADDRESS, 'bobby');
    await register(env, BOB, 'testnet', { Ax: bobKeys.Ax.toString(), Ay: bobKeys.Ay.toString(), nk: bobKeys.nk.toString(), viewSk: bytesToBigInt(bobKeys.viewSk).toString() });
  });

  test('GET /names/:label: public and private address, never the number', async () => {
    const r = await call('/names/BOBBY');
    expect(r.body).toEqual({ name: 'bobby.ender.my', address: BOB_ADDRESS, private: bobPrivate });
    expect(JSON.stringify(r.body)).not.toContain('98000');
    expect((await call('/names/alice')).body).toEqual({ name: 'alice.ender.my', address: '0x000000000000000000000000000000000000a11c' });
    expect(await call('/names/nobody')).toEqual({ status: 404, body: { error: 'unknown-name' } });
    expect((await call('/names/no')).body).toEqual({ error: 'bad-name' });
  });

  test('GET /names/by-phone: signed in only, limited per user', async () => {
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`)).status).toBe(401);
    const r = await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`, { as: ALICE });
    expect(r.body).toEqual({ name: 'bobby.ender.my', address: BOB_ADDRESS, private: bobPrivate });
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(CAROL)}`, { as: ALICE })).body).toEqual({ error: 'not-on-ender' });
    for (let i = 0; i < 3; i++) await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`, { as: ALICE });
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`, { as: ALICE })).status).toBe(429);
    expect(hits.get(`lookup:${ALICE}`)).toBe(LIMIT + 1);
  });

  test('the pay page: themed, both addresses with QR codes, no number; unknown names are a themed 404', async () => {
    const page = await call('https://bobby.ender.my/');
    expect(page.status).toBe(200);
    for (const s of ['<h1>bobby<span>.ender.my</span></h1>', BOB_ADDRESS, bobPrivate, '#141411', '#CDC971', 'Newsreader', 'Geist', '<svg', 'Pay with any wallet'])
      expect(page.body).toContain(s);
    expect(page.body).not.toContain('98000');
    const alice = await call('https://alice.ender.my/');
    expect(alice.body).not.toContain('Private address');
    for (const host of ['https://nobody.ender.my/', 'https://ab.ender.my/', 'https://a.bobby.ender.my/', 'https://bobby.ender.my/x']) {
      hits.clear();
      const r = await call(host);
      expect(r.status).toBe(404);
      expect(r.body).toContain('No one has this Ender ID.');
      expect(r.body).toContain('#141411');
    }
    expect((await call('https://bobby.ender.my/', { method: 'POST' })).status).toBe(405);
  });
});

// ---------------------------------------------------------------- SMS

describe('SMS to a name', () => {
  const sms = async (from: string, body: string) => (await handleInbound(env, { from, body }))?.body;
  const BOB_ADDRESS = '0x000000000000000000000000000000000000b0b0';

  test('SEND <label.ender.my> quotes to their public address; an unknown name is ERR unknown-name', async () => {
    await link(ALICE, '0x000000000000000000000000000000000000a11c', 'alice');
    await link(BOB, BOB_ADDRESS, 'bobby');
    const q = parseReply((await sms(ALICE, 'SEND Bobby.ender.my, 10 AUSD'))!);
    expect(q).toMatchObject({ kind: 'quote', to: BOB_ADDRESS, fee: '0.01' });
    expect(await sms(ALICE, '[Test] SEND nobody.ender.my, 10 AUSD')).toBe('[Test] ERR unknown-name');
  });

  test('PAY <label.ender.my> quotes to their shielded key (to=, for pinning); Sent will name the ID, never the number', async () => {
    const [a, b] = [provingKeys(newUser()), provingKeys(newUser())];
    const keys = (k: typeof a) => ({ Ax: k.Ax.toString(), Ay: k.Ay.toString(), nk: k.nk.toString(), viewSk: bytesToBigInt(k.viewSk).toString() });
    await link(ALICE, '0x000000000000000000000000000000000000a11c', 'alice');
    await link(BOB, BOB_ADDRESS, 'bobby');
    await register(env, ALICE, 'testnet', keys(a));
    await register(env, BOB, 'testnet', keys(b));
    await env.DB.prepare('INSERT INTO pool_cursors (network, block, done) VALUES (?, 0, 1)').bind('testnet').run();
    await env.DB.prepare(`INSERT INTO shielded_notes (network, pos, phone, amount, blinding, nullifier) VALUES ('testnet', 0, ?, '50000000', '1', '1')`).bind(ALICE).run();

    const q = parseReply((await sms(ALICE, '[Test] PAY bobby.ender.my, 10 AUSD'))!);
    expect(q).toMatchObject({ kind: 'shieldedQuote', test: true });
    expect(b64((q as { to: Uint8Array }).to)).toBe(b64(packAddress(owner(b))));
    const row = await env.DB.prepare('SELECT to_phone, to_address FROM shielded_quotes').first<{ to_phone: string; to_address: string }>();
    expect(row).toEqual({ to_phone: BOB, to_address: 'bobby.ender.my' });
    expect(await sms(ALICE, '[Test] PAY nobody.ender.my, 10 AUSD')).toBe('[Test] ERR NOUSER');
  });

  test('Sent names the number it was asked for by, else the Ender ID (also for an address), else the short address', async () => {
    const CAROL_ADDRESS = '0x000000000000000000000000000000000000ca01';
    await link(ALICE, '0x000000000000000000000000000000000000a11c', 'alice');
    await link(BOB, BOB_ADDRESS, 'bobby');
    await link(CAROL, CAROL_ADDRESS, null);
    // A public quote keeps what it was asked for when that was a number or an ID.
    await sms(ALICE, `SEND ${BOB}, 1 AUSD`);
    await sms(ALICE, 'SEND @bobby, 2 AUSD');
    await sms(ALICE, `SEND ${BOB_ADDRESS}, 3 AUSD`);
    const asked = await env.DB.prepare('SELECT recipient FROM sessions ORDER BY amount').all<{ recipient: string | null }>();
    expect(asked.results.map((r) => r.recipient)).toEqual([BOB, 'bobby.ender.my', null]);

    expect(await sentTo(env, BOB, BOB_ADDRESS)).toBe(BOB);
    expect(await sentTo(env, 'bobby.ender.my', BOB_ADDRESS)).toBe('bobby.ender.my');
    expect(await sentTo(env, null, BOB_ADDRESS)).toBe('bobby.ender.my');
    expect(await sentTo(env, null, CAROL_ADDRESS)).toBe('0x0000...01');
    // Private: an ender1 address names its owner's ID (looked up by number, never shown), else stays short.
    const ender1 = encodePrivateAddress(packAddress(owner(provingKeys(newUser()))));
    expect(await sentTo(env, ender1, ender1, BOB)).toBe('bobby.ender.my');
    expect(await sentTo(env, ender1, ender1, CAROL)).toBe(shortPrivateAddress(ender1));
    // A withdrawal to a linked wallet, and a merge (our own number).
    expect(await sentTo(env, BOB_ADDRESS, BOB_ADDRESS)).toBe('bobby.ender.my');
    expect(await sentTo(env, ALICE, ALICE)).toBe(ALICE);
  });
});


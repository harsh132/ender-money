/**
 * Ender IDs on the gateway, no chain: label rules, the random ID a new account
 * gets, the one change (by verified number or a $2 mainnet payment), earlier
 * labels as aliases, lookups (public by name, signed-in by number,
 * rate-limited, never a phone number), the pay page, and SEND / PAY to a name
 * by SMS. JSON-RPC is a stand-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { bytesToBigInt, encodeAbiParameters, encodeEventTopics, pad, parseAbi, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loginMessage } from '../../protocol/auth';
import { MAX_LABEL, RESERVED_LABELS, validateLabel } from '../../protocol/names';
import { CALIBUR, NETWORKS } from '../../protocol/networks';
import { encodePrivateAddress, shortPrivateAddress } from '../../protocol/recipient';
import { newUser, owner, packAddress, provingKeys } from '../../protocol/shielded';
import { b64, parseReply } from '../../protocol/sms';
import { d1, mockWorkers, relayStub } from './test-env';

mockWorkers();
const worker = (await import('./index')).default;
const { customise } = await import('./names');
const { register } = await import('./shielded');
const { handleInbound, sentTo } = await import('./sms');
const { signJwt } = await import('./jwt');
type Env = import('./env').Env;

const ALICE = '+919800000001';
const BOB = '+919800000002';
const CAROL = '+919800000003';
const A = '0x000000000000000000000000000000000000a11c';
const B = '0x000000000000000000000000000000000000b0b0';
const C = '0x000000000000000000000000000000000000ca01';
const GATEWAY_KEY = generatePrivateKey();
const TREASURY = privateKeyToAccount(GATEWAY_KEY).address.toLowerCase() as Address;

// ---------------------------------------------------------------- JSON-RPC stand-in: delegated accounts with 45.2 AUSD

/** Mined transactions by hash, per network: their AUSD Transfer logs. */
let receipts: Map<string, { network: 'mainnet' | 'testnet'; transfers: Array<{ from: string; to: string; value: bigint }>; status?: '0x0' }>;

const transferTopics = (from: string, to: string) =>
  encodeEventTopics({ abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']), eventName: 'Transfer', args: { from: from as Address, to: to as Address } });

const receipt = (network: 'mainnet' | 'testnet', hash: string) => {
  const r = receipts.get(hash);
  if (!r || r.network !== network) return null;
  const common = { blockHash: pad('0xb1', { size: 32 }), blockNumber: '0x1', transactionHash: hash, transactionIndex: '0x0' };
  return {
    ...common,
    from: TREASURY,
    to: A,
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    gasUsed: '0x1',
    logsBloom: `0x${'0'.repeat(512)}`,
    status: r.status ?? '0x1',
    type: '0x2',
    logs: r.transfers.map((t, i) => ({
      ...common,
      address: NETWORKS[network].ausd,
      topics: transferTopics(t.from, t.to),
      data: encodeAbiParameters([{ type: 'uint256' }], [t.value]),
      logIndex: toHex(i),
      removed: false,
    })),
  };
};

const rpc = (url: string, method: string, params: unknown[]): unknown => {
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
    case 'eth_getTransactionReceipt':
      return receipt(url.endsWith('/mainnet') ? 'mainnet' : 'testnet', params[0] as string);
  }
  throw { code: -32601, message: `no ${method}` };
};
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('http://rpc.test/')) throw new Error(`unexpected fetch ${url}`);
    const req = JSON.parse(String(init!.body));
    const one = (r: { id: number; method: string; params: unknown[] }) => {
      try {
        return { jsonrpc: '2.0', id: r.id, result: rpc(url, r.method, r.params) };
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
  receipts = new Map();
  env = {
    DB: d1(),
    RELAY: relayStub([]),
    DEV: '1',
    JWT_SECRET: 'unit-test-jwt',
    FEE_AUSD: '0.01',
    NAME_FEE_AUSD: '2',
    GATEWAY_PRIVATE_KEY: GATEWAY_KEY,
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
/** `as`: the signed-in account's address. */
const call = async (path: string, init: RequestInit & { as?: string; json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  if (init.as) headers.set('authorization', `Bearer ${await signJwt(env.JWT_SECRET, { sub: init.as }, 600)}`);
  const req = { ...init, headers, ...(init.json !== undefined ? { method: 'POST', body: JSON.stringify(init.json) } : {}) };
  const res = await worker.fetch!(new Request(path.startsWith('http') ? path : `https://api.ender.money${path}`, req) as never, env, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON or HTML, checked by each test
  return { status: res.status, body: (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as any };
};

/** An account as 0010 leaves one: its label in `names` too. A label set before 0010 counts as its one change. */
const link = async (phone: string | null, address: string, label: string | null, changed = false) => {
  await env.DB.prepare('INSERT INTO links (phone, address, network, created_at, label) VALUES (?, ?, ?, 0, ?)').bind(phone, address, 'mainnet', label).run();
  if (label) await env.DB.prepare('INSERT INTO names (label, address, created_at) VALUES (?, ?, 0)').bind(label, address).run();
  if (changed) await env.DB.prepare('INSERT INTO name_unlocks (proof, address, created_at) VALUES (?, ?, 0)').bind(phone, address).run();
};
const labelOf = async (address: string) => (await env.DB.prepare('SELECT label FROM links WHERE address = ?').bind(address).first<{ label: string | null }>())?.label;

/** A real wallet's first sign-in (challenge, personal_sign, verify): its account and random ID. */
const signIn = async (key = generatePrivateKey()) => {
  const wallet = privateKeyToAccount(key);
  const c = (await call('/auth/challenge', { json: { address: wallet.address } })).body;
  const signature = await wallet.signMessage({ message: loginMessage({ address: wallet.address, ...c }) });
  const r = await call('/auth/verify', { json: { address: wallet.address, signature } });
  return { ...r.body, address: wallet.address.toLowerCase() } as { token: string; address: string; name: string; created: boolean };
};

// ---------------------------------------------------------------- rules

test('label rules: 5-20 of a-z 0-9 and interior single hyphens, any case, not reserved', () => {
  for (const ok of ['harsh', 'Harsh', 'h4rsh-p', 'a1b2c', 'x'.repeat(MAX_LABEL), 'nifty-robin-245']) expect(validateLabel(ok)).toBeUndefined();
  expect(validateLabel('abcd')).toBe('too-short');
  expect(validateLabel('x'.repeat(MAX_LABEL + 1))).toBe('too-long');
  for (const bad of ['har sh', 'harsh.ender', 'hаrsh' /* Cyrillic а */, 'harsh_p', 'härsh', '@harsh']) expect(validateLabel(bad)).toBe('characters');
  for (const bad of ['-harsh', 'harsh-', 'ha--rsh', 'xn--abc']) expect(validateLabel(bad)).toBe('hyphens');
  for (const r of RESERVED_LABELS.filter((l) => l.length >= 5)) expect(validateLabel(r)).toBe('reserved');
  expect(validateLabel('Admin')).toBe('reserved');
});

test('GET /names/check: reasons, taken (any case, an earlier label too), per-IP limit', async () => {
  await link(BOB, B, 'bobby');
  await env.DB.prepare('INSERT INTO names (label, address, created_at) VALUES (?, ?, 0)').bind('brave-otter-123', B).run();
  expect((await call('/names/check?label=harsh')).body).toEqual({ available: true });
  expect((await call('/names/check?label=BOBBY')).body).toEqual({ available: false, reason: 'taken' });
  expect((await call('/names/check?label=brave-otter-123')).body).toEqual({ available: false, reason: 'taken' });
  expect((await call('/names/check?label=ab')).body).toEqual({ available: false, reason: 'too-short' });
  expect((await call('/names/check?label=support')).body).toEqual({ available: false, reason: 'reserved' });
  expect((await call('/names/check?label=harsh')).status).toBe(429); // the 6th call from this IP
});

// ---------------------------------------------------------------- random IDs

describe('random IDs', () => {
  test('a new account gets a valid random ID with its account row, and keeps it on the next sign-in', async () => {
    const key = generatePrivateKey();
    const first = await signIn(key);
    expect(first.created).toBe(true);
    const label = first.name.replace(/\.ender\.my$/, '');
    expect(label).toMatch(/^[a-z]+-[a-z]+-[1-9]\d\d$/);
    expect(validateLabel(label)).toBeUndefined();
    expect(await env.DB.prepare('SELECT address FROM names WHERE label = ?').bind(label).first<{ address: string }>()).toEqual({ address: first.address });
    expect(await signIn(key)).toMatchObject({ created: false, name: first.name });
  });

  test('an account from before random IDs gets one on its next sign-in', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    await link(ALICE, wallet.address.toLowerCase(), null);
    const r = await signIn(generatePrivateKey()); // someone else, for contrast
    expect(r.created).toBe(true);
    const c = (await call('/auth/challenge', { json: { address: wallet.address } })).body;
    const signature = await wallet.signMessage({ message: loginMessage({ address: wallet.address, ...c }) });
    const mine = (await call('/auth/verify', { json: { address: wallet.address, signature } })).body;
    expect(mine.created).toBe(false);
    expect(await labelOf(wallet.address.toLowerCase())).toBe(mine.name.replace('.ender.my', ''));
  });

  test('a taken draw is drawn again in a fresh batch: no account without an ID, no ID on two accounts', async () => {
    // Every label but one is "taken": the unique index refuses the batch, so the account row goes with it.
    const real = env.DB.batch.bind(env.DB);
    let refusals = 3;
    env.DB.batch = (async (stmts: D1PreparedStatement[]) => {
      if (refusals-- > 0) throw new Error('D1_ERROR: UNIQUE constraint failed: names.label: SQLITE_CONSTRAINT');
      return real(stmts);
    }) as typeof env.DB.batch;
    const r = await signIn();
    expect(r.created).toBe(true);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM links').first<{ n: number }>())!.n).toBe(1);
    // Never more than eight draws.
    refusals = 100;
    expect((await call('/auth/verify', { json: {} })).status).toBe(400);
    const wallet = privateKeyToAccount(generatePrivateKey());
    const c = (await call('/auth/challenge', { json: { address: wallet.address } })).body;
    const signature = await wallet.signMessage({ message: loginMessage({ address: wallet.address, ...c }) });
    expect((await call('/auth/verify', { json: { address: wallet.address, signature } })).status).toBe(500);
    expect(await labelOf(wallet.address.toLowerCase())).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the one change

describe('POST /account/name', () => {
  const change = (as: string, json: unknown) => call('/account/name', { as, json });

  test('by a verified number: once, then locked; the number never unlocks another', async () => {
    await link(ALICE, A, 'brave-otter-123');
    await link(null, B, 'quiet-heron-456');
    expect((await change(A, { name: 'alice' })).status).toBe(200);
    expect(await labelOf(A)).toBe('alice');
    expect((await call('/account/name', { as: A })).body).toEqual({ name: 'alice.ender.my', locked: true, phone: false, fee: '2', treasury: TREASURY });
    expect(await change(A, { name: 'alice2' })).toEqual({ status: 409, body: { error: 'name-already-set' } });
    // No number, no payment.
    expect((await call('/account/name', { as: B })).body).toMatchObject({ locked: false, phone: false });
    expect(await change(B, { name: 'bobby' })).toEqual({ status: 402, body: { error: 'unlock-required' } });
    // Alice's number moves to B (OTP): it already paid for a change, so it can't unlock B's.
    await env.DB.batch([
      env.DB.prepare('UPDATE links SET phone = NULL WHERE address = ?').bind(A),
      env.DB.prepare('UPDATE links SET phone = ? WHERE address = ?').bind(ALICE, B),
    ]);
    expect((await call('/account/name', { as: B })).body).toMatchObject({ phone: false });
    expect(await change(B, { name: 'bobby' })).toEqual({ status: 402, body: { error: 'unlock-required' } });
    await expect(customise(env, B, { name: 'bobby' })).rejects.toThrow('unlock-required');
  });

  test('signed in only; the name valid and free, any case; a refused name costs nothing', async () => {
    await link(ALICE, A, 'brave-otter-123');
    await link(BOB, B, 'bobby', true);
    expect((await call('/account/name', { json: { name: 'alice' } })).status).toBe(401);
    expect((await change(A, { name: 'no' })).body).toEqual({ error: 'bad-name' });
    expect(await change(A, { name: 'BOBBY' })).toEqual({ status: 409, body: { error: 'name-taken' } });
    expect(await change(A, { name: 'brave-otter-123' })).toEqual({ status: 409, body: { error: 'name-taken' } });
    expect((await change(A, { name: 'Alice' })).body).toEqual({ name: 'alice.ender.my' });
  });

  test('two accounts racing for one name: one gets it', async () => {
    await link(BOB, B, 'brave-otter-123');
    await link(CAROL, C, 'quiet-heron-456');
    const race = await Promise.allSettled([customise(env, B, { name: 'shared' }), customise(env, C, { name: 'shared' })]);
    expect(race.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('name-taken');
  });

  test('by a $2 payment on mainnet: amount, recipient, network and reuse are checked', async () => {
    await link(null, A, 'brave-otter-123');
    await link(null, B, 'quiet-heron-456');
    const hash = (n: number) => pad(toHex(n), { size: 32 }) as Hex;
    receipts.set(hash(1), { network: 'mainnet', transfers: [{ from: A, to: TREASURY, value: 1_990_000n }] });
    receipts.set(hash(2), { network: 'mainnet', transfers: [{ from: A, to: B, value: 2_000_000n }] });
    receipts.set(hash(3), { network: 'testnet', transfers: [{ from: A, to: TREASURY, value: 2_000_000n }] });
    receipts.set(hash(4), { network: 'mainnet', transfers: [{ from: B, to: TREASURY, value: 2_000_000n }] });
    receipts.set(hash(5), { network: 'mainnet', transfers: [{ from: A, to: TREASURY, value: 2_000_000n }], status: '0x0' });
    // The $2 and the $0.01 fee in one Calibur batch: the fee goes elsewhere, the $2 counts.
    receipts.set(hash(6), { network: 'mainnet', transfers: [{ from: A, to: TREASURY, value: 2_000_000n }, { from: A, to: B, value: 10_000n }] });
    expect(await change(A, { name: 'alice', txHash: hash(1) })).toEqual({ status: 402, body: { error: 'bad-payment' } }); // short
    expect(await change(A, { name: 'alice', txHash: hash(2) })).toEqual({ status: 402, body: { error: 'bad-payment' } }); // not the treasury
    expect(await change(A, { name: 'alice', txHash: hash(3) })).toEqual({ status: 404, body: { error: 'payment-not-found' } }); // testnet
    expect(await change(A, { name: 'alice', txHash: hash(4) })).toEqual({ status: 402, body: { error: 'bad-payment' } }); // someone else paid
    expect(await change(A, { name: 'alice', txHash: hash(5) })).toEqual({ status: 404, body: { error: 'payment-not-found' } }); // reverted
    expect(await change(A, { name: 'alice', txHash: 'nope' })).toEqual({ status: 400, body: { error: 'bad-payment' } });
    expect(await change(A, { name: 'alice', txHash: hash(6) })).toEqual({ status: 200, body: { name: 'alice.ender.my' } });
    expect(await change(A, { name: 'alice2', txHash: hash(6) })).toEqual({ status: 409, body: { error: 'name-already-set' } });
    // B can't spend A's payment, nor reuse one already spent.
    receipts.set(hash(7), { network: 'mainnet', transfers: [{ from: B, to: TREASURY, value: 2_000_000n }] });
    expect(await change(B, { name: 'bobby', txHash: hash(6) })).toEqual({ status: 402, body: { error: 'bad-payment' } });
    await env.DB.prepare('INSERT INTO name_unlocks (proof, address, created_at) VALUES (?, ?, 0)').bind(hash(7), C).run();
    expect(await change(B, { name: 'bobby', txHash: hash(7) })).toEqual({ status: 409, body: { error: 'payment-used' } });
    expect(await labelOf(B)).toBe('quiet-heron-456');
  });

  test('a TREASURY_ADDRESS var and fee override the defaults', async () => {
    await link(null, A, 'brave-otter-123');
    env.TREASURY_ADDRESS = B;
    env.NAME_FEE_AUSD = '5';
    expect((await call('/account/name', { as: A })).body).toMatchObject({ fee: '5', treasury: B });
    receipts.set(pad('0x1', { size: 32 }), { network: 'mainnet', transfers: [{ from: A, to: B, value: 4_000_000n }] });
    expect((await change(A, { name: 'alice', txHash: pad('0x1', { size: 32 }) })).body).toEqual({ error: 'bad-payment' });
  });

  test('the earlier label stays an alias: lookups, quotes, PAY and the pay page reach the same account', async () => {
    await link(ALICE, A, 'brave-otter-123');
    await link(BOB, B, 'bobby');
    await change(A, { name: 'alice' });
    expect((await call('/names/brave-otter-123')).body).toEqual({ name: 'alice.ender.my', address: A });
    expect((await call('/names/alice')).body).toEqual({ name: 'alice.ender.my', address: A });
    const page = await call('https://brave-otter-123.ender.my/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1>alice<span>.ender.my</span></h1>');
    const q = parseReply((await handleInbound(env, { from: BOB, body: 'SEND brave-otter-123.ender.my, 1 AUSD' }))!.body);
    expect(q).toMatchObject({ kind: 'quote', to: A });
    // Never given out again.
    expect((await call('/names/check?label=brave-otter-123')).body).toEqual({ available: false, reason: 'taken' });
  });
});

// ---------------------------------------------------------------- lookups and the page

describe('lookups', () => {
  const bobKeys = provingKeys(newUser());
  const bobPrivate = encodePrivateAddress(packAddress(owner(bobKeys)));
  beforeEach(async () => {
    await link(ALICE, A, 'alice');
    await link(BOB, B, 'bobby');
    await register(env, B, 'testnet', { Ax: bobKeys.Ax.toString(), Ay: bobKeys.Ay.toString(), nk: bobKeys.nk.toString(), viewSk: bytesToBigInt(bobKeys.viewSk).toString() });
  });

  test('GET /names/:label: public and private address, never the number', async () => {
    const r = await call('/names/BOBBY');
    expect(r.body).toEqual({ name: 'bobby.ender.my', address: B, private: bobPrivate });
    expect(JSON.stringify(r.body)).not.toContain('98000');
    expect((await call('/names/alice')).body).toEqual({ name: 'alice.ender.my', address: A });
    expect(await call('/names/nobody')).toEqual({ status: 404, body: { error: 'unknown-name' } });
    expect((await call('/names/no')).body).toEqual({ error: 'bad-name' });
  });

  test('GET /names/by-phone: signed in only, limited per user; a number no account holds is not on Ender', async () => {
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`)).status).toBe(401);
    const r = await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`, { as: A });
    expect(r.body).toEqual({ name: 'bobby.ender.my', address: B, private: bobPrivate });
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(CAROL)}`, { as: A })).body).toEqual({ error: 'not-on-ender' });
    for (let i = 0; i < 3; i++) await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`, { as: A });
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}`, { as: A })).status).toBe(429);
    expect(hits.get(`lookup:${A}`)).toBe(LIMIT + 1);
  });

  test('?network= gives the private address registered on that network (mainnet too); none: on any', async () => {
    // Bob is on testnet only so far.
    expect((await call('/names/bobby?network=mainnet')).body).toEqual({ name: 'bobby.ender.my', address: B });
    expect((await call('/names/bobby?network=testnet')).body).toEqual({ name: 'bobby.ender.my', address: B, private: bobPrivate });
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}&network=mainnet`, { as: A })).body).toEqual({ name: 'bobby.ender.my', address: B });
    const keys = { Ax: bobKeys.Ax.toString(), Ay: bobKeys.Ay.toString(), nk: bobKeys.nk.toString(), viewSk: bytesToBigInt(bobKeys.viewSk).toString() };
    await register(env, B, 'mainnet', keys);
    hits.clear(); // under the per-IP limit
    expect((await call('/names/bobby?network=mainnet')).body).toEqual({ name: 'bobby.ender.my', address: B, private: bobPrivate });
    expect((await call(`/names/by-phone?phone=${encodeURIComponent(BOB)}&network=mainnet`, { as: A })).body).toEqual({ name: 'bobby.ender.my', address: B, private: bobPrivate });
    expect((await call('/names/bobby')).body).toEqual({ name: 'bobby.ender.my', address: B, private: bobPrivate });
    expect((await call('/names/bobby?network=moon')).body).toEqual({ error: 'bad-network' });
  });

  test('the pay page: themed, both addresses with QR codes, no number; unknown names are a themed 404', async () => {
    const page = await call('https://bobby.ender.my/');
    expect(page.status).toBe(200);
    for (const s of ['<h1>bobby<span>.ender.my</span></h1>', B, bobPrivate, '#141411', '#CDC971', 'Newsreader', 'Geist', '<svg', 'Pay with any wallet'])
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

  test('SEND <label.ender.my> quotes to their public address; an unknown name is ERR unknown-name', async () => {
    await link(ALICE, A, 'alice');
    await link(BOB, B, 'bobby');
    const q = parseReply((await sms(ALICE, 'SEND Bobby.ender.my, 10 AUSD'))!);
    expect(q).toMatchObject({ kind: 'quote', to: B, fee: '0.01' });
    expect(await sms(ALICE, '[Test] SEND nobody.ender.my, 10 AUSD')).toBe('[Test] ERR unknown-name');
  });

  test('PAY <label.ender.my> quotes to their shielded key (to=, for pinning); Sent will name the ID, never the number', async () => {
    const [a, b] = [provingKeys(newUser()), provingKeys(newUser())];
    const keys = (k: typeof a) => ({ Ax: k.Ax.toString(), Ay: k.Ay.toString(), nk: k.nk.toString(), viewSk: bytesToBigInt(k.viewSk).toString() });
    await link(ALICE, A, 'alice');
    await link(BOB, B, 'bobby');
    await register(env, A, 'testnet', keys(a));
    await register(env, B, 'testnet', keys(b));
    await env.DB.prepare('INSERT INTO pool_cursors (network, block, done) VALUES (?, 0, 1)').bind('testnet').run();
    await env.DB.prepare(`INSERT INTO shielded_notes (network, pos, account, amount, blinding, nullifier) VALUES ('testnet', 0, ?, '50000000', '1', '1')`).bind(A).run();

    const q = parseReply((await sms(ALICE, '[Test] PAY bobby.ender.my, 10 AUSD'))!);
    expect(q).toMatchObject({ kind: 'shieldedQuote', test: true });
    expect(b64((q as { to: Uint8Array }).to)).toBe(b64(packAddress(owner(b))));
    // By number too: what was asked is kept for the Sent; the recipient's account stays internal.
    await sms(ALICE, `[Test] PAY ${BOB}, 1 AUSD`);
    const rows = await env.DB.prepare('SELECT to_account, to_address FROM shielded_quotes ORDER BY amount DESC').all<{ to_account: string; to_address: string }>();
    expect(rows.results).toEqual([
      { to_account: B, to_address: 'bobby.ender.my' },
      { to_account: B, to_address: BOB },
    ]);
    expect(await sms(ALICE, '[Test] PAY nobody.ender.my, 10 AUSD')).toBe('[Test] ERR NOUSER');
  });

  test('Sent names the number it was asked for by, else the Ender ID (also for an address), else the short address', async () => {
    await link(ALICE, A, 'alice');
    await link(BOB, B, 'bobby');
    await link(CAROL, C, null);
    // A public quote keeps what it was asked for when that was a number or an ID.
    await sms(ALICE, `SEND ${BOB}, 1 AUSD`);
    await sms(ALICE, 'SEND @bobby, 2 AUSD');
    await sms(ALICE, `SEND ${B}, 3 AUSD`);
    const asked = await env.DB.prepare('SELECT recipient, account FROM sessions ORDER BY amount').all<{ recipient: string | null; account: string }>();
    expect(asked.results).toEqual([
      { recipient: BOB, account: A },
      { recipient: 'bobby.ender.my', account: A },
      { recipient: null, account: A },
    ]);

    expect(await sentTo(env, BOB, B)).toBe(BOB);
    expect(await sentTo(env, 'bobby.ender.my', B)).toBe('bobby.ender.my');
    expect(await sentTo(env, null, B)).toBe('bobby.ender.my');
    expect(await sentTo(env, null, C)).toBe('0x0000...01');
    // Private: an ender1 address names its owner's ID (looked up by account, never shown), else stays short.
    const ender1 = encodePrivateAddress(packAddress(owner(provingKeys(newUser()))));
    expect(await sentTo(env, ender1, ender1, B)).toBe('bobby.ender.my');
    expect(await sentTo(env, ender1, ender1, C)).toBe(shortPrivateAddress(ender1));
    // A withdrawal to an account's wallet, and a merge (our own address).
    expect(await sentTo(env, B, B)).toBe('bobby.ender.my');
    expect(await sentTo(env, A, A)).toBe('alice.ender.my');
  });
});

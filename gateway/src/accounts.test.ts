/**
 * Accounts keyed by wallet address, no chain: sign-in by signature (challenge,
 * verify, replay, expiry, wrong signer, Turnstile, pre-0010 tokens), the
 * delegation step, and the optional phone number (add by OTP, remove, move to
 * another account) with the SMS features that follow it. JSON-RPC is a stand-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeAbiParameters, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loginMessage } from '../../protocol/auth';
import { CALIBUR, NETWORKS } from '../../protocol/networks';
import { d1, mockWorkers, relayStub, type Sent } from './test-env';

mockWorkers();
const worker = (await import('./index')).default;
const { handleInbound } = await import('./sms');
const { record, alertAll } = await import('./activity');
const { signJwt } = await import('./jwt');
type Env = import('./env').Env;

const ALICE = '+919800000001';

// ---------------------------------------------------------------- stand-ins: JSON-RPC (delegated, 45.2 AUSD) and Turnstile

let turnstile: Array<string>;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const token = (init!.body as FormData).get('response');
      turnstile.push(String(token));
      return Response.json({ success: token === 'good' });
    }
    if (!url.startsWith('http://rpc.test/')) throw new Error(`unexpected fetch ${url}`);
    const req = JSON.parse(String(init!.body));
    const one = (r: { id: number; method: string }) => ({
      jsonrpc: '2.0',
      id: r.id,
      result:
        r.method === 'eth_call'
          ? encodeAbiParameters(
              [{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }],
              [[[true, encodeAbiParameters([{ type: 'uint256' }], [45_200_000n])], [true, encodeAbiParameters([{ type: 'uint256' }], [7n])]]],
            )
          : r.method === 'eth_getCode'
            ? `0xef0100${CALIBUR.slice(2)}`
            : '0x0',
    });
    return Response.json(Array.isArray(req) ? req.map(one) : one(req));
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

let env: Env;
let sent: Sent;
beforeEach(() => {
  turnstile = [];
  sent = [];
  env = {
    DB: d1(),
    RELAY: relayStub(sent),
    DEV: '1',
    JWT_SECRET: 'unit-test-jwt',
    FEE_AUSD: '0.01',
    SHIELDED_KEY_SECRET: 'unit-test-secret',
    RPC_MAINNET: 'http://rpc.test/mainnet',
    RPC_TESTNET: 'http://rpc.test/testnet',
    IP_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = async (path: string, init: { token?: string; json?: unknown } = {}) => {
  const headers = new Headers(init.token ? { authorization: `Bearer ${init.token}` } : {});
  const req = new Request(`https://api.ender.money${path}`, init.json !== undefined ? { method: 'POST', headers, body: JSON.stringify(init.json) } : { headers });
  const res = await worker.fetch!(req as never, env, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked by each test
  return { status: res.status, body: (await res.json()) as any };
};

const wallet = () => privateKeyToAccount(generatePrivateKey());
type Wallet = ReturnType<typeof wallet>;
const challenge = async (w: Wallet) => (await call('/auth/challenge', { json: { address: w.address } })).body as { nonce: string; expires: number };
const signFor = (w: Wallet, c: { nonce: string; expires: number }) => w.signMessage({ message: loginMessage({ address: w.address, ...c }) });
const signIn = async (w: Wallet, extra: Record<string, unknown> = {}) => {
  const signature = await signFor(w, await challenge(w));
  return call('/auth/verify', { json: { address: w.address, signature, ...extra } });
};
const tokenOf = async (w: Wallet) => (await signIn(w)).body.token as string;

// ---------------------------------------------------------------- sign-in

describe('sign-in by signature', () => {
  test('challenge -> personal_sign -> a token for the address; the first one creates the account', async () => {
    const w = wallet();
    const c = await challenge(w);
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(c.expires - Date.now() / 1000).toBeGreaterThan(290);
    expect(c.expires - Date.now() / 1000).toBeLessThanOrEqual(300);
    const r = await call('/auth/verify', { json: { address: w.address, signature: await signFor(w, c) } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ address: w.address.toLowerCase(), created: true });
    const account = await call('/account?network=mainnet', { token: r.body.token });
    expect(account.body).toMatchObject({ address: w.address.toLowerCase(), name: r.body.name, phone: null, balance: '45.2', delegated: true });
    expect(await env.DB.prepare('SELECT address, phone, network FROM links').all()).toMatchObject({ results: [{ address: w.address.toLowerCase(), phone: null, network: 'mainnet' }] });
  });

  test('the message names ender.money, the address, the nonce and the expiry', () => {
    const m = loginMessage({ address: '0xABCDEF0000000000000000000000000000000001', nonce: 'n0nce', expires: 1_800_000_000 });
    expect(m).toBe(
      'ender.money wants you to sign in to Ender with your wallet.\n\nAddress: 0xabcdef0000000000000000000000000000000001\nNonce: n0nce\nExpires: 2027-01-15T08:00:00.000Z',
    );
  });

  test('a challenge answers once: a replayed signature is refused', async () => {
    const w = wallet();
    const signature = await signFor(w, await challenge(w));
    expect((await call('/auth/verify', { json: { address: w.address, signature } })).status).toBe(200);
    expect(await call('/auth/verify', { json: { address: w.address, signature } })).toEqual({ status: 401, body: { error: 'challenge-expired' } });
  });

  test('a newer challenge replaces the open one', async () => {
    const w = wallet();
    const old = await signFor(w, await challenge(w));
    await challenge(w);
    expect(await call('/auth/verify', { json: { address: w.address, signature: old } })).toEqual({ status: 401, body: { error: 'bad-signature' } });
  });

  test('an expired challenge is refused', async () => {
    const w = wallet();
    const c = await challenge(w);
    await env.DB.prepare('UPDATE auth_challenges SET expires_at = ?').bind(Math.floor(Date.now() / 1000) - 1).run();
    expect(await call('/auth/verify', { json: { address: w.address, signature: await signFor(w, { ...c, expires: c.expires - 301 }) } })).toEqual({
      status: 401,
      body: { error: 'challenge-expired' },
    });
  });

  test("another wallet's signature, or another message, is refused and spends the challenge", async () => {
    const [w, thief] = [wallet(), wallet()];
    const c = await challenge(w);
    expect(await call('/auth/verify', { json: { address: w.address, signature: await signFor(thief, c) } })).toEqual({ status: 401, body: { error: 'bad-signature' } });
    const c2 = await challenge(w);
    const other = await w.signMessage({ message: `sign in to evil.example\nNonce: ${c2.nonce}` });
    expect(await call('/auth/verify', { json: { address: w.address, signature: other } })).toEqual({ status: 401, body: { error: 'bad-signature' } });
    expect((await call('/auth/verify', { json: { address: w.address, signature: await signFor(w, c2) } })).status).toBe(401);
    expect(await call('/auth/verify', { json: { address: w.address, signature: 'nope' } })).toEqual({ status: 400, body: { error: 'bad-signature' } });
    expect(await call('/auth/challenge', { json: { address: 'nope' } })).toEqual({ status: 400, body: { error: 'bad-address' } });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM links').first<{ n: number }>())!.n).toBe(0);
  });

  test('a token from before 0010 (phone subject) is refused like an expired one', async () => {
    const legacy = await signJwt(env.JWT_SECRET, { phone: ALICE, address: '0x000000000000000000000000000000000000a11c' } as never, 600);
    expect(await call('/account', { token: legacy })).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(await call('/account', { token: await signJwt('another-secret', { sub: '0x000000000000000000000000000000000000a11c' }, 600) })).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
  });

  test('two sign-ins of one new wallet at once: one account', async () => {
    const w = wallet();
    const signature = await signFor(w, await challenge(w));
    const results = await Promise.all([call('/auth/verify', { json: { address: w.address, signature } }), signIn(w)]);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM links').first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM names').first<{ n: number }>())!.n).toBe(1);
  });

  test('TURNSTILE_SECRET set: creating an account needs a passing token; signing in to one does not', async () => {
    env.TURNSTILE_SECRET = 'secret';
    const w = wallet();
    expect(await signIn(w)).toEqual({ status: 403, body: { error: 'captcha-failed' } });
    expect(await signIn(w, { turnstile: 'bad' })).toEqual({ status: 403, body: { error: 'captcha-failed' } });
    expect((await signIn(w, { turnstile: 'good' })).body.created).toBe(true);
    expect((await signIn(w)).body.created).toBe(false);
    expect(turnstile).toEqual(['bad', 'good']);
  });

  test('POST /wallet/create delegates the signed-in account on each network (already delegated: at once)', async () => {
    const w = wallet();
    const token = await tokenOf(w);
    // As the app sends them (lib/wallet.ts createWallet): JSON, no bigint v.
    const auth = async (who: Wallet, n: 'mainnet' | 'testnet') => {
      const { address, chainId, nonce, r, s, yParity } = await who.signAuthorization({ contractAddress: CALIBUR, chainId: NETWORKS[n].chain.id, nonce: 0 });
      return { address, chainId, nonce, r, s, yParity };
    };
    const authorizations = { mainnet: await auth(w, 'mainnet'), testnet: await auth(w, 'testnet') };
    expect(await call('/wallet/create', { json: { authorizations } })).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect((await call('/wallet/create', { token, json: { authorizations } })).body).toEqual({
      address: w.address.toLowerCase(),
      delegations: [
        { network: 'mainnet', delegated: true },
        { network: 'testnet', delegated: true },
      ],
    });
    // Another wallet's authorizations are refused.
    const other = wallet();
    const theirs = { ...authorizations, mainnet: await auth(other, 'mainnet') };
    expect((await call('/wallet/create', { token, json: { authorizations: theirs } })).body).toEqual({ error: 'bad-sig' });
  });
});

// ---------------------------------------------------------------- phone number

describe('phone number', () => {
  const start = (token: string, phone = ALICE) => call('/account/phone/start', { token, json: { phone } });
  const verify = (token: string, code: string, phone = ALICE) => call('/account/phone/verify', { token, json: { phone, code } });

  test('add by OTP, show, remove', async () => {
    const token = await tokenOf(wallet());
    expect((await call('/account/phone/start', { json: { phone: ALICE } })).status).toBe(401);
    const s = await start(token);
    expect(s.body).toMatchObject({ sent: true, expiresIn: 600 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ALICE);
    expect(sent[0]!.body).toContain(s.body.devCode);
    expect(await verify(token, s.body.devCode === '000000' ? '111111' : '000000')).toEqual({ status: 401, body: { error: 'bad-code' } });
    expect((await verify(token, s.body.devCode)).body).toEqual({ phone: ALICE, moved: false });
    expect((await call('/account', { token })).body.phone).toBe(ALICE);
    // The code is spent.
    expect(await verify(token, s.body.devCode)).toEqual({ status: 401, body: { error: 'code-expired' } });
    expect((await call('/account/phone/remove', { token, json: {} })).body).toEqual({ phone: null });
    expect((await call('/account', { token })).body.phone).toBeNull();
  });

  test('a number on another account moves here; that account loses its SMS features', async () => {
    const [w1, w2] = [wallet(), wallet()];
    const [t1, t2] = [await tokenOf(w1), await tokenOf(w2)];
    await verify(t1, (await start(t1)).body.devCode);
    expect(parseReplyBody(await handleInbound(env, { from: ALICE, body: 'SYNC' }))).toMatch(/^OK /);
    // A new passkey is a new account; the number comes along by OTP.
    expect((await verify(t2, (await start(t2)).body.devCode)).body).toEqual({ phone: ALICE, moved: true });
    expect((await call('/account', { token: t1 })).body.phone).toBeNull();
    expect((await call('/account', { token: t2 })).body.phone).toBe(ALICE);
    // Texts from the number now act for the new account, and paying the number pays it.
    const q = await call('/tx/quote', { token: t1, json: { network: 'testnet', to: ALICE, amount: '1' } });
    expect(q.body.to).toBe(w2.address.toLowerCase());
  });

  test('bad numbers and countries Ender cannot text are refused; at most 3 codes an hour per number', async () => {
    const token = await tokenOf(wallet());
    expect((await start(token, '98000')).body).toEqual({ error: 'bad-phone' });
    expect(await start(token, '+14155550100')).toEqual({ status: 503, body: { error: 'sms-unavailable' } });
    for (let i = 0; i < 3; i++) expect((await start(token)).status).toBe(200);
    expect(await start(token)).toEqual({ status: 429, body: { error: 'rate-limited' } });
  });

  test('without a number: no alerts by text, SMS commands refused, and the account is not payable by number', async () => {
    const w = wallet();
    const token = await tokenOf(w);
    const me = w.address.toLowerCase() as Address;
    expect(await handleInbound(env, { from: ALICE, body: 'SYNC' })).toEqual({ to: ALICE, body: 'ERR not-registered' });
    const t = Math.floor(Date.now() / 1000);
    const STRANGER = '0x3333333333333333333333333333333333333333' as Address;
    await alertAll(env, await record(env, 'testnet', [{ txHash: `0x${'01'.repeat(32)}`, logIndex: 0, from: STRANGER, to: me, value: 1_000_000n, block: 1, at: t }]));
    expect(sent).toEqual([]);
    expect((await call('/activity?network=testnet', { token })).body.items).toHaveLength(1);
    // With one: the same transfer kind is texted.
    await verify(token, (await start(token)).body.devCode);
    sent.length = 0;
    await alertAll(env, await record(env, 'testnet', [{ txHash: `0x${'02'.repeat(32)}`, logIndex: 0, from: STRANGER, to: me, value: 1_000_000n, block: 2, at: t }]));
    expect(sent.map((s) => s.to)).toEqual([ALICE]);
  });
});

const parseReplyBody = (r: { body: string } | null) => r?.body ?? '';

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import worker, { type Env } from './worker';

/** D1 stand-in on bun:sqlite with site/migrations applied (pattern from gateway/src/test-env.ts). */
const d1 = () => {
  const db = new Database(':memory:');
  const dir = join(import.meta.dir, '..', 'migrations');
  for (const f of readdirSync(dir).sort()) db.run(readFileSync(join(dir, f), 'utf8'));
  type Param = string | number | null;
  const stmt = (sql: string, params: Param[] = []) => ({
    bind: (...p: Param[]) => stmt(sql, p),
    run: async () => ({ success: true, meta: { changes: db.query(sql).run(...params).changes } }),
  });
  return { db, binding: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database };
};

const setup = (opts: { limit?: number; turnstile?: string } = {}) => {
  const { db, binding } = d1();
  let hits = 0;
  const env: Env = {
    WAITLIST: binding,
    WAITLIST_LIMITER: { limit: async () => ({ success: ++hits <= (opts.limit ?? 100) }) },
    TURNSTILE_SECRET: opts.turnstile,
  };
  const post = async (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    const res = await worker.fetch(new Request('https://ender.money/api/waitlist', { method: 'POST', headers, body: JSON.stringify(body) }), env);
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
  };
  const rows = () => db.query('SELECT email FROM waitlist').all();
  return { post, rows, env };
};

test('valid sign-up is stored normalised, nothing echoed', async () => {
  const { post, rows } = setup();
  const r = await post({ email: '  Asha@Example.COM ' });
  expect(r).toEqual({ status: 200, body: { ok: true } });
  expect(rows()).toEqual([{ email: 'asha@example.com' }]);
});

test('a phone number sent anyway is not stored', async () => {
  const { post, rows } = setup();
  expect((await post({ email: 'a@b.co', phone: '+919876543210' })).status).toBe(200);
  expect(rows()).toEqual([{ email: 'a@b.co' }]);
});

test('duplicate email looks the same and is stored once', async () => {
  const { post, rows } = setup();
  await post({ email: 'a@b.co' });
  expect(await post({ email: 'A@B.co' })).toEqual({ status: 200, body: { ok: true } });
  expect(rows()).toEqual([{ email: 'a@b.co' }]);
});

test('bad email', async () => {
  const { post, rows } = setup();
  for (const email of ['', 'nope', 'a@b', 'a b@c.com', 'a@@b.com', 42, `${'x'.repeat(250)}@b.co`]) {
    expect(await post({ email })).toEqual({ status: 400, body: { ok: false, error: 'email' } });
  }
  expect(rows()).toEqual([]);
});

test('honeypot: looks successful, stores nothing', async () => {
  const { post, rows } = setup();
  expect(await post({ email: 'bot@spam.com', website: 'http://spam' })).toEqual({ status: 200, body: { ok: true } });
  expect(rows()).toEqual([]);
});

test('rate limit', async () => {
  const { post, rows } = setup({ limit: 2 });
  await post({ email: 'a@b.co' });
  await post({ email: 'c@d.co' });
  expect(await post({ email: 'e@f.co' })).toEqual({ status: 429, body: { ok: false, error: 'rate-limited' } });
  expect(rows()).toHaveLength(2);
});

test('json only; other paths and methods refused', async () => {
  const { post, env } = setup();
  expect((await post({ email: 'a@b.co' }, { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await worker.fetch(new Request('https://ender.money/api/waitlist'), env)).status).toBe(405);
  expect((await worker.fetch(new Request('https://ender.money/api/other', { method: 'POST' }), env)).status).toBe(404);
});

test('turnstile on: missing token refused before storing', async () => {
  const { post, rows } = setup({ turnstile: 'secret' });
  expect(await post({ email: 'a@b.co' })).toEqual({ status: 403, body: { ok: false, error: 'captcha' } });
  expect(rows()).toEqual([]);
});

test('serves the Digital Asset Links file passkeys need, as JSON', async () => {
  const { default: worker, ASSET_LINKS } = await import('./worker');
  const res = await worker.fetch(new Request('https://ender.money/.well-known/assetlinks.json') as never, {} as never);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect((await res.json()) as unknown).toEqual(ASSET_LINKS);
});

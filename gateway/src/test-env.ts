/**
 * Test-only: a Worker Env for `bun test` without wrangler. D1 is bun:sqlite
 * behind the subset of the D1 API the gateway uses, with every migration
 * applied; Workers-only modules are mocked, so import the gateway's modules
 * dynamically after calling mockWorkers().
 */
import { Database } from 'bun:sqlite';
import { mock } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Param = string | number | bigint | null;

export const d1 = (): D1Database => {
  const db = new Database(':memory:');
  const dir = join(import.meta.dir, '..', 'migrations');
  for (const f of readdirSync(dir).sort()) db.run(readFileSync(join(dir, f), 'utf8'));
  const stmt = (sql: string, params: Param[] = []) => ({
    bind: (...p: Param[]) => stmt(sql, p),
    first: async () => (db.query(sql).get(...params) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...params), success: true, meta: {} }),
    run: async () => ({ success: true, meta: { changes: db.query(sql).run(...params).changes } }),
    exec: () => ({ results: db.query(sql).all(...params), success: true, meta: {} }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Array<ReturnType<typeof stmt>>) => db.transaction(() => stmts.map((s) => s.exec()))(),
  } as unknown as D1Database;
};

/** cloudflare:workers and @cloudflare/containers stubs; `proverUrl` is a running prover/ container (docker). */
export const mockWorkers = (proverUrl = 'http://127.0.0.1:1') => {
  mock.module('cloudflare:workers', () => ({
    DurableObject: class {
      constructor(
        readonly ctx: unknown,
        readonly env: unknown,
      ) {}
    },
  }));
  mock.module('@cloudflare/containers', () => ({
    Container: class {},
    getContainer: () => ({ fetch: (url: string, init?: RequestInit) => fetch(url.replace('http://prover', proverUrl), init) }),
  }));
};

/** Texts the gateway sent through the relay (OTPs, alerts), newest last. */
export type Sent = Array<{ to: string; body: string }>;

export const relayStub = (sent: Sent) => ({
  idFromName: (n: string) => n,
  get: () => ({
    send: async (to: string, body: string) => {
      sent.push({ to, body });
      return { queued: false };
    },
  }),
});

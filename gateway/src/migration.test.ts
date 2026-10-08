/**
 * 0010_accounts.sql against a database seeded the way production is before it
 * (migrations 0001-0009, phone-keyed rows): every account carries over by
 * address with its number, name and settings, dependent rows follow their
 * account, and keys sealed under the number still open.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockWorkers } from './test-env';

mockWorkers();
const { sealKey, usersFor } = await import('./shielded');
type Env = import('./env').Env;

const dir = join(import.meta.dir, '..', 'migrations');
const files = readdirSync(dir).sort();
const SECRET = 'unit-test-secret';

const ALICE = { phone: '+919800000001', address: '0x000000000000000000000000000000000000a11c' };
const BOB = { phone: '+919800000002', address: '0x000000000000000000000000000000000000b0b0' };
// Relinked to a new wallet after registering private keys with the old one (0x...01d).
const CAROL = { phone: '+919800000003', address: '0x000000000000000000000000000000000000ca01', old: '0x000000000000000000000000000000000000001d' };

test('0010 keeps every account, keyed by address, and re-points what hangs off it', async () => {
  const db = new Database(':memory:');
  for (const f of files.filter((f) => f < '0010')) db.run(readFileSync(join(dir, f), 'utf8'));

  const run = (sql: string, ...p: Array<string | number | null>) => db.query(sql).run(...p);
  run(`INSERT INTO links (phone, address, network, alerts, created_at, label) VALUES (?, ?, 'testnet', 0, 100, 'alice')`, ALICE.phone, ALICE.address);
  run(`INSERT INTO links (phone, address, network, alerts, created_at, label) VALUES (?, ?, 'mainnet', 1, 200, NULL)`, BOB.phone, BOB.address);
  run(`INSERT INTO links (phone, address, network, alerts, created_at, label) VALUES (?, ?, 'mainnet', 1, 300, 'carol')`, CAROL.phone, CAROL.address);
  run(`INSERT INTO otps (phone, code_hash, attempts, expires_at, sends, window_start) VALUES (?, 'h', 1, 0, 2, 50)`, BOB.phone);
  run(`INSERT INTO alerts_sent (tx_hash, phone) VALUES ('0xaa', ?)`, ALICE.phone);
  run(
    `INSERT INTO sessions (id, phone, network, from_address, to_address, amount, fee, nonce, deadline, request_hash, expires_at, recipient)
     VALUES ('S1', ?, 'mainnet', ?, ?, '1', '1', '0', 0, 'h', 0, ?)`,
    ALICE.phone,
    ALICE.address,
    BOB.address,
    BOB.phone,
  );
  // Private keys, sealed with the number in the aad, as shielded.ts did before 0010.
  const seal = (phone: string, f: string, v: string) => sealKey(SECRET, v, `${phone}|testnet|${f}`);
  for (const [who, eoa, key] of [
    [ALICE, ALICE.address, '11'],
    [CAROL, CAROL.old, '33'],
  ] as const)
    run(
      `INSERT INTO shielded_users (phone, network, ax, ay, nk, view_sk, owner_key, enc_pk, eoa, created_at) VALUES (?, 'testnet', '1', '2', ?, ?, ?, '0x00', ?, 0)`,
      who.phone,
      await seal(who.phone, 'nk', key),
      await seal(who.phone, 'view', `0x${key.repeat(32)}`),
      key,
      eoa,
    );
  run(`INSERT INTO shielded_notes (network, pos, phone, amount, blinding, nullifier) VALUES ('testnet', 0, ?, '5', '1', '1')`, ALICE.phone);
  run(`INSERT INTO shielded_notes (network, pos, phone, amount, blinding, nullifier) VALUES ('testnet', 1, ?, '7', '1', '2')`, CAROL.phone);
  run(`INSERT INTO shielded_quotes (id, phone, network, kind, to_phone, amount, fee, exp, created_at) VALUES ('Q1', ?, 'testnet', 'pay', ?, '1', '1', 0, 0)`, ALICE.phone, CAROL.phone);
  run(`INSERT INTO shielded_quotes (id, phone, network, kind, to_phone, to_address, amount, fee, exp, created_at) VALUES ('Q2', ?, 'testnet', 'pay', ?, 'carol.ender.my', '1', '1', 0, 0)`, ALICE.phone, CAROL.phone);
  run(`INSERT INTO shielded_quotes (id, phone, network, kind, amount, fee, exp, created_at) VALUES ('Q3', ?, 'testnet', 'merge', '0', '1', 0, 0)`, ALICE.phone);

  db.run(readFileSync(join(dir, files.find((f) => f.startsWith('0010'))!), 'utf8'));
  const all = (sql: string) => db.query(sql).all();

  expect(all('SELECT address, phone, network, alerts, created_at, label FROM links ORDER BY created_at')).toEqual([
    { address: ALICE.address, phone: ALICE.phone, network: 'testnet', alerts: 0, created_at: 100, label: 'alice' },
    { address: BOB.address, phone: BOB.phone, network: 'mainnet', alerts: 1, created_at: 200, label: null },
    { address: CAROL.address, phone: CAROL.phone, network: 'mainnet', alerts: 1, created_at: 300, label: 'carol' },
  ]);
  // Names: every existing one, which counts as the account's one change (unlocked by its number).
  expect(all('SELECT label, address FROM names ORDER BY label')).toEqual([
    { label: 'alice', address: ALICE.address },
    { label: 'carol', address: CAROL.address },
  ]);
  expect(all('SELECT proof, address FROM name_unlocks ORDER BY proof')).toEqual([
    { proof: ALICE.phone, address: ALICE.address },
    { proof: CAROL.phone, address: CAROL.address },
  ]);
  // SMS-side tables keep the number.
  expect(all('SELECT phone, sends FROM otps')).toEqual([{ phone: BOB.phone, sends: 2 }]);
  expect(all('SELECT phone FROM alerts_sent')).toEqual([{ phone: ALICE.phone }]);
  // Account-side ones follow the account.
  expect(all('SELECT id, account, recipient FROM sessions')).toEqual([{ id: 'S1', account: ALICE.address, recipient: BOB.phone }]);
  expect(all('SELECT account, eoa, sealed_as FROM shielded_users ORDER BY owner_key')).toEqual([
    { account: ALICE.address, eoa: ALICE.address, sealed_as: ALICE.phone },
    // Registered from the old wallet: the registration (and its notes) belong to that wallet's account.
    { account: CAROL.old, eoa: CAROL.old, sealed_as: CAROL.phone },
  ]);
  expect(all('SELECT pos, account FROM shielded_notes ORDER BY pos')).toEqual([
    { pos: 0, account: ALICE.address },
    { pos: 1, account: CAROL.old },
  ]);
  expect(all('SELECT id, account, to_account, to_address FROM shielded_quotes ORDER BY id')).toEqual([
    { id: 'Q1', account: ALICE.address, to_account: CAROL.old, to_address: CAROL.phone },
    { id: 'Q2', account: ALICE.address, to_account: CAROL.old, to_address: 'carol.ender.my' },
    { id: 'Q3', account: ALICE.address, to_account: null, to_address: null },
  ]);
  // A number is one account's: the unique index holds.
  expect(() => run(`UPDATE links SET phone = ? WHERE address = ?`, ALICE.phone, BOB.address)).toThrow('UNIQUE constraint failed: links.phone');
  expect(() => run(`INSERT INTO links (address, created_at) VALUES (?, 0)`, ALICE.address)).toThrow('UNIQUE constraint failed: links.address');

  // Keys sealed under the number still open (the aad is sealed_as).
  const env = {
    SHIELDED_KEY_SECRET: SECRET,
    DB: { prepare: (sql: string) => ({ bind: (...p: string[]) => ({ all: async () => ({ results: db.query(sql).all(...p) }) }) }) },
  } as unknown as Env;
  const users = await usersFor(env, 'testnet');
  expect(users.map((u) => [u.account, u.keys.nk]).sort()).toEqual([
    [CAROL.old, 33n],
    [ALICE.address, 11n],
  ]);
});

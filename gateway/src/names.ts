/**
 * Ender IDs (protocol/names.ts) on the gateway: availability, lookups, the
 * one-time claim for accounts made before names, and recipient resolution for
 * quotes. Signup claims its name inside /wallet/create (auth.ts). The name
 * lives on `links` (0007_names.sql), so it follows the number.
 *
 * Nothing here ever answers with a phone number: a lookup by name gives the
 * public and private addresses only, and the lookup by number is for
 * signed-in users (rate-limited per user and per IP).
 */
import { hexToBytes, type Address, type Hex } from 'viem';
import { enderId, validateLabel, type LabelProblem } from '../../protocol/names';
import { encodePrivateAddress } from '../../protocol/recipient';
import { packAddress } from '../../protocol/shielded';
import { GatewayError } from './core';
import type { Env } from './env';

/**
 * Private addresses come from the shielded pool's registrations.
 * ponytail: testnet only, the only network with a pool; take a network when mainnet gets one.
 */
const POOL_NETWORK = 'testnet';

/** `private`: the ender1… address, when the account has registered its shielded keys. */
export type NameInfo = { name: string | null; address: Address; private?: string };

type Row = { label: string | null; address: Address; owner_key: string | null; enc_pk: Hex | null };

const LOOKUP = `SELECT l.label, l.address, s.owner_key, s.enc_pk FROM links l
  LEFT JOIN shielded_users s ON s.phone = l.phone AND s.network = ?`;

const info = (r: Row): NameInfo => ({
  name: r.label ? enderId(r.label) : null,
  address: r.address,
  ...(r.owner_key && r.enc_pk ? { private: encodePrivateAddress(packAddress({ ownerKey: BigInt(r.owner_key), encPk: hexToBytes(r.enc_pk) })) } : {}),
});

export const byLabel = async (env: Env, label: string): Promise<NameInfo | null> => {
  const r = await env.DB.prepare(`${LOOKUP} WHERE l.label = ?`).bind(POOL_NETWORK, label.toLowerCase()).first<Row>();
  return r && info(r);
};

export const byPhone = async (env: Env, phone: string): Promise<NameInfo | null> => {
  const r = await env.DB.prepare(`${LOOKUP} WHERE l.phone = ?`).bind(POOL_NETWORK, phone).first<Row>();
  return r && info(r);
};

/** The number behind a label, for routing a payment; never returned to a caller. */
export const phoneOf = async (env: Env, label: string) =>
  (await env.DB.prepare('SELECT phone FROM links WHERE label = ?').bind(label).first<{ phone: string }>())?.phone ?? null;

export const isTaken = async (env: Env, label: string) => !!(await env.DB.prepare('SELECT 1 FROM links WHERE label = ?').bind(label).first());

/** `GET /names/check`: what the signup screen shows while typing. */
export const check = async (env: Env, raw: string): Promise<{ available: boolean; reason?: LabelProblem | 'taken' }> => {
  const reason = validateLabel(raw);
  if (reason) return { available: false, reason };
  return (await isTaken(env, raw.toLowerCase())) ? { available: false, reason: 'taken' } : { available: true };
};

/** A label for /wallet/create or /account/name: lowercase and valid, else `bad-name`. */
export const requireLabel = (raw: unknown): string => {
  if (typeof raw !== 'string' || validateLabel(raw)) throw new GatewayError('bad-name');
  return raw.toLowerCase();
};

/** The unique index on links.label refused it: someone got there first. */
export const isLabelConflict = (e: unknown) => /UNIQUE constraint failed: links\.label/.test(String(e instanceof Error ? e.message : e));

/**
 * `POST /account/name`: an account made before names picks one, once. One
 * statement, so two racing claims can't both win, and a set name never changes.
 */
export const claim = async (env: Env, phone: string, raw: unknown) => {
  const label = requireLabel(raw);
  let changes: number;
  try {
    ({ changes } = (await env.DB.prepare('UPDATE links SET label = ? WHERE phone = ? AND label IS NULL').bind(label, phone).run()).meta);
  } catch (e) {
    if (isLabelConflict(e)) throw new GatewayError('name-taken', 409);
    throw e;
  }
  if (changes === 1) return { name: enderId(label) };
  const link = await env.DB.prepare('SELECT label FROM links WHERE phone = ?').bind(phone).first<{ label: string | null }>();
  if (!link) throw new GatewayError('not-registered', 403);
  throw new GatewayError('name-already-set', 409);
};

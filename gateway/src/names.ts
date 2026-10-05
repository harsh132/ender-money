/**
 * Ender IDs (protocol/names.ts) on the gateway: availability, lookups, the
 * one-time claim for accounts made before names, and recipient resolution for
 * quotes. Signup claims its name inside /wallet/create (auth.ts). The name
 * lives on `links` (0007_names.sql), so it follows the number.
 *
 * Nothing here ever answers with a phone number: a lookup by name gives the
 * public and private addresses only, and the lookup by number is for
 * signed-in users (rate-limited per user and per IP).
 *
 * Also who texts name (docs/SMS.md "Who appears in texts"): Ender IDs by
 * number or address, and reverse ENS for a public Received's sender.
 */
import { createPublicClient, hexToBytes, http, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { enderId, validateLabel, type LabelProblem } from '../../protocol/names';
import { encodePrivateAddress } from '../../protocol/recipient';
import { packAddress } from '../../protocol/shielded';
import { isTextName } from '../../protocol/sms';
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

// ---------------------------------------------------------------- who texts name

const idWhere = (column: 'phone' | 'address') => async (env: Env, value: string) => {
  const r = await env.DB.prepare(`SELECT label FROM links WHERE ${column} = ?`).bind(value).first<{ label: string | null }>();
  return r?.label ? enderId(r.label) : null;
};

/** The Ender ID of the account with this number, if it has one. */
export const idOfPhone = idWhere('phone');

const byAddress = idWhere('address');
/** The Ender ID of the account linked to this address, if it has one. */
export const idOfAddress = (env: Env, address: string) => byAddress(env, address.toLowerCase());

export const DEFAULT_ETH_RPC = 'https://eth.drpc.org';
/** A cached reverse-ENS answer (a name, or none) is rechecked after this long. */
export const ENS_TTL_SECONDS = 7 * 86_400;
/** An alert waits at most this long for ENS, then shows the address. */
const ENS_TIMEOUT_MS = 4_000;

/**
 * The address's primary ENS name on Ethereum, if it has one a text can carry
 * (isTextName: plain ASCII GSM-7, at most 40 characters), else null. Verified:
 * viem's getEnsName asks the Universal Resolver, which checks that the name
 * resolves forward to the same address. Cached per address in `ens_names` for
 * ENS_TTL_SECONDS. Never throws: an RPC failure answers the cached name, if
 * any, else null (and the alert shows the address).
 */
export const reverseEns = async (env: Env, address: string): Promise<string | null> => {
  const a = address.toLowerCase() as Address;
  const t = Math.floor(Date.now() / 1000);
  const cached = await env.DB.prepare('SELECT name, checked_at FROM ens_names WHERE address = ?')
    .bind(a)
    .first<{ name: string | null; checked_at: number }>()
    .catch(() => null);
  if (cached && t - cached.checked_at < ENS_TTL_SECONDS) return cached.name;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = createPublicClient({ chain: mainnet, transport: http(env.ETH_RPC_URL || DEFAULT_ETH_RPC, { timeout: ENS_TIMEOUT_MS, retryCount: 0 }) });
    // The race also bounds a CCIP-Read gateway fetch, which the transport's timeout doesn't cover.
    const found = await Promise.race([
      client.getEnsName({ address: a }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ENS_TIMEOUT_MS))),
    ]);
    const name = found && isTextName(found) ? found : null;
    await env.DB.prepare(
      'INSERT INTO ens_names (address, name, checked_at) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at',
    )
      .bind(a, name, t)
      .run();
    return name;
  } catch (e) {
    console.warn('reverse ENS failed:', (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e));
    return cached?.name ?? null;
  } finally {
    clearTimeout(timer);
  }
};

/** A public Received's from=: the sender's Ender ID, else its verified reverse-ENS name, else its address. Never a number. */
export const senderName = async (env: Env, address: string) => (await idOfAddress(env, address)) ?? (await reverseEns(env, address)) ?? address;

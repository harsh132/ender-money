/**
 * Onboarding: OTP to prove the phone number, then wallet creation with the
 * signed 7702 authorizations to prove the address.
 */
import { isAddress, isHex, type Address, type SignedAuthorization } from 'viem';
import { formatOtp, isPhone, withRetrieverHash } from '../../protocol/sms';
import type { NetworkName } from '../../protocol/networks';
import { account, delegate, GatewayError } from './core';
import type { Env } from './env';
import { signJwt } from './jwt';
import { canText, sendSms } from './outbound';

const OTP_TTL_SECONDS = 600;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS = 3;
const OTP_WINDOW_SECONDS = 3600;
export const TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

/** Keyed with the JWT secret, so a leaked table can't be brute-forced back to codes. */
const codeHash = async (env: Env, phone: string, code: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${phone}:${code}:${env.JWT_SECRET}`)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const requirePhone = (phone: unknown): string => {
  if (typeof phone !== 'string' || !isPhone(phone)) throw new GatewayError('bad-phone');
  return phone;
};

/** Networks a signup delegates on. Both in production; .dev.vars can narrow it to testnet. */
export const signupNetworks = (env: Env): NetworkName[] =>
  (env.SIGNUP_NETWORKS ?? 'mainnet,testnet').split(',').map((n) => n.trim()) as NetworkName[];

// ---------------------------------------------------------------- /auth/start

export const startAuth = async (env: Env, rawPhone: unknown) => {
  const phone = requirePhone(rawPhone);
  if (!canText(phone)) throw new GatewayError('sms-unavailable', 503);
  const t = now();
  const row = await env.DB.prepare('SELECT sends, window_start FROM otps WHERE phone = ?')
    .bind(phone)
    .first<{ sends: number; window_start: number }>();
  const sameWindow = row && t - row.window_start < OTP_WINDOW_SECONDS;
  const sends = sameWindow ? row.sends : 0;
  if (sends >= OTP_MAX_SENDS) throw new GatewayError('rate-limited', 429);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  await env.DB.prepare(
    `INSERT INTO otps (phone, code_hash, attempts, expires_at, sends, window_start) VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT (phone) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at,
       sends = excluded.sends, window_start = excluded.window_start`,
  )
    .bind(phone, await codeHash(env, phone, code), t + OTP_TTL_SECONDS, sends + 1, sameWindow ? row.window_start : t)
    .run();

  const { queued } = await sendSms(env, phone, withRetrieverHash(formatOtp(code), env.SMS_RETRIEVER_HASH));
  return { sent: true, queued, expiresIn: OTP_TTL_SECONDS, ...(env.DEV === '1' ? { devCode: code } : {}) };
};

// ---------------------------------------------------------------- /auth/verify

export const verifyAuth = async (env: Env, rawPhone: unknown, code: unknown) => {
  const phone = requirePhone(rawPhone);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new GatewayError('bad-code');
  // Count the attempt and read the hash in one statement, so parallel guesses all count.
  const row = await env.DB.prepare(
    `UPDATE otps SET attempts = attempts + 1 WHERE phone = ? AND expires_at > ? AND attempts < ? RETURNING code_hash`,
  )
    .bind(phone, now(), OTP_MAX_ATTEMPTS)
    .first<{ code_hash: string }>();
  if (!row) throw new GatewayError('code-expired', 401);
  if (row.code_hash !== (await codeHash(env, phone, code))) throw new GatewayError('bad-code', 401);
  // Spend the code but keep the row, so the hourly send budget still applies.
  await env.DB.prepare('UPDATE otps SET expires_at = 0 WHERE phone = ?').bind(phone).run();

  const link = await env.DB.prepare('SELECT address FROM links WHERE phone = ?').bind(phone).first<{ address: Address }>();
  const token = await signJwt(env.JWT_SECRET, { phone, address: link?.address ?? '' }, TOKEN_TTL_SECONDS);
  if (!link) return { token, status: 'new' as const };
  // Only now, after the code, does the number's wallet get revealed.
  const a = await account(env, phone);
  return { token, status: 'existing' as const, address: a.address, network: a.network, balance: a.balance };
};

// ---------------------------------------------------------------- /wallet/create

type AuthorizationJson = { address: Address; chainId: number; nonce: number; r: `0x${string}`; s: `0x${string}`; yParity: number };

const parseAuthorization = (a: unknown): SignedAuthorization => {
  const x = a as Partial<AuthorizationJson> | undefined;
  if (
    !x ||
    !isAddress(x.address ?? '') ||
    !Number.isInteger(x.chainId) ||
    !Number.isInteger(x.nonce) ||
    !isHex(x.r) ||
    !isHex(x.s) ||
    (x.yParity !== 0 && x.yParity !== 1)
  )
    throw new GatewayError('bad-authorization');
  return { address: x.address!, chainId: x.chainId!, nonce: x.nonce!, r: x.r, s: x.s, yParity: x.yParity };
};

export const createWallet = async (
  env: Env,
  phone: string,
  req: { address?: unknown; authorizations?: Record<string, unknown>; relink?: unknown },
) => {
  if (typeof req.address !== 'string' || !isAddress(req.address)) throw new GatewayError('bad-address');
  const address = req.address.toLowerCase() as Address;
  const relink = req.relink === true;

  const [byPhone, byAddress] = await Promise.all([
    env.DB.prepare('SELECT address FROM links WHERE phone = ?').bind(phone).first<{ address: string }>(),
    env.DB.prepare('SELECT phone FROM links WHERE address = ?').bind(address).first<{ phone: string }>(),
  ]);
  if (byPhone && byPhone.address !== address && !relink) throw new GatewayError('number-linked', 409);
  if (byAddress && byAddress.phone !== phone && !relink) throw new GatewayError('address-linked', 409);

  // Delegate on every signup network before linking: a number never points at an undelegated wallet.
  const networks = signupNetworks(env);
  const delegations = await Promise.all(
    networks.map((n) => delegate(env, n, address, parseAuthorization(req.authorizations?.[n]))),
  );

  await env.DB.batch([
    env.DB.prepare('DELETE FROM links WHERE phone = ? OR address = ?').bind(phone, address),
    env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, ?)').bind(phone, address, networks[0], now()),
  ]);
  const token = await signJwt(env.JWT_SECRET, { phone, address }, TOKEN_TTL_SECONDS);
  return { token, address, delegations };
};

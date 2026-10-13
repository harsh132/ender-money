/**
 * Accounts are wallet addresses. Sign-in is a signature over a one-time
 * challenge (POST /auth/challenge, /auth/verify), and the first one creates
 * the account with a random Ender ID (names.ts ensureLabel). /wallet/create
 * then delegates the wallet to Calibur on each network. A phone number is an
 * optional extra, proven by OTP and held by one account at a time.
 */
import { isAddress, isHex, recoverMessageAddress, type Address, type SignedAuthorization } from 'viem';
import { loginMessage } from '../../protocol/auth';
import { enderId } from '../../protocol/names';
import type { NetworkName } from '../../protocol/networks';
import { formatOtp, isPhone, withRetrieverHash } from '../../protocol/sms';
import { syncAlchemy } from './alchemy';
import { delegate, GatewayError } from './core';
import type { Env } from './env';
import { signJwt } from './jwt';
import { ensureLabel } from './names';
import { canText, sendSms } from './outbound';

const OTP_TTL_SECONDS = 600;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS = 3;
const OTP_WINDOW_SECONDS = 3600;
const CHALLENGE_TTL_SECONDS = 300;
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

const requireAddress = (address: unknown): Address => {
  if (typeof address !== 'string' || !isAddress(address)) throw new GatewayError('bad-address');
  return address.toLowerCase() as Address;
};

/** Networks a new account delegates on. Both in production; .dev.vars can narrow it to testnet. */
export const signupNetworks = (env: Env): NetworkName[] =>
  (env.SIGNUP_NETWORKS ?? 'mainnet,testnet').split(',').map((n) => n.trim()) as NetworkName[];

// ---------------------------------------------------------------- /auth/challenge, /auth/verify

/** A fresh nonce for this address, replacing any open one. The app builds the message itself (protocol/auth.ts). */
export const challenge = async (env: Env, rawAddress: unknown) => {
  const address = requireAddress(rawAddress);
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expires = now() + CHALLENGE_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO auth_challenges (address, nonce, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET nonce = excluded.nonce, expires_at = excluded.expires_at`,
  )
    .bind(address, nonce, expires)
    .run();
  return { nonce, expires };
};

/** Cloudflare Turnstile's verdict on a token from the web app (as site/src/worker.ts). */
const turnstileOk = async (secret: string, token: unknown, ip: string) => {
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form }).catch(() => null);
  return !!res?.ok && ((await res.json()) as { success?: boolean }).success === true;
};

/**
 * EIP-191 signature over loginMessage -> a session token for the address. The
 * challenge is spent in the same statement that reads it, so a signature
 * answers it once; a wrong one spends it too (the app just asks again). The
 * first sign-in creates the account, behind Turnstile when TURNSTILE_SECRET is
 * set; an older account without an Ender ID gets its random one here.
 */
export const verifyAuth = async (env: Env, req: { address?: unknown; signature?: unknown; turnstile?: unknown }, ip: string) => {
  const address = requireAddress(req.address);
  if (!isHex(req.signature)) throw new GatewayError('bad-signature');
  const c = await env.DB.prepare('DELETE FROM auth_challenges WHERE address = ? RETURNING nonce, expires_at')
    .bind(address)
    .first<{ nonce: string; expires_at: number }>();
  if (!c || c.expires_at <= now()) throw new GatewayError('challenge-expired', 401);
  const signer = await recoverMessageAddress({ message: loginMessage({ address, nonce: c.nonce, expires: c.expires_at }), signature: req.signature }).catch(() => null);
  if (signer?.toLowerCase() !== address) throw new GatewayError('bad-signature', 401);

  const exists = await env.DB.prepare('SELECT 1 FROM links WHERE address = ?').bind(address).first();
  if (!exists && env.TURNSTILE_SECRET && !(await turnstileOk(env.TURNSTILE_SECRET, req.turnstile, ip))) throw new GatewayError('captcha-failed', 403);
  const { label, created } = await ensureLabel(env, address, { network: signupNetworks(env)[0]! });
  // Onto Alchemy's webhooks before the address is handed out. Never throws; the cron retries a miss.
  if (created) await syncAlchemy(env);
  const token = await signJwt(env.JWT_SECRET, { sub: address }, TOKEN_TTL_SECONDS);
  return { token, address, name: enderId(label), created };
};

// ---------------------------------------------------------------- /wallet/create

type AuthorizationJson = { address: Address; chainId: number; nonce: number; r: `0x${string}`; s: `0x${string}`; yParity: number };

export const parseAuthorization = (a: unknown): SignedAuthorization => {
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

/**
 * The signed-in account's 7702 delegation to Calibur on every signup network,
 * sponsored. Idempotent: a network already delegated answers at once, so the
 * app sends it after every sign-in that set a wallet up or restored one.
 */
export const createWallet = async (env: Env, account: Address, req: { authorizations?: Record<string, unknown> }) => {
  const delegations = await Promise.all(signupNetworks(env).map((n) => delegate(env, n, account, parseAuthorization(req.authorizations?.[n]))));
  return { address: account, delegations };
};

// ---------------------------------------------------------------- phone number (/account/phone/*)

/** Text a 6-digit code to the number, at most OTP_MAX_SENDS an hour per number. */
export const startPhone = async (env: Env, rawPhone: unknown) => {
  const phone = requirePhone(rawPhone);
  if (!canText(env, phone)) throw new GatewayError('sms-unavailable', 503);
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

/**
 * The code checks out: the number becomes this account's. A number is one
 * account's at a time, so on another account it moves here (the code proves
 * control) and that account loses its SMS features. `moved` says it did.
 */
export const verifyPhone = async (env: Env, account: Address, rawPhone: unknown, code: unknown) => {
  const phone = requirePhone(rawPhone);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new GatewayError('bad-code');
  if (!(await env.DB.prepare('SELECT 1 FROM links WHERE address = ?').bind(account).first())) throw new GatewayError('not-registered', 403);
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

  const [moved] = await env.DB.batch([
    env.DB.prepare('UPDATE links SET phone = NULL WHERE phone = ? AND address != ?').bind(phone, account),
    env.DB.prepare('UPDATE links SET phone = ? WHERE address = ?').bind(phone, account),
  ]);
  return { phone, moved: moved!.meta.changes > 0 };
};

/** The account gives its number up: no more texts to it, and SMS commands from it are refused. */
export const removePhone = async (env: Env, account: Address) => {
  await env.DB.prepare('UPDATE links SET phone = NULL WHERE address = ?').bind(account).run();
  return { phone: null };
};

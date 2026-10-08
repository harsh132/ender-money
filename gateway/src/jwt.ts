/**
 * HS256 session tokens: the gateway both signs and verifies, so one shared
 * secret is enough. The algorithm is fixed here, never read from the header.
 * `sub` is the account: its wallet address, lowercase. Tokens from before
 * 0010 carry a phone instead and are refused (index.ts accountFrom).
 */
export type Claims = { sub: string; exp: number };

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const key = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

const HEADER = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export const signJwt = async (secret: string, claims: Omit<Claims, 'exp'>, ttlSeconds: number) => {
  const body = b64url(enc.encode(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`${HEADER}.${body}`)));
  return `${HEADER}.${body}.${b64url(sig)}`;
};

export const verifyJwt = async (secret: string, token: string): Promise<Claims | null> => {
  const [header, body, sig] = token.split('.');
  if (header !== HEADER || !body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), enc.encode(`${header}.${body}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Claims;
    return claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
};

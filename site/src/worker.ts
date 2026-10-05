/**
 * ender.money: the landing page is served from public/ by Workers static assets; only /api/* runs here.
 * POST /api/waitlist {email, website?, "cf-turnstile-response"?} → {ok} | {ok: false, error}.
 * Success looks the same for a new or an already-listed email, so the endpoint never says who signed up.
 */
export interface Env {
  WAITLIST: D1Database;
  WAITLIST_LIMITER: RateLimit;
  /** Set as a secret to require Cloudflare Turnstile; unset, no captcha. */
  TURNSTILE_SECRET?: string;
}

const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

export const normEmail = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(email) ? email : null;
};

const turnstileOk = async (secret: string, token: unknown, ip: string | null) => {
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  return res.ok && ((await res.json()) as { success?: boolean }).success === true;
};

const join = async (request: Request, env: Env) => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail('bad-request', 415);
  const ip = request.headers.get('cf-connecting-ip');
  if (!(await env.WAITLIST_LIMITER.limit({ key: ip ?? 'local' })).success) return fail('rate-limited', 429);

  const text = await request.text();
  if (text.length > 4096) return fail('bad-request', 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('bad-request');
  }
  if (!body || typeof body !== 'object') return fail('bad-request');

  // Honeypot: bots fill every field. Look successful, store nothing.
  if (body.website) return json({ ok: true });

  const email = normEmail(body.email);
  if (!email) return fail('email');

  if (env.TURNSTILE_SECRET && !(await turnstileOk(env.TURNSTILE_SECRET, body['cf-turnstile-response'], ip))) return fail('captcha', 403);

  await env.WAITLIST.prepare('INSERT OR IGNORE INTO waitlist (email) VALUES (?)').bind(email).run();
  return json({ ok: true });
};

/**
 * Digital Asset Links: lets the Android app use passkeys for ender.money. Must list the release signing key's
 * SHA-256; served from code because static assets may skip dot-folders like .well-known.
 */
export const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: {
      namespace: 'android_app',
      package_name: 'money.ender.app',
      sha256_cert_fingerprints: ['9A:6B:FE:68:54:2E:86:CE:08:FC:DE:C9:B6:C7:7E:57:35:A0:26:78:28:40:5E:D6:BA:AD:D1:42:D5:14:E6:DE'],
    },
  },
];

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/.well-known/assetlinks.json') return json(ASSET_LINKS);
    if (pathname !== '/api/waitlist') return fail('not-found', 404);
    if (request.method !== 'POST') return fail('method-not-allowed', 405);
    return join(request, env);
  },
} satisfies ExportedHandler<Env>;

/**
 * Twilio: the international transport (docs/gateway.md "Transports out"). One
 * US number (TWILIO_FROM) sends through the REST Messages API and receives on
 * POST /webhooks/twilio, which Twilio signs with the account's auth token.
 *
 * An inbound text gets an empty TwiML answer at once; the reply goes out later
 * by REST, from the Relay object, where a SIG waiting on its receipt (or the
 * prover) isn't cut off as a Worker's waitUntil is, 30 s after the response.
 */
import type { Env } from './env';
import { handleInbound } from './sms';

export const twilioReady = (env: Env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

const enc = (s: string) => new TextEncoder().encode(s);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `X-Twilio-Signature`: base64 HMAC-SHA1, under the auth token, of the full URL then every POST param's name and value, by name. */
export const twilioSignatureOk = async (authToken: string, url: string, params: URLSearchParams, signature: string) => {
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const data = url + [...params].sort(([a, x], [b, y]) => cmp(a, b) || cmp(x, y)).map(([k, v]) => k + v).join('');
  const key = await crypto.subtle.importKey('raw', enc(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['verify']);
  // `verify` compares in constant time.
  return crypto.subtle.verify('HMAC', key, sig, enc(data));
};

const twiml = () => new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });

// ---------------------------------------------------------------- POST /webhooks/twilio

/** 403 unless signed (or with Twilio unset); a MessageSid seen before is answered and dropped, as Twilio may retry. */
export const twilioWebhook = async (request: Request, env: Env, ctx: ExecutionContext) => {
  const params = new URLSearchParams(await request.text());
  const signature = request.headers.get('x-twilio-signature');
  // Twilio signs the webhook URL as configured in its console: https://api.ender.money/webhooks/twilio.
  if (!twilioReady(env) || !signature || !(await twilioSignatureOk(env.TWILIO_AUTH_TOKEN!, request.url, params, signature))) {
    return new Response('forbidden', { status: 403 });
  }
  const [sid, from, body] = [params.get('MessageSid'), params.get('From'), params.get('Body')];
  if (!sid || !from || body === null) return twiml();
  const fresh = await env.DB.prepare('INSERT OR IGNORE INTO twilio_inbound (sid, received_at) VALUES (?, ?)')
    .bind(sid, Math.floor(Date.now() / 1000))
    .run();
  if (fresh.meta.changes === 1) {
    const relay = env.RELAY.get(env.RELAY.idFromName('relay'));
    ctx.waitUntil(relay.twilio(from, body).catch((e: unknown) => console.error('twilio: inbound failed', e instanceof Error ? e.stack : e)));
  }
  return twiml();
};

/** An inbound Twilio text: the same command handling as the relay's, answered on Twilio. Runs in the Relay object. */
export const answerTwilio = async (env: Env, from: string, body: string) => {
  const out = await handleInbound(env, { from, body });
  if (out) await sendTwilio(env, out.to, out.body);
};

/** One text by the REST Messages API. A failure is logged, never thrown: a text is best effort, like the relay's. */
export const sendTwilio = async (env: Env, to: string, body: string) => {
  const masked = `${to.slice(0, 4)}•••${to.slice(-3)}`;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` },
      body: new URLSearchParams({ From: env.TWILIO_FROM!, To: to, Body: body }),
    });
    if (!res.ok) {
      const error = (await res.json().catch(() => ({}))) as { code?: number };
      console.error(`twilio: send to ${masked} failed: ${res.status} ${error.code ?? ''}`);
    }
  } catch (e) {
    console.error(`twilio: send to ${masked} failed`, e instanceof Error ? e.message : e);
  }
};

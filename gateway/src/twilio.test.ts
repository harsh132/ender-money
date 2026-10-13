/**
 * The Twilio transport: the webhook's signature check and MessageSid dedupe, inbound texts into the same command
 * handling as the relay's, the reply on the transport the text came in on, and sendSms's routing by country. Twilio's
 * REST API is a stand-in; signatures are made here with node:crypto, independently of twilio.ts.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { d1, mockWorkers, relayStub, type Sent } from './test-env';

mockWorkers();
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class {};
const worker = (await import('./index')).default;
const { answerTwilio } = await import('./twilio');
const { canText, sendSms } = await import('./outbound');
const { Relay } = await import('./relay');
type Env = import('./env').Env;

const URL_ = 'https://api.ender.money/webhooks/twilio';
const SID = 'ACtest';
const TOKEN = 'token-test';
const US = '+15550001111';

let calls: Array<{ url: string; auth: string | null; form: URLSearchParams }>;
const realFetch = globalThis.fetch;
const twilioApi = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.twilio.com/')) throw new Error(`unexpected fetch ${url}`);
  calls.push({ url, auth: new Headers(init!.headers).get('authorization'), form: new URLSearchParams(String(init!.body)) });
  return Response.json({ sid: 'SMout' }, { status: 201 });
}) as typeof fetch;
beforeAll(() => {
  globalThis.fetch = twilioApi;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

let env: Env;
let relayed: Sent;
let pending: Array<Promise<unknown>>;
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  calls = [];
  relayed = [];
  pending = [];
  const stub = relayStub(relayed);
  env = {
    DB: d1(),
    TWILIO_ACCOUNT_SID: SID,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM: '+18106768046',
    // The Relay object's twilio(): what the Worker hands an inbound text to.
    RELAY: { ...stub, get: () => ({ ...stub.get(), twilio: (from: string, body: string) => answerTwilio(env, from, body) }) },
  } as unknown as Env;
});

const sign = (params: Record<string, string>, url = URL_, token = TOKEN) =>
  createHmac('sha1', token)
    .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(''))
    .digest('base64');

const post = async (params: Record<string, string>, headers: Record<string, string> = { 'x-twilio-signature': sign(params) }, body = new URLSearchParams(params).toString()) => {
  const res = await worker.fetch!(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body }) as never, env, ctx);
  await Promise.all(pending);
  return res;
};

const inbound = (body: string, from = US, sid = 'SM1') => ({ MessageSid: sid, AccountSid: SID, From: from, To: '+18106768046', Body: body, NumSegments: '1' });

test('signed: empty TwiML at once, the reply by REST from the Twilio number', async () => {
  const res = await post(inbound('SYNC'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/xml');
  expect(await res.text()).toBe('<Response/>');
  // The relay's command handling: a number that isn't on Ender gets ERR not-registered for a well-formed command.
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
  expect(calls[0]!.auth).toBe(`Basic ${btoa(`${SID}:${TOKEN}`)}`);
  expect(Object.fromEntries(calls[0]!.form)).toEqual({ From: '+18106768046', To: US, Body: 'ERR not-registered' });
  expect(relayed).toEqual([]);
});

test('silence: a stray text from a number not on Ender gets no reply', async () => {
  expect((await post(inbound('hello there'))).status).toBe(200);
  expect(calls).toEqual([]);
});

test('an Indian number that texted the Twilio number is answered on Twilio, not the relay', async () => {
  await post(inbound('[Test] SYNC', '+919800000001'));
  expect(calls.map((c) => [c.form.get('To'), c.form.get('Body')])).toEqual([['+919800000001', '[Test] ERR not-registered']]);
  expect(relayed).toEqual([]);
});

test('a MessageSid seen before is answered and dropped', async () => {
  expect((await post(inbound('SYNC'))).status).toBe(200);
  expect((await post(inbound('SYNC'))).status).toBe(200);
  expect(calls).toHaveLength(1);
  await post(inbound('SYNC', US, 'SM2'));
  expect(calls).toHaveLength(2);
});

test('403: missing, wrong or tampered signature, another URL, or Twilio unset', async () => {
  const params = inbound('SYNC');
  expect((await post(params, {})).status).toBe(403);
  expect((await post(params, { 'x-twilio-signature': 'not base64!' })).status).toBe(403);
  expect((await post(params, { 'x-twilio-signature': sign(params, URL_, 'other-token') })).status).toBe(403);
  expect((await post(params, { 'x-twilio-signature': sign(params, 'https://evil.example/webhooks/twilio') })).status).toBe(403);
  const tampered = new URLSearchParams({ ...params, Body: 'SEND 50 +15550002222' }).toString();
  expect((await post(params, { 'x-twilio-signature': sign(params) }, tampered)).status).toBe(403);
  env.TWILIO_AUTH_TOKEN = undefined;
  expect((await post(params)).status).toBe(403);
  expect(calls).toEqual([]);
});

test('sendSms: +91 through the relay, every other number through Twilio', async () => {
  expect(await sendSms(env, '+919800000001', 'Ender code: 123456')).toEqual({ queued: false });
  expect(await sendSms(env, US, 'Ender code: 654321')).toEqual({ queued: false });
  expect(relayed).toEqual([{ to: '+919800000001', body: 'Ender code: 123456' }]);
  expect(calls.map((c) => Object.fromEntries(c.form))).toEqual([{ From: '+18106768046', To: US, Body: 'Ender code: 654321' }]);
  expect(canText(env, US)).toBe(true);
});

test('sendSms without Twilio: +91 only, as before', async () => {
  env.TWILIO_ACCOUNT_SID = undefined;
  expect(canText(env, US)).toBe(false);
  expect(canText(env, '+919800000001')).toBe(true);
  await expect(sendSms(env, US, 'x')).rejects.toThrow('sms-unavailable');
  expect(calls).toEqual([]);
});

test('a failed Twilio send is logged, not thrown', async () => {
  globalThis.fetch = (async () => Response.json({ code: 21211 }, { status: 400 })) as unknown as typeof fetch;
  try {
    expect(await sendSms(env, US, 'x')).toEqual({ queued: false });
  } finally {
    globalThis.fetch = twilioApi;
  }
});

test('a text on the relay is answered on the relay socket, even from a US number', async () => {
  const socket: string[] = [];
  const relay = new Relay({ setWebSocketAutoResponse: () => {} } as never, env);
  await relay.webSocketMessage({ send: (m: string) => socket.push(m) } as never, JSON.stringify({ type: 'inbound', id: 'r1', from: US, body: 'SYNC' }));
  expect(socket.map((m) => JSON.parse(m))).toMatchObject([{ type: 'send', to: US, body: 'ERR not-registered' }, { type: 'ack', id: 'r1' }]);
  expect(calls).toEqual([]);
});

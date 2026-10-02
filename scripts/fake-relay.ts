/**
 * Stands in for the Android relay phone: connects to /relay, forwards one
 * inbound text and prints what the gateway asks it to send.
 *
 *   bun run fake-relay "<from>" "<text>" [--gateway ws://127.0.0.1:8787]
 *
 * Reads RELAY_TOKEN from gateway/.dev.vars.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const gi = args.indexOf('--gateway');
const base = gi >= 0 ? args.splice(gi, 2)[1]! : 'ws://127.0.0.1:8787';
const [from = '+919800000001', body = 'SYNC T'] = args;
const token = /^RELAY_TOKEN=(.+)$/m.exec(readFileSync('gateway/.dev.vars', 'utf8'))?.[1]?.trim();
if (!token) throw new Error('RELAY_TOKEN missing from gateway/.dev.vars');

const id = crypto.randomUUID();
const ws = new WebSocket(`${base}/relay`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
const done = setTimeout(() => {
  console.error('no ack within 20s');
  process.exit(1);
}, 20_000);

ws.onopen = () => {
  console.log(`> inbound from ${from}: ${body}`);
  ws.send(JSON.stringify({ type: 'inbound', id, from, body, receivedAt: Date.now() }));
};
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data)) as { type: string; id: string; to?: string; body?: string };
  if (msg.type === 'send') {
    console.log(`< send to ${msg.to}: ${msg.body}`);
    ws.send(JSON.stringify({ type: 'sent', id: msg.id, ok: true }));
  } else if (msg.type === 'ack' && msg.id === id) {
    console.log('< ack');
    clearTimeout(done);
    ws.close();
  }
};
ws.onerror = (e) => {
  console.error('socket error', e);
  process.exit(1);
};

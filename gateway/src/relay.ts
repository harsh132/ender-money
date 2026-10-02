import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { handleInbound } from './sms';

/**
 * Messages on the relay phone's WebSocket (JSON):
 *   relay → gateway  { type: 'inbound', id, from, body, receivedAt }
 *                    { type: 'sent', id, ok, error? }   { type: 'delivered', id }
 *   gateway → relay  { type: 'ack', id }                { type: 'send', id, to, body }
 * plus 'ping' → 'pong', answered by the runtime without waking the object.
 */
type FromRelay =
  | { type: 'inbound'; id: string; from: string; body: string; receivedAt?: number }
  | { type: 'sent'; id: string; ok: boolean; error?: string }
  | { type: 'delivered'; id: string };
type Queued = { type: 'send'; id: string; to: string; body: string; expiresAt: number };

const OUTBOX_TTL_MS = 10 * 60_000;

/**
 * The Android relay phone's connection: one object, one socket, hibernating
 * between messages. Inbound texts are answered on the same socket and acked
 * only after the reply is queued, so a text the phone forwards twice (say,
 * after a reconnect) is handled twice; the session core is idempotent for
 * exactly that reason. Outbound texts from elsewhere (OTPs, alerts) wait in
 * storage for up to 10 minutes if the phone is offline.
 */
export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** The Worker forwards the already-authenticated upgrade request here. */
  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    for (const old of this.ctx.getWebSockets()) old.close(1000, 'replaced by a newer connection');
    this.ctx.acceptWebSocket(server);
    await this.flush(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: FromRelay;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as FromRelay;
    } catch {
      return;
    }
    if (msg.type === 'inbound') {
      const out = await handleInbound(this.env, { from: msg.from, body: msg.body });
      if (out) ws.send(JSON.stringify({ type: 'send', id: crypto.randomUUID(), to: out.to, body: out.body }));
      ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
    } else if (msg.type === 'sent' && !msg.ok) {
      console.warn(`relay: send ${msg.id} failed: ${msg.error ?? 'unknown'}`);
    }
  }

  /** Send a text through the phone; queued if it's offline. Called by OTP and alerts. */
  async send(to: string, body: string): Promise<{ queued: boolean }> {
    const msg: Queued = { type: 'send', id: crypto.randomUUID(), to, body, expiresAt: Date.now() + OUTBOX_TTL_MS };
    const ws = this.ctx.getWebSockets()[0];
    if (ws) {
      ws.send(JSON.stringify(msg));
      return { queued: false };
    }
    await this.ctx.storage.put(`out:${msg.id}`, msg);
    return { queued: true };
  }

  connected() {
    return this.ctx.getWebSockets().length > 0;
  }

  private async flush(ws: WebSocket) {
    const outbox = await this.ctx.storage.list<Queued>({ prefix: 'out:' });
    for (const [key, msg] of outbox) {
      if (msg.expiresAt > Date.now()) ws.send(JSON.stringify(msg));
      else console.warn(`relay: dropped expired text ${msg.id}`);
      await this.ctx.storage.delete(key);
    }
  }
}

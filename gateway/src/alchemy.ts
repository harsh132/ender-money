/**
 * Alchemy Address Activity webhooks, the only source of incoming transfers:
 * AUSD transfers touching a linked address reach `transfers` and the alert
 * path within seconds. Ported from ender-backend's apps/worker/src/alchemy.ts.
 * A webhook reports only addresses it held when the block was made, so an
 * address must be pushed before it is paid; there is no backfill.
 *
 * Outbound: the gateway creates its own webhooks through Alchemy's Notify API,
 * one per network until it holds 100,000 addresses, and pushes every linked
 * address to each network's webhook: on /wallet/create, and from the cron for
 * whatever that missed. The first webhook is created with every address
 * already linked. Its signing key comes back in the create response and is
 * stored sealed under SHIELDED_KEY_SECRET, so nobody handles it by hand.
 *
 * Inbound: POST /webhooks/alchemy, signed with that key.
 *
 * Unset ALCHEMY_AUTH_TOKEN (or ALCHEMY_WEBHOOK_URL, or SHIELDED_KEY_SECRET),
 * none of this runs and no incoming transfers are recorded.
 */
import type { Address, Hex } from 'viem';
import { NETWORKS, type NetworkName } from '../../protocol/networks';
import { alertAll, record, type Transfer } from './activity';
import type { Env } from './env';
import { openKey, sealKey } from './shielded';

const API = 'https://dashboard.alchemy.com/api';

/** Alchemy's network enum, as `alchemy app chains` lists it. */
const ALCHEMY_NETWORK: Record<NetworkName, string> = { mainnet: 'MONAD_MAINNET', testnet: 'MONAD_TESTNET' };

/** Alchemy's limit on one Address Activity webhook. */
export const WEBHOOK_CAPACITY = 100_000;

/** Addresses per Notify request. Alchemy states no limit; this keeps each one small. */
const BATCH = 1_000;

/** Notify requests per network per sync: a big backlog drains a minute at a time through the cron. */
const MAX_BATCHES = 20;

const now = () => Math.floor(Date.now() / 1000);
const aad = (webhookId: string) => `alchemy|${webhookId}`;

const notify = async <T>(env: Env, method: string, path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${API}/${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Alchemy-Token': env.ALCHEMY_AUTH_TOKEN! },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
};

/** Push one batch: onto the network's webhook with room, or a new one if none has any. */
const register = async (env: Env, network: NetworkName, addresses: string[]) => {
  const hook = await env.DB.prepare('SELECT id, addresses FROM alchemy_webhooks WHERE network = ? AND addresses < ? ORDER BY addresses DESC LIMIT 1')
    .bind(network, WEBHOOK_CAPACITY)
    .first<{ id: string; addresses: number }>();

  let batch = addresses;
  let write: D1PreparedStatement;
  if (hook) {
    batch = addresses.slice(0, WEBHOOK_CAPACITY - hook.addresses);
    await notify(env, 'PATCH', 'update-webhook-addresses', { webhook_id: hook.id, addresses_to_add: batch, addresses_to_remove: [] });
    write = env.DB.prepare('UPDATE alchemy_webhooks SET addresses = addresses + ? WHERE id = ?').bind(batch.length, hook.id);
  } else {
    // Created with its first addresses: one request, and never a webhook watching nothing.
    const { data } = await notify<{ data: { id: string; signing_key: string } }>(env, 'POST', 'create-webhook', {
      network: ALCHEMY_NETWORK[network],
      webhook_type: 'ADDRESS_ACTIVITY',
      webhook_url: env.ALCHEMY_WEBHOOK_URL,
      addresses: batch,
    });
    write = env.DB.prepare('INSERT INTO alchemy_webhooks (id, network, signing_key, addresses, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      data.id,
      network,
      await sealKey(env.SHIELDED_KEY_SECRET, data.signing_key, aad(data.id)),
      batch.length,
      now(),
    );
    console.log(`alchemy: created webhook ${data.id} for ${network}`);
  }
  await env.DB.batch([write, ...batch.map((a) => env.DB.prepare('INSERT OR IGNORE INTO alchemy_addresses (network, address) VALUES (?, ?)').bind(network, a))]);
};

/**
 * Push every linked address not yet on a webhook, on both networks.
 *
 * Never throws: a network Alchemy can't take right now is logged and left for
 * the next cron run.
 *
 * ponytail: two syncs at once can push the same addresses twice. Alchemy's
 * update is idempotent, but the count overshoots and a webhook is retired a
 * little before it is full. Serialize through a Durable Object if that matters.
 */
export const syncAlchemy = async (env: Env) => {
  if (!env.ALCHEMY_AUTH_TOKEN || !env.ALCHEMY_WEBHOOK_URL || !env.SHIELDED_KEY_SECRET) return;
  for (const network of Object.keys(NETWORKS) as NetworkName[]) {
    try {
      for (let i = 0; i < MAX_BATCHES; i++) {
        const { results } = await env.DB.prepare(
          'SELECT address FROM links WHERE address NOT IN (SELECT address FROM alchemy_addresses WHERE network = ?) ORDER BY created_at LIMIT ?',
        )
          .bind(network, BATCH)
          .all<{ address: string }>();
        if (!results.length) break;
        await register(env, network, results.map((r) => r.address));
      }
    } catch (e) {
      console.error(`alchemy: ${network} not synced, the cron retries: ${e instanceof Error ? e.message : e}`);
    }
  }
};

// ---------------------------------------------------------------- POST /webhooks/alchemy

const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
const isHexNumber = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s);

/** `X-Alchemy-Signature`: hex HMAC-SHA256 of the raw body under the webhook's signing key. */
const signedBy = async (body: string, signature: string | null, key: string) => {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  // `verify` compares in constant time.
  return crypto.subtle.verify('HMAC', hmac, fromHex(signature), new TextEncoder().encode(body));
};

type Activity = {
  hash?: string;
  fromAddress?: string;
  toAddress?: string;
  blockNum?: string;
  category?: string;
  rawContract?: { address?: string; rawValue?: string };
  log?: { logIndex?: string; blockNumber?: string; removed?: boolean };
};

type Delivery = { webhookId?: string; createdAt?: string; type?: string; event?: { activity?: Activity[] } };

/**
 * One delivery. Nothing is read past the webhook row until the signature
 * checks out under that webhook's key. AUSD transfers only, as the scan
 * records them; a log a reorg took back (`removed`) is skipped. A failed
 * write answers 500 so Alchemy delivers again; a repeat writes nothing.
 */
export const alchemyWebhook = async (request: Request, env: Env, ctx: ExecutionContext) => {
  const body = await request.text();
  let delivery: Delivery;
  try {
    delivery = JSON.parse(body) as Delivery;
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const id = String(delivery?.webhookId ?? '');
  const hook = await env.DB.prepare('SELECT network, signing_key FROM alchemy_webhooks WHERE id = ?')
    .bind(id)
    .first<{ network: NetworkName; signing_key: string }>();
  const key = hook && (await openKey(env.SHIELDED_KEY_SECRET, hook.signing_key, aad(id)).catch(() => null));
  if (!hook || !key || !(await signedBy(body, request.headers.get('x-alchemy-signature'), key))) {
    console.warn('alchemy: rejected an unsigned delivery');
    return new Response('unauthorized', { status: 401 });
  }
  if (delivery.type !== 'ADDRESS_ACTIVITY') return Response.json({ recorded: 0 });

  // When Alchemy saw it; the payload carries no block time.
  const at = Math.floor(Date.parse(delivery.createdAt ?? '') / 1000) || now();
  const ausd = NETWORKS[hook.network].ausd.toLowerCase();
  const transfers: Transfer[] = (delivery.event?.activity ?? []).flatMap((a) => {
    const { log, rawContract } = a;
    if (a.category !== 'token' || rawContract?.address?.toLowerCase() !== ausd || !log || log.removed) return [];
    if (!isHexNumber(a.hash) || !isHexNumber(rawContract.rawValue) || !isHexNumber(log.logIndex) || !isHexNumber(log.blockNumber ?? a.blockNum)) return [];
    if (typeof a.fromAddress !== 'string' || typeof a.toAddress !== 'string') return [];
    return [
      {
        txHash: a.hash.toLowerCase() as Hex,
        logIndex: Number(log.logIndex),
        from: a.fromAddress.toLowerCase() as Address,
        to: a.toAddress.toLowerCase() as Address,
        value: BigInt(rawContract.rawValue),
        block: Number(log.blockNumber ?? a.blockNum),
        at,
      },
    ];
  });

  const recorded = await record(env, hook.network, transfers);
  ctx.waitUntil(alertAll(env, recorded));
  return Response.json({ recorded: recorded.ours.length });
};

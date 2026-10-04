import { isAddress, isHex, type Hex, type SignedAuthorization } from 'viem';
import { isPhone } from '../../protocol/sms';
import { isNetwork } from './chain';
import { activity, setAlerts } from './activity';
import { alchemyWebhook, syncAlchemy } from './alchemy';
import { createWallet, startAuth, verifyAuth, TOKEN_TTL_SECONDS } from './auth';
import { account, delegate, GatewayError, quote, reconcile, sign, txStatus } from './core';
import type { Env } from './env';
import { signJwt, verifyJwt } from './jwt';
import * as shielded from './shielded';
import { handleInbound } from './sms';

export { ProverContainer } from './prover';
export { Relay } from './relay';
export { Sponsor } from './sponsor';

/**
 * Any origin may call the API: auth is a bearer token, never a cookie, so a
 * page elsewhere gains nothing a script couldn't. Lets the app's web preview work.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

const body = async <T>(request: Request): Promise<T> => {
  try {
    return (await request.json()) as T;
  } catch {
    throw new GatewayError('bad-json');
  }
};

const phoneFrom = async (env: Env, request: Request) => {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  const claims = token ? await verifyJwt(env.JWT_SECRET, token) : null;
  if (!claims) throw new GatewayError('unauthorized', 401);
  return claims.phone;
};

/** Constant-time comparison, so the relay token can't be guessed byte by byte. */
const sameSecret = (a: string, b: string) => {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
};

/**
 * Android hands passkeys for ender.money only to apps whose signing key is
 * listed here. SHA-256 of the app's key (app/credentials/, never committed).
 */
const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: {
      namespace: 'android_app',
      package_name: 'money.ender.app',
      sha256_cert_fingerprints: ['9A:6B:FE:68:54:2E:86:CE:08:FC:DE:C9:B6:C7:7E:57:35:A0:26:78:28:40:5E:D6:BA:AD:D1:42:D5:14:E6:DE'],
    },
  },
];

const route = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === '/.well-known/assetlinks.json') return json(ASSET_LINKS);

  // Per-IP limit on everything a stranger can hammer: OTP sends and transfers.
  if (/^\/(auth|tx|wallet|shielded)\//.test(url.pathname)) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    if (!(await env.IP_LIMITER.limit({ key: ip })).success) throw new GatewayError('rate-limited', 429);
  }

  const txId = /^\/tx\/([23456789A-Za-z]{4})$/.exec(url.pathname)?.[1];
  if (request.method === 'GET' && txId) return json(await txStatus(env, await phoneFrom(env, request), txId.toUpperCase()));

  switch (key) {
    case 'GET /health':
      return json({ ok: true });

    case 'POST /auth/start': {
      const req = await body<{ phone?: string }>(request);
      return json(await startAuth(env, req.phone));
    }

    case 'POST /auth/verify': {
      const req = await body<{ phone?: string; code?: string }>(request);
      return json(await verifyAuth(env, req.phone, req.code));
    }

    case 'POST /wallet/create': {
      const phone = await phoneFrom(env, request);
      return json(await createWallet(env, phone, await body(request)));
    }

    case 'GET /account': {
      const network = url.searchParams.get('network') ?? undefined;
      if (network !== undefined && !isNetwork(network)) throw new GatewayError('bad-network');
      return json(await account(env, await phoneFrom(env, request), network));
    }

    case 'GET /activity': {
      const phone = await phoneFrom(env, request);
      const network = url.searchParams.get('network') ?? undefined;
      if (network !== undefined && !isNetwork(network)) throw new GatewayError('bad-network');
      return json(await activity(env, phone, network));
    }

    case 'POST /account/alerts': {
      const phone = await phoneFrom(env, request);
      return json(await setAlerts(env, phone, (await body<{ on?: unknown }>(request)).on));
    }

    case 'POST /tx/quote': {
      const phone = await phoneFrom(env, request);
      const req = await body<{ network?: string; to?: string; amount?: string; deliver?: string }>(request);
      if (req.network !== undefined && !isNetwork(req.network)) throw new GatewayError('bad-network');
      if (typeof req.to !== 'string' || typeof req.amount !== 'string') throw new GatewayError('bad-request');
      if (req.deliver !== undefined && req.deliver !== 'AUSD' && req.deliver !== 'CTK') throw new GatewayError('bad-request');
      return json(await quote(env, phone, { network: req.network, to: req.to, amount: req.amount, deliver: req.deliver }));
    }

    case 'POST /tx/sign': {
      const phone = await phoneFrom(env, request);
      const req = await body<{ id?: string; signature?: string }>(request);
      if (typeof req.id !== 'string' || !isHex(req.signature) || req.signature.length !== 132) throw new GatewayError('bad-request');
      return json(await sign(env, phone, req.id.toUpperCase(), req.signature as Hex));
    }

    // Shielded pool (testnet). `network` defaults to testnet, the only network with a pool.
    case 'POST /shielded/register': {
      const phone = await phoneFrom(env, request);
      const req = await body<{ network?: string; keys?: Record<string, unknown> }>(request);
      return json(await shielded.register(env, phone, shieldedNetwork(req.network), req.keys));
    }

    case 'GET /shielded/notes': {
      const phone = await phoneFrom(env, request);
      return json(await shielded.notes(env, phone, shieldedNetwork(url.searchParams.get('network') ?? undefined)));
    }

    case 'POST /shielded/quote': {
      const phone = await phoneFrom(env, request);
      const req = await body<{ network?: string; kind?: string; to?: string; amount?: string }>(request);
      if (!['pay', 'withdraw', 'shield', 'merge'].includes(req.kind ?? '')) throw new GatewayError('bad-request');
      return json(
        await shielded.quote(
          env,
          phone,
          { network: shieldedNetwork(req.network), kind: req.kind as shielded.ShieldedKind, to: req.to, amount: req.amount },
          (p) => ctx.waitUntil(p),
        ),
      );
    }

    case 'POST /shielded/submit': {
      const phone = await phoneFrom(env, request);
      const req = await body<{ id?: unknown; refs?: unknown; sig?: unknown; signature?: unknown }>(request);
      if (typeof req.id !== 'string') throw new GatewayError('bad-request');
      const sig = req.sig === undefined ? undefined : shielded.sigFromBase64(req.sig);
      if (sig === null) throw new GatewayError('bad-request');
      if (req.refs !== undefined && (!Array.isArray(req.refs) || req.refs.length > 12)) throw new GatewayError('bad-request');
      if (req.signature !== undefined && (!isHex(req.signature) || req.signature.length !== 132)) throw new GatewayError('bad-request');
      // Finish even if the app gives up waiting (it then texts the SIG, which waits for this same outcome).
      const settled = shielded.submit(env, phone, { id: req.id.toUpperCase(), refs: req.refs as number[] | undefined, sig, signature: req.signature as Hex | undefined });
      ctx.waitUntil(settled.catch(() => {}));
      const r = await settled;
      return json({ tx: r.tx, ...(r.p !== undefined ? { p: r.p } : {}), ...(r.pending ? { pending: true } : {}) });
    }

    case 'GET /shielded/address': {
      await phoneFrom(env, request);
      const phone = url.searchParams.get('phone') ?? '';
      if (!isPhone(phone)) throw new GatewayError('bad-phone');
      return json(await shielded.shieldedAddress(env, shieldedNetwork(url.searchParams.get('network') ?? undefined), phone));
    }

    // Address activity from Alchemy; proves itself by signature.
    case 'POST /webhooks/alchemy':
      return alchemyWebhook(request, env, ctx);

    // The Android relay phone's WebSocket.
    case 'GET /relay': {
      if (request.headers.get('upgrade') !== 'websocket') throw new GatewayError('upgrade-required', 426);
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!env.RELAY_TOKEN || !sameSecret(token, env.RELAY_TOKEN)) throw new GatewayError('unauthorized', 401);
      return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(request);
    }

    // Dev only: inject an inbound text as if the relay delivered it; returns the reply instead of sending it.
    case 'POST /dev/sms': {
      if (env.DEV !== '1') break;
      const req = await body<{ from?: string; body?: string }>(request);
      if (typeof req.from !== 'string' || typeof req.body !== 'string') throw new GatewayError('bad-request');
      return json({ reply: await handleInbound(env, { from: req.from, body: req.body }) });
    }

    // Dev only: link a phone to an address without OTP and hand back a token. Replaced by /auth/* on 5 Oct.
    case 'POST /dev/link': {
      if (env.DEV !== '1') break;
      const req = await body<{ phone?: string; address?: string; network?: string }>(request);
      if (!req.phone || !isPhone(req.phone) || !req.address || !isAddress(req.address)) throw new GatewayError('bad-request');
      const network = isNetwork(req.network) ? req.network : 'mainnet';
      await env.DB.prepare(
        `INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (phone) DO UPDATE SET address = excluded.address, network = excluded.network`,
      )
        .bind(req.phone, req.address.toLowerCase(), network, Math.floor(Date.now() / 1000))
        .run();
      return json({ token: await signJwt(env.JWT_SECRET, { phone: req.phone, address: req.address.toLowerCase() }, TOKEN_TTL_SECONDS) });
    }

    // Dev only: queue a delegation without signup. /wallet/create (5 Oct) wraps the same core call.
    case 'POST /dev/delegate': {
      if (env.DEV !== '1') break;
      const req = await body<{ network?: string; address?: string; authorization?: SignedAuthorization }>(request);
      if (!isNetwork(req.network) || !req.address || !isAddress(req.address) || !req.authorization) throw new GatewayError('bad-request');
      return json(await delegate(env, req.network, req.address, req.authorization));
    }
  }
  return json({ error: 'not-found' }, 404);
};

const shieldedNetwork = (network: string | undefined) => {
  if (network === undefined) return 'testnet' as const;
  if (!isNetwork(network)) throw new GatewayError('bad-network');
  return network;
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Emergency stop: PAUSED = "1" (dashboard → Settings → Variables) turns every request away; DOs and the prover
    // only get work through here.
    if (env.PAUSED === '1') return json({ error: 'paused' }, 503);
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof GatewayError) return json({ error: error.code }, error.status);
      console.error('unhandled', error instanceof Error ? error.stack : error);
      return json({ error: 'internal' }, 500);
    }
  },
  async scheduled(_controller, env, ctx) {
    if (env.PAUSED === '1') return;
    const log = (what: string) => (e: unknown) => console.error(`cron: ${what} failed`, e instanceof Error ? e.message : e);
    ctx.waitUntil(
      Promise.all([
        reconcile(env).catch(log('reconcile')),
        // Pushes what /wallet/create couldn't, and makes each network's first webhook.
        syncAlchemy(env),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;

import { isAddress, isHex, type Address, type Hex, type SignedAuthorization } from 'viem';
import { validateLabel } from '../../protocol/names';
import { isPhone } from '../../protocol/sms';
import { isNetwork } from './chain';
import { activity, setAlerts } from './activity';
import { alchemyWebhook, syncAlchemy } from './alchemy';
import * as bridge from './bridge';
import { challenge, createWallet, removePhone, startPhone, verifyAuth, verifyPhone, TOKEN_TTL_SECONDS } from './auth';
import { handleCcip } from './ccip';
import { account, delegate, GatewayError, quote, reconcile, sign, txStatus } from './core';
import type { Env } from './env';
import { signJwt, verifyJwt } from './jwt';
import * as names from './names';
import { payPage } from './page';
import * as shielded from './shielded';
import { handleInbound } from './sms';
import { twilioWebhook } from './twilio';

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

/** The signed-in account: its address, lowercase. A token from before 0010 (a phone, no `sub`) is refused like an expired one. */
const accountFrom = async (env: Env, request: Request): Promise<Address> => {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  const claims = token ? await verifyJwt(env.JWT_SECRET, token) : null;
  if (!claims || typeof claims.sub !== 'string' || !isAddress(claims.sub)) throw new GatewayError('unauthorized', 401);
  return claims.sub.toLowerCase() as Address;
};

/** Constant-time comparison, so the relay token can't be guessed byte by byte. */
const sameSecret = (a: string, b: string) => {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
};

/** One binding, separate budgets: the key says whose and for what. */
const limit = async (env: Env, key: string) => {
  if (!(await env.IP_LIMITER.limit({ key })).success) throw new GatewayError('rate-limited', 429);
};

const route = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';

  // https://<label>.ender.my: that Ender ID's pay page (route `*.ender.my/*`). www has an origin of its own.
  const host = /^(.+)\.ender\.my$/.exec(url.hostname) ?? (env.DEV === '1' ? /^(.+)\.localhost$/.exec(url.hostname) : null);
  if (host) {
    if (host[1] === 'www') return fetch(request);
    await limit(env, `page:${ip}`);
    return payPage(env, request, host[1]!);
  }

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // ENS (EnderResolver's CCIP-Read gateway URL): /ccip/{sender}/{data}.json and POST /ccip.
  if (url.pathname === '/ccip' || url.pathname.startsWith('/ccip/')) {
    await limit(env, `ccip:${ip}`);
    return handleCcip(request, url, env);
  }

  // Per-IP limit on everything a stranger can hammer: sign-in, OTP sends and transfers.
  if (/^\/(auth|tx|wallet|shielded|bridge|account\/phone)\//.test(url.pathname)) await limit(env, ip);

  // Ender IDs. Public, per IP: availability (the signup screen, while typing) and name -> addresses.
  const label = /^\/names\/([^/]+)$/.exec(url.pathname)?.[1];
  if (request.method === 'GET' && label && label !== 'check' && label !== 'by-phone') {
    await limit(env, `names:${ip}`);
    if (validateLabel(label)) throw new GatewayError('bad-name');
    const found = await names.byLabel(env, label, lookupNetwork(url));
    if (!found) throw new GatewayError('unknown-name', 404);
    return json(found);
  }

  const txId = /^\/tx\/([23456789A-Za-z]{4})$/.exec(url.pathname)?.[1];
  if (request.method === 'GET' && txId) return json(await txStatus(env, await accountFrom(env, request), txId.toUpperCase()));

  switch (key) {
    case 'GET /health':
      return json({ ok: true });

    // Sign-in by wallet signature (auth.ts); the first one creates the account.
    case 'POST /auth/challenge':
      return json(await challenge(env, (await body<{ address?: unknown }>(request)).address));

    case 'POST /auth/verify':
      return json(await verifyAuth(env, await body(request), ip));

    case 'POST /wallet/create': {
      const me = await accountFrom(env, request);
      return json(await createWallet(env, me, await body(request)));
    }

    case 'GET /account': {
      const network = url.searchParams.get('network') ?? undefined;
      if (network !== undefined && !isNetwork(network)) throw new GatewayError('bad-network');
      return json(await account(env, await accountFrom(env, request), network));
    }

    // The account's phone number: OTP to add or move it here, and remove.
    case 'POST /account/phone/start': {
      await accountFrom(env, request);
      return json(await startPhone(env, (await body<{ phone?: unknown }>(request)).phone));
    }

    case 'POST /account/phone/verify': {
      const me = await accountFrom(env, request);
      const req = await body<{ phone?: unknown; code?: unknown }>(request);
      return json(await verifyPhone(env, me, req.phone, req.code));
    }

    case 'POST /account/phone/remove':
      return json(await removePhone(env, await accountFrom(env, request)));

    case 'GET /activity': {
      const me = await accountFrom(env, request);
      const network = url.searchParams.get('network') ?? undefined;
      if (network !== undefined && !isNetwork(network)) throw new GatewayError('bad-network');
      return json(await activity(env, me, network));
    }

    case 'GET /names/check': {
      await limit(env, `names:${ip}`);
      return json(await names.check(env, url.searchParams.get('label') ?? ''));
    }

    // Number -> Ender ID and addresses, for signed-in users only; limited per user and per IP. Never the other way.
    case 'GET /names/by-phone': {
      const me = await accountFrom(env, request);
      await limit(env, `lookup:${me}`);
      await limit(env, `names:${ip}`);
      const phone = url.searchParams.get('phone') ?? '';
      if (!isPhone(phone)) throw new GatewayError('bad-phone');
      const found = await names.byPhone(env, phone, lookupNetwork(url));
      if (!found) throw new GatewayError('not-on-ender', 404);
      return json(found);
    }

    // The account's one change of Ender ID: what it would take, and making it (by its number, or a $2 payment).
    case 'GET /account/name': {
      const { phoneNumber: _, ...status } = await names.nameStatus(env, await accountFrom(env, request));
      return json(status);
    }

    case 'POST /account/name': {
      const me = await accountFrom(env, request);
      return json(await names.customise(env, me, await body<{ name?: unknown; txHash?: unknown }>(request)));
    }

    case 'POST /account/alerts': {
      const me = await accountFrom(env, request);
      return json(await setAlerts(env, me, (await body<{ on?: unknown }>(request)).on));
    }

    case 'POST /tx/quote': {
      const me = await accountFrom(env, request);
      const req = await body<{ network?: string; to?: string; amount?: string; deliver?: string }>(request);
      if (req.network !== undefined && !isNetwork(req.network)) throw new GatewayError('bad-network');
      if (typeof req.to !== 'string' || typeof req.amount !== 'string') throw new GatewayError('bad-request');
      if (req.deliver !== undefined && req.deliver !== 'AUSD' && req.deliver !== 'CTK') throw new GatewayError('bad-request');
      return json(await quote(env, me, { network: req.network, to: req.to, amount: req.amount, deliver: req.deliver }));
    }

    case 'POST /tx/sign': {
      const me = await accountFrom(env, request);
      const req = await body<{ id?: string; signature?: string }>(request);
      if (typeof req.id !== 'string' || !isHex(req.signature) || req.signature.length !== 132) throw new GatewayError('bad-request');
      return json(await sign(env, me, req.id.toUpperCase(), req.signature as Hex));
    }

    // Shielded pool, on each network with one (protocol/networks.ts). `network` defaults to mainnet, as everywhere.
    case 'POST /shielded/register': {
      const me = await accountFrom(env, request);
      const req = await body<{ network?: string; keys?: Record<string, unknown> }>(request);
      return json(await shielded.register(env, me, shieldedNetwork(req.network), req.keys));
    }

    case 'GET /shielded/notes': {
      const me = await accountFrom(env, request);
      return json(await shielded.notes(env, me, shieldedNetwork(url.searchParams.get('network') ?? undefined)));
    }

    case 'POST /shielded/quote': {
      const me = await accountFrom(env, request);
      const req = await body<{ network?: string; kind?: string; to?: string; amount?: string }>(request);
      if (!['pay', 'withdraw', 'shield', 'merge'].includes(req.kind ?? '')) throw new GatewayError('bad-request');
      return json(
        await shielded.quote(
          env,
          me,
          { network: shieldedNetwork(req.network), kind: req.kind as shielded.ShieldedKind, to: req.to, amount: req.amount },
          (p) => ctx.waitUntil(p),
        ),
      );
    }

    case 'POST /shielded/submit': {
      const me = await accountFrom(env, request);
      const req = await body<{ id?: unknown; refs?: unknown; sig?: unknown; signature?: unknown }>(request);
      if (typeof req.id !== 'string') throw new GatewayError('bad-request');
      const sig = req.sig === undefined ? undefined : shielded.sigFromBase64(req.sig);
      if (sig === null) throw new GatewayError('bad-request');
      if (req.refs !== undefined && (!Array.isArray(req.refs) || req.refs.length > 12)) throw new GatewayError('bad-request');
      if (req.signature !== undefined && (!isHex(req.signature) || req.signature.length !== 132)) throw new GatewayError('bad-request');
      // Finish even if the app gives up waiting (it then texts the SIG, which waits for this same outcome).
      const settled = shielded.submit(env, me, { id: req.id.toUpperCase(), refs: req.refs as number[] | undefined, sig, signature: req.signature as Hex | undefined });
      ctx.waitUntil(settled.catch(() => {}));
      const r = await settled;
      return json({ tx: r.tx, ...(r.p !== undefined ? { p: r.p } : {}), ...(r.pending ? { pending: true } : {}) });
    }

    case 'GET /shielded/address': {
      await accountFrom(env, request);
      const phone = url.searchParams.get('phone') ?? '';
      if (!isPhone(phone)) throw new GatewayError('bad-phone');
      return json(await shielded.shieldedAddress(env, shieldedNetwork(url.searchParams.get('network') ?? undefined), phone));
    }

    // Auto-bridge (bridge.ts): tokens at the user's address on Ethereum, Base, Arbitrum and Polygon, into AUSD on Monad.
    case 'GET /bridge/pending':
      return json(await bridge.pending(env, await accountFrom(env, request)));

    case 'POST /bridge/prepare': {
      const me = await accountFrom(env, request);
      return json(await bridge.prepare(env, me, await body(request)));
    }

    case 'POST /bridge/submit': {
      const me = await accountFrom(env, request);
      // Finish even if the app gives up waiting: it learns the outcome from Relay's status.
      const settled = bridge.submit(env, me, await body(request));
      ctx.waitUntil(settled.catch(() => {}));
      return json(await settled);
    }

    // Address activity from Alchemy; proves itself by signature.
    case 'POST /webhooks/alchemy':
      return alchemyWebhook(request, env, ctx);

    // Inbound texts on the Twilio number; proves itself by signature.
    case 'POST /webhooks/twilio':
      return twilioWebhook(request, env, ctx);

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

    // Dev only: an account for an address without a signature (a random Ender ID, and the number if given, moved here
    // without OTP) and a token for it.
    case 'POST /dev/link': {
      if (env.DEV !== '1') break;
      const req = await body<{ phone?: string; address?: string; network?: string }>(request);
      if ((req.phone !== undefined && !isPhone(req.phone)) || !req.address || !isAddress(req.address)) throw new GatewayError('bad-request');
      const address = req.address.toLowerCase();
      const network = isNetwork(req.network) ? req.network : 'mainnet';
      await names.ensureLabel(env, address, { network });
      await env.DB.batch([
        env.DB.prepare('UPDATE links SET phone = NULL WHERE phone = ? AND address != ?').bind(req.phone ?? null, address),
        env.DB.prepare('UPDATE links SET network = ?, phone = coalesce(?, phone) WHERE address = ?').bind(network, req.phone ?? null, address),
      ]);
      return json({ token: await signJwt(env.JWT_SECRET, { sub: address }, TOKEN_TTL_SECONDS) });
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
  if (network === undefined) return 'mainnet' as const;
  if (!isNetwork(network)) throw new GatewayError('bad-network');
  return network;
};

/** A name lookup's `?network=`: the private address registered there; absent, on any network. */
const lookupNetwork = (url: URL) => {
  const network = url.searchParams.get('network') ?? undefined;
  if (network !== undefined && !isNetwork(network)) throw new GatewayError('bad-network');
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
        // Pushes what a first sign-in couldn't, and makes each network's first webhook.
        syncAlchemy(env),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;

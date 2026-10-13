/**
 * Ender IDs (protocol/names.ts) on the gateway: the random ID every account
 * gets at creation (auth.ts), the one change it may make later, availability,
 * lookups and recipient resolution for quotes. Every label ever given out is
 * in `names` (0010_accounts.sql) and keeps resolving to its account;
 * `links.label` is the current one.
 *
 * Nothing here ever answers with a phone number: a lookup by name gives the
 * public and private addresses only, and the lookup by number is for
 * signed-in users (rate-limited per user and per IP).
 *
 * Also who texts name (docs/SMS.md "Who appears in texts"): Ender IDs by
 * number or address, and reverse ENS for a public Received's sender.
 */
import { createPublicClient, hexToBytes, http, isHex, parseEventLogs, parseUnits, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { enderId, MAX_LABEL, validateLabel, type LabelProblem } from '../../protocol/names';
import { AUSD_DECIMALS, NETWORKS, type NetworkName } from '../../protocol/networks';
import { encodePrivateAddress } from '../../protocol/recipient';
import { packAddress } from '../../protocol/shielded';
import { isTextName } from '../../protocol/sms';
import { publicClient, sponsorAddress, transferEvent } from './chain';
import { GatewayError } from './core';
import type { Env } from './env';
import { ADJECTIVES, NOUNS } from './words';

// ---------------------------------------------------------------- random IDs (ported from ender-backend names.ts)

/** The two hyphens and three digits around the words. */
const FIXED = 5;
const fits = (adjective: string, noun: string) => adjective.length + noun.length + FIXED <= MAX_LABEL;

/**
 * A random ID: `<adjective>-<noun>-<100..999>`, like `nifty-robin-245`. Words
 * so it can be read aloud and remembered, the number so the space stays large;
 * starting at 100 keeps every number three digits. A pair longer than
 * MAX_LABEL is drawn again, which keeps the draw uniform over the pairs that fit.
 */
export const generateLabel = (): string => {
  for (;;) {
    const [adjective, noun] = [pick(ADJECTIVES), pick(NOUNS)];
    if (fits(adjective, noun)) return `${adjective}-${noun}-${100 + randomBelow(900)}`;
  }
};

/** Every ID generateLabel can produce. */
export const NAME_SPACE = ADJECTIVES.reduce((n, a) => n + NOUNS.filter((b) => fits(a, b)).length, 0) * 900;

const pick = (words: readonly string[]): string => words[randomBelow(words.length)]!;

/** A uniform integer in [0, n): rejection sampling, as a bare modulo favours the low values. */
const randomBelow = (n: number): number => {
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value! < limit) return value! % n;
  }
};

/** A unique index refused the write; `what` narrows it to one (`table.column`). */
export const isUniqueConflict = (e: unknown, what = '') => String(e instanceof Error ? e.message : e).includes(`UNIQUE constraint failed: ${what}`);

/** Draws before giving up: eight taken draws from hundreds of millions is a wedged database, never bad luck. */
const MAX_LABEL_ATTEMPTS = 8;

/**
 * The account's current ID, giving it a random one if it has none. For a new
 * account (`create`) the ID goes in the same batch as the account row, one
 * transaction, so no account ever exists without one; an account made before
 * random IDs gets one here on its next sign-in. A taken label fails the batch
 * and the loop draws again; a racing creation of the same account finds the
 * winner's row on the next pass.
 */
export const ensureLabel = async (env: Env, address: string, create?: { network: string }): Promise<{ label: string; created: boolean }> => {
  for (let attempt = 0; ; attempt++) {
    const row = await env.DB.prepare('SELECT label FROM links WHERE address = ?').bind(address).first<{ label: string | null }>();
    if (row?.label) return { label: row.label, created: false };
    if (!row && !create) throw new GatewayError('not-registered', 403);
    if (attempt === MAX_LABEL_ATTEMPTS) throw new Error('Could not assign an Ender ID.');
    const label = generateLabel();
    // Can't be reserved today (those have no digits), but the check keeps that true if either list changes.
    if (validateLabel(label)) continue;
    const t = Math.floor(Date.now() / 1000);
    try {
      await env.DB.batch(
        row
          ? [
              env.DB.prepare('INSERT INTO names (label, address, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM links WHERE address = ? AND label IS NULL)').bind(
                label,
                address,
                t,
                address,
              ),
              env.DB.prepare('UPDATE links SET label = ? WHERE address = ? AND label IS NULL').bind(label, address),
            ]
          : [
              env.DB.prepare('INSERT INTO links (address, network, created_at, label) VALUES (?, ?, ?, ?)').bind(address, create!.network, t, label),
              env.DB.prepare('INSERT INTO names (label, address, created_at) VALUES (?, ?, ?)').bind(label, address, t),
            ],
      );
      if (!row) return { label, created: true };
    } catch (e) {
      if (!isUniqueConflict(e)) throw e;
    }
  }
};

// ---------------------------------------------------------------- lookups

/** `private`: the ender1… address, when the account has registered its shielded keys. */
export type NameInfo = { name: string | null; address: Address; private?: string };

type Row = { label: string | null; address: Address; owner_key: string | null; enc_pk: Hex | null };

/**
 * Private addresses come from the shielded pool's registrations: on `network` when the caller names one, else on
 * any (the keys, so the address, are the same on every network; the app registers on each network with a pool).
 */
const LOOKUP = `SELECT l.label, l.address, s.owner_key, s.enc_pk FROM links l
  LEFT JOIN shielded_users s ON s.account = l.address AND s.network = coalesce(?, s.network)`;

const info = (r: Row): NameInfo => ({
  name: r.label ? enderId(r.label) : null,
  address: r.address,
  ...(r.owner_key && r.enc_pk ? { private: encodePrivateAddress(packAddress({ ownerKey: BigInt(r.owner_key), encPk: hexToBytes(r.enc_pk) })) } : {}),
});

/** By any label the account ever had (an earlier random one too); `name` is its current ID. */
export const byLabel = async (env: Env, label: string, network?: NetworkName): Promise<NameInfo | null> => {
  const r = await env.DB.prepare(`${LOOKUP} WHERE l.address = (SELECT address FROM names WHERE label = ?)`).bind(network ?? null, label.toLowerCase()).first<Row>();
  return r && info(r);
};

export const byPhone = async (env: Env, phone: string, network?: NetworkName): Promise<NameInfo | null> => {
  const r = await env.DB.prepare(`${LOOKUP} WHERE l.phone = ?`).bind(network ?? null, phone).first<Row>();
  return r && info(r);
};

/** The account behind any label it ever had, for routing a payment. */
export const accountOfLabel = async (env: Env, label: string) =>
  (await env.DB.prepare('SELECT address FROM names WHERE label = ?').bind(label.toLowerCase()).first<{ address: Address }>())?.address ?? null;

export const isTaken = async (env: Env, label: string) => !!(await env.DB.prepare('SELECT 1 FROM names WHERE label = ?').bind(label).first());

/** `GET /names/check`: what the change screen shows while typing. */
export const check = async (env: Env, raw: string): Promise<{ available: boolean; reason?: LabelProblem | 'taken' }> => {
  const reason = validateLabel(raw);
  if (reason) return { available: false, reason };
  return (await isTaken(env, raw.toLowerCase())) ? { available: false, reason: 'taken' } : { available: true };
};

/** A label for /account/name: lowercase and valid, else `bad-name`. */
export const requireLabel = (raw: unknown): string => {
  if (typeof raw !== 'string' || validateLabel(raw)) throw new GatewayError('bad-name');
  return raw.toLowerCase();
};

// ---------------------------------------------------------------- the one change

/** What changing the ID by payment costs, in AUSD on mainnet. */
export const nameFee = (env: Env) => env.NAME_FEE_AUSD || '2';
/** Where it is paid: TREASURY_ADDRESS, else the gateway key's address. Lowercase. */
export const treasury = (env: Env) => (env.TREASURY_ADDRESS || sponsorAddress(env)).toLowerCase() as Address;

/**
 * `GET /account/name`: the current ID, whether it is locked (changed once
 * already), whether the account's number can unlock the change (verified and
 * never used for one), and the fee and treasury for paying instead.
 */
export const nameStatus = async (env: Env, account: string) => {
  const r = await env.DB.prepare(
    `SELECT label, phone, EXISTS (SELECT 1 FROM name_unlocks WHERE address = l.address) AS locked,
       EXISTS (SELECT 1 FROM name_unlocks WHERE proof = l.phone) AS phone_used FROM links l WHERE address = ?`,
  )
    .bind(account)
    .first<{ label: string | null; phone: string | null; locked: number; phone_used: number }>();
  if (!r) throw new GatewayError('not-registered', 403);
  return { name: r.label ? enderId(r.label) : null, locked: r.locked === 1, phone: !!r.phone && r.phone_used === 0, fee: nameFee(env), treasury: treasury(env), phoneNumber: r.phone };
};

/**
 * The name fee, paid on Monad mainnet only (testnet AUSD is free): a
 * successful transaction whose AUSD Transfers from the account to the treasury
 * add up to the fee. Returns the hash, lowercase, as the unlock's proof; the
 * caller's batch refuses one used before.
 */
export const verifyPayment = async (env: Env, account: string, raw: unknown): Promise<Hex> => {
  if (typeof raw !== 'string' || !isHex(raw) || raw.length !== 66) throw new GatewayError('bad-payment');
  const hash = raw.toLowerCase() as Hex;
  const receipt = await publicClient(env, 'mainnet')
    .getTransactionReceipt({ hash })
    .catch(() => null);
  if (!receipt || receipt.status !== 'success') throw new GatewayError('payment-not-found', 404);
  const to = treasury(env);
  const ausd = NETWORKS.mainnet.ausd.toLowerCase();
  const paid = parseEventLogs({ abi: transferEvent, logs: receipt.logs.filter((l) => l.address.toLowerCase() === ausd) })
    .filter((l) => l.args.from.toLowerCase() === account && l.args.to.toLowerCase() === to)
    .reduce((s, l) => s + l.args.value, 0n);
  if (paid < parseUnits(nameFee(env), AUSD_DECIMALS)) throw new GatewayError('bad-payment', 402);
  return hash;
};

/**
 * `POST /account/name`: the account's one change of ID, unlocked by its
 * verified number (each number once, ever) or a confirmed payment (`txHash`).
 * One batch: the unlock, the new label and the switch land together or not at
 * all, so a taken name costs nothing and can be retried. The earlier label
 * stays in `names`, resolving to the same account, and is never given out again.
 */
export const customise = async (env: Env, account: string, req: { name?: unknown; txHash?: unknown }) => {
  const label = requireLabel(req.name);
  const status = await nameStatus(env, account);
  if (status.locked) throw new GatewayError('name-already-set', 409);
  const byPayment = req.txHash !== undefined;
  if (!byPayment && !status.phone) throw new GatewayError('unlock-required', 402);
  const proof = byPayment ? await verifyPayment(env, account, req.txHash) : status.phoneNumber!;
  const t = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO name_unlocks (proof, address, created_at) VALUES (?, ?, ?)').bind(proof, account, t),
      env.DB.prepare('INSERT INTO names (label, address, created_at) VALUES (?, ?, ?)').bind(label, account, t),
      env.DB.prepare('UPDATE links SET label = ? WHERE address = ?').bind(label, account),
    ]);
  } catch (e) {
    if (isUniqueConflict(e, 'name_unlocks.address')) throw new GatewayError('name-already-set', 409);
    if (isUniqueConflict(e, 'name_unlocks.proof')) throw new GatewayError(byPayment ? 'payment-used' : 'phone-used', 409);
    if (isUniqueConflict(e)) throw new GatewayError('name-taken', 409);
    throw e;
  }
  return { name: enderId(label) };
};

// ---------------------------------------------------------------- who texts name

/** The Ender ID of the account at this address, if it has one. */
export const idOfAddress = async (env: Env, address: string) => {
  const r = await env.DB.prepare('SELECT label FROM links WHERE address = ?').bind(address.toLowerCase()).first<{ label: string | null }>();
  return r?.label ? enderId(r.label) : null;
};

export const DEFAULT_ETH_RPC = 'https://eth.drpc.org';
/** A cached reverse-ENS answer (a name, or none) is rechecked after this long. */
export const ENS_TTL_SECONDS = 7 * 86_400;
/** An alert waits at most this long for ENS, then shows the address. */
const ENS_TIMEOUT_MS = 4_000;

/**
 * The address's primary ENS name on Ethereum, if it has one a text can carry
 * (isTextName: plain ASCII GSM-7, at most 40 characters), else null. Verified:
 * viem's getEnsName asks the Universal Resolver, which checks that the name
 * resolves forward to the same address. Cached per address in `ens_names` for
 * ENS_TTL_SECONDS. Never throws: an RPC failure answers the cached name, if
 * any, else null (and the alert shows the address).
 */
export const reverseEns = async (env: Env, address: string): Promise<string | null> => {
  const a = address.toLowerCase() as Address;
  const t = Math.floor(Date.now() / 1000);
  const cached = await env.DB.prepare('SELECT name, checked_at FROM ens_names WHERE address = ?')
    .bind(a)
    .first<{ name: string | null; checked_at: number }>()
    .catch(() => null);
  if (cached && t - cached.checked_at < ENS_TTL_SECONDS) return cached.name;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = createPublicClient({ chain: mainnet, transport: http(env.ETH_RPC_URL || DEFAULT_ETH_RPC, { timeout: ENS_TIMEOUT_MS, retryCount: 0 }) });
    // The race also bounds a CCIP-Read gateway fetch, which the transport's timeout doesn't cover.
    const found = await Promise.race([
      client.getEnsName({ address: a }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ENS_TIMEOUT_MS))),
    ]);
    const name = found && isTextName(found) ? found : null;
    await env.DB.prepare(
      'INSERT INTO ens_names (address, name, checked_at) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at',
    )
      .bind(a, name, t)
      .run();
    return name;
  } catch (e) {
    console.warn('reverse ENS failed:', (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e));
    return cached?.name ?? null;
  } finally {
    clearTimeout(timer);
  }
};

/** A public Received's from=: the sender's Ender ID, else its verified reverse-ENS name, else its address. Never a number. */
export const senderName = async (env: Env, address: string) => (await idOfAddress(env, address)) ?? (await reverseEns(env, address)) ?? address;

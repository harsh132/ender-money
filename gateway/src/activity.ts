/**
 * Incoming money: every minute the cron reads AUSD Transfer logs since the last
 * block it saw, keeps the ones touching a linked address, and texts recipients
 * an alert. GET /activity serves the same table, so an online recipient sees
 * money arrive without the SMS, and a fresh device gets its history back.
 *
 * Monad's public RPCs cap eth_getLogs at 100 blocks; at ~0.4 s a block that is
 * two calls a minute per network, with room to catch up after a gap.
 */
import { formatUnits, parseAbiItem, type Address, type Hex } from 'viem';
import { erc20Abi } from '../../protocol/calibur';
import { AUSD_DECIMALS, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../protocol/networks';
import { formatAlert, shortHex } from '../../protocol/sms';
import { publicClient } from './chain';
import { GatewayError } from './core';
import type { Env } from './env';
import { canText, sendSms } from './outbound';

const RANGE = 100n;
/** Blocks per run at most (cron is every minute, ~150 new blocks). */
const MAX_CHUNKS = 10n;
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

type LinkRow = { phone: string; address: string; alerts: number };

const linksFor = async (env: Env, addresses: string[]) => {
  const out = new Map<string, LinkRow>();
  // D1 caps bound parameters per statement.
  for (let i = 0; i < addresses.length; i += 90) {
    const part = addresses.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT phone, address, alerts FROM links WHERE address IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<LinkRow>();
    for (const r of results) out.set(r.address, r);
  }
  return out;
};

export const scan = async (env: Env, network: NetworkName) => {
  const net = NETWORKS[network];
  const pub = publicClient(env, network);
  const head = await pub.getBlockNumber();
  const cursor = await env.DB.prepare('SELECT block FROM cursors WHERE network = ?').bind(network).first<{ block: number }>();
  let from = cursor ? BigInt(cursor.block) + 1n : head;
  const last = from + RANGE * MAX_CHUNKS - 1n < head ? from + RANGE * MAX_CHUNKS - 1n : head;
  if (from > last) return;

  const logs = [];
  for (; from <= last; from += RANGE) {
    const to = from + RANGE - 1n < last ? from + RANGE - 1n : last;
    logs.push(...(await pub.getLogs({ address: net.ausd, event: transferEvent, fromBlock: from, toBlock: to })));
  }

  const addresses = [...new Set(logs.flatMap((l) => [l.args.from!.toLowerCase(), l.args.to!.toLowerCase()]))];
  const links = addresses.length ? await linksFor(env, addresses) : new Map<string, LinkRow>();
  const now = Math.floor(Date.now() / 1000);
  const ours = logs.filter((l) => links.has(l.args.from!.toLowerCase()) || links.has(l.args.to!.toLowerCase()));

  const writes = ours.map((l) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO transfers (network, tx_hash, log_index, from_address, to_address, amount, block, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(network, l.transactionHash, l.logIndex, l.args.from!.toLowerCase(), l.args.to!.toLowerCase(), l.args.value!.toString(), Number(l.blockNumber), now),
  );
  writes.push(
    env.DB.prepare('INSERT INTO cursors (network, block) VALUES (?, ?) ON CONFLICT (network) DO UPDATE SET block = excluded.block').bind(network, Number(last)),
  );
  await env.DB.batch(writes);

  for (const l of ours) {
    const recipient = links.get(l.args.to!.toLowerCase());
    if (recipient?.alerts) await alert(env, network, recipient, l.transactionHash, l.args.from!, l.args.value!, links).catch((e) => console.error('alert failed', e instanceof Error ? e.message : e));
  }
};

/** One alert per transaction per number; alerts_sent makes a re-scan harmless. */
const alert = async (env: Env, network: NetworkName, to: LinkRow, txHash: Hex, from: Address, value: bigint, links: Map<string, LinkRow>) => {
  if (!canText(to.phone)) return;
  const fresh = await env.DB.prepare('INSERT OR IGNORE INTO alerts_sent (tx_hash, phone) VALUES (?, ?)').bind(txHash, to.phone).run();
  if (fresh.meta.changes !== 1) return;
  const balance = await publicClient(env, network).readContract({ address: NETWORKS[network].ausd, abi: erc20Abi, functionName: 'balanceOf', args: [to.address as Address] });
  const sender = links.get(from.toLowerCase())?.phone ?? shortHex(from);
  const text = formatAlert(formatUnits(value, AUSD_DECIMALS), sender, formatUnits(balance, AUSD_DECIMALS));
  await sendSms(env, to.phone, network === 'testnet' ? `[Test] ${text}` : text);
};

// ---------------------------------------------------------------- GET /activity

/** `network` defaults to the number's current one, as for /account. */
export const activity = async (env: Env, phone: string, requested?: NetworkName) => {
  const link = await env.DB.prepare('SELECT address, network FROM links WHERE phone = ?').bind(phone).first<{ address: string; network: NetworkName }>();
  if (!link) throw new GatewayError('not-registered', 403);
  const network = requested ?? link.network;
  const me = link.address.toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT tx_hash, log_index, from_address, to_address, amount, at FROM transfers
     WHERE network = ? AND (to_address = ? OR (from_address = ? AND to_address != ?))
     ORDER BY block DESC, log_index DESC LIMIT 100`,
  )
    .bind(network, me, me, FEE_RECIPIENT.toLowerCase())
    .all<{ tx_hash: Hex; log_index: number; from_address: Address; to_address: Address; amount: string; at: number }>();
  return {
    network,
    items: results.map((r) => ({
      txHash: r.tx_hash,
      logIndex: r.log_index,
      direction: r.to_address === me ? ('in' as const) : ('out' as const),
      counterparty: r.to_address === me ? r.from_address : r.to_address,
      amount: formatUnits(BigInt(r.amount), AUSD_DECIMALS),
      at: r.at,
    })),
  };
};

export const setAlerts = async (env: Env, phone: string, on: unknown) => {
  if (typeof on !== 'boolean') throw new GatewayError('bad-request');
  await env.DB.prepare('UPDATE links SET alerts = ? WHERE phone = ?').bind(on ? 1 : 0, phone).run();
  return { alerts: on };
};

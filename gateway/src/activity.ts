/**
 * Incoming money: AUSD transfers touching a linked address land in `transfers`
 * and text the recipient an alert. Alchemy's Address Activity webhook
 * (alchemy.ts) is the only source; the primary key and alerts_sent make a
 * repeated delivery harmless. GET /activity serves the same table, so an
 * online recipient sees money arrive without the SMS, and a fresh device gets
 * its history back.
 */
import { formatUnits, type Address, type Hex } from 'viem';
import { erc20Abi } from '../../protocol/calibur';
import { AUSD_DECIMALS, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../protocol/networks';
import { formatAlert, shortHex } from '../../protocol/sms';
import { publicClient } from './chain';
import { GatewayError } from './core';
import type { Env } from './env';
import { canText, sendSms } from './outbound';

/** Older than this, a transfer is recorded but not texted about: a late (retried) delivery doesn't send a stale alert. */
export const ALERT_MAX_AGE = 600;
const now = () => Math.floor(Date.now() / 1000);

type LinkRow = { phone: string; address: string; alerts: number };

/** One AUSD Transfer log, addresses lowercase; `at` is when it happened, or the best estimate of it. */
export type Transfer = { txHash: Hex; logIndex: number; from: Address; to: Address; value: bigint; block: number; at: number };

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

/** Insert the transfers that touch a linked address, in one batch. Alerts follow with alertAll. */
export const record = async (env: Env, network: NetworkName, transfers: Transfer[]) => {
  const links = transfers.length ? await linksFor(env, [...new Set(transfers.flatMap((t) => [t.from, t.to]))]) : new Map<string, LinkRow>();
  const ours = transfers.filter((t) => links.has(t.from) || links.has(t.to));
  const writes = ours.map((t) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO transfers (network, tx_hash, log_index, from_address, to_address, amount, block, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(network, t.txHash, t.logIndex, t.from, t.to, t.value.toString(), t.block, t.at),
  );
  if (writes.length) await env.DB.batch(writes);
  return { network, ours, links };
};

/** Text each recipient with alerts on, skipping transfers older than ALERT_MAX_AGE. Never throws. */
export const alertAll = async (env: Env, { network, ours, links }: Awaited<ReturnType<typeof record>>) => {
  const t = now();
  for (const x of ours) {
    const recipient = links.get(x.to);
    if (!recipient?.alerts || t - x.at > ALERT_MAX_AGE) continue;
    await alert(env, network, recipient, x.txHash, x.from, x.value, links).catch((e) => console.error('alert failed', e instanceof Error ? e.message : e));
  }
};

/** One alert per transaction per number; alerts_sent makes a repeated delivery harmless. */
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

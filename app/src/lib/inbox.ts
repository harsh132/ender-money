/**
 * Public `Received` alerts that arrive by text, as Activity rows. The alert
 * carries only the short tx hash, so the row's id is built from it, and the
 * online history (GET /activity, full hash) replaces that row when it sees the
 * same transfer. Pure, so it runs under `bun test`.
 */
import type { Address } from 'viem';
import type { NetworkName } from '../../../protocol/networks';
import { shortHex, type Reply } from '../../../protocol/sms';
import type { Tx } from './store';

export type Received = Extract<Reply, { kind: 'received' }>;

export const smsRowId = (network: NetworkName, shortTx: string) => `sms:${network}:${shortTx.toLowerCase()}`;
export const alertNetwork = (r: Received): NetworkName => (r.test ? 'testnet' : 'mainnet');

/** The row for an alert, or null when that transfer is already in Activity (online history, or the same text twice). */
export const receivedRow = (activity: Tx[], r: Received, at: number): Tx | null => {
  const network = alertNetwork(r);
  const id = smsRowId(network, r.tx);
  const known = activity.some((t) => t.network === network && (t.id === id || (t.direction === 'in' && !!t.txHash && shortHex(t.txHash).toLowerCase() === r.tx)));
  if (known) return null;
  return { id, network, direction: 'in', amount: r.amount, counterparty: r.from.toLowerCase() as Address, status: 'sent', at };
};

/** The row from a text that an incoming item of the online history stands for. */
export const smsTwin = (activity: Tx[], network: NetworkName, item: { txHash: string; direction: 'in' | 'out' }) =>
  item.direction === 'in' ? activity.find((t) => t.id === smsRowId(network, shortHex(item.txHash))) : undefined;

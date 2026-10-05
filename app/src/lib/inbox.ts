/**
 * Public `Received` alerts that arrive by text, as Activity rows. The alert
 * carries only the short tx hash, so the row's id is built from it, and the
 * online history (GET /activity, full hash) replaces that row when it sees the
 * same transfer. Pure, so it runs under `bun test`. A private `Received`
 * (p= b=) is a note: private.ts.
 */
import { isAddress, type Address } from 'viem';
import type { NetworkName } from '../../../protocol/networks';
import { shortHex, type Reply } from '../../../protocol/sms';
import type { State, Tx } from './store';

/** A public Received; the private one has p and blinding. */
export type Received = Extract<Reply, { kind: 'received'; p?: undefined }>;

export const smsRowId = (network: NetworkName, shortTx: string) => `sms:${network}:${shortTx.toLowerCase()}`;
export const alertNetwork = (r: Received): NetworkName => (r.test ? 'testnet' : 'mainnet');

/**
 * The row for an alert, or null when that transfer is already in Activity (online history, or the same text twice).
 * A sender named by Ender ID or ENS name is the row's label; its address comes with the online history.
 */
export const receivedRow = (activity: Tx[], r: Received, at: number): Tx | null => {
  const network = alertNetwork(r);
  const id = smsRowId(network, r.tx);
  const known = activity.some((t) => t.network === network && (t.id === id || (t.direction === 'in' && !!t.txHash && shortHex(t.txHash).toLowerCase() === r.tx)));
  if (known) return null;
  const from = isAddress(r.from) ? { counterparty: r.from.toLowerCase() as Address } : { label: r.from };
  return { id, network, direction: 'in', amount: r.amount, ...from, status: 'sent', at };
};

/**
 * A Received text, applied to the network it names whatever mode the app shows: the new row and that network's
 * balance. Null when Activity already has that transfer (its balance may be older than the synced one).
 */
export const fileReceived = (s: Pick<State, 'activity' | 'account'>, r: Received, at: number) => {
  const row = receivedRow(s.activity, r, at);
  if (!row) return null;
  const a = s.account[row.network];
  return { row, account: a ? { ...s.account, [row.network]: { ...a, balance: r.balance, syncedAt: at } } : s.account };
};

/** The row from a text that an incoming item of the online history stands for. */
export const smsTwin = (activity: Tx[], network: NetworkName, item: { txHash: string; direction: 'in' | 'out' }) =>
  item.direction === 'in' ? activity.find((t) => t.id === smsRowId(network, shortHex(item.txHash))) : undefined;

import { expect, test } from 'bun:test';
import { parseReply } from '../../../protocol/sms';
import { receivedRow, smsTwin, type Received } from './inbox';
import type { Tx } from './store';

const HASH = '0xab12c0ffee000000000000000000000000000000000000000000000000000ef';
const TEXT = '[Test] Received 10 AUSD from 0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5. Balance 45.2 AUSD. Tx 0xab12...ef\nFA+9qCX9VSu';

test('a Received alert (with the Retriever hash line) becomes one incoming row', () => {
  const r = parseReply(TEXT) as Received;
  expect(r).toEqual({ kind: 'received', amount: '10', from: '0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5', balance: '45.2', tx: '0xab12...ef', test: true });
  const row = receivedRow([], r, 1000);
  expect(row).toEqual({
    id: 'sms:testnet:0xab12...ef',
    network: 'testnet',
    direction: 'in',
    amount: '10',
    counterparty: '0x7e9bce1e34dadc99a83da4edcdb56d288afa84c5',
    status: 'sent',
    at: 1000,
  });
  // The same text again (Retriever and receiver, or a re-read): nothing new.
  expect(receivedRow([row!], r, 2000)).toBeNull();
  // Mainnet alerts have no [Test] prefix and land on mainnet.
  expect(receivedRow([row!], parseReply(TEXT.replace('[Test] ', '')) as Received, 0)?.network).toBe('mainnet');
});

test('dedupe against the online history, both ways', () => {
  const r = parseReply(TEXT) as Received;
  const online: Tx = { id: `${HASH}:0`, network: 'testnet', direction: 'in', amount: '10', status: 'sent', txHash: HASH, at: 1 };
  // Already synced online: the alert adds nothing.
  expect(receivedRow([online], r, 5)).toBeNull();
  // The text came first: the online item finds its row, to replace it.
  const row = receivedRow([], r, 5)!;
  expect(smsTwin([row], 'testnet', { txHash: HASH, direction: 'in' })).toBe(row);
  expect(smsTwin([row], 'mainnet', { txHash: HASH, direction: 'in' })).toBeUndefined();
  expect(smsTwin([row], 'testnet', { txHash: HASH, direction: 'out' })).toBeUndefined();
  expect(smsTwin([row], 'testnet', { txHash: `0x99${HASH.slice(4)}`, direction: 'in' })).toBeUndefined();
});

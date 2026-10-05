import { expect, test } from 'bun:test';
import { parseReply } from '../../../protocol/sms';
import { fileReceived, receivedRow, smsTwin, type Received } from './inbox';
import type { Tx } from './store';

const HASH = '0xab12c0ffee000000000000000000000000000000000000000000000000000ef';
/** The current form, and the older one (TEXT) that still parses. */
const NEW = '[Test] Received 10 AUSD from=0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5 balance=45.2 tx=0xab12...ef\nFA+9qCX9VSu';
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

test('a sender named by Ender ID or ENS name is the label; the online history brings the address', () => {
  for (const name of ['ravi1.ender.my', 'vitalik.eth']) {
    const r = parseReply(NEW.replace(/from=\S+/,`from=${name}`)) as Received;
    expect(r.from).toBe(name);
    const row = receivedRow([], r, 5)!;
    expect(row).toEqual({ id: 'sms:testnet:0xab12...ef', network: 'testnet', direction: 'in', amount: '10', label: name, status: 'sent', at: 5 });
    expect(smsTwin([row], 'testnet', { txHash: HASH, direction: 'in' })).toBe(row);
  }
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

test('a Received lands in the network it names, whatever mode the app shows', () => {
  const account = { mainnet: { balance: '1', nonce: '0', delegated: true, syncedAt: 0 }, testnet: { balance: '2', nonce: '0', delegated: true, syncedAt: 0 } };
  // Showing testnet, a mainnet alert: mainnet row and balance (fileReceived never reads the mode).
  const main = fileReceived({ activity: [], account }, parseReply(NEW.replace('[Test] ', '')) as Received, 7)!;
  expect(main.row).toMatchObject({ id: 'sms:mainnet:0xab12...ef', network: 'mainnet' });
  expect(main.account).toEqual({ ...account, mainnet: { ...account.mainnet, balance: '45.2', syncedAt: 7 } });
  // Showing mainnet, a testnet alert: testnet row and balance.
  const test_ = fileReceived({ activity: [], account }, parseReply(NEW) as Received, 7)!;
  expect(test_.row).toMatchObject({ id: 'sms:testnet:0xab12...ef', network: 'testnet' });
  expect(test_.account).toEqual({ ...account, testnet: { ...account.testnet, balance: '45.2', syncedAt: 7 } });
  // Already in Activity: nothing.
  expect(fileReceived({ activity: [test_.row], account }, parseReply(NEW) as Received, 8)).toBeNull();
});

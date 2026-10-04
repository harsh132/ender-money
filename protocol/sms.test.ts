import { expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  fitsOneSegment,
  formatCommand,
  formatOtp,
  formatReply,
  normalizePhone,
  parseCommand,
  parseReply,
  septets,
  withRetrieverHash,
  type Command,
  type Reply,
} from './sms';

const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const address = privateKeyToAccount(key).address;

test('commands round-trip and fit one segment', async () => {
  const signature = await privateKeyToAccount(key).signMessage({ message: 'x' });
  const commands: Command[] = [
    { kind: 'sync', network: 'mainnet' },
    { kind: 'sync', network: 'testnet' },
    { kind: 'send', to: address.toLowerCase(), amount: '10.5', deliver: 'AUSD' },
    { kind: 'send', to: '+919876543210', amount: '0.001', deliver: 'CTK' },
    { kind: 'sig', id: '7F3K', signature },
  ];
  for (const c of commands) {
    const text = formatCommand(c);
    expect(fitsOneSegment(text)).toBe(true);
    expect(parseCommand(text)).toEqual(c);
  }
});

test('commands are forgiving about case and spacing, strict about content', () => {
  expect(parseCommand('  sync   t ')).toEqual({ kind: 'sync', network: 'testnet' });
  expect(parseCommand(`send ${address},10 ausd`)).toMatchObject({ kind: 'send', to: address.toLowerCase(), amount: '10' });
  expect(parseCommand('SEND 12345, 10 AUSD')).toBeNull(); // not an address or E.164 number
  expect(parseCommand(`SEND ${address}, 0 AUSD`)).toBeNull();
  expect(parseCommand(`SEND ${address}, 1.1234567 AUSD`)).toBeNull(); // AUSD has 6 decimals
  expect(parseCommand('SIG 7F3K notbase64')).toBeNull();
  expect(parseCommand('HELLO')).toBeNull();
});

test('replies round-trip and fit one segment, even at their longest', () => {
  const replies: Reply[] = [
    { kind: 'ok', nonce: 3n, delegated: true, balance: '45.2', inr: '83.9' },
    {
      kind: 'quote',
      id: '7F3K',
      nonce: 18446744073709551615n,
      expires: 1790000000,
      fee: '0.001',
      to: address,
      out: '999999.999999999999999999',
    },
    { kind: 'sent', amount: '10', to: '0x1234...cd', tx: '0xabcd...ef' },
    { kind: 'error', id: '7F3K', code: 'expired' },
    { kind: 'error', code: 'not-registered' },
  ];
  for (const r of replies) {
    const text = formatReply(r);
    expect(fitsOneSegment(text)).toBe(true);
    expect(parseReply(text)).toEqual(r);
  }
});

test('alerts and OTPs fit, with the Retriever hash appended', () => {
  const alert: Reply = { kind: 'received', amount: '99999.999999', from: address, balance: '99999.999999', tx: '0xab12...ef', test: true };
  const text = withRetrieverHash(formatReply(alert), 'FA+9qCX9VSu');
  expect(text).toBe(`[Test] Received 99999.999999 AUSD from ${address}. Balance 99999.999999 AUSD. Tx 0xab12...ef${'\n'}FA+9qCX9VSu`);
  expect(fitsOneSegment(text)).toBe(true);
  expect(parseReply(text)).toEqual(alert); // the hash line is ignored
  expect(parseReply(formatReply({ ...alert, from: address.toLowerCase() as typeof address, test: false }))).toEqual({ ...alert, test: false }); // EIP-55 out
  expect(fitsOneSegment(withRetrieverHash(formatOtp('481926'), 'FA+9qCX9VSu'))).toBe(true);
});

test('Got carries no sender; the older "from" form still parses', () => {
  const got: Reply = { kind: 'got', amount: '20', p: 2, blinding: 123456789n };
  const text = formatReply(got);
  expect(text).toBe('Got 20 AUSD (private) p=2 b=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdbzRU');
  expect(parseReply(`${text}\nFA+9qCX9VSu`)).toEqual(got);
  expect(parseReply(text.replace('(private)', 'from +919800000001'))).toEqual(got);
});

test('non-GSM characters are refused, extended ones cost two', () => {
  expect(septets('Sent 10…')).toBeNull();
  expect(septets('₹10')).toBeNull();
  expect(septets('{}')).toBe(4);
  expect(() => formatReply({ kind: 'sent', amount: '1', to: '0x12…cd', tx: '0xab' })).toThrow();
});

test('sender numbers normalise to E.164; non-personal senders are refused', () => {
  for (const raw of ['+919876543210', '9876543210', '09876543210', '919876543210', '0091 98765-43210', '+91 98765 43210'])
    expect(normalizePhone(raw)).toBe('+919876543210');
  expect(normalizePhone('+14155550123')).toBe('+14155550123');
  for (const raw of ['VM-AIRTEL', '56767', 'AD-HDFCBK', '+123']) expect(normalizePhone(raw)).toBeNull();
});

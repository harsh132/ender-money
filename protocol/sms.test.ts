import { expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  fitsOneSegment,
  b64,
  formatCommand,
  formatOtp,
  formatShieldedCommand,
  formatReply,
  normalizePhone,
  parseCommand,
  parseReply,
  parseShieldedCommand,
  septets,
  withRetrieverHash,
  type Command,
  type Reply,
} from './sms';

const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const address = privateKeyToAccount(key).address;

test('commands round-trip and fit one segment, on either network', async () => {
  const signature = await privateKeyToAccount(key).signMessage({ message: 'x' });
  const commands: Command[] = [
    { kind: 'sync' },
    { kind: 'send', to: address.toLowerCase(), amount: '10.5', deliver: 'AUSD' },
    { kind: 'send', to: '+919876543210', amount: '0.001', deliver: 'CTK' },
    { kind: 'sig', id: '7F3K', signature },
  ];
  for (const c of commands) {
    const main = formatCommand(c, 'mainnet');
    const test = formatCommand(c, 'testnet');
    expect(test).toBe(`[Test] ${main}`);
    expect(septets(test)).toBe(septets(main)! + 9);
    expect(fitsOneSegment(test)).toBe(true);
    // Unprefixed: mainnet for SYNC, the gateway's legacy rule for anything else (no network).
    expect(parseCommand(main)).toEqual(c.kind === 'sync' ? { ...c, network: 'mainnet' } : c);
    expect(parseCommand(test)).toEqual({ ...c, network: 'testnet' });
  }
});

test('commands are forgiving about case and spacing, strict about content', () => {
  expect(parseCommand('  sync   t ')).toEqual({ kind: 'sync', network: 'testnet' }); // the older SYNC T
  expect(parseCommand(' [test]  sync')).toEqual({ kind: 'sync', network: 'testnet' });
  expect(parseCommand(`[TEST] send ${address},10 ausd`)).toMatchObject({ kind: 'send', network: 'testnet', amount: '10' });
  expect(parseCommand(`send ${address},10 ausd`)).toMatchObject({ kind: 'send', to: address.toLowerCase(), amount: '10' });
  expect(parseCommand(`send ${address},10 ausd`)).not.toHaveProperty('network');
  expect(parseCommand('[Main] SYNC')).toBeNull();
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
  expect(text).toBe(`[Test] Received 99999.999999 AUSD from=${address} balance=99999.999999 tx=0xab12...ef${'\n'}FA+9qCX9VSu`);
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

test('Sent, Shielded and Received are key=value; Sent and Shielded carry the id; older forms still parse', () => {
  const sent: Reply = { kind: 'sent', id: '7F3K', amount: '20', to: '+919800000002', tx: '0xab12...ef', p: 2 };
  expect(formatReply(sent)).toBe('Sent 7F3K 20 AUSD to=+919800000002 tx=0xab12...ef p=2');
  expect(parseReply(formatReply(sent))).toEqual(sent);
  const shielded: Reply = { kind: 'shielded', id: '7F3K', amount: '1', tx: '0xab12...ef', p: 5 };
  expect(formatReply(shielded)).toBe('Shielded 7F3K 1 AUSD tx=0xab12...ef p=5');
  expect(parseReply(formatReply(shielded))).toEqual(shielded);
  const received: Reply = { kind: 'received', amount: '10', from: address, balance: '10', tx: '0xab12...ef', test: true };
  expect(formatReply(received)).toBe(`[Test] Received 10 AUSD from=${address} balance=10 tx=0xab12...ef`);
  // Older gateways: no id, `to …. Tx …`, `. Tx …`, `from …. Balance … AUSD. Tx …`.
  expect(parseReply('Sent 20 AUSD to +919800000002. Tx 0xab12...ef p=2')).toEqual({ kind: 'sent', amount: '20', to: '+919800000002', tx: '0xab12...ef', p: 2 });
  expect(parseReply('Sent 2345 AUSD to 0x1234...cd. Tx 0xab12...ef')).toEqual({ kind: 'sent', amount: '2345', to: '0x1234...cd', tx: '0xab12...ef' }); // an all-digit amount, not an id
  expect(parseReply('Shielded 50 AUSD. Tx 0xab12...ef p=0')).toEqual({ kind: 'shielded', amount: '50', tx: '0xab12...ef', p: 0 });
  expect(parseReply(`[Test] Received 10 AUSD from ${address}. Balance 10 AUSD. Tx 0xab12...ef`)).toEqual(received);
});

test('[Test] marks every testnet text; worst cases fit one segment with it and the hash line', () => {
  const max = '999999.999999';
  const worst: Reply[] = [
    { kind: 'ok', nonce: 18446744073709551615n, delegated: true, balance: max, inr: '88.72' },
    { kind: 'quote', id: '7F3K', nonce: 18446744073709551615n, expires: 1791200000, fee: '0.01', to: address, out: '999999.999999999999999999' },
    { kind: 'shieldedQuote', id: '7F3K', expires: 999999999999, fee: '0.01', to: new Uint8Array(64).fill(255) },
    { kind: 'sent', id: '7F3K', amount: max, to: '+123456789012345', tx: '0xab12...ef', p: 99999999 },
    { kind: 'shielded', id: '7F3K', amount: max, tx: '0xab12...ef', p: 99999999 },
    { kind: 'got', amount: max, p: 99999999, blinding: (1n << 256n) - 1n },
    { kind: 'error', id: '7F3K', code: 'send-failed' },
    { kind: 'received', amount: max, from: address, balance: max, tx: '0xab12...ef', test: true },
  ];
  for (const r of worst) {
    const text = withRetrieverHash(formatReply({ ...r, test: true }), 'FA+9qCX9VSu');
    expect(text.startsWith('[Test] ')).toBe(true);
    expect(fitsOneSegment(text)).toBe(true);
    expect(parseReply(text)).toEqual({ ...r, test: true });
    // Untagged: mainnet.
    expect(parseReply(formatReply({ ...r, test: false }))?.test).toBeFalsy();
  }
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

test('phone texts at their longest, with [Test]: all fit (no hash line on phone texts)', async () => {
  const signature = await privateKeyToAccount(key).signMessage({ message: 'x' });
  const ender1 = 'ender1rreg3epk4xpk3zmh7sujagu783a06av4andq2dq8x37ye6z6gfe7r3xyxafcr5ggzcaag53fumarcwpcvmy62nc4lc823ktn46kkq2g7q6dx9';
  const refs = Array.from({ length: 12 }, (_, i) => 262_143 - i);
  const lengths = {
    sync: septets(formatCommand({ kind: 'sync' }, 'testnet')),
    send: septets(formatCommand({ kind: 'send', to: address.toLowerCase(), amount: '999999.999999', deliver: 'CTK' }, 'testnet')),
    sig: septets(formatCommand({ kind: 'sig', id: '7F3K', signature }, 'testnet')),
    pay: septets(formatShieldedCommand({ kind: 'pay', to: ender1, amount: '999999.999999' }, 'testnet')),
    shield: septets(formatShieldedCommand({ kind: 'shield', amount: '999999.999999' }, 'testnet')),
    merge: septets(formatShieldedCommand({ kind: 'merge' }, 'testnet')),
    privateSig: septets(formatShieldedCommand({ kind: 'shieldedSig', id: '7F3K', refs, signature: new Uint8Array(64).fill(255) }, 'testnet')),
  };
  expect(lengths).toEqual({ sync: 13, send: 82, sig: 106, pay: 148, shield: 34, merge: 14, privateSig: 141 });
  const sig = formatShieldedCommand({ kind: 'shieldedSig', id: '7F3K', refs, signature: new Uint8Array(64).fill(255) }, 'testnet');
  expect(parseShieldedCommand(sig)).toMatchObject({ kind: 'shieldedSig', refs, network: 'testnet', signature: new Uint8Array(64).fill(255) });
  expect(parseCommand(sig)).toBeNull();
  expect(b64(new Uint8Array(64).fill(255)).length).toBe(86);
});

test('Ender IDs in SEND and PAY: any case or @label in, label.ender.my out; the longest still fit with [Test]', () => {
  const longest = `${'x'.repeat(30)}.ender.my`;
  expect(parseCommand('SEND Harsh.Ender.My, 10 AUSD')).toEqual({ kind: 'send', to: 'harsh.ender.my', amount: '10', deliver: 'AUSD' });
  expect(parseCommand('[Test] send @harsh,10 ausd > ctk')).toEqual({ kind: 'send', to: 'harsh.ender.my', amount: '10', deliver: 'CTK', network: 'testnet' });
  expect(parseShieldedCommand('PAY harsh.ender.my, 2 AUSD')).toEqual({ kind: 'pay', to: 'harsh.ender.my', amount: '2' });
  for (const bad of ['harsh', 'ab.ender.my', 'harsh.ender.eth', 'a.harsh.ender.my', 'support.ender.my', '-harsh.ender.my'])
    expect(parseCommand(`SEND ${bad}, 10 AUSD`)).toBeNull();

  const send = formatCommand({ kind: 'send', to: longest, amount: '999999.999999', deliver: 'CTK' }, 'testnet');
  const pay = formatShieldedCommand({ kind: 'pay', to: longest, amount: '999999.999999' }, 'testnet');
  expect([septets(send), septets(pay)]).toEqual([79, 72]);
  expect(parseCommand(send)).toEqual({ kind: 'send', to: longest, amount: '999999.999999', deliver: 'CTK', network: 'testnet' });
  expect(parseShieldedCommand(pay)).toEqual({ kind: 'pay', to: longest, amount: '999999.999999', network: 'testnet' });

  // The private Sent names the ID it was paid to (never the number behind it).
  const sent: Reply = { kind: 'sent', id: '7F3K', amount: '999999.999999', to: longest, tx: '0xab12...ef', p: 99999999 };
  const text = withRetrieverHash(formatReply({ ...sent, test: true }), 'FA+9qCX9VSu');
  expect(septets(text)).toBe(118);
  expect(parseReply(text)).toEqual({ ...sent, test: true });
});

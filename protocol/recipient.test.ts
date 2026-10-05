import { bech32m } from '@scure/base';
import type { Address } from 'viem';
import { expect, test } from 'bun:test';
import { decodePrivateAddress, encodePrivateAddress, parseRecipient } from './recipient';
import { owner, packAddress, provingKeys, shieldedKeysFromSeed } from './shielded';
import { fitsOneSegment, formatShieldedCommand, parseShieldedCommand, septets } from './sms';

const BYTES = Uint8Array.from({ length: 64 }, (_, i) => i);
const VECTOR = 'ender1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu0cpgc7e7';
const me = owner(provingKeys(shieldedKeysFromSeed(new Uint8Array(32).fill(7))));
const MINE = 'ender1rreg3epk4xpk3zmh7sujagu783a06av4andq2dq8x37ye6z6gfe7r3xyxafcr5ggzcaag53fumarcwpcvmy62nc4lc823ktn46kkq2g7q6dx9';
const ADDR = '0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5';
const addr = ADDR.toLowerCase() as Address;

/** BIP-350 reference checksum, independent of @scure/base. */
const bech32mValid = (s: string) => {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const pos = s.lastIndexOf('1');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]!;
  }
  return chk === 0x2bc830a3;
};

test('private address: bech32m "ender" over the 64 packed bytes', () => {
  expect(encodePrivateAddress(BYTES)).toBe(VECTOR);
  expect(VECTOR.length).toBe(115);
  expect(bech32mValid(VECTOR)).toBe(true);
  expect(encodePrivateAddress(packAddress(me))).toBe(MINE);
  expect(decodePrivateAddress(MINE)).toEqual(packAddress(me));
  expect(decodePrivateAddress(VECTOR.toUpperCase())).toEqual(BYTES); // case-insensitive
  expect(decodePrivateAddress(` ${VECTOR}\n`)).toEqual(BYTES);
  expect(() => encodePrivateAddress(new Uint8Array(32))).toThrow();
});

test('private address: typos, other prefixes and lengths are refused', () => {
  // Every single-character substitution is caught by the checksum.
  for (let i = 6; i < VECTOR.length; i++) {
    const c = VECTOR[i] === 'q' ? 'p' : 'q';
    expect(decodePrivateAddress(VECTOR.slice(0, i) + c + VECTOR.slice(i + 1))).toBeNull();
  }
  expect(decodePrivateAddress(VECTOR.slice(0, -1))).toBeNull(); // truncated
  expect(decodePrivateAddress(VECTOR.slice(0, 20) + VECTOR.slice(21))).toBeNull(); // dropped character
  expect(decodePrivateAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBeNull(); // other HRP (BIP-173 vector)
  // Valid bech32m "ender" strings of the wrong length.
  expect(decodePrivateAddress(bech32m.encode('ender', bech32m.toWords(new Uint8Array(32)), 200))).toBeNull();
  expect(decodePrivateAddress(bech32m.encode('ender', bech32m.toWords(new Uint8Array(65)), 200))).toBeNull();
  expect(decodePrivateAddress(ADDR)).toBeNull();
});

test('parseRecipient: addresses, URIs, numbers, private addresses', () => {
  expect(parseRecipient(ADDR)).toEqual({ kind: 'address', address: addr });
  expect(parseRecipient(addr)).toEqual({ kind: 'address', address: addr });
  expect(parseRecipient(ADDR.replace('7e9B', '7e9b'))).toBeNull(); // mixed case with a bad EIP-55 checksum
  expect(parseRecipient(`ethereum:${ADDR}@143?amount=2.5`)).toEqual({ kind: 'address', address: addr, amount: '2.5' });
  expect(parseRecipient(`ethereum:pay-${ADDR}`)).toEqual({ kind: 'address', address: addr });
  // ERC-20 transfer: the recipient is the address parameter, not the token contract.
  expect(parseRecipient(`ethereum:0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC@10143/transfer?address=${ADDR}&uint256=1e6`)).toEqual({ kind: 'address', address: addr });
  expect(parseRecipient('ethereum:+919876543210')).toBeNull();
  expect(parseRecipient(`ender:+919876543210?amount=10`)).toEqual({ kind: 'phone', phone: '+919876543210', amount: '10' });
  expect(parseRecipient(`ender:${ADDR}?amount=abc`)).toEqual({ kind: 'address', address: addr }); // bad amount dropped
  expect(parseRecipient('98765 43210')).toEqual({ kind: 'phone', phone: '+919876543210' });
  expect(parseRecipient(MINE)).toEqual({ kind: 'private', packed: packAddress(me) });
  expect(parseRecipient(MINE.toUpperCase())).toEqual({ kind: 'private', packed: packAddress(me) });
  expect(parseRecipient(`ender:${MINE}?amount=5`)).toEqual({ kind: 'private', packed: packAddress(me), amount: '5' });
  expect(parseRecipient(MINE.slice(0, -1) + 'q')).toBeNull();
  expect(parseRecipient('hello')).toBeNull();
  expect(parseRecipient('ethereum:0x1234')).toBeNull();
  expect(parseRecipient('ender:%E0%A4%A')).toBeNull();
});

test('PAY to a private address fits one segment and round-trips', () => {
  const pay = formatShieldedCommand({ kind: 'pay', to: MINE, amount: '999999.999999' }, 'mainnet');
  expect(septets(pay)).toBe(139);
  expect(parseShieldedCommand(pay)).toEqual({ kind: 'pay', to: MINE, amount: '999999.999999' });
  // The worst phone text: with `[Test] ` (9 septets), 148.
  const test = formatShieldedCommand({ kind: 'pay', to: MINE, amount: '999999.999999' }, 'testnet');
  expect(septets(test)).toBe(148);
  expect(fitsOneSegment(test)).toBe(true);
  expect(parseShieldedCommand(test)).toEqual({ kind: 'pay', to: MINE, amount: '999999.999999', network: 'testnet' });
  expect(parseShieldedCommand(`pay ${MINE.toUpperCase()},10 ausd`)).toEqual({ kind: 'pay', to: MINE, amount: '10' });
  expect(parseShieldedCommand(`PAY ${MINE.slice(0, -1)}q, 10 AUSD`)).toBeNull();
});

test('parseRecipient: Ender IDs as label.ender.my, @label, the pay page link and in URIs', () => {
  const name = { kind: 'name', label: 'harsh' } as const;
  for (const s of ['harsh.ender.my', 'Harsh.Ender.MY', ' @harsh ', '@HARSH', 'https://harsh.ender.my', 'https://harsh.ender.my/', 'ender:harsh.ender.my', 'ethereum:harsh.ender.my'])
    expect(parseRecipient(s)).toEqual(name);
  expect(parseRecipient('ender:harsh.ender.my?amount=5')).toEqual({ ...name, amount: '5' });
  for (const s of ['harsh', 'ab.ender.my', '@ab', 'harsh.ender.eth', 'a.harsh.ender.my', 'https://harsh.ender.my/pay', 'https://evil.com', 'https://@harsh', '@support', 'har_sh.ender.my'])
    expect(parseRecipient(s)).toBeNull();
});

import { expect, test } from 'bun:test';
import { hkdfSync } from 'node:crypto';
import { parseUnits } from 'viem';
import { buildTx, newUser, owner, packAddress, provingKeys, shieldedKeysFromSeed, unpackAddress, verifySig } from '../../../protocol/shielded';
import { encodePrivateAddress } from '../../../protocol/recipient';
import { b64, formatReply, parseReply, type Reply } from '../../../protocol/sms';
import {
  applyReply,
  checkShieldedQuote,
  chooseRoute,
  privateBalance,
  resync,
  shieldedUser,
  signPrivate,
  type Awaiting,
  type Cache,
  type CachedNote,
} from './private';

const PRF = Uint8Array.from({ length: 32 }, (_, i) => i);
const u = (s: string) => parseUnits(s, 6).toString();
const note = (pos: number, amount: string, spent = false): CachedNote => ({ pos, amount: u(amount), blinding: String(1000 + pos), spent });
const reply = (text: string) => parseReply(text) as Reply;

test('shielded keys: fixed PRF bytes give a fixed owner key, via HKDF "ender/shielded/v1/seed"', () => {
  const user = shieldedUser(PRF);
  const me = owner(provingKeys(user));
  expect(me.ownerKey.toString()).toBe('13479838922502436507094902162721868726956612317206488877066005706655654887925');
  expect(b64(packAddress(me))).toBe('Hc1RhmqNOUumtMght8zTMdchME5Cr4SMnBrDD/kSQfVgsxb7wQkyeP3I0zjljoe7vQIRIWy4aK5oIGNiMGoPIA');
  // Same as an independent HKDF (node:crypto), then the protocol's per-key labels.
  const seed = new Uint8Array(hkdfSync('sha256', PRF, new Uint8Array(), 'ender/shielded/v1/seed', 32));
  expect(owner(provingKeys(shieldedKeysFromSeed(seed))).ownerKey).toBe(me.ownerKey);
  // Not the raw PRF output as the seed (domain-separated), and the PRF bytes are left alone.
  expect(owner(provingKeys(shieldedKeysFromSeed(PRF))).ownerKey).not.toBe(me.ownerKey);
  expect(PRF[31]).toBe(31);
});

const awaitingPay: Awaiting = { id: 'AB23', kind: 'pay', amount: '20', ins: [0, 1], outs: [{ i: 1, amount: u('4.99'), blinding: '77' }], exp: 2e9, phone: '+919800000002', pin: 'KEY' };
const base: Cache = { notes: [note(0, '15'), note(1, '10'), note(2, '0.0005')], awaiting: [awaitingPay], pins: {} };

test('note cache: Sent p= spends the inputs, adds the change at p+1 and pins the recipient', () => {
  const text = formatReply({ kind: 'sent', amount: '20', to: '+919800000002', tx: '0xd340...50', p: 7 });
  const { cache, settled } = applyReply(base, reply(text));
  expect(settled?.id).toBe('AB23');
  expect(cache.awaiting).toEqual([]);
  expect(cache.notes.filter((n) => n.spent).map((n) => n.pos)).toEqual([0, 1]);
  expect(cache.notes.find((n) => n.pos === 8)).toEqual({ pos: 8, amount: u('4.99'), blinding: '77', spent: false });
  expect(cache.pins).toEqual({ '+919800000002': 'KEY' });
  expect(privateBalance(cache.notes)).toBe('4.99'); // 0.0005 doesn't count
});

test('note cache: Sent without p= (a change-less withdrawal) only spends', () => {
  const w: Awaiting = { id: 'CD45', kind: 'withdraw', amount: '10', ins: [1], outs: [], exp: 2e9 };
  const { cache } = applyReply({ ...base, awaiting: [w] }, reply('Sent 10 AUSD to 0x1234...abcd. Tx 0xd340...50'));
  expect(cache.notes.map((n) => n.spent)).toEqual([false, true, false]);
  expect(cache.notes.length).toBe(3);
});

test('note cache: Sent for an amount nothing waits on (a public send) changes nothing', () => {
  const { cache, settled } = applyReply(base, reply('Sent 3 AUSD to +919800000002. Tx 0xd340...50'));
  expect(settled).toBeUndefined();
  expect(cache).toBe(base);
});

test('note cache: Shielded p= adds the deposit; Got adds a received note once', () => {
  const sh: Awaiting = { id: 'EF67', kind: 'shield', amount: '50', ins: [], outs: [{ i: 0, amount: u('50'), blinding: '99' }], exp: 2e9 };
  const a = applyReply({ notes: [], awaiting: [sh, awaitingPay], pins: {} }, reply('Shielded 50 AUSD. Tx 0x36e2...df p=4'));
  expect(a.settled?.id).toBe('EF67');
  expect(a.cache.notes).toEqual([{ pos: 4, amount: u('50'), blinding: '99', spent: false }]);
  expect(a.cache.awaiting.map((x) => x.id)).toEqual(['AB23']);

  const got = formatReply({ kind: 'got', amount: '20', p: 9, blinding: 123456789n });
  const b = applyReply(a.cache, reply(got));
  expect(b.cache.notes.at(-1)).toEqual({ pos: 9, amount: u('20'), blinding: '123456789', spent: false });
  expect(applyReply(b.cache, reply(got)).cache.notes.length).toBe(2);
});

test('note cache: online resync replaces notes, settles payments whose inputs are spent, expires stale ones', () => {
  const stale: Awaiting = { ...awaitingPay, id: 'GH89', ins: [2], exp: 1 };
  const r = resync({ ...base, awaiting: [awaitingPay, stale] }, [note(0, '15', true), note(1, '10', true), note(2, '0.0005'), note(8, '4.99')]);
  expect(r.settled.map((a) => a.id)).toEqual(['AB23']);
  expect(r.expired.map((a) => a.id)).toEqual(['GH89']);
  expect(r.cache.awaiting).toEqual([]);
  expect(r.cache.pins['+919800000002']).toBe('KEY');
});

test('review decision: private only when the recipient can take it and the notes alone pay amount + fee', () => {
  const cache = { notes: [note(0, '15'), note(1, '10')], awaiting: [] };
  expect(chooseRoute({ recipientPrivate: true, cache, amount: '20' })).toBe('private');
  expect(chooseRoute({ recipientPrivate: true, cache, amount: '25' })).toBe('public'); // 25 + 0.01 fee > 25
  expect(chooseRoute({ recipientPrivate: false, cache, amount: '1' })).toBe('public'); // number with no shielded address
  expect(chooseRoute({ recipientPrivate: true, cache, amount: '1', deliver: 'CTK' })).toBe('public');
  expect(chooseRoute({ recipientPrivate: true, cache: { ...cache, awaiting: [awaitingPay] }, amount: '1' })).toBe('public'); // notes held by a pending payment
  // 13 notes of 1 whose 12 largest can't pay 12.5: MERGE, so public.
  const many = { notes: Array.from({ length: 13 }, (_, i) => note(i, '1')), awaiting: [] };
  expect(chooseRoute({ recipientPrivate: true, cache: many, amount: '12.5' })).toBe('public');
  expect(chooseRoute({ recipientPrivate: true, cache: many, amount: '11' })).toBe('private');
});

test('quote checks: expired, fee too high, key changed, wrong withdrawal address, deposit with a recipient', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  const addr = new Uint8Array(64).fill(7);
  const pay = { kind: 'pay' as const, amount: '20', to: '+919800000002', phone: '+919800000002' };
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t + 300, fee: '0.01', to: addr }, undefined, now)).toBeUndefined();
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t + 300, fee: '0.01', to: addr }, b64(addr), now)).toBeUndefined();
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t - 1, fee: '0.01', to: addr }, undefined, now)?.code).toBe('expired');
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t + 7200, fee: '0.01', to: addr }, undefined, now)?.code).toBe('bad-quote');
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t + 300, fee: '0.02', to: addr }, undefined, now)?.code).toBe('fee-too-high');
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t + 300, fee: '0.01', to: addr }, b64(new Uint8Array(64).fill(8)), now)?.code).toBe('KEY CHANGED');
  expect(checkShieldedQuote(pay, { id: 'AB23', exp: t + 300, fee: '0.01', to: '0x00000000000000000000000000000000000000aa' }, undefined, now)?.code).toBe('recipient-mismatch');

  const withdraw = { kind: 'withdraw' as const, amount: '5', to: '0x00000000000000000000000000000000000000AA' };
  expect(checkShieldedQuote(withdraw, { id: 'AB23', exp: t + 300, fee: '0.01', to: '0x00000000000000000000000000000000000000aa' }, undefined, now)).toBeUndefined();
  expect(checkShieldedQuote(withdraw, { id: 'AB23', exp: t + 300, fee: '0.01', to: '0x00000000000000000000000000000000000000bb' }, undefined, now)?.code).toBe('recipient-mismatch');

  // To a private address: the quote must carry exactly that key.
  const toAddr = { kind: 'pay' as const, amount: '20', to: encodePrivateAddress(addr) };
  expect(checkShieldedQuote(toAddr, { id: 'AB23', exp: t + 300, fee: '0.01', to: addr }, undefined, now)).toBeUndefined();
  expect(checkShieldedQuote(toAddr, { id: 'AB23', exp: t + 300, fee: '0.01', to: new Uint8Array(64).fill(8) }, undefined, now)?.code).toBe('recipient-mismatch');
  expect(checkShieldedQuote(toAddr, { id: 'AB23', exp: t + 300, fee: '0.01' }, undefined, now)?.code).toBe('recipient-mismatch');

  const shield = { kind: 'shield' as const, amount: '50' };
  expect(checkShieldedQuote(shield, { id: 'AB23', exp: t + 300, fee: '0.01' }, undefined, now)).toBeUndefined();
  expect(checkShieldedQuote(shield, { id: 'AB23', exp: t + 300, fee: '0.01', to: addr }, undefined, now)?.code).toBe('recipient-mismatch');
});

test('signPrivate: 12-in payment the gateway can rebuild; signature verifies; change held for p+1', () => {
  const user = shieldedUser(PRF);
  const me = owner(provingKeys(user));
  const bob = owner(provingKeys(newUser()));
  const notes = Array.from({ length: 14 }, (_, i) => note(i, '1'));
  const q = { id: 'AB23', exp: Math.floor(Date.now() / 1000) + 600, fee: '0.01', to: packAddress(bob) };
  const t0 = performance.now();
  const r = signPrivate(user, { notes, awaiting: [] }, { kind: 'pay', amount: '11.5', phone: '+919800000002' }, q, 'testnet', () => 0);
  const ms = performance.now() - t0;
  if ('err' in r) throw new Error(r.err);
  console.log(`12-in pay: pick + buildTx + sign ${ms.toFixed(0)} ms (${typeof Bun === 'undefined' ? 'node' : 'bun'})`);
  expect(r.refs.length).toBe(12);
  expect(r.awaiting.outs).toEqual([{ i: 1, amount: u('0.49'), blinding: expect.any(String) }]);
  // What the gateway does with the refs: rebuild and check the signature.
  const tx = buildTx({
    me: owner(provingKeys(user)),
    nIns: 12,
    inputs: r.refs.map((pos) => ({ pos, amount: parseUnits('1', 6), blinding: BigInt(1000 + pos) })),
    outputs: [{ amount: parseUnits('11.5', 6), to: unpackAddress(packAddress(bob)) }, { amount: parseUnits('0.49', 6), to: me }],
    fee: parseUnits('0.01', 6),
    relayer: '0x458E8F51EC2B833209b5C71372376eeb1e40af08',
    deadline: q.exp,
    domain: { chainId: 10143, pool: '0xbe34bb676ba6d40098e8aaa36b4599400c9810ff' },
  });
  expect(verifySig(r.sig, tx.msg, provingKeys(user))).toBe(true);
});

import { expect, test } from 'bun:test';
import { hkdfSync } from 'node:crypto';
import { parseUnits } from 'viem';
import { buildTx, newUser, owner, packAddress, provingKeys, shieldedKeysFromSeed, unpackAddress, verifySig } from '../../../protocol/shielded';
import { encodePrivateAddress } from '../../../protocol/recipient';
import { selectMerge } from '../../../protocol/select';
import { b64, formatReply, parseReply, type Reply } from '../../../protocol/sms';
import type { Tx } from './store';
import {
  applyReply,
  AUTO_SHIELD_MIN,
  autoShieldOn,
  canMerge,
  checkShieldedQuote,
  chooseRoute,
  fileReply,
  privateBalance,
  resync,
  shieldAmount,
  shieldedUser,
  shouldAutoMerge,
  shouldAutoShield,
  signPrivate,
  textNetwork,
  txLinks,
  withdrawRoute,
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

test('note cache: Shielded p= adds the deposit; a private Received (or an older Got) adds the note once', () => {
  const sh: Awaiting = { id: 'EF67', kind: 'shield', amount: '50', ins: [], outs: [{ i: 0, amount: u('50'), blinding: '99' }], exp: 2e9 };
  const a = applyReply({ notes: [], awaiting: [sh, awaitingPay], pins: {} }, reply('Shielded 50 AUSD. Tx 0x36e2...df p=4'));
  expect(a.settled?.id).toBe('EF67');
  expect(a.cache.notes).toEqual([{ pos: 4, amount: u('50'), blinding: '99', spent: false }]);
  expect(a.cache.awaiting.map((x) => x.id)).toEqual(['AB23']);

  const got = formatReply({ kind: 'received', amount: '20', from: 'ravi1.ender.my', tx: '0xab12...ef', p: 9, blinding: 123456789n });
  const b = applyReply(a.cache, reply(got));
  expect(b.cache.notes.at(-1)).toEqual({ pos: 9, amount: u('20'), blinding: '123456789', spent: false });
  expect(applyReply(b.cache, reply(got)).cache.notes.length).toBe(2);
  const legacy = `Got 20 AUSD (private) p=9 b=${got.split(' b=')[1]}`;
  expect(applyReply(a.cache, reply(legacy)).cache).toEqual(b.cache);
  // A public Received is no note.
  expect(applyReply(a.cache, reply('Received 10 AUSD from=ravi1.ender.my balance=5 tx=0xab12...ef')).cache).toBe(a.cache);
});

test('rows from texts get the full hash from a resync: the note at their position or the next', () => {
  const rows: Tx[] = [
    { id: 'got:testnet:9', network: 'testnet', direction: 'in', amount: '20', private: true, status: 'sent', at: 1, pos: 9, shortTx: '0xab12...ef' },
    { id: 'MRG1', network: 'testnet', direction: 'out', amount: '0', private: true, status: 'sent', at: 1, pos: 4 },
    { id: 'DONE', network: 'testnet', direction: 'out', amount: '1', private: true, status: 'sent', at: 1, pos: 9, txHash: '0x01' },
    { id: 'PUB1', network: 'testnet', direction: 'out', amount: '1', status: 'sent', at: 1, pos: 9 },
    { id: 'MAIN', network: 'mainnet', direction: 'in', amount: '1', private: true, status: 'sent', at: 1, pos: 9 },
  ];
  const notes: CachedNote[] = [{ ...note(5, '1'), tx: '0xbb' }, { ...note(9, '20'), tx: '0xaa' }, note(12, '1')];
  expect(txLinks(rows, 'testnet', notes)).toEqual([
    { id: 'got:testnet:9', txHash: '0xaa' },
    { id: 'MRG1', txHash: '0xbb' }, // a merge's own note is its change, at p + 1
  ]);
  expect(txLinks(rows, 'testnet', [note(9, '20')])).toEqual([]); // an older gateway: no tx
});

test('note cache: Sent / Shielded settle the payment with their id, never another of the same amount', () => {
  const second: Awaiting = { ...awaitingPay, id: 'XY23', ins: [2], outs: [] };
  const c = { ...base, awaiting: [awaitingPay, second] };
  const text = formatReply({ kind: 'sent', id: 'XY23', amount: '20', to: '+919800000002', tx: '0xd340...50', p: 7 });
  expect(applyReply(c, reply(text)).settled?.id).toBe('XY23');
  // A public Sent of the same amount (its own id) settles nothing.
  expect(applyReply(c, reply('Sent 7F3K 20 AUSD to 0x1234...cd. Tx 0xd340...50')).settled).toBeUndefined();
  const sh: Awaiting = { id: 'EF67', kind: 'shield', amount: '50', ins: [], outs: [{ i: 0, amount: u('50'), blinding: '99' }], exp: 2e9 };
  expect(applyReply({ ...c, awaiting: [sh] }, reply('Shielded 7F3K 50 AUSD. Tx 0x36e2...df p=4')).settled).toBeUndefined();
  expect(applyReply({ ...c, awaiting: [sh] }, reply('Shielded EF67 50 AUSD. Tx 0x36e2...df p=4')).settled?.id).toBe('EF67');
});

test('texts are filed under the network they name, not the one the app shows', () => {
  const state = { network: 'mainnet' as const, notes: {}, awaiting: {}, shieldedPins: {}, shielded: { owner: 'x', registered: ['testnet' as const] } };
  const got = formatReply({ kind: 'received', amount: '20', tx: '0xab12...ef', p: 9, blinding: 5n, test: true });
  const filed = fileReply(state, reply(got));
  expect(filed?.network).toBe('testnet');
  expect(filed?.patch.notes).toEqual({ testnet: [{ pos: 9, amount: u('20'), blinding: '5', spent: false }] });
  // An older gateway's untagged private text: mainnet has no pool, so the network that has one.
  expect(fileReply(state, reply(got.replace('[Test] ', '')))?.network).toBe('testnet');
  // A Sent settles the testnet payment while mainnet is shown.
  const sent = formatReply({ kind: 'sent', id: 'AB23', amount: '20', to: '+919800000002', tx: '0xd340...50', p: 7, test: true });
  const s2 = { ...state, notes: { testnet: base.notes }, awaiting: { testnet: [awaitingPay] } };
  expect(fileReply(s2, reply(sent))?.settled?.id).toBe('AB23');
  expect(fileReply(s2, reply(sent))?.patch.awaiting).toEqual({ testnet: [] });
  // Not registered there: nothing to file.
  expect(fileReply({ ...state, shielded: undefined }, reply(got))).toBeUndefined();
  // What Review compares with its payment's network: the tag; an untagged private-only text means the pool's network.
  expect(textNetwork(reply('[Test] Q 7F3K exp=1791200000 fee=0.01'))).toBe('testnet');
  expect(textNetwork(reply('Q 7F3K exp=1791200000 fee=0.01'))).toBe('testnet');
  expect(textNetwork(reply('ERR 7F3K expired'))).toBe('mainnet');
  expect(textNetwork(reply('[Test] ERR 7F3K expired'))).toBe('testnet');
  expect(textNetwork(reply(got.replace('[Test] ', '')))).toBe('testnet'); // a private Received
  expect(textNetwork(reply('Received 10 AUSD from=ravi1.ender.my balance=5 tx=0xab12...ef'))).toBe('mainnet'); // a public one
});

test('Merge pill: more than 12 usable notes, on a network with a pool', () => {
  const notes = (n: number) => Array.from({ length: n }, (_, i) => note(i, '1'));
  expect(canMerge('testnet', { notes: notes(12), awaiting: [] })).toBe(false);
  expect(canMerge('testnet', { notes: notes(13), awaiting: [] })).toBe(true);
  expect(canMerge('mainnet', { notes: notes(13), awaiting: [] })).toBe(false);
  expect(canMerge('testnet', { notes: [...notes(12), note(20, '0.0005')], awaiting: [] })).toBe(false); // dust doesn't count
  expect(canMerge('testnet', { notes: notes(13), awaiting: [{ ...awaitingPay, ins: [0] }] })).toBe(false); // held by a payment
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

test('signPrivate: a merge is 12 notes in, 0 to ourselves and one note back, as the gateway rebuilds it', () => {
  const user = shieldedUser(PRF);
  const me = owner(provingKeys(user));
  const notes = Array.from({ length: 14 }, (_, i) => note(i, '1'));
  const q = { id: 'MG23', exp: Math.floor(Date.now() / 1000) + 600, fee: '0.01' };
  const merge = { kind: 'merge' as const, amount: '0' };
  expect(checkShieldedQuote(merge, q)).toBeUndefined();
  expect(checkShieldedQuote(merge, { ...q, to: new Uint8Array(64) })?.code).toBe('recipient-mismatch');
  const r = signPrivate(user, { notes, awaiting: [] }, merge, q, 'testnet', () => 0);
  if ('err' in r) throw new Error(r.err);
  expect(r.refs.length).toBe(12);
  expect(r.awaiting).toMatchObject({ id: 'MG23', kind: 'merge', amount: '0', ins: r.refs });
  expect(r.awaiting.outs).toEqual([{ i: 1, amount: u('11.99'), blinding: expect.any(String) }]);
  // The gateway's merge build (shielded.ts transfer): outputs [0 to the sender, change].
  const tx = buildTx({
    me,
    nIns: 12,
    inputs: r.refs.map((pos) => ({ pos, amount: parseUnits('1', 6), blinding: BigInt(1000 + pos) })),
    outputs: [{ amount: 0n, to: me }, { amount: parseUnits('11.99', 6), to: me }],
    fee: parseUnits('0.01', 6),
    relayer: '0x458E8F51EC2B833209b5C71372376eeb1e40af08',
    deadline: q.exp,
    domain: { chainId: 10143, pool: '0xbe34bb676ba6d40098e8aaa36b4599400c9810ff' },
  });
  expect(verifySig(r.sig, tx.msg, provingKeys(user))).toBe(true);
});

test('selectMerge: the 12 largest notes, ties by tree position, in position order', () => {
  // Amounts 0..14 at shuffled positions, plus a second 13 and a second 3.
  const notes = [9, 3, 14, 0, 7, 12, 5, 1, 10, 2, 13, 6, 11, 4, 8].map((amount, pos) => ({ pos, amount: BigInt(amount) * 1_000_000n }));
  const tied = [...notes, { pos: 15, amount: 13_000_000n }, { pos: 16, amount: 3_000_000n }];
  const r = selectMerge(tied, 10_000n);
  if (r.err) throw new Error(r.err);
  expect(r.circuit).toBe(12);
  // Largest first: 14, 13 (pos 10), 13 (pos 15), 12, 11, 10, 9, 8, 7, 6, 5, 4; the 3s, 2, 1 and 0 are left.
  expect(r.ins.map((n) => Number(n.amount / 1_000_000n))).toEqual([9, 14, 7, 12, 5, 10, 13, 6, 11, 4, 8, 13]);
  expect(r.ins.map((n) => n.pos)).toEqual([0, 2, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15]);
  // Ties at the cut: the lower position wins.
  const flat = Array.from({ length: 14 }, (_, i) => ({ pos: 20 - i, amount: 5_000_000n }));
  expect((selectMerge(flat, 10_000n) as { ins: { pos: number }[] }).ins.map((n) => n.pos)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  // Fewer notes: all of them, smallest circuit that holds them; nothing to pay the fee with is FUNDS.
  expect(selectMerge(notes.slice(0, 5), 10_000n)).toMatchObject({ circuit: 6 });
  expect(selectMerge([], 10_000n)).toEqual({ err: 'FUNDS' });
  expect(selectMerge([{ pos: 0, amount: 5_000n }], 10_000n)).toEqual({ err: 'FUNDS' });
});

test('signPrivate: a merge spends the 12 largest notes, not a random fill', () => {
  const user = shieldedUser(PRF);
  const notes = Array.from({ length: 20 }, (_, i) => note(i, String(i + 1)));
  const q = { id: 'MG24', exp: Math.floor(Date.now() / 1000) + 600, fee: '0.01' };
  for (const rng of [() => 0, (k: number) => k - 1]) {
    const r = signPrivate(user, { notes, awaiting: [] }, { kind: 'merge', amount: '0' }, q, 'testnet', rng);
    if ('err' in r) throw new Error(r.err);
    expect(r.refs).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(r.awaiting.outs[0]!.amount).toBe(u(String(9 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 - 0.01)));
  }
});

test('auto-merge: only when on, online, unlocked, registered, nothing pending and more than 12 notes', () => {
  const many = { notes: Array.from({ length: 13 }, (_, i) => note(i, '1')), awaiting: [] };
  const go = { on: true, online: true, unlocked: true, registered: true, network: 'testnet' as const, cache: many };
  expect(shouldAutoMerge(go)).toBe(true);
  expect(shouldAutoMerge({ ...go, on: false })).toBe(false);
  expect(shouldAutoMerge({ ...go, online: false })).toBe(false);
  expect(shouldAutoMerge({ ...go, unlocked: false })).toBe(false);
  expect(shouldAutoMerge({ ...go, registered: false })).toBe(false);
  expect(shouldAutoMerge({ ...go, network: 'mainnet' })).toBe(false); // no pool
  expect(shouldAutoMerge({ ...go, cache: { ...many, notes: many.notes.slice(0, 12) } })).toBe(false); // 12 fit one payment
  // A merge (or any payment) still waiting: its notes are held, and another merge would race it.
  const mergeWaiting: Awaiting = { id: 'MG23', kind: 'merge', amount: '0', ins: [], outs: [], exp: 2e9 };
  expect(shouldAutoMerge({ ...go, cache: { ...many, awaiting: [mergeWaiting] } })).toBe(false);
  expect(shouldAutoMerge({ ...go, cache: { notes: [...many.notes, note(20, '1')], awaiting: [{ ...awaitingPay, ins: [20] }] } })).toBe(false);
  // Spent and dust notes don't count towards the 13.
  expect(shouldAutoMerge({ ...go, cache: { ...many, notes: [...many.notes.slice(0, 12), note(12, '1', true), note(13, '0.0005')] } })).toBe(false);
});

test('auto-shield: on unless turned off; installs from before it (no value) read as on', () => {
  expect(autoShieldOn({})).toBe(true);
  expect(autoShieldOn({ autoShield: undefined })).toBe(true);
  expect(autoShieldOn({ autoShield: true })).toBe(true);
  expect(autoShieldOn({ autoShield: false })).toBe(false);
});

test('auto-shield: only when on, online, unlocked, registered, nothing pending, no public send in flight and at least 1 AUSD public', () => {
  const go = { on: true, online: true, unlocked: true, registered: true, network: 'testnet' as const, cache: { awaiting: [] }, publicBalance: '1', busy: false };
  expect(AUTO_SHIELD_MIN).toBe('1');
  expect(shouldAutoShield(go)).toBe(true);
  expect(shouldAutoShield({ ...go, publicBalance: '250.5' })).toBe(true);
  expect(shouldAutoShield({ ...go, publicBalance: '0.999999' })).toBe(false);
  expect(shouldAutoShield({ ...go, publicBalance: '0' })).toBe(false);
  expect(shouldAutoShield({ ...go, on: false })).toBe(false);
  expect(shouldAutoShield({ ...go, online: false })).toBe(false);
  expect(shouldAutoShield({ ...go, unlocked: false })).toBe(false);
  expect(shouldAutoShield({ ...go, registered: false })).toBe(false);
  expect(shouldAutoShield({ ...go, busy: true })).toBe(false); // a public payment still sending
  // A shield, merge or payment still waiting: never two at once.
  expect(shouldAutoShield({ ...go, cache: { awaiting: [awaitingPay] } })).toBe(false);
});

test('auto-shield: a no-op on mainnet (no pool, so never registered there)', () => {
  const go = { on: true, online: true, unlocked: true, network: 'mainnet' as const, cache: { awaiting: [] }, publicBalance: '500', busy: false };
  expect(shouldAutoShield({ ...go, registered: false })).toBe(false);
  // Even a state that claims mainnet is registered: no pool, no shield.
  expect(shouldAutoShield({ ...go, registered: true })).toBe(false);
});

test('auto-shield amount: the whole public balance less the fee, so deposit + fee is all of it', () => {
  expect(shieldAmount('25', '0.01')).toBe('24.99');
  expect(shieldAmount('1', '0.01')).toBe('0.99');
  expect(shieldAmount('3.123456', '0.01')).toBe('3.113456');
  const amount = shieldAmount('7.5', '0.01');
  expect(parseUnits(amount, 6) + parseUnits('0.01', 6)).toBe(parseUnits('7.5', 6));
  // What the gateway takes: at most 6 decimals.
  expect(amount).toMatch(/^\d+(\.\d{1,6})?$/);
});

test('review decision: a number or Ender ID with no shielded address is paid by a private withdrawal to its wallet', () => {
  const cache = { notes: [note(0, '15'), note(1, '10')], awaiting: [] };
  const wallet = '0x00000000000000000000000000000000000b0b0b' as const;
  expect(withdrawRoute({ wallet, cache, amount: '20' })).toEqual({ route: 'private', withdrawTo: wallet });
  // The notes can't cover amount + fee: public, from the public balance.
  expect(withdrawRoute({ wallet, cache, amount: '25' })).toEqual({ route: 'public' });
  const many = { notes: Array.from({ length: 13 }, (_, i) => note(i, '1')), awaiting: [] };
  expect(withdrawRoute({ wallet, cache: many, amount: '12.5' })).toEqual({ route: 'public' }); // MERGE
  // No wallet (not on Ender, or the lookup failed): public.
  expect(withdrawRoute({ cache, amount: '1' })).toEqual({ route: 'public' });
  // The wallet pinned for them: fine in any case; a different one goes public, where Review flags the change.
  expect(withdrawRoute({ wallet, pinned: '0x00000000000000000000000000000000000B0B0B', cache, amount: '1' })).toEqual({ route: 'private', withdrawTo: wallet });
  expect(withdrawRoute({ wallet, pinned: '0x000000000000000000000000000000000000dead', cache, amount: '1' })).toEqual({ route: 'public' });
});

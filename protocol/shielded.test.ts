/**
 * Compatibility of the TS port with the split-key spike (spikes/nova-splitkey/src/*.mjs, run as-is):
 * every value the phone and the gateway must agree on is computed by both and compared. The TS side
 * runs with WebAssembly removed (as on Hermes); the spike needs it (circomlibjs).
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashTypedData, hexToBytes, keccak256, stringToBytes, type Address } from 'viem';

type Any = any;
const SPIKE = '../spikes/nova-splitkey';
const load = (path: string): Promise<Any> => import(`${SPIKE}/${path}`);

// The spike (WebAssembly on).
const S = await load('src/shielded.mjs');
const SS = await load('src/select.mjs');
const SM = await load('src/sms.mjs');
const { poseidonHash2, ZERO_VALUE: SPIKE_ZERO } = await load('src/utils.mjs');
const { MerkleTree } = await load('node_modules/fixed-merkle-tree/lib/index.js');

// The port, loaded and run with WebAssembly removed.
const g = globalThis as Any;
const noWasm = <T>(f: () => T): T => {
  const wasm = g.WebAssembly;
  g.WebAssembly = undefined;
  try {
    return f();
  } finally {
    g.WebAssembly = wasm;
  }
};
const wasm = g.WebAssembly;
g.WebAssembly = undefined;
const T = await import('./shielded');
const TS = await import('./select');
const TM = await import('./sms');
expect(typeof WebAssembly).toBe('undefined');
g.WebAssembly = wasm;

/** Buffers and Uint8Arrays as hex, recursively, so spike and port values compare structurally. */
const norm = (x: Any): Any => {
  if (x instanceof Uint8Array) return `bytes:${Buffer.from(x).toString('hex')}`;
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, norm(v)]));
  return x;
};
const same = (a: Any, b: Any) => expect(norm(a)).toEqual(norm(b));

function seeded(seed: number) {
  // mulberry32, as spikes/nova-splitkey/scripts/select-test.mjs
  return (k: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k);
  };
}
const rand = seeded(1);
const randBig = (bytes: number) => BigInt('0x' + Array.from({ length: bytes }, () => rand(256).toString(16).padStart(2, '0')).join(''));
const randBytes = (n: number) => Uint8Array.from({ length: n }, () => rand(256));

const bytes = (label: string) => hexToBytes(keccak256(stringToBytes(label)));
const users = Array.from({ length: 5 }, (_, i) => ({
  authSk: bytes(`user ${i} auth`),
  nk: BigInt(keccak256(stringToBytes(`user ${i} nk`))) >> 8n,
  viewSk: bytes(`user ${i} view`),
}));
const domain = { chainId: 10143, pool: '0xbe34bb676ba6d40098e8aaa36b4599400c9810ff' as Address };
const relayer = '0x458E8F51EC2B833209b5C71372376eeb1e40af08' as Address;
const ausd = { address: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC' as Address, name: 'Agora Dollar', version: '1' };

const spikeOwners = users.map((u) => S.owner(S.provingKeys(u)));
const tsOwners = noWasm(() => users.map((u) => T.owner(T.provingKeys(u))));
const counts: Record<string, number> = {};
const count = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

test('keys, addresses, constants', () => {
  for (let i = 0; i < users.length; i++) {
    same(tsOwners[i], spikeOwners[i]);
    const addr = noWasm(() => T.packAddress(tsOwners[i]!));
    same(addr, S.packAddress(spikeOwners[i]));
    same(noWasm(() => T.unpackAddress(addr)), S.unpackAddress(S.packAddress(spikeOwners[i])));
    count('owner keys + packed addresses');
  }
  expect(T.NULL_COMMITMENT).toBe(S.NULL_COMMITMENT);
  expect(T.ZERO_VALUE).toBe(SPIKE_ZERO);
  expect(T.LEVELS).toBe(S.LEVELS);
  expect(TS.MIN_NOTE).toBe(SS.MIN_NOTE);
  expect(TS.CIRCUITS).toEqual(SS.CIRCUITS);
  expect(TM.REF_MOD).toBe(SM.REF_MOD);
});

test('shieldedKeysFromSeed: deterministic, domain-separated, spike-compatible', () => {
  const seed = bytes('ender test seed');
  const u = noWasm(() => T.shieldedKeysFromSeed(seed));
  same(noWasm(() => T.shieldedKeysFromSeed(seed)), u);
  expect(u.nk < 1n << 248n).toBe(true);
  expect(new Set([u.authSk, u.viewSk].map((b) => Buffer.from(b).toString('hex'))).size).toBe(2);
  same(noWasm(() => T.owner(T.provingKeys(u))), S.owner(S.provingKeys(u)));
  // Pinned: changing the derivation would strand every note made under it.
  expect(noWasm(() => T.owner(T.provingKeys(u))).ownerKey.toString(16)).toBe(PINNED_OWNER_KEY);
  expect(() => T.shieldedKeysFromSeed(new Uint8Array(16))).toThrow();
});
const PINNED_OWNER_KEY = '1234006195d205a33f5904ac4421b9bc9b9ab07107ad29dea1295721f54e8bc3';

test('commitments, nullifiers, note encryption', () => {
  for (let i = 0; i < 40; i++) {
    const o = tsOwners[i % users.length]!;
    const amount = randBig(rand(2) ? 4 : 31);
    const blinding = randBig(32) % T.FIELD_SIZE;
    const pos = rand(1 << 20);
    const c = noWasm(() => T.commitment(amount, o.ownerKey, blinding));
    expect(c).toBe(S.commitment(amount, o.ownerKey, blinding));
    expect(noWasm(() => T.nullifier(o.nk, c, pos))).toBe(S.nullifier(o.nk, c, pos));
    const sender = users[(i + 1) % users.length]!.nk;
    const ct = noWasm(() => T.encryptNote({ amount, blinding, commitment: c }, o.encPk, sender));
    expect(ct).toBe(S.encryptNote({ amount, blinding, commitment: c }, Buffer.from(o.encPk), sender));
    same(noWasm(() => T.decryptNote(ct, o.viewSk)), { amount, blinding });
    same(S.decryptNote(ct, Buffer.from(o.viewSk)), { amount, blinding });
    expect(noWasm(() => T.decryptNote(ct, tsOwners[(i + 1) % users.length]!.viewSk))).toBeNull();
    count('commitments + nullifiers + ciphertexts');
  }
  expect(T.decryptNote('0x1234', tsOwners[0]!.viewSk)).toBeNull();
});

/** One payment as phone and gateway build it: spike tx vs port tx, field by field. */
const txCases: Any[] = [];
for (const nIns of [2, 6, 12]) {
  for (const real of [1, 2, nIns]) {
    for (const kind of ['transfer', 'withdraw', 'withdraw-all', 'merge']) {
      const me = rand(users.length);
      const inputs = Array.from({ length: real }, () => ({ amount: randBig(4) + 1000n, blinding: randBig(32) % T.FIELD_SIZE, pos: rand(500) }));
      const total = inputs.reduce((s, n) => s + n.amount, 0n);
      const fee = 10000n;
      const amount = kind === 'withdraw-all' || kind === 'merge' ? total - fee : total / 3n;
      txCases.push({ nIns, real, kind, me, inputs, fee, amount, deadline: 1790000000 + rand(1000) });
    }
  }
}
const build = (impl: Any, owners: Any[], c: Any) => {
  const me = owners[c.me];
  const to = owners[(c.me + 1) % owners.length];
  const change = { amount: c.inputs.reduce((s: bigint, n: Any) => s + n.amount, 0n) - c.amount - c.fee, to: me };
  const common = { me, nIns: c.nIns, inputs: c.inputs, fee: c.fee, relayer, deadline: c.deadline, domain };
  if (c.kind.startsWith('withdraw'))
    return impl.buildTx({ ...common, outputs: impl.withdrawOutputs(change), extAmount: -c.amount, recipient: '0x00000000000000000000000000000000000000aa' });
  const recipient = c.kind === 'merge' ? me : impl.unpackAddress(impl.packAddress(to));
  return impl.buildTx({ ...common, outputs: [{ amount: c.amount, to: recipient }, change] });
};

test('buildTx: nullifiers, blindings, outputs, ciphertexts, extDataHash, signed message, signatures', () => {
  for (const c of txCases) {
    const spike = build(S, spikeOwners, c);
    const port = noWasm(() => build(T, tsOwners, c));
    same(port, spike);
    if (c.kind === 'withdraw-all') expect(port.outs.map((o: Any) => o.commitment)).toEqual([T.NULL_COMMITMENT, T.NULL_COMMITMENT]);

    const sk = users[c.me]!.authSk;
    const sig = noWasm(() => T.sign(sk, port.msg));
    const spikeSig = S.sign(sk, spike.msg);
    same(sig, spikeSig);
    expect(noWasm(() => T.verifySig(spikeSig, port.msg, tsOwners[c.me]!))).toBe(true);
    expect(S.verifySig(Buffer.from(sig), spike.msg, spikeOwners[c.me])).toBe(true);
    const other = tsOwners[(c.me + 1) % users.length]!;
    expect(noWasm(() => T.verifySig(sig, port.msg, other))).toBe(false);
    expect(noWasm(() => T.verifySig(sig, port.msg + 1n, tsOwners[c.me]!))).toBe(false);
    expect(S.verifySig(Buffer.from(sig), spike.msg + 1n, spikeOwners[c.me])).toBe(false);
    count('transactions');
    count('signatures (equal bytes, cross-verified)');
  }
  expect(() => T.buildTx({ me: tsOwners[0]!, nIns: 3, inputs: [], outputs: [], deadline: 0, domain })).toThrow();
  expect(() =>
    T.buildTx({ me: tsOwners[0]!, inputs: [], outputs: [{ amount: 1n, to: T.NULL_OWNER }, { amount: 0n, to: T.NULL_OWNER }], deadline: 0, domain }),
  ).toThrow();
}, 120_000);

test('deposits: buildDeposit, nonce, depositTx, quoteSeed, receiveAuth', () => {
  const gwUser = { authSk: bytes('gw auth'), nk: 12345n, viewSk: bytes('gw view') };
  const gwSpike = S.owner(S.provingKeys(gwUser));
  const gwPort = noWasm(() => T.owner(T.provingKeys(gwUser)));
  for (let i = 0; i < 10; i++) {
    const id = Array.from({ length: 4 }, () => TM.SESSION_ID_ALPHABET[rand(TM.SESSION_ID_ALPHABET.length)]).join('');
    const exp = 1790000000 + rand(100000);
    const seed = noWasm(() => T.quoteSeed(id, exp));
    expect(seed).toBe(S.quoteSeed(id, exp));
    const amount = randBig(4) + 1n;
    const args = (owners: Any[]) => ({
      me: owners[i % users.length],
      outputs: [{ amount, to: owners[i % users.length] }, { amount: 0n, to: owners[i % users.length] }],
      fee: 10000n,
      relayer,
      deadline: exp,
      seed,
      domain,
    });
    const spike = S.buildDeposit(args(spikeOwners));
    const port = noWasm(() => T.buildDeposit(args(tsOwners)));
    same(port, spike);
    const nIns = [2, 6, 12][i % 3];
    const spikeTx = S.depositTx(gwSpike, spike, nIns);
    same(noWasm(() => T.depositTx(gwPort, port, nIns, spikeTx.ins[0].blinding)), spikeTx);
    same(noWasm(() => T.sign(gwUser.authSk, spikeTx.msg)), S.sign(gwUser.authSk, spikeTx.msg));

    const from = '0x00000000000000000000000000000000000000bb' as Address;
    const authArgs = { from, to: domain.pool, value: port.value, validBefore: exp, nonce: port.nonce };
    const typed = noWasm(() => T.receiveAuth(ausd, domain.chainId, authArgs));
    same(typed, S.receiveAuth(ausd, domain.chainId, authArgs));
    expect(hashTypedData(typed)).toBe(hashTypedData(S.receiveAuth(ausd, domain.chainId, authArgs)));
    count('deposits (outputs, extDataHash, nonce, dummy tx, typed data)');
  }
});

test('selection: eligible, planCircuit, selectNotes (seeded), settle', () => {
  for (let i = 0; i < 300; i++) {
    const n = 1 + rand(30);
    const notes = Array.from({ length: n }, (_, k) => ({
      pos: k * 3 + rand(3),
      amount: rand(5) === 0 ? BigInt(rand(1500)) : BigInt(1 + rand(5)) * 10n ** BigInt(4 + rand(3)),
      spent: rand(8) === 0,
    }));
    const pending = new Set(notes.filter(() => rand(10) === 0).map((x) => x.pos));
    const el = noWasm(() => TS.eligible(notes, pending));
    expect(el).toEqual(SS.eligible(notes, pending));
    const T_ = BigInt(rand(3) === 0 ? 10000 : 1 + rand(2_000_000));
    expect(noWasm(() => TS.planCircuit(el, T_))).toEqual(SS.planCircuit(el, T_));
    const seed = rand(1 << 30);
    expect(noWasm(() => TS.selectNotes(el, T_, seeded(seed)))).toEqual(SS.selectNotes(el, T_, seeded(seed)));
    const total = el.reduce((s, x) => s + x.amount, 0n);
    if (total >= T_) expect(noWasm(() => TS.settle(total, T_ - 10000n, 10000n))).toEqual(SS.settle(total, T_ - 10000n, 10000n));
    count('selection cases');
  }
  const r = noWasm(() => TS.selectNotes([{ pos: 1, amount: 5000n }, { pos: 2, amount: 9000n }, { pos: 3, amount: 2000n }], 3000n));
  expect(r.err === undefined && r.circuit).toBe(2);
});

test('SMS: every shielded message, formatted and parsed', () => {
  const id = '7F3K';
  const exp = 1790000000;
  const tx = '0xd34000000000000000000000000000000000000000000000000000000000ab50';
  const addr = S.packAddress(spikeOwners[1]);
  const evm = '0x00000000000000000000000000000000000000aa';
  const strings: [string, string][] = [];

  for (const to of [addr, evm, undefined]) {
    const s = SM.formatQuote({ id, exp, fee: '0.01', to });
    const t = TM.formatReply({ kind: 'shieldedQuote', id, expires: exp, fee: '0.01', to: to === undefined ? undefined : typeof to === 'string' ? (to as Address) : Uint8Array.from(to) });
    strings.push([t, s]);
    const p = TM.parseReply(s) as Any;
    const sp = SM.parseQuote(s);
    expect(p.kind).toBe('shieldedQuote');
    same({ id: p.id, exp: p.expires, fee: p.fee, to: p.to }, sp);
  }
  expect((TM.parseReply(`Q ${id} n=1 exp=${exp} fee=0.01 to=${evm}`) as Any).kind).toBe('quote'); // public quote untouched

  for (const real of [1, 6, 12]) {
    const positions = Array.from({ length: real }, () => rand(1 << 20));
    const sig = S.sign(users[0]!.authSk, 42n);
    const s = SM.formatSig(id, sig, positions);
    strings.push([TM.formatShieldedCommand({ kind: 'shieldedSig', id, refs: positions, signature: Uint8Array.from(sig) }), s]);
    const p = TM.parseShieldedCommand(s) as Any;
    same({ id: p.id, refs: p.refs, sig: p.signature }, SM.parseSig(s));
    expect(TM.parseCommand(s)).toBeNull(); // the public parser never takes a private SIG
  }

  for (const [amount, to, p] of [['20', '+919800000002', 2], ['10', evm, undefined], ['999999.999999', '+919800000002', 99999999]] as const) {
    const s = SM.formatSent({ amount, to, tx, p });
    strings.push([TM.formatReply({ kind: 'sent', amount, to, tx: TM.shortHex(tx), p }), s]);
    const r = TM.parseReply(s) as Any;
    same({ amount: r.amount, to: r.to, tx: r.tx, p: r.p }, SM.parseSent(s));
  }

  const blinding = S.nullifier(1n, 2n, 3);
  const got = SM.formatGot({ amount: '20', from: '+919800000001', p: 2, blinding: Buffer.from(blinding.toString(16).padStart(64, '0'), 'hex') });
  // Got dropped the spike's `from <number>`; the spike's form still parses, and ours carries the same note.
  const gp = TM.parseReply(got) as Any;
  const sg = SM.parseGot(got);
  same({ amount: gp.amount, p: gp.p, blinding: gp.blinding }, { amount: sg.amount, p: sg.p, blinding: sg.blinding });
  const ours = TM.formatReply({ kind: 'got', amount: '20', p: 2, blinding });
  expect(ours).toBe(got.replace('from +919800000001', '(private)'));
  expect(TM.parseReply(ours)).toEqual({ kind: 'got', amount: '20', p: 2, blinding });
  strings.push([ours, ours]);

  const sh = SM.formatShielded({ amount: '50', tx, p: 0 });
  strings.push([TM.formatReply({ kind: 'shielded', amount: '50', tx: TM.shortHex(tx), p: 0 }), sh]);
  const shp = TM.parseReply(sh) as Any;
  same({ amount: shp.amount, tx: shp.tx, p: shp.p }, SM.parseShielded(sh));

  strings.push([TM.formatShieldedCommand({ kind: 'shield', amount: '50' }), SM.formatShield('50')]);
  same((TM.parseShieldedCommand(SM.formatShield('50')) as Any).amount, SM.parseShield(SM.formatShield('50')).amount);
  strings.push([TM.formatShieldedCommand({ kind: 'merge' }), SM.MERGE]);

  for (const [t, s] of strings) {
    expect(t).toBe(s);
    expect(TM.fitsOneSegment(t)).toBe(true);
    count('SMS strings');
  }

  // PAY is new (the spike sent SEND); it round-trips and never parses as a public SEND, nor SEND as PAY.
  for (const to of ['+919800000002', evm]) {
    const pay = TM.formatShieldedCommand({ kind: 'pay', to, amount: '20' });
    expect(TM.parseShieldedCommand(pay)).toEqual({ kind: 'pay', to, amount: '20' });
    expect(TM.parseCommand(pay)).toBeNull();
    expect(TM.parseShieldedCommand(TM.formatCommand({ kind: 'send', to, amount: '20', deliver: 'AUSD' }))).toBeNull();
  }
  expect(TM.parseShieldedCommand('pay +919800000002,1.5 ausd')).toEqual({ kind: 'pay', to: '+919800000002', amount: '1.5' });
  expect(TM.parseShieldedCommand('PAY +919800000002, 0 AUSD')).toBeNull();
  expect(TM.parseShieldedCommand('SIG 7F3K AAA notbase64')).toBeNull();
  // Longest cases still fit with the SMS Retriever hash.
  expect(TM.fitsOneSegment(TM.withRetrieverHash(strings[0]![0], 'FA+9qCX9VSu'))).toBe(true);
});

const tree = (leaves: bigint[]) => new MerkleTree(T.LEVELS, leaves, { hashFunction: poseidonHash2, zeroElement: SPIKE_ZERO });

test('witness input JSON (real and garbage signatures)', () => {
  for (const c of txCases.slice(0, 24)) {
    // Put the case's input notes in a tree at their positions.
    const leaves = Array.from({ length: 500 }, (_, i) => BigInt(i + 1));
    for (const n of c.inputs) leaves[n.pos] = S.commitment(n.amount, spikeOwners[c.me].ownerKey, n.blinding);
    const t = tree(leaves);
    const spikeTx = build(S, spikeOwners, c);
    const portTx = noWasm(() => build(T, tsOwners, c));
    const realSig = S.sign(users[c.me]!.authSk, spikeTx.msg);
    for (const sig of [realSig, new Uint8Array(64), randBytes(64), randBytes(64), randBytes(64)]) {
      const spikeIn = S.witnessInput(spikeTx, t, spikeOwners[c.me], Buffer.from(sig));
      const portIn = noWasm(() => T.witnessInput(portTx, t, tsOwners[c.me]!, Uint8Array.from(sig)));
      same(portIn, spikeIn);
      expect(T.witnessJson(portIn)).toBe(JSON.stringify(spikeIn, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
      count('witness inputs');
    }
  }
}, 120_000);

const SPIKE_DIR = fileURLToPath(new URL(`${SPIKE}/`, import.meta.url).href);
/** snarkjs hangs under bun, so proving and verifying run in node, in the spike's directory, with its own code. */
const PROVER = `
import { readFileSync } from 'node:fs'
import { groth16 } from 'snarkjs'
import { prove } from './src/shielded.mjs'
const { input, packed } = JSON.parse(readFileSync(0, 'utf8'))
const unpack = (hex) => {
  const l = hex.slice(2).match(/.{64}/g).map((h) => BigInt('0x' + h).toString())
  return { pi_a: [l[0], l[1], '1'], pi_b: [[l[3], l[2]], [l[5], l[4]], ['1', '0']], pi_c: [l[6], l[7], '1'], protocol: 'groth16', curve: 'bn128' }
}
const c = 'transaction' + input.inputNullifier.length
const vkey = JSON.parse(readFileSync('build/' + c + '_vkey.json', 'utf8'))
let out
if (packed) out = { ok: await Promise.all(packed.map(async (p) => groth16.verify(vkey, input.publicSignals, unpack(p)))) }
else {
  const spikeArgs = await prove(input)
  const { proof, publicSignals } = await groth16.fullProve(input, 'build/' + c + '_js/' + c + '.wasm', 'build/' + c + '.zkey')
  out = { spikeArgs: { ...spikeArgs, publicAmount: String(spikeArgs.publicAmount) }, proof, publicSignals }
}
process.stdout.write(JSON.stringify(out))
process.exit(0)
`;
const node = async (payload: unknown) => {
  const p = Bun.spawn(['node', '--input-type=module', '-e', PROVER], { cwd: SPIKE_DIR, stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err);
  return JSON.parse(out);
};

test.skipIf(!existsSync(`${SPIKE_DIR}build/transaction2.zkey`))(
  'proof -> contract args (real proofs, checked against the spike packing)',
  async () => {
    for (const nIns of [2, 6]) {
      const c = txCases.find((x) => x.nIns === nIns && x.kind === 'transfer');
      const leaves = Array.from({ length: 500 }, (_, i) => BigInt(i + 1));
      for (const n of c.inputs) leaves[n.pos] = S.commitment(n.amount, spikeOwners[c.me].ownerKey, n.blinding);
      const t = tree(leaves);
      const sig = S.sign(users[c.me]!.authSk, build(S, spikeOwners, c).msg);
      const input = noWasm(() => T.witnessInput(build(T, tsOwners, c), t, tsOwners[c.me]!, sig));
      const { spikeArgs, proof, publicSignals } = await node({ input: JSON.parse(T.witnessJson(input)) });
      const portArgs = T.proofArgs(proof, input);
      // Everything but the (randomized) proof is identical to the spike's prove() output.
      same({ ...portArgs, proof: null, publicAmount: String(portArgs.publicAmount) }, { ...spikeArgs, proof: null });
      // Unpacked in Nova's limb order, the spike's packed proof and the port's both verify, so the orders agree.
      const { ok } = await node({ input: { ...JSON.parse(T.witnessJson(input)), publicSignals }, packed: [spikeArgs.proof, portArgs.proof] });
      expect(ok).toEqual([true, true]);
      count('proofs');
    }
  },
  180_000,
);

test('summary', () => console.log('compared:', counts));

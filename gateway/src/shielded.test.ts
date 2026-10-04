/**
 * Shielded gateway, no chain: the persisted Merkle tree against the spike's
 * fixed-merkle-tree, key sealing, ref resolution, the owner policy and SMS
 * routing. The end-to-end flow on anvil is shielded.e2e.test.ts.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { bytesToBigInt, bytesToHex, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LEVELS, NULL_OWNER, ZERO_VALUE, buildTx, newUser, owner, packAddress, poseidon, provingKeys, sign, verifySig, type Note } from '../../protocol/shielded';
import { encodePrivateAddress } from '../../protocol/recipient';
import { b64, encodeRefs, REF_MOD, signatureToBase64 } from '../../protocol/sms';
import { d1, mockWorkers, relayStub, type Sent } from './test-env';

mockWorkers();
const { extendTree, treeFor } = await import('./pool');
const { checkOwners, openKey, register, resolveRefs, sealKey } = await import('./shielded');
const { handleInbound } = await import('./sms');
const { GatewayError } = await import('./core');
type Env = import('./env').Env;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { MerkleTree } = (await import('../../spikes/nova-splitkey/node_modules/fixed-merkle-tree/lib/index.js' as string)) as any;
const reference = (leaves: bigint[]) =>
  new MerkleTree(LEVELS, leaves, { hashFunction: (a: bigint, b: bigint) => poseidon([BigInt(a), BigInt(b)]), zeroElement: ZERO_VALUE });

const testEnv = (sent: Sent = []) =>
  ({
    DB: d1(),
    RELAY: relayStub(sent),
    FEE_AUSD: '0.01',
    SHIELDED_KEY_SECRET: 'unit-test-secret',
    GATEWAY_SHIELDED_SEED: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  }) as unknown as Env;

const randomField = () => bytesToBigInt(crypto.getRandomValues(new Uint8Array(31)));

describe('merkle tree', () => {
  const addLeaves = (env: Env, from: number, cs: bigint[]) =>
    env.DB.batch(
      cs.map((c, i) => env.DB.prepare('INSERT INTO pool_leaves (network, idx, commitment, ciphertext, block) VALUES (?, ?, ?, ?, ?)').bind('testnet', from + i, c.toString(), '0x', 1)),
    );

  test('empty tree root is zeros(LEVELS)', async () => {
    const tree = await treeFor(testEnv(), 'testnet', []);
    expect(tree.root).toBe(BigInt(reference([]).root));
  });

  test('incremental appends match fixed-merkle-tree, roots and paths', async () => {
    const env = testEnv();
    const leaves = Array.from({ length: 301 }, randomField);
    let n = 0;
    for (const k of [2, 1, 5, 2, 7, 23, 261]) {
      await addLeaves(env, n, leaves.slice(n, n + k));
      n += k;
      expect(await extendTree(env, 'testnet')).toBe(n);
      const ref = reference(leaves.slice(0, n));
      const positions = [0, n - 1, Math.floor(n / 2)];
      const tree = await treeFor(env, 'testnet', positions);
      expect(tree.root).toBe(BigInt(ref.root));
      for (const p of positions) expect(tree.path(p).pathElements).toEqual(ref.path(p).pathElements.map((x: bigint) => BigInt(x)));
    }
  });

  test('a gap stops the tree; filling it continues', async () => {
    const env = testEnv();
    const leaves = Array.from({ length: 6 }, randomField);
    await addLeaves(env, 0, leaves.slice(0, 2));
    await addLeaves(env, 4, leaves.slice(4));
    expect(await extendTree(env, 'testnet')).toBe(2);
    await addLeaves(env, 2, leaves.slice(2, 4));
    expect(await extendTree(env, 'testnet')).toBe(6);
    expect((await treeFor(env, 'testnet', [])).root).toBe(BigInt(reference(leaves).root));
  });

  test('racing appends still build the right tree', async () => {
    const env = testEnv();
    const leaves = Array.from({ length: 40 }, randomField);
    await addLeaves(env, 0, leaves);
    await Promise.all([extendTree(env, 'testnet'), extendTree(env, 'testnet'), extendTree(env, 'testnet')]);
    expect((await treeFor(env, 'testnet', [])).root).toBe(BigInt(reference(leaves).root));
  });

  test('a path for a position not in the tree is refused', async () => {
    await expect(treeFor(testEnv(), 'testnet', [0])).rejects.toThrow('syncing');
  });
});

describe('keys at rest', () => {
  test('round trip, bound to the row and the secret', async () => {
    const sealed = await sealKey('s1', '12345', '+919800000001|testnet|nk');
    expect(sealed).not.toContain('12345');
    expect(await openKey('s1', sealed, '+919800000001|testnet|nk')).toBe('12345');
    await expect(openKey('s1', sealed, '+919800000002|testnet|nk')).rejects.toThrow();
    await expect(openKey('s2', sealed, '+919800000001|testnet|nk')).rejects.toThrow();
    await expect(sealKey(undefined, 'x', 'y')).rejects.toThrow('SHIELDED_KEY_SECRET');
  });
});

describe('ref resolution', () => {
  const user = newUser();
  const me = owner(provingKeys(user));
  const domain = { chainId: 10143, pool: '0x0000000000000000000000000000000000000001' as Address };
  const note = (pos: number, amount: bigint): Note => ({ pos, amount, blinding: randomField() });
  const build = (ins: Note[], nIns: number) =>
    buildTx({ me, nIns, inputs: ins, outputs: [{ amount: 5n, to: me }, { amount: 0n, to: me }], fee: 0n, deadline: 1, domain });
  const notes = [note(3, 10n), note(5, 10n), note(9, 10n), note(3 + REF_MOD, 10n)];
  const signed = (ins: Note[], nIns = 2) => sign(user.authSk, build(ins, nIns).msg);
  const verify = (sig: Uint8Array) => (msg: bigint) => verifySig(sig, msg, me);

  test('finds the signed notes, including a colliding ref', () => {
    const sig = signed([notes[3]!, notes[1]!]);
    const r = resolveRefs(notes, [3, 5], 5n, build, verify(sig));
    if ('err' in r) throw new Error(r.err);
    expect(r.ins.map((n) => n.pos).sort((a, b) => a - b)).toEqual([5, 3 + REF_MOD]);
    expect(r.nIns).toBe(2);
    expect(r.tried).toBe(2);
  });

  test('three refs use the 6-in circuit', () => {
    const sig = signed([notes[0]!, notes[1]!, notes[2]!], 6);
    const r = resolveRefs(notes, [3, 5, 9], 5n, build, verify(sig));
    expect('err' in r ? r.err : r.nIns).toBe(6);
  });

  test('refusals', () => {
    const sig = signed([notes[0]!, notes[1]!]);
    expect(resolveRefs(notes, [3, 3], 5n, build, verify(sig))).toEqual({ err: 'REF' }); // duplicate
    expect(resolveRefs(notes, [3, 7], 5n, build, verify(sig))).toEqual({ err: 'REF' }); // unknown
    expect(resolveRefs(notes, [], 5n, build, verify(sig))).toEqual({ err: 'REF' });
    expect(resolveRefs(notes, Array.from({ length: 13 }, (_, i) => i), 5n, build, verify(sig))).toEqual({ err: 'REF' });
    expect(resolveRefs(notes, [5], 5n, build, verify(sig))).toEqual({ err: 'BADSIG' }); // one ref dropped
    expect(resolveRefs(notes, [3, 5, 9], 5n, build, verify(sig))).toEqual({ err: 'BADSIG' }); // one extra
    expect(resolveRefs(notes, [3, 5], 100n, build, verify(sig))).toEqual({ err: 'BADSIG' }); // can't cover T
  });
});

describe('owner policy', () => {
  const alice = owner(provingKeys(newUser()));
  const stranger = owner(provingKeys(newUser()));
  const domain = { chainId: 10143, pool: '0x0000000000000000000000000000000000000001' as Address };
  const registered = (k: bigint) => k === alice.ownerKey;
  const tx = (ins: Note[], to: typeof alice | typeof NULL_OWNER, toAmount = 0n) =>
    buildTx({ me: alice, inputs: ins, outputs: [{ amount: toAmount, to }, { amount: 0n, to: alice }], deadline: 1, domain });

  test('outputs must be registered keys or null', () => {
    expect(() => checkOwners(tx([{ pos: 0, amount: 5n, blinding: 1n }], alice, 5n), false, registered)).not.toThrow();
    expect(() => checkOwners(tx([{ pos: 0, amount: 5n, blinding: 1n }], NULL_OWNER), false, registered)).not.toThrow();
    expect(() => checkOwners(tx([{ pos: 0, amount: 5n, blinding: 1n }], stranger, 5n), false, registered)).toThrow(new GatewayError('POLICY'));
  });

  test('gateway inputs must be zero-value dummies', () => {
    expect(() => checkOwners(tx([], alice), true, registered)).not.toThrow();
    expect(() => checkOwners(tx([{ pos: 0, amount: 5n, blinding: 1n }], alice), true, registered)).toThrow(new GatewayError('POLICY'));
  });
});

describe('register and SMS routing', () => {
  const ALICE = '+919800000001';
  const BOB = '+919800000002';
  const user = newUser();
  const pk = provingKeys(user);
  const keysJson = { Ax: pk.Ax.toString(), Ay: pk.Ay.toString(), nk: pk.nk.toString(), viewSk: bytesToBigInt(pk.viewSk).toString() };
  const eoa = privateKeyToAccount(generatePrivateKey());
  let env: Env;
  const sms = async (from: string, body: string) => (await handleInbound(env, { from, body }))?.body;

  beforeAll(async () => {
    env = testEnv();
    for (const [phone, address] of [
      [ALICE, eoa.address.toLowerCase()],
      [BOB, '0x000000000000000000000000000000000000b0b0'],
    ])
      await env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, 0)').bind(phone, address, 'testnet').run();
  });

  test('register is idempotent and refuses other keys', async () => {
    const r = await register(env, ALICE, 'testnet', keysJson);
    expect(r.owner).toBe(b64(packAddress(owner(pk))));
    expect(await register(env, ALICE, 'testnet', keysJson)).toEqual(r);
    const other = provingKeys(newUser());
    await expect(
      register(env, ALICE, 'testnet', { Ax: other.Ax.toString(), Ay: other.Ay.toString(), nk: other.nk.toString(), viewSk: '1' }),
    ).rejects.toThrow('key-changed');
    await expect(register(env, BOB, 'testnet', keysJson)).rejects.toThrow('key-in-use');
    await expect(register(env, BOB, 'testnet', { ...keysJson, Ax: '1' })).rejects.toThrow('bad-keys');
    await expect(register(env, BOB, 'mainnet', keysJson)).rejects.toThrow('unsupported');
    const row = await env.DB.prepare('SELECT nk, view_sk FROM shielded_users WHERE phone = ?').bind(ALICE).first<{ nk: string; view_sk: string }>();
    expect(row!.nk).not.toContain(keysJson.nk);
  });

  test('PAY to a number without a shielded key', async () => {
    expect(await sms(ALICE, `PAY ${BOB}, 1 AUSD`)).toBe('ERR NOUSER');
  });

  test('PAY to a private address nobody registered, or with another encryption key', async () => {
    expect(await sms(ALICE, `PAY ${encodePrivateAddress(packAddress(owner(provingKeys(newUser()))))}, 1 AUSD`)).toBe('ERR NOUSER');
    const swapped = packAddress({ ownerKey: owner(pk).ownerKey, encPk: new Uint8Array(32).fill(9) });
    expect(await sms(ALICE, `PAY ${encodePrivateAddress(swapped)}, 1 AUSD`)).toBe('ERR NOUSER');
    expect(await sms(ALICE, `PAY ${encodePrivateAddress(swapped).slice(0, -1)}q, 1 AUSD`)).toBe('ERR bad-command'); // typo: not a command
  });

  test('every reply ends with the SMS Retriever hash', async () => {
    const withHash = { ...env, SMS_RETRIEVER_HASH: 'FA+9qCX9VSu' } as Env;
    expect((await handleInbound(withHash, { from: ALICE, body: `PAY ${BOB}, 1 AUSD` }))?.body).toBe('ERR NOUSER\nFA+9qCX9VSu');
  });

  test('PAY / MERGE / SHIELD from a number without a shielded key', async () => {
    expect(await sms(BOB, `PAY ${ALICE}, 1 AUSD`)).toBe('ERR NOUSER');
    expect(await sms(BOB, 'MERGE')).toBe('ERR NOUSER');
    expect(await sms(BOB, 'SHIELD 5 AUSD')).toBe('ERR NOUSER');
  });

  test('private SIG (refs + 64-byte signature) for an unknown quote', async () => {
    const body = `SIG 7F3K ${encodeRefs([1, 2])} ${b64(new Uint8Array(64).fill(7))}`;
    expect(await sms(ALICE, body)).toBe('ERR 7F3K UNKNOWN');
  });

  test('public-shaped SIG goes to the deposit when the quote is a SHIELD', async () => {
    await env.DB.prepare(
      `INSERT INTO shielded_quotes (id, phone, network, kind, amount, fee, exp, created_at) VALUES ('D3P2', ?, 'testnet', 'shield', '5000000', '10000', ?, 0)`,
    )
      .bind(ALICE, Math.floor(Date.now() / 1000) + 600)
      .run();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const signature = await stranger.signMessage({ message: 'not the authorization' });
    expect(await sms(ALICE, `SIG D3P2 ${signatureToBase64(signature)}`)).toBe('ERR D3P2 BADSIG');
    const q = await env.DB.prepare(`SELECT state, error FROM shielded_quotes WHERE id = 'D3P2'`).first();
    expect(q).toEqual({ state: 'open', error: 'BADSIG' }); // reopened for a corrected retry
    // The same shape for an id that isn't a shielded quote is a public SIG.
    expect(await sms(ALICE, `SIG H7K9 ${signatureToBase64(signature)}`)).toBe('ERR H7K9 unknown-session');
  });

  test('unparseable text from a number on Ender', async () => {
    expect(await sms(ALICE, 'hello')).toBe('ERR bad-command');
  });
});


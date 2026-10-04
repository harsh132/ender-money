/**
 * The shielded flow end to end on a local anvil chain (chain id 10143, so the
 * testnet config applies) with the split-key pool and MockAUSD deployed as in
 * spikes/nova-splitkey/scripts/sms-sim.mjs, the real Sponsor object as the
 * sender and the prover/ container (docker image `ender-prover`) as the
 * prover. Two users: Alice shields 50 by SMS, pays Bob 20 by SMS (Bob gets
 * `Got`), Bob withdraws his whole note over HTTPS (two null outputs), Alice
 * merges over HTTPS; the gateway's tree root matches the pool's throughout.
 *
 * Skipped unless anvil, docker with `ender-prover` and the spike's forge
 * build (spikes/nova-splitkey/out) are present.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, createPublicClient, createWalletClient, formatUnits, http, parseUnits, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { AUSD_EIP712, FEE_RECIPIENT, NETWORKS } from '../../protocol/networks';
import { shieldedPoolAbi } from '../../protocol/pool';
import { eligible, selectNotes, settle } from '../../protocol/select';
import {
  buildDeposit,
  buildTx,
  owner,
  provingKeys,
  quoteSeed,
  receiveAuth,
  sign,
  unpackAddress,
  withdrawOutputs,
  newUser,
  LEVELS,
  type Note,
  type User,
} from '../../protocol/shielded';
import { b64, formatCommand, formatShieldedCommand, parseReply, unb64 } from '../../protocol/sms';
import { d1, mockWorkers, relayStub, type Sent } from './test-env';

const SPIKE = join(import.meta.dir, '../../spikes/nova-splitkey');
const ANVIL = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
const ANVIL_PORT = 18561;
const PROVER_PORT = 18562;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PROVER_NAME = 'ender-prover-gateway-e2e';
const hasImage = () => spawnSync('docker', ['image', 'inspect', 'ender-prover'], { stdio: 'ignore' }).status === 0;
const ready = existsSync(ANVIL) && existsSync(join(SPIKE, 'out/ShieldedPool.sol/ShieldedPool.json')) && hasImage();

mockWorkers(`http://127.0.0.1:${PROVER_PORT}`);
const { Sponsor } = await import('./sponsor');
const worker = (await import('./index')).default;
const { handleInbound } = await import('./sms');
const { signJwt } = await import('./jwt');
const { catchUp, treeFor } = await import('./pool');
const shieldedCore = await import('./shielded');
type Env = import('./env').Env;

const MNEMONIC = 'test test test test test test test test test test test junk'; // anvil's public dev mnemonic
const key = (i: number) => bytesToHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey!);
const deployer = privateKeyToAccount(key(0));
const aliceEOA = privateKeyToAccount(key(1));
const bobEOA = privateKeyToAccount(key(2));
const gatewayKey = privateKeyToAccount(key(6));
const ALICE = '+919800000001';
const BOB = '+919800000002';
const AUSD = (x: string) => parseUnits(x, 6);

const chain = { ...monadTestnet, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account: typeof deployer) => createWalletClient({ account, chain, transport: http(RPC) });
const art = (name: string) => JSON.parse(readFileSync(join(SPIKE, `out/${name}.sol/${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };

let anvil: ReturnType<typeof spawn> | undefined;
let env: Env;
let token: Address;
let pool: Address;
const sent: Sent = [];
const users: Record<string, User> = { [ALICE]: newUser(), [BOB]: newUser() };
const me = (phone: string) => owner(provingKeys(users[phone]!));
const restore: { testnet?: typeof NETWORKS.testnet; eip712?: typeof AUSD_EIP712 } = {};

const deploy = async (abi: Abi, bytecode: Hex, args: unknown[] = []) => {
  const hash = await wallet(deployer).deployContract({ abi, bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
};

beforeAll(async () => {
  if (!ready) return;
  anvil = spawn(ANVIL, ['--port', String(ANVIL_PORT), '--chain-id', String(monadTestnet.id), '--silent'], { stdio: 'ignore' });
  try {
    execFileSync('docker', ['rm', '-f', PROVER_NAME], { stdio: 'ignore' });
  } catch {}
  execFileSync('docker', ['run', '-d', '--name', PROVER_NAME, '--cpus=2', '--memory=3g', '-p', `127.0.0.1:${PROVER_PORT}:8080`, 'ender-prover']);
  for (let i = 0; ; i++) {
    const up = await Promise.all([
      pub.getChainId().then(() => true, () => false),
      fetch(`http://127.0.0.1:${PROVER_PORT}/health`).then((r) => r.ok, () => false),
    ]);
    if (up.every(Boolean)) break;
    if (i > 300) throw new Error('anvil or the prover did not start');
    await new Promise((r) => setTimeout(r, 100));
  }

  const hasher = JSON.parse(readFileSync(join(SPIKE, 'build/Hasher.json'), 'utf8')) as { abi: Abi; bytecode: Hex };
  const verifiers = [];
  for (const n of [2, 6, 12]) verifiers.push(await deploy(art(`Verifier${n}`).abi, art(`Verifier${n}`).bytecode.object));
  const T = art('MockAUSD');
  token = await deploy(T.abi, T.bytecode.object);
  const P = art('ShieldedPool');
  const deployHash = await wallet(deployer).deployContract({
    abi: P.abi,
    bytecode: P.bytecode.object,
    args: [...verifiers, LEVELS, await deploy(hasher.abi, hasher.bytecode), token, AUSD('1000'), gatewayKey.address, deployer.address],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: deployHash });
  pool = receipt.contractAddress!;
  // Point the testnet config at the local deployment (MockAUSD's EIP-712 name differs from AUSD's); afterAll restores
  // both, since every test file shares these modules.
  Object.assign(restore, { testnet: { ...NETWORKS.testnet }, eip712: { ...AUSD_EIP712 } });
  Object.assign(NETWORKS.testnet, { ausd: token, pool, poolDeployBlock: receipt.blockNumber });
  Object.assign(AUSD_EIP712 as { name: string }, { name: 'Mock AUSD' });
  // Gas for the gateway key, AUSD for Alice's wallet.
  await pub.waitForTransactionReceipt({ hash: await wallet(deployer).writeContract({ address: token, abi: T.abi, functionName: 'mint', args: [aliceEOA.address, AUSD('50.01')] }) });

  const sponsors = new Map<string, InstanceType<typeof Sponsor>>();
  env = {
    DB: d1(),
    RELAY: relayStub(sent),
    PROVER: {},
    IP_LIMITER: { limit: async () => ({ success: true }) },
    FEE_AUSD: '0.01',
    JWT_SECRET: 'e2e-jwt',
    RPC_TESTNET: RPC,
    GATEWAY_PRIVATE_KEY: key(6),
    SHIELDED_KEY_SECRET: 'e2e-secret',
    GATEWAY_SHIELDED_SEED: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  } as unknown as Env;
  (env as { SPONSOR: unknown }).SPONSOR = {
    idFromName: (n: string) => n,
    get: (n: string) => sponsors.get(n) ?? sponsors.set(n, new Sponsor({} as DurableObjectState, env)).get(n)!,
  };
  for (const [phone, eoa] of [
    [ALICE, aliceEOA.address],
    [BOB, bobEOA.address],
  ] as const)
    await env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, 0)').bind(phone, eoa.toLowerCase(), 'testnet').run();
}, 120_000);

afterAll(() => {
  if (restore.testnet) Object.assign(NETWORKS.testnet, restore.testnet);
  if (restore.eip712) Object.assign(AUSD_EIP712 as object, restore.eip712);
  anvil?.kill();
  if (ready) spawnSync('docker', ['rm', '-f', PROVER_NAME], { stdio: 'ignore' });
});

const api = async <T>(phone: string, method: string, path: string, body?: unknown): Promise<T> => {
  const jwt = await signJwt(env.JWT_SECRET, { phone, address: '' }, 600);
  const res = await worker.fetch!(
    new Request(`https://api.test${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error}`);
  return json;
};
const sms = async (from: string, body: string) => {
  const out = await handleInbound(env, { from, body });
  return out!.body;
};
/** The phone's note cache, resynced from the gateway's index (as the app does online). */
const notesOf = async (phone: string) =>
  (await api<{ notes: Array<{ pos: number; amount: string; blinding: string; spent: boolean }>; root: string }>(phone, 'GET', '/shielded/notes?network=testnet'))
    .notes;
const unspent = async (phone: string): Promise<Note[]> =>
  eligible((await notesOf(phone)).map((n) => ({ pos: n.pos, amount: BigInt(n.amount), blinding: BigInt(n.blinding), spent: n.spent })));
const rootsMatch = async () => {
  const { root } = await api<{ root: string }>(ALICE, 'GET', '/shielded/notes?network=testnet');
  expect(BigInt(root)).toBe(BigInt(await pub.readContract({ address: pool, abi: shieldedPoolAbi, functionName: 'getLastRoot' })));
};
const domain = () => ({ chainId: monadTestnet.id, pool });

/** The phone's side of a payment, withdrawal or merge: pick notes, build, sign. */
const phoneSigns = async (phone: string, q: { id: string; exp: number; fee: string }, amount: bigint, outputs: (change: { amount: bigint; to: ReturnType<typeof me> }) => Parameters<typeof buildTx>[0]['outputs'], extra = {}) => {
  const fee = AUSD(q.fee);
  const sel = selectNotes(await unspent(phone), amount + fee);
  if (sel.err) throw new Error(sel.err);
  const s = settle(sel.ins.reduce((t, n) => t + n.amount, 0n), amount, fee);
  const tx = buildTx({
    me: me(phone),
    nIns: sel.circuit,
    inputs: sel.ins,
    outputs: outputs({ amount: s.change, to: me(phone) }),
    fee: s.fee,
    relayer: FEE_RECIPIENT,
    deadline: q.exp,
    domain: domain(),
    ...extra,
  });
  return { refs: sel.ins.map((n) => n.pos), sig: sign(users[phone]!.authSk, tx.msg), tx };
};

test.skipIf(!ready)(
  'shield, pay, change-free withdrawal and merge through the gateway',
  async () => {
    // Online onboarding: both register their proving keys.
    const owners: Record<string, string> = {};
    for (const phone of [ALICE, BOB]) {
      const pk = provingKeys(users[phone]!);
      const keys = { Ax: pk.Ax.toString(), Ay: pk.Ay.toString(), nk: pk.nk.toString(), viewSk: BigInt(bytesToHex(pk.viewSk)).toString() };
      owners[phone] = (await api<{ owner: string }>(phone, 'POST', '/shielded/register', { network: 'testnet', keys })).owner;
    }
    expect(await api<{ owner: string }>(ALICE, 'GET', `/shielded/address?network=testnet&phone=${encodeURIComponent(BOB)}`)).toEqual({ owner: owners[BOB]! });

    // 1. SMS: Alice shields 50 from her wallet (EIP-3009 for 50.01).
    const q1 = parseReply(await sms(ALICE, 'SHIELD 50 AUSD'));
    if (q1?.kind !== 'shieldedQuote') throw new Error(`no quote: ${JSON.stringify(q1)}`);
    expect(q1.to).toBeUndefined();
    const dep = buildDeposit({
      me: me(ALICE),
      outputs: [
        { amount: AUSD('50'), to: me(ALICE) },
        { amount: 0n, to: me(ALICE) },
      ],
      fee: AUSD(q1.fee),
      relayer: FEE_RECIPIENT,
      deadline: q1.expires,
      seed: quoteSeed(q1.id, q1.expires),
      domain: domain(),
    });
    const auth = receiveAuth({ address: token, ...AUSD_EIP712 }, monadTestnet.id, { from: aliceEOA.address, to: pool, value: dep.value, validBefore: q1.expires, nonce: dep.nonce });
    const shielded = parseReply(await sms(ALICE, formatCommand({ kind: 'sig', id: q1.id, signature: await aliceEOA.signTypedData(auth) })));
    expect(shielded).toMatchObject({ kind: 'shielded', amount: '50', p: 0 });
    expect(await unspent(ALICE)).toEqual([{ pos: 0, amount: AUSD('50'), blinding: dep.outs[0]!.blinding, spent: false } as Note]);
    await rootsMatch();

    // 2. SMS: Alice pays Bob 20; Bob gets Got with the note.
    const q2 = parseReply(await sms(ALICE, `PAY ${BOB}, 20 AUSD`));
    if (q2?.kind !== 'shieldedQuote' || !(q2.to instanceof Uint8Array)) throw new Error(`no quote: ${JSON.stringify(q2)}`);
    expect(b64(q2.to)).toBe(owners[BOB]!);
    const pay = await phoneSigns(ALICE, { id: q2.id, exp: q2.expires, fee: q2.fee }, AUSD('20'), (change) => [{ amount: AUSD('20'), to: unpackAddress(q2.to as Uint8Array) }, change]);
    // The app's HTTPS submit and its SMS fallback race: one proves and sends, the other waits for the same outcome.
    const [smsText, http2] = await Promise.all([
      sms(ALICE, formatShieldedCommand({ kind: 'shieldedSig', id: q2.id, refs: pay.refs, signature: pay.sig })),
      api<{ tx: Hex; p: number }>(ALICE, 'POST', '/shielded/submit', { id: q2.id, refs: pay.refs, sig: b64(pay.sig) }),
    ]);
    const sentReply = parseReply(smsText);
    expect(sentReply).toMatchObject({ kind: 'sent', amount: '20', to: BOB, p: 2 });
    expect(http2.p).toBe(2);
    expect((sentReply as { tx: string }).tx).toBe(`${http2.tx.slice(0, 6)}...${http2.tx.slice(-2)}`);
    expect(sent.filter((s) => s.to === BOB)).toHaveLength(1);
    const got = sent.find((s) => s.to === BOB);
    expect(parseReply(got!.body)).toEqual({ kind: 'got', amount: '20', from: ALICE, p: 2, blinding: pay.tx.outs[0]!.blinding });
    expect((await unspent(BOB)).map((n) => [n.pos, n.amount])).toEqual([[2, AUSD('20')]]);
    expect((await unspent(ALICE)).map((n) => [n.pos, n.amount])).toEqual([[3, AUSD('29.99')]]);
    expect((await notesOf(ALICE)).find((n) => n.pos === 0)?.spent).toBe(true);
    await rootsMatch();

    // A repeated SIG returns the same transaction.
    expect(parseReply(await sms(ALICE, formatShieldedCommand({ kind: 'shieldedSig', id: q2.id, refs: pay.refs, signature: pay.sig })))).toEqual(sentReply);

    // 3. HTTPS: Bob withdraws his whole note to a fresh address: no change, two null outputs, no leaves, no p.
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    const q3 = await api<{ id: string; exp: number; fee: string; to: string }>(BOB, 'POST', '/shielded/quote', { network: 'testnet', kind: 'withdraw', to: fresh, amount: '19.99' });
    expect(q3.to).toBe(fresh.toLowerCase());
    const w = await phoneSigns(BOB, q3, AUSD('19.99'), withdrawOutputs, { extAmount: -AUSD('19.99'), recipient: fresh });
    const r3 = await api<{ tx: Hex; p?: number }>(BOB, 'POST', '/shielded/submit', { id: q3.id, refs: w.refs, sig: b64(w.sig) });
    expect(r3.p).toBeUndefined();
    const balance = await pub.readContract({ address: token, abi: art('MockAUSD').abi, functionName: 'balanceOf', args: [fresh] });
    expect(formatUnits(balance as bigint, 6)).toBe('19.99');
    expect(await unspent(BOB)).toEqual([]);
    await rootsMatch();

    // 4. HTTPS: Alice merges (0 to self; fee only), and an empty wallet gets FUNDS.
    const q4 = await api<{ id: string; exp: number; fee: string; to?: string }>(ALICE, 'POST', '/shielded/quote', { network: 'testnet', kind: 'merge' });
    expect(q4.to).toBeUndefined();
    const m = await phoneSigns(ALICE, q4, 0n, (change) => [{ amount: 0n, to: me(ALICE) }, change]);
    expect((await api<{ p: number }>(ALICE, 'POST', '/shielded/submit', { id: q4.id, refs: m.refs, sig: b64(m.sig) })).p).toBe(4);
    expect((await unspent(ALICE)).map((n) => [n.pos, n.amount])).toEqual([[5, AUSD('29.98')]]);
    await expect(api(BOB, 'POST', '/shielded/quote', { network: 'testnet', kind: 'pay', to: ALICE, amount: '1' })).rejects.toThrow('FUNDS');
    await rootsMatch();

    // Fees reached the relayer: 0.01 x 4 plus the withdrawal's dust-free change.
    const fees = await pub.readContract({ address: token, abi: art('MockAUSD').abi, functionName: 'balanceOf', args: [FEE_RECIPIENT] });
    expect(formatUnits(fees as bigint, 6)).toBe('0.04');
    // Nothing the gateway keeps at rest is plaintext key material.
    const row = await env.DB.prepare('SELECT nk FROM shielded_users WHERE phone = ?').bind(ALICE).first<{ nk: string }>();
    expect(row!.nk).not.toContain(provingKeys(users[ALICE]!).nk.toString());
    expect(unb64(owners[ALICE]!, 64)).not.toBeNull();

    // A fresh database rebuilds everything from the deploy block (the first-use catch-up).
    const env2 = { ...env, DB: d1() } as Env;
    await env2.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, 0)').bind(ALICE, aliceEOA.address.toLowerCase(), 'testnet').run();
    const pk = provingKeys(users[ALICE]!);
    await shieldedCore.register(env2, ALICE, 'testnet', { Ax: pk.Ax.toString(), Ay: pk.Ay.toString(), nk: pk.nk.toString(), viewSk: BigInt(bytesToHex(pk.viewSk)).toString() });
    await catchUp(env2, 'testnet');
    const again = await shieldedCore.notes(env2, ALICE, 'testnet');
    expect(again.notes).toEqual(await notesOf(ALICE));
    expect(BigInt(again.root)).toBe((await treeFor(env, 'testnet', [])).root);
    expect((await treeFor(env2, 'testnet', [])).size).toBe(6);
  },
  300_000,
);

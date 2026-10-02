// End-to-end on a local anvil: deposits from stealth EOAs, 2-in merge, private transfer, relayed withdrawal
// to a gasless fresh EOA, a 16-in merge, negative checks, balances, gas and proving times.
// Prereqs: scripts/ptau.sh, scripts/setup.sh, forge build.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, encodeFunctionData, formatUnits, parseUnits, hexToBytes } from 'viem'
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { Keypair } from '../src/keypair.mjs'
import { Utxo } from '../src/utxo.mjs'
import { prepareTransaction, findNotes, buildMerkleTree, proveTimes, MERKLE_TREE_HEIGHT } from '../src/index.mjs'
import { getExtDataHash, toFixedHex, FIELD_SIZE } from '../src/utils.mjs'

const PORT = process.env.PORT ?? '18547' // not 8545, to stay clear of other local chains
const ANVIL = process.env.ANVIL ?? path.join(os.homedir(), '.foundry', 'bin', 'anvil')
const RPC = `http://127.0.0.1:${PORT}`
const AUSD = (x) => parseUnits(String(x), 6)
const fmt = (x) => formatUnits(x, 6)

const anvil = spawn(ANVIL, ['--port', PORT, '--silent'], { stdio: 'inherit' })
process.on('exit', () => anvil.kill())
const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } }
const client = createPublicClient({ chain, transport: http(RPC) })
for (let i = 0; ; i++) {
  try {
    await client.getChainId()
    break
  } catch {
    if (i > 100) throw new Error('anvil did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
}

const art = (name) => JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8'))
const MNEMONIC = 'test test test test test test test test test test test junk' // anvil's public dev mnemonic
const wallet = (i) => createWalletClient({ account: mnemonicToAccount(MNEMONIC, { addressIndex: i }), chain, transport: http(RPC) })
const [deployer, S1, S2, S3, S4, S5, relayer] = [0, 1, 2, 3, 4, 5, 6].map(wallet)
const fresh = privateKeyToAccount(generatePrivateKey()) // never sends a tx, never holds native gas

async function deploy(abi, bytecode, args = []) {
  const hash = await deployer.deployContract({ abi, bytecode, args })
  return (await client.waitForTransactionReceipt({ hash })).contractAddress
}

const hasherJson = JSON.parse(fs.readFileSync('build/Hasher.json', 'utf8'))
const hasher = await deploy(hasherJson.abi, hasherJson.bytecode)
const V2 = art('Verifier2')
const V16 = art('Verifier16')
const T = art('MockAUSD')
const P = art('ShieldedPool')
const verifier2 = await deploy(V2.abi, V2.bytecode.object)
const verifier16 = await deploy(V16.abi, V16.bytecode.object)
const token = await deploy(T.abi, T.bytecode.object)
const MAX_DEPOSIT = AUSD(1000)
const pool = await deploy(P.abi, P.bytecode.object, [verifier2, verifier16, MERKLE_TREE_HEIGHT, hasher, token, MAX_DEPOSIT])
console.log(`deployed pool ${pool} (tree height ${MERKLE_TREE_HEIGHT}, cap ${fmt(MAX_DEPOSIT)} AUSD)`)

const balanceOf = (a) => client.readContract({ address: token, abi: T.abi, functionName: 'balanceOf', args: [a] })
const gas = []
async function send(w, address, abi, functionName, args) {
  const hash = await w.writeContract({ address, abi, functionName, args })
  const r = await client.waitForTransactionReceipt({ hash })
  assert.equal(r.status, 'success', functionName)
  return r
}
async function transact(w, tx, label) {
  const r = await send(w, pool, P.abi, 'transact', [tx.args, tx.extData])
  gas.push({ label, gasUsed: r.gasUsed })
  console.log(`  ${label}: gas ${r.gasUsed}`)
  return r
}
async function expectRevert(w, tx, reason, label) {
  await assert.rejects(
    client.simulateContract({ account: w.account, address: pool, abi: P.abi, functionName: 'transact', args: [tx.args, tx.extData] }),
    (e) => e.message.includes(reason),
    label,
  )
  console.log(`  reverts as expected: ${label} ("${reason}")`)
}
async function deposit(w, keypair, amount, label) {
  await send(w, token, T.abi, 'mint', [w.account.address, AUSD(amount)])
  const ar = await send(w, token, T.abi, 'approve', [pool, AUSD(amount)])
  gas.push({ label: 'approve (ERC-20, before each deposit)', gasUsed: ar.gasUsed })
  const tx = await prepareTransaction({ client, pool, outputs: [new Utxo({ amount: AUSD(amount), keypair })] })
  return transact(w, tx, label)
}

const bob = new Keypair()
const alice = new Keypair()

console.log('1. stealth addresses S1, S2 deposit 10 and 15 for Bob')
await deposit(S1, bob, 10, 'deposit 10 (tx2)')
await deposit(S2, bob, 15, 'deposit 15 (tx2)')

console.log('2. Bob merges 10 + 15 -> 25 (transaction2)')
let bobNotes = await findNotes({ client, pool, keypair: bob })
assert.deepEqual(bobNotes.map((n) => n.amount).sort(), [AUSD(10), AUSD(15)])
const mergeTx = await prepareTransaction({ client, pool, inputs: bobNotes, outputs: [new Utxo({ amount: AUSD(25), keypair: bob })] })
await transact(S1, mergeTx, 'merge 10+15 (tx2)')

console.log('3. Bob sends 20 privately to Alice, 5 change')
bobNotes = await findNotes({ client, pool, keypair: bob })
assert.deepEqual(bobNotes.map((n) => n.amount), [AUSD(25)])
const aliceAddr = Keypair.fromString(alice.address()) // Bob only knows Alice's shielded address
const transferTx = await prepareTransaction({
  client,
  pool,
  inputs: bobNotes,
  outputs: [new Utxo({ amount: AUSD(20), keypair: aliceAddr }), new Utxo({ amount: AUSD(5), keypair: bob })],
})
await transact(S2, transferTx, 'transfer 20 + 5 change (tx2)')

console.log('4. Alice withdraws 12 from her notes: 11.9 to a fresh EOA + 0.1 relayer fee, keeps 8')
let aliceNotes = await findNotes({ client, pool, keypair: alice })
assert.deepEqual(aliceNotes.map((n) => n.amount), [AUSD(20)])
const FEE = AUSD('0.1')
const withdrawTx = await prepareTransaction({
  client,
  pool,
  inputs: aliceNotes,
  outputs: [new Utxo({ amount: AUSD(8), keypair: alice })],
  fee: FEE,
  recipient: fresh.address,
  relayer: relayer.account.address,
})
assert.equal(withdrawTx.extData.extAmount, -AUSD('11.9'))

console.log('6. negative checks')
// tamper recipient after proving
await expectRevert(
  relayer,
  { ...withdrawTx, extData: { ...withdrawTx.extData, recipient: S5.account.address } },
  'Incorrect external data hash',
  'tampered recipient',
)
// tamper fee and patch extDataHash/publicAmount to match: the proof no longer verifies
{
  const extData = { ...withdrawTx.extData, fee: AUSD(1) }
  const args = {
    ...withdrawTx.args,
    extDataHash: toFixedHex(getExtDataHash(extData)),
    publicAmount: (extData.extAmount - extData.fee + FIELD_SIZE) % FIELD_SIZE,
  }
  await expectRevert(relayer, { args, extData }, 'Invalid transaction proof', 'tampered fee with recomputed extDataHash')
}
// overdraw: notes hold 20, try to take 30 -> sum constraint fails, no proof
await assert.rejects(
  prepareTransaction({ client, pool, inputs: aliceNotes, extAmount: -AUSD(30), recipient: fresh.address }),
  /Assert Failed|Error in template/,
)
console.log('  fails to prove as expected: withdraw 30 from a 20 note')
// overdraw by lying about the note amount -> commitment not in tree, no proof
{
  const liar = new Utxo({ amount: AUSD(30), keypair: alice, blinding: aliceNotes[0].blinding, index: aliceNotes[0].index })
  await assert.rejects(
    prepareTransaction({ client, pool, inputs: [liar], extAmount: -AUSD(30), recipient: fresh.address }),
    /not found|Assert Failed|Error in template/,
  )
  console.log('  fails to prove as expected: withdraw 30 claiming the 20 note holds 30')
}
// replay the merge (its nullifiers are spent)
await expectRevert(S1, mergeTx, 'Input is already spent', 'replayed merge tx')
// fresh proof spending an already-spent note (Bob's original 10 is still in the tree)
{
  const events = await client.getContractEvents({ address: pool, abi: P.abi, eventName: 'NewCommitment', fromBlock: 0n })
  const spent10 = events
    .map((e) => {
      try {
        return Utxo.decrypt(bob, e.args.encryptedOutput, Number(e.args.index))
      } catch {
        return null
      }
    })
    .find((u) => u && u.amount === AUSD(10))
  const tx = await prepareTransaction({ client, pool, inputs: [spent10], outputs: [new Utxo({ amount: AUSD(10), keypair: bob })] })
  await expectRevert(S1, tx, 'Input is already spent', 'new proof re-spending a spent note (same nullifier)')
}
// deposit above the cap
{
  await send(S5, token, T.abi, 'mint', [S5.account.address, AUSD(1001)])
  await send(S5, token, T.abi, 'approve', [pool, AUSD(1001)])
  const tx = await prepareTransaction({ client, pool, outputs: [new Utxo({ amount: AUSD(1001), keypair: bob })] })
  await expectRevert(S5, tx, 'amount is larger than maximumDepositAmount', 'deposit 1001 > cap 1000')
  await send(S5, token, T.abi, 'approve', [pool, 0n])
}

console.log('4b. relayer submits the untampered withdrawal')
assert.equal(await client.getBalance({ address: fresh.address }), 0n)
await transact(relayer, withdrawTx, 'withdraw 11.9 + 0.1 fee via relayer (tx2)')
assert.equal(await client.getBalance({ address: fresh.address }), 0n)
aliceNotes = await findNotes({ client, pool, keypair: alice })
assert.deepEqual(aliceNotes.map((n) => n.amount), [AUSD(8)])

console.log('5. S3..S5 deposit 1, 2, 3 for Bob; Bob merges 4 notes (5+1+2+3) with transaction16')
await deposit(S3, bob, 1, 'deposit 1 (tx2)')
await deposit(S4, bob, 2, 'deposit 2 (tx2)')
await deposit(S5, bob, 3, 'deposit 3 (tx2)')
bobNotes = await findNotes({ client, pool, keypair: bob })
assert.equal(bobNotes.length, 4)
const m16 = await prepareTransaction({ client, pool, inputs: bobNotes, outputs: [new Utxo({ amount: AUSD(11), keypair: bob })] })
assert.equal(m16.args.inputNullifiers.length, 16)
await transact(S3, m16, 'merge 4 notes (tx16)')
bobNotes = await findNotes({ client, pool, keypair: bob })
assert.deepEqual(bobNotes.map((n) => n.amount), [AUSD(11)])

console.log('7. final balances')
const bal = { pool: await balanceOf(pool), fresh: await balanceOf(fresh.address), relayer: await balanceOf(relayer.account.address) }
console.log(`  pool ${fmt(bal.pool)}  fresh EOA ${fmt(bal.fresh)}  relayer ${fmt(bal.relayer)}  (fresh EOA native balance 0)`)
assert.equal(bal.pool, AUSD(19)) // Alice 8 + Bob 11
assert.equal(bal.fresh, AUSD('11.9'))
assert.equal(bal.relayer, FEE)
const tree = await buildMerkleTree({ client, pool })
assert.equal(toFixedHex(tree.root), await client.readContract({ address: pool, abi: P.abi, functionName: 'getLastRoot' }))

// Verifier-only gas: call each verifier in its own tx and subtract intrinsic gas (21000 + calldata).
async function verifierGas(verifier, abi, tx) {
  const [a0, a1, b00, b01, b10, b11, c0, c1] = tx.args.proof
    .slice(2)
    .match(/.{64}/g)
    .map((h) => BigInt('0x' + h))
  const pub = [tx.args.root, tx.args.publicAmount, tx.args.extDataHash, ...tx.args.inputNullifiers, ...tx.args.outputCommitments].map(BigInt)
  const args = [[a0, a1], [[b00, b01], [b10, b11]], [c0, c1], pub]
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verifyProof', args }), true)
  const data = encodeFunctionData({ abi, functionName: 'verifyProof', args })
  const r = await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: verifier, data, gas: 3_000_000n }) /* explicit: estimateGas finds a limit where the precompile calls fail and verifyProof just returns false */ })
  const calldataGas = hexToBytes(data).reduce((s, b) => s + (b === 0 ? 4n : 16n), 0n)
  return { nPub: pub.length, verifyGas: r.gasUsed - 21000n - calldataGas }
}
const v2 = await verifierGas(verifier2, V2.abi, withdrawTx)
const v16 = await verifierGas(verifier16, V16.abi, m16)
// Monad reprices BN254 precompiles: ecAdd 150->300, ecMul 6000->30000, ecPairing 45000+34000k -> 225000+170000k (4 pairs).
const monadDelta = (nPub) => BigInt(nPub) * (30000n - 6000n + 300n - 150n) + (225000n - 45000n) + 4n * (170000n - 34000n)

const summary = {
  gas: gas.map((g) => ({ ...g, gasUsed: Number(g.gasUsed) })),
  verifier: [
    { circuit: 'transaction2', nPub: v2.nPub, verifyGas: Number(v2.verifyGas), monadVerifyGasEst: Number(v2.verifyGas + monadDelta(v2.nPub)) },
    { circuit: 'transaction16', nPub: v16.nPub, verifyGas: Number(v16.verifyGas), monadVerifyGasEst: Number(v16.verifyGas + monadDelta(v16.nPub)) },
  ],
  monadPrecompileDelta: { tx2: Number(monadDelta(7)), tx16: Number(monadDelta(21)) },
  proveTimes,
  balances: Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, fmt(v)])),
}
fs.writeFileSync('build/e2e-results.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log('E2E OK')
process.exit(0)

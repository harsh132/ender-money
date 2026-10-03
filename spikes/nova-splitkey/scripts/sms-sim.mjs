// Offline shielded payments over SMS with split keys, on a local anvil chain.
// PHONE (src/phone.mjs) and GATEWAY (src/gateway.mjs) only talk through literal SMS strings, each checked by
// checkSms (printable ASCII, one GSM-7 segment). Prereqs: scripts/setup.sh, forge build.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, encodeFunctionData, hexToBytes, parseEventLogs } from 'viem'
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { newUser, provingKeys, owner, packAddress, buildTx, sign, prove, witnessInput, proveTimes, LEVELS } from '../src/shielded.mjs'
import { getExtDataHash, toFixedHex, toBuffer, FIELD_SIZE } from '../src/utils.mjs'
import { checkSms, formatQuote, formatSig, formatSent, formatGot, parseSig, formatCommand } from '../src/sms.mjs'
import { Phone } from '../src/phone.mjs'
import { Gateway } from '../src/gateway.mjs'

const PORT = process.env.PORT ?? '18548'
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

// ---------- deploy
const art = (name) => JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8'))
const MNEMONIC = 'test test test test test test test test test test test junk' // anvil's public dev mnemonic
const wallet = (i) => createWalletClient({ account: mnemonicToAccount(MNEMONIC, { addressIndex: i }), chain, transport: http(RPC) })
const [deployer, aliceEOA, gwWallet] = [0, 1, 6].map(wallet)
const fresh = privateKeyToAccount(generatePrivateKey()) // withdrawal target, never holds native gas
const attacker = privateKeyToAccount(generatePrivateKey())
async function deploy(abi, bytecode, args = []) {
  const hash = await deployer.deployContract({ abi, bytecode, args })
  return (await client.waitForTransactionReceipt({ hash })).contractAddress
}
const hasherJson = JSON.parse(fs.readFileSync('build/Hasher.json', 'utf8'))
const [V2, T, P] = ['Verifier2', 'MockAUSD', 'ShieldedPool'].map(art)
const hasher = await deploy(hasherJson.abi, hasherJson.bytecode)
const verifier2 = await deploy(V2.abi, V2.bytecode.object)
const token = await deploy(T.abi, T.bytecode.object)
const pool = await deploy(P.abi, P.bytecode.object, [verifier2, LEVELS, hasher, token, AUSD(1000)])
const domain = { chainId: await client.getChainId(), pool }
console.log(`deployed pool ${pool} on chain ${domain.chainId}`)
const balanceOf = (a) => client.readContract({ address: token, abi: T.abi, functionName: 'balanceOf', args: [a] })
async function send(w, address, abi, functionName, args) {
  const r = await client.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName, args }) })
  assert.equal(r.status, 'success', functionName)
  return r
}
async function expectRevert(args, extData, reason, label) {
  await assert.rejects(
    client.simulateContract({ account: gwWallet.account, address: pool, abi: P.abi, functionName: 'transact', args: [args, extData] }),
    (e) => e.message.includes(reason),
    label,
  )
  console.log(`  OK pool rejects: ${label} ("${reason}")`)
}
async function expectNoProof(promise, label) {
  await assert.rejects(promise, /Assert Failed|Error in template/, label)
  console.log(`  OK no proof: ${label}`)
}

// ---------- actors
const FEE = AUSD('0.05')
const gateway = new Gateway({ client, wallet: gwWallet, pool, poolAbi: P.abi, domain, fee: FEE })
const config = { domain, relayer: gwWallet.account.address, maxFee: AUSD(1) }
const users = { alice: newUser(), bob: newUser(), carol: newUser() }
const numbers = { alice: '+919800000001', bob: '+919800000002', carol: '+919800000003' }
const phones = Object.fromEntries(Object.entries(users).map(([k, user]) => [k, new Phone({ number: numbers[k], user, config })]))
const byNumber = Object.fromEntries(Object.values(phones).map((p) => [p.number, p]))
for (const [k, user] of Object.entries(users)) gateway.register(numbers[k], provingKeys(user)) // online onboarding
const { alice, bob, carol } = phones

const smsLog = []
function wire(from, to, text, note = '') {
  checkSms(text)
  smsLog.push({ from, to, kind: text.split(' ')[0], len: text.length, text, note })
  console.log(`  [${String(text.length).padStart(3)}] ${from === 'GW' ? 'GW' : from} -> ${to === 'GW' ? 'GW' : to}: ${text}${note ? `   <- ${note}` : ''}`)
}
/** Runs an SMS exchange to quiescence. Throws if a phone refuses. */
async function converse(phone, text) {
  const queue = [{ from: phone.number, to: 'GW', text }]
  while (queue.length) {
    const m = queue.shift()
    wire(m.from, m.to, m.text)
    if (m.to === 'GW') for (const r of await gateway.onSms(m.from, m.text)) queue.push({ from: 'GW', ...r })
    else {
      const res = byNumber[m.to].onSms(m.text)
      if (res.refused) throw new Error(`${m.to} refused: ${res.refused}`)
      if (res.out) queue.push({ from: m.to, to: 'GW', text: res.out })
    }
  }
}
const cache = (p) => p.unspent().map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
const now = () => Math.floor(Date.now() / 1000)

// ---------- 1. Alice shields 50 (online)
console.log('1. Alice shields 50 AUSD from her EOA (online)')
await send(aliceEOA, token, T.abi, 'mint', [aliceEOA.account.address, AUSD(50)])
await send(aliceEOA, token, T.abi, 'approve', [pool, AUSD(50)])
{
  const tx = buildTx({ me: alice.me, inputs: [], outputs: [{ amount: AUSD(50), to: alice.me }, { amount: 0n, to: alice.me }], extAmount: AUSD(50), deadline: now() + 600, domain })
  const args = await gateway.proveTx(alice.number, tx, sign(users.alice.authSk, tx.msg)) // phone signs, gateway proves
  const r = await send(aliceEOA, pool, P.abi, 'transact', [args, tx.extData])
  gateway.gas.push({ label: 'deposit 50 (Alice EOA)', gasUsed: Number(r.gasUsed) })
  const p = Number(parseEventLogs({ abi: P.abi, logs: r.logs, eventName: 'NewCommitment' })[0].args.index)
  alice.addNote(p, tx.outs[0].amount, tx.outs[0].blinding)
}
console.log(`  Alice cache: ${cache(alice)}`)

// ---------- 2. Alice pays Bob 20 over SMS
console.log('2. OFFLINE: Alice pays Bob 20 (private transfer)')
await converse(alice, alice.send(bob.number, '20'))
const step2 = gateway.last
console.log(`  Alice cache: ${cache(alice)} | Bob cache: ${cache(bob)} | Alice pinned Bob: ${alice.contacts.has(bob.number)}`)
assert.equal(alice.balance(), AUSD('29.95'))
assert.equal(bob.balance(), AUSD(20))

// ---------- negative checks on the phone (d, f): malicious or wrong quotes are refused, no SIG goes out
console.log('d/f. phone refuses bad quotes (nothing is signed)')
const aliceNote = alice.unspent()[0].pos
function expectRefused(phone, q, why) {
  const text = formatQuote(q)
  wire('GW', phone.number, text, `forged: ${why}`)
  const res = phone.onSms(text)
  assert.ok(res.refused && !res.out, why)
  console.log(`  OK refused: ${res.refused}`)
}
const mallory = owner(provingKeys(newUser()))
alice.send(bob.number, '1')
expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.05', ins: [999], to: packAddress(bob.me) }, '(d) note not in cache')
expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.05', ins: [aliceNote, aliceNote], to: packAddress(bob.me) }, '(d) same note twice')
expectRefused(alice, { id: 'MMMM', exp: now() - 1, fee: '0.05', ins: [aliceNote], to: packAddress(bob.me) }, 'expired quote')
expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '5', ins: [aliceNote], to: packAddress(bob.me) }, 'fee above limit')
expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.05', ins: [aliceNote], to: packAddress(mallory) }, "(f) Bob's pinned key substituted")
alice.cancel()
alice.send(bob.number, '40')
expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.05', ins: [aliceNote], to: packAddress(bob.me) }, "(d) notes don't cover amount + fee")
alice.cancel()
alice.send(fresh.address, '10')
expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.05', ins: [aliceNote], to: attacker.address }, 'withdrawal address substituted')
alice.cancel()

// ---------- 3. Bob pays Carol 5 from the note he just learned by SMS
console.log('3. OFFLINE: Bob pays Carol 5 from the 20 note (change to Bob)')
await converse(bob, bob.send(carol.number, '5'))
console.log(`  Bob cache: ${cache(bob)} | Carol cache: ${cache(carol)}`)
assert.equal(bob.balance(), AUSD('14.95'))
assert.equal(carol.balance(), AUSD(5))

// ---------- 4. Alice withdraws 10 to a fresh address, step by step to attack the gateway side
console.log('4. OFFLINE: Alice withdraws 10 to a fresh EVM address')
const sendText = alice.send(fresh.address, '10')
wire(alice.number, 'GW', sendText)
const [qMsg] = await gateway.onSms(alice.number, sendText)
wire('GW', alice.number, qMsg.text)
const sigText = alice.onSms(qMsg.text).out
wire(alice.number, 'GW', sigText)
const { id, sig } = parseSig(sigText)
const quote = gateway.quotes.get(id)
{
  console.log('a. gateway alters the transaction after SIG')
  const ins = quote.ins
  const total = ins.reduce((s, n) => s + n.amount, 0n)
  const me = gateway.users.get(alice.number).me
  const base = { me, inputs: ins, relayer: gwWallet.account.address, deadline: quote.exp, domain }
  const alt = (extAmount, fee, recipient) => buildTx({ ...base, outputs: [{ amount: 0n, to: me }, { amount: total + extAmount - fee, to: me }], extAmount, fee, recipient })
  await expectNoProof(gateway.proveTx(alice.number, alt(-AUSD(10), FEE, attacker.address), sig), 'recipient changed to attacker')
  await expectNoProof(gateway.proveTx(alice.number, alt(-AUSD(11), FEE, fresh.address), sig), 'amount 10 -> 11')
  await expectNoProof(gateway.proveTx(alice.number, alt(-AUSD(10), AUSD(1), fresh.address), sig), 'fee 0.05 -> 1')
  const args = await gateway.proveTx(alice.number, quote.tx, sig)
  await expectRevert(args, { ...quote.tx.extData, recipient: attacker.address }, 'Incorrect external data hash', 'honest proof, recipient swapped in extData')
  const extData = { ...quote.tx.extData, fee: AUSD(1) }
  await expectRevert(
    { ...args, extDataHash: toFixedHex(getExtDataHash(extData, domain)), publicAmount: (extData.extAmount - extData.fee + FIELD_SIZE) % FIELD_SIZE },
    extData,
    'Invalid transaction proof',
    'honest proof, fee raised with extDataHash and publicAmount recomputed',
  )

  console.log("b. gateway spends Alice's notes with nk + viewing key only (no phone signature)")
  const steal = buildTx({ ...base, outputs: [{ amount: 0n, to: me }, { amount: 0n, to: me }], extAmount: -total, fee: 0n, recipient: attacker.address })
  await expectNoProof(gateway.proveTx(alice.number, steal, Buffer.alloc(64)), 'all-zero signature')
  await expectNoProof(gateway.proveTx(alice.number, steal, crypto.randomBytes(64)), 'random 64 bytes')
  await expectNoProof(gateway.proveTx(alice.number, steal, sig), "Alice's real signature from this quote")
  await expectNoProof(gateway.proveTx(alice.number, steal, sign(crypto.randomBytes(32), steal.msg)), "signature by the gateway's own EdDSA key")

  console.log('c. signature by a different authority key')
  await expectNoProof(gateway.proveTx(alice.number, quote.tx, sign(users.carol.authSk, quote.tx.msg)), "Carol's phone signs Alice's withdrawal")
  const bad = await gateway.onSms(alice.number, formatSig(id, sign(users.carol.authSk, quote.tx.msg)))
  wire('GW', alice.number, bad[0].text, 'gateway pre-check before proving')
}
console.log('4b. the untampered SIG goes through')
for (const r of await gateway.onSms(alice.number, sigText)) {
  wire('GW', r.to, r.text)
  byNumber[r.to].onSms(r.text)
}
console.log(`  Alice cache: ${cache(alice)}`)
assert.equal(alice.balance(), AUSD('19.9'))

console.log('e. replays')
await expectRevert(step2.args, step2.extData, 'Input is already spent', "resubmit step 2's transaction")
{
  const spent50 = [...alice.notes].find(([, n]) => n.amount === AUSD(50))
  const tx = buildTx({ me: alice.me, inputs: [{ pos: spent50[0], ...spent50[1] }], outputs: [{ amount: AUSD('49.95'), to: alice.me }, { amount: 0n, to: alice.me }], fee: FEE, relayer: gwWallet.account.address, deadline: now() + 600, domain })
  const args = await gateway.proveTx(alice.number, tx, sign(users.alice.authSk, tx.msg)) // proves fine: the note is still in the tree
  await expectRevert(args, tx.extData, 'Input is already spent', 'fresh signed proof re-spending the spent 50 note')
}
{
  const r = await gateway.onSms(alice.number, sigText)
  wire('GW', alice.number, r[0].text, 'SIG replayed to the gateway')
}

// ---------- 5. verify
console.log('5. balances and caches')
const bal = { pool: await balanceOf(pool), fresh: await balanceOf(fresh.address), gateway: await balanceOf(gwWallet.account.address) }
console.log(`  pool ${fmt(bal.pool)} | fresh ${fmt(bal.fresh)} (native ${await client.getBalance({ address: fresh.address })}) | gateway fees ${fmt(bal.gateway)}`)
assert.equal(bal.pool, AUSD('39.85'))
assert.equal(bal.fresh, AUSD(10))
assert.equal(bal.gateway, AUSD('0.15'))
assert.equal(await client.getBalance({ address: fresh.address }), 0n)
await gateway.sync()
for (const p of Object.values(phones)) {
  const g = gateway.unspent(p.number).map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
  console.log(`  ${p.number}: phone cache [${cache(p)}] = gateway index [${g}]`)
  assert.equal(cache(p), g)
  for (const [pos, n] of p.notes) {
    const onChain = await client.readContract({ address: pool, abi: P.abi, functionName: 'isSpent', args: [toFixedHex(p.nullifierOf(pos))] })
    assert.equal(onChain, n.spent, `spent flag of ${p.number} note ${pos}`)
  }
}
assert.equal(toFixedHex(gateway.tree.root), await client.readContract({ address: pool, abi: P.abi, functionName: 'getLastRoot' }))

// ---------- measurements
// Verifier-only gas: own tx with an explicit gas limit (estimateGas would find a limit where verifyProof returns false).
const lastArgs = gateway.last.args
const [a0, a1, b00, b01, b10, b11, c0, c1] = lastArgs.proof.slice(2).match(/.{64}/g).map((h) => BigInt('0x' + h))
const pub = [lastArgs.root, lastArgs.publicAmount, lastArgs.extDataHash, ...lastArgs.inputNullifiers, ...lastArgs.outputCommitments].map(BigInt)
const vData = encodeFunctionData({ abi: V2.abi, functionName: 'verifyProof', args: [[a0, a1], [[b00, b01], [b10, b11]], [c0, c1], pub] })
const vr = await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: verifier2, data: vData, gas: 3_000_000n }) })
const verifyGas = Number(vr.gasUsed) - 21000 - hexToBytes(vData).reduce((s, b) => s + (b === 0 ? 4 : 16), 0)
const monadDelta = 7 * (30000 - 6000 + 300 - 150) + (225000 - 45000) + 4 * (170000 - 34000)

const bench = []
{
  const input = witnessInput(quote.tx, gateway.tree, gateway.users.get(alice.number).keys, sig)
  for (let i = 0; i < 10; i++) {
    await prove(input)
    bench.push(proveTimes.at(-1))
  }
}
const sorted = [...bench].sort((a, b) => a - b)

const worst = {
  SEND: formatCommand({ kind: 'send', to: '0x' + 'f'.repeat(40), amount: '999999.999999', deliver: 'AUSD' }),
  Q: formatQuote({ id: 'ZZZZ', exp: 9999999999, fee: '999.999999', ins: [8388607, 8388606], to: Buffer.alloc(64, 255) }),
  SIG: formatSig('ZZZZ', Buffer.alloc(64, 255)),
  Sent: formatSent({ amount: '999999.999999', to: '0x' + 'f'.repeat(40), tx: '0x' + 'f'.repeat(64), p: 8388606 }),
  Got: formatGot({ amount: '999999.999999', from: '+123456789012345', p: 8388607, blinding: toBuffer(FIELD_SIZE - 1n, 32) }),
}
const summary = {
  sms: smsLog,
  smsMaxByKind: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, v.length])),
  gas: gateway.gas,
  verifyGas,
  monadVerifyGasEst: verifyGas + monadDelta,
  monadPrecompileDelta: monadDelta,
  proveMs: { all: proveTimes, bench, median: (sorted[4] + sorted[5]) / 2, min: sorted[0], max: sorted.at(-1) },
  balances: Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, fmt(v)])),
  caches: Object.fromEntries(Object.values(phones).map((p) => [p.number, cache(p)])),
}
fs.writeFileSync('build/sms-sim-results.json', JSON.stringify(summary, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
console.log('SMS lengths (worst case):', summary.smsMaxByKind)
console.log('gas:', gateway.gas.map((g) => `${g.label}: ${g.gasUsed}`).join(' | '))
console.log(`verifier only: ${verifyGas} (Monad est. ${verifyGas + monadDelta}); +${monadDelta} per transact on Monad`)
console.log(`proving (fullProve, n=10): median ${summary.proveMs.median} ms, ${summary.proveMs.min}-${summary.proveMs.max} ms`)
console.log('SMS SIM OK')
process.exit(0)

// Offline shielded payments over SMS with split keys, on a local anvil chain.
// PHONE (src/phone.mjs) and GATEWAY (src/gateway.mjs) only talk through literal SMS strings, each checked by
// checkSms (printable ASCII, one GSM-7 segment). The phone picks the input notes (src/select.mjs) and names them in
// its SIG; the gateway resolves them, rebuilds, verifies the signature and proves with the 2-, 6- or 12-input circuit.
// Deposits go SHIELD -> Q -> SIG -> Shielded: the phone signs MockAUSD's EIP-3009 ReceiveWithAuthorization with its
// EOA key, and the gateway calls depositWithAuthorization (the pool takes deposits no other way).
// Prereqs: scripts/setup.sh, forge build.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, encodeFunctionData, hexToBytes, parseEventLogs } from 'viem'
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { newUser, provingKeys, owner, packAddress, buildTx, sign, verifySig, prove, proveTimes, LEVELS, buildDeposit, receiveAuth, NULL_COMMITMENT } from '../src/shielded.mjs'
import { getExtDataHash, toFixedHex, toBuffer, FIELD_SIZE, randomBN } from '../src/utils.mjs'
import { checkSms, formatQuote, formatSig, formatSent, formatGot, parseSig, formatCommand, REF_MOD, formatShield, formatShielded } from '../src/sms.mjs'
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
const [deployer, aliceEOA, bobEOA, gwWallet] = [0, 1, 2, 6].map(wallet)
const fresh = privateKeyToAccount(generatePrivateKey()) // withdrawal target, never holds native gas
const attacker = privateKeyToAccount(generatePrivateKey())
async function deploy(abi, bytecode, args = []) {
  const hash = await deployer.deployContract({ abi, bytecode, args })
  return (await client.waitForTransactionReceipt({ hash })).contractAddress
}
const hasherJson = JSON.parse(fs.readFileSync('build/Hasher.json', 'utf8'))
const V = { 2: art('Verifier2'), 6: art('Verifier6'), 12: art('Verifier12') }
const [T, P] = ['MockAUSD', 'ShieldedPool'].map(art)
const hasher = await deploy(hasherJson.abi, hasherJson.bytecode)
const verifiers = {}
for (const n of [2, 6, 12]) verifiers[n] = await deploy(V[n].abi, V[n].bytecode.object)
const token = await deploy(T.abi, T.bytecode.object)
const pool = await deploy(P.abi, P.bytecode.object, [verifiers[2], verifiers[6], verifiers[12], LEVELS, hasher, token, AUSD(1000), gwWallet.account.address, deployer.account.address])
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
const FEE = AUSD('0.01')
const ausd = { address: token, name: 'Mock AUSD', version: '1' } // EIP-712 domain of MockAUSD
const gateway = new Gateway({ client, wallet: gwWallet, pool, poolAbi: P.abi, domain, fee: FEE, ausd })
const config = { domain, relayer: gwWallet.account.address, maxFee: AUSD(1), ausd }
const users = { alice: newUser(), bob: newUser(), carol: newUser(), dave: newUser() }
const numbers = { alice: '+919800000001', bob: '+919800000002', carol: '+919800000003', dave: '+919800000004' }
const accounts = { alice: aliceEOA.account, bob: bobEOA.account } // root keys of the users' EOAs (for SHIELD)
const phones = Object.fromEntries(Object.entries(users).map(([k, user]) => [k, new Phone({ number: numbers[k], user, config, account: accounts[k] })]))
const byNumber = Object.fromEntries(Object.values(phones).map((p) => [p.number, p]))
for (const [k, user] of Object.entries(users)) gateway.register(numbers[k], provingKeys(user), accounts[k]?.address) // online onboarding
const { alice, bob, carol, dave } = phones

const smsLog = []
function wire(from, to, text, note = '') {
  checkSms(text)
  smsLog.push({ from, to, kind: text.split(' ')[0], len: text.length, text, note })
  console.log(`  [${String(text.length).padStart(3)}] ${from === 'GW' ? 'GW' : from} -> ${to === 'GW' ? 'GW' : to}: ${text}${note ? `   <- ${note}` : ''}`)
}
/** Runs an SMS exchange to quiescence, starting with `text` from `from`. Throws if a phone refuses or gets an ERR. */
async function converse(from, text) {
  const queue = [{ from, to: 'GW', text }]
  while (queue.length) {
    const m = queue.shift()
    wire(m.from, m.to, m.text)
    if (m.to === 'GW') for (const r of await gateway.onSms(m.from, m.text)) queue.push({ from: 'GW', ...r })
    else {
      const res = await byNumber[m.to].onSms(m.text)
      if (res.refused || res.error) throw new Error(`${m.to}: ${res.refused ?? res.error}`)
      if (res.out) queue.push({ from: m.to, to: 'GW', text: res.out })
    }
  }
}
/** A command the gateway must answer with `ERR [<id>] <code>`; the reply is delivered to the phone. */
async function expectErr(phone, text, code, label) {
  wire(phone.number, 'GW', text)
  const [r] = await gateway.onSms(phone.number, text)
  wire('GW', phone.number, r.text, label)
  assert.match(r.text, new RegExp(`^ERR (\\S{4} )?${code}$`), label)
  assert.equal((await phone.onSms(r.text)).error, code)
}
const cache = (p) => p.unspent().map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
const now = () => Math.floor(Date.now() / 1000)
const byCircuit = {} // nIns -> gateway.last of a payment with that circuit
const viewChecks = []
/** Phone and gateway must count the same eligible notes, or the circuit choice would differ. */
async function sameView(phone) {
  await gateway.sync()
  const pos = (ns) => ns.map((n) => n.pos).sort((a, b) => a - b).join()
  assert.equal(pos(phone.eligible()), pos(gateway.eligible(phone.number)), `eligible notes of ${phone.number}`)
  viewChecks.push(phone.eligible().length)
}
/** One SMS payment that must use the nIns circuit with `real` real inputs. */
async function pay(phone, text, nIns, real, label) {
  console.log(label)
  await sameView(phone)
  await converse(phone.number, text)
  assert.equal(gateway.last.nIns, nIns, `${label}: circuit`)
  assert.equal(gateway.last.real, real, `${label}: real inputs`)
  byCircuit[nIns] ??= gateway.last
  console.log(`  -> transaction${nIns}, ${real} real inputs + ${nIns - real} dummies | ${phone.number} cache: ${cache(phone)}`)
}

// ---------- 1. Alice shields 50 over SMS (EIP-3009 from her EOA)
console.log('1. OFFLINE: Alice shields 50 AUSD from her EOA (SHIELD -> Q -> SIG -> Shielded)')
await send(aliceEOA, token, T.abi, 'mint', [aliceEOA.account.address, AUSD('50.01')]) // deposit + fee; no approve
await converse(alice.number, alice.shield('50'))
assert.equal(await balanceOf(aliceEOA.account.address), 0n)
console.log(`  Alice cache: ${cache(alice)}`)

// ---------- 2. Alice pays Bob 20 over SMS
await pay(alice, alice.send(bob.number, '20'), 2, 1, '2. OFFLINE: Alice pays Bob 20 (private transfer)')
const step2 = gateway.last
console.log(`  Alice cache: ${cache(alice)} | Bob cache: ${cache(bob)} | Alice pinned Bob: ${alice.contacts.has(bob.number)}`)
assert.equal(alice.balance(), AUSD('29.99'))
assert.equal(bob.balance(), AUSD(20))

// ---------- negative checks on the phone (d, f): malicious or wrong quotes are refused, no SIG goes out
console.log('d/f. phone refuses bad quotes (nothing is signed)')
async function expectRefused(phone, q, why) {
  const text = formatQuote(q)
  wire('GW', phone.number, text, `forged: ${why}`)
  const res = await phone.onSms(text)
  assert.ok(res.refused && !res.out, why)
  console.log(`  OK refused: ${res.refused}`)
}
const mallory = owner(provingKeys(newUser()))
alice.send(bob.number, '1')
await expectRefused(alice, { id: 'MMMM', exp: now() - 1, fee: '0.01', to: packAddress(bob.me) }, 'expired quote')
await expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '5', to: packAddress(bob.me) }, 'fee above limit')
await expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.01', to: packAddress(mallory) }, "(f) Bob's pinned key substituted")
alice.cancel()
alice.send(bob.number, '40')
await expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.01', to: packAddress(bob.me) }, "(d) notes don't cover amount + fee")
alice.cancel()
alice.send(fresh.address, '10')
await expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.01', to: attacker.address }, 'withdrawal address substituted')
alice.cancel()
alice.shield('5')
await expectRefused(alice, { id: 'MMMM', exp: now() - 1, fee: '0.01' }, 'SHIELD: expired quote')
await expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '5' }, 'SHIELD: fee above limit')
await expectRefused(alice, { id: 'MMMM', exp: now() + 600, fee: '0.01', to: packAddress(mallory) }, 'SHIELD: deposit quote names a recipient')
alice.cancel()

// ---------- 3. Bob pays Carol 5 from the note he just learned by SMS
await pay(bob, bob.send(carol.number, '5'), 2, 1, '3. OFFLINE: Bob pays Carol 5 from the 20 note (change to Bob)')
console.log(`  Bob cache: ${cache(bob)} | Carol cache: ${cache(carol)}`)
assert.equal(bob.balance(), AUSD('14.99'))
assert.equal(carol.balance(), AUSD(5))

// ---------- 4. Alice withdraws 10 to a fresh address, step by step to attack the gateway side
console.log('4. OFFLINE: Alice withdraws 10 to a fresh EVM address')
const sendText = alice.send(fresh.address, '10')
wire(alice.number, 'GW', sendText)
const [qMsg] = await gateway.onSms(alice.number, sendText)
wire('GW', alice.number, qMsg.text)
const sigText = (await alice.onSms(qMsg.text)).out
wire(alice.number, 'GW', sigText)
const { id, sig, refs } = parseSig(sigText)
const quote = gateway.quotes.get(id)
{
  const r = gateway.resolve(quote, sig, refs)
  assert.equal(r.nIns, 2)
  console.log('a. gateway alters the transaction after SIG')
  const total = r.ins.reduce((s, n) => s + n.amount, 0n)
  const me = gateway.users.get(alice.number).me
  const base = { me, inputs: r.ins, relayer: gwWallet.account.address, deadline: quote.exp, domain }
  const alt = (extAmount, fee, recipient) => buildTx({ ...base, outputs: [{ amount: 0n, to: me }, { amount: total + extAmount - fee, to: me }], extAmount, fee, recipient })
  await expectNoProof(gateway.proveTx(alice.number, alt(-AUSD(10), FEE, attacker.address), sig), 'recipient changed to attacker')
  await expectNoProof(gateway.proveTx(alice.number, alt(-AUSD(11), FEE, fresh.address), sig), 'amount 10 -> 11')
  await expectNoProof(gateway.proveTx(alice.number, alt(-AUSD(10), AUSD(1), fresh.address), sig), 'fee 0.01 -> 1')
  const args = await gateway.proveTx(alice.number, r.tx, sig)
  await expectRevert(args, { ...r.tx.extData, recipient: attacker.address }, 'Incorrect external data hash', 'honest proof, recipient swapped in extData')
  const extData = { ...r.tx.extData, fee: AUSD(1) }
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
  await expectNoProof(gateway.proveTx(alice.number, r.tx, sign(users.carol.authSk, r.tx.msg)), "Carol's phone signs Alice's withdrawal")
  const bad = await gateway.onSms(alice.number, formatSig(id, sign(users.carol.authSk, r.tx.msg), refs))
  wire('GW', alice.number, bad[0].text, 'gateway pre-check before proving')
  assert.equal(bad[0].text, `ERR ${id} BADSIG`)
}
console.log('4b. the untampered SIG goes through')
for (const r of await gateway.onSms(alice.number, sigText)) {
  wire('GW', r.to, r.text)
  await byNumber[r.to].onSms(r.text)
}
console.log(`  Alice cache: ${cache(alice)}`)
assert.equal(alice.balance(), AUSD('19.98'))

console.log('e. replays')
await expectRevert(step2.args, step2.extData, 'Input is already spent', "resubmit step 2's transaction")
{
  const spent50 = [...alice.notes].find(([, n]) => n.amount === AUSD(50))
  const tx = buildTx({ me: alice.me, inputs: [{ pos: spent50[0], ...spent50[1] }], outputs: [{ amount: AUSD(50) - FEE, to: alice.me }, { amount: 0n, to: alice.me }], fee: FEE, relayer: gwWallet.account.address, deadline: now() + 600, domain })
  const args = await gateway.proveTx(alice.number, tx, sign(users.alice.authSk, tx.msg)) // proves fine: the note is still in the tree
  await expectRevert(args, tx.extData, 'Input is already spent', 'fresh signed proof re-spending the spent 50 note')
}
{
  const r = await gateway.onSms(alice.number, sigText)
  wire('GW', alice.number, r[0].text, 'SIG replayed to the gateway')
  assert.equal(r[0].text, `ERR ${id} UNKNOWN`)
}

console.log('5. balances after steps 1-4')
{
  const bal = { pool: await balanceOf(pool), fresh: await balanceOf(fresh.address), gateway: await balanceOf(gwWallet.account.address) }
  console.log(`  pool ${fmt(bal.pool)} | fresh ${fmt(bal.fresh)} (native ${await client.getBalance({ address: fresh.address })}) | gateway fees ${fmt(bal.gateway)}`)
  assert.equal(bal.pool, AUSD('39.97'))
  assert.equal(bal.fresh, AUSD(10))
  assert.equal(bal.gateway, AUSD('0.04')) // 3 SMS payments + the SMS deposit
  assert.equal(await client.getBalance({ address: fresh.address }), 0n)
}

// ---------- 6. Dave: many small notes, every branch of the selection rule, all three circuits
console.log('6. Dave receives small payments and pays Carol: 2-, 6- and 12-input circuits')
await send(bobEOA, token, T.abi, 'mint', [bobEOA.account.address, AUSD(100)])
/**
 * Online: Bob's EOA shields notes straight to Dave. Bob's app builds the deposit and signs the EIP-3009 authorization;
 * the gateway proves (its own dummy inputs) and submits. Fee 0 here so the step balances stay as before. Dave's app syncs.
 */
async function fund(phone, amounts) {
  for (let i = 0; i < amounts.length; i += 2) {
    const outs = [amounts[i], amounts[i + 1] ?? 0n].map(AUSD)
    const dep = buildDeposit({ me: bob.me, outputs: outs.map((amount) => ({ amount, to: phone.me })), relayer: gwWallet.account.address, deadline: now() + 600, seed: randomBN(), domain })
    const signature = await bobEOA.account.signTypedData(receiveAuth(ausd, domain.chainId, { from: bobEOA.account.address, to: pool, value: dep.value, validBefore: dep.extData.deadline, nonce: dep.nonce }))
    const r = await gateway.deposit(dep, bobEOA.account.address, signature, 'fund Dave (deposit)')
    const p = Number(parseEventLogs({ abi: P.abi, logs: r.logs, eventName: 'NewCommitment' })[0].args.index)
    outs.forEach((a, j) => a > 0n && phone.addNote(p + j, a, dep.outs[j].blinding))
  }
  console.log(`  Dave receives ${amounts.join(' + ')} | cache: ${cache(phone)} | eligible n = ${phone.eligible().length}`)
}
const ones = (k) => Array(k).fill('1')

await fund(dave, [...ones(4), '0.0005'])
const dust = dave.unspent().find((n) => n.amount < AUSD('0.001'))
assert.equal(dave.balance(), AUSD(4), 'the 0.0005 note is not counted')
await pay(dave, dave.send(carol.number, '1.5'), 2, 2, '6a. n=4: 2 largest cover 1.51 -> 2-in')
await pay(dave, dave.send(carol.number, '2.4795'), 6, 3, '6b. n=3: 2 largest (2) short of 2.4895 -> 6-in with all 3 notes; change 0.0005 goes to the fee')
assert.equal(gateway.last.extData.fee, AUSD('0.0105'), 'change under 0.001 AUSD is added to the fee')
assert.equal(dave.balance(), 0n)
assert.equal(dave.unspent().length, 1, 'no change note: only the old 0.0005 note is left')
console.log('6c. n=0 (only the 0.0005 note left): ERR FUNDS')
await expectErr(dave, dave.send(carol.number, '0.01'), 'FUNDS', 'nothing eligible: the 0.0005 note is ignored')

await fund(dave, ones(8))
console.log('6d. n=8: 6 largest cover 3.01 -> 6-in; attacks on SIG refs first')
await sameView(dave)
{
  const sendText = dave.send(carol.number, '3')
  wire(dave.number, 'GW', sendText)
  const [q] = await gateway.onSms(dave.number, sendText)
  wire('GW', dave.number, q.text)
  const sigText = (await dave.onSms(q.text)).out
  wire(dave.number, 'GW', sigText)
  const { id, sig, refs } = parseSig(sigText)
  const quote = gateway.quotes.get(id)
  const r = gateway.resolve(quote, sig, refs)
  assert.equal(r.nIns, 6)
  // the gateway swaps one named note for another of Dave's eligible notes and rebuilds
  const other = gateway.eligible(dave.number).find((n) => !r.ins.some((i) => i.pos === n.pos))
  const swapped = [...r.ins.slice(1), other].sort((a, b) => a.pos - b.pos)
  const tx = gateway.buildFor(quote, swapped, 6)
  assert.equal(verifySig(sig, tx.msg, gateway.users.get(dave.number).keys), false)
  await expectNoProof(gateway.proveTx(dave.number, tx, sig), `gateway substitutes note @${other.pos} for @${r.ins[0].pos}`)
  // forged or broken SIGs (sent with Dave's number); the replies are not delivered to Dave's phone
  const forged = async (positions, code, label) => {
    const text = formatSig(id, sig, positions)
    wire(dave.number, 'GW', text, `forged: ${label}`)
    const [res] = await gateway.onSms(dave.number, text)
    wire('GW', dave.number, res.text)
    assert.equal(res.text, `ERR ${id} ${code}`, label)
    console.log(`  OK gateway refuses: ${label} (${code})`)
  }
  const pos = r.ins.map((n) => n.pos)
  await forged(swapped.map((n) => n.pos), 'BADSIG', 'ref to a different note of Dave (signature fails)')
  await forged([...pos.slice(1), alice.unspent()[0].pos].sort((a, b) => a - b), 'REF', "unknown ref (Alice's note)")
  await forged([...pos.slice(1), dust.pos].sort((a, b) => a - b), 'REF', 'ref to the 0.0005 note')
  await forged([pos[0], ...pos.slice(0, 5)], 'REF', 'duplicate ref')
  await forged(pos.slice(0, 5), 'BADSIG', 'dropping a ref (signature fails)')
  await forged([...pos, other.pos].sort((a, b) => a - b), 'BADSIG', 'adding a ref (signature fails)')
  console.log('  the honest SIG goes through')
  for (const m of await gateway.onSms(dave.number, sigText)) {
    wire('GW', m.to, m.text)
    await byNumber[m.to].onSms(m.text)
  }
  assert.equal(gateway.last.nIns, 6)
  assert.equal(gateway.last.real, 6)
  byCircuit[6] = gateway.last
  console.log(`  -> transaction6, 6 real inputs | Dave cache: ${cache(dave)}`)
}

await fund(dave, ones(6))
await pay(dave, dave.send(carol.number, '8'), 12, 9, '6e. n=9: 6 largest (7.99) short of 8.01 -> 12-in with all 9 notes')
assert.equal(dave.balance(), AUSD('2.98'))

await fund(dave, ones(23))
{
  // ref collision: the gateway's index gets a fake note whose position equals the 2.98 note's mod 2^18, listed first
  const big = dave.eligible().find((n) => n.amount === AUSD('2.98'))
  const u = gateway.users.get(dave.number)
  const fakePos = big.pos + REF_MOD
  u.notes = new Map([[fakePos, { amount: AUSD(1), blinding: randomBN(), nullifier: randomBN(), spent: false }], ...u.notes])
  await converse(dave.number, dave.send(carol.number, '2'))
  console.log('6f. n=24 (>= 12) -> 12-in: the 2.98 note covers 2.01, 11 random notes fill the rest')
  assert.equal(gateway.last.nIns, 12)
  assert.equal(gateway.last.real, 12)
  assert.equal(gateway.last.tried, 2, 'the colliding fake note was tried first')
  u.notes.delete(fakePos)
  byCircuit[12] = gateway.last
  console.log(`  -> transaction12, 12 real inputs; ref @${big.pos} collided with a fake @${fakePos}: ${gateway.last.tried} candidates tried, the signature picked the real one`)
  console.log(`  Dave cache: ${cache(dave)}`)
}
assert.equal(dave.balance(), AUSD('23.97'))
await sameView(dave)
console.log('6g. n=13: the 12 largest (22.97) are short of 23.01 -> ERR MERGE')
await expectErr(dave, dave.send(carol.number, '23'), 'MERGE', '12 largest notes short; all 13 would cover')
dave.send(carol.number, '23')
await expectRefused(dave, { id: 'MMMM', exp: now() + 600, fee: '0.01', to: packAddress(carol.me) }, 'quote the rule says needs a merge')
dave.cancel()
await pay(dave, dave.merge(), 12, 12, '6h. merge to self (T = fee): n=13 -> 12-in, 12 notes become 1')
assert.equal(dave.balance(), AUSD('23.96'))
await pay(dave, dave.send(carol.number, '23'), 2, 2, '6i. n=2 after the merge: 2 largest cover 23.01 -> 2-in')
assert.equal(dave.balance(), AUSD('0.95'))
{
  const leaves = Number(await client.readContract({ address: pool, abi: P.abi, functionName: 'nextIndex' }))
  await pay(dave, dave.send(fresh.address, '0.94'), 2, 1, '6j. Dave withdraws all of his 0.95 note (0.94 + fee): no change, so two null outputs')
  assert.deepEqual(gateway.last.args.outputCommitments.map(BigInt), [NULL_COMMITMENT, NULL_COMMITMENT])
  assert.equal(Number(await client.readContract({ address: pool, abi: P.abi, functionName: 'nextIndex' })), leaves, 'no leaves inserted')
  assert.equal(dave.balance(), 0n)
  console.log(`  -> no leaves, Sent has no p=, gas ${gateway.gas.at(-1).gasUsed}`)
}

// ---------- gateway policy: value only moves between registered users (checked before any proof)
console.log('policy. the gateway refuses to prove for unregistered keys or accounts')
{
  const stranger = owner(provingKeys(newUser())) // a valid shielded key the gateway has no number for
  const [note] = carol.unspent()
  const base = { relayer: gwWallet.account.address, deadline: now() + 600, domain }
  const t = buildTx({ ...base, me: carol.me, inputs: [note], outputs: [{ amount: note.amount - FEE, to: stranger }, { amount: 0n, to: carol.me }], fee: FEE })
  const refused = async (promise, re, label) => {
    await assert.rejects(promise, re, label)
    console.log(`  OK refused: ${label}`)
  }
  await refused(gateway.proveTx(carol.number, t, sign(users.carol.authSk, t.msg)), /output to an unregistered key/, 'transfer to an unregistered shielded key')
  await refused(gateway.proveTx('+919899999999', t, sign(users.carol.authSk, t.msg), provingKeys(users.carol)), /inputs of an unregistered user/, 'inputs of an unregistered number')
  const dep = (to) => buildDeposit({ ...base, me: carol.me, outputs: [{ amount: AUSD(1), to }, { amount: 0n, to: carol.me }], seed: randomBN() })
  await refused(gateway.deposit(dep(carol.me), attacker.address, '0x', 'x'), /deposit from an unregistered account/, 'deposit from an unregistered EVM account')
  await refused(gateway.deposit(dep(stranger), bobEOA.account.address, '0x', 'x'), /output to an unregistered key/, 'deposit into an unregistered shielded key')
}

// ---------- 7. verify
console.log('7. balances and caches')
const bal = { pool: await balanceOf(pool), fresh: await balanceOf(fresh.address), gateway: await balanceOf(gwWallet.account.address) }
console.log(`  pool ${fmt(bal.pool)} | fresh ${fmt(bal.fresh)} | gateway fees ${fmt(bal.gateway)}`)
assert.equal(bal.pool, AUSD('79.95')) // 39.97 + 41.0005 shielded to Dave - 8 fees (0.0805: one took 0.0005 of change) - 0.94 withdrawn
assert.equal(bal.fresh, AUSD('10.94'))
assert.equal(bal.gateway, AUSD('0.1205')) // 0.1105 in payment fees + 0.01 for the SMS deposit
assert.equal(carol.balance(), AUSD('44.9795'))
await gateway.sync()
for (const p of Object.values(phones)) {
  const g = gateway.unspent(p.number).map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
  console.log(`  ${p.number}: phone cache [${cache(p)}] = gateway index [${g}]`)
  assert.equal(cache(p), g)
  await sameView(p)
  for (const [pos, n] of p.notes) {
    const onChain = await client.readContract({ address: pool, abi: P.abi, functionName: 'isSpent', args: [toFixedHex(p.nullifierOf(pos))] })
    assert.equal(onChain, n.spent, `spent flag of ${p.number} note ${pos}`)
  }
}
assert.equal(toFixedHex(gateway.tree.root), await client.readContract({ address: pool, abi: P.abi, functionName: 'getLastRoot' }))

// ---------- measurements
// Verifier-only gas: own tx with an explicit gas limit (estimateGas would find a limit where verifyProof returns false).
// Monad reprices BN254 precompiles: ecAdd 150->300, ecMul 6000->30000, ecPairing 45000+34000k -> 225000+170000k (4 pairs).
const monadDelta = (nPub) => nPub * (30000 - 6000 + 300 - 150) + (225000 - 45000) + 4 * (170000 - 34000)
const circuits = {}
for (const n of [2, 6, 12]) {
  const { args, input } = byCircuit[n]
  const [a0, a1, b00, b01, b10, b11, c0, c1] = args.proof.slice(2).match(/.{64}/g).map((h) => BigInt('0x' + h))
  const pub = [args.root, args.publicAmount, args.extDataHash, ...args.inputNullifiers, ...args.outputCommitments].map(BigInt)
  const data = encodeFunctionData({ abi: V[n].abi, functionName: 'verifyProof', args: [[a0, a1], [[b00, b01], [b10, b11]], [c0, c1], pub] })
  const vr = await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: verifiers[n], data, gas: 3_000_000n }) })
  const verifyGas = Number(vr.gasUsed) - 21000 - hexToBytes(data).reduce((s, b) => s + (b === 0 ? 4 : 16), 0)
  const tx = gateway.gas.filter((g) => g.label.endsWith(`[${n}-in]`)).map((g) => g.gasUsed)
  const bench = []
  for (let i = 0; i < 10; i++) {
    await prove(input)
    bench.push(proveTimes.at(-1).ms)
  }
  const sorted = [...bench].sort((a, b) => a - b)
  circuits[n] = {
    nPub: pub.length,
    transactGas: { min: Math.min(...tx), max: Math.max(...tx), all: tx },
    monadTransactEst: { min: Math.min(...tx) + monadDelta(pub.length), max: Math.max(...tx) + monadDelta(pub.length) },
    verifyGas,
    monadVerifyEst: verifyGas + monadDelta(pub.length),
    monadPrecompileDelta: monadDelta(pub.length),
    proveMs: { bench, median: (sorted[4] + sorted[5]) / 2, min: sorted[0], max: sorted.at(-1) },
  }
  console.log(
    `transaction${n}: transact gas ${circuits[n].transactGas.min}-${circuits[n].transactGas.max} (Monad est. ${circuits[n].monadTransactEst.min}-${circuits[n].monadTransactEst.max}) | verifier only ${verifyGas} (Monad est. ${circuits[n].monadVerifyEst}) | fullProve n=10 median ${circuits[n].proveMs.median} ms (${circuits[n].proveMs.min}-${circuits[n].proveMs.max})`,
  )
}

const worst = {
  SEND: formatCommand({ kind: 'send', to: '0x' + 'f'.repeat(40), amount: '999999.999999', deliver: 'AUSD' }),
  Q: formatQuote({ id: 'ZZZZ', exp: 9999999999, fee: '999.999999', to: Buffer.alloc(64, 255) }),
  SIG: formatSig('ZZZZ', Buffer.alloc(64, 255), Array.from({ length: 12 }, (_, i) => 8388607 - i)),
  Sent: formatSent({ amount: '999999.999999', to: '0x' + 'f'.repeat(40), tx: '0x' + 'f'.repeat(64), p: 8388606 }),
  Got: formatGot({ amount: '999999.999999', from: '+123456789012345', p: 8388607, blinding: toBuffer(FIELD_SIZE - 1n, 32) }),
  SHIELD: formatShield('999999.999999'),
  'Q (deposit)': formatQuote({ id: 'ZZZZ', exp: 9999999999, fee: '999.999999' }),
  'SIG (deposit)': formatCommand({ kind: 'sig', id: 'ZZZZ', signature: '0x' + 'ff'.repeat(65) }),
  Shielded: formatShielded({ amount: '999999.999999', tx: '0x' + 'f'.repeat(64), p: 8388606 }),
}
const smsMaxSeen = {}
for (const m of smsLog) smsMaxSeen[m.kind] = Math.max(smsMaxSeen[m.kind] ?? 0, m.len)
const summary = {
  sms: smsLog,
  smsMaxByKind: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, v.length])),
  smsMaxSeen,
  gas: gateway.gas,
  circuits,
  viewChecks: viewChecks.length,
  proveMs: proveTimes,
  balances: Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, fmt(v)])),
  caches: Object.fromEntries(Object.values(phones).map((p) => [p.number, cache(p)])),
}
fs.writeFileSync('build/sms-sim-results.json', JSON.stringify(summary, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
console.log('SMS lengths (worst case):', summary.smsMaxByKind, '| longest seen:', smsMaxSeen)
console.log('gas:', gateway.gas.map((g) => `${g.label}: ${g.gasUsed}`).join(' | '))
console.log(`phone/gateway eligible-note views compared ${viewChecks.length} times`)
console.log('SMS SIM OK')
process.exit(0)

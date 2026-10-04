// EIP-3009 deposits and the pool's guardrails on an anvil fork of Monad testnet, with the REAL AUSD and the REAL
// Calibur. Local only: the fork reads state from the public testnet RPC and nothing is broadcast to Monad.
// A fresh EOA is delegated to Calibur (EIP-7702), gets AUSD from the testnet faucet contract (impersonated on the
// fork), and shields by SMS (SHIELD -> Q -> SIG -> Shielded). Then an SMS payment, an SMS withdrawal, a null-output
// withdrawal submitted by a random EOA, and the negative checks. Prereqs: scripts/setup.sh, forge build.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, createTestClient, http, parseUnits, formatUnits, erc20Abi, parseAbi, parseEventLogs, parseSignature, encodeAbiParameters, encodeFunctionData, zeroHash } from 'viem'
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { monadTestnet } from 'viem/chains'
import { newUser, provingKeys, buildTx, sign, buildDeposit, depositTx, receiveAuth, commitment, quoteSeed, NULL_OWNER, LEVELS, witnessInput, prove } from '../src/shielded.mjs'
import { checkSms, parseCommand, parseSig } from '../src/sms.mjs'
import { randomBN, toFixedHex, getExtDataHash } from '../src/utils.mjs'
import { Phone } from '../src/phone.mjs'
import { Gateway } from '../src/gateway.mjs'

const FORK_URL = 'https://testnet-rpc.monad.xyz'
const PORT = process.env.FORK_PORT ?? '18549'
const ANVIL = process.env.ANVIL ?? path.join(os.homedir(), '.foundry', 'bin', 'anvil')
const RPC = `http://127.0.0.1:${PORT}`
const AUSD_ADDR = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC' // testnet AUSD (proxy)
const CALIBUR = '0x000000005c84F8Fd50b21CAC312528A64437030e' // v1.1.0
const FAUCET = '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C' // testnet AUSD faucet: holds AUSD; impersonated on the fork only
const ausd = { address: AUSD_ADDR, name: 'Agora Dollar', version: '1' }
const AUSD = (x) => parseUnits(String(x), 6)
const fmt = (x) => formatUnits(x, 6)
const now = () => Math.floor(Date.now() / 1000)

const anvil = spawn(ANVIL, ['--fork-url', FORK_URL, '--hardfork', 'prague', '--port', PORT, '--silent'], { stdio: 'inherit' })
process.on('exit', () => anvil.kill())
const chain = { ...monadTestnet, rpcUrls: { default: { http: [RPC] } } } // every client below talks to the local fork only
const transport = http(RPC, { timeout: 120_000 })
const client = createPublicClient({ chain, transport })
const test = createTestClient({ chain, transport, mode: 'anvil' })
for (let i = 0; ; i++) {
  try {
    await client.getChainId()
    break
  } catch {
    if (i > 300) throw new Error('anvil fork did not start')
    await new Promise((r) => setTimeout(r, 200))
  }
}
const forkBlock = await client.getBlockNumber()
console.log(`fork of Monad testnet (chain ${await client.getChainId()}) at block ${forkBlock}, hardfork prague`)

// ---------- accounts and deploy
const MNEMONIC = 'test test test test test test test test test test test junk' // anvil's public dev mnemonic
const wallet = (account) => createWalletClient({ account, chain, transport })
const [admin, gwWallet, gw2Wallet] = [0, 6, 7].map((i) => wallet(mnemonicToAccount(MNEMONIC, { addressIndex: i })))
const aliceKey = privateKeyToAccount(generatePrivateKey()) // the user's root key; its EOA gets delegated to Calibur
const plainKey = privateKeyToAccount(generatePrivateKey()) // a plain (undelegated) EOA, for comparison
const outsider = wallet(privateKeyToAccount(generatePrivateKey())) // random non-gateway EOA
const exitAddr = privateKeyToAccount(generatePrivateKey()).address
const freshAddr = privateKeyToAccount(generatePrivateKey()).address
await test.setBalance({ address: outsider.account.address, value: 10n ** 18n })

const art = (name) => JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8'))
const P = art('ShieldedPool')
async function deploy(abi, bytecode, args = []) {
  const r = await client.waitForTransactionReceipt({ hash: await admin.deployContract({ abi, bytecode, args }) })
  assert.equal(r.status, 'success')
  return r
}
const hasherJson = JSON.parse(fs.readFileSync('build/Hasher.json', 'utf8'))
const hasher = (await deploy(hasherJson.abi, hasherJson.bytecode)).contractAddress
const verifiers = []
for (const n of [2, 6, 12]) verifiers.push((await deploy(art(`Verifier${n}`).abi, art(`Verifier${n}`).bytecode.object)).contractAddress)
const poolReceipt = await deploy(P.abi, P.bytecode.object, [...verifiers, LEVELS, hasher, AUSD_ADDR, AUSD(1000), gwWallet.account.address, admin.account.address])
const pool = poolReceipt.contractAddress
const domain = { chainId: chain.id, pool }
console.log(`pool ${pool} (gateway ${gwWallet.account.address}, admin ${admin.account.address})`)
const balanceOf = (a) => client.readContract({ address: AUSD_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const poolRead = (functionName, args = []) => client.readContract({ address: pool, abi: P.abi, functionName, args })

// ---------- EIP-7702: delegate Alice's fresh EOA to Calibur (the admin account sponsors the type-4 transaction)
{
  const authorization = await admin.signAuthorization({ account: aliceKey, contractAddress: CALIBUR })
  const r = await client.waitForTransactionReceipt({ hash: await admin.sendTransaction({ authorizationList: [authorization], to: aliceKey.address, data: '0x' }) })
  assert.equal(r.status, 'success')
  const code = await client.getCode({ address: aliceKey.address })
  assert.equal(code.toLowerCase(), `0xef0100${CALIBUR.slice(2).toLowerCase()}`)
  console.log(`Alice's EOA delegated to Calibur: code ${code}`)
}

// ---------- AUSD from the faucet contract (impersonated on the fork)
await test.impersonateAccount({ address: FAUCET })
await test.setBalance({ address: FAUCET, value: 10n ** 18n })
const faucet = wallet(FAUCET)
for (const [to, amount] of [[aliceKey.address, AUSD(5)], [plainKey.address, AUSD(1)]]) {
  const r = await client.waitForTransactionReceipt({ hash: await faucet.writeContract({ address: AUSD_ADDR, abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) })
  assert.equal(r.status, 'success')
}
await test.stopImpersonatingAccount({ address: FAUCET })
console.log(`Alice's EOA holds ${fmt(await balanceOf(aliceKey.address))} AUSD, the plain EOA ${fmt(await balanceOf(plainKey.address))}`)

// ---------- how AUSD checks the signature of a 7702-delegated `from`: probes with eth_call, msg.sender = `to`
const ausdAbi = parseAbi([
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
])
// AUSD's custom errors (names matched against the selectors in the proxy's bytecode)
const ERRORS = { '0x8baa579f': 'InvalidSignature()', '0x2ce87eeb': 'InvalidAuthorization()', '0x1dbc01d4': 'UsedOrCanceledAuthorization()', '0xa899ef93': 'ExpiredAuthorization()', '0xfea94442': 'InvalidPayee(address,address)' }
const customError = (e) => {
  const sel = /reverted with the following signature:\s*(0x[0-9a-f]{8})/i.exec(e.message)?.[1]
  return sel && `AUSD ${ERRORS[sel] ?? sel}`
}
const probes = []
async function probe(label, signer, from, { vrs = false, wrap, expectOk }) {
  const to = outsider.account.address
  const m = { from, to, value: 1n, validBefore: BigInt(now() + 600), nonce: toFixedHex(randomBN(32)) }
  const sig = await signer.signTypedData(receiveAuth(ausd, chain.id, m))
  const head = [m.from, m.to, m.value, 0n, m.validBefore, m.nonce]
  const { v, r, s } = parseSignature(sig)
  const args = vrs ? [...head, Number(v), r, s] : [...head, wrap ? wrap(sig) : sig]
  let ok = true
  let why = ''
  try {
    await client.simulateContract({ account: to, address: AUSD_ADDR, abi: ausdAbi, functionName: 'receiveWithAuthorization', args })
  } catch (e) {
    ok = false
    why = customError(e) ?? (e.shortMessage ?? e.message).split('\n')[0]
  }
  // which calls did AUSD make? callTracer over the same eth_call
  let calls1271 = null
  try {
    const data = encodeFunctionData({ abi: ausdAbi, functionName: 'receiveWithAuthorization', args })
    const trace = await client.request({ method: 'debug_traceCall', params: [{ from: to, to: AUSD_ADDR, data }, 'latest', { tracer: 'callTracer' }] })
    calls1271 = flatten(trace).filter((c) => c.input?.startsWith('0x1626ba7e')).map((c) => c.to.toLowerCase())
  } catch {}
  probes.push({ label, ok, why, isValidSignatureCalls: calls1271 })
  console.log(`  ${ok ? 'accepted' : 'rejected'}: ${label}${why ? ` (${why})` : ''}${calls1271 ? ` | ERC-1271 calls: ${calls1271.length ? calls1271.join(', ') : 'none'}` : ''}`)
  assert.equal(ok, expectOk, label)
}
const flatten = (c) => [c, ...(c.calls ?? []).flatMap(flatten)]
console.log('AUSD signature probes (eth_call, nothing mined)')
const other = privateKeyToAccount(generatePrivateKey())
// Calibur's wrapped format: abi.encode(keyHash, signature, hookData), root keyHash = 0
const wrapped = (sig) => encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }, { type: 'bytes' }], [zeroHash, sig, '0x'])
await probe('plain EOA, raw 65-byte signature (bytes overload)', plainKey, plainKey.address, { expectOk: true })
await probe('plain EOA, v/r/s overload', plainKey, plainKey.address, { vrs: true, expectOk: true })
await probe('7702 EOA, raw 65-byte root-key signature (bytes overload)', aliceKey, aliceKey.address, { expectOk: true })
await probe('7702 EOA, v/r/s overload', aliceKey, aliceKey.address, { vrs: true, expectOk: true })
await probe('7702 EOA, signature by another key', other, aliceKey.address, { expectOk: false })
await probe("7702 EOA, Calibur-wrapped (keyHash 0, sig, '') signature", aliceKey, aliceKey.address, { wrap: wrapped, expectOk: false })

// ---------- actors
const FEE = AUSD('0.01')
const gateway = new Gateway({ client, wallet: gwWallet, pool, poolAbi: P.abi, domain, fee: FEE, fromBlock: poolReceipt.blockNumber, ausd })
const config = { domain, relayer: gwWallet.account.address, maxFee: AUSD('0.02'), ausd }
const users = { alice: newUser(), bob: newUser() }
const alice = new Phone({ number: '+919800000001', user: users.alice, config, account: aliceKey })
const bob = new Phone({ number: '+919800000002', user: users.bob, config })
const byNumber = { [alice.number]: alice, [bob.number]: bob }
gateway.register(alice.number, provingKeys(users.alice), aliceKey.address)
gateway.register(bob.number, provingKeys(users.bob))

const smsLog = []
const wire = (from, to, text) => {
  checkSms(text)
  smsLog.push({ kind: text.split(' ')[0], len: text.length, text })
  console.log(`  [${String(text.length).padStart(3)}] ${from} -> ${to}: ${text}`)
}
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
const gasOf = (label) => gateway.gas.find((g) => g.label.startsWith(label)).gasUsed
const results = { gas: {}, negative: [] }

// ---------- 1. SMS deposit from the 7702 account
console.log('1. OFFLINE: Alice shields 1 AUSD from her Calibur-delegated EOA')
const before = { alice: await balanceOf(aliceKey.address), pool: await balanceOf(pool), gw: await balanceOf(gwWallet.account.address) }
await converse(alice.number, alice.shield('1'))
assert.equal(before.alice - (await balanceOf(aliceKey.address)), AUSD('1.01'))
assert.equal((await balanceOf(pool)) - before.pool, AUSD(1))
assert.equal((await balanceOf(gwWallet.account.address)) - before.gw, FEE)
assert.equal(alice.balance(), AUSD(1))
{
  // what AUSD actually did inside the mined deposit
  const hash = smsLog.at(-1).text.match(/Tx (\S+)/)[1]
  const tx = (await client.getBlock({ blockTag: 'latest', includeTransactions: true })).transactions.find((t) => t.to?.toLowerCase() === pool.toLowerCase())
  assert.ok(tx.hash.startsWith(hash.slice(0, 6)))
  const trace = await client.request({ method: 'debug_traceTransaction', params: [tx.hash, { tracer: 'callTracer' }] })
  const calls = flatten(trace)
  const r3009 = calls.find((c) => c.input?.startsWith('0x88b7ab63'))
  const c1271 = calls.filter((c) => c.input?.startsWith('0x1626ba7e'))
  results.deposit7702 = {
    receiveWithAuthorizationGas: Number(BigInt(r3009.gasUsed)),
    isValidSignatureCalls: c1271.map((c) => ({ to: c.to, type: c.type, output: c.output })),
    precompileCalls: [...new Set(calls.filter((c) => /^0x0{39}[1-9a-f]$/i.test(c.to)).map((c) => c.to))],
  }
  console.log(`  AUSD.receiveWithAuthorization: ${results.deposit7702.receiveWithAuthorizationGas} gas | isValidSignature calls: ${c1271.length ? c1271.map((c) => `${c.to} -> ${c.output?.slice(0, 10)}`).join(', ') : 'none'} | precompiles: ${results.deposit7702.precompileCalls.join(', ')}`)
}
results.gas.depositWithAuthorization = gasOf('SHIELD 1')

// ---------- 2. SMS payment, 3. SMS withdrawal (normal: two outputs inserted)
console.log('2. OFFLINE: Alice pays Bob 0.3')
await converse(alice.number, alice.send(bob.number, '0.3'))
results.gas.payment = gateway.gas.at(-1).gasUsed
assert.equal(bob.balance(), AUSD('0.3'))
console.log('3. OFFLINE: Alice withdraws 0.2 to a fresh address (normal withdrawal: change note + zero note inserted)')
await converse(alice.number, alice.send(freshAddr, '0.2'))
results.gas.withdrawal = gateway.gas.at(-1).gasUsed
assert.equal(await balanceOf(freshAddr), AUSD('0.2'))
assert.equal(alice.balance(), AUSD('0.48'))

// ---------- 4. null-output withdrawal, submitted by a random EOA (not the gateway)
console.log("4. Bob exits his whole 0.3 note with a null-output withdrawal, submitted by a random EOA")
{
  const [note] = bob.unspent()
  const tx = buildTx({ me: bob.me, inputs: [note], outputs: [{ amount: 0n, to: NULL_OWNER }, { amount: 0n, to: NULL_OWNER }], extAmount: -note.amount, recipient: exitAddr, deadline: now() + 600, domain })
  assert.equal(tx.outs[0].commitment, BigInt(await poolRead('NULL_COMMITMENT')))
  const args = await gateway.proveTx(bob.number, tx, sign(users.bob.authSk, tx.msg)) // here the gateway's prover; in an exit, the user's own
  const nextIndex = await poolRead('nextIndex')
  const rootBefore = await poolRead('getLastRoot')
  const r = await client.waitForTransactionReceipt({ hash: await outsider.writeContract({ address: pool, abi: P.abi, functionName: 'transact', args: [args, tx.extData] }) })
  assert.equal(r.status, 'success')
  results.gas.nullOutputWithdrawal = Number(r.gasUsed)
  assert.equal(parseEventLogs({ abi: P.abi, logs: r.logs, eventName: 'NewCommitment' }).length, 0)
  assert.equal(await poolRead('nextIndex'), nextIndex)
  assert.equal(await poolRead('getLastRoot'), rootBefore)
  assert.equal(await balanceOf(exitAddr), note.amount)
  bob.notes.get(note.pos).spent = true
  await gateway.sync()
  assert.equal(toFixedHex(gateway.tree.root), rootBefore)
  assert.equal(gateway.unspent(bob.number).length, 0)
  console.log(`  OK: ${fmt(note.amount)} AUSD to ${exitAddr}, no leaves inserted, gateway root = pool root, gas ${r.gasUsed}`)
}

// ---------- 5. negative checks
const reject = async (label, sim, reason) => {
  let msg = null
  try {
    await sim()
  } catch (e) {
    msg = customError(e) ?? e.shortMessage ?? e.message
  }
  assert.ok(msg, `${label}: was accepted`)
  if (reason) assert.ok(msg.includes(reason), `${label}: ${msg}`)
  const why = reason ?? msg.split('\n').find((l) => /revert|error/i.test(l))?.trim() ?? msg.split('\n')[0]
  results.negative.push({ label, why })
  console.log(`  OK rejected: ${label} (${why})`)
}
const simulate = (w, functionName, args) => client.simulateContract({ account: w.account, address: pool, abi: P.abi, functionName, args })

console.log('5. negative checks')
// a fresh SMS deposit, stopped after the SIG
const sigOf = async (phone, text) => {
  wire(phone.number, 'GW', text)
  const [q] = await gateway.onSms(phone.number, text)
  wire('GW', phone.number, q.text)
  const res = await phone.onSms(q.text)
  if (!res.out) throw new Error(`phone did not sign: ${res.refused ?? res.error}`)
  wire(phone.number, 'GW', res.out)
  const out = res.out
  return out
}
const depSig = await sigOf(alice, alice.shield('0.5'))
const { id, signature } = parseCommand(depSig)
const q = gateway.quotes.get(id)
const honest = gateway.depositFor(q)
// A malicious gateway skips its own policy check (checkOwners): prove straight from the witness.
const proveDeposit = async (dep) => {
  const tx = depositTx(gateway.self, dep)
  await gateway.sync()
  return { args: await prove(witnessInput(tx, gateway.tree, gateway.keys, sign(gateway.authSk, tx.msg))), extData: tx.extData }
}
const forged = async (label, dep) => {
  const { args, extData } = await proveDeposit(dep)
  await reject(label, () => simulate(gwWallet, 'depositWithAuthorization', [args, extData, aliceKey.address, signature]), 'AUSD InvalidSignature()')
}
const gw = gateway.self
const r1 = randomBN()
await forged('gateway changes output commitment 0 (deposit into its own note), extData unchanged', { ...honest, outs: [{ amount: AUSD('0.5'), to: gw, blinding: r1, commitment: commitment(AUSD('0.5'), gw.ownerKey, r1) }, honest.outs[1]] })
await forged('gateway changes output commitment 1 (the zero note), extData unchanged', { ...honest, outs: [honest.outs[0], { amount: 0n, to: gw, blinding: r1, commitment: commitment(0n, gw.ownerKey, r1) }] })
const variant = (o) => buildDeposit({ me: alice.me, outputs: [{ amount: AUSD('0.5'), to: alice.me }, { amount: 0n, to: alice.me }], fee: FEE, relayer: gwWallet.account.address, deadline: q.exp, seed: quoteSeed(id, q.exp), domain, ...o })
assert.equal(variant({}).nonce, honest.nonce, 'variant() rebuilds the honest deposit')
await forged('gateway raises the amount 0.5 -> 0.6', variant({ outputs: [{ amount: AUSD('0.6'), to: alice.me }, { amount: 0n, to: alice.me }] }))
await forged('gateway raises the fee 0.01 -> 0.11, same total pulled (deposit 0.4)', variant({ outputs: [{ amount: AUSD('0.4'), to: alice.me }, { amount: 0n, to: alice.me }], fee: AUSD('0.11') }))
await forged('gateway extends the deadline by 1 hour', variant({ deadline: q.exp + 3600 }))
{
  const dep = variant({})
  dep.extData = { ...dep.extData, recipient: outsider.account.address }
  const { args, extData } = await proveDeposit({ ...dep, extDataHash: getExtDataHash(dep.extData, domain) })
  await reject('gateway sets the extData recipient', () => simulate(gwWallet, 'depositWithAuthorization', [args, extData, aliceKey.address, signature]), 'AUSD InvalidSignature()')
}
const honestProof = await proveDeposit(honest)
await reject('depositWithAuthorization called by a non-gateway EOA', () => simulate(outsider, 'depositWithAuthorization', [honestProof.args, honestProof.extData, aliceKey.address, signature]), 'only gateway')
await reject('plain transact deposit (even from the gateway)', () => simulate(gwWallet, 'transact', [honestProof.args, honestProof.extData]), 'deposits: depositWithAuthorization')
// the honest deposit goes through, then replays
{
  const res = await gateway.onSms(alice.number, depSig)
  for (const m of res) {
    wire('GW', m.to, m.text)
    await byNumber[m.to].onSms(m.text)
  }
  assert.match(res[0].text, /^Shielded 0\.5 AUSD/)
  const used = await client.readContract({ address: AUSD_ADDR, abi: ausdAbi, functionName: 'authorizationState', args: [aliceKey.address, honest.nonce] })
  assert.equal(used, true)
  const { args, tx: { extData } } = gateway.lastDeposit
  await reject('replay: the mined deposit resubmitted', () => simulate(gwWallet, 'depositWithAuthorization', [args, extData, aliceKey.address, signature]), 'AUSD UsedOrCanceledAuthorization()')
  const again = await proveDeposit(honest) // fresh dummy inputs, so fresh nullifiers: only the authorization is reused
  await reject('replay: same authorization, freshly proved with new dummy nullifiers', () => simulate(gwWallet, 'depositWithAuthorization', [again.args, again.extData, aliceKey.address, signature]), 'AUSD UsedOrCanceledAuthorization()')
  const r = await gateway.onSms(alice.number, depSig)
  assert.equal(r[0].text, `ERR ${id} UNKNOWN`)
}
// transfers and withdrawals from a non-gateway sender
{
  const sigText = await sigOf(alice, alice.send(bob.number, '0.05'))
  const s = parseSig(sigText)
  const r = gateway.resolve(gateway.quotes.get(s.id), s.sig, s.refs)
  const args = await gateway.proveTx(alice.number, r.tx, s.sig)
  await reject('plain transfer submitted by a non-gateway EOA', () => simulate(outsider, 'transact', [args, r.tx.extData]), 'only gateway')
  alice.awaiting = alice.awaiting.filter((p) => p.quote.id !== s.id)
  gateway.quotes.delete(s.id)
  // sneaky transfer: a 0.01 withdrawal whose second output is a real note
  const [note] = alice.unspent()
  const tx = buildTx({ me: alice.me, inputs: [note], outputs: [{ amount: 0n, to: NULL_OWNER }, { amount: note.amount - AUSD('0.01'), to: alice.me }], extAmount: -AUSD('0.01'), recipient: outsider.account.address, deadline: now() + 600, domain })
  const a2 = await gateway.proveTx(alice.number, tx, sign(users.alice.authSk, tx.msg))
  await reject('non-gateway withdrawal with one null and one real output (sneaky transfer)', () => simulate(outsider, 'transact', [a2, tx.extData]), 'only gateway')
}
// admin rotation
await reject('non-admin setGateway (from the gateway)', () => simulate(gwWallet, 'setGateway', [gwWallet.account.address]), 'only admin')
await reject('non-admin setGateway (from a random EOA)', () => simulate(outsider, 'setGateway', [outsider.account.address]), 'only admin')
{
  const r = await client.waitForTransactionReceipt({ hash: await admin.writeContract({ address: pool, abi: P.abi, functionName: 'setGateway', args: [gw2Wallet.account.address] }) })
  assert.equal(r.status, 'success')
  console.log(`  admin rotated the gateway to ${gw2Wallet.account.address}`)
  gateway.wallet = gw2Wallet // the new gateway takes over the same users; phones learn its relayer address
  config.relayer = gw2Wallet.account.address
  const depSig2 = await sigOf(alice, alice.shield('0.25'))
  const p2 = parseCommand(depSig2)
  const dep = gateway.depositFor(gateway.quotes.get(p2.id))
  const { args, extData } = await proveDeposit(dep)
  await reject('old gateway after rotation', () => simulate(gwWallet, 'depositWithAuthorization', [args, extData, aliceKey.address, p2.signature]), 'only gateway')
  for (const m of await gateway.onSms(alice.number, depSig2)) {
    wire('GW', m.to, m.text)
    await byNumber[m.to].onSms(m.text)
  }
  console.log('  OK new gateway: SHIELD 0.25 went through')
  await converse(alice.number, alice.send(bob.number, '0.1'))
  console.log('  OK new gateway: SMS payment of 0.1 went through')
}

// ---------- final consistency
await gateway.sync()
for (const p of [alice, bob]) {
  const c = p.unspent().map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
  const g = gateway.unspent(p.number).map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
  console.log(`  ${p.number}: phone cache [${c}] = gateway index [${g}]`)
  assert.equal(c, g)
}
assert.equal(toFixedHex(gateway.tree.root), await poolRead('getLastRoot'))
results.probes = probes
results.sms = smsLog
results.smsMaxSeen = {}
for (const m of smsLog) results.smsMaxSeen[m.kind] = Math.max(results.smsMaxSeen[m.kind] ?? 0, m.len)
results.gasAll = gateway.gas
fs.mkdirSync('build', { recursive: true })
fs.writeFileSync('build/deposit3009-fork-results.json', JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
console.log('gas:', results.gas)
console.log(`negative checks rejected: ${results.negative.length}; probes: ${probes.length}`)
console.log('FORK TEST OK')
process.exit(0)

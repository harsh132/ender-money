// Smoke test of the guarded testnet pool (deployments/monad-testnet-guarded.json) with the same Phone and Gateway
// code as the anvil sim. Alice's EVM account is the demo user (DEMO_USER_PRIVATE_KEY, Calibur-delegated):
//   1. SMS: Alice shields 0.3 (EIP-3009 authorization from the demo user, gateway relays depositWithAuthorization)
//   2. SMS: Alice pays Bob 0.1
//   3. SMS: Bob withdraws his whole note (0.09 + fee): no change, two null outputs, no leaves
//   4. Open exit: Alice's 0.19 note leaves with a null-output withdrawal sent by a fresh EOA, not the gateway
// Throwaway shielded keys; the pool ends empty.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createPublicClient, createWalletClient, http, parseUnits, parseEther, formatUnits, formatEther, erc20Abi, parseEventLogs } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { monadTestnet } from 'viem/chains'
import { newUser, provingKeys, buildTx, sign, NULL_OWNER } from '../src/shielded.mjs'
import { checkSms } from '../src/sms.mjs'
import { Phone } from '../src/phone.mjs'
import { Gateway } from '../src/gateway.mjs'

const d = JSON.parse(fs.readFileSync('deployments/monad-testnet-guarded.json', 'utf8'))
const env = Object.fromEntries(
  fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const AUSD = (x) => parseUnits(String(x), 6)
const fmt = (x) => formatUnits(x, 6)
const tx = (h) => `https://testnet.monadvision.com/tx/${h}`
const now = () => Math.floor(Date.now() / 1000)

const account = privateKeyToAccount(env.GATEWAY_PRIVATE_KEY)
const demo = privateKeyToAccount(env.DEMO_USER_PRIVATE_KEY)
const client = createPublicClient({ chain: monadTestnet, transport: http() })
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() })
const P = JSON.parse(fs.readFileSync('out/ShieldedPool.sol/ShieldedPool.json', 'utf8'))
const domain = { chainId: d.chainId, pool: d.pool }
const ausdDomain = { address: d.token, name: 'Agora Dollar', version: '1' }
const gateway = new Gateway({ client, wallet, pool: d.pool, poolAbi: P.abi, domain, fee: AUSD('0.01'), fromBlock: d.deployBlock, ausd: ausdDomain })
const config = { domain, relayer: account.address, maxFee: AUSD('0.02'), ausd: ausdDomain }
const users = { alice: newUser(), bob: newUser() }
const phones = {
  alice: new Phone({ number: '+919800000001', user: users.alice, config, account: demo }),
  bob: new Phone({ number: '+919800000002', user: users.bob, config }),
}
const byNumber = Object.fromEntries(Object.values(phones).map((p) => [p.number, p]))
gateway.register(phones.alice.number, provingKeys(users.alice), demo.address)
gateway.register(phones.bob.number, provingKeys(users.bob))
const { alice, bob } = phones
const ausd = (a) => client.readContract({ address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const poolRead = (functionName) => client.readContract({ address: d.pool, abi: P.abi, functionName })
const balances = async () => ({
  gatewayMon: formatEther(await client.getBalance({ address: account.address })),
  gatewayAusd: fmt(await ausd(account.address)),
  demoAusd: fmt(await ausd(demo.address)),
  poolAusd: fmt(await ausd(d.pool)),
})
const poolBefore = await ausd(d.pool) // an earlier, interrupted run may have left notes behind
console.log('before', await balances())

async function converse(from, text) {
  const queue = [{ from, to: 'GW', text }]
  while (queue.length) {
    const m = queue.shift()
    checkSms(m.text)
    console.log(`  [${String(m.text.length).padStart(3)}] ${m.from} -> ${m.to}: ${m.text}`)
    if (m.to === 'GW') for (const r of await gateway.onSms(m.from, m.text)) queue.push({ from: 'GW', ...r })
    else {
      const res = await byNumber[m.to].onSms(m.text)
      if (res.refused || res.error) throw new Error(`${m.to}: ${res.refused ?? res.error}`)
      if (res.out) queue.push({ from: m.to, to: 'GW', text: res.out })
    }
  }
  console.log(`  -> gas ${gateway.gas.at(-1).gasUsed}, ${tx(gateway.gas.at(-1).hash)}`)
}

console.log('1. SMS: Alice shields 0.3 (EIP-3009 from the Calibur-delegated demo account)')
const demoBefore = await ausd(demo.address)
await converse(alice.number, alice.shield('0.3'))
assert.equal(alice.balance(), AUSD('0.3'))
assert.equal(demoBefore - (await ausd(demo.address)), AUSD('0.31'))

console.log('2. SMS: Alice pays Bob 0.1')
await converse(alice.number, alice.send(bob.number, '0.1'))
assert.equal(alice.balance(), AUSD('0.19'))
assert.equal(bob.balance(), AUSD('0.1'))

console.log('3. SMS: Bob withdraws his whole note (0.09 + fee) to the gateway address: two null outputs')
{
  const leaves = await poolRead('nextIndex')
  await converse(bob.number, bob.send(account.address, '0.09'))
  assert.equal(await poolRead('nextIndex'), leaves, 'no leaves inserted')
  assert.equal(bob.balance(), 0n)
}

console.log("4. Open exit: Alice's 0.19 note, null outputs, sent by a fresh EOA (not the gateway)")
{
  const outsider = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: monadTestnet, transport: http() })
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: outsider.account.address, value: parseEther('0.2') }) })
  const exitAddr = privateKeyToAccount(generatePrivateKey()).address
  const [note] = alice.unspent()
  const t = buildTx({ me: alice.me, inputs: [note], outputs: [{ amount: 0n, to: NULL_OWNER }, { amount: 0n, to: NULL_OWNER }], extAmount: -note.amount, recipient: exitAddr, deadline: now() + 600, domain })
  const args = await gateway.proveTx(alice.number, t, sign(users.alice.authSk, t.msg)) // the gateway's prover here; an exit tool in production
  const r = await client.waitForTransactionReceipt({ hash: await outsider.writeContract({ address: d.pool, abi: P.abi, functionName: 'transact', args: [args, t.extData] }) })
  assert.equal(r.status, 'success')
  assert.equal(parseEventLogs({ abi: P.abi, logs: r.logs, eventName: 'NewCommitment' }).length, 0)
  assert.equal(await ausd(exitAddr), note.amount)
  alice.notes.get(note.pos).spent = true
  console.log(`  ${fmt(note.amount)} AUSD to ${exitAddr}, gas ${r.gasUsed}, ${tx(r.transactionHash)}`)
}

await gateway.sync()
for (const p of Object.values(phones)) assert.equal(gateway.unspent(p.number).length, p.unspent().length, `${p.number} cache matches the index`)
assert.equal(BigInt(await poolRead('getLastRoot')), BigInt(gateway.tree.root))
assert.equal(await ausd(d.pool), poolBefore, 'everything this run put in came out')
console.log('gas', gateway.gas.map((g) => `${g.label}: ${g.gasUsed}`).join(' | '))
console.log('after', await balances())
console.log('TESTNET SMOKE OK')
process.exit(0) // snarkjs keeps worker threads alive

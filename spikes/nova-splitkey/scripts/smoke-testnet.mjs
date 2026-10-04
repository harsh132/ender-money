// Smoke test of the deployed testnet pool (deployments/monad-testnet.json) with the same Phone and Gateway code as
// the anvil sim. The gateway key deposits 0.3 AUSD to Alice; by SMS Alice pays Bob 0.1, then Bob withdraws 0.05 back
// to the gateway address. Throwaway shielded keys: whatever stays in the pool (0.23 AUSD) is abandoned.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, formatEther, erc20Abi, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monadTestnet } from 'viem/chains'
import { newUser, provingKeys, buildTx, sign } from '../src/shielded.mjs'
import { checkSms } from '../src/sms.mjs'
import { Phone } from '../src/phone.mjs'
import { Gateway } from '../src/gateway.mjs'

const d = JSON.parse(fs.readFileSync('deployments/monad-testnet.json', 'utf8'))
const env = Object.fromEntries(
  fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const AUSD = (x) => parseUnits(String(x), 6)
const fmt = (x) => formatUnits(x, 6)
const tx = (h) => `https://testnet.monadvision.com/tx/${h}`
const now = () => Math.floor(Date.now() / 1000)

const account = privateKeyToAccount(env.GATEWAY_PRIVATE_KEY)
const client = createPublicClient({ chain: monadTestnet, transport: http() })
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() })
const P = JSON.parse(fs.readFileSync('out/ShieldedPool.sol/ShieldedPool.json', 'utf8'))
const domain = { chainId: d.chainId, pool: d.pool }
const gateway = new Gateway({ client, wallet, pool: d.pool, poolAbi: P.abi, domain, fee: AUSD('0.01'), fromBlock: d.deployBlock })
const config = { domain, relayer: account.address, maxFee: AUSD('0.02') }
const users = { alice: newUser(), bob: newUser() }
const phones = { alice: new Phone({ number: '+919800000001', user: users.alice, config }), bob: new Phone({ number: '+919800000002', user: users.bob, config }) }
const byNumber = Object.fromEntries(Object.values(phones).map((p) => [p.number, p]))
for (const [k, p] of Object.entries(phones)) gateway.register(p.number, provingKeys(users[k]))
const { alice, bob } = phones
const balances = async () => ({
  mon: formatEther(await client.getBalance({ address: account.address })),
  gatewayAusd: fmt(await client.readContract({ address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })),
  poolAusd: fmt(await client.readContract({ address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [d.pool] })),
})
console.log('before', await balances())

async function converse(from, text) {
  const queue = [{ from, to: 'GW', text }]
  while (queue.length) {
    const m = queue.shift()
    checkSms(m.text)
    console.log(`  [${String(m.text.length).padStart(3)}] ${m.from} -> ${m.to}: ${m.text}`)
    if (m.to === 'GW') for (const r of await gateway.onSms(m.from, m.text)) queue.push({ from: 'GW', ...r })
    else {
      const res = byNumber[m.to].onSms(m.text)
      if (res.refused || res.error) throw new Error(`${m.to}: ${res.refused ?? res.error}`)
      if (res.out) queue.push({ from: m.to, to: 'GW', text: res.out })
    }
  }
  console.log(`  -> transaction${gateway.last.nIns}, ${tx(gateway.last.hash)}`)
}

console.log('1. gateway EOA deposits 0.3 AUSD to Alice (online)')
{
  const approve = await wallet.writeContract({ address: d.token, abi: erc20Abi, functionName: 'approve', args: [d.pool, AUSD('0.3')] })
  await client.waitForTransactionReceipt({ hash: approve })
  const t = buildTx({ me: alice.me, inputs: [], outputs: [{ amount: AUSD('0.3'), to: alice.me }, { amount: 0n, to: alice.me }], extAmount: AUSD('0.3'), deadline: now() + 600, domain })
  const args = await gateway.proveTx(alice.number, t, sign(users.alice.authSk, t.msg))
  const r = await gateway.submit(args, t.extData, 'deposit 0.3')
  const p = Number(parseEventLogs({ abi: P.abi, logs: r.logs, eventName: 'NewCommitment' })[0].args.index)
  alice.addNote(p, t.outs[0].amount, t.outs[0].blinding)
  console.log(`  note @${p}, gas ${r.gasUsed}, ${tx(r.transactionHash)}`)
}

console.log('2. SMS: Alice pays Bob 0.1')
await converse(alice.number, alice.send(bob.number, '0.1'))
assert.equal(alice.balance(), AUSD('0.19'))
assert.equal(bob.balance(), AUSD('0.1'))

console.log('3. SMS: Bob withdraws 0.05 to the gateway address')
await converse(bob.number, bob.send(account.address, '0.05'))
assert.equal(bob.balance(), AUSD('0.04'))

await gateway.sync()
for (const p of Object.values(phones)) {
  const g = gateway.unspent(p.number).map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
  const c = p.unspent().map((n) => `${fmt(n.amount)}@${n.pos}`).join(', ')
  assert.equal(c, g, `${p.number} cache matches the gateway index`)
}
assert.equal(BigInt(await client.readContract({ address: d.pool, abi: P.abi, functionName: 'getLastRoot' })), BigInt(gateway.tree.root))
console.log('gas', gateway.gas.map((g) => `${g.label}: ${g.gasUsed}`).join(' | '))
console.log('after', await balances())
console.log('TESTNET SMOKE OK')

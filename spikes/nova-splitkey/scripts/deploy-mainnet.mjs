// Deploys the split-key pool to Monad MAINNET from the gateway key (GATEWAY_PRIVATE_KEY in the repo's .env):
// Poseidon hasher, Verifier2/6/12 and ShieldedPool over mainnet AUSD (gateway = admin = the deployer), with a
// 50 AUSD cap per deposit. Writes deployments/monad-mainnet.json; resumable: each address is written as soon as it
// lands. BETA: the trusted setup is single-contributor and nothing is audited; hence the cap.
// Run by the owner (Claude doesn't broadcast mainnet transactions):
//   cd spikes/nova-splitkey && node scripts/deploy-mainnet.mjs
// Prereqs: scripts/setup.sh, forge build (the same artifacts the testnet pool was deployed from).
import fs from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { LEVELS } from '../src/shielded.mjs'

const monad = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
})
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'
const MAX_DEPOSIT = parseUnits('50', 6)
const OUT = 'deployments/monad-mainnet.json'

const env = Object.fromEntries(
  fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const account = privateKeyToAccount(env.GATEWAY_PRIVATE_KEY)
const client = createPublicClient({ chain: monad, transport: http() })
const wallet = createWalletClient({ account, chain: monad, transport: http() })

const art = (name) => JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8'))
const hasherJson = JSON.parse(fs.readFileSync('build/Hasher.json', 'utf8'))
const V = { 2: art('Verifier2'), 6: art('Verifier6'), 12: art('Verifier12') }
const P = art('ShieldedPool')

fs.mkdirSync('deployments', { recursive: true })
const d = fs.existsSync(OUT)
  ? JSON.parse(fs.readFileSync(OUT, 'utf8'))
  : { chainId: monad.id, token: AUSD, levels: LEVELS, maxDeposit: MAX_DEPOSIT.toString(), deployer: account.address, gateway: account.address, admin: account.address }
const save = () => fs.writeFileSync(OUT, JSON.stringify(d, null, 2) + '\n')

async function deploy(key, abi, bytecode, args = []) {
  if (d[key]) return console.log(`${key} ${d[key]} (already deployed)`)
  const hash = await wallet.deployContract({ abi, bytecode, args })
  const r = await client.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${key} deploy reverted: ${hash}`)
  d[key] = r.contractAddress
  if (key === 'pool') d.deployBlock = Number(r.blockNumber)
  save()
  console.log(`${key} ${r.contractAddress} gas ${r.gasUsed} tx ${hash}`)
}

console.log(`deployer ${account.address}, ${formatEther(await client.getBalance({ address: account.address }))} MON`)
await deploy('hasher', hasherJson.abi, hasherJson.bytecode)
for (const n of [2, 6, 12]) await deploy(`verifier${n}`, V[n].abi, V[n].bytecode.object)
await deploy('pool', P.abi, P.bytecode.object, [d.verifier2, d.verifier6, d.verifier12, LEVELS, d.hasher, AUSD, MAX_DEPOSIT, account.address, account.address]) // gateway, admin
console.log(`done: ${OUT}, ${formatEther(await client.getBalance({ address: account.address }))} MON left`)

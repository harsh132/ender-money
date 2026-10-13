// Read-only: estimates the gas and MON cost of deploy-mainnet.mjs. Sends nothing.
import fs from 'node:fs'
import { createPublicClient, defineChain, encodeDeployData, formatEther, http, parseUnits } from 'viem'
import { LEVELS } from '../src/shielded.mjs'

const monad = defineChain({ id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } })
const client = createPublicClient({ chain: monad, transport: http() })
const from = '0x458E8F51EC2B833209b5C71372376eeb1e40af08'
const art = (name) => JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8'))
const hasher = JSON.parse(fs.readFileSync('build/Hasher.json', 'utf8'))
const P = art('ShieldedPool')
const dummy = '0x0000000000000000000000000000000000000001'
const items = [
  ['hasher', encodeDeployData({ abi: hasher.abi, bytecode: hasher.bytecode })],
  ...[2, 6, 12].map((n) => [`verifier${n}`, encodeDeployData({ abi: art(`Verifier${n}`).abi, bytecode: art(`Verifier${n}`).bytecode.object })]),
  ['pool', encodeDeployData({ abi: P.abi, bytecode: P.bytecode.object, args: [dummy, dummy, dummy, LEVELS, dummy, '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', parseUnits('50', 6), from, from] })],
]
const price = await client.getGasPrice()
let total = 0n
for (const [name, data] of items) {
  const gas = await client.estimateGas({ account: from, data })
  total += gas
  console.log(`${name}: ${gas} gas`)
}
const balance = await client.getBalance({ address: from })
console.log(`total ${total} gas at ${formatEther(price * 1_000_000_000n)} gwei-ish price -> ${formatEther(total * price)} MON; balance ${formatEther(balance)} MON`)

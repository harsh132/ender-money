// End-to-end check of the prover image: builds 2-, 6- and 12-input witness inputs with the spike's code, proves them in
// the container, verifies each proof with snarkjs (spike vkeys) and on Monad testnet (eth_call to the deployed pool's
// verifyProof, read-only), checks bad inputs are rejected without killing the server, and measures timings.
//   node test.mjs                 docker run ender-prover pinned to 1 CPU / 3 GiB, test, bench, remove the container
//   node test.mjs --url http://localhost:8080 [--no-bench]
// Needs the spike's node_modules (cd ../spikes/nova-splitkey && npm ci).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const SPIKE = new URL('../spikes/nova-splitkey/', import.meta.url)
const require = createRequire(new URL('package.json', SPIKE))
const { groth16 } = require('snarkjs')
const { MerkleTree } = require('fixed-merkle-tree').MerkleTree ? require('fixed-merkle-tree') : require('fixed-merkle-tree').default
const { createPublicClient, http, parseAbi } = require('viem')
const { poseidonHash2, ZERO_VALUE, toFixedHex } = await import(new URL('src/utils.mjs', SPIKE))
const { newUser, provingKeys, owner, buildTx, sign, witnessInput, commitment, LEVELS } = await import(new URL('src/shielded.mjs', SPIKE))

const args = process.argv.slice(2)
const argUrl = args.includes('--url') ? args[args.indexOf('--url') + 1] : null
const BENCH = !args.includes('--no-bench')
const IMAGE = process.env.IMAGE ?? 'ender-prover'
const RUN_ARGS = (process.env.RUN_ARGS ?? '').split(' ').filter(Boolean) // e.g. RUN_ARGS='-e OMP_NUM_THREADS=1'
const NAME = 'ender-prover-test'
const URL_ = argUrl ?? 'http://127.0.0.1:18080'
const report = {}

// ---------- container (unless --url)
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
if (!argUrl) {
  try { docker('rm', '-f', NAME) } catch {}
  process.on('exit', () => { try { docker('rm', '-f', NAME) } catch {} })
  const t = performance.now()
  docker('run', '-d', '--name', NAME, '--cpus=1', '--memory=3g', '-p', '127.0.0.1:18080:8080', ...RUN_ARGS, IMAGE)
  for (;;) {
    try { if ((await fetch(`${URL_}/health`)).ok) break } catch {}
    await sleep(20)
  }
  report.coldStartMs = Math.round(performance.now() - t)
  console.log(`cold start (docker run -> /health 200): ${report.coldStartMs} ms`)
}

const post = async (body) => {
  const r = await fetch(`${URL_}/prove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) })
  return { status: r.status, json: await r.json() }
}
const timed = async (body) => {
  const t = performance.now()
  const r = await post(body)
  return { ...r, ms: Math.round(performance.now() - t) }
}

// ---------- inputs (as scripts/circuit-test.mjs builds them)
const domain = { chainId: 10143, pool: '0x0000000000000000000000000000000000000001' }
const user = newUser()
const keys = provingKeys(user)
const me = owner(keys)
const notes = Array.from({ length: 12 }, (_, i) => ({ amount: BigInt(i + 1) * 10n ** 6n, blinding: 1000n + BigInt(i), pos: i }))
const tree = new MerkleTree(LEVELS, notes.map((n) => commitment(n.amount, me.ownerKey, n.blinding)), { hashFunction: poseidonHash2, zeroElement: ZERO_VALUE })
const inputs = {}
for (const N of [2, 6, 12]) {
  const real = notes.slice(0, N === 2 ? 1 : N) // 2-in: 1 real + 1 dummy; 6/12: every slot real
  const sum = real.reduce((s, n) => s + n.amount, 0n)
  const tx = buildTx({ me, nIns: N, inputs: real, outputs: [{ amount: sum - 10n ** 4n, to: me }, { amount: 0n, to: me }], extAmount: 0n, fee: 10n ** 4n, deadline: 2n ** 40n, domain })
  inputs[N] = witnessInput(tx, tree, keys, sign(user.authSk, tx.msg))
}
const expectedPublic = (inp) => [inp.root, inp.publicAmount, inp.extDataHash, ...inp.inputNullifier, ...inp.outputCommitment].map(String)

// ---------- first proofs (2-in key loaded at startup; 6 and 12 load lazily here) + verification
const proofs = {}
report.firstProofMs = {}
for (const N of [2, 6, 12]) {
  const r = await timed({ circuit: N, input: inputs[N] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  report.firstProofMs[N] = r.ms
  proofs[N] = r.json
  const vkey = JSON.parse(fs.readFileSync(new URL(`build/transaction${N}_vkey.json`, SPIKE)))
  assert.deepEqual(r.json.publicSignals, expectedPublic(inputs[N]), `${N}-in public signals`)
  assert.equal(await groth16.verify(vkey, r.json.publicSignals, r.json.proof), true, `${N}-in snarkjs verify`)
  for (const k of ['pi_a', 'pi_b', 'pi_c', 'protocol', 'curve']) assert.ok(k in r.json.proof, k)
  console.log(`ok  ${N}-in: first proof ${r.ms} ms, snarkjs groth16.verify = true`)
}
// same shape as snarkjs fullProve (the gateway's current prover)
{
  const f = (p) => fileURLToPath(new URL(p, SPIKE))
  const ref = await groth16.fullProve(inputs[2], f('build/transaction2_js/transaction2.wasm'), f('build/transaction2.zkey'))
  assert.deepEqual(proofs[2].publicSignals, ref.publicSignals)
  assert.deepEqual(Object.keys(proofs[2].proof).sort(), Object.keys(ref.proof).sort())
  console.log('ok  2-in: publicSignals and proof keys identical to snarkjs fullProve')
}

// ---------- on-chain: the deployed testnet pool's verifyProof (eth_call, nothing sent)
{
  const dep = JSON.parse(fs.readFileSync(new URL('deployments/monad-testnet-guarded.json', SPIKE)))
  const client = createPublicClient({ transport: http('https://testnet-rpc.monad.xyz') })
  const abi = parseAbi([
    'struct Proof { bytes proof; bytes32 root; bytes32[] inputNullifiers; bytes32[2] outputCommitments; uint256 publicAmount; bytes32 extDataHash; }',
    'function verifyProof(Proof _args) view returns (bool)',
  ])
  const pack = ({ pi_a, pi_b, pi_c }) => '0x' + [pi_a[0], pi_a[1], pi_b[0][1], pi_b[0][0], pi_b[1][1], pi_b[1][0], pi_c[0], pi_c[1]].map((x) => toFixedHex(x).slice(2)).join('')
  const call = (N, publicAmount) =>
    client.readContract({
      address: dep.pool, abi, functionName: 'verifyProof',
      args: [{ proof: pack(proofs[N].proof), root: toFixedHex(inputs[N].root), inputNullifiers: inputs[N].inputNullifier.map((x) => toFixedHex(x)), outputCommitments: inputs[N].outputCommitment.map((x) => toFixedHex(x)), publicAmount, extDataHash: toFixedHex(inputs[N].extDataHash) }],
    })
  try {
    for (const N of [2, 6, 12]) {
      assert.equal(await call(N, inputs[N].publicAmount), true, `${N}-in on-chain`)
      assert.equal(await call(N, inputs[N].publicAmount + 1n), false, `${N}-in on-chain, tampered`)
      console.log(`ok  ${N}-in: testnet pool ${dep.pool} verifyProof = true (tampered publicAmount = false)`)
    }
    report.onChain = 'ok'
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e
    report.onChain = `skipped (RPC unreachable: ${e.shortMessage ?? e.message})`
    console.log(`--  on-chain check ${report.onChain}`)
  }
}

// ---------- bad inputs: an error each, and the server stays up
{
  const tampered = { ...inputs[2], inputNullifier: [inputs[2].inputNullifier[0] + 1n, inputs[2].inputNullifier[1]] }
  const { nk, ...noNk } = inputs[2]
  const cases = [
    ['circuit 3', { circuit: 3, input: inputs[2] }, 400],
    ['body not JSON', '{"circuit":2,', 400],
    ['no input', { circuit: 2 }, 400],
    ['non-numeric field element', { circuit: 2, input: { ...inputs[2], nk: 'abc' } }, 400],
    ['negative number', { circuit: 2, input: { ...inputs[2], inPathIndices: [-1, 0] } }, 400],
    ['wrong nullifier (constraint fails)', { circuit: 2, input: tampered }, 422],
    ['6-in input as circuit 2', { circuit: 2, input: inputs[6] }, 422],
    ['missing nk', { circuit: 2, input: noNk }, 422],
  ]
  for (const [name, body, status] of cases) {
    const r = await post(body)
    assert.equal(r.status, status, `${name}: ${JSON.stringify(r.json)}`)
    assert.equal(typeof r.json.error, 'string')
    assert.ok(!r.json.error.includes(String(inputs[2].nk)), 'error leaks nk')
    console.log(`ok  rejects ${name}: ${r.status} ${r.json.error.slice(0, 110)}`)
  }
  assert.equal((await fetch(`${URL_}/health`)).status, 200)
  assert.equal((await post({ circuit: 2, input: inputs[2] })).status, 200)
  console.log('ok  server still healthy and proving after the bad inputs')
}

// ---------- warm timings
if (BENCH) {
  report.warmMedianMs = {}
  report.warmRangeMs = {}
  for (const N of [2, 6, 12]) {
    const ms = []
    for (let i = 0; i < 10; i++) {
      const r = await timed({ circuit: N, input: inputs[N] })
      assert.equal(r.status, 200)
      ms.push(r.ms)
    }
    ms.sort((a, b) => a - b)
    report.warmMedianMs[N] = (ms[4] + ms[5]) / 2
    report.warmRangeMs[N] = [ms[0], ms[9]]
    console.log(`warm ${N}-in, n=10: median ${report.warmMedianMs[N]} ms (${ms[0]}-${ms[9]})`)
  }
}
report.health = await (await fetch(`${URL_}/health`)).json()
if (!argUrl) {
  report.serverLog = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' }).stderr.trim().split('\n')
}
console.log(JSON.stringify(report, null, 2))
console.log('ALL PASS')
process.exit(0) // snarkjs/circomlibjs worker threads would keep the process alive

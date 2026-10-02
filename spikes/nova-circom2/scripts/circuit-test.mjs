// Witness-level checks of the ported circuits (no keys needed): valid join-splits pass and satisfy the R1CS;
// each Nova constraint family rejects a violating witness.
import assert from 'node:assert/strict'
import { wtns } from 'snarkjs'
import MerkleTreeMod from 'fixed-merkle-tree'
import { Keypair } from '../src/keypair.mjs'
import { Utxo } from '../src/utxo.mjs'
import { poseidonHash2, ZERO_VALUE, FIELD_SIZE } from '../src/utils.mjs'

const { MerkleTree } = MerkleTreeMod
const tree = new MerkleTree(23, [], { hashFunction: poseidonHash2, zeroElement: ZERO_VALUE })
const bob = new Keypair()
const a = new Utxo({ amount: 10n, keypair: bob })
const b = new Utxo({ amount: 15n, keypair: bob })
tree.bulkInsert([a.getCommitment(), b.getCommitment()])
a.index = 0
b.index = 1

function build(ins, outs, publicAmount = 0n, over = {}) {
  const n = ins.length
  const input = {
    root: tree.root,
    publicAmount: ((publicAmount % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE,
    extDataHash: 12345n,
    inputNullifier: ins.map((x) => x.getNullifier()),
    inAmount: ins.map((x) => x.amount),
    inPrivateKey: ins.map((x) => x.keypair.privkey),
    inBlinding: ins.map((x) => x.blinding),
    inPathIndices: ins.map((x) => x.index ?? 0),
    inPathElements: ins.map((x) => (x.amount > 0n ? tree.path(x.index).pathElements : new Array(23).fill(0))),
    outputCommitment: outs.map((x) => x.getCommitment()),
    outAmount: outs.map((x) => x.amount),
    outPubkey: outs.map((x) => x.keypair.pubkey),
    outBlinding: outs.map((x) => x.blinding),
  }
  return { circuit: `transaction${n}`, input: { ...input, ...over } }
}

async function witness({ circuit, input }) {
  const out = { type: 'mem' }
  await wtns.calculate(input, `build/${circuit}_js/${circuit}.wasm`, out)
  return out
}
const ok = async (name, t) => { await witness(t); console.log('ok   ', name) }
const bad = async (name, t) => {
  await assert.rejects(witness(t), /Assert Failed|Error in template/, name)
  console.log('fails', name, '(expected)')
}

const z = () => new Utxo()
const merge = build([a, b], [new Utxo({ amount: 25n, keypair: bob }), z()])
await ok('deposit 10 (2 empty inputs)', build([z(), z()], [new Utxo({ amount: 10n, keypair: bob }), z()], 10n))
await ok('merge 10+15 -> 25', merge)
await ok('withdraw 12 + 8 change (publicAmount -12)', build([a, b], [new Utxo({ amount: 13n }), z()], -12n))
await ok('16-in merge', build([a, b, ...Array.from({ length: 14 }, z)], [new Utxo({ amount: 25n }), z()]))

// R1CS satisfaction of a real witness (snarkjs wtns check)
const w = await witness(merge)
assert.equal(await wtns.check('build/transaction2.r1cs', w), true)
console.log('ok    merge witness satisfies transaction2.r1cs')

await bad('sum mismatch (create 1 from nothing)', build([a, b], [new Utxo({ amount: 26n }), z()]))
await bad('duplicate input (same nullifier twice)', build([a, a], [new Utxo({ amount: 20n }), z()]))
await bad('out amount >= 2^248 (field wraparound: 10+15 -> 26 + (p-1))', build([a, b], [new Utxo({ amount: 26n }), new Utxo({ amount: FIELD_SIZE - 1n })]))
await bad('wrong owner key', build([new Utxo({ amount: 10n, keypair: new Keypair(), blinding: a.blinding, index: 0 }), b], [new Utxo({ amount: 25n }), z()]))
await bad('wrong nullifier', { ...merge, input: { ...merge.input, inputNullifier: [merge.input.inputNullifier[0] + 1n, merge.input.inputNullifier[1]] } })
await bad('wrong root with non-zero input', { ...merge, input: { ...merge.input, root: 1n } })
await bad('wrong path index', { ...merge, input: { ...merge.input, inPathIndices: [1, 0] } })
await bad('output commitment mismatch', { ...merge, input: { ...merge.input, outputCommitment: [1n, merge.input.outputCommitment[1]] } })
await bad('inflated input amount not in tree', build([new Utxo({ amount: 30n, keypair: bob, blinding: a.blinding, index: 0 }), b], [new Utxo({ amount: 45n }), z()]))
console.log('all circuit checks passed')
process.exit(0)

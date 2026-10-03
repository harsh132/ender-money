// Witness-level checks of the split-key transaction2, 6 and 12 (no proving key needed): valid join-splits pass and
// satisfy the R1CS; every constraint family, old (Nova) and new (split keys), rejects a violating witness.
import assert from 'node:assert/strict'
import { wtns } from 'snarkjs'
import MerkleTreeMod from 'fixed-merkle-tree'
import { poseidonHash2, ZERO_VALUE, FIELD_SIZE } from '../src/utils.mjs'
import { newUser, provingKeys, owner, buildTx, sign, witnessInput, commitment, LEVELS } from '../src/shielded.mjs'

const { MerkleTree } = MerkleTreeMod
const domain = { chainId: 31337, pool: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }
const mk = () => {
  const user = newUser()
  return { user, me: owner(provingKeys(user)), keys: provingKeys(user) }
}
const alice = mk()
const bob = mk()
const carol = mk()

// notes in the tree: Alice 10 @0, 15 @1 and ten more @2..11, Carol 7 @12, Alice (p-5) @13 (only reachable by
// skipping the range check)
const aliceNotes = [10n, 15n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 11n, 12n, 13n].map((amount, i) => ({ amount, blinding: 100n + BigInt(i), pos: i }))
const [a10, a15] = aliceNotes
const c7 = { amount: 7n, blinding: 333n, pos: 12 }
const aHuge = { amount: FIELD_SIZE - 5n, blinding: 444n, pos: 13 }
const tree = new MerkleTree(
  LEVELS,
  [...aliceNotes.map((n) => commitment(n.amount, alice.me.ownerKey, n.blinding)), commitment(c7.amount, carol.me.ownerKey, c7.blinding), commitment(aHuge.amount, alice.me.ownerKey, aHuge.blinding)],
  { hashFunction: poseidonHash2, zeroElement: ZERO_VALUE },
)

const out = (amount, who) => ({ amount, to: who.me })
const total = (ns) => ns.reduce((s, n) => s + n.amount, 0n)
let passed = 0
let rejected = 0

for (const N of [2, 6, 12]) {
  const wasm = `build/transaction${N}_js/transaction${N}.wasm`
  const build = (who, inputs, outputs, extra = {}) => {
    const tx = buildTx({ me: who.me, nIns: N, inputs, outputs, deadline: 2n ** 40n, domain, ...extra })
    return { tx, input: witnessInput(tx, tree, who.keys, sign(who.user.authSk, tx.msg)) }
  }
  const witness = async (input) => {
    const w = { type: 'mem' }
    await wtns.calculate(input, wasm, w)
    return w
  }
  const ok = async (name, input) => {
    await witness(input)
    passed++
    console.log(`ok    [${N}-in]`, name)
  }
  const bad = async (name, input) => {
    await assert.rejects(witness(input), /Assert Failed|Error in template/, name)
    rejected++
    console.log(`fails [${N}-in]`, name, '(expected)')
  }

  const full = aliceNotes.slice(0, N) // every slot a real note
  const sum = total(full)
  const merge = build(alice, full, [out(sum, alice), out(0n, alice)])
  const pay = build(alice, [a10], [out(4n, bob), out(6n, alice)])
  console.log(`== transaction${N}`)
  await ok(`deposit 10 (${N} dummy inputs, owner keys)`, build(alice, [], [out(10n, alice), out(0n, alice)], { extAmount: 10n }).input)
  await ok(`merge ${N} real notes -> ${sum}`, merge.input)
  await ok(`pay 4 to Bob from the 10 note, 6 change (1 real + ${N - 1} dummies)`, pay.input)
  await ok('withdraw 12 (publicAmount -12), 1 fee, 12 change (10 + 15 + dummies)', build(alice, [a10, a15], [out(12n, alice), out(0n, alice)], { extAmount: -12n, fee: 1n }).input)
  assert.equal(await wtns.check(`build/transaction${N}.r1cs`, await witness(merge.input)), true)
  passed++
  console.log(`ok    [${N}-in] merge witness satisfies transaction${N}.r1cs`)

  const sigOf = (input, user, msg) => {
    // replace the signature fields with a signature by `user` over `msg`
    const s = witnessInput(merge.tx, tree, alice.keys, sign(user.authSk, msg))
    return { ...input, sigR8x: s.sigR8x, sigR8y: s.sigR8y, sigS: s.sigS }
  }
  const swap01 = (xs) => [xs[1], xs[0], ...xs.slice(2)]

  console.log('-- Nova constraint families')
  await bad('sum mismatch (create 1 from nothing)', build(alice, full, [out(sum + 1n, alice), out(0n, alice)]).input)
  {
    const dup = [a10, a10, ...full.slice(2)]
    await bad('duplicate input (same nullifier twice)', build(alice, dup, [out(total(dup), alice), out(0n, alice)]).input)
  }
  await bad('out amount >= 2^248 (sum+1 and p-1)', build(alice, full, [out(sum + 1n, alice), out(FIELD_SIZE - 1n, alice)]).input)
  await bad('wrong nullifier', { ...merge.input, inputNullifier: [merge.input.inputNullifier[0] + 1n, ...merge.input.inputNullifier.slice(1)] })
  await bad('wrong root with non-zero input', { ...merge.input, root: 1n })
  await bad('wrong path index', { ...merge.input, inPathIndices: swap01(merge.input.inPathIndices) })
  await bad('output commitment mismatch', { ...merge.input, outputCommitment: [1n, merge.input.outputCommitment[1]] })
  await bad('inflated input amount (commitment not in tree)', build(alice, [{ ...a10, amount: 30n }, ...full.slice(1)], [out(sum + 20n, alice), out(0n, alice)]).input)

  console.log('-- new: input range check (fix 1)')
  await bad('input amount p-5 that is in the tree: (p-5) + 10 -> 5', build(alice, [aHuge, a10], [out(5n, alice), out(0n, alice)]).input)

  console.log('-- new: spending authority')
  await bad('no signature (gateway has nk + viewing key only)', { ...merge.input, sigR8x: 0n, sigR8y: 1n, sigS: 0n })
  await bad("signature by another key (Bob signs Alice's spend)", sigOf(merge.input, bob.user, merge.tx.msg))
  await bad('signature over a different message', sigOf(merge.input, alice.user, merge.tx.msg + 1n))
  {
    // gateway swaps the recipient after the phone signed: rebuild with Carol as recipient, keep Alice's signature
    const t = buildTx({ me: alice.me, nIns: N, inputs: [a10], outputs: [out(4n, carol), out(6n, alice)], deadline: 2n ** 40n, domain })
    await bad('recipient swapped after signing', { ...witnessInput(t, tree, alice.keys, Buffer.alloc(64)), sigR8x: pay.input.sigR8x, sigR8y: pay.input.sigR8y, sigS: pay.input.sigS })
  }
  await bad('extDataHash changed after signing (fee/recipient/ciphertext/chain/pool)', { ...pay.input, extDataHash: pay.input.extDataHash + 1n })
  await bad('publicAmount changed after signing', { ...pay.input, publicAmount: pay.input.publicAmount + 1n })
  {
    // attacker uses its own authority key (valid signature) on Alice's notes: ownerKey differs -> commitments not in tree
    const keys = { ...alice.keys, Ax: bob.keys.Ax, Ay: bob.keys.Ay }
    const t = buildTx({ me: owner(keys), nIns: N, inputs: [a10], outputs: [out(10n, bob), out(0n, bob)], deadline: 2n ** 40n, domain })
    await bad("own authority key on Alice's notes (Alice's nk)", witnessInput(t, tree, keys, sign(bob.user.authSk, t.msg)))
  }
  // mixed owners: Alice signs a tx spending her 10 and Carol's 7; the circuit has one ownerKey for all inputs
  await bad("mixed owners (Alice's note + Carol's note)", build(alice, [a10, c7], [out(17n, alice), out(0n, alice)]).input)
  await bad('wrong nk (gateway guesses nk)', { ...merge.input, nk: merge.input.nk + 1n })
  await bad('authority key off the curve', { ...merge.input, authAx: merge.input.authAx + 1n })
}
console.log(`all circuit checks passed: ${passed} valid, ${rejected} rejected`)
process.exit(0)

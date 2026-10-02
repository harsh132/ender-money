// Port of tornado-nova src/index.js + src/prover.js (hardhat/ethers -> viem, snarkjs 0.7).
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { groth16 } from 'snarkjs'
import MerkleTreeMod from 'fixed-merkle-tree'
import { toFixedHex, poseidonHash2, getExtDataHash, FIELD_SIZE, ZERO_VALUE, shuffle } from './utils.mjs'
import { Utxo } from './utxo.mjs'

const { MerkleTree } = MerkleTreeMod
export const MERKLE_TREE_HEIGHT = 23
const BUILD = fileURLToPath(new URL('../build/', import.meta.url))

export const poolEvents = [
  { type: 'event', name: 'NewCommitment', inputs: [{ name: 'commitment', type: 'bytes32' }, { name: 'index', type: 'uint256' }, { name: 'encryptedOutput', type: 'bytes' }] },
  { type: 'event', name: 'NewNullifier', inputs: [{ name: 'nullifier', type: 'bytes32' }] },
]

export async function getCommitmentEvents({ client, pool }) {
  const logs = await client.getContractEvents({ address: pool, abi: poolEvents, eventName: 'NewCommitment', fromBlock: 0n })
  return logs.map((l) => l.args).sort((a, b) => Number(a.index - b.index))
}

export async function buildMerkleTree({ client, pool }) {
  const leaves = (await getCommitmentEvents({ client, pool })).map((e) => BigInt(e.commitment))
  return new MerkleTree(MERKLE_TREE_HEIGHT, leaves, { hashFunction: poseidonHash2, zeroElement: ZERO_VALUE })
}

export const proveTimes = [] // { circuit, ms }

export async function prove(input, circuit) {
  const t = performance.now()
  const { proof } = await groth16.fullProve(input, `${BUILD}${circuit}_js/${circuit}.wasm`, `${BUILD}${circuit}.zkey`)
  proveTimes.push({ circuit, ms: Math.round(performance.now() - t) })
  // Same packing as Nova's prover.js; equals abi.encode(uint[2] a, uint[2][2] b, uint[2] c) with b's limbs swapped for the EVM.
  return (
    '0x' +
    [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]
      .map((x) => toFixedHex(x).slice(2))
      .join('')
  )
}

export async function getProof({ inputs, outputs, tree, extAmount, fee, recipient, relayer }) {
  inputs = shuffle(inputs)
  outputs = shuffle(outputs)

  const inPathIndices = []
  const inPathElements = []
  for (const input of inputs) {
    if (input.amount > 0n) {
      input.index = tree.indexOf(input.getCommitment())
      if (input.index < 0) throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      inPathIndices.push(input.index)
      inPathElements.push(tree.path(input.index).pathElements)
    } else {
      inPathIndices.push(0)
      inPathElements.push(new Array(tree.levels).fill(0))
    }
  }

  const extData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: BigInt(extAmount),
    relayer: toFixedHex(relayer, 20),
    fee: BigInt(fee),
    encryptedOutput1: outputs[0].encrypt(),
    encryptedOutput2: outputs[1].encrypt(),
  }

  const extDataHash = getExtDataHash(extData)
  const input = {
    root: tree.root,
    inputNullifier: inputs.map((x) => x.getNullifier()),
    outputCommitment: outputs.map((x) => x.getCommitment()),
    publicAmount: (((BigInt(extAmount) - BigInt(fee)) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE,
    extDataHash,
    inAmount: inputs.map((x) => x.amount),
    inPrivateKey: inputs.map((x) => x.keypair.privkey),
    inBlinding: inputs.map((x) => x.blinding),
    inPathIndices,
    inPathElements,
    outAmount: outputs.map((x) => x.amount),
    outBlinding: outputs.map((x) => x.blinding),
    outPubkey: outputs.map((x) => x.keypair.pubkey),
  }

  const proof = await prove(input, `transaction${inputs.length}`)
  const args = {
    proof,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())),
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())),
    publicAmount: input.publicAmount,
    extDataHash: toFixedHex(extDataHash),
  }
  return { args, extData }
}

/** Pads to 2 or 16 inputs and 2 outputs; extAmount = fee + sum(outputs) - sum(inputs) unless overridden. */
export async function prepareTransaction({ client, pool, inputs = [], outputs = [], fee = 0n, recipient = 0, relayer = 0, extAmount }) {
  if (inputs.length > 16 || outputs.length > 2) throw new Error('Incorrect inputs/outputs count')
  inputs = [...inputs]
  outputs = [...outputs]
  while (inputs.length !== 2 && inputs.length < 16) inputs.push(new Utxo())
  while (outputs.length < 2) outputs.push(new Utxo())

  const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0n)
  extAmount ??= BigInt(fee) + sum(outputs) - sum(inputs)

  return getProof({ inputs, outputs, tree: await buildMerkleTree({ client, pool }), extAmount, fee, recipient, relayer })
}

/** Finds a keypair's unspent notes by trial-decrypting every NewCommitment log. */
export async function findNotes({ client, pool, keypair }) {
  const notes = []
  for (const e of await getCommitmentEvents({ client, pool })) {
    let utxo
    try {
      utxo = Utxo.decrypt(keypair, e.encryptedOutput, Number(e.index))
    } catch {
      continue
    }
    if (utxo.getCommitment() !== BigInt(e.commitment)) continue // not ours / bogus ciphertext
    if (utxo.amount === 0n) continue
    const spent = await client.readContract({
      address: pool,
      abi: [{ type: 'function', name: 'isSpent', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }],
      functionName: 'isSpent',
      args: [toFixedHex(utxo.getNullifier())],
    })
    if (!spent) notes.push(utxo)
  }
  return notes
}

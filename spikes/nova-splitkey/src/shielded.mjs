// Split-key note logic shared by the phone and the gateway. Both call buildTx with the same inputs and must get
// identical nullifiers, output notes, ciphertexts, extDataHash and signed message: that is what lets a 64-byte
// signature over SMS authorize a transaction the gateway then proves.
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import { buildEddsa } from 'circomlibjs'
import { groth16 } from 'snarkjs'
import { keccak256, zeroAddress, encodeAbiParameters } from 'viem'
import { CIRCUITS } from './select.mjs'
import { poseidonHash, getExtDataHash, FIELD_SIZE, toBuffer, toFixedHex, randomBN } from './utils.mjs'

const eddsa = await buildEddsa()
const F = eddsa.babyJub.F
const BUILD = fileURLToPath(new URL('../build/', import.meta.url))
export const LEVELS = 23

const b32 = (x) => toBuffer(x, 32)
const kdf = (tag, ...xs) => Buffer.from(keccak256(Buffer.concat([Buffer.from(tag), ...xs.map(b32)])).slice(2), 'hex')
const big = (buf) => BigInt('0x' + Buffer.from(buf).toString('hex'))

// ---------- keys

/** All of a user's secrets. Only the phone ever holds authSk. */
export const newUser = () => ({ authSk: crypto.randomBytes(32), nk: randomBN(31), viewSk: crypto.randomBytes(32) })

/** Everything but the authority private key: what the gateway gets at onboarding (nk + viewing key + authority pubkey). */
export function provingKeys({ authSk, nk, viewSk }) {
  const [Ax, Ay] = eddsa.prv2pub(authSk).map((p) => F.toObject(p))
  return { nk, viewSk, Ax, Ay }
}

/** Derived public values: ownerKey = Poseidon(Ax, Ay, Poseidon(nk)); encPk = x25519(viewSk). */
export function owner({ nk, viewSk, Ax, Ay }) {
  return {
    nk,
    viewSk,
    Ax,
    Ay,
    ownerKey: poseidonHash([Ax, Ay, poseidonHash([nk])]),
    encPk: Buffer.from(nacl.box.keyPair.fromSecretKey(viewSk).publicKey),
  }
}

/** Shielded address, 64 bytes: ownerKey || x25519 encryption key. Off-chain only. */
export const packAddress = ({ ownerKey, encPk }) => Buffer.concat([b32(ownerKey), Buffer.from(encPk)])
export function unpackAddress(buf) {
  if (buf.length !== 64) throw new Error('shielded address must be 64 bytes')
  return { ownerKey: big(buf.subarray(0, 32)), encPk: Buffer.from(buf.subarray(32)) }
}

// ---------- notes

export const commitment = (amount, ownerKey, blinding) => poseidonHash([amount, ownerKey, blinding])
export const nullifier = (nk, c, pos) => poseidonHash([nk, c, pos])

/**
 * Deterministic note encryption (Nova's x25519-xsalsa20-poly1305 box, 135 bytes: nonce 24 | ephemeral
 * pubkey 32 | box 79; plaintext amount 31 + blinding 32, the blinding is a full field element). Ephemeral key and nonce come from the sender's nk and the note's commitment, so the phone
 * can reproduce the gateway's ciphertext (it is inside extDataHash, which the phone signs). A key is reused only
 * for the same commitment, i.e. the same plaintext.
 */
export function encryptNote({ amount, blinding, commitment: c }, encPk, nk) {
  const eph = nacl.box.keyPair.fromSecretKey(kdf('ender/note-eph', nk, c))
  const nonce = kdf('ender/note-nonce', nk, c).subarray(0, 24)
  const box = nacl.box(Buffer.concat([toBuffer(amount, 31), toBuffer(blinding, 32)]), nonce, encPk, eph.secretKey)
  return '0x' + Buffer.concat([nonce, eph.publicKey, box]).toString('hex')
}

export function decryptNote(data, viewSk) {
  const b = Buffer.from(data.slice(2), 'hex')
  if (b.length < 56 + 16) return null
  const pt = nacl.box.open(b.subarray(56), b.subarray(0, 24), b.subarray(24, 56), viewSk)
  return pt && pt.length === 63 ? { amount: big(pt.subarray(0, 31)), blinding: big(pt.subarray(31)) } : null
}

// ---------- the transaction both sides build

/**
 * me: owner(...) of the spender. nIns: circuit size (2, 6 or 12). inputs: 0-nIns notes {amount, blinding, pos}.
 * outputs: exactly 2 {amount, to: {ownerKey, encPk} | NULL_OWNER}.
 * Dummy inputs (amount 0, root check skipped) use the owner's keys; their blinding derives from the first real
 * nullifier (random only when there is no real input, i.e. a deposit).
 * Output blinding_i = Poseidon(nk, nullifier0, nullifier1, i).
 * Signed message: Poseidon(nullifier[0..nIns), commitment0, commitment1, extDataHash, publicAmount), at most 16 inputs.
 */
export function buildTx({ me, nIns = 2, inputs, outputs, extAmount = 0n, fee = 0n, recipient = zeroAddress, relayer = zeroAddress, deadline, domain }) {
  if (!CIRCUITS.includes(nIns) || inputs.length > nIns || outputs.length !== 2) throw new Error(`transaction${nIns}: 0-${nIns} inputs, 2 outputs`)
  const ins = [...inputs]
    .sort((a, b) => a.pos - b.pos)
    .map((n) => {
      const c = commitment(n.amount, me.ownerKey, n.blinding)
      return { amount: BigInt(n.amount), blinding: n.blinding, pos: n.pos, commitment: c, nullifier: nullifier(me.nk, c, n.pos) }
    })
  addDummies(me, ins, nIns)
  const blindingOf = (i) => poseidonHash([me.nk, ins[0].nullifier, ins[1].nullifier, i])
  return withMsg(ins, seal({ nk: me.nk, outputs, blindingOf, extAmount, fee, recipient, relayer, deadline, domain }))
}

function addDummies(me, ins, nIns) {
  while (ins.length < nIns) {
    const blinding = ins.length ? poseidonHash([me.nk, ins[0].nullifier, ins.length]) : randomBN()
    const c = commitment(0n, me.ownerKey, blinding)
    ins.push({ amount: 0n, blinding, pos: 0, commitment: c, nullifier: nullifier(me.nk, c, 0) })
  }
}

/** An empty output: amount 0, owner key 0, blinding 0, no ciphertext. Its commitment is the pool's NULL_COMMITMENT. */
export const NULL_OWNER = Object.freeze({ ownerKey: 0n, encPk: null })
export const NULL_COMMITMENT = commitment(0n, 0n, 0n)

/** A withdrawal's outputs: [0 to self, change], or two null outputs when there is no change (no leaves, ~860k less gas). */
export const withdrawOutputs = (change) =>
  change.amount > 0n ? [{ amount: 0n, to: change.to }, change] : [{ amount: 0n, to: NULL_OWNER }, { amount: 0n, to: NULL_OWNER }]

/** Output notes, extData, extDataHash, publicAmount. nk keys the deterministic note encryption. */
function seal({ nk, outputs, blindingOf, extAmount, fee, recipient, relayer, deadline, domain }) {
  const outs = outputs.map((o, i) => {
    if (o.to === NULL_OWNER && BigInt(o.amount) !== 0n) throw new Error('a null output carries no amount')
    const blinding = o.to === NULL_OWNER ? 0n : blindingOf(i)
    return { amount: BigInt(o.amount), to: o.to, blinding, commitment: commitment(o.amount, o.to.ownerKey, blinding) }
  })
  const enc = (o) => (o.to === NULL_OWNER ? '0x' : encryptNote(o, o.to.encPk, nk))
  const extData = {
    recipient,
    extAmount: BigInt(extAmount),
    relayer,
    fee: BigInt(fee),
    deadline: BigInt(deadline),
    encryptedOutput1: enc(outs[0]),
    encryptedOutput2: enc(outs[1]),
  }
  const extDataHash = getExtDataHash(extData, domain)
  const publicAmount = (((extData.extAmount - extData.fee) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE
  return { outs, extData, extDataHash, publicAmount }
}

const withMsg = (ins, s) => ({ ins, ...s, msg: poseidonHash([...ins.map((x) => x.nullifier), s.outs[0].commitment, s.outs[1].commitment, s.extDataHash, s.publicAmount]) })

// ---------- EIP-3009 deposits

/** Per-quote seed for deposit blindings: unique per (quote id, exp), known to the phone and the gateway. */
export const quoteSeed = (id, exp) => (BigInt(exp) << 32n) | BigInt('0x' + Buffer.from(id).toString('hex'))

/**
 * A deposit as the depositor builds it alone (no inputs, no gateway keys): outputs, extData (recipient 0,
 * extAmount = outputs + fee), and the EIP-3009 nonce keccak256(extDataHash, commitment0, commitment1).
 * Output blinding_i = Poseidon(nk, seed, i). value is what the authorization moves: deposit + fee.
 */
export function buildDeposit({ me, outputs, fee = 0n, relayer = zeroAddress, deadline, seed, domain }) {
  const value = outputs.reduce((s, o) => s + BigInt(o.amount), 0n) + BigInt(fee)
  const s = seal({ nk: me.nk, outputs, blindingOf: (i) => poseidonHash([me.nk, seed, i]), extAmount: value, fee, recipient: zeroAddress, relayer, deadline, domain })
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [toFixedHex(s.extDataHash), toFixedHex(s.outs[0].commitment), toFixedHex(s.outs[1].commitment)]))
  return { ...s, value, nonce }
}

/** The gateway completes a deposit: dummy inputs under its own keys (gw = owner(...)), and the message its own EdDSA key signs. */
export const depositTx = (gw, dep, nIns = 2) => {
  const ins = []
  addDummies(gw, ins, nIns)
  return withMsg(ins, dep)
}

/** EIP-712 typed data of AUSD's ReceiveWithAuthorization. ausd: { address, name, version }. */
export const receiveAuth = (ausd, chainId, { from, to, value, validBefore, nonce }) => ({
  domain: { name: ausd.name, version: ausd.version, chainId, verifyingContract: ausd.address },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization',
  message: { from, to, value, validAfter: 0n, validBefore: BigInt(validBefore), nonce },
})

// ---------- spending authority (phone)

/** 64 bytes: compressed R8 (32) || S (32, little-endian), circomlibjs packSignature. */
export const sign = (authSk, msg) => Buffer.from(eddsa.packSignature(eddsa.signPoseidon(authSk, F.e(msg))))

// circomlibjs unpackPoint clears the sign bit of its input buffer in place, so a second unpack of the same bytes
// gives the wrong R8 half the time. Always unpack a copy.
const unpackSig = (sig) => eddsa.unpackSignature(Uint8Array.from(sig))

export function verifySig(sig, msg, { Ax, Ay }) {
  try {
    return eddsa.verifyPoseidon(F.e(msg), unpackSig(sig), [F.e(Ax), F.e(Ay)])
  } catch {
    return false
  }
}

// ---------- proving (gateway)

/** Circuit input. tree: fixed-merkle-tree instance; keys: {nk, Ax, Ay}; sig: 64 bytes (garbage allowed, for negative tests). */
export function witnessInput(tx, tree, keys, sig) {
  let R8 = [0n, 0n]
  let S = 0n
  try {
    const s = unpackSig(sig)
    if (s.R8) R8 = s.R8.map((p) => F.toObject(p))
    S = s.S
  } catch {}
  return {
    root: tree.root,
    publicAmount: tx.publicAmount,
    extDataHash: tx.extDataHash,
    inputNullifier: tx.ins.map((x) => x.nullifier),
    inAmount: tx.ins.map((x) => x.amount),
    inBlinding: tx.ins.map((x) => x.blinding),
    inPathIndices: tx.ins.map((x) => x.pos),
    inPathElements: tx.ins.map((x) => (x.amount > 0n ? tree.path(x.pos).pathElements : new Array(LEVELS).fill(0))),
    nk: keys.nk,
    authAx: keys.Ax,
    authAy: keys.Ay,
    sigR8x: R8[0],
    sigR8y: R8[1],
    sigS: S,
    outputCommitment: tx.outs.map((x) => x.commitment),
    outAmount: tx.outs.map((x) => x.amount),
    outPubkey: tx.outs.map((x) => x.to.ownerKey),
    outBlinding: tx.outs.map((x) => x.blinding),
  }
}

export const proveTimes = []

/** Groth16 proof packed as the pool expects (Nova's limb order), plus the Proof struct for transact(). The circuit follows the input count. */
export async function prove(input) {
  const t = performance.now()
  const c = `transaction${input.inputNullifier.length}`
  const { proof } = await groth16.fullProve(input, `${BUILD}${c}_js/${c}.wasm`, `${BUILD}${c}.zkey`)
  proveTimes.push({ nIns: input.inputNullifier.length, ms: Math.round(performance.now() - t) })
  const packed =
    '0x' +
    [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]
      .map((x) => toFixedHex(x).slice(2))
      .join('')
  return {
    proof: packed,
    root: toFixedHex(input.root),
    inputNullifiers: input.inputNullifier.map((x) => toFixedHex(x)),
    outputCommitments: input.outputCommitment.map((x) => toFixedHex(x)),
    publicAmount: input.publicAmount,
    extDataHash: toFixedHex(input.extDataHash),
  }
}

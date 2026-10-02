// Port of tornado-nova src/{utils,keypair,utxo,prover,index}.js to plain ethers v5 (no hardhat).
// Changes vs Nova: ExtData drops isL1Withdrawal/l1Fee; tree height 23; artifacts read from build/.
const crypto = require('crypto')
const path = require('path')
const { ethers } = require('ethers')
const { BigNumber } = ethers
const { poseidon } = require('circomlib')
const MerkleTree = require('fixed-merkle-tree')
const { encrypt, decrypt, getEncryptionPublicKey } = require('eth-sig-util')
const { groth16 } = require('snarkjs')

const MERKLE_TREE_HEIGHT = 23
const BUILD = path.join(__dirname, '..', 'build')
const FIELD_SIZE = BigNumber.from('21888242871839275222246405745257275088548364400416034343698204186575808495617')

// ---- utils.js
const poseidonHash = (items) => BigNumber.from(poseidon(items.map((x) => BigNumber.from(x).toBigInt())).toString())
const poseidonHash2 = (a, b) => poseidonHash([a, b])
const randomBN = (nbytes = 31) => BigNumber.from(crypto.randomBytes(nbytes))
function toFixedHex(number, length = 32) {
  let result =
    '0x' +
    (number instanceof Buffer ? number.toString('hex') : BigNumber.from(number).toHexString().replace('0x', '')).padStart(length * 2, '0')
  if (result.indexOf('-') > -1) result = '-' + result.replace('-', '')
  return result
}
const toBuffer = (value, length) => Buffer.from(BigNumber.from(value).toHexString().slice(2).padStart(length * 2, '0'), 'hex')
const EXT_DATA_TYPE =
  'tuple(address recipient,int256 extAmount,address relayer,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2)'
function getExtDataHash(extData) {
  const encoded = ethers.utils.defaultAbiCoder.encode([EXT_DATA_TYPE], [extData])
  return BigNumber.from(ethers.utils.keccak256(encoded)).mod(FIELD_SIZE)
}
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}
// BigNumber -> decimal string, recursively (snarkjs wants strings/bigints)
const toCircuit = (v) => (Array.isArray(v) ? v.map(toCircuit) : BigNumber.from(v).toString())

// ---- keypair.js
function packEncryptedMessage(m) {
  const nonce = Buffer.from(m.nonce, 'base64')
  const epk = Buffer.from(m.ephemPublicKey, 'base64')
  const ct = Buffer.from(m.ciphertext, 'base64')
  return '0x' + Buffer.concat([Buffer.alloc(24 - nonce.length), nonce, Buffer.alloc(32 - epk.length), epk, ct]).toString('hex')
}
function unpackEncryptedMessage(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  return {
    version: 'x25519-xsalsa20-poly1305',
    nonce: b.slice(0, 24).toString('base64'),
    ephemPublicKey: b.slice(24, 56).toString('base64'),
    ciphertext: b.slice(56).toString('base64'),
  }
}
class Keypair {
  constructor(privkey = ethers.Wallet.createRandom().privateKey) {
    this.privkey = privkey
    this.pubkey = poseidonHash([this.privkey])
    this.encryptionKey = getEncryptionPublicKey(privkey.slice(2))
  }
  toString() {
    return toFixedHex(this.pubkey) + Buffer.from(this.encryptionKey, 'base64').toString('hex')
  }
  address() {
    return this.toString()
  }
  static fromString(str) {
    if (str.length === 130) str = str.slice(2)
    if (str.length !== 128) throw new Error('Invalid key length')
    return Object.assign(new Keypair(), {
      privkey: null,
      pubkey: BigNumber.from('0x' + str.slice(0, 64)),
      encryptionKey: Buffer.from(str.slice(64, 128), 'hex').toString('base64'),
    })
  }
  sign(commitment, merklePath) {
    return poseidonHash([this.privkey, commitment, merklePath])
  }
  encrypt(bytes) {
    return packEncryptedMessage(encrypt(this.encryptionKey, { data: bytes.toString('base64') }, 'x25519-xsalsa20-poly1305'))
  }
  decrypt(data) {
    return Buffer.from(decrypt(unpackEncryptedMessage(data), this.privkey.slice(2)), 'base64')
  }
}

// ---- utxo.js
class Utxo {
  constructor({ amount = 0, keypair = new Keypair(), blinding = randomBN(), index = null } = {}) {
    this.amount = BigNumber.from(amount)
    this.blinding = BigNumber.from(blinding)
    this.keypair = keypair
    this.index = index
  }
  getCommitment() {
    if (!this._commitment) this._commitment = poseidonHash([this.amount, this.keypair.pubkey, this.blinding])
    return this._commitment
  }
  getNullifier() {
    if (!this._nullifier) {
      if (this.amount.gt(0) && (this.index === undefined || this.index === null || !this.keypair.privkey)) {
        throw new Error('Can not compute nullifier without utxo index or private key')
      }
      const signature = this.keypair.privkey ? this.keypair.sign(this.getCommitment(), this.index || 0) : 0
      this._nullifier = poseidonHash([this.getCommitment(), this.index || 0, signature])
    }
    return this._nullifier
  }
  encrypt() {
    return this.keypair.encrypt(Buffer.concat([toBuffer(this.amount, 31), toBuffer(this.blinding, 31)]))
  }
  static decrypt(keypair, data, index) {
    const buf = keypair.decrypt(data)
    return new Utxo({
      amount: BigNumber.from('0x' + buf.slice(0, 31).toString('hex')),
      blinding: BigNumber.from('0x' + buf.slice(31, 62).toString('hex')),
      keypair,
      index,
    })
  }
}

// ---- prover.js
const timings = []
async function prove(input, n) {
  const t = Date.now()
  const { proof } = await groth16.fullProve(input, path.join(BUILD, `transaction${n}.wasm`), path.join(BUILD, `transaction${n}.zkey`))
  timings.push({ circuit: n, ms: Date.now() - t })
  const p = [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]
  return '0x' + p.map((x) => toFixedHex(x).slice(2)).join('')
}

// ---- index.js
async function buildMerkleTree(pool) {
  const events = await pool.queryFilter(pool.filters.NewCommitment(), 0)
  const leaves = events.sort((a, b) => a.args.index - b.args.index).map((e) => toFixedHex(e.args.commitment))
  return new MerkleTree(MERKLE_TREE_HEIGHT, leaves, { hashFunction: poseidonHash2 })
}

async function getProof({ inputs, outputs, tree, extAmount, fee, recipient, relayer }) {
  inputs = shuffle(inputs)
  outputs = shuffle(outputs)
  const inPathIndices = []
  const inPathElements = []
  for (const input of inputs) {
    if (input.amount.gt(0)) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
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
    extAmount: toFixedHex(extAmount),
    relayer: toFixedHex(relayer, 20),
    fee: toFixedHex(fee),
    encryptedOutput1: outputs[0].encrypt(),
    encryptedOutput2: outputs[1].encrypt(),
  }
  const extDataHash = getExtDataHash(extData)
  const input = {
    root: tree.root(),
    inputNullifier: inputs.map((x) => x.getNullifier()),
    outputCommitment: outputs.map((x) => x.getCommitment()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE),
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
  const circuitInput = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, toCircuit(v)]))
  const proof = await prove(circuitInput, inputs.length)
  const args = {
    proof,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())),
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())),
    publicAmount: toFixedHex(input.publicAmount),
    extDataHash: toFixedHex(extDataHash),
  }
  return { args, extData }
}

/** Nova's prepareTransaction. `extAmountOverride` exists only for the overdraw negative test. */
async function prepareTransaction({ pool, inputs = [], outputs = [], fee = 0, recipient = 0, relayer = 0, extAmountOverride, tree }) {
  if (inputs.length > 16 || outputs.length > 2) throw new Error('Incorrect inputs/outputs count')
  while (inputs.length !== 2 && inputs.length < 16) inputs.push(new Utxo())
  while (outputs.length < 2) outputs.push(new Utxo())
  const extAmount =
    extAmountOverride !== undefined
      ? BigNumber.from(extAmountOverride)
      : BigNumber.from(fee)
          .add(outputs.reduce((s, x) => s.add(x.amount), BigNumber.from(0)))
          .sub(inputs.reduce((s, x) => s.add(x.amount), BigNumber.from(0)))
  return getProof({ inputs, outputs, tree: tree || (await buildMerkleTree(pool)), extAmount, fee, recipient, relayer })
}

/** Trial-decrypts every NewCommitment and returns this keypair's unspent notes. */
async function scanNotes(pool, keypair) {
  const events = await pool.queryFilter(pool.filters.NewCommitment(), 0)
  const notes = []
  for (const e of events) {
    let u
    try {
      u = Utxo.decrypt(keypair, e.args.encryptedOutput, e.args.index.toNumber())
    } catch {
      continue
    }
    if (u.amount.gt(0) && !(await pool.isSpent(toFixedHex(u.getNullifier())))) notes.push(u)
  }
  return notes
}

module.exports = { Keypair, Utxo, prepareTransaction, buildMerkleTree, scanNotes, toFixedHex, getExtDataHash, FIELD_SIZE, timings, poseidonHash2 }

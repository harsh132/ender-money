// Copied from ../nova-circom2/src/utils.mjs (port of tornado-nova src/utils.js); split-key changes: ExtData.deadline, domain in extDataHash.
// Port of tornado-nova src/utils.js: BigInt instead of ethers BigNumber, viem instead of ethers, circomlibjs Poseidon.
import crypto from 'node:crypto'
import { buildPoseidon } from 'circomlibjs'
import { encodeAbiParameters, keccak256 } from 'viem'

const P = await buildPoseidon()
export const poseidonHash = (items) => P.F.toObject(P(items.map(BigInt)))
export const poseidonHash2 = (a, b) => poseidonHash([a, b])

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
export const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n // keccak256("tornado") % FIELD_SIZE

/** Generate random number of specified byte length */
export const randomBN = (nbytes = 31) => BigInt('0x' + crypto.randomBytes(nbytes).toString('hex'))

export const EXT_DATA_TYPE = [
  {
    type: 'tuple',
    components: [
      { name: 'recipient', type: 'address' },
      { name: 'extAmount', type: 'int256' },
      { name: 'relayer', type: 'address' },
      { name: 'fee', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'encryptedOutput1', type: 'bytes' },
      { name: 'encryptedOutput2', type: 'bytes' },
    ],
  },
]

// Must match ShieldedPool: uint256(keccak256(abi.encode(block.chainid, address(this), _extData))) % FIELD_SIZE
export function getExtDataHash(extData, { chainId, pool }) {
  return BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, ...EXT_DATA_TYPE], [BigInt(chainId), pool, extData]))) % FIELD_SIZE
}

/** BigInt to 0x hex string of specified byte length */
export const toFixedHex = (n, length = 32) => '0x' + BigInt(n).toString(16).padStart(length * 2, '0')

/** Convert value into buffer of specified byte length */
export const toBuffer = (value, length) => Buffer.from(BigInt(value).toString(16).padStart(length * 2, '0'), 'hex')

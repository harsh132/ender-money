// Writes build/Hasher.json (circomlibjs Poseidon(2) EVM bytecode, as Nova's compileHasher.js did)
// and prints the zeros() table for MerkleTreeWithHistory.sol (standard circomlib Poseidon).
import fs from 'node:fs'
import { poseidonContract } from 'circomlibjs'
import { poseidonHash, ZERO_VALUE } from '../src/utils.mjs'

fs.mkdirSync('build', { recursive: true })
fs.writeFileSync('build/Hasher.json', JSON.stringify({ abi: poseidonContract.generateABI(2), bytecode: poseidonContract.createCode(2) }))

if (process.argv.includes('--zeros')) {
  let z = ZERO_VALUE
  for (let i = 0; i <= 32; i++) {
    console.log(`    else if (i == ${i}) return bytes32(0x${z.toString(16).padStart(64, '0')});`)
    z = poseidonHash([z, z])
  }
}

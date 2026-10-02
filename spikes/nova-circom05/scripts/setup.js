// Single-party, TESTNET-ONLY trusted setup via the snarkjs JS API.
// (The snarkjs 0.4.5 CLI breaks on Windows: it resolves its own package.json as C:\C:\..., so we call the API.)
// Usage: node scripts/setup.js [power]   default 17: transaction16 has 75,148 constraints < 2^17
const s = require('snarkjs')
const { buildBn128 } = require(require.resolve('ffjavascript', { paths: [require.resolve('snarkjs')] }))
const fs = require('fs')
const crypto = require('crypto')
const POWER = Number(process.argv[2] || 17)
const B = 'build'
const ent = () => crypto.randomBytes(32).toString('hex')
const log = { log() {}, info() {}, debug() {}, warn: console.warn, error: console.error }
async function step(name, fn) {
  const t = Date.now()
  await fn()
  console.log(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`)
}
;(async () => {
  const ptau = `${B}/pot${POWER}_final.ptau`
  if (!fs.existsSync(ptau)) {
    const curve = await buildBn128()
    await step(`ptau new bn128 2^${POWER}`, () => s.powersOfTau.newAccumulator(curve, POWER, `${B}/pot_0.ptau`, log))
    await step('ptau contribute', () => s.powersOfTau.contribute(`${B}/pot_0.ptau`, `${B}/pot_1.ptau`, 'spike', ent(), log))
    await step('ptau prepare phase2', () => s.powersOfTau.preparePhase2(`${B}/pot_1.ptau`, ptau, log))
    fs.unlinkSync(`${B}/pot_0.ptau`)
    fs.unlinkSync(`${B}/pot_1.ptau`)
  }
  const tpl = fs.readFileSync(require('path').join(__dirname, '..', 'node_modules', 'snarkjs', 'templates', 'verifier_groth16.sol.ejs'), 'utf8')
  for (const n of [2, 16]) {
    const c = `${B}/transaction${n}`
    await step(`groth16 setup tx${n}`, () => s.zKey.newZKey(`${c}.r1cs`, ptau, `${c}_0.zkey`, log))
    await step(`zkey contribute tx${n}`, () => s.zKey.contribute(`${c}_0.zkey`, `${c}.zkey`, 'spike', ent(), log))
    fs.unlinkSync(`${c}_0.zkey`)
    // Only toolchain-forced change: bump the generated verifier from ^0.7.0 to ^0.8.0 and give each
    // file a unique Pairing library name so both verifiers can live in one Foundry compilation.
    const sol = (await s.zKey.exportSolidityVerifier(`${c}.zkey`, { groth16: tpl }, log))
      .replace('pragma solidity ^0.7.0', 'pragma solidity ^0.8.0')
      .replace(/\bPairing\b/g, `Pairing${n}`)
      .replace('contract Verifier ', `contract Verifier${n} `)
    fs.writeFileSync(`contracts/src/Verifier${n}.sol`, sol)
    fs.writeFileSync(`${c}_vkey.json`, JSON.stringify(await s.zKey.exportVerificationKey(`${c}.zkey`), null, 1))
  }
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })

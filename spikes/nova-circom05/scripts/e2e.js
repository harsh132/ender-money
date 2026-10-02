// End-to-end test of the stripped Nova pool on a local anvil.
// Usage (from spikes/nova-circom05): node scripts/e2e.js   (spawns anvil on :8547, needs build/ + contracts/out)
const { spawn } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')
const { ethers } = require('ethers')
const genContract = require('circomlib/src/poseidon_gencontract.js')
const { Keypair, Utxo, prepareTransaction, buildMerkleTree, scanNotes, toFixedHex, timings, poseidonHash2 } = require('../src/nova')
const MerkleTree = require('fixed-merkle-tree')

const PORT = 8547
const LEVELS = 23
const A = (x) => ethers.utils.parseUnits(String(x), 6) // AUSD has 6 decimals
const fmt = (x) => ethers.utils.formatUnits(x, 6)
const OUT = path.join(__dirname, '..', 'contracts', 'out')
const artifact = (file, name) => JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`)))
const gas = {}

async function deploy(signer, file, name, ...args) {
  const a = artifact(file, name)
  const c = await new ethers.ContractFactory(a.abi, a.bytecode.object, signer).deploy(...args)
  await c.deployed()
  return c
}

async function expectRevert(promise, reason) {
  try {
    await promise
  } catch (e) {
    const msg = [e.reason, e.error && e.error.message, e.message].filter(Boolean).join(' | ')
    assert(msg.includes(reason), `expected revert "${reason}", got: ${msg.slice(0, 300)}`)
    return
  }
  throw new Error(`expected revert "${reason}" but call succeeded`)
}

async function main() {
  const anvilBin = path.join(os.homedir(), '.foundry', 'bin', 'anvil')
  const anvil = spawn(anvilBin, ['--port', String(PORT), '--silent'], { stdio: 'ignore' })
  process.on('exit', () => anvil.kill())
  const provider = new ethers.providers.JsonRpcProvider(`http://127.0.0.1:${PORT}`)
  for (let i = 0; ; i++) {
    try {
      await provider.getBlockNumber()
      break
    } catch {
      if (i > 50) throw new Error('anvil did not start')
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  const mnemonic = 'test test test test test test test test test test test junk'
  const signers = [...Array(7).keys()].map((i) => ethers.Wallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`).connect(provider))
  const [deployer, S1, S2, S3, S4, relayer] = signers
  const fresh = ethers.Wallet.createRandom() // withdrawal destination, never funded with gas
  const bob = new Keypair()
  const alice = new Keypair()

  // ---- deploy
  const hasherF = new ethers.ContractFactory(genContract.generateABI(2), genContract.createCode(2), deployer)
  const hasher = await hasherF.deploy()
  const v2 = await deploy(deployer, 'Verifier2.sol', 'Verifier2')
  const v16 = await deploy(deployer, 'Verifier16.sol', 'Verifier16')
  const token = await deploy(deployer, 'MockAUSD.sol', 'MockAUSD')
  const pool = await deploy(deployer, 'ShieldedPool.sol', 'ShieldedPool', v2.address, v16.address, LEVELS, hasher.address, token.address, A(1000))
  console.log('deployed pool', pool.address, 'tree height', LEVELS)

  async function send(label, signer, { args, extData }) {
    const tx = await pool.connect(signer).transact(args, extData, { gasLimit: 5e6 })
    const r = await tx.wait()
    ;(gas[label] = gas[label] || []).push(r.gasUsed.toNumber())
    console.log(`${label}: gas ${r.gasUsed}`)
    return r
  }

  // ---- 1. stealth deposits for Bob
  async function deposit(stealth, amount, label = 'deposit (2-in)') {
    await (await token.mint(stealth.address, A(amount))).wait()
    await (await token.connect(stealth).approve(pool.address, A(amount))).wait()
    const out = new Utxo({ amount: A(amount), keypair: bob })
    await send(label, stealth, await prepareTransaction({ pool, outputs: [out] }))
  }
  await deposit(S1, 10)
  await deposit(S2, 15)
  let bobNotes = await scanNotes(pool, bob)
  assert.deepStrictEqual(bobNotes.map((n) => fmt(n.amount)).sort(), ['10.0', '15.0'])

  // deposit cap
  await (await token.mint(S3.address, A(1001))).wait()
  await (await token.connect(S3).approve(pool.address, A(1001))).wait()
  const big = await prepareTransaction({ pool, outputs: [new Utxo({ amount: A(1001), keypair: bob })] })
  await expectRevert(pool.connect(S3).callStatic.transact(big.args, big.extData), 'amount is larger than maximumDepositAmount')
  console.log('ok: deposit above cap reverts')

  // ---- 2. Bob merges 10 + 15 -> 25 (relayer submits, fee 0)
  const spentTen = bobNotes.find((n) => n.amount.eq(A(10)))
  const merge = await prepareTransaction({ pool, inputs: bobNotes, outputs: [new Utxo({ amount: A(25), keypair: bob })] })
  await send('merge (2-in)', relayer, merge)
  bobNotes = await scanNotes(pool, bob)
  assert.deepStrictEqual(bobNotes.map((n) => fmt(n.amount)), ['25.0'])

  // replay: exact same proof+extData
  await expectRevert(pool.connect(relayer).callStatic.transact(merge.args, merge.extData), 'Input is already spent')
  console.log('ok: replaying the merge reverts (Input is already spent)')
  // fresh proof re-spending the already-spent 10 note
  const respend = await prepareTransaction({ pool, inputs: [spentTen], outputs: [new Utxo({ amount: A(10), keypair: bob })] })
  await expectRevert(pool.connect(relayer).callStatic.transact(respend.args, respend.extData), 'Input is already spent')
  console.log('ok: new proof re-spending a spent note reverts (Input is already spent)')

  // ---- 3. Bob -> Alice 20, change 5
  const transfer = await prepareTransaction({
    pool,
    inputs: bobNotes,
    outputs: [new Utxo({ amount: A(20), keypair: Keypair.fromString(alice.address()) }), new Utxo({ amount: A(5), keypair: bob })],
  })
  await send('transfer (2-in)', relayer, transfer)
  const aliceNotes = await scanNotes(pool, alice)
  assert.deepStrictEqual(aliceNotes.map((n) => fmt(n.amount)), ['20.0'])

  // ---- 4. Alice withdraws 12 gross: 11.9 to a fresh EOA + 0.1 relayer fee, keeps 8
  // overdraw: claim 30 out of a 20 note -> amount invariant fails in the witness
  await expectRevert(
    prepareTransaction({
      pool,
      inputs: [aliceNotes[0]],
      outputs: [new Utxo({ amount: A(8), keypair: alice })],
      fee: A('0.1'),
      recipient: fresh.address,
      relayer: relayer.address,
      extAmountOverride: A(-30),
    }),
    "Constraint doesn't match",
  )
  console.log('ok: overdraw (withdraw 30 from a 20 note) fails to prove')
  // overdraw with a fake 100 note in a locally forged tree: proves, but the root is unknown on-chain
  const fakeNote = new Utxo({ amount: A(100), keypair: alice })
  const forged = await buildMerkleTree(pool)
  forged.insert(toFixedHex(fakeNote.getCommitment()))
  const fake = await prepareTransaction({ pool, tree: forged, inputs: [fakeNote], outputs: [], recipient: fresh.address, relayer: relayer.address })
  await expectRevert(pool.connect(relayer).callStatic.transact(fake.args, fake.extData), 'Invalid merkle root')
  console.log('ok: spending a note that is not in the pool tree reverts (Invalid merkle root)')

  const withdraw = await prepareTransaction({
    pool,
    inputs: [aliceNotes[0]],
    outputs: [new Utxo({ amount: A(8), keypair: alice })],
    fee: A('0.1'),
    recipient: fresh.address,
    relayer: relayer.address,
  })
  assert(ethers.BigNumber.from(withdraw.extData.extAmount).eq(A('-11.9')))
  // tamper extData after proving
  const attacker = signers[6].address
  await expectRevert(
    pool.connect(relayer).callStatic.transact(withdraw.args, { ...withdraw.extData, recipient: attacker }),
    'Incorrect external data hash',
  )
  await expectRevert(
    pool.connect(relayer).callStatic.transact(withdraw.args, { ...withdraw.extData, fee: toFixedHex(A(5)) }),
    'Incorrect external data hash',
  )
  console.log('ok: tampering recipient or fee after proving reverts (Incorrect external data hash)')
  assert((await provider.getBalance(fresh.address)).eq(0))
  await send('withdraw (2-in, relayed)', relayer, withdraw)
  assert.deepStrictEqual((await scanNotes(pool, alice)).map((n) => fmt(n.amount)), ['8.0'])

  // ---- 5. transaction16: Bob merges his 5 change + two more stealth deposits (1, 2) -> 8
  await deposit(S3, 1)
  await deposit(S4, 2)
  bobNotes = await scanNotes(pool, bob)
  assert.deepStrictEqual(bobNotes.map((n) => fmt(n.amount)).sort(), ['1.0', '2.0', '5.0'])
  const m16 = await prepareTransaction({ pool, inputs: bobNotes, outputs: [new Utxo({ amount: A(8), keypair: bob })] })
  await send('merge (16-in)', relayer, m16)
  assert.deepStrictEqual((await scanNotes(pool, bob)).map((n) => fmt(n.amount)), ['8.0'])

  // ---- 7. balances
  const bal = {
    pool: fmt(await token.balanceOf(pool.address)),
    fresh: fmt(await token.balanceOf(fresh.address)),
    relayer: fmt(await token.balanceOf(relayer.address)),
    freshNative: (await provider.getBalance(fresh.address)).toString(),
  }
  console.log('final balances', bal)
  assert.deepStrictEqual(bal, { pool: '16.0', fresh: '11.9', relayer: '0.1', freshNative: '0' })

  // verifier-only gas (eth_estimateGas of a direct call; includes 21000 base + calldata)
  const v2gas = await v2.estimateGas['verifyProof(bytes,uint256[7])'](
    withdraw.args.proof,
    [withdraw.args.root, withdraw.args.publicAmount, withdraw.args.extDataHash, ...withdraw.args.inputNullifiers, ...withdraw.args.outputCommitments],
  )
  console.log('\nRESULTS')
  console.log('gas', JSON.stringify(gas))
  const v16gas = await v16.estimateGas['verifyProof(bytes,uint256[21])'](
    m16.args.proof,
    [m16.args.root, m16.args.publicAmount, m16.args.extDataHash, ...m16.args.inputNullifiers, ...m16.args.outputCommitments],
  )
  const hgas = await hasher.estimateGas['poseidon(uint256[2])']([1, 2])
  console.log('direct-call estimateGas (incl. 21000 base + calldata): verifier2', v2gas.toString(), 'verifier16', v16gas.toString(), 'poseidon(2)', hgas.toString())
  const by = (n) => timings.filter((t) => t.circuit === n).map((t) => t.ms)
  console.log('prove ms tx2', JSON.stringify(by(2)), 'tx16', JSON.stringify(by(16)))
  console.log('ALL CHECKS PASSED')
  anvil.kill()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

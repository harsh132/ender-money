// The gateway: holds each user's proving keys (nk, viewing key, authority PUBLIC key), indexes their notes by
// trial decryption, quotes a fee, resolves the notes the phone names in its SIG, rebuilds the same deterministic
// transaction as the phone, proves it once the signature checks out, relays it (paying gas) and keeps the fee in AUSD.
// Deposits (SHIELD): the user's EIP-3009 authorization pins extData and both output commitments; the dummy inputs are
// the gateway's own, signed in-circuit with its own EdDSA authority key. Only this gateway may call the pool.
import crypto from 'node:crypto'
import MerkleTreeMod from 'fixed-merkle-tree'
import { formatUnits, parseUnits, isAddress, parseEventLogs, recoverTypedDataAddress, isAddressEqual } from 'viem'
import { poseidonHash2, ZERO_VALUE, toBuffer } from './utils.mjs'
import { newUser, provingKeys, owner, packAddress, buildTx, verifySig, witnessInput, prove, commitment, nullifier, decryptNote, LEVELS, sign, buildDeposit, depositTx, quoteSeed, receiveAuth, withdrawOutputs, NULL_OWNER } from './shielded.mjs'
import { parseCommand, formatReply, formatQuote, parseSig, formatSent, formatGot, SESSION_ID_ALPHABET, MERGE, REF_MOD, parseShield, formatShielded } from './sms.mjs'
import { eligible, planCircuit, settle, CIRCUITS } from './select.mjs'

const { MerkleTree } = MerkleTreeMod
const fmt = (x) => formatUnits(x, 6)
const sum = (ns) => ns.reduce((s, n) => s + n.amount, 0n)
const MAX_COMBOS = 64
const LOG_RANGE = 100n

export class Gateway {
  /**
   * fromBlock: the pool's deploy block. Public RPCs cap eth_getLogs ranges, so logs are read in LOG_RANGE chunks.
   * ausd: { address, name, version } (EIP-712 domain of the token). authority: the gateway's own shielded keys, which
   * own the dummy inputs of deposits.
   */
  constructor({ client, wallet, pool, poolAbi, domain, fee, fromBlock = 0n, ausd, authority = newUser() }) {
    Object.assign(this, { client, wallet, pool, poolAbi, domain, fee, ausd, fromBlock: BigInt(fromBlock) })
    this.authSk = authority.authSk
    this.keys = provingKeys(authority)
    this.self = owner(this.keys)
    this.users = new Map() // number -> { keys, me, eoa, notes: Map pos -> { amount, blinding, nullifier, spent } }
    this.quotes = new Map() // id -> quote
    this.gas = []
  }

  /** Online onboarding: the app hands over nk, the viewing key and the authority public key. Never the authority private key. */
  register(number, keys, eoa) {
    this.users.set(number, { keys, me: owner(keys), eoa, notes: new Map() })
  }

  // ponytail: rescans every log on each call; an indexer would keep a cursor and an incremental tree
  async events(eventName) {
    const to = await this.client.getBlockNumber({ cacheTime: 0 })
    const out = []
    for (let from = this.fromBlock; from <= to; from += LOG_RANGE) {
      const end = from + LOG_RANGE - 1n < to ? from + LOG_RANGE - 1n : to
      out.push(...(await this.client.getContractEvents({ address: this.pool, abi: this.poolAbi, eventName, fromBlock: from, toBlock: end })))
    }
    return out
  }

  async sync() {
    const logs = await this.events('NewCommitment')
    const leaves = logs.map((l) => l.args).sort((a, b) => Number(a.index - b.index))
    this.tree = new MerkleTree(LEVELS, leaves.map((e) => BigInt(e.commitment)), { hashFunction: poseidonHash2, zeroElement: ZERO_VALUE })
    const spent = new Set(
      (await this.events('NewNullifier')).map((l) => BigInt(l.args.nullifier)),
    )
    for (const u of this.users.values()) {
      for (const e of leaves) {
        const pos = Number(e.index)
        if (u.notes.has(pos)) continue
        const d = decryptNote(e.encryptedOutput, u.keys.viewSk)
        if (!d || d.amount === 0n) continue
        const c = commitment(d.amount, u.me.ownerKey, d.blinding)
        if (c !== BigInt(e.commitment)) continue // not ours, or a bogus ciphertext
        u.notes.set(pos, { ...d, nullifier: nullifier(u.keys.nk, c, pos) })
      }
      for (const n of u.notes.values()) n.spent = spent.has(n.nullifier)
    }
  }

  /** The index: every unspent note, dust included. */
  unspent(number) {
    return [...this.users.get(number).notes].filter(([, n]) => !n.spent).map(([pos, n]) => ({ pos, ...n }))
  }

  /** Notes the selection rule counts: unspent, >= 0.001 AUSD, not an input of a SIG being proved right now. */
  eligible(number) {
    const reserved = new Set([...this.quotes.values()].filter((q) => q.from === number && q.ins).flatMap((q) => q.ins.map((i) => i.pos)))
    return eligible(this.unspent(number), reserved)
  }

  /** Incoming SMS -> outgoing SMS list [{ to, text }]. */
  async onSms(from, text) {
    const err = (code, id) => [{ to: from, text: formatReply({ kind: 'error', id, code }) }]
    if (!this.users.has(from)) return err('NOUSER')
    const s = parseSig(text)
    if (s) return this.onSig(from, s, err)
    if (text === MERGE) return this.onSend(from, { to: from, amount: '0' }, err)
    const shield = parseShield(text)
    if (shield) return this.onShield(from, shield, err)
    const cmd = parseCommand(text)
    if (cmd?.kind === 'send') return this.onSend(from, cmd, err)
    if (cmd?.kind === 'sig') return this.onDepositSig(from, cmd, err)
    return err('SYNTAX')
  }

  newQuote(q) {
    const id = Array.from(crypto.randomBytes(4), (b) => SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length]).join('')
    const exp = Math.floor(Date.now() / 1000) + 600
    this.quotes.set(id, { ...q, id, exp })
    return { id, exp }
  }

  onShield(from, { amount }, err) {
    if (!this.users.get(from).eoa) return err('NOEOA')
    const { id, exp } = this.newQuote({ from, deposit: true, amount: parseUnits(amount, 6) })
    return [{ to: from, text: formatQuote({ id, exp, fee: fmt(this.fee) }) }]
  }

  /** The deposit the phone built for quote q (same inputs, same bytes). */
  depositFor(q) {
    const me = this.users.get(q.from).me
    const outputs = [{ amount: q.amount, to: me }, { amount: 0n, to: me }]
    return buildDeposit({ me, outputs, fee: this.fee, relayer: this.wallet.account.address, deadline: q.exp, seed: quoteSeed(q.id, q.exp), domain: this.domain })
  }

  async onDepositSig(from, { id, signature }, err) {
    const q = this.quotes.get(id)
    if (!q || q.from !== from || !q.deposit) return err('UNKNOWN', id)
    if (q.exp <= Math.floor(Date.now() / 1000)) return err('EXPIRED', id)
    const { eoa } = this.users.get(from)
    const dep = this.depositFor(q)
    // cheap pre-check before proving: the key that signed is the EOA's own key (also true for a 7702 account's root key)
    const auth = receiveAuth(this.ausd, this.domain.chainId, { from: eoa, to: this.pool, value: dep.value, validBefore: q.exp, nonce: dep.nonce })
    const signer = await recoverTypedDataAddress({ ...auth, signature }).catch(() => null)
    if (!signer || !isAddressEqual(signer, eoa)) return err('BADSIG', id)
    const res = await this.deposit(dep, eoa, signature, `SHIELD ${fmt(q.amount)} (${from}, deposit)`)
    this.quotes.delete(id)
    const p = Number(parseEventLogs({ abi: this.poolAbi, logs: res.logs, eventName: 'NewCommitment' })[0].args.index)
    return [{ to: from, text: formatShielded({ amount: fmt(q.amount), tx: res.transactionHash, p }) }]
  }

  /** Proves and submits a deposit (buildDeposit output) that `from` authorized with EIP-3009 `signature`. */
  async deposit(dep, from, signature, label) {
    if (![...this.users.values()].some((u) => u.eoa && isAddressEqual(u.eoa, from))) throw new Error('policy: deposit from an unregistered account')
    const tx = depositTx(this.self, dep)
    const args = await this.proveTx(null, tx, sign(this.authSk, tx.msg), this.keys)
    this.lastDeposit = { args, tx, from, signature }
    return this.submit('depositWithAuthorization', [args, tx.extData, from, signature], label)
  }

  async onSend(from, cmd, err) {
    await this.sync()
    const amount = parseUnits(cmd.amount, 6)
    const withdraw = isAddress(cmd.to)
    const recipient = withdraw ? null : this.users.get(cmd.to)
    if (!withdraw && !recipient) return err('NOUSER')
    const plan = planCircuit(this.eligible(from), amount + this.fee) // FUNDS / MERGE before quoting
    if (plan.err) return err(plan.err)
    const { id, exp } = this.newQuote({ from, to: cmd.to, amount })
    const to = withdraw ? cmd.to : packAddress(recipient.me)
    return [{ to: from, text: formatQuote({ id, exp, fee: fmt(this.fee), to }) }]
  }

  /** Quote q's transaction spending `ins` in the nIns circuit: the same build the phone does. */
  buildFor(q, ins, nIns) {
    const me = this.users.get(q.from).me
    const s = settle(sum(ins), q.amount, this.fee)
    const change = { amount: s.change, to: me }
    const common = { me, nIns, inputs: ins, fee: s.fee, relayer: this.wallet.account.address, deadline: q.exp, domain: this.domain }
    return isAddress(q.to)
      ? buildTx({ ...common, outputs: withdrawOutputs(change), extAmount: -q.amount, recipient: q.to })
      : buildTx({ ...common, outputs: [{ amount: q.amount, to: this.users.get(q.to).me }, change] })
  }

  /**
   * SIG refs -> the user's eligible notes, then the transaction the signature verifies. The selection rule is the
   * phone's policy, not checked here: any 1-12 distinct notes go in the smallest circuit that holds them. Refs are tree
   * position mod 2^18, so they can collide: every combination of candidates is rebuilt and the one the signature
   * verifies is kept. Returns { nIns, ins, tx, tried } or { err }.
   */
  resolve(q, sig, refs) {
    const notes = this.eligible(q.from)
    const T = q.amount + this.fee
    const nIns = CIRCUITS.find((c) => c >= refs.length)
    if (!refs.length || !nIns) return { err: 'REF' }
    if (new Set(refs).size !== refs.length) return { err: 'REF' }
    const cands = refs.map((r) => notes.filter((n) => n.pos % REF_MOD === r))
    if (cands.some((c) => !c.length)) return { err: 'REF' }
    let combos = [[]]
    for (const c of cands) combos = combos.flatMap((pre) => c.map((n) => [...pre, n]))
    // ponytail: brute force, capped; collisions need 262,144+ leaves. A longer ref (4 chars) if trees get that big.
    if (combos.length > MAX_COMBOS) return { err: 'REF' }
    const keys = this.users.get(q.from).keys
    let tried = 0
    for (const ins of combos) {
      if (sum(ins) < T) continue
      tried++
      const tx = this.buildFor(q, ins, nIns)
      if (verifySig(sig, tx.msg, keys)) return { nIns, ins, tx, tried }
    }
    return { err: 'BADSIG' }
  }

  async onSig(from, { id, sig, refs }, err) {
    const q = this.quotes.get(id)
    if (!q || q.from !== from || q.deposit) return err('UNKNOWN', id)
    if (q.exp <= Math.floor(Date.now() / 1000)) return err('EXPIRED', id)
    await this.sync()
    const r = this.resolve(q, sig, refs) // cheap checks before 1-6 s of proving
    if (r.err) return err(r.err, id)
    q.ins = r.ins
    const args = await this.proveTx(from, r.tx, sig)
    const res = await this.submit('transact', [args, r.tx.extData], `${from} -> ${q.to} [${r.nIns}-in]`)
    this.quotes.delete(id)
    const leaf = parseEventLogs({ abi: this.poolAbi, logs: res.logs, eventName: 'NewCommitment' })[0] // none for null outputs
    const p = leaf && Number(leaf.args.index)
    this.last = { args, extData: r.tx.extData, hash: res.transactionHash, input: this.lastInput, nIns: r.nIns, real: r.ins.length, tried: r.tried }
    const out = [{ to: from, text: formatSent({ amount: fmt(q.amount), to: q.to, tx: res.transactionHash, p }) }]
    if (q.to !== from && this.users.has(q.to)) {
      const o = r.tx.outs[0]
      out.push({ to: q.to, text: formatGot({ amount: fmt(o.amount), from, p, blinding: toBuffer(o.blinding, 32) }) })
    }
    return out
  }

  /** Proves a transaction for a registered user given the phone's signature (keys: the owner's, if not a user's). */
  async proveTx(number, tx, sig, keys = this.users.get(number)?.keys) {
    this.checkOwners(number, tx)
    await this.sync()
    this.lastInput = witnessInput(tx, this.tree, keys, sig)
    return prove(this.lastInput)
  }

  /**
   * Policy, checked before every proof: inputs belong to one registered user (number), or are the gateway's own
   * zero-value deposit dummies (number null); every output is null or a registered user's note. Value only ever moves
   * between registered users; withdrawals may still go to any EVM address.
   */
  checkOwners(number, tx) {
    if (number === null ? tx.ins.some((i) => i.amount > 0n) : !this.users.has(number)) throw new Error('policy: inputs of an unregistered user')
    const registered = new Set([...this.users.values()].map((u) => u.me.ownerKey))
    if (tx.outs.some((o) => o.to !== NULL_OWNER && !registered.has(o.to.ownerKey))) throw new Error('policy: output to an unregistered key')
  }

  /** functionName: transact or depositWithAuthorization. */
  async submit(functionName, args, label) {
    const hash = await this.wallet.writeContract({ address: this.pool, abi: this.poolAbi, functionName, args })
    const r = await this.client.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`${functionName} reverted: ${label}`)
    this.gas.push({ label, gasUsed: Number(r.gasUsed), hash: r.transactionHash })
    return r
  }
}

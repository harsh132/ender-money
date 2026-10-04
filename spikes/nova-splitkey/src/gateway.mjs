// The gateway: holds each user's proving keys (nk, viewing key, authority PUBLIC key), indexes their notes by
// trial decryption, quotes a fee, resolves the notes the phone names in its SIG, rebuilds the same deterministic
// transaction as the phone, proves it once the signature checks out, relays it (paying gas) and keeps the fee in AUSD.
import crypto from 'node:crypto'
import MerkleTreeMod from 'fixed-merkle-tree'
import { formatUnits, parseUnits, isAddress, parseEventLogs } from 'viem'
import { poseidonHash2, ZERO_VALUE, toBuffer } from './utils.mjs'
import { owner, packAddress, buildTx, verifySig, witnessInput, prove, commitment, nullifier, decryptNote, LEVELS } from './shielded.mjs'
import { parseCommand, formatReply, formatQuote, parseSig, formatSent, formatGot, SESSION_ID_ALPHABET, MERGE, REF_MOD } from './sms.mjs'
import { eligible, planCircuit, settle, CIRCUITS } from './select.mjs'

const { MerkleTree } = MerkleTreeMod
const fmt = (x) => formatUnits(x, 6)
const sum = (ns) => ns.reduce((s, n) => s + n.amount, 0n)
const MAX_COMBOS = 64
const LOG_RANGE = 100n

export class Gateway {
  /** fromBlock: the pool's deploy block. Public RPCs cap eth_getLogs ranges, so logs are read in LOG_RANGE chunks. */
  constructor({ client, wallet, pool, poolAbi, domain, fee, fromBlock = 0n }) {
    Object.assign(this, { client, wallet, pool, poolAbi, domain, fee, fromBlock: BigInt(fromBlock) })
    this.users = new Map() // number -> { keys, me, notes: Map pos -> { amount, blinding, nullifier, spent } }
    this.quotes = new Map() // id -> quote
    this.gas = []
  }

  /** Online onboarding: the app hands over nk, the viewing key and the authority public key. Never the authority private key. */
  register(number, keys) {
    this.users.set(number, { keys, me: owner(keys), notes: new Map() })
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
    const cmd = parseCommand(text)
    if (cmd?.kind === 'send') return this.onSend(from, cmd, err)
    return err('SYNTAX')
  }

  async onSend(from, cmd, err) {
    await this.sync()
    const amount = parseUnits(cmd.amount, 6)
    const withdraw = isAddress(cmd.to)
    const recipient = withdraw ? null : this.users.get(cmd.to)
    if (!withdraw && !recipient) return err('NOUSER')
    const plan = planCircuit(this.eligible(from), amount + this.fee) // FUNDS / MERGE before quoting
    if (plan.err) return err(plan.err)
    const id = Array.from(crypto.randomBytes(4), (b) => SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length]).join('')
    const exp = Math.floor(Date.now() / 1000) + 600
    this.quotes.set(id, { id, from, to: cmd.to, amount, exp })
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
      ? buildTx({ ...common, outputs: [{ amount: 0n, to: me }, change], extAmount: -q.amount, recipient: q.to })
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
    if (!q || q.from !== from) return err('UNKNOWN', id)
    if (q.exp <= Math.floor(Date.now() / 1000)) return err('EXPIRED', id)
    await this.sync()
    const r = this.resolve(q, sig, refs) // cheap checks before 1-6 s of proving
    if (r.err) return err(r.err, id)
    q.ins = r.ins
    const args = await this.proveTx(from, r.tx, sig)
    const res = await this.submit(args, r.tx.extData, `${from} -> ${q.to} [${r.nIns}-in]`)
    this.quotes.delete(id)
    const p = Number(parseEventLogs({ abi: this.poolAbi, logs: res.logs, eventName: 'NewCommitment' })[0].args.index)
    this.last = { args, extData: r.tx.extData, hash: res.transactionHash, input: this.lastInput, nIns: r.nIns, real: r.ins.length, tried: r.tried }
    const out = [{ to: from, text: formatSent({ amount: fmt(q.amount), to: q.to, tx: res.transactionHash, p }) }]
    if (q.to !== from && this.users.has(q.to)) {
      const o = r.tx.outs[0]
      out.push({ to: q.to, text: formatGot({ amount: fmt(o.amount), from, p, blinding: toBuffer(o.blinding, 32) }) })
    }
    return out
  }

  /** Proves a transaction for a registered user given the phone's signature (also used online, e.g. for deposits). */
  async proveTx(number, tx, sig) {
    await this.sync()
    this.lastInput = witnessInput(tx, this.tree, this.users.get(number).keys, sig)
    return prove(this.lastInput)
  }

  async submit(args, extData, label) {
    const hash = await this.wallet.writeContract({ address: this.pool, abi: this.poolAbi, functionName: 'transact', args: [args, extData] })
    const r = await this.client.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`transact reverted: ${label}`)
    this.gas.push({ label, gasUsed: Number(r.gasUsed) })
    return r
  }
}

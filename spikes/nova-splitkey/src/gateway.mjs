// The gateway: holds each user's proving keys (nk, viewing key, authority PUBLIC key), indexes their notes by
// trial decryption, picks input notes, builds the same deterministic transaction as the phone, proves it once the
// phone's signature arrives, relays it (paying gas) and keeps the fee in AUSD.
import crypto from 'node:crypto'
import MerkleTreeMod from 'fixed-merkle-tree'
import { formatUnits, parseUnits, isAddress, parseEventLogs } from 'viem'
import { poseidonHash2, ZERO_VALUE, toBuffer } from './utils.mjs'
import { owner, packAddress, buildTx, verifySig, witnessInput, prove, commitment, nullifier, decryptNote, LEVELS } from './shielded.mjs'
import { parseCommand, formatReply, formatQuote, parseSig, formatSent, formatGot, SESSION_ID_ALPHABET } from './sms.mjs'

const { MerkleTree } = MerkleTreeMod
const fmt = (x) => formatUnits(x, 6)

export class Gateway {
  constructor({ client, wallet, pool, poolAbi, domain, fee }) {
    Object.assign(this, { client, wallet, pool, poolAbi, domain, fee })
    this.users = new Map() // number -> { keys, me, notes: Map pos -> { amount, blinding, nullifier, spent } }
    this.quotes = new Map() // id -> quote
    this.gas = []
  }

  /** Online onboarding: the app hands over nk, the viewing key and the authority public key. Never the authority private key. */
  register(number, keys) {
    this.users.set(number, { keys, me: owner(keys), notes: new Map() })
  }

  // ponytail: rescans every log on each call; an indexer would keep a cursor and an incremental tree
  async sync() {
    const logs = await this.client.getContractEvents({ address: this.pool, abi: this.poolAbi, eventName: 'NewCommitment', fromBlock: 0n })
    const leaves = logs.map((l) => l.args).sort((a, b) => Number(a.index - b.index))
    this.tree = new MerkleTree(LEVELS, leaves.map((e) => BigInt(e.commitment)), { hashFunction: poseidonHash2, zeroElement: ZERO_VALUE })
    const spent = new Set(
      (await this.client.getContractEvents({ address: this.pool, abi: this.poolAbi, eventName: 'NewNullifier', fromBlock: 0n })).map((l) => BigInt(l.args.nullifier)),
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

  unspent(number) {
    const reserved = new Set([...this.quotes.values()].filter((q) => q.from === number).flatMap((q) => q.ins.map((i) => i.pos)))
    return [...this.users.get(number).notes].filter(([pos, n]) => !n.spent && !reserved.has(pos)).map(([pos, n]) => ({ pos, ...n }))
  }

  /** Smallest single note that covers `need`, else the smallest-sum pair; transaction2 takes at most 2. */
  pickNotes(number, need) {
    const notes = this.unspent(number).sort((a, b) => (a.amount < b.amount ? -1 : 1))
    const one = notes.find((n) => n.amount >= need)
    if (one) return [one]
    let best = null
    for (let i = 0; i < notes.length; i++)
      for (let j = i + 1; j < notes.length; j++) {
        const s = notes[i].amount + notes[j].amount
        if (s >= need && (!best || s < best.s)) best = { s, pair: [notes[i], notes[j]] }
      }
    return best?.pair ?? null
  }

  /** Incoming SMS -> outgoing SMS list [{ to, text }]. */
  async onSms(from, text) {
    const err = (code, id) => [{ to: from, text: formatReply({ kind: 'error', id, code }) }]
    if (!this.users.has(from)) return err('NOUSER')
    const s = parseSig(text)
    if (s) return this.onSig(from, s, err)
    const cmd = parseCommand(text)
    if (cmd?.kind === 'send') return this.onSend(from, cmd, err)
    return err('SYNTAX')
  }

  async onSend(from, cmd, err) {
    await this.sync()
    const u = this.users.get(from)
    const amount = parseUnits(cmd.amount, 6)
    const withdraw = isAddress(cmd.to)
    const recipient = withdraw ? null : this.users.get(cmd.to)
    if (!withdraw && !recipient) return err('NOUSER')
    const ins = this.pickNotes(from, amount + this.fee)
    if (!ins) return err('FUNDS')
    const id = Array.from(crypto.randomBytes(4), (b) => SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length]).join('')
    const exp = Math.floor(Date.now() / 1000) + 600
    const change = { amount: ins.reduce((s, n) => s + n.amount, 0n) - amount - this.fee, to: u.me }
    const common = { me: u.me, inputs: ins, fee: this.fee, relayer: this.wallet.account.address, deadline: exp, domain: this.domain }
    const tx = withdraw
      ? buildTx({ ...common, outputs: [{ amount: 0n, to: u.me }, change], extAmount: -amount, recipient: cmd.to })
      : buildTx({ ...common, outputs: [{ amount, to: recipient.me }, change] })
    this.quotes.set(id, { id, from, to: cmd.to, amount, exp, ins, tx })
    const to = withdraw ? cmd.to : packAddress(recipient.me)
    return [{ to: from, text: formatQuote({ id, exp, fee: fmt(this.fee), ins: ins.map((n) => n.pos), to }) }]
  }

  async onSig(from, { id, sig }, err) {
    const q = this.quotes.get(id)
    if (!q || q.from !== from) return err('UNKNOWN', id)
    if (q.exp <= Math.floor(Date.now() / 1000)) return err('EXPIRED', id)
    const u = this.users.get(from)
    if (!verifySig(sig, q.tx.msg, u.keys)) return err('BADSIG', id) // cheap check before spending ~1 s proving
    const args = await this.proveTx(from, q.tx, sig)
    const r = await this.submit(args, q.tx.extData, `${from} -> ${q.to}`)
    this.quotes.delete(id)
    const p = Number(parseEventLogs({ abi: this.poolAbi, logs: r.logs, eventName: 'NewCommitment' })[0].args.index)
    this.last = { args, extData: q.tx.extData, hash: r.transactionHash }
    const out = [{ to: from, text: formatSent({ amount: fmt(q.amount), to: q.to, tx: r.transactionHash, p }) }]
    if (this.users.has(q.to)) {
      const o = q.tx.outs[0]
      out.push({ to: q.to, text: formatGot({ amount: fmt(o.amount), from, p, blinding: toBuffer(o.blinding, 32) }) })
    }
    return out
  }

  /** Proves a transaction for a registered user given the phone's signature (also used online, e.g. for deposits). */
  async proveTx(number, tx, sig) {
    await this.sync()
    return prove(witnessInput(tx, this.tree, this.users.get(number).keys, sig))
  }

  async submit(args, extData, label) {
    const hash = await this.wallet.writeContract({ address: this.pool, abi: this.poolAbi, functionName: 'transact', args: [args, extData] })
    const r = await this.client.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`transact reverted: ${label}`)
    this.gas.push({ label, gasUsed: Number(r.gasUsed) })
    return r
  }
}

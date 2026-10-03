// The phone: holds the authority private key (never leaves it), nk and the viewing key, a local note cache and
// pinned contact keys. Offline it only exchanges SMS: SEND -> Q -> SIG -> Sent, plus Got alerts.
// The phone picks the input notes (src/select.mjs) and names them in its SIG.
import { formatUnits, parseUnits, isAddress } from 'viem'
import { provingKeys, owner, packAddress, unpackAddress, buildTx, sign, commitment, nullifier } from './shielded.mjs'
import { formatCommand, parseQuote, formatSig, parseSent, parseGot, b64, MERGE } from './sms.mjs'
import { eligible, selectNotes, settle } from './select.mjs'

const sum = (ns) => ns.reduce((s, n) => s + n.amount, 0n)

export class Phone {
  /** config: { domain: {chainId, pool}, relayer (pinned gateway address), maxFee (AUSD units) }. rng: for tests (default crypto). */
  constructor({ number, user, config, rng }) {
    this.number = number
    this.authSk = user.authSk
    this.me = owner(provingKeys(user))
    this.config = config
    this.rng = rng
    this.notes = new Map() // pos -> { amount, blinding, spent }
    this.contacts = new Map() // phone number -> pinned shielded address (base64)
    this.pending = null // SEND waiting for its Q: { to, amount }
    this.awaiting = [] // signed payments waiting for Sent, oldest first: { to, amount, quote, tx, pin? }
  }

  address() {
    return packAddress(this.me)
  }

  addNote(pos, amount, blinding) {
    this.notes.set(pos, { amount, blinding, spent: false })
  }

  /** The cache: every unspent note, dust included. */
  unspent() {
    return [...this.notes].filter(([, n]) => !n.spent && n.amount > 0n).map(([pos, n]) => ({ pos, ...n }))
  }

  /** Notes the selection rule may use: unspent, >= 0.001 AUSD, not an input of a payment still waiting for Sent. */
  eligible() {
    return eligible(this.unspent(), new Set(this.awaiting.flatMap((p) => p.tx.ins.filter((i) => i.amount > 0n).map((i) => i.pos))))
  }

  /** Balance shown to the user: notes under 0.001 AUSD don't count. */
  balance() {
    return sum(eligible(this.unspent()))
  }

  send(to, amount) {
    this.pending = { to, amount: parseUnits(amount, 6) }
    return formatCommand({ kind: 'send', to, amount, deliver: 'AUSD' })
  }

  /** Payment to self of 0: T is the fee alone. */
  merge() {
    this.pending = { to: this.number, amount: 0n }
    return MERGE
  }

  cancel() {
    this.pending = null
  }

  /** Returns { out } (a reply SMS to the gateway), { refused } (shown to the user, nothing sent), { error } or {}. */
  onSms(text) {
    const q = parseQuote(text)
    if (q) return this.onQuote(q)
    const sent = parseSent(text)
    if (sent) return this.onSent(sent)
    const got = parseGot(text)
    if (got) {
      this.addNote(got.p, parseUnits(got.amount, 6), got.blinding)
      return {}
    }
    const e = /^ERR (?:(\S{4}) )?(\S+)$/.exec(text)
    if (e) {
      if (e[1]) this.awaiting = this.awaiting.filter((p) => p.quote.id !== e[1]) // a refused SIG frees its notes
      else this.pending = null
      return { error: e[2] }
    }
    return {}
  }

  onQuote(q) {
    const p = this.pending
    if (!p) return { refused: 'no SEND waiting for a quote' }
    const now = Math.floor(Date.now() / 1000)
    if (q.exp <= now || q.exp > now + 3600) return { refused: `quote expiry ${q.exp} out of range` }
    const fee = parseUnits(q.fee, 6)
    if (fee > this.config.maxFee) return { refused: `fee ${q.fee} above limit` }
    const T = p.amount + fee
    const sel = selectNotes(this.eligible(), T, this.rng)
    if (sel.err) return { refused: `ERR ${sel.err}: notes can't pay ${formatUnits(T, 6)}` }
    const ins = sel.ins.map(({ pos, amount, blinding }) => ({ pos, amount, blinding }))
    const s = settle(sum(ins), p.amount, fee)
    const change = { amount: s.change, to: this.me }

    let tx
    const common = { me: this.me, nIns: sel.circuit, inputs: ins, fee: s.fee, relayer: this.config.relayer, deadline: q.exp, domain: this.config.domain }
    if (isAddress(p.to)) {
      if (q.to !== p.to.toLowerCase()) return { refused: `quote pays ${q.to}, not ${p.to}` }
      tx = buildTx({ ...common, outputs: [{ amount: 0n, to: this.me }, change], extAmount: -p.amount, recipient: p.to })
    } else if (p.to === this.number) {
      if (!Buffer.isBuffer(q.to) || !q.to.equals(this.address())) return { refused: 'merge quote pays someone else' }
      tx = buildTx({ ...common, outputs: [{ amount: p.amount, to: this.me }, change] })
    } else {
      if (!Buffer.isBuffer(q.to)) return { refused: 'quote has no shielded address for a phone number' }
      const pinned = this.contacts.get(p.to)
      if (pinned && pinned !== b64(q.to)) return { refused: `KEY CHANGED for ${p.to}: pinned ${pinned.slice(0, 8)}..., quote ${b64(q.to).slice(0, 8)}...` }
      p.pin = b64(q.to)
      tx = buildTx({ ...common, outputs: [{ amount: p.amount, to: unpackAddress(q.to) }, change] })
    }
    p.quote = q
    p.tx = tx
    this.awaiting.push(p)
    this.pending = null
    return { out: formatSig(q.id, sign(this.authSk, tx.msg), ins.map((n) => n.pos)) }
  }

  onSent(s) {
    const p = this.awaiting.shift()
    if (!p) return {}
    for (const i of p.tx.ins) if (this.notes.has(i.pos) && i.amount > 0n) this.notes.get(i.pos).spent = true
    p.tx.outs.forEach((o, i) => {
      if (o.to === this.me && o.amount > 0n) this.addNote(s.p + i, o.amount, o.blinding)
    })
    if (p.pin) this.contacts.set(p.to, p.pin)
    return {}
  }

  /** What the phone can say about its own notes offline (used to cross-check the gateway's index). */
  nullifierOf(pos) {
    const n = this.notes.get(pos)
    return nullifier(this.me.nk, commitment(n.amount, this.me.ownerKey, n.blinding), pos)
  }
}

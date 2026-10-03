// The phone: holds the authority private key (never leaves it), nk and the viewing key, a local note cache and
// pinned contact keys. Offline it only exchanges SMS: SEND -> Q -> SIG -> Sent, plus Got alerts.
import { formatUnits, parseUnits, isAddress } from 'viem'
import { provingKeys, owner, packAddress, unpackAddress, buildTx, sign, commitment, nullifier } from './shielded.mjs'
import { formatCommand, parseQuote, formatSig, parseSent, parseGot, b64 } from './sms.mjs'

export class Phone {
  /** config: { domain: {chainId, pool}, relayer (pinned gateway address), maxFee (AUSD units) } */
  constructor({ number, user, config }) {
    this.number = number
    this.authSk = user.authSk
    this.me = owner(provingKeys(user))
    this.config = config
    this.notes = new Map() // pos -> { amount, blinding, spent }
    this.contacts = new Map() // phone number -> pinned shielded address (base64)
    this.pending = null // { to, amount, quote?, tx? }
  }

  address() {
    return packAddress(this.me)
  }

  addNote(pos, amount, blinding) {
    this.notes.set(pos, { amount, blinding, spent: false })
  }

  unspent() {
    return [...this.notes].filter(([, n]) => !n.spent && n.amount > 0n).map(([pos, n]) => ({ pos, ...n }))
  }

  balance() {
    return this.unspent().reduce((s, n) => s + n.amount, 0n)
  }

  send(to, amount) {
    this.pending = { to, amount: parseUnits(amount, 6) }
    return formatCommand({ kind: 'send', to, amount, deliver: 'AUSD' })
  }

  cancel() {
    this.pending = null
  }

  /** Returns { out } (a reply SMS to the gateway), { refused } (shown to the user, nothing sent) or {}. */
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
    return {}
  }

  onQuote(q) {
    const p = this.pending
    if (!p || p.tx) return { refused: 'no SEND waiting for a quote' }
    const now = Math.floor(Date.now() / 1000)
    if (q.exp <= now || q.exp > now + 3600) return { refused: `quote expiry ${q.exp} out of range` }
    const fee = parseUnits(q.fee, 6)
    if (fee > this.config.maxFee) return { refused: `fee ${q.fee} above limit` }
    if (new Set(q.ins).size !== q.ins.length) return { refused: 'duplicate input' }
    const ins = []
    for (const pos of q.ins) {
      const n = this.notes.get(pos)
      if (!n || n.spent) return { refused: `note p=${pos} not in my cache` }
      ins.push({ pos, amount: n.amount, blinding: n.blinding })
    }
    const total = ins.reduce((s, n) => s + n.amount, 0n)
    if (total < p.amount + fee) return { refused: `notes hold ${formatUnits(total, 6)}, need ${formatUnits(p.amount + fee, 6)}` }
    const change = { amount: total - p.amount - fee, to: this.me }

    let tx
    const common = { me: this.me, inputs: ins, fee, relayer: this.config.relayer, deadline: q.exp, domain: this.config.domain }
    if (isAddress(p.to)) {
      if (q.to !== p.to.toLowerCase()) return { refused: `quote pays ${q.to}, not ${p.to}` }
      tx = buildTx({ ...common, outputs: [{ amount: 0n, to: this.me }, change], extAmount: -p.amount, recipient: p.to })
    } else {
      if (!Buffer.isBuffer(q.to)) return { refused: 'quote has no shielded address for a phone number' }
      const pinned = this.contacts.get(p.to)
      if (pinned && pinned !== b64(q.to)) return { refused: `KEY CHANGED for ${p.to}: pinned ${pinned.slice(0, 8)}..., quote ${b64(q.to).slice(0, 8)}...` }
      p.pin = b64(q.to)
      tx = buildTx({ ...common, outputs: [{ amount: p.amount, to: unpackAddress(q.to) }, change] })
    }
    p.quote = q
    p.tx = tx
    return { out: formatSig(q.id, sign(this.authSk, tx.msg)) }
  }

  onSent(s) {
    const p = this.pending
    if (!p?.tx) return {}
    for (const i of p.tx.ins) if (this.notes.has(i.pos) && i.amount > 0n) this.notes.get(i.pos).spent = true
    p.tx.outs.forEach((o, i) => {
      if (o.to === this.me && o.amount > 0n) this.addNote(s.p + i, o.amount, o.blinding)
    })
    if (p.pin) this.contacts.set(p.to, p.pin)
    this.pending = null
    return {}
  }

  /** What the phone can say about its own notes offline (used to cross-check the gateway's index). */
  nullifierOf(pos) {
    const n = this.notes.get(pos)
    return nullifier(this.me.nk, commitment(n.amount, this.me.ownerKey, n.blinding), pos)
  }
}

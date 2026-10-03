// Input-note selection and change, shared by the phone (which chooses the notes) and the gateway (which rebuilds the
// same transaction).
// Notes are { pos, amount, ... } with amount in AUSD base units (6 decimals).
import crypto from 'node:crypto'

/** Notes under 0.001 AUSD are ignored by both sides: never counted, never selected. */
export const MIN_NOTE = 1000n
export const CIRCUITS = [2, 6, 12]

/** Unspent, at least MIN_NOTE, and not pending (an input of a payment whose Sent hasn't arrived). */
export const eligible = (notes, pending = new Set()) => notes.filter((n) => !n.spent && n.amount >= MIN_NOTE && !pending.has(n.pos))

const sum = (ns) => ns.reduce((s, n) => s + n.amount, 0n)
const largestFirst = (ns) => [...ns].sort((a, b) => (a.amount === b.amount ? a.pos - b.pos : a.amount > b.amount ? -1 : 1))

/**
 * The circuit the rule picks for eligible notes and T = amount + fee: { circuit } or { err: 'FUNDS' | 'MERGE' }.
 *   sum < T: FUNDS.  n >= 12: 12-in if the 12 largest cover T, else MERGE.
 *   6 <= n <= 11: 6-in if the 6 largest cover T, else 12-in.  n < 6: 2-in if the 2 largest cover T, else 6-in.
 * It does not depend on the random fill, so the gateway can recompute it.
 */
export function planCircuit(notes, T) {
  const sorted = largestFirst(notes)
  const top = (k) => sum(sorted.slice(0, k))
  const n = sorted.length
  if (sum(sorted) < T) return { err: 'FUNDS' }
  if (n >= 12) return top(12) >= T ? { circuit: 12 } : { err: 'MERGE' }
  if (n >= 6) return { circuit: top(6) >= T ? 6 : 12 }
  return { circuit: top(2) >= T ? 2 : 6 }
}

/** Change under MIN_NOTE isn't created: it goes to the gateway on top of the fee. { change, fee } in base units. */
export function settle(total, amount, fee) {
  const change = total - amount - fee
  return change < MIN_NOTE ? { change: 0n, fee: fee + change } : { change, fee }
}

/** Real inputs the rule's circuit takes: all of them up to its size. The rest of the slots are dummies. */
export const realInputs = (notes, circuit) => Math.min(circuit, notes.length)

/**
 * { circuit, ins } or { err }. Largest notes until T is covered, then random eligible notes until the circuit is
 * full or none are left. ins are sorted by tree position. rng(k) returns an integer in [0, k).
 */
export function selectNotes(notes, T, rng = crypto.randomInt) {
  const plan = planCircuit(notes, T)
  if (plan.err) return plan
  const rest = largestFirst(notes)
  const ins = []
  for (let s = 0n; s < T; s += ins.at(-1).amount) ins.push(rest.shift())
  while (ins.length < plan.circuit && rest.length) ins.push(rest.splice(rng(rest.length), 1)[0])
  return { circuit: plan.circuit, ins: ins.sort((a, b) => a.pos - b.pos) }
}

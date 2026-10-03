// Unit test of the note-selection rule (src/select.mjs): every branch and the boundaries n = 1, 2, 5, 6, 11, 12, 13.
import assert from 'node:assert/strict'
import { MIN_NOTE, eligible, planCircuit, realInputs, selectNotes, settle } from '../src/select.mjs'

const A = (x) => BigInt(Math.round(x * 1e6)) // AUSD -> base units
const notes = (...amounts) => amounts.map((a, i) => ({ pos: 10 + i * 3, amount: A(a) }))
const ones = (k, extra = []) => notes(...Array(k).fill(1), ...extra)
function seeded(seed) {
  // mulberry32
  return (k) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k)
  }
}
let checks = 0
function expect(ns, T, want, label) {
  const r = selectNotes(ns, A(T), seeded(7))
  if (typeof want === 'string') assert.deepEqual(r, { err: want }, label)
  else {
    assert.equal(r.circuit, want.circuit, label)
    assert.equal(r.ins.length, want.real, `${label}: real inputs`)
    assert.ok(r.ins.reduce((s, n) => s + n.amount, 0n) >= A(T), `${label}: covers T`)
  }
  checks++
  console.log(`ok  n=${String(ns.length).padStart(2)} T=${T}: ${typeof want === 'string' ? want : `${want.circuit}-in, ${want.real} real`}  (${label})`)
}

console.log('-- n < 6')
expect(notes(5), 3, { circuit: 2, real: 1 }, 'n=1, one note covers: 1 real + 1 dummy')
expect(notes(2), 3, 'FUNDS', 'n=1, short')
expect(notes(2, 2), 3, { circuit: 2, real: 2 }, 'n=2, two cover')
expect(notes(5, 2), 3, { circuit: 2, real: 2 }, 'n=2, largest alone covers, the other fills the slot')
expect(notes(1, 1), 3, 'FUNDS', 'n=2, short')
expect(notes(1, 1, 1, 1, 1), 2, { circuit: 2, real: 2 }, 'n=5, 2 largest cover exactly (boundary)')
expect(notes(1, 1, 1, 1, 1), 2.01, { circuit: 6, real: 5 }, 'n=5, 2 largest short -> 6-in with all 5')
expect(notes(1, 1, 1, 1, 1), 5.01, 'FUNDS', 'n=5, short')
console.log('-- 6 <= n <= 11')
expect(ones(6), 1, { circuit: 6, real: 6 }, 'n=6: 6-in even though 1 note covers')
expect(ones(6), 6, { circuit: 6, real: 6 }, 'n=6, all 6 exactly')
expect(ones(6), 6.01, 'FUNDS', 'n=6, short')
expect(ones(11), 6, { circuit: 6, real: 6 }, 'n=11, 6 largest cover exactly')
expect(ones(11), 6.01, { circuit: 12, real: 11 }, 'n=11, 6 largest short -> 12-in with all 11 + 1 dummy')
expect(ones(11), 11.01, 'FUNDS', 'n=11, short')
console.log('-- n >= 12')
expect(ones(12), 0.5, { circuit: 12, real: 12 }, 'n=12: 12-in, all 12')
expect(ones(12), 12, { circuit: 12, real: 12 }, 'n=12, exactly')
expect(ones(12), 12.01, 'FUNDS', 'n=12, short')
expect(ones(13), 12, { circuit: 12, real: 12 }, 'n=13, 12 largest cover exactly')
expect(ones(13), 12.5, 'MERGE', 'n=13, 12 largest short but all 13 cover')
expect(ones(13), 13.01, 'FUNDS', 'n=13, short')
expect(ones(13), 0.05, { circuit: 12, real: 12 }, 'n=13, merge to self (T = fee)')

console.log('-- largest first, then random fill, sorted by position')
{
  const ns = notes(1, 4, 1, 1, 3, 1, 1, 1) // n=8 -> 6-in; T=6 needs 4 + 3 = 7 -> 2 largest, 4 random of the six 1s
  const r = selectNotes(ns, A(6), seeded(1))
  assert.equal(r.circuit, 6)
  assert.ok(r.ins.some((n) => n.amount === A(4)) && r.ins.some((n) => n.amount === A(3)), 'largest notes taken first')
  assert.deepEqual(r.ins.map((n) => n.pos), [...r.ins.map((n) => n.pos)].sort((a, b) => a - b), 'sorted by position')
  const picks = new Set()
  for (let s = 0; s < 50; s++) picks.add(selectNotes(ns, A(6), seeded(s)).ins.map((n) => n.pos).join())
  assert.ok(picks.size > 1, 'fill is random')
  assert.deepEqual(selectNotes(ns, A(6), seeded(3)), selectNotes(ns, A(6), seeded(3)), 'same seed, same pick')
  assert.equal(selectNotes(ns, A(6)).ins.length, 6, 'default crypto rng')
  checks += 5
  console.log(`ok  2 largest + 4 random, ${picks.size} different fills over 50 seeds, sorted, seedable`)
}

console.log('-- eligibility: 0.001 AUSD floor, spent, pending')
{
  const ns = [
    { pos: 1, amount: MIN_NOTE - 1n },
    { pos: 2, amount: MIN_NOTE },
    { pos: 3, amount: A(1), spent: true },
    { pos: 4, amount: A(1) },
    { pos: 5, amount: A(1) },
  ]
  assert.deepEqual(eligible(ns, new Set([5])).map((n) => n.pos), [2, 4])
  // the 0.000999 note is never counted: 0.001 + 1 = 1.001 < 1.0015
  assert.deepEqual(selectNotes(eligible(ns, new Set([5])), 1001500n), { err: 'FUNDS' })
  checks += 2
  console.log('ok  0.000999 ignored, 0.001 counted, spent and pending excluded')
}

console.log('-- invariants over random cases')
{
  const rng = seeded(42)
  for (let i = 0; i < 3000; i++) {
    const ns = Array.from({ length: rng(16) }, (_, j) => ({ pos: j * 5 + rng(5), amount: BigInt(1000 + rng(5_000_000)) }))
    const T = BigInt(rng(40_000_000))
    const r = selectNotes(ns, T, rng)
    assert.deepEqual(r.err ?? r.circuit, planCircuit(ns, T).err ?? planCircuit(ns, T).circuit)
    if (r.err) continue
    assert.equal(r.ins.length, realInputs(ns, r.circuit))
    assert.ok(r.ins.reduce((s, n) => s + n.amount, 0n) >= T)
    assert.equal(new Set(r.ins.map((n) => n.pos)).size, r.ins.length)
  }
  checks++
  console.log('ok  3000 random cases: plan matches, real inputs = min(circuit, n), covers T, no repeats')
}
console.log('-- change under 0.001 AUSD goes to the fee')
const FEE = 10000n // 0.01
for (const [total, amount, want, why] of [
  [5000000n, 2000000n, { change: 2990000n, fee: FEE }, 'normal change'],
  [2011000n, 2000000n, { change: 1000n, fee: FEE }, 'change of exactly 0.001 is kept'],
  [2010999n, 2000000n, { change: 0n, fee: FEE + 999n }, '0.000999 change donated'],
  [2010000n, 2000000n, { change: 0n, fee: FEE }, 'exact: no change'],
]) {
  assert.deepEqual(settle(total, amount, FEE), want, why)
  checks++
  console.log(`ok  ${why}`)
}

console.log(`select test passed (${checks} checks)`)

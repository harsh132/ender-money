/**
 * Input-note selection and change, shared by the phone (which chooses the
 * notes) and the gateway (which answers ERR FUNDS / ERR MERGE at SEND time).
 * Port of spikes/nova-splitkey/src/select.mjs. Amounts in AUSD base units (6 decimals).
 */

/** Notes under 0.001 AUSD are ignored by both sides: never counted, never selected. */
export const MIN_NOTE = 1000n;
export const CIRCUITS = [2, 6, 12];

export type SelectableNote = { pos: number; amount: bigint; spent?: boolean };

/** Unspent, at least MIN_NOTE, and not pending (an input of a payment whose Sent hasn't arrived). */
export const eligible = <N extends SelectableNote>(notes: N[], pending: Set<number> = new Set()) =>
  notes.filter((n) => !n.spent && n.amount >= MIN_NOTE && !pending.has(n.pos));

const sum = (ns: SelectableNote[]) => ns.reduce((s, n) => s + n.amount, 0n);
const largestFirst = <N extends SelectableNote>(ns: N[]) =>
  [...ns].sort((a, b) => (a.amount === b.amount ? a.pos - b.pos : a.amount > b.amount ? -1 : 1));

export type Plan = { circuit: number; err?: undefined } | { err: 'FUNDS' | 'MERGE'; circuit?: undefined };

/**
 * The circuit the rule picks for eligible notes and T = amount + fee.
 *   sum < T: FUNDS.  n >= 12: 12-in if the 12 largest cover T, else MERGE.
 *   6 <= n <= 11: 6-in if the 6 largest cover T, else 12-in.  n < 6: 2-in if the 2 largest cover T, else 6-in.
 */
export const planCircuit = (notes: SelectableNote[], T: bigint): Plan => {
  const sorted = largestFirst(notes);
  const top = (k: number) => sum(sorted.slice(0, k));
  const n = sorted.length;
  if (sum(sorted) < T) return { err: 'FUNDS' };
  if (n >= 12) return top(12) >= T ? { circuit: 12 } : { err: 'MERGE' };
  if (n >= 6) return { circuit: top(6) >= T ? 6 : 12 };
  return { circuit: top(2) >= T ? 2 : 6 };
};

/** Change under MIN_NOTE isn't created: it goes to the gateway on top of the fee. */
export const settle = (total: bigint, amount: bigint, fee: bigint) => {
  const change = total - amount - fee;
  return change < MIN_NOTE ? { change: 0n, fee: fee + change } : { change, fee };
};

/** Uniform integer in [0, k) from crypto.getRandomValues (the app polyfills it on Hermes). */
export const randomInt = (k: number) => {
  const limit = 2 ** 32 - (2 ** 32 % k);
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b);
  while (b[0]! >= limit);
  return b[0]! % k;
};

/**
 * Largest notes until T is covered, then random eligible notes until the
 * circuit is full or none are left. ins are sorted by tree position. rng(k)
 * returns an integer in [0, k).
 */
export const selectNotes = <N extends SelectableNote>(
  notes: N[],
  T: bigint,
  rng: (k: number) => number = randomInt,
): { circuit: number; ins: N[]; err?: undefined } | { err: 'FUNDS' | 'MERGE' } => {
  const plan = planCircuit(notes, T);
  if (plan.err) return { err: plan.err };
  const rest = largestFirst(notes);
  const ins: N[] = [];
  for (let s = 0n; s < T; s += ins[ins.length - 1]!.amount) ins.push(rest.shift()!);
  while (ins.length < plan.circuit && rest.length) ins.push(rest.splice(rng(rest.length), 1)[0]!);
  return { circuit: plan.circuit, ins: ins.sort((a, b) => a.pos - b.pos) };
};

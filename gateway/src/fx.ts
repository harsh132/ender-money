/**
 * INR per USD for the app's "≈ ₹" line (AUSD is a dollar). Frankfurter serves
 * the European Central Bank's daily rates with no key.
 *
 * Cached per isolate for an hour. If a fetch fails, the last known rate is
 * returned, or undefined: replies then leave `inr` out and the app keeps the
 * rate it already has (it ships with 96).
 */
const SOURCE = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR';
const TTL_MS = 3600_000;

let cached: { rate: string; at: number } | undefined;

export const inrPerUsd = async (): Promise<string | undefined> => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rate;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(3000) });
    const rate = ((await res.json()) as { rates?: { INR?: number } }).rates?.INR;
    if (!res.ok || typeof rate !== 'number' || !(rate > 0)) throw new Error(`bad FX response ${res.status}`);
    cached = { rate: rate.toFixed(2), at: Date.now() };
  } catch (error) {
    console.warn('fx: using last known INR rate', error instanceof Error ? error.message : error);
  }
  return cached?.rate;
};

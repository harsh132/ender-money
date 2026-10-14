// urbit-ob ships no types; the one function the pay page's sigil uses (as app/src/types/urbit-ob.d.ts).
declare module 'urbit-ob' {
  /** Number to point name, e.g. `0x2ea1403b` → `~socteg-lagteg`. Throws on invalid input. */
  export const patp: (value: number | string | bigint) => string;
}

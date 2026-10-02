/**
 * urbit-ob ships no types. Only the point-naming half is used here — the
 * `@p` encoding that turns a 32-bit number into the name a sigil is drawn from.
 */
declare module 'urbit-ob' {
  /** Number to point name, e.g. `0x2ea1403b` → `~socteg-lagteg`. Throws on invalid input. */
  export const patp: (value: number | string | bigint) => string;
  /** Point name back to its number. */
  export const patp2dec: (name: string) => string;
  export const isValidPatp: (name: string) => boolean;
}

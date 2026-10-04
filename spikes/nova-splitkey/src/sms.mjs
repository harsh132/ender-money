// SMS formats for shielded payments. SEND and ERR are protocol/sms.ts unchanged; Q, SIG, Sent and Got are the
// shielded variants. Every message goes through checkSms: printable ASCII, one GSM-7 segment (protocol/sms.ts).
import { fitsOneSegment, septets, parseCommand, formatCommand, formatReply, SESSION_ID_ALPHABET, shortHex } from '../../../protocol/sms.ts'

export { parseCommand, formatCommand, formatReply, septets, shortHex, SESSION_ID_ALPHABET }

/** Standard base64 without padding: all of A-Z a-z 0-9 + / are in the GSM-7 basic alphabet. */
export const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '')
const unb64 = (s, n) => {
  const b = Buffer.from(s, 'base64')
  return b.length === n ? b : null
}
const ID = '([23456789ABCDEFGHJKMNPQRSTVWXYZ]{4})'
const AMT = '(\\d+(?:\\.\\d{1,6})?)'

export function checkSms(text) {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error(`SMS is not printable ASCII: ${JSON.stringify(text)}`)
  if (!fitsOneSegment(text)) throw new Error(`SMS does not fit one GSM-7 segment (${text.length}): ${text}`)
  return text
}

// MERGE: a payment to self of 0 AUSD (T = fee alone) that turns many small notes into one. Spike-only command.
export const MERGE = 'MERGE'

// Q <id> exp=<unix> fee=<AUSD> to=<64-byte shielded address, base64 | 0x EVM address>  (the phone picks the notes)
// Deposit quote (answers SHIELD): Q <id> exp=<unix> fee=<AUSD>, no to=.
const toField = (to) => (to === undefined ? '' : ` to=${typeof to === 'string' ? to : b64(to)}`)
export const formatQuote = ({ id, exp, fee, to }) => checkSms(`Q ${id} exp=${exp} fee=${fee}${toField(to)}`)
export function parseQuote(text) {
  const m = new RegExp(`^Q ${ID} exp=(\\d{1,12}) fee=${AMT}(?: to=(0x[0-9a-fA-F]{40}|[A-Za-z0-9+/]{86}))?$`).exec(text)
  if (!m) return null
  const to = m[4] === undefined ? undefined : m[4].startsWith('0x') ? m[4].toLowerCase() : unb64(m[4], 64)
  return { id: m[1], exp: Number(m[2]), fee: m[3], to }
}

// SHIELD <amount> AUSD: deposit from the phone's own EOA. The reply SIG has today's shape, SIG <id> <88-char base64
// of a 65-byte secp256k1 signature> (protocol/sms.ts formatCommand/parseCommand), here an EIP-3009 authorization.
export const formatShield = (amount) => checkSms(`SHIELD ${amount} AUSD`)
export function parseShield(text) {
  const m = new RegExp(`^SHIELD ${AMT} AUSD$`).exec(text)
  return m && Number(m[1]) > 0 ? { amount: m[1] } : null
}

// Shielded <amt> AUSD. Tx <short hash> p=<tree position of the new note>
export const formatShielded = ({ amount, tx, p }) => checkSms(`Shielded ${amount} AUSD. Tx ${shortHex(tx)} p=${p}`)
export function parseShielded(text) {
  const m = new RegExp(`^Shielded ${AMT} AUSD\\. Tx (\\S+) p=(\\d{1,8})$`).exec(text)
  return m ? { amount: m[1], tx: m[2], p: Number(m[3]) } : null
}

// Note refs: 3 base64 characters per input = tree position mod 2^18 (262,144), concatenated. Positions past that can
// collide; the gateway resolves that by trying the candidates against the signature.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' // RFC 4648, all GSM-7
export const REF_MOD = 1 << 18
export const encodeRefs = (positions) => positions.map((p) => [12, 6, 0].map((k) => B64[((p % REF_MOD) >> k) & 63]).join('')).join('')
export const decodeRefs = (s) => s.match(/.{3}/g).map((t) => [...t].reduce((v, c) => v * 64 + B64.indexOf(c), 0))

// SIG <id> <refs of the 1-12 real inputs, by tree position> <64-byte EdDSA signature, base64>
// (today's SIG carries a 65-byte secp256k1 signature and no refs, so the shape tells them apart)
export const formatSig = (id, sig, positions) => checkSms(`SIG ${id} ${encodeRefs(positions)} ${b64(sig)}`)
export function parseSig(text) {
  const m = new RegExp(`^SIG ${ID} ((?:[A-Za-z0-9+/]{3}){1,12}) ([A-Za-z0-9+/]{86})$`).exec(text)
  return m ? { id: m[1], refs: decodeRefs(m[2]), sig: unb64(m[3], 64) } : null
}

// Sent <amt> AUSD to <who>. Tx <short hash> p=<tree position of output 0; change is p+1>
export const formatSent = ({ amount, to, tx, p }) => checkSms(`Sent ${amount} AUSD to ${to}. Tx ${shortHex(tx)}${p === undefined ? '' : ` p=${p}`}`)
export function parseSent(text) {
  const m = /^Sent (\S+) AUSD to (\S+)\. Tx (\S+)(?: p=(\d{1,8}))?$/.exec(text)
  return m ? { amount: m[1], to: m[2], tx: m[3], p: m[4] === undefined ? undefined : Number(m[4]) } : null
}

// Got <amt> AUSD from <who> p=<tree position> b=<blinding, 32 bytes base64>: an offline phone learns a note
export const formatGot = ({ amount, from, p, blinding }) => checkSms(`Got ${amount} AUSD from ${from} p=${p} b=${b64(blinding)}`)
export function parseGot(text) {
  const m = new RegExp(`^Got ${AMT} AUSD from (\\S+) p=(\\d{1,8}) b=([A-Za-z0-9+/]{43})$`).exec(text)
  return m ? { amount: m[1], from: m[2], p: Number(m[3]), blinding: BigInt('0x' + unb64(m[4], 32).toString('hex')) } : null
}

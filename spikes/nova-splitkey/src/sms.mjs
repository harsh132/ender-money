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

// Q <id> exp=<unix> fee=<AUSD> in=<pos>[,<pos>] to=<64-byte shielded address, base64 | 0x EVM address>
export const formatQuote = ({ id, exp, fee, ins, to }) =>
  checkSms(`Q ${id} exp=${exp} fee=${fee} in=${ins.join(',')} to=${typeof to === 'string' ? to : b64(to)}`)
export function parseQuote(text) {
  const m = new RegExp(`^Q ${ID} exp=(\\d{1,12}) fee=${AMT} in=(\\d{1,8}(?:,\\d{1,8})?) to=(0x[0-9a-fA-F]{40}|[A-Za-z0-9+/]{86})$`).exec(text)
  if (!m) return null
  return { id: m[1], exp: Number(m[2]), fee: m[3], ins: m[4].split(',').map(Number), to: m[5].startsWith('0x') ? m[5].toLowerCase() : unb64(m[5], 64) }
}

// SIG <id> <64-byte EdDSA signature, base64>  (today's SIG carries a 65-byte secp256k1 signature; length tells them apart)
export const formatSig = (id, sig) => checkSms(`SIG ${id} ${b64(sig)}`)
export function parseSig(text) {
  const m = new RegExp(`^SIG ${ID} ([A-Za-z0-9+/]{86})$`).exec(text)
  return m ? { id: m[1], sig: unb64(m[2], 64) } : null
}

// Sent <amt> AUSD to <who>. Tx <short hash> p=<tree position of output 0; change is p+1>
export const formatSent = ({ amount, to, tx, p }) => checkSms(`Sent ${amount} AUSD to ${to}. Tx ${shortHex(tx)} p=${p}`)
export function parseSent(text) {
  const m = /^Sent (\S+) AUSD to (\S+)\. Tx (\S+) p=(\d{1,8})$/.exec(text)
  return m ? { amount: m[1], to: m[2], tx: m[3], p: Number(m[4]) } : null
}

// Got <amt> AUSD from <who> p=<tree position> b=<blinding, 32 bytes base64>: an offline phone learns a note
export const formatGot = ({ amount, from, p, blinding }) => checkSms(`Got ${amount} AUSD from ${from} p=${p} b=${b64(blinding)}`)
export function parseGot(text) {
  const m = new RegExp(`^Got ${AMT} AUSD from (\\S+) p=(\\d{1,8}) b=([A-Za-z0-9+/]{43})$`).exec(text)
  return m ? { amount: m[1], from: m[2], p: Number(m[3]), blinding: BigInt('0x' + unb64(m[4], 32).toString('hex')) } : null
}

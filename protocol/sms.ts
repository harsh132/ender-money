/**
 * The SMS protocol between the app and the gateway, in both directions.
 *
 * App → gateway: `SYNC [T]`, `SEND <to>, <amount> AUSD[ > CTK]`, `SIG <id> <sig>`.
 * Gateway → app: `OK …`, `Q …`, `Sent …`, `ERR …`, plus alerts and OTPs.
 *
 * Private payments (shielded pool, testnet only; see protocol/shielded.ts):
 *   `SEND` is always public. A private payment is `PAY <+number|0x…>, <amount> AUSD`
 *   (to a number: a shielded transfer; to an address: a withdrawal from the pool).
 *   `SHIELD <amount> AUSD` deposits from the user's own account; `MERGE` folds
 *   many notes into one. Replies: `Q <id> exp=… fee=…[ to=…]` (no `n=`, which
 *   is how it differs from the public quote), `Sent … p=<pos>`,
 *   `Shielded <amt> AUSD. Tx … p=<pos>`, `Got <amt> AUSD from <who> p=<pos> b=<blinding>`.
 *   The private `SIG <id> <refs> <signature>` has three fields after `SIG`, the
 *   public one two. A deposit's SIG has the public shape (a 65-byte EIP-3009 signature).
 *
 * Every message must fit one GSM-7 segment (160 septets). Anything outside the
 * GSM-7 alphabet, even one "…" or "₹", turns the whole text into UCS-2 and
 * cuts the segment to 70 characters, so formatters only ever emit ASCII and
 * `septets` refuses anything else.
 */
import { bytesToBigInt, bytesToHex, hexToBytes, isAddress, numberToBytes, type Address, type Hex } from 'viem';

export type NetworkCode = 'mainnet' | 'testnet';
export type Deliver = 'AUSD' | 'CTK';

export type Command =
  | { kind: 'sync'; network: NetworkCode }
  | { kind: 'send'; to: string; amount: string; deliver: Deliver }
  | { kind: 'sig'; id: string; signature: Hex };

/** Private-payment commands; a separate union so `Command` handlers stay exhaustive. */
export type ShieldedCommand =
  | { kind: 'pay'; to: string; amount: string }
  | { kind: 'shield'; amount: string }
  | { kind: 'merge' }
  /** refs: tree positions of the 1-12 real input notes (sent mod REF_MOD); signature: 64-byte EdDSA. */
  | { kind: 'shieldedSig'; id: string; refs: number[]; signature: Uint8Array };

export type Reply =
  | { kind: 'ok'; nonce: bigint; delegated: boolean; balance: string; inr?: string }
  | { kind: 'quote'; id: string; nonce: bigint; expires: number; fee: string; to: Address; out?: string }
  /** p: tree position of output 0 of a private payment (change is p+1); absent for public sends and change-less withdrawals. */
  | { kind: 'sent'; amount: string; to: string; tx: string; p?: number }
  | { kind: 'error'; id?: string; code: string }
  /** to: a 64-byte shielded address (transfer), a 0x address (withdrawal), or absent (deposit, answering SHIELD). */
  | { kind: 'shieldedQuote'; id: string; expires: number; fee: string; to?: Address | Uint8Array }
  | { kind: 'shielded'; amount: string; tx: string; p: number }
  | { kind: 'got'; amount: string; from: string; p: number; blinding: bigint };

export const SEGMENT_SEPTETS = 160;

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f';

/** Length in GSM-7 septets, or null if the text needs UCS-2. Extended characters cost two. */
export const septets = (text: string): number | null => {
  let n = 0;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) n += 1;
    else if (GSM7_EXTENDED.includes(ch)) n += 2;
    else return null;
  }
  return n;
};

export const fitsOneSegment = (text: string) => {
  const n = septets(text);
  return n !== null && n <= SEGMENT_SEPTETS;
};

/** A formatter's output must fit one segment; anything longer is a bug, not a user error. */
const oneSegment = (text: string) => {
  if (!fitsOneSegment(text)) throw new Error(`SMS does not fit one GSM-7 segment: ${JSON.stringify(text)}`);
  return text;
};

export const isPhone = (s: string) => /^\+[1-9]\d{7,14}$/.test(s);

/**
 * A sender number as a carrier or the relay phone reports it, in E.164, or null
 * for anything that isn't a personal number (alphanumeric senders like
 * "VM-AIRTEL", short codes). Bare national numbers get the default country.
 */
export const normalizePhone = (raw: string, defaultCountry = '91'): string | null => {
  const s = raw.replace(/[\s\-()]/g, '');
  let e164: string;
  if (s.startsWith('+')) e164 = s;
  else if (s.startsWith('00')) e164 = `+${s.slice(2)}`;
  else if (/^0\d{10}$/.test(s)) e164 = `+${defaultCountry}${s.slice(1)}`;
  else if (/^\d{10}$/.test(s)) e164 = `+${defaultCountry}${s}`;
  else if (s.startsWith(defaultCountry) && s.length === defaultCountry.length + 10) e164 = `+${s}`;
  else return null;
  return isPhone(e164) ? e164 : null;
};
/** Session ids: 4 chars, Crockford-ish base32 without look-alikes (no 0/1/I/L/O/U). */
export const SESSION_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const isSessionId = (s: string) => /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(s);
const isAmount = (s: string) => /^\d+(\.\d{1,6})?$/.test(s) && Number(s) > 0;

/** 65-byte signatures travel as standard base64: 88 characters, all GSM-7. */
export const signatureToBase64 = (sig: Hex) => btoa(String.fromCharCode(...hexToBytes(sig)));
export const signatureFromBase64 = (b64: string): Hex | null => {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return bytes.length === 65 ? bytesToHex(bytes) : null;
  } catch {
    return null;
  }
};

/** Standard base64 without padding; all of A-Z a-z 0-9 + / are GSM-7. */
export const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
export const unb64 = (s: string, n: number): Uint8Array | null => {
  try {
    const bytes = Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return bytes.length === n ? bytes : null;
  } catch {
    return null;
  }
};

/**
 * Note refs in a private SIG: 3 base64 characters per input, the note's tree
 * position mod 2^18, concatenated. Past 262,144 leaves refs can collide; the
 * gateway tries each candidate against the signature.
 */
export const REF_MOD = 1 << 18;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const encodeRefs = (positions: number[]) =>
  positions.map((p) => [12, 6, 0].map((k) => B64[((p % REF_MOD) >> k) & 63]).join('')).join('');
export const decodeRefs = (s: string) => s.match(/.{3}/g)!.map((t) => [...t].reduce((v, c) => v * 64 + B64.indexOf(c), 0));

/** `0x1234…abcd` in ASCII: `0x1234...abcd`. */
export const shortHex = (hex: string, head = 4, tail = 2) => `${hex.slice(0, 2 + head)}...${hex.slice(-tail)}`;

// ---------- app → gateway

export const parseCommand = (raw: string): Command | null => {
  const text = raw.trim().replace(/\s+/g, ' ');
  const [word, ...rest] = text.split(' ');
  switch (word?.toUpperCase()) {
    case 'SYNC': {
      if (rest.length === 0) return { kind: 'sync', network: 'mainnet' };
      if (rest.length === 1 && rest[0]!.toUpperCase() === 'T') return { kind: 'sync', network: 'testnet' };
      return null;
    }
    case 'SEND': {
      const m = /^(\S+), ?(\S+) AUSD(?: > (CTK))?$/i.exec(rest.join(' '));
      if (!m) return null;
      const [, to, amount, ctk] = m;
      const recipient = isAddress(to!) ? to!.toLowerCase() : to!;
      if (!isAddress(recipient) && !isPhone(recipient)) return null;
      if (!isAmount(amount!)) return null;
      return { kind: 'send', to: recipient, amount: amount!, deliver: ctk ? 'CTK' : 'AUSD' };
    }
    case 'SIG': {
      if (rest.length !== 2) return null;
      const id = rest[0]!.toUpperCase();
      const signature = signatureFromBase64(rest[1]!);
      if (!isSessionId(id) || !signature) return null;
      return { kind: 'sig', id, signature };
    }
    default:
      return null;
  }
};

export const formatCommand = (c: Command): string => {
  switch (c.kind) {
    case 'sync':
      return oneSegment(c.network === 'testnet' ? 'SYNC T' : 'SYNC');
    case 'send':
      return oneSegment(`SEND ${c.to}, ${c.amount} AUSD${c.deliver === 'CTK' ? ' > CTK' : ''}`);
    case 'sig':
      return oneSegment(`SIG ${c.id} ${signatureToBase64(c.signature)}`);
  }
};

/** `PAY`, `SHIELD`, `MERGE` and the private `SIG` (three fields); parseCommand returns null for all of them. */
export const parseShieldedCommand = (raw: string): ShieldedCommand | null => {
  const text = raw.trim().replace(/\s+/g, ' ');
  const [word, ...rest] = text.split(' ');
  switch (word?.toUpperCase()) {
    case 'PAY': {
      const m = /^(\S+), ?(\S+) AUSD$/i.exec(rest.join(' '));
      if (!m) return null;
      const to = isAddress(m[1]!) ? m[1]!.toLowerCase() : m[1]!;
      if ((!isAddress(to) && !isPhone(to)) || !isAmount(m[2]!)) return null;
      return { kind: 'pay', to, amount: m[2]! };
    }
    case 'SHIELD': {
      const m = /^(\S+) AUSD$/i.exec(rest.join(' '));
      return m && isAmount(m[1]!) ? { kind: 'shield', amount: m[1]! } : null;
    }
    case 'MERGE':
      return rest.length === 0 ? { kind: 'merge' } : null;
    case 'SIG': {
      if (rest.length !== 3) return null;
      const id = rest[0]!.toUpperCase();
      const signature = /^[A-Za-z0-9+/]{86}$/.test(rest[2]!) ? unb64(rest[2]!, 64) : null;
      if (!isSessionId(id) || !/^(?:[A-Za-z0-9+/]{3}){1,12}$/.test(rest[1]!) || !signature) return null;
      return { kind: 'shieldedSig', id, refs: decodeRefs(rest[1]!), signature };
    }
    default:
      return null;
  }
};

export const formatShieldedCommand = (c: ShieldedCommand): string => {
  switch (c.kind) {
    case 'pay':
      return oneSegment(`PAY ${c.to}, ${c.amount} AUSD`);
    case 'shield':
      return oneSegment(`SHIELD ${c.amount} AUSD`);
    case 'merge':
      return 'MERGE';
    case 'shieldedSig':
      return oneSegment(`SIG ${c.id} ${encodeRefs(c.refs)} ${b64(c.signature)}`);
  }
};

// ---------- gateway → app

export const formatReply = (r: Reply): string => {
  switch (r.kind) {
    case 'ok':
      return oneSegment(`OK n=${r.nonce} dlg=${r.delegated ? 1 : 0} AUSD=${r.balance}${r.inr ? ` inr=${r.inr}` : ''}`);
    case 'quote':
      return oneSegment(
        `Q ${r.id} n=${r.nonce} exp=${r.expires} fee=${r.fee} to=${r.to}${r.out ? ` out=${r.out}` : ''}`,
      );
    case 'sent':
      return oneSegment(`Sent ${r.amount} AUSD to ${r.to}. Tx ${r.tx}${r.p === undefined ? '' : ` p=${r.p}`}`);
    case 'error':
      return oneSegment(`ERR ${r.id ? `${r.id} ` : ''}${r.code}`);
    case 'shieldedQuote': {
      const to = r.to === undefined ? '' : ` to=${typeof r.to === 'string' ? r.to : b64(r.to)}`;
      return oneSegment(`Q ${r.id} exp=${r.expires} fee=${r.fee}${to}`);
    }
    case 'shielded':
      return oneSegment(`Shielded ${r.amount} AUSD. Tx ${r.tx} p=${r.p}`);
    case 'got':
      return oneSegment(`Got ${r.amount} AUSD from ${r.from} p=${r.p} b=${b64(numberToBytes(r.blinding, { size: 32 }))}`);
  }
};

const fields = (parts: string[]) => Object.fromEntries(parts.map((p) => p.split('=', 2) as [string, string]));

export const parseReply = (raw: string): Reply | null => {
  const text = raw.trim();
  const parts = text.split(/\s+/);
  switch (parts[0]) {
    case 'OK': {
      const f = fields(parts.slice(1));
      if (f.n === undefined || f.dlg === undefined || f.AUSD === undefined) return null;
      return { kind: 'ok', nonce: BigInt(f.n), delegated: f.dlg === '1', balance: f.AUSD, inr: f.inr };
    }
    case 'Q': {
      const f = fields(parts.slice(2));
      if (f.n === undefined) {
        if (!parts[1] || !isSessionId(parts[1]) || !/^\d{1,12}$/.test(f.exp ?? '') || !/^\d+(\.\d{1,6})?$/.test(f.fee ?? '')) return null;
        const r = { kind: 'shieldedQuote', id: parts[1], expires: Number(f.exp), fee: f.fee! } as const;
        if (f.to === undefined) return r;
        if (/^0x[0-9a-fA-F]{40}$/.test(f.to)) return { ...r, to: f.to.toLowerCase() as Address };
        const to = /^[A-Za-z0-9+/]{86}$/.test(f.to) ? unb64(f.to, 64) : null;
        return to ? { ...r, to } : null;
      }
      if (!parts[1] || !f.n || !f.exp || !f.fee || !f.to || !isAddress(f.to)) return null;
      return { kind: 'quote', id: parts[1], nonce: BigInt(f.n), expires: Number(f.exp), fee: f.fee, to: f.to, out: f.out };
    }
    case 'Sent': {
      const m = /^Sent (\S+) AUSD to (\S+)\. Tx (\S+?)(?: p=(\d{1,8}))?$/.exec(text);
      if (!m) return null;
      const r = { kind: 'sent', amount: m[1]!, to: m[2]!, tx: m[3]! } as const;
      return m[4] === undefined ? r : { ...r, p: Number(m[4]) };
    }
    case 'Shielded': {
      const m = /^Shielded (\d+(?:\.\d{1,6})?) AUSD\. Tx (\S+) p=(\d{1,8})$/.exec(text);
      return m ? { kind: 'shielded', amount: m[1]!, tx: m[2]!, p: Number(m[3]) } : null;
    }
    case 'Got': {
      const m = /^Got (\d+(?:\.\d{1,6})?) AUSD from (\S+) p=(\d{1,8}) b=([A-Za-z0-9+/]{43})$/.exec(text);
      const b = m && unb64(m[4]!, 32);
      return m && b ? { kind: 'got', amount: m[1]!, from: m[2]!, p: Number(m[3]), blinding: bytesToBigInt(b) } : null;
    }
    case 'ERR':
      return parts.length === 3
        ? { kind: 'error', id: parts[1], code: parts[2]! }
        : parts.length === 2
          ? { kind: 'error', code: parts[1]! }
          : null;
    default:
      return null;
  }
};

// ---------- gateway → anyone

export const formatAlert = (amount: string, from: string, balance: string) =>
  oneSegment(`Received ${amount} AUSD from ${from}. Balance ${balance} AUSD.`);

export const formatOtp = (code: string) => oneSegment(`Ender code: ${code}. Don't share it.`);

/** Append the app's SMS Retriever hash so Android hands the text to the app without SMS permission. */
export const withRetrieverHash = (text: string, hash?: string) => (hash ? oneSegment(`${text}\n${hash}`) : text);

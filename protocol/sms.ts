/**
 * The SMS protocol between the app and the gateway, in both directions.
 *
 * App → gateway: `SYNC [T]`, `SEND <to>, <amount> AUSD[ > CTK]`, `SIG <id> <sig>`.
 * Gateway → app: `OK …`, `Q …`, `Sent …`, `ERR …`, plus alerts and OTPs.
 *
 * Every message must fit one GSM-7 segment (160 septets). Anything outside the
 * GSM-7 alphabet, even one "…" or "₹", turns the whole text into UCS-2 and
 * cuts the segment to 70 characters, so formatters only ever emit ASCII and
 * `septets` refuses anything else.
 */
import { bytesToHex, hexToBytes, isAddress, type Address, type Hex } from 'viem';

export type NetworkCode = 'mainnet' | 'testnet';
export type Deliver = 'AUSD' | 'CTK';

export type Command =
  | { kind: 'sync'; network: NetworkCode }
  | { kind: 'send'; to: string; amount: string; deliver: Deliver }
  | { kind: 'sig'; id: string; signature: Hex };

export type Reply =
  | { kind: 'ok'; nonce: bigint; delegated: boolean; balance: string; inr?: string }
  | { kind: 'quote'; id: string; nonce: bigint; expires: number; fee: string; to: Address; out?: string }
  | { kind: 'sent'; amount: string; to: string; tx: string }
  | { kind: 'error'; id?: string; code: string };

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
      return oneSegment(`Sent ${r.amount} AUSD to ${r.to}. Tx ${r.tx}`);
    case 'error':
      return oneSegment(`ERR ${r.id ? `${r.id} ` : ''}${r.code}`);
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
      if (!parts[1] || !f.n || !f.exp || !f.fee || !f.to || !isAddress(f.to)) return null;
      return { kind: 'quote', id: parts[1], nonce: BigInt(f.n), expires: Number(f.exp), fee: f.fee, to: f.to, out: f.out };
    }
    case 'Sent': {
      const m = /^Sent (\S+) AUSD to (\S+)\. Tx (\S+)$/.exec(text);
      return m ? { kind: 'sent', amount: m[1]!, to: m[2]!, tx: m[3]! } : null;
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

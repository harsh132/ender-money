/**
 * The SMS protocol between the app and the gateway, in both directions.
 *
 * App → gateway: `SYNC`, `SEND <to>, <amount> AUSD[ > CTK]`, `SIG <id> <sig>`. `<to>` is a 0x
 * address, a +number or an Ender ID (`label.ender.my`); the gateway resolves the last two.
 * Gateway → app: `OK …`, `Q …`, `Sent …`, `ERR …`, plus alerts and OTPs.
 *
 * Every command the phone sends for testnet starts with `[Test] ` too (the
 * formatters take the network); the gateway uses the network it names. No
 * prefix is mainnet for SYNC, and for anything else either mainnet or an
 * older app, so the gateway falls back to its legacy rule (the number's
 * current network; the session's for a SIG; testnet for private commands).
 * The older `SYNC T` still parses as testnet.
 *
 * Private payments (shielded pool, testnet only; see protocol/shielded.ts):
 *   `SEND` is always public. A private payment is `PAY <+number|label.ender.my|ender1…|0x…>, <amount> AUSD`
 *   (to a number, an Ender ID or a private address: a shielded transfer; to a 0x address: a
 *   withdrawal from the pool). `SHIELD <amount> AUSD` deposits from the user's
 *   own account; `MERGE` folds many notes into one. Replies:
 *   `Q <id> exp=… fee=…[ to=…]` (no `n=`, which is how it differs from the
 *   public quote; `to=` is the recipient's packed address for a PAY to a number or an Ender ID,
 *   the 0x address for a withdrawal, and absent for SHIELD, MERGE and a PAY to
 *   an ender1 address, whose key the phone already has),
 *   `Sent <id> <amt> AUSD to=<to> tx=0x1234...ef[ p=<pos>]`, `Shielded <id> <amt> AUSD tx=… p=<pos>`.
 *   `Sent` and `Shielded` carry the id the SIG named; an older gateway's forms
 *   (`… to <to>. Tx …`, no id) still parse. `Sent … to=` (public or private) is the
 *   number the payment was asked for by, else the recipient's Ender ID, else its short address.
 *
 * Alerts, one keyword for both kinds of incoming payment:
 *   public  `Received <amt> AUSD from=<who> balance=<amt> tx=0x1234...ef`
 *   private `Received <amt> AUSD[ from=<Ender ID>] tx=0x1234...ef p=<pos> b=<blinding>`
 * `p=` and `b=` make it private: the note for the cache, and no balance (carriers
 * read texts). `from=` is the sender's Ender ID, else (public only) a verified
 * reverse-ENS name, else (public only) the EIP-55 address; never a number. The older
 * `Received … from 0x…. Balance … AUSD. Tx …` and the private `Got <amt> AUSD (private)
 * p=… b=…` (or `from <who>`) still parse, as public and private `received`.
 * Every reply and alert about testnet starts with `[Test] ` (`test: true`);
 * no tag means mainnet. The app applies each text to the network it names,
 * whatever mode it shows. Every text the gateway sends ends with the SMS
 * Retriever hash on its own line; parseReply reads the first line only.
 *   The private `SIG <id> <refs> <signature>` has three fields after `SIG`, the
 *   public one two. A deposit's SIG has the public shape (a 65-byte EIP-3009 signature).
 *
 * Every message must fit one GSM-7 segment (160 septets). Anything outside the
 * GSM-7 alphabet, even one "…" or "₹", turns the whole text into UCS-2 and
 * cuts the segment to 70 characters, so formatters only ever emit ASCII and
 * `septets` refuses anything else.
 */
import { bytesToBigInt, bytesToHex, getAddress, hexToBytes, isAddress, numberToBytes, type Address, type Hex } from 'viem';
import { enderId, parseEnderId } from './names';
import { isPhone, isPrivateAddress } from './recipient';

export { isPhone, normalizePhone } from './recipient';

export type NetworkCode = 'mainnet' | 'testnet';
export type Deliver = 'AUSD' | 'CTK';

export type Command =
  | { kind: 'sync' }
  | { kind: 'send'; to: string; amount: string; deliver: Deliver }
  | { kind: 'sig'; id: string; signature: Hex };

/** Private-payment commands; a separate union so `Command` handlers stay exhaustive. */
export type ShieldedCommand =
  | { kind: 'pay'; to: string; amount: string }
  | { kind: 'shield'; amount: string }
  | { kind: 'merge' }
  /** refs: tree positions of the 1-12 real input notes (sent mod REF_MOD); signature: 64-byte EdDSA. */
  | { kind: 'shieldedSig'; id: string; refs: number[]; signature: Uint8Array };

/**
 * A parsed command and the network its prefix names: testnet for `[Test] `
 * (or the older `SYNC T`), mainnet for a plain `SYNC`, absent for any other
 * unprefixed command (mainnet, or an older app: the gateway's legacy rule).
 */
export type Parsed<C> = C & { network?: NetworkCode };

/** test: the text is about testnet (`[Test] ` prefix); untagged means mainnet. */
export type Reply = (
  | { kind: 'ok'; nonce: bigint; delegated: boolean; balance: string; inr?: string }
  | { kind: 'quote'; id: string; nonce: bigint; expires: number; fee: string; to: Address; out?: string }
  /**
   * id: the session or quote the SIG named (absent in an older gateway's text).
   * p: tree position of output 0 of a private payment (change is p+1); absent for public sends and change-less withdrawals.
   */
  | { kind: 'sent'; id?: string; amount: string; to: string; tx: string; p?: number }
  | { kind: 'error'; id?: string; code: string }
  /** to: a 64-byte shielded address (transfer), a 0x address (withdrawal), or absent (deposit, answering SHIELD). */
  | { kind: 'shieldedQuote'; id: string; expires: number; fee: string; to?: Address | Uint8Array }
  | { kind: 'shielded'; id?: string; amount: string; tx: string; p: number }
  /**
   * A public incoming transfer. from: an EIP-55 address, the sender's Ender ID or a verified ENS name (isTextName);
   * tx: shortHex of the hash (dedupes against the online history).
   */
  | { kind: 'received'; amount: string; from: string; balance: string; tx: string; test: boolean; p?: undefined; blinding?: undefined }
  /**
   * A private incoming payment: the recipient's note at tree position p. from: the sender's Ender ID, when they
   * have one; tx: shortHex of the pool transaction. Both absent in the older `Got` form.
   */
  | { kind: 'received'; amount: string; from?: string; tx?: string; p: number; blinding: bigint; balance?: undefined }
) & { test?: boolean };

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

/** Longest name a text shows for a sender (`from=`); a longer reverse-ENS name shows as the address. */
export const MAX_TEXT_NAME = 40;

/** A name a text can carry as one field: printable ASCII, no spaces, plain GSM-7 (nothing costing two septets), at most MAX_TEXT_NAME. */
export const isTextName = (s: string) => s.length <= MAX_TEXT_NAME && /^[!-~]+$/.test(s) && septets(s) === s.length;

export const fitsOneSegment = (text: string) => {
  const n = septets(text);
  return n !== null && n <= SEGMENT_SEPTETS;
};

/** A formatter's output must fit one segment; anything longer is a bug, not a user error. */
const oneSegment = (text: string) => {
  if (!fitsOneSegment(text)) throw new Error(`SMS does not fit one GSM-7 segment: ${JSON.stringify(text)}`);
  return text;
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

export const TEST_PREFIX = '[Test] ';
const prefixed = (network: NetworkCode, text: string) => oneSegment(`${network === 'testnet' ? TEST_PREFIX : ''}${text}`);

/** Normalised text without its `[Test] ` prefix (any case, any spacing), and the network the prefix names. */
const unprefix = (raw: string): { text: string; network?: NetworkCode } => {
  const text = raw.trim().replace(/\s+/g, ' ');
  const m = /^\[test\] ?/i.exec(text);
  return m ? { text: text.slice(m[0].length), network: 'testnet' } : { text };
};
const withNetwork = <C extends object>(c: C | null, network?: NetworkCode) => (c && network ? { ...c, network } : c) as Parsed<C> | null;

/**
 * A recipient as the gateway takes it, or null: a 0x address (lowercased), an
 * E.164 number, an Ender ID (`label.ender.my`, also read from `@label`) and,
 * for PAY only, a private address (ender1…, lowercased).
 */
const recipientOf = (to: string, private_: boolean): string | null => {
  if (isAddress(to)) return to.toLowerCase();
  if (isPhone(to)) return to;
  const label = parseEnderId(to);
  if (label) return enderId(label);
  return private_ && isPrivateAddress(to) ? to.toLowerCase() : null;
};

export const parseCommand = (raw: string): Parsed<Command> | null => {
  const { text, network } = unprefix(raw);
  const [word, ...rest] = text.split(' ');
  switch (word?.toUpperCase()) {
    case 'SYNC': {
      if (rest.length === 0) return { kind: 'sync', network: network ?? 'mainnet' };
      if (rest.length === 1 && rest[0]!.toUpperCase() === 'T') return { kind: 'sync', network: 'testnet' };
      return null;
    }
    case 'SEND': {
      const m = /^(\S+), ?(\S+) AUSD(?: > (CTK))?$/i.exec(rest.join(' '));
      if (!m) return null;
      const [, to, amount, ctk] = m;
      const recipient = recipientOf(to!, false);
      if (!recipient || !isAmount(amount!)) return null;
      return withNetwork({ kind: 'send', to: recipient, amount: amount!, deliver: ctk ? 'CTK' : 'AUSD' } as const, network);
    }
    case 'SIG': {
      if (rest.length !== 2) return null;
      const id = rest[0]!.toUpperCase();
      const signature = signatureFromBase64(rest[1]!);
      if (!isSessionId(id) || !signature) return null;
      return withNetwork({ kind: 'sig', id, signature } as const, network);
    }
    default:
      return null;
  }
};

/** `network`: the payment's own (never the mode the app shows); testnet adds `[Test] `. */
export const formatCommand = (c: Command, network: NetworkCode): string => {
  switch (c.kind) {
    case 'sync':
      return prefixed(network, 'SYNC');
    case 'send':
      return prefixed(network, `SEND ${c.to}, ${c.amount} AUSD${c.deliver === 'CTK' ? ' > CTK' : ''}`);
    case 'sig':
      return prefixed(network, `SIG ${c.id} ${signatureToBase64(c.signature)}`);
  }
};

/** `PAY`, `SHIELD`, `MERGE` and the private `SIG` (three fields); parseCommand returns null for all of them. */
export const parseShieldedCommand = (raw: string): Parsed<ShieldedCommand> | null => {
  const { text, network } = unprefix(raw);
  return withNetwork(parseShielded(text), network);
};

const parseShielded = (text: string): ShieldedCommand | null => {
  const [word, ...rest] = text.split(' ');
  switch (word?.toUpperCase()) {
    case 'PAY': {
      const m = /^(\S+), ?(\S+) AUSD$/i.exec(rest.join(' '));
      if (!m) return null;
      const to = recipientOf(m[1]!, true);
      if (!to || !isAmount(m[2]!)) return null;
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

export const formatShieldedCommand = (c: ShieldedCommand, network: NetworkCode): string => {
  switch (c.kind) {
    case 'pay':
      return prefixed(network, `PAY ${c.to}, ${c.amount} AUSD`);
    case 'shield':
      return prefixed(network, `SHIELD ${c.amount} AUSD`);
    case 'merge':
      return prefixed(network, 'MERGE');
    case 'shieldedSig':
      return prefixed(network, `SIG ${c.id} ${encodeRefs(c.refs)} ${b64(c.signature)}`);
  }
};

// ---------- gateway → app

export const formatReply = (r: Reply): string => oneSegment(`${r.test ? TEST_PREFIX : ''}${formatBody(r)}`);

const formatBody = (r: Reply): string => {
  switch (r.kind) {
    case 'ok':
      return oneSegment(`OK n=${r.nonce} dlg=${r.delegated ? 1 : 0} AUSD=${r.balance}${r.inr ? ` inr=${r.inr}` : ''}`);
    case 'quote':
      return oneSegment(
        `Q ${r.id} n=${r.nonce} exp=${r.expires} fee=${r.fee} to=${r.to}${r.out ? ` out=${r.out}` : ''}`,
      );
    case 'sent':
      return oneSegment(`Sent ${r.id ? `${r.id} ` : ''}${r.amount} AUSD to=${r.to} tx=${r.tx}${r.p === undefined ? '' : ` p=${r.p}`}`);
    case 'error':
      return oneSegment(`ERR ${r.id ? `${r.id} ` : ''}${r.code}`);
    case 'shieldedQuote': {
      const to = r.to === undefined ? '' : ` to=${typeof r.to === 'string' ? r.to : b64(r.to)}`;
      return oneSegment(`Q ${r.id} exp=${r.expires} fee=${r.fee}${to}`);
    }
    case 'shielded':
      return oneSegment(`Shielded ${r.id ? `${r.id} ` : ''}${r.amount} AUSD tx=${r.tx} p=${r.p}`);
    case 'received': {
      const from = r.from === undefined ? '' : ` from=${isAddress(r.from) ? getAddress(r.from) : r.from}`;
      if (r.p === undefined) return oneSegment(`Received ${r.amount} AUSD${from} balance=${r.balance} tx=${r.tx}`);
      return oneSegment(`Received ${r.amount} AUSD${from}${r.tx ? ` tx=${r.tx}` : ''} p=${r.p} b=${b64(numberToBytes(r.blinding, { size: 32 }))}`);
    }
  }
};

const fields = (parts: string[]) => Object.fromEntries(parts.map((p) => p.split('=', 2) as [string, string]));

/** One reply, from its first line (the SMS Retriever hash follows on the next). */
export const parseReply = (raw: string): Reply | null => {
  const line = raw.trim().split(/\r?\n/)[0]!.trim();
  const test = line.startsWith(TEST_PREFIX);
  const r = parseBody(test ? line.slice(TEST_PREFIX.length) : line);
  return r && test ? { ...r, test } : r;
};

const parseBody = (text: string): Reply | null => {
  const parts = text.split(/\s+/);
  switch (parts[0]) {
    case 'Received': {
      // Public: from= balance= tx=. Private: [from=] [tx=] p= b=, never balance=.
      const m =
        /^Received (\d+(?:\.\d{1,6})?) AUSD(?: from=(\S+))?(?: balance=(\d+(?:\.\d{1,6})?))?(?: tx=(0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{2}))?(?: p=(\d{1,8}) b=([A-Za-z0-9+/]{43}))?$/.exec(text);
      if (m) {
        const [, amount, rawFrom, balance, rawTx, p, b] = m;
        const from = rawFrom === undefined ? undefined : /^0x[0-9a-fA-F]{40}$/.test(rawFrom) ? getAddress(rawFrom) : isTextName(rawFrom) ? rawFrom : null;
        const tx = rawTx?.toLowerCase();
        if (from === null) return null;
        if (p === undefined) return from && balance && tx ? { kind: 'received', amount: amount!, from, balance, tx, test: false } : null;
        const blinding = balance === undefined ? unb64(b!, 32) : null;
        return blinding ? { kind: 'received', amount: amount!, ...(from ? { from } : {}), ...(tx ? { tx } : {}), p: Number(p), blinding: bytesToBigInt(blinding) } : null;
      }
      // The older public form: `… from 0x…. Balance <amt> AUSD. Tx 0x…`.
      const old = /^Received (\d+(?:\.\d{1,6})?) AUSD from (0x[0-9a-fA-F]{40})\. Balance (\d+(?:\.\d{1,6})?) AUSD\. Tx (0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{2})$/.exec(text);
      return old ? { kind: 'received', amount: old[1]!, from: getAddress(old[2]!), balance: old[3]!, tx: old[4]!.toLowerCase(), test: false } : null;
    }
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
    // An older gateway sent no id and `… to <to>. Tx <tx>` / `… AUSD. Tx <tx>`; both still parse.
    case 'Sent': {
      const m =
        /^Sent (?:([23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}) )?(\d+(?:\.\d{1,6})?) AUSD to=(\S+) tx=(\S+?)(?: p=(\d{1,8}))?$/.exec(text) ??
        /^Sent (?:([23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}) )?(\d+(?:\.\d{1,6})?) AUSD to (\S+)\. Tx (\S+?)(?: p=(\d{1,8}))?$/.exec(text);
      if (!m) return null;
      return { kind: 'sent', ...(m[1] ? { id: m[1] } : {}), amount: m[2]!, to: m[3]!, tx: m[4]!, ...(m[5] === undefined ? {} : { p: Number(m[5]) }) };
    }
    case 'Shielded': {
      const m = /^Shielded (?:([23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}) )?(\d+(?:\.\d{1,6})?) AUSD(?: tx=|\. Tx )(\S+) p=(\d{1,8})$/.exec(text);
      return m ? { kind: 'shielded', ...(m[1] ? { id: m[1] } : {}), amount: m[2]!, tx: m[3]!, p: Number(m[4]) } : null;
    }
    case 'Got': {
      // The older private Received. `from <who>`: older still (and the spike's); the sender is dropped.
      const m = /^Got (\d+(?:\.\d{1,6})?) AUSD (?:\(private\)|from \S+) p=(\d{1,8}) b=([A-Za-z0-9+/]{43})$/.exec(text);
      const b = m && unb64(m[3]!, 32);
      return m && b ? { kind: 'received', amount: m[1]!, p: Number(m[2]), blinding: bytesToBigInt(b) } : null;
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

export const formatOtp = (code: string) => oneSegment(`Ender code: ${code}. Don't share it.`);

/** Append the app's SMS Retriever hash so Android hands the text to the app without SMS permission. */
export const withRetrieverHash = (text: string, hash?: string) => (hash ? oneSegment(`${text}\n${hash}`) : text);

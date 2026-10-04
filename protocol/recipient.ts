/**
 * Who a payment goes to, as people type, paste or scan it: a 0x address, a
 * phone number, or a private (shielded) address. Shared by the app's Send
 * input, scanner and links, and the gateway.
 *
 * Private address: bech32m (BIP-350) with HRP `ender` over the 64-byte packed
 * shielded address (protocol/shielded.ts packAddress: ownerKey || x25519 key).
 * 115 characters, lowercase, all GSM-7, with a checksum that catches typos.
 * BIP-173's 90-character limit is lifted for it.
 */
import { bech32m } from '@scure/base';
import { isAddress, type Address } from 'viem';

export const PRIVATE_HRP = 'ender';
const PACKED_BYTES = 64;
const LIMIT = 200;

export const encodePrivateAddress = (packed: Uint8Array): string => {
  if (packed.length !== PACKED_BYTES) throw new Error('shielded address must be 64 bytes');
  return bech32m.encode(PRIVATE_HRP, bech32m.toWords(packed), LIMIT);
};

/** The 64 packed bytes, or null: wrong prefix, checksum, length or padding. Case-insensitive. */
export const decodePrivateAddress = (s: string): Uint8Array | null => {
  const d = bech32m.decodeUnsafe(s.trim().toLowerCase(), LIMIT);
  if (!d || d.prefix !== PRIVATE_HRP) return null;
  const bytes = bech32m.fromWordsUnsafe(d.words);
  return bytes && bytes.length === PACKED_BYTES ? Uint8Array.from(bytes) : null;
};

export const isPrivateAddress = (s: string) => decodePrivateAddress(s) !== null;

/** `ender1abcd...wxyz`: ASCII, for SMS. */
export const shortPrivateAddress = (a: string) => `${a.slice(0, 10)}...${a.slice(-4)}`;

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

/** `amount`: from a payment URI's `?amount=` (AUSD, up to 6 decimals), when it has a valid one. */
export type ParsedRecipient = (
  | { kind: 'address'; address: Address }
  | { kind: 'phone'; phone: string }
  | { kind: 'private'; packed: Uint8Array }
) & { amount?: string };

/** 0x addresses: lowercase, mixed case only with a valid EIP-55 checksum. */
const bare = (s: string, onlyAddress: boolean): ParsedRecipient | null => {
  if (isAddress(s)) return { kind: 'address', address: s.toLowerCase() as Address };
  if (onlyAddress) return null;
  const packed = decodePrivateAddress(s);
  if (packed) return { kind: 'private', packed };
  const phone = normalizePhone(s);
  return phone ? { kind: 'phone', phone } : null;
};

/**
 * Reads a bare address, number or private address, and the URIs
 * `ethereum:[pay-]0x…[@chain][?amount=…]` (EIP-681; for an ERC-20
 * `…/transfer?address=<recipient>` the recipient is the parameter, not the
 * token) and `ender:<0x…|+number|ender1…>[?amount=…]`.
 */
export const parseRecipient = (input: string): ParsedRecipient | null => {
  const text = input.trim();
  const uri = /^(ethereum|ender):(?:pay-)?([^@?/]+)(?:@\d+)?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(text);
  if (!uri) return bare(text, false);
  const query = new URLSearchParams(uri[4] ?? '');
  const transfer = uri[3]?.toLowerCase() === 'transfer';
  let target: string;
  try {
    target = transfer ? (query.get('address') ?? '') : decodeURIComponent(uri[2]!);
  } catch {
    return null;
  }
  const r = bare(target, uri[1]!.toLowerCase() === 'ethereum');
  // A transfer's uint256 is in token base units; not trusted as an AUSD amount.
  const amount = transfer ? null : query.get('amount');
  return r && amount && /^\d+(\.\d{1,6})?$/.test(amount) && Number(amount) > 0 ? { ...r, amount } : r;
};

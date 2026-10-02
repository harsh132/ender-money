/** Payment codes. Ender shows a plain address (any wallet can read it) and reads a few common shapes. */
import { isAddress } from 'viem';
import { normalizePhone } from '../../../protocol/sms';

export type Scanned = { to: string; amount?: string };

/**
 * Reads: a bare address; `ethereum:0x…[@chain][?value=…|amount=…]` (EIP-681-ish);
 * `ender:<address or +number>[?amount=…]`; a bare phone number.
 */
export const parseCode = (raw: string): Scanned | null => {
  const text = raw.trim();
  if (isAddress(text)) return { to: text.toLowerCase() };
  const m = /^(?:ethereum|ender):(?:pay-)?([^@?/]+)(?:@\d+)?(?:\/[^?]*)?(?:\?(.*))?$/i.exec(text);
  if (m) {
    const target = decodeURIComponent(m[1]!);
    const query = new URLSearchParams(m[2] ?? '');
    const amount = query.get('amount') ?? undefined;
    const to = isAddress(target) ? target.toLowerCase() : normalizePhone(target);
    if (!to) return null;
    return { to, ...(amount && /^\d+(\.\d{1,6})?$/.test(amount) ? { amount } : {}) };
  }
  const phone = normalizePhone(text.replace(/[\s()-]/g, ''));
  return phone ? { to: phone } : null;
};

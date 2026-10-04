/** Money and address formatting. AUSD amounts arrive as decimal strings. */

/** "45.2" -> "45.20"; keeps extra precision when there is any ("0.001"). */
export const usd = (amount: string | number) => {
  const s = typeof amount === 'number' ? amount.toFixed(6) : amount;
  const [int = '0', frac = ''] = s.split('.');
  const trimmed = frac.replace(/0+$/, '');
  const decimals = trimmed.length > 2 ? trimmed : trimmed.padEnd(2, '0');
  return `${Number(int).toLocaleString('en-US')}.${decimals}`;
};

export const inr = (amountUsd: string, rate: number) =>
  Math.round(Number(amountUsd) * rate).toLocaleString('en-IN');

/** `0x1234…abcd`; a private address keeps its prefix: `ender1abcd…wxyz`. */
export const short = (address: string) => `${address.slice(0, address.startsWith('ender1') ? 10 : 6)}…${address.slice(-4)}`;

/** "+919876543210" -> "+91 98765 43210"; other countries just get the code split off. */
export const phoneDisplay = (phone: string) => {
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone);
  return m ? `+91 ${m[1]} ${m[2]}` : phone.replace(/^(\+\d{1,3})(\d+)$/, '$1 $2');
};

/** Settings shows the number half-hidden. */
export const phoneMasked = (phone: string) => {
  const d = phoneDisplay(phone);
  return d.replace(/(\d{2})(\d{3}) (\d{2})(\d{3})$/, '$1••• ••$4');
};

export const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export const ago = (ms: number) => {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

export const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

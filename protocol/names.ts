/**
 * Ender IDs: `<label>.ender.my`, chosen once at signup and permanent. Shared by
 * the app (live check while typing, recipient parsing) and the gateway (signup,
 * lookups, ENS, the pay page).
 *
 * A label is read off one screen and typed into another, so the rules are
 * narrow: ASCII letters, digits and interior hyphens. Unicode would let a
 * Cyrillic `а` register beside a Latin `a`; `--` is punycode's `xn--` and
 * renders as something else in some clients. Case-insensitive: stored and
 * shown lowercase.
 */
export const NAME_PARENT = 'ender.my';
export const MIN_LABEL = 5;
/** 20: the longest ID (29 characters with `.ender.my`) still fits a private `Received` text with `[Test] ` and the hash line. */
export const MAX_LABEL = 20;

/** Names the infrastructure needs, or that would let a holder impersonate the service. */
export const RESERVED_LABELS = [
  'www', 'api', 'app', 'gateway', 'resolver', 'ens', 'mail', 'smtp', 'imap', 'ftp',
  'ns', 'ns1', 'ns2', 'admin', 'administrator', 'root', 'support', 'help',
  'security', 'abuse', 'billing', 'status', 'docs', 'blog', 'about', 'legal',
  'privacy', 'terms', 'ender', 'test', 'staging', 'dev',
  'enderid', 'ender-id', 'ender-money', 'wallet', 'official', 'team', 'payments',
];

export type LabelProblem = 'characters' | 'hyphens' | 'too-short' | 'too-long' | 'reserved';

/** Why `label` can't be an Ender ID, or undefined if it can. Any case; store `label.toLowerCase()`. */
export const validateLabel = (raw: string): LabelProblem | undefined => {
  const label = raw.toLowerCase();
  if (!/^[a-z0-9-]*$/.test(label)) return 'characters';
  if (label.startsWith('-') || label.endsWith('-') || label.includes('--')) return 'hyphens';
  if (label.length < MIN_LABEL) return 'too-short';
  if (label.length > MAX_LABEL) return 'too-long';
  if (RESERVED_LABELS.includes(label)) return 'reserved';
  return undefined;
};

export const enderId = (label: string) => `${label}.${NAME_PARENT}`;

/** The label of `label.ender.my` or `@label` (any case, lowercased), if it is a valid one. */
export const parseEnderId = (s: string): string | null => {
  const m = /^(?:@([^.\s@]+)|([^.\s@]+)\.ender\.my\.?)$/i.exec(s.trim());
  const label = (m?.[1] ?? m?.[2])?.toLowerCase();
  return label && !validateLabel(label) ? label : null;
};

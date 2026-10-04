import type { NetworkName } from '../../../protocol/networks';

export const GATEWAY_URL = process.env.EXPO_PUBLIC_GATEWAY_URL ?? 'https://api.ender.money';
/** Passkey relying party: ender.money serves assetlinks.json for this app's signing key. */
export const RP_ID = 'ender.money';

/**
 * Numbers the app texts when offline. India goes through the relay phone; the
 * international (Twilio) number lands on 9 Oct.
 */
export const GATEWAY_SMS: Record<'india' | 'international', string | undefined> = {
  india: process.env.EXPO_PUBLIC_GATEWAY_SMS_IN ?? '+917004543035',
  international: process.env.EXPO_PUBLIC_GATEWAY_SMS_INTL,
};

/** Shipped rate; replaced by the latest the gateway reports (Frankfurter, USD). */
export const DEFAULT_INR_PER_USD = 96;
/** Fee the app is willing to sign; the gateway quotes it, the app checks it. */
export const MAX_FEE = '0.01';
export const HTTP_TIMEOUT_MS = 5000;

/** Quick send scope (SCOPE.md "Signing sessions"). Constants, not settings. */
export const QUICK_SEND = { perTx: 20, total: 50, minutes: 10 } as const;

export const DEFAULT_NETWORK: NetworkName = 'mainnet';

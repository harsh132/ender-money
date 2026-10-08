/**
 * Sign-in by wallet signature (POST /auth/challenge, /auth/verify): the exact
 * EIP-191 message both sides build. The app builds it itself from the nonce
 * and expiry, so the gateway can never get it to sign anything else.
 */
export const AUTH_DOMAIN = 'ender.money';

/** `expires`: unix seconds. `address` as the app has it; the gateway compares lowercase. */
export const loginMessage = ({ address, nonce, expires }: { address: string; nonce: string; expires: number }) =>
  `${AUTH_DOMAIN} wants you to sign in to Ender with your wallet.\n\n` +
  `Address: ${address.toLowerCase()}\nNonce: ${nonce}\nExpires: ${new Date(expires * 1000).toISOString()}`;

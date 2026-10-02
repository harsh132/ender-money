import { GatewayError } from './core';
import type { Env } from './env';

/**
 * Send a text to a number, picking the transport by country: Indian numbers go
 * through the relay phone (queued up to 10 minutes if it's offline).
 *
 * ponytail: every other country gets an error until the Twilio transport lands
 * on 9 Oct.
 */
export const canText = (to: string) => to.startsWith('+91');

export const sendSms = async (env: Env, to: string, body: string): Promise<{ queued: boolean }> => {
  if (!canText(to)) throw new GatewayError('sms-unavailable', 503);
  return env.RELAY.get(env.RELAY.idFromName('relay')).send(to, body);
};

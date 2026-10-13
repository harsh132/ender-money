import { GatewayError } from './core';
import type { Env } from './env';
import { sendTwilio, twilioReady } from './twilio';

/**
 * Send a text the gateway starts itself (OTP, alerts), picking the transport by
 * country: Indian numbers go through the relay phone (queued up to 10 minutes
 * if it's offline), every other number through Twilio once its secrets are
 * set. Replies to an inbound text don't come here: they go back on the
 * transport the text arrived on.
 */
export const canText = (env: Env, to: string) => to.startsWith('+91') || twilioReady(env);

export const sendSms = async (env: Env, to: string, body: string): Promise<{ queued: boolean }> => {
  if (to.startsWith('+91')) return env.RELAY.get(env.RELAY.idFromName('relay')).send(to, body);
  if (!twilioReady(env)) throw new GatewayError('sms-unavailable', 503);
  await sendTwilio(env, to, body);
  return { queued: false };
};

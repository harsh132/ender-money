/**
 * Picking the pipe: HTTPS when the internet is reachable, otherwise the SMS
 * composer to the gateway number. Replies to texts come back by themselves on
 * Android (modules/sms-retriever: RECEIVE_SMS, or else the SMS Retriever; wired
 * in the root layout), and everywhere through the clipboard (the user copies
 * the gateway's reply; the app reads it on focus) or Paste reply.
 */
import NetInfo from '@react-native-community/netinfo';
import * as Clipboard from 'expo-clipboard';
import * as SMS from 'expo-sms';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { formatCommand, formatShieldedCommand, parseReply, type Command, type Reply, type ShieldedCommand } from '../../../protocol/sms';
import { GATEWAY_SMS } from './config';
import { whileOwnScreen } from './keys';
import { getState } from './store';

export type Pipe = 'internet' | 'text';

export const online = async () => {
  const s = await NetInfo.fetch();
  return s.isConnected === true && s.isInternetReachable !== false;
};

/** Live connectivity for banners and the pill. `null` while unknown. */
export const useOnline = () => {
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(
    () => NetInfo.addEventListener((s) => setUp(s.isConnected === true && s.isInternetReachable !== false)),
    [],
  );
  return up;
};

export const gatewayNumber = (): string | undefined => {
  const { gateway, wallet } = getState();
  const india = gateway === 'india' || (gateway === 'auto' && (wallet?.phone ?? '+91').startsWith('+91'));
  return india ? GATEWAY_SMS.india : GATEWAY_SMS.international;
};

export class NoSmsError extends Error {}

const SHIELDED = new Set<string>(['pay', 'shield', 'merge', 'shieldedSig']);
const format = (c: Command | ShieldedCommand) => (SHIELDED.has(c.kind) ? formatShieldedCommand(c as ShieldedCommand) : formatCommand(c as Command));

/** Opens the composer with the command filled in; the user taps send. Private payments use PAY / SHIELD / the three-field SIG. */
export const textGateway = async (command: Command | ShieldedCommand) => {
  const to = gatewayNumber();
  if (!to) throw new NoSmsError('No gateway number for texts is set up in this build.');
  if (!(await SMS.isAvailableAsync())) throw new NoSmsError("This phone can't send texts.");
  expecting = Date.now() + REPLY_WINDOW_MS;
  await whileOwnScreen(() => SMS.sendSMSAsync([to], format(command)));
};

// ---------------------------------------------------------------- replies by clipboard

type Listener = (reply: Reply, raw: string) => void;
const listeners = new Set<Listener>();
let lastSeen = '';
/** The clipboard is only read for a while after texting the gateway, never otherwise. */
const REPLY_WINDOW_MS = 10 * 60_000;
let expecting = 0;

export const onReply = (l: Listener) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Feeds a pasted or copied gateway reply to whoever is waiting. Returns whether it parsed. */
export const acceptReply = (raw: string) => {
  // Copying a whole thread or a line with the sender is common; find the reply line.
  for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
    const reply = parseReply(line);
    if (reply) {
      listeners.forEach((l) => l(reply, line));
      return true;
    }
  }
  return false;
};

export const checkClipboard = async () => {
  if (Date.now() > expecting || listeners.size === 0 || !(await Clipboard.hasStringAsync())) return;
  const text = await Clipboard.getStringAsync();
  if (!text || text === lastSeen) return;
  lastSeen = text;
  acceptReply(text);
};

AppState.addEventListener('change', (s) => {
  if (s === 'active') void checkClipboard();
});

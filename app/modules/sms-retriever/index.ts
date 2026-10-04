import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

type Native = {
  start(): Promise<void>;
  stop(): void;
  setSenders(numbers: string[]): void;
  drain(): Promise<{ from: string; body: string; at: number }[]>;
  addListener(event: 'onSms' | 'onInbox', listener: (e: { message?: string }) => void): { remove(): void };
};

const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('SmsRetriever') : null;
const listeners = new Set<(body: string) => void>();
const emit = (body: string) => listeners.forEach((l) => l(body));
let wired = false;

/** Every text from the gateway the app gets, by either path (Android only). Returns the unsubscribe. */
export function onSms(listener: (body: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The native module is there (Android dev or release build). */
export const smsSupported = !!native;

export const canReadSms = async () => !!native && (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS));

/** Asks once for RECEIVE_SMS; the caller explains why first. */
export const askToReadSms = async () => {
  if (!native) return false;
  const granted = (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS)) === 'granted';
  void pump();
  return granted;
};

/** The numbers whose texts the receiver keeps; stored natively, so it filters while the app is closed. */
export const setSenders = (numbers: string[]) => native?.setSenders(numbers);

/**
 * On startup, on every foreground and whenever a text arrives. With RECEIVE_SMS: hand over what the receiver
 * queued (also while the app was closed). Without it: re-arm the SMS Retriever (one text per five-minute window,
 * so it is re-armed after each one too).
 */
export async function pump(): Promise<void> {
  if (!native) return;
  if (!wired) {
    wired = true;
    native.addListener('onSms', ({ message }) => {
      if (message) emit(message);
      void pump();
    });
    native.addListener('onInbox', () => void pump());
  }
  if (await canReadSms()) for (const m of await native.drain()) emit(m.body);
  else await native.start().catch(() => {});
}

/** Calls onCode with the code from the next "Ender code: 123456" text (Android only). Returns the stop function. */
export function listenForCode(onCode: (code: string) => void): () => void {
  const off = onSms((message) => {
    const m = /Ender code: (\d{6})/.exec(message);
    if (m) onCode(m[1]!);
  });
  void pump();
  return off;
}

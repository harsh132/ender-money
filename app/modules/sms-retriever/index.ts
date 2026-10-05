import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type Native = {
  start(): Promise<void>;
  stop(): void;
  drain(): Promise<string[]>;
  addListener(event: 'onSms', listener: () => void): { remove(): void };
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

/**
 * Hands over what the Retriever caught (kept natively, so a reply that arrived while the app was in the background
 * isn't lost) and re-arms it: one text per five-minute window, so it's called on startup, on every foreground, after
 * each text, every few minutes while open, and right before opening the SMS app.
 */
export async function pump(): Promise<void> {
  if (!native) return;
  if (!wired) {
    wired = true;
    native.addListener('onSms', () => void pump());
  }
  for (const message of await native.drain().catch(() => [] as string[])) emit(message);
  await native.start().catch(() => {});
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

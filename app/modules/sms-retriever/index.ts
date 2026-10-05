import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type Native = {
  start(): Promise<void>;
  stop(): void;
  addListener(event: 'onSms', listener: (e: { message?: string }) => void): { remove(): void };
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
 * (Re-)arms the SMS Retriever: one text per five-minute window, so it's called on startup, on every foreground,
 * after each text and every few minutes while the app is open.
 */
export async function pump(): Promise<void> {
  if (!native) return;
  if (!wired) {
    wired = true;
    native.addListener('onSms', ({ message }) => {
      if (message) emit(message);
      void pump();
    });
  }
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

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type Native = {
  start(): Promise<void>;
  stop(): void;
  addListener(event: 'onSms', listener: (e: { message?: string }) => void): { remove(): void };
};

const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('SmsRetriever') : null;

/**
 * Calls onCode with the code from the next "Ender code: 123456" SMS that carries the app's hash (Android only).
 * Returns the stop function.
 */
export function listenForCode(onCode: (code: string) => void): () => void {
  if (!native) return () => {};
  const sub = native.addListener('onSms', ({ message }) => {
    const m = /Ender code: (\d{6})/.exec(message ?? '');
    if (m) onCode(m[1]!);
  });
  native.start().catch(() => {});
  return () => {
    sub.remove();
    native.stop();
  };
}

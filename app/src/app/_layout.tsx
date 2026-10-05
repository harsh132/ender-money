// Deep imports, so only the weights in use are bundled.
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { Newsreader_500Medium } from '@expo-google-fonts/newsreader/500Medium';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { onSms, pump } from '../../modules/sms-retriever';
import { c } from '../lib/theme';
import { hydrate, useStore } from '../lib/store';
import { acceptReply, onReply } from '../lib/transport';
import { applyOkReply, applyReceived, applyShieldedReply, autoMerge } from '../lib/wallet';

void SplashScreen.preventAutoHideAsync();
void hydrate();

export default function Root() {
  const [fonts] = useFonts({ Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, GeistMono_400Regular, Newsreader_500Medium });
  const hydrated = useStore((s) => s.hydrated);
  const ready = fonts && hydrated;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  // Replies by text, however they arrive (read from the SMS, pasted, copied): OK updates the balance, a public Received
  // adds an incoming row, Sent / Shielded / a private Received (p= b=, or an older Got) update private notes. Q / ERR go
  // to the screen waiting for them.
  useEffect(
    () => onReply((r) => (r.kind === 'ok' ? applyOkReply(r) : r.kind === 'received' && r.p === undefined ? applyReceived(r) : applyShieldedReply(r))),
    [],
  );

  // Android: the SMS Retriever, re-armed on every foreground, after each text and every 4 minutes while open (its window
  // is 5). Elsewhere a no-op; the clipboard and Paste reply still work everywhere.
  // Back in the foreground with a Quick send session still open (after the SMS composer, say): Auto-merge may run.
  useEffect(() => {
    const off = onSms((body) => void acceptReply(body));
    void pump();
    const rearm = setInterval(() => AppState.currentState === 'active' && void pump(), 4 * 60_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void pump();
      void autoMerge();
    });
    return () => {
      off();
      clearInterval(rearm);
      sub.remove();
    };
  }, []);

  if (!ready) return null;
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}>
        <Stack.Screen name="receive" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.86], sheetCornerRadius: 28, contentStyle: { backgroundColor: c.bg } }} />
        <Stack.Screen name="tx/[id]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.7], sheetCornerRadius: 28, contentStyle: { backgroundColor: c.bg } }} />
        <Stack.Screen name="scan" options={{ animation: 'fade' }} />
      </Stack>
    </>
  );
}

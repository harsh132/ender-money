import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { phoneDisplay } from '../lib/format';
import { onboarding } from '../lib/onboarding';
import { c, f } from '../lib/theme';
import { errorText } from '../lib/wallet';
import { listenForCode } from '../../modules/sms-retriever';
import { BackHeader, Banner, Button, Screen, Steps, T } from '../ui/kit';

const RESEND_AFTER = 45;

/** O3: the gateway answers new or existing once the code checks out. */
export default function CodeScreen() {
  const { change } = useLocalSearchParams<{ change?: string }>();
  const phone = onboarding.phone ?? '';
  const [code, setCode] = useState(onboarding.devCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [wait, setWait] = useState(RESEND_AFTER);
  const input = useRef<TextInput>(null);

  useEffect(() => {
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const verify = async (value = code) => {
    if (value.length !== 6) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.verifyAuth(phone, value);
      onboarding.verified = r.status === 'new' ? { phone, token: r.token, status: 'new' } : { phone, token: r.token, status: 'existing', address: r.address, balance: r.balance };
      if (change) router.replace({ pathname: '/create', params: { mode: 'change' } });
      else router.replace(r.status === 'new' ? '/create' : '/restore');
    } catch (e) {
      setError(errorText(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  // Android hands over the code SMS (it ends with the app's hash), for five minutes from here, which covers a resend.
  // ponytail: starts on mount; the relay's SMS takes seconds, so it lands after this. Start it before startAuth if a
  // code ever arrives first.
  useEffect(
    () =>
      listenForCode((v) => {
        setCode(v);
        void verify(v);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const resend = async () => {
    setError(undefined);
    try {
      const r = await api.startAuth(phone);
      onboarding.devCode = r.devCode;
      if (r.devCode) setCode(r.devCode);
      setWait(RESEND_AFTER);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior="padding">
      <Screen>
        <BackHeader />
        <Steps at={1} />
        <T v="headline" style={{ fontSize: 36 }}>Enter the code</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 12 }}>
          We texted a 6-digit code to <T v="meta" style={{ fontSize: 18, color: c.fg }}>{phoneDisplay(phone)}</T>.
        </T>
        <Pressable onPress={() => input.current?.focus()} style={{ flexDirection: 'row', gap: 8, marginTop: 32 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                height: 64,
                borderRadius: 16,
                backgroundColor: c.surface,
                borderWidth: i === code.length ? 2 : 1,
                borderColor: i === code.length ? c.accent : c.line,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <T style={{ fontFamily: f.display, fontSize: 30, lineHeight: 36 }}>{code[i] ?? ''}</T>
            </View>
          ))}
        </Pressable>
        {/* One hidden input, so Android's SMS code autofill fills all six boxes. */}
        <TextInput
          ref={input}
          autoFocus
          value={code}
          onChangeText={(t) => {
            const v = t.replace(/\D/g, '').slice(0, 6);
            setCode(v);
            if (v.length === 6) void verify(v);
          }}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={6}
          returnKeyType="done"
          onSubmitEditing={() => verify()}
          style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
          accessibilityLabel="Code"
        />
        <T v="meta" style={{ color: c.fg3, fontSize: 15, marginTop: 12 }}>Fills in by itself when the text arrives.</T>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 }}>
          {wait > 0 ? (
            <T v="meta">Resend code in 0:{String(wait).padStart(2, '0')}</T>
          ) : (
            <Pressable onPress={resend} hitSlop={10}><T v="meta" style={{ color: c.accent, fontFamily: f.uiMedium }}>Resend code</T></Pressable>
          )}
          <Pressable onPress={() => router.back()} hitSlop={10}><T v="meta" style={{ color: c.accent, fontFamily: f.uiMedium }}>Wrong number?</T></Pressable>
        </View>
        {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
        <View style={{ flex: 1, minHeight: 24 }} />
        <Button title="Verify" onPress={() => verify()} busy={busy} disabled={code.length !== 6} style={{ marginBottom: 12 }} />
      </Screen>
    </KeyboardAvoidingView>
  );
}

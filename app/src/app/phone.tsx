import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Keyboard, KeyboardAvoidingView, View } from 'react-native';
import { normalizePhone } from '../../../protocol/sms';
import { api } from '../lib/api';
import { onboarding } from '../lib/onboarding';
import { c, f } from '../lib/theme';
import { errorText } from '../lib/wallet';
import { BackHeader, Banner, Button, Field, Screen, Steps, T } from '../ui/kit';

/** O2. Also the first step of changing the number from Settings (`?change=1`). */
export default function PhoneScreen() {
  const { change } = useLocalSearchParams<{ change?: string }>();
  const [cc, setCc] = useState('91');
  const [num, setNum] = useState(onboarding.phone?.replace(/^\+91/, '') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const phone = normalizePhone(`+${cc}${num.replace(/\D/g, '')}`);

  const send = async () => {
    if (!phone) return setError('Check the number.');
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.startAuth(phone);
      onboarding.phone = phone;
      onboarding.devCode = r.devCode;
      // The next screen's input re-opens it; a keyboard carried across screens never resizes the layout.
      Keyboard.dismiss();
      router.push({ pathname: '/code', params: change ? { change } : {} });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior="padding">
      <Screen>
        <BackHeader />
        <Steps at={0} />
        <T v="headline" style={{ fontSize: 36 }}>{change ? 'Your new number' : 'Your number'}</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 12 }}>
          We'll text you a code to check it's you. People can pay you at this number.
        </T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 28 }}>
          <View style={{ width: 108 }}>
            <Field
              value={`+${cc}`}
              onChangeText={(t) => setCc(t.replace(/\D/g, '').slice(0, 3))}
              keyboardType="phone-pad"
              accessibilityLabel="Country code"
              style={{ textAlign: 'center' }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              big
              autoFocus
              value={num}
              onChangeText={setNum}
              keyboardType="phone-pad"
              autoComplete="tel-national"
              textContentType="telephoneNumber"
              placeholder="98765 43210"
              accessibilityLabel="Phone number"
              onSubmitEditing={send}
              style={{ letterSpacing: 0.5, fontFamily: f.uiMedium }}
            />
          </View>
        </View>
        <T v="meta" style={{ color: c.fg3, fontSize: 15, marginTop: 12, lineHeight: 22 }}>
          Ender's gateway keeps your number next to your wallet address to route payments and alerts.
        </T>
        {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
        <View style={{ flex: 1 }} />
        <Button title="Send code" onPress={send} busy={busy} disabled={!phone} style={{ marginBottom: 12 }} />
      </Screen>
    </KeyboardAvoidingView>
  );
}

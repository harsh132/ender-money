import { router } from 'expo-router';
import { useState } from 'react';
import { Keyboard, KeyboardAvoidingView, View } from 'react-native';
import { normalizePhone } from '../../../protocol/sms';
import { api } from '../lib/api';
import { phoneFlow } from '../lib/phone';
import { c, f } from '../lib/theme';
import { errorText } from '../lib/wallet';
import { getState } from '../lib/store';
import { BackHeader, Banner, Button, Field, Screen, T } from '../ui/kit';

/** Settings -> Phone number: the number to add (or change to). A code by text proves it (code.tsx). */
export default function PhoneScreen() {
  const change = !!getState().wallet?.phone;
  const [cc, setCc] = useState('91');
  const [num, setNum] = useState(phoneFlow.phone?.replace(/^\+91/, '') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const phone = normalizePhone(`+${cc}${num.replace(/\D/g, '')}`);

  const send = async () => {
    if (!phone) return setError('Check the number.');
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.phoneStart(phone);
      phoneFlow.phone = phone;
      phoneFlow.devCode = r.devCode;
      // The next screen's input re-opens it; a keyboard carried across screens never resizes the layout.
      Keyboard.dismiss();
      router.push('/code');
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
        <T v="headline" style={{ fontSize: 36 }}>{change ? 'Your new number' : 'Your number'}</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 12 }}>
          We'll text you a code to check it's you. Then people can pay you at this number, we'll text you when money arrives, and you can pay by text without internet.
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
        <View style={{ flex: 1, minHeight: 24 }} />
        <Button title="Send code" onPress={send} busy={busy} disabled={!phone} style={{ marginBottom: 12 }} />
      </Screen>
    </KeyboardAvoidingView>
  );
}

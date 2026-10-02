import { router } from 'expo-router';
import { View } from 'react-native';
import { usd } from '../lib/format';
import { onboarding } from '../lib/onboarding';
import { c } from '../lib/theme';
import { Alert } from '../ui/icons';
import { BackHeader, Button, Card, KV, Screen, T } from '../ui/kit';

/** E2: honest about what a lost passkey means, then a new wallet that takes the number. */
export default function Lost() {
  const v = onboarding.verified;
  const balance = v?.status === 'existing' ? v.balance : '0';
  return (
    <Screen>
      <BackHeader />
      <View style={{ alignItems: 'center', marginTop: 16, marginBottom: 28 }}>
        <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
          <Alert size={52} color={c.warning} width={1.8} />
        </View>
      </View>
      <T v="headline" style={{ fontSize: 36, textAlign: 'center' }}>Start a new wallet?</T>
      <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 14, textAlign: 'center' }}>
        Without its passkey, nobody can open your old wallet, not even Ender. Check your Google account on another phone first.
      </T>
      <Card style={{ marginTop: 28 }}>
        <KV k="Old wallet" v={`Keeps $${usd(balance)}`} />
        <KV k="Number" v="Moves to new wallet" last />
      </Card>
      <View style={{ flex: 1 }} />
      <Button title="Start a new wallet" onPress={() => router.replace({ pathname: '/create', params: { mode: 'relink' } })} />
      <Button title="Try my passkey again" kind="text" onPress={() => router.back()} style={{ marginBottom: 4 }} />
    </Screen>
  );
}

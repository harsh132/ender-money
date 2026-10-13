import { router } from 'expo-router';
import { View } from 'react-native';
import { c } from '../lib/theme';
import { Shield } from '../ui/icons';
import { BackHeader, Button, Card, Screen, T } from '../ui/kit';

const STEPS = [
  'Money arrives at your public address.',
  'Once it reaches $1, Ender moves it to your private balance in one step, for a $0.01 fee.',
  'From there, the chain shows no link between who paid and who got paid.',
];

/** What Auto Shield is, opened from its toast (tabs layout). */
export default function AutoShieldInfo() {
  return (
    <Screen scroll>
      <BackHeader title="Auto Shield" />
      <View style={{ alignItems: 'center', marginTop: 12, marginBottom: 20 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
          <Shield size={30} color={c.accent} />
        </View>
      </View>
      <T v="title" style={{ textAlign: 'center' }}>Private by default</T>
      <T v="meta" style={{ textAlign: 'center', marginTop: 8 }}>Auto Shield moves the money you receive into your private balance, so your payments stay private.</T>
      <Card style={{ marginTop: 24, gap: 16 }}>
        {STEPS.map((text, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
            <T v="body" style={{ color: c.accent, width: 18 }}>{i + 1}</T>
            <T v="body" style={{ flex: 1 }}>{text}</T>
          </View>
        ))}
      </Card>
      <T v="meta" style={{ marginTop: 20 }}>It runs while the app is open and online. You can still pay any address: it's paid from your private balance.</T>
      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="Settings" kind="ghost" onPress={() => router.replace('/settings')} />
    </Screen>
  );
}

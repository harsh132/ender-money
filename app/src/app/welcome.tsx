import { router } from 'expo-router';
import { View } from 'react-native';
import { c, f } from '../lib/theme';
import { Button, Feature, Screen, T } from '../ui/kit';
import { Fingerprint, Shield, Signal } from '../ui/icons';
import { Mark } from '../ui/Mark';

/** O1 */
export default function Welcome() {
  return (
    <Screen>
      <View style={{ alignItems: 'center', marginTop: 64, marginBottom: 32 }}>
        <Mark />
      </View>
      <T v="headline" style={{ textAlign: 'center' }}>Private money{'\n'}by text.</T>
      <View style={{ alignSelf: 'center', marginTop: 12, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: c.accent }}>
        <T style={{ fontFamily: f.uiMedium, fontSize: 12, lineHeight: 16, color: c.accent }}>Beta</T>
      </View>
      <T v="meta" style={{ fontSize: 18, lineHeight: 27, textAlign: 'center', marginTop: 16, marginHorizontal: 12 }}>
        Pay anyone with just a phone signal.
      </T>
      <View style={{ marginTop: 28, paddingHorizontal: 8 }}>
        <Feature icon={<Shield size={22} color={c.accent} />} text="Private by default" />
        <Feature icon={<Signal size={22} color={c.accent} />} text="Works offline" />
        <Feature icon={<Fingerprint size={22} color={c.accent} />} text="No seed phrase" />
      </View>
      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="Get started" onPress={() => router.push('/create')} style={{ marginBottom: 12 }} />
    </Screen>
  );
}

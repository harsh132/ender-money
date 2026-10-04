import { router } from 'expo-router';
import { View } from 'react-native';
import { c } from '../lib/theme';
import { Button, Chip, Feature, Screen, T } from '../ui/kit';
import { Fingerprint, Message, Signal } from '../ui/icons';
import { Mark } from '../ui/Mark';

/** O1 */
export default function Welcome() {
  return (
    <Screen>
      <View style={{ alignItems: 'center', marginTop: 64, marginBottom: 32 }}>
        <Mark />
      </View>
      <T v="headline" style={{ textAlign: 'center' }}>Money by text.{'\n'}No internet needed.</T>
      <T v="meta" style={{ fontSize: 18, lineHeight: 27, textAlign: 'center', marginTop: 16, marginHorizontal: 12 }}>
        Send dollars to anyone with just a phone signal. Your face or fingerprint is your key.
      </T>
      <View style={{ marginTop: 28, paddingHorizontal: 8 }}>
        <Feature icon={<Fingerprint size={22} color={c.accent} />} text="No seed phrase to write down" />
        <Feature icon={<Signal size={22} color={c.accent} />} text="Works with mobile data off" />
        <Feature icon={<Message size={22} color={c.accent} />} text="Pay any phone number" />
      </View>
      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="Log in" onPress={() => router.push('/phone')} />
      <View style={{ alignItems: 'center', marginTop: 16, marginBottom: 12 }}>
        <Chip label="Setup needs internet once. After that, just signal." />
      </View>
    </Screen>
  );
}

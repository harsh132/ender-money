import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { short, usd } from '../lib/format';
import { passkeyError, unlockWallet } from '../lib/keys';
import { onboarding } from '../lib/onboarding';
import { setState } from '../lib/store';
import { c } from '../lib/theme';
import { sync } from '../lib/wallet';
import { Fingerprint } from '../ui/icons';
import { BackHeader, Banner, Button, Card, KV, Screen, Steps, T } from '../ui/kit';

/** E1: the verified number already has a wallet; the passkey proves it is this person's. */
export default function Restore() {
  const v = onboarding.verified;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!v || v.status !== 'existing') {
    router.replace('/');
    return null;
  }

  const open = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const u = await unlockWallet();
      const address = u.address;
      const credential = u.credential;
      u.session.end();
      if (address.toLowerCase() !== v.address.toLowerCase()) {
        setError('That passkey belongs to another wallet. Pick the other Ender passkey.');
        return;
      }
      setState({
        wallet: { phone: v.phone, address: v.address, credentialId: credential.credentialId },
        token: v.token,
        network: 'mainnet',
        account: { mainnet: { balance: v.balance, nonce: '0', delegated: true, syncedAt: Date.now() } },
      });
      onboarding.verified = undefined;
      void sync();
      router.replace('/home');
    } catch (e) {
      const msg = passkeyError(e);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <BackHeader />
      <Steps at={2} />
      <T v="headline" style={{ fontSize: 36 }}>Welcome back</T>
      <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 12 }}>
        This number already has an Ender wallet. Use your passkey to open it.
      </T>
      <Card style={{ marginTop: 28 }}>
        <KV k="Wallet" v={short(v.address)} mono />
        <KV k="Balance" v={`$${usd(v.balance)}`} last />
      </Card>
      {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
      <View style={{ flex: 1 }} />
      <Button title="Use my passkey" icon={<Fingerprint size={22} color={c.accentInk} />} busy={busy} onPress={open} />
      <Button title="I lost my passkey" kind="text" onPress={() => router.push('/lost')} style={{ marginBottom: 4 }} />
    </Screen>
  );
}

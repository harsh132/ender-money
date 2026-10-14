import { useState } from 'react';
import { View } from 'react-native';
import { passkeyError, quickSend, unlockWallet } from '../lib/keys';
import { signOut, useStore } from '../lib/store';
import { c, f } from '../lib/theme';
import { afterUnlock, refresh } from '../lib/wallet';
import { Banner, Button, Screen, T } from './kit';
import { Mark } from './Mark';

/**
 * In place of the app while there's a wallet but no gateway session (expired, or rejected and not renewable without the
 * key). One passkey prompt signs in again, registers private keys where missing and keeps the key as a Quick send
 * session, so Auto Shield and Auto-bridge can run.
 */
export const LockScreen = () => {
  const wallet = useStore((s) => s.wallet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!wallet) return null;

  const unlock = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const u = await unlockWallet({ credentialId: wallet.credentialId });
      await afterUnlock(u);
      quickSend.open(u, 0);
      void refresh().catch(() => {});
    } catch (e) {
      setError(passkeyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Mark />
        <T v="headline" style={{ textAlign: 'center', marginTop: 28 }}>Unlock Ender</T>
        {wallet.enderId ? <T style={{ fontFamily: f.display, fontSize: 22, lineHeight: 28, color: c.fg2, marginTop: 10 }}>{wallet.enderId}</T> : null}
      </View>
      {error ? <View style={{ marginBottom: 12 }}><Banner tone="negative">{error}</Banner></View> : null}
      <Button title="Unlock" busy={busy} onPress={unlock} />
      <Button title="Log out" kind="text" disabled={busy} onPress={() => void signOut()} style={{ marginBottom: 12 }} />
    </Screen>
  );
};

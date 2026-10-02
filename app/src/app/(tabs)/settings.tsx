import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NetworkName } from '../../../../protocol/networks';
import { api } from '../../lib/api';
import { ago, phoneMasked, short } from '../../lib/format';
import { passkeyError, quickSend, unlockWallet } from '../../lib/keys';
import { getState, setState, signOut, useStore } from '../../lib/store';
import { c } from '../../lib/theme';
import { online } from '../../lib/transport';
import { errorText, refresh, syncByText } from '../../lib/wallet';
import { Chevron } from '../../ui/icons';
import { Banner, T, TestnetPill } from '../../ui/kit';

const GATEWAYS = ['auto', 'india', 'international'] as const;
const GATEWAY_LABEL = { auto: 'Auto', india: 'India', international: 'International' } as const;

export default function Settings() {
  const wallet = useStore((s) => s.wallet);
  const network = useStore((s) => s.network);
  const alerts = useStore((s) => s.alerts);
  const gateway = useStore((s) => s.gateway);
  const snapshot = useStore((s) => s.account[s.network]);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ text: string; tone: 'plain' | 'negative' }>();

  if (!wallet) return null;
  const autoPick = wallet.phone.startsWith('+91') ? 'India' : 'International';

  /** Test mode always asks for the passkey, so a borrowed unlocked phone can't flip what "balance" means. */
  const toggleTestMode = async (on: boolean) => {
    setBusy('network');
    setNote(undefined);
    try {
      quickSend.end();
      const u = await unlockWallet({ credentialId: wallet.credentialId });
      u.session.end();
      const next: NetworkName = on ? 'testnet' : 'mainnet';
      setState({ network: next });
      if (!(await refresh())) await syncByText().catch(() => {});
    } catch (e) {
      const msg = passkeyError(e);
      if (msg) setNote({ text: msg, tone: 'negative' });
    } finally {
      setBusy(undefined);
    }
  };

  const toggleAlerts = async (on: boolean) => {
    setBusy('alerts');
    setNote(undefined);
    try {
      await api.setAlerts(on);
      setState({ alerts: on });
    } catch (e) {
      setNote({ text: `Couldn't change alerts. ${errorText(e)}`, tone: 'negative' });
    } finally {
      setBusy(undefined);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    setNote(undefined);
    try {
      if ((await online()) && (await refresh())) return;
      await syncByText();
      setNote({ text: 'Sent SYNC by text. When the reply arrives, copy it and come back.', tone: 'plain' });
    } catch (e) {
      setNote({ text: errorText(e), tone: 'negative' });
    } finally {
      setBusy(undefined);
    }
  };

  const logOut = () =>
    Alert.alert('Log out of this phone?', 'Your wallet stays safe. Log in again with your number and passkey to get it back.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: async () => {
          quickSend.end();
          await signOut();
          router.replace('/welcome');
        },
      },
    ]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 64, gap: 12 }}>
          <T v="title" style={{ flex: 1 }}>Settings</T>
          {network === 'testnet' ? <TestnetPill /> : null}
        </View>

        <Label>Account</Label>
        <Group>
          <Row title="Phone number" sub={phoneMasked(wallet.phone)} onPress={() => router.push({ pathname: '/phone', params: { change: '1' } })} />
          <Row title="Wallet" sub={short(wallet.address)} mono onPress={() => router.push('/receive')} />
          <Row
            title="Text me when I get paid"
            right={<Switch value={alerts} disabled={busy === 'alerts'} onValueChange={toggleAlerts} trackColor={{ true: c.accent, false: c.surface2 }} thumbColor={alerts ? '#fff' : c.fg3} />}
            last
          />
        </Group>

        <Label>Network</Label>
        <Group>
          <Row
            title="Test mode"
            sub={network === 'testnet' ? 'Monad testnet. Test money only.' : 'Off: real money on Monad.'}
            right={
              <Switch
                value={network === 'testnet'}
                disabled={!!busy}
                onValueChange={toggleTestMode}
                trackColor={{ true: c.accent, false: c.surface2 }}
                thumbColor={network === 'testnet' ? '#fff' : c.fg3}
              />
            }
          />
          <Row
            title="Gateway"
            sub={gateway === 'auto' ? `Auto · ${autoPick}` : GATEWAY_LABEL[gateway]}
            onPress={() => setState({ gateway: GATEWAYS[(GATEWAYS.indexOf(getState().gateway) + 1) % GATEWAYS.length]! })}
          />
          <Row title={busy === 'sync' ? 'Syncing…' : 'Sync now'} sub={snapshot ? `Last synced ${ago(snapshot.syncedAt)}` : 'Not synced yet'} onPress={syncNow} last />
        </Group>

        {note ? <View style={{ marginTop: 16 }}><Banner tone={note.tone}>{note.text}</Banner></View> : null}

        <Label>This phone</Label>
        <Group>
          <Row title="Log out" sub="Your wallet comes back with your passkey." onPress={logOut} danger last />
        </Group>

        <T v="caption" style={{ color: c.fg3, textAlign: 'center', marginTop: 28 }}>
          Built on Monad · v{Constants.expoConfig?.version ?? '0.1'}
        </T>
      </ScrollView>
    </SafeAreaView>
  );
}

const Label = ({ children }: { children: string }) => (
  <T v="caption" style={{ color: c.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 22, marginBottom: 8, marginHorizontal: 4 }}>{children}</T>
);

const Group = ({ children }: { children: ReactNode }) => (
  <View style={{ borderRadius: 24, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, paddingHorizontal: 18 }}>{children}</View>
);

const Row = ({ title, sub, right, onPress, last, mono, danger }: { title: string; sub?: string; right?: ReactNode; onPress?: () => void; last?: boolean; mono?: boolean; danger?: boolean }) => (
  <Pressable
    onPress={onPress}
    disabled={!onPress}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, paddingVertical: 10, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.line, opacity: pressed ? 0.7 : 1 })}
  >
    <View style={{ flex: 1 }}>
      <T v="body" style={danger ? { color: c.negative } : undefined}>{title}</T>
      {sub ? <T v={mono ? 'mono' : 'meta'} style={{ marginTop: 2, color: c.fg2, fontSize: mono ? 15 : 16 }}>{sub}</T> : null}
    </View>
    {right ?? (onPress ? <Chevron size={20} color={c.fg3} /> : null)}
  </Pressable>
);


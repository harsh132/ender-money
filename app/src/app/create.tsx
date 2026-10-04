import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { phoneDisplay } from '../lib/format';
import { createWalletKey, passkeyError, quickSend, unlockWallet, type Unlocked } from '../lib/keys';
import { onboarding } from '../lib/onboarding';
import { getState, setState } from '../lib/store';
import { c } from '../lib/theme';
import { createWallet, errorText, sync } from '../lib/wallet';
import { Check, Fingerprint } from '../ui/icons';
import { BackHeader, Banner, Button, Card, KV, Screen, Spinner, Steps, T } from '../ui/kit';

type Phase = 'intro' | 'setting' | 'ready';

/**
 * N1 -> N2 -> N3. Modes:
 * - new (default): fresh passkey, or "I already have an Ender passkey" to move this number to it
 * - relink: E2, a fresh wallet that takes the number over from a lost one
 * - change: Settings, the current wallet takes over a new number
 */
export default function Create() {
  const { mode = 'new' } = useLocalSearchParams<{ mode?: 'new' | 'relink' | 'change' }>();
  const verified = onboarding.verified;
  const [phase, setPhase] = useState<Phase>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const key = useRef<Unlocked | null>(null);
  const [existing, setExisting] = useState(false);

  if (!verified) {
    router.replace('/');
    return null;
  }

  const setUp = async (useExisting = existing) => {
    const u = key.current!;
    setPhase('setting');
    setError(undefined);
    try {
      const relink = mode !== 'new' || useExisting;
      const res = await createWallet(u, verified.token, relink);
      const prev = getState().wallet;
      setState({
        wallet: { phone: verified.phone, address: res.address, credentialId: u.credential.credentialId, transports: u.credential.transports as string[] | undefined },
        token: res.token,
        ...(prev?.address.toLowerCase() === res.address.toLowerCase() ? {} : { network: 'mainnet', account: {}, activity: [] }),
      });
      onboarding.verified = undefined;
      u.session.end();
      key.current = null;
      void sync();
      if (mode === 'change') router.dismissTo('/settings');
      else setPhase('ready');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const withPasskey = async (open: () => Promise<Unlocked>, useExisting: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      quickSend.end();
      key.current = await open();
      setExisting(useExisting);
      await setUp(useExisting);
    } catch (e) {
      const msg = passkeyError(e);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const current = getState().wallet;

  if (phase === 'setting')
    return (
      <Screen>
        <View style={{ height: 64 }} />
        <Steps at={3} />
        <T v="headline" style={{ fontSize: 36 }}>Setting up your wallet</T>
        <T v="meta" style={{ fontSize: 18, marginTop: 12 }}>A few seconds.</T>
        <View style={{ marginTop: 32, gap: 4 }}>
          <Progress done title="Number verified" sub={phoneDisplay(verified.phone)} />
          <Progress done title={existing || mode === 'change' ? 'Passkey checked' : 'Passkey created'} />
          <Progress done={false} failed={!!error} title="Setting up your wallet on Monad" sub="No fees for you. Ender covers it." last />
        </View>
        {error ? (
          <>
            <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View>
            <View style={{ flex: 1, minHeight: 24 }} />
            <Button title="Try again" onPress={() => setUp()} style={{ marginBottom: 12 }} />
          </>
        ) : null}
      </Screen>
    );

  if (phase === 'ready')
    return (
      <Screen>
        <View style={{ alignItems: 'center', marginTop: 72, marginBottom: 28 }}>
          <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
            <Check size={52} color={c.accent} />
          </View>
        </View>
        <T v="headline" style={{ textAlign: 'center', fontSize: 36 }}>You're all set</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, textAlign: 'center', marginTop: 12, marginHorizontal: 8 }}>
          Anyone can pay you at your number, and we'll text you when money arrives.
        </T>
        <Card style={{ marginTop: 28 }}>
          <KV k="Number" v={phoneDisplay(verified.phone)} />
          <KV k="Balance" v={`$${getState().account.mainnet?.balance ?? '0.00'}`} last />
        </Card>
        <View style={{ marginTop: 20 }}><Banner>Now try it with mobile data off. Ender only needs signal.</Banner></View>
        <View style={{ flex: 1, minHeight: 24 }} />
        <Button title="Add money" onPress={() => { router.replace('/home'); router.push('/receive'); }} />
        <Button title="Go to home" kind="text" onPress={() => router.replace('/home')} style={{ marginBottom: 4 }} />
      </Screen>
    );

  if (mode === 'change')
    return (
      <Screen>
        <BackHeader />
        <Steps at={2} />
        <T v="headline" style={{ fontSize: 36 }}>Move your wallet to this number</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 12 }}>
          {phoneDisplay(verified.phone)} is verified. Approve with your passkey and people can pay you there. Your old number stops working for Ender.
        </T>
        {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
        <View style={{ flex: 1, minHeight: 24 }} />
        <Button
          title="Use my passkey"
          icon={<Fingerprint size={22} color={c.accentInk} />}
          busy={busy}
          onPress={() => withPasskey(() => unlockWallet(current ? { credentialId: current.credentialId } : undefined), true)}
          style={{ marginBottom: 12 }}
        />
      </Screen>
    );

  return (
    <Screen>
      <BackHeader />
      <Steps at={2} />
      <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 28 }}>
        <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
          <Fingerprint size={56} color={c.accent} width={1.6} />
        </View>
      </View>
      <T v="headline" style={{ fontSize: 36, textAlign: 'center' }}>Your fingerprint is your key</T>
      <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 14, textAlign: 'center' }}>
        {mode === 'relink' ? 'A new wallet for your number. ' : 'Number verified. '}
        Now we'll make a passkey on this phone. No seed phrase, nothing to write down. It's saved to your Google account as “Ender”, so a new phone can get your wallet back.
      </T>
      {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="Create passkey" busy={busy} onPress={() => withPasskey(createWalletKey, false)} />
      {mode === 'new' ? (
        <Button title="I already have an Ender passkey" kind="text" onPress={() => withPasskey(() => unlockWallet(), true)} style={{ marginBottom: 4 }} />
      ) : (
        <View style={{ height: 12 }} />
      )}
    </Screen>
  );
}

const Progress = ({ done, failed, title, sub, last }: { done: boolean; failed?: boolean; title: string; sub?: string; last?: boolean }) => (
  <View style={{ flexDirection: 'row', gap: 16, minHeight: 64 }}>
    <View style={{ alignItems: 'center', width: 28 }}>
      {done ? (
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Check size={16} color={c.accentInk} width={2.6} />
        </View>
      ) : failed ? (
        <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: c.negative }} />
      ) : (
        <Spinner />
      )}
      {!last ? <View style={{ width: 2, flex: 1, backgroundColor: done ? c.accent : c.line, marginVertical: 4 }} /> : null}
    </View>
    <View style={{ flex: 1, paddingBottom: 14 }}>
      <T v="body">{title}</T>
      {sub ? <T v="meta" style={{ fontSize: 15, marginTop: 2 }}>{sub}</T> : null}
    </View>
  </View>
);

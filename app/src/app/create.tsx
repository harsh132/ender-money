import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { createWalletKey, passkeyError, quickSend, unlockWallet, type Unlocked } from '../lib/keys';
import { c } from '../lib/theme';
import { errorText, setUpWallet } from '../lib/wallet';
import { Check, Fingerprint } from '../ui/icons';
import { BackHeader, Banner, Button, Card, KV, Screen, Spinner, Steps, T } from '../ui/kit';

type Phase = 'intro' | 'setting' | 'ready';

/**
 * N1 -> N2 -> "Your Ender ID". A fresh passkey (or an Ender passkey from
 * another phone), then sign-in by signature, which creates the account with a
 * random Ender ID the first time, and the wallet's delegation. A lost passkey
 * is just a new wallet: the number, if any, moves to it from Settings by a new
 * code.
 */
export default function Create() {
  const [existing, setExisting] = useState(false);
  const [phase, setPhase] = useState<Phase>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState<string>();
  const key = useRef<Unlocked | null>(null);

  const setUp = async () => {
    const u = key.current!;
    setPhase('setting');
    setError(undefined);
    try {
      const r = await setUpWallet(u);
      // The sign-up prompt's key stays as a Quick send session, so Auto Shield can run right away.
      quickSend.open(u, 0);
      key.current = null;
      // Someone coming back to their wallet goes straight home; a new one first sees its Ender ID.
      if (!r.created) return router.replace('/home');
      setName(r.name);
      setPhase('ready');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const withPasskey = async (open: () => Promise<Unlocked>, restoring: boolean) => {
    setBusy(true);
    setError(undefined);
    setExisting(restoring);
    try {
      quickSend.end();
      key.current = await open();
      await setUp();
    } catch (e) {
      const msg = passkeyError(e);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'setting')
    return (
      <Screen>
        <View style={{ height: 64 }} />
        <Steps at={1} of={2} />
        <T v="headline" style={{ fontSize: 36 }}>Setting up your wallet</T>
        <T v="meta" style={{ fontSize: 18, marginTop: 12 }}>A few seconds.</T>
        <View style={{ marginTop: 32, gap: 4 }}>
          <Progress done title={existing ? 'Passkey checked' : 'Passkey created'} />
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
        <T v="headline" style={{ textAlign: 'center', fontSize: 36 }}>Your Ender ID</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, textAlign: 'center', marginTop: 12, marginHorizontal: 8 }}>
          Anyone can pay you at it, from Ender or any wallet.
        </T>
        <Card style={{ marginTop: 28 }}>
          <KV k="Ender ID" v={name ?? ''} last />
        </Card>
        <T v="meta" style={{ textAlign: 'center', marginTop: 16 }}>You can change it once in Settings.</T>
        <View style={{ flex: 1, minHeight: 24 }} />
        <Button title="Add money" onPress={() => { router.replace('/home'); router.push('/receive'); }} />
        <Button title="Go to home" kind="text" onPress={() => router.replace('/home')} style={{ marginBottom: 4 }} />
      </Screen>
    );

  return (
    <Screen>
      <BackHeader />
      <Steps at={0} of={2} />
      <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 28 }}>
        <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
          <Fingerprint size={56} color={c.accent} width={1.6} />
        </View>
      </View>
      <T v="headline" style={{ fontSize: 36, textAlign: 'center' }}>Your fingerprint is your key</T>
      <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 14, textAlign: 'center' }}>
        We'll make a passkey on this phone. No seed phrase, nothing to write down. It's saved to your Google account as “Ender”, so a new phone can get your wallet back.
      </T>
      {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="Create passkey" busy={busy && !existing} disabled={busy} onPress={() => withPasskey(createWalletKey, false)} />
      <Button title="I already have an Ender passkey" kind="text" disabled={busy} onPress={() => withPasskey(() => unlockWallet(), true)} style={{ marginBottom: 4 }} />
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

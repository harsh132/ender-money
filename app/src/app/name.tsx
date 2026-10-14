import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { parseUnits, type Hex } from 'viem';
import { AUSD_DECIMALS } from '../../../protocol/networks';
import { api, ApiError } from '../lib/api';
import { MAX_FEE } from '../lib/config';
import { passkeyError } from '../lib/keys';
import { getState, setState, useStore } from '../lib/store';
import { errorText, payNameFee, sync } from '../lib/wallet';
import { ChooseName } from '../ui/ChooseName';
import { BackHeader, Banner, Button, Card, KV, Screen, Spinner, T } from '../ui/kit';

type Status = Awaited<ReturnType<typeof api.nameStatus>>;
type Unlock = 'phone' | 'pay';

/**
 * Settings -> Ender ID: the account's one change of its (random) ID, unlocked
 * by a verified number (Android, where numbers live) or by paying the fee on
 * mainnet. The earlier ID keeps working as an alias.
 */
export default function NameScreen() {
  const network = useStore((s) => s.network);
  const balance = useStore((s) => s.account.mainnet?.balance ?? '0');
  const [status, setStatus] = useState<Status>();
  const [unlock, setUnlock] = useState<Unlock>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.nameStatus().then(setStatus, (e: unknown) => setError(errorText(e)));
  }, []);

  const submit = async (label: string) => {
    setBusy(true);
    setError(undefined);
    try {
      let txHash: Hex | undefined;
      if (unlock === 'pay') {
        // Paid before (a taken name, a closed screen): the same payment, never a second one.
        txHash = (getState().namePaid as Hex | undefined) ?? (await payNameFee(status!.fee, status!.treasury));
        setState({ namePaid: txHash });
      }
      const r = await changeWhenLanded(label, txHash);
      setState((s) => ({ namePaid: undefined, ...(s.wallet ? { wallet: { ...s.wallet, enderId: r.name } } : {}) }));
      void sync();
      router.back();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'name-already-set') {
        void sync();
        return router.back();
      }
      // A cancelled passkey prompt says nothing.
      setError(e instanceof ApiError ? errorText(e) : passkeyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (unlock) return <ChooseName back busy={busy} error={error} onSubmit={submit} />;

  const fee = status?.fee ?? '2';
  const paid = !!getState().namePaid;
  const canPay = network === 'mainnet' && (paid || parseUnits(balance, AUSD_DECIMALS) >= parseUnits(fee, AUSD_DECIMALS) + parseUnits(MAX_FEE, AUSD_DECIMALS));
  // Numbers are verified on Android and on the web.
  const android = Platform.OS !== 'ios';

  return (
    <Screen>
      <BackHeader title="Ender ID" />
      {!status ? (
        error ? <Banner tone="negative">{error}</Banner> : <Spinner />
      ) : (
        <>
          <Card>
            <KV k="Your Ender ID" v={status.name ?? ''} last />
          </Card>
          {status.locked ? (
            <T v="meta" style={{ marginTop: 16 }}>Already changed.</T>
          ) : (
            <>
              <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 20 }}>
                You can change it once.
              </T>
              {error ? <View style={{ marginTop: 16 }}><Banner tone="negative">{error}</Banner></View> : null}
              <View style={{ flex: 1, minHeight: 24 }} />
              {android ? (
                status.phone ? (
                  <Button title="Change with my number" onPress={() => setUnlock('phone')} style={{ marginBottom: 12 }} />
                ) : (
                  <Button title="Verify phone" kind={canPay ? 'ghost' : undefined} onPress={() => router.push('/phone')} style={{ marginBottom: 12 }} />
                )
              ) : null}
              {canPay ? (
                <Button title={paid ? 'Choose a name (paid)' : `Pay $${fee}`} onPress={() => setUnlock('pay')} style={{ marginBottom: 12 }} />
              ) : (
                <T v="meta" style={{ textAlign: 'center', marginBottom: 16 }}>
                  {network !== 'mainnet' ? `Pay $${fee} with Test mode off.` : `Needs $${fee} in your public balance.`}
                </T>
              )}
            </>
          )}
        </>
      )}
    </Screen>
  );
}

/** The gateway checks the payment on-chain: a moment after it's sent it may not have landed. */
const changeWhenLanded = async (label: string, txHash?: Hex) => {
  for (let i = 0; ; i++) {
    try {
      return await api.changeName(label, txHash);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'payment-not-found') || i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};

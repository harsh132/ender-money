import { router, useLocalSearchParams } from 'expo-router';
import { Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NETWORKS } from '../../../../protocol/networks';
import { dayLabel, short, time, usd } from '../../lib/format';
import { useStore } from '../../lib/store';
import { c } from '../../lib/theme';
import { Button, Card, KV, T } from '../../ui/kit';
import { meta, who } from '../../ui/TxRow';

/** Detail sheet for one transfer. */
export default function TxDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tx = useStore((s) => s.activity.find((t) => t.id === id));
  const me = useStore((s) => s.wallet?.address);
  const { bottom } = useSafeAreaInsets();
  if (!tx) return null;
  const incoming = tx.direction === 'in';
  const dead = tx.status === 'failed' || tx.status === 'expired';
  // A row built from a text only knows the short hash (the full one doesn't fit the SMS): a public one links to the
  // wallet's page, which lists the transfer, until an online sync fills in the full hash. A private transaction isn't
  // on that page, so a private row links once a resync's notes give its hash.
  const smsTx = tx.txHash ? undefined : (tx.shortTx ?? (tx.id.startsWith('sms:') ? tx.id.split(':')[2] : undefined));
  const explorer = tx.txHash
    ? `${NETWORKS[tx.network].explorer}/tx/${tx.txHash}`
    : smsTx && me && !tx.private
      ? `${NETWORKS[tx.network].explorer}/address/${me}`
      : undefined;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: bottom }}>
      <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.surface2, marginBottom: 20 }} />
      <T v="hero" style={{ textAlign: 'center', fontSize: 52, lineHeight: 60, color: incoming ? c.positive : dead ? c.fg3 : c.fg }}>
        {incoming ? '+' : '−'}${usd(tx.amount)}
      </T>
      <T v="meta" style={{ textAlign: 'center', marginTop: 6, color: dead ? c.negative : c.fg2 }}>{meta(tx)}</T>
      <Card style={{ marginTop: 24 }}>
        <KV k={incoming ? 'From' : 'To'} v={who(tx)} />
        {tx.label && tx.counterparty ? <KV k="Wallet" v={short(tx.counterparty)} mono /> : null}
        {tx.label && tx.to?.startsWith('ender1') ? <KV k="Address" v={short(tx.to)} mono /> : null}
        {tx.private ? <KV k="Privacy" v="Private" /> : null}
        {tx.fee ? <KV k="Fee" v={`$${usd(tx.fee)}`} /> : null}
        <KV k="When" v={`${dayLabel(tx.at)}, ${time(tx.at)}`} />
        {tx.error ? <KV k="Error" v={tx.error} /> : null}
        {tx.txHash ? <KV k="Tx" v={short(tx.txHash)} mono /> : smsTx ? <KV k="Tx" v={smsTx} mono /> : null}
        <KV k="Network" v={tx.network === 'mainnet' ? 'Monad' : 'Monad testnet'} last />
      </Card>
      <View style={{ flex: 1, minHeight: 24 }} />
      <View style={{ gap: 4, marginBottom: 24 }}>
        {dead && !incoming && (tx.shield || tx.phone || tx.to || tx.counterparty) ? (
          <Button
            title="Try again"
            onPress={() => {
              router.back();
              router.push({
                pathname: '/review',
                params: tx.shield
                  ? { shield: '1', amount: tx.amount }
                  : tx.phone
                    ? { to: tx.phone, phone: tx.phone, amount: tx.amount, ...(tx.label ? { label: tx.label } : {}) }
                    : tx.to
                      ? { to: tx.to, amount: tx.amount, ...(tx.label ? { label: tx.label } : {}) }
                    : { to: tx.counterparty!, toAddress: tx.counterparty!, amount: tx.amount, ...(tx.label ? { label: tx.label } : {}) },
              });
            }}
          />
        ) : null}
        {explorer ? <Button title="View on explorer" kind={dead ? 'text' : 'ghost'} onPress={() => Linking.openURL(explorer)} /> : null}
      </View>
    </ScrollView>
  );
}

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Mask, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import { ago, inr, usd } from '../../lib/format';
import { quickSend } from '../../lib/keys';
import { useStore } from '../../lib/store';
import { c, f } from '../../lib/theme';
import { useOnline } from '../../lib/transport';
import { refresh } from '../../lib/wallet';
import { ArrowDown, ArrowUp, Bolt, Scan, Signal } from '../../ui/icons';
import { Banner, Chip, IconButton, T } from '../../ui/kit';
import { Sigil } from '../../ui/Sigil';
import { TxRow } from '../../ui/TxRow';
import { useQuickSend } from '../../ui/useQuickSend';

/** The faint dot grid behind the balance, fading out from the centre. */
const DotGrid = () => (
  <Svg style={{ position: 'absolute', top: -20, left: -20, right: -20, bottom: 0 }} width="110%" height="100%">
    <Defs>
      <Pattern id="dots" width={14} height={14} patternUnits="userSpaceOnUse">
        <Circle cx={7} cy={7} r={1.1} fill="rgba(255,255,255,0.12)" />
      </Pattern>
      <RadialGradient id="fade" cx="50%" cy="50%" r="50%">
        <Stop offset="0.3" stopColor="#fff" stopOpacity={1} />
        <Stop offset="1" stopColor="#fff" stopOpacity={0} />
      </RadialGradient>
      <Mask id="m">
        <Rect width="100%" height="100%" fill="url(#fade)" />
      </Mask>
    </Defs>
    <Rect width="100%" height="100%" fill="url(#dots)" mask="url(#m)" />
  </Svg>
);

export default function Home() {
  const wallet = useStore((s) => s.wallet);
  const network = useStore((s) => s.network);
  const snapshot = useStore((s) => s.account[s.network]);
  const rate = useStore((s) => s.inr);
  const activity = useStore((s) => s.activity);
  const online = useOnline();
  const quickMin = useQuickSend();
  const [refreshing, setRefreshing] = useState(false);

  const recent = useMemo(() => activity.filter((t) => t.network === network).sort((a, b) => b.at - a.at).slice(0, 5), [activity, network]);
  const balance = snapshot?.balance ?? '0';
  const [whole, cents] = usd(balance).split('.');

  const pull = useCallback(async () => {
    setRefreshing(true);
    await refresh().catch(() => {});
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh().catch(() => {});
    }, []),
  );

  if (!wallet) return null;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={c.accent} colors={[c.accent]} progressBackgroundColor={c.surface} />}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 64 }}>
          <Sigil address={wallet.address} fallback="E" size={44} fill={28 / 44} />
          <T v="title" style={{ flex: 1 }}>Home</T>
          {network === 'testnet' ? <Chip label="Testnet" tone="warning" onPress={() => router.push('/settings')} /> : null}
          <IconButton label="Scan a code" onPress={() => router.push('/scan')}>
            <Scan size={24} />
          </IconButton>
        </View>

        {quickMin ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <Chip label={`Quick send · ${quickMin} min left`} icon={<Bolt size={14} color={c.accent} />} onPress={quickSend.end} />
          </View>
        ) : null}

        <View style={{ alignItems: 'center', paddingTop: 40, paddingBottom: 36 }}>
          <DotGrid />
          <T v="hero" accessibilityLabel={`Balance ${usd(balance)} dollars`}>
            ${whole}
            <T style={{ fontFamily: f.display, fontSize: 36, color: c.fg2 }}>.{cents}</T>
          </T>
          <T v="meta" style={{ fontSize: 18, marginTop: 12 }}>
            ≈ ₹{inr(balance, rate)}
            {snapshot ? ` · synced ${ago(snapshot.syncedAt)}` : ''}
          </T>
        </View>

        {online === false ? (
          <View style={{ marginBottom: 16 }}>
            <Banner icon={<Signal size={20} color={c.warning} />} tone="warning">No internet, payments go by text</Banner>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Tile label="Send" onPress={() => router.push('/send')} icon={<ArrowUp size={24} color={c.accent} />} />
          <Tile label="Receive" onPress={() => router.push('/receive')} icon={<ArrowDown size={24} color={c.accent} />} />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 32, marginBottom: 8 }}>
          <T v="section">Recent</T>
          {recent.length ? (
            <Pressable onPress={() => router.push('/activity')} hitSlop={10}>
              <T v="meta" style={{ color: c.accent, fontFamily: f.uiMedium }}>See all</T>
            </Pressable>
          ) : null}
        </View>
        {recent.length ? (
          recent.map((tx) => <TxRow key={tx.id} tx={tx} />)
        ) : (
          <T v="meta" style={{ marginTop: 8 }}>
            Nothing yet. Share your number or tap Receive to get paid.
          </T>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const Tile = ({ label, icon, onPress }: { label: string; icon: React.ReactNode; onPress: () => void }) => (
  <Pressable
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => ({
      flex: 1,
      height: 72,
      borderRadius: 24,
      backgroundColor: pressed ? c.surface2 : c.surface,
      borderWidth: 1,
      borderColor: c.line,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    })}
  >
    {icon}
    <T style={{ fontFamily: f.uiSemi, fontSize: 19 }}>{label}</T>
  </Pressable>
);


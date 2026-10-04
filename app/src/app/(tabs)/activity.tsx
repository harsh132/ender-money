import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';
import { askToReadSms, canReadSms, smsSupported } from '../../../modules/sms-retriever';
import { SafeAreaView } from 'react-native-safe-area-context';
import { dayLabel } from '../../lib/format';
import { setState, useStore, type Tx } from '../../lib/store';
import { c, f } from '../../lib/theme';
import { refresh } from '../../lib/wallet';
import { T, TestnetPill } from '../../ui/kit';
import { TxRow } from '../../ui/TxRow';

/** Every transfer on the current network, grouped by day. */
export default function Activity() {
  const activity = useStore((s) => s.activity);
  const network = useStore((s) => s.network);
  const [refreshing, setRefreshing] = useState(false);
  // Android asks once, here, for RECEIVE_SMS: Ender's texts then land in Activity without internet or copying.
  const smsAsked = useStore((s) => !!s.smsAsked);
  const [askSms, setAskSms] = useState(false);
  useEffect(() => {
    if (!smsAsked && smsSupported) void canReadSms().then((granted) => setAskSms(!granted), () => {});
  }, [smsAsked]);
  const allowSms = async () => {
    setAskSms(false);
    setState({ smsAsked: true });
    await askToReadSms().catch(() => false);
  };
  const [, tick] = useState(0);

  // Keeps "Sending · 4:12 left" counting down.
  useFocusEffect(
    useCallback(() => {
      const t = setInterval(() => tick((n) => n + 1), 1000);
      return () => clearInterval(t);
    }, []),
  );

  const sections = useMemo(() => {
    const groups = new Map<string, Tx[]>();
    for (const tx of activity.filter((t) => t.network === network).sort((a, b) => b.at - a.at)) {
      const day = dayLabel(tx.at);
      groups.set(day, [...(groups.get(day) ?? []), tx]);
    }
    return [...groups].map(([title, data]) => ({ title, data }));
  }, [activity, network]);

  const pull = async () => {
    setRefreshing(true);
    await refresh().catch(() => {});
    setRefreshing(false);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={c.accent} colors={[c.accent]} progressBackgroundColor={c.surface} />}
        ListHeaderComponent={
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', height: 64, gap: 12 }}>
              <T v="title" style={{ flex: 1 }}>Activity</T>
              {network === 'testnet' ? <TestnetPill /> : null}
            </View>
            {askSms ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, paddingHorizontal: 16, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
                <T v="meta" style={{ flex: 1 }}>Let Ender read texts from its own number, so payments show up here without internet.</T>
                <Pressable accessibilityRole="button" onPress={allowSms} hitSlop={10}>
                  <T v="meta" style={{ color: c.accent, fontFamily: f.uiSemi }}>Allow</T>
                </Pressable>
              </View>
            ) : null}
          </>
        }
        renderSectionHeader={({ section }) => (
          <T v="caption" style={{ color: c.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 20, marginBottom: 4, backgroundColor: c.bg }}>
            {section.title}
          </T>
        )}
        renderItem={({ item }) => <TxRow tx={item} />}
        ListEmptyComponent={<T v="meta" style={{ marginTop: 16 }}>No transfers yet.</T>}
        stickySectionHeadersEnabled={false}
      />
    </SafeAreaView>
  );
}

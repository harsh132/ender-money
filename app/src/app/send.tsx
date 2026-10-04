import { Contact, requestPermissionsAsync } from 'expo-contacts';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { formatUnits, isAddress, parseUnits, type Address } from 'viem';
import { AUSD_DECIMALS } from '../../../protocol/networks';
import { normalizePhone } from '../../../protocol/sms';
import { MAX_FEE } from '../lib/config';
import { phoneDisplay, short, usd } from '../lib/format';
import { quickSend, whileOwnScreen } from '../lib/keys';
import { useStore, type Recipient } from '../lib/store';
import { c, f } from '../lib/theme';
import { Back, Bolt, Person, Scan } from '../ui/icons';
import { Sigil } from '../ui/Sigil';
import { useQuickSend } from '../ui/useQuickSend';
import { Avatar, BackHeader, Banner, Button, Chip, Field, Screen, T, TestnetPill } from '../ui/kit';

export type To = { to: string; toAddress?: Address; phone?: string; label?: string };

/** Typed text -> recipient: an address, or a phone number (bare Indian numbers get +91). */
const parseRecipient = (raw: string): To | null => {
  const text = raw.trim();
  if (isAddress(text)) return { to: text.toLowerCase(), toAddress: text.toLowerCase() as Address };
  const phone = normalizePhone(text.replace(/[\s()-]/g, ''));
  return phone ? { to: phone, phone } : null;
};

const fromRecent = (r: Recipient): To => (r.phone ? { to: r.phone, phone: r.phone, label: r.name } : { to: r.address, toAddress: r.address, label: r.name });

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const;

export default function Send() {
  const params = useLocalSearchParams<{ to?: string; amount?: string }>();
  const recents = useStore((s) => s.recents);
  const pins = useStore((s) => s.pins);
  const network = useStore((s) => s.network);
  const balance = useStore((s) => s.account[s.network]?.balance);
  const [text, setText] = useState('');
  const [to, setTo] = useState<To | null>(() => (params.to ? parseRecipient(params.to) : null));
  const [amount, setAmount] = useState(params.amount ?? '');
  const [error, setError] = useState<string>();
  const [deliver, setDeliver] = useState<'AUSD' | 'CTK'>('AUSD');

  // A scan from this screen comes back with new params: adopt them once.
  const incoming = `${params.to ?? ''}|${params.amount ?? ''}`;
  const [adopted, setAdopted] = useState(incoming);
  if (adopted !== incoming) {
    setAdopted(incoming);
    if (params.to) setTo(parseRecipient(params.to));
    if (params.amount) setAmount(params.amount);
  }

  const quickMin = useQuickSend();
  const chips =
    network === 'testnet' || quickMin ? (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {quickMin ? <Chip label={`Quick send · ${quickMin} min`} icon={<Bolt size={14} color={c.accent} />} onPress={quickSend.end} /> : null}
        {network === 'testnet' ? <TestnetPill /> : null}
      </View>
    ) : undefined;

  const typed = useMemo(() => parseRecipient(text), [text]);
  const labelled = (t: To): To => {
    const known = recents.find((r) => (t.phone ? r.phone === t.phone : r.address === t.toAddress));
    return { ...t, label: t.label ?? known?.name };
  };

  const pickContact = async () => {
    setError(undefined);
    const { granted } = await requestPermissionsAsync();
    if (!granted) return setError('Ender needs contacts permission to pick someone.');
    const contact = await whileOwnScreen(() => Contact.presentPicker());
    if (!contact) return;
    const [phones, name] = await Promise.all([contact.getPhones(), contact.getFullName().catch(() => undefined)]);
    const phone = phones.map((p) => normalizePhone((p.number ?? '').replace(/[\s()-]/g, ''))).find(Boolean);
    if (!phone) return setError("That contact doesn't have a phone number Ender can use.");
    setTo({ to: phone, phone, label: name || undefined });
  };

  // ------------------------------------------------------------ amount step
  if (to) {
    const max = balance ? parseUnits(balance, AUSD_DECIMALS) - parseUnits(MAX_FEE, AUSD_DECIMALS) : 0n;
    const value = /^\d+(\.\d{0,6})?$/.test(amount) ? parseUnits(amount.replace(/\.$/, ''), AUSD_DECIMALS) : 0n;
    const tooMuch = balance !== undefined && value > max;
    const press = (k: (typeof KEYS)[number]) => {
      setAmount((a) => {
        if (k === '⌫') return a.slice(0, -1);
        if (k === '.') return a.includes('.') ? a : `${a || '0'}.`;
        if (a.includes('.') && a.split('.')[1]!.length >= 2) return a;
        if (a === '0') return k;
        return a.length >= 9 ? a : a + k;
      });
    };
    const name = to.label ?? (to.phone ? phoneDisplay(to.phone) : short(to.to));
    return (
      <Screen>
        <BackHeader title="Send" right={chips} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, paddingHorizontal: 16, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
          <Sigil address={to.toAddress ?? (to.phone ? pins[to.phone] : undefined)} fallback={name} size={44} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="body" numberOfLines={1}>{name}</T>
            <T v="meta" numberOfLines={1} style={{ fontSize: 15, fontFamily: to.toAddress ? f.mono : f.ui }}>
              {to.label && to.phone ? phoneDisplay(to.phone) : to.toAddress ? short(to.toAddress) : 'Ender finds their wallet'}
            </T>
          </View>
          <Pressable onPress={() => setTo(null)} hitSlop={10}>
            <T v="meta" style={{ color: c.accent, fontFamily: f.uiMedium }}>Change</T>
          </Pressable>
        </View>

        <T v="amount" style={{ textAlign: 'center', paddingTop: 36, paddingBottom: 8 }} numberOfLines={1} adjustsFontSizeToFit>
          <T v="amount" style={{ color: c.fg3 }}>$ </T>
          {amount || '0'}
        </T>
        <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 }}>
          <T v="meta" style={{ color: tooMuch ? c.negative : c.fg2 }}>
            {tooMuch ? 'More than your balance' : `Balance $${usd(balance ?? '0')}`}
          </T>
          {max > 0n ? (
            <Pressable onPress={() => setAmount(formatUnits(max, AUSD_DECIMALS))} style={{ height: 36, paddingHorizontal: 14, borderRadius: 999, backgroundColor: c.surface2, justifyContent: 'center' }}>
              <T style={{ fontFamily: f.uiSemi, fontSize: 15 }}>Max</T>
            </Pressable>
          ) : null}
        </View>

        {network === 'testnet' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 20 }}>
            <T v="meta">Recipient gets</T>
            <View style={{ flexDirection: 'row', backgroundColor: c.surface, borderRadius: 999, borderWidth: 1, borderColor: c.line, padding: 4 }}>
              {(['AUSD', 'CTK'] as const).map((d) => (
                <Pressable
                  key={d}
                  accessibilityRole="button"
                  accessibilityState={{ selected: deliver === d }}
                  onPress={() => setDeliver(d)}
                  style={{ height: 40, paddingHorizontal: 18, borderRadius: 999, justifyContent: 'center', backgroundColor: deliver === d ? c.surface2 : 'transparent' }}
                >
                  <T style={{ fontFamily: f.uiSemi, fontSize: 15, color: deliver === d ? c.accent : c.fg2 }}>{d}</T>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ flex: 1, minHeight: 24 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {KEYS.map((k) => (
            <Pressable key={k} accessibilityLabel={k === '⌫' ? 'Delete' : k} onPress={() => press(k)} style={({ pressed }) => ({ width: '33.33%', height: 68, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: pressed ? c.surface : 'transparent' })}>
              {k === '⌫' ? <Back size={28} color={c.fg2} /> : <T style={{ fontFamily: f.uiMedium, fontSize: 30, lineHeight: 36 }}>{k}</T>}
            </Pressable>
          ))}
        </View>
        <Button
          title="Review"
          disabled={value <= 0n || tooMuch}
          onPress={() => router.push({ pathname: '/review', params: { ...to, amount: amount.replace(/\.$/, ''), ...(network === 'testnet' && deliver === 'CTK' ? { deliver } : {}) } })}
          style={{ marginTop: 8, marginBottom: 12 }}
        />
      </Screen>
    );
  }

  // ------------------------------------------------------------ recipient step
  return (
    <Screen>
      <BackHeader title="Send" right={chips} />
      <Field
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder="Number or wallet address"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="default"
        onSubmitEditing={() => typed && setTo(labelled(typed))}
        right={
          <View style={{ flexDirection: 'row', gap: 4 }}>
            <Pressable accessibilityLabel="Pick a contact" onPress={pickContact} hitSlop={8} style={{ padding: 6 }}><Person size={24} color={c.fg2} /></Pressable>
            <Pressable accessibilityLabel="Scan a code" onPress={() => router.push('/scan')} hitSlop={8} style={{ padding: 6 }}><Scan size={24} color={c.fg2} /></Pressable>
          </View>
        }
      />
      {error ? <View style={{ marginTop: 12 }}><Banner tone="negative">{error}</Banner></View> : null}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
        {typed ? (
          <Pressable onPress={() => setTo(labelled(typed))} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, height: 72, marginTop: 8, opacity: pressed ? 0.7 : 1 })}>
            <Avatar label={typed.phone ? '#' : '0'} />
            <View style={{ flex: 1 }}>
              <T v="body">Send to {typed.phone ? phoneDisplay(typed.phone) : short(typed.to)}</T>
              <T v="meta">{typed.phone ? 'Phone number' : 'Wallet address'}</T>
            </View>
          </Pressable>
        ) : null}
        {recents.length ? (
          <>
            <T v="caption" style={{ color: c.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 24, marginBottom: 4 }}>Recent</T>
            {recents.map((r) => {
              const name = r.name ?? (r.phone ? phoneDisplay(r.phone) : short(r.address));
              return (
                <Pressable key={r.address} onPress={() => setTo(fromRecent(r))} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, height: 72, opacity: pressed ? 0.7 : 1 })}>
                  <Sigil address={r.address} fallback={name} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T v="body" numberOfLines={1}>{name}</T>
                    <T v="meta" numberOfLines={1} style={{ fontFamily: f.mono, fontSize: 15 }}>{short(r.address)}</T>
                  </View>
                </Pressable>
              );
            })}
          </>
        ) : (
          <T v="meta" style={{ marginTop: 20 }}>Type a phone number or paste a wallet address. Pick a contact or scan a code with the buttons above.</T>
        )}
      </ScrollView>
    </Screen>
  );
}

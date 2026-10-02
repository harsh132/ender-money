import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { countdown, short, time, usd } from '../lib/format';
import type { Tx } from '../lib/store';
import { c, f } from '../lib/theme';
import { ArrowDown, ArrowUp } from './icons';
import { T } from './kit';

const STATUS = { sending: 'Sending', sent: 'Sent', failed: 'Failed', expired: 'Expired' } as const;

export const meta = (tx: Tx) => {
  if (tx.direction === 'in') return `Received · ${time(tx.at)}`;
  if (tx.status === 'sending' && tx.deadline && tx.deadline * 1000 > Date.now()) return `Sending · ${countdown(tx.deadline * 1000 - Date.now())} left`;
  if (tx.status === 'failed' || tx.status === 'expired') return `${STATUS[tx.status]} · tap to retry`;
  return `${STATUS[tx.status]} · ${time(tx.at)}`;
};

export const TxRow = ({ tx }: { tx: Tx }) => {
  const incoming = tx.direction === 'in';
  const dead = tx.status === 'failed' || tx.status === 'expired';
  return (
    <Pressable onPress={() => router.push({ pathname: '/tx/[id]', params: { id: tx.id } })} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, height: 72, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
        {incoming ? <ArrowDown size={22} color={c.positive} /> : <ArrowUp size={22} color={dead ? c.negative : c.fg2} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="body" numberOfLines={1}>{tx.label ?? short(tx.counterparty)}</T>
        <T v="meta" numberOfLines={1} style={{ marginTop: 2, color: dead ? c.negative : c.fg2 }}>{meta(tx)}</T>
      </View>
      <T v="body" style={{ fontFamily: f.uiSemi, color: incoming ? c.positive : dead ? c.fg3 : c.fg, textDecorationLine: dead ? 'line-through' : 'none' }}>
        {incoming ? '+' : dead ? '' : '−'}${usd(tx.amount)}
      </T>
    </Pressable>
  );
};

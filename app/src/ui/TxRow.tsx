import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { countdown, short, time, usd } from '../lib/format';
import type { Tx } from '../lib/store';
import { c, f } from '../lib/theme';
import { ArrowDown, ArrowUp } from './icons';
import { T } from './kit';
import { Sigil } from './Sigil';

const STATUS = { sending: 'Sending', sent: 'Sent', failed: 'Failed', expired: 'Expired' } as const;

const metaText = (tx: Tx) => {
  if (tx.direction === 'in') return `Received · ${time(tx.at)}`;
  if (tx.status === 'sending' && tx.deadline && tx.deadline * 1000 > Date.now()) return `Sending · ${countdown(tx.deadline * 1000 - Date.now())} left`;
  if (tx.status === 'failed' || tx.status === 'expired') return `${STATUS[tx.status]} · tap to retry`;
  return `${STATUS[tx.status]} · ${time(tx.at)}`;
};

export const meta = (tx: Tx) =>
  tx.shield && tx.status === 'sent' ? `Made private · ${time(tx.at)}` : tx.private ? `Private · ${metaText(tx)}` : metaText(tx);

/** Name of the other side: contact, number, address, private address, or (a private payment to a number we don't know) "Private". */
export const who = (tx: Tx) => tx.label ?? (tx.counterparty ? short(tx.counterparty) : tx.to ? short(tx.to) : 'Private');

export const TxRow = ({ tx }: { tx: Tx }) => {
  const incoming = tx.direction === 'in';
  const dead = tx.status === 'failed' || tx.status === 'expired';
  return (
    <Pressable onPress={() => router.push({ pathname: '/tx/[id]', params: { id: tx.id } })} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, height: 72, opacity: pressed ? 0.7 : 1 })}>
      <View>
        <Sigil address={tx.counterparty ?? tx.to} fallback={tx.label ?? '#'} />
        <View style={{ position: 'absolute', right: -4, bottom: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
          {incoming ? <ArrowDown size={14} color={c.positive} width={2.4} /> : <ArrowUp size={14} color={dead ? c.negative : c.fg2} width={2.4} />}
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="body" numberOfLines={1}>{who(tx)}</T>
        <T v="meta" numberOfLines={1} style={{ marginTop: 2, color: dead ? c.negative : c.fg2 }}>{meta(tx)}</T>
      </View>
      <T v="body" style={{ fontFamily: f.uiSemi, color: incoming ? c.positive : dead ? c.fg3 : c.fg, textDecorationLine: dead ? 'line-through' : 'none' }}>
        {incoming ? '+' : dead ? '' : '−'}${usd(tx.amount)}
      </T>
    </Pressable>
  );
};

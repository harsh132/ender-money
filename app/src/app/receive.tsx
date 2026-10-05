import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { encodePrivateAddress } from '../../../protocol/recipient';
import { unb64 } from '../../../protocol/sms';
import { MAX_FEE } from '../lib/config';
import { phoneDisplay } from '../lib/format';
import { autoShieldOn } from '../lib/private';
import { useStore } from '../lib/store';
import { isRegistered } from '../lib/wallet';
import { c, f } from '../lib/theme';
import { Copy, Share as ShareIcon } from '../ui/icons';
import { Button, T, TestnetPill } from '../ui/kit';
import { QR } from '../ui/QR';

type Mode = 'public' | 'private';

/**
 * Sheet: the Ender ID and its pay page link (copy), the QR of the plain address (any wallet can read it), plus copy
 * and share. On a network with a pool, a Public / Private toggle shows the private address (ender1…) too, which takes
 * private payments only.
 */
export default function Receive() {
  const wallet = useStore((s) => s.wallet);
  const network = useStore((s) => s.network);
  const owner = useStore((s) => (isRegistered(s.network, s) ? s.shielded?.owner : undefined));
  // With Auto Shield on the public balance moves by itself.
  const canShield = useStore((s) => isRegistered(s.network, s) && !autoShieldOn(s) && Number(s.account[s.network]?.balance ?? 0) > Number(MAX_FEE));
  const [mode, setMode] = useState<Mode>('public');
  const [copied, setCopied] = useState<'address' | 'link'>();
  const { bottom } = useSafeAreaInsets();
  const privateAddress = useMemo(() => {
    const packed = owner ? unb64(owner.replace(/=+$/, ''), 64) : null;
    return packed ? encodePrivateAddress(packed) : undefined;
  }, [owner]);
  if (!wallet) return null;

  const priv = mode === 'private' && !!privateAddress;
  const shown = (priv && privateAddress) || wallet.address;
  const link = wallet.enderId ? `https://${wallet.enderId}` : undefined;
  const copy = async (what: 'address' | 'link') => {
    await Clipboard.setStringAsync(what === 'link' ? link! : shown);
    setCopied(what);
    setTimeout(() => setCopied(undefined), 1500);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: bottom }}>
      <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.surface2, marginBottom: 16 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <T v="title" style={{ flex: 1 }}>Receive</T>
        {network === 'testnet' ? <TestnetPill /> : null}
      </View>
      {wallet.enderId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy ${link}`}
          onPress={() => copy('link')}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 20, backgroundColor: pressed ? c.surface2 : c.surface, borderWidth: 1, borderColor: c.line })}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="caption" style={{ color: c.fg3 }}>Your Ender ID</T>
            <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: f.display, fontSize: 24, lineHeight: 30, color: c.fg, marginTop: 2 }}>{wallet.enderId}</T>
          </View>
          {copied === 'link' ? <T style={{ fontFamily: f.uiSemi, fontSize: 15, color: c.accent }}>Copied</T> : <Copy size={20} color={c.accent} />}
        </Pressable>
      ) : null}
      {privateAddress ? (
        <View style={{ flexDirection: 'row', alignSelf: 'flex-start', marginTop: 14, backgroundColor: c.surface, borderRadius: 999, borderWidth: 1, borderColor: c.line, padding: 4 }}>
          {(['public', 'private'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m }}
              onPress={() => setMode(m)}
              style={{ height: 40, paddingHorizontal: 18, borderRadius: 999, justifyContent: 'center', backgroundColor: mode === m ? c.surface2 : 'transparent' }}
            >
              <T style={{ fontFamily: f.uiSemi, fontSize: 15, color: mode === m ? c.accent : c.fg2 }}>{m === 'public' ? 'Public' : 'Private'}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
      <T v="meta" style={{ marginTop: 10 }}>
        {priv ? 'Your private address. Takes private payments from Ender only' : `Your AUSD address on Monad${network === 'testnet' ? ' testnet' : ''}`}
      </T>
      <View style={{ alignSelf: 'center', marginTop: 24, marginBottom: 18, padding: 22, borderRadius: 28, backgroundColor: c.fg }}>
        <QR value={shown} size={216} />
      </View>
      <T style={{ fontFamily: f.mono, fontSize: priv ? 13 : 16, lineHeight: priv ? 19 : 24, color: c.fg, textAlign: 'center', paddingHorizontal: 12 }} selectable>
        {shown}
      </T>
      {priv ? null : (
        <T v="meta" style={{ textAlign: 'center', marginTop: 12 }}>
          {wallet.enderId ? 'Or your number' : 'Or just your number'}: {phoneDisplay(wallet.phone)}. We'll text you when money arrives.
        </T>
      )}
      <View style={{ flex: 1, minHeight: 24 }} />
      {canShield ? (
        <Button
          title="Make private"
          kind="text"
          onPress={() => {
            router.back();
            router.push({ pathname: '/send', params: { shield: '1' } });
          }}
        />
      ) : null}
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 28 }}>
        <Button title={copied === 'address' ? 'Copied' : 'Copy'} kind="ghost" icon={<Copy size={20} />} onPress={() => copy('address')} style={{ flex: 1 }} />
        <Button
          title="Share"
          icon={<ShareIcon size={20} color={c.accentInk} />}
          onPress={() =>
            Share.share({
              message: priv
                ? `Pay me privately on Ender: ${shown}`
                : link
                  ? `Pay me on Ender: ${link}\nOr send AUSD on Monad to ${wallet.address}`
                  : `Pay me on Ender: ${phoneDisplay(wallet.phone)}\nOr send AUSD on Monad to ${wallet.address}`,
            })
          }
          style={{ flex: 1 }}
        />
      </View>
    </ScrollView>
  );
}

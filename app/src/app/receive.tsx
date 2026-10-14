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
import { smsOn } from '../lib/transport';
import { isRegistered } from '../lib/wallet';
import { c, f } from '../lib/theme';
import { Close, Copy, Share as ShareIcon } from '../ui/icons';
import { Button, IconButton, T, TestnetPill } from '../ui/kit';
import { QR } from '../ui/QR';
import { closeSheet, Sheet } from '../ui/Sheet';

type Mode = 'ender' | 'public' | 'private';
const LABEL: Record<Mode, string> = { ender: 'Ender ID', public: 'Public', private: 'Private' };

/**
 * Sheet: Ender ID / Public / Private tabs, each a QR with copy and share. The Ender ID QR is the plain name
 * (label.ender.my), so ENS wallets resolve it as well as our scanner; Public is the 0x address any wallet reads;
 * Private (networks with a pool) is the ender1… address, which takes private payments only.
 */
export default function Receive() {
  const wallet = useStore((s) => s.wallet);
  const sms = useStore((s) => smsOn(s));
  const network = useStore((s) => s.network);
  const owner = useStore((s) => (isRegistered(s.network, s) ? s.shielded?.owner : undefined));
  // With Auto Shield on the public balance moves by itself.
  const canShield = useStore((s) => isRegistered(s.network, s) && !autoShieldOn(s) && Number(s.account[s.network]?.balance ?? 0) > Number(MAX_FEE));
  const [mode, setMode] = useState<Mode>(wallet?.enderId ? 'ender' : 'public');
  const [copied, setCopied] = useState(false);
  const { bottom } = useSafeAreaInsets();
  const privateAddress = useMemo(() => {
    const packed = owner ? unb64(owner.replace(/=+$/, ''), 64) : null;
    return packed ? encodePrivateAddress(packed) : undefined;
  }, [owner]);
  if (!wallet) return null;

  const modes = (['ender', 'public', 'private'] as const).filter((m) => (m === 'ender' ? !!wallet.enderId : m === 'private' ? !!privateAddress : true));
  const shown = mode === 'ender' && wallet.enderId ? wallet.enderId : mode === 'private' && privateAddress ? privateAddress : wallet.address;
  const copy = async () => {
    await Clipboard.setStringAsync(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const share = () =>
    Share.share({
      message:
        mode === 'private'
          ? `Pay me privately on Ender: ${shown}`
          : mode === 'ender'
            ? `Pay me on Ender: ${shown}\nOr send AUSD on Monad to ${wallet.address}`
            : sms
              ? `Pay me on Ender: ${phoneDisplay(wallet.phone!)}\nOr send AUSD on Monad to ${wallet.address}`
              : `Pay me in AUSD on Monad: ${wallet.address}`,
    });

  return (
    <Sheet height="72%">
      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: bottom }}>
        <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.surface2, marginBottom: 12 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <T v="title" style={{ flex: 1 }}>Receive</T>
          {network === 'testnet' ? <TestnetPill /> : null}
          <IconButton label="Close" onPress={closeSheet}>
            <Close size={22} />
          </IconButton>
        </View>
        {modes.length > 1 ? (
          <View style={{ flexDirection: 'row', alignSelf: 'flex-start', marginTop: 12, backgroundColor: c.surface, borderRadius: 999, borderWidth: 1, borderColor: c.line, padding: 4 }}>
            {modes.map((m) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === m }}
                onPress={() => setMode(m)}
                style={{ height: 38, paddingHorizontal: 16, borderRadius: 999, justifyContent: 'center', backgroundColor: mode === m ? c.surface2 : 'transparent' }}
              >
                <T style={{ fontFamily: f.uiSemi, fontSize: 15, color: mode === m ? c.accent : c.fg2 }}>{LABEL[m]}</T>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={{ alignSelf: 'center', marginTop: 20, marginBottom: 12, padding: 14, borderRadius: 24, backgroundColor: c.fg }}>
          <QR value={shown} size={168} />
        </View>
        {mode === 'ender' ? (
          <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: f.display, fontSize: 26, lineHeight: 32, color: c.fg, textAlign: 'center', paddingHorizontal: 12 }} selectable>
            {shown}
          </T>
        ) : (
          <T style={{ fontFamily: f.mono, fontSize: mode === 'private' ? 13 : 15, lineHeight: mode === 'private' ? 19 : 22, color: c.fg, textAlign: 'center', paddingHorizontal: 12 }} selectable>
            {shown}
          </T>
        )}
        <View style={{ flex: 1, minHeight: 20 }} />
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
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
          <Button title={copied ? 'Copied' : 'Copy'} kind="ghost" icon={<Copy size={20} />} onPress={copy} style={{ flex: 1 }} />
          <Button title="Share" icon={<ShareIcon size={20} color={c.accentInk} />} onPress={share} style={{ flex: 1 }} />
        </View>
      </ScrollView>
    </Sheet>
  );
}

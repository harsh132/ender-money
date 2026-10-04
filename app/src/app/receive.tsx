import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Share, View } from 'react-native';
import { MAX_FEE } from '../lib/config';
import { phoneDisplay } from '../lib/format';
import { useStore } from '../lib/store';
import { isRegistered } from '../lib/wallet';
import { c, f } from '../lib/theme';
import { Copy, Share as ShareIcon } from '../ui/icons';
import { Button, T, TestnetPill } from '../ui/kit';
import { QR } from '../ui/QR';

/** Sheet: QR of the plain address (any wallet can read it), plus copy and share. */
export default function Receive() {
  const wallet = useStore((s) => s.wallet);
  const network = useStore((s) => s.network);
  const canShield = useStore((s) => isRegistered(s.network, s) && Number(s.account[s.network]?.balance ?? 0) > Number(MAX_FEE));
  const [copied, setCopied] = useState(false);
  if (!wallet) return null;

  const copy = async () => {
    await Clipboard.setStringAsync(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingHorizontal: 20, paddingTop: 20 }}>
      <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.surface2, marginBottom: 16 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <T v="title" style={{ flex: 1 }}>Receive</T>
        {network === 'testnet' ? <TestnetPill /> : null}
      </View>
      <T v="meta" style={{ marginTop: 6 }}>Your AUSD address on Monad{network === 'testnet' ? ' testnet' : ''}</T>
      <View style={{ alignSelf: 'center', marginTop: 28, marginBottom: 20, padding: 22, borderRadius: 28, backgroundColor: c.fg }}>
        <QR value={wallet.address} size={216} />
      </View>
      <T style={{ fontFamily: f.mono, fontSize: 16, lineHeight: 24, color: c.fg, textAlign: 'center', paddingHorizontal: 12 }} selectable>
        {wallet.address}
      </T>
      <T v="meta" style={{ textAlign: 'center', marginTop: 12 }}>
        Or just your number: {phoneDisplay(wallet.phone)}. We'll text you when money arrives.
      </T>
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
        <Button title={copied ? 'Copied' : 'Copy'} kind="ghost" icon={<Copy size={20} />} onPress={copy} style={{ flex: 1 }} />
        <Button
          title="Share"
          icon={<ShareIcon size={20} color={c.accentInk} />}
          onPress={() => Share.share({ message: `Pay me on Ender: ${phoneDisplay(wallet.phone)}\nOr send AUSD on Monad to ${wallet.address}` })}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { enderId } from '../../../protocol/names';
import { encodePrivateAddress, parseRecipient } from '../../../protocol/recipient';
import { c, f } from '../lib/theme';
import { Close, Torch } from '../ui/icons';
import { Banner, Button, T } from '../ui/kit';

/** Full-screen scanner. Reads a wallet address, ethereum: or ender: link, private address, Ender ID (or its pay page link) or number, then opens Send. */
export default function Scan() {
  const [permission, request] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [error, setError] = useState<string>();
  const handled = useRef(false);

  const go = (raw: string) => {
    const r = parseRecipient(raw);
    if (!r) return setError("That isn't a wallet address, Ender ID, private address or Ender code.");
    handled.current = true;
    const to = r.kind === 'address' ? r.address : r.kind === 'phone' ? r.phone : r.kind === 'name' ? enderId(r.label) : encodePrivateAddress(r.packed);
    router.dismissTo({ pathname: '/send', params: r.amount ? { to, amount: r.amount } : { to } });
  };

  const paste = async () => go(await Clipboard.getStringAsync());

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => !handled.current && go(data)}
        />
      ) : null}
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 64 }}>
          <Pressable accessibilityLabel="Close" onPress={() => router.back()} hitSlop={12} style={st.round}>
            <Close size={24} />
          </Pressable>
          <View style={{ flex: 1, minHeight: 24 }} />
          {permission?.granted ? (
            <Pressable accessibilityLabel="Torch" onPress={() => setTorch((t) => !t)} hitSlop={12} style={[st.round, torch && { backgroundColor: c.accent }]}>
              <Torch size={22} color={torch ? c.accentInk : c.fg} />
            </Pressable>
          ) : null}
        </View>
        <T v="title" style={{ textAlign: 'center', marginTop: 12 }}>Scan to pay</T>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {permission?.granted ? (
            <View style={st.frame} />
          ) : (
            <View style={{ gap: 16, alignSelf: 'stretch' }}>
              <T v="body" style={{ textAlign: 'center', color: c.fg2 }}>Ender needs the camera to scan codes.</T>
              <Button title="Allow camera" onPress={request} />
            </View>
          )}
        </View>
        {error ? <Banner tone="negative">{error}</Banner> : null}
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 12, marginBottom: 12 }}>
          <Pressable onPress={paste} style={st.pill}><T style={{ fontFamily: f.uiSemi, fontSize: 17 }}>Paste address</T></Pressable>
          <Pressable onPress={() => router.dismissTo('/send')} style={st.pill}><T style={{ fontFamily: f.uiSemi, fontSize: 17 }}>Enter number</T></Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const st = StyleSheet.create({
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(20,20,17,0.7)', alignItems: 'center', justifyContent: 'center' },
  frame: { width: 260, height: 260, borderRadius: 32, borderWidth: 3, borderColor: c.accent },
  pill: { flex: 1, height: 56, borderRadius: 999, backgroundColor: 'rgba(30,29,26,0.92)', borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
});

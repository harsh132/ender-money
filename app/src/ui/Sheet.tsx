import { router } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { c } from '../lib/theme';

export const closeSheet = () => (router.canGoBack() ? router.back() : router.replace('/home'));

/**
 * A bottom sheet's frame. On the phone the native form sheet (_layout options) drags and dims; the web has none, so
 * there it's a dimmed backdrop (a tap closes it), the sheet anchored to the bottom at `height`, and Escape.
 */
export const Sheet = ({ children, height }: { children: ReactNode; height: `${number}%` }) => {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeSheet();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' }}>
      <Pressable accessibilityLabel="Close" onPress={closeSheet} style={{ flex: 1 }} />
      <View style={{ height, width: '100%', maxWidth: 520, alignSelf: 'center', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', backgroundColor: c.bg }}>
        {children}
      </View>
    </View>
  );
};

import { BlurTargetView, BlurView } from 'expo-blur';
import { router, Tabs, usePathname } from 'expo-router';
import { useRef, type RefObject } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c } from '../../lib/theme';
import { useAutoShielding } from '../../lib/wallet';
import { Gear, Home, List, Shield } from '../../ui/icons';
import { Spinner, T } from '../../ui/kit';

const TABS = [
  { name: 'home', label: 'Home', Icon: Home },
  { name: 'activity', label: 'Activity', Icon: List },
  { name: 'settings', label: 'Settings', Icon: Gear },
] as const;

/**
 * Floating pill dock, frosted over whatever scrolls beneath it. It lives
 * outside the navigator because Android's blur samples a BlurTargetView,
 * which must hold the screens but not the dock itself.
 */
const Dock = ({ target }: { target: RefObject<View | null> }) => {
  const insets = useSafeAreaInsets();
  const path = usePathname();
  return (
    <View pointerEvents="box-none" style={[st.wrap, { bottom: Math.max(insets.bottom, 12) + 12 }]}>
      <View style={st.shadow}>
        <BlurView blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" intensity={70} tint="dark" style={st.dock}>
          {TABS.map(({ name, label, Icon }) => {
            const on = path === `/${name}`;
            return (
              <Pressable
                key={name}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: on }}
                onPress={() => !on && router.navigate(`/${name}`)}
                style={[st.tab, on && { backgroundColor: 'rgba(255,255,255,0.08)' }]}
              >
                <Icon size={26} color={on ? c.accent : c.fg2} />
              </Pressable>
            );
          })}
        </BlurView>
      </View>
    </View>
  );
};

/** While Auto Shield moves the public balance into the private one; a tap explains it. */
const ShieldToast = () => {
  const insets = useSafeAreaInsets();
  if (!useAutoShielding()) return null;
  return (
    <View pointerEvents="box-none" style={[st.wrap, { bottom: Math.max(insets.bottom, 12) + 96 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Auto Shield is running. What is this?" onPress={() => router.push('/auto-shield')} style={st.toast}>
        <Spinner />
        <T v="meta" style={{ flex: 1, color: c.fg }}>Making your balance private…</T>
        <Shield size={20} color={c.accent} />
      </Pressable>
    </View>
  );
};

export default function TabsLayout() {
  const target = useRef<View>(null);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <BlurTargetView ref={target} style={{ flex: 1, backgroundColor: c.bg }}>
        <Tabs tabBar={() => null} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.bg }, animation: 'fade' }}>
          <Tabs.Screen name="home" />
          <Tabs.Screen name="activity" />
          <Tabs.Screen name="settings" />
        </Tabs>
      </BlurTargetView>
      <ShieldToast />
      <Dock target={target} />
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // Shadow on an unclipped wrapper; the blur itself is clipped to the pill.
  shadow: { borderRadius: 999, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 16 },
  dock: {
    flexDirection: 'row',
    gap: 6,
    padding: 8,
    borderRadius: 999,
    overflow: 'hidden',
    // A warm tint over the blur keeps icons legible over bright rows.
    backgroundColor: 'rgba(24,23,20,0.72)',
    borderWidth: 1,
    borderColor: c.line,
  },
  tab: { width: 76, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: 300,
    maxWidth: '90%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
  },
});

import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c } from '../../lib/theme';
import { Gear, Home, List } from '../../ui/icons';

type BottomTabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

const ICONS = { home: Home, activity: List, settings: Gear } as const;
const LABELS = { home: 'Home', activity: 'Activity', settings: 'Settings' } as const;

/** Floating pill dock: Home / Activity / Settings. */
const Dock = ({ state, navigation }: BottomTabBarProps) => {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[st.wrap, { bottom: Math.max(insets.bottom, 12) + 12 }]}>
      <View style={st.dock}>
        {state.routes.map((route, i) => {
          const Icon = ICONS[route.name as keyof typeof ICONS];
          const on = state.index === i;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={LABELS[route.name as keyof typeof LABELS]}
              accessibilityState={{ selected: on }}
              onPress={() => !on && navigation.navigate(route.name)}
              style={[st.tab, on && { backgroundColor: 'rgba(255,255,255,0.08)' }]}
            >
              {Icon ? <Icon size={26} color={on ? c.accent : c.fg2} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <Dock {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.bg }, animation: 'fade' }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  dock: {
    flexDirection: 'row',
    gap: 6,
    padding: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(36,35,31,0.96)',
    borderWidth: 1,
    borderColor: c.line,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  tab: { width: 76, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});

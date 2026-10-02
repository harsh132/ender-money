/** Shared building blocks. Sizes follow SCOPE.md: 14pt minimum, 56pt+ targets, 72pt rows. */
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { c, f } from '../lib/theme';
import { Back } from './icons';

type Variant = 'hero' | 'amount' | 'headline' | 'title' | 'section' | 'body' | 'meta' | 'caption' | 'mono';

const variants: Record<Variant, TextStyle> = {
  hero: { fontFamily: f.display, fontSize: 64, lineHeight: 70, letterSpacing: -1.2, color: c.fg },
  amount: { fontFamily: f.display, fontSize: 72, lineHeight: 80, letterSpacing: -1.4, color: c.fg },
  headline: { fontFamily: f.display, fontSize: 38, lineHeight: 44, letterSpacing: -0.4, color: c.fg },
  title: { fontFamily: f.uiBold, fontSize: 30, lineHeight: 36, color: c.fg },
  section: { fontFamily: f.uiSemi, fontSize: 22, lineHeight: 28, color: c.fg },
  body: { fontFamily: f.uiMedium, fontSize: 18, lineHeight: 24, color: c.fg },
  meta: { fontFamily: f.ui, fontSize: 16, lineHeight: 22, color: c.fg2 },
  caption: { fontFamily: f.uiMedium, fontSize: 14, lineHeight: 18, color: c.fg2 },
  mono: { fontFamily: f.mono, fontSize: 16, lineHeight: 22, color: c.fg },
};

export const T = ({ v = 'body', style, ...rest }: TextProps & { v?: Variant }) => (
  <Text {...rest} style={[variants[v], { fontVariant: ['tabular-nums'] }, style]} />
);

export const Screen = ({
  children,
  scroll,
  style,
  edges = ['top', 'bottom'],
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  edges?: ('top' | 'bottom')[];
}) => (
  <SafeAreaView edges={edges} style={s.screen}>
    {scroll ? (
      <ScrollView contentContainerStyle={[s.body, style]} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    ) : (
      <View style={[s.body, { flex: 1 }, style]}>{children}</View>
    )}
  </SafeAreaView>
);

export const Button = ({
  title,
  onPress,
  kind = 'primary',
  busy,
  disabled,
  icon,
  style,
}: {
  title: string;
  onPress?: () => void;
  kind?: 'primary' | 'ghost' | 'text';
  busy?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) => {
  const ink = kind === 'primary' ? c.accentInk : kind === 'text' ? c.accent : c.fg;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={busy || disabled ? undefined : onPress}
      style={({ pressed }) => [
        s.btn,
        kind === 'primary' && { backgroundColor: pressed ? c.accentPress : c.accent },
        kind === 'ghost' && { backgroundColor: pressed ? c.surface2 : c.surface, borderWidth: 1, borderColor: c.line },
        kind === 'text' && { height: 52, opacity: pressed ? 0.6 : 1 },
        (disabled || busy) && kind !== 'text' && { opacity: 0.45 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={ink} /> : icon}
      <Text style={{ fontFamily: f.uiSemi, fontSize: kind === 'text' ? 17 : 19, color: ink }}>{title}</Text>
    </Pressable>
  );
};

export const IconButton = ({ children, onPress, label }: { children: ReactNode; onPress: () => void; label: string }) => (
  <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.iconBtn, pressed && { backgroundColor: c.surface2 }]}>
    {children}
  </Pressable>
);

export const BackHeader = ({ title, right }: { title?: string; right?: ReactNode }) => (
  <View style={s.back}>
    <Pressable accessibilityLabel="Back" accessibilityRole="button" hitSlop={12} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} style={{ paddingRight: 6 }}>
      <Back size={28} />
    </Pressable>
    {title ? <T v="section" style={{ flex: 1 }}>{title}</T> : <View style={{ flex: 1 }} />}
    {right}
  </View>
);

/** Web preview only: drop the browser's focus outline (the field has its own border). */
const webInput = Platform.OS === 'web' ? ({ outlineStyle: 'none', minWidth: '0px', width: '0px' } as unknown as TextStyle) : undefined;

export const Field = (props: TextInputProps & { left?: ReactNode; right?: ReactNode; big?: boolean }) => {
  const { left, right, big, style, ...rest } = props;
  return (
    <View style={s.field}>
      {left}
      <TextInput
        placeholderTextColor={c.fg3}
        selectionColor={c.accent}
        cursorColor={c.accent}
        {...rest}
        style={[{ flex: 1, minWidth: 0, color: c.fg, fontFamily: f.uiMedium, fontSize: big ? 22 : 18, height: '100%' }, webInput, style]}
      />
      {right}
    </View>
  );
};

export const Chip = ({
  label,
  tone = 'plain',
  onPress,
  icon,
  small,
}: {
  label: string;
  tone?: 'plain' | 'warning' | 'positive';
  onPress?: () => void;
  icon?: ReactNode;
  small?: boolean;
}) => {
  const color = tone === 'warning' ? c.warning : tone === 'positive' ? c.positive : c.fg2;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[s.chip, small && { minHeight: 30, paddingVertical: 4, paddingHorizontal: 11, gap: 6 }, tone === 'warning' && { borderColor: 'rgba(232,182,92,0.35)' }]}
    >
      {icon ?? <View style={[s.dot, { backgroundColor: color }, small && { width: 6, height: 6, borderRadius: 3 }]} />}
      <Text style={{ fontFamily: f.uiMedium, fontSize: small ? 13 : 14, lineHeight: small ? 18 : 20, color, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
};

/** Shown wherever testnet balances appear, so test money is never mistaken for real money. */
export const TestnetPill = ({ onPress }: { onPress?: () => void }) => <Chip label="Testnet" tone="warning" small onPress={onPress} />;

export const Card = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[s.card, style]}>{children}</View>;

export const KV = ({ k, v, last, mono }: { k: string; v: ReactNode; last?: boolean; mono?: boolean }) => (
  <View style={[s.kv, last && { borderBottomWidth: 0 }]}>
    <T v="body" style={{ color: c.fg2, fontFamily: f.ui }}>{k}</T>
    {typeof v === 'string' ? <T v={mono ? 'mono' : 'body'} style={{ fontFamily: mono ? f.mono : f.uiSemi, flexShrink: 1, textAlign: 'right' }}>{v}</T> : v}
  </View>
);

export const Banner = ({ children, tone = 'plain', icon }: { children: ReactNode; tone?: 'plain' | 'warning' | 'negative'; icon?: ReactNode }) => (
  <View style={[s.banner, tone === 'warning' && { borderColor: 'rgba(232,182,92,0.35)' }, tone === 'negative' && { borderColor: 'rgba(232,144,122,0.4)' }]}>
    {icon}
    <T v="meta" style={{ flex: 1, color: tone === 'negative' ? c.negative : tone === 'warning' ? c.warning : c.fg }}>{children}</T>
  </View>
);

export const Avatar = ({ label, size = 48 }: { label: string; size?: number }) => (
  <View style={[s.avatar, { width: size, height: size }]}>
    <Text style={{ fontFamily: f.uiBold, fontSize: size * 0.38, color: c.fg }}>{/^[+\d]/.test(label) ? '#' : label.slice(0, 1).toUpperCase()}</Text>
  </View>
);

/** Feature bullet on onboarding screens. */
export const Feature = ({ icon, text }: { icon: ReactNode; text: string }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18 }}>
    <View style={s.featIcon}>{icon}</View>
    <T v="body" style={{ fontSize: 17 }}>{text}</T>
  </View>
);

/** Onboarding progress: O2, O3, then N or E. */
export const Steps = ({ at, of = 4 }: { at: number; of?: number }) => (
  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, marginBottom: 28 }}>
    {Array.from({ length: of }, (_, i) => (
      <View key={i} style={{ flex: 1, height: 4, borderRadius: 4, backgroundColor: i <= at ? c.accent : c.surface2 }} />
    ))}
  </View>
);

export const Spinner = () => <ActivityIndicator color={c.accent} />;

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  body: { paddingHorizontal: 20, paddingTop: 8 },
  btn: { height: 60, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, alignSelf: 'stretch' },
  iconBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 64 },
  field: { height: 64, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignSelf: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: { borderRadius: 24, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, paddingVertical: 6, paddingHorizontal: 20 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 60, gap: 16, borderBottomWidth: 1, borderBottomColor: c.line },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line },
  avatar: { borderRadius: 999, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  featIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
});

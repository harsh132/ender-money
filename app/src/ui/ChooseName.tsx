import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, View } from 'react-native';
import { MAX_LABEL, validateLabel } from '../../../protocol/names';
import { api } from '../lib/api';
import { cleanLabel, nameStatus, type Checked } from '../lib/names';
import { c, f } from '../lib/theme';
import { BackHeader, Banner, Button, Field, Screen, Steps, T } from './kit';

/**
 * Choose your Ender ID: the account's one change of its random ID (name.tsx). Checks availability while typing; the
 * gateway has the last word on submit.
 */
export const ChooseName = ({
  onSubmit,
  busy,
  error,
  step,
  back,
}: {
  onSubmit: (label: string) => void;
  busy?: boolean;
  error?: string;
  /** Onboarding progress, in signup. */
  step?: number;
  back?: boolean;
}) => {
  const [label, setLabel] = useState('');
  const [checked, setChecked] = useState<Checked>();
  const status = nameStatus(label, checked);

  useEffect(() => {
    if (validateLabel(label)) return;
    let live = true;
    const t = setTimeout(
      () =>
        api.checkName(label).then(
          (r) => live && setChecked({ label, ...r }),
          () => live && setChecked({ label, failed: true }),
        ),
      350,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [label]);

  const submit = () => status.ok && !busy && onSubmit(label);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior="padding">
      <Screen>
        {back ? <BackHeader /> : <View style={{ height: 64 }} />}
        {step !== undefined ? <Steps at={step} /> : null}
        <T v="headline" style={{ fontSize: 36 }}>Choose your Ender ID</T>
        <T v="meta" style={{ fontSize: 18, lineHeight: 27, marginTop: 12 }}>
          A name anyone can pay, from Ender or any wallet.
        </T>
        <View style={{ marginTop: 28 }}>
          <Field
            big
            autoFocus
            value={label}
            onChangeText={(t) => setLabel(cleanLabel(t))}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            maxLength={MAX_LABEL}
            placeholder="yourname"
            accessibilityLabel="Ender ID"
            onSubmitEditing={submit}
            right={<T style={{ fontFamily: f.uiMedium, fontSize: 18, color: c.fg3 }}>.ender.my</T>}
          />
        </View>
        <T
          v="meta"
          accessibilityLiveRegion="polite"
          style={{ fontSize: 15, marginTop: 12, minHeight: 22, color: status.tone === 'negative' ? c.negative : status.tone === 'positive' ? c.positive : c.fg3 }}
        >
          {status.text}
        </T>
        {error ? <View style={{ marginTop: 20 }}><Banner tone="negative">{error}</Banner></View> : null}
        <View style={{ flex: 1, minHeight: 24 }} />
        <Button title="Continue" onPress={submit} busy={busy} disabled={!status.ok} style={{ marginBottom: 12 }} />
      </Screen>
    </KeyboardAvoidingView>
  );
};

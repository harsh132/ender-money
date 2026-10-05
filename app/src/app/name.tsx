import { router } from 'expo-router';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { setState } from '../lib/store';
import { errorText, sync } from '../lib/wallet';
import { ChooseName } from '../ui/ChooseName';

/** An account made before Ender IDs picks one, once (Home opens this on launch while it has none). */
export default function NameScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (label: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.claimName(label);
      setState((s) => (s.wallet ? { wallet: { ...s.wallet, enderId: r.name } } : {}));
      router.back();
    } catch (e) {
      // Set from another phone meanwhile: the next sync brings it.
      if (e instanceof ApiError && e.code === 'name-already-set') {
        void sync();
        return router.back();
      }
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return <ChooseName back busy={busy} error={error} onSubmit={submit} />;
}

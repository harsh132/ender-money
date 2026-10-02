import { useFocusEffect } from 'expo-router';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { quickSend } from '../lib/keys';

/** Minutes left on the open Quick send session, or null. */
export const useQuickSend = () => {
  const q = useSyncExternalStore(quickSend.subscribe, quickSend.get);
  const [, tick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      const t = setInterval(() => tick((n) => n + 1), 15_000);
      return () => clearInterval(t);
    }, []),
  );
  return q ? Math.max(1, Math.ceil(quickSend.msLeft() / 60_000)) : null;
};


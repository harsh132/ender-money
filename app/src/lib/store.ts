/**
 * App state: one object, persisted to AsyncStorage (the JWT goes to
 * SecureStore). Nothing secret lives here: the wallet key is re-derived from
 * the passkey whenever it is needed.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { Address } from 'viem';
import type { NetworkName } from '../../../protocol/networks';
import { DEFAULT_INR_PER_USD, DEFAULT_NETWORK } from './config';
import type { Awaiting, CachedNote } from './private';

export type TxStatus = 'sending' | 'sent' | 'failed' | 'expired';

export type Tx = {
  /** Gateway session id for our own transfers, tx hash + log index for incoming ones. */
  id: string;
  network: NetworkName;
  direction: 'in' | 'out';
  amount: string;
  fee?: string;
  /** Unknown for a private payment to a number. */
  counterparty?: Address;
  /** The number paid, for a private payment (to retry it). */
  phone?: string;
  /** The private address (ender1…) or Ender ID (label.ender.my) paid, for a payment to one (to retry it). */
  to?: string;
  /** Through the private balance (shielded pool). */
  private?: true;
  /** Moved from the public to the private balance. */
  shield?: true;
  /** Between our own balances (a merge, a withdrawal to our own wallet, the pool side of a shield): kept to settle, never listed. */
  internal?: true;
  /** Contact name, Ender ID, ENS name or phone number, when we know one. */
  label?: string;
  status: TxStatus;
  txHash?: string;
  /** The short hash a text gave (`0xab12...ef`), until the full one is known. */
  shortTx?: string;
  /** Private, from a text: tree position of the transaction's first output; a resync's notes there give the full hash. */
  pos?: number;
  error?: string;
  at: number;
  deadline?: number;
};

/** Activity lists only payments to and from others: shields and other moves between our own balances stay hidden. */
export const listed = (t: Tx) => !t.shield && !t.internal;

/** address: a 0x address (lowercase), or a private address (ender1…) paid directly. name: a contact name; enderId: label.ender.my. */
export type Recipient = { address: string; phone?: string; name?: string; enderId?: string; lastUsed: number };

export type Wallet = {
  phone: string;
  address: Address;
  /** Our Ender ID (label.ender.my). null: the gateway says the account has none yet (the app asks); undefined: unknown. */
  enderId?: string | null;
  credentialId: string;
  transports?: string[];
};

export type AccountSnapshot = { balance: string; nonce: string; delegated: boolean; syncedAt: number };

export type State = {
  hydrated: boolean;
  wallet?: Wallet;
  token?: string;
  network: NetworkName;
  account: Partial<Record<NetworkName, AccountSnapshot>>;
  inr: number;
  activity: Tx[];
  recents: Recipient[];
  /** phone or Ender ID -> address seen on the first transfer; a different answer later is flagged. */
  pins: Record<string, Address>;
  alerts: boolean;
  gateway: 'auto' | 'india' | 'international';
  /**
   * Private balance. Only public values: the packed shielded address (base64)
   * and the networks it is registered on. The keys come from the passkey.
   */
  shielded?: { owner: string; registered: NetworkName[] };
  notes: Partial<Record<NetworkName, CachedNote[]>>;
  awaiting: Partial<Record<NetworkName, Awaiting[]>>;
  /** phone or Ender ID -> shielded address (base64) seen on the first private payment; a different one later is refused. */
  shieldedPins: Record<string, string>;
  /** Settings' Auto-merge (networks with a pool): fold the 12 largest private notes while unlocked and online. Off by default. */
  autoMerge?: boolean;
  /** Settings' Auto Shield (networks with a pool): move the public balance into the private one while unlocked and online. On unless false (autoShieldOn). */
  autoShield?: boolean;
};

const initial: State = {
  hydrated: false,
  network: DEFAULT_NETWORK,
  account: {},
  inr: DEFAULT_INR_PER_USD,
  activity: [],
  recents: [],
  pins: {},
  alerts: true,
  gateway: 'auto',
  notes: {},
  awaiting: {},
  shieldedPins: {},
};

const STATE_KEY = 'ender:state:v1';
const TOKEN_KEY = 'ender.token';

/** SecureStore on the phone; the web preview has none, so it falls back to plain storage there. */
const tokenStore =
  Platform.OS === 'web'
    ? { get: () => AsyncStorage.getItem(TOKEN_KEY), set: (t: string) => AsyncStorage.setItem(TOKEN_KEY, t), del: () => AsyncStorage.removeItem(TOKEN_KEY) }
    : { get: () => SecureStore.getItemAsync(TOKEN_KEY), set: (t: string) => SecureStore.setItemAsync(TOKEN_KEY, t), del: () => SecureStore.deleteItemAsync(TOKEN_KEY) };

let state = initial;
const listeners = new Set<() => void>();

export const getState = () => state;

export const setState = (patch: Partial<State> | ((s: State) => Partial<State>)) => {
  const next = typeof patch === 'function' ? patch(state) : patch;
  const tokenChanged = 'token' in next && next.token !== state.token;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
  if (!state.hydrated) return;
  const { hydrated: _h, token, ...persisted } = state;
  void AsyncStorage.setItem(STATE_KEY, JSON.stringify(persisted));
  if (tokenChanged) void (token ? tokenStore.set(token) : tokenStore.del());
};

export const useStore = <T,>(select: (s: State) => T): T =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );

export const hydrate = async () => {
  try {
    const [raw, token] = await Promise.all([AsyncStorage.getItem(STATE_KEY), tokenStore.get()]);
    let saved = raw ? (JSON.parse(raw) as Partial<State>) : {};
    let seededToken: string | undefined;
    // Dev builds only (dropped from release bundles): start logged in as a test wallet, for emulators
    // without a passkey. Public data and a local-gateway token only; never a key.
    if (__DEV__ && !saved.wallet && process.env.EXPO_PUBLIC_DEV_SEED) {
      const seed = JSON.parse(process.env.EXPO_PUBLIC_DEV_SEED) as Partial<State>;
      seededToken = seed.token;
      saved = { ...saved, ...seed };
    }
    state = { ...initial, ...saved, token: token ?? seededToken, hydrated: true };
  } catch {
    state = { ...initial, hydrated: true };
  }
  listeners.forEach((l) => l());
};

/** Fresh device semantics: forget everything local. The wallet comes back from the passkey. */
export const signOut = async () => {
  await Promise.all([AsyncStorage.removeItem(STATE_KEY), tokenStore.del()]);
  state = { ...initial, hydrated: true };
  listeners.forEach((l) => l());
};

// ---------------------------------------------------------------- helpers

export const upsertTx = (tx: Partial<Tx> & Pick<Tx, 'id'>) =>
  setState((s) => {
    const i = s.activity.findIndex((t) => t.id === tx.id);
    if (i < 0) return { activity: [tx as Tx, ...s.activity].slice(0, 200) };
    const activity = [...s.activity];
    activity[i] = { ...activity[i]!, ...tx };
    return { activity };
  });

export const rememberRecipient = (r: Omit<Recipient, 'lastUsed'>) =>
  setState((s) => {
    const address = r.address.toLowerCase();
    const prev = s.recents.find((x) => x.address === address);
    const merged: Recipient = { ...prev, ...r, address, lastUsed: Date.now() };
    const key = r.phone ?? r.enderId;
    return {
      recents: [merged, ...s.recents.filter((x) => x.address !== address)].slice(0, 20),
      pins: key && !s.pins[key] ? { ...s.pins, [key]: address as Address } : s.pins,
    };
  });

export const labelFor = (address: string, s: State = state) => {
  const r = s.recents.find((x) => x.address === address.toLowerCase());
  return r?.name ?? r?.enderId ?? r?.phone;
};

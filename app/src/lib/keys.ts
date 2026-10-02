/**
 * The wallet key: a passkey's PRF output, turned into a secp256k1 key the
 * way Mera's "create passkey accounts" recipe does (PRF -> BIP-39 entropy ->
 * seed -> m/44'/60'/0'/0/0). Nothing is stored; every signature starts from a
 * passkey prompt, or from an open Quick send session.
 */
import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getEvmAddress,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
} from '@category-labs/mera';
import { reactNativeWebAuthnClient } from '@category-labs/mera/react-native-webauthn-client';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { AppState } from 'react-native';
import type { Address, LocalAccount } from 'viem';
import { QUICK_SEND, RP_ID } from './config';

const ETH_PATH = "m/44'/60'/0'/0/0";

const sessionFromPrf = (prfOutput: Uint8Array): Secp256k1SigningSession => {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(ETH_PATH);
  try {
    // The session keeps its own copy; wipe ours.
    return createSecp256k1SigningSession({ privateKey: node.privateKey! });
  } finally {
    node.wipePrivateData();
    seed.fill(0);
    prfOutput.fill(0);
  }
};

export type Unlocked = {
  credential: PasskeyCredentialMetadata;
  address: Address;
  account: LocalAccount;
  session: Secp256k1SigningSession;
};

const unlocked = (credential: PasskeyCredentialMetadata, session: Secp256k1SigningSession): Unlocked => ({
  credential,
  address: getEvmAddress(session.publicKey),
  account: toViemAccount(session),
  session,
});

/** N1: a new passkey named "Ender" for ender.money. One prompt (two on authenticators without create-time PRF). */
export const createWalletKey = async (): Promise<Unlocked> => {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: RP_ID, name: 'Ender' },
    user: { name: 'Ender', displayName: 'Ender' },
    webAuthnClient: reactNativeWebAuthnClient,
  });
  return unlocked({ credentialId: created.credentialId, transports: created.transports }, sessionFromPrf(created.prfOutput));
};

/** One passkey prompt. Without `credential` the system picker lists every Ender passkey. */
export const unlockWallet = async (credential?: PasskeyCredentialMetadata): Promise<Unlocked> => {
  const got = await getPasskeyPrfOutput({ rpId: RP_ID, credential, webAuthnClient: reactNativeWebAuthnClient });
  return unlocked({ credentialId: got.credentialId, transports: credential?.transports }, sessionFromPrf(got.prfOutput));
};

/** Readable message for a passkey failure, or undefined when the user just cancelled. */
export const passkeyError = (e: unknown): string | undefined => {
  if (isMeraError(e)) {
    if (e.code === 'PRF_UNAVAILABLE') return "This phone's passkey provider can't make wallet keys. Use Google Password Manager.";
    const cause = String((e as { cause?: { error?: string; message?: string } }).cause?.error ?? (e.cause as Error | undefined)?.message ?? '');
    if (/cancel|UserCancelled|NotAllowed/i.test(cause)) return undefined;
    if (/NoCredentials|No credentials/i.test(cause)) return 'No Ender passkey on this phone. Check the Google account it was saved to.';
    return `Passkey failed. ${cause}`.trim();
  }
  return e instanceof Error ? e.message : String(e);
};

// ---------------------------------------------------------------- Quick send

type Quick = { unlocked: Unlocked; openedAt: number; spent: number };
let quick: Quick | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
let timer: ReturnType<typeof setTimeout> | undefined;

export const quickSend = {
  get: () => quick,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  msLeft: () => (quick ? quick.openedAt + QUICK_SEND.minutes * 60_000 - Date.now() : 0),

  /** Whether a transfer can be signed without a prompt. */
  covers: (amountUsd: number, toIsRecent: boolean) =>
    !!quick &&
    quickSend.msLeft() > 0 &&
    toIsRecent &&
    amountUsd <= QUICK_SEND.perTx &&
    quick.spent + amountUsd <= QUICK_SEND.total,

  /** Keep a freshly prompted key as the session, counting the transfer it just signed. */
  open: (u: Unlocked, spentUsd: number) => {
    quickSend.end();
    if (spentUsd > QUICK_SEND.total) return u.session.end();
    quick = { unlocked: u, openedAt: Date.now(), spent: spentUsd };
    timer = setTimeout(quickSend.end, QUICK_SEND.minutes * 60_000);
    notify();
  },

  spend: (amountUsd: number) => {
    if (!quick) return;
    quick.spent += amountUsd;
    if (quick.spent >= QUICK_SEND.total) quickSend.end();
    else notify();
  },

  /** Zeroes the key. Silent: the next transfer just asks for the passkey again. */
  end: () => {
    clearTimeout(timer);
    if (!quick) return;
    quick.unlocked.session.end();
    quick = null;
    notify();
  },
};

/**
 * Leaving the app ends the session, except for system screens Ender opened
 * itself (SMS composer, contact picker), which also background the app.
 */
let ownScreens = 0;
export const whileOwnScreen = async <T,>(open: () => Promise<T>): Promise<T> => {
  ownScreens++;
  try {
    return await open();
  } finally {
    // The 'active' event lands just after the screen closes.
    setTimeout(() => ownScreens--, 1000);
  }
};

AppState.addEventListener('change', (s) => {
  if (s === 'background' && ownScreens === 0) quickSend.end();
});

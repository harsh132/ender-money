/** HTTPS client for the gateway. Times out fast so a dead connection falls back to SMS. */
import type { Address, Hex } from 'viem';
import type { NetworkName } from '../../../protocol/networks';
import type { BridgePrepared, BridgeSubmit } from './bridge';
import { GATEWAY_URL, HTTP_TIMEOUT_MS } from './config';
import { getState } from './store';

/** The gateway answered with an error code (see gateway/src). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

/** No answer at all: offline, DNS, timeout. The caller may retry by SMS. */
export class OfflineError extends Error {
  constructor() {
    super('offline');
  }
}

/** We gave up waiting (the request may still land): an OfflineError to callers, but told apart in the message. */
export class TimeoutError extends OfflineError {}

/** What a 401 on our own token does (lib/auth.ts): sign in again when it can (true), else drop the token. */
let reauth: (() => Promise<boolean>) | undefined;
export const onUnauthorized = (f: () => Promise<boolean>) => {
  reauth = f;
};

const request = async <T,>(method: 'GET' | 'POST', path: string, body?: unknown, token = getState().token, timeoutMs = HTTP_TIMEOUT_MS, retried = false): Promise<T> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw ctrl.signal.aborted ? new TimeoutError() : new OfflineError();
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  // Expired, or a phone-number token from before sign-in by signature: once more with a fresh one, if one can be had.
  if (res.status === 401 && token && token === getState().token && !retried && reauth && (await reauth()))
    return request<T>(method, path, body, getState().token, timeoutMs, true);
  if (!res.ok) throw new ApiError(json.error ?? `http-${res.status}`, res.status);
  return json;
};

export type AccountInfo = {
  address: Address;
  /** The Ender ID (`label.ender.my`); null only for an account made before names that hasn't signed in since. */
  name?: string | null;
  /** The account's verified number: SMS features only with one. */
  phone?: string | null;
  network: NetworkName;
  balance: string;
  nonce: string;
  delegated: boolean;
  inr?: number;
};

export type QuoteInfo = {
  id: string;
  network: NetworkName;
  to: Address;
  amount: string;
  fee: string;
  /** CTK the recipient gets, for CTK delivery. */
  out?: string;
  nonce: string;
  deadline: number;
};

export type SignInfo = { id: string; txHash: Hex; amount: string; to: Address; pending?: true };

export type TxInfo = {
  id: string;
  network: NetworkName;
  status: 'open' | 'sending' | 'sent' | 'failed' | 'expired';
  txHash: Hex | null;
  error: string | null;
};

export type ActivityItem = {
  txHash: Hex;
  logIndex: number;
  direction: 'in' | 'out';
  counterparty: Address;
  amount: string;
  at: number;
};

/** `private`: their ender1… address, when they take private payments. */
export type NameInfo = { name: string | null; address: Address; private?: string };

export type AuthorizationJson = { address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };

/** Shielded-pool quote (see /shielded/quote): to is a base64 shielded address (pay) or 0x (withdraw). */
export type ShieldedQuoteInfo = { id: string; exp: number; fee: string; to?: string };
export type ShieldedKind = 'pay' | 'withdraw' | 'shield' | 'merge';

export const api = {
  // Sign-in by wallet signature (lib/auth.ts); the first one creates the account and its random Ender ID.
  challenge: (address: Address) => request<{ nonce: string; expires: number }>('POST', '/auth/challenge', { address }, ''),
  verifyAuth: (body: { address: Address; signature: Hex; turnstile?: string }) =>
    request<{ token: string; address: Address; name: string; created: boolean }>('POST', '/auth/verify', body, '', 15_000),
  /** The signed-in wallet's 7702 delegation on each network; idempotent. */
  createWallet: (body: { authorizations: Partial<Record<NetworkName, AuthorizationJson>> }) =>
    request<{ address: Address }>('POST', '/wallet/create', body, undefined, 30_000),
  account: (network: NetworkName) => request<AccountInfo>('GET', `/account?network=${network}`),
  // The phone number: a code by text to add it (or move it from another account), and remove.
  phoneStart: (phone: string) => request<{ sent: true; queued: boolean; expiresIn: number; devCode?: string }>('POST', '/account/phone/start', { phone }),
  phoneVerify: (phone: string, code: string) => request<{ phone: string; moved: boolean }>('POST', '/account/phone/verify', { phone, code }),
  phoneRemove: () => request<{ phone: null }>('POST', '/account/phone/remove', {}),
  quote: (body: { network: NetworkName; to: string; amount: string; deliver?: 'AUSD' | 'CTK' }) => request<QuoteInfo>('POST', '/tx/quote', body),
  sign: (id: string, signature: Hex) => request<SignInfo>('POST', '/tx/sign', { id, signature }),
  tx: (id: string) => request<TxInfo>('GET', `/tx/${id}`),
  setAlerts: (on: boolean) => request<{ alerts: boolean }>('POST', '/account/alerts', { on }),
  // Ender IDs. Lookups never return a phone number.
  checkName: (label: string) => request<{ available: boolean; reason?: string }>('GET', `/names/check?label=${encodeURIComponent(label)}`, undefined, ''),
  name: (label: string) => request<NameInfo>('GET', `/names/${encodeURIComponent(label)}`, undefined, ''),
  nameByPhone: (phone: string) => request<NameInfo>('GET', `/names/by-phone?phone=${encodeURIComponent(phone)}`),
  /** The one change of Ender ID: whether it's used, whether our number can unlock it, and the fee (mainnet) otherwise. */
  nameStatus: () => request<{ name: string | null; locked: boolean; phone: boolean; fee: string; treasury: Address }>('GET', '/account/name'),
  /** By our number, or with the hash of the fee's payment. */
  changeName: (name: string, txHash?: Hex) => request<{ name: string }>('POST', '/account/name', { name, ...(txHash ? { txHash } : {}) }),
  activity: (network: NetworkName) => request<{ items: ActivityItem[] }>('GET', `/activity?network=${network}`),

  // Private balance (shielded pool). Bigints travel as decimal strings.
  shieldedRegister: (network: NetworkName, keys: { Ax: string; Ay: string; nk: string; viewSk: string }) =>
    request<{ owner: string }>('POST', '/shielded/register', { network, keys }),
  shieldedNotes: (network: NetworkName) =>
    // tx: the note's transaction (full hash); absent from older gateways and for notes indexed before it.
    request<{ notes: { pos: number; amount: string; blinding: string; spent: boolean; tx?: string }[]; root: string }>('GET', `/shielded/notes?network=${network}`),
  shieldedQuote: (body: { network: NetworkName; kind: ShieldedKind; to?: string; amount?: string }) => request<ShieldedQuoteInfo>('POST', '/shielded/quote', body, undefined, 15_000),
  shieldedSubmit: (body: { id: string; refs?: number[]; sig?: string; signature?: Hex }) => // The gateway proves (1-4 s) and waits for the receipt before answering.
    request<{ tx: Hex; p?: number; pending?: true }>('POST', '/shielded/submit', body, undefined, 60_000),
  shieldedAddress: (network: NetworkName, phone: string) =>
    request<{ owner: string }>('GET', `/shielded/address?network=${network}&phone=${encodeURIComponent(phone)}`),

  // Auto-bridge (lib/bridge.ts): balances on Ethereum, Base, Arbitrum and Polygon into AUSD on Monad mainnet.
  bridgePending: () => request<{ items: { chainId: number; token: Address }[] }>('GET', '/bridge/pending'),
  // The gateway quotes Relay and simulates the batch to price its fee.
  bridgePrepare: (body: { chainId: number; token: Address }) => request<BridgePrepared>('POST', '/bridge/prepare', body, undefined, 20_000),
  // Simulated, sent, and its receipt waited for before the answer.
  bridgeSubmit: (body: BridgeSubmit) => request<{ txHash: Hex; pending?: true }>('POST', '/bridge/submit', body, undefined, 60_000),
};

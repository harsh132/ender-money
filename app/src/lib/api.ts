/** HTTPS client for the gateway. Times out fast so a dead connection falls back to SMS. */
import type { Address, Hex } from 'viem';
import type { NetworkName } from '../../../protocol/networks';
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

const request = async <T,>(method: 'GET' | 'POST', path: string, body?: unknown, token = getState().token, timeoutMs = HTTP_TIMEOUT_MS): Promise<T> => {
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
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(json.error ?? `http-${res.status}`, res.status);
  return json;
};

export type AccountInfo = {
  address: Address;
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

export type AuthorizationJson = { address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };

/** Shielded-pool quote (see /shielded/quote): to is a base64 shielded address (pay) or 0x (withdraw). */
export type ShieldedQuoteInfo = { id: string; exp: number; fee: string; to?: string };
export type ShieldedKind = 'pay' | 'withdraw' | 'shield' | 'merge';

export const api = {
  startAuth: (phone: string) => request<{ sent: true; queued: boolean; expiresIn: number; devCode?: string }>('POST', '/auth/start', { phone }, ''),
  verifyAuth: (phone: string, code: string) =>
    request<
      | { token: string; status: 'new' }
      | { token: string; status: 'existing'; address: Address; network: NetworkName; balance: string }
    >('POST', '/auth/verify', { phone, code }, ''),
  createWallet: (token: string, body: { address: Address; authorizations: Partial<Record<NetworkName, AuthorizationJson>>; relink?: boolean }) =>
    request<{ token: string; address: Address }>('POST', '/wallet/create', body, token),
  account: (network: NetworkName) => request<AccountInfo>('GET', `/account?network=${network}`),
  quote: (body: { network: NetworkName; to: string; amount: string; deliver?: 'AUSD' | 'CTK' }) => request<QuoteInfo>('POST', '/tx/quote', body),
  sign: (id: string, signature: Hex) => request<SignInfo>('POST', '/tx/sign', { id, signature }),
  tx: (id: string) => request<TxInfo>('GET', `/tx/${id}`),
  setAlerts: (on: boolean) => request<{ alerts: boolean }>('POST', '/account/alerts', { on }),
  activity: (network: NetworkName) => request<{ items: ActivityItem[] }>('GET', `/activity?network=${network}`),

  // Private balance (shielded pool). Bigints travel as decimal strings.
  shieldedRegister: (network: NetworkName, keys: { Ax: string; Ay: string; nk: string; viewSk: string }) =>
    request<{ owner: string }>('POST', '/shielded/register', { network, keys }),
  shieldedNotes: (network: NetworkName) =>
    request<{ notes: { pos: number; amount: string; blinding: string; spent: boolean }[]; root: string }>('GET', `/shielded/notes?network=${network}`),
  shieldedQuote: (body: { network: NetworkName; kind: ShieldedKind; to?: string; amount?: string }) => request<ShieldedQuoteInfo>('POST', '/shielded/quote', body, undefined, 15_000),
  shieldedSubmit: (body: { id: string; refs?: number[]; sig?: string; signature?: Hex }) => // The gateway proves (1-4 s) and waits for the receipt before answering.
    request<{ tx: Hex; p?: number; pending?: true }>('POST', '/shielded/submit', body, undefined, 60_000),
  shieldedAddress: (network: NetworkName, phone: string) =>
    request<{ owner: string }>('GET', `/shielded/address?network=${network}&phone=${encodeURIComponent(phone)}`),
};

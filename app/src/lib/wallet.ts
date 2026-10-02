/** Account sync, signup and the pieces of a transfer, shared by the screens. */
import { createPublicClient, http, parseUnits, type Address, type Hex, type LocalAccount } from 'viem';
import { signedBatchTypedData, swapWithFee, transferWithFee } from '../../../protocol/calibur';
import { AUSD_DECIMALS, CALIBUR, CTK_DECIMALS, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../../protocol/networks';
import type { Deliver, Reply } from '../../../protocol/sms';
import { api, ApiError, OfflineError, type ActivityItem, type AuthorizationJson } from './api';
import { MAX_FEE } from './config';
import type { Unlocked } from './keys';
import { getState, labelFor, setState, upsertTx, type TxStatus } from './store';
import { textGateway, type Pipe } from './transport';

// ---------------------------------------------------------------- sync

/** Online refresh of balance and nonce. Returns false when offline (the caller can offer SYNC by text). */
export const sync = async (network = getState().network): Promise<boolean> => {
  try {
    const a = await api.account(network);
    setState((s) => ({
      account: { ...s.account, [network]: { balance: a.balance, nonce: a.nonce, delegated: a.delegated, syncedAt: Date.now() } },
      ...(a.inr ? { inr: a.inr } : {}),
    }));
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setState({ token: undefined });
    if (e instanceof OfflineError || e instanceof ApiError) return false;
    throw e;
  }
};

/** Pull to refresh: balance, then the status of transfers still sending, then incoming payments. */
export const refresh = async () => {
  if (!(await sync())) return false;
  await Promise.all([refreshPending(), pullActivity()]);
  return true;
};

const STATUS: Record<string, TxStatus> = { sent: 'sent', failed: 'failed', expired: 'expired', open: 'sending', sending: 'sending' };

export const refreshPending = async () => {
  const pending = getState().activity.filter((t) => t.direction === 'out' && t.status === 'sending');
  await Promise.all(
    pending.map(async (t) => {
      try {
        const r = await api.tx(t.id);
        // An open session whose signature never reached the gateway expires with its deadline.
        const status = r.status === 'open' && t.deadline && t.deadline * 1000 < Date.now() ? 'expired' : STATUS[r.status] ?? 'sending';
        upsertTx({ id: t.id, status, txHash: r.txHash ?? t.txHash, error: r.error ?? undefined });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && t.deadline && t.deadline * 1000 < Date.now()) upsertTx({ id: t.id, status: 'expired' });
      }
    }),
  );
};

/**
 * Transfers from the gateway's view of AUSD Transfer logs. Incoming ones are
 * new to the app; outgoing ones restore history on a fresh device, or settle a
 * transfer sent by text whose hash the app never saw.
 */
const pullActivity = async () => {
  const { network } = getState();
  let items: ActivityItem[];
  try {
    ({ items } = await api.activity(network));
  } catch {
    return; // Older gateways have no /activity; outgoing history is local anyway.
  }
  for (const it of items) {
    const local = getState().activity;
    if (local.some((t) => t.txHash?.toLowerCase() === it.txHash.toLowerCase() && t.counterparty === it.counterparty)) continue;
    const unsettled = it.direction === 'out' && local.find((t) => t.direction === 'out' && !t.txHash && t.counterparty === it.counterparty && Number(t.amount) === Number(it.amount));
    if (unsettled) {
      upsertTx({ id: unsettled.id, txHash: it.txHash, status: 'sent' });
      continue;
    }
    upsertTx({
      id: `${it.txHash}:${it.logIndex}`,
      network,
      direction: it.direction,
      amount: it.amount,
      counterparty: it.counterparty,
      label: labelFor(it.counterparty),
      status: 'sent',
      txHash: it.txHash,
      at: it.at * 1000,
    });
  }
};

export const syncByText = () => textGateway({ kind: 'sync', network: getState().network });

/** An `OK …` reply, from SYNC by text, describes the current network. */
export const applyOkReply = (r: Extract<Reply, { kind: 'ok' }>) =>
  setState((s) => ({
    account: {
      ...s.account,
      [s.network]: { balance: r.balance, nonce: r.nonce.toString(), delegated: r.delegated, syncedAt: Date.now() },
    },
    ...(r.inr && Number(r.inr) > 0 ? { inr: Number(r.inr) } : {}),
  }));

// ---------------------------------------------------------------- signup

/**
 * N2: sign a 7702 authorization to Calibur on each network (no extra prompt:
 * the key is already unlocked) and hand them to /wallet/create, which sends
 * the sponsored delegations and links the number.
 */
export const createWallet = async (u: Unlocked, token: string, relink = false) => {
  const authorizations: Partial<Record<NetworkName, AuthorizationJson>> = {};
  for (const name of Object.keys(NETWORKS) as NetworkName[]) {
    const { chain } = NETWORKS[name];
    const nonce = await createPublicClient({ chain, transport: http() }).getTransactionCount({ address: u.address });
    const a = await u.account.signAuthorization!({ contractAddress: CALIBUR, chainId: chain.id, nonce });
    authorizations[name] = { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity! };
  }
  return api.createWallet(token, { address: u.address, authorizations, relink });
};

// ---------------------------------------------------------------- transfer

export type Draft = {
  network: NetworkName;
  /** What the user typed or picked: an address or an E.164 number. */
  to: string;
  /** Known up front for address recipients; for numbers the quote supplies it. */
  toAddress?: Address;
  phone?: string;
  label?: string;
  amount: string;
  /** What the recipient gets: AUSD, or CTK through Agora's pair (Test mode only). */
  deliver: Deliver;
};

/** `out`: CTK the recipient gets at least, for CTK delivery. */
export type Quote = { id: string; to: Address; fee: string; nonce: bigint; deadline: number; pipe: Pipe; out?: string };

export class TransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Never sign what the gateway made up: the recipient, fee and deadline must be what the user saw. */
export const checkQuote = (draft: Draft, q: Quote): { pinChanged: boolean } => {
  if (draft.toAddress && q.to.toLowerCase() !== draft.toAddress.toLowerCase())
    throw new TransferError('recipient-mismatch', 'The gateway quoted a different recipient. Nothing was sent.');
  if (parseUnits(q.fee, AUSD_DECIMALS) > parseUnits(MAX_FEE, AUSD_DECIMALS))
    throw new TransferError('fee-too-high', `The fee came back as $${q.fee}. Nothing was sent.`);
  if (q.deadline * 1000 < Date.now()) throw new TransferError('expired', 'That quote has expired. Try again.');
  if (draft.deliver === 'CTK' && !(q.out && Number(q.out) > 0))
    throw new TransferError('no-out', 'The quote came back without a CTK amount. Nothing was sent.');
  const pinned = draft.phone ? getState().pins[draft.phone] : undefined;
  return { pinChanged: !!pinned && pinned !== q.to.toLowerCase() };
};

/** The app builds the batch itself from the readable fields and signs that, never the gateway's calldata. */
export const signQuote = (account: LocalAccount, draft: Draft, q: Quote): Promise<Hex> => {
  const net = NETWORKS[draft.network];
  const amount = parseUnits(draft.amount, AUSD_DECIMALS);
  const fee = parseUnits(q.fee, AUSD_DECIMALS);
  // CTK: swap on the pair straight to the recipient, with the quoted output as the minimum.
  const calls =
    draft.deliver === 'CTK'
      ? swapWithFee(net.ausd, net.pair!, net.ctk!, q.to, amount, parseUnits(q.out!, CTK_DECIMALS), BigInt(q.deadline), FEE_RECIPIENT, fee)
      : transferWithFee(net.ausd, q.to, amount, FEE_RECIPIENT, fee);
  return account.signTypedData!(signedBatchTypedData(account.address, net.chain.id, calls, q.nonce, BigInt(q.deadline)));
};

const ERRORS: Record<string, string> = {
  'not-on-ender': "This number isn't on Ender yet. Invite them, then pay once they've signed up.",
  'low-balance': "Not enough balance for this amount plus the fee.",
  'self-transfer': "That's your own wallet.",
  'bad-recipient': "That isn't a phone number or wallet address.",
  'bad-amount': 'Check the amount.',
  'not-delegated': 'Your wallet is still being set up on this network. Try again in a minute.',
  'not-registered': 'This number has no wallet. Log in again.',
  'rate-limited': 'Too many tries. Wait a minute.',
  expired: 'That quote has expired. Try again.',
  'bad-sig': "The signature didn't match. Nothing was sent.",
  'swap-unavailable': 'Local-currency delivery is unavailable right now. Send AUSD instead.',
  reverted: 'The transfer would fail on-chain. Nothing was sent.',
  failed: 'The transfer failed on-chain. Your money did not move.',
  'send-failed': "The gateway couldn't send it. Try again.",
  'in-progress': 'Already sending.',
  unsupported: 'Not supported yet.',
  unauthorized: 'Your login expired. Log in again.',
  'sms-unavailable': "Ender can't text this country yet.",
  'number-linked': 'This number already has a wallet.',
  'address-linked': 'This passkey already belongs to another number.',
  'bad-code': "That code isn't right.",
  'code-expired': 'That code has expired. Send a new one.',
  'bad-phone': 'Check the number.',
};

export const errorText = (e: unknown): string => {
  if (e instanceof ApiError) return ERRORS[e.code] ?? `Gateway said: ${e.code}`;
  if (e instanceof OfflineError) return 'No internet.';
  if (typeof e === 'string') return ERRORS[e] ?? `Gateway said: ${e}`;
  return e instanceof Error ? e.message : String(e);
};

/** Account sync, signup and the pieces of a transfer, shared by the screens. */
import { bytesToBigInt, createPublicClient, http, parseUnits, type Address, type Hex, type LocalAccount } from 'viem';
import { signedBatchTypedData, swapWithFee, transferWithFee } from '../../../protocol/calibur';
import { AUSD_DECIMALS, CALIBUR, CTK_DECIMALS, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../../protocol/networks';
import { owner, packAddress, provingKeys, type User } from '../../../protocol/shielded';
import { b64, type Deliver, type Reply } from '../../../protocol/sms';
import { api, ApiError, OfflineError, type ActivityItem, type AuthorizationJson } from './api';
import { MAX_FEE } from './config';
import { phoneDisplay } from './format';
import type { Unlocked } from './keys';
import { applyReply, chooseRoute, hasPool, POOL_NETWORKS, resync, settleAwaiting, type Awaiting, type Cache } from './private';
import { getState, labelFor, setState, upsertTx, type State, type TxStatus } from './store';
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
  await Promise.all([refreshPending(), pullActivity(), pullNotes()]);
  return true;
};

const STATUS: Record<string, TxStatus> = { sent: 'sent', failed: 'failed', expired: 'expired', open: 'sending', sending: 'sending' };

export const refreshPending = async () => {
  // Private payments settle through the note cache (pullNotes, Sent / Shielded texts), not /tx.
  const pending = getState().activity.filter((t) => t.direction === 'out' && t.status === 'sending' && !t.private);
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
  const pool = NETWORKS[network].pool?.toLowerCase();
  let items: ActivityItem[];
  try {
    ({ items } = await api.activity(network));
  } catch {
    return; // Older gateways have no /activity; outgoing history is local anyway.
  }
  for (const it of items) {
    const local = getState().activity;
    if (local.some((t) => t.txHash?.toLowerCase() === it.txHash.toLowerCase() && t.counterparty === it.counterparty)) continue;
    // A shield moves amount + fee to the pool.
    const moved = (t: (typeof local)[number]) => parseUnits(t.amount, AUSD_DECIMALS) + (t.shield ? parseUnits(t.fee ?? '0', AUSD_DECIMALS) : 0n);
    const unsettled =
      it.direction === 'out' &&
      local.find((t) => t.direction === 'out' && !t.txHash && t.counterparty === it.counterparty && moved(t) === parseUnits(it.amount, AUSD_DECIMALS));
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
      // The pool's transfers are shields (out) and private withdrawals to us (in).
      ...(it.counterparty.toLowerCase() === pool
        ? { label: it.direction === 'out' ? 'Private balance' : 'Private payment', private: true as const }
        : { label: labelFor(it.counterparty) }),
      status: 'sent',
      txHash: it.txHash,
      at: it.at * 1000,
    });
  }
};

// ---------------------------------------------------------------- private balance

const cacheOf = (s: State, network: NetworkName): Cache => ({ notes: s.notes[network] ?? [], awaiting: s.awaiting[network] ?? [], pins: s.shieldedPins });
const saveCache = (network: NetworkName, c: Cache) =>
  setState((s) => ({ notes: { ...s.notes, [network]: c.notes }, awaiting: { ...s.awaiting, [network]: c.awaiting }, shieldedPins: c.pins }));

export const isRegistered = (network: NetworkName, s: State = getState()) => hasPool(network) && !!s.shielded?.registered.includes(network);
export const cache = (network: NetworkName) => cacheOf(getState(), network);

/**
 * Hands the gateway what it needs to prove for us (never the spending key) on
 * every network with a pool. Idempotent; skipped once done. Runs after
 * create/restore and after any unlock while it's missing; failures (offline,
 * older gateway) wait for the next unlock.
 */
export const registerShielded = async (user: User) => {
  // Before any await: the caller may wipe authSk right after.
  const pk = provingKeys(user);
  const mine = b64(packAddress(owner(pk)));
  const keys = { Ax: pk.Ax.toString(), Ay: pk.Ay.toString(), nk: pk.nk.toString(), viewSk: bytesToBigInt(pk.viewSk).toString() };
  for (const network of POOL_NETWORKS) {
    const s = getState().shielded;
    if (s?.owner === mine && s.registered.includes(network)) continue;
    try {
      const r = await api.shieldedRegister(network, keys);
      if (r.owner.replace(/=+$/, '') !== mine) continue;
      setState((st) => ({ shielded: { owner: mine, registered: [...(st.shielded?.owner === mine ? st.shielded.registered : []), network] } }));
    } catch {
      // Retried on the next unlock.
    }
  }
};

export const ensureRegistered = (u: Unlocked) => {
  if (!POOL_NETWORKS.every((n) => isRegistered(n))) void registerShielded(u.shielded);
};

/** Online: the gateway's index of our notes replaces the cache; waiting payments settle or expire. */
export const pullNotes = async (network = getState().network) => {
  if (!isRegistered(network)) return;
  let notes;
  try {
    ({ notes } = await api.shieldedNotes(network));
  } catch {
    return;
  }
  const r = resync(cacheOf(getState(), network), notes.map((n) => ({ pos: n.pos, amount: String(n.amount), blinding: String(n.blinding), spent: n.spent })));
  saveCache(network, r.cache);
  for (const a of r.settled) upsertTx({ id: a.id, status: 'sent' });
  for (const a of r.expired) upsertTx({ id: a.id, status: 'expired' });
};

/** A private payment or shield was signed: hold its notes until it settles. */
export const holdNotes = (network: NetworkName, a: Awaiting) =>
  setState((s) => ({ awaiting: { ...s.awaiting, [network]: [...(s.awaiting[network] ?? []).filter((x) => x.id !== a.id), a] } }));

/** Refused or failed: its notes are free again. */
export const releaseNotes = (network: NetworkName, id: string) =>
  setState((s) => ({ awaiting: { ...s.awaiting, [network]: (s.awaiting[network] ?? []).filter((x) => x.id !== id) } }));

/** The gateway answered the submit online: settle that payment, with the output position it reported. */
export const settlePrivate = (network: NetworkName, id: string, p?: number) => {
  const c = cacheOf(getState(), network);
  const a = c.awaiting.find((x) => x.id === id);
  if (a) saveCache(network, settleAwaiting(c, a, p));
};

/** Sent / Shielded / Got texts update the note cache wherever the user is. */
export const applyShieldedReply = (r: Reply) => {
  const { network } = getState();
  if (!isRegistered(network) || (r.kind !== 'sent' && r.kind !== 'shielded' && r.kind !== 'got')) return;
  const { cache: next, settled } = applyReply(cacheOf(getState(), network), r);
  saveCache(network, next);
  if (settled) upsertTx({ id: settled.id, status: 'sent' });
  if (r.kind === 'got')
    upsertTx({ id: `got:${network}:${r.p}`, network, direction: 'in', amount: r.amount, label: phoneDisplay(r.from), private: true, status: 'sent', at: Date.now() });
};

/**
 * Private or public for this payment. A number can take a private payment once
 * we've paid it privately (pinned) or the gateway knows its shielded address;
 * offline and unpinned means public.
 */
export const decideRoute = async (d: Draft): Promise<'private' | 'public'> => {
  const s = getState();
  if (!isRegistered(d.network, s) || d.deliver === 'CTK') return 'public';
  let recipientPrivate = !!d.toAddress;
  if (d.phone)
    recipientPrivate =
      !!s.shieldedPins[d.phone] ||
      (await api.shieldedAddress(d.network, d.phone).then(
        () => true,
        () => false,
      ));
  return chooseRoute({ recipientPrivate, cache: cacheOf(s, d.network), amount: d.amount, deliver: d.deliver });
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
  // Private payments (shielded pool).
  NOUSER: "This number can't take private payments yet.",
  FUNDS: 'Not enough private balance for this amount plus the fee.',
  MERGE: 'Your private balance is in too many small pieces for this amount. Pay publicly, or send less.',
  REF: "The gateway didn't recognise your private notes. Pull to refresh, then try again.",
  BADSIG: "The signature didn't match. Nothing was sent.",
  UNKNOWN: 'That quote is no longer open. Try again.',
  EXPIRED: 'That quote has expired. Try again.',
  NOEOA: "Your wallet can't fund the private balance yet. Try again in a minute.",
  POLICY: 'The gateway refused this private payment.',
};

export const errorText = (e: unknown): string => {
  if (e instanceof ApiError) return ERRORS[e.code] ?? `Gateway said: ${e.code}`;
  if (e instanceof OfflineError) return 'No internet.';
  if (typeof e === 'string') return ERRORS[e] ?? `Gateway said: ${e}`;
  return e instanceof Error ? e.message : String(e);
};

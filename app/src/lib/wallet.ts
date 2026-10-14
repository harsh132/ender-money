/** Account sync, signup and the pieces of a transfer, shared by the screens. */
import { useSyncExternalStore } from 'react';
import { bytesToBigInt, createPublicClient, http, parseUnits, type Address, type Hex, type LocalAccount } from 'viem';
import { relayQuote, relayStatus } from '../../../protocol/bridge';
import { signedBatchTypedData, swapWithFee, transferWithFee } from '../../../protocol/calibur';
import { AUSD_DECIMALS, BRIDGE_CHAINS, bridgeChainOf, CALIBUR, CTK_DECIMALS, FEE_RECIPIENT, NETWORKS, type NetworkName } from '../../../protocol/networks';
import { MAX_LABEL, MIN_LABEL, parseEnderId } from '../../../protocol/names';
import { isPrivateAddress } from '../../../protocol/recipient';
import { owner, packAddress, provingKeys, type User } from '../../../protocol/shielded';
import { b64, type Deliver, type Reply } from '../../../protocol/sms';
import { api, ApiError, OfflineError, TimeoutError, type ActivityItem, type AuthorizationJson } from './api';
import { signIn } from './auth';
import { autoBridgeOn, bridgeOutcome, checkPrepared, shouldAutoBridge, signBridge } from './bridge';
import { DEFAULT_NETWORK, MAX_FEE } from './config';
import { fileReceived, smsTwin, type Received } from './inbox';
import { lock, quickSend, unlockWallet, type Unlocked } from './keys';
import {
  autoShieldOn,
  checkShieldedQuote,
  chooseRoute,
  fileReply,
  hasPool,
  isPrivateReceived,
  POOL_NETWORKS,
  resync,
  settleAwaiting,
  shieldAmount,
  shouldAutoMerge,
  shouldAutoShield,
  signPrivate,
  signShield,
  txLinks,
  withdrawRoute,
  type Awaiting,
  type Cache,
  type PrivateDraft,
} from './private';
import { getState, labelFor, setState, upsertTx, type State, type TxStatus } from './store';
import { online, textGateway, type Pipe } from './transport';

// ---------------------------------------------------------------- sync

/** Online refresh of balance and nonce. Returns false when offline (the caller can offer SYNC by text). */
export const sync = async (network = getState().network): Promise<boolean> => {
  try {
    const a = await api.account(network);
    setState((s) => ({
      account: { ...s.account, [network]: { balance: a.balance, nonce: a.nonce, delegated: a.delegated, syncedAt: Date.now() } },
      ...(a.inr ? { inr: a.inr } : {}),
      // The Ender ID (it may have changed on another phone) and the number, which turns SMS features on. An older gateway says neither.
      ...(s.wallet ? { wallet: { ...s.wallet, ...(a.name !== undefined ? { enderId: a.name } : {}), ...(a.phone !== undefined ? { phone: a.phone } : {}) } } : {}),
    }));
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setState({ token: undefined });
    if (e instanceof OfflineError || e instanceof ApiError) return false;
    throw e;
  }
};

/** Pull to refresh: balance, then the status of transfers and bridges still going, then incoming payments; then Auto Shield and Auto-bridge may run. */
export const refresh = async () => {
  if (!(await sync())) return false;
  await Promise.all([refreshPending(), refreshBridges(), pullActivity(), pullNotes()]);
  void autoShield();
  void autoBridge();
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
    // A Received text got here first: the full row replaces it.
    const twin = smsTwin(getState().activity, network, it);
    if (twin) setState((s) => ({ activity: s.activity.filter((t) => t !== twin) }));
    // A bridge's AUSD landing (Relay's fill): the bridge's own row shows it, with what actually arrived.
    const bridged = it.direction === 'in' && getState().activity.find((t) => t.bridge && t.txHash?.toLowerCase() === it.txHash.toLowerCase());
    if (bridged) {
      if (bridged.amount !== it.amount) upsertTx({ id: bridged.id, amount: it.amount });
      continue;
    }
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
      // The pool's transfers are shields (out) and private withdrawals to us (in). Shields and our own withdrawals
      // (one of our private payments has the same hash) aren't listed.
      ...(it.counterparty.toLowerCase() === pool
        ? {
            label: it.direction === 'out' ? 'Private balance' : 'Private payment',
            private: true as const,
            ...(it.direction === 'out' || local.some((t) => t.private && t.direction === 'out' && t.txHash?.toLowerCase() === it.txHash.toLowerCase())
              ? { internal: true as const }
              : {}),
          }
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
 * sign-up and after any unlock while it's missing; failures (offline, older
 * gateway) wait for the next unlock. The keys are read at once, since the
 * caller may wipe authSk right after; the returned call sends them.
 */
const registration = (user: User) => {
  const pk = provingKeys(user);
  const mine = b64(packAddress(owner(pk)));
  const keys = { Ax: pk.Ax.toString(), Ay: pk.Ay.toString(), nk: pk.nk.toString(), viewSk: bytesToBigInt(pk.viewSk).toString() };
  return async () => {
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
};

/**
 * After any passkey unlock: sign in again if the gateway token is gone (it
 * expired, or predates sign-in by signature), then register the private keys
 * while they're missing. Await it before locking `u`.
 */
export const afterUnlock = async (u: Unlocked) => {
  const register = POOL_NETWORKS.every((n) => isRegistered(n)) ? null : registration(u.shielded);
  if (!getState().token) await signIn(u).catch(() => {});
  await register?.();
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
  const r = resync(
    cacheOf(getState(), network),
    notes.map((n) => ({ pos: n.pos, amount: String(n.amount), blinding: String(n.blinding), spent: n.spent, ...(n.tx ? { tx: n.tx } : {}) })),
  );
  saveCache(network, r.cache);
  for (const a of r.settled) upsertTx({ id: a.id, status: 'sent' });
  for (const a of r.expired) upsertTx({ id: a.id, status: 'expired' });
  // Rows from texts know only the short hash; the notes give the full one (private transactions aren't on the wallet's page).
  for (const link of txLinks(getState().activity, network, r.cache.notes)) upsertTx(link);
  void autoMerge(network);
  void autoShield(network);
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
  void autoMerge(network);
  void autoShield(network);
};

/**
 * Sent / Shielded / private Received texts, wherever the user is and whatever network the app shows: the note
 * cache of the network the text names, and the Activity row with the text's id (a public Sent too), with the
 * text's short hash and output position until a resync gives the full hash (txLinks).
 */
export const applyShieldedReply = (r: Reply) => {
  const received = isPrivateReceived(r);
  if (r.kind !== 'sent' && r.kind !== 'shielded' && !received) return;
  const filed = fileReply(getState(), r);
  if (filed) setState(filed.patch);
  if (filed?.settled) {
    void autoMerge(filed.network);
    void autoShield(filed.network);
  }
  const short = r.tx ? { shortTx: r.tx } : {};
  const id = filed?.settled?.id ?? (received ? undefined : r.id);
  if (id && getState().activity.some((t) => t.id === id)) upsertTx({ id, status: 'sent', ...short, ...(r.p === undefined ? {} : { pos: r.p }) });
  if (received && filed)
    upsertTx({
      id: `got:${filed.network}:${r.p}`,
      network: filed.network,
      direction: 'in',
      amount: r.amount,
      // The sender's Ender ID; a sender without one (or an older gateway's Got) stays "Private payment".
      label: r.from ?? 'Private payment',
      private: true,
      status: 'sent',
      at: Date.now(),
      pos: r.p,
      ...short,
    });
};

/**
 * A public `Received` alert by text: an incoming row (replaced by the online history later) and the balance it
 * reports. A transfer Activity already has changes nothing: its balance may be older than the synced one.
 */
export const applyReceived = (r: Received) => {
  const filed = fileReceived(getState(), r, Date.now());
  if (!filed) return;
  // Named by address: a contact's name if we have one. By Ender ID or ENS name: that name.
  upsertTx(filed.row.counterparty ? { ...filed.row, label: labelFor(filed.row.counterparty) } : filed.row);
  setState({ account: filed.account });
};

// ---------------------------------------------------------------- auto-merge, auto-shield

// One at a time: a trigger that comes while the other runs waits for it to finish.
let merging = false;
let shielding = false;
// A deposit on its way, for the Auto Shield toast (tabs layout). In memory only: it ends with the app.
let depositing = false;
const depositListeners = new Set<() => void>();
const setDepositing = (on: boolean) => {
  depositing = on;
  depositListeners.forEach((l) => l());
};
export const useAutoShielding = () =>
  useSyncExternalStore(
    (l) => {
      depositListeners.add(l);
      return () => depositListeners.delete(l);
    },
    () => depositing,
  );
/** After a failed auto-shield, triggers wait this long, so a gateway that keeps refusing doesn't fill Activity with failed rows. */
const SHIELD_BACKOFF_MS = 10 * 60_000;
let shieldRetryAt = 0;
let mergeLater = false;
let shieldLater = false;

/**
 * Settings' Auto-merge: one merge (the 12 largest notes into one, fee 0.01)
 * online in the background, when shouldAutoMerge says so. The spending key is
 * the open Quick send session's; nothing is stored for this, so a locked app
 * waits for the next unlock. Never by text. A failure only logs: the next
 * trigger (a resync, a settled private payment, coming to the foreground, the
 * toggle) tries again. A merge that settles re-checks, as more may be left.
 */
export const autoMerge = async (network: NetworkName = getState().network): Promise<void> => {
  if (merging) return;
  if (shielding) return void (mergeLater = true);
  merging = true;
  let again = false;
  const ready = async () => {
    const s = getState();
    const cache = cacheOf(s, network);
    const base = { on: !!s.autoMerge, unlocked: !!quickSend.get(), registered: isRegistered(network, s), network, cache };
    // NetInfo is only asked once everything else holds.
    return shouldAutoMerge({ ...base, online: true }) && (await online());
  };
  try {
    if (!(await ready())) return;
    const draft: PrivateDraft = { kind: 'merge', amount: '0' };
    const q = await api.shieldedQuote({ network, kind: 'merge' });
    const session = quickSend.get();
    // Locked, turned off or a payment started meanwhile: the quote just expires.
    if (!session || !(await ready())) return;
    const quote = { id: q.id, exp: q.exp, fee: q.fee, ...(q.to === undefined ? {} : { to: q.to as Address }) };
    const refused = checkShieldedQuote(draft, quote);
    if (refused) throw new Error(refused.code);
    const r = signPrivate(session.unlocked.shielded, cacheOf(getState(), network), draft, quote, network);
    if ('err' in r) throw new Error(r.err);
    holdNotes(network, r.awaiting);
    upsertTx({ id: q.id, network, direction: 'out', amount: '0', fee: q.fee, label: 'Merged private notes', status: 'sending', at: Date.now(), deadline: q.exp, private: true, internal: true });
    try {
      const res = await api.shieldedSubmit({ id: q.id, refs: r.refs, sig: btoa(String.fromCharCode(...r.sig)) });
      // Still landing: its notes stay held until a resync sees it.
      if (res.pending) return upsertTx({ id: q.id, txHash: res.tx });
      upsertTx({ id: q.id, status: 'sent', txHash: res.tx });
      const c = cacheOf(getState(), network);
      saveCache(network, settleAwaiting(c, c.awaiting.find((x) => x.id === q.id)!, res.p));
      again = true;
    } catch (e) {
      // Refused: the notes are free again. Lost connection: it may have gone through; held until a resync tells.
      if (!(e instanceof OfflineError)) {
        releaseNotes(network, q.id);
        upsertTx({ id: q.id, status: 'failed', error: e instanceof ApiError ? e.code : undefined });
      }
      throw e;
    }
  } catch (e) {
    console.warn('auto-merge:', e instanceof ApiError ? e.code : e instanceof Error ? e.message : e);
  } finally {
    merging = false;
    if (again) void autoMerge(network);
    else if (shieldLater) {
      shieldLater = false;
      void autoShield(network);
    }
  }
};

/**
 * Settings' Auto Shield: the whole public balance into the private one, in one
 * deposit (fee included; at most the pool's cap, the rest on the next trigger), online in the background when shouldAutoShield says
 * so. Like Auto-merge: the open Quick send session's key, never by text, a
 * failure only logs and the next trigger (a refresh, a resync, a settled
 * private payment, the foreground, the toggle) tries again. A shield that
 * settles syncs the public balance and lets Auto-merge run.
 */
export const autoShield = async (network: NetworkName = getState().network): Promise<void> => {
  if (shielding || Date.now() < shieldRetryAt) return;
  if (merging) return void (shieldLater = true);
  shielding = true;
  let again = false;
  const ready = async () => {
    const s = getState();
    const base = {
      on: autoShieldOn(s),
      unlocked: !!quickSend.get(),
      registered: isRegistered(network, s),
      network,
      cache: cacheOf(s, network),
      publicBalance: s.account[network]?.balance ?? '0',
      // A public payment still sending would race the deposit for the same balance.
      busy: s.activity.some((t) => t.network === network && t.direction === 'out' && t.status === 'sending' && !t.private),
    };
    return shouldAutoShield({ ...base, online: true }) && (await online());
  };
  try {
    if (!(await ready())) return;
    // ponytail: priced at MAX_FEE (the gateway's fee today); a lower quoted fee would leave the difference public.
    const amount = shieldAmount(getState().account[network]!.balance, MAX_FEE, network);
    const draft: PrivateDraft = { kind: 'shield', amount };
    const q = await api.shieldedQuote({ network, kind: 'shield', amount });
    const session = quickSend.get();
    // Locked, turned off or a payment started meanwhile: the quote just expires.
    if (!session || !(await ready())) return;
    const quote = { id: q.id, exp: q.exp, fee: q.fee, ...(q.to === undefined ? {} : { to: q.to as Address }) };
    const refused = checkShieldedQuote(draft, quote);
    if (refused) throw new Error(refused.code);
    const r = await signShield(session.unlocked.shielded, session.unlocked.account, amount, quote, network);
    holdNotes(network, r.awaiting);
    upsertTx({
      id: q.id,
      network,
      direction: 'out',
      amount,
      fee: q.fee,
      counterparty: NETWORKS[network].pool,
      label: 'Private balance',
      status: 'sending',
      at: Date.now(),
      deadline: q.exp,
      private: true,
      shield: true,
    });
    setDepositing(true);
    let res;
    try {
      res = await api.shieldedSubmit({ id: q.id, signature: r.signature });
    } catch (e) {
      // Refused: nothing moved. Lost connection: it may have gone through; held until a resync tells.
      if (!(e instanceof OfflineError)) {
        releaseNotes(network, q.id);
        upsertTx({ id: q.id, status: 'failed', error: e instanceof ApiError ? e.code : undefined });
      }
      throw e;
    }
    // Still landing: held until a resync sees it.
    if (res.pending) return upsertTx({ id: q.id, txHash: res.tx });
    upsertTx({ id: q.id, status: 'sent', txHash: res.tx });
    settlePrivate(network, q.id, res.p);
    await sync(network);
    again = true; // capped: what's left over goes next
  } catch (e) {
    console.warn('auto-shield:', e instanceof ApiError ? e.code : e instanceof Error ? e.message : e);
    if (!(e instanceof OfflineError)) shieldRetryAt = Date.now() + SHIELD_BACKOFF_MS;
  } finally {
    shielding = false;
    setDepositing(false);
    // The settle above (or a resync meanwhile) asked for a merge.
    if (mergeLater) {
      mergeLater = false;
      void autoMerge(network);
    } else if (again) void autoShield(network);
  }
};

// A key in memory (sign-up, an unlock, an approved payment) is what Auto Shield waits for.
quickSend.subscribe(() => {
  if (quickSend.get()) void autoShield();
});

// ---------------------------------------------------------------- auto-bridge

let bridging = false;
/** After the list itself fails (an older gateway, say), triggers wait this long; so does one balance we refused. */
const BRIDGE_BACKOFF_MS = 10 * 60_000;
let bridgeRetryAt = 0;
const bridgeSkip = new Map<string, number>();

/**
 * Auto-bridge: tokens that reached our address on Ethereum, Base, Arbitrum or
 * Polygon become AUSD here on Monad mainnet, through Relay (lib/bridge.ts). No
 * setting; online and unlocked like Auto Shield, from the same triggers (a
 * refresh, the foreground). For each balance the gateway lists, it prices its
 * fee and gives the nonces; we fetch Relay's quote ourselves (to us, AUSD on
 * Monad, that fee to the recipient we ship), check and sign it, and the
 * gateway sends it, paying the gas. A balance someone refuses only logs: the
 * gateway lists it again later, or when more arrives.
 */
export const autoBridge = async (): Promise<void> => {
  if (bridging || Date.now() < bridgeRetryAt) return;
  bridging = true;
  const ready = async () =>
    shouldAutoBridge({ on: autoBridgeOn(getState()), network: getState().network, unlocked: !!quickSend.get(), online: true }) && (await online());
  try {
    if (!(await ready())) return;
    const { items } = await api.bridgePending();
    for (const it of items) {
      const key = `${it.chainId}:${it.token}`;
      if (Date.now() < (bridgeSkip.get(key) ?? 0)) continue;
      try {
        await bridgeOne(it.chainId, it.token);
      } catch (e) {
        if (e instanceof OfflineError) throw e;
        if (!(e instanceof ApiError)) bridgeSkip.set(key, Date.now() + BRIDGE_BACKOFF_MS);
        console.warn('auto-bridge:', e instanceof ApiError ? e.code : e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('auto-bridge:', e instanceof ApiError ? e.code : e instanceof Error ? e.message : e);
    if (!(e instanceof OfflineError)) bridgeRetryAt = Date.now() + BRIDGE_BACKOFF_MS;
  } finally {
    bridging = false;
  }
};

const bridgeOne = async (chainId: number, token: Address) => {
  const p = await api.bridgePrepare({ chainId, token });
  const refused = checkPrepared(p);
  if (refused) throw new Error(refused);
  const me = quickSend.get()?.unlocked.address;
  if (!me) return;
  const quote = await relayQuote({ user: me, originChainId: chainId, token, amount: BigInt(p.amount), bps: p.bps });
  // Locked meanwhile: the prepared bridge just expires.
  const session = quickSend.get();
  if (!session) return;
  const body = await signBridge(session.unlocked.account, p, quote);
  const id = `bridge:${p.id}`;
  const bridge = { chainId, requestId: body.requestId };
  upsertTx({
    id,
    network: 'mainnet',
    direction: 'in',
    amount: quote.details.currencyOut.amountFormatted,
    label: `From ${BRIDGE_CHAINS[bridgeChainOf(chainId)!].label}`,
    status: 'sending',
    at: Date.now(),
    deadline: body.deadline,
    bridge,
  });
  try {
    const r = await api.bridgeSubmit(body);
    upsertTx({ id, bridge: { ...bridge, tx: r.txHash } });
  } catch (e) {
    // Refused: nothing moved, nothing to show. Lost connection: it may have gone; Relay's status tells (refreshBridges).
    if (!(e instanceof OfflineError)) setState((s) => ({ activity: s.activity.filter((t) => t.id !== id) }));
    throw e;
  }
};

/** Bridges on their way, settled by Relay's status; the fill's own incoming row, if already pulled, goes. */
const refreshBridges = async () => {
  const going = getState().activity.filter((t) => t.bridge?.requestId && t.status === 'sending');
  await Promise.all(
    going.map(async (t) => {
      const r = await relayStatus(t.bridge!.requestId!).catch(() => undefined);
      if (!r) return;
      const status = bridgeOutcome(r.status);
      if (!status) {
        // Relay never saw the deposit and the batch's deadline is long past: it never will.
        if (r.status === 'waiting' && t.deadline && t.deadline * 1000 + 5 * 60_000 < Date.now()) upsertTx({ id: t.id, status: 'expired' });
        return;
      }
      const fill = status === 'sent' ? r.txHashes?.[0]?.toLowerCase() : undefined;
      upsertTx({ id: t.id, status, ...(fill ? { txHash: fill } : {}) });
      if (fill) setState((s) => ({ activity: s.activity.filter((x) => x.bridge || x.direction !== 'in' || x.txHash?.toLowerCase() !== fill) }));
    }),
  );
};

/**
 * Private or public for this payment. A number or Ender ID can take a private payment once
 * we've paid it privately (pinned) or the gateway knows its shielded address;
 * one without a shielded address gets a private withdrawal to its wallet
 * (withdrawTo) when the notes cover it (withdrawRoute). Offline and unpinned
 * means public. A private address (ender1…) takes private payments only:
 * 'public' for one means the private balance can't pay it.
 */
export const decideRoute = async (d: Draft): Promise<{ route: 'private' | 'public'; withdrawTo?: Address }> => {
  const s = getState();
  if (!isRegistered(d.network, s) || d.deliver === 'CTK') return { route: 'public' };
  let recipientPrivate = !!d.toAddress || isPrivateAddress(d.to);
  /** The recipient's wallet, when a lookup gave it. */
  let wallet: Address | undefined;
  const label = parseEnderId(d.to);
  if (d.phone)
    recipientPrivate =
      !!s.shieldedPins[d.phone] ||
      (await api.shieldedAddress(d.network, d.phone).then(
        () => true,
        () => false,
      ));
  else if (label && s.shieldedPins[d.to]) recipientPrivate = true;
  else if (label) {
    const r = await api.name(label, d.network).catch(() => undefined);
    recipientPrivate = !!r?.private;
    wallet = r?.address;
  }
  const cache = cacheOf(s, d.network);
  if (recipientPrivate || !(d.phone || label)) return { route: chooseRoute({ recipientPrivate, cache, amount: d.amount, deliver: d.deliver }) };
  if (d.phone) wallet = await api.nameByPhone(d.phone).then((r) => r.address, () => undefined);
  const key = pinKey(d);
  return withdrawRoute({ wallet, pinned: key ? s.pins[key] : undefined, cache, amount: d.amount });
};

export const syncByText = () => textGateway({ kind: 'sync' }, getState().network);

/** An `OK …` reply, from SYNC by text: the network it names (`[Test] ` is testnet). */
export const applyOkReply = (r: Extract<Reply, { kind: 'ok' }>) =>
  setState((s) => ({
    account: {
      ...s.account,
      [r.test ? 'testnet' : 'mainnet']: { balance: r.balance, nonce: r.nonce.toString(), delegated: r.delegated, syncedAt: Date.now() },
    },
    ...(r.inr && Number(r.inr) > 0 ? { inr: Number(r.inr) } : {}),
  }));

// ---------------------------------------------------------------- signup

/**
 * Sign a 7702 authorization to Calibur on each network (no extra prompt: the
 * key is already unlocked) and hand them to /wallet/create, which sends the
 * sponsored delegations (a network already delegated answers at once).
 */
export const createWallet = async (u: Unlocked) => {
  const authorizations: Partial<Record<NetworkName, AuthorizationJson>> = {};
  for (const name of Object.keys(NETWORKS) as NetworkName[]) {
    const { chain } = NETWORKS[name];
    const nonce = await createPublicClient({ chain, transport: http() }).getTransactionCount({ address: u.address });
    const a = await u.account.signAuthorization!({ contractAddress: CALIBUR, chainId: chain.id, nonce });
    authorizations[name] = { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity! };
  }
  return api.createWallet({ authorizations });
};

/**
 * Onboarding with an unlocked passkey, new or existing: sign in (the first
 * time creates the account and its random Ender ID), make sure the wallet is
 * delegated, keep it, and register the private keys. The caller locks `u` after.
 */
export const setUpWallet = async (u: Unlocked) => {
  const register = registration(u.shielded);
  const r = await signIn(u);
  await createWallet(u);
  const prev = getState().wallet;
  const same = prev?.address.toLowerCase() === r.address.toLowerCase();
  setState({
    wallet: { address: u.address, enderId: r.name, phone: same ? prev.phone : undefined, credentialId: u.credential.credentialId, transports: u.credential.transports as string[] | undefined },
    ...(same ? {} : { network: DEFAULT_NETWORK, account: {}, activity: [] }),
  });
  void register();
  void sync();
  return r;
};

/**
 * The Ender ID change by payment (Settings): `fee` AUSD to the treasury on mainnet, a normal public transfer
 * (quote, passkey, sign). Returns its hash for POST /account/name.
 */
export const payNameFee = async (fee: string, treasury: Address): Promise<Hex> => {
  const wallet = getState().wallet!;
  const draft: Draft = { network: 'mainnet', to: treasury, toAddress: treasury, amount: fee, deliver: 'AUSD', label: 'Ender ID change' };
  const q = await api.quote({ network: 'mainnet', to: treasury, amount: fee });
  const quote: Quote = { id: q.id, to: q.to, fee: q.fee, nonce: BigInt(q.nonce), deadline: q.deadline, pipe: 'internet' };
  checkQuote(draft, quote);
  quickSend.end();
  const u = await unlockWallet({ credentialId: wallet.credentialId });
  let signature: Hex;
  try {
    if (u.address.toLowerCase() !== wallet.address.toLowerCase()) throw new TransferError('wrong-passkey', 'That passkey belongs to another wallet. Pick your Ender passkey.');
    signature = await signQuote(u.account, draft, quote);
  } finally {
    lock(u);
  }
  const r = await api.sign(q.id, signature);
  upsertTx({ id: q.id, network: 'mainnet', direction: 'out', amount: fee, fee: q.fee, counterparty: treasury, label: draft.label, status: r.pending ? 'sending' : 'sent', txHash: r.txHash, at: Date.now(), deadline: q.deadline });
  return r.txHash;
};

// ---------------------------------------------------------------- transfer

export type Draft = {
  network: NetworkName;
  /** What the user typed or picked: a 0x address, an E.164 number, a private address (ender1…) or an Ender ID (label.ender.my). */
  to: string;
  /** The recipient's Ender ID when known (display; `to` itself when paying the name). */
  enderId?: string;
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

/** What a recipient's first answer is pinned under: the number, or the Ender ID when paying one. */
export const pinKey = (d: Pick<Draft, 'to' | 'phone'>) => d.phone ?? (parseEnderId(d.to) ? d.to : undefined);

/** Never sign what the gateway made up: the recipient, fee and deadline must be what the user saw. */
export const checkQuote = (draft: Draft, q: Quote): { pinChanged: boolean } => {
  if (draft.toAddress && q.to.toLowerCase() !== draft.toAddress.toLowerCase())
    throw new TransferError('recipient-mismatch', 'The gateway quoted a different recipient. Nothing was sent.');
  if (parseUnits(q.fee, AUSD_DECIMALS) > parseUnits(MAX_FEE, AUSD_DECIMALS))
    throw new TransferError('fee-too-high', `The fee came back as $${q.fee}. Nothing was sent.`);
  if (q.deadline * 1000 < Date.now()) throw new TransferError('expired', 'That quote has expired. Try again.');
  if (draft.deliver === 'CTK' && !(q.out && Number(q.out) > 0))
    throw new TransferError('no-out', 'The quote came back without a CTK amount. Nothing was sent.');
  const key = pinKey(draft);
  const pinned = key ? getState().pins[key] : undefined;
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
  'bad-recipient': "That isn't a phone number, Ender ID, wallet address or private address.",
  'bad-amount': 'Check the amount.',
  'not-delegated': 'Your wallet is still being set up on this network. Try again in a minute.',
  'not-registered': 'This wallet has no Ender account yet. Log in again.',
  'rate-limited': 'Too many tries. Wait a minute.',
  expired: 'That quote has expired. Try again.',
  'bad-sig': "The signature didn't match. Nothing was sent.",
  'swap-unavailable': 'Local-currency delivery is unavailable right now. Send AUSD instead.',
  reverted: 'The transfer would fail on-chain. Nothing was sent.',
  failed: 'The transfer failed on-chain. Your money did not move.',
  'send-failed': "The gateway couldn't send it. Try again.",
  'in-progress': 'Already sending.',
  unsupported: 'Not supported yet.',
  unauthorized: 'Your login expired. Unlock with your passkey to continue.',
  'challenge-expired': 'That took too long. Try again.',
  'bad-signature': "The signature didn't match. Try again.",
  'captcha-failed': "We couldn't check you're human. Try again.",
  'sms-unavailable': "Ender can't text this country yet.",
  'bad-code': "That code isn't right.",
  'code-expired': 'That code has expired. Send a new one.',
  'bad-phone': 'Check the number.',
  'unknown-name': 'No one has that Ender ID.',
  'name-taken': 'That Ender ID was just taken. Pick another.',
  'bad-name': `That Ender ID isn't allowed. Use ${MIN_LABEL} to ${MAX_LABEL} letters, numbers or hyphens.`,
  'name-already-set': "You've already changed your Ender ID.",
  'unlock-required': 'Verify a phone number or pay to change your Ender ID.',
  'phone-used': 'This number has already changed an Ender ID.',
  'payment-used': 'That payment was already used.',
  'bad-payment': "That payment doesn't cover the change.",
  'payment-not-found': "The payment hasn't landed yet. Try again in a moment.",
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
  CAP: 'Private deposits have a per-deposit limit during the beta. Make a smaller amount private.',
  syncing: 'The gateway is still catching up with the private pool. Try again in a minute.',
  'wrong-network': 'That approval was for the other network. Nothing was sent.',
};

export const errorText = (e: unknown): string => {
  if (e instanceof ApiError) return ERRORS[e.code] ?? `Gateway said: ${e.code}`;
  if (e instanceof TimeoutError) return 'Taking longer than usual. Try again.';
  if (e instanceof OfflineError) return 'No internet.';
  if (typeof e === 'string') return ERRORS[e] ?? `Gateway said: ${e}`;
  return e instanceof Error ? e.message : String(e);
};

import * as Clipboard from 'expo-clipboard';
import * as SMS from 'expo-sms';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Address, Hex } from 'viem';
import { NETWORKS } from '../../../protocol/networks';
import { decodePrivateAddress, isPrivateAddress } from '../../../protocol/recipient';
import { unb64, type Command, type Reply, type ShieldedCommand } from '../../../protocol/sms';
import { api, ApiError, OfflineError } from '../lib/api';
import { MAX_FEE } from '../lib/config';
import { countdown, phoneDisplay, short, time, usd } from '../lib/format';
import { lock, passkeyError, quickSend, unlockWallet, whileOwnScreen, type Unlocked } from '../lib/keys';
import { checkShieldedQuote, hasPool, MERGE_OVER, signPrivate, signShield, textNetwork, type Awaiting, type PrivateDraft, type ShieldedQuote } from '../lib/private';
import { getState, rememberRecipient, upsertTx, useStore } from '../lib/store';
import { c, f } from '../lib/theme';
import { acceptReply, NoSmsError, onReply, online, textGateway, type Pipe } from '../lib/transport';
import {
  cache,
  checkQuote,
  decideRoute,
  ensureRegistered,
  errorText,
  holdNotes,
  releaseNotes,
  settlePrivate,
  signQuote,
  TransferError,
  type Draft,
  type Quote,
} from '../lib/wallet';
import { Bolt, Check, Globe, Message, Shield } from '../ui/icons';
import { BackHeader, Banner, Button, Card, Chip, KV, Spinner, T, TestnetPill } from '../ui/kit';

type Step = 'request' | 'quote' | 'approve' | 'sent';
const ORDER: Step[] = ['request', 'quote', 'approve', 'sent'];

type Phase =
  | { k: 'review' }
  | { k: 'working'; step: Step }
  | { k: 'wait-quote' }
  | { k: 'pin'; quote: Quote }
  | { k: 'wait-sent'; id: string; sms: Command | ShieldedCommand }
  | { k: 'done'; txHash?: string }
  | { k: 'failed'; step: Step; message: string; quote?: Quote; code?: string };

const total = (amount: string, fee: string) => (Number(amount) + Number(fee)).toFixed(6);
/** Milliseconds until the quote's signed deadline. Only called from handlers, not render. */
const msLeft = (q: Quote) => q.deadline * 1000 - Date.now();
const stamp = () => Date.now();

type PQuote = ShieldedQuote & { pipe: Pipe };
/** A private quote: the gateway refused because the recipient or our notes can't do it privately; paying publicly may work. */
const PUBLIC_INSTEAD = new Set(['NOUSER', 'FUNDS', 'MERGE']);
/** Lets the spinner paint before the heavy part (Poseidon, BabyJubJub) blocks the JS thread. */
const paint = () => new Promise((r) => setTimeout(r, 32));

/** Review, then the same screen tracks progress: Request sent -> Quote received -> Approve -> Sent. */
export default function Review() {
  const p = useLocalSearchParams<{ to: string; toAddress?: string; phone?: string; label?: string; amount: string; deliver?: string; shield?: string; merge?: string }>();
  const network = useStore((s) => s.network);
  const wallet = useStore((s) => s.wallet)!;
  const recents = useStore((s) => s.recents);
  /** Make private: public balance -> private balance (shield). */
  const shield = p.shield === '1';
  /** Merge: 12 private notes into one (0 to ourselves, the fee only). */
  const merge = p.merge === '1';
  /** Shield and merge pay ourselves: no recipient, always private. */
  const self = shield || merge;
  const deliver = p.deliver === 'CTK' && network === 'testnet' && !self ? 'CTK' : 'AUSD';
  const draft: Draft = self
    ? { network, to: wallet.address, amount: merge ? '0' : p.amount, deliver }
    : { network, to: p.to, toAddress: p.toAddress as Address | undefined, phone: p.phone, label: p.label, amount: p.amount, deliver };
  const kind: PrivateDraft['kind'] = merge ? 'merge' : shield ? 'shield' : draft.toAddress ? 'withdraw' : 'pay';
  /** To a private address (ender1…): private only, never public. */
  const privAddr = !self && isPrivateAddress(draft.to);
  const pdraft: PrivateDraft = { kind, amount: draft.amount, to: draft.toAddress ?? draft.phone ?? draft.to, phone: draft.phone };
  // Private or public is decided once, on arrival (it may ask the gateway whether the number takes private payments).
  const [route, setRoute] = useState<'private' | 'public' | undefined>(self ? 'private' : undefined);
  const priv = route === 'private';
  /** A private address the private balance can't pay (or no private balance on this network yet). */
  const blocked = privAddr && route === 'public';
  const [pq, setPq] = useState<PQuote>();

  const [phase, setPhase] = useState<Phase>({ k: 'review' });
  const [pipe, setPipe] = useState<Pipe>('internet');
  const [quote, setQuote] = useState<Quote>();
  const [times, setTimes] = useState<Partial<Record<Step, number>>>({});
  const [usedQuick, setUsedQuick] = useState(false);
  const [pasteNote, setPasteNote] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (!self) void decideRoute(draft).then(setRoute, () => setRoute('public'));
    void online().then((up) => setPipe(up ? 'internet' : 'text'));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mark = (step: Step) => setTimes((t) => ({ ...t, [step]: stamp() }));
  const recipientAddress = (quote?.to ?? draft.toAddress)?.toLowerCase();
  const isRecent =
    self ||
    (!!recipientAddress && recents.some((r) => r.address === recipientAddress)) ||
    (priv && !!draft.phone && recents.some((r) => r.phone === draft.phone)) ||
    (privAddr && recents.some((r) => r.address === draft.to));
  const quick = quickSend.covers(Number(draft.amount), isRecent);
  const name = draft.label ?? (draft.phone ? phoneDisplay(draft.phone) : short(draft.to));

  // ---------------------------------------------------------------- steps

  const fail = (step: Step, e: unknown, q?: Quote) =>
    setPhase({
      k: 'failed',
      step,
      message: e instanceof TransferError || e instanceof NoSmsError ? e.message : errorText(e),
      quote: q,
      code: e instanceof ApiError ? e.code : typeof e === 'string' ? e : undefined,
    });

  /** Not on Ender: the user invites them from their own phone. No money moves. */
  const invite = () =>
    whileOwnScreen(() =>
      SMS.sendSMSAsync([draft.phone!], `I want to send you money on Ender. Get the app and sign up with this number: https://ender.money`),
    ).catch(() => {});

  const start = async () => {
    setPhase({ k: 'working', step: 'request' });
    mark('request');
    if (await online()) {
      try {
        const q = await api.quote({ network, to: draft.to, amount: draft.amount, deliver });
        setPipe('internet');
        mark('quote');
        return afterQuote({ id: q.id, to: q.to, fee: q.fee, nonce: BigInt(q.nonce), deadline: q.deadline, pipe: 'internet', out: q.out });
      } catch (e) {
        if (!(e instanceof OfflineError)) return fail('request', e);
      }
    }
    setPipe('text');
    try {
      await textGateway({ kind: 'send', to: draft.to, amount: draft.amount, deliver });
      setPhase({ k: 'wait-quote' });
    } catch (e) {
      fail('request', e);
    }
  };

  const afterQuote = (q: Quote, pinAccepted = false) => {
    setQuote(q);
    try {
      const { pinChanged } = checkQuote(draft, q);
      if (pinChanged && !pinAccepted) return setPhase({ k: 'pin', quote: q });
    } catch (e) {
      return fail('quote', e, q);
    }
    void approve(q);
  };

  /** Signs with the open Quick send session when it covers this, else after a passkey prompt (which then opens one). */
  const withKey = async <R,>(toIsRecent: boolean, sign: (u: Unlocked) => Promise<R>): Promise<R> => {
    const amountUsd = Number(draft.amount);
    const session = quickSend.get();
    if (session && quickSend.covers(amountUsd, toIsRecent)) {
      const r = await sign(session.unlocked);
      quickSend.spend(amountUsd);
      setUsedQuick(true);
      return r;
    }
    const u = await unlockWallet({ credentialId: wallet.credentialId });
    if (u.address.toLowerCase() !== wallet.address.toLowerCase()) {
      lock(u);
      throw new TransferError('wrong-passkey', 'That passkey belongs to another wallet. Pick your Ender passkey.');
    }
    ensureRegistered(u);
    let r: R;
    try {
      r = await sign(u);
    } catch (e) {
      lock(u);
      throw e;
    }
    quickSend.open(u, amountUsd);
    return r;
  };

  const approve = async (q: Quote) => {
    setPhase({ k: 'working', step: 'approve' });
    const toIsRecent = getState().recents.some((r) => r.address === q.to.toLowerCase());
    let signature: Hex;
    try {
      signature = await withKey(toIsRecent, (u) => signQuote(u.account, draft, q));
    } catch (e) {
      return setPhase({ k: 'failed', step: 'approve', message: e instanceof TransferError ? e.message : (passkeyError(e) ?? 'Approval cancelled.'), quote: q });
    }
    mark('approve');
    rememberRecipient({ address: q.to, phone: draft.phone, name: draft.label });
    upsertTx({
      id: q.id,
      network,
      direction: 'out',
      amount: draft.amount,
      fee: q.fee,
      counterparty: q.to,
      label: draft.label ?? (draft.phone ? phoneDisplay(draft.phone) : undefined),
      status: 'sending',
      at: stamp(),
      deadline: q.deadline,
    });
    await submit(q, signature);
  };

  const submit = async (q: Quote, signature: Hex) => {
    if (await online()) {
      try {
        const r = await api.sign(q.id, signature);
        setPipe('internet');
        upsertTx({ id: q.id, txHash: r.txHash, status: r.pending ? 'sending' : 'sent' });
        if (r.pending) await pollUntilSettled(q);
        else finish(q, r.txHash);
        return;
      } catch (e) {
        if (!(e instanceof OfflineError)) {
          upsertTx({ id: q.id, status: 'failed', error: errorText(e) });
          return setPhase({ k: 'failed', step: 'sent', message: errorText(e), quote: q });
        }
      }
    }
    setPipe('text');
    try {
      const sms = { kind: 'sig', id: q.id, signature } as const;
      await textGateway(sms);
      setPhase({ k: 'wait-sent', id: q.id, sms });
    } catch (e) {
      setPhase({ k: 'failed', step: 'sent', message: e instanceof NoSmsError ? e.message : errorText(e), quote: q });
    }
  };

  const pollUntilSettled = async (q: Quote) => {
    while (msLeft(q) > -60_000) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api.tx(q.id).catch(() => null);
      if (s?.status === 'sent') return finish(q, s.txHash ?? undefined);
      if (s?.status === 'failed' || s?.status === 'expired') {
        upsertTx({ id: q.id, status: s.status, error: s.error ?? undefined });
        return setPhase({ k: 'failed', step: 'sent', message: errorText(s.error ?? s.status), quote: q });
      }
    }
    setPhase({ k: 'done' });
  };

  const finish = (q: Quote, txHash?: string) => {
    mark('sent');
    upsertTx({ id: q.id, status: 'sent', ...(txHash ? { txHash } : {}) });
    setPhase({ k: 'done', txHash });
  };

  // ---------------------------------------------------------------- private (shielded pool)

  const failPrivate = (step: Step, e: unknown) => {
    const code = e instanceof ApiError ? e.code : typeof e === 'string' ? e : undefined;
    if (!self && !privAddr && code && PUBLIC_INSTEAD.has(code)) setRoute('public');
    if (privAddr && code === 'NOUSER') return fail(step, new TransferError(code, "That private address isn't on Ender (or isn't on this network). Nothing was sent."));
    fail(step, e);
  };

  const startPrivate = async () => {
    setPhase({ k: 'working', step: 'request' });
    mark('request');
    if (await online()) {
      try {
        const q = await api.shieldedQuote({ network, kind, ...(merge ? {} : { amount: draft.amount }), ...(self ? {} : { to: draft.to }) });
        setPipe('internet');
        mark('quote');
        const to = q.to === undefined ? undefined : q.to.startsWith('0x') ? (q.to.toLowerCase() as Address) : (unb64(q.to.replace(/=+$/, ''), 64) ?? new Uint8Array());
        return afterPrivateQuote({ id: q.id, exp: q.exp, fee: q.fee, to, pipe: 'internet' });
      } catch (e) {
        if (!(e instanceof OfflineError)) return failPrivate('request', e);
      }
    }
    setPipe('text');
    try {
      await textGateway(merge ? { kind: 'merge' } : shield ? { kind: 'shield', amount: draft.amount } : { kind: 'pay', to: draft.to, amount: draft.amount });
      setPhase({ k: 'wait-quote' });
    } catch (e) {
      fail('request', e);
    }
  };

  const afterPrivateQuote = (quoted: PQuote) => {
    // A PAY to a private address comes back by text without to=: the key is the one the user gave.
    const q = privAddr && quoted.to === undefined ? { ...quoted, to: decodePrivateAddress(draft.to) ?? undefined } : quoted;
    setPq(q);
    const refused = checkShieldedQuote(pdraft, q, draft.phone ? getState().shieldedPins[draft.phone] : undefined);
    if (refused) return fail('quote', new TransferError(refused.code, refused.message));
    void approvePrivate(q);
  };

  const approvePrivate = async (q: PQuote) => {
    setPhase({ k: 'working', step: 'approve' });
    let signed: { sms: Command | ShieldedCommand; body: Parameters<typeof api.shieldedSubmit>[0]; awaiting: Awaiting };
    try {
      signed = await withKey(isRecent, async (u) => {
        if (shield) {
          const r = await signShield(u.shielded, u.account, draft.amount, q, network);
          return { sms: { kind: 'sig', id: q.id, signature: r.signature }, body: { id: q.id, signature: r.signature }, awaiting: r.awaiting };
        }
        await paint();
        const t0 = Date.now();
        const r = signPrivate(u.shielded, cache(network), pdraft, q, network);
        if (__DEV__) console.log(`[private] notes picked, transaction built and signed in ${Date.now() - t0} ms`);
        if ('err' in r) throw new TransferError(r.err, errorText(r.err));
        return {
          sms: { kind: 'shieldedSig', id: q.id, refs: r.refs, signature: r.sig },
          body: { id: q.id, refs: r.refs, sig: btoa(String.fromCharCode(...r.sig)) },
          awaiting: r.awaiting,
        };
      });
    } catch (e) {
      return setPhase({ k: 'failed', step: 'approve', message: e instanceof TransferError ? e.message : (passkeyError(e) ?? 'Approval cancelled.') });
    }
    mark('approve');
    holdNotes(network, signed.awaiting);
    const address = draft.toAddress ?? (draft.phone ? getState().pins[draft.phone] : undefined);
    if (!self && (address || privAddr)) rememberRecipient({ address: address ?? draft.to, phone: draft.phone, name: draft.label });
    upsertTx({
      id: q.id,
      network,
      direction: 'out',
      amount: draft.amount,
      fee: q.fee,
      counterparty: shield ? NETWORKS[network].pool : merge ? undefined : address,
      phone: draft.phone,
      ...(privAddr ? { to: draft.to } : {}),
      label: shield ? 'Private balance' : merge ? 'Merged private notes' : (draft.label ?? (draft.phone ? phoneDisplay(draft.phone) : undefined)),
      status: 'sending',
      at: stamp(),
      deadline: q.exp,
      private: true,
      ...(shield ? { shield: true as const } : {}),
    });
    await submitPrivate(q.id, signed.body, signed.sms);
  };

  const submitPrivate = async (id: string, body: Parameters<typeof api.shieldedSubmit>[0], sms: Command | ShieldedCommand) => {
    if (await online()) {
      try {
        const r = await api.shieldedSubmit(body);
        setPipe('internet');
        // Still landing: its notes stay held until a resync (pull to refresh) sees it.
        if (r.pending) {
          upsertTx({ id, txHash: r.tx });
          return setPhase({ k: 'done' });
        }
        settlePrivate(network, id, r.p);
        mark('sent');
        upsertTx({ id, status: 'sent', txHash: r.tx });
        return setPhase({ k: 'done', txHash: r.tx });
      } catch (e) {
        if (!(e instanceof OfflineError)) {
          releaseNotes(network, id);
          upsertTx({ id, status: 'failed', error: errorText(e) });
          return setPhase({ k: 'failed', step: 'sent', message: errorText(e) });
        }
      }
    }
    setPipe('text');
    try {
      await textGateway(sms);
      setPhase({ k: 'wait-sent', id, sms });
    } catch (e) {
      // Nothing left the phone: free the notes.
      releaseNotes(network, id);
      upsertTx({ id, status: 'failed' });
      setPhase({ k: 'failed', step: 'sent', message: e instanceof NoSmsError ? e.message : errorText(e) });
    }
  };

  // Replies that come back by text (copied from Messages, read on focus or pasted).
  useEffect(
    () =>
      onReply((r: Reply) => {
        const ph = phaseRef.current;
        // A reply names its own network ([Test] or not); one for the other network than this payment's is an error.
        const otherNetwork = textNetwork(r) !== network;
        const wrongNetwork = new TransferError('wrong-network', `That reply was for ${network === 'testnet' ? 'mainnet' : 'Test mode'}, not this payment. Check Activity before trying again.`);
        if (ph.k === 'wait-quote') {
          if ((r.kind === 'quote' || r.kind === 'shieldedQuote' || r.kind === 'error') && otherNetwork) fail('quote', wrongNetwork);
          else if (r.kind === 'quote') {
            mark('quote');
            afterQuote({ id: r.id, to: r.to, fee: r.fee, nonce: r.nonce, deadline: r.expires, pipe: 'text', out: r.out });
          } else if (r.kind === 'shieldedQuote') {
            mark('quote');
            afterPrivateQuote({ id: r.id, exp: r.expires, fee: r.fee, to: r.to, pipe: 'text' });
          } else if (r.kind === 'error') failPrivate('request', r.code);
        } else if (ph.k === 'wait-sent') {
          // The note cache is updated by the root listener (applyShieldedReply). Ours by id; an older gateway's
          // id-less text by amount.
          const ours = (r.kind === 'sent' || r.kind === 'shielded') && (r.id ? r.id === ph.id : Number(r.amount) === Number(draft.amount));
          if ((ours || (r.kind === 'error' && (!r.id || r.id === ph.id))) && otherNetwork) {
            upsertTx({ id: ph.id, status: 'failed', error: 'wrong-network' });
            setPhase({ k: 'failed', step: 'sent', message: wrongNetwork.message });
          } else if (ours) {
            mark('sent');
            upsertTx({ id: ph.id, status: 'sent' });
            setPhase({ k: 'done' });
          } else if (r.kind === 'error' && r.code === 'pending' && r.id === ph.id) {
            // Sent, not confirmed yet: like an online `pending`, its notes stay held until a resync sees it.
            setPhase({ k: 'done' });
          } else if (r.kind === 'error' && (!r.id || r.id === ph.id)) {
            releaseNotes(network, ph.id);
            upsertTx({ id: ph.id, status: 'failed', error: r.code });
            setPhase({ k: 'failed', step: 'sent', message: errorText(r.code) });
          }
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    setPasteNote(acceptReply(text) ? undefined : "That doesn't look like a reply from Ender. Copy the whole text and try again.");
  };

  // Never public to a private address, whatever the route says.
  const begin = () => void (priv ? startPrivate() : privAddr ? undefined : start());

  const retry = () => {
    if (phase.k !== 'failed') return;
    if (priv) {
      if (phase.step === 'approve' && pq && pq.exp * 1000 - Date.now() > 15_000) return void approvePrivate(pq);
      setPq(undefined);
      setTimes({});
      return begin();
    }
    const q = phase.quote;
    const live = q && msLeft(q) > 15_000;
    if (live && phase.step === 'approve') return void approve(q);
    setQuote(undefined);
    setTimes({});
    void start();
  };

  // ---------------------------------------------------------------- view

  const current: Step =
    phase.k === 'review' ? 'request'
    : phase.k === 'working' ? phase.step
    : phase.k === 'wait-quote' ? 'quote'
    : phase.k === 'pin' ? 'approve'
    : phase.k === 'wait-sent' ? 'sent'
    : phase.k === 'failed' ? phase.step
    : 'sent';
  const doneUpTo = phase.k === 'done' ? 4 : phase.k === 'review' ? 0 : ORDER.indexOf(current);
  const deadline = quote?.deadline ?? pq?.exp;
  const quotePipe = quote?.pipe ?? pq?.pipe;
  const left = deadline ? deadline * 1000 - now : 0;
  const fee = quote?.fee ?? pq?.fee ?? MAX_FEE;
  const busy = phase.k === 'working';

  const stepSub: Record<Step, string | undefined> = {
    request: times.request ? time(times.request) : undefined,
    quote: deadline ? (left > 0 ? `${quotePipe === 'text' ? 'Arrived by text · ' : ''}valid for ${countdown(left)}` : 'Expired') : phase.k === 'wait-quote' ? 'Waiting for the reply text' : undefined,
    approve: usedQuick || (phase.k === 'review' && quick) ? 'Quick send, no fingerprint' : 'Signs exactly what\'s above',
    sent: phase.k === 'wait-sent' ? 'Waiting for the reply text' : phase.k === 'done' ? (times.sent ? time(times.sent) : 'On its way') : undefined,
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, flexGrow: 1 }}>
        <BackHeader
          title={phase.k === 'done' ? (self ? 'Done' : 'Sent') : merge ? 'Merge' : 'Review'}
          right={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {network === 'testnet' ? <TestnetPill /> : null}
              <Chip label={pipe === 'internet' ? 'Internet' : 'Text'} icon={pipe === 'internet' ? <Globe size={14} color={c.positive} /> : <Message size={14} color={c.warning} />} />
            </View>
          }
        />
        <Card>
          {merge ? (
            <KV k="Private notes" v={`${MERGE_OVER} into 1`} />
          ) : shield ? (
            <>
              <KV k="From" v="Public balance" />
              <KV k="To" v="Private balance" />
            </>
          ) : (
            <>
              <KV k="To" v={name} />
              {draft.label && draft.phone ? <KV k="Number" v={phoneDisplay(draft.phone)} /> : null}
              {recipientAddress ? <KV k="Wallet" v={short(recipientAddress)} mono /> : null}
              {privAddr && draft.label ? <KV k="Address" v={short(draft.to)} mono /> : null}
              {priv ? (
                <KV
                  k="Payment"
                  v={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Shield size={16} color={c.positive} />
                      <T v="body" style={{ fontFamily: f.uiSemi, color: c.positive }}>Private</T>
                    </View>
                  }
                />
              ) : null}
            </>
          )}
          {merge ? null : <KV k="Amount" v={`$${usd(draft.amount)}`} />}
          <KV k="Fee" v={`$${usd(fee)}`} last={merge} />
          {merge ? null : <KV k="Total" v={`$${usd(total(draft.amount, fee))}`} last={deliver !== 'CTK'} />}
          {deliver === 'CTK' ? <KV k="They get" v={quote?.out ? `${Number(quote.out).toLocaleString('en-US', { maximumFractionDigits: 2 })} CTK` : 'CTK, quoted next'} last /> : null}
        </Card>
        {blocked ? (
          <View style={{ marginTop: 12 }}>
            <Banner icon={<Shield size={20} color={c.warning} />} tone="warning">
              Private addresses take private payments only, and your private balance doesn't cover ${usd(total(draft.amount, MAX_FEE))} with the fee. Make private first.
            </Banner>
          </View>
        ) : hasPool(network) && route === 'public' ? (
          <T v="meta" style={{ marginTop: 10, marginHorizontal: 4 }}>Public payment: amount and wallets are visible on Monad.</T>
        ) : null}

        <View style={{ marginTop: 24 }}>
          <StepRow title="Request sent" sub={stepSub.request} state={rowState('request', doneUpTo, current, phase)} />
          <StepRow title="Quote received" sub={stepSub.quote} state={rowState('quote', doneUpTo, current, phase)} />
          <StepRow title={usedQuick || (phase.k === 'review' && quick) ? 'Approve with Quick send' : 'Approve with fingerprint'} sub={stepSub.approve} state={rowState('approve', doneUpTo, current, phase)} />
          <StepRow title="Sent" sub={stepSub.sent} state={rowState('sent', doneUpTo, current, phase)} last />
        </View>

        <View style={{ flex: 1, minHeight: 24 }} />
        <View style={{ gap: 12, marginTop: 12 }}>
          {pipe === 'text' && phase.k !== 'done' ? <Banner icon={<Message size={20} color={c.warning} />} tone="warning">No internet, sending over SMS.</Banner> : null}
          {deliver === 'CTK' && phase.k !== 'done' ? <Banner>CTK is Agora's test token, standing in for local currency. Swapped at a fixed price, settled in the same transaction.</Banner> : null}
          {phase.k === 'review' && quick ? <Banner icon={<Bolt size={20} color={c.accent} />}>Sending without fingerprint (Quick send).</Banner> : null}
          {phase.k === 'wait-quote' || phase.k === 'wait-sent' ? (
            <Banner>When Ender's reply arrives, copy it in Messages and come back. It's read automatically.</Banner>
          ) : null}
          {pasteNote ? <Banner tone="negative">{pasteNote}</Banner> : null}
          {phase.k === 'pin' ? (
            <Banner tone="warning">
              {name} now points to a different wallet ({short(phase.quote.to)}) than the one you paid before. Only continue if they told you they changed wallets.
            </Banner>
          ) : null}
          {phase.k === 'failed' ? <Banner tone="negative">{phase.message}</Banner> : null}
          {phase.k === 'done' && phase.txHash ? <Banner icon={<Check size={20} color={c.positive} />}>Settled on Monad.</Banner> : null}
        </View>
      </ScrollView>

      <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 4 }}>
        {blocked && phase.k === 'review' ? (
          <>
            <Button title="Make private" onPress={() => router.replace({ pathname: '/send', params: { shield: '1' } })} />
            <Button title="Cancel" kind="text" onPress={() => router.back()} />
          </>
        ) : phase.k === 'review' || busy ? (
          <Button
            title={
              merge ? (quick ? 'Merge with Quick send' : 'Approve & merge')
              : shield ? (quick ? 'Make private with Quick send' : 'Approve & make private')
              : quick ? 'Send with Quick send' : 'Approve & send'
            }
            onPress={begin}
            busy={busy || route === undefined}
          />
        ) : null}
        {phase.k === 'wait-quote' || phase.k === 'wait-sent' ? (
          <>
            <Button title="Paste reply" onPress={paste} />
            <Button
              title="Text again"
              kind="text"
              onPress={() =>
                phase.k === 'wait-quote' ? begin() : void textGateway(phase.sms).catch((e) => fail('sent', e))
              }
            />
          </>
        ) : null}
        {phase.k === 'pin' ? (
          <>
            <Button title="Send anyway" onPress={() => afterQuote(phase.quote, true)} />
            <Button title="Cancel" kind="text" onPress={() => router.back()} />
          </>
        ) : null}
        {phase.k === 'failed' && phase.code === 'not-on-ender' && draft.phone ? (
          <>
            <Button title="Invite them" onPress={invite} />
            <Button title="Cancel" kind="text" onPress={() => router.back()} />
          </>
        ) : phase.k === 'failed' ? (
          <>
            <Button title="Try again" onPress={retry} />
            <Button title="Cancel" kind="text" onPress={() => router.back()} />
          </>
        ) : null}
        {phase.k === 'done' ? <Button title="Done" onPress={() => router.dismissTo('/home')} /> : null}
      </View>
    </SafeAreaView>
  );
}

type RowState = 'todo' | 'now' | 'done' | 'failed';
const rowState = (step: Step, doneUpTo: number, current: Step, phase: Phase): RowState => {
  const i = ORDER.indexOf(step);
  if (phase.k === 'failed' && step === current) return 'failed';
  if (i < doneUpTo) return 'done';
  if (step === current && phase.k !== 'review') return 'now';
  return 'todo';
};

const StepRow = ({ title, sub, state, last }: { title: string; sub?: string; state: RowState; last?: boolean }) => (
  <View style={{ flexDirection: 'row', gap: 16, minHeight: 64 }}>
    <View style={{ alignItems: 'center', width: 28 }}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: state === 'done' ? c.accent : c.surface2,
          borderWidth: state === 'done' ? 0 : state === 'now' || state === 'failed' ? 2 : 1,
          borderColor: state === 'failed' ? c.negative : state === 'now' ? c.accent : c.line,
        }}
      >
        {state === 'done' ? <Check size={16} color={c.accentInk} width={2.6} /> : state === 'now' ? <Spinner /> : null}
      </View>
      {!last ? <View style={{ width: 2, flex: 1, backgroundColor: state === 'done' ? c.accent : c.line, marginVertical: 4 }} /> : null}
    </View>
    <View style={{ flex: 1, paddingBottom: 14 }}>
      <T v="body" style={{ color: state === 'todo' ? c.fg2 : state === 'failed' ? c.negative : c.fg, paddingTop: 2 }}>{title}</T>
      {sub ? <T v="meta" style={{ fontSize: 15, marginTop: 2, fontFamily: f.ui }}>{sub}</T> : null}
    </View>
  </View>
);

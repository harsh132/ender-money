import * as Clipboard from 'expo-clipboard';
import * as SMS from 'expo-sms';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Address, Hex } from 'viem';
import type { Reply } from '../../../protocol/sms';
import { api, ApiError, OfflineError } from '../lib/api';
import { MAX_FEE } from '../lib/config';
import { countdown, phoneDisplay, short, time, usd } from '../lib/format';
import { passkeyError, quickSend, unlockWallet, whileOwnScreen } from '../lib/keys';
import { getState, rememberRecipient, upsertTx, useStore } from '../lib/store';
import { c, f } from '../lib/theme';
import { acceptReply, NoSmsError, onReply, online, textGateway, type Pipe } from '../lib/transport';
import { checkQuote, errorText, signQuote, TransferError, type Draft, type Quote } from '../lib/wallet';
import { Bolt, Check, Globe, Message } from '../ui/icons';
import { BackHeader, Banner, Button, Card, Chip, KV, Spinner, T, TestnetPill } from '../ui/kit';

type Step = 'request' | 'quote' | 'approve' | 'sent';
const ORDER: Step[] = ['request', 'quote', 'approve', 'sent'];

type Phase =
  | { k: 'review' }
  | { k: 'working'; step: Step }
  | { k: 'wait-quote' }
  | { k: 'pin'; quote: Quote }
  | { k: 'wait-sent'; quote: Quote; signature: Hex }
  | { k: 'done'; txHash?: string }
  | { k: 'failed'; step: Step; message: string; quote?: Quote; code?: string };

const total = (amount: string, fee: string) => (Number(amount) + Number(fee)).toFixed(6);
/** Milliseconds until the quote's signed deadline. Only called from handlers, not render. */
const msLeft = (q: Quote) => q.deadline * 1000 - Date.now();
const stamp = () => Date.now();

/** Review, then the same screen tracks progress: Request sent -> Quote received -> Approve -> Sent. */
export default function Review() {
  const p = useLocalSearchParams<{ to: string; toAddress?: string; phone?: string; label?: string; amount: string; deliver?: string }>();
  const network = useStore((s) => s.network);
  const wallet = useStore((s) => s.wallet)!;
  const recents = useStore((s) => s.recents);
  const deliver = p.deliver === 'CTK' && network === 'testnet' ? 'CTK' : 'AUSD';
  const draft: Draft = { network, to: p.to, toAddress: p.toAddress as Address | undefined, phone: p.phone, label: p.label, amount: p.amount, deliver };

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
    void online().then((up) => setPipe(up ? 'internet' : 'text'));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const mark = (step: Step) => setTimes((t) => ({ ...t, [step]: stamp() }));
  const recipientAddress = (quote?.to ?? draft.toAddress)?.toLowerCase();
  const isRecent = !!recipientAddress && recents.some((r) => r.address === recipientAddress);
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

  const approve = async (q: Quote) => {
    setPhase({ k: 'working', step: 'approve' });
    const amountUsd = Number(draft.amount);
    const toIsRecent = getState().recents.some((r) => r.address === q.to.toLowerCase());
    let signature: Hex;
    try {
      const session = quickSend.get();
      if (session && quickSend.covers(amountUsd, toIsRecent)) {
        signature = await signQuote(session.unlocked.account, draft, q);
        quickSend.spend(amountUsd);
        setUsedQuick(true);
      } else {
        const u = await unlockWallet({ credentialId: wallet.credentialId });
        if (u.address.toLowerCase() !== wallet.address.toLowerCase()) {
          u.session.end();
          throw new TransferError('wrong-passkey', 'That passkey belongs to another wallet. Pick your Ender passkey.');
        }
        signature = await signQuote(u.account, draft, q);
        quickSend.open(u, amountUsd);
      }
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
      await textGateway({ kind: 'sig', id: q.id, signature });
      setPhase({ k: 'wait-sent', quote: q, signature });
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

  // Replies that come back by text (copied from Messages, read on focus or pasted).
  useEffect(
    () =>
      onReply((r: Reply) => {
        const ph = phaseRef.current;
        if (ph.k === 'wait-quote') {
          if (r.kind === 'quote') {
            mark('quote');
            afterQuote({ id: r.id, to: r.to, fee: r.fee, nonce: r.nonce, deadline: r.expires, pipe: 'text', out: r.out });
          } else if (r.kind === 'error') fail('request', r.code);
        } else if (ph.k === 'wait-sent') {
          if (r.kind === 'sent') {
            mark('sent');
            upsertTx({ id: ph.quote.id, status: 'sent' });
            setPhase({ k: 'done' });
          } else if (r.kind === 'error' && (!r.id || r.id === ph.quote.id)) {
            upsertTx({ id: ph.quote.id, status: 'failed', error: r.code });
            setPhase({ k: 'failed', step: 'sent', message: errorText(r.code), quote: ph.quote });
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

  const retry = () => {
    if (phase.k !== 'failed') return;
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
  const left = quote ? quote.deadline * 1000 - now : 0;
  const fee = quote?.fee ?? MAX_FEE;
  const busy = phase.k === 'working';

  const stepSub: Record<Step, string | undefined> = {
    request: times.request ? time(times.request) : undefined,
    quote: quote ? (left > 0 ? `${quote.pipe === 'text' ? 'Arrived by text · ' : ''}valid for ${countdown(left)}` : 'Expired') : phase.k === 'wait-quote' ? 'Waiting for the reply text' : undefined,
    approve: usedQuick || (phase.k === 'review' && quick) ? 'Quick send, no fingerprint' : 'Signs exactly what\'s above',
    sent: phase.k === 'wait-sent' ? 'Waiting for the reply text' : phase.k === 'done' ? (times.sent ? time(times.sent) : 'On its way') : undefined,
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, flexGrow: 1 }}>
        <BackHeader
          title={phase.k === 'done' ? 'Sent' : 'Review'}
          right={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {network === 'testnet' ? <TestnetPill /> : null}
              <Chip label={pipe === 'internet' ? 'Internet' : 'Text'} icon={pipe === 'internet' ? <Globe size={14} color={c.positive} /> : <Message size={14} color={c.warning} />} />
            </View>
          }
        />
        <Card>
          <KV k="To" v={name} />
          {draft.label && draft.phone ? <KV k="Number" v={phoneDisplay(draft.phone)} /> : null}
          {recipientAddress ? <KV k="Wallet" v={short(recipientAddress)} mono /> : null}
          <KV k="Amount" v={`$${usd(draft.amount)}`} />
          <KV k="Fee" v={`$${usd(fee)}`} />
          <KV k="Total" v={`$${usd(total(draft.amount, fee))}`} last={deliver !== 'CTK'} />
          {deliver === 'CTK' ? <KV k="They get" v={quote?.out ? `${Number(quote.out).toLocaleString('en-US', { maximumFractionDigits: 2 })} CTK` : 'CTK, quoted next'} last /> : null}
        </Card>

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
        {phase.k === 'review' || busy ? <Button title={quick ? 'Send with Quick send' : 'Approve & send'} onPress={start} busy={busy} /> : null}
        {phase.k === 'wait-quote' || phase.k === 'wait-sent' ? (
          <>
            <Button title="Paste reply" onPress={paste} />
            <Button
              title="Text again"
              kind="text"
              onPress={() =>
                phase.k === 'wait-quote'
                  ? void start()
                  : void textGateway({ kind: 'sig', id: phase.quote.id, signature: phase.signature }).catch((e) => fail('sent', e, phase.quote))
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

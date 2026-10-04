/**
 * Inbound SMS → session core → reply text. Transport-agnostic: the relay
 * phone and Twilio both hand over `(from, body)` and send back whatever this
 * returns.
 *
 * Silence is a feature here. The relay SIM also receives carrier promos, bank
 * alerts and stray texts; replying to those costs money and invites loops. So
 * non-personal senders get nothing, and a number that isn't on Ender only gets
 * an answer if it sent a well-formed command.
 */
import { isAddress } from 'viem';
import { parseCommand, parseShieldedCommand, formatReply, normalizePhone, shortHex, unb64, withRetrieverHash, type Reply, type ShieldedCommand } from '../../protocol/sms';
import type { NetworkName } from '../../protocol/networks';
import { account, GatewayError, quote, sign } from './core';
import type { Env } from './env';
import * as shielded from './shielded';

/** The only network with a pool; private SMS commands carry no network. */
const SHIELDED_NETWORK: NetworkName = 'testnet';

export type Inbound = { from: string; body: string };
/** `to` is the E.164 number to answer, `body` the one-segment reply. */
export type Outbound = { to: string; body: string };

export const handleInbound = async (env: Env, { from: rawFrom, body }: Inbound): Promise<Outbound | null> => {
  const from = normalizePhone(rawFrom);
  if (!from) return null;
  const command = parseCommand(body);
  if (!command) {
    const private_ = parseShieldedCommand(body);
    if (private_) return handleShielded(env, from, private_);
    const known = await env.DB.prepare('SELECT 1 FROM links WHERE phone = ?').bind(from).first();
    return known ? reply(env, from, { kind: 'error', code: 'bad-command' }) : null;
  }

  try {
    switch (command.kind) {
      case 'sync': {
        const a = await account(env, from, command.network);
        return reply(env, from, { kind: 'ok', nonce: BigInt(a.nonce), delegated: a.delegated, balance: a.balance, inr: a.inr });
      }
      case 'send': {
        const q = await quote(env, from, { to: command.to, amount: command.amount, deliver: command.deliver });
        return reply(env, from, { kind: 'quote', id: q.id, nonce: BigInt(q.nonce), expires: q.deadline, fee: q.fee, to: q.to, out: q.out });
      }
      case 'sig': {
        // A deposit's SIG has the public shape (a 65-byte EIP-3009 signature); its quote id says which it is.
        if ((await shielded.quoteKind(env, from, command.id)) === 'shield') {
          const r = await shielded.submit(env, from, { id: command.id, signature: command.signature });
          if (r.pending || r.p === undefined) return reply(env, from, { kind: 'error', id: command.id, code: 'pending' });
          return reply(env, from, { kind: 'shielded', amount: r.amount, tx: shortHex(r.tx), p: r.p });
        }
        const r = await sign(env, from, command.id, command.signature);
        return reply(env, from, { kind: 'sent', amount: r.amount, to: shortHex(r.to), tx: shortHex(r.txHash) });
      }
    }
  } catch (error) {
    const id = command.kind === 'sig' ? command.id : undefined;
    if (error instanceof GatewayError) return reply(env, from, { kind: 'error', id, code: error.code });
    console.error('sms: unhandled', error instanceof Error ? error.stack : error);
    return reply(env, from, { kind: 'error', id, code: 'internal' });
  }
};

/** PAY / SHIELD / MERGE and the private SIG (refs + 64-byte signature). */
const handleShielded = async (env: Env, from: string, command: ShieldedCommand): Promise<Outbound | null> => {
  const network = SHIELDED_NETWORK;
  try {
    if (command.kind === 'shieldedSig') {
      const r = await shielded.submit(env, from, { id: command.id, refs: command.refs, sig: command.signature });
      // Sent but unconfirmed: a Sent now would carry no change position. A repeated SIG answers once it lands.
      if (r.pending) return reply(env, from, { kind: 'error', id: command.id, code: 'pending' });
      const to = isAddress(r.to) ? shortHex(r.to) : r.to;
      return reply(env, from, { kind: 'sent', amount: r.amount, to, tx: shortHex(r.tx), p: r.p });
    }
    const req: shielded.ShieldedQuoteRequest =
      command.kind === 'pay'
        ? { network, kind: isAddress(command.to) ? 'withdraw' : 'pay', to: command.to, amount: command.amount }
        : command.kind === 'shield'
          ? { network, kind: 'shield', amount: command.amount }
          : { network, kind: 'merge' };
    const q = await shielded.quote(env, from, req); // warms the prover; the Relay object stays up while it runs
    return reply(env, from, { kind: 'shieldedQuote', id: q.id, expires: q.exp, fee: q.fee, to: q.to === undefined ? undefined : isAddress(q.to) ? q.to : unb64(q.to, 64)! });
  } catch (error) {
    const id = command.kind === 'shieldedSig' ? command.id : undefined;
    if (error instanceof GatewayError) return reply(env, from, { kind: 'error', id, code: error.code });
    console.error('sms: unhandled', error instanceof Error ? error.stack : error);
    return reply(env, from, { kind: 'error', id, code: 'internal' });
  }
};

const reply = (env: Env, to: string, r: Reply): Outbound => ({ to, body: withRetrieverHash(formatReply(r), env.SMS_RETRIEVER_HASH) });

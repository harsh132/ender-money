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
import { parseCommand, formatReply, normalizePhone, shortHex, withRetrieverHash, type Reply } from '../../protocol/sms';
import { account, GatewayError, quote, sign } from './core';
import type { Env } from './env';

export type Inbound = { from: string; body: string };
/** `to` is the E.164 number to answer, `body` the one-segment reply. */
export type Outbound = { to: string; body: string };

export const handleInbound = async (env: Env, { from: rawFrom, body }: Inbound): Promise<Outbound | null> => {
  const from = normalizePhone(rawFrom);
  if (!from) return null;
  const command = parseCommand(body);
  if (!command) {
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

const reply = (env: Env, to: string, r: Reply): Outbound => ({ to, body: withRetrieverHash(formatReply(r), env.SMS_RETRIEVER_HASH) });

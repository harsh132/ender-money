/**
 * Inbound SMS → session core → reply text. Transport-agnostic: the relay
 * phone and Twilio both hand over `(from, body)` and send back whatever this
 * returns.
 *
 * Silence is a feature here. The relay SIM also receives carrier promos, bank
 * alerts and stray texts; replying to those costs money and invites loops. So
 * non-personal senders get nothing, and a number that isn't on Ender only gets
 * an answer if it sent a well-formed command (ERR not-registered).
 *
 * A text acts for the account holding the sender's verified number; an account
 * without one has no SMS path at all.
 */
import { isAddress } from 'viem';
import { parseCommand, parseShieldedCommand, formatReply, isPhone, normalizePhone, shortHex, unb64, withRetrieverHash, type Parsed, type Reply, type ShieldedCommand } from '../../protocol/sms';
import type { NetworkName } from '../../protocol/networks';
import { parseEnderId } from '../../protocol/names';
import { isPrivateAddress, shortPrivateAddress } from '../../protocol/recipient';
import { account, accountOfPhone, GatewayError, quote, sign } from './core';
import type { Env } from './env';
import { idOfAddress } from './names';
import * as shielded from './shielded';

/** A SIG whose prefix names another network than its quote's is refused (unprefixed: an older app, the quote's own). */
const sameNetwork = (named: NetworkName | undefined, quoted: NetworkName | undefined) => {
  if (named && quoted && named !== quoted) throw new GatewayError('wrong-network', 409);
};

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

  // The network the reply is about, for its [Test] tag (an ERR too); unknown for a number or session that doesn't exist.
  let network: NetworkName | undefined;
  try {
    // The prefix names the network: `[Test] SEND` is testnet, no prefix is mainnet; a SIG's quote says, once found.
    network = command.kind === 'sig' ? command.network : (command.network ?? 'mainnet');
    const me = await accountOfPhone(env, from);
    switch (command.kind) {
      case 'sync': {
        const a = await account(env, me, network);
        return reply(env, from, { kind: 'ok', nonce: BigInt(a.nonce), delegated: a.delegated, balance: a.balance, inr: a.inr }, a.network);
      }
      case 'send': {
        const q = await quote(env, me, { network, to: command.to, amount: command.amount, deliver: command.deliver });
        return reply(env, from, { kind: 'quote', id: q.id, nonce: BigInt(q.nonce), expires: q.deadline, fee: q.fee, to: q.to, out: q.out }, q.network);
      }
      case 'sig': {
        // A deposit's SIG has the public shape (a 65-byte EIP-3009 signature); its quote id says which it is.
        const deposit = await shielded.quoteOf(env, me, command.id);
        if (deposit?.kind === 'shield') {
          network = command.network ?? deposit.network;
          sameNetwork(command.network, deposit.network);
          const r = await shielded.submit(env, me, { id: command.id, signature: command.signature });
          if (r.pending || r.p === undefined) return reply(env, from, { kind: 'error', id: command.id, code: 'pending' }, network);
          return reply(env, from, { kind: 'shielded', id: command.id, amount: r.amount, tx: shortHex(r.tx), p: r.p }, network);
        }
        const session = await env.DB.prepare('SELECT network, recipient FROM sessions WHERE id = ? AND account = ?')
          .bind(command.id, me)
          .first<{ network: NetworkName; recipient: string | null }>();
        network = command.network ?? session?.network;
        sameNetwork(command.network, session?.network);
        const r = await sign(env, me, command.id, command.signature);
        const to = await sentTo(env, session?.recipient, r.to);
        return reply(env, from, { kind: 'sent', id: command.id, amount: r.amount, to, tx: shortHex(r.txHash) }, network);
      }
    }
  } catch (error) {
    const id = command.kind === 'sig' ? command.id : undefined;
    if (error instanceof GatewayError) return reply(env, from, { kind: 'error', id, code: error.code }, network);
    console.error('sms: unhandled', error instanceof Error ? error.stack : error);
    return reply(env, from, { kind: 'error', id, code: 'internal' }, network);
  }
};

/**
 * PAY / SHIELD / MERGE and the private SIG (refs + 64-byte signature). The prefix names the network, as for
 * public commands: `[Test] ` is testnet, no prefix mainnet; an unprefixed SIG, its quote's.
 */
const handleShielded = async (env: Env, from: string, command: Parsed<ShieldedCommand>): Promise<Outbound | null> => {
  let network: NetworkName = command.network ?? 'mainnet';
  try {
    const me = await accountOfPhone(env, from);
    if (command.kind === 'shieldedSig') {
      const quoted = (await shielded.quoteOf(env, me, command.id))?.network;
      network = command.network ?? quoted ?? network;
      sameNetwork(command.network, quoted);
      const r = await shielded.submit(env, me, { id: command.id, refs: command.refs, sig: command.signature });
      // Sent but unconfirmed: a Sent now would carry no change position. A repeated SIG answers once it lands.
      if (r.pending) return reply(env, from, { kind: 'error', id: command.id, code: 'pending' }, network);
      // r.to: the number, Ender ID or ender1 address paid, the 0x address withdrawn to, or our own address (MERGE).
      const to = await sentTo(env, r.to, r.to, r.toAccount);
      return reply(env, from, { kind: 'sent', id: command.id, amount: r.amount, to, tx: shortHex(r.tx), p: r.p }, network);
    }
    const req: shielded.ShieldedQuoteRequest =
      command.kind === 'pay'
        ? { network, kind: isAddress(command.to) ? 'withdraw' : 'pay', to: command.to, amount: command.amount }
        : command.kind === 'shield'
          ? { network, kind: 'shield', amount: command.amount }
          : { network, kind: 'merge' };
    const q = await shielded.quote(env, me, req); // warms the prover; the Relay object stays up while it runs
    // A PAY to an ender1 address gets no to=: the phone already has that key, and checks the payment against it.
    const to = q.to === undefined || (command.kind === 'pay' && isPrivateAddress(command.to)) ? undefined : isAddress(q.to) ? q.to : unb64(q.to, 64)!;
    return reply(env, from, { kind: 'shieldedQuote', id: q.id, expires: q.exp, fee: q.fee, to }, network);
  } catch (error) {
    const id = command.kind === 'shieldedSig' ? command.id : undefined;
    if (error instanceof GatewayError) return reply(env, from, { kind: 'error', id, code: error.code }, network);
    console.error('sms: unhandled', error instanceof Error ? error.stack : error);
    return reply(env, from, { kind: 'error', id, code: 'internal' }, network);
  }
};

/**
 * Sent's to=: the number the payment was asked for by, else the recipient's Ender ID (also when it was paid by
 * 0x or ender1 address), else that address, short. `asked`: what the payment named (a number, an Ender ID, an
 * address); `owner`: the account behind a private address, used only to find its Ender ID.
 */
export const sentTo = async (env: Env, asked: string | null | undefined, address: string, owner?: string | null) => {
  if (asked && (isPhone(asked) || parseEnderId(asked))) return asked;
  const id = owner ? await idOfAddress(env, owner) : isAddress(address) ? await idOfAddress(env, address) : null;
  return id ?? (isAddress(address) ? shortHex(address) : isPrivateAddress(address) ? shortPrivateAddress(address) : address);
};

/** Every text about testnet starts with `[Test] `, so the app files it under that network. */
const reply = (env: Env, to: string, r: Reply, network?: NetworkName): Outbound => ({
  to,
  body: withRetrieverHash(formatReply({ ...r, test: network === 'testnet' }), env.SMS_RETRIEVER_HASH),
});

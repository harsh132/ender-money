/**
 * ENS for `<label>.ender.my`, over CCIP-Read (EIP-3668). Ported from
 * ender-backend; the stealth address per lookup is gone: a name answers with
 * the account's public address, the one wallet that is the user's on every EVM
 * chain.
 *
 * `ender.my` is a gasless DNS name (ENSIP-17): its TXT record points at
 * `EnderResolver` on Ethereum (RESOLVER_ADDRESS), which reverts with
 * `OffchainLookup`; the client fetches the answer here and the contract accepts
 * it only if RESOLVER_SIGNER_KEY signed it for that exact request. Every answer
 * is signed, the empty ones too: an unsigned or failed answer reads to a sender
 * as "this name is broken", and an error would tell a prober which names exist.
 */
import { bytesToString, decodeFunctionData, encodeAbiParameters, encodePacked, hexToBytes, isHex, keccak256, parseAbi, slice, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { enderId, NAME_PARENT } from '../../protocol/names';
import type { Env } from './env';
import { byLabel } from './names';

const EXTENDED_RESOLVER_ABI = parseAbi(['function resolve(bytes name, bytes data) returns (bytes)']);
const RESOLVER_ABI = parseAbi([
  'function addr(bytes32 node) returns (address)',
  'function addr(bytes32 node, uint256 coinType) returns (bytes)',
  'function text(bytes32 node, string key) returns (string)',
  'function name(bytes32 node) returns (string)',
]);

const ADDR = '0x3b3b57de';
const ADDR_COIN_TYPE = '0xf1cb7e06';
const TEXT = '0x59d1d43c';
const NAME = '0x691f3431';

/** ENSIP-11: Ethereum keeps 60; every other EVM chain is 0x80000000 | chainId (Monad: 0x8000008f), 0x80000000 the default (ENSIP-19). */
const ETH_COIN_TYPE = 60n;
const isEvmCoinType = (t: bigint) => t === ETH_COIN_TYPE || (t >= 0x80000000n && t <= 0xffffffffn);

/** A signed answer's lifetime: it only has to outlive the client's round trip. */
export const SIGNATURE_TTL_SECONDS = 60;

/** DNS wire format, strictly: no compression, nothing after the terminator. The name decides whose address answers. */
export const decodeDnsName = (encoded: Hex): string[] => {
  const bytes = hexToBytes(encoded);
  const labels: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset]!;
    if (length === 0) {
      if (offset !== bytes.length - 1) throw new Error('Trailing bytes after DNS name terminator.');
      return labels;
    }
    if (length > 63) throw new Error('Invalid DNS label length.');
    const end = offset + 1 + length;
    if (end > bytes.length) throw new Error('DNS label runs past end of name.');
    labels.push(bytesToString(bytes.slice(offset + 1, end)));
    offset = end;
  }
  throw new Error('DNS name is not terminated.');
};

/** `<label>.ender.my` -> label. Everything after the first label is the parent, so `a.harsh.ender.my` is refused, never read as `a`. */
export const labelOf = (labels: string[]) => {
  if (labels.length < 2) throw new Error('Name has no label under a parent.');
  const parent = labels.slice(1).join('.').toLowerCase();
  if (parent !== NAME_PARENT) throw new Error(`Unknown parent: ${parent}`);
  return labels[0]!.toLowerCase();
};

/** The caller's mistake: a name we don't serve, or calldata we can't read. */
export class ResolveError extends Error {}

/** "No record" in the shape the selector expects; `addr` must be the zero address, empty bytes revert most clients. */
const emptyResult = (selector: Hex): Hex => {
  if (selector === ADDR) return encodeAbiParameters([{ type: 'address' }], [zeroAddress]);
  if (selector === TEXT || selector === NAME) return encodeAbiParameters([{ type: 'string' }], ['']);
  return encodeAbiParameters([{ type: 'bytes' }], ['0x']);
};

/** The digest `EnderResolver.makeSignatureHash` builds: EIP-191 version 0x00 with the resolver as validator. */
export const makeSignatureHash = ({ target, expires, request, result }: { target: `0x${string}`; expires: bigint; request: Hex; result: Hex }): Hex =>
  keccak256(encodePacked(['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'], ['0x1900', target, expires, keccak256(request), keccak256(result)]));

/** `abi.encode(result, expires, signature)`, what `resolveCallback` decodes. Raw ECDSA over the digest, no message prefix. */
const signAnswer = async (env: Env, request: Hex, result: Hex, now: number): Promise<Hex> => {
  const expires = BigInt(Math.floor(now / 1000) + SIGNATURE_TTL_SECONDS);
  const hash = makeSignatureHash({ target: env.RESOLVER_ADDRESS as `0x${string}`, expires, request, result });
  const signature = await privateKeyToAccount(env.RESOLVER_SIGNER_KEY as Hex).sign({ hash });
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }], [result, expires, signature]);
};

/**
 * One `resolve(name, data)`: `addr` for Ethereum and any EVM coin type is the
 * public address, `text("url")` the pay page, `name` the name; anything else,
 * and any name nobody holds, is the signed empty answer.
 */
export const resolve = async (env: Env, callData: Hex, now = Date.now()): Promise<Hex> => {
  let label: string;
  let inner: Hex;
  let selector: Hex;
  try {
    const [name, data] = decodeFunctionData({ abi: EXTENDED_RESOLVER_ABI, data: callData }).args as [Hex, Hex];
    inner = data;
    selector = slice(inner, 0, 4);
    label = labelOf(decodeDnsName(name));
  } catch (error) {
    throw new ResolveError(error instanceof Error ? error.message : 'Malformed request.');
  }

  let result = emptyResult(selector);
  const known = [ADDR, ADDR_COIN_TYPE, TEXT, NAME].includes(selector) ? await byLabel(env, label) : null;
  if (known) {
    let args: readonly unknown[];
    try {
      args = decodeFunctionData({ abi: RESOLVER_ABI, data: inner }).args ?? [];
    } catch {
      throw new ResolveError('Malformed record request.');
    }
    if (selector === ADDR) result = encodeAbiParameters([{ type: 'address' }], [known.address]);
    else if (selector === ADDR_COIN_TYPE && isEvmCoinType(args[1] as bigint)) result = encodeAbiParameters([{ type: 'bytes' }], [known.address]);
    else if (selector === TEXT && args[1] === 'url') result = encodeAbiParameters([{ type: 'string' }], [`https://${enderId(label)}`]);
    else if (selector === NAME) result = encodeAbiParameters([{ type: 'string' }], [enderId(label)]);
  }
  // Signed over exactly the bytes we were given; the contract passes them back as extraData, so an answer can't be
  // lifted onto another name or record.
  return signAnswer(env, callData, result, now);
};

/** Wallets and dapps resolve from browsers too; nothing here is per-user. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

/** `GET /ccip/{sender}/{data}.json` and `POST /ccip {sender, data}`, both EIP-3668. */
export const handleCcip = async (request: Request, url: URL, env: Env): Promise<Response> => {
  if (!env.RESOLVER_SIGNER_KEY || !env.RESOLVER_ADDRESS) return reply({ message: 'Resolver not configured.' }, 503);
  let sender: unknown;
  let data: unknown;
  if (request.method === 'POST' && url.pathname === '/ccip') {
    const body = (await request.json().catch(() => null)) as { sender?: unknown; data?: unknown } | null;
    sender = body?.sender;
    data = body?.data;
  } else if (request.method === 'GET') {
    const m = /^\/ccip\/([^/]+)\/([^/]+?)(?:\.json)?$/.exec(url.pathname);
    sender = m?.[1];
    data = m?.[2];
  } else return reply({ message: 'Not found.' }, 404);

  if (typeof sender !== 'string' || !isHex(sender) || sender.length !== 42) return reply({ message: 'Invalid sender.' }, 400);
  if (typeof data !== 'string' || !isHex(data)) return reply({ message: 'Invalid call data.' }, 400);
  // `sender` is not checked against our resolver: a DNS name reaches it through ENS's OffchainDNSResolver, which
  // re-raises our OffchainLookup as its own. The answer is signed for EnderResolver and this request either way.
  try {
    return reply({ data: await resolve(env, data) });
  } catch (error) {
    if (error instanceof ResolveError) return reply({ message: error.message }, 400);
    throw error;
  }
};

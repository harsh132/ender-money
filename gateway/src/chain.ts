import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { NETWORKS, type NetworkName } from '../../protocol/networks';
import type { Env } from './env';

export const isNetwork = (n: unknown): n is NetworkName => n === 'mainnet' || n === 'testnet';

export const rpcUrl = (env: Env, network: NetworkName) =>
  (network === 'mainnet' ? env.RPC_MAINNET : env.RPC_TESTNET) || NETWORKS[network].chain.rpcUrls.default.http[0]!;

/**
 * No JSON-RPC batching: viem's batch scheduler shares one pending request
 * across callers, and the Workers runtime cancels a request whose promise is
 * resolved from another request's context. Reads that belong together go
 * through Multicall3 instead.
 */
export const publicClient = (env: Env, network: NetworkName) =>
  createPublicClient({
    chain: NETWORKS[network].chain,
    transport: http(rpcUrl(env, network), { timeout: 15_000 }),
  });

const transferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

/**
 * Addresses that sent `token` in this receipt. Each user's Calibur batch is
 * all-or-nothing and always moves AUSD from the user, so "their address sent
 * AUSD here" means "their transfer landed".
 */
export const tokenSenders = (receipt: TransactionReceipt, token: Address) =>
  new Set(
    parseEventLogs({ abi: transferEvent, logs: receipt.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()) }).map((l) =>
      l.args.from.toLowerCase(),
    ),
  );

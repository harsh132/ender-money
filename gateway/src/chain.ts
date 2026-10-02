import { createPublicClient, http } from 'viem';
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

import { createPublicClient, fallback, http, parseAbi, parseEventLogs, type Address, type Chain, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BRIDGE_CHAINS, NETWORKS, type BridgeChainName, type NetworkName } from '../../protocol/networks';
import type { Env } from './env';

/** The gateway key's address: the Sponsor's sender, and the default auto-bridge fee recipient and name-fee treasury. */
export const sponsorAddress = (env: Env) => privateKeyToAccount(env.GATEWAY_PRIVATE_KEY as Hex).address;

export const isNetwork = (n: unknown): n is NetworkName => n === 'mainnet' || n === 'testnet';

/** Monad (mainnet, testnet), or a chain whose tokens auto-bridge into it. */
export type ChainName = NetworkName | BridgeChainName;

export const chainOf = (n: ChainName): Chain => (isNetwork(n) ? NETWORKS[n].chain : BRIDGE_CHAINS[n].chain);

/** Alchemy's JSON-RPC host for each bridge chain, and a public endpoint that backs it up (or stands in without a key). */
const BRIDGE_RPC: Record<BridgeChainName, { alchemy: string; public: string }> = {
  ethereum: { alchemy: 'eth-mainnet', public: 'https://eth.drpc.org' },
  base: { alchemy: 'base-mainnet', public: 'https://mainnet.base.org' },
  arbitrum: { alchemy: 'arb-mainnet', public: 'https://arb1.arbitrum.io/rpc' },
  polygon: { alchemy: 'polygon-mainnet', public: 'https://polygon.drpc.org' },
};

export const rpcUrl = (env: Env, network: NetworkName) =>
  (network === 'mainnet' ? env.RPC_MAINNET : env.RPC_TESTNET) || NETWORKS[network].chain.rpcUrls.default.http[0]!;

const rpcUrls = (env: Env, n: ChainName): string[] => {
  if (isNetwork(n)) return [rpcUrl(env, n)];
  const own = env[`RPC_${n.toUpperCase()}` as 'RPC_BASE'];
  if (own) return [own];
  return [...(env.ALCHEMY_API_KEY ? [`https://${BRIDGE_RPC[n].alchemy}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`] : []), BRIDGE_RPC[n].public];
};

/**
 * No JSON-RPC batching: viem's batch scheduler shares one pending request
 * across callers, and the Workers runtime cancels a request whose promise is
 * resolved from another request's context. Reads that belong together go
 * through Multicall3 instead.
 */
export const publicClient = (env: Env, n: ChainName) => {
  const urls = rpcUrls(env, n);
  const transport = urls.length === 1 ? http(urls[0], { timeout: 15_000 }) : fallback(urls.map((u) => http(u, { timeout: 15_000 })));
  return createPublicClient({ chain: chainOf(n), transport });
};

export const transferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

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

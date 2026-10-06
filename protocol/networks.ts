import { arbitrum, base, mainnet, monad, monadTestnet, polygon } from 'viem/chains';
import type { Address, Chain } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

export type Network = {
  chain: Chain;
  explorer: string;
  ausd: Address;
  /** Agora Instant Settlement AUSD/CTK pair; mainnet's AUSD/USDC pair needs Agora KYC, so it is unused. */
  pair?: Address;
  ctk?: Address;
  /** Grants the pair's APPROVED_SWAPPER role; permissionless on testnet (`setApprovedSwapper(address)`). */
  whitelister?: Address;
  /** Testnet-only AUSD faucet (`requestFunds(address)`). */
  ausdFaucet?: Address;
  /**
   * Split-key ShieldedPool (protocol/pool.ts) and the block it was deployed in
   * (where log scans start). Testnet only: single-contributor trusted setup,
   * no audit. Its gateway (the only relayer it accepts) is FEE_RECIPIENT.
   */
  pool?: Address;
  poolDeployBlock?: bigint;
};

/** Calibur v1.1.0, Uniswap's EIP-7702 account. Same address on both networks. */
export const CALIBUR: Address = '0x000000005c84F8Fd50b21CAC312528A64437030e';

/** Multicall3, standard address, deployed on both networks. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * Treasury that collects the flat fee. Shared, not quoted: the SMS quote has no
 * room for it, and the app needs it to rebuild the calls it signs. For now it
 * is the gateway key's address.
 */
export const FEE_RECIPIENT: Address = '0x458E8F51EC2B833209b5C71372376eeb1e40af08';

/** AUSD's EIP-712 domain name and version (EIP-3009 deposits); checked on testnet. */
export const AUSD_EIP712 = { name: 'Agora Dollar', version: '1' } as const;

/** AUSD has 6 decimals on both networks. */
export const AUSD_DECIMALS = 6;
/** Agora's testnet CTK token, standing in for a local-currency stablecoin. */
export const CTK_DECIMALS = 18;

export const NETWORKS: Record<NetworkName, Network> = {
  mainnet: {
    chain: monad,
    explorer: 'https://monadvision.com',
    ausd: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  },
  testnet: {
    chain: monadTestnet,
    explorer: 'https://testnet.monadvision.com',
    ausd: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
    pair: '0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae',
    ctk: '0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D',
    whitelister: '0x7c10F56d6f04a51376393a1C3670e966863F6BD5',
    ausdFaucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
    pool: '0xbe34bb676ba6d40098e8aaa36b4599400c9810ff',
    poolDeployBlock: 68154262n,
  },
};

/**
 * Chains whose tokens auto-bridge into AUSD on Monad mainnet through Relay
 * (protocol/bridge.ts): the same address takes tokens there. Calibur is
 * deployed at CALIBUR on each, with the same bytecode.
 */
export type BridgeChainName = 'ethereum' | 'base' | 'arbitrum' | 'polygon';

export const BRIDGE_CHAINS: Record<BridgeChainName, { chain: Chain; label: string }> = {
  ethereum: { chain: mainnet, label: 'Ethereum' },
  base: { chain: base, label: 'Base' },
  arbitrum: { chain: arbitrum, label: 'Arbitrum' },
  polygon: { chain: polygon, label: 'Polygon' },
};

export const bridgeChainOf = (chainId: unknown) =>
  (Object.keys(BRIDGE_CHAINS) as BridgeChainName[]).find((n) => BRIDGE_CHAINS[n].chain.id === chainId);

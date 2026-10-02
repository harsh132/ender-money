import { monad, monadTestnet } from 'viem/chains';
import type { Address, Chain } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

export type Network = {
  chain: Chain;
  explorer: string;
  ausd: Address;
  /** Agora Instant Settlement AUSD/CTK pair; mainnet's AUSD/USDC pair needs Agora KYC, so it is unused. */
  pair?: Address;
  ctk?: Address;
  /** Testnet-only AUSD faucet (`requestFunds(address)`). */
  ausdFaucet?: Address;
};

/** Calibur v1.1.0, Uniswap's EIP-7702 account. Same address on both networks. */
export const CALIBUR: Address = '0x000000005c84F8Fd50b21CAC312528A64437030e';

/** Multicall3, standard address, deployed on both networks. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** AUSD has 6 decimals on both networks. */
export const AUSD_DECIMALS = 6;

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
    ausdFaucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
  },
};

import type { ProverContainer } from './prover';
import type { Relay } from './relay';
import type { Sponsor } from './sponsor';

export type Env = {
  DB: D1Database;
  SPONSOR: DurableObjectNamespace<Sponsor>;
  GATEWAY_PRIVATE_KEY: string;
  JWT_SECRET: string;
  FEE_AUSD: string;
  /** "1" stops all HTTP requests (503) and cron work: the emergency stop. */
  PAUSED?: string;
  RELAY_TOKEN: string;
  /** Android SMS Retriever hash appended to replies; unset until the app is signed. */
  SMS_RETRIEVER_HASH?: string;
  RELAY: DurableObjectNamespace<Relay>;
  RPC_MAINNET?: string;
  RPC_TESTNET?: string;
  /** Ethereum mainnet JSON-RPC for reverse ENS in Received alerts (names.ts reverseEns); defaults to https://eth.drpc.org. */
  ETH_RPC_URL?: string;
  /**
   * Cloudflare rate-limit binding, keyed by IP for /auth/*, /tx/*, /wallet/* and /shielded/*; by
   * `<what>:<ip>` for name checks and lookups, /ccip and pay pages; by `lookup:<phone>` for /names/by-phone.
   */
  IP_LIMITER: RateLimit;
  /** Comma-separated networks a signup delegates on; defaults to "mainnet,testnet". */
  SIGNUP_NETWORKS?: string;
  /** Groth16 prover container (shielded pool). */
  PROVER: DurableObjectNamespace<ProverContainer>;
  /** AES-GCM key material for users' nk and viewing keys at rest (shielded_users). Never logged. */
  SHIELDED_KEY_SECRET?: string;
  /** Hex, 32+ bytes: seed of the gateway's own shielded authority key, which owns the dummy inputs of deposits. */
  GATEWAY_SHIELDED_SEED?: string;
  /** Alchemy Notify auth token (dashboard → Webhooks). Unset, no webhooks are made and incoming transfers go unrecorded. */
  ALCHEMY_AUTH_TOKEN?: string;
  /** Where Alchemy delivers: this Worker's POST /webhooks/alchemy. */
  ALCHEMY_WEBHOOK_URL?: string;
  /** EnderResolver on Ethereum: CCIP-Read answers (/ccip) are signed for this address. Unset, /ccip answers 503. */
  RESOLVER_ADDRESS?: string;
  /** secp256k1 key the resolver trusts (its `signers`). Can point any name anywhere: a secret, never logged. */
  RESOLVER_SIGNER_KEY?: string;
  /** "1" enables the /dev/* routes and pay pages at <label>.localhost. Only ever set in .dev.vars. */
  DEV?: string;
};

import type { ProverContainer } from './prover';
import type { Relay } from './relay';
import type { Sponsor } from './sponsor';

export type Env = {
  DB: D1Database;
  SPONSOR: DurableObjectNamespace<Sponsor>;
  GATEWAY_PRIVATE_KEY: string;
  JWT_SECRET: string;
  FEE_AUSD: string;
  RELAY_TOKEN: string;
  /** Android SMS Retriever hash appended to replies; unset until the app is signed. */
  SMS_RETRIEVER_HASH?: string;
  RELAY: DurableObjectNamespace<Relay>;
  RPC_MAINNET?: string;
  RPC_TESTNET?: string;
  /** Per-IP limiter for /auth/* and /tx/* (Cloudflare rate-limit binding). */
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
  /** "1" enables the /dev/* routes. Only ever set in .dev.vars. */
  DEV?: string;
};

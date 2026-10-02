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
  /** "1" enables the /dev/* routes. Only ever set in .dev.vars. */
  DEV?: string;
};

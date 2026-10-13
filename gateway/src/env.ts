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
  /** Twilio, the transport for every number outside India (twilio.ts). Without all three it's off: no webhook, no texts. */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** The Twilio number texts come from, E.164. */
  TWILIO_FROM?: string;
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
  /** Alchemy API key (dashboard → Apps): JSON-RPC on the auto-bridge chains, public endpoints behind it (chain.ts). */
  ALCHEMY_API_KEY?: string;
  /** One auto-bridge chain's JSON-RPC instead of Alchemy's and the public one (tests, a fork). */
  RPC_ETHEREUM?: string;
  RPC_BASE?: string;
  RPC_ARBITRUM?: string;
  RPC_POLYGON?: string;
  /** Auto-bridge (bridge.ts): the app fee pays our gas times this... */
  BRIDGE_GAS_MARKUP?: string;
  /** ...plus this many USD... */
  BRIDGE_FEE_FLAT_USD?: string;
  /** ...unless that is over this percent of the amount (then the balance waits)... */
  BRIDGE_MAX_FEE_PCT?: string;
  /** ...or the amount is under this many USD. */
  BRIDGE_MIN_USD?: string;
  /** Where Relay accrues the app fee; defaults to the gateway key's address. The app ships the same address and refuses another. */
  BRIDGE_FEE_RECIPIENT?: string;
  /** EnderResolver on Ethereum: CCIP-Read answers (/ccip) are signed for this address. Unset, /ccip answers 503. */
  RESOLVER_ADDRESS?: string;
  /** secp256k1 key the resolver trusts (its `signers`). Can point any name anywhere: a secret, never logged. */
  RESOLVER_SIGNER_KEY?: string;
  /** AUSD an account pays on mainnet to change its Ender ID without a phone (names.ts). Defaults to "2". */
  NAME_FEE_AUSD?: string;
  /** Where that fee is paid; defaults to the gateway key's address. */
  TREASURY_ADDRESS?: string;
  /** Cloudflare Turnstile secret: set, creating an account (POST /auth/verify) needs a passing `turnstile` token. */
  TURNSTILE_SECRET?: string;
  /** "1" enables the /dev/* routes and pay pages at <label>.localhost. Only ever set in .dev.vars. */
  DEV?: string;
};

-- Auto-bridge (bridge.ts): tokens at a user's own address on Ethereum, Base, Arbitrum or Polygon, swapped and bridged
-- by Relay into AUSD at the same address on Monad mainnet.

-- What those chains' Alchemy webhooks saw arrive, one row per (address, chain, token). The balance itself is read live
-- when bridging; a bridge that moved it deletes the row, and the next incoming transfer brings it back.
CREATE TABLE foreign_balances (
  address  TEXT NOT NULL,              -- lowercase
  chain_id INTEGER NOT NULL,
  token    TEXT NOT NULL,              -- lowercase; 0x0000000000000000000000000000000000000000 for the chain's coin
  seen_at  INTEGER NOT NULL,           -- last incoming transfer
  retry_at INTEGER NOT NULL DEFAULT 0, -- not listed before this (too small, fee too high, a token Relay can't take); a new transfer clears it
  PRIMARY KEY (address, chain_id, token)
);

-- One per POST /bridge/prepare; POST /bridge/submit sends it.
CREATE TABLE bridges (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  chain_id   INTEGER NOT NULL,
  token      TEXT NOT NULL,
  amount     TEXT NOT NULL,              -- base units: the whole balance at prepare
  bps        INTEGER NOT NULL,           -- Relay app fee the app quotes with
  nonce      TEXT NOT NULL,              -- Calibur nonce the batch must carry
  delegate   INTEGER NOT NULL,           -- 1: not yet delegated there; the transaction carries the user's 7702 authorization
  max_cost   TEXT NOT NULL,              -- wei: the most gas (and L1 data) the fee pays for
  state      TEXT NOT NULL,              -- prepared | sending | sent | failed
  error      TEXT,
  tx_hash    TEXT,
  request_id TEXT,                       -- Relay's
  created_at INTEGER NOT NULL
);
CREATE INDEX bridges_address ON bridges (address, created_at);

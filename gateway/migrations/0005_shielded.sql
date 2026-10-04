-- Split-key shielded pool (testnet only; see docs/splitkey-spike.md).

-- Users' proving keys. nk and view_sk are AES-GCM ciphertexts under SHIELDED_KEY_SECRET (shielded.ts sealKey);
-- the authority PRIVATE key never reaches the gateway. owner_key and enc_pk are public, derived from the rest.
CREATE TABLE shielded_users (
  phone      TEXT NOT NULL,
  network    TEXT NOT NULL,
  ax         TEXT NOT NULL,  -- authority public key (BabyJubJub), decimal
  ay         TEXT NOT NULL,
  nk         TEXT NOT NULL,  -- sealed nullifier key
  view_sk    TEXT NOT NULL,  -- sealed x25519 viewing key
  owner_key  TEXT NOT NULL,  -- Poseidon(Ax, Ay, Poseidon(nk)), decimal
  enc_pk     TEXT NOT NULL,  -- x25519 public key, hex
  eoa        TEXT NOT NULL,  -- the linked wallet address deposits must come from, lowercase
  created_at INTEGER NOT NULL,
  PRIMARY KEY (phone, network)
);
CREATE UNIQUE INDEX shielded_users_owner ON shielded_users (network, owner_key);
CREATE INDEX shielded_users_eoa ON shielded_users (network, eoa);

-- The pool's leaves, from the gateway's own receipts (and the first-use catch-up scan).
CREATE TABLE pool_leaves (
  network    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  commitment TEXT NOT NULL,  -- decimal
  ciphertext TEXT NOT NULL,  -- hex
  block      INTEGER NOT NULL,
  PRIMARY KEY (network, idx)
);

-- Incremental Merkle tree: level 0 = leaves, level 23 idx 0 = root. Absent nodes are the level's zero.
CREATE TABLE pool_nodes (
  network TEXT NOT NULL,
  level   INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  hash    TEXT NOT NULL,     -- decimal
  PRIMARY KEY (network, level, idx)
);

-- One row per tree append [from_size, to_size). The primary key makes racing appends from the same size fail
-- (the whole D1 batch rolls back), so the tree is never built from stale siblings.
CREATE TABLE pool_appends (
  network   TEXT NOT NULL,
  from_size INTEGER NOT NULL,
  to_size   INTEGER NOT NULL,
  PRIMARY KEY (network, from_size)
);

CREATE TABLE pool_nullifiers (
  network   TEXT NOT NULL,
  nullifier TEXT NOT NULL,  -- decimal
  PRIMARY KEY (network, nullifier)
);

-- Catch-up scan of pool logs from the deploy block (first use, or after a gap); done = 1 once it reached the head.
CREATE TABLE pool_cursors (
  network TEXT PRIMARY KEY,
  block   INTEGER NOT NULL,
  done    INTEGER NOT NULL DEFAULT 0
);

-- Each registered user's notes, found by trial decryption.
CREATE TABLE shielded_notes (
  network   TEXT NOT NULL,
  pos       INTEGER NOT NULL,
  phone     TEXT NOT NULL,
  amount    TEXT NOT NULL,  -- base units
  blinding  TEXT NOT NULL,  -- decimal
  nullifier TEXT NOT NULL,  -- decimal
  spent     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network, pos)
);
CREATE INDEX shielded_notes_phone ON shielded_notes (phone, network);
CREATE INDEX shielded_notes_nullifier ON shielded_notes (network, nullifier);

-- Shielded quotes (PAY / SHIELD / MERGE, HTTPS or SMS). Claimed like sessions: open -> sending -> sent.
CREATE TABLE shielded_quotes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  network    TEXT NOT NULL,
  kind       TEXT NOT NULL,  -- pay | withdraw | shield | merge
  to_phone   TEXT,           -- pay
  to_address TEXT,           -- withdraw
  amount     TEXT NOT NULL,  -- base units
  fee        TEXT NOT NULL,  -- base units
  exp        INTEGER NOT NULL, -- also the on-chain deadline
  state      TEXT NOT NULL DEFAULT 'open',
  ins        TEXT,           -- JSON positions of the notes being spent while sending
  tx_hash    TEXT,
  p          INTEGER,        -- position of output 0, if it made leaves
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX shielded_quotes_phone ON shielded_quotes (phone, state);

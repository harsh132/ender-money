-- Phone ↔ address directory, queried both ways. Addresses are stored lowercase.
CREATE TABLE links (
  phone      TEXT PRIMARY KEY,               -- E.164
  address    TEXT NOT NULL UNIQUE,
  network    TEXT NOT NULL DEFAULT 'mainnet', -- the phone's current network, for the SMS path
  alerts     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE otps (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Pending quotes: exactly what the user is asked to sign. The call batch is rebuilt from these fields.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  phone        TEXT NOT NULL,
  network      TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address   TEXT NOT NULL,
  amount       TEXT NOT NULL,  -- base units
  fee          TEXT NOT NULL,  -- base units
  deliver      TEXT NOT NULL DEFAULT 'AUSD',
  nonce        TEXT NOT NULL,
  deadline     INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open', -- open | sending | sent
  tx_hash      TEXT,
  error        TEXT,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_request ON sessions (phone, request_hash);

CREATE TABLE alerts_sent (
  tx_hash TEXT NOT NULL,
  phone   TEXT NOT NULL,
  PRIMARY KEY (tx_hash, phone)
);

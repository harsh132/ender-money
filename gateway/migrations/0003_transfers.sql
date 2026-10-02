-- AUSD transfers touching a linked address, read from Transfer logs by the cron.
-- Serves GET /activity and incoming-payment alerts.
CREATE TABLE transfers (
  network      TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address   TEXT NOT NULL,
  amount       TEXT NOT NULL,  -- base units
  block        INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (network, tx_hash, log_index)
);
CREATE INDEX transfers_to ON transfers (network, to_address, block);
CREATE INDEX transfers_from ON transfers (network, from_address, block);

-- Last block the log scan has covered, per network.
CREATE TABLE cursors (
  network TEXT PRIMARY KEY,
  block   INTEGER NOT NULL
);

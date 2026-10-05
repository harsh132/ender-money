-- Who texts name (docs/SMS.md "Who appears in texts").

-- Reverse ENS for a public Received's from=: an address's verified primary name on Ethereum (names.ts reverseEns),
-- null when it has none or one a text can't carry. Rechecked after a week.
CREATE TABLE ens_names (
  address    TEXT PRIMARY KEY,  -- lowercase
  name       TEXT,
  checked_at INTEGER NOT NULL
);

-- What a public quote was asked for when it was a number or an Ender ID (null for a 0x address), so its Sent names it.
ALTER TABLE sessions ADD COLUMN recipient TEXT;

-- The pool transaction that made each note (full hash), for GET /shielded/notes: the app links private rows to it.
-- Null for notes indexed before this migration.
ALTER TABLE shielded_notes ADD COLUMN tx_hash TEXT;

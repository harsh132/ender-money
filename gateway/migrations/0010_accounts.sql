-- Accounts are wallet addresses (docs/gateway.md "Accounts"): login is a signature, the phone number an optional,
-- verified extra. Every existing row already has an address, so every account carries over with its number.
-- Preflight on production (must return no rows, or this migration fails on shielded_users' primary key):
--   SELECT eoa, network FROM shielded_users GROUP BY eoa, network HAVING count(*) > 1;

-- links, re-keyed: SQLite can't change a primary key in place, so the table is rebuilt.
CREATE TABLE links_new (
  address    TEXT PRIMARY KEY,                -- the account: the wallet address, lowercase
  phone      TEXT UNIQUE,                     -- E.164, set only after an OTP; null without one (no SMS features)
  network    TEXT NOT NULL DEFAULT 'mainnet', -- the account's current network, for the SMS path
  alerts     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  label      TEXT UNIQUE                      -- the current Ender ID; every one it ever had is in `names`
);
INSERT INTO links_new (address, phone, network, alerts, created_at, label)
  SELECT lower(address), phone, network, alerts, created_at, label FROM links;
DROP TABLE links;
ALTER TABLE links_new RENAME TO links;

-- Every Ender ID ever given out, current or not. A label is never given to another account: an account's earlier
-- (random) label keeps resolving to it.
CREATE TABLE names (
  label      TEXT PRIMARY KEY,  -- lowercase
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX names_address ON names (address);
INSERT INTO names (label, address, created_at) SELECT label, address, created_at FROM links WHERE label IS NOT NULL;

-- The one name change an account gets (POST /account/name), and what unlocked it: a verified number (each number
-- once, ever) or a mainnet payment's transaction hash (each once). A name chosen before 0010 counts as that change,
-- unlocked by the account's number.
CREATE TABLE name_unlocks (
  proof      TEXT PRIMARY KEY,      -- E.164 number, or 0x transaction hash (lowercase)
  address    TEXT NOT NULL UNIQUE,  -- once per account
  created_at INTEGER NOT NULL
);
INSERT INTO name_unlocks (proof, address, created_at) SELECT phone, address, created_at FROM links WHERE label IS NOT NULL;

-- Sign-in challenges (POST /auth/challenge): one open nonce per address, spent by POST /auth/verify.
CREATE TABLE auth_challenges (
  address    TEXT PRIMARY KEY,  -- lowercase
  nonce      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Public quotes belong to the account that asked: its address, which is the quote's from_address.
ALTER TABLE sessions RENAME COLUMN phone TO account;
UPDATE sessions SET account = from_address;

-- Private balance: a registration belongs to the wallet whose key derived it (its eoa), as do its notes and quotes.
-- A paid number moves into to_address (what the payment was asked for), the recipient's account into to_account.
UPDATE shielded_notes SET phone = coalesce(
  (SELECT eoa FROM shielded_users u WHERE u.phone = shielded_notes.phone AND u.network = shielded_notes.network), phone);
UPDATE shielded_quotes SET to_address = to_phone WHERE kind = 'pay' AND to_address IS NULL AND to_phone IS NOT NULL;
UPDATE shielded_quotes SET to_phone = coalesce(
  (SELECT eoa FROM shielded_users u WHERE u.phone = shielded_quotes.to_phone AND u.network = shielded_quotes.network), to_phone)
  WHERE to_phone IS NOT NULL;
UPDATE shielded_quotes SET phone = coalesce(
  (SELECT eoa FROM shielded_users u WHERE u.phone = shielded_quotes.phone AND u.network = shielded_quotes.network), phone);
ALTER TABLE shielded_notes RENAME COLUMN phone TO account;
ALTER TABLE shielded_quotes RENAME COLUMN phone TO account;
ALTER TABLE shielded_quotes RENAME COLUMN to_phone TO to_account;

-- nk and view_sk were sealed with the number in their AES-GCM aad (shielded.ts openUser): keep it to open them.
-- Null for registrations after 0010, sealed with the account.
ALTER TABLE shielded_users ADD COLUMN sealed_as TEXT;
UPDATE shielded_users SET sealed_as = phone, phone = eoa;
ALTER TABLE shielded_users RENAME COLUMN phone TO account;

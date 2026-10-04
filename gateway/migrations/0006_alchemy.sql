-- Alchemy Address Activity webhooks (alchemy.ts): AUSD transfers pushed to POST /webhooks/alchemy within seconds.
-- They replace the cron's log scan, whose cursor goes.
DROP TABLE cursors;

-- Webhooks the gateway created itself through Alchemy's Notify API. One per network until it holds 100,000 addresses.
CREATE TABLE alchemy_webhooks (
  id          TEXT PRIMARY KEY,           -- Alchemy's webhook id, named in every delivery
  network     TEXT NOT NULL,
  signing_key TEXT NOT NULL,              -- AES-GCM under SHIELDED_KEY_SECRET (shielded.ts sealKey), aad `alchemy|<id>`
  addresses   INTEGER NOT NULL DEFAULT 0, -- addresses pushed to it
  created_at  INTEGER NOT NULL
);
CREATE INDEX alchemy_webhooks_network ON alchemy_webhooks (network, addresses);

-- Linked addresses already on one of the network's webhooks. A linked address missing here is pushed by the next sync.
CREATE TABLE alchemy_addresses (
  network TEXT NOT NULL,
  address TEXT NOT NULL,                  -- lowercase
  PRIMARY KEY (network, address)
);

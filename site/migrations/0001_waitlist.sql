-- Landing-page waitlist. Email only, stored lowercase; it is the dedupe key.
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Ender IDs: <label>.ender.my, chosen once (at signup, or once later for older accounts) and never changed.
-- On links, so the name follows the number and a relink carries it in the same statement. Lowercase.
ALTER TABLE links ADD COLUMN label TEXT;
CREATE UNIQUE INDEX links_label ON links (label);

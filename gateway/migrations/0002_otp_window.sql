-- Per-number send budget for OTPs: at most 3 sends per rolling hour window.
ALTER TABLE otps ADD COLUMN sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE otps ADD COLUMN window_start INTEGER NOT NULL DEFAULT 0;

-- Local-currency delivery (Test mode): the quoted CTK output, signed as the swap's minimum.
ALTER TABLE sessions ADD COLUMN min_out TEXT;  -- CTK base units, NULL for AUSD

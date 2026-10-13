-- Inbound texts on the Twilio number already handled (POST /webhooks/twilio): Twilio may deliver one twice.
CREATE TABLE twilio_inbound (
  sid         TEXT PRIMARY KEY,  -- MessageSid
  received_at INTEGER NOT NULL
);

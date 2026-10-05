# Later

Deliberately deferred. Newest first.

- **Names in texts (5 Oct).**
  - Notes indexed before `0008` have no `tx_hash` (no backfill), so their
    private rows never get an explorer link. A rescan from the deploy block
    with an upsert would fill them.
  - A private row from a `Sent` text gets its full hash only through one of
    our notes at `p` or `p+1`; a payment or withdrawal with no change leaves
    us none, so it stays unlinked.
  - A reverse-ENS answer is trusted for 7 days: a changed or dropped primary
    name shows until the recheck.
- **Review follow-ups (5 Oct).**
  - The app's 15 s quote timeout falls back to SMS, but a first quote can run
    the pool catch-up (up to 200 log chunks) and take longer.
  - Prover 400/422 errors reach the app as `internal` 500; map them to a code.
  - `registerShielded` swallows `key-changed`/`key-in-use` silently (see the
    re-link item below).
  - Nothing cleans up old `shielded_quotes` rows.
  - The sender low-balance warning isn't built.
- **New passkey, same number.** The gateway refuses a re-registration with
  different shielded keys (`key-changed`), so a user who lost their passkey and
  made a new wallet can't use private payments. Needs a re-link flow (verify
  the number, retire the old keys; notes under the old keys are lost with them).
- **Private Received after a late settle.** A private payment whose receipt
  timed out and was settled by a later submit sends no private `Received` to
  the recipient.
- **Open exit.** Let users withdraw a whole note with two null outputs without
  the gateway (the pool already allows it). Needs a pool event scan for
  transactions the gateway didn't relay (`TODO(open-exit)` in the gateway) and a
  way for users to prove on their own (exit tool or web prover).
- **Mainnet pool.** Multi-party trusted setup, circomspect and Picus, a circuit
  and contract audit, then deploy with an admin multisig.
- **Alert MACs.** `Received`, `Sent` and `Shielded` are unauthenticated; add a short
  MAC per alert.
- **First payment to a new contact trusts the gateway's directory.** Pin
  contacts online, or have the directory entry signed by the recipient.
- **SMS payload privacy.** Carriers can read note details (and the payer's
  Ender ID) in a private `Received`.

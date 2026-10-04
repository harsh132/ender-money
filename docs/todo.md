# Later

Deliberately deferred. Newest first.

- **Review follow-ups (5 Oct).**
  - The app's 15 s quote timeout falls back to SMS, but a first quote can run
    the pool catch-up (up to 200 log chunks) and take longer.
  - Prover 400/422 errors reach the app as `internal` 500; map them to a code.
  - The app matches a `Sent` by kind and amount only; a change-free
    withdrawal's `Sent` has no `p=`, so a public `Sent` of the same amount could
    settle a waiting private payment. Add the quote id or a short tag.
  - `registerShielded` swallows `key-changed`/`key-in-use` silently (see the
    re-link item below).
  - Replies carry the SMS Retriever hash, but the app only listens on the
    sign-in code screen; `Got` and quotes still arrive by clipboard or paste.
  - Nothing cleans up old `shielded_quotes` rows.
  - The sender low-balance warning isn't built.
- **New passkey, same number.** The gateway refuses a re-registration with
  different shielded keys (`key-changed`), so a user who lost their passkey and
  made a new wallet can't use private payments. Needs a re-link flow (verify
  the number, retire the old keys; notes under the old keys are lost with them).
- **Got after a late settle.** A private payment whose receipt timed out and was
  settled by a later submit sends no `Got` to the recipient.
- **Open exit.** Let users withdraw a whole note with two null outputs without
  the gateway (the pool already allows it). Needs a pool event scan for
  transactions the gateway didn't relay (`TODO(open-exit)` in the gateway) and a
  way for users to prove on their own (exit tool or web prover).
- **Mainnet pool.** Multi-party trusted setup, circomspect and Picus, a circuit
  and contract audit, then deploy with an admin multisig.
- **Alert MACs.** `Got`, `Sent` and `Shielded` are unauthenticated; add a short
  MAC per alert.
- **First payment to a new contact trusts the gateway's directory.** Pin
  contacts online, or have the directory entry signed by the recipient.
- **SMS payload privacy.** Carriers can read note details in `Got`.

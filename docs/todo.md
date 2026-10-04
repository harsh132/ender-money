# Later

Deliberately deferred. Newest first.

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

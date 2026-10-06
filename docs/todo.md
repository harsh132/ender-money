# Later

Deliberately deferred. Newest first.

- **Auto-bridge (6 Oct).**
  - Only fungible tokens Relay can route: NFTs, illiquid and spam tokens stay
    where they landed (a token Relay refuses waits a week, or until more
    arrives). Nothing to recover them from the app yet.
  - Ethereum, Base, Arbitrum and Polygon only. Optimism (and other chains
    Relay and Calibur both cover) is one entry in `BRIDGE_CHAINS`, an Alchemy
    network and an RPC each.
  - The gateway can't verify that the quote the app signed carried our app
    fee (no keyless Relay lookup by request id): a modified app gets free gas
    for its own bridges. Check `GET /requests/v3` (needs a Relay API key)
    after the fact and stop bridging for accounts that skip the fee, or move
    the fee into the batch as an on-chain transfer the gateway can check.
  - Our fee comes back as USDC at Relay while gas is paid in ETH / POL: the
    gateway key is topped up by hand. No alert beyond the log line.
  - Mainnet only, and only while the app shows mainnet, is online and
    unlocked; tokens that arrive meanwhile wait. Testnet has no Relay route.
  - Ender IDs resolve (ENS) to the Monad address only; per-chain ENS
    addresses (ENSIP-11 coin types for Ethereum, Base, Arbitrum, Polygon)
    would let senders on those chains pay `label.ender.my` directly.
  - The Monad fill still sends a `Received` text naming Relay's solver
    address; it could say "from Base" instead.
  - On a lost connection after submit, the row stays "Arriving" until Relay's
    status settles it, or expires 5 minutes after the signed deadline if
    Relay never saw the deposit.

- **Auto Shield (6 Oct).**
  - Online only, and only while a Quick send session holds the key: money
    that arrives while the app is locked or offline stays public until the
    next unlock online. No auto-shield by text.
  - Self-custody caveat: with it on by default, nearly all funds sit in the
    pool, and spending them needs the gateway (it proves) until open exit
    ships (below).
  - The deposit is priced at `MAX_FEE`; if the gateway ever quotes a lower
    fee, the difference stays public (dust under $0.01). A re-quote at the
    quoted fee would close it.
  - A public payment being reviewed (quoted, not yet signed) can race an
    auto-shield for the same balance; one of them then fails and is retried.
  - A failed auto-shield leaves a failed "Private balance" row in Activity,
    as a failed auto-merge does.

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

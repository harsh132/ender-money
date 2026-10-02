# Ender Money — stealth addresses (scope)

Paying a phone number today returns the recipient's one wallet address, so any
Ender user can turn a list of numbers into a list of wallets, and with them
every balance and payment on-chain. This scopes per-pair stealth addresses:
the gateway still resolves numbers, but what it resolves to is useless to
anyone except the payer.

## The idea

- When Alice pays Bob's number, she is given an address that is **Bob's, for
  Alice**. Every later lookup by Alice returns the same address; Carol gets a
  different one, also stable for her.
- Only Bob can spend from it. Nobody watching the chain can link it to Bob's
  main wallet or to the address Carol pays.
- Bob sees one balance. The gateway knows all of his addresses and sums them;
  the app spends from as many as a payment needs.

What a scraper learns by looking up Bob's number: an address holding only the
scraper's own payments. What still leaks: that the number is on Ender (the
Invite flow needs `not-on-ender`).

**Privacy model, stated plainly:** private from the public, not from Ender.
The gateway can see every user's incoming payments by number. It cannot move
any of them.

## Keys (Fluidkey model, ported from ender-backend)

`ender-backend/packages/stealth` already implements this on
`@fluidkey/stealth-account-kit`. Port `keys.ts` and `derive.ts` into
`protocol/stealth.ts` so the gateway and the app share one derivation.

| Key | Where | Can |
| --- | --- | --- |
| Spending private key | phone only, derived on demand like the wallet key | spend from any of the user's stealth addresses |
| Viewing node (`m/5564'/N'` xprv) | gateway, encrypted at rest | derive addresses and see payments; cannot spend |
| Spending public key | gateway | combine with the viewing node to derive addresses |

**Derivation from the passkey.** The wallet's root key signs a fixed message
(`enderKeygenMessage`); `generateKeysFromSignature` turns the 65-byte
signature into the spending and viewing keys. secp256k1 signatures are
deterministic (RFC 6979), so the same passkey always gives the same keys, and
it happens inside the same Mera session as the approval, so there is no extra
prompt. This is also the story for Mera's "One Passkey, Many Keys" bounty:
wallet key, stealth spending key and viewing key, all from one passkey.

Addresses are per pair, not per chain: the kit derives with Ender's coin type,
not the chain ID, so one stealth address is the same on mainnet and testnet,
with separate balances, like the main wallet.

## Address per pair

- New table `stealth_addresses (recipient_phone, sender_phone, nonce, address,
  ephemeral_pub, delegated, created_at)`, unique on `(recipient, sender)` and
  on `address`.
- The first quote from Alice to Bob assigns Bob's next nonce, derives the
  address from Bob's viewing node and spending public key, and stores the row.
  Every later quote returns the stored row. One address per payer, no matter
  how many payments.
- A payment by address or QR still goes to the main wallet (that address is
  public anyway). Stealth applies to payments by phone number.
- Pinning (warn if a number's address changes) keeps working: Alice's pinned
  address for Bob is her pair address, which is stable.

## Receiving

- **Balance** = main wallet + every stealth address, summed in one Multicall3
  read. `/account` and the SMS `SYNC` reply return the total; `/account` also
  returns the per-address breakdown the app needs to spend (`sources`).
- **Activity and alerts**: the cron's log scan watches stealth addresses as
  well as main wallets. Because the gateway knows which pair an address belongs
  to, the alert can name the sender's number ("Received 10 AUSD from +9198…"),
  which is better than today's short address.
- **Fresh device**: the app rebuilds its keys from the passkey and gets the
  nonces from `/account`. If the gateway's table were lost, the app can walk
  nonces from 0 until it finds a run of empty addresses (gap limit), as the
  ender-backend recovery does.

## Spending

A stealth address is a plain EOA. Like the main wallet, it needs an EIP-7702
delegation to Calibur before the gateway can sponsor a transfer from it. That
costs about 0.02 MON (about $0.0007) per address, once, and only for addresses
that hold a balance: a pair address is created on the first quote, and a payer
who never pays leaves it empty, so it is never delegated.

**Source selection (gateway, in the quote).** For a payment of X: use the
fewest sources that cover X plus the fee, largest balance first, preferring
delegated ones. The fee comes from the first source. The quote returns one
part per source: `{from, amount, nonce, delegated}`.

**Online.** One passkey prompt opens the Mera session. In it, the app derives
each source's private key, signs one `SignedBatchedCall` per source, and, for
any source not yet delegated, signs its 7702 authorization. `/tx/sign` takes
the list. The gateway's Sponsor already puts delegations and calls in the same
transaction, so a first spend from a new address is still one transaction.

**Delegate on the next online approval.** Whenever the user approves anything
online, the app also signs authorizations for every stealth address that has a
balance and is not yet delegated, in the same session, and the gateway
delegates them in the next batch. Empty addresses are skipped. No extra
prompt, and funded addresses become spendable by text.

**Offline (SMS).** One `SIG` per source, each one segment as today. The quote
reply gains a compact source list, e.g. `src=0:3:12.5,2:0:12.5` (index into
the user's sources, Calibur nonce, amount), which fits one segment for up to
about three sources. Undelegated addresses are skipped offline: delegation by
SMS stays out of scope (decided earlier), and the delegate-on-next-approval
rule keeps that set small.

**Privacy cost of spending.** Sources signed together land in one Multicall
batch, which hints they belong together (weakly: batches mix other users'
calls). Spending from Alice's pair address shows that address to the payee, so
Alice and the payee together could link it to Bob. Both are stated in the
write-up.

## Changes by component

| Component | Change |
| --- | --- |
| `protocol/stealth.ts` | port keys + derive from ender-backend; quote source list in `sms.ts` (`src=`), with tests |
| Gateway: storage | migration: `links` + `spending_pub`, `viewing_node` (AES-GCM under a new `VIEWING_KEY_SECRET`); `stealth_addresses`; `session_sources` (one row per source of a quote) |
| Gateway: signup | `/wallet/create` takes `spendingPublicKey` and `viewingNode`; existing wallets register once via `POST /wallet/stealth` |
| Gateway: quote/sign | phone recipient resolves to the pair address; multi-source quotes; `sign` takes a list of signatures (+ authorizations), checks each against its own rebuilt batch, submits them as one Sponsor batch |
| Gateway: account/scan | totals and `sources`; the scan watches stealth addresses; alerts name the sender's number |
| App: keys | derive stealth keys in the session; register at signup or on first online open |
| App: send | multi-source signing online; `SIG` per source offline; delegate pending stealth addresses on any online approval |
| App: home/activity | unchanged UI: one balance; activity rows already come from `/activity` |

## Build order (about 2–3 days)

1. `protocol/stealth.ts` + tests: same keys and addresses as ender-backend for
   a fixed signature; app-side private key matches gateway-side address.
2. Gateway: storage, registration, pair resolution in the quote, balances with
   sources. Script: Alice pays Bob's number twice and gets the same address;
   Carol gets a different one.
3. Gateway + app: multi-source online spend with delegation in the same
   transaction. Script: Bob receives from two payers, then pays one amount that
   needs both addresses.
4. Scan + alerts on stealth addresses; delegate-on-next-approval.
5. SMS: `src=` in the quote, `SIG` per source.

## Decided

- Per-pair addresses (one per payer), not one per payment: fewer sources means
  fewer signatures and fewer texts per spend.
- Fluidkey key model: viewing node on the gateway, spending key on the phone.
- Keys from a root-key signature inside the approval session (no extra prompt).
- No delegation over SMS; offline spends use delegated sources only.
- Delegate a stealth address only once it holds a balance.
- No lookup rate limits for now (stealth addresses remove the harm they
  addressed).

## Open questions

- Should a user's existing balance at the main address stay spendable by
  number payments alone, or should the app nudge them to keep the main address
  for QR/address payments only? (Default: both just count toward one balance.)
- Viewing-node encryption key rotation: out of scope for the hackathon.

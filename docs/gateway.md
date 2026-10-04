# Gateway — scope

The gateway takes a user's signed request, over HTTPS or SMS, and turns it
into a sponsored Monad transaction. It also verifies phone numbers, keeps the
phone ↔ address directory, and texts incoming-payment alerts. It never holds
user funds and cannot move them without a fresh user signature.

Parent scope: [SCOPE.md](../SCOPE.md). Build window: 3–5 Oct (Twilio and
alerts on 9 Oct).

## Shape

One Cloudflare Worker in `gateway/` (wrangler, Bun, TypeScript, viem),
served at `api.ender.money`. It also serves
`ender.money/.well-known/assetlinks.json` (a route on that one path only):
`ender.money` is the passkey's relying-party ID, and Android only lets the
app use it if that file names the app's package and signing certificate.
If the Ender wallet adopts passkeys on `ender.money` later, the same file
lists both apps. Three
ways in, one session core, one way out to the chain.

```
 app ──HTTPS──────────────┐
                          │
 Android relay ─WebSocket─┤                ┌─ Sponsor DO (mainnet) ─┐
 (Indian SIM)             ├─► session core ┤                        ├─► Monad RPC
 Twilio ──webhook─────────┤                └─ Sponsor DO (testnet) ─┘
                          │
 Alchemy ──webhook────────┘ (incoming payments → SMS alert)
```

The session core is transport-agnostic: every request arrives as
`{ phone, transport, command }` and leaves as a reply the transport renders
(JSON for HTTPS, one GSM-7 segment for SMS). HTTPS and SMS differ only in
how they authenticate and how they format.

## Storage

D1 holds all per-number state; Durable Objects only where something must
have exactly one owner. Every state change that must happen once is a
single atomic SQL statement, so concurrent requests can't double-act.

| Store | Holds |
| --- | --- |
| D1 `links` | `phone (E.164) · address · network · alerts · created_at`, unique on phone and on address. The directory, queried both ways: phone → address to pay a number, address → phone for alerts |
| D1 `otps` | `phone · code_hash · attempts · expires_at`. A try is `UPDATE … SET attempts = attempts + 1 WHERE phone = ? AND expires_at > ? AND attempts < 5 RETURNING *` |
| D1 `sessions` | pending quotes, i.e. exactly what the user is asked to sign (below). Signing claims one with `UPDATE … SET state = 'sending' WHERE id = ? AND state = 'open' RETURNING *`; a racing duplicate gets nothing back and reads the tx hash instead |
| D1 `alerts_sent` | `tx_hash · phone`, so a repeated webhook delivery (or a `Got` for the same transaction) never alerts twice |
| D1 `transfers` | AUSD `Transfer` logs touching a linked address (`network · tx_hash · log_index · from · to · amount · block · at`), written by the Alchemy webhook (`INSERT OR IGNORE`, so a repeated delivery writes nothing); serves `GET /activity` and alerts |
| D1 `alchemy_webhooks` | `id · network · signing_key · addresses · created_at`: the Address Activity webhooks the gateway made itself (`0006_alchemy.sql`); `signing_key` sealed under `SHIELDED_KEY_SECRET` |
| D1 `alchemy_addresses` | `network · address`: linked addresses already pushed to that network's webhook |
| `Sponsor` DO, one per network | the gateway key's nonce and the transfer queue; sends one Multicall3 batch at a time (see "Sending many transfers") |
| `Relay` DO, singleton | the Android relay's WebSocket (hibernation API), outbound queue, delivery reports |

Per-number rate limits use Cloudflare's rate-limit binding keyed by phone
number; per-IP limits use the same binding keyed by IP. The cron deletes
expired `otps` and `sessions` rows.

**`sessions` columns.** A session exists mainly for SMS: `SIG` carries only
the quote id and the 65-byte signature, so the gateway rebuilds what was
signed from its own record, never from the message. Single use, expiry and
"same tx hash on retry" come with it. HTTPS uses the same table so there is
one code path.

| Column | Purpose |
| --- | --- |
| `id` | 4-char base32 code shown in SMS (`Q 7F3K …`, `SIG 7F3K …`) |
| `phone`, `network` | who asked, on which chain |
| `from`, `to`, `amount`, `fee`, `deliver`, `min_out` | the readable transfer; the call batch is rebuilt from these by `protocol/`, not stored |
| `nonce`, `deadline` | Calibur nonce and expiry inside the signed data |
| `request_hash` | hash of the request; a repeated `SEND` from the same number while the quote is open returns this quote |
| `state`, `tx_hash`, `error` | `open → sending → sent`, or back to `open` with an error so a retry before the deadline works |
| `expires_at` | 5 minutes after the quote is sent |

**Duplicate SMS** (carriers occasionally deliver twice; the relay may
re-forward after a reconnect) need no table of their own: a repeated `SIG`
hits an already-claimed session and returns the same tx hash, a repeated
`SEND` returns the open quote through `request_hash`, and a repeated `SYNC`
costs one reply, capped by the per-number rate limit.

No user activity history on the server; the app keeps its own.

## HTTPS API

Auth: `/auth/verify` returns a JWT (HS256, 30 days) holding `phone` and
`address`. Every call below except `/auth/*` and webhooks needs it. Losing it
(fresh device, cleared storage) just means logging in again with an OTP.

| Call | Does |
| --- | --- |
| `POST /auth/start {phone}` | normalises to E.164, rate-limits, sends a 6-digit OTP (10 min, 5 tries, 3 sends/number/hour, plus per-IP) |
| `POST /auth/verify {phone, code}` | returns `{token, status: "new"}` or `{token, status: "existing", address, balance}` |
| `POST /wallet/create {address, authorizations: {mainnet, testnet}, relink?}` | checks both 7702 authorizations (delegate = Calibur, chain matches, nonce = account nonce, signer = address), queues each delegation with that network's `Sponsor` DO, where it rides in the next batch alongside transfers (gateway pays, the user is never charged), waits for them, then writes `links`. Refuses a linked number unless `relink` |
| `GET /account?network=` | balance, Calibur nonce (`getSeq(0)`), delegated yes/no, and the INR rate for the `≈ ₹` line (Frankfurter / ECB daily rate, cached an hour; omitted if unavailable) |
| `POST /tx/quote {network, to, amount, deliver?}` | `to` is an address or phone number. Returns `{id, to, amount, fee, out?, nonce, deadline, calls}`; the app rebuilds and checks `calls` before signing |
| `POST /tx/sign {id, signature}` | runs the checks below, sends, returns `{txHash}` |
| `GET /tx/:id` | the session's `network` (stored with it, so no parameter is needed), status (`open`, `sending`, `sent`, `failed`), tx hash and error. The app polls it while a transfer shows "Sending" (only needed when `/tx/sign` came back `pending`) |
| `GET /activity?network=` | `network` defaults to the number's current one, as for `/account`. The number's last 100 AUSD transfers in and out (fee legs left out), from the `transfers` table, so an online recipient sees money arrive without an SMS and a fresh device gets its history back |
| `POST /account/alerts {on}` | the Settings switch "Text me when I get paid" (`links.alerts`) |
| `GET ender.money/.well-known/assetlinks.json` | Android passkey association: package `money.ender.app` and the SHA-256 of the app's signing key (a Worker route on that one path) |
| `GET /relay` | WebSocket upgrade for the Android relay; `Authorization: Bearer <RELAY_TOKEN>` |
| `POST /webhooks/twilio` | inbound SMS; checks `X-Twilio-Signature` |
| `POST /webhooks/alchemy` | Alchemy Address Activity deliveries; `X-Alchemy-Signature` must be the hex HMAC-SHA256 of the raw body under the key of the webhook the body names (else 401). Records AUSD transfers and alerts, below |

## SMS commands

Parsed and formatted by `protocol/sms.ts`, shared with the app. Identity is
the sender's number as the carrier delivered it, normalised to E.164
(bare Indian numbers get +91). The relay SIM also receives carrier promos,
bank alerts and stray texts, so silence is the default: alphanumeric
senders and short codes get nothing, an unparseable text gets nothing
unless the number is on Ender (then `ERR bad-command`), and a well-formed
command from a number that isn't on Ender gets `ERR not-registered`, since
signing up needs the app online.

| In | Out |
| --- | --- |
| `SYNC` / `SYNC T` | `OK n=3 dlg=1 AUSD=45.20 inr=83.9`; `T` also switches the phone to testnet |
| `SEND <address or +number>, <amount> AUSD[ > CTK]` | `Q <id> n=4 exp=<unix> fee=0.01 to=0x<40>[ out=<ctk>]` |
| `SIG <id> <sig>` | `Sent 10 AUSD to 0x12…cd. Tx 0xab…ef` |
| anything else | `ERR <id?> bad-command` |

Errors: `expired`, `low-balance`, `bad-sig`, `not-on-ender`, `not-registered`,
`rate-limited`. Duplicates are handled by the session rules above. Every outbound message is checked to fit one GSM-7
segment; every reply appends the SMS Retriever hash (`SMS_RETRIEVER_HASH`) on its own line.

OTP text: `Ender code: 481926. Don't share it.` plus the Retriever hash.

## Session core

**Quote** (same for `/tx/quote` and `SEND`):

1. Resolve the recipient: an address as given, or a phone number through
   `links` (`not-on-ender` if absent).
2. Fee: flat 0.01 AUSD for now, from a `FEE_AUSD` var, paid to
   `FEE_RECIPIENT`, a treasury address in `protocol/networks.ts` (shared, not
   quoted: the SMS quote has no room for it and the app needs it to rebuild
   the calls it signs).
3. Read the Calibur nonce and balance in one batched RPC call; refuse if
   balance < amount + fee.
4. Build the batch with `protocol/calibur.ts`: transfer + fee, or for CTK
   delivery approve + `swapExactTokensForTokens(amount, minOut, [AUSD, CTK],
   recipient, deadline)` + fee, with `minOut` from `getAmountsOut`.
5. Deadline now + 300 s. Insert the session into `sessions` under a 4-char
   base32 id; it expires 5 minutes after the quote is sent.

**Sign** (same for `/tx/sign` and `SIG`), checked in order before any gas is
spent:

1. Claim the session (the atomic `UPDATE` above): it exists, is unexpired
   and nobody else is sending it.
2. Rebuild the EIP-712 digest from the stored session (never from the
   message).
3. Recover the signer; it must equal the number's linked address.
4. Balance still covers amount + fee.
5. `eth_call` the batch (the account is already delegated on both networks
   since signup).
6. Queue it in the network's `Sponsor` DO, which sends it in the next
   Multicall3 batch; store the tx hash on the session; reply with it. If any check fails, the session goes back to `open` with
   the error, so a corrected retry before the deadline still works.
7. Text the recipient an alert if they're on Ender with alerts on, and record
   it in `alerts_sent`.

A repeated `SIG`/`/tx/sign` for a used session returns the same tx hash.

**Delegation at signup, on both networks.** The app signs two 7702
authorizations (mainnet and testnet) during onboarding, and `/wallet/create`
sends both before returning: one sponsored transaction per network, each to
the user's own address with empty calldata and the authorization attached.
After that every transfer is a plain Calibur batch, Test mode needs no
on-chain step, and there is no delegation command over SMS at all. Cost:
about 0.02 MON per network per signup at today's gas price.

**Sending many transfers: Multicall3 batching.** One gateway key sends
everything; transfers that arrive together share one transaction through
Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, deployed on both
networks, checked 2 Oct). Calibur accepts the call from Multicall3 because
the signed `executor` is zero, so the user's signature doesn't change; that
field must stay zero.

The queue lives in the network's `Sponsor` DO, the single sender:

- **Flush when idle.** A signed, simulated transfer is appended to the
  queue. If no batch is in flight, the DO sends at once: a batch of one,
  so a quiet system is instant. Transfers that arrive while a batch is
  confirming wait and go together as the next batch the moment it lands
  (about a second on Monad). At most 50 calls per batch. A receipt not
  seen within 30 s answers the waiting callers with the tx hash marked
  pending, so a stuck batch never blocks the queue. No fixed timer, so nobody
  waits a few seconds for nothing.
- **One batch in flight.** The nonce simply goes up by one per batch. No
  pipelining, no gaps to repair; after an RPC error the DO rereads the
  pending nonce before the next send.
- **Failure isolation.** Batches use `aggregate3` with `allowFailure: true`
  on every call. Before sending, the DO simulates the whole batch and
  drops any call that would fail; that user gets an error straight away
  and the rest go ahead. Gas limit = the batch's estimate + 5%.
- **Per-user result.** Multicall3's per-call results aren't in the
  receipt, so each user's outcome is read from the receipt's AUSD
  `Transfer` logs from their address (or the CTK `Transfer` for local
  delivery): present means sent, absent means failed and the session
  returns to `open`.
- **Waiting callers.** `/tx/sign` waits for its batch and returns the tx
  hash (about a second online); the SMS reply goes out when the batch
  lands. Several users therefore share one tx hash, which is fine for
  receipts and the explorer link.
- **Signups ride in the same batch.** Every batch is one EIP-7702
  transaction: its `authorizationList` carries the pending signup
  delegations and its calldata is the Multicall3 `aggregate3` of the
  queued transfers. Delegations are applied before the calls run. An
  invalid authorization is skipped by the protocol rather than reverting,
  so a bad signup can't sink anyone's transfer (each is still checked
  before it is queued). Delegations leave no receipt log, so afterwards
  the DO reads each new user's code: pointing at Calibur means signed up;
  otherwise that signup is retried in the next batch. A batch with only
  signups calls `aggregate3` with an empty list.
- **Funding.** Monad bills the gas limit and, because execution trails
  consensus, requires the sender to cover gas still in flight (its
  reserve-balance rule; to be checked against Monad's docs). With one
  batch in flight that's one transaction's worth. A low-balance warning
  for the sender isn't built yet.

Fees go to `FEE_RECIPIENT`, a treasury address, not the sender key, so a
second sender key can be added later as configuration if one key ever
isn't enough.

**Gas.** Monad bills the gas limit, not gas used. Limit = estimate + 5%
(the 20% in the check script cost ~0.0036 MON extra per transfer).

## Transports out

`sendSms(phone, text)` picks the transport by number: `+91` goes to the
relay, everything else to Twilio. Replies to an inbound SMS go back on the
transport it arrived on.

**Relay protocol** (JSON over the WebSocket):

| Direction | Message |
| --- | --- |
| relay → gateway | `{type: "inbound", id, from, body, receivedAt}`; the relay keeps it until acked and resends unacked ones on reconnect |
| gateway → relay | `{type: "ack", id}` once the reply (if any) is queued |
| gateway → relay | `{type: "send", id, to, body}` |
| relay → gateway | `{type: "sent", id, ok, error?}` and later `{type: "delivered", id}` |
| both | `ping` / `pong` every 30 s |

If the relay is offline, outbound messages queue in the `Relay` DO for 10
minutes, then drop with a log line. OTP requests while it's offline return
an error the app can show ("Couldn't send the code, try again").

**Twilio**: inbound webhook, outbound REST `Messages` API from one US
number.

## Incoming-payment alerts

Both networks, from Alchemy Address Activity webhooks only (`alchemy.ts`,
ported from ender-backend; the per-minute log scan and its `cursors` table
are gone, `0006_alchemy.sql`). AUSD transfers touching a linked address go
into `transfers` (`activity.ts` `record`), and each recipient with alerts on
gets a text (`alertAll`). `transfers`' primary key and `alerts_sent` make a
repeated delivery harmless: one row, one text per transaction per number. A
transfer more than 10 minutes old (by the delivery's `createdAt`, e.g. a late
retry) is recorded but not texted about.

- **Webhooks.** The gateway makes its own Address Activity webhooks through
  Alchemy's Notify API (`https://dashboard.alchemy.com/api`, header
  `X-Alchemy-Token`), networks `MONAD_MAINNET` and `MONAD_TESTNET`,
  delivering to `ALCHEMY_WEBHOOK_URL`
  (`https://api.ender.money/webhooks/alchemy`). A webhook reports only
  addresses it held when the block was made and there is no backfill, so
  every linked address goes onto each network's webhook before it is handed
  out: `/wallet/create` pushes right after writing `links`, and the cron
  (still every minute, with reconcile) pushes anything not yet in
  `alchemy_addresses` (a failed push, links made another way). A network's
  first webhook is created with every address already linked; a webhook
  that reaches 100,000 addresses is left full and the next push creates a
  new one. `create-webhook` returns the signing key, stored sealed (AES-GCM
  under `SHIELDED_KEY_SECRET`, associated data `alchemy|<id>`), so nobody
  copies it by hand.
- **Deliveries** (`POST /webhooks/alchemy`): 401 unless the signature
  checks out. Keeps `category: "token"` activity whose
  `rawContract.address` is the network's AUSD, skips `removed` logs, takes
  `log.logIndex` / `log.blockNumber`, writes the rows, answers 200 (also
  when nothing matched) and sends the alerts after responding. A failed
  write answers 500 so Alchemy retries.
- With `ALCHEMY_AUTH_TOKEN` unset (or `ALCHEMY_WEBHOOK_URL` /
  `SHIELDED_KEY_SECRET`), no webhooks are made and incoming transfers go
  unrecorded.
- Alert text: `Received 10 AUSD from +9198…/0x12...cd. Balance 45.20 AUSD.`,
  prefixed `[Test] ` on testnet. Folding several alerts into one (30 s) is
  not built.

**Turning the webhook on** after deploying (`0006_alchemy.sql` applied
with `bun run gateway:migrate:remote`): copy the Notify auth token from the
Alchemy dashboard (Webhooks page, "Auth token") and run
`wrangler secret put ALCHEMY_AUTH_TOKEN -c gateway/wrangler.jsonc`. The
next cron minute creates both webhooks with every linked address (or the
next `/wallet/create`, whichever comes first); `wrangler tail` shows
`alchemy: created webhook <id> for <network>`. Nothing else to configure.

## Security

- The gateway key only pays gas; it holds a few MON per network. The worst
  case is losing that, never user funds.
- Signature, delegate address and chain ID checked before every send; the
  gateway relays nothing it can't rebuild from its own session.
- Phone ↔ address only revealed after an OTP; paying a number reveals the
  address only to a sender who is about to sign a transfer to it.
- Rate limits: Cloudflare rate-limit bindings per IP on `/auth/*`,
  `/tx/*`, `/wallet/*` and `/shielded/*`, plus per-number limits on OTP sends and SMS through the same
  binding keyed by phone.
- Phone numbers masked in logs (`+91 98•••••210`).
- Secrets: `GATEWAY_PRIVATE_KEY`, `JWT_SECRET`, `RELAY_TOKEN`,
  `SHIELDED_KEY_SECRET`, `GATEWAY_SHIELDED_SEED`,
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Twilio not built yet),
  `ALCHEMY_AUTH_TOKEN`. Plain vars in `wrangler.jsonc`: `FEE_AUSD`,
  `SMS_RETRIEVER_HASH`, `ALCHEMY_WEBHOOK_URL`. Alchemy webhook signing keys are not secrets to
  set: the gateway receives them when it creates a webhook and keeps them
  sealed in D1 (`alchemy_webhooks`).

## Emergency stop

There is no spending cap on Workers Paid. If the gateway runs away:

1. **Roll back** a bad deploy: Deployments → Rollback, or
   `bunx wrangler rollback -c gateway/wrangler.jsonc`.
2. **Pause**: set the `PAUSED` var to `"1"` (dashboard → Settings → Variables;
   saving deploys a new version at once). Every request gets
   `503 {"error":"paused"}` and the cron does nothing. Durable Objects and the
   prover only get work through the Worker, so they go quiet too. Set it back to
   `"0"` to resume.
3. **Cut a trigger**: delete the cron (Settings → Trigger events) or remove the
   `api.ender.money` route.
4. Deleting the Worker is the last resort: it wipes the Durable Objects' storage.

Caps already in place: `limits.cpu_ms` 5000 per invocation, the prover container
at one instance sleeping after 60 s, `IP_LIMITER` on the public routes. The
money that can actually run out is the gateway key's MON: keep a small float.
Turn on Notifications → Workers usage (weekly summary and the CPU-spike alert).

## Testing

- `bun test`: SMS parse/format round trips and the one-segment limit,
  digest rebuild against a signature made with the demo key, quote → sign
  happy path against an anvil fork of Monad, every error code.
- `bun test ./gateway`: the shielded tree against fixed-merkle-tree, key
  sealing, ref resolution, the owner policy and SMS routing
  (`shielded.test.ts`); the shielded flow end to end on anvil with the
  pool, MockAUSD, the real `Sponsor` and the prover container
  (`shielded.e2e.test.ts`; needs anvil, the spike's forge build and the
  `ender-prover` docker image, else skipped); Alchemy webhook creation,
  address pushes (including from `/wallet/create`) and the 100k rollover,
  signed deliveries, AUSD-only recording, one alert per transfer and the
  stale-alert rule, against a mocked Notify API and JSON-RPC
  (`alchemy.test.ts`).
- `wrangler dev` plus `scripts/play.ts`: plays the app with the demo key
  through both pipes, HTTPS and a dev-only `POST /dev/sms` that injects an
  inbound text as if the relay delivered it.
- Then the real thing: the relay phone, a second phone, mobile data off.

## Build order

1. **3 Oct** — `protocol/sms.ts` (grammar, formatter, segment check);
   session core; `/account`, `/tx/quote`, `/tx/sign`; `Sponsor` DO with the
   Multicall3 queue;
   `scripts/play.ts` over HTTPS against testnet.
2. **4 Oct** — SMS ingress: `Relay` DO and `/relay`, dedup, `/dev/sms`;
   the Android relay app (~200 lines of Kotlin); play the SMS path.
3. **5 Oct** — `/auth/*` with OTP through the relay, `GET /tx/:id` and the
   cron that finalises stuck sessions, `/wallet/create` with
   delegation on both networks, D1 `links`; deploy; first transfer from a fresh demo
   wallet over HTTPS and over SMS.
4. **9 Oct** — Twilio transport. (Alerts and `GET /activity` landed on
   2 Oct from a cron log scan; the Alchemy webhook replaced that scan on
   4 Oct.)

## Shielded pool (testnet, built 4 Oct)

Private payments through the split-key pool
([splitkey-spike.md](splitkey-spike.md); reference code
`spikes/nova-splitkey/src/gateway.mjs`). Testnet only: the pool is
`NETWORKS.testnet.pool` (`0xbe34…10ff`, deployed in block 68154262); a
network without a pool answers `unsupported`. The gateway holds each user's
proving keys (`nk`, viewing key, authority public key), never the authority
private key: it can rebuild, prove and relay exactly what the phone signed,
and can't spend, redirect or reprice. Code: `shielded.ts` (core, both
transports), `pool.ts` (index and Merkle tree), `prover.ts` (container).

**Storage** (D1, `0005_shielded.sql`):

| Store | Holds |
| --- | --- |
| `shielded_users` | `phone · network · Ax · Ay · nk · view_sk · owner_key · enc_pk · eoa · created_at`. `nk` and `view_sk` are AES-256-GCM ciphertexts under `SHIELDED_KEY_SECRET`, bound to `phone|network|field`; `owner_key` and `enc_pk` are the public parts of the shielded address; `eoa` is the number's linked wallet, the only account its deposits may come from |
| `pool_leaves` | `network · idx · commitment · ciphertext · block`, every `NewCommitment` |
| `pool_nodes` | the Merkle tree (23 levels, Poseidon, empty leaf `ZERO_VALUE`): `network · level · idx · hash`, level 0 the leaves, level 23 the root; an absent node is that level's zero. A path costs one query |
| `pool_appends` | one row per tree append `[from_size, to_size)`, keyed by `from_size`: two racing appends from the same size can't both commit (the D1 batch rolls back), so the tree is never built from stale siblings |
| `pool_nullifiers` | every `NewNullifier` |
| `pool_cursors` | the catch-up scan's last block and whether it reached the pool's leaf count |
| `shielded_notes` | `network · pos · phone · amount · blinding · nullifier · spent`: each user's notes, found by trial decryption |
| `shielded_quotes` | `id · phone · network · kind · to_phone · to_address · amount · fee · exp · state · ins · tx_hash · p · error`. Claimed like `sessions` (`open → sending → sent`); `ins` reserves the notes being spent while a SIG is proved; `exp` (10 minutes) is also the signed on-chain deadline |

**Indexing.** Every pool transaction goes through the gateway (deposits and
transfers are gateway-only on-chain, and open exits aren't supported yet), so
the index is fed from the gateway's own receipts: after each relayed
transaction its `NewCommitment` / `NewNullifier` logs are inserted, new
leaves are trial-decrypted for every registered user (`decryptNote` plus the
commitment check), notes whose nullifier appeared are marked spent, and the
tree is extended. There is no cron step. The only log scan is a catch-up on
first use, or after a gap (a leaf past the tree's end means a receipt was
missed): 100-block `eth_getLogs` filtered on the pool address only, from the
deploy block (or the gap) until the tree holds the pool's `nextIndex`
leaves, with the cursor saved after each chunk. At most 200 chunks per
request; beyond that the request answers `syncing` (503) and the next one
continues. The tree's root equals the pool's `getLastRoot()`.

**Prover.** `ProverContainer` (prover/, Cloudflare Containers: 1 vCPU,
3 GiB, 2 GB disk, one instance, asleep 60 s after its last request). The
Worker posts `witnessInput` (`witnessJson`) to `/prove` and turns the
snarkjs-shaped proof into the pool's arguments (`proofArgs`). Sending a `Q`
warms it (loads the circuit the quote will need), so the `SIG` that follows
doesn't wait on a cold start. Run `prover/sync.sh` before deploying.

**Sending.** `pool.transact` and `depositWithAuthorization` check
`msg.sender == gateway`, so they can't ride a Multicall3 batch: they are a
`direct` item in the network's `Sponsor` queue, sent alone by the gateway key
in queue order, so the nonce stays serialized with the sponsored batches.
The relayer in every transaction is `FEE_RECIPIENT` (the gateway key's
address on testnet) and the fee is `FEE_AUSD`.

**Quote** (`/shielded/quote`, `PAY` / `SHIELD` / `MERGE`): the sender must
be registered (`NOUSER`); a payment's recipient must be a registered number
(`NOUSER`), a withdrawal's any 0x address; a deposit needs the AUSD in the
linked wallet (`FUNDS`). For payments, withdrawals and merges the selection
rule (`protocol/select.ts`) runs on the sender's eligible notes first, so
`FUNDS` / `MERGE` come before the quote.

**Submit** (`/shielded/submit`, `SIG`), in order, before any gas:

1. Claim the quote (one `UPDATE … RETURNING`); a repeat after success
   returns the same transaction; any refusal below reopens it.
2. Resolve the refs to the sender's eligible notes (unspent, ≥ 0.001 AUSD,
   not reserved by another SIG in flight); a duplicate or unmatched ref is
   `REF`; colliding refs (positions 2^18 apart) try every combination, at
   most 64.
3. Rebuild the transaction with `buildTx` from the quote (change under
   0.001 AUSD goes to the fee; a change-free withdrawal has two null outputs
   via `withdrawOutputs`, so no leaves and no `p`); the signature must verify
   (`BADSIG`). A deposit instead rebuilds `buildDeposit` and recovers the
   EIP-3009 signer, which must be the number's wallet.
4. Policy (`POLICY`): inputs are the one sender's notes, or the gateway's
   zero-value deposit dummies (signed with its own authority key, from
   `GATEWAY_SHIELDED_SEED`); every non-null output belongs to a registered
   user; deposits only from a registered wallet.
5. Prove, send as a `direct` item, wait for the receipt, index its logs.
6. A payment to another number texts them
   `Got <amt> AUSD from <number> p=<pos> b=<blinding>` (alerts switch on,
   `canText`, once per transaction through `alerts_sent`).

**HTTPS** (JWT like every other route; `network` defaults to `testnet`):

| Call | Does |
| --- | --- |
| `POST /shielded/register {network, keys: {Ax, Ay, nk, viewSk}}` | decimal strings; `viewSk` is the 32 key bytes as a big-endian integer. Returns `{owner}`, the 64-byte packed shielded address in unpadded base64 (`protocol/sms.ts` `b64`). `eoa` = the number's linked wallet. Idempotent; other keys for the same number are `key-changed` (409), the same keys under another number `key-in-use` (409) |
| `GET /shielded/notes?network=` | `{notes: [{pos, amount, blinding, spent}], root}`: the number's whole index, spent included (amount, blinding and root as decimal strings) |
| `POST /shielded/quote {network, kind, to?, amount}` | `kind`: `pay` (to a number), `withdraw` (to a 0x address), `shield`, `merge` (amount ignored). Returns `{id, exp, fee, to?}`: `to` is the recipient's packed address (base64) for `pay`, the address for `withdraw`, absent otherwise |
| `POST /shielded/submit {id, refs?, sig?, signature?}` | `refs` (tree positions) + `sig` (64-byte EdDSA, base64, padded or not) for pay / withdraw / merge; `signature` (0x, 65-byte EIP-3009) for shield. Returns `{tx, p?}` after the receipt (`p` = position of output 0; absent for a change-free withdrawal); `{tx, pending: true}` if the receipt didn't come within 30 s, and a repeated submit settles it |
| `GET /shielded/address?network=&phone=` | `{owner}` of a registered number, so the app can pin a contact's key online; `NOUSER` (404) otherwise |

Errors are the usual `{error}` with the SMS codes: `NOUSER`, `FUNDS`,
`MERGE`, `REF`, `BADSIG`, `UNKNOWN`, `EXPIRED`, `NOEOA`, `POLICY`, plus
`unsupported`, `syncing`, `in-progress`, `reverted`, `failed`, `bad-*`.

**SMS** (parsed and formatted by `protocol/sms.ts`; always testnet):

| In | Out |
| --- | --- |
| `PAY <+number>, <amount> AUSD` | `Q <id> exp=<unix> fee=0.01 to=<86-char shielded address>` |
| `PAY <0x address>, <amount> AUSD` (withdrawal) | `Q <id> exp=<unix> fee=0.01 to=0x<40>` |
| `MERGE` | `Q <id> exp=<unix> fee=0.01` |
| `SHIELD <amount> AUSD` | `Q <id> exp=<unix> fee=0.01` |
| `SIG <id> <refs> <86-char signature>` | `Sent 20 AUSD to +91…. Tx 0xab…ef p=2` (no `p=` for a change-free withdrawal) |
| `SIG <id> <88-char signature>` for a `SHIELD` quote | `Shielded 50 AUSD. Tx 0xab…ef p=0` |

A public-shaped `SIG` is a deposit's if its id is the number's `SHIELD`
quote, else today's public `SIG`. Errors are `ERR [<id>] <code>` with the
codes above; `ERR <id> pending` if the transaction was sent but not yet
confirmed (repeat the `SIG`).

**Secrets**: `SHIELDED_KEY_SECRET` (any long random string; losing it means
every user registers again) and `GATEWAY_SHIELDED_SEED` (hex, 32+ bytes,
e.g. `openssl rand -hex 32`), set with `wrangler secret put` and, for
`wrangler dev`, in `gateway/.dev.vars`. Neither is ever logged, nor are
`nk`, viewing keys or prover request bodies.

**Not built**: a scan for pool transactions the gateway didn't relay (open
exits; `TODO(open-exit)` in `pool.ts`), backfilling notes for keys
registered after they received notes (the policy makes that impossible
today), alert MACs.

## Not in the gateway

Several relay phones, fee bumping for stuck transactions, push
notifications, an admin UI, server-side activity history, escrow for
numbers not on Ender.

## Decided

- Fee: flat 0.01 AUSD per transfer for now (`FEE_AUSD`), paid to `FEE_RECIPIENT`.

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
| D1 `alerts_sent` | `tx_hash · phone`, so a transfer we sent isn't alerted twice when Alchemy reports it too |
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
| `GET /account?network=` | balance, Calibur nonce (`getSeq(0)`), delegated yes/no, and an INR rate for the `≈ ₹` line |
| `POST /tx/quote {network, to, amount, deliver?}` | `to` is an address or phone number. Returns `{id, to, amount, fee, out?, nonce, deadline, calls}`; the app rebuilds and checks `calls` before signing |
| `POST /tx/sign {id, signature}` | runs the checks below, sends, returns `{txHash}` |
| `GET /relay` | WebSocket upgrade for the Android relay; `Authorization: Bearer <RELAY_TOKEN>` |
| `POST /webhooks/twilio` | inbound SMS; checks `X-Twilio-Signature` |
| `POST /webhooks/alchemy` | address activity; checks `X-Alchemy-Signature` (port from `ender-backend`) |

## SMS commands

Parsed and formatted by `protocol/sms.ts`, shared with the app. Identity is
the sender's number as the carrier delivered it. A number with no `links`
row gets `ERR not-registered` to every command, since signing up needs the
app online.

| In | Out |
| --- | --- |
| `SYNC` / `SYNC T` | `OK n=3 dlg=1 AUSD=45.20 inr=83.9`; `T` also switches the phone to testnet |
| `SEND <address or +number>, <amount> AUSD[ > CTK]` | `Q <id> n=4 exp=<unix> fee=0.001 to=0x<40>[ out=<ctk>]` |
| `SIG <id> <sig>` | `Sent 10 AUSD to 0x12…cd. Tx 0xab…ef` |
| anything else | `ERR <id?> bad-command` |

Errors: `expired`, `low-balance`, `bad-sig`, `not-on-ender`, `not-registered`,
`rate-limited`. Duplicates are handled by the session rules above. Every outbound message is checked to fit one GSM-7
segment; replies to Android numbers append the SMS Retriever hash.

OTP text: `Ender code: 481926. Don't share it.` plus the Retriever hash.

## Session core

**Quote** (same for `/tx/quote` and `SEND`):

1. Resolve the recipient: an address as given, or a phone number through
   `links` (`not-on-ender` if absent).
2. Fee: flat 0.001 AUSD for now, from a `FEE_AUSD` var, paid to `FEE_RECIPIENT` (a
   treasury address, not whichever sponsor key sends the transaction).
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
  (about a second on Monad). At most 50 calls per batch; a DO alarm
  flushes as a backstop if anything stalls. No fixed timer, so nobody
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
  batch in flight that's one transaction's worth. The cron warns when the
  sender runs low.

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
| relay → gateway | `{type: "inbound", from, body, receivedAt}` |
| gateway → relay | `{type: "send", id, to, body}` |
| relay → gateway | `{type: "sent", id, ok, error?}` and later `{type: "delivered", id}` |
| both | `ping` / `pong` every 30 s |

If the relay is offline, outbound messages queue in the `Relay` DO for 10
minutes, then drop with a log line. OTP requests while it's offline return
an error the app can show ("Couldn't send the code, try again").

**Twilio**: inbound webhook, outbound REST `Messages` API from one US
number.

## Incoming-payment alerts

- **Mainnet**: an Alchemy Address Activity webhook on AUSD transfers to
  linked addresses. `/wallet/create` adds the address to the webhook before
  returning, so no payment is missed.
- **Testnet**: Alchemy's Monad testnet support is unconfirmed. Fallback: the
  cron reads AUSD `Transfer` logs to linked addresses every minute
  (`eth_getLogs` from the last seen block).
- Alert text: `Received 10 AUSD from 0x12…cd. Balance 45.20 AUSD.` At most
  one alert per number per 30 s; extras are folded into the next one.

## Security

- The gateway key only pays gas; it holds a few MON per network. The worst
  case is losing that, never user funds.
- Signature, delegate address and chain ID checked before every send; the
  gateway relays nothing it can't rebuild from its own session.
- Phone ↔ address only revealed after an OTP; paying a number reveals the
  address only to a sender who is about to sign a transfer to it.
- Rate limits: Cloudflare rate-limit bindings per IP on `/auth/*` and
  `/tx/*`, plus per-number limits on OTP sends and SMS through the same
  binding keyed by phone.
- Phone numbers masked in logs (`+91 98•••••210`).
- Secrets: `GATEWAY_PRIVATE_KEY`, `JWT_SECRET`, `RELAY_TOKEN`,
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ALCHEMY_AUTH_TOKEN`, Alchemy
  webhook signing key, `SMS_RETRIEVER_HASH`.

## Testing

- `bun test`: SMS parse/format round trips and the one-segment limit,
  digest rebuild against a signature made with the demo key, quote → sign
  happy path against an anvil fork of Monad, every error code.
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
3. **5 Oct** — `/auth/*` with OTP through the relay, `/wallet/create` with
   delegation on both networks, D1 `links`; deploy; first transfer from a fresh demo
   wallet over HTTPS and over SMS.
4. **9 Oct** — Twilio transport, Alchemy webhook and testnet log polling,
   alerts.

## Not in the gateway

Several relay phones, fee bumping for stuck transactions, push
notifications, an admin UI, server-side activity history, escrow for
numbers not on Ender.

## Decided

- Fee: flat 0.001 AUSD per transfer for now (`FEE_AUSD`), paid to `FEE_RECIPIENT`.

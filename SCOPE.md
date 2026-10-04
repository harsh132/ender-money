# Ender Money — scope

Hackathon build of the SMS wallet in the design doc
("SMS Wallet on Monad — Design Doc"). Monad Metropolis, Consumer Products &
Payments track. Deadline 13 Oct 2026.

One sentence: send and receive AUSD on Monad with a passkey instead of a
seed phrase, over the internet when there is one and over plain SMS when
there isn't.

## In scope

| Area | What ships |
| --- | --- |
| Account | No contract of our own. The user's EOA delegates by EIP-7702 to **Calibur v1.1.0** (Uniswap's audited 7702 account), already deployed on Monad mainnet and testnet. |
| Gateway | Cloudflare Worker at `api.ender.money` (see [docs/gateway.md](docs/gateway.md)). HTTPS API plus `SYNC` / `SEND` / `SIG` over SMS through one session core; verify, `eth_call` simulate, broadcast, reply. Alchemy webhook for incoming alerts. Private payments on testnet only (`/shielded/*`, `PAY` / `SHIELD` / `MERGE` over SMS). |
| Transports | Android relay app (Kotlin, ~200 lines, WebSocket to the DO) for Indian SIMs. Twilio number for everyone else. Picked automatically from SIM country. |
| App | Expo SDK 57 dev build, Bun ([app/README.md](app/README.md)). Mera (`@category-labs/mera`) + `react-native-passkey` (the binding Mera's React Native client is written for) for keys. `expo-sms` composer for sending. Screens below. |
| Token | AUSD only. Static token table shared by app and gateway. |

## Transport: internet first, SMS fallback

The app talks to the gateway over HTTPS whenever the internet is
reachable, and falls back to SMS when it isn't. Same gateway, same session
logic in the Durable Object, same signatures; only the pipe changes.

| Step | Online (HTTPS) | Offline (SMS) |
| --- | --- | --- |
| Balance, nonce, delegation | `GET /account` | `SYNC` |
| Ask for a quote | `POST /tx/quote` | `SEND …` via the composer |
| Quote back | in the HTTP response, instant | reply SMS, picked up from the clipboard (SMS Retriever on Android) |
| Submit the signature | `POST /tx/sign` | `SIG …` via the composer |
| Receipt | HTTP response | reply SMS |
| Incoming-money alert | SMS (both cases; works with data off) | SMS |

- **Choosing the pipe.** Before each step the app checks reachability
  (`@react-native-community/netinfo`, `isInternetReachable`). An HTTPS
  call that fails or times out (5 s) falls back to SMS for that step.
  The choice is per step, so a transfer can start online and finish by
  text.
- **Why falling back is safe.** Only the signature moves money, and the
  Calibur nonce makes it single-use. A quote request sent twice (once
  online, once by text) just makes two quotes; a signature sent twice
  lands once.
- **Copy is pipe-agnostic.** Progress says "Request sent", "Quote
  received", "Approve with fingerprint", "Sent", never "texted". A small
  pill in the header says **Internet** or **Text**, and offline the
  screen adds one line: "No internet, sending over SMS." Home shows a banner only when offline ("No internet,
  payments go by text") or with no service at all ("No signal, sending
  will wait").
- **Demo.** Run the same transfer twice: once online (instant), once with
  data off (by text). The pill and the banner make the switch visible.

## Chain and account

**Two networks, mainnet by default.** A new wallet starts on Monad
mainnet. Settings has a **Test mode** switch that moves the wallet to Monad
testnet, where Agora's Instant Settlement can be used (mainnet swaps need
Agora KYC; testnet whitelisting is permissionless). Same passkey, same
address on both; balances, nonce, delegation and activity are kept per
network.

| | Mainnet (143), default | Testnet (10143), Test mode |
| --- | --- | --- |
| Calibur v1.1.0 | `0x000000005c84F8Fd50b21CAC312528A64437030e` | same address, already deployed (checked 2 Oct) |
| AUSD (6 dec) | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, faucet available |
| Instant Settlement pair | AUSD/USDC `0xf33286E3222D1c829dACeac48c0Ec651F6452470`, KYC-whitelisted swappers only: unused | AUSD/CTK `0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae`, self-whitelist via `0x7c10F56d6f04a51376393a1C3670e966863F6BD5` |
| Factory | `0x8468587Af422ad440F58a57E955eCA6A970b5375` | same |

Mainnet demo amounts are a few dollars. The gateway holds a little MON on
both networks.

**How the switch works**

- The network table (chain ID, RPC, Calibur, AUSD, pair) lives in
  `protocol/` and is shared by app and gateway. One table, two rows.
- The gateway keeps the network per phone number (`links.network`).
  The app tells it with `SYNC`: `SYNC 0x<addr>` is mainnet, `SYNC 0x<addr> T`
  is testnet. Flipping the switch sends that `SYNC`, which the app needs
  anyway for the new network's balance and nonce. `SEND` / `SIG`
  are unchanged and run on the phone's current network.
- Every signature binds the chain ID (Calibur's EIP-712 domain, the 7702
  authorization), so a message that reaches the gateway on the wrong
  network fails verification instead of moving money.
- No on-chain step when switching: the account is delegated on both
  networks at signup.
- In Test mode the app shows a persistent **Test mode** chip on Home and
  Send, in the warning colour, so test balances are never mistaken for
  real money. Mainnet shows nothing extra.
- Alchemy alerts: one webhook per network, both pointing at the gateway.

**Why Calibur instead of our own `SmsWallet`.** Everything the design doc
asked of `SmsWallet` is already in Calibur's
`execute(SignedBatchedCall, wrappedSignature)`:

| Doc requirement | Calibur |
| --- | --- |
| EIP-712 signature by the account itself | root key (`keyHash = 0`) signs `SignedBatchedCall`; domain is `Calibur` / `1.0.0` (v1.1.0 keeps the 1.0.0 domain version) / chain ID / the user's address / salt = Calibur address |
| Own nonce, separate from the account nonce | 2D nonce manager, `getSeq(0)` |
| Deadline enforced on-chain | `deadline` field in the signed struct |
| Transfer + fee to gateway | one batch of two calls: `AUSD.transfer(to, amount)`, `AUSD.transfer(treasury, fee)`, `revertOnFailure = true` so the fee is only paid if the transfer lands |
| Gateway submits and pays gas | anyone may submit when `executor = 0`; the signature decides if it runs |

What that buys: no contract to write, test, audit or deploy (saves ~1.5
days); an audited account holding real money; and `ender-backend` and
`wallet2` already run this exact pattern (sponsored Calibur batches,
root-key signing, gateway-checked 7702 authorization), so the encoding and
typed-data code are ported, not written.

What it costs: the signed payload is a call batch rather than a flat
`{token, to, amount, fee}` struct. The app builds the batch from the
readable fields and shows those fields, never raw calldata. SMS is
unchanged: `SIG` still carries only the 65-byte signature, and the gateway
rebuilds the identical batch from the session.

**Protocol changes from the doc**

- No `DLG` over SMS. Delegation happens once, online, at signup, on both
  networks: the app signs two 7702 authorizations to Calibur's fixed
  address and `/wallet/create` sends them. The gateway rejects any other
  delegate (an authorization to other code would hand the address over,
  with us paying gas).
- `SYNC` reply `n=` is Calibur's `getSeq(0)`. `SYNC` takes an optional
  ` T` suffix for testnet.
- Quote `fee=` becomes the second call in the batch. Fee: flat 0.01 AUSD
  for now, paid to a treasury address (`FEE_RECIPIENT`).
- Linking a number to a wallet is **not** an SMS command. It happens
  online during onboarding or a number change in Settings, with an OTP
  (see Onboarding). SMS stays for transacting: `SYNC`, `SEND`
  and `SIG`.
- `SEND` accepts a phone number as recipient (`SEND +919876543210, 10
  AUSD`); the quote then carries the resolved `to=0x<40 hex>` (~100
  characters, still one segment).
- `SEND` takes an optional ` > CTK` suffix for local-currency delivery
  (Test mode only, below); the quote then also carries `out=`, the CTK
  the recipient gets.

## Onboarding

Mocked in [docs/mockups.html](docs/mockups.html). **Onboarding needs
internet once**; after it, everything works on SMS alone. The phone number
is verified first, so the gateway can say up front whether this person
already has a wallet: one entry point, no separate create and restore
paths for the user to choose between.

**Flow**

1. **O1 Welcome** — one button, "Log in". Note: "Setup needs internet
   once. After that, just signal."
2. **O2 Your number** — prefilled from the SIM (`TelephonyManager`),
   editable. The SIM country also picks the gateway (India phone vs
   Twilio). "Send code" → `POST /auth/start`.
3. **O3 Enter the code** — 6 digits, filled in automatically on Android by
   the SMS Retriever (the gateway writes the OTP text, so it can carry the
   app hash; no SMS permission). Resend after 45 s; "Wrong number?" goes
   back. "Verify" → `POST /auth/verify`, which answers **new** or
   **existing**.

**New number** (N1 → N3)

- **N1 Create passkey** — "Your fingerprint is your key". Before creating,
  the app checks Android's Credential Manager for an Ender passkey already
  on the phone, without UI (`preferImmediatelyAvailableCredentials`). That
  catches someone who changed numbers: if one exists, the app offers "Use
  your existing wallet" instead, which moves the new number to it. If none,
  it creates a passkey named `Ender` for `ender.money` (Mera +
  `react-native-passkey`) and derives the address (PRF → BIP-39 entropy →
  `m/44'/60'/0'/0/0`, Mera's recipe). Built: `react-native-passkey` has no
  silent check, so N1 offers "I already have an Ender passkey" instead,
  which opens the system picker and moves the number to that wallet.
- **N2 Setting up** — `POST /wallet/create` with two signed 7702
  authorizations to Calibur, one per network (one passkey prompt signs
  both). The gateway sends both sponsored delegations, waits for them
  (about a second each on Monad), then links the number.
- **N3 Ready** — number, $0.00, "Now try it with mobile data off." Alerts
  are on by default and live in Settings; no toggle during onboarding.

**Existing number** (E1 → Home)

- **E1 Welcome back** — shows the wallet's short address and balance
  (only after the code is verified, so a typed number can't be used to
  look someone up). "Use my passkey" opens the system picker; the app
  derives the address and compares it with the one the gateway returned.
  Match → Home. Different passkey → "That passkey belongs to another
  wallet. Pick the other Ender passkey." No passkey on this phone → the
  picker says so and E1 suggests checking the Google account.
- **E2 Lost passkey** — "I lost my passkey" leads here. Plain warning:
  without its passkey nobody can open the old wallet, not even Ender; its
  balance stays there. "Start a new wallet" → N1, then `POST
  /wallet/create` with `relink: true`. Payers who pinned the old address
  get the "address changed" warning on their next transfer, which is
  correct here.

**Gateway API** (HTTPS, only for onboarding and number changes)

| Call | Does |
| --- | --- |
| `POST /auth/start {phone}` | sends a 6-digit OTP through the normal SMS transport; 10 min expiry, 5 attempts, at most 3 sends per number per hour, plus a per-IP limit |
| `POST /auth/verify {phone, code}` | returns a short-lived token and `{status: "new"}` or `{status: "existing", address, balance}` |
| `POST /wallet/create {token, address, network, authorization, relink?}` | checks the authorization (Calibur only, right chain), links the number to the address, submits the delegation, returns balance and nonce. Refuses an already-linked number unless `relink` |

The OTP proves control of the number; the 7702 authorization proves
control of the address. Restoring onto an existing wallet needs no write:
the passkey proves the address locally, and balance comes back with
`/auth/verify`. A number change in Settings reuses O2 → O3 and
`/wallet/create` with `relink`.

Note for India: OTPs from the relay phone's personal SIM are fine at
hackathon scale. At real volume, carriers treat OTP traffic as commercial
and it would need a DLT-registered sender; Twilio covers non-Indian
numbers either way.

**Device test (day 3, first thing):** on a real Android phone with data
and wifi off: create a passkey, sign in with an existing one, and repeat
after a reboot. Sign-in must work offline (every transfer approval
depends on it); if it doesn't, keep the key in a Mera secret vault
unlocked once per Quick send session. Creation offline is a bonus.

Not in onboarding: contacts permission (asked the first time the user
picks a contact to pay), Test mode (Settings only), Quick send (opens on
the first transfer).

## Sending to a phone number

Recipient field accepts a phone number, a contact (`expo-contacts`, asked
on first use), an address, or a QR scan.

- The app sends `SEND +91…, 10 AUSD`. The gateway looks the number up and
  returns the address in the quote (`to=`), so the user signs a transfer
  to a concrete address.
- **Trust.** The gateway is now trusted to resolve numbers honestly the
  first time. Limits on that: the review screen shows the name, number
  and short address; the app pins number → address after the first
  transfer and shows a warning if the gateway ever returns a different
  address; and the recipient gets an SMS alert, so a misroute surfaces
  fast. Stated plainly in the write-up.
- **Number not on Ender.** The gateway replies `ERR not-on-ender`. The app
  offers "Invite", which opens the composer to the recipient from the
  user's own phone with a short invite text. No money moves. Holding funds
  for unregistered numbers (escrow and claim) is out of scope.
- Numbers are normalised to E.164 on both sides before lookup.
- **Privacy (planned):** a number resolves to a per-payer stealth address
  instead of the recipient's main wallet, so looking numbers up reveals
  nothing on-chain. Scoped in [docs/stealth.md](docs/stealth.md).

## Signing sessions (Mera)

Mera's `createSecp256k1SigningSession({ privateKey })` holds the
passkey-derived key in memory and signs digests until `end()` zeroes it.
It has no expiry or limits of its own, so the app enforces the scope.
Required by the Mera UX bounty ("prompt-free signing via Mera signing
sessions with a clearly scoped session").

**Quick send** — one passkey prompt opens a session. While it is open,
transfers that fit inside it are signed with no prompt.

| Prompt-free (inside the session) | Always re-prompts |
| --- | --- |
| a transfer of ≤ $20 | anything over $20, or one that would take the session past $50 total |
| to a recipient already in Recent | a new recipient |
| within 10 minutes of opening | Test mode switch, phone number change |

The session ends, with `end()`, at whichever comes first: 10 minutes, the
$50 total, the app going to the background, or the user tapping "End".
Ending is silent; the next transfer simply asks for the passkey again.

UX: a small chip on Home and Send, "Quick send · 8 min left", tappable to
end it. The confirm screen says "Sending without fingerprint (Quick
send)" so the user always knows which path they're on. Limits are
constants in the app for the hackathon, not settings.

**Stateless test** (also required by the Mera bounty: judges clear storage
or use a fresh device mid-demo). From the passkey alone the app rebuilds
the address; one `SYNC` restores balance, nonce and delegation status; the
network defaults to mainnet. Lost on a fresh device: Recent recipients and
local activity, which are conveniences. Stretch: encrypt them with a Mera
secret vault (a second PRF namespace) and park the ciphertext with the
gateway when data is on. That also fits the "One Passkey, Many Keys"
bounty.

## Local-currency delivery (Test mode)

Cross-border angle for the Agora bounty. On the Send screen in Test mode,
a "Recipient gets" switch picks **AUSD** or **CTK**. CTK is Agora's test
token on the testnet Instant Settlement pair; in production that pair
would be AUSD against a local stablecoin. The UI labels it honestly as a
test token standing in for local currency, never as rupees.

- Batch: `AUSD.approve(pair, amount)`,
  `pair.swapExactTokensForTokens(amount, minOut, [AUSD, CTK], recipient,
  deadline)`, `AUSD.transfer(gateway, fee)`. One signature, atomic,
  settled in one transaction.
- Fixed-price quote: the gateway reads `getAmountsOut` and returns `out=`
  in the quote SMS; `minOut` in the signed batch is that number, so the
  recipient gets at least what the sender saw.
- The pair only swaps for `APPROVED_SWAPPER` accounts. On the first switch
  to Test mode the gateway calls the testnet whitelister's
  `setApprovedSwapper` for the user's address (permissionless on testnet,
  gateway pays the gas).
- Mainnet: hidden. The mainnet pair is AUSD/USDC and needs Agora KYC.

## Bounties we target

| Bounty | Prize | How |
| --- | --- | --- |
| Consumer Products & Payments (track) | $30k pool | the whole app. 45% of the score is founder/market readiness and traction: name the user segment (migrant workers sending money home over plain SMS), test with 5+ real people, write a distribution plan |
| Agora: Cross-Border Payments | $10k | AUSD transfers, Mera onboarding, Instant Settlement local-currency delivery in Test mode |
| Mera-Powered UX | $2.5k | Mera is the whole account layer; Quick send sessions; passes the stateless test; Calibur + gas sponsorship for the bonus |
| Alchemy | $1k credits | incoming-payment webhooks on both networks |

Not targeted: Community Team (team not in a listed group), Dynamic and
Privy (they would replace Mera), Envio, Chainlink CRE, and the trading/AI
bounties. **Aurora Intents ($5k)** is deferred: suggest any-chain deposits
on mainnet once everything above is done.

Submission (track): logo, public GitHub repo shared with
`metropolis@hackathon.monad.xyz`, technical demo video ≤ 3 min of the live
product, pitch video ≤ 2 min, live link with access instructions. Agora
also wants a ≤ 2 min video of onboarding, balance and a completed
send/receive. Bounty deadline 14 Oct 09:29 IST.

## Out of scope (hackathon)

Escrow for payments to numbers not on Ender, swaps (other than
local-currency delivery above), NFTs, contract calls, multiple tokens in the UI, iOS auto-send,
feature phones, voice/MMS transport, multiple gateways per country,
production scale, light theme, Calibur's extra features (P256/WebAuthn
keys, hooks, 4337), on-chain session keys (Quick send scope is enforced in
the app), Aurora deposits (deferred, see Bounties).
Private balances (shielded pool) on mainnet: built for testnet only (the
split-key pool, [docs/splitkey-spike.md](docs/splitkey-spike.md); gateway
side in [docs/gateway.md](docs/gateway.md#shielded-pool-testnet-built-4-oct)).
Mainnet needs a multi-party trusted setup and an audit first
([docs/todo.md](docs/todo.md)). Options and target design:
[docs/shielded-pool.md](docs/shielded-pool.md).

## Repo layout

```
ender-money/
  protocol/    TS. SMS message parse/format, token table, Calibur batch
               + EIP-712 types. Imported by gateway and app so the two
               can't drift.
  gateway/     Cloudflare Worker + Durable Objects (wrangler, Bun); see docs/gateway.md
  prover/      Groth16 prover container for the shielded pool (testnet); see prover/README.md
  relay/       Android relay app (Kotlin). Never shipped to users.
  app/         Expo app (Bun, dev build)
```

Bun workspaces over `protocol`, `gateway`, `app`. `relay` builds with Gradle.

## App: screens

Seven screens plus one sheet. Dock: Home / Activity / Settings. Everything
reachable in two taps from Home.

1. **Onboarding** — number → code → create or welcome back; see the
   Onboarding section. One passkey prompt.
2. **Home** — balance hero, Send / Receive tiles, QR scanner button top
   right (scan an address or Ender QR straight into Send), Quick send chip
   while a session is open, Test mode chip in Test mode, recent activity
   (last 5), dock. No permanent signal chip; a "No signal, sending will
   wait" banner appears only when there is no cell service.
3. **QR scanner** — full-screen camera from the Home button or the Send
   recipient field: "Scan to pay", torch, and "Paste address" / "Enter
   number" fallbacks. Reads an Ender code (address plus optional amount)
   or a plain address. `expo-camera`, which scans barcodes itself.
4. **Send** — recipient (phone number, contact, address, QR scan, or
   recent), then a big-number
   keypad for amount. Max button. Shows balance under the amount. In Test
   mode, a "Recipient gets AUSD / CTK" switch.
5. **Review & progress** — one screen that turns into the progress tracker:
   amount, recipient, fee, total (and CTK delivered, if chosen). Says
   whether it will ask for the fingerprint or go through Quick send, and
   shows an Internet / Text pill. Steps: Request sent → Quote received →
   Approve (passkey) → Sent. Online the first two take a moment; offline
   the request goes through the composer and the quote comes back by
   text. Countdown to deadline. Retry button per step (failure table in the
   doc maps 1:1 to these states).
6. **Activity** — all transfers, grouped by day. Tap for detail sheet
   (amount, counterparty, fee, tx hash, state).
7. **Receive** (sheet) — QR, address, copy/share.
8. **Settings** (dock tab) — phone number, alerts toggle, **Test mode**
   switch (off by default; on = Monad testnet), gateway (Auto / India /
   International), "Sync now", app version, "Built on Monad" mark.

### Reading gateway replies (SMS path only)

Biggest UX risk offline: the user has to get the quote SMS back into the
app. Online there is nothing to read; the reply is the HTTP response.

- Demo default: app watches the clipboard on focus and shows a
  "Quote found — continue" banner when it sees `Q <id> ...`. One tap.
- Day 10 (was stretch, now planned with the time Calibur saves): Android
  SMS Retriever. Gateway appends the app hash to replies; the app reads
  them with no SMS permission. Removes the paste step entirely on Android.
  ~11 characters per reply, still one segment.

## Visual direction

Reference: dark wallet home with a large balance, two big action tiles and
a floating dock. Same structure, palette derived from Agora's site
(agora.finance), larger type. Palette only: no Agora logo or name in the
UI, so it never reads as Agora's own app.

**Colour** (dark only, warm; gold is the one accent)

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#141411` | page, warm near-black |
| `surface` | `#1E1D1A` | tiles, rows, sheets, banners |
| `surface-2` | `#2A2925` | pressed, inputs, dock, avatar |
| `line` | `rgba(245,241,237,0.09)` | hairlines, tile borders |
| `fg` | `#F5F1ED` | cream, primary text |
| `fg-2` | 64% of `fg` | secondary text |
| `fg-3` | 40% of `fg` | hints, disabled |
| `accent` | `#CDC971` | olive-gold: primary button, small marks |
| `accent-press` | `#B5B15C` | pressed primary button |
| `accent-ink` | `#141411` | text and glyphs on gold |
| `negative` | `#E8907A` | errors, failed state |
| `warning` | `#E8B65C` | Test mode chip and banner |
| `positive` | `#9CC5A6` | incoming amounts |

Gold is allowed on: the one primary button per screen, active dock icon,
Send/Receive glyphs, links ("See all"), progress bullets, toggles, focus
ring, small inline icons. Never on backgrounds, tiles, cards or secondary
buttons (those are `surface`). Home has no primary button.

Primary button: `accent-ink` on gold, ~10:1, passes AA at any size.

**Type** — three families, each with one job:

- **Newsreader** (serif, 500): balance hero, amount entry, onboarding
  headline. The Agora feel lives here.
- **Geist**: all other UI text.
- **Geist Mono**: addresses and tx hashes.

Tabular numerals everywhere money appears. Sizes go one step bigger than
usual:

| Role | Family | Size / weight |
| --- | --- | --- |
| Balance hero | Newsreader | 64 / 500 |
| Amount entry | Newsreader | 72 / 500 |
| Onboarding headline | Newsreader | 38 / 500 |
| Screen title | Geist | 30 / 700 |
| Section title | Geist | 22 / 600 |
| Body, row title | Geist | 18 / 500 |
| Secondary, row meta | Geist | 16 / 400 |
| Caption, chip | Geist | 14 / 500 |

Minimum text size 14. Touch targets 56pt+. Rows 72pt tall.

**Shape** — radius 24 tiles, 20 rows/inputs, full pill buttons and dock.
Faint dot grid behind the balance (echoes the reference texture). No
shadows except the dock.

Mockups: [docs/mockups.html](docs/mockups.html).

## Build order

Today is 2 Oct. Bounty deadline 14 Oct 09:29 IST; we aim to submit 13 Oct.

1. 2 Oct — `scripts/onchain-check.ts`, on both networks: a 7702 delegation
   to Calibur and a sponsored batch (AUSD transfer + fee) signed by the root
   key, gateway pays gas. Mainnet simulation passes (211k gas limit); the
   `--send` runs are done by hand.
2. 3–5 Oct — `protocol` + `gateway` + `relay`: HTTPS endpoints and the SMS
   path over one session core, hand-signed messages end to end on both.
3. 5–7 Oct — `app` shell: dev build, passkey/mera, typed-data signing,
   composer, Home/Send/Review screens, Quick send sessions.
4. 8 Oct — onboarding: `/auth/*` OTP, passkey, `/wallet/create`
   delegation, phone registration live; Test mode switch.
5. 9 Oct — Alchemy webhooks + alerts. Twilio transport.
6. 10 Oct — SMS Retriever on Android; local-currency delivery on testnet.
7. 11 Oct — error states, retries, stateless-test rehearsal, five real
   users try it (traction evidence), polish on two real phones.
8. 12 Oct — logo, demo video, pitch video, Agora video, write-up,
   distribution plan. 13 Oct — submit, 14 Oct morning as buffer.

## Decided

- Currency: `$` primary, `≈ ₹` line. The app ships with 96 INR per USD and
  replaces it with the latest rate it sees: `/account` online, `inr=` in the
  `SYNC` reply offline. The gateway gets it from Frankfurter (ECB daily
  rates, no key) and caches it for an hour.
- Dock: kept (Home / Activity / Settings).
- Recipients: phone numbers as well as addresses (above).

# SMS reference

Every text Ender sends or receives, as the code does it after `91a136f` plus
Ender IDs of 5-20 characters, one `Received` for public and private incoming
payments, and Ender IDs / reverse ENS in place of addresses where they fit
("Who appears in texts"). The
grammar lives in `protocol/sms.ts` (with `protocol/recipient.ts` for
recipients and `protocol/shielded.ts` for private payments); the gateway side
is `gateway/src/sms.ts`, `auth.ts`, `activity.ts`, `names.ts` and `shielded.ts`; the app
side is `app/src/lib/transport.ts`, `wallet.ts`, `private.ts`, `inbox.ts` and
`app/modules/sms-retriever`. Gateway design: [gateway.md](gateway.md).
Private-payment design and threat model: [splitkey-spike.md](splitkey-spike.md).

**Only accounts with a verified phone number have any of this.** An account
is a wallet address (sign-in by signature, [gateway.md](gateway.md) "HTTPS
API"); a number is optional, added in Settings by an OTP, and held by one
account at a time. Without one the gateway sends the account no texts (no
`Received`, no OTP but the one that adds a number) and a text from a number
no account holds gets `ERR not-registered`; the app hides offline sending,
alerts, paying numbers and the number on Receive. The web app has none of it.

Examples below were printed by the real formatters (`formatCommand`,
`formatShieldedCommand`, `formatReply`, `formatOtp`, `withRetrieverHash`)
and counted with `septets`. Lengths are GSM-7 septets; "+hash" is the same
text with the Retriever hash line appended, as the gateway sends it.

## Conventions

### Channels and numbers

| | |
| --- | --- |
| India | `+917004543035`, a SIM in the Android relay phone. The phone holds a WebSocket to the gateway's `Relay` Durable Object (`GET /relay`) and forwards every text it receives; the gateway answers on the same socket. Configured in the app as `GATEWAY_SMS.india` (`EXPO_PUBLIC_GATEWAY_SMS_IN`, default `+917004543035`). |
| International | `+18106768046`, a Twilio number (US). Twilio posts each text to `POST /webhooks/twilio` (signed); the gateway answers by Twilio's REST API from the same number. Configured in the app as `GATEWAY_SMS.international` (`EXPO_PUBLIC_GATEWAY_SMS_INTL`, default `+18106768046`). Off on the gateway until its `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` secrets are set ([gateway.md](gateway.md) "Transports out"). |

The app picks the number in `gatewayNumber()`: India when the Settings
choice is `india`, or `auto` and the account's number starts with `+91`;
otherwise international. `textGateway` refuses (`NoSmsError`) for an account
without a number, and on the web.

Outbound texts the gateway starts itself (OTP, `Received`) go through
`sendSms`: `+91` numbers through the relay, every other number through Twilio
(with Twilio unset, `+91` only). If the relay phone is offline they wait in
the `Relay` DO for 10 minutes (`OUTBOX_TTL_MS`), then drop with a log line; a
failed Twilio send is logged and dropped. Replies to an inbound text go back
on the transport it came in on (the relay socket, or Twilio from the Twilio
number), to the sender; they are not filtered by `canText`. The texts are
the same on both, Retriever hash line included, and the app reads replies
from either number the same way (the Retriever and the clipboard don't look
at the sender).

### One GSM-7 segment

Every text must fit one GSM-7 segment: 160 septets. One character outside
the GSM-7 alphabet (`…`, `₹`, curly quotes) turns the whole text into UCS-2
and cuts the segment to 70 characters, so formatters only emit ASCII and
`septets()` returns `null` for anything else. The extension characters
`^ { } \ [ ~ ] | €` cost two septets each; the only ones Ender uses are `[ ]`
in `[Test] `. Each formatter goes through `oneSegment`, which throws if the
text does not fit: an overflow is a bug, not a user error (the gateway then
answers `ERR internal` for an inbound command, or logs and skips an alert).

### The Retriever hash line

Every text the gateway sends (OTP, every reply, `Received`) ends with
`\n` plus the app's SMS Retriever hash, `withRetrieverHash(text,
env.SMS_RETRIEVER_HASH)`. The value is `IaTP8lLJOvM` (`gateway/wrangler.jsonc`),
11 characters, so the line adds 12 septets. Android's SMS Retriever hands a
text to the app without any SMS permission only if it carries this hash, which
is derived from the app's package name and signing key. If the variable is
unset, nothing is appended.

`parseReply` reads only the first line, so the hash line is ignored.

### `[Test] ` and the network of a text

Every text about testnet starts with `[Test] `, in both directions. It costs
9 septets (7 characters, `[` and `]` two each); every worst case below
includes it.

- **Gateway → phone**: `OK`, both `Q`s, `Sent`, `Shielded`, `ERR` and
  both `Received`s. No prefix means mainnet. `formatReply` adds it for `test: true`;
  `parseReply` strips it and sets `test: true`.
- **Phone → gateway**: every command the app sends for testnet: `SYNC`,
  `SEND`, `PAY`, `SHIELD`, `MERGE` and both `SIG` shapes.
  `formatCommand(c, network)` / `formatShieldedCommand(c, network)` take the
  network; the app always passes the payment's own (Review fixes it when it
  opens), never just the mode on screen. Mainnet commands have no prefix.
  `parseCommand` / `parseShieldedCommand` strip it (any case, one optional
  space after `]`) and return `network: 'testnet'`.

How the gateway picks the network of a command (`gateway/src/sms.ts`):

| Command | `[Test] ` prefix | No prefix (mainnet, or an older app) |
| --- | --- | --- |
| `SYNC` | testnet | mainnet; the older `SYNC T` is still testnet |
| `SEND` | testnet | mainnet |
| public / deposit `SIG` | its session's or quote's network, which must be testnet, else `ERR <id> wrong-network` | its session's or quote's network |
| `PAY`, `SHIELD`, `MERGE` | testnet | testnet (`SHIELDED_NETWORK`, the only pool) |
| private `SIG` | its quote's network, which must be testnet, else `ERR <id> wrong-network` | its quote's network |

`SYNC` and `[Test] SEND` also make that network the number's current one
(`links.network`, as online calls do); a `SIG` and the private commands
don't change it. A refused `wrong-network` `SIG` leaves its quote open.
An unprefixed `SEND` is always mainnet, whatever the number used last.

Texts with no network: OTP, `ERR bad-command`, and an `ERR` for a number or
session that doesn't exist (`not-registered` after a plain `SEND`,
`unknown-session`).

**The app's mode is display only.** Every text is applied to the network it
names, whatever mode the app shows: `OK` sets that network's balance and
nonce, a public `Received` adds a row to that network's Activity and sets its
balance, `Sent` / `Shielded` / a private `Received` update that network's note
cache and waiting payments. Private texts follow the same rule (`[Test] ` is
the testnet note cache, untagged mainnet's), even while the app shows the other
network (`textNetwork` in `private.ts`). The
Review screen waiting for a reply compares its network with its payment's:
a `Q`, `ERR`, or its own `Sent` / `Shielded` for the other network fails the
payment ("That reply was for mainnet, not this payment. …"), code
`wrong-network`.

### Case and whitespace

Commands (phone → gateway), `parseCommand` / `parseShieldedCommand`:

- Leading and trailing whitespace is trimmed; runs of whitespace become one space.
- The `[Test] ` prefix, the command word, `T`, `AUSD` and `> CTK` are case-insensitive. So is the session id in `SIG` (upper-cased).
- After the recipient, a comma, then an optional single space: `SEND +919876543210,20 ausd` parses. A space before the comma does not.
- 0x addresses: lower-case, or mixed case with a valid EIP-55 checksum (viem `isAddress`); stored lower-case. `ender1…` addresses are case-insensitive and lower-cased.
- Base64 fields are case-sensitive.

Replies (gateway → phone), `parseReply`: an optional `[Test] ` prefix, then
case-sensitive keywords (`OK`, `Q`, `Sent`, `ERR`, …), fields split on
whitespace, first line only. The app's
`acceptReply` tries every line of what it is given and takes the first that
parses, so a copied thread or a line with the sender's name still works.

### Amounts

Decimal AUSD, `^\d+(\.\d{1,6})?$` and greater than zero: up to 6 decimals,
no sign, no thousands separator, no leading `.`. `1.1234567` and `0` are
refused. There is no upper bound in the grammar; the segment limit is the
bound. Amounts in replies come from `formatUnits`, so no trailing zeros
(`10.5`, not `10.50`). Worst cases below use `999999.999999` (13 characters).
`out=` in a CTK quote has up to 18 decimals (`CTK_DECIMALS`).

### Ids

4 characters from `SESSION_ID_ALPHABET` = `23456789ABCDEFGHJKMNPQRSTVWXYZ`
(30 symbols, no `0 1 I L O U`), random per quote (`byte % 30`). Public
sessions and private quotes share the namespace: a new private quote skips
any id a public session holds. The id is in `Q`, `SIG`, `ERR <id> …`,
`Sent` and `Shielded`; the app matches every reply to its payment by it.

### Encodings

| Encoding | Used for |
| --- | --- |
| Standard base64, padded (`signatureToBase64`) | The 65-byte secp256k1 signature in a public or deposit `SIG`: always 88 characters ending in `=` |
| Standard base64, unpadded (`b64` / `unb64`) | 64-byte EdDSA signature in a private `SIG` (86 chars); the 64-byte packed shielded address in `Q … to=` (86 chars); the 32-byte blinding in a private `Received … b=` (43 chars, big-endian) |
| Refs (`encodeRefs`) | 3 base64-alphabet characters per input note: tree position mod 2^18 (`REF_MOD`), 6 bits per character, most significant first. Position 2 is `AAC`; 262146 is also `AAC` |
| bech32m (`protocol/recipient.ts`) | Private address: HRP `ender`, the 64-byte packed address (`owner_key ‖ enc_pk`), 115 lower-case characters. Shortened in replies to `ender1abcd...wxyz` (`shortPrivateAddress`) |
| Short hex (`shortHex`) | `0x` + 4 hex + `...` + 2 hex: tx hashes (`tx=`) in `Sent`, `Shielded`, `Received`; addresses (`to=`) in `Sent` when the recipient has no Ender ID |

Base64url is not used anywhere in SMS.

### Phone numbers

E.164 (`isPhone`: `^\+[1-9]\d{7,14}$`). The gateway normalises the sender of
an inbound text with `normalizePhone(raw, '91')`: spaces, dashes and brackets
dropped; `+…` kept; `00…` becomes `+…`; `0` + 10 digits and bare 10 digits
get `+91`; `91` + 10 digits gets `+`. Anything else (alphanumeric senders like
`VM-AIRTEL`, short codes) is `null`, and the text is dropped without a reply.
Inside commands, numbers must already be E.164: `SEND 9876543210, 1 AUSD` does
not parse.

### Ender IDs

`<label>.ender.my` (`protocol/names.ts`): a label of 5-20 characters
(`MIN_LABEL`, `MAX_LABEL`), `a-z`, `0-9` and interior single hyphens, not
reserved. The longest ID is 29 characters; 20 is what lets a private
`Received` naming it fit one segment with `[Test] ` and the hash line (155
septets, below). Commands also take `@label`, any case.

### Who appears in texts

A text never tells one user another's number, except to the user who typed it.

| Text | Field | What it shows |
| --- | --- | --- |
| `Received`, public | `from=` | The sender's Ender ID if the sending address is linked to a named account; else its verified primary ENS name (reverse ENS on Ethereum, `reverseEns` in `gateway/src/names.ts`) if that is plain ASCII GSM-7 of at most 40 characters (`isTextName`); else the full EIP-55 address. Never a number |
| `Received`, private | `from=` | The sender's Ender ID; no `from=` when the sender has none. Never a number |
| `Sent` (public and private) | `to=` | The number, if the payment was asked for by number (`SEND +91…`, `PAY +91…`; a `MERGE` names the sender's own); else the recipient's Ender ID if they have one, also when paid by 0x or `ender1…` address; else the address, short (`0x9965...dc`, `ender1rreg...6dx9`) |
| `Q` | `to=` | Unchanged: the real address or packed key, which the phone checks before signing |

Reverse ENS: viem's `getEnsName` against the Universal Resolver on Ethereum
mainnet over `ETH_RPC_URL` (default `https://eth.drpc.org`); the resolver
only answers a name whose forward record points back at the address. Each
answer, a name or none, is cached per address in D1 `ens_names` and
rechecked after 7 days. A lookup gives up after 4 s; an RPC error or
timeout falls back to the cached name, else the address. It never fails or
holds back an alert.

### How the app sends and picks up texts

The app uses HTTPS first and texts the gateway only as a fallback: Review
texts when `online()` is false (NetInfo connected and internet not
known-unreachable) or a call throws `OfflineError` (5 s timeout); Settings
sends `SYNC` by text whenever the online refresh fails.

Sending: `textGateway(command, network)` opens the system SMS composer to the
gateway number with the command filled in (with `[Test] ` for testnet); the
user taps send. It also opens a
10-minute window in which the clipboard is read (`REPLY_WINDOW_MS`).

Receiving, every path ends in `acceptReply(raw)`, whose listeners are the root
layout (`OK` → `applyOkReply`, a public `Received` → `applyReceived`, everything
else, a private `Received` too, → `applyShieldedReply`, each on the network the text names) and the Review
screen while it waits (`Q`, `ERR`, `Sent`, `Shielded`, matched by id):

1. **SMS Retriever** (Android, no permission). Play services hands over the
   next text that ends with the app's hash, one per `start()`, within five
   minutes. `pump` re-arms it on start, on every foreground, after each text
   and every 4 minutes while the app is open. Texts that arrive while the app
   is closed are picked up by the next online sync, or by pasting. (A
   `RECEIVE_SMS` receiver was tried and dropped: Play Protect blocks
   sideloaded apps that ask for SMS permissions.)
2. **Clipboard** (any platform). On foreground, within 10 minutes of texting
   the gateway, a new clipboard string is passed to `acceptReply`.
3. **Paste reply** button on the Review screen while it waits.

The OTP is not a reply: `listenForCode` matches `Ender code: (\d{6})` on the
same `onSms` stream.

## Adding a number

### OTP (gateway → phone)

Sent when the app calls `POST /account/phone/start {phone}` (`startPhone`)
from Settings, signed in. Sign-in itself is by passkey signature, never by
text, and there is no SMS command for either; both need the app online.

```
Ender code: <6 digits>. Don't share it.
```

| Field | Format |
| --- | --- |
| code | 6 decimal digits, uniform from `crypto.getRandomValues`, zero-padded |

Example (`formatOtp('481926')`), 35 septets, 47 +hash (fixed length):

```
Ender code: 481926. Don't share it.
IaTP8lLJOvM
```

Gateway rules: `bad-phone` unless E.164; `sms-unavailable` (503) unless `+91` or Twilio is set up;
`rate-limited` (429) after 3 sends per number per hour. The code lives 10
minutes, 5 tries (`OTP_MAX_ATTEMPTS`), stored as SHA-256 of
`phone:code:JWT_SECRET`. `startPhone` returns `queued: true` if the relay was
offline (the text waits up to 10 minutes).

App: the code screen fills and verifies the code by itself when it arrives
through RECEIVE_SMS or the Retriever; otherwise the user types it.
`POST /account/phone/verify` answers `bad-code` or `code-expired` (401), else
the number is the account's from then on (moved from another account if it
had it).

## Account

### `SYNC` (phone → gateway)

Sent from Settings ("Sync now", or switching Test mode) when the online
refresh fails (`syncByText`), for the network the app shows.

```
SYNC
[Test] SYNC
```

`SYNC` is mainnet, `[Test] SYNC` testnet; an older app's `SYNC T` is still
testnet. Each also sets the number's current network (`links.network`).
4 and 13 septets (`SYNC T`: 6).

Gateway: `account(env, from, network)`. Errors: `ERR not-registered` (number
not linked), `ERR rpc-unavailable`, `ERR internal`.

### `OK` (gateway → phone)

```
[Test] OK n=<nonce> dlg=<0|1> AUSD=<balance>[ inr=<rate>]
```

`[Test] ` for a testnet `SYNC` (and on every testnet text below; see Conventions).

| Field | Meaning |
| --- | --- |
| `n` | Calibur nonce, `getSeq(0)`, decimal |
| `dlg` | `1` if the wallet is delegated to Calibur on that network |
| `AUSD` | Balance, decimal AUSD |
| `inr` | INR per USD, 2 decimals (Frankfurter, cached an hour); left out if unavailable |

Examples:

```
OK n=3 dlg=1 AUSD=45.2 inr=88.72                 32 septets, 44 +hash
[Test] OK n=3 dlg=1 AUSD=45.2 inr=88.72          41, 53
[Test] OK n=18446744073709551615 dlg=1 AUSD=999999.999999 inr=88.72   69, 81 (worst)
```

Parse needs `n`, `dlg` and `AUSD`. App (`applyOkReply`): writes balance,
nonce and delegation for the network the text names (`[Test]` testnet, else
mainnet), whatever mode the app shows, and the INR rate if it is above zero.

## Public payments

### `SEND` (phone → gateway)

Sent from Review when the route is public and the app is offline at the quote
step (`start`). Also "Text again" while waiting for the quote.

```
[Test] SEND <to>, <amount> AUSD[ > CTK]
```

| Field | Format |
| --- | --- |
| `to` | 0x address (42 chars), E.164 number, or Ender ID `label.ender.my` (5-20 character label; any case; `@label` also parses; the app always sends the full lowercase form). Not an `ender1…` address (that is `PAY`) |
| `amount` | AUSD amount, as above |
| `> CTK` | Recipient gets CTK through Agora's testnet pair instead of AUSD |

Examples:

```
SEND +919876543210, 20 AUSD                                                 27 septets
SEND 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 10.5 AUSD                  58
[Test] SEND +919876543210, 20 AUSD                                          36
[Test] SEND 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 10.5 AUSD           67
[Test] SEND 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 999999.999999 AUSD > CTK   82 (worst with a 13-char amount; CTK is testnet only)
SEND harsh.ender.my, 20 AUSD                                                28
[Test] SEND xxxxxxxxxxxxxxxxxxxx.ender.my, 999999.999999 AUSD > CTK   69 (longest name: 20-char label)
```

To an Ender ID the gateway resolves the name to its public address
(`unknown-name` if nobody has it); the `Q` that follows carries that address in
`to=`, which the app pins under the name as it does for a number. The session
keeps what it was asked for (`sessions.recipient`: the number or the ID; null
for a 0x address), so its `Sent` can name it.

Gateway (`quote` in `core.ts`): testnet for `[Test] SEND`, mainnet without the
prefix; it also becomes the number's current network. In order:
`not-registered`, `unsupported` (CTK where the network has no pair, i.e.
mainnet), `bad-amount`, `not-on-ender` (a number with no wallet),
`unknown-name` (an Ender ID nobody has),
`self-transfer`, `not-delegated`, `low-balance` (balance < amount + fee),
`swap-unavailable` (CTK), `rpc-unavailable`, `busy` (no free id after 5
tries), `internal`. All as `ERR <code>` (no id). A repeated `SEND` (same
number, network, recipient, amount, delivery) while its quote is open
gets the same quote back (`request_hash`).

### `Q`, public (gateway → phone)

```
[Test] Q <id> n=<nonce> exp=<unix> fee=<fee> to=<0x address>[ out=<ctk>]
```

| Field | Meaning |
| --- | --- |
| `id` | Session id |
| `n` | Calibur nonce the phone signs with. Its presence is what makes this the public quote |
| `exp` | Signed deadline, unix seconds: now + 300 |
| `fee` | `FEE_AUSD` (`0.01`), paid to `FEE_RECIPIENT` |
| `to` | Recipient address, lower-case as stored (for a number, its linked wallet) |
| `out` | CTK delivery only: the minimum CTK the recipient gets, up to 18 decimals |

Examples:

```
Q 7F3K n=4 exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc          80, 92 +hash
[Test] Q 7F3K n=4 exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc   89, 101
[Test] Q 7F3K n=18446744073709551615 exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc out=999999.999999999999999999   138, 150 (worst; CTK is testnet only)
```

Parse needs `id`, `n`, `exp`, `fee` and a valid `to`. A `Q` for the other
network than the payment's fails it (`wrong-network`); with every `SEND`
naming its network this only happens if a reply is mixed up.
App (`checkQuote`), before any signing prompt:

- `recipient-mismatch` if the user gave a 0x address and `to` differs.
- `fee-too-high` if `fee` > `MAX_FEE` (0.01).
- `expired` if `exp` has passed.
- `no-out` for CTK without a positive `out`.
- For a number paid before (`pins`), a different `to` stops on a warning
  ("… now points to a different wallet …") with Send anyway / Cancel.

Then the app builds the Calibur batch itself from the fields on screen and
`n` / `exp`, and signs the EIP-712 `SignedBatch`.

### `SIG`, public (phone → gateway)

Sent when the app is offline at the submit step (`submit`), whether the quote
came by HTTPS or by text.

```
[Test] SIG <id> <signature>
```

| Field | Format |
| --- | --- |
| `id` | Session id from the `Q` |
| `signature` | 65-byte secp256k1 signature, padded base64, 88 characters |

Examples, 97 and 106 septets (fixed lengths):

```
SIG 7F3K JWFtkOhiqEI6qtMqeJDLLv097MZuT+ZlXGH38t36bw8hWtT7wsWOhGAh3UxLF0vMXp6CaAUrwor+/jbX8p82Qxs=
[Test] SIG 7F3K JWFtkOhiqEI6qtMqeJDLLv097MZuT+ZlXGH38t36bw8hWtT7wsWOhGAh3UxLF0vMXp6CaAUrwor+/jbX8p82Qxs=
```

Two fields after `SIG` is the public shape. If `id` is this number's
`SHIELD` quote, it is a deposit instead (below). A `[Test] SIG` for a mainnet
session answers `ERR <id> wrong-network` and leaves it open. Otherwise `sign` in
`core.ts`: claims the session, rebuilds the typed data from the stored
session, recovers the signer, re-reads the balance, queues the batch with the
network's `Sponsor`. Errors, as `ERR <id> <code>`: `wrong-network`, `unknown-session`,
`in-progress`, `expired`, `bad-sig`, `low-balance`, `rpc-unavailable`,
`reverted` (simulation dropped it), `failed` (landed without the transfer),
`send-failed`, `internal`. Every refusal after the claim reopens the session,
so a corrected `SIG` before `exp` still works. A repeated `SIG` of a sent
session answers the same `Sent`.

### `Sent`, public (gateway → phone)

```
[Test] Sent <id> <amount> AUSD to=<number | Ender ID | short address> tx=<short tx>
```

| Field | Meaning |
| --- | --- |
| `id` | The session id the `SIG` named |
| `amount` | The session's amount |
| `to` | The number, if the `SEND` (or `/tx/quote`) named one; else the recipient's Ender ID if they have one (asked for by ID, or the 0x address is linked to a named account); else `shortHex` of the address ("Who appears in texts") |
| `tx` | `shortHex` of the transaction hash |

Examples:

```
Sent 7F3K 10.5 AUSD to=+919876543210 tx=0xc6b9...fb                                51, 63 +hash
Sent 7F3K 10.5 AUSD to=harsh.ender.my tx=0xc6b9...fb                               52, 64
Sent 7F3K 10.5 AUSD to=0x9965...dc tx=0xc6b9...fb                                  49, 61
[Test] Sent 7F3K 10.5 AUSD to=0x9965...dc tx=0xc6b9...fb                           58, 70
[Test] Sent 7F3K 999999.999999 AUSD to=xxxxxxxxxxxxxxxxxxxx.ender.my tx=0xc6b9...fb   85, 97 (worst: longest ID)
```

An older gateway's `Sent 10.5 AUSD to 0x9965...dc. Tx 0xc6b9...fb` (no id)
still parses; the app then falls back to matching by amount.

Sent once the batch lands, or, if no receipt came within 30 s, with the
hash of the pending batch: the public path has no `ERR pending`. A repeated
`SIG` answers the same text, id included. App: the Activity row with that id
is marked sent (by the root listener, so also when Review is closed; the
waiting Review screen takes only a `Sent` with its own id); the next online
`/activity` pull matches it by recipient and amount and fills in the full
hash. The recipient gets a `Received` alert from the Alchemy webhook.

## Private payments

Both networks (mainnet in beta: 50 AUSD per deposit, amount + fee; over it,
`ERR CAP`). The prefix names the network like every other command: `[Test] `
is testnet, no prefix mainnet; an unprefixed private `SIG`, its quote's. Every
private reply about testnet starts with `[Test] `.
The sender must have registered proving keys online (`/shielded/register`),
else `NOUSER`.

### `PAY` (phone → gateway)

Sent from Review when the route is private and the app is offline at the
quote step (`startPrivate`).

```
[Test] PAY <to>, <amount> AUSD
```

| `to` | Kind | Meaning |
| --- | --- | --- |
| E.164 number | `pay` | Shielded transfer to that number's registered shielded address |
| `label.ender.my` | `pay` | Shielded transfer to the registered shielded address of that Ender ID's account; `Q` carries it in `to=` (as for a number), so the app can pin it under the name |
| `ender1…` | `pay` | Shielded transfer to that private address; its owner must be registered (matched by `owner_key` and `enc_pk`) |
| 0x address | `withdraw` | Withdrawal from the pool to any address |

Examples:

```
[Test] PAY +919876543210, 20 AUSD                                     35 septets
[Test] PAY 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 5 AUSD         63
[Test] PAY ender1rreg3epk4xpk3zmh7sujagu783a06av4andq2dq8x37ye6z6gfe7r3xyxafcr5ggzcaag53fumarcwpcvmy62nc4lc823ktn46kkq2g7q6dx9, 20 AUSD   137
[Test] PAY harsh.ender.my, 20 AUSD                                    36
[Test] PAY xxxxxxxxxxxxxxxxxxxx.ender.my, 999999.999999 AUSD   62 (longest name)
```

Worst case, and the longest phone text: `ender1…` with `999999.999999`, 148
(139 unprefixed, as an older app sends it). Phone texts carry no hash line.

When the app takes this route: `decideRoute` says private when the network has
a pool and the app is registered, delivery is AUSD, the recipient can take it
(a 0x address, an `ender1…` address, a number that is pinned or that
`GET /shielded/address` knows, or an Ender ID that is pinned or whose
`GET /names/:label` has a private address; offline and unpinned means public), and the
private notes alone cover amount + `MAX_FEE` under the selection rule. An
`ender1…` recipient is never paid publicly.

Gateway (`shielded.quote`), as `ERR <code>` without id: `NOUSER` (sender not
registered, or recipient not registered, or an Ender ID nobody has), `bad-amount`, `bad-recipient`,
`syncing` (pool index still catching up), `FUNDS` (eligible notes < amount +
fee), `MERGE` (more than 12 notes needed), `busy`, `internal`. `FUNDS` and
`MERGE` come from the same rule the phone runs (`planCircuit`). Every `PAY`
makes a new quote; there is no request dedupe. Sending a `Q` also warms the
prover for the circuit the payment will need.

App: on `NOUSER`, `FUNDS` or `MERGE` (not for `ender1…` or a shield) the
Review screen switches the route to public, so "Try again" pays publicly.

### `SHIELD` (phone → gateway)

Moves AUSD from the number's own wallet into its private balance ("Make
private"). Sent when offline at the quote step.

```
[Test] SHIELD <amount> AUSD
```

`[Test] SHIELD 50 AUSD` (23), worst `[Test] SHIELD 999999.999999 AUSD` (34);
unprefixed 14 and 25.

Gateway errors: `NOUSER`, `bad-amount`, `NOEOA` (no linked wallet on record),
`FUNDS` (wallet balance < amount + fee), `busy`, `internal` (for example an
RPC failure reading the balance).

### `MERGE` (phone → gateway)

```
[Test] MERGE
```

14 septets (`MERGE` alone: 5). Nothing after it. Folds notes into one: a
transfer of 0 to self, the change being everything else minus the fee.
Errors as `PAY`.

App: Home shows a **Merge** pill next to Make private on a network with a
pool when more than 12 private notes are usable (`canMerge`: `eligible`, and
not held by a waiting payment; 12 is the largest circuit). It opens Review in
merge mode ("Merge", Private notes 12 into 1, Fee $0.01). Approving (passkey or
Quick send) asks for the quote online (`POST /shielded/quote {kind:'merge'}`,
no amount) or texts `[Test] MERGE`; the phone picks the 12 largest usable
notes, ties by lower tree position (`selectMerge` in `protocol/select.ts`;
fewer if it has fewer, in the smallest circuit that holds them), and builds 0
to itself plus the change, one note back at `p+1` (`signPrivate`, kind
`merge`), then submits online or by the private `SIG`. The `Sent` with its id
settles it. The gateway doesn't check which notes a merge uses: any 1-12
distinct refs it can resolve, as for a payment.

**Auto-merge** (Settings → Private balance, shown on a network with a pool;
off by default, persisted as `autoMerge`): the app runs one merge by itself,
online only (`/shielded/quote` + `/shielded/submit`, never by text), when all
of these hold (`shouldAutoMerge` in `private.ts`, run by `autoMerge` in
`wallet.ts`): the toggle is on, the app is online, the shielded spending key
is in memory (an open Quick send session, which a passkey approval opens;
nothing is stored for this, so a locked app waits for the next unlock), the
network's private balance is registered, nothing is waiting to settle (no
merge, nor a payment whose notes it could collide with), and more than 12
notes are usable. Triggers: after a resync (`pullNotes`), after a private
payment settles (online, or a `Sent` / `Shielded` text), when the app comes
to the foreground, and when the toggle is turned on. It shows in Activity as
"Merged private notes", like a manual merge. A merge that settles re-checks
(more than 12 may still be left); one still pending waits for a resync. A
failure only logs (`auto-merge: <code>`) and frees the notes; it is retried
at the next trigger, not before.

### `Q`, private (gateway → phone)

```
[Test] Q <id> exp=<unix> fee=<fee>[ to=<to>]
```

No `n=`: that is how the parser tells it from the public quote.

| Field | Meaning |
| --- | --- |
| `id` | Quote id |
| `exp` | now + 600, 1-12 digits. Also the on-chain deadline signed into the transaction (and `validBefore` of a deposit) |
| `fee` | `FEE_AUSD` (`0.01`) |
| `to` | `PAY` to a number: the recipient's 64-byte packed shielded address, unpadded base64, 86 chars. `PAY` to a 0x address: that address, lower-case. Absent for `SHIELD`, `MERGE` and `PAY` to an `ender1…` address (the phone already has that key) |

Examples:

```
[Test] Q 7F3K exp=1791200000 fee=0.01 to=GPKI5Dapg2iLd/Q5LqOePHr9dZXs2gU0BzR8TOhaQnPhxMQ3U4HRCBY71FIp5vo8ODhmyaVPFf4OqNlzrq1gKQ   129, 141 +hash
[Test] Q 7F3K exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc   85, 97
[Test] Q 7F3K exp=1791200000 fee=0.01                                                 39, 51
[Test] Q 7F3K exp=999999999999 fee=0.01 to=<86>                                        131, 143 (worst)
```

Parse: `id` must be a valid id, `exp` 1-12 digits, `fee` an amount, `to`
either 0x + 40 hex or exactly 86 base64 characters decoding to 64 bytes.

App (`checkShieldedQuote`), before signing. For a `PAY` to `ender1…` that
came by text without `to=`, the typed address is used as `to`.

| Refusal | When |
| --- | --- |
| `expired` | `exp` has passed |
| `bad-quote` | `exp` more than an hour ahead |
| `fee-too-high` | `fee` > `MAX_FEE` |
| `recipient-mismatch` | Shield or merge with a `to`; withdrawal whose `to` isn't the requested 0x address; payment whose `to` isn't 64 bytes, or isn't the `ender1…` key the user gave |
| `KEY CHANGED` | The number's pinned shielded address (`shieldedPins`) differs from `to`. Shown as "This contact's private address changed since you last paid them. Nothing was sent." App-only; never on the wire |

Then the app picks the notes (`selectNotes`, or `selectMerge` for a merge; it
can still answer `FUNDS` / `MERGE` itself), builds the transaction the gateway will rebuild, signs it
with the authority key, and holds the input notes (`holdNotes`). A shield
instead builds the deposit (`buildDeposit`, seed `quoteSeed(id, exp)`) and
signs AUSD's `ReceiveWithAuthorization` with the wallet key.

### `SIG`, private (phone → gateway)

For `PAY` and `MERGE` quotes. Sent when offline at the submit step.

```
[Test] SIG <id> <refs> <signature>
```

| Field | Format |
| --- | --- |
| `id` | Quote id |
| `refs` | 1-12 refs, 3 characters each, one per real input note, in tree-position order |
| `signature` | 64-byte EdDSA (BabyJubJub, Poseidon) over the transaction message, unpadded base64, exactly 86 characters |

Three fields after `SIG` is the private shape.

```
[Test] SIG 7F3K AAC D76n2YDRR+PysiacoSqPvXl93ED9Amd3Rx8L0/11GyLXAFqDntlxNWMMjLUU05PAXzMMFTyUgU+kATrW+ZvwAg      108 septets
[Test] SIG 7F3K AACAAD D76n2YDRR+PysiacoSqPvXl93ED9Amd3Rx8L0/11GyLXAFqDntlxNWMMjLUU05PAXzMMFTyUgU+kATrW+ZvwAg   111 (2 refs)
[Test] SIG 7F3K AAAAABAACAADAAEAAFAAGAAHAAIAAJAAK8// D76n2YDRR+PysiacoSqPvXl93ED9Amd3Rx8L0/11GyLXAFqDntlxNWMMjLUU05PAXzMMFTyUgU+kATrW+ZvwAg   141 (12 refs, worst)
```

Unprefixed (an older app): 99, 102 and 132.

Gateway (`shielded.submit`), as `ERR <id> <code>`:

| Code | When |
| --- | --- |
| `wrong-network` | `[Test] SIG` for a quote on another network (the quote stays open) |
| `UNKNOWN` | No such quote for this number |
| `EXPIRED` | Past `exp`, never sent |
| `in-progress` | Another submit of the same quote is still running after a 60 s wait |
| `bad-request` | Malformed refs or signature (for example a three-field `SIG` for a `SHIELD` quote) |
| `NOUSER` | Sender's or recipient's keys are gone |
| `syncing` | Pool index still catching up |
| `REF` | A duplicate ref, a ref matching no eligible note, or more than 64 combinations |
| `BADSIG` | No combination of matching notes gives a transaction the signature verifies |
| `POLICY` | An output belongs to no registered user |
| `reverted`, `send-failed`, `failed` | From the `Sponsor`: would revert, couldn't send, reverted on-chain |
| `pending` | Sent, no receipt within 30 s. Repeat the same `SIG` to get the `Sent` |
| `internal` | Anything else, including prover errors |

Any refusal reopens the quote, so a corrected `SIG` before `exp` works. A
repeat after success answers the same `Sent`. Colliding refs (positions 2^18
apart) are tried exhaustively.

### `SIG`, deposit (phone → gateway)

For a `SHIELD` quote. Same shape as the public `SIG`: `[Test] SIG <id>
<88-char padded base64>`, 106 septets (97 unprefixed). The gateway routes it
by the id (`shielded.quoteOf(...)?.kind === 'shield'`); a prefix naming
another network than the quote's is `ERR <id> wrong-network`.

Gateway: rebuilds the deposit from its own record, recovers the EIP-3009
signer, which must be the number's wallet (`BADSIG`), checks policy (`POLICY`),
proves with the gateway's own dummy inputs and sends
`depositWithAuthorization`. Errors as the private `SIG`, plus `NOEOA`; answered
`ERR <id> pending` if there is no receipt yet or no position.

### `Sent`, private (gateway → phone)

```
[Test] Sent <id> <amount> AUSD to=<to> tx=<short tx>[ p=<pos>]
```

| Field | Meaning |
| --- | --- |
| `id` | The quote id the `SIG` named |
| `amount` | The quote's amount (`0` for `MERGE`) |
| `to` | `PAY` to a number: that number. `PAY` to an Ender ID: the ID (`harsh.ender.my`). `PAY` to `ender1…`: its owner's Ender ID, else `ender1abcd...wxyz`. Withdrawal: the Ender ID of the account the 0x address is linked to, else `shortHex` of the address. `MERGE`: the sender's own number. Never the recipient's number unless the payer typed it |
| `tx` | `shortHex` of the transaction |
| `p` | Tree position of output 0; our change, if any, is at `p+1`. Up to 8 digits. Absent for a withdrawal with no change (two null outputs, no leaves) |

Examples:

```
[Test] Sent 7F3K 20 AUSD to=+919876543210 tx=0xc6b9...fb p=2          62, 74 +hash
[Test] Sent 7F3K 20 AUSD to=harsh.ender.my tx=0xc6b9...fb p=2         63, 75 (an ID, or an ender1 / 0x address whose owner has one)
[Test] Sent 7F3K 20 AUSD to=ender1rreg...6dx9 tx=0xc6b9...fb p=2      66, 78 (an ender1 address whose owner has no ID)
[Test] Sent 7F3K 5 AUSD to=0x9965...dc tx=0xc6b9...fb                 55, 67 (withdrawal without change)
[Test] Sent 7F3K 0 AUSD to=+919876543210 tx=0xc6b9...fb p=40          62, 74 (MERGE)
[Test] Sent 7F3K 999999.999999 AUSD to=+123456789012345 tx=0xc6b9...fb p=99999999   83, 95
[Test] Sent 7F3K 999999.999999 AUSD to=xxxxxxxxxxxxxxxxxxxx.ender.my tx=0xc6b9...fb p=99999999   96, 108 (worst: longest ID)
```

Only sent once the receipt is in (else `ERR <id> pending`); a repeated `SIG`
answers the same text, id included. App (`applyShieldedReply` → `fileReply` →
`applyReply`), on the testnet note cache whatever mode the app shows: the
waiting payment with that id settles: its inputs are marked spent, our
outputs are added at `p + i`, and a number's shielded address is pinned. The
Review screen waiting for that id shows done. A `Sent` without an id (older
gateway, `Sent 20 AUSD to +91…. Tx … p=2`) still parses and settles the
oldest waiting payment of that kind and amount.

### `Shielded` (gateway → phone)

```
[Test] Shielded <id> <amount> AUSD tx=<short tx> p=<pos>
```

`id` is the deposit's quote id, `p` the position of the new note (output 0).
`[Test] Shielded 7F3K 50 AUSD tx=0xc6b9...fb p=0` (49, 61 +hash); worst
`[Test] Shielded 7F3K 999999.999999 AUSD tx=0xc6b9...fb p=99999999` (67, 79).

App: the waiting shield with that id settles and its note is added at `p`.
The older `Shielded 50 AUSD. Tx 0xc6b9...fb p=0` still parses (matched by
amount).

The recipient of a private payment gets a private `Received` (Alerts, below).
`Got` is its older name, still parsed.

## Alerts

### `Received` (gateway → recipient)

One keyword for both kinds of incoming payment. `p=` and `b=` make it
private; a private one never carries `balance=` (a carrier reads every text).

```
[Test] Received <amount> AUSD from=<who> balance=<balance> tx=<short tx>            public
[Test] Received <amount> AUSD[ from=<Ender ID>] tx=<short tx> p=<pos> b=<blinding>  private
```

| Field | Meaning |
| --- | --- |
| `[Test] ` | Testnet only |
| `amount` | Transfer value; for a private one, the payment's amount |
| `from` | "Who appears in texts". Public: the sender's Ender ID, else verified reverse-ENS name, else EIP-55 address. Private: the sender's Ender ID, else no `from=`. Never a number |
| `balance` | Public only: the recipient's AUSD balance read when the alert is built |
| `tx` | `shortHex` of the hash (public: the transfer; private: the pool transaction). How the app matches a public alert with `/activity` |
| `p` | Private only: tree position of the recipient's note, up to 8 digits |
| `b` | Private only: the note's blinding, 32 bytes big-endian, unpadded base64, 43 chars |

**Public**: texted when an AUSD transfer to a linked address arrives (Alchemy
Address Activity webhook → `record` → `alertAll`), on either network, if the
recipient has alerts on and a `+91` number. Not for transfers more than 10
minutes old by the delivery's `createdAt` (`ALERT_MAX_AGE`), and once per
transaction per number (`alerts_sent`). Any AUSD sender counts, including a
private withdrawal from the pool to an Ender wallet (then `from` is the pool's
address, or its ENS name if it had one). The balance read and the sender's
name (`senderName`) run together.

**Private**: texted to the recipient of a private payment the gateway relayed
(`receivedAlert` in `shielded.ts`), after the transaction lands, when the
recipient is a different number, has alerts on (`links.alerts`), and is a
`+91` number. Once per transaction per number (`alerts_sent`, shared with the
public one).

```
[Test] Received 10 AUSD from=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc balance=25.5 tx=0xc6b9...fb   101, 113 +hash
Received 10 AUSD from=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc balance=25.5 tx=0xc6b9...fb          92, 104
[Test] Received 10 AUSD from=harsh.ender.my balance=25.5 tx=0xc6b9...fb                               73, 85
[Test] Received 10 AUSD from=vitalik.eth balance=25.5 tx=0xc6b9...fb                                  70, 82
[Test] Received 999999.999999 AUSD from=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc balance=999999.999999 tx=0xc6b9...fb   121, 133 (worst public)
[Test] Received 999999.999999 AUSD from=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.eth balance=999999.999999 tx=0xc6b9...fb   119, 131 (40-char ENS name)
[Test] Received 20 AUSD from=ravi1.ender.my tx=0xc6b9...fb p=2 b=JChSinJMDXfb6EPnc6mmjkvKxsypLXMVyyyZT3Z0fk0      110, 122 (private)
[Test] Received 20 AUSD tx=0xc6b9...fb p=2 b=JChSinJMDXfb6EPnc6mmjkvKxsypLXMVyyyZT3Z0fk0                         90, 102 (private, sender without an ID)
[Test] Received 999999.999999 AUSD from=xxxxxxxxxxxxxxxxxxxx.ender.my tx=0xc6b9...fb p=99999999 b=JChSinJMDXfb6EPnc6mmjkvKxsypLXMVyyyZT3Z0fk0   143, 155 (worst private; the longest text the gateway sends)
```

Parsed by one strict regex: `from=` must be a 0x address (returned EIP-55) or
a name `isTextName` accepts; a public one needs `from=`, `balance=` and `tx=`;
a private one needs `p=` and `b=` and refuses `balance=`. Older forms still
parse: the public `… from 0x…. Balance 25.5 AUSD. Tx 0xc6b9...fb`, and `Got`
as a private `Received` without `from` or `tx`: `Got <amt> AUSD (private)
p=… b=…`, and the older still `Got <amt> AUSD from <who> p=… b=…` (the sender
dropped).

App, public (`applyReceived` → `fileReceived`): network from `[Test]`,
whatever mode the app shows; adds an incoming Activity row
`sms:<network>:<short tx>` unless that transfer is already there (same row
id, or an incoming row whose full hash shortens to it), and then sets that
network's balance to `balance`. A sender named by address is the row's
counterparty (shown by contact name if it has one); one named by Ender ID or
ENS name is the row's label. When `/activity` later returns the transfer, the
full row replaces the text's row.

App, private (`applyShieldedReply` → `fileReply`): adds the note
`{pos: p, amount, blinding}` to the cache of the network the text names
(untagged: the network with a pool; also while the app shows mainnet) and an
incoming private row `got:<network>:<p>` labelled with the sender's ID (else
"Private payment"), with the short hash and `p`. The next online
`/shielded/notes` replaces the cache anyway; its notes carry their full `tx`,
which fills in the row's hash (`txLinks`; also for private rows settled by a
`Sent` or `Shielded` text), so "View on explorer" opens the transaction
itself. Until then a private row has no explorer link: private transactions
don't show on the wallet's address page.

## Texts the app composes but the gateway never sees

The invite, sent from the user's own SMS app to a number that isn't on Ender
(Review, after `ERR not-on-ender`, "Invite them"), 96 characters:

```
I want to send you money on Ender. Get the app and sign up with this number: https://ender.money
```

## Flows

Online, the app uses HTTPS for every step marked (HTTP) and no SMS is sent;
the gateway's texts that it starts itself (OTP, `Received`) go out
either way. Steps can mix: a quote fetched online can be signed and sent by
text if the connection drops.

**Adding a number** (Settings; sign-in is by passkey, no texts)

1. App → `POST /account/phone/start {phone}` (HTTP only).
2. Gateway → phone: `Ender code: 481926. Don't share it.` + hash.
3. App reads it (RECEIVE_SMS or Retriever) or the user types it → `POST /account/phone/verify` (HTTP).

**Public send, online**: `POST /tx/quote` → `checkQuote` → sign →
`POST /tx/sign` (polls `GET /tx/:id` if `pending`). No texts, except the
recipient's `Received`.

**Public send, offline**

1. Phone → `SEND +919876543210, 20 AUSD` (`[Test] SEND …` on testnet)
2. Gateway → `Q 7F3K n=4 exp=… fee=0.01 to=0x…` (or `ERR <code>`; both with `[Test] ` on testnet)
3. App checks the quote, user approves (passkey or Quick send).
4. Phone → `SIG 7F3K <88>` (`[Test] SIG …` on testnet)
5. Gateway → `Sent 7F3K 20 AUSD to=+919876543210 tx=0xc6b9...fb` (or `ERR 7F3K <code>`)
6. Gateway → recipient: `Received …` (webhook, alerts on).

**Private `PAY` to a number** (offline; online: `/shielded/quote`, `/shielded/submit`)

1. Phone → `[Test] PAY +919876543210, 20 AUSD`
2. Gateway → `[Test] Q 7F3K exp=… fee=0.01 to=<86>`
3. App checks (incl. `KEY CHANGED`), picks notes, signs.
4. Phone → `[Test] SIG 7F3K <refs> <86>`
5. Gateway → `[Test] Sent 7F3K 20 AUSD to=+919876543210 tx=… p=2` (or `[Test] ERR 7F3K pending`, then repeat 4)
6. Gateway → recipient: `[Test] Received 20 AUSD from=<payer's ID> tx=… p=2 b=<43>` (alerts on).

**Private `PAY` to an `ender1…` address**: as above, but the `Q` has no
`to=` (the app uses the typed key), `Sent` names the owner's Ender ID (else
`to=ender1rreg...6dx9`), and the private `Received` goes to the address's
owner, whose number the payer never sees.

**Private withdrawal to 0x**: `[Test] PAY 0x…, 5 AUSD` → `[Test] Q … to=0x…` (must
equal the typed address) → `[Test] SIG <id> <refs> <86>` → `[Test] Sent <id> 5 AUSD
to=0x9965...dc tx=…[ p=…]`. If the 0x address is a linked Ender wallet, its owner gets a
`Received` from the pool address.

**`SHIELD`**: `[Test] SHIELD 50 AUSD` → `[Test] Q 7F3K exp=… fee=0.01` → app signs
the EIP-3009 authorization with the wallet key → `[Test] SIG 7F3K <88>` →
`[Test] Shielded 7F3K 50 AUSD tx=… p=0` (or `[Test] ERR 7F3K pending`).

**`MERGE`** (Home's Merge pill, more than 12 usable notes): `[Test] MERGE` →
`[Test] Q <id> exp=… fee=0.01` → `[Test] SIG <id> <refs> <86>` (the 12
largest notes) → `[Test] Sent <id> 0 AUSD to=<own number> tx=… p=<n>`, merged
note at `p+1`. Online: `/shielded/quote {kind:'merge'}`, `/shielded/submit`;
Auto-merge only ever takes this online path.

**Incoming public payment**: transfer lands → Alchemy webhook → `transfers`
row → `Received … balance=…` text (alerts on, ≤ 10 min old) → app adds the
row; online, `/activity` shows the same transfer without the text.

**Incoming private payment**: the payer's `SIG` (or `/shielded/submit`) lands
→ the gateway indexes the receipt (the recipient's note is found by trial
decryption and stored with its tx hash) → `Received … p=… b=…` to the
recipient (alerts on) → app adds the note; online, `/shielded/notes` has it
anyway, with the full hash.

## Error codes

`ERR <code>` answers a command that has no id (`SYNC`, `SEND`, `PAY`,
`SHIELD`, `MERGE`, an unparseable text); `ERR <id> <code>` answers a `SIG`.
Codes never contain spaces. An `ERR` carries `[Test] ` when the gateway knows
the command was about testnet. On HTTPS the same codes come as `{error}`. The app
text is `ERRORS` in `wallet.ts`; codes missing there show
`Gateway said: <code>`. While Review waits for a reply, any `ERR` (and, while
waiting for `Sent`, any `ERR` with that id or no id) fails the step.

| Code | Path | Meaning | App |
| --- | --- | --- | --- |
| `bad-command` | any | Unparseable text from a linked number (unlinked numbers get nothing) | Gateway said |
| `not-registered` | `SYNC`, `SEND` | Number has no wallet | "This wallet has no Ender account yet. Log in again." (the app; by text the number belongs to no account, or was removed from one) |
| `rpc-unavailable` | `SYNC`, `SEND`, `SIG` | Balance read failed | Gateway said |
| `unsupported` | `SEND … > CTK` | No CTK pair on this network | "Not supported yet." |
| `bad-amount` | `SEND`, `PAY`, `SHIELD` | Amount invalid (the parser catches it first) | "Check the amount." |
| `bad-recipient` | `PAY` | Not a number, Ender ID, 0x or `ender1…` (the parser catches it first) | "That isn't a phone number, Ender ID, wallet address or private address." |
| `not-on-ender` | `SEND` | Number not on Ender | Explains, offers "Invite them" |
| `unknown-name` | `SEND` | Nobody has that Ender ID (`PAY` answers `NOUSER`) | "No one has that Ender ID." |
| `self-transfer` | `SEND` | Recipient is the sender's wallet | "That's your own wallet." |
| `not-delegated` | `SEND` | Wallet not delegated yet | "…still being set up…" |
| `low-balance` | `SEND`, `SIG` | Balance < amount + fee | "Not enough balance…" |
| `swap-unavailable` | `SEND … > CTK` | Couldn't whitelist or price the swap | "Local-currency delivery is unavailable…" |
| `busy` | `SEND`, `PAY`, `SHIELD`, `MERGE` | No free id after 5 tries | Gateway said |
| `wrong-network` | `[Test] SIG` (any shape) | The session or quote is on another network; it stays open | "That approval was for the other network. Nothing was sent." |
| `unknown-session` | `SIG` (public) | No such session for this number (also any `SIG` from an unlinked number) | Gateway said |
| `in-progress` | `SIG` | Another submit is sending it | "Already sending." |
| `expired` | `SIG` (public) | Session past its deadline | "That quote has expired. Try again." |
| `bad-sig` | `SIG` (public) | Signer isn't the number's wallet | "The signature didn't match…" |
| `reverted` | `SIG` | Simulation says it would fail | "…would fail on-chain. Nothing was sent." |
| `failed` | `SIG` | Landed without moving the money | "…failed on-chain. Your money did not move." |
| `send-failed` | `SIG` | The gateway couldn't send it | "The gateway couldn't send it. Try again." |
| `NOUSER` | private | Sender or recipient has no shielded keys | "This number can't take private payments yet." (for `ender1…`: "That private address isn't on Ender…"); switches to public for a number |
| `FUNDS` | private | Private notes (or, for `SHIELD`, the wallet) can't cover amount + fee | "Not enough private balance…"; switches to public |
| `MERGE` | private | Would need more than 12 notes | "…too many small pieces…"; switches to public |
| `NOEOA` | `SHIELD`, deposit `SIG` | No linked wallet for deposits | "Your wallet can't fund the private balance yet…" |
| `UNKNOWN` | private `SIG` | No such quote | "That quote is no longer open. Try again." |
| `EXPIRED` | private `SIG` | Quote past `exp` | "That quote has expired. Try again." |
| `REF` | private `SIG` | Refs don't match eligible notes | "…didn't recognise your private notes. Pull to refresh…" |
| `BADSIG` | private `SIG`, deposit `SIG` | Signature doesn't verify | "The signature didn't match…" |
| `POLICY` | private `SIG`, deposit `SIG` | Output or deposit outside registered users | "The gateway refused this private payment." |
| `syncing` | private | Pool index still catching up | "…still catching up with the private pool…" |
| `bad-request` | private `SIG` | Malformed refs / signature for this quote kind | Gateway said |
| `pending` | private and deposit `SIG` | Sent, not confirmed yet | Not an error: Review shows done, notes stay held until a resync |
| `internal` | any | Unhandled error (prover, RPC, formatter) | Gateway said |

HTTPS-only codes (never in a text): `rate-limited`, `sms-unavailable`,
`bad-code`, `code-expired`, `bad-phone`, `number-linked`, `address-linked`,
`unauthorized`, `bad-network`, `key-changed`, `key-in-use`, `delegation-*`,
`paused`.

App-only refusals (never on the wire): `expired`, `bad-quote`,
`fee-too-high`, `recipient-mismatch`, `no-out`, `KEY CHANGED`,
`wrong-passkey`, and the public pin-change warning. `wrong-network` is both:
the gateway's answer to a mismatched `[Test] SIG`, and the app's own refusal
of a reply for the other network than the payment's.

## Open questions

- **A private `Received` needs alerts on.** `receivedAlert` skips numbers with
  `links.alerts` off, so they learn of a private payment only online.
- **Public `SIG` while pending.** `sign` returns `pending` when no receipt came
  in 30 s, but `gateway/src/sms.ts` answers `Sent` anyway, so the text can
  report a transfer that later fails (`GET /tx/:id` and `reconcile` know).
- **Id namespace.** A private quote skips ids held by public sessions, but a
  public quote doesn't check `shielded_quotes`. If one number had both under
  the same id, its public-shaped `SIG` would go to the deposit.
- **Rate limits.** [gateway.md](gateway.md) says inbound SMS has a per-number
  limit; `handleInbound` has none, and `ERR rate-limited` is never sent by text.
- **Retriever timing.** `listenForCode` starts on the code screen, after
  `/account/phone/start`; a code that arrived first would be missed by the Retriever
  (RECEIVE_SMS still queues it).

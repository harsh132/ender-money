# SMS reference

Every text Ender sends or receives, as the code does it at `2599c83`. The
grammar lives in `protocol/sms.ts` (with `protocol/recipient.ts` for
recipients and `protocol/shielded.ts` for private payments); the gateway side
is `gateway/src/sms.ts`, `auth.ts`, `activity.ts` and `shielded.ts`; the app
side is `app/src/lib/transport.ts`, `wallet.ts`, `private.ts`, `inbox.ts` and
`app/modules/sms-retriever`. Gateway design: [gateway.md](gateway.md).
Private-payment design and threat model: [splitkey-spike.md](splitkey-spike.md).

Examples below were printed by the real formatters (`formatCommand`,
`formatShieldedCommand`, `formatReply`, `formatOtp`, `withRetrieverHash`)
and counted with `septets`. Lengths are GSM-7 septets; "+hash" is the same
text with the Retriever hash line appended, as the gateway sends it.

## Conventions

### Channels and numbers

| | |
| --- | --- |
| India | `+917004543035`, a SIM in the Android relay phone. The phone holds a WebSocket to the gateway's `Relay` Durable Object (`GET /relay`) and forwards every text it receives; the gateway answers on the same socket. Configured in the app as `GATEWAY_SMS.india` (`EXPO_PUBLIC_GATEWAY_SMS_IN`, default `+917004543035`). |
| International | Not built. `GATEWAY_SMS.international` comes from `EXPO_PUBLIC_GATEWAY_SMS_INTL` and is unset, so `textGateway` throws `NoSmsError` ("No gateway number for texts is set up in this build."). The gateway's `canText` is `to.startsWith('+91')`; `sendSms` to any other number throws `sms-unavailable` (503). |

The app picks the number in `gatewayNumber()`: India when the Settings
choice is `india`, or `auto` and the wallet's number starts with `+91` (or
there is no wallet yet); otherwise international.

Outbound texts the gateway starts itself (OTP, `Received`, `Got`) go through
`sendSms`, which only texts `+91` numbers. If the relay phone is offline they
wait in the `Relay` DO for 10 minutes (`OUTBOX_TTL_MS`), then drop with a log
line. Replies to an inbound text go straight back on the relay socket to the
sender; they are not filtered by `canText`.

### One GSM-7 segment

Every text must fit one GSM-7 segment: 160 septets. One character outside
the GSM-7 alphabet (`…`, `₹`, curly quotes) turns the whole text into UCS-2
and cuts the segment to 70 characters, so formatters only emit ASCII and
`septets()` returns `null` for anything else. The extension characters
`^ { } \ [ ~ ] | €` cost two septets each; the only one Ender uses is `[ ]`
in `[Test] `. Each formatter goes through `oneSegment`, which throws if the
text does not fit: an overflow is a bug, not a user error (the gateway then
answers `ERR internal` for an inbound command, or logs and skips an alert).

### The Retriever hash line

Every text the gateway sends (OTP, every reply, `Received`, `Got`) ends with
`\n` plus the app's SMS Retriever hash, `withRetrieverHash(text,
env.SMS_RETRIEVER_HASH)`. The value is `IaTP8lLJOvM` (`gateway/wrangler.jsonc`),
11 characters, so the line adds 12 septets. Android's SMS Retriever hands a
text to the app without any SMS permission only if it carries this hash, which
is derived from the app's package name and signing key. If the variable is
unset, nothing is appended.

`parseReply` reads only the first line, so the hash line is ignored.

### `[Test] `

Only on `Received` alerts for testnet transfers (`test: network ===
'testnet'`). It costs 9 septets (7 characters, two of them double). No other
text says which network it is about.

### Case and whitespace

Commands (phone → gateway), `parseCommand` / `parseShieldedCommand`:

- Leading and trailing whitespace is trimmed; runs of whitespace become one space.
- The command word, `T`, `AUSD` and `> CTK` are case-insensitive. So is the session id in `SIG` (upper-cased).
- After the recipient, a comma, then an optional single space: `SEND +919876543210,20 ausd` parses. A space before the comma does not.
- 0x addresses: lower-case, or mixed case with a valid EIP-55 checksum (viem `isAddress`); stored lower-case. `ender1…` addresses are case-insensitive and lower-cased.
- Base64 fields are case-sensitive.

Replies (gateway → phone), `parseReply`: case-sensitive keywords (`OK`, `Q`,
`Sent`, `ERR`, …), fields split on whitespace, first line only. The app's
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
any id a public session holds.

### Encodings

| Encoding | Used for |
| --- | --- |
| Standard base64, padded (`signatureToBase64`) | The 65-byte secp256k1 signature in a public or deposit `SIG`: always 88 characters ending in `=` |
| Standard base64, unpadded (`b64` / `unb64`) | 64-byte EdDSA signature in a private `SIG` (86 chars); the 64-byte packed shielded address in `Q … to=` (86 chars); the 32-byte blinding in `Got … b=` (43 chars, big-endian) |
| Refs (`encodeRefs`) | 3 base64-alphabet characters per input note: tree position mod 2^18 (`REF_MOD`), 6 bits per character, most significant first. Position 2 is `AAC`; 262146 is also `AAC` |
| bech32m (`protocol/recipient.ts`) | Private address: HRP `ender`, the 64-byte packed address (`owner_key ‖ enc_pk`), 115 lower-case characters. Shortened in replies to `ender1abcd...wxyz` (`shortPrivateAddress`) |
| Short hex (`shortHex`) | `0x` + 4 hex + `...` + 2 hex: tx hashes and addresses in `Sent`, `Shielded`, `Received` |

Base64url is not used anywhere in SMS.

### Phone numbers

E.164 (`isPhone`: `^\+[1-9]\d{7,14}$`). The gateway normalises the sender of
an inbound text with `normalizePhone(raw, '91')`: spaces, dashes and brackets
dropped; `+…` kept; `00…` becomes `+…`; `0` + 10 digits and bare 10 digits
get `+91`; `91` + 10 digits gets `+`. Anything else (alphanumeric senders like
`VM-AIRTEL`, short codes) is `null`, and the text is dropped without a reply.
Inside commands, numbers must already be E.164: `SEND 9876543210, 1 AUSD` does
not parse.

### How the app sends and picks up texts

The app uses HTTPS first and texts the gateway only as a fallback: Review
texts when `online()` is false (NetInfo connected and internet not
known-unreachable) or a call throws `OfflineError` (5 s timeout); Settings
sends `SYNC` by text whenever the online refresh fails.

Sending: `textGateway(command)` opens the system SMS composer to the gateway
number with the command filled in; the user taps send. It also opens a
10-minute window in which the clipboard is read (`REPLY_WINDOW_MS`).

Receiving, every path ends in `acceptReply(raw)`, whose listeners are the root
layout (`OK` → `applyOkReply`, `Received` → `applyReceived`, everything else →
`applyShieldedReply`) and the Review screen while it waits (`Q`, `ERR`,
`Sent`, `Shielded`):

1. **RECEIVE_SMS** (Android, if granted; the Activity tab asks once). A
   manifest receiver (`SmsReceiver`) keeps only texts whose sender's last ten
   digits match a gateway number (`setSenders`, stored natively, so it filters
   while the app is closed). Others are dropped before the body is read.
   Matching texts go into a queue in SharedPreferences (`ender.sms`, at most
   50, deduped by body and timestamp). JS drains it on start, on every
   foreground and whenever a text is added (`pump`).
2. **SMS Retriever** (Android, without the permission). Play services hands
   over the next text that ends with the app's hash, one per `start()`,
   within five minutes. `pump` re-arms it on start, on every foreground and
   after each text.
3. **Clipboard** (any platform). On foreground, within 10 minutes of texting
   the gateway, a new clipboard string is passed to `acceptReply`.
4. **Paste reply** button on the Review screen while it waits.

The OTP is not a reply: `listenForCode` matches `Ender code: (\d{6})` on the
same `onSms` stream.

## Onboarding

### OTP (gateway → phone)

Sent when the app calls `POST /auth/start {phone}` (`startAuth`). Sign-in has
no SMS command; it needs the app online.

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

Gateway rules: `bad-phone` unless E.164; `sms-unavailable` (503) unless `+91`;
`rate-limited` (429) after 3 sends per number per hour. The code lives 10
minutes, 5 tries (`OTP_MAX_ATTEMPTS`), stored as SHA-256 of
`phone:code:JWT_SECRET`. `startAuth` returns `queued: true` if the relay was
offline (the text waits up to 10 minutes).

App: the code screen fills and verifies the code by itself when it arrives
through RECEIVE_SMS or the Retriever; otherwise the user types it.
`POST /auth/verify` answers `bad-code` or `code-expired` (401).

## Account

### `SYNC` / `SYNC T` (phone → gateway)

Sent from Settings ("Sync now", or switching Test mode) when the online
refresh fails (`syncByText`).

```
SYNC
SYNC T
```

`SYNC` is mainnet, `SYNC T` testnet. Either one also sets the number's
current network (`links.network`), which every later `SEND` by text uses.
4 and 6 septets.

Gateway: `account(env, from, network)`. Errors: `ERR not-registered` (number
not linked), `ERR rpc-unavailable`, `ERR internal`.

### `OK` (gateway → phone)

```
OK n=<nonce> dlg=<0|1> AUSD=<balance>[ inr=<rate>]
```

| Field | Meaning |
| --- | --- |
| `n` | Calibur nonce, `getSeq(0)`, decimal |
| `dlg` | `1` if the wallet is delegated to Calibur on that network |
| `AUSD` | Balance, decimal AUSD |
| `inr` | INR per USD, 2 decimals (Frankfurter, cached an hour); left out if unavailable |

Examples:

```
OK n=3 dlg=1 AUSD=45.2 inr=88.72          32 septets, 44 +hash
OK n=0 dlg=0 AUSD=0                       19, 31
OK n=18446744073709551615 dlg=1 AUSD=999999.999999 inr=88.72   60, 72
```

Parse needs `n`, `dlg` and `AUSD`. App (`applyOkReply`): writes balance,
nonce and delegation for the app's current network (`OK` carries no network)
and the INR rate if it is above zero.

## Public payments

### `SEND` (phone → gateway)

Sent from Review when the route is public and the app is offline at the quote
step (`start`). Also "Text again" while waiting for the quote.

```
SEND <to>, <amount> AUSD[ > CTK]
```

| Field | Format |
| --- | --- |
| `to` | 0x address (42 chars) or E.164 number. Not an `ender1…` address (that is `PAY`) |
| `amount` | AUSD amount, as above |
| `> CTK` | Recipient gets CTK through Agora's testnet pair instead of AUSD |

Examples:

```
SEND +919876543210, 20 AUSD                                          27 septets
SEND 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 10.5 AUSD           58
SEND 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 999999.999999 AUSD > CTK   73 (worst with a 13-char amount)
```

Gateway (`quote` in `core.ts`) uses the number's current network. In order:
`not-registered`, `unsupported` (CTK where the network has no pair, i.e.
mainnet), `bad-amount`, `not-on-ender` (a number with no wallet),
`self-transfer`, `not-delegated`, `low-balance` (balance < amount + fee),
`swap-unavailable` (CTK), `rpc-unavailable`, `busy` (no free id after 5
tries), `internal`. All as `ERR <code>` (no id). A repeated `SEND` (same
number, network, recipient, amount, delivery) while its quote is open
gets the same quote back (`request_hash`).

### `Q`, public (gateway → phone)

```
Q <id> n=<nonce> exp=<unix> fee=<fee> to=<0x address>[ out=<ctk>]
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
Q 7F3K n=4 exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc            80, 92 +hash
Q 7F3K n=4 exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc out=1.5    88, 100
Q 7F3K n=18446744073709551615 exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc out=999999.999999999999999999   129, 141 (worst)
```

Parse needs `id`, `n`, `exp`, `fee` and a valid `to`. App (`checkQuote`),
before any signing prompt:

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
SIG <id> <signature>
```

| Field | Format |
| --- | --- |
| `id` | Session id from the `Q` |
| `signature` | 65-byte secp256k1 signature, padded base64, 88 characters |

Example, 97 septets (fixed length):

```
SIG 7F3K JWFtkOhiqEI6qtMqeJDLLv097MZuT+ZlXGH38t36bw8hWtT7wsWOhGAh3UxLF0vMXp6CaAUrwor+/jbX8p82Qxs=
```

Two fields after `SIG` is the public shape. If `id` is this number's
`SHIELD` quote, it is a deposit instead (below). Otherwise `sign` in
`core.ts`: claims the session, rebuilds the typed data from the stored
session, recovers the signer, re-reads the balance, queues the batch with the
network's `Sponsor`. Errors, as `ERR <id> <code>`: `unknown-session`,
`in-progress`, `expired`, `bad-sig`, `low-balance`, `rpc-unavailable`,
`reverted` (simulation dropped it), `failed` (landed without the transfer),
`send-failed`, `internal`. Every refusal after the claim reopens the session,
so a corrected `SIG` before `exp` still works. A repeated `SIG` of a sent
session answers the same `Sent`.

### `Sent`, public (gateway → phone)

```
Sent <amount> AUSD to <short to>. Tx <short tx>
```

| Field | Meaning |
| --- | --- |
| `amount` | The session's amount |
| `to` | `shortHex` of the recipient address (also when paid to a number) |
| `Tx` | `shortHex` of the transaction hash |

Examples: `Sent 10.5 AUSD to 0x9965...dc. Tx 0xc6b9...fb` (45, 57 +hash);
worst `Sent 999999.999999 AUSD to 0x9965...dc. Tx 0xc6b9...fb` (54, 66).

Sent once the batch lands, or, if no receipt came within 30 s, with the
hash of the pending batch: the public path has no `ERR pending`. App: the
waiting Review screen marks the transfer sent (no full hash yet); the next
online `/activity` pull matches it by recipient and amount and fills in the
hash. The recipient gets a `Received` alert from the Alchemy webhook.

## Private payments

Testnet only: private commands carry no network and the gateway always uses
`testnet` (`SHIELDED_NETWORK`). The sender must have registered proving keys
online (`/shielded/register`), else `NOUSER`.

### `PAY` (phone → gateway)

Sent from Review when the route is private and the app is offline at the
quote step (`startPrivate`).

```
PAY <to>, <amount> AUSD
```

| `to` | Kind | Meaning |
| --- | --- | --- |
| E.164 number | `pay` | Shielded transfer to that number's registered shielded address |
| `ender1…` | `pay` | Shielded transfer to that private address; its owner must be registered (matched by `owner_key` and `enc_pk`) |
| 0x address | `withdraw` | Withdrawal from the pool to any address |

Examples:

```
PAY +919876543210, 20 AUSD                                     26 septets
PAY 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc, 5 AUSD         54
PAY ender1rreg3epk4xpk3zmh7sujagu783a06av4andq2dq8x37ye6z6gfe7r3xyxafcr5ggzcaag53fumarcwpcvmy62nc4lc823ktn46kkq2g7q6dx9, 20 AUSD   128
```

Worst case: `ender1…` with `999999.999999`, 139.

When the app takes this route: `decideRoute` says private when the network has
a pool and the app is registered, delivery is AUSD, the recipient can take it
(a 0x address, an `ender1…` address, or a number that is pinned or that
`GET /shielded/address` knows; offline and unpinned means public), and the
private notes alone cover amount + `MAX_FEE` under the selection rule. An
`ender1…` recipient is never paid publicly.

Gateway (`shielded.quote`), as `ERR <code>` without id: `NOUSER` (sender not
registered, or recipient not registered), `bad-amount`, `bad-recipient`,
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
SHIELD <amount> AUSD
```

`SHIELD 50 AUSD` (14), worst `SHIELD 999999.999999 AUSD` (25).

Gateway errors: `NOUSER`, `bad-amount`, `NOEOA` (no linked wallet on record),
`FUNDS` (wallet balance < amount + fee), `busy`, `internal` (for example an
RPC failure reading the balance).

### `MERGE` (phone → gateway)

```
MERGE
```

5 septets. Nothing after it. Folds notes into one: a transfer of 0 to self,
the change being everything else minus the fee. Errors as `PAY`. The app
never sends it (see Open questions).

### `Q`, private (gateway → phone)

```
Q <id> exp=<unix> fee=<fee>[ to=<to>]
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
Q 7F3K exp=1791200000 fee=0.01 to=GPKI5Dapg2iLd/Q5LqOePHr9dZXs2gU0BzR8TOhaQnPhxMQ3U4HRCBY71FIp5vo8ODhmyaVPFf4OqNlzrq1gKQ   120, 132 +hash
Q 7F3K exp=1791200000 fee=0.01 to=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc   76, 88
Q 7F3K exp=1791200000 fee=0.01                                                 30, 42
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
| `recipient-mismatch` | Shield with a `to`; withdrawal whose `to` isn't the requested 0x address; payment whose `to` isn't 64 bytes, or isn't the `ender1…` key the user gave |
| `KEY CHANGED` | The number's pinned shielded address (`shieldedPins`) differs from `to`. Shown as "This contact's private address changed since you last paid them. Nothing was sent." App-only; never on the wire |

Then the app picks the notes (`selectNotes`; it can still answer `FUNDS` /
`MERGE` itself), builds the transaction the gateway will rebuild, signs it
with the authority key, and holds the input notes (`holdNotes`). A shield
instead builds the deposit (`buildDeposit`, seed `quoteSeed(id, exp)`) and
signs AUSD's `ReceiveWithAuthorization` with the wallet key.

### `SIG`, private (phone → gateway)

For `PAY` and `MERGE` quotes. Sent when offline at the submit step.

```
SIG <id> <refs> <signature>
```

| Field | Format |
| --- | --- |
| `id` | Quote id |
| `refs` | 1-12 refs, 3 characters each, one per real input note, in tree-position order |
| `signature` | 64-byte EdDSA (BabyJubJub, Poseidon) over the transaction message, unpadded base64, exactly 86 characters |

Three fields after `SIG` is the private shape.

```
SIG 7F3K AAC D76n2YDRR+PysiacoSqPvXl93ED9Amd3Rx8L0/11GyLXAFqDntlxNWMMjLUU05PAXzMMFTyUgU+kATrW+ZvwAg      99 septets
SIG 7F3K AACAAD D76n2YDRR+PysiacoSqPvXl93ED9Amd3Rx8L0/11GyLXAFqDntlxNWMMjLUU05PAXzMMFTyUgU+kATrW+ZvwAg   102 (2 refs)
SIG 7F3K AAAAABAACAADAAEAAFAAGAAHAAIAAJAAKJPg D76n2YDRR+PysiacoSqPvXl93ED9Amd3Rx8L0/11GyLXAFqDntlxNWMMjLUU05PAXzMMFTyUgU+kATrW+ZvwAg   132 (12 refs, worst)
```

Gateway (`shielded.submit`), as `ERR <id> <code>`:

| Code | When |
| --- | --- |
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

For a `SHIELD` quote. Same shape as the public `SIG`: `SIG <id> <88-char
padded base64>`, 97 septets. The gateway routes it by the id
(`shielded.quoteKind(...) === 'shield'`).

Gateway: rebuilds the deposit from its own record, recovers the EIP-3009
signer, which must be the number's wallet (`BADSIG`), checks policy (`POLICY`),
proves with the gateway's own dummy inputs and sends
`depositWithAuthorization`. Errors as the private `SIG`, plus `NOEOA`; answered
`ERR <id> pending` if there is no receipt yet or no position.

### `Sent`, private (gateway → phone)

```
Sent <amount> AUSD to <to>. Tx <short tx>[ p=<pos>]
```

| Field | Meaning |
| --- | --- |
| `amount` | The quote's amount (`0` for `MERGE`) |
| `to` | `PAY` to a number: that number. `PAY` to `ender1…`: `ender1abcd...wxyz`, never its owner's number. Withdrawal: `shortHex` of the 0x address. `MERGE`: the sender's own number |
| `Tx` | `shortHex` of the transaction |
| `p` | Tree position of output 0; our change, if any, is at `p+1`. Up to 8 digits. Absent for a withdrawal with no change (two null outputs, no leaves) |

Examples:

```
Sent 20 AUSD to +919876543210. Tx 0xc6b9...fb p=2           49, 61 +hash
Sent 20 AUSD to ender1rreg...6dx9. Tx 0xc6b9...fb p=2       53, 65
Sent 5 AUSD to 0x9965...dc. Tx 0xc6b9...fb p=14             47, 59
Sent 5 AUSD to 0x9965...dc. Tx 0xc6b9...fb                  42, 54
Sent 0 AUSD to +919876543210. Tx 0xc6b9...fb p=40           49, 61 (MERGE)
Sent 999999.999999 AUSD to +123456789012345. Tx 0xc6b9...fb p=99999999   70, 82 (worst)
```

Only sent once the receipt is in (else `ERR <id> pending`). App
(`applyShieldedReply` → `applyReply`): the oldest waiting private payment
(not a shield) with the same amount settles: its inputs are marked spent,
our outputs are added at `p + i`, and a number's shielded address is pinned.
The Review screen waiting for it shows done.

### `Shielded` (gateway → phone)

```
Shielded <amount> AUSD. Tx <short tx> p=<pos>
```

`p` is the position of the new note (output 0). `Shielded 50 AUSD. Tx
0xc6b9...fb p=0` (36, 48 +hash); worst 54, 66.

App: the oldest waiting shield with the same amount settles and its note is
added at `p`.

### `Got` (gateway → recipient)

Texted to the recipient of a private payment (`gotAlert`), after the
transaction lands, when the recipient is a different number, has alerts on
(`links.alerts`), and is a `+91` number. Once per transaction per number
(`alerts_sent`, shared with `Received`).

```
Got <amount> AUSD (private) p=<pos> b=<blinding>
```

| Field | Meaning |
| --- | --- |
| `amount` | The payment's amount |
| `p` | Tree position of the recipient's note |
| `b` | The note's blinding, 32 bytes big-endian, unpadded base64, 43 chars |

No sender: a text never tells one user another's number. The older
`Got <amt> AUSD from <who> p=… b=…` still parses; the sender is dropped.

```
Got 20 AUSD (private) p=2 b=JChSinJMDXfb6EPnc6mmjkvKxsypLXMVyyyZT3Z0/k0                 71, 83 +hash
Got 999999.999999 AUSD (private) p=99999999 b=JChSinJMDXfb6EPnc6mmjkvKxsypLXMVyyyZT3Z0/k0   89, 101
```

App: adds the note `{pos: p, amount, blinding}` to the cache and an incoming
"Private payment" row `got:<network>:<p>`. The next online `/shielded/notes`
replaces the cache anyway.

## Alerts

### `Received` (gateway → recipient)

Texted when an AUSD transfer to a linked address arrives (Alchemy Address
Activity webhook → `record` → `alertAll`), on either network, if the
recipient has alerts on and a `+91` number. Not for transfers more than 10
minutes old by the delivery's `createdAt` (`ALERT_MAX_AGE`), and once per
transaction per number (`alerts_sent`). Any AUSD sender counts, including a
private withdrawal from the pool to an Ender wallet (then `from` is the pool).

```
[Test] Received <amount> AUSD from <0x EIP-55>. Balance <balance> AUSD. Tx <short tx>
```

| Field | Meaning |
| --- | --- |
| `[Test] ` | Testnet only |
| `amount` | Transfer value |
| `from` | Sender's full address, EIP-55. Never a number, even for an Ender sender |
| `Balance` | Recipient's AUSD balance read when the alert is built |
| `Tx` | `shortHex` of the hash: how the app matches the alert with `/activity` |

```
[Test] Received 10 AUSD from 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc. Balance 25.5 AUSD. Tx 0xc6b9...fb   108, 120 +hash
Received 10 AUSD from 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc. Balance 25.5 AUSD. Tx 0xc6b9...fb          99, 111
[Test] Received 999999.999999 AUSD from 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc. Balance 999999.999999 AUSD. Tx 0xc6b9...fb   128, 140 (worst)
```

Parsed by one strict regex. App (`applyReceived`): network from `[Test]`; adds
an incoming Activity row `sms:<network>:<short tx>` unless that transfer is
already there (same row id, or an incoming row whose full hash shortens to
it), and then sets that network's balance to `Balance`. When `/activity`
later returns the transfer, the full row replaces the text's row.

## Texts the app composes but the gateway never sees

The invite, sent from the user's own SMS app to a number that isn't on Ender
(Review, after `ERR not-on-ender`, "Invite them"), 96 characters:

```
I want to send you money on Ender. Get the app and sign up with this number: https://ender.money
```

## Flows

Online, the app uses HTTPS for every step marked (HTTP) and no SMS is sent;
the gateway's texts that it starts itself (OTP, `Received`, `Got`) go out
either way. Steps can mix: a quote fetched online can be signed and sent by
text if the connection drops.

**Sign-in**

1. App → `POST /auth/start {phone}` (HTTP only).
2. Gateway → phone: `Ender code: 481926. Don't share it.` + hash.
3. App reads it (RECEIVE_SMS or Retriever) or the user types it → `POST /auth/verify` (HTTP).

**Public send, online**: `POST /tx/quote` → `checkQuote` → sign →
`POST /tx/sign` (polls `GET /tx/:id` if `pending`). No texts, except the
recipient's `Received`.

**Public send, offline**

1. Phone → `SEND +919876543210, 20 AUSD`
2. Gateway → `Q 7F3K n=4 exp=… fee=0.01 to=0x…` (or `ERR <code>`)
3. App checks the quote, user approves (passkey or Quick send).
4. Phone → `SIG 7F3K <88>`
5. Gateway → `Sent 20 AUSD to 0x9965...dc. Tx 0xc6b9...fb` (or `ERR 7F3K <code>`)
6. Gateway → recipient: `Received …` (webhook, alerts on).

**Private `PAY` to a number** (offline; online: `/shielded/quote`, `/shielded/submit`)

1. Phone → `PAY +919876543210, 20 AUSD`
2. Gateway → `Q 7F3K exp=… fee=0.01 to=<86>`
3. App checks (incl. `KEY CHANGED`), picks notes, signs.
4. Phone → `SIG 7F3K <refs> <86>`
5. Gateway → `Sent 20 AUSD to +919876543210. Tx … p=2` (or `ERR 7F3K pending`, then repeat 4)
6. Gateway → recipient: `Got 20 AUSD (private) p=2 b=<43>` (alerts on).

**Private `PAY` to an `ender1…` address**: as above, but the `Q` has no
`to=` (the app uses the typed key), `Sent` says `to ender1rreg...6dx9`, and
`Got` goes to the address's owner, whose number the payer never sees.

**Private withdrawal to 0x**: `PAY 0x…, 5 AUSD` → `Q … to=0x…` (must equal
the typed address) → `SIG <id> <refs> <86>` → `Sent 5 AUSD to 0x9965...dc. Tx
… [p=…]`. If the 0x address is a linked Ender wallet, its owner gets a
`Received` from the pool address.

**`SHIELD`**: `SHIELD 50 AUSD` → `Q 7F3K exp=… fee=0.01` → app signs the
EIP-3009 authorization with the wallet key → `SIG 7F3K <88>` → `Shielded 50
AUSD. Tx … p=0` (or `ERR 7F3K pending`).

**`MERGE`** (gateway only; no app UI): `MERGE` → `Q <id> exp=… fee=0.01` →
`SIG <id> <refs> <86>` → `Sent 0 AUSD to <own number>. Tx … p=<n>`, merged
note at `p+1`.

**Incoming public payment**: transfer lands → Alchemy webhook → `transfers`
row → `Received …` text (alerts on, ≤ 10 min old) → app adds the row; online,
`/activity` shows the same transfer without the text.

**Private `Got`**: the payer's `SIG` (or `/shielded/submit`) lands → the
gateway indexes the receipt (the recipient's note is found by trial
decryption) → `Got …` to the recipient (alerts on) → app adds the note; online,
`/shielded/notes` has it anyway.

## Error codes

`ERR <code>` answers a command that has no id (`SYNC`, `SEND`, `PAY`,
`SHIELD`, `MERGE`, an unparseable text); `ERR <id> <code>` answers a `SIG`.
Codes never contain spaces. On HTTPS the same codes come as `{error}`. The app
text is `ERRORS` in `wallet.ts`; codes missing there show
`Gateway said: <code>`. While Review waits for a reply, any `ERR` (and, while
waiting for `Sent`, any `ERR` with that id or no id) fails the step.

| Code | Path | Meaning | App |
| --- | --- | --- | --- |
| `bad-command` | any | Unparseable text from a linked number (unlinked numbers get nothing) | Gateway said |
| `not-registered` | `SYNC`, `SEND` | Number has no wallet | "This number has no wallet. Log in again." |
| `rpc-unavailable` | `SYNC`, `SEND`, `SIG` | Balance read failed | Gateway said |
| `unsupported` | `SEND … > CTK` | No CTK pair on this network | "Not supported yet." |
| `bad-amount` | `SEND`, `PAY`, `SHIELD` | Amount invalid (the parser catches it first) | "Check the amount." |
| `bad-recipient` | `PAY` | Not a number, 0x or `ender1…` (the parser catches it first) | "That isn't a phone number, wallet address or private address." |
| `not-on-ender` | `SEND` | Number not on Ender | Explains, offers "Invite them" |
| `self-transfer` | `SEND` | Recipient is the sender's wallet | "That's your own wallet." |
| `not-delegated` | `SEND` | Wallet not delegated yet | "…still being set up…" |
| `low-balance` | `SEND`, `SIG` | Balance < amount + fee | "Not enough balance…" |
| `swap-unavailable` | `SEND … > CTK` | Couldn't whitelist or price the swap | "Local-currency delivery is unavailable…" |
| `busy` | `SEND`, `PAY`, `SHIELD`, `MERGE` | No free id after 5 tries | Gateway said |
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
`wrong-passkey`, and the public pin-change warning.

## Open questions

- **`Sent` matching.** `Sent` carries no id. The waiting Review screen takes
  any `Sent` / `Shielded` as its own, and `applyReply` settles the oldest
  waiting private payment with the same amount, also on a public `Sent`. A late
  or unrelated `Sent` of the same amount could settle the wrong one until the
  next online resync.
- **Private texts while in mainnet mode.** `applyShieldedReply` uses the app's
  current network and returns unless it is registered there, so a `Got`,
  `Sent` or `Shielded` that arrives while the app shows mainnet is dropped.
  The next online `/shielded/notes` on testnet recovers it.
- **`Got` needs alerts on.** `gotAlert` skips numbers with `links.alerts` off,
  so they learn of a private payment only online.
- **`MERGE`** is in the protocol and the gateway, but the app has no screen
  that sends it.
- **Public `SIG` while pending.** `sign` returns `pending` when no receipt came
  in 30 s, but `gateway/src/sms.ts` answers `Sent` anyway, so the text can
  report a transfer that later fails (`GET /tx/:id` and `reconcile` know).
- **Id namespace.** A private quote skips ids held by public sessions, but a
  public quote doesn't check `shielded_quotes`. If one number had both under
  the same id, its public-shaped `SIG` would go to the deposit.
- **Rate limits.** [gateway.md](gateway.md) says inbound SMS has a per-number
  limit; `handleInbound` has none, and `ERR rate-limited` is never sent by text.
- **Twilio.** [gateway.md](gateway.md) lists `POST /webhooks/twilio`; there is
  no such route yet, so inbound SMS only comes through the relay.
- **Retriever timing.** `listenForCode` starts on the code screen, after
  `/auth/start`; a code that arrived first would be missed by the Retriever
  (RECEIVE_SMS still queues it).

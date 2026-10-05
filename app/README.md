# Ender app

Expo (SDK 57) dev build for Android. Screens and flows are specified in
[../SCOPE.md](../SCOPE.md); the gateway API in [../docs/gateway.md](../docs/gateway.md);
every SMS the app and gateway exchange in [../docs/SMS.md](../docs/SMS.md).

## Layout

```
src/app/          routes (expo-router)
  welcome, phone, code          O1-O3: log in with an OTP
  create, restore, lost         N1-N3 new wallet (with its Ender ID) / E1 welcome back / E2 lost passkey
  name                          pick an Ender ID once, for an account made before them
  (tabs)/home, activity, settings
  send, review, scan, receive, tx/[id]
src/lib/
  keys.ts       passkey -> PRF -> secp256k1 key (Mera), Quick send sessions
  wallet.ts     sync, signup (7702 authorizations), quote checks, signing
  private.ts    private balance (shielded pool, testnet only): key derivation, routing, note cache, signing, auto-merge and auto-shield rules
  transport.ts  internet first; SMS composer when offline ([Test] prefix for testnet); replies by SMS, clipboard or paste
  inbox.ts      public Received alerts by text -> Activity rows, deduped against the online history (private ones: private.ts)
  names.ts      the Ender ID screen's hints and rules (live check: GET /names/check)
modules/sms-retriever/   Android: gateway texts via the SMS Retriever (no permission)
  api.ts        gateway HTTPS client (5 s timeout, then SMS)
  store.ts      persisted state (AsyncStorage; JWT in SecureStore)
../protocol/    shared with the gateway: networks, Calibur typed data, SMS format, recipients (0x, numbers, ender1…, Ender IDs), Ender ID rules
```

## Keys

Nothing secret is stored. Each approval runs a passkey assertion with the
PRF extension; the 32-byte output becomes BIP-39 entropy, then
`m/44'/60'/0'/0/0`, as in Mera's passkey-accounts recipe. A Quick send session
keeps that key in a Mera signing session for up to 10 minutes / $50 / $20 per
transfer, recent recipients only, and ends when the app is backgrounded.

The app signs the Calibur batch it builds itself from the fields on screen
(recipient, amount, fee), never calldata from the gateway.

The private balance's keys (testnet only) come from the same PRF output under
HKDF label `ender/shielded/v1/seed` (`lib/private.ts`). The app registers the
proving keys with the gateway (`/shielded/register`); the spending key never
leaves the phone. Mainnet shows no private balance. Settings' Auto-merge
(off by default) folds the 12 largest notes into one while the app is online
and a Quick send session holds the key; it never keeps a key for this.

Settings' Auto Shield (on by default, also for installs from before it)
moves the whole public balance into the private one in a single deposit
(deposit + $0.01 fee = the balance) once it holds $1 or more, under the same
conditions as Auto-merge, and only when nothing private is waiting to settle
and no public payment is still sending. It runs after a refresh, a resync, a
settled private payment, on coming to the foreground and when switched on;
never by text, never on mainnet (no pool). One of Auto-merge and Auto Shield
runs at a time. With it on, Home shows one balance (public + private) and no
Make private; with it off, the split and Make private come back.

Activity lists only payments to and from others. Shields, merges and
withdrawals to our own wallet (and the pool transfers the online history shows
for them) are kept to settle but never listed (`listed` in store.ts), so their
$0.01 fees have no row.

Payments come from the private balance whenever the notes cover amount + fee:
to a private address or a number / Ender ID with one, a private payment; to a
0x address, or a number / Ender ID whose owner has no private address, a
private withdrawal to that wallet (the gateway's lookup, checked against the
pinned wallet if any). Otherwise (notes short, `ERR MERGE`, a changed pinned
wallet) it's public. A private payment refused at the quote or by the notes
(`NOUSER`, `FUNDS`, `MERGE`), or at submit/proving when the public balance
covers it, switches Review to public, so Try again pays publicly.

## Ender IDs

Every account has a permanent name, `<label>.ender.my` (5-20 of `a-z`, `0-9`,
interior hyphens; `protocol/names.ts`). A new wallet picks it after the
passkey and before `/wallet/create`, which takes it (`ui/ChooseName.tsx`,
checking availability as the user types). A relink keeps the existing one;
an account without one is sent to the same screen on launch (`/name`, once
per launch; `POST /account/name`). Restoring an account that has one skips it.

Send, the scanner and links take `label.ender.my`, `@label` and
`https://label.ender.my`; the gateway resolves the name, and the route is
the usual one (private when the name has a private address and the private
notes cover it, else public). Its first answers are pinned under the name,
as a number's are. Receive shows the Ender ID and copies its pay page link;
Settings shows it. Anyone can open `https://<label>.ender.my` to pay from any
wallet, and ENS-aware wallets resolve the name to the public address.

## Texts from the gateway

On Android the app reads the gateway's replies and alerts (`Received`,
public or private, the older `Got`, `Sent`, `Shielded`, `Q`, `ERR`) by itself while it's open, through
the SMS Retriever (no permission; every gateway text ends with the app's
hash), re-armed on every foreground, after each text and every 4 minutes.
Texts that arrive while the app is closed come in with the next online sync,
or by Copy / Paste reply, which work everywhere. `RECEIVE_SMS` was dropped:
Play Protect blocks sideloaded apps that request SMS permissions.

## Passkeys need the signing key

Passkeys for `ender.money` only work in builds signed with the key in
`credentials/` (gitignored), whose SHA-256 is listed at
`https://ender.money/.well-known/assetlinks.json` (served by the gateway).
`plugins/with-android-build.js` signs debug and release builds with it.
Without `credentials/`, builds fall back to the stock debug key and passkey
calls fail.

## Run

```bash
bun install
bunx expo run:android                 # debug build + Metro
cd android && ./gradlew assembleRelease   # standalone APK in android/app/build/outputs/apk/release
```

On Windows the native build can hit the 260-character path limit
(react-native-gesture-handler's codegen objects). Build from a short drive
alias instead:

```bash
subst X: C:\workspace\ender-money
cd /x/app/android && ./gradlew.bat assembleRelease
```

Emulator note: if another project's Metro already owns port 8081, start this
one with `bunx expo start --port 8082` and point the debug app at it
(dev menu → Settings → Debug server host → `localhost:8082`, plus
`adb reverse tcp:8082 tcp:8082`).

Environment (build time):

| Variable | Default | Use |
| --- | --- | --- |
| `EXPO_PUBLIC_GATEWAY_URL` | `https://api.ender.money` | `http://10.0.2.2:8787` for a local gateway from the emulator |
| `EXPO_PUBLIC_GATEWAY_SMS_IN` | `+917004543035` | relay phone number the app texts when offline (India) |
| `EXPO_PUBLIC_GATEWAY_SMS_INTL` | unset | Twilio number (international) |

Without a gateway number the SMS fallback says so instead of opening the composer.

## Checks

```bash
./node_modules/.bin/tsc --noEmit
bunx expo lint
```

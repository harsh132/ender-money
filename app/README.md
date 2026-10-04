# Ender app

Expo (SDK 57) dev build for Android. Screens and flows are specified in
[../SCOPE.md](../SCOPE.md); the gateway API in [../docs/gateway.md](../docs/gateway.md).

## Layout

```
src/app/          routes (expo-router)
  welcome, phone, code          O1-O3: log in with an OTP
  create, restore, lost         N1-N3 new wallet / E1 welcome back / E2 lost passkey
  (tabs)/home, activity, settings
  send, review, scan, receive, tx/[id]
src/lib/
  keys.ts       passkey -> PRF -> secp256k1 key (Mera), Quick send sessions
  wallet.ts     sync, signup (7702 authorizations), quote checks, signing
  private.ts    private balance (shielded pool, testnet only): key derivation, routing, note cache, signing
  transport.ts  internet first; SMS composer when offline; replies by SMS, clipboard or paste
  inbox.ts      Received alerts by text -> Activity rows, deduped against the online history
modules/sms-retriever/   Android: gateway texts by RECEIVE_SMS (queued while closed) or the SMS Retriever
  api.ts        gateway HTTPS client (5 s timeout, then SMS)
  store.ts      persisted state (AsyncStorage; JWT in SecureStore)
../protocol/    shared with the gateway: networks, Calibur typed data, SMS format, recipients (0x, numbers, ender1…)
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
leaves the phone. Mainnet shows no private balance.

## Texts from the gateway

On Android the app reads the gateway's replies and alerts (`Received`,
`Got`, `Sent`, `Shielded`, `Q`, `ERR`) by itself. With
`RECEIVE_SMS` (asked once, from Activity), a manifest receiver in
`modules/sms-retriever` keeps texts from the gateway's numbers only
(`EXPO_PUBLIC_GATEWAY_SMS_IN` / `_INTL`, passed in at startup), queues
them while the app is closed and hands them over on startup and every
foreground; other senders are dropped unread. Without the permission it
falls back to the SMS Retriever (no permission; every gateway text ends with
the app's hash), re-armed on every foreground and after each text. Copy or
Paste reply works everywhere.

Play Store builds need the SMS permissions declaration form (core use:
SMS-based money transactions) before `RECEIVE_SMS` is allowed; sideloaded
APKs are unaffected.

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

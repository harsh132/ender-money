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
  transport.ts  internet first; SMS composer + clipboard replies when offline
  api.ts        gateway HTTPS client (5 s timeout, then SMS)
  store.ts      persisted state (AsyncStorage; JWT in SecureStore)
../protocol/    shared with the gateway: networks, Calibur typed data, SMS format
```

## Keys

Nothing secret is stored. Each approval runs a passkey assertion with the
PRF extension; the 32-byte output becomes BIP-39 entropy, then
`m/44'/60'/0'/0/0`, as in Mera's passkey-accounts recipe. A Quick send session
keeps that key in a Mera signing session for up to 10 minutes / $50 / $20 per
transfer, recent recipients only, and ends when the app is backgrounded.

The app signs the Calibur batch it builds itself from the fields on screen
(recipient, amount, fee), never calldata from the gateway.

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

Environment (build time):

| Variable | Default | Use |
| --- | --- | --- |
| `EXPO_PUBLIC_GATEWAY_URL` | `https://api.ender.money` | `http://10.0.2.2:8787` for a local gateway from the emulator |
| `EXPO_PUBLIC_GATEWAY_SMS_IN` | unset | relay phone number the app texts when offline (India) |
| `EXPO_PUBLIC_GATEWAY_SMS_INTL` | unset | Twilio number (international) |

Without a gateway number the SMS fallback says so instead of opening the composer.

## Checks

```bash
./node_modules/.bin/tsc --noEmit
bunx expo lint
```

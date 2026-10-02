# Unlink spike (3 Oct 2026)

Question: can Ender use Unlink's shielded pool on Monad to move funds between
stealth addresses and spend them without linking them? Not integrated; this is
what the SDK and the hosted service showed.

## Result: blocked, and a poor fit for the SMS path

**1. The hosted Engine is offline on every network.** Every SDK environment
(`monad-testnet`, `monad`, `base-sepolia`, …) points at
`https://<env>-production-api.unlink.xyz`. Each of those is a CNAME to a Fly.io
app (`unlink-engine-<env>-production.fly.dev`), and every one of those returns
NXDOMAIN (checked with Google and Cloudflare DNS). The Engine prepares every
transaction, builds every proof and relays it, so nothing works without it. The
newest SDK is `0.3.0-canary.793` from 3 Aug 2026; the docs site is up.
**Live testing was not possible.**

**2. An API key needs a dashboard account** (`dashboard.unlink.xyz`). Not
created: creating accounts is the user's call.

**3. Every spend needs the full prepared transaction on the phone.** From
`@unlink-xyz/sdk` (transfer, withdraw):

1. The client asks the Engine to `prepare`; the Engine returns a
   `signing_request` with the selected notes, output commitments, nonces and
   proof inputs.
2. The client checks it against what the user asked for
   (`assertSigningRequestIntent`, `assertSigningRequestArtifacts`), so the
   Engine can't swap the recipient or amount.
3. The client signs it with an **EdDSA-Poseidon (BabyJubJub)** key: signature
   `[R8x, R8y, S]`, three field elements.
4. The client submits the signature; the Engine proves and relays.

Step 2 is what keeps the Engine honest, and it needs kilobytes of data. A
160-character SMS can't carry it. An offline Unlink spend would mean the phone
signing something it can't check, trusting the gateway with the recipient and
amount. That is a downgrade from today, where the phone rebuilds the Calibur
batch from the readable fields and signs exactly that.

## Answers to the open questions

| Question | Finding |
| --- | --- |
| Monad support | listed: `monad-testnet` (10143), `monad` (143, access grant) — but the Engines are down |
| AUSD | no token list in the SDK or docs; tokens come from the Engine at runtime, so unknown |
| React Native | likely workable: pure JS (`@noble/*`, `poseidon-lite`, `@scure/*`, `openapi-fetch`), needs only `crypto.getRandomValues` and `fetch`; `window` appears only in the optional browser-wallet helper. Proving is done by the Engine, not on the phone |
| Keys from our passkey | yes: `account.fromEthereumSignature` derives the seed from a `personal_sign` by our root key (app ID and chain ID are bound in) |
| Deposit from a stealth address | uses Permit2 approval + a prepared deposit from the EVM sender; a Calibur batch signed by the stealth key could do it |
| SMS spends | no (see 3) |
| Gas | sponsored from a per-tenant relay balance; `execute` uses their ERC-4337 paymaster |
| Fees, mainnet | no pricing published; mainnet needs an access grant |

## Recommendation

- Don't build on Unlink for the hackathon: the service is down, and even when
  up it can't serve offline payments safely.
- Ship per-pair stealth addresses with direct spending
  ([stealth.md](stealth.md)). Number lookups reveal nothing on-chain; the
  remaining leaks (addresses spent together, payer and payee comparing notes)
  are written up honestly.
- In the write-up, list "private balance via a shielded pool, online only" as
  future work, and recheck Unlink's status before submission.

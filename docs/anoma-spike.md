# Anoma spike (3 Oct 2026)

Question: can Ender use Anoma (anoma.net), whose protocol adapter is already on
Monad mainnet, for a private AUSD balance, and could it work offline? Two
tracks: reading the open-source code, and read-only checks against Heliax's
backend and Monad mainnet. Nothing was broadcast, registered or committed to
their servers. Dry-run script, on-chain checks and saved evidence:
[spikes/anoma](../spikes/anoma/README.md).

## Result

The design is the best fit found, and the contracts on Monad are usable by
anyone. But **Heliax's hosted service does not support AUSD on Monad**, there is
**no testnet anywhere**, and their backend and indexer are **closed source**.
Using Anoma means either Heliax listing AUSD, or running the backend ourselves.

## What Anoma is

- **Anoma Resource Machine (ARM):** a private ledger of "resources"
  ([arm-risc0](https://github.com/anoma/arm-risc0), Apache-2.0). A resource has
  `logic_ref, label_ref, quantity (u128), value_ref, is_ephemeral, nonce,
  nk_commitment, rand_seed`. Commitments and nullifiers are SHA-256 based; an
  action tree (SHA-256 Merkle) covers the `[nullifier, commitment]` pairs. The
  rules run as Rust programs in the RISC Zero zkVM; proofs are wrapped to
  Groth16 for on-chain verification.
- **EVM protocol adapter** ([pa-evm](https://github.com/anoma/pa-evm), MIT in
  `contracts/`): verifies proofs (RISC Zero verifier router), keeps the
  commitment tree and nullifier set, calls forwarders. On Monad mainnet at
  `0x2D2Fa19aFdbb20DC73737ca5f075cfAE00Cd90C2`, version 1.1.0, owner a 3-of-5
  Safe that can only trigger a one-way emergency stop. `execute()` is
  permissionless.
- **ERC-20 forwarder** ([anomapay-erc20-forwarder](https://github.com/anoma/anomapay-erc20-forwarder)):
  wraps any ERC-20 into resources and back. On Monad at
  `0x23dc44E1a1c3d5432EeC8A1c027e22ccDC0A8F54`, version 1.0.1. **No token
  allowlist on-chain**: only calls from the adapter with the AnomaPay v1 transfer
  logic (`bc1232…`) are accepted, so anyone who produces valid proofs can use it
  for any ERC-20, AUSD included. The allowlist is only in Heliax's backend.
- **AnomaPay:** Heliax's live payments app. The app sends a payment to a
  transaction service; a proving service builds the proof on GPUs; the adapter
  settles. Backend `pay.prod.heliax.app` (version 1.3.0), indexer
  `galileo.prod.heliax.app`.

## Flows and what's public

| Flow | How | Public on-chain |
| --- | --- | --- |
| Wrap (deposit) | the user's EOA signs a Uniswap Permit2 `permitWitnessTransferFrom` with the action tree root as witness; the relayer calls `PA.execute()`, which pulls tokens through Permit2 (needs a one-time `approve(Permit2)`) | `Wrapped(token, from, amount)`, nullifiers, commitments, ciphertexts |
| Private transfer | consume notes, create notes for the recipient and change | nullifiers, commitments, ciphertexts, relayer; not sender, receiver, amount or token |
| Unwrap (withdraw) | an ephemeral resource triggers `safeTransfer` to an EVM address | `Unwrapped(token, to, amount)` |

## Keys

`createUserKeyringFromIkm(ikm, salt)`: `seed = HKDF-SHA256(ikm, salt, "", 32)`,
then each key is `HMAC-SHA256(seed, domain)`. Authority, encryption and
discovery keys are secp256k1; the nullifier key is 32 raw bytes with
commitment `sha256(nk)`. **Our passkey PRF output can be the `ikm` directly**
(the SDK even has `createUserKeyringFromPasskey`); use a salt distinct from the
EVM wallet key's. The passkey itself (P-256) can't sign spends: the derived
secp256k1 authority key lives in app memory.

A pay address is 135 bytes (authority, discovery and encryption public keys,
nullifier-key commitment, CRC32), encoded in **base58** (about 184 characters;
the README says Base64URL, the code says otherwise).

## The key property: split keys

A spend is authorized by an **ECDSA signature from the authority key**, over
`"ARM_AUTH_V1" ‖ "TokenTransferAuthorization" ‖ actionTreeRoot` (SHA-256
prehash, 64 bytes r‖s). It is checked inside the ZK proof, not on-chain. The
prover needs the **nullifier key** and the note plaintexts, but not the authority
key. So a server can prove without being able to spend.

**Offline:** the phone can rebuild everything it signs. The action tree root
commits to full commitments, which include quantity, token (`label_ref`) and the
recipient's keys (`value_ref`, `nk_commitment`). With its unspent notes and the
recipient's pay address cached, plus deterministic `rand_seed` values and a coin
selection rule the backend copies exactly, the phone signs 64 bytes: **one SMS**
(88 base64 characters plus compact fields). Our backend would then hold the
user's nullifier key and note plaintexts permanently. Caveat: the recipient's
encrypted note is produced by the prover and isn't covered by the signature, so
a malicious prover can't redirect funds but could break discovery.

## Live checks (Monad mainnet and Heliax backend)

- **Chains served:** ethereum, base, arbitrum, bsc, monad, stable; all mainnet.
  `pay.dev.heliax.app` serves the same mainnet contracts. Monad testnet (10143)
  appears nowhere, and the contracts have no code there.
- **Tokens on Monad:** USDC, USDT0, WETH, WMON. **AUSD is rejected:**
  `400 "Token 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a is not supported on monad"`.
- **Fees (quoted, paid in the moved token, USDC on Monad):** wrap 0; transfer or
  unwrap 0.0023 (4 resources), 0.0028 with the fee note (6 resources). Fits
  `(390k + 78k × resources) gas × gas price × MON price` (inferred). Heliax's
  relayer pays the MON; the quoted fee covers about half the real gas.
- **Usage:** 1,134 commitments ever; the forwarder holds about 109 USDC and 90
  WMON (about $112) and 0 AUSD. Recent activity is under one transaction a day,
  almost all from two Heliax relayer addresses. **The anonymity set is tiny.**
- **Gas per transaction:** wrap about 1.59M; transfer 1.57–1.95M; unwrap
  1.65–2.21M; about 0.16–0.23 MON ($0.005–0.007).
- **Dry run** (`spikes/anoma/dry-run.mjs`): derives keyrings and a pay address,
  builds a wrap (Permit2 EIP-712 signature, 65 bytes), a private transfer and an
  unwrap (64-byte authority signatures; request bodies 3.2–4.6 KB), and stops
  before submitting. The indexer lookup returns 404 for an unregistered key; the
  next step (`POST /add_key`) would register it, so it was not called.

## Trust model with Heliax's service

Every spend sends the user's **nullifier key in plain text** to the backend
(so Heliax can link all of a user's spends), and the backend sees amounts,
recipient keys and addresses while proving. Checking a balance gives the indexer
the **discovery secret key** (in the URL path of `GET /tags/<sk>`). Private from
the chain, not from Heliax.

## Proving and self-hosting

- Proofs are built by the backend; the SDK has no prover. Docs budget about
  **20 s per resource pair** on GPUs (Vast.ai). Aggregation on an RTX 4090: 6.4 s
  for 1 action, 12 s for 4. Groth16 wrapping needs x86_64. RISC Zero's hosted
  prover (Bonsai) is supported via environment variables.
- **Closed:** the transaction/proving service and the indexer. Self-hosting means
  writing a Rust service that builds the transfer witness, compliance units and
  delta proof, proves (CUDA GPU or Bonsai), aggregates and relays `execute()`,
  plus an indexer for the adapter's events. Several engineer-weeks.
- Adapter benchmark: about 1.1M gas for 2 resources without aggregation (0.6M
  with), 5.3M / 1.9M for 10, 21M / 7M for 40.

## Audits and licenses

| Date | Auditor | Scope | Notable |
| --- | --- | --- | --- |
| 2025-11-13 | Nethermind | ARM + adapter | 3 low |
| 2025-11-24 | Informal Systems | ARM + adapter | 15 findings, 2 medium, fixed in v0.8.2 |
| 2025-12-19 | Informal Systems | AnomaPay phase I (SDK, forwarder, resource) | 1 critical (fee-on-transfer/rebasing), resolved |
| 2026-07-03 | Informal Systems | generic call resource and forwarder | informational |

Licenses: arm-risc0 and anoma-app-sdk Apache-2.0; contracts MIT (in their
`contracts/` folders); **anomapay-erc20-resource GPL-3.0** (Cargo.toml, no
LICENSE file): fine on our server, not in the app.

## React Native

`@anomaorg/arm-bindings` 0.3.1 uses a pre-release of
uniffi-bindgen-react-native (JSI TurboModule, RN ≥ 0.79), Android arm64-v8a
only, about 35 MB unstripped. Expo needs a development build; there's an
`examples/expo` app. SDK v1.0 removed the backend and indexer clients, but the
balance example still imports them (last version with them: v0.18.1).

## Risks

1. AUSD not listed by Heliax; no testnet.
2. Closed backend and indexer.
3. **Calibur and Permit2:** deposits go through Permit2, and our users' accounts
   are Calibur-delegated, so Permit2 takes the contract-signature (EIP-1271)
   path while the forwarder hard-codes a 65-byte signature. Must test first.
4. Heliax (or our backend) holds nullifier keys and sees all activity.
5. Emergency committee can move forwarder funds after a stop; Agora can freeze
   the forwarder's AUSD; RISC Zero pausing its verifier halts the adapter.
6. Tiny anonymity set; pre-release RN bindings; GPL resource code; about 20 s
   proving per pair.

## Human-run test plan

AUSD can't go through AnomaPay today, so the plan in
[spikes/anoma/README.md](../spikes/anoma/README.md) uses 0.10 USDC and 0.05 MON
from a fresh wallet: approve Permit2 (one transaction you broadcast), wrap,
private transfer between two throwaway pay addresses, unwrap, verify balances.

# Ender Money — private balances (design and research)

Stealth addresses ([stealth.md](stealth.md)) stop number lookups from revealing
wallets, but leaks remain: stealth addresses spent together hint they belong
together, a payer and payee comparing notes can link a pair address to its
owner, and every amount is public. A shielded pool closes these: money held as
private notes, transfers that reveal nothing, and deposits and withdrawals that
don't line up with payments.

This doc collects the options, the research behind them and the target design.
Spike reports: [nova-spike.md](nova-spike.md), [splitkey-spike.md](splitkey-spike.md),
[anoma-spike.md](anoma-spike.md), [unlink-spike.md](unlink-spike.md).

## Where we landed

| Option | Status | Verdict |
| --- | --- | --- |
| **Nova-style pool with split keys** (our own) | Nova spike passes on both toolchains; split-key spike passes, offline over SMS included | **target design**: fast Groth16, server proves but can't spend, one-SMS offline payments; needs a ceremony and an audit |
| **Anoma** (live on Monad) | contracts usable by anyone; Heliax backend rejects AUSD, no testnet, backend closed | strongest off-the-shelf option; ask Heliax to list AUSD, or self-host (weeks) |
| zAUSD wormhole | design only | better deniability, but every transfer pays to update the tree; later |
| Burn addresses + claim | design only | same machinery as zAUSD; replaces stealth addresses for receiving |
| RAILGUN | contracts and circuits unlicensed | can't deploy our own; only if the RAILGUN DAO deploys on Monad |
| Privacy Pools (0xbow) | audited, maintained | v1 can't merge deposits or transfer in-pool |
| Unlink | hosted Engine offline | blocked |

**For the hackathon (13 Oct):** none of these ships. Stealth addresses as
planned; private balances are the roadmap item in the pitch.

## The model: balances live in the pool

Amounts only link people at the pool's edges: a deposit shows "X went in", a
withdrawal "X came out". Inside, transfers hide sender, receiver and amount.

- **Ender to Ender:** a private transfer inside the pool. Nothing public, so
  nothing to match.
- **Deposits and withdrawals don't line up with payments:** a top-up of 50 is
  later spent as 12.34; received notes are merged with others (10 + 15 + 5 into
  30) before any withdrawal, so no withdrawal matches an incoming amount.
- **Extra cover at low volume:** withdraw in common chunks, add random delays,
  let the gateway batch withdrawals. More users is the real defence.
- **What stays visible:** paying an outside wallet is a withdrawal (that wallet
  gets X, but not who paid); money arriving from outside shows its sender and
  amount going in, not which Ender user it went to.

## Option A: Nova-style pool

Base: [tornadocash/tornado-nova](https://github.com/tornadocash/tornado-nova)
(ISC per `package.json`, no LICENSE file, archived 2022, audited by ZeroPool).
Spike: [nova-spike.md](nova-spike.md).

**Notes and join-splits.** Money is held as notes `{amount, owner pubkey,
blinding}`; the pool stores only their hashes (commitments) in an on-chain
Merkle tree. Every transaction spends 2 notes and creates 2 (16-in/2-out for
big merges), with a public amount: positive for a deposit, negative for a
withdrawal, zero for a private transfer. The proof shows the inputs are in the
tree and owned by the spender, their nullifiers are fresh, and inputs + public
amount = outputs. New notes are encrypted to their owners and published in the
transaction's log.

| Action | Inputs | Outputs | Public amount | Public on-chain |
| --- | --- | --- | --- | --- |
| Deposit 10 | empty, empty | 10, 0 | +10 | depositor and amount |
| Merge | 10, 15 | 25, 0 | 0 | that a pool transaction happened |
| Transfer | 25 | 20 to Alice, 5 change | 0 | nothing about who or how much |
| Withdraw | 5 | 0, 0 | −5 | amount and destination |

**Relayer.** `extData = {recipient, extAmount, relayer, fee, encryptedOutputs}`
is hashed into a public input; the relayer (our gateway) submits and is paid in
AUSD, so fresh addresses need no MON.

**Spike result.** Stripped of Nova's Gnosis Chain wiring (bridge deposits,
cross-chain governance, proxy, multisig, key registry), ported to Solidity 0.8,
it works end to end on anvil with both the original Circom 0.5 toolchain and a
Circom 2 port. Build on the Circom 2 port (maintained tooling, standard
Poseidon). Per transaction: about 2.1M gas on Monad (about 0.2 MON), proving
0.73 s for 2-in/2-out on a desktop, 8 MB proving key.

### Who builds the proof

Nova's proof takes the spending private key as an input (`pubkey =
hash(privkey)`, and the nullifier is derived from it). Whoever proves can spend.
So with Nova unchanged, either the phone proves (mopro + rapidsnark, estimated
1–3 s on mid-range Android, 8 MB key downloaded once), or the gateway proves and
becomes custodial. Unacceptable.

### Integration (online)

- **Keys:** a shielded key derived from the passkey PRF output, separately from
  the wallet key, plus an encryption key. A shielded address (about 64 bytes) is
  an off-chain identifier, never on-chain. The gateway directory maps phone
  numbers to shielded addresses, so **for Ender-to-Ender payments the pool makes
  per-pair stealth addresses unnecessary**: the lookup reveals nothing on-chain.
- **Shield:** one Calibur batch, `AUSD.approve(pool)` + `pool.transact(proof,
  +X)`, signed by the wallet key and sponsored by the gateway like today.
- **Private payment to a number:** the gateway resolves the number to a shielded
  address; the proof creates X for the recipient, change for the sender and the
  fee for the gateway; the gateway submits `pool.transact` from its relayer key.
  No wallet signature: the proof is the authorization.
- **Pay an outside address:** a withdrawal to that address.
- **Receive:** the gateway's cron indexes the pool's note events and serves tree
  paths; the app decrypts what's new. SMS alerts still work for transfers the
  gateway relayed. The app merges notes in the background.
- **UI:** Private and Public balances; private by default for Ender recipients
  online, public (main wallet) offline.

### Viewing key on the gateway

If the user gives the gateway their viewing (decryption) key, the gateway
decrypts every note as it lands and serves each user only their own notes and
paths. Sync gets light, alerts work, a fresh device recovers instantly. Cost:
Ender sees every user's private balance and history (the same trust model as
stealth addresses). It does not enable offline spending on its own: proving
still needs the spending key.

### Offline: two ways

**1. The phone proves offline from cached data** (Nova unchanged). The gateway
sends notes and paths on every online sync; offline, the phone proves and texts
the result. Limits: the pool accepts proofs against the last 100 roots, so a
proof goes stale if 100 pool transactions happened since the last sync; and the
message doesn't fit one SMS:

| Part | Bytes | Why it must be sent |
| --- | --- | --- |
| Groth16 proof | 128 compressed (256 raw) | only the prover can make it |
| Two nullifiers | 64 | computed from the spending key |
| Command, recipient ID, amount, fee, root index | about 15 | small fields |
| **Total** | **about 207** | |

Output commitments, `extDataHash` and the root itself can be rebuilt by the
gateway (deterministic note randomness, root sent as a 1-byte index). 207 bytes
is about 276 base64 characters: **2 SMS segments** (153 characters each in a
multi-part SMS). The proof alone (128 bytes) exceeds the roughly 120 bytes a
plain-text SMS carries; a binary data SMS (140 bytes) needs `SEND_SMS`, which the
Play Store restricts to default SMS apps.

**2. Split keys** (the target design). Change the circuit so spending needs two
things, as in Zcash and Anoma:

- **Proving key** (nullifier key + viewing key), given to the gateway: it finds
  notes, computes nullifiers and builds proofs, but can't spend.
- **Spending-authority key**, kept on the phone: the circuit requires its
  signature (EdDSA on BabyJubJub, checked in-circuit) over the transaction's
  nullifiers, new note commitments and `extDataHash`.

Offline, the phone builds the transaction from cached notes and the recipient's
cached shielded address, with deterministic randomness the gateway reproduces,
and signs it: **one 64-byte signature, one SMS**, exactly like today's `SIG`,
over data the phone can check. The gateway rebuilds the identical transaction,
proves in about 1 s (Groth16, no GPU) and submits. Cost: roughly +10k
constraints per transaction, deterministic note construction both sides agree
on, and our own circuit changes in the audit scope. No prover on the phone.

**Spiked** ([splitkey-spike.md](splitkey-spike.md)): works end to end on anvil
with today's four messages (`SEND`, `Q`, `SIG`, `Sent`) plus a `Got` alert to
the recipient, every message one GSM-7 segment (worst case 145 characters).
18,738 constraints (+32%), about 965 ms proving on the gateway, about 2.1M gas
on Monad. All tampering attempts by the gateway fail.

| | Phone proves | Split keys |
| --- | --- | --- |
| Circuit | Nova unchanged | Nova + in-circuit signature |
| Offline SMS | 2 segments, can go stale | 1 segment, like today |
| Proving | phone (native module, 8 MB key) | gateway, about 1 s |
| Gateway can spend | no | no |
| Gateway sees | notes (viewing key) | notes (viewing key) |

### Build order

1. Gateway relay and indexer on Monad testnet, with Node-side proving in a
   script (2–3 days): the whole loop on a real chain.
2. Split-key circuit change: done in the spike; harden it (16-input variant,
   alert MACs, SMS payload encryption).
3. App: keys from the passkey, note sync via the viewing key, signing, Private
   and Public balances (3–4 days); offline signing over SMS.
4. Mainnet: multi-party ceremony, the spike's two fixes (range-check input
   amounts; bind nullifiers to chain and pool), circomspect and Picus, audit.

## Option B: zAUSD wormhole

Inspired by EIP-7503 (zero-knowledge wormholes, stagnant: minting native ETH
needs a consensus change). We can't mint AUSD, but we can mint our own wrapper.

1. Wrap: lock AUSD in the zAUSD contract, get zAUSD 1:1; unwrap burns zAUSD and
   returns AUSD. Inside Ender everyone holds zAUSD.
2. Burn by transfer: send zAUSD to an address derived from a secret, which has
   no private key. On-chain it looks like any payment to a fresh address.
3. Re-mint: prove "an unspendable address from my secret received X and hasn't
   been claimed"; the contract mints X to any address, or splits it into a
   payment and change to a new burn address.

Because we own the token, there's no consensus change and no proof against
chain state. **Buys:** deniability: depositing looks like an ordinary payment.
**Costs:** every zAUSD transfer must be added to a hash tree (the contract can't
tell burns from payments): Poseidon on-chain is about 1M gas per transfer
(about $0.0035), or keccak on-chain is cheap but makes the circuit about 100×
heavier. Users hold zAUSD, wrapped and unwrapped at Ender's edges. The contract
holds all AUSD (a circuit bug drains it; an AUSD freeze freezes everyone).
Circuit work is about the same as the pool.

## Option C: burn addresses for receiving

zAUSD applied to receiving by phone number, replacing stealth addresses:

1. Bob's app uploads a batch of one-time public keys (like Signal pre-keys).
2. Alice looks up Bob's number; the gateway turns one pre-key into a burn
   address `H(one-time key, nonce)`. Alice always gets the same address for Bob.
3. Alice pays it in zAUSD (wrapped inside her Calibur batch); works over SMS.
4. Bob claims: proves he knows the secret behind some burn address that received
   X; zAUSD is minted to his main wallet, or better, into a private note.

**Better than stealth addresses:** received money ends up in one place, no
per-address Calibur setup, and spending stays one signature. **Careful:** the
gateway computes burn addresses but must not be able to claim (one-time keys, so
server-side proving only learns a key that's already spent); claiming needs
internet; amount and timing correlation unless claimed into the pool; real AUSD
sent to a burn address is lost forever (never show it for copying); 160-bit
addresses have about 2^80 collision security.

## Option D: Anoma

Full report: [anoma-spike.md](anoma-spike.md). The Anoma Resource Machine on
RISC Zero, with an EVM protocol adapter and an ERC-20 forwarder **already on
Monad mainnet, audited, and usable by anyone**. It has exactly the split-key
property: the server proves with the nullifier key, but spending needs the
phone's authority signature, 64 bytes, which fits one SMS and is over data the
phone can rebuild.

Blockers: Heliax's backend rejects AUSD on Monad (USDC, USDT0, WETH, WMON only);
no testnet; the backend and indexer are closed source (self-hosting means a Rust
prover on a GPU or Bonsai, about 20 s per resource pair, plus relayer and
indexer: weeks); Permit2 deposits from Calibur-delegated accounts are untested;
Heliax sees nullifier keys and all activity; the anonymity set is tiny (about
$112 in the forwarder).

Cheapest next move: ask Heliax to list AUSD on Monad (the user's call).

## RAILGUN

| Part | License |
| --- | --- |
| [contract](https://github.com/Railgun-Privacy/contract) | `UNLICENSED` (every Solidity file and `package.json`) |
| [circuits-v2](https://github.com/Railgun-Privacy/circuits-v2) | "No License is provided for any party under any circumstances." |
| circuits-ppoi | no license |
| engine, wallet, shared-models, waku-broadcaster-client | MIT |

The code is public to read but not licensed to copy, modify or deploy. RAILGUN
can be used where its DAO has deployed it (Ethereum, Arbitrum, BNB, Polygon) via
the MIT client libraries, as wallet2 does. Not on Monad. Two routes to RAILGUN
on Monad: ask the RAILGUN DAO to deploy (wallet2's integration would then mostly
carry over; governance, no timeline), or build the equivalent on an open base:

| RAILGUN feature | Anoma | Our Nova pool |
| --- | --- | --- |
| Shielded pool, any ERC-20, any amount | yes | yes (one token per pool) |
| Private transfers | yes | yes |
| Shield and unshield | yes | yes |
| Private DeFi calls ("relay adapt") | yes (generic call forwarder) | no |
| Gas-free withdrawals via relayers | yes | yes (fee bound into the proof) |
| Viewing keys | yes | encryption keys (viewing key with split keys) |
| Compliance (private proofs of innocence) | no (screening at our relayer) | no |
| Audited circuits | yes | no |

## Privacy Pools (0xbow)

A Tornado-style pool plus a compliance filter, from a 2023 paper co-written by
Vitalik Buterin; live on Ethereum and other chains, open source
([privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core),
Apache-2.0), audited, with a 514-contributor ceremony.

- **Deposit:** a commitment `hash(value, label, hash(nullifier, secret))`; the
  label is a unique ID that follows the money through every withdrawal.
- **ASP (Association Set Provider):** reviews deposits and publishes the approved
  labels as a Merkle root on-chain (0xbow runs one; anyone can run their own).
- **Withdraw:** prove "I own a commitment in the tree, its label is in the
  approved set, here's its nullifier"; partial withdrawals create a new
  commitment with the same label. A relayer can submit.
- **Ragequit:** if the ASP never approves you, you withdraw publicly to your
  original address. Funds can't be frozen, only denied privacy.

**For Ender:** a credible compliance story, but v1 can't merge deposits or
transfer in-pool (each deposit stays its own note), and merging is the job we
need. v2 (private transfers) is announced; code and timing unconfirmed.

## Other research

- **Unlink** ([unlink-spike.md](unlink-spike.md)): hosted Engine offline on every
  network; spends need kilobytes of prepared data on the phone, so no SMS.
- **Zero-knowledge wormholes (EIP-7503):** burn to a keyless address, re-mint
  with a proof. Needs a consensus change for native ETH, or a token you can mint:
  hence zAUSD (Option B).
- **Proof systems:** Groth16 (Circom) wins for us: 256-byte proofs, about 1.1M
  gas to verify on Monad. Noir/UltraHonk needs no per-circuit setup but costs an
  estimated 4–5M gas with about 7 KB proofs, and its toolchain still churns.
- **Monad gas:** BN254 precompiles cost about 5× Ethereum (ecAdd 300, ecMul 30k,
  ecPairing 225k + 170k per pair); 30M gas per transaction; the gas limit is
  charged, not gas used.
- **Mobile proving:** [mopro](https://zkmopro.org/docs/sdk/react-native/) builds
  native Circom (rapidsnark) and Noir provers with React Native bindings;
  published numbers include Semaphore in 166 ms on a Galaxy S23 Ultra.
- **Proving ownership of the secp256k1 wallet key in-circuit** is about 1.5M
  constraints: derive separate shielded keys instead.

## Shared constraints

- **Trusted setup:** single-party for testnet only; mainnet needs a multi-party
  ceremony.
- **Audit before mainnet:** under-constrained circuits are the main risk (Hinkal
  lost about $800k to a double spend on 2026-07-02). Expect several weeks.
- **Legal:** OFAC delisted Tornado Cash in March 2025; Roman Storm was convicted
  in August 2025 of running an unlicensed money transmitter. The risk sits with
  running a relayer for unscreened funds. Before mainnet: viewing keys, deposit
  limits, screening (Privacy Pools' association sets are a model), legal review.
- **Offline:** only the split-key design (ours or Anoma's) keeps one-SMS
  payments. Otherwise private payments are online only and offline payments use
  the public wallet.

## Alternatives considered

| Protocol | Why not (for now) |
| --- | --- |
| Tornado Classic | fixed denominations |
| Hinkal | closed-source circuits; lost about $800k to a double spend (July 2026) |
| Panther | very complex, unclear license |
| Nocturne | shut down January 2024 |
| zkBob | Rust circuits, pools closing |
| Aztec | its own L2, can't run on Monad (its Noir libraries are a useful reference) |
| Noir/UltraHonk custom | 4× verification gas, large proofs, toolchain churn |
| [minimal-shielded-pool](https://github.com/kassandraoftroy/minimal-shielded-pool) | research only; it range-checks inputs and binds nullifiers to chain and pool, the two fixes Nova needs |

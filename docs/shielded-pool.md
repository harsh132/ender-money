# Ender Money — shielded pool (design options)

Stealth addresses ([stealth.md](stealth.md)) stop number lookups from
revealing wallets, but two leaks remain: stealth addresses spent together in
one transaction hint they belong together, and a payer and payee comparing
notes can link a pair address to its owner. A shielded pool closes both: funds
from many stealth addresses become one private balance, and payments out carry
no link back. Online only: a shielded spend needs fresh tree data and a proof,
which can't travel by SMS.

Two designs are worth building. Both are about the same amount of circuit
work and both need an audit before mainnet. Testnet first.

## Option A: Nova-style pool (Tornado Cash Nova)

Source: [tornadocash/tornado-nova](https://github.com/tornadocash/tornado-nova)
(ISC per `package.json`, no LICENSE file, archived 2022, audited by ZeroPool).

**Model.** Money is held as notes: `{amount, owner pubkey, blinding}`. The pool
stores only note hashes (commitments) in an on-chain Merkle tree. Every action
is one join-split: spend 2 notes, create 2 (a 16-in/2-out variant merges many),
with a public amount that is positive for a deposit, negative for a withdrawal
and zero for a private transfer. The proof shows: the inputs are in the tree
and owned by the spender; their nullifiers are fresh (no double spend);
inputs + public amount = outputs. New notes are encrypted to their owners and
published in the transaction's log; apps find theirs by trial decryption.

| Action | Inputs | Outputs | Public amount | Public on-chain |
| --- | --- | --- | --- | --- |
| Deposit 10 | empty, empty | 10, 0 | +10 | depositor and amount |
| Merge | 10, 15 | 25, 0 | 0 | that a pool transaction happened |
| Transfer | 25 | 20 to Alice, 5 change | 0 | nothing about who or how much |
| Withdraw | 5 | 0, 0 | −5 | amount and destination |

**Relayer.** `extData = {recipient, extAmount, relayer, fee, encryptedOutputs}`
is hashed into a public input, so the relayer and fee can't be changed. The
relayer (our gateway) submits the transaction and is paid in AUSD, so fresh
withdrawal addresses need no MON.

**For Ender.** Each funded stealth address deposits; a 16-in merge (or a few
2-in merges) folds them into one note; paying Dave is a withdrawal to Dave's
address (or a private transfer if Dave is in the pool).

**Adapting Nova to Monad.** The contract is wired to Tornado's Gnosis Chain
deployment (OmniBridge deposits via ERC-677 `onTokenBridged`, an L1 unwrapper,
cross-chain upgradeable governance, a multisig, Solidity 0.7). Strip all of it:
plain ERC-20 deposits (approve + `transferFrom`, or inside the user's Calibur
batch), keep the tree, nullifier set, verifiers and relayer fee. The circuits
are token- and chain-agnostic and need no logic changes; they're written for
Circom 0.5 with Tornado's forks of circomlib and snarkjs.

## Option B: zAUSD wormhole

Inspired by EIP-7503 (zero-knowledge wormholes, stagnant: minting native ETH
needs a consensus change). We can't mint AUSD, but we can mint our own wrapper.

**Model.**
1. Wrap: lock AUSD in the zAUSD contract, get zAUSD 1:1; unwrap burns zAUSD and
   returns AUSD. Inside Ender everyone holds zAUSD.
2. Burn by transfer: send zAUSD to an address derived from a secret
   (`address = H(secret)`), which has no private key. On-chain it looks like any
   other payment to a fresh address.
3. Re-mint: prove in zero knowledge "an unspendable address from my secret
   received X and hasn't been claimed" (a nullifier marks it); the contract
   mints X to any address, or splits it into a payment and change sent to a new
   burn address.

**What it buys.** Deniability: a pool deposit is visible as a deposit, a zAUSD
burn looks like an ordinary payment. Consolidating stealth addresses looks like
normal activity.

**What it costs.**
- To prove receipts, the zAUSD contract must add every transfer to a hash tree
  (it can't know which recipients are burn addresses). Poseidon on-chain costs
  about 20 hashes per transfer; keccak on-chain is cheap but makes the circuit
  about 100× heavier (around 3M constraints, server proving only). Either way
  the cost lands on every payment, not only private ones.
- Users hold zAUSD; AUSD arriving from outside must be wrapped and payments
  leaving Ender unwrapped (the app can do both inside the Calibur batch). The
  anonymity set is zAUSD holders, i.e. Ender users.
- The contract holds every user's AUSD: a circuit bug mints unbacked zAUSD and
  drains it, and an AUSD freeze on the contract freezes everyone.

## Comparison

| | Nova-style pool | zAUSD wormhole |
| --- | --- | --- |
| Deposits look like | pool deposits | ordinary transfers |
| Cost on ordinary payments | none | every transfer updates the tree |
| Users hold | AUSD | zAUSD |
| Existing code | Nova circuits and contracts | none; Nova circuits as a base |
| Circuit and audit work | baseline | about the same, plus a custom token |

**Recommendation.** Spike Option A now (testnet, no app integration). Keep B as
the stronger-privacy follow-up if the per-transfer cost is acceptable.

## Shared decisions and constraints

- **Proof system: Groth16 (Circom).** 256-byte proofs, about 1.15M gas to verify
  on Monad (BN254 pairing precompiles cost 5× Ethereum there:
  [opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)),
  about 0.115 MON at the minimum base fee. UltraHonk (Noir) needs no per-circuit
  setup but costs an estimated 4–5M gas with ~7 KB proofs.
- **Proving on the server first.** The prover sees the transaction's witness;
  that matches the trust model already accepted for stealth addresses (private
  from the public, not from Ender). Never send the spending key; send one
  transaction's witness. On-device proving later via
  [mopro](https://zkmopro.org/docs/sdk/react-native/) + rapidsnark (estimated
  under 1.5 s for a 2-in/2-out circuit on mid-range Android).
- **Keys.** A separate shielded key derived from the passkey's PRF output.
  Proving ownership of the secp256k1 wallet key in-circuit is about 1.5M
  constraints, far too slow.
- **Trusted setup.** Single-party, labelled "testnet only". Mainnet needs a
  multi-party ceremony.
- **Audit before mainnet.** Under-constrained circuits are the main risk
  (Hinkal lost about $800k to a double spend on 2026-07-02). Expect a circuit
  and contract audit of several weeks.
- **Legal.** OFAC delisted Tornado Cash in March 2025; Roman Storm was convicted
  in August 2025 of running an unlicensed money transmitter. Running a relayer
  for unscreened funds carries the risk. Before mainnet: viewing keys, deposit
  limits, screening (Privacy Pools' association sets are a model), legal review.

## Alternatives considered

| Protocol | Why not (for now) |
| --- | --- |
| Unlink | hosted Engine offline; spends need the full prepared tx on the phone ([unlink-spike.md](unlink-spike.md)) |
| Privacy Pools (0xbow) | audited, maintained, compliance story; but v1 can't merge deposits or transfer in-pool ([privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core)) |
| RAILGUN | unlicensed contracts, heavy infrastructure, not on Monad |
| Tornado Classic | fixed denominations |
| Hinkal, Panther, Nocturne, zkBob | closed source, too complex, shut down, or obscure stack |
| Noir/UltraHonk custom | 4× verification gas, large proofs, toolchain churn |
| Minimal reference: [minimal-shielded-pool](https://github.com/kassandraoftroy/minimal-shielded-pool) | Circom 2, 2-in/2-out, Apache-2.0, research only; a useful cross-check for the Circom 2 port |

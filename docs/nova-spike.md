# Tornado Nova spike (3 Oct 2026)

Question: can Tornado Cash Nova be stripped down to a minimal AUSD shielded pool
and run end to end? Two parallel spikes, one per Circom toolchain, both on a
local anvil chain. Code and reproduction steps:
[spikes/nova-circom05](../spikes/nova-circom05/README.md) and
[spikes/nova-circom2](../spikes/nova-circom2/README.md).

## Result: both work; build on the Circom 2 port

Both pass the same scenario and every negative check.

**Scenario.**
1. Stealth addresses S1 and S2 deposit 10 and 15 AUSD into notes for Bob; Bob
   finds them by trial decryption.
2. Bob merges them into one 25 note (2-in/2-out).
3. Bob transfers 20 privately to Alice, keeping 5.
4. Alice withdraws 12 of her balance through a relayer: 11.9 to a fresh address
   with no MON, 0.1 fee to the relayer, 8 kept as change.
5. A 16-in/2-out merge folds several notes into one.

**Negative checks (all rejected):** deposit over the cap; spending a note twice;
changing the recipient or fee after proving; overdrawing (fails to prove); a fake
note proved against a forged tree ("Invalid merkle root").

## What was stripped from Nova

Nova's `TornadoPool` was built for Tornado's Gnosis Chain deployment. Removed:
OmniBridge/ERC-677 deposits (`onTokenBridged`), the L1 unwrapper and L1 fee,
cross-chain governance and the upgradeable proxy, the multisig and
`rescueTokens`, and the public-key registry. Kept: the Merkle tree with root
history, the nullifier set, `transact(proof, extData)` with the `extDataHash`
binding and `publicAmount = extAmount - fee`, the relayer fee paid in the token,
both verifiers, and a deposit cap (constructor parameter). Deposits are a plain
ERC-20 `transferFrom`. Contracts ported to Solidity 0.8 and tested with Foundry.

## Numbers

Desktop: Ryzen 5 5500GT, 6 cores (both spikes ran at once, so times are pessimistic).
Tree height 23 (Nova's production value).

| | Circom 0.5 (original) | Circom 2 (port) |
| --- | --- | --- |
| Toolchain | circom 0.5.45, Tornado's circomlib and snarkjs forks | circom 2.2.3, circomlib 2.0.5, snarkjs 0.7.6 |
| Constraints, 2-in / 16-in | 10,132 / 75,148 | 14,150 / 106,179 |
| Proving key, 2-in / 16-in | 5.3 MB / 39.5 MB | 8.2 MB / 61.6 MB |
| Proving time (Node), 2-in / 16-in | 0.8–1.0 s / about 6 s | 0.73 s / 4.1 s |
| Gas per transaction on anvil | about 0.95–1.02M; 16-in 1.40M | about 1.17–1.24M; 16-in 1.62M |
| Monad estimate | about 1.9M; 16-in about 2.6M | about 2.1M; 16-in about 2.9M |
| Verifier alone, 2-in | 272k (Monad about 1.17M) | 229k (Monad about 1.12M) |

- Monad prices the BN254 precompiles about 5× Ethereum (ecMul 30k, ecPairing
  225k + 170k per pair), which the Monad estimates add. At the 100 gwei minimum
  base fee, 2M gas is about 0.2 MON, under a cent. Monad charges the gas limit,
  so limits must be tight.
- **Where the gas goes:** the proof check is about 240k; inserting the two new
  notes is about 450k (23 on-chain Poseidon hashes each). A shallower tree or a
  cheaper Poseidon contract is the main saving.
- **Trusted setup:** powers of tau generated locally at power 17 (fits the
  16-in circuit), single contributor, testnet only. Phase-2 preparation took
  about 23 minutes; downloading a public ptau file would skip it.

## Why the port has more constraints

Nova's circomlib fork uses Poseidon with 35 partial rounds; current circomlib
uses the paper's recommended 56/57/56 (t = 2/3/4). That accounts for the extra
constraints and about 200k gas per transaction (29.6k vs 19.7k per on-chain
hash). Hashes differ, so the port is not compatible with Nova's deployment; the
zeros table and the on-chain hasher were regenerated.

**Equivalence check.** With the fork's Poseidon swapped into the port, the
number of signals matches the original exactly (43,315 / 330,567); constraints
come to 10,130 / 75,027. The gap is 1 + the number of nullifier pairs, all
redundant rows the old compiler kept (`IsEqual().out === 0` leftovers) and a
linear sum folded by `--O2`. `--inspect` is clean, the port adds no `<--`
assignments, and a witness test rejects nine cheating cases (sum inflation,
duplicate nullifier, output wraparound, wrong key, wrong root, inflated input).
Circuits must be compiled with `--O2`: circom 2.2.3's default `--O1` gives
30,148 / 229,438 constraints.

## Problems and findings

- **The old toolchain is deprecated:** about 730 packages, and its snarkjs
  command line breaks on Windows (the spike calls its JS API instead).
- **Verifier gas trap:** the snarkjs verifiers return `false` instead of reverting
  when their precompile calls run out of gas, so `estimateGas` on a bare
  `verifyProof` reads absurdly low (11.6k instead of about 229k). The pool is safe
  because it requires `true`, but never budget verifier gas from an estimate.
- **Fix before an audit (Nova's original behaviour, kept in the spike):**
  1. input amounts are not range-checked;
  2. nullifiers are not bound to the chain and pool, so a proof could replay
     against another deployment.
- **Not run:** circomspect and Picus (both need Rust). Run them before an audit.
- **Proving needs the spending key.** The circuit checks `pubkey = hash(privkey)`
  and derives the nullifier from it, so whoever proves can spend. See
  [shielded-pool.md](shielded-pool.md#who-builds-the-proof) for what that means
  for Ender.

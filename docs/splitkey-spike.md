# Split-key Nova spike (3 Oct 2026)

Question: can a private (shielded) payment be made offline over SMS with
Ender's existing four messages (`SEND`, `Q`, `SIG`, `Sent`), each one GSM-7
segment? Design: [shielded-pool.md](shielded-pool.md#offline-two-ways) ("Split
keys"). Code and reproduction steps:
[spikes/nova-splitkey](../spikes/nova-splitkey/README.md), built on the Circom 2
port from [nova-spike.md](nova-spike.md).

## Result: yes

The whole scenario and every negative check pass on a local anvil chain, with
2-, 6- and 12-input circuits. Every message is one segment. The phone needs no
tree, no proving key and no prover. It picks the input notes itself and names
them in its `SIG`. The gateway proves in 1 to 4 s and can't spend, redirect or
reprice a payment, or swap the notes the phone chose.

## Circuit changes

- **Owner key** = Poseidon(Ax, Ay, Poseidon(nk)): the spending-authority public
  key (EdDSA on BabyJubJub) plus a commitment to the nullifier key.
- **Nullifier** = Poseidon(nk, commitment, pathIndex). The gateway holds `nk`, so
  it computes nullifiers and builds proofs.
- **One EdDSA-Poseidon signature**, checked in-circuit, over Poseidon(nf[0..n),
  oc0, oc1, extDataHash, publicAmount). Only the phone holds the authority key.
  All inputs (dummies included) share one owner.
- **2, 6 or 12 inputs**, 2 outputs. The message hash takes n + 4 values and
  circomlib's Poseidon takes at most 16, so 12 is the maximum.
- **Public inputs unchanged**, so the pool contract barely changes: regenerated
  verifiers, picked by the number of nullifiers (2, 6 or 12; any other count is
  rejected).
- **Fixes from the Nova spike:**
  - input amounts are range-checked (+248 constraints per input; a witness
    test with an in-tree note of amount p−5 fails only on this check);
  - chain and pool binding via `extDataHash`: the pool hashes `block.chainid` and
    `address(this)` into it, so proofs and signatures are bound to one
    deployment (no extra constraints). The nullifier itself carries no domain;
    that would need a new public input.
- **Also added:** on-curve checks for the authority key and R8 (circomlib's
  verifier skips them), and a `deadline` in `ExtData` (the quote's expiry,
  enforced on-chain).
- **Determinism:** phone and gateway build the identical transaction: inputs
  sorted by tree position, blindings derived from `nk` and the nullifiers, and
  note encryption with ephemeral key and nonce derived from `nk` and the
  commitment (needed because the ciphertexts are inside the signed
  `extDataHash`).

| | Circom 2 port (2-in) | 2-in | 6-in | 12-in |
| --- | --- | --- | --- | --- |
| Constraints | 14,150 | 18,738 (+32%; signature check 4,567) | 44,213 | 82,448 |
| Proving key | 8.2 MB | 12.0 MB | 27.0 MB | 50.6 MB |
| Proving time (Node, desktop, median) | 672 ms | about 1.0 s | about 2.0 s | about 3.8 s |
| Gas per payment (anvil) | about 1.17M | 1.19–1.22M | 1.32M | 1.50–1.51M |
| Monad estimate | about 2.1M | about 2.1M | about 2.3M | about 2.6M |
| Proof check alone (Monad) | about 1.12M | about 1.12M | about 1.25M | about 1.43M |

Each extra input costs about 6,370 constraints. All three fit the power-17 ptau.
Monad prices the BN254 precompiles about 5× Ethereum, which the estimates add;
the extra grows with the public inputs (+893k for 2-in, +1.13M for 12-in).

`--inspect` shows only unused-bit warnings; the circuits add no `<--`.
circomspect and Picus not run (need Rust).

## Choosing input notes (on the phone)

The phone picks the notes. The rule is the phone's policy; the gateway doesn't
check it.
The code is in `src/select.mjs`, which both sides import.

- **Eligible notes:** unspent, at least **0.001 AUSD**, and not pending (an
  input of a payment whose `Sent` hasn't arrived, or that payment's change).
  Notes under 0.001 AUSD are ignored by both sides: never counted, never
  selected, and the gateway refuses refs to them.
- T = amount + fee (the fee is a flat 0.01 AUSD, quoted first); n = number of
  eligible notes.
- **No dust change:** change under 0.001 AUSD isn't created; it goes to the
  gateway on top of the fee (at most 0.000999 extra).

| Case | Result |
| --- | --- |
| eligible notes add up to less than T | `ERR FUNDS` |
| n ≥ 12 | 12-in if the 12 largest cover T, else `ERR MERGE` |
| 6 ≤ n ≤ 11 | 6-in if the 6 largest cover T, else all n notes in the 12-in |
| n < 6 | 2-in if the 2 largest cover T, else all n notes in the 6-in |

- **Filling:** the largest notes until T is covered, then random eligible notes
  until the circuit is full. Empty slots are dummies. Inputs stay sorted by tree
  position.
- **Merge:** after `ERR MERGE` the user sends `MERGE`, a payment of 0 to self
  (T is the fee alone). It follows the same rule, so 12 notes become one.

## SMS messages

| Message | Example | Worst-case length |
| --- | --- | --- |
| `SEND` (unchanged) | `SEND +919800000002, 20 AUSD` | 67 |
| `MERGE` (spike only) | `MERGE` | 5 |
| `Q` | `Q <id> exp=<unix> fee=0.01 to=<86-char shielded address or 0x address>` (no inputs: the phone picks them) | 126 (138 with the SMS Retriever hash) |
| `SIG` | `SIG <id> <refs> <86-char signature>` | 132 (12 refs) |
| `Sent` | `Sent 20 AUSD to +91.... Tx 0xd340...50 p=2` (change note at p+1) | 95 |
| `Got` (to the recipient) | `Got 20 AUSD from +91... p=2 b=<43-char blinding>` | 100 |

All pass printable-ASCII and `fitsOneSegment` from `protocol/sms.ts`.

**SIG refs.** One ref per real input: 3 base64 characters (`A-Z a-z 0-9 + /`)
for the note's tree position mod 2^18 (262,144), concatenated. Today's 65-byte `SIG` is one 88-char
field after the id; the shielded `SIG` has two (refs, then the 86-char
signature), so the shape tells them apart. The gateway:

1. accepts 1–12 refs and uses the smallest circuit (2, 6 or 12) that holds
   them;
2. maps each ref to eligible notes; a duplicate or unmatched ref (unknown,
   spent, under 0.001 AUSD) is `ERR REF`;
3. on a collision (positions 262,144 apart, so only past 262,144 leaves), tries
   each candidate and keeps the one whose rebuilt transaction the signature
   verifies; no match is `ERR BADSIG`;
4. picks the circuit, rebuilds, proves.

**What the phone checks before signing:** the quote hasn't expired; the fee is
under its limit; its eligible notes can pay (else it shows `FUNDS` or `MERGE`);
the withdrawal address is the one requested; a merge pays itself; a pinned
recipient's key hasn't changed. Then it picks the notes, builds the
transaction itself and signs it.

## Scenario

1. Alice shields 50 AUSD (online deposit).
2. By SMS, Alice pays Bob 20 privately; Bob learns the note from the `Got` alert.
3. By SMS, Bob pays Carol 5 from that note.
4. By SMS, Alice withdraws 10 to a fresh address with no MON.
5. Dave gets many 1 AUSD notes (plus one of 0.0005, which is ignored) and pays
   Carol by SMS through every branch: 2-in (n = 4); 6-in with all 3 notes
   (n = 3, two largest short; the 0.0005 change goes to the fee); `ERR FUNDS` (nothing eligible); 6-in (n = 8);
   12-in with all 9 notes (n = 9, six largest short); 12-in (n = 24); `ERR MERGE`
   (n = 13, twelve largest short); `MERGE` (12-in); then 2-in (n = 2).

Final state: pool 80.9, fresh address 10 (zero native balance), gateway fees
0.1005. Each phone's note cache matches the gateway's index, phone and gateway
counted the same eligible notes before every payment, spent flags match
on-chain nullifiers, and the gateway's root matches the pool's.

## Negative checks (all rejected)

| Attack | Result |
| --- | --- |
| Gateway changes recipient, amount or fee after `SIG` | no proof; honest proof with tampered `extData` → `Incorrect external data hash` / `Invalid transaction proof` |
| Gateway spends with only `nk` + viewing key (zero signature, random bytes, another transaction's signature, its own key) | no proof |
| Another user's key signs | no proof; gateway pre-check answers `ERR BADSIG` |
| Gateway swaps one of the notes the phone named for another of its notes | signature fails, no proof; `ERR BADSIG` |
| `SIG` naming an unknown note, a note under 0.001 AUSD, or the same note twice | `ERR REF` |
| `SIG` with one ref dropped or one extra ref added | `ERR BADSIG` |
| Quote the phone's notes can't pay (or that needs a merge), expired, fee over limit, swapped withdrawal address | phone refuses |
| Replaying a spent note | `Input is already spent` |
| Different key for a pinned recipient | refused, `KEY CHANGED` |

Selection unit test: 33 checks, every branch (plus the dust-change rule) at n = 1, 2, 5, 6, 11, 12 and 13.
Witness tests: the same 4 valid cases and 19 bad ones for each circuit (15
accepted, 57 rejected in all; Nova's original checks plus the split-key logic).

## What each side holds

- **Phone:** authority key, `nk`, viewing key; config (chain ID, pool address,
  gateway relayer address, maximum fee); about 70 bytes per cached note; pinned
  contacts.
- **Gateway:** sees all its users' notes, balances, counterparties and timing,
  and when notes are spent. Can censor or delay until the deadline. Cannot spend,
  redirect or reprice.

## Monad testnet deployment (4 Oct 2026)

Deployed from the gateway key with `scripts/deploy-testnet.mjs`; addresses in
[`deployments/monad-testnet.json`](../spikes/nova-splitkey/deployments/monad-testnet.json).

| Contract | Address | Gas |
| --- | --- | --- |
| ShieldedPool (testnet AUSD, cap 1,000) | `0x1bedcebdf1d026f7f807ec5c69f06bccf2f8621c` | 2,946,983 |
| Poseidon hasher | `0xb414989d9358298f530c5a0325ed0853511e816d` | 2,174,462 |
| Verifier2 / 6 / 12 | `0xa6cf…5450` / `0xd6a5…5941` / `0x55bc…fda2` | 470,593 / 553,028 / 677,067 |

Deploying cost about 0.7 MON. `scripts/smoke-testnet.mjs` then ran the same
phone and gateway code against it: a 0.3 AUSD deposit, an SMS payment of 0.1
and an SMS withdrawal of 0.05, about 2.32–2.37M gas each (close to the Monad
estimate). Caches, the gateway index and the on-chain root all matched.

- **Testnet only.** The trusted setup is single-contributor.
- **Keep the zkeys.** The deployed verifiers only accept proofs from the local
  `build/transaction{2,6,12}.zkey` (gitignored). Losing them strands every
  note in this pool.
- The gateway reads logs from the deploy block in 100-block chunks (public RPC
  limits); it rescans everything on each sync, so an indexer is next.

## Problems and open items

1. **First payment to a new contact trusts the gateway's directory.** The phone
   signs to whatever key the first `Q` carries; pinning protects only later
   payments. Fix: offline payments only to contacts pinned online, or verify the
   key online first.
2. **`Got` and `Sent` are unauthenticated.** A fake `Got` shows a note that
   doesn't exist (spending it fails); a lost `Sent` leaves the change note's
   position unknown, so it can't be spent offline until the next sync. Fix: a
   short MAC per alert (fits the SMS).
3. **No count check.** The gateway no longer reruns the rule on a `SIG`: that
   broke payments whenever the phone's view lagged (a lost `Sent`) and added no
   safety, since the signature covers exactly which notes are spent. It still
   runs the rule at `SEND` time to answer `ERR FUNDS` / `ERR MERGE`.
4. **Many notes mean big transactions.** With 6 or more eligible notes, every
   payment spends 6 or 12 of them: a 12-in costs about 1.5M gas (2.6M on Monad)
   and about 4 s of proving. Wallets do consolidate on their own.
5. **Notes under 0.001 AUSD stay in the pool.** Nothing spends them, not even a
   merge.
6. **The gateway can't check the random fill.** The phone's own
   randomness is all that keeps the choice from leaking anything.
7. **circomlibjs bug:** `unpackSignature` mutates its input buffer, so unpacking
   the same signature twice gave a wrong R8 about half the time. Always unpack a
   copy.
8. **Blinding overflow:** full-field blindings overflowed Nova's 31-byte slot in
   the encrypted note and silently broke decryption; the plaintext is now 63
   bytes.
9. **Before mainnet:** multi-party ceremony (three circuits now), circomspect
   and Picus, alert MACs, SMS payload encryption (carriers can see note details
   in `Got`), and a circuit and contract audit.

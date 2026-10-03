# Split-key Nova spike (3 Oct 2026)

Question: can a private (shielded) payment be made offline over SMS with
Ender's existing four messages (`SEND`, `Q`, `SIG`, `Sent`), each one GSM-7
segment? Design: [shielded-pool.md](shielded-pool.md#offline-two-ways) ("Split
keys"). Code and reproduction steps:
[spikes/nova-splitkey](../spikes/nova-splitkey/README.md), built on the Circom 2
port from [nova-spike.md](nova-spike.md).

## Result: yes

The whole scenario and every negative check pass on a local anvil chain. Every
message is one segment. The phone needs no tree, no proving key and no prover;
the gateway proves in about 1 s and can't spend, redirect or reprice a payment.

## Circuit changes (transaction2 only)

- **Owner key** = Poseidon(Ax, Ay, Poseidon(nk)): the spending-authority public
  key (EdDSA on BabyJubJub) plus a commitment to the nullifier key.
- **Nullifier** = Poseidon(nk, commitment, pathIndex). The gateway holds `nk`, so
  it computes nullifiers and builds proofs.
- **One EdDSA-Poseidon signature**, checked in-circuit, over Poseidon(nf0, nf1,
  oc0, oc1, extDataHash, publicAmount). Only the phone holds the authority key.
  All inputs (dummies included) share one owner.
- **Public inputs unchanged**, so the pool contract barely changes (regenerated
  verifier).
- **Fixes from the Nova spike:**
  - input amounts are range-checked (+496 constraints; a witness test with an
    in-tree note of amount p−5 fails only on this check);
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

| | Circom 2 port | Split keys |
| --- | --- | --- |
| Constraints | 14,150 | 18,738 (+32%; signature check 4,567) |
| Proving key | 8.2 MB | 12.0 MB |
| Proving time (Node, desktop) | 672 ms | about 965 ms |
| Gas per transaction (anvil) | about 1.17M | 1.19–1.23M |
| Monad estimate | about 2.1M | about 2.1M (proof check about 1.12M) |

`--inspect` shows only unused-bit warnings; the circuits add no `<--`.
circomspect and Picus not run (need Rust).

## SMS messages

| Message | Example | Worst-case length |
| --- | --- | --- |
| `SEND` (unchanged) | `SEND +919800000002, 20 AUSD` | 67 |
| `Q` | `Q <id> exp=<unix> fee=0.05 in=3,5 to=<86-char shielded address or 0x address>` | 145 (157 with the SMS Retriever hash) |
| `SIG` | `SIG <id> <86-char signature>` (64 bytes; today's 65-byte `SIG` is 88 chars, so length distinguishes them) | 95 |
| `Sent` | `Sent 20 AUSD to +91.... Tx 0xd340...50 p=2` (change note at p+1) | 95 |
| `Got` (to the recipient) | `Got 20 AUSD from +91... p=2 b=<43-char blinding>` | 100 |

All pass printable-ASCII and `fitsOneSegment` from `protocol/sms.ts`.

**What the phone checks before signing:** the quoted notes are in its cache, not
repeated, and cover amount + fee; the quote hasn't expired; the fee is under its
limit; the withdrawal address is the one requested; a pinned recipient's key
hasn't changed. Then it builds the transaction itself and signs it.

## Scenario

1. Alice shields 50 AUSD (online deposit).
2. By SMS, Alice pays Bob 20 privately; Bob learns the note from the `Got` alert.
3. By SMS, Bob pays Carol 5 from that note.
4. By SMS, Alice withdraws 10 to a fresh address with no MON.

Final state: pool 39.85, fresh address 10 (zero native balance), gateway fees
0.15. Each phone's note cache matches the gateway's index, spent flags match
on-chain nullifiers, and the gateway's root matches the pool's.

## Negative checks (all rejected)

| Attack | Result |
| --- | --- |
| Gateway changes recipient, amount or fee after `SIG` | no proof; honest proof with tampered `extData` → `Incorrect external data hash` / `Invalid transaction proof` |
| Gateway spends with only `nk` + viewing key (zero signature, random bytes, another transaction's signature, its own key) | no proof |
| Another user's key signs | no proof; gateway pre-check answers `ERR BADSIG` |
| Quote with unknown notes, a repeated note, too little money, expired, fee over limit, swapped withdrawal address | phone refuses |
| Replaying a spent note | `Input is already spent` |
| Different key for a pinned recipient | refused, `KEY CHANGED` |

Witness tests: 4 valid cases accepted, 19 bad ones rejected (Nova's original
checks plus the split-key logic).

## What each side holds

- **Phone:** authority key, `nk`, viewing key; config (chain ID, pool address,
  gateway relayer address, maximum fee); about 70 bytes per cached note; pinned
  contacts.
- **Gateway:** sees all its users' notes, balances, counterparties and timing,
  and when notes are spent. Can censor or delay until the deadline. Cannot spend,
  redirect or reprice.

## Problems and open items

1. **First payment to a new contact trusts the gateway's directory.** The phone
   signs to whatever key the first `Q` carries; pinning protects only later
   payments. Fix: offline payments only to contacts pinned online, or verify the
   key online first.
2. **`Got` and `Sent` are unauthenticated.** A fake `Got` shows a note that
   doesn't exist (spending it fails); a lost `Sent` leaves the change note's
   position unknown, so it can't be spent offline until the next sync. Fix: a
   short MAC per alert (fits the SMS).
3. **Only 2 inputs.** If two notes can't cover a payment the gateway answers
   `ERR FUNDS`; merging happens online. A 16-input version needs a two-level
   message hash.
4. **circomlibjs bug:** `unpackSignature` mutates its input buffer, so unpacking
   the same signature twice gave a wrong R8 about half the time. Always unpack a
   copy.
5. **Blinding overflow:** full-field blindings overflowed Nova's 31-byte slot in
   the encrypted note and silently broke decryption; the plaintext is now 63
   bytes.
6. **Before mainnet:** multi-party ceremony, circomspect and Picus, the 16-input
   variant, alert MACs, SMS payload encryption (carriers can see note details in
   `Got`), and a circuit and contract audit.

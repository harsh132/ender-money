# Spike: split-key Nova, private payments over SMS

This spike tests the "Split keys" design in [docs/shielded-pool.md](../../docs/shielded-pool.md#offline-two-ways).
It asks whether a shielded payment can be made offline using today's 4-SMS pattern (`SEND`, `Q`, `SIG`, `Sent`),
where every message is one GSM-7 segment. The gateway proves but cannot spend. The base is the Circom 2 port in
[../nova-circom2](../nova-circom2/README.md). **Testnet only:** the trusted setup has a single party, and nothing
here is audited.

**Status: it works, with 2-, 6- and 12-input circuits.** All three compile and `--inspect` is clean. The phone picks
the input notes with a fixed rule and names them in its `SIG`. The selection unit test passes (33 checks). The witness
tests pass (15 valid cases, 57 rejected). The anvil simulation passes every scenario step and every negative check.
Every SMS was at most 132 characters, and the worst case per format is 132.

## Design

| | Nova (Circom 2 port) | Split keys (this spike) |
| --- | --- | --- |
| Keys | one `privkey` | phone: EdDSA BabyJubJub authority key `(Ax, Ay)`. Gateway: nullifier key `nk` (field element) + x25519 viewing key |
| Owner key | `Poseidon(privkey)` | `Poseidon(Ax, Ay, Poseidon(nk))` |
| Commitment | `Poseidon(amount, pubkey, blinding)` | unchanged |
| Nullifier | `Poseidon(C, pos, Poseidon(privkey, C, pos))` | `Poseidon(nk, C, pos)` |
| Authorization | knowing `privkey` | one EdDSA-Poseidon signature over `Poseidon(nf[0..n), oc0, oc1, extDataHash, publicAmount)` |
| Inputs | 2 or 16, each with its own key | 2, 6 or 12; all inputs (dummies too) share one `(Ax, Ay, nk)` |
| Public inputs | root, publicAmount, extDataHash, nullifier[n], commitment[2] | **unchanged** (the verifiers are regenerated) |

- **Deterministic construction.** The phone and the gateway call the same `buildTx` (`src/shielded.mjs`) and get
  identical bytes:
  - Inputs are sorted by tree position.
  - A dummy input's blinding is `Poseidon(nk, nf_firstReal, i)`. It is random only for deposits, which are built
    online.
  - Output blinding is `blinding_i = Poseidon(nk, nf0, nf1, i)`.
  - Outputs are `[payment, change]`. A withdrawal uses `[0 to self, change]`.
- **Deterministic note encryption.** The format is Nova's x25519-xsalsa20-poly1305 box. The ephemeral key and the
  nonce are `keccak(tag, nk, commitment)`. The ciphertexts sit inside `extDataHash`, which the phone signs, so the
  phone must reproduce the gateway's ciphertexts exactly. A key repeats only when the commitment, and so the
  plaintext, is identical. The plaintext is 63 bytes (amount 31 + blinding 32, because a Poseidon blinding is a
  full field element), so a ciphertext is 135 bytes.
- **Pool changes (`contracts/ShieldedPool.sol`):**
  - `ExtData` gains `deadline`, which is the quote's `exp`, enforced with `require(block.timestamp <= deadline)`.
  - `extDataHash = keccak256(abi.encode(block.chainid, address(this), extData)) % p`.
  - Verifier2, Verifier6 and Verifier12. The pool picks one by the number of nullifiers and rejects any other count.

  Nothing else changed.
- **The two fixes from docs/nova-spike.md:**
  1. **Input amounts are range-checked:** `Num2Bits(248)` per input, 248 constraints each. A witness test has a note of
     amount `p-5` sitting in the tree. It passes every other constraint and fails only this one.
  2. **Chain and pool binding goes through `extDataHash`, not the nullifier.** The pool hashes its own chain ID and
     address into `extDataHash`, so both the proof and the phone's signature are bound to one deployment. This adds
     no constraints and no public input. The nullifier value itself carries no domain. That would need a new public
     input, or a circuit and key per deployment. The only effect is that a note duplicated byte-for-byte in two
     pools would show the same nullifier in both.
- **Also added:** `BabyCheck` (on-curve check) for `A` and `R8`, because circomlib's verifier skips it. Cost: about 6
  constraints.
- **Why 12 is the maximum.** The signed message is one Poseidon over `n + 4` values. circomlib's Poseidon takes at
  most 16, so `n ≤ 12` with 2 outputs.

### Note selection (`src/select.mjs`, run by the phone)

The phone picks the input notes. The rule is the phone's policy; the gateway doesn't check it.

- **Eligible notes:** unspent, at least **0.001 AUSD** (1000 base units), and not pending. Pending means an input of a
  payment whose `Sent` hasn't arrived; that payment's change isn't in the cache yet anyway. Notes under 0.001 AUSD
  are ignored by both sides. They are never counted (not even in the balance), never selected, and the gateway
  refuses refs to them.
- `T = amount + fee`. The fee is a flat **0.01 AUSD**, quoted before selection. `n` is the number of eligible notes.
- **No dust change.** If the change would be under 0.001 AUSD it isn't created: it goes to the gateway on top of the
  fee (so at most 0.000999 extra). Both sides compute this the same way (`settle` in `src/select.mjs`).
- **The rule:**

  | Case | Circuit |
  | --- | --- |
  | sum of eligible < T | `ERR FUNDS` |
  | n ≥ 12 | 12-in if the 12 largest cover T, else `ERR MERGE` |
  | 6 ≤ n ≤ 11 | 6-in if the 6 largest cover T, else all n notes in the 12-in |
  | n < 6 | 2-in if the 2 largest cover T, else all n notes in the 6-in |

- **Filling the circuit:** take the largest notes until T is covered. Fill the remaining slots with randomly chosen
  eligible notes (crypto randomness; tests can inject an RNG). Slots left over when there are fewer notes are
  dummies. Inside the transaction, inputs stay sorted by tree position.
- **Merge:** `MERGE` (a spike-only command) is a payment of 0 to self, so T is the fee alone. It follows the same
  rule. With n ≥ 12 it spends 12 notes and leaves one.
- The circuit choice depends only on the notes and T, not on the random fill. So the gateway can recompute it, but
  it can't check which notes filled the slots.

## Layout

| Path | What |
| --- | --- |
| `circuits/transaction.circom` | split-key `Transaction(levels, nIns, nOuts)` (`merkleProof.circom` copied unchanged) |
| `circuits/transaction{2,6,12}.circom` | mains: height 23, 2/6/12 inputs, 2 outputs, the port's public inputs |
| `circuits/eddsaProbe.circom` | the authorization block on its own (message hash + curve checks + EdDSA), to measure its cost |
| `contracts/` | `ShieldedPool.sol` (changes above), `MerkleTreeWithHistory.sol` and `MockAUSD.sol` copied unchanged; `generated/Verifier{2,6,12}.sol` (gitignored) |
| `src/shielded.mjs` | keys, notes, deterministic `buildTx`, note encryption, EdDSA sign/verify, witness, prover |
| `src/select.mjs` | the note-selection rule, imported by both the phone and the gateway |
| `src/phone.mjs` | **PHONE**: authority key, nk, viewing key, note cache, pinned contacts; checks quotes, picks inputs, signs |
| `src/gateway.mjs` | **GATEWAY**: users' nk + viewing keys + authority *public* keys; indexes notes, resolves the phone's refs, proves, relays, earns the fee |
| `src/sms.mjs` | message formats and the `checkSms` validator (`SEND`/`ERR` and `fitsOneSegment` imported from `protocol/sms.ts`) |
| `scripts/setup.sh` | compile, Groth16 setup + one contribution, verifier export (reuses `../nova-circom2/build/pot17_final.ptau`) |
| `scripts/select-test.mjs` | unit test of the selection rule |
| `scripts/circuit-test.mjs` | witness-level tests, all three circuits |
| `scripts/sms-sim.mjs` | anvil simulation: scenario, negative checks, gas, proving benchmark → `build/sms-sim-results.json` |

## Reproduce

In Git Bash from `spikes/nova-splitkey/`, with Node 22 (it imports `../../protocol/sms.ts` through Node's built-in
type stripping) and Foundry in `~/.foundry/bin`:

```bash
mkdir -p bin && cp ../nova-circom2/bin/circom.exe bin/   # circom 2.2.3 (see ../nova-circom2 for the download)
npm ci
export PATH=$PATH:~/.foundry/bin
npm run setup           # ~5 min for the three circuits; needs ../nova-circom2/build/pot17_final.ptau (or PTAU=<path>)
npm run test:select     # selection rule
npm run test:circuits   # witness tests (circom prints each expected assert failure to stderr)
npm run sim             # forge build + anvil simulation on port 18548
```

## Results

The machine is a Ryzen 5 5500GT with 6 cores, running Windows 11. Proving uses snarkjs 0.7.6 in Node (WASM witness,
JS prover).

### Circuits (height 23, 2 outputs, `--O2`)

| | Circom 2 port (2-in) | Split keys 2-in | Split keys 6-in | Split keys 12-in |
| --- | --- | --- | --- | --- |
| Constraints | 14,150 | **18,738** (+32% on the port) | **44,213** | **82,448** |
| Public / private inputs | 7 / 60 | 7 / 64 | 11 / 168 | 17 / 324 |
| wasm / zkey | 2.52 MB / 8.2 MB | 4.25 MB / **12.0 MB** | 5.01 MB / **27.0 MB** | 6.17 MB / **50.6 MB** |
| fullProve, n=10, median (range) | 672 ms (654–703) | **1,044 ms** (1,020–1,245) | **2,026 ms** (1,874–2,785) | **3,811 ms** (3,593–5,471) |
| Setup: compile / groth16 setup / contribute / zkey verify | | 4 / 25 / 2 / 27 s | 8 / 38 / 5 / 39 s | 12 / 48 / 9 / 55 s |

- **Each extra input costs about 6,370 constraints** (Poseidon commitment and nullifier, a 23-level Merkle path,
  the range check, the duplicate-nullifier checks). The 12-in circuit fits the power-17 ptau (131,072) with room.
- **2-in breakdown:** the authorization block alone (`eddsaProbe`: Poseidon(6) message + 2 BabyCheck +
  EdDSAPoseidonVerifier) is 4,567. The input range checks add 496. Sharing one owner key saves about 475 (one
  Poseidon(1) + one Poseidon(3) fewer).
- **Proving times** come from this session. An earlier session measured the 2-in at 961–969 ms, so expect ±10%
  between runs on this machine.
- **Under-constraint check.** `--inspect` reports only CA02 warnings for all three. All of them are unused `Num2Bits`
  output bits (range checks, constrained inside `Num2Bits`) or circomlib-internal (`CompConstant`, `EscalarMul*`).
- **No `<--` in our circuits.** The only `<--` are circomlib's `IsZero`, `Num2Bits` and `BabyAdd`, each followed by
  its constraint.
- **Not run:** circomspect and Picus (both need Rust).

### Selection rule (`scripts/select-test.mjs`)

33 checks pass (4 of them for the dust-change rule). Each branch is tested at n = 1, 2, 5, 6, 11, 12 and 13, with T exactly at and just over each
boundary. Also tested: the largest notes come first, the fill is random and seedable, the 0.001 AUSD floor (0.000999
ignored, 0.001 counted), spent and pending notes excluded. 3,000 random cases check that the plan matches,
real inputs = min(circuit, n), T is covered and no note repeats.

### Witness tests (`scripts/circuit-test.mjs`)

The same cases run against each of the three circuits: 15 valid, 57 rejected (19 per circuit).

**Pass:** deposit (all dummies); merge with every slot a real note (2, 6 or 12); pay with 1 real input and the rest
dummies; withdraw with fee. The merge witness satisfies each R1CS.

**Fail, as expected:**
- **Nova's families:** sum inflation; duplicate nullifier; output ≥ 2^248; wrong nullifier; wrong root; wrong path
  index; output commitment mismatch; inflated input amount.
- **New:**
  - input amount `p-5` that is in the tree (input range check);
  - no signature;
  - signature by another key;
  - signature over a different message;
  - recipient swapped after signing;
  - `extDataHash` changed after signing;
  - `publicAmount` changed;
  - the attacker's own valid authority key on Alice's notes;
  - mixed owners (Alice's note + Carol's note under Alice's signature);
  - wrong `nk`;
  - authority key changed.

### Gas (anvil, Ethereum pricing) and Monad estimate

Monad prices the BN254 precompiles about 5× Ethereum (method in [docs/nova-spike.md](../../docs/nova-spike.md)).
The delta grows with the public inputs (one ecMul + ecAdd each): +893k for 7, +990k for 11, +1,135k for 17.

| Transaction | Gas | Monad estimate |
| --- | --- | --- |
| Deposit 50 (Alice's EOA, first insert, cold tree), 2-in | 1,229,038 | ~2.12M |
| Private payment, 2-in (4 runs) | 1,190,289–1,213,510 | ~2.08–2.11M |
| Withdrawal, 2-in | 1,219,665 | ~2.11M |
| Private payment, 6-in (2 runs) | 1,316,557–1,322,655 | ~2.31M |
| Private payment or merge, 12-in (3 runs) | 1,499,913–1,509,075 | ~2.63–2.64M |
| Groth16 verify only: 2-in / 6-in / 12-in | 228,804 / 255,392 / 295,274 | ~1.12M / ~1.25M / ~1.43M |

- A 12-in payment costs about 290k more than a 2-in: 66k in the verifier, the rest in 10 more nullifier checks and
  writes, events and calldata.
- The pool now builds the public inputs in a loop for all three verifiers. That cost about +2.5k per 2-in
  transaction (Alice → Bob was 1,211,043 before, 1,213,510 now).
- The port's private transfer cost 1,174,468. The roughly +20k for the 2-in comes from `deadline`, the
  1-byte-longer ciphertexts and the domain in `extDataHash`. The gateway pays gas in MON and earns 0.01 AUSD per
  transaction. The fresh withdrawal address's native balance stays 0.

### SMS formats

`checkSms` (`src/sms.mjs`) requires printable ASCII and calls `protocol/sms.ts`'s `fitsOneSegment` (GSM-7, ≤160
septets). Binary fields use standard base64 without padding (`A-Z a-z 0-9 + /` are all in the GSM-7 basic set).
"Worst" is the formatter's output with every field at its maximum width.

| Msg | Direction | Format | Example (from the run) | Len | Worst |
| --- | --- | --- | --- | --- | --- |
| `SEND` | phone → GW | unchanged from `protocol/sms.ts` | `SEND +919800000002, 20 AUSD` | 27 | 67 (address, `999999.999999`) |
| `MERGE` | phone → GW | spike-only: pay 0 to self | `MERGE` | 5 | 5 |
| `Q` | GW → phone | `Q <id> exp=<unix> fee=<AUSD> to=<86-char shielded address \| 0x address>` | `Q TED8 exp=1791041485 fee=0.01 to=A6iRqJSm...ectXLA` | 120 (76 for a withdrawal) | **126** |
| `SIG` | phone → GW | `SIG <id> <refs: 3 chars per real input> <86-char EdDSA sig>` | `SIG FZ56 AAjAAlAAnAAqAArAAsAAuAAwAAyAA0AA3AA6 hKRpucYZ...ejydAw` | 99 (1 input) to 132 (12 inputs) | **132** |
| `Sent` | GW → phone | `Sent <amt> AUSD to <who>. Tx <short hash> p=<pos of output 0>` | `Sent 1.5 AUSD to +919800000003. Tx 0x821b...a3 p=14` | 51 | 95 |
| `Got` | GW → recipient | `Got <amt> AUSD from <who> p=<pos> b=<43-char blinding>` | `Got 20 AUSD from +919800000001 p=2 b=KLK4aUmf...LQBgJo` | 80 | 100 |
| `ERR` | GW → phone | unchanged; new codes `MERGE`, `REF` | `ERR EBKT REF` | 9–16 | |

- **Q** no longer lists inputs: the phone picks them. `to` is the recipient's 64-byte shielded address
  (`ownerKey ‖ x25519 key`), or the withdrawal address. With the SMS Retriever hash (12 more characters), the worst
  case is 138.
- **SIG refs.** Each real input is 3 base64 characters (RFC 4648 alphabet `A-Z a-z 0-9 + /`, all GSM-7): its tree
  position mod 2^18 (262,144), in tree order, concatenated. Dummies get no ref. Today's `SIG` carries a 65-byte secp256k1 signature in 88
  characters and no refs; the shielded one has refs, then an 86-character signature, so the shape tells them apart.
- **How the gateway reads a SIG.** It accepts 1–12 refs and uses the smallest circuit (2, 6 or 12) that holds
  them; it doesn't rerun the selection rule. A duplicate ref, or a ref that matches no
  eligible note (unknown, spent, or under 0.001 AUSD), is `ERR REF`. On a collision (positions 262,144 apart) it
  rebuilds every candidate combination and keeps the one the signature verifies (capped at 64 combinations). No
  match is `ERR BADSIG`. All of this happens before proving.
- **Sent.** The change note is at `p+1`. The phone needs `p` to spend its change offline.

### Scenario (`npm run sim`, all asserts pass)

1. Alice shields 50 from her EOA (online: her phone signs, the gateway proves, her EOA submits).
2. **SMS:** Alice pays Bob 20 (2-in, 1 real input). Four messages, plus `Got` to Bob. Alice's cache is `29.99@3`,
   she has pinned Bob's key, and Bob's cache is `20@2`.
3. **SMS:** Bob pays Carol 5 from the note he learned by SMS. Bob's cache is `14.99@5`, Carol's is `5@4`.
4. **SMS:** Alice withdraws 10 to a fresh EVM address. Her cache is `19.98@7`.
5. **Balances:** pool 39.97, fresh address 10 (native balance 0), gateway fees 0.03.
6. **Dave** gets small notes shielded to him online (from Bob's EOA) and pays Carol by SMS. Fee 0.01 each:

   | Step | Dave's eligible notes | Pays | Rule | Circuit, real inputs |
   | --- | --- | --- | --- | --- |
   | a | 4 × 1 (+ a 0.0005 note, ignored) | 1.5 | 2 largest cover 1.51 | 2-in, 2 |
   | b | 1, 1, 0.49 | 2.4795 | 2 largest short of 2.4895 | 6-in, all 3; the 0.0005 change goes to the fee (0.0105), no change note |
   | c | none (only the 0.0005 note) | 0.01 | sum < T | `ERR FUNDS` |
   | d | 8 × 1 | 3 | 6 largest cover 3.01 | 6-in, 6 (4 largest + 2 random) |
   | e | 2.99, 8 × 1 | 8 | 6 largest (7.99) short of 8.01 | 12-in, all 9 |
   | f | 2.98, 23 × 1 | 2 | n ≥ 12 | 12-in, 12 (2.98 + 11 random) |
   | g | 11.97, 12 × 1 | 23 | 12 largest (22.97) short of 23.01 | `ERR MERGE` |
   | h | same | `MERGE` | n ≥ 12, T = 0.01 | 12-in, 12; leaves 22.96 and 1 |
   | i | 22.96, 1 | 23 | 2 largest cover 23.01 | 2-in, 2 |

   In step f the gateway's index also holds a fake note 262,144 positions after the 2.98 note, listed first. Both
   candidates were tried and the signature picked the real one.
7. **Final state:** pool 80.9, fresh address 10, gateway fees 0.1005, Carol 44.9795, Dave 0.95 (plus the ignored
   0.0005). Each phone's cache equals the gateway's index of its notes. Phone and gateway counted the same eligible
   notes before every SMS payment (13 comparisons). Each cached note's spent flag matches `isSpent(nullifier)`
   on-chain. The gateway's tree root equals `getLastRoot()`.

**Negative checks (all rejected):**

| | Check | Result |
| --- | --- | --- |
| a | Gateway changes recipient / amount 10→11 / fee 0.01→1 after SIG, keeping Alice's signature | no proof (EdDSA assert) ×3 |
| a | Honest proof, recipient swapped in `extData` at submission | pool: `Incorrect external data hash` |
| a | Honest proof, fee raised with `extDataHash` and `publicAmount` recomputed | pool: `Invalid transaction proof` |
| b | Gateway spends Alice's notes with nk + viewing key only: zero signature, random bytes, Alice's signature from another transaction, its own EdDSA key | no proof ×4 |
| c | Carol's authority key signs Alice's withdrawal | no proof; also `ERR <id> BADSIG` from the gateway's pre-check |
| d | Phone gets a `Q` whose amount + fee its notes can't cover (`FUNDS`) or that needs a merge (`MERGE`), an expired quote, a fee above its limit, or a substituted withdrawal address | refused, nothing signed ×6 |
| e | Resubmit step 2's transaction; a freshly signed and proved re-spend of the spent 50 note | pool: `Input is already spent` ×2; replayed `SIG` → `ERR <id> UNKNOWN` |
| f | `Q` for Bob with a different key after Bob was pinned | refused: `KEY CHANGED for +919800000002` |
| g | Gateway substitutes another of Dave's notes for one he named, and rebuilds | signature fails; no proof; the same refs in a `SIG` → `ERR <id> BADSIG` |
| g | `SIG` refs: unknown note (Alice's), Dave's 0.0005 note, a duplicate ref | `ERR <id> REF` ×3 |
| g | `SIG` with one ref dropped or one extra ref added | `ERR <id> BADSIG` ×2 |
| g | Dave asks to pay with nothing eligible / when the 12 largest are short | `ERR FUNDS` / `ERR MERGE` before any quote |

The old phone checks "note not in my cache" and "same note twice" are gone with `in=`. Their gateway-side
counterparts are the unknown-ref and duplicate-ref checks in g.

### What the phone stores

- **Secrets:** authority private key (32 B), `nk` (31 B), viewing key (32 B).
- **Config:** chain ID, pool address, the gateway's relayer address (it is in `extData`), maximum fee.
- **Note cache:** position, amount, blinding and spent flag, about 70 B per note.
- **Pinned contacts:** phone number → 64-byte shielded address.
- **Sends in flight:** the one waiting for its `Q`, and the signed ones waiting for `Sent` (their inputs are pending).

It needs no tree, no paths, no proving key and no prover. It needs a keccak + ABI encoder, Poseidon, x25519/xsalsa20
and EdDSA-Poseidon (all small JS).

### What the gateway learns

- **Sees everything about its users.** With `nk` and the viewing key it has every user's notes, balances,
  counterparties, amounts and timing, and with `nk` it can tell when any note is spent, even through another
  relayer. This is the same trust level as the "viewing key on the gateway" option.
- **Cannot spend, redirect or reprice** a signed transaction (checks a–c), or swap the notes the phone chose
  (check g).
- **Can still** censor or delay a transaction until its `deadline`, and lie in `Got` and `Sent` alerts (see
  Problems).

## Problems and findings

1. **First contact trusts the gateway's directory (TOFU).** On the first payment to a number, the phone signs to
   whatever 64-byte key the `Q` carries. A malicious gateway could substitute a key set it controls and later spend
   the note itself. Pinning stops this only on later payments (check f). Options: verify the key online (safety
   number or QR) before the first offline payment; refuse offline payments to unpinned contacts; or have the
   directory entry signed by the recipient's authority key (that still needs one trusted fetch).
2. **Alerts are unauthenticated.** A forged `Got` (from the gateway, or SMS sender spoofing) puts a fake note in the
   cache. Spending it just fails to prove, but the user may believe they were paid. A forged or lost `Sent` leaves
   the cache out of sync, and without `p` the change can't be spent offline. A short MAC per alert (for example
   6–8 base64 characters, keyed by a secret shared with the gateway) fits within the budget.
3. **No count check.** The gateway used to rerun the rule and reject a `SIG` whose ref count differed (`ERR COUNT`).
   That broke payments whenever the phone's view lagged (a lost `Sent`, or a second payment before the first
   `Sent`), and added no safety: the signature already covers exactly which notes are spent. Dropped. The gateway
   still runs the rule at `SEND` time to answer `ERR FUNDS` / `ERR MERGE` before quoting.
4. **The gateway can't check the random fill.** It doesn't check which notes the phone picked. A
   buggy or hostile phone app could leak information through its choice. Only the phone's own randomness protects
   this.
5. **Many notes mean big transactions.** Once n ≥ 6, every payment spends 6 or 12 notes, however small. A 12-in
   costs about 1.5M gas (about 2.6M on Monad) and 3.8 s of proving. The upside is that wallets consolidate on their
   own.
6. **Notes under 0.001 AUSD are stuck.** Both sides ignore them, and a merge doesn't sweep them. They stay in the
   pool until some future online sweep.
7. **Ref collisions start at 262,144 leaves.** Until then a ref names exactly one position. After that the gateway
   brute-forces candidate combinations (capped at 64, else `ERR REF`). A 4-character ref (2^24 positions) adds 12
   characters to the worst case and still fits (144).
8. **circomlibjs gotcha:** `unpackSignature` (`babyJub.unpackPoint`) clears the sign bit of its input buffer
   *in place*. Unpacking the same bytes twice (verify, then witness) gave a wrong `R8` about half the time. The fix
   is to always unpack a copy (`src/shielded.mjs`).
9. **Note blindings are now full field elements** (Poseidon outputs). Nova's 31-byte blinding slot in the encrypted
   note overflowed, which silently broke decryption, so the plaintext is now 63 bytes.
10. **The gateway pre-checks refs and signature in JS** (`REF`, `BADSIG`) so a bad SIG doesn't burn
    1–4 s of proving.
11. **Root staleness disappears:** the phone never signs the root, so the gateway proves against the current root
    whenever the SIG arrives.
12. **Deterministic ciphertexts:** re-quoting the same notes with different amounts is safe, because the key and
    nonce come from the commitment. Re-quoting the same quote reproduces the same ciphertext.
13. **For the audit:** circomlib's EdDSA has no on-curve checks (added here). The `ForceEqualIfEnabled` dummy-input
    rule is unchanged from Nova. Run circomspect and Picus.

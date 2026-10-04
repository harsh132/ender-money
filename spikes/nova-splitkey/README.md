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

**Deposits work over SMS too (EIP-3009).** `SHIELD` → `Q` → `SIG` → `Shielded`: the phone signs one AUSD
`ReceiveWithAuthorization` whose nonce pins the deposit. Tested on an anvil fork of Monad testnet with the real AUSD
and a real Calibur-delegated account (`npm run fork`). The pool now only takes calls from the gateway, except a
withdrawal with two null outputs. See [EIP-3009 deposits and guardrails](#eip-3009-deposits-and-guardrails).

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
  - A dummy input's blinding is `Poseidon(nk, nf_firstReal, i)`. It is random only for deposits, whose dummy
    inputs belong to the gateway.
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
  - `depositWithAuthorization`, `gateway`, `admin` and the null-output rule (see
    [EIP-3009 deposits and guardrails](#eip-3009-deposits-and-guardrails)).

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
| `contracts/` | `ShieldedPool.sol` (changes above), `MerkleTreeWithHistory.sol` copied unchanged, `MockAUSD.sol` (+ a minimal EIP-3009 `receiveWithAuthorization`); `generated/Verifier{2,6,12}.sol` (gitignored) |
| `src/shielded.mjs` | keys, notes, deterministic `buildTx` and `buildDeposit`, note encryption, EdDSA sign/verify, EIP-3009 typed data, witness, prover |
| `src/select.mjs` | the note-selection rule, imported by both the phone and the gateway |
| `src/phone.mjs` | **PHONE**: authority key, nk, viewing key, EOA root key (for `SHIELD`), note cache, pinned contacts; checks quotes, picks inputs, signs |
| `src/gateway.mjs` | **GATEWAY**: users' nk + viewing keys + authority *public* keys + EOA addresses, its own EdDSA key (deposit dummies); indexes notes, resolves the phone's refs, proves, relays, earns the fee |
| `src/sms.mjs` | message formats and the `checkSms` validator (`SEND`/`ERR` and `fitsOneSegment` imported from `protocol/sms.ts`) |
| `scripts/setup.sh` | compile, Groth16 setup + one contribution, verifier export (reuses `../nova-circom2/build/pot17_final.ptau`) |
| `scripts/select-test.mjs` | unit test of the selection rule |
| `scripts/circuit-test.mjs` | witness-level tests, all three circuits |
| `scripts/sms-sim.mjs` | anvil simulation: scenario, negative checks, gas, proving benchmark → `build/sms-sim-results.json` |
| `scripts/deposit3009-fork.mjs` | anvil fork of Monad testnet (real AUSD, real Calibur): SMS deposit, payment, withdrawals, guardrail checks → `build/deposit3009-fork-results.json` |

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
npm run fork            # forge build + anvil fork of Monad testnet on port 18549 (reads the public RPC, broadcasts nothing)
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
| Deposit 50 by SMS (`depositWithAuthorization`, Alice's EOA, first insert, cold tree), 2-in | 1,267,613 (was 1,229,038 with `transact` + `transferFrom`) | ~2.16M |
| Online deposits to Dave (EIP-3009 from Bob's EOA, warm tree, 22 runs) | 1,217,478–1,226,664 | ~2.11–2.12M |
| Private payment, 2-in (4 runs) | 1,190,562–1,196,659 | ~2.08–2.09M |
| Withdrawal, 2-in | 1,219,856 | ~2.11M |
| Private payment, 6-in (2 runs) | 1,316,854–1,322,880 | ~2.31M |
| Private payment or merge, 12-in (3 runs) | 1,500,090–1,509,264 | ~2.63–2.64M |
| Groth16 verify only: 2-in / 6-in / 12-in | 228,804 / 255,392 / 295,274 | ~1.12M / ~1.25M / ~1.43M |

- A 12-in payment costs about 290k more than a 2-in: 66k in the verifier, the rest in 10 more nullifier checks and
  writes, events and calldata.
- The pool now builds the public inputs in a loop for all three verifiers. That cost about +2.5k per 2-in
  transaction (Alice → Bob was 1,211,043 before, 1,213,510 after). With SMS deposits it is 1,196,659: the deposit fee
  already made the gateway's AUSD balance non-zero, so the payment's fee transfer no longer creates that slot.
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
| `SHIELD` | phone → GW | spike-only: deposit from the phone's EOA | `SHIELD 50 AUSD` | 13–16 | 25 |
| `Q` (deposit) | GW → phone | `Q <id> exp=<unix> fee=<AUSD>` (no `to=`) | `Q VFVM exp=1791124439 fee=0.01` | 30 | 36 (48 with the Retriever hash) |
| `SIG` (deposit) | phone → GW | today's: `SIG <id> <88-char base64 of the 65-byte secp256k1 signature>` | `SIG VFVM cFw/zpbT...cI7Z5Rs=` | 97 | 97 |
| `Shielded` | GW → phone | `Shielded <amt> AUSD. Tx <short hash> p=<pos>` | `Shielded 50 AUSD. Tx 0x36e2...df p=0` | 35–38 | 53 |
| `ERR` | GW → phone | unchanged; new codes `MERGE`, `REF`, `NOEOA` | `ERR EBKT REF` | 9–16 | |

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

1. **SMS:** Alice shields 50 from her EOA: `SHIELD 50 AUSD`, a deposit `Q`, a `SIG` with her EIP-3009 signature
   (50.01 AUSD: the deposit plus the fee), `Shielded ... p=0`. Her EOA holds 0 afterwards and never approved anything.
2. **SMS:** Alice pays Bob 20 (2-in, 1 real input). Four messages, plus `Got` to Bob. Alice's cache is `29.99@3`,
   she has pinned Bob's key, and Bob's cache is `20@2`.
3. **SMS:** Bob pays Carol 5 from the note he learned by SMS. Bob's cache is `14.99@5`, Carol's is `5@4`.
4. **SMS:** Alice withdraws 10 to a fresh EVM address. Her cache is `19.98@7`.
5. **Balances:** pool 39.97, fresh address 10 (native balance 0), gateway fees 0.04.
6. **Dave** gets small notes shielded to him online (Bob's EOA signs EIP-3009 authorizations, fee 0) and pays Carol
   by SMS. Fee 0.01 each:

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
7. **Final state:** pool 80.9, fresh address 10, gateway fees 0.1105, Carol 44.9795, Dave 0.95 (plus the ignored
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
| d | Deposit `Q` after `SHIELD`: expired, fee above the limit, or carrying a `to=` | refused, nothing signed ×3 |
| e | Resubmit step 2's transaction; a freshly signed and proved re-spend of the spent 50 note | pool: `Input is already spent` ×2; replayed `SIG` → `ERR <id> UNKNOWN` |
| f | `Q` for Bob with a different key after Bob was pinned | refused: `KEY CHANGED for +919800000002` |
| g | Gateway substitutes another of Dave's notes for one he named, and rebuilds | signature fails; no proof; the same refs in a `SIG` → `ERR <id> BADSIG` |
| g | `SIG` refs: unknown note (Alice's), Dave's 0.0005 note, a duplicate ref | `ERR <id> REF` ×3 |
| g | `SIG` with one ref dropped or one extra ref added | `ERR <id> BADSIG` ×2 |
| g | Dave asks to pay with nothing eligible / when the 12 largest are short | `ERR FUNDS` / `ERR MERGE` before any quote |

The old phone checks "note not in my cache" and "same note twice" are gone with `in=`. Their gateway-side
counterparts are the unknown-ref and duplicate-ref checks in g.

### What the phone stores

- **Secrets:** authority private key (32 B), `nk` (31 B), viewing key (32 B). For `SHIELD`, the EOA's root key
  (secp256k1, the one the wallet already has).
- **Config:** chain ID, pool address, the gateway's relayer address (it is in `extData`), maximum fee, AUSD's
  address and EIP-712 name and version.
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

## EIP-3009 deposits and guardrails

Before this, a deposit couldn't go over SMS: the user's EOA had to submit calldata containing the gateway's proof.
Now the user signs one AUSD authorization and the gateway submits.

### Design

- **The nonce is the commitment.** The phone builds the whole deposit alone (`buildDeposit`, `src/shielded.mjs`):
  outputs `[amount to self, 0 to self]`, blinding_i = `Poseidon(nk, seed, i)` with `seed` from the quote's id and
  `exp`, deterministic ciphertexts, `extData` (recipient 0, `extAmount` = amount + fee, relayer, fee, `deadline` =
  `exp`). It signs AUSD's `ReceiveWithAuthorization{from: its EOA, to: pool, value: amount + fee, validAfter: 0,
  validBefore: exp, nonce}` with `nonce = keccak256(abi.encode(extDataHash, outputCommitment0, outputCommitment1))`.
  `publicAmount = extAmount - fee`, so the pool keeps exactly the amount and the fee goes to the relayer.
- **`depositWithAuthorization(proof, extData, from, signature)`.** Gateway only. Requires `extAmount > 0` and the
  deposit cap. The pool computes the nonce from the submitted proof (`_transact` then checks `extDataHash` against
  `extData`), calls `AUSD.receiveWithAuthorization(from, pool, extAmount, 0, deadline, nonce, signature)`, then runs
  the normal transact (proof, nullifiers, insert, fee).
- **No shielded signature from the user.** A deposit has only dummy inputs. The gateway owns them under its own
  EdDSA authority key and `nk`, and signs the in-circuit message itself. This works with the circuit as it is: all
  inputs share one owner (the gateway's), outputs may go to anyone. The witness and proof are normal 2-in ones. The
  user's EIP-3009 signature pins `extDataHash` and both output commitments, so the gateway can't redirect.
- **AUSD's ABI** (testnet proxy `0xa901...22dC`, handled in the proxy itself): both
  `receiveWithAuthorization(..., bytes signature)` (`0x88b7ab63`) and `(..., uint8 v, bytes32 r, bytes32 s)`
  (`0xef55bec6`), plus the `transferWithAuthorization` pair. The pool uses the bytes overload.
- **Guardrails:**

  | Call | Who may send it |
  | --- | --- |
  | `depositWithAuthorization` | gateway only |
  | `transact` with `extAmount > 0` | nobody (`deposits: depositWithAuthorization`) |
  | `transact`, transfer or merge (`extAmount == 0`) | gateway only |
  | `transact`, withdrawal with both outputs = `NULL_COMMITMENT` | anyone |
  | `transact`, any other withdrawal | gateway only |
  | `setGateway` | `admin` (immutable; a multisig in production) |

  `NULL_COMMITMENT = Poseidon(0, 0, 0) = 0x0bc1...99aa` (circomlibjs, hard-coded). A null output has amount 0, owner
  key 0, blinding 0 and an empty ciphertext. When both outputs are null the pool inserts no leaves and emits no
  `NewCommitment`. The gateway's tree is built from those events, so it still matches `getLastRoot()` (asserted).
  The null-output withdrawal is the exit that doesn't need the gateway: the user (online, with a prover) withdraws
  whole notes.

### How AUSD checks a 7702 account's signature

AUSD **tries `ecrecover` first**, then falls back to ERC-1271:

| Probe (eth_call on the fork, `msg.sender` = `to`) | Result | `isValidSignature` call |
| --- | --- | --- |
| Plain EOA, raw 65 bytes / v, r, s | accepted / accepted | none |
| Calibur-delegated EOA, raw 65-byte root-key signature / v, r, s | accepted / accepted | none |
| Calibur-delegated EOA, signature by another key | `InvalidSignature()` | yes, to the account (Calibur rejects too) |
| Calibur-delegated EOA, Calibur-wrapped `abi.encode(keyHash 0, sig, "")` | `InvalidSignature()` | yes, to the account |

- So **a raw 65-byte root-key signature works**, and through plain `ecrecover`: the mined deposit's trace has no
  `isValidSignature` call, only precompile 0x01 (`receiveWithAuthorization` used 61,285 gas). The 7702 delegation
  plays no part.
- The 1271 path would also accept it: Calibur v1.1.0's `isValidSignature` takes a raw 64/65-byte signature from the
  root key. The wrapped form needs an ERC-7739 `TypedDataSign` inner signature, so a plain one fails. It would only
  matter for a non-root Calibur key (a passkey), which this spike doesn't use.

### Fork test (`npm run fork`, all asserts pass)

anvil `--fork-url https://testnet-rpc.monad.xyz --hardfork prague`. A fresh EOA is delegated to Calibur
(`0x0000...030e`) with a viem EIP-7702 authorization (another account sponsors the type-4 transaction); its code is
`0xef0100 ‖ Calibur`. It gets 5 AUSD from the testnet faucet contract, impersonated on the fork. The pool, hasher
and verifiers are deployed on the fork.

1. **SMS deposit** from the 7702 account: `SHIELD 1 AUSD` → `Q` → `SIG` → `Shielded 1 AUSD ... p=0`. The EOA paid
   1.01, the pool got 1, the gateway 0.01.
2. **SMS payment**, Alice → Bob 0.3. **SMS withdrawal**, Alice 0.2 to a fresh address.
3. **Null-output withdrawal** of Bob's whole 0.3 note, submitted by a random EOA. No leaves, same root, gateway
   root = pool root.
4. **Negative checks**, all rejected (15):

   | Attack | Result |
   | --- | --- |
   | Gateway replaces output commitment 0 with its own note (valid proof, `extData` unchanged) | AUSD `InvalidSignature()` |
   | Gateway replaces output commitment 1 | AUSD `InvalidSignature()` |
   | Gateway raises the amount 0.5 → 0.6 | AUSD `InvalidSignature()` |
   | Gateway raises the fee 0.01 → 0.11, same total pulled (deposit 0.4) | AUSD `InvalidSignature()` |
   | Gateway extends the deadline by an hour | AUSD `InvalidSignature()` |
   | Gateway sets the `extData` recipient | AUSD `InvalidSignature()` |
   | Replay of the mined deposit; same authorization with fresh dummy nullifiers | AUSD `UsedOrCanceledAuthorization()` ×2 |
   | `depositWithAuthorization` from a non-gateway EOA | `only gateway` |
   | Plain `transact` deposit (even from the gateway) | `deposits: depositWithAuthorization` |
   | Transfer submitted by a non-gateway EOA | `only gateway` |
   | Non-gateway withdrawal with one null and one real output (a sneaky transfer) | `only gateway` |
   | `setGateway` from the gateway / from a random EOA | `only admin` ×2 |
   | Old gateway after the admin rotated it | `only gateway` |

   After the rotation the new gateway relays a `SHIELD 0.25` and an SMS payment. Caches equal the gateway's index,
   and its root equals the pool's.

The anvil sim (`npm run sim`) uses the same path with MockAUSD (EIP-712 + `ecrecover`) and still passes every check.
The circuit was not changed; the witness tests and the selection test pass as before.

### Gas

| Transaction | Gas | Monad estimate |
| --- | --- | --- |
| Deposit, `transact` + `transferFrom` (before; sim, MockAUSD, cold tree) | 1,229,038 | ~2.12M |
| Deposit, `depositWithAuthorization` (sim, MockAUSD, cold tree) | 1,267,613 (+38.6k, +3.1%) | ~2.16M |
| Deposit, `depositWithAuthorization` (fork, real AUSD, 7702 account, cold tree) | 1,276,796 | ~2.17M |
| Withdrawal, 2-in, normal (fork) | 1,226,086 | ~2.12M |
| Withdrawal, 2-in, null outputs, sent by a random EOA (fork) | **365,707** (−860k, −70%) | ~1.26M |

- The deposit costs more mainly because AUSD stores the used nonce (a fresh slot), plus EIP-712 hashing,
  `ecrecover`, and the `from` and signature calldata.
- Skipping the insert saves the 23 Poseidon hashes up the tree. That is most of a normal transaction's gas.

### Problems and findings

1. **Rotating the gateway means updating every phone.** The relayer address is inside `extData`, which the phone
   builds and signs. After `setGateway`, phones that still have the old relayer build different bytes, and their
   `SIG`s fail (`BADSIG`). The fork test updates the phone's config by hand.
2. **The deposit seed comes from the quote** (id, `exp`). A gateway that repeats an (id, `exp`) pair for the same
   amount gets the same commitments and nonce, and the second deposit fails with `UsedOrCanceledAuthorization`. It
   can only deny that deposit. The phone could refuse a pair it has already signed.
3. **SMS withdrawals still insert two leaves.** A withdrawal with no change could use null outputs and save about
   860k gas (and anyone could relay it). Not done: the phone's build and the `Sent` reply (it has no `p` then) would
   change.
4. **The null-output exit needs a prover.** The phone has none. The exit is for a user with an online wallet that
   can prove.
5. **`validBefore` is strict.** AUSD requires `block.timestamp < validBefore`, the pool `<= deadline`, so the last
   second of a quote fails in AUSD. Harmless.
6. **MockAUSD vs AUSD.** The mock's domain name is "Mock AUSD" and it only does `ecrecover`; the phone's config
   carries the token's EIP-712 name and version.
7. **The deployed testnet pool predates this.** It has no gateway, admin or `depositWithAuthorization`.
   `scripts/deploy-testnet.mjs` now passes the deployer as gateway and admin, but a new deployment needs a new
   deployments file. `scripts/smoke-testnet.mjs` still targets the old pool.

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

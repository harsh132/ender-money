# Spike: split-key Nova, private payments over SMS

This spike tests the "Split keys" design in [docs/shielded-pool.md](../../docs/shielded-pool.md#offline-two-ways).
It asks whether a shielded payment can be made offline using today's 4-SMS pattern (`SEND`, `Q`, `SIG`, `Sent`),
where every message is one GSM-7 segment. The gateway proves but cannot spend. The base is the Circom 2 port in
[../nova-circom2](../nova-circom2/README.md). **Testnet only:** the trusted setup has a single party, and nothing
here is audited.

**Status: it works.** The circuit compiles and `--inspect` is clean. The witness tests pass (4 valid cases, 19
rejected). The anvil simulation passes every scenario step and every negative check. Every SMS was at most 127
characters, and the worst case per format is 145.

## Design

| | Nova (Circom 2 port) | Split keys (this spike) |
| --- | --- | --- |
| Keys | one `privkey` | phone: EdDSA BabyJubJub authority key `(Ax, Ay)`. Gateway: nullifier key `nk` (field element) + x25519 viewing key |
| Owner key | `Poseidon(privkey)` | `Poseidon(Ax, Ay, Poseidon(nk))` |
| Commitment | `Poseidon(amount, pubkey, blinding)` | unchanged |
| Nullifier | `Poseidon(C, pos, Poseidon(privkey, C, pos))` | `Poseidon(nk, C, pos)` |
| Authorization | knowing `privkey` | one EdDSA-Poseidon signature over `Poseidon(nf0, nf1, oc0, oc1, extDataHash, publicAmount)` |
| Inputs | each with its own key | all inputs (dummies too) share one `(Ax, Ay, nk)` |
| Public inputs | root, publicAmount, extDataHash, nullifier[2], commitment[2] | **unchanged** (the verifier is regenerated) |

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
  - Only Verifier2 remains.

  Nothing else changed.
- **The two fixes from docs/nova-spike.md:**
  1. **Input amounts are range-checked:** `Num2Bits(248)` per input, 496 constraints. A witness test has a note of
     amount `p-5` sitting in the tree. It passes every other constraint and fails only this one.
  2. **Chain and pool binding goes through `extDataHash`, not the nullifier.** The pool hashes its own chain ID and
     address into `extDataHash`, so both the proof and the phone's signature are bound to one deployment. This adds
     no constraints and no public input. The nullifier value itself carries no domain. That would need a new public
     input, or a circuit and key per deployment. The only effect is that a note duplicated byte-for-byte in two
     pools would show the same nullifier in both.
- **Also added:** `BabyCheck` (on-curve check) for `A` and `R8`, because circomlib's verifier skips it. Cost: about 6
  constraints.

## Layout

| Path | What |
| --- | --- |
| `circuits/transaction.circom` | split-key `Transaction(levels, nIns, nOuts)` (`merkleProof.circom` copied unchanged) |
| `circuits/transaction2.circom` | main: height 23, 2-in/2-out, the port's public inputs |
| `circuits/eddsaProbe.circom` | the authorization block on its own (message hash + curve checks + EdDSA), to measure its cost |
| `contracts/` | `ShieldedPool.sol` (changes above), `MerkleTreeWithHistory.sol` and `MockAUSD.sol` copied unchanged; `generated/Verifier2.sol` (gitignored) |
| `src/shielded.mjs` | keys, notes, deterministic `buildTx`, note encryption, EdDSA sign/verify, witness, prover |
| `src/phone.mjs` | **PHONE**: authority key, nk, viewing key, note cache, pinned contacts; checks quotes and signs |
| `src/gateway.mjs` | **GATEWAY**: users' nk + viewing keys + authority *public* keys; indexes notes, picks inputs, proves, relays, earns the fee |
| `src/sms.mjs` | message formats and the `checkSms` validator (`SEND`/`ERR` and `fitsOneSegment` imported from `protocol/sms.ts`) |
| `scripts/setup.sh` | compile, Groth16 setup + one contribution, verifier export (reuses `../nova-circom2/build/pot17_final.ptau`) |
| `scripts/circuit-test.mjs` | witness-level tests |
| `scripts/sms-sim.mjs` | anvil simulation: scenario, negative checks, gas, proving benchmark → `build/sms-sim-results.json` |

## Reproduce

In Git Bash from `spikes/nova-splitkey/`, with Node 22 (it imports `../../protocol/sms.ts` through Node's built-in
type stripping) and Foundry in `~/.foundry/bin`:

```bash
mkdir -p bin && cp ../nova-circom2/bin/circom.exe bin/   # circom 2.2.3 (see ../nova-circom2 for the download)
npm ci
export PATH=$PATH:~/.foundry/bin
npm run setup           # ~1 min; needs ../nova-circom2/build/pot17_final.ptau (or PTAU=<path>)
npm run test:circuits   # witness tests (circom prints each expected assert failure to stderr)
npm run sim             # forge build + anvil simulation on port 18548
```

## Results

The machine is a Ryzen 5 5500GT with 6 cores, running Windows 11. Proving uses snarkjs 0.7.6 in Node (WASM witness,
JS prover).

### Circuit (transaction2, height 23, `--O2`)

| | Circom 2 port | Split keys |
| --- | --- | --- |
| Constraints | 14,150 | **18,738 (+4,588, +32%)** |
| Authorization block alone (`eddsaProbe`: Poseidon(6) msg + 2 BabyCheck + EdDSAPoseidonVerifier) | — | 4,567 |
| Input range checks (fix 1) | — | +496 |
| Saved by sharing one owner key (one Poseidon(1) + one Poseidon(3) fewer) | — | about −475 |
| Public / private inputs | 7 / 60 | 7 / 64 |
| wasm / zkey | 2.52 MB / 8.2 MB | 4.25 MB / **12.0 MB** |
| fullProve, n=10, same machine and session | median 672 ms (654–703) | **median 961–969 ms (931–1,005)**, +44% |
| Setup: compile / groth16 setup / contribute / zkey verify | | 5 s / 24 s / 3 s / 25 s (ptau reused) |

- **Under-constraint check.** `--inspect` reports only CA02 warnings. All of them are unused `Num2Bits` output bits
  (range checks, constrained inside `Num2Bits`) or circomlib-internal (`CompConstant`, `EscalarMul*`).
- **No `<--` in our circuits.** The only `<--` are circomlib's `IsZero`, `Num2Bits` and `BabyAdd`, each followed by
  its constraint.
- **Not run:** circomspect and Picus (both need Rust).

### Witness tests (`scripts/circuit-test.mjs`)

**Pass:** deposit (2 dummies); merge; pay with 1 real input + 1 dummy; withdraw with fee. The merge witness
satisfies the R1CS.

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

| Transaction | Gas | Monad estimate (+893k BN254 precompile delta) |
| --- | --- | --- |
| Deposit 50 (Alice's EOA, first insert, cold tree) | 1,226,547 | ~2.12M |
| Alice → Bob 20, private, relayed | 1,211,043 | ~2.10M |
| Bob → Carol 5, private, relayed | 1,193,896 | ~2.09M |
| Alice withdraws 10 to a fresh address, relayed | 1,217,162 | ~2.11M |
| Groth16 verify only | 228,804 (same as the port: 7 public inputs) | ~1.12M |

The port's private transfer cost 1,174,468. The roughly +20k here comes from `deadline`, the 1-byte-longer
ciphertexts and the domain in `extDataHash`. The gateway pays gas in MON and earns 0.05 AUSD per transaction. The
fresh withdrawal address's native balance stays 0.

### SMS formats

`checkSms` (`src/sms.mjs`) requires printable ASCII and calls `protocol/sms.ts`'s `fitsOneSegment` (GSM-7, ≤160
septets). Binary fields use standard base64 without padding (`A-Z a-z 0-9 + /` are all in the GSM-7 basic set).
"Worst" is the formatter's output with every field at its maximum width.

| Msg | Direction | Format | Example (from the run) | Len | Worst |
| --- | --- | --- | --- | --- | --- |
| `SEND` | phone → GW | unchanged from `protocol/sms.ts` | `SEND +919800000002, 20 AUSD` | 27 | 67 (address, `999999.999999`) |
| `Q` | GW → phone | `Q <id> exp=<unix> fee=<AUSD> in=<pos>[,<pos>] to=<86-char shielded address \| 0x address>` | `Q 6D7Q exp=1791016918 fee=0.05 in=0 to=H26ZxDNDzEfCStGV...YOqszOw` | 125 (81 for a withdrawal) | **145** |
| `SIG` | phone → GW | `SIG <id> <86-char EdDSA sig: compressed R8 32 B + S 32 B>` | `SIG 6D7Q vMX17RJk7JEL...KlhH7AA` | 95 | 95 |
| `Sent` | GW → phone | `Sent <amt> AUSD to <who>. Tx <short hash> p=<pos of output 0>` | `Sent 20 AUSD to +919800000002. Tx 0xd340...50 p=2` | 49 | 95 |
| `Got` | GW → recipient | `Got <amt> AUSD from <who> p=<pos> b=<43-char blinding>` | `Got 20 AUSD from +919800000001 p=2 b=G2R5bsZGvEaH...FP9U+0` | 80 | 100 |
| `ERR` | GW → phone | unchanged | `ERR W98D BADSIG` | 15 | |

- **Q.** `in` lists the phone's own notes by tree position (2^23 leaves, at most 7 digits). `to` is the
  recipient's 64-byte shielded address (`ownerKey ‖ x25519 key`), or the withdrawal address. Even with the
  SMS Retriever hash (12 more characters), the worst case is 157.
- **SIG.** Today's `SIG` carries a 65-byte secp256k1 signature in 88 characters. This one is 64 bytes in 86
  characters, so the length tells them apart.
- **Sent.** The change note is at `p+1`. The phone needs `p` to spend its change offline.

### Scenario (`npm run sim`, all asserts pass)

1. Alice shields 50 from her EOA (online: her phone signs, the gateway proves, her EOA submits).
2. **SMS:** Alice pays Bob 20. Four messages, plus `Got` to Bob. Alice's cache is `29.95@3`, she has pinned Bob's
   key, and Bob's cache is `20@2`.
3. **SMS:** Bob pays Carol 5 from the note he learned by SMS. Bob's cache is `14.95@5`, Carol's is `5@4`.
4. **SMS:** Alice withdraws 10 to a fresh EVM address. Her cache is `19.9@7`.
5. **Final state:** pool 39.85, fresh address 10 (native balance 0), gateway fees 0.15. Each phone's cache equals
   the gateway's index of its notes. Each cached note's spent flag matches `isSpent(nullifier)` on-chain. The
   gateway's tree root equals `getLastRoot()`.

**Negative checks (all rejected):**

| | Check | Result |
| --- | --- | --- |
| a | Gateway changes recipient / amount 10→11 / fee 0.05→1 after SIG, keeping Alice's signature | no proof (EdDSA assert) ×3 |
| a | Honest proof, recipient swapped in `extData` at submission | pool: `Incorrect external data hash` |
| a | Honest proof, fee raised with `extDataHash` and `publicAmount` recomputed | pool: `Invalid transaction proof` |
| b | Gateway spends Alice's notes with nk + viewing key only: zero signature, random bytes, Alice's signature from another transaction, its own EdDSA key | no proof ×4 |
| c | Carol's authority key signs Alice's withdrawal | no proof; also `ERR <id> BADSIG` from the gateway's pre-check |
| d | Phone gets a `Q` with a note not in its cache, the same note twice, notes that don't cover amount + fee, an expired quote, a fee above its limit, or a substituted withdrawal address | refused, nothing signed |
| e | Resubmit step 2's transaction; a freshly signed and proved re-spend of the spent 50 note | pool: `Input is already spent` ×2; replayed `SIG` → `ERR <id> UNKNOWN` |
| f | `Q` for Bob with a different key after Bob was pinned | refused: `KEY CHANGED for +919800000002` |

### What the phone stores

- **Secrets:** authority private key (32 B), `nk` (31 B), viewing key (32 B).
- **Config:** chain ID, pool address, the gateway's relayer address (it is in `extData`), maximum fee.
- **Note cache:** position, amount, blinding and spent flag, about 70 B per note.
- **Pinned contacts:** phone number → 64-byte shielded address.
- **Pending send:** at most one at a time.

It needs no tree, no paths, no proving key and no prover. It needs a keccak + ABI encoder, Poseidon, x25519/xsalsa20
and EdDSA-Poseidon (all small JS).

### What the gateway learns

- **Sees everything about its users.** With `nk` and the viewing key it has every user's notes, balances,
  counterparties, amounts and timing, and with `nk` it can tell when any note is spent, even through another
  relayer. This is the same trust level as the "viewing key on the gateway" option.
- **Cannot spend, redirect or reprice** a signed transaction (checks a–c).
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
3. **circomlibjs gotcha:** `unpackSignature` (`babyJub.unpackPoint`) clears the sign bit of its input buffer
   *in place*. Unpacking the same bytes twice (verify, then witness) gave a wrong `R8` about half the time. The fix
   is to always unpack a copy (`src/shielded.mjs`).
4. **Note blindings are now full field elements** (Poseidon outputs). Nova's 31-byte blinding slot in the encrypted
   note overflowed, which silently broke decryption, so the plaintext is now 63 bytes.
5. **Only 2 inputs.** transaction16 is skipped: `Poseidon(nIns+nOuts+2)` exceeds circomlib's 16-input width, so it
   would need a two-level message hash. Not hard, but not done. When no two notes cover a payment, the gateway
   answers `ERR FUNDS`. Merging has to happen online (each merge needs a signature from the app).
6. **The gateway pre-checks the signature in JS** (`BADSIG`) so a bad SIG doesn't burn about 1 s of proving.
7. **Root staleness disappears:** the phone never signs the root, so the gateway proves against the current root
   whenever the SIG arrives.
8. **Deterministic ciphertexts:** re-quoting the same notes with different amounts is safe, because the key and
   nonce come from the commitment. Re-quoting the same quote reproduces the same ciphertext.
9. **For the audit:** circomlib's EdDSA has no on-curve checks (added here). The `ForceEqualIfEnabled` dummy-input
   rule is unchanged from Nova. Run circomspect and Picus.

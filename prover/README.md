# Prover: Groth16 for the split-key pool

A small container that proves split-key pool transactions (2, 6 or 12 inputs) for the gateway. It runs on Cloudflare
Containers and only the gateway Worker calls it. Circuits and keys come from
[spikes/nova-splitkey](../spikes/nova-splitkey/README.md) ([docs/splitkey-spike.md](../docs/splitkey-spike.md)).
**It bakes in the spike's existing zkeys.** The deployed testnet verifiers only accept proofs for those keys, so never
regenerate them.

- **Witness:** circom's C++ witness generator (`circom --c --O2`), built as one static binary + `.dat` per circuit.
  The server runs it as a child process: input JSON on stdin, `.wtns` on stdout. Nothing touches disk, and a crash
  (a failed constraint calls `assert` and aborts) only kills the child.
- **Proof:** rapidsnark v0.0.8 (iden3, native C++/asm), linked as a static library. Each key is parsed once and kept
  in memory.
- **Server:** C++ with cpp-httplib (one header), in the same static binary as rapidsnark.
- **Image:** `gcr.io/distroless/static-debian12:nonroot`, with no shell, libc or Node.

**Why C++.** rapidsnark is a C++ library, and it's the only way to keep keys loaded between requests: its CLI
reloads the zkey on every proof. Go or Rust would need cgo/FFI to the same library plus a second toolchain in the
build. C++ with a header-only HTTP library is one `g++` line. The result is one 2.9 MB static binary, so the runtime
can be distroless/static. I didn't try witnesscalc: the circom binaries take 20–120 ms against 1–4 s of proving.

## Build and run

```bash
./sync.sh                         # copies circuits, circomlib, the spike's .r1cs and the existing zkeys into assets/ (gitignored)
docker build -t ender-prover .    # ~9 min cold (the 12-in witness C++ is the slow part)
docker run --rm -p 8080:8080 ender-prover
node test.mjs                     # needs the spike's node_modules; starts its own container at 1 CPU / 3 GiB
```

The build checks that its circom compile reproduces the spike's `.r1cs` byte for byte (`cmp`; same circom 2.2.3 and
`--O2`). So the witnesses match the baked zkeys, or the build fails. circom and cpp-httplib downloads are
sha256-pinned. rapidsnark is pinned by tag.

## API

| Call | Answer |
| --- | --- |
| `GET /health` | `200 {"loaded":[2],"maxrssMiB":..,"cgroupPeakMiB":..}`. The port opens only after the 2-in key is loaded, so any answer means ready. |
| `GET /warm?circuit=6` | Loads that key if needed (20–80 ms), then answers like `/health`. |
| `POST /prove {"circuit":2\|6\|12,"input":{...}}` | `200 {"proof":{"pi_a","pi_b","pi_c","protocol":"groth16","curve":"bn128"},"publicSignals":[...]}`: the shape snarkjs `groth16.fullProve` returns. The 2-in result was checked against snarkjs `fullProve`. |

- **`input`** is exactly what the spike's `witnessInput()` returns. BigInts go as decimal strings (`"0x…"` hex also
  works). Plain JSON integers are accepted and turned into strings. Floats, negatives, other strings and `null` get a
  400, because circom would read numbers as doubles. `publicSignals` order: `root, publicAmount, extDataHash,
  inputNullifier[n], outputCommitment[2]`, the pool's order.
- **Errors** are `{"error": "..."}`:
  - **400:** bad request: unknown circuit, invalid JSON, or a non-field-element value. The message names the
    signal, never its value. A 400 is a gateway bug.
  - **422:** the witness generator rejected the input: a failed constraint (`Failed assert in template/function
    Transaction line 77`), a missing signal (`Not all inputs have been set`), or the wrong circuit
    (`Error loading signal inAmount: Too many values`). Don't retry.
  - **500:** prover fault.
- **One proof at a time** (a global lock, sized for 1 vCPU). Concurrent requests queue.
- **Bodies are never logged and never written to disk.** They hold the user's nullifier key. The log has key loads,
  per-proof timings (`prove n=12 witness=85 ms groth16=4207 ms`) and failure status codes, nothing else.
- **Environment:**
  - `PORT` (default 8080).
  - `PROVER_DIR` (default `/app`).
  - `OMP_NUM_THREADS`: rapidsnark uses OpenMP. Under `docker --cpus=1` it sees every host core. Setting it to 1
    was slightly steadier (12-in 4.0–4.2 s, against 4.2–5.2 s); not baked in.

## Measured (Docker Desktop, Ryzen 5 5500GT, `docker run --cpus=1 --memory=3g`)

| | 2-in | 6-in | 12-in |
| --- | --- | --- | --- |
| First proof (6/12 include the lazy key load) | 977 ms | 2,374 ms | 4,186 ms |
| Warm proof, median of 10 (range) | **1,000 ms** (907–1,091) | **2,301 ms** (2,203–2,398) | **4,406 ms** (4,205–5,226) |
| of which witness (server log) | 20–130 ms | 40–130 ms | 75–120 ms |
| Key load | 21 ms (at startup) | 30–55 ms | 80 ms |
| snarkjs fullProve, Node, 6 cores (spike) | 1,044 ms | 2,026 ms | 3,811 ms |

- **Cold start** (`docker run` → first `/health` 200): **660–880 ms** over 4 runs, mostly Docker creating the
  container; the server itself is ready ~25 ms after exec. On Cloudflare the VM start and image fetch will dominate.
  That's what `warm()` hides.
- **Peak memory:** **195 MiB** (cgroup `memory.peak` after all three keys loaded and 40+ proofs; server RSS
  181 MiB). That fits 3 GiB with a lot of room.
- **Image:** **71.9 MB** compressed (what's pushed), about 124 MB unpacked: 89.5 MB of zkeys, 29 MB of binaries
  (three witness generators of 6–8 MB, their `.dat` files of 1–2 MB each, a 2.9 MB server) and 6 MB of distroless
  base.
- **So rapidsnark on one vCPU matches snarkjs on six cores.** A SIG waits 1–4.5 s for its proof once the
  container is up.
- **With 2 vCPU / 6 GiB** (`--cpus=2`, the smallest custom step up at 3 GiB per vCPU), the warm medians were 593 /
  1,304 / 2,660 ms, about 1.7× faster. Only the instance type in the snippet changes.

## Verification (`node test.mjs`, all pass)

- 2-in (1 real + 1 dummy), 6-in and 12-in (every slot a real note) inputs are built with the spike's
  `buildTx`/`witnessInput`, then proved by the container.
- Each proof:
  - passes snarkjs `groth16.verify` with the spike's `transaction{N}_vkey.json`;
  - has `publicSignals` equal to `[root, publicAmount, extDataHash, …nullifiers, …commitments]`.
- **On-chain:** `eth_call` to the deployed Monad testnet pool's `verifyProof` (`0xbe34…10ff`, from
  `deployments/monad-testnet-guarded.json`) returns `true` for all three, and `false` with `publicAmount` + 1.
  Read-only, nothing sent.
- **Bad input:** each case gets its error, and the server stays up and keeps proving:
  - circuit 3, broken JSON, no input, `nk: "abc"` and a negative path index → 400;
  - a tampered nullifier, a 6-in input sent as 2-in, and a missing `nk` → 422.

## Cloudflare wiring

Lives in the gateway: [`gateway/src/prover.ts`](../gateway/src/prover.ts) and
[`gateway/wrangler.jsonc`](../gateway/wrangler.jsonc).

- `ProverContainer extends Container` (`@cloudflare/containers` 0.3.7), with `defaultPort = 8080`,
  `sleepAfter = "60s"`, `enableInternet = false` and `pingEndpoint = "localhost/health"`.
- `prove(env, circuit, witnessJson)` returns `{ proof, publicSignals }`; a non-2xx answer throws a `ProverError`
  carrying the status. `warm(env, circuit)` preloads that circuit's key.
- wrangler: the `containers` entry (custom instance `{ vcpu: 1, memory_mib: 3072, disk_mb: 2000 }`, image
  `../prover/Dockerfile`, `max_instances: 1`), the `PROVER` Durable Object binding and migration `v3`
  (`new_sqlite_classes: ["ProverContainer"]`; the gateway uses `migrations`, which can't be combined with `exports`).

What the gateway needs to know:

- **Before `wrangler deploy`, run `prover/sync.sh`.** The image needs `assets/`. wrangler builds it from
  `../prover`. Containers must be `linux/amd64`, and this build is x86_64 (asm).
- **Call `ctx.waitUntil(warm(env, circuit).catch(() => {}))` when sending a `Q`.** The selection rule already gives
  the circuit at `SEND` time. A cold container then starts, and loads the 6/12 key, while the phone signs. Each
  call resets the 60 s idle timer. If the SIG comes more than 60 s after the quote, it waits for a cold start
  (about one container boot plus 25 ms).
- **Timeouts:** `prove` aborts after 30 s. Worst case today is about 5 s, plus queueing behind other proofs (one at
  a time).
- **Bodies:**
  - The request body is the user's `nk` plus their whole transaction. Don't log it, and don't log a failed request.
  - Error messages are safe to log: they name signals and template lines, never values.
- **Only through the binding:** the prover has no auth of its own. Don't route public traffic to the
  `ProverContainer` (no `fetch` passthrough from the gateway's public handler).
- **Sharding:** one named instance (`getContainer(env.PROVER, "prover")`) proves everything. If SIGs start to
  queue, shard by name and raise `max_instances`.

## Files

| Path | What |
| --- | --- |
| `server.cpp` | the HTTP server (~200 lines) |
| `Dockerfile` | multi-stage: Debian build (rapidsnark, circom → C++ witness, server), distroless/static runtime |
| `sync.sh` | copies the spike's circuits, circomlib, `.r1cs` and zkeys into `assets/` (gitignored) |
| `test.mjs` | correctness, on-chain check, bad inputs, timings |

**Found on the way:** rapidsnark v0.0.8's `groth16_prover_create_zkey_file` unmaps the file when it returns, and
leaves the prover pointing into freed memory. The first proof segfaults. The server reads the key into a buffer it
keeps and calls `groth16_prover_create`.

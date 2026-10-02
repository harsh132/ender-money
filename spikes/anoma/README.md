# Spike: Anoma / AnomaPay as a private balance for Ender (Monad, AUSD)

Date: 2026-10-03. All checks were read-only. Nothing was broadcast, nothing was submitted to the backend, and no indexer key was registered.

## TL;DR

- **AnomaPay supports Monad mainnet (143). It does not support AUSD.** The Monad tokens are USDC, WETH, USDT0 and WMON. The backend rejects AUSD outright: `{"error":"Token 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a is not supported on monad","status":400}`. `estimate-fee` for an AUSD tx also fails (`Fee estimation failed`).
- **The contracts would accept AUSD.** The ERC20 forwarder has no token allowlist (`_wrap` is Permit2 `permitWitnessTransferFrom` plus a balance-delta check), and `ProtocolAdapter.execute` is permissionless. The allowlist lives only in Heliax's backend. That backend also does the proving: one of its tx statuses is `proofGeneration`.
- **Fees.** Wrap is free. Transfer and unwrap cost `(baseFee + resourceFee × #resources)` gas × gas price × MON/USD, paid in the token being moved. For USDC on Monad today that is **0.002297 USDC** (4 resources) and **0.002808 USDC** (6 resources, the real case once the fee note is included). Heliax's relayer pays the MON gas. Each PA tx really burns ~1.56–1.85M gas (≈0.16–0.19 MON ≈ $0.005–0.006), so the fee recovers only about half the gas.
- **Usage on Monad is tiny.** The PA was deployed 2026-05-28 and has 511 txs and 1134 commitments. The last activity was 2026-09-29. The forwarder holds 109.31 USDC and 90.46 WMON (~$112 TVL), and 0 AUSD. Almost all txs are sent by two Heliax relayer EOAs.
- **No testnet anywhere.** Neither the prod nor the dev backend (`pay.dev.heliax.app`) lists a testnet. Both point at the same mainnet contracts, and nothing is deployed at the PA/forwarder addresses on Monad testnet (10143).
- **Trust model (important).** The client sends its **nullifier key in cleartext** to the backend with every spend, and the backend gets the plaintext resources (amounts, recipient keys, EVM addresses). The indexer needs the **discovery secret key**: it goes in the URL path of `GET /tags/<sk>`, and the SDK example POSTs it to `/add_key`. The result is private from the public chain, not from Heliax.
- **The dry run works up to the network submit.** It builds the keyring, pay address, Permit2 EIP-712 wrap signature, private transfer and unwrap payloads, and gets live fee quotes. It stops before `POST /api/v1/transactions/monad` and before indexer `POST /add_key`.

## Files

| File | What |
|---|---|
| `dry-run.mjs` | SDK dry run (`node dry-run.mjs`; `NO_ESTIMATE=1` / `NO_INDEXER=1` skip the two optional network calls) |
| `onchain.mjs` | Read-only receipts/gas/events for recent PA txs on Monad (`node onchain.mjs`) |
| `evidence/` | Raw responses: backend config (prod + dev), indexer health, prices, AUSD error, dry-run output, on-chain table |
| `vendor/` (gitignored) | Shallow clones: `anoma-app-sdk` main@7dc89be, `anoma-app-sdk` v0.18.1, `anomapay-erc20-forwarder`, `pa-evm` |

Setup: `cd spikes/anoma && npm install`. The SDK is npm `@anomaorg/anoma-app-sdk@1.2.0`, the same version as GitHub main. `package.json` overrides `@anomaorg/arm-bindings` to npm `0.3.1` instead of the SDK's `pkg.pr.new` preview URL, and it works. Node needs a `file:` fetch shim to load the wasm; it is the same shim the SDK's own `src/tests/setup.ts` uses.

## 1. Backend and indexer API

**SDK state.** v1.0.0 (2026-08-25, "slim sdk role") **removed** the `./api` clients. `TransferBackendClient` and `IndexerClient` no longer exist on main, so `examples/balance/src/main.ts` is stale and won't build against main. The endpoint paths below come from the last version that had them, **v0.18.1 `src/api/paths.ts`**:

| Service | Method & path | Read-only? | Called? |
|---|---|---|---|
| backend | `GET /health` | yes | yes: `{"version":"1.3.0","commit":"0533507f…"}` |
| backend | `GET /api/v1/configuration/all` | yes | yes (evidence/pay_prod_…_configuration_all.json) |
| backend | `GET /api/v1/configuration` | yes | yes: just `{chains:[{chain,chainId}…]}` |
| backend | `GET /api/v1/tokens/prices?tokens=net:addr,…` | yes | yes |
| backend | `GET /api/v1/tokens/{net}/{addr}/balances`, `/permit2/{token}/allowance` | yes | no (needs a real wallet) |
| backend | `POST /api/v1/transactions/{net}/estimate-fee` `{feeToken, transaction}` | quote | yes (throwaway payloads) |
| backend | `POST /api/v1/transactions/{net}/estimate-duration` | quote | no |
| backend | `GET /api/v1/swap/{net}/quote?…` (Bebop proxy) | yes | no |
| backend | **`POST /api/v1/transactions/{net}`** → `{requestId}` | **submits** | **no** |
| backend | `GET /api/v1/transactions/{id}`, `/{id}/status` (SSE), `/receipt/{net}/{hash}` | yes | no |
| indexer | `GET /health` | yes | yes |
| indexer | `GET /tags/{discoverySk}`, `GET /tags/{chain}/{contract}/{discoverySk}` | yes, but leaks the sk | once, with a throwaway sk → 404 |
| indexer | **`POST /add_key {public_key, secret_key}`** | **registers key** | **no** |
| indexer | `GET /sync-status/{sk}`, `POST /nullifying-transactions {nullifiers}`, `/alchemy` (RPC proxy) | yes | no |

**Monad entry (prod)**, trimmed:
```json
{"chain":"monad","chainId":143,"enabled":true,"testnet":false,
 "protocolAdapterAddress":"0x2D2Fa19aFdbb20DC73737ca5f075cfAE00Cd90C2",
 "forwarderAddress":"0x23dc44e1a1c3d5432eec8a1c027e22ccdc0a8f54",
 "genericCallForwarderAddress":"0x354cd903169af664e03afdd07df7e8913d48f064",
 "transferLogicVerifyingKey":"bc12323668c37c3d381ca798f11116f35fb1639d12239b29da7810df3985e7ad",
 "percentageFee":0,"baseFee":390000,"resourceFee":78000,
 "tokens":[{"symbol":"USDC","address":"0x754704bc059f8c67012fed69bc8a327a5aafb603","decimals":6,"feeEnabled":true},
           {"symbol":"WETH","address":"0xee8c0e9f1bffb4eb878d8f15f368a02a35481242"},
           {"symbol":"USDT0","address":"0xe7cd86e13ac4309349f30b3435a9d337750fc82d"},
           {"symbol":"WMON","address":"0x3bd359c1119da7da1d913d1c4d2b7c461115433a"}],
 "settings":{"maxResources":50}}
```
Other chains in prod: ethereum 1, base 8453, arbitrum 42161, bsc 56 and stable 988. All have `testnet:false`. The indexer also indexes Aurora (1313161554), which the backend does not expose.

**AUSD:** `GET /api/v1/tokens/prices?tokens=monad:0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` returns `400 {"error":"Token 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a is not supported on monad"}`.

**Prices** (2026-10-02T21:32Z): WMON $0.031716, USDC $0.99996.

**Fees.** `estimate-fee` responses with feeToken=USDC on Monad:

| tx | resources (consumed+created) | quote (USDC base units) |
|---|---|---|
| wrap 0.01 | 1+1 | `0` |
| transfer 0.005, no fee note (Bob + change) | 2+2 | `2297` |
| unwrap 0.005, no fee note | 2+2 | `2297` |
| transfer/unwrap **with** the fee note (what the app actually submits) | 3+3 | `2808` |

The fee formula fits exactly. `(390000 + 78000·n)` gas at ≈103 gwei × $0.0317/MON gives n=4 → $0.00230 and n=6 → $0.00281. This is inferred from the numbers, not documented anywhere. `percentageFee` is 0. The dev backend has `baseFee:10000, resourceFee:0`.

**Testnet.** I probed `pay.dev.heliax.app` and `galileo.dev.heliax.app` (both 200). They expose the same 6 mainnet chains and the same contracts. `pay.staging.`, `pay.testnet.` and other variants don't resolve. `10143` appears in no config. Monad testnet has no code at the PA, forwarder or generic-forwarder addresses. The repos' deployment maps list testnets only for Sepolia and Base Sepolia, and the backend doesn't serve those.

## 2. On-chain (Monad mainnet, block ~110,002,115)

| Contract | Read |
|---|---|
| PA `0x2D2F…90C2` | code 20,137 B; `getVersion`="1.1.0"; `isEmergencyStopped`=false; `owner`=`0xE9082Ac8Aa2Fb27DEfDBAC604921C196b884Da10` (Safe, **3-of-5**); RISC Zero router `0x8cFdF6D8…dF7f`, selector `0x73c457ba`; `commitmentCount`=1134, `nullifierCount`=1134, `commitmentTreeRootCount`=509, tree depth 11 (variable depth, grows) |
| ERC20 forwarder `0x23dc…8F54` | code 3,883 B; `getVersion`="1.0.1"; `getProtocolAdapter`=PA above; `getLogicRef`=`bc1232…e7ad` (= transferLogicVerifyingKey); `getEmergencyCaller`=0x0 (not set); no `owner()`, **no token allowlist** (any ERC20 with exact-amount transfers works at contract level) |
| Forwarder balances | USDC 109.307234 · WMON 90.455032 · WETH 0 · USDT0 0 · **AUSD 0** · MON 0 |
| Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` | deployed (9,152 B) |

**Activity** (monadscan reports 511 txs; the 25 most recent, analysed in `evidence/onchain_recent_txs.txt`):
- The PA was deployed 2026-05-28 by `0x61462bE5…`, using 15.6M gas. The 24 user txs after it span 2026-08-15 to 2026-09-29, so fewer than one tx per day.
- Senders are the relayers `0x05E4CDa72C7C00B1cf8afb2b0e7df01AF50AaD5c` (nonce 245, ~354 MON) and `0x39De2f775967573fEFA93195CBa10f4d3A5E0f50` (nonce 251, ~353 MON), plus `0x2D3dCAc0…` (13 txs).
- Gas by type (Monad charges the gas *limit*; gasUsed == gasLimit in every receipt), all at 102 gwei:

| Kind | Tags | Gas |
|---|---|---|
| wrap | 2 | 1.587M (one at 1.76–1.78M) |
| transfer | 4 | ~1.56–1.57M |
| transfer | 6 | ~1.73–1.95M |
| unwrap | 4–8 | 1.65–2.21M |

  Each tx costs ≈ **0.16–0.23 MON (~$0.005–0.007)**.
- The pattern is wrap X → private transfer → unwrap X−ε, mostly in USDC (5 USDC, 43 USDC, and one 1000 USDC round trip). The wrap-to-unwrap differences of 0.002–0.0075 USDC match the fee table above.

## 3. Dry run (`node dry-run.mjs`, full output in `evidence/dry-run-output.txt`)

What it does, all locally except the calls noted:
1. `GET /api/v1/configuration/all` and map it to `SupportedChainConfig`, the same mapping as `examples/balance`.
2. Two keyrings from random 32-byte IKM (`createUserKeyringFromIkm(ikm, "anoma-pay:keyring-seed")`). It prints the **pay address** (184-char base58, round-trip verified) and the public keys: authority, discovery and encryption (33-byte compressed secp256k1) plus the nullifier-key commitment (32 B).
3. **Wrap 0.01 AUSD** (and again for USDC):
   - `TransferLogic.createMintResources` builds an ephemeral consumed resource (`value_ref` = EVM address) and a persistent created note for Alice.
   - The action tree root becomes the Permit2 witness.
   - **What the user signs:** EIP-712 `PermitWitnessTransferFrom` with domain `{name:"Permit2", chainId:143, verifyingContract:Permit2}`, `permitted={token, amount:10000}`, `spender=forwarder`, random 256-bit `nonce`, `deadline`, and `witness={actionTreeRoot}`. The script prints the digest; the signature is 65 bytes.
   - It then prints the exact snake_case JSON body that **would** be POSTed to `/api/v1/transactions/monad` (1 consumed + 1 created).
4. **Private transfer 0.005 to Bob.** It spends the wrap's created note *as if it had landed* (synthetic, not on chain). `ParametersDraftResolver` adds padding and change. **What the user signs:** an AnomaPay authority signature (secp256k1, **64 bytes**, domain `TokenTransferAuthorization`) over the Merkle root of `[nullifier, commitment]` action pairs. No EVM wallet is involved. The body is 3.2 KB (4.6 KB with the fee note).
5. **Unwrap 0.005 to an EVM address.** A burn resource whose `value_ref` is the receiver address, signed the same way.
6. **`estimate-fee`** quotes, as tabled above. For AUSD every one returns `400 Fee estimation failed`.
7. **Indexer:** `GET /tags/<throwaway discovery sk>` → **404**. **STOP.** The SDK example's next step is `POST /add_key {public_key, secret_key}`, which registers the key server-side, so I did not call it.

**Where it stops, and why:**
- **Wrap/transfer/unwrap submission:** the next call would be `POST /api/v1/transactions/monad`. For AUSD the backend would reject it: the token is not supported.
- **Transfer/unwrap need a real note:** in the dry run they use a note that isn't in the commitment tree, so the backend would fail proving (membership).
- **Balance discovery needs indexer key registration.** Alternatively, a client could track its own created notes locally; the sender doesn't need the indexer to spend its own change.

Payload notes worth knowing:
- `consumedResources[].nullifierKey` is the user's **nk in base64**. With it the backend can compute every nullifier for that user, which means it can link all their spends.
- Created-witness public keys are `base64(JSON-quoted uppercase hex)`. That is what `PublicKey.toBase64()` emits; it looks odd but it is the SDK's real format.

## 4. Human-run tiny mainnet test (NOT executed)

AUSD cannot be tested through AnomaPay today, so use **USDC on Monad**; the flow would be identical for AUSD if Heliax listed it. Budget: 0.10 USDC plus ~0.05 MON. You need:
- a **fresh throwaway EVM wallet** (not the repo `.env` keys);
- two fresh AnomaPay keyrings (32-byte IKMs saved offline). Keyring A is the sender; keyring B is the second pay address.

```bash
export PATH=$PATH:~/.foundry/bin RPC=https://rpc.monad.xyz
USDC=0x754704bc059f8c67012fed69bc8a327a5aafb603
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
FWD=0x23dc44E1a1c3d5432EeC8A1c027e22ccDC0A8F54

cast wallet new                                   # throwaway EVM wallet; keep the key out of the repo
# fund it from your own wallet: 0.10 USDC + 0.05 MON (Monad charges gas *limit*)
cast call $USDC 'balanceOf(address)(uint256)' $TEST_ADDR --rpc-url $RPC

# BROADCAST #1 (the only tx you pay gas for): approve Permit2 for 0.05 USDC
cast send $USDC 'approve(address,uint256)' $PERMIT2 50000 --rpc-url $RPC --private-key $TEST_PK
```

Then adapt `dry-run.mjs`:
- **Fix the inputs:** `IKM_A`/`IKM_B` from env instead of random, `privateKeyToAccount(process.env.TEST_PK)`, `token = USDC`, `quantity = 50000`.
- **Wrap:** sign the Permit2 typed data, then `POST https://pay.prod.heliax.app/api/v1/transactions/monad` with the wrap body, which returns `{requestId}`. Poll `GET /api/v1/transactions/{requestId}` until `completed`. The statuses are pending → validating → proofGeneration → broadcast → completed. **BROADCAST #2 happens here**, done by Heliax's relayer: `PA.execute`, which emits `Wrapped(USDC, TEST_ADDR, 50000)`. Wrap fee is 0.
- **Private transfer A→B:** reuse the wrap's `createdResource` as A's note (no indexer needed). Quote the fee with `estimate-fee` (≈2808 for 6 resources), add the fee receiver (`monad.feePublicKeys`), sign with A's authority key, POST, and poll. This is **BROADCAST #3** (relayer), with no `Wrapped`/`Unwrapped` event.
- **Unwrap from B to an EVM address:** B must *discover* its note. Either register B's discovery key with the indexer (`POST galileo…/add_key`, which means sharing B's discovery secret with Heliax — owner's call), then `GET /tags/{sk}` → `deserializeResourcesPayload(B.encryptionSk, …)`. Or scan the PA `DiscoveryPayload`/`ResourcePayload` events yourself and decrypt locally. Then build an `EvmAddress` receiver plus the fee receiver, sign with B's authority key, and POST. This is **BROADCAST #4** (relayer) and emits `Unwrapped(USDC, dest, ≈0.0472)`.
- **Verify:** check `cast call $USDC 'balanceOf(address)(uint256)' $DEST`, the forwarder's USDC balance delta, and the PA `nullifierCount` increasing by 1 + 3 + 3.

The only thing you broadcast yourself is the Permit2 approve. Heliax relays the wrap, transfer and unwrap and pays the MON, and the user pays ~0.0028 USDC per transfer/unwrap. The anoma web app (`anoma/pay-interface-app`, URL not confirmed in this spike) is the no-code alternative.

## Uncertainties

- The fee formula is inferred from quotes. Quotes move with the MON price and gas price.
- The Permit2 `nonce` wire format (base64 of 32 bytes, read as a big-endian uint256) follows the SDK's own `buildForwarderWrapPermit2`. A real submit was not tested.
- Whether Heliax would list AUSD (it would need price feeds for fees) is unknown. Self-hosting a prover and relayer is possible in principle, since `execute` is permissionless and the forwarder accepts any ERC20. It would be a large effort: RISC Zero proving plus an indexer.
- Usage figures come from the monadscan HTML page and its 25 most recent txs, not a full log scan.
- `estimate-fee` is a POST. I treated it as a read-only quote; the payloads used only throwaway keys and non-existent notes.

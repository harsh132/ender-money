// AnomaPay dry run on Monad mainnet config. NEVER broadcasts, NEVER submits to the backend.
// Network calls made: GET  pay.prod.heliax.app/api/v1/configuration/all
//                     POST pay.prod.heliax.app/api/v1/transactions/monad/estimate-fee   (quote only; skip with NO_ESTIMATE=1)
//                     GET  galileo.prod.heliax.app/tags/<throwaway discovery sk>         (expected 404; skip with NO_INDEXER=1)
// NOT called: POST /api/v1/transactions/monad (submit), POST galileo/add_key (registers a key).
// Usage: node dry-run.mjs
import {
  initSdk,
  createUserKeyringFromIkm,
  extractUserPublicKeys,
  encodePayAddress,
  decodePayAddress,
  TransferBuilder,
  ParametersDraftResolver,
  PayloadBuilder,
  Resource,
} from "@anomaorg/anoma-app-sdk";
import { toBase64, toHex, fromHex } from "@anomaorg/anoma-app-sdk/primitives";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashTypedData, parseUnits } from "viem";

const BACKEND = "https://pay.prod.heliax.app";
const INDEXER = "https://galileo.prod.heliax.app";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const AUSD = { symbol: "AUSD", name: "AUSD", decimals: 6, address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", feeEnabled: true, network: "monad" };

const log = (title, v) => console.log(`\n=== ${title}\n` + (typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)));
const trim = s => (typeof s === "string" && s.length > 80 ? `${s.slice(0, 40)}…(${s.length} chars)` : s);
const trimDeep = o => JSON.parse(JSON.stringify(o, (_, x) => (typeof x === "bigint" ? x.toString() : trim(x))));
const keysHex = pk => Object.fromEntries(Object.entries(pk).map(([k, v]) => [k, toHex(v)]));

// Same mapping as examples/balance/src/main.ts (toChainConfig).
const toChainConfig = c => ({
  ...c,
  network: c.chain,
  tokens: c.tokens.map(t => ({ ...t, network: c.chain })),
  feePublicKeys: {
    authorityPublicKey: fromHex(`0x${c.feeAuthorityPk}`),
    discoveryPublicKey: fromHex(`0x${c.feeDiscoveryPk}`),
    encryptionPublicKey: fromHex(`0x${c.feeEncryptionPk}`),
    nullifierKeyCommitment: fromHex(`0x${c.feeNullifierKeyCommitment}`),
  },
});

// Backend wants snake_case resource fields (copied from SDK v0.18.1 src/api/formatParameters.ts, removed in 1.0).
const toWire = p => {
  const snake = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), v]));
  const arr = a => a.map(({ resource, ...rest }) => ({ ...rest, resource: snake(resource) }));
  return { ...p, consumedResources: arr(p.consumedResources), createdResources: arr(p.createdResources) };
};
const json = o => JSON.stringify(o, (_, x) => (typeof x === "bigint" ? x.toString() : x));

// initSdk() fetches its wasm via a file: URL, which Node's fetch rejects. Same shim as SDK src/tests/setup.ts.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.protocol !== "file:") return realFetch(input, init);
  return new Response(await readFile(url), { headers: { "content-type": "application/wasm" } });
};
await initSdk();

// 1. Config
const cfg = await (await fetch(`${BACKEND}/api/v1/configuration/all`)).json();
const monadRaw = cfg.configurations.find(c => c.chainId === 143);
const monad = toChainConfig(monadRaw);
log("Monad config (backend)", { enabled: monad.enabled, testnet: monad.testnet, protocolAdapter: monad.protocolAdapterAddress, forwarder: monad.forwarderAddress, baseFee: monad.baseFee, resourceFee: monad.resourceFee, percentageFee: monad.percentageFee, tokens: monad.tokens.map(t => t.symbol), ausdListed: monad.tokens.some(t => t.address.toLowerCase() === AUSD.address.toLowerCase()) });

// 2. Keyrings from throwaway IKM (same derivation the example uses: HKDF(ikm, "anoma-pay:keyring-seed")).
const ikmA = new Uint8Array(randomBytes(32));
const ikmB = new Uint8Array(randomBytes(32));
const alice = createUserKeyringFromIkm(ikmA, "anoma-pay:keyring-seed");
const bob = createUserKeyringFromIkm(ikmB, "anoma-pay:keyring-seed");
const alicePk = extractUserPublicKeys(alice);
const bobPk = extractUserPublicKeys(bob);
const alicePay = encodePayAddress(alicePk);
const bobPay = encodePayAddress(bobPk);
if (encodePayAddress(decodePayAddress(alicePay)) !== alicePay) throw new Error("pay address roundtrip failed");
log("Alice (sender) pay address", `${alicePay}\n(length ${alicePay.length} chars)`);
log("Alice public keys (hex)", keysHex(alicePk));
log("Bob (recipient) pay address", bobPay);

// Throwaway EVM wallet that would fund the wrap (never funded, never broadcasts).
const evm = privateKeyToAccount(generatePrivateKey());
log("Throwaway EVM wallet", evm.address);

const builder = await TransferBuilder.init(monad.transferLogicVerifyingKey, monad.trivialLogicVerifyingKey);

function buildFlows(token) {
  const out = {};
  // ---- WRAP (deposit) 0.01 token: EVM wallet -> Alice shielded note
  const qty = parseUnits("0.01", token.decimals);
  const mint = builder.client.createMintResources({ userAddress: evm.address, forwarderAddress: monad.forwarderAddress, token: token.address, quantity: qty, keyring: alice });
  const actionTreeRoot = `0x${mint.actionTree.root().toHex().replace(/^0x/, "")}`;
  const nonceBytes = new Uint8Array(randomBytes(32));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const typedData = {
    domain: { name: "Permit2", chainId: 143, verifyingContract: PERMIT2 },
    types: {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
      Witness: [{ name: "actionTreeRoot", type: "bytes32" }],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: { permitted: { token: token.address, amount: qty }, spender: monad.forwarderAddress, nonce: BigInt(toHex(nonceBytes)), deadline: BigInt(deadline), witness: { actionTreeRoot } },
  };
  out.wrapTypedData = typedData;
  out.wrapDigest = hashTypedData(typedData);
  out.signTypedData = evm.signTypedData(typedData); // promise; local signing only
  out.mint = mint;
  out.nonceBytes = nonceBytes;
  out.deadline = deadline;
  out.qty = qty;
  return out;
}

async function run(token, fee) {
  const f = buildFlows(token);
  const sig = await f.signTypedData;
  const permit2Data = { deadline: f.deadline, nonce: toBase64(f.nonceBytes), signature: toBase64(fromHex(sig)) };
  const wrapParams = builder.buildMintParameters({ createdResource: f.mint.createdResource, consumedResource: f.mint.consumedResource }, permit2Data, evm.address, token.address, alice);

  // Pretend the wrap landed: Alice's created note becomes a spendable AppResource (it is NOT on chain).
  const note = { ...f.mint.createdResource.encode(), chainId: 143, network: "monad", erc20TokenAddress: token.address, forwarder: monad.forwarderAddress };

  const priv = (receivers) => {
    const r = new ParametersDraftResolver(builder, alicePk, alice.nullifierKeyPair.nk, monad);
    receivers.forEach(x => r.addReceiver(x));
    const resolved = r.build([note]);
    const pb = new PayloadBuilder(resolved).withAuthorization(alice.authorityKeyPair.privateKey);
    const actions = resolved.consumeIntents.flatMap((c, i) => [c.resource.nullifier(c.nullifierKey).toHex(), resolved.createIntents[i].resource.commitment().toHex()]);
    return { params: pb.build(), actions, sigBytes: pb.authorizationSignature.toBytes().length };
  };
  const feeRx = fee > 0n ? [{ type: "AnomaAddress", userPublicKeys: monad.feePublicKeys, quantity: fee, token }] : [];
  const transfer = priv([{ type: "AnomaAddress", userPublicKeys: bobPk, quantity: f.qty / 2n, token }, ...feeRx]);
  const unwrap = priv([{ type: "EvmAddress", address: evm.address, quantity: f.qty / 2n, token }, ...feeRx]);
  return { f, sig, wrapParams, transfer, unwrap };
}

const estimateFee = async (feeToken, params) => {
  const r = await fetch(`${BACKEND}/api/v1/transactions/monad/estimate-fee`, { method: "POST", headers: { "content-type": "application/json" }, body: json({ feeToken, transaction: toWire(params) }) });
  return { status: r.status, body: await r.text() };
};

for (const token of [AUSD, monad.tokens.find(t => t.symbol === "USDC")]) {
  console.log(`\n\n##################### ${token.symbol} (${token.address}) #####################`);
  const { f, sig, wrapParams, transfer, unwrap } = await run(token, 0n);

  log(`WRAP 0.01 ${token.symbol}: what the EVM wallet signs (EIP-712 Permit2 PermitWitnessTransferFrom)`, f.wrapTypedData);
  log("WRAP: EIP-712 digest / signature", { digest: f.wrapDigest, signatureBytes: (sig.length - 2) / 2, actionTreeRoot: f.wrapTypedData.message.witness.actionTreeRoot });
  log(`WRAP: body that WOULD be POSTed to ${BACKEND}/api/v1/transactions/monad (NOT sent)`, trimDeep(toWire(wrapParams)));

  log(`PRIVATE TRANSFER 0.005 ${token.symbol} Alice -> Bob: actions Alice's authority key signs (nullifier, commitment pairs)`, transfer.actions);
  log("TRANSFER: authority signature", { domain: "TokenTransferAuthorization", scheme: "secp256k1 over MerkleTree(actions) root (arm-bindings AuthoritySigningKey.authorize)", signatureBytes: transfer.sigBytes, consumed: transfer.params.consumedResources.length, created: transfer.params.createdResources.length, bodyBytes: json(toWire(transfer.params)).length });
  log("TRANSFER: body that WOULD be POSTed (NOT sent) — note consumedResources[].nullifierKey is Alice's nk in cleartext", trimDeep(toWire(transfer.params)));

  log(`UNWRAP 0.005 ${token.symbol} -> ${evm.address}`, { actions: unwrap.actions.length, signatureBytes: unwrap.sigBytes, createdWitness: unwrap.params.createdResources.map(c => Object.keys(c.witnessData)[0]), bodyBytes: json(toWire(unwrap.params)).length });

  if (!process.env.NO_ESTIMATE) {
    log(`estimate-fee (read-only quote) feeToken=${token.symbol}, tx=transfer`, await estimateFee(token.address, transfer.params));
    log(`estimate-fee (read-only quote) feeToken=${token.symbol}, tx=unwrap`, await estimateFee(token.address, unwrap.params));
    log(`estimate-fee (read-only quote) feeToken=${token.symbol}, tx=wrap`, await estimateFee(token.address, wrapParams));
    // Second pass: add the quoted fee as an extra receiver (Heliax fee keys), as SwapResolver does, and re-quote.
    const q = await estimateFee(token.address, transfer.params);
    if (q.status === 200) {
      const fee = BigInt(JSON.parse(q.body).baseFee);
      const withFee = await run(token, fee);
      log(`TRANSFER incl. fee ${fee} (${token.symbol} base units)`, { consumed: withFee.transfer.params.consumedResources.length, created: withFee.transfer.params.createdResources.length, tags: withFee.transfer.actions.length, bodyBytes: json(toWire(withFee.transfer.params)).length, requote: await estimateFee(token.address, withFee.transfer.params) });
      log(`UNWRAP incl. fee ${fee}`, { tags: withFee.unwrap.actions.length, requote: await estimateFee(token.address, withFee.unwrap.params) });
    }
  }
}

// Indexer: balance discovery needs the discovery PRIVATE key in the URL path. Unknown key -> 404 -> SDK example then POSTs /add_key (registers key server-side). We stop at the 404.
if (!process.env.NO_INDEXER) {
  const r = await fetch(`${INDEXER}/tags/${toHex(alice.discoveryKeyPair.privateKey)}`);
  log("Indexer GET /tags/<throwaway discovery sk>", { status: r.status, body: (await r.text()).slice(0, 300), next: "STOP: example would POST /add_key {public_key, secret_key} — not called" });
}
console.log("\nDone. Nothing was broadcast or submitted.");

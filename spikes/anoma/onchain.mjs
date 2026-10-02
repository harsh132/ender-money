// Read-only: receipts for recent Protocol Adapter txs on Monad (hashes scraped from monadscan into evidence/pa_recent_txs.txt).
// Usage: node onchain.mjs
import { readFileSync } from "node:fs";
import { keccak256, toBytes, decodeAbiParameters, formatUnits } from "viem";

const RPC = "https://rpc.monad.xyz";
const FW = "0x23dc44e1a1c3d5432eec8a1c027e22ccdc0a8f54";
const TOKENS = {
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": ["USDC", 6],
  "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242": ["WETH", 18],
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d": ["USDT0", 6],
  "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": ["WMON", 18],
};
const topic = s => keccak256(toBytes(s));
const T = {
  [topic("Wrapped(address,address,uint128)")]: "Wrapped",
  [topic("Unwrapped(address,address,uint128)")]: "Unwrapped",
  [topic("TransactionExecuted(bytes32[],bytes32[])")]: "TransactionExecuted",
};
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};

const hashes = readFileSync(new URL("./evidence/pa_recent_txs.txt", import.meta.url), "utf8").match(/0x[0-9a-f]{64}/g);
const rows = [];
for (const h of hashes) {
  const [rc, tx] = await Promise.all([rpc("eth_getTransactionReceipt", [h]), rpc("eth_getTransactionByHash", [h])]);
  const blk = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]);
  const ev = [];
  let tags = 0;
  for (const l of rc.logs) {
    const name = T[l.topics[0]];
    if (name === "TransactionExecuted") tags = decodeAbiParameters([{ type: "bytes32[]" }, { type: "bytes32[]" }], l.data)[0].length;
    if ((name === "Wrapped" || name === "Unwrapped") && l.address.toLowerCase() === FW) {
      const token = "0x" + l.topics[1].slice(26);
      const [sym, dec] = TOKENS[token] ?? [token, 0];
      ev.push(`${name} ${formatUnits(BigInt(l.data), dec)} ${sym}`);
    }
  }
  rows.push({
    hash: h.slice(0, 12),
    time: new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 16),
    status: rc.status,
    gasUsed: Number(rc.gasUsed),
    gasLimit: Number(tx.gas),
    gwei: Number(rc.effectiveGasPrice) / 1e9,
    feeMON: (Number(rc.gasUsed) * Number(rc.effectiveGasPrice)) / 1e18,
    calldataBytes: (tx.input.length - 2) / 2,
    tags,
    from: tx.from.slice(0, 10),
    ev: ev.join("; "),
  });
}
console.table(rows);
const g = rows.map(r => r.gasUsed).sort((a, b) => a - b);
console.log(JSON.stringify({ n: g.length, minGas: g[0], medianGas: g[g.length >> 1], maxGas: g.at(-1), senders: [...new Set(rows.map(r => r.from))] }));

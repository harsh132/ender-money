#!/usr/bin/env bash
# Compile circuits, Groth16 setup + one contribution per circuit, export verifiers. TESTNET ONLY (single party).
# Needs build/pot17_final.ptau (scripts/ptau.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
P=${POWER:-17}
SNARKJS="node node_modules/snarkjs/build/cli.cjs"
mkdir -p build contracts/generated
t() { local s=$(date +%s); "$@"; echo "[time] $(( $(date +%s) - s ))s: ${*:1:5}" | tee -a build/timings.log; }
node scripts/gen-hasher.mjs
for n in 2 16; do
  # --O2 = full linear simplification, the equivalent of circom 0.5's default (Nova built with defaults).
  t ./bin/circom.exe circuits/transaction$n.circom --O2 --r1cs --wasm --sym --inspect -l node_modules -o build
  t $SNARKJS groth16 setup build/transaction$n.r1cs build/pot${P}_final.ptau build/transaction${n}_0.zkey
  t $SNARKJS zkey contribute build/transaction${n}_0.zkey build/transaction$n.zkey --name="ender spike" -e="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  rm build/transaction${n}_0.zkey
  t $SNARKJS zkey verify build/transaction$n.r1cs build/pot${P}_final.ptau build/transaction$n.zkey
  $SNARKJS zkey export verificationkey build/transaction$n.zkey build/transaction${n}_vkey.json
  $SNARKJS zkey export solidityverifier build/transaction$n.zkey contracts/generated/Verifier$n.sol
  sed -i "s/contract Groth16Verifier/contract Verifier$n/" contracts/generated/Verifier$n.sol
  $SNARKJS r1cs info build/transaction$n.r1cs
done

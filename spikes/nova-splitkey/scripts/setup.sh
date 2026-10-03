#!/usr/bin/env bash
# Compile the split-key transaction2, Groth16 setup + one contribution, export the verifier. TESTNET ONLY (single party).
# Reuses the power-17 ptau from ../nova-circom2 (generating one takes ~25 min: see that spike's scripts/ptau.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
PTAU=${PTAU:-../nova-circom2/build/pot17_final.ptau}
SNARKJS="node node_modules/snarkjs/build/cli.cjs"
mkdir -p build contracts/generated
t() { local s=$(date +%s); "$@"; echo "[time] $(( $(date +%s) - s ))s: ${*:1:5}" | tee -a build/timings.log; }
node scripts/gen-hasher.mjs
# probe: the authorization block alone, to measure what EdDSA adds
./bin/circom.exe circuits/eddsaProbe.circom --O2 --r1cs -l node_modules -o build
$SNARKJS r1cs info build/eddsaProbe.r1cs
t ./bin/circom.exe circuits/transaction2.circom --O2 --r1cs --wasm --sym --inspect -l node_modules -o build
t $SNARKJS groth16 setup build/transaction2.r1cs $PTAU build/transaction2_0.zkey
t $SNARKJS zkey contribute build/transaction2_0.zkey build/transaction2.zkey --name="ender splitkey spike" -e="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
rm build/transaction2_0.zkey
t $SNARKJS zkey verify build/transaction2.r1cs $PTAU build/transaction2.zkey
$SNARKJS zkey export verificationkey build/transaction2.zkey build/transaction2_vkey.json
$SNARKJS zkey export solidityverifier build/transaction2.zkey contracts/generated/Verifier2.sol
sed -i "s/contract Groth16Verifier/contract Verifier2/" contracts/generated/Verifier2.sol
$SNARKJS r1cs info build/transaction2.r1cs

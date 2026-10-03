#!/usr/bin/env bash
# Compile the split-key transaction2/6/12, Groth16 setup + one contribution each, export the verifiers. TESTNET ONLY (single party).
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
for n in ${CIRCUITS:-2 6 12}; do
  c=transaction$n
  t ./bin/circom.exe circuits/$c.circom --O2 --r1cs --wasm --sym --inspect -l node_modules -o build
  t $SNARKJS groth16 setup build/$c.r1cs $PTAU build/${c}_0.zkey
  t $SNARKJS zkey contribute build/${c}_0.zkey build/$c.zkey --name="ender splitkey spike" -e="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  rm build/${c}_0.zkey
  t $SNARKJS zkey verify build/$c.r1cs $PTAU build/$c.zkey
  $SNARKJS zkey export verificationkey build/$c.zkey build/${c}_vkey.json
  $SNARKJS zkey export solidityverifier build/$c.zkey contracts/generated/Verifier$n.sol
  sed -i "s/contract Groth16Verifier/contract Verifier$n/" contracts/generated/Verifier$n.sol
  $SNARKJS r1cs info build/$c.r1cs
done

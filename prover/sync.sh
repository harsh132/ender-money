#!/usr/bin/env bash
# Copy what the image bakes in from the split-key spike into assets/ (gitignored): circuit sources + circomlib (to build the
# C++ witness generators), the spike's .r1cs (the Docker build checks its own compile against them byte for byte), and the
# EXISTING zkeys + vkeys. Never regenerate the zkeys: the deployed testnet verifiers only accept proofs for these.
set -euo pipefail
cd "$(dirname "$0")"
S=../spikes/nova-splitkey
rm -rf assets
mkdir -p assets/circuits assets/lib/circomlib assets/keys
cp $S/circuits/{transaction,merkleProof,transaction2,transaction6,transaction12}.circom assets/circuits/
cp -r $S/node_modules/circomlib/circuits assets/lib/circomlib/
for n in 2 6 12; do cp $S/build/transaction$n.{zkey,r1cs} $S/build/transaction${n}_vkey.json assets/keys/; done
sha256sum assets/keys/*.zkey

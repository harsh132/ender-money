#!/usr/bin/env bash
# Local single-party powers of tau (TESTNET ONLY). Power 17 covers transaction16 (106,179 constraints at --O2).
set -euo pipefail
cd "$(dirname "$0")/.."
P=${POWER:-17}
mkdir -p build
t() { local s=$(date +%s); "$@"; echo "[time] $(( $(date +%s) - s ))s: ${*:1:4}" | tee -a build/timings.log; }
SNARKJS="node node_modules/snarkjs/build/cli.cjs"
t $SNARKJS powersoftau new bn128 $P build/pot${P}_0.ptau
t $SNARKJS powersoftau contribute build/pot${P}_0.ptau build/pot${P}_1.ptau --name="ender spike" -e="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
t $SNARKJS powersoftau prepare phase2 build/pot${P}_1.ptau build/pot${P}_final.ptau
rm build/pot${P}_0.ptau build/pot${P}_1.ptau

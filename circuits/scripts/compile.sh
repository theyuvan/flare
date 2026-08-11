#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

# circomlib must be installed HERE first — derived_ownership.circom includes
# "node_modules/circomlib/circuits/poseidon.circom", which only resolves after
# this step. Skipping it is what breaks the build on a clean checkout.
echo "Installing circomlib..."
npm install

echo "Compiling circuit..."
mkdir -p build
circom src/derived_ownership.circom \
  --r1cs --wasm --sym \
  --output build/ \
  --include node_modules

echo "Done. Artifacts in circuits/build/"

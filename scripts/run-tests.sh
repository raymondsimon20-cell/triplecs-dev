#!/usr/bin/env bash
# Compile + run the engine rule tests.
# Output: PASS/FAIL per test, exit code 0 on success.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf scripts/dist
./node_modules/.bin/tsc --project scripts/tsconfig.test.json
node scripts/dist/scripts/test-engine-rules.js

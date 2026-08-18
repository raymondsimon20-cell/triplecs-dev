#!/usr/bin/env bash
# Compile + run the test suites.
# Output: PASS/FAIL per test, exit code 0 only if every suite passes.
#
# verify-position-math was previously run by hand and drifted out of the suite,
# which is how a $3,919 day-change error reached the dashboard unnoticed. Both
# suites run every time now, and a failure in one does not mask the other.
set -uo pipefail
cd "$(dirname "$0")/.."
rm -rf scripts/dist

fail=0

./node_modules/.bin/tsc --project scripts/tsconfig.test.json || exit 1
node scripts/dist/scripts/test-engine-rules.js || fail=1

echo
./node_modules/.bin/tsc --project scripts/tsconfig.position-math.test.json || exit 1
node scripts/dist/scripts/verify-position-math.js || fail=1

echo
./node_modules/.bin/tsc --project scripts/tsconfig.cash-category.test.json || exit 1
node scripts/dist/scripts/test-cash-category.js || fail=1

echo
./node_modules/.bin/tsc --project scripts/tsconfig.performance.test.json || exit 1
node scripts/dist/scripts/test-performance.js || fail=1

exit $fail

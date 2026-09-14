#!/usr/bin/env bash
# Check out zipp.org beside this repository at the revision the vendored
# engine records, for the Rust host (apps/softn-host-rust depends on
# crates/zipp-vm by sibling path). The pin is packages/@softn/core/wasm-zipp/
# SOURCE.json, the same revision the engine bytes in that folder were built
# from, so the host's VM and the runtime's engine come from one commit.
# Mirrors checkout-xdb.sh.
set -euo pipefail
ZIPP_REPOSITORY="https://github.com/f2i-com/zipp.org.git"
SOURCE_JSON="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}/packages/@softn/core/wasm-zipp/SOURCE.json"
ZIPP_COMMIT="$(sed -n 's/^[[:space:]]*"revision":[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "$SOURCE_JSON")"
if [[ ! "$ZIPP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "No 40-character revision in $SOURCE_JSON" >&2
  exit 1
fi
ZIPP_DESTINATION="${GITHUB_WORKSPACE}/../zipp.org"
if [[ -e "$ZIPP_DESTINATION" ]]; then
  echo "Refusing to replace existing ZIPP checkout: $ZIPP_DESTINATION" >&2
  exit 1
fi
git init --quiet "$ZIPP_DESTINATION"
git -C "$ZIPP_DESTINATION" remote add origin "$ZIPP_REPOSITORY"
git -C "$ZIPP_DESTINATION" fetch --quiet --depth 1 origin "$ZIPP_COMMIT"
git -C "$ZIPP_DESTINATION" checkout --quiet --detach FETCH_HEAD
checked_out_commit="$(git -C "$ZIPP_DESTINATION" rev-parse HEAD)"
if [[ "$checked_out_commit" != "$ZIPP_COMMIT" ]]; then
  echo "ZIPP checkout mismatch: expected $ZIPP_COMMIT, got $checked_out_commit" >&2
  exit 1
fi
echo "Checked out zipp.org at $checked_out_commit"

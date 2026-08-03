#!/usr/bin/env bash
set -euo pipefail

# The loader consumes XDB as a Cargo path dependency. Keep the revision here so
# build and release workflows can never drift apart; update this one value when
# deliberately adopting a newer XDB commit.
XDB_REPOSITORY="https://github.com/f2i-com/xdb.org.git"
XDB_COMMIT="fe6d06f82c7df0b3cf46d439bedd1532d913b745"
XDB_DESTINATION="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}/../xdb.org"

if [[ -e "$XDB_DESTINATION" ]]; then
  echo "Refusing to replace existing XDB checkout: $XDB_DESTINATION" >&2
  exit 1
fi

git init --quiet "$XDB_DESTINATION"
git -C "$XDB_DESTINATION" remote add origin "$XDB_REPOSITORY"
git -C "$XDB_DESTINATION" fetch --quiet --depth 1 origin "$XDB_COMMIT"
git -C "$XDB_DESTINATION" checkout --quiet --detach FETCH_HEAD

checked_out_commit="$(git -C "$XDB_DESTINATION" rev-parse HEAD)"
if [[ "$checked_out_commit" != "$XDB_COMMIT" ]]; then
  echo "XDB checkout mismatch: expected $XDB_COMMIT, got $checked_out_commit" >&2
  exit 1
fi

echo "Checked out xdb.org at $checked_out_commit"

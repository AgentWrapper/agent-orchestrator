#!/usr/bin/env bash
# Fails if any @deprecated JSDoc tag is missing a concrete cutoff marker.
# Accepted: `@deprecated v<num>` or `@deprecated removeBy=YYYY[-Q1..4|-MM-DD]`.
# Rejects `removeBy=TBD` and similar placeholders.
# Policy: without a cutoff, deprecation becomes permanent. See issue #1430.
set -euo pipefail
bad=$(grep -rn --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=coverage \
  '@deprecated' . \
  | grep -Ev '@deprecated[[:space:]]+(v[0-9][0-9.]*|removeBy=[0-9]{4}(-Q[1-4]|-[0-9]{2}-[0-9]{2})?)([[:space:]]|$)' \
  || true)
if [ -n "$bad" ]; then
  echo "Found @deprecated without cutoff marker (v<num> or removeBy=YYYY[-QN|-MM-DD]):"
  echo "$bad"
  exit 1
fi

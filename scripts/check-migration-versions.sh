#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
migrations_dir="backend/internal/storage/sqlite/migrations"
base_ref="${1:-}"

declare -A seen
status=0

while IFS= read -r -d '' file; do
  name="${file##*/}"
  version="${name%%_*}"
  if [[ ! "$version" =~ ^[0-9]+$ ]]; then
    echo "migration filename has no numeric prefix: $file" >&2
    status=1
    continue
  fi

  numeric=$((10#$version))
  if [[ -n "${seen[$numeric]:-}" ]]; then
    echo "duplicate migration version $numeric: ${seen[$numeric]} vs $file" >&2
    status=1
  else
    seen[$numeric]="$file"
  fi
done < <(find "$repo_root/$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z)

if [[ -n "$base_ref" ]]; then
  while IFS= read -r file; do
    [[ "$file" == "$migrations_dir"/*.sql ]] || continue
    [[ -f "$repo_root/$file" ]] || continue

    name="${file##*/}"
    version="${name%%_*}"
    [[ "$version" =~ ^[0-9]+$ ]] || continue
    numeric=$((10#$version))

    if git cat-file -e "$base_ref:$migrations_dir" 2>/dev/null &&
      git ls-tree -r --name-only "$base_ref" -- "$migrations_dir" |
        awk -F/ -v n="$numeric" '
          {
            split($NF, parts, "_")
            if (parts[1] ~ /^[0-9]+$/ && parts[1] + 0 == n) {
              found=1
            }
          }
          END { exit found ? 0 : 1 }
        '; then
      echo "migration version $numeric from $file already exists on $base_ref" >&2
      status=1
    fi
  done < <(git diff --name-only --diff-filter=A "$base_ref" HEAD -- "$migrations_dir")
fi

exit "$status"

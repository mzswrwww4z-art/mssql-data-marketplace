#!/usr/bin/env bash
# Save the SQL Server DSN for the mssql-data plugin in Claude Code's secure storage.
# The DSN is read without echo, so it never appears on screen, in shell history, or on disk.
#
# Usage:
#   ./set-dsn.sh           prompt for the DSN and save it
#   ./set-dsn.sh --which   only show which Claude Code CLI would be used
set -euo pipefail

readonly PLUGIN_ID="mssql-data@mssql-data-marketplace"
readonly MIN_VERSION="2.1.285"   # first version with `claude plugin configure`

version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

find_cli() {
  local path version
  if path="$(command -v claude 2>/dev/null)"; then
    version="$(claude --version 2>/dev/null | awk '{ print $1 }')"
    if [ -n "$version" ] && version_at_least "$version" "$MIN_VERSION"; then
      printf '%s\n' "$path"
      return 0
    fi
  fi
  # Fall back to the newest Claude Code bundled with the Claude desktop app.
  path="$(ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$path" ] && [ -x "$path" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  echo "Claude Code >= $MIN_VERSION not found. Upgrade it: 'brew upgrade --cask claude-code' (Homebrew) or 'claude update' (native installer)." >&2
  return 1
}

cli="$(find_cli)"
if [ "${1:-}" = "--which" ]; then
  printf 'Would use: %s (%s)\n' "$cli" "$("$cli" --version 2>/dev/null)"
  exit 0
fi

python3 -c 'import getpass, json, sys; sys.stdout.write(json.dumps({"dsn": getpass.getpass("SQL Server DSN (input hidden): ")}))' \
  | "$cli" plugin configure "$PLUGIN_ID" --values-stdin

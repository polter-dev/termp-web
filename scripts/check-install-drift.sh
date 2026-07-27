#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
canonical_url="https://raw.githubusercontent.com/polter-dev/discord_terminal_presence/main/install.sh"
downloaded_script=$(mktemp "${TMPDIR:-/tmp}/termp-install.XXXXXX")

trap 'rm -f "$downloaded_script"' EXIT HUP INT TERM

if ! curl --fail --silent --show-error --location \
  "$canonical_url" \
  --output "$downloaded_script"; then
  echo "Failed to download canonical installer from $canonical_url" >&2
  exit 1
fi

if ! diff -u "$repo_root/src/install.txt" "$downloaded_script"; then
  echo "Vendored install script has drifted from $canonical_url" >&2
  exit 1
fi

echo "Vendored install script matches $canonical_url"

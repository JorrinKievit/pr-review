#!/bin/sh
# Installs the PR Review companion, the local program that runs git and your AI agents for the extension.
#
# Browsers only start a local program that has been registered with them, and an extension cannot register one
# itself: it may not write files or the Windows registry. This script does that once. It downloads the companion,
# writes a launcher for it and tells Chrome, Edge and Firefox where that launcher is. The browser then starts the
# companion while a review tab is open and stops it after.
#
#   curl -fsSL https://github.com/JorrinKievit/pr-review/releases/download/v<version>/install.sh | sh -s -- [--extension-id <id>]
set -eu

version=__VERSION__
tarball=${PR_REVIEW_TARBALL:-https://github.com/JorrinKievit/pr-review/releases/download/v$version/pr-review-companion.tar.gz}
dir="$HOME/.local/share/pr-review"

if ! command -v node >/dev/null 2>&1; then
  echo "PR Review needs Node 24 or later (https://nodejs.org). Install it, then run this again." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "PR Review needs Node 24 or later; this is Node $(node --version). Update it, then run this again." >&2
  exit 1
fi

echo "Downloading the PR Review companion $version"
mkdir -p "$dir"
tmp=$(mktemp -d "$dir/.companion.XXXXXX")
case $tarball in
  http*) curl -fsSL "$tarball" | tar -xz -C "$tmp" ;;
  *) tar -xzf "$tarball" -C "$tmp" ;;
esac
rm -rf "$dir/companion"
mv "$tmp" "$dir/companion"

echo "Registering it with your browsers"
exec node "$dir/companion/dist/main.mjs" install "$@"

#!/usr/bin/env bash
# Copies player assets from ./src to Anki's collection.media.
# Usage: ./scripts/deploy-macos-linux.sh
# Optionally override destination: ANKI_MEDIA="/path/to/collection.media" ./scripts/deploy-macos-linux.sh

set -euo pipefail

# --- CONFIG ---
# If ANKI_MEDIA is not set, try common defaults (macOS first, then Linux).
if [[ -z "${ANKI_MEDIA:-}" ]]; then
  if [[ -d "$HOME/Library/Application Support/Anki2/User 1/collection.media" ]]; then
    ANKI_MEDIA="$HOME/Library/Application Support/Anki2/User 1/collection.media"
  elif [[ -d "$HOME/.local/share/Anki2/User 1/collection.media" ]]; then
    ANKI_MEDIA="$HOME/.local/share/Anki2/User 1/collection.media"
  else
    echo "✗ Could not auto-detect Anki media folder."
    echo "  Please set ANKI_MEDIA env var, e.g.:"
    echo "    ANKI_MEDIA=\"$HOME/Library/Application Support/Anki2/User 1/collection.media\" ./scripts/deploy-macos-linux.sh"
    exit 1
  fi
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src"

FILES=(
  "_player.js"
  "_player.css"
  "_7.10.1_wavesurfer.esm.min.js"
  "_7.10.1-regions.esm.min.js"
)

echo "→ Source: $SRC"
echo "→ Dest:   $ANKI_MEDIA"
echo

# Sanity checks
[[ -d "$SRC" ]] || { echo "✗ Missing src folder: $SRC"; exit 1; }
[[ -d "$ANKI_MEDIA" ]] || { echo "✗ Missing Anki media folder: $ANKI_MEDIA"; exit 1; }

# Copy
for f in "${FILES[@]}"; do
  from="$SRC/$f"
  to="$ANKI_MEDIA/$f"
  [[ -f "$from" ]] || { echo "✗ Missing file: $from"; exit 1; }
  cp -f "$from" "$to"
  echo "✓ Copied $f"
done

echo
echo "✔ Deployed ${#FILES[@]} files to:"
echo "  $ANKI_MEDIA"
echo "Tip: Refresh Anki's preview (or sync on mobile) to pick up changes."

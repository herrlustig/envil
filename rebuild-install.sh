#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Stamp the build so the running extension can be identified unambiguously
STAMP=$(date +%Y%m%d-%H%M%S)
sed -i "s/^const ENVIL_BUILD_STAMP = .*/const ENVIL_BUILD_STAMP = '$STAMP';   \/\/ rewritten by rebuild-install.sh/" extension.js
echo "==> Build stamp: $STAMP"

echo "==> Installing root dependencies..."
npm install

echo "==> Compiling TypeScript (client + server)..."
npm run compile

echo "==> Packaging extension..."
npx vsce package --allow-star-activation 2>&1 | tail -5

VSIX=$(ls -t "$SCRIPT_DIR"/*.vsix | head -1)
echo "==> Installing $VSIX ..."
code --install-extension "$VSIX" --force

echo ""
echo "✅ Done! Reload VS Code window to apply changes (Ctrl+Shift+P → Developer: Reload Window)."

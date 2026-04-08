#!/usr/bin/env bash
# ============================================================
# build.sh — Full Nput project build
#
# Builds everything you need for both distribution targets:
#
#   1. Rust backend binary (release)
#   2. Electron TypeScript → dist/
#   3. Web renderer TypeScript → web/
#   4. electron-builder AppImage (Linux) or NSIS installer (Win)
#
# Usage:
#   ./build.sh              # backend + frontend only (no package)
#   ./build.sh --package    # also run electron-builder (AppImage)
#   ./build.sh --package-win # also run electron-builder (NSIS)
#
# The web overlay is always built into web/ and served by the
# Rust HTTP server at http://localhost:8766.
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"

# ── Colours (only if we're in a real terminal) ───────────────

if [ -t 1 ]; then
  C_BOLD='\033[1m'
  C_GREEN='\033[0;32m'
  C_BLUE='\033[0;34m'
  C_YELLOW='\033[0;33m'
  C_RED='\033[0;31m'
  C_RESET='\033[0m'
else
  C_BOLD='' C_GREEN='' C_BLUE='' C_YELLOW='' C_RED='' C_RESET=''
fi

step()  { echo -e "${C_BOLD}${C_BLUE}▶ $*${C_RESET}"; }
ok()    { echo -e "${C_GREEN}  ✓ $*${C_RESET}"; }
warn()  { echo -e "${C_YELLOW}  ! $*${C_RESET}"; }
die()   { echo -e "${C_RED}  ✗ $*${C_RESET}" >&2; exit 1; }

# ── Arg parsing ──────────────────────────────────────────────

DO_PACKAGE=0
DO_PACKAGE_WIN=0

for arg in "$@"; do
  case "$arg" in
    --package)     DO_PACKAGE=1     ;;
    --package-win) DO_PACKAGE_WIN=1 ;;
    --help|-h)
      sed -n '2,/^[^#]/{ /^#/!d; s/^# \{0,2\}//; p }' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

# ── Step 1: Rust backend ──────────────────────────────────────

step "Building Rust backend (release)…"
cd "$BACKEND_DIR"

cargo build --release 2>&1 | grep -E '^(error|warning\[|   = )' || true
# Run it again cleanly to surface real errors if grep ate them
cargo build --release

BINARY="$BACKEND_DIR/target/release/nput-backend"
[ -f "$BINARY" ] || die "Binary not found after build: $BINARY"
ok "backend → $BINARY"

# ── Step 2: Electron TypeScript ──────────────────────────────

step "Installing frontend npm dependencies…"
cd "$FRONTEND_DIR"

if [ ! -d node_modules ]; then
  npm install
  ok "npm install done"
else
  ok "node_modules already present (run 'npm install' to refresh)"
fi

step "Compiling Electron renderer (tsc)…"
npm run build
ok "Electron dist → $FRONTEND_DIR/dist/"

# ── Step 3: Web renderer ─────────────────────────────────────

step "Compiling web renderer (tsc -p tsconfig.web.json)…"
npx tsc -p tsconfig.web.json
ok "Web renderer → $ROOT/web/web-renderer.js"

# ── Step 4: Packaging (optional) ─────────────────────────────

if [ "$DO_PACKAGE" -eq 1 ]; then
  step "Packaging AppImage (Linux x64)…"
  npm run dist:linux
  ok "AppImage → $ROOT/dist-app/"
fi

if [ "$DO_PACKAGE_WIN" -eq 1 ]; then
  step "Building Rust backend (Windows x64 cross-compile)…"
  cd "$BACKEND_DIR"
  cargo build --release --target x86_64-pc-windows-gnu
  WIN_BINARY="$BACKEND_DIR/target/x86_64-pc-windows-gnu/release/nput-backend.exe"
  [ -f "$WIN_BINARY" ] || die "Windows binary not found after build: $WIN_BINARY"
  ok "Windows backend → $WIN_BINARY"
  cd "$FRONTEND_DIR"
  step "Packaging NSIS installer (Windows x64)…"
  npm run dist:win
  ok "Installer → $ROOT/dist-app/"
fi

# ── Done ─────────────────────────────────────────────────────

echo ""
echo -e "${C_BOLD}${C_GREEN}All done!${C_RESET}"
echo ""
echo "  Dev mode:     npm run start        (from frontend/)"
echo "  Backend only: cargo run --release  (from backend/)"
echo "  OBS overlay:  http://127.0.0.1:8766"
echo "  WebSocket:    ws://127.0.0.1:8765"
echo ""
if [ "$DO_PACKAGE" -eq 0 ] && [ "$DO_PACKAGE_WIN" -eq 0 ]; then
  warn "Re-run with --package to build the distributable AppImage."
fi

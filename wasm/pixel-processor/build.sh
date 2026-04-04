#!/usr/bin/env bash
# Build the pixel-processor WebAssembly module.
# Requires: rustup with wasm32-unknown-unknown target
#   rustup target add wasm32-unknown-unknown
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_DIR="$SCRIPT_DIR"
OUT_DIR="$SCRIPT_DIR/../../js"

cargo build \
  --manifest-path "$CRATE_DIR/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

cp "$CRATE_DIR/target/wasm32-unknown-unknown/release/pixel_processor.wasm" \
   "$OUT_DIR/pixel_processor.wasm"

echo "Built: $OUT_DIR/pixel_processor.wasm ($(wc -c < "$OUT_DIR/pixel_processor.wasm") bytes)"

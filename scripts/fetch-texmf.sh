#!/bin/sh
# BusyTeX のデータパッケージに無い TeX のパッケージを、TeX Live 2023（BusyTeX と同じ版）の保管庫から取得し、
# public/texmf/<名前>.zip にまとめる。組版で足りないファイルがあったときに、ブラウザがその zip を読み込む（src/texmf.ts）
set -eu
TL=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2023/tlnet-final/archive
# 名前：含める TeX Live のパッケージ
BUNDLES="pgf:pgf,pgfplots"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=$ROOT/public/texmf
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$DEST"
for b in $BUNDLES; do
  name=${b%%:*}
  if [ -s "$DEST/$name.zip" ]; then echo "skip $name"; continue; fi
  for pkg in $(echo "${b#*:}" | tr ',' ' '); do
    echo "fetch $pkg"
    curl -fsSL -o "$WORK/$pkg.tar.xz" "$TL/$pkg.tar.xz"
    mkdir -p "$WORK/$name"
    tar -xJf "$WORK/$pkg.tar.xz" -C "$WORK/$name"
  done
  node "$ROOT/scripts/pack-texmf.mjs" "$name" "$WORK/$name" "$DEST"
done
node "$ROOT/scripts/pack-texmf.mjs" --index "$DEST"

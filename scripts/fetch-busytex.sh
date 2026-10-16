#!/bin/sh
# BusyTeX の WASM 版リリースを public/busytex/ に取得する（固定バージョン）。
set -eu
TAG=build_wasm_4499aa69fd3cf77ad86a47287d9a5193cf5ad993_7936974349_1
BASE=https://github.com/busytex/busytex/releases/download/$TAG
DEST=$(dirname "$0")/../public/busytex
PACKAGES="texlive-basic ubuntu-texlive-latex-base ubuntu-texlive-latex-recommended ubuntu-texlive-fonts-recommended ubuntu-texlive-science ubuntu-texlive-latex-extra"

mkdir -p "$DEST"
FILES="busytex.js busytex.wasm busytex_pipeline.js busytex_worker.js versions.txt"
for p in $PACKAGES; do FILES="$FILES $p.js $p.data"; done

for f in $FILES; do
  if [ -s "$DEST/$f" ]; then
    echo "skip $f"
  else
    echo "fetch $f"
    curl -fsSL -o "$DEST/$f.part" "$BASE/$f"
    mv "$DEST/$f.part" "$DEST/$f"
  fi
done

# BusyTeX のバグ修正：Emscripten の callMain は引数の配列を unshift で書き換えるため、
# BibTeX の流れで同じコマンド配列を 2 回使うと 2 回目の pdflatex が失敗する。配列をコピーして渡す。
if grep -q 'callMainWithRedirects(cmd,' "$DEST/busytex_pipeline.js"; then
  sed -i.orig 's/callMainWithRedirects(cmd,/callMainWithRedirects([...cmd],/' "$DEST/busytex_pipeline.js"
  rm -f "$DEST/busytex_pipeline.js.orig"
  echo "patched busytex_pipeline.js"
fi
echo "$TAG" > "$DEST/TAG"

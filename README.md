# 論文マグ 表紙ジェネレータ（PoC）

LaTeX プロジェクトの zip から、タイトル・著者・Abstract だけを組み直して、マグ印刷用の PDF を作るブラウザアプリ。処理はすべてブラウザ内で行い、ファイルはどこにも送信しない。仕様は [SPEC.md](SPEC.md)。

## 使い方

```sh
npm install
npm run fetch-busytex   # BusyTeX（WASM 版 TeX Live 2023、約 170 MB）を public/busytex/ に取得
npm run dev             # http://localhost:5173/
```

1. zip を選ぶ（Overleaf の「Download Source」など。`.cls` は zip に同梱されている前提）。
2. 本文の文字サイズなどを決めて「組版」を押す。
3. プレビューを確認し、`mug.pdf` をダウンロードする。

## 開発

```sh
npm test                # パッチ処理のユニットテスト
npm run typecheck
npm run build           # dist/ に静的サイトを出力（public/busytex/ も含む）

# パッチ結果をローカルの TeX Live で確かめる
npm run patch-cli -- tests/fixtures/ieee-conf --out /tmp/mug --body 6
cd /tmp/mug && pdflatex __mug_main.tex
```

新しい文書クラスへの対応の足し方は [src/styles/README.md](src/styles/README.md)。

## 分野別のレンダリング例

物理・天文・化学・生態学・数学・地球科学・電気電子・統計の各分野で使われているクラスについて、架空の論文をマグ用に組んだ結果を [samples/journals/README.md](samples/journals/README.md) にまとめている。作り直すには次を実行する（ローカルの TeX Live と poppler の `pdftoppm` が必要）。

```sh
npm run gallery            # 全部
npm run gallery -- mnras   # 指定したものだけ
```

## ライセンス上の注意

`public/busytex/` の配布物は [BusyTeX](https://github.com/busytex/busytex) のリリース（`scripts/fetch-busytex.sh` に記載のタグ）で、TeX Live の各ソフトウェアのライセンス（pdfTeX は GPL など）が適用される。公開時はライセンス文とソースの入手先を併記すること。

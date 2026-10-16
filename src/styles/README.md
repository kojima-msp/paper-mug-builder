# スタイル（文書クラス）ごとの対応

論文の文書クラスごとに、表紙をマグ用に組み直すための差分をここにまとめる。**TypeScript は書かなくてよい。** フォルダに設定ファイル `style.json` と、当てる TeX のコード片（`.tex`）を置くだけで認識される。

```
styles/
├─ common/             # 全スタイル共通で当てる TeX（触らなくてよい）
├─ generic/            # 汎用（article など）。どのスタイルにも当たらないときの受け皿
│  ├─ style.json
│  └─ title-abstract.tex
├─ ieeeoj/             # IEEEoj（IEEE Open Journal：OJSP など）
│  └─ style.json
├─ ieeetran/           # IEEEtran
│  ├─ style.json
│  ├─ title-abstract.tex     # Abstract をタイトル直下の全幅領域に入れる
│  ├─ original-preamble.tex  # 著者欄と Abstract の間の空きを詰める
│  └─ reflow-preamble.tex
├─ revtex/             # REVTeX（APS・AIP）と、REVTeX を内蔵した AASTeX（AAS）
│  ├─ style.json
│  ├─ before-textwidth.tex   # Abstract の幅と本文幅の比を覚えておく
│  ├─ original-preamble.tex  # 本文幅を変えた後も Abstract の幅を同じ比にする
│  └─ after-bibliography.tex # 文献リストの自動出力を止める
├─ registry.ts         # 自動生成（npm run styles）。手で編集しない
└─ spec.ts / types.ts / template.ts / index.ts  # 仕組み（スタイルを足すだけなら触らない）
```

## 新しいスタイルを足す

1. `src/styles/<名前>/style.json` を作る。最小限なら次の 3 項目だけでよい。

   ```json
   {
     "id": "mnras",
     "label": "MNRAS",
     "match": { "classes": ["mnras"] }
   }
   ```

2. 組み方を直す必要があれば、同じフォルダに `.tex` を置き、`style.json` からファイル名で指す（下の表）。
   - `.tex` の先頭に `% [paper-mug] …` のコメントを書いておくと、パッチ後の tex のどこに当てたかが分かる。
3. `npm run styles` で確かめる。設定の誤り（知らない項目、無いファイル、正しくない正規表現など）はここで知らせる。テスト・開発・ビルドの前にも自動で走る。
4. 試す：`npm run dev` でブラウザから、または `npm run patch-cli -- <zip> --out <dir>` でパッチ後の tex を書き出してローカルの pdflatex で。
5. プルリクエストを送る。可能なら、そのクラスの架空の論文を `samples/journals/<名前>/` に足す（[samples/journals/README.md](../../samples/journals/README.md)）。

## style.json の項目

| 項目 | 内容 |
|---|---|
| `id` | フォルダ名と同じにする |
| `label` | UI のクラス選択に出す名前 |
| `description` | 説明（どの雑誌か、何をしているか）。JSON にはコメントを書けないので、ここに書く |
| `match.classes` | 当てはまるクラス名（`\documentclass{…}` の中身）。大文字小文字は区別しない。`"/^aastex\\d*$/"` のように `/…/` で囲むと正規表現 |
| `keywordEnvs` | Keywords とみなす環境名（既定は `["keywords"]`）。Abstract の直後にあれば一緒に表紙に含める。`\keywords{…}` コマンドや「Keywords:」で始まる段落は、書かなくても拾う |
| `defaultFontSize` | クラスオプションに `10pt` などが無いときの本文の文字サイズ（既定は 10） |
| `warnings` | `[{ "if": "正規表現", "message": "警告文" }]`。ソース（コメントを除いたもの）に当てはまったら警告を出す |
| `bstSubstitutes` | BusyTeX に無い `.bst` の代わり（番号の付け方が同じもの）。例：`{ "IEEEtran": "ieeetr" }` |
| `original.titleAbstract` | `{ "file": "…tex", "ifOptions": […], "unlessOptions": […] }`。`\maketitle` の後にある Abstract を、タイトルと同じ全幅の領域に入れるコード。ファイルの `{{abstract}}` に Abstract（と Keywords）が入る。元々全幅のクラスでは書かない |
| `original.preamble` | プリアンブルの最後に足す `.tex`（タイトル周りの空きの調整など） |
| `original.beforeTextwidth` | 本文幅を変える直前に置く `.tex`（クラスが本文幅と別に持つ幅を、変える前の値で覚えておくなど） |
| `original.afterBibliography` | 引用番号のために文献リストを読んだ直後に置く `.tex` |
| `original.ensureMaketitle` | `true` なら、`\maketitle` が書かれていないときに補う（最初の `\section` でタイトルを出すクラスのため） |
| `reflow` | 組み直しモード用（UI からは外している）。`removeOptions`・`addOptions`・`preamble` |

## 共通の処理が前提にしていること

スタイルを足すときは、次が成り立つかを確かめる。成り立たない場合は、そのスタイルの `.tex` で合わせる。

- タイトルは `\maketitle` の中で `\@title` として組まれる（タイトルの位置を取るため、`\@title` の前後にマーカーを置いている）。取れない場合は、タイトルも本文と同じ縮尺で組む。
- 本文幅は `\textwidth`、本文の高さは `\textheight` で決まり、プリアンブルで変えられる。
- Abstract は `abstract` 環境で書かれている（`\abstract{…}` コマンドのクラスでも、`\maketitle` が組むなら動く）。

## よくある直し方（いままでの例）

| 症状 | 原因 | 直し方の例 |
|---|---|---|
| Abstract が片段の幅になる | 2 段組のクラスで、Abstract が本文側に組まれている | `original.titleAbstract`（ieeetran、generic） |
| 著者欄と Abstract の間が空きすぎる | クラスがタイトルの後に本文用の空きを入れる | `original.preamble` で空きを変える（ieeetran） |
| Abstract が版面からはみ出す | クラスが Abstract の幅を本文幅と別に固定している | `beforeTextwidth` と `preamble` で比を保つ（revtex） |
| 真っ白になる | `\maketitle` を書かず、最初の `\section` でタイトルを出すクラス | `ensureMaketitle`（revtex） |
| 引用が 2 回読まれて失敗する | クラスが文献リストを自動で出す | `afterBibliography`（revtex） |

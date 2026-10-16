# スタイル（文書クラス）ごとの対応

論文の文書クラスごとに、表紙をマグ用に組み直すための差分をここにまとめる。TeX のコード片は `.tex` ファイルに置き、TypeScript からは `?raw` で文字列として読み込む。

```
styles/
├─ index.ts            # スタイルの一覧と選び方（上から順に match したものを使う）
├─ types.ts            # StyleAdapter（スタイルが持つ情報）
├─ template.ts         # .tex に値を差し込む fill()
├─ common/             # 全スタイル共通で当てる TeX
│  ├─ markers.tex          # 版面・文字サイズ・タイトルの終わりの位置をログに出す
│  ├─ original-textwidth.tex  # 本文幅（マグ上の本文サイズから決める）
│  ├─ original-height.tex  # 本文の高さと紙の高さ
│  ├─ intro-marker.tex     # イントロが何ページ目に組まれたか
│  ├─ end-marker.tex       # 中身の終端の位置
│  ├─ bibliography.tex     # 引用番号を出すための文献リスト（捨て箱）
│  └─ reflow-geometry.tex  # 組み直しモードの紙（UI からは外している）
├─ generic/            # 汎用（article など）。最後の受け皿
├─ ieeeoj/             # IEEEoj（IEEE Open Journal：OJSP など）
│  └─ index.ts
├─ revtex/             # REVTeX（APS・AIP）と、REVTeX を内蔵した AASTeX（AAS）
│  ├─ index.ts
│  ├─ before-textwidth.tex   # Abstract の幅と本文幅の比を覚えておく
│  ├─ original-preamble.tex  # 本文幅を変えた後も Abstract の幅を同じ比にする
│  └─ after-bibliography.tex # 文献リストの自動出力を止める
└─ ieeetran/           # IEEEtran
   ├─ index.ts             # 判定と設定
   ├─ title-abstract.tex   # Abstract をタイトル直下の全幅領域に入れる
   ├─ original-preamble.tex  # 版面のまま組むときに足すプリアンブル
   └─ reflow-preamble.tex  # 組み直しモード用
```

## 新しいスタイルを足す

1. `styles/<名前>/index.ts` を作り、`StyleAdapter` を export する。`ieeetran/index.ts` が見本。
2. 必要な TeX は同じフォルダの `.tex` に書き、`import x from './x.tex?raw'` で読み込んで `fill(x, { ... })` で使う。
   - 差し込む値は `{{name}}` と書く。TeX の波括弧と並んでもよい（`\fpeval{{{w}}}` → `\fpeval{77}`）。
   - 先頭に `% [paper-mug] …` のコメントを書いておくと、パッチ後の tex のどこに当てたかが分かる。
3. `styles/index.ts` の `styles` に加える。**generic より前に置く。**
4. `tests/fixtures/` にそのクラスの最小のプロジェクトを置き、`tests/patch.test.ts` にテストを足す。

## StyleAdapter で決めること

| 項目 | 内容 |
|---|---|
| `match(cls, options)` | このスタイルを使うか。普通はクラス名で判定する |
| `keywordEnvs` | Keywords とみなす環境名（IEEEtran なら `IEEEkeywords`）。Abstract の直後にあれば一緒に表紙に含める |
| `defaultFontSize` | クラスオプションに `10pt` などが無いときの本文の文字サイズ |
| `check(masked)` | 対応していない書き方を見つけたら警告を返す |
| `bstSubstitutes` | BusyTeX に無い `.bst` の代わり（番号の付け方が同じもの）。全スタイルの分を合わせて使う |
| `original.titleAbstract(abs, options)` | `\maketitle` の後にある Abstract を、タイトルと同じ全幅の領域に入れるコード。`\maketitle` の直前に置かれる。元々全幅なら `null` |
| `original.preamble()` | 版面のまま組むときに足すプリアンブル（タイトル周りの空きの調整など） |
| `original.beforeTextwidth()` | 本文幅を変える直前に置くコード（クラスが本文幅と別に持つ幅を覚えておくなど） |
| `original.afterBibliography()` | 引用番号のために文献リストを読んだ直後に置くコード |
| `original.ensureMaketitle` | `\maketitle` が書かれていなければ補う（最初の `\section` でタイトルを出すクラスのため） |
| `reflow.*` | 組み直しモード用（UI からは外している） |

## 共通の処理が前提にしていること

スタイルを足すときは、次が成り立つかを確かめる。成り立たない場合は、そのスタイルの `original.preamble` などで合わせる。

- タイトルは `\maketitle` の中で `\@title` として組まれる（タイトルの終わりの位置を取るため、`\@title` の直後にマーカーを置いている）。取れない場合は、タイトルも本文と同じ縮尺で組む。
- 本文幅は `\textwidth`、本文の高さは `\textheight` で決まり、プリアンブルで変えられる。
- Abstract は `abstract` 環境で書かれている。

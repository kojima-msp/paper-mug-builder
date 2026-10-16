# 論文マグ 表紙ジェネレータ — PoC 実装仕様

LaTeX プロジェクト（zip）から論文の「表紙」（タイトル・著者・所属・Abstract）だけを組版し直し、マグカップ印刷用の PDF を出力するブラウザアプリの PoC。

---

## 0. このドキュメントの使い方（Claude Code 向け）

- 「マイルストーン」（§9）の順に実装する。各マイルストーンの完了条件を満たしたら、次に進む前にユーザーに確認を求める。
- パッチ処理（§5）は純粋関数として実装し、ブラウザ無しでテストできるようにする。ローカルの TeX Live があれば、CLI（§8）経由で `pdflatex` を使い、パッチ結果を自己検証してよい。

### 決定事項の経緯（2026-10-14）
- 当初は SwiftLaTeX を想定していたが、公開パッケージミラー（texlive2.swiftlatex.com）が停止（HTTP 522）しており、本体も 2022 年以降更新がないため不採用。
- サーバー側コンパイル（Cloud Run 等）は、無料枠では十分に収まるが、未公開原稿をサーバーに送る権利面の懸念から PoC では不採用。
- **BusyTeX（TeX Live 2023 の WASM ビルド）を採用。** Node 上での検証で、IEEEtran の表紙がローカルの TeX Live 2026 と同一の出力になることを確認済み。

---

## 1. 目的とスコープ

### 作るもの
- 入力：LaTeX プロジェクトの zip（Overleaf の「Download Source」で得られる形式を想定）。
- 出力：
  - **表紙 PDF**：論文のクラスファイルの見た目のまま、タイトル・著者・所属・Abstract を組んだもの。
    - Abstract は**全幅の 1 段組**にする。
    - 本文・参考文献は含めない。
  - **マグ用 PDF**：表紙 PDF の中身の領域を切り出し、マグの印刷範囲の寸法のページにベクターのまま配置したもの。
- 処理はすべてブラウザ内で行い、バックエンドは持たない。静的サイトとして置ける構成にする。

### PoC の対象
- エンジン：pdfLaTeX（BusyTeX の WASM 版 pdfTeX 1.40.25 / TeX Live 2023）
- 言語：英語論文
- クラス：`IEEEtran` と generic（`article` など）。`acmart`、`llncs`、`elsarticle` は M4。
- クラスファイル（`.cls`）は**ユーザーの zip に同梱されている前提**とする（Overleaf の各社テンプレートは同梱している）。

### 対象外（PoC ではやらない）
- upLaTeX / LuaLaTeX / XeLaTeX、和文論文
- PDF 入力
- 本文の流し込み
- サーバー側コンパイル（将来の選択肢。§10 参照）
- アカウント、保存機能

---

## 2. 技術スタック

| 用途 | 採用 | 備考 |
|---|---|---|
| ビルド | Vite + TypeScript（フレームワーク無し） | `dist/` を静的ホスティングにデプロイ |
| TeX エンジン | BusyTeX（WASM） | https://github.com/busytex/busytex のリリース `build_wasm_4499aa69…_1`（2024-02）に固定。`scripts/fetch-busytex.sh` で `public/busytex/` に取得し、リポジトリには含めない |
| zip 展開 | fflate | |
| PDF 面付け | pdf-lib | `embedPage`（bounding box 指定）でベクターのまま切り出して配置 |
| プレビュー | `<iframe>` に Blob URL | |
| テスト | Vitest | パッチ処理のユニットテスト |
| CLI | tsx | §8 のパッチ CLI 実行用 |

### BusyTeX について（確認済み）
- BusyTeX 同梱の `busytex_worker.js`（classic worker）をそのまま使う。`busytex_pipeline.js` が `importScripts` で読み込まれる。
- **既知のバグと修正**：Emscripten の `callMain` が引数の配列を `unshift` で書き換えるため、BibTeX の流れで同じコマンド配列を 2 回使うと 2 回目の pdflatex が失敗する。`scripts/fetch-busytex.sh` が `busytex_pipeline.js` の `callMainWithRedirects(cmd,` を `callMainWithRedirects([...cmd],` に置き換える。
- データパッケージ（Emscripten の file_packager 形式、`.js` + `.data`）
  - **事前読み込み**：`texlive-basic`（`pdflatex.fmt` を含む）、`ubuntu-texlive-latex-base`、`ubuntu-texlive-latex-recommended`、`ubuntu-texlive-fonts-recommended`、`ubuntu-texlive-science`
    - BusyTeX は `\usepackage` 名から必要なパッケージを選ぶため、フォント（Times の `ptmr7t` など）は自動では読み込まれない。フォントを含むものは事前読み込みにする。
    - `algorithmic.sty`（IEEE テンプレートが読み込む）は `ubuntu-texlive-science` に入っている。
  - **必要なときだけ読み込む**：`ubuntu-texlive-latex-extra`（gzip 後 約 36 MB。`stfloats`、`multirow`、`cleveref`、`enumitem` など）。
    - BusyTeX の依存解決は、**メイン tex の中身が文字列のときだけ** `\usepackage` を読む。パッチ後の tex は文字列で渡す。
  - **TeX Live の残り**：データパッケージは Ubuntu の TeX Live の一部だけで、pgf/TikZ、revtex、newtx、biblatex、acmart などが無い。そこで TeX Live 2023（BusyTeX と同じ版）のうち、BusyTeX に無いファイルを持つパッケージを `scripts/build-texmf.mjs` が自動で集め、TeX Live のパッケージごとの zip（`public/texmf/p/<名前>.zip`）と目録（`index.json`：ファイル名 → zip、zip 同士の依存関係、フォントの対応表）にして配信する。
    - 含めるもの：`tex/latex`・`tex/generic`・`bibtex/bst` と、pdfTeX 用のフォント（`tfm`・`type1`・`vf`・`enc`・`map`）。約 1,700 パッケージ、415 MB。
    - フォントは、3 MB 以下のパッケージ（記号など）と、論文でよく使うもの（newtx、libertine、stix2、inconsolata など。`FONT_ALLOW`）だけ。ほかの大きなフォントのパッケージは含めず、組版ではそのパッケージを外す。GitHub Pages の 1 サイト 1 GB の上限に収めるため。
    - 組版の前に、クラス・残したパッケージ・`\usetikzlibrary`・同梱の `.sty` が読み込むものを目録で引き、依存するものも含めてまとめて読み込む（`src/texmf.ts`、`build.ts`）。それでも足りないファイル（ログの ``File `X' not found``、TikZ のライブラリ、フォントの `.tfm`・`.pfb`）があれば、目録から探して読み込み、組み直す。
    - 読み込んだ一式に含まれるフォントの対応表は、`\pdfmapfile{+X.map}` で pdfTeX に知らせる（BusyTeX の `pdftex.map` には載っていないため）。
- **応答の見張り**：BusyTeX はデータパッケージの読み込みに失敗すると、エラーを出さずに完了を待ち続ける。組版中にワーカーから 120 秒何も届かなければ打ち切り、ワーカーを作り直す。ワーカーのエラーも同様に扱う。
- 初回の転送量は gzip 後で約 110 MB（本体 12 MB、texlive-basic 77 MB、その他 22 MB）。データは IndexedDB にキャッシュされる。
- コンパイルはプロジェクトを MEMFS に書き、**メイン tex のディレクトリに chdir してから**実行される。相対パスは元のプロジェクトと同じに解決される。
- エンジンは `engine.ts` の薄いインターフェース（ファイル一式とメインのパスを渡し、PDF とログを受け取る）の裏に隠す。自前ビルドやサーバー版に差し替えられるようにする。

---

## 3. 処理フロー

```
zip ─▶ 展開・正規化 ─▶ メイン tex 特定 ─▶ \input 展開（flatten）
    ─▶ パッチ（クラス別アダプタ＋汎用処理） ─▶ BusyTeX へ渡す
    ─▶ pdfTeX コンパイル ─▶ 表紙 PDF ＋ 中身の下端位置（ログ）
    ─▶ pdf-lib で切り出し・面付け ─▶ マグ用 PDF ─▶ プレビュー／ダウンロード
```

### 3.1 zip 展開・正規化（`zip.ts`）
- `__MACOSX/` と `.DS_Store` を除外する。
- 全ファイルが単一のトップフォルダ配下にある場合は、そのフォルダを剥がす。
- 結果は `Map<string, Uint8Array>`（パス区切りは `/`）。

### 3.2 メイン tex の特定（`project.ts`）
- 候補：コメント外に `\documentclass` と `\begin{document}` の両方を含む `.tex`。
- 候補が複数ある場合：
  1. ファイル名が `main.tex`、`paper.tex`、`ms.tex`、`manuscript.tex` のものをこの順に優先する。
  2. それでも決まらなければ、UI のセレクトでユーザーに選ばせる。
- 候補が 0 件ならエラーを表示する。

### 3.3 `\input` / `\include` の展開（`project.ts`）
- 対象は `\input{...}` と `\include{...}` のみ。
  - TeX と同じく、拡張子が無ければ `<name>.tex` → `<name>` の順に探す。
  - パスはメイン tex のディレクトリ基準で解決する（TeX の解決と同じ）。
  - 再帰の深さは最大 10。
  - `\include` は `\clearpage` を伴わずに中身だけ展開する。
  - 展開した中身が改行で終わらない場合は改行を補う（末尾のコメントが後続を食わないように）。
- zip 内に見つからないファイルはそのまま残す（`\input{glyphtounicode}` のように TeX Live 側にあるものが多い）。情報ログを出す。
- 対象外：`\input file`（波括弧なし）、`\subfile`、`\import`。警告のみ出す。

---

## 4. TeX ソースの簡易パース（`texparse.ts`）

- **コメントのマスク**：直前のバックスラッシュの個数が偶数（0 を含む）の `%` から行末までを、**同じ長さの空白に置き換えた**テキストを作る。
  - 位置の検索はマスク後のテキストで行い、切り貼りは元のテキストに対して同じ位置で行う。
  - 出力には元のコメントが残る。行末 `%` によるスペース抑制などの意味を変えないため。
  - `verbatim` や `\url{}` 内の `%` は PoC では考慮しない。既知の制限として残す。
- **`\documentclass[opts]{cls}` の解析**：オプション配列とクラス名、ソース上の範囲を取り出す。
- **主要位置の検出**（いずれもマスク後のテキスト上で探す）：
  - `\begin{document}` の位置
  - `\begin{document}` 以降の最初の `\maketitle` の終端位置
  - `\begin{document}` 以降の最初の `\end{abstract}` の終端位置
- **環境の対応チェック**：指定範囲内の `\begin{X}` / `\end{X}` を走査し、閉じていない環境をスタック順で返す。

---

## 5. パッチ処理（`patch.ts`、`styles/*`）— この PoC の核心

### 5.0 2 つのモード
| モード | 本文幅 | 段組み | 文字サイズ | 用途 |
|---|---|---|---|---|
| **original（既定）**：論文の版面のまま | ヘッダー・タイトル・フッターは元の本文幅、著者以下はマグ上の本文の文字サイズ `bodyPt`（既定 6pt）から決める（§5.4） | 元のまま（2 段組なら 2 段組） | 本文は `bodyPt`。タイトルは元の版面をマグの幅に縮めた大きさ（IEEEtran・85 mm で約 10pt） | 実物の 1 ページ目に寄せた見た目 |
| reflow：組み直して文字を大きく（**UI からは外している**。コードは残す） | `printWidth × k` | 1 段組に変える | 元 ÷ k（自動フィットで決める） | 読みやすさ優先 |

- original では、紙の左右の余白は使わず、**版面（本文領域）と、その上下のヘッダー・フッターの帯を切り出す**。ページスタイルはクラスのまま（`\pagestyle{empty}` にしない）。
- ヘッダーとタイトルは、改行位置も含めて元の論文と同じ見た目にする。著者以下は本文幅を変えるので改行位置は変わるが、段組みと書式は保つ。
- タイトルの文字サイズは、クラスの書式を書き換えずに済むよう、元の版面の縮尺で決まる。実際の値はログから読んで表示する。
- original は 2 段階で組む（§5.4）。

### 5.1 汎用処理（全クラス共通）

**(a) 打ち切り位置の決定**
- `cut = max(\maketitle の終端, \end{abstract} の終端)`
  - タイトルと Abstract の両方を出すため、**後に来る方の直後**で切る。
  - `\maketitle` が見つからない場合（elsarticle など）は `\end{abstract}` の後で切る。
  - `\end{abstract}` が見つからない場合は `\maketitle` の後で切り、警告を出す。
  - どちらも無ければエラーにする。
- `cut` の直後（空白を飛ばした位置）が、アダプタの `keywordEnvs` のいずれかの環境なら、それを Keywords とみなす。
  - **Keywords は常に含める**（全スタイル共通）。`cut` をその `\end{...}` まで延ばす。Abstract を全幅の領域に移すときも一緒に移す。
  - 無効なら、イントロを流し込むときに Keywords を飛ばす。

**(b) Abstract を全幅にする（original のみ）**
- `\maketitle` の後に Abstract があるクラスで、アダプタが `original.titleAbstract` を返す場合、Abstract（と、含めるなら Keywords）を `\maketitle` の直前に移し、タイトルと同じ全幅の領域で組ませる。
  - IEEEtran：`\IEEEaftertitletext{...}`（クラス公式のコマンド）。2 段組のまま組むので、`\if@twocolumn` が真になり、Abstract は本来の「*Abstract*—」の書式になる。
  - generic（`twocolumn` 指定時）：`\g@addto@macro\@maketitle{...}`。`\@maketitle` は `\twocolumn[...]` の中で組まれるので全幅になる。
- 元々全幅のクラス（acmart、1 段組のクラス）では動かさない。

**(c) イントロの流し込み（original の full フェーズ、オプション「余白にイントロの冒頭を入れる」、既定 ON）**
- 表紙部分の後ろに、最初の `\section` の中身を、次の `\section`・`\appendix`・`\bibliography`・`thebibliography`・`\end{document}` のうち最も手前まで入れる。
- 浮動体（`figure`、`figure*`、`table`、`table*`、`algorithm`、`wrapfigure` など）は取り除く。
- 1 ページ目のどこで切るかは TeX に任せる（§5.4）。

**(d) 引用番号の解決（流し込んだ部分に `\cite` がある場合）**
- 文献リストを `\setbox0=\vbox{...}` の中で読んで捨て、`\bibcite` だけを aux に書かせる。BusyTeX の BibTeX の流れ（pdflatex → bibtex8 → pdflatex → pdflatex）で組む。
- 文献の出どころは次の優先順位：
  1. 元の論文の `.bbl`（`<メイン名>.bbl`）。番号が元の論文と完全に一致する。
  2. 本文中の `thebibliography` 環境。
  3. `\bibliographystyle` と `\bibliography` があり、`.bib` が zip にある場合は BibTeX。
     - `.bst` が zip にも BusyTeX にも無い場合は、番号の付け方が同じものに置き換える（`IEEEtran` → `ieeetr`、`IEEEtranN` → `unsrtnat`、`IEEEtranS` → `plain`）。置き換えた旨を警告する。
- biblatex は未対応（biber が無い）。引用は `[?]` になる旨を警告する。

**(d') `\thanks` の除去**
- 表紙部分・イントロ・プリアンブル（`\title` や `\author` がプリアンブルにある論文も多い）から、`\thanks{...}` を引数ごと取り除く（波括弧の入れ子に対応）。脚注はマグには不要なため。

**(e) 本文の切り詰め**
- 表紙部分（とイントロ）以外を削除する。
- 残した部分で閉じていない環境（`document` 自身は除く）を、逆順に `\end{X}` で閉じる。
- 末尾に次を付ける。2 行目は、中身の終端の位置をログに書き出すためのもの。
  ```latex
  \par\thispagestyle{empty}
  \pdfsavepos\write-1{MUG-POS=\the\pdflastxpos,\the\pdflastypos}
  <(d) の文献リストを捨てるコード>
  \end{document}
  ```

**(f) プリアンブルへの差し込み**（`\begin{document}` の直前）
- 共通：`\pagestyle{empty}` と、版面の位置をログに出すコード。
  ```latex
  \AtBeginDocument{\typeout{MUG-LAYOUT=<\textwidth>,<\textheight>,<\paperheight>,<左端>,<上端からの距離>}}
  ```
  （値はすべて sp。左端は `1in+\hoffset+\oddsidemargin`、上端からの距離は `1in+\voffset+\topmargin+\headheight+\headsep`）
- original：`\textwidth` を、マグ上の本文が `bodyPt` になる幅にする（fancyhdr の `\headwidth` も合わせる）。縮尺は「利用可能な幅 ÷ 本文幅」なので、`\textwidth = \fpeval{利用可能な幅 × \f@size ÷ bodyPt} mm`（元の本文幅には依らない）。あわせて本文の高さを変える。`\paperheight` もそれに合わせ、`\AtBeginDocument` で `\pdfpageheight` を上書きする（geometry や hyperref より後に効かせるため）。
  - front フェーズ：`\textheight = 3\paperheight`（改ページを起こさない）
  - full フェーズ：`\textheight = (利用可能な高さ ÷ 利用可能な幅) × \textwidth − ヘッダー・フッターの帯`（帯は `\headheight + \headsep + \footskip + 4bp`。ヘッダー・フッターを含めない設定では引かない）
- `MUG-LAYOUT` には、ヘッダー・フッターの切り出しに使う `\headheight`、`\headsep`、`\footskip` も出す。
- 文字サイズの表示用に、`MUG-BASE=\f@size`（本文）と `MUG-TITLE=\f@size`（`\maketitle` の中で `\@title` が使われた時点。`\AddToHook{cmd/maketitle/before}` で `\@title` を包む）を出す。
- 同じ包みで、`\@title` の直後に `\par\pdfsavepos\write-1{MUG-TITLEEND=\the\pdflastypos}` を置き、タイトルの終わりの高さを出す（`\protected` なので `\markboth` などでは展開されない。ヘッダー内で使われた分は、版面より上にあるので読み捨てる）。
- `PatchOptions.width`：`original` なら本文幅を変えない（上段用）、`body` なら `bodyPt` から決める。`PatchOptions.fullHeight` を渡すと、full の本文の高さを `fixedSp + ratio × \textwidth` にする。
- イントロを流し込むときは、その先頭に `\AddToHookNext{para/begin}{...MUG-INTRO=\thepage...}` を置き、最初の段落（節見出しを含む）が組まれたページを出す。
- **ログの読み方**：BusyTeX のログは「`$ コマンド`」行で区切って各段のログファイルと端末出力を連結している。`\write-1` はログファイルにしか出ないので、マーカーは最後の段の先頭（最後の「`$ `」行）から読む。
- reflow：
  ```latex
  \@ifpackageloaded{geometry}{\geometry{<geo>}}{\usepackage[<geo>]{geometry}}
  ```
  `<geo> = paperwidth=<printWidth×k>mm, paperheight=<printHeight×k×3>mm, hmargin=vmargin=<margin×k>mm`

**(g) クラスオプション**
- original：変えない。
- reflow：アダプタの `reflow.editOptions` で 1 段組にする。

**(h) 不要なパッケージ・動かないパッケージを外す**（`stubs.ts`）
- パッケージごとの規則の表（`PACKAGE_RULES`）で、`\usepackage` から外すかを決める。
  - `unavailable`：ブラウザでは動かない（シェルエスケープが要る `minted`、`svg`、`shellesc`）。使われていても外す。BusyTeX に無いだけのものは TeX Live の一式から読み込む。
  - `always`：表紙の見た目に関係しない（`todonotes`、`stfloats`、`balance`、`placeins`、`wrapfig` など）。常に外す。
  - `unused`：表紙とイントロで使われていなければ外す（`multirow`、`cleveref`、`enumitem`、`makecell`、`comment`、`orcidlink`）。使われているかは、残す本文とプリアンブルのマクロ定義を、規則ごとのパターンで調べる。latex-extra の読み込みを避ける効果もある。
- 外した位置に、プリアンブルで使われうる設定コマンドの空定義を置く（後続の `\usetikzlibrary` や `\crefname` が未定義にならないように）。残った `tikzpicture` などの環境は中身ごと捨てる定義にする。
- 外したパッケージが読み込んでいたもの（tikz → xcolor など）は、代わりに読み込む。
- **見つからないファイルによる失敗からの回復**（`build.ts`）：TeX Live の目録にも無いパッケージは、X を直接 `\usepackage` していればそれを、そうでなければエラーの時点で開いていたパッケージ（ログの括弧の対応から求める）を外して組み直す。目録に無い TikZ のライブラリは、中身の無いファイルで代用する。最大 8 回。外した旨を表示する。
- **サブフォルダのスタイルファイル**：zip のサブフォルダにある `.sty`・`.cls`・`.bst` などは、メインと同じ場所にも置く（TeX はカレントディレクトリしか探さないため）。

### 5.2 スタイル（クラス）別の対応（`src/styles/`）
- スタイルごとのフォルダに、設定（`style.json`）と、当てる TeX のコード片（`.tex`）を置く。**TypeScript は書かなくてよい**（プルリクエストで受け付けやすくするため）。`scripts/gen-styles.mjs` がフォルダを集めて検証し、`src/styles/registry.ts` を作る（`npm run styles`。テスト・開発・ビルドの前にも自動で走る）。全スタイル共通の TeX は `src/styles/common/` に置く。`patch.ts` には切り貼りの処理だけを残す。
- `.tex` は `?raw` で文字列として読み込み、`fill()` で `{{name}}` に値を差し込む。CLI（tsx）では `scripts/raw-loader.mjs`（Node のモジュールフック）で `?raw` を扱う。
- 各コード片の先頭には `% [paper-mug] …` のコメントを置き、パッチ後の tex のどこに当てたかを分かるようにする。
- 足し方は `src/styles/README.md` を参照。
```ts
interface ClassAdapter {
  id: string;
  match(cls: string, options: string[]): boolean;
  keywordEnvs: string[];                       // Keywords とみなす環境名
  defaultFontSize: number;                     // オプションに指定が無いときの文字サイズ
  check?(masked: string): string[];            // 警告の検出
  original: {
    titleAbstract?(abs: string, options: string[]): string | null;  // §5.1(b)
    preamble?(): string;
  };
  reflow: {
    editOptions(options: string[]): string[];
    preamble?(): string;
  };
}
```

| クラス | original.titleAbstract | reflow.editOptions | reflow.preamble | 備考 |
|---|---|---|---|---|
| `IEEEtran` | `\IEEEaftertitletext{...}`（`onecolumn` と `compsoc` は対象外）。`original.preamble` で `\IEEEquantizevspace` をタイトル部分をそのまま出すだけの定義にする（本来は 2 段組の本文の行を格子に揃えるための空きで、Abstract を挟むと著者欄との間が空きすぎるため。ベースライン間 50pt → 29pt） | `twocolumn` を除去し `onecolumn` を追加 | Abstract と Keywords を「*Abstract*—」の書式に再定義（compsoc 以外） | compsoc（`\IEEEtitleabstractindextext`）は警告 |
| `IEEEoj`（IEEE Open Journal：OJSP など。`\documentclass{IEEEoj}`、ファイルは `ieeeoj.cls`） | なし（Abstract と Index Terms は `\maketitle` より前に書き、クラスが箱にしまってタイトル部分に全幅で出す） | 変えない | なし | |
| generic | `twocolumn` 指定時のみ `\g@addto@macro\@maketitle{...}` | `twocolumn` を除去 | なし | フォールバック |
| `acmart`（M4） | なし（元々全幅） | `nonacm` を追加 | `\settopmatter{printacmref=false,printccs=false,printfolios=false}` | Libertine 等のフォントが BusyTeX に無い |
| `llncs`（M4） | なし（1 段組） | なし | なし | |

- スタイルは `styles/index.ts` で、上から順に `match` するものを選ぶ。UI で手動上書きもできる。
- **新しいクラスへの対応は、スタイルのフォルダを 1 つ追加するだけで済む構造にする。**
- `.bst` の代わり（`IEEEtran` → `ieeetr` など）も、スタイルの `bstSubstitutes` に持たせる。

### 5.3 出力
- パッチ後のソースは、**元のメイン tex と同じディレクトリ**に `__mug_main.tex` として置く。
- デバッグ用に、パッチ後の `.tex` を UI からダウンロードできるようにする。

### 5.4 組み方の流れ（`build.ts`）
- **original**：本文幅の違う 2 通りの組版から帯を切り出し、マグの上で縦に並べる（ベクターのまま）。
  1. **上段・下段**：元の本文幅（`width: original`）で front フェーズを組む。ヘッダーの帯の上端から `MUG-TITLEEND` まで（上段＝ヘッダーとタイトル）と、フッターの帯（下段）を切り出し、どちらもマグの幅いっぱいの縮尺で置く。
  2. **中段の計測**：本文サイズに合わせた幅（`width: body`）で front フェーズを組む。`MUG-TITLEEND` の 3bp 下（丸い文字のはみ出しを避ける）から Abstract の終わりまでが中段（著者・Abstract）。
  3. 中段が「印刷範囲の高さ − 上段 − 下段」に収まらなければ、**本文の文字サイズを下げて組み直す**（最大 3 回。高さは文字サイズの 2 乗にほぼ比例するとみなす）。縮小すると幅いっぱいにならず、Abstract が細い段のように見えるため。2.5pt まで下げても入らなければ、高さに合わせて縮小する（警告）。
  4. 収まり、イントロを入れる設定で、Abstract の下に 10 mm 以上の余白があれば、full フェーズで組む。本文の高さは「版面の上端からタイトルの終わりまで（2 で測った値）＋ 残りの高さ ÷ 縮尺」にする。**TeX が 1 ページ目の末尾で行単位に切る**。
  5. full が失敗した場合、または `MUG-INTRO` が 1 でない場合（イントロが 1 ページ目に入らなかった）は、2 の結果を使う。
  6. `MUG-TITLEEND` が取れないクラスでは、本文サイズの幅で組んだものだけを置く（タイトルも本文と同じ縮尺）。
- **reflow**：front フェーズで組む。自動フィットは k を探す（§6）。

---

## 6. マグのパラメータと自動フィット

```ts
interface MugOptions {
  mode: 'original' | 'reflow';
  includeIntro: boolean; // original のとき、余白にイントロの冒頭を入れる
  bodyPt: number;        // original のときの、マグ上の本文の文字サイズ（3.5〜9pt、既定 6pt）
  includeHeaderFooter: boolean; // original のとき、ヘッダー・フッターの帯も切り出す（既定 ON）
  printWidth: number;    // mm, 印刷範囲の幅
  printHeight: number;   // mm
  margin: number;        // mm, 印刷範囲の内側の余白（最終寸法）
  bleed: number;         // mm, 塗り足し（既定 0）
  k: number;             // reflow のときの紙の拡大率
  valign: 'center' | 'top';
}
```
- 印刷範囲は**まず 1:1（正方形）**で作る。プリセットは `85 × 85 mm（仮）`。
  - マグを一度に見られる幅は 80〜100 mm 程度のため、全周ではなく正面だけに組む。
  - 値は仮。UI で数値を編集できるようにする。
- 最終的な文字サイズを UI に表示し、6pt を下回ったら警告する（閾値は定数）。
  - original：本文は `bodyPt`、タイトルはログから読んだ値 × 縮尺（組版後に表示）。参考：IEEEtran の本文幅のまま 85 mm に置くと約 4.2pt。
  - 正方形の印刷範囲で `bodyPt` を大きくすると、タイトルと Abstract だけで高さの大半を使い、イントロが入らなくなる（85 mm の IEEEtran サンプルで、6pt は入らず、5pt なら入る）。
  - reflow：元の文字サイズ ÷ k。
- **自動フィット（reflow のみ）**：最終的な中身の高さ `h(k)` が、利用可能な高さ（`printHeight − 2·margin`）に収まる最小の k を探す。
  - 中身の面積はほぼ一定なので `h ∝ 1/k²` と近似し、`k ← k·√(h/avail)` で更新する。k の範囲は [1.0, 4.0]。
  - コンパイル回数は最大 5 回まで。収まった中で最小の k を採用する。

---

## 7. 面付け（`impose.ts`）

- 出力ページのサイズ：`(printWidth + 2·bleed) × (printHeight + 2·bleed)` mm（bp = mm × 72 / 25.4）。
- 部品（`Part`：PDF・切り出し範囲・縮尺・置き場所）の並びとして扱う。`top` の部品は上から順に積み、`bottom` の部品（フッター）は下端に置く。各部品は左右中央。
- ログの `MUG-LAYOUT`・`MUG-POS`・`MUG-TITLEEND` から、各 PDF の 1 ページ目で切り出す範囲を決め、`embedPage` の bounding box で切り出す。
  - 左右：版面の左端から本文幅まで。
  - 上：版面の上端。original でヘッダー・フッターを含める設定なら、ヘッダーの帯の上端（`\headsep + \headheight` 上）。
  - 下：中身の終端の高さ。ただし、2 ページ以上になった場合や、終端が 2 段目（右の段）にある場合（＝ページが埋まっている）は、1 ページ目の版面の下端。original でヘッダー・フッターを含める設定で、ページが埋まっているなら、フッターの帯の下端（`\footskip + 4bp` 下）。
  - ページが埋まっていない（表紙だけの）場合、フッターは紙の下端近くにあるので含めない（既知の制限）。
  - 単位：`\pdflastxpos` / `\pdflastypos` と各長さは sp（TeX pt の 1/65536）。bp への換算は `sp / 65536 × 72 / 72.27`。
- 縮尺：
  - original：`min(利用可能な幅 / 切り出し幅, 利用可能な高さ / 切り出し高さ)`。
  - reflow：`利用可能な幅 / 切り出し幅`（≒ 1/k）。高さが超える場合は「収まっていない」と表示し、自動フィットを提案する。
- 配置：`top` の部品の束を、下端の部品の上の残りの範囲の中で、縦は中央（上寄せも選べる）に置く。はみ出す場合は上端を揃える。
- 既知の制限：ヘッダー・フッターが空のページスタイルでも、その帯の分の余白が上下に出る。
- ダウンロードできるもの：
  - 表紙 PDF（`cover.pdf`、コンパイル結果そのまま）
  - マグ用 PDF（`mug.pdf`）
  - パッチ後の tex（`__mug_main.tex`）

---

## 8. パッチ CLI（ブラウザ無しの検証用）

```
npm run patch-cli -- <project.zip|dir> --out <dir> [--mode original|reflow] [--phase front|full] [--no-intro] [--k 1.5] [--width 85] [--height 85] [--margin 4]
```
- §3.1〜§5 と同じコードを使い、`<dir>` にプロジェクト一式と `__mug_main.tex` を書き出す。
- ローカルに TeX Live があれば、次のコマンドで WASM 版と独立にパッチ結果を確認できる。
  ```
  cd <dir> && pdflatex -interaction=nonstopmode __mug_main.tex
  ```

### テスト（Vitest）
`tests/fixtures/` に最小構成の tex プロジェクトを用意し、パッチ結果を検証する。
- フィクスチャ（M2）：IEEEtran conference、article + twocolumn、Abstract が `\input` で別ファイル、コメントアウトされた `\documentclass` を含む、メイン候補が複数、IEEEtran compsoc（警告）
- フィクスチャ（M4）：IEEEtran journal、acmart sigconf、llncs、elsarticle
- 検証する項目：打ち切り位置、Abstract の移動、イントロの流し込みと浮動体の除去、引用の解決方法、閉じていない環境の補完、クラスオプションの書き換え、`\input` の展開、本文の高さ・`geometry` の差し込み、コメントの保持、パッケージの無効化

---

## 9. マイルストーン

| # | 内容 | 完了条件 |
|---|---|---|
| M1 | Vite 雛形と BusyTeX の組み込み | ブラウザで hello world の tex がコンパイルでき、PDF がプレビューされる。初回の読み込み時間を計測して報告 |
| M2 | zip 読み込み、メイン特定、flatten、パッチ（IEEEtran と generic）、CLI、テスト | IEEEtran conference のプロジェクトから、1 段組 Abstract の表紙 PDF がブラウザで得られる。テストが通る |
| M3 | 面付け、ダウンロード、パラメータ UI、original（Abstract の全幅化・イントロの流し込み・引用番号）と reflow（自動フィット） | 寸法を変えてマグ用 PDF をダウンロードできる |
| M4 | acmart / llncs / elsarticle 対応、データパッケージの作り直し | 各フィクスチャで表紙が収まる。初回転送量を削減 |

**PoC の完了条件は M1〜M3。** M4 はユーザーの確認後に進める。

---

## 10. 既知のリスクと将来の拡張

### 既知のリスク
- **BusyTeX の保守**：実質ひとりのプロジェクトで、WASM 版のリリースは 2024-02（TeX Live 2023）が最後。特定バージョンに固定し、配布物を自前で持つ。止まった場合は Makefile から自前ビルドする。
- **TeX Live 2023 への固定**：zip 同梱の `.cls` が新しい LaTeX カーネルを前提にしていると通らない（IEEEtran は問題なし、acmart は要注意）。
- **初回の転送量（約 110 MB）**：M4 で pdfLaTeX に必要なものだけのデータパッケージに作り直す。
- **ホスティングのファイルサイズ上限**：`texlive-basic.data`（105 MB）は GitHub Pages の 100 MB を、`busytex.wasm`（30 MB）は Cloudflare の 25 MiB を超える。データパッケージの作り直し（分割を含む）で解消する。
- **original の文字サイズとイントロの両立**：`bodyPt` を大きくするほど、タイトルと Abstract が高さを使い、イントロが入らなくなる。印刷範囲を横長にするか、どちらを優先するかを決める必要がある。印刷の解像度と読みやすさは実物で確認する。
- **流し込んだイントロの `\ref`**：図表を取り除き、1 ページ分しか組まないため、図表・節への参照は `??` になりうる。
- **EPS 画像**：pdfTeX は読めない（変換には Ghostscript が要る）。`\includegraphics` の対象が EPS だけなら、同じ大きさ（`%%BoundingBox`）の枠の PDF に差し替えて組版を続け、警告する（`src/eps.ts`）。同じ名前の PDF・PNG・JPG が zip にあればそちらを使う。
- **クラスによる `geometry` の上書き拒否や警告**：結果がおかしい場合は、パッチ後の tex をダウンロードして調査する。
- **ライセンス**：BusyTeX のバイナリには TeX Live の各ライセンス（pdfTeX は GPL）が適用される。配布時はライセンス文とソースの入手先を同梱する。

### ホスティング
- PoC は GitHub Pages（静的配信のみ）。利用者が増えたら、帯域の制限がない Cloudflare + R2 に移す。

### 将来の拡張（PoC 後）
- サーバー側コンパイル（Cloud Run 等）を選択肢として追加（和文・upLaTeX、最新の TeX Live）。
- マグ上の配置調整：取っ手位置を基準にした配置、左右の利き手の切り替え、全周レイアウト。
- 300dpi の PNG 書き出し（画像入稿のみの業者向け）。
- マグ形状のプレビュー（円筒への巻き付け表示）。

---

## 11. ディレクトリ構成

```
paper-mug-builder/
├─ index.html
├─ public/
│  └─ busytex/                 # scripts/fetch-busytex.sh で取得（git 管理外）
├─ src/
│  ├─ main.ts                  # UI
│  ├─ zip.ts
│  ├─ project.ts               # メイン特定・flatten
│  ├─ texparse.ts
│  ├─ patch.ts
│  ├─ stubs.ts
│  ├─ mug.ts                   # 寸法計算
│  ├─ build.ts                 # 組み方の流れ・自動フィット
│  ├─ styles/                  # スタイルごとの対応（README.md に足し方）
│  │  ├─ index.ts / types.ts / template.ts
│  │  ├─ common/*.tex          # 全スタイル共通で当てる TeX
│  │  ├─ generic/
│  │  └─ ieeetran/             # index.ts と *.tex
│  ├─ engine.ts                # BusyTeX ラッパー
│  └─ impose.ts
├─ scripts/
│  ├─ fetch-busytex.sh
│  ├─ raw-loader.mjs           # tsx で ?raw を読むためのフック
│  └─ patch-cli.ts
└─ tests/
   ├─ fixtures/
   └─ patch.test.ts
```

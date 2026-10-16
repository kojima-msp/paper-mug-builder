export interface StyleAdapter {
  id: string;
  label: string;
  match(cls: string, options: string[]): boolean;
  /** Keywords とみなす環境名（Abstract の直後にあれば一緒に表紙に含める） */
  keywordEnvs: string[];
  /** オプションで指定が無い場合の本文の文字サイズ (pt) */
  defaultFontSize: number;
  /** 警告の検出（マスク済みソースを受け取る） */
  check?(masked: string): string[];
  /** BusyTeX に無い .bst の代わり（番号の付け方が同じもの）。全スタイルの分を合わせて使う */
  bstSubstitutes?: Record<string, string>;

  /** 版面のまま組むモード */
  original: {
    /**
     * \maketitle の後にある Abstract を、タイトルと同じ全幅の領域に入れるコード（\maketitle の直前に置く）。
     * null なら動かさない（元々全幅のクラス）。
     */
    titleAbstract?(abstractSrc: string, options: string[]): string | null;
    /** プリアンブルへの追加 */
    preamble?(): string;
    /** 本文幅を変える直前に置くコード（クラスが本文幅と別に持つ幅を、変える前の値で覚えておくなど） */
    beforeTextwidth?(): string;
    /** 引用番号のために文献リストを捨て箱で読んだ直後に置くコード */
    afterBibliography?(): string;
    /** \maketitle が書かれていなければ、表紙部分の後に補う（最初の \section でタイトルを出すクラスのため） */
    ensureMaketitle?: boolean;
  };

  /** 本文幅を k で組み直すモード（1 段組）。UI からは外している */
  reflow: {
    editOptions(options: string[]): string[];
    preamble?(): string;
  };
}

export const withoutOption = (options: string[], name: string) => options.filter((o) => o !== name);

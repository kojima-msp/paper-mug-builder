// style.json（スタイルの設定）の形と、そこから StyleAdapter を組み立てる処理。
// スタイルを足す人は TypeScript を書かず、style.json と .tex を置くだけでよい（README.md 参照）。
import { fill } from './template';
import type { StyleAdapter } from './types';

/** style.json の中身 */
export interface StyleSpec {
  /** フォルダ名と同じにする */
  id: string;
  /** UI のクラス選択に出す名前 */
  label: string;
  /** このスタイルの説明（どの雑誌か、何をしているか）。JSON にはコメントを書けないので、ここに書く */
  description?: string;
  match: {
    /**
     * 当てはまるクラス名（\documentclass{…} の中身）。大文字小文字は区別しない（TeX がファイル名を区別しない設定のため）。
     * "/…/" と書くと正規表現、"*" はどのクラスにも当てはまる（generic 用）
     */
    classes: string[];
  };
  /** Keywords とみなす環境名。Abstract の直後にあれば一緒に表紙に含める（既定は ["keywords"]） */
  keywordEnvs?: string[];
  /** クラスオプションに 10pt などが無いときの本文の文字サイズ（既定は 10） */
  defaultFontSize?: number;
  /** 対応していない書き方を見つけたら出す警告。if はソース（コメントを除いたもの）に当てる正規表現 */
  warnings?: { if: string; message: string }[];
  /** BusyTeX に無い .bst の代わり（番号の付け方が同じもの）。全スタイルの分を合わせて使う */
  bstSubstitutes?: Record<string, string>;
  /** 版面のまま組むモード */
  original?: {
    /**
     * \maketitle の後にある Abstract を、タイトルと同じ全幅の領域に入れるコード（\maketitle の直前に置く）。
     * file の中の {{abstract}} に Abstract が入る。元々全幅のクラスでは書かない
     */
    titleAbstract?: {
      file: string;
      /** これらのクラスオプションがあるときだけ動かす */
      ifOptions?: string[];
      /** これらのクラスオプションがあるときは動かさない */
      unlessOptions?: string[];
    };
    /** プリアンブルの最後に足す .tex */
    preamble?: string;
    /** 本文幅を変える直前に置く .tex（クラスが本文幅と別に持つ幅を、変える前の値で覚えておくなど） */
    beforeTextwidth?: string;
    /** 引用番号のために文献リストを読んだ直後に置く .tex */
    afterBibliography?: string;
    /** \maketitle が書かれていなければ補う（最初の \section でタイトルを出すクラスのため） */
    ensureMaketitle?: boolean;
  };
  /** 本文幅を k で組み直すモード（UI からは外している） */
  reflow?: {
    removeOptions?: string[];
    addOptions?: string[];
    preamble?: string;
  };
}

/** style.json のファイル名から中身を引けるもの（registry.ts が作る） */
export type StyleFiles = Record<string, string>;

const matcher = (pattern: string): ((cls: string) => boolean) => {
  if (pattern === '*') return () => true;
  const re = /^\/(.*)\/$/.exec(pattern);
  if (re) {
    const r = new RegExp(re[1], 'i');
    return (cls) => r.test(cls);
  }
  return (cls) => cls.toLowerCase() === pattern.toLowerCase();
};

export function fromSpec(spec: StyleSpec, files: StyleFiles): StyleAdapter {
  const tex = (name: string | undefined) => (name === undefined ? undefined : () => fill(files[name]));
  const matchers = spec.match.classes.map(matcher);
  const warnings = (spec.warnings ?? []).map((w) => ({ re: new RegExp(w.if), message: w.message }));
  const ta = spec.original?.titleAbstract;
  const rf = spec.reflow ?? {};
  return {
    id: spec.id,
    label: spec.label,
    match: (cls) => matchers.some((m) => m(cls)),
    keywordEnvs: spec.keywordEnvs ?? ['keywords'],
    defaultFontSize: spec.defaultFontSize ?? 10,
    check: warnings.length ? (masked) => warnings.filter((w) => w.re.test(masked)).map((w) => w.message) : undefined,
    bstSubstitutes: spec.bstSubstitutes,
    original: {
      titleAbstract: ta
        ? (abs, options) => {
            if (ta.ifOptions && !ta.ifOptions.some((o) => options.includes(o))) return null;
            if (ta.unlessOptions?.some((o) => options.includes(o))) return null;
            return `${fill(files[ta.file], { abstract: abs })}\n`;
          }
        : undefined,
      preamble: tex(spec.original?.preamble),
      beforeTextwidth: tex(spec.original?.beforeTextwidth),
      afterBibliography: tex(spec.original?.afterBibliography),
      ensureMaketitle: spec.original?.ensureMaketitle,
    },
    reflow: {
      editOptions: (options) => [...options.filter((o) => !(rf.removeOptions ?? []).includes(o)), ...(rf.addOptions ?? [])],
      preamble: tex(rf.preamble),
    },
  };
}

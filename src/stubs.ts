// 表紙に不要なパッケージ、BusyTeX では動かないパッケージの無効化と、代わりのパッケージ（シム）。
import { maskComments, splitList } from './texparse';

interface PackageRule {
  pkg: string;
  /**
   * 外すかどうか
   * - unavailable：BusyTeX に無い／動かない。使われていても外す
   * - always：表紙の見た目に関係しない。常に外す
   * - unused：表紙とイントロで使われていなければ外す（used で判定）
   * - substitute：外さずに、同名の代わりのパッケージ（シム）を読ませる（BusyTeX ではフォントが使えないものなど）
   *
   * unavailable と substitute は、作業フォルダに同名の .sty（シム）も置く。クラス自身が読み込む場合にも効くように
   */
  when: 'unavailable' | 'always' | 'unused' | 'substitute';
  /** 表紙とイントロ（とプリアンブルのマクロ定義）で使われているとみなすパターン */
  used?: RegExp;
  /** 外した位置に置く定義（プリアンブルで使われうるコマンドを空にする） */
  define?: string;
  /** 外したときに代わりに読み込むパッケージ（tikz が読み込んでいた xcolor など） */
  require?: string[];
  /** シムの中身（define と require に加えて書くもの） */
  substitute?: string;
}

// 環境の中身ごと捨てる定義
const gobbleEnv = (name: string, args = '') =>
  String.raw`\@ifundefined{${name}}{\NewDocumentEnvironment{${name}}{${args}+b}{}{}}{}`;
const gobble = (cmd: string, spec: string) => String.raw`\providecommand${cmd}${spec}{}`;

export const PACKAGE_RULES: PackageRule[] = [
  // --- ブラウザでは動かない（シェルエスケープが要る）。BusyTeX に無いだけのものは TeX Live の一式（src/texmf.ts）から読み込む ---
  {
    pkg: 'minted', // シェルエスケープが必要
    when: 'unavailable',
    define: [
      gobble('\\setminted', '[2][]'),
      gobble('\\setmintedinline', '[2][]'),
      gobble('\\usemintedstyle', '[2][]'),
      gobble('\\newminted', '[3][]'),
      gobble('\\newmint', '[3][]'),
      gobble('\\newmintinline', '[3][]'),
      gobble('\\newmintedfile', '[3][]'),
      gobbleEnv('minted', 'o m '),
    ].join(''),
  },
  { pkg: 'svg', when: 'unavailable', define: gobble('\\svgpath', '[1]') + gobble('\\svgsetup', '[1]') + gobble('\\includesvg', '[2][]') },
  { pkg: 'shellesc', when: 'unavailable', define: gobble('\\ShellEscape', '[1]') },
  // --- 表紙の見た目に関係しない（常に外す） ---
  {
    pkg: 'todonotes',
    when: 'always',
    require: ['xcolor'],
    define: gobble('\\todo', '[2][]') + gobble('\\missingfigure', '[2][]') + gobble('\\listoftodos', '[1][]') + gobble('\\todostyle', '[2]'),
  },
  { pkg: 'stfloats', when: 'always', define: gobble('\\fnbelowfloat', '') + gobble('\\fnunderfloat', '') },
  { pkg: 'dblfloatfix', when: 'always' },
  { pkg: 'balance', when: 'always', define: gobble('\\balance', '') + gobble('\\nobalance', '') },
  { pkg: 'flushend', when: 'always', define: gobble('\\atColsBreak', '[1]') + gobble('\\showcolsendrule', '') },
  { pkg: 'placeins', when: 'always', define: gobble('\\FloatBarrier', '') },
  { pkg: 'wrapfig', when: 'always' },
  { pkg: 'threeparttable', when: 'always' },

  // --- 表紙とイントロで使われていなければ外す（latex-extra の読み込みを避ける） ---
  { pkg: 'multirow', when: 'unused', used: /\\multirow\b/ },
  {
    pkg: 'makecell',
    when: 'unused',
    used: /\\(makecell|thead|makegapedcells)\b/,
    define: gobble('\\theadfont', '') + gobble('\\theadalign', '') + gobble('\\cellalign', '') + gobble('\\cellset', '') + gobble('\\theadset', ''),
  },
  {
    pkg: 'cleveref',
    when: 'unused',
    used: /\\(c|C)ref(range)?\*?\s*\{|\\labelcref\s*\{|\\namecref|\\nameCref/,
    define: ['\\crefname', '\\Crefname'].map((c) => gobble(c, '[3]')).join('') + ['\\crefformat', '\\Crefformat', '\\creflabelformat'].map((c) => gobble(c, '[2]')).join(''),
  },
  {
    pkg: 'enumitem',
    when: 'unused',
    used: /\\begin\s*\{(itemize|enumerate|description)\}\s*\[|\\newlist\b/,
    define: gobble('\\setlist', '[2][]') + gobble('\\setlistdepth', '[1]') + gobble('\\setenumerate', '[2][]') + gobble('\\setitemize', '[2][]') + gobble('\\setdescription', '[2][]'),
  },
  { pkg: 'comment', when: 'unused', used: /\\begin\s*\{comment\}|\\(includecomment|excludecomment|specialcomment)\b/ },
  // orcidlink は hyperref を読み込むので、外すときは代わりに読み込む（\hypersetup だけを書く論文があるため）
  { pkg: 'orcidlink', when: 'unused', used: /\\orcidlink\b/, require: ['hyperref'] },
];

const USEPACKAGE_RE = /\\(usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g;

export interface StubResult {
  source: string;
  removed: string[];
  /** 外さずに残した \usepackage のパッケージ名 */
  kept: string[];
}

/**
 * \usepackage から規則に当たるものを取り除き、同じ位置に空定義を置く（後続のプリアンブルで使われるため）。
 * usage は「使われているか」を判定する対象（表紙とイントロ、プリアンブルのマクロ定義）。
 * drop は規則に無いが外したいパッケージ（コンパイルで見つからなかったもの、それを要求したもの）。
 */
export function stubPackages(src: string, usage: string, drop: string[] = []): StubResult {
  const masked = maskComments(src);
  const usageMasked = maskComments(usage);
  const rules = new Map<string, PackageRule>(PACKAGE_RULES.map((r) => [r.pkg, r]));
  const shouldDrop = (pkg: string) => {
    if (drop.includes(pkg)) return true;
    const r = rules.get(pkg);
    if (!r || r.when === 'substitute') return false;
    return r.when !== 'unused' || !r.used!.test(usageMasked);
  };
  const removed: string[] = [];
  const kept: string[] = [];
  const required = new Set<string>();
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(USEPACKAGE_RE)) {
    const pkgs = splitList(m[3]);
    const keep = pkgs.filter((p) => !shouldDrop(p));
    kept.push(...keep);
    if (keep.length === pkgs.length) continue;
    const gone = pkgs.filter((p) => shouldDrop(p));
    removed.push(...gone);
    const lines = [
      keep.length ? `\\${m[1]}${m[2] ?? ''}{${keep.join(',')}}` : '',
      `% [paper-mug] removed ${gone.join(',')}: ${m[0].replace(/\s+/g, ' ')}`,
    ];
    for (const p of gone) {
      const r = rules.get(p);
      for (const q of r?.require ?? []) {
        if (!required.has(q)) lines.push(`\\usepackage{${q}}`);
        required.add(q);
      }
      if (r?.define) lines.push(`\\makeatletter${r.define}\\makeatother`);
    }
    out += src.slice(last, m.index) + lines.filter(Boolean).join('\n');
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  return { source: out, removed, kept };
}

/** プリアンブルのうち、\usepackage 以外（マクロ定義など）。使われているかの判定に含める */
export const preambleWithoutPackages = (preamble: string) => preamble.replace(USEPACKAGE_RE, '');

const shim = (pkg: string, body: string) =>
  `\\ProvidesPackage{${pkg}}[2026/01/01 paper-mug shim]\n\\DeclareOption*{}\\ProcessOptions\\relax\n${body}\n\\endinput\n`;

/** 作業フォルダに置く代わりのパッケージ（ファイル名 → 中身）。unavailable と substitute の規則から作る */
export function shimFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of PACKAGE_RULES) {
    if (r.when !== 'unavailable' && r.when !== 'substitute') continue;
    const body = [...(r.require ?? []).map((q) => `\\RequirePackage{${q}}`), r.define ?? '', r.substitute ?? ''].filter(Boolean).join('\n');
    out[`${r.pkg}.sty`] = shim(r.pkg, body);
  }
  return out;
}

/** 中身の無い代わりのパッケージ。クラスが読み込むパッケージが BusyTeX に無いとき、組版を通すために使う */
export const emptyShim = (pkg: string) => shim(pkg, '% [paper-mug] BusyTeX に無いため、中身の無いパッケージで代用');

// 表紙だけを組むためのパッチ処理（純粋関数）。
import { bstSubstitutes, pickStyle, type StyleAdapter } from './styles';
import bibliographyTex from './styles/common/bibliography.tex?raw';
import endMarkerTex from './styles/common/end-marker.tex?raw';
import fontFallbackTex from './styles/common/font-fallback.tex?raw';
import introMarkerTex from './styles/common/intro-marker.tex?raw';
import markersTex from './styles/common/markers.tex?raw';
import originalHeightTex from './styles/common/original-height.tex?raw';
import originalTextwidthTex from './styles/common/original-textwidth.tex?raw';
import reflowGeometryTex from './styles/common/reflow-geometry.tex?raw';
import { fill } from './styles/template';
import { availableHeight, availableWidth, paperGeometry, type MugOptions } from './mug';
import { basename, dirname, flatten, joinPath } from './project';
import { preambleWithoutPackages, stubPackages } from './stubs';
import {
  findBegin,
  findCommandEnd,
  findCommandStart,
  findEndOf,
  formatDocumentClass,
  maskComments,
  parseDocumentClass,
  removeCommandWithArg,
  removeEnvironments,
  splitList,
  unclosedEnvironments,
} from './texparse';
import type { ProjectFiles } from './zip';

export const PATCHED_NAME = '__mug_main.tex';
export const POS_MARKER = 'MUG-POS';
export const LAYOUT_MARKER = 'MUG-LAYOUT';
export const BASE_MARKER = 'MUG-BASE';
export const TITLE_MARKER = 'MUG-TITLE';
export const INTRO_MARKER = 'MUG-INTRO';
export const TITLE_END_MARKER = 'MUG-TITLEEND';

/**
 * front: タイトル・Abstract だけを縦長の紙に組む（高さの計測用、または表紙のみの出力）
 * full: 紙の高さを印刷範囲の縦横比に合わせ、イントロの冒頭まで流し込む（original モードのみ）
 */
export type PatchPhase = 'front' | 'full';

export interface PatchOptions {
  mug: MugOptions;
  phase?: PatchPhase;
  /** UI からのアダプタ手動指定 */
  adapterId?: string;
  /** プロジェクト内にファイルがあるか（メインのディレクトリ基準のパス） */
  hasFile?: (path: string) => boolean;
  /** メイン tex の拡張子を除いたファイル名（元の .bbl を探すため） */
  mainName?: string;
  /** 外すパッケージ（コンパイルで見つからなかったもの） */
  dropPackages?: string[];
  /**
   * プリアンブルの最後に \usepackage として書き足すパッケージ。クラスが読み込むパッケージを BusyTeX に知らせるため
   * （BusyTeX はメイン tex の \usepackage を見て、必要なデータパッケージを読み込む）。クラスが読み込み済みなら何もしない行になる
   */
  hintPackages?: string[];
  /**
   * original のときの本文幅
   * - body（既定）：マグ上の本文が bodyPt になる幅
   * - original：クラスのまま（ヘッダーとタイトルを元の見た目で切り出すため）
   */
  width?: 'body' | 'original';
  /** original / full のときの本文の高さ：fixedSp (sp) + ratio × \textwidth。未指定なら印刷範囲の縦横比から決める */
  fullHeight?: { fixedSp: number; ratio: number };
}

export interface PatchResult {
  source: string;
  adapter: StyleAdapter;
  cls: string;
  options: string[];
  /** 本文の文字サイズ (pt) */
  baseFontSize: number;
  cutReason: 'maketitle' | 'abstract' | 'keywords';
  /** Abstract をタイトルの全幅領域に移したか */
  movedAbstract: boolean;
  /** イントロを流し込んだか */
  includedIntro: boolean;
  /** 引用番号の出どころ */
  citeSource?: 'bbl' | 'thebibliography' | 'bibtex';
  /** BibTeX の流れ（pdflatex を 2 回以上）で組む必要があるか */
  bibtex: boolean;
  closedEnvs: string[];
  removedPackages: string[];
  /** 残した \usepackage のパッケージ名 */
  keptPackages: string[];
  /** 取り除いた \thanks の数 */
  removedThanks: number;
  /** 枠で代用した EPS の画像（eps：元のファイル、placeholder：代わりに読ませる PDF。どちらもメインのディレクトリ基準） */
  epsImages: EpsImage[];
  removedFloats: string[];
  warnings: string[];
}

export class PatchError extends Error {}

export interface EpsImage {
  eps: string;
  placeholder: string;
}

/** EPS の代わりに読ませる PDF の名前（拡張子無しで \includegraphics に書く） */
const EPS_PLACEHOLDER_SUFFIX = '-mug-eps';
const RASTER_OR_PDF = ['.pdf', '.png', '.jpg', '.jpeg'];

/**
 * \includegraphics の対象が EPS なら、代わりの PDF の名前に書き換える。
 * 同じ名前の PDF・PNG・JPG がプロジェクトにあれば、拡張子を外してそちらを読ませる（Overleaf が変換したものなど）
 */
function rewriteEpsImages(src: string, hasFile: PatchOptions['hasFile']): { source: string; images: EpsImage[] } {
  if (!hasFile) return { source: src, images: [] };
  const masked = maskComments(src);
  const images: EpsImage[] = [];
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(/\\includegraphics\s*(\*)?\s*(\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const name = m[3].trim();
    const base = name.replace(/\.eps$/i, '');
    const isEps = /\.eps$/i.test(name) || (!/\.[A-Za-z0-9]+$/.test(name) && hasFile(`${name}.eps`) && !RASTER_OR_PDF.some((e) => hasFile(`${name}${e}`)));
    if (!isEps) continue;
    const other = RASTER_OR_PDF.find((e) => hasFile(`${base}${e}`));
    const target = other ? base : `${base}${EPS_PLACEHOLDER_SUFFIX}`;
    if (!other) images.push({ eps: /\.eps$/i.test(name) ? name : `${name}.eps`, placeholder: `${target}.pdf` });
    const argStart = m.index + m[0].lastIndexOf('{');
    out += src.slice(last, argStart) + `{${target}}`;
    last = m.index + m[0].length;
  }
  return { source: out + src.slice(last), images };
}

/** 「Keywords:」で始まる段落（書体の指定や \noindent が前に付くことがある） */
const KEYWORD_PARAGRAPH_RE = /^(\\noindent\s*)?(\{?\s*\\(textbf|textit|emph|textsc|bf|it|bfseries|itshape|small|footnotesize)\s*\{?\s*)*(Key\s*words|Keywords|KEYWORDS|Index\s+Terms)\b/i;

/** open の位置の { に対応する } の位置。\{ \} は数えない */
function matchingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '\\') i++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** 本文に流し込むときに取り除く環境（浮動体はページを動き回るため） */
const FLOAT_ENVS = ['figure', 'figure*', 'table', 'table*', 'algorithm', 'algorithm*', 'wrapfigure', 'wraptable'];

export function patchSource(src: string, opts: PatchOptions): PatchResult {
  const { mug } = opts;
  const phase: PatchPhase = mug.mode === 'original' ? (opts.phase ?? 'full') : 'front';
  const warnings: string[] = [];
  const masked = maskComments(src);

  const dc = parseDocumentClass(masked);
  if (!dc) throw new PatchError('\\documentclass が見つかりません');
  const beginDoc = findBegin(masked, 'document', dc.end);
  if (beginDoc < 0) throw new PatchError('\\begin{document} が見つかりません');
  const bodyStart = beginDoc + masked.slice(beginDoc).match(/^\\begin\s*\{document\}/)![0].length;
  const endDocEnd = findEndOf(masked, 'document', bodyStart);
  const endDoc = endDocEnd < 0 ? src.length : masked.lastIndexOf('\\end', endDocEnd);

  const adapter = pickStyle(dc.cls, dc.options, opts.adapterId);
  warnings.push(...(adapter.check?.(masked) ?? []));

  // (a) 打ち切り位置
  const titleStart = findCommandStart(masked, 'maketitle', bodyStart);
  const titleEnd = findCommandEnd(masked, 'maketitle', bodyStart);
  const absBegin = findBegin(masked, 'abstract', bodyStart);
  const absEnd = findEndOf(masked, 'abstract', bodyStart);
  if (titleEnd < 0 && absEnd < 0) throw new PatchError('\\maketitle も \\end{abstract} も見つかりません');
  if (absEnd < 0) warnings.push('\\end{abstract} が見つからないため、\\maketitle の直後で切ります');
  let cut = Math.max(titleEnd, absEnd);
  let cutReason: PatchResult['cutReason'] = cut === absEnd ? 'abstract' : 'maketitle';

  // Abstract の直後の Keywords。書き方は 3 通りある
  // - 環境：\begin{IEEEkeywords}…\end{IEEEkeywords}、\begin{keywords}…（スタイルの keywordEnvs）
  // - コマンド：\keywords{…}（AASTeX、REVTeX など）
  // - 段落：\noindent\textbf{Keywords:} …（article で手書きするもの）。次の空行か \section まで
  const kw = (() => {
    const rest = masked.slice(cut);
    const at = cut + rest.length - rest.trimStart().length;
    for (const env of adapter.keywordEnvs) {
      if (findBegin(masked, env, at) === at) {
        const end = findEndOf(masked, env, at);
        if (end > 0) return { begin: at, end };
      }
    }
    const cmd = /^\\(keywords|keyword|keyterms)\s*\{/.exec(masked.slice(at));
    if (cmd) {
      const end = matchingBrace(masked, at + cmd[0].length - 1);
      if (end > 0) return { begin: at, end: end + 1 };
    }
    if (KEYWORD_PARAGRAPH_RE.test(masked.slice(at, at + 200))) {
      const m = /\n[ \t]*\n|\\(section|subsection|begin)\b/.exec(masked.slice(at));
      return { begin: at, end: m ? at + m.index : at };
    }
    return undefined;
  })();
  // Keywords は常に含める
  if (kw) {
    cut = kw.end;
    cutReason = 'keywords';
  }
  const frontTail = cut;

  // (b) 表紙部分の本文
  const options = mug.mode === 'reflow' ? adapter.reflow.editOptions(dc.options) : dc.options;
  let front: string;
  let movedAbstract = false;
  const absAfterTitle = titleStart >= 0 && absBegin > titleEnd;
  const titleCode =
    mug.mode === 'original' && absAfterTitle ? adapter.original.titleAbstract?.(src.slice(absBegin, cut), options) ?? null : null;
  if (titleCode !== null) {
    movedAbstract = true;
    front = src.slice(bodyStart, titleStart) + titleCode + src.slice(titleStart, absBegin);
  } else {
    front = src.slice(bodyStart, cut);
  }


  // (c) イントロの冒頭（original / full のみ）。次の \section、付録、参考文献の手前まで
  let intro = '';
  let removedFloats: string[] = [];
  const includedIntro = phase === 'full' && mug.includeIntro;
  if (includedIntro) {
    const s1 = findCommandStart(masked, 'section', frontTail);
    const stops = [
      s1 >= 0 ? findCommandStart(masked, 'section', s1 + 1) : -1,
      findCommandStart(masked, 'appendix', frontTail),
      findCommandStart(masked, 'bibliography', frontTail),
      findBegin(masked, 'thebibliography', frontTail),
      endDoc,
    ].filter((i) => i >= 0);
    const introEnd = Math.min(...stops);
    const r = removeEnvironments(src.slice(frontTail, introEnd), FLOAT_ENVS);
    // イントロの最初の段落（節見出しを含む）が組まれたページをログに出す。1 ページ目に入らなかったことを見分けるため
    intro = `\n${fill(introMarkerTex)}${r.source}`;
    removedFloats = r.removed;
  }

  // (d) 参考文献：流し込んだ部分の \cite に番号を出すため、文献リストを捨て箱の中で読み、2 回組む
  let bibCode = '';
  let citeSource: PatchResult['citeSource'];
  if (includedIntro && /\\cite[a-zA-Z]*\*?\s*[[{]/.test(maskComments(intro))) {
    const r = bibliographyCode(src, masked, bodyStart, endDoc, opts);
    if ('warning' in r) warnings.push(r.warning);
    else {
      bibCode = `${fill(bibliographyTex, { code: r.code })}\n${adapter.original.afterBibliography?.() ?? ''}\n`;
      citeSource = r.source;
      if (r.note) warnings.push(r.note);
    }
  }
  const bibtex = citeSource !== undefined;

  // \maketitle を書かないクラス（REVTeX 系は最初の \section でタイトルを出す）には、表紙部分の後に補う。
  // イントロを流し込むときは、その \section がタイトルを出すので補わない（2 回組むとクラスがエラーにする）
  if (titleStart < 0 && adapter.original.ensureMaketitle && !includedIntro) front += '\n\\maketitle\n';

  // (e) \thanks の脚注はマグには不要なので、中身ごと取り除く（\title や \author はプリアンブルにあることも多い）
  const thanksBody = removeCommandWithArg(front + intro, 'thanks');
  // EPS の画像は pdfTeX で読めないので、同じ大きさの枠（build.ts が作る PDF）に差し替える
  const epsBody = rewriteEpsImages(thanksBody.source, opts.hasFile);
  const body = epsBody.source;

  // (f) 閉じていない環境
  const closedEnvs = unclosedEnvironments(maskComments(body), 0, body.length);
  const closers = [...closedEnvs].reverse().map((e) => `\\end{${e}}`).join('\n');

  const sizeOpt = options.map((o) => /^(\d+(?:\.\d+)?)pt$/.exec(o)).find((m) => m);
  const baseFontSize = sizeOpt ? Number(sizeOpt[1]) : adapter.defaultFontSize;

  // (g) 不要なパッケージ・動かないパッケージを外す（\documentclass 以降のプリアンブルのみ）
  const thanksPreamble = removeCommandWithArg(src.slice(dc.end, beginDoc), 'thanks');
  const epsPreamble = rewriteEpsImages(thanksPreamble.source, opts.hasFile);
  const afterClass = epsPreamble.source;
  const epsImages = [...epsPreamble.images, ...epsBody.images].filter((e, i, a) => a.findIndex((x) => x.placeholder === e.placeholder) === i);
  for (const e of epsImages) warnings.push(`EPS の画像（${e.eps}）は表示できないため、同じ大きさの枠で代用しました。PDF か PNG にして zip に入れてください`);
  const removedThanks = thanksBody.count + thanksPreamble.count;
  // 使われているかは、残す本文とプリアンブルのマクロ定義で判定する
  const stub = stubPackages(afterClass, preambleWithoutPackages(afterClass) + body, opts.dropPackages);

  // (h) プリアンブルへの差し込み。original はページスタイル（ヘッダー・フッター）をクラスのまま残す
  const overrides = [
    '% ===== paper-mug overrides =====',
    ...(mug.mode === 'reflow' ? reflowLayout(mug) : originalLayout(mug, phase, opts, adapter)),
    fill(markersTex),
    mug.mode === 'reflow' ? adapter.reflow.preamble?.() : adapter.original.preamble?.(),
    fill(fontFallbackTex),
    ...(opts.hintPackages?.length ? ['% [paper-mug] クラスが読み込むパッケージを BusyTeX に知らせる', ...opts.hintPackages.map((p) => `\\usepackage{${p}}`)] : []),
    '% ===== end paper-mug overrides =====',
    '',
  ].filter((l) => l !== undefined && l !== '').join('\n');

  const source = [
    src.slice(0, dc.start),
    formatDocumentClass(dc.cls, options),
    stub.source,
    overrides,
    '\n',
    src.slice(beginDoc, bodyStart),
    body,
    '\n',
    closers ? `${closers}\n` : '',
    mug.mode === 'reflow' ? '\\par\\thispagestyle{empty}\n' : '\\par\n',
    `${fill(endMarkerTex)}\n`,
    bibCode,
    '\\end{document}\n',
  ].join('');

  return {
    source,
    adapter,
    cls: dc.cls,
    options,
    baseFontSize,
    cutReason,
    movedAbstract,
    includedIntro,
    citeSource,
    bibtex,
    closedEnvs,
    removedPackages: stub.removed,
    keptPackages: stub.kept,
    removedThanks,
    epsImages,
    removedFloats,
    warnings,
  };
}

/** BusyTeX のデータパッケージに入っている .bst */
const AVAILABLE_BST = new Set(['plain', 'unsrt', 'abbrv', 'alpha', 'ieeetr', 'acm', 'siam', 'apalike', 'plainnat', 'unsrtnat', 'abbrvnat', 'amsplain', 'amsalpha']);

function bibliographyCode(
  src: string,
  masked: string,
  bodyStart: number,
  endDoc: number,
  opts: PatchOptions,
): { code: string; source: NonNullable<PatchResult['citeSource']>; note?: string } | { warning: string } {
  const has = (p: string) => opts.hasFile?.(p) ?? false;
  // 1. 元の論文の .bbl（番号が元の論文と完全に一致する）
  if (opts.mainName && has(`${opts.mainName}.bbl`)) return { code: `\\input{${opts.mainName}.bbl}`, source: 'bbl' };
  // 2. 本文に直接書かれた thebibliography
  const tb = findBegin(masked, 'thebibliography', bodyStart);
  if (tb >= 0 && tb < endDoc) {
    const end = findEndOf(masked, 'thebibliography', tb);
    if (end > 0) return { code: src.slice(tb, end), source: 'thebibliography' };
  }
  // 3. .bib から BibTeX
  if (/\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b/.test(masked)) return { warning: 'biblatex は未対応のため、引用は [?] になります' };
  const style = /\\bibliographystyle\s*\{([^}]*)\}/.exec(masked)?.[1]?.trim();
  const bibs = /\\bibliography\s*\{([^}]*)\}/.exec(masked.slice(bodyStart))?.[1];
  const bibFiles = bibs ? splitList(bibs) : [];
  if (bibFiles.length === 0) return { warning: '参考文献が見つからないため、引用は [?] になります' };
  if (!bibFiles.every((b) => has(b.endsWith('.bib') ? b : `${b}.bib`))) return { warning: '.bib が zip に無いため、引用は [?] になります' };
  // \bibliographystyle が無ければ、クラスが文献スタイルを決める（REVTeX など）ものとして \bibliography だけを読む
  if (!style) return { code: `\\bibliography{${bibFiles.join(',')}}`, source: 'bibtex' };
  let bst = style;
  let note: string | undefined;
  if (!has(`${style}.bst`) && !AVAILABLE_BST.has(style)) {
    const sub = bstSubstitutes[style];
    if (!sub) return { warning: `${style}.bst が見つからないため、引用は [?] になります` };
    bst = sub;
    note = `${style}.bst が無いため、番号の付け方が同じ ${sub}.bst で引用番号を解決しました`;
  }
  return { code: `\\bibliographystyle{${bst}}\\bibliography{${bibFiles.join(',')}}`, source: 'bibtex', note };
}

/** reflow：紙の幅を印刷範囲 × k にし、縦長にして改ページを起こさない */
function reflowLayout(mug: MugOptions): string[] {
  const g = paperGeometry(mug);
  const geo = `paperwidth=${g.paperWidth}mm,paperheight=${g.paperHeight}mm,hmargin=${g.margin}mm,vmargin=${g.margin}mm`;
  return [fill(reflowGeometryTex, { geometry: geo })];
}

/**
 * original：段組みやページスタイルはクラスのまま。本文幅と本文の高さだけを変える。
 * - 本文幅：マグ上の本文の文字サイズが bodyPt になる幅。縮尺は「利用可能な幅 ÷ 本文幅」なので、
 *   本文幅 = 利用可能な幅 × 元の本文の文字サイズ（\f@size）÷ bodyPt。元の本文幅には依らない。
 * - 本文の高さ：front は縦長（改ページを起こさない）、full は印刷範囲の縦横比に合わせ、1 ページ目で TeX に行単位で切らせる。
 */
function originalLayout(mug: MugOptions, phase: PatchPhase, opts: PatchOptions, adapter: StyleAdapter): string[] {
  const ratio = availableHeight(mug) / availableWidth(mug);
  // ヘッダー・フッターも切り出すときは、その帯の分だけ本文を低くして、全体を印刷範囲の縦横比に合わせる
  const bands = mug.includeHeaderFooter ? '-\\headheight-\\headsep-\\footskip-4bp' : '';
  const height =
    phase === 'front'
      ? '3\\paperheight'
      : opts.fullHeight
        ? `\\dimexpr${Math.round(opts.fullHeight.fixedSp)}sp+${opts.fullHeight.ratio.toFixed(5)}\\textwidth\\relax`
        : `\\dimexpr${ratio.toFixed(5)}\\textwidth${bands}\\relax`;
  return [
    adapter.original.beforeTextwidth?.() ?? '',
    ...(opts.width === 'original' ? [] : [fill(originalTextwidthTex, { availWidth: availableWidth(mug).toFixed(3), bodyPt: mug.bodyPt })]),
    fill(originalHeightTex, { textheight: height }),
  ];
}

export interface ProjectPatch extends PatchResult {
  mainPath: string;
  /** パッチ後のファイルのパス（メインと同じディレクトリ） */
  outPath: string;
  info: string[];
}

export function patchProject(files: ProjectFiles, mainPath: string, opts: PatchOptions): ProjectPatch {
  const flat = flatten(files, mainPath);
  const dir = dirname(mainPath);
  const mainName = basename(mainPath).replace(/\.tex$/i, '');
  const r = patchSource(flat.source, { hasFile: (p) => files.has(joinPath(dir, p)), mainName, ...opts });
  return {
    ...r,
    mainPath,
    outPath: dir ? `${dir}/${PATCHED_NAME}` : PATCHED_NAME,
    warnings: [...flat.warnings, ...r.warnings],
    info: flat.info,
  };
}

/** コンパイルログから、見つからなかったパッケージ（.sty）とクラス（.cls）を取り出す。 */
export function missingFiles(log: string): { packages: string[]; classes: string[] } {
  const names = [...log.matchAll(/File `([^']+)\.(sty|cls)' not found/g)];
  const uniq = (ext: string) => [...new Set(names.filter((m) => m[2] === ext).map((m) => m[1]))];
  return { packages: uniq('sty'), classes: uniq('cls') };
}

/**
 * 見つからなかったファイルを要求したパッケージを探す。
 * 直接 \\usepackage しているならそれ自身、そうでなければエラーの時点で開いていたファイルのうち、残したパッケージの最も内側のもの。
 * TeX のログはファイルを開くと「(パス」、閉じると「)」を書くので、括弧の対応を追う。
 */
export function culpritPackage(log: string, missing: string, kept: string[]): string | undefined {
  if (kept.includes(missing)) return missing;
  const at = log.lastIndexOf(`File \`${missing}.sty' not found`);
  // BusyTeX のログは各段の出力を連結しているので、最後の段（エラーを含む段）の先頭から追う
  const runStart = Math.max(0, log.lastIndexOf('This is pdfTeX', at < 0 ? undefined : at));
  const text = log.slice(runStart, at < 0 ? undefined : at);
  const stack: (string | null)[] = [];
  for (const m of text.matchAll(/\((\.?\/[^\s()]*|\/[^\s()]*)?|\)/g)) {
    if (m[0] === ')') stack.pop();
    else stack.push(m[1] ? m[1].slice(m[1].lastIndexOf('/') + 1) : null);
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const name = stack[i]?.replace(/\.sty$/, '');
    if (name && kept.includes(name)) return name;
  }
  return undefined;
}

export interface CompileLog {
  /** 中身の終端（sp, ページ左下が原点） */
  pos?: { x: number; y: number };
  /** 本文の文字サイズ (pt) */
  baseSize?: number;
  /** タイトルの文字サイズ (pt) */
  titleSize?: number;
  /** イントロの最初の段落が組まれたページ */
  introPage?: number;
  /** タイトルの終わりの高さ（sp, ページ下端から）。\@title が使われるたびに出る */
  titleEnds?: number[];
  /** タイトルを組み始める高さ（sp） */
  titleTops?: number[];
  /** 1 ページ目のヘッダー・フッターが空か */
  headEmpty?: boolean;
  footEmpty?: boolean;
  /** 版面（sp） */
  layout?: {
    textWidth: number;
    textHeight: number;
    paperHeight: number;
    left: number;
    top: number;
    headHeight: number;
    headSep: number;
    footSkip: number;
  };
}

export function parseCompileLog(log: string): CompileLog {
  const pos = new RegExp(`${POS_MARKER}=(-?\\d+),(-?\\d+)`).exec(log);
  const lay = new RegExp(`${LAYOUT_MARKER}=${Array(8).fill('(-?\\d+)').join(',')}`).exec(log)?.slice(1).map(Number);
  // BusyTeX のログは「$ コマンド」行で区切って各段のログファイルと端末出力を連結しているので、最後の段から読む。
  // \write-1 はログファイルにしか出ないので、端末出力（This is pdfTeX で始まる）からではなく段の先頭から読む
  const last = log.slice(Math.max(0, log.lastIndexOf('\n$ ')));
  const num = (marker: string) => {
    const m = new RegExp(`${marker}=(\\d+(?:\\.\\d+)?)`).exec(last);
    return m ? Number(m[1]) : undefined;
  };
  return {
    pos: pos ? { x: Number(pos[1]), y: Number(pos[2]) } : undefined,
    baseSize: num(BASE_MARKER),
    titleSize: num(TITLE_MARKER),
    introPage: num(INTRO_MARKER),
    titleEnds: [...last.matchAll(new RegExp(`${TITLE_END_MARKER}=(-?\\d+)`, 'g'))].map((m) => Number(m[1])),
    titleTops: [...last.matchAll(/MUG-TITLETOP=(-?\d+)/g)].map((m) => Number(m[1])),
    headEmpty: /MUG-HEAD=(empty|full)/.exec(last)?.[1] === 'empty' ? true : /MUG-HEAD=full/.test(last) ? false : undefined,
    footEmpty: /MUG-FOOT=(empty|full)/.exec(last)?.[1] === 'empty' ? true : /MUG-FOOT=full/.test(last) ? false : undefined,
    layout: lay
      ? { textWidth: lay[0], textHeight: lay[1], paperHeight: lay[2], left: lay[3], top: lay[4], headHeight: lay[5], headSep: lay[6], footSkip: lay[7] }
      : undefined,
  };
}

// パッチ → コンパイル → 計測 → 部品の切り出し の一連の流れと、自動フィット。
import type { CompileResult, TexEngine } from './engine';
import { PAD_BP, pageGeometry, partHeight, summarize, textCrop, widthScale, type CoverMeasure, type PageGeometry, type Part } from './impose';
import { availableHeight, availableWidth, K_RANGE, mmToBp, nextK, type MugOptions } from './mug';
import {
  culpritPackage,
  missingFiles,
  parseCompileLog,
  patchProject,
  type CompileLog,
  type PatchOptions,
  type PatchPhase,
  type ProjectPatch,
} from './patch';
import { basename, dirname } from './project';
import { emptyShim, shimFiles } from './stubs';
import type { ProjectFiles } from './zip';

export interface BuildResult {
  mug: MugOptions;
  /** 本文部分（original なら著者・Abstract・イントロ）のパッチとコンパイル */
  patch: ProjectPatch;
  compile: CompileResult;
  /** マグに並べる部品。コンパイルに失敗したら無い */
  parts?: Part[];
  measure?: CoverMeasure;
  /** UI に出す補足 */
  notes: string[];
  /** 見つからなかったため外したパッケージ */
  dropped: string[];
}

/** タイトルの上端として、組み始めの位置からタイトルの文字サイズの何倍上までを残すか（1 行目の高さの分） */
const TITLE_TOP_ROOM_PT = 1.2;
/** イントロを入れるのに必要な、Abstract の下の余白 (mm)。数行分 */
const MIN_INTRO_ROOM_MM = 8;
/** 本文の高さを決めるときの余裕 (mm)。切り出しの余白などで、はみ出さないように */
const HEIGHT_SLACK_MM = 0.5;
/**
 * 本文側をタイトルの終わりの何 bp 下から切り出すか。マーカーは TeX の最終行の下端（ベースライン＋深さ）だが、
 * 丸い文字はベースラインより少し下まで描かれるので、その分を避ける（タイトルの直後には著者欄までの空きがある）
 */
const TITLE_CUT_BP = 3;
/** 著者と Abstract が収まらないとき、本文の文字サイズを下げて組み直す回数の上限 */
const MAX_REFIT = 3;
/** 文字サイズを下げるときの余裕（少し小さめに見積もって、1 回で収まりやすくする） */
const REFIT_MARGIN = 0.97;
/** 文字サイズをこれより下げない (pt)。これでも入らなければ縮小する */
const MIN_REFIT_PT = 2.5;
/** 見つからないパッケージを外して組み直す回数の上限 */
const MAX_DROP_RETRIES = 8;

const SUPPORT_EXT = /\.(sty|cls|clo|cfg|def|fd|bst|bbx|cbx)$/i;

/**
 * メインと同じ場所に置く補助ファイル（TeX はカレントディレクトリしか探さないため）
 * - サブフォルダにある .sty や .cls
 * - BusyTeX に無い・使えないパッケージの代わり（シム）。プロジェクトに同名のファイルがあればそちらを使う
 * - 見つからなかったため外したパッケージの、中身の無い代わり（クラスが読み込む場合にも組版を通すため）
 */
function supportFiles(files: ProjectFiles, mainPath: string, dropped: string[]): Record<string, string | Uint8Array> {
  const dir = dirname(mainPath);
  const at = (name: string) => (dir ? `${dir}/${name}` : name);
  const out: Record<string, string | Uint8Array> = {};
  const add = (name: string, c: string | Uint8Array) => {
    const dest = at(name);
    if (!files.has(dest) && !(dest in out)) out[dest] = c;
  };
  for (const [p, c] of files) if (SUPPORT_EXT.test(p) && dirname(p) !== dir) add(basename(p), c);
  for (const [name, c] of Object.entries(shimFiles())) add(name, c);
  for (const pkg of dropped) add(`${pkg}.sty`, emptyShim(pkg));
  return out;
}

/** 見つからなかったパッケージへの対処。組み直しをまたいで引き継ぐ */
interface Missing {
  /** 外した（または中身の無い代わりを置いた）パッケージ */
  dropped: string[];
  /** BusyTeX に知らせるために書き足したパッケージ */
  hints: string[];
}

interface Compiled extends Missing {
  patch: ProjectPatch;
  compile: CompileResult;
  log: CompileLog;
  /** コンパイルに成功したときだけ */
  geom?: PageGeometry;
  notes: string[];
}

type CompileOpts = Pick<PatchOptions, 'adapterId' | 'width' | 'fullHeight'>;

async function compileOnce(
  engine: TexEngine,
  files: ProjectFiles,
  mainPath: string,
  mug: MugOptions,
  phase: PatchPhase,
  opts: CompileOpts,
  missing: Missing = { dropped: [], hints: [] },
): Promise<Compiled> {
  let { dropped, hints } = missing;
  for (let i = 0; ; i++) {
    const support = supportFiles(files, mainPath, dropped);
    const patch = patchProject(files, mainPath, { mug, phase, ...opts, dropPackages: dropped, hintPackages: hints });
    const compile = await engine.compile(files, patch.outPath, { ...support, [patch.outPath]: patch.source }, { bibtex: patch.bibtex });
    const log = parseCompileLog(compile.log);
    const notes = dropped.length ? [`${dropped.join('、')} は見つからない（または見つからないファイルを要求する）ため外して組みました`] : [];
    if (compile.ok && compile.pdf) {
      return { patch, compile, log, geom: await pageGeometry(compile.pdf, log, phase === 'full'), notes, dropped, hints };
    }
    // 見つからないパッケージへの対処。表紙に不要なことが多いので、組めることを優先する
    // - 自分で \usepackage したもの（またはそれを要求したもの）は外す
    // - クラスが要求したものは、まず \usepackage を書き足して BusyTeX に読み込ませる（latex-extra にあれば見つかる）。
    //   それでも見つからなければ、中身の無い代わりを置く
    const next = { dropped: [...dropped], hints: [...hints] };
    for (const m of missingFiles(compile.log).packages) {
      const culprit = culpritPackage(compile.log, m, patch.keptPackages);
      if (culprit && !next.dropped.includes(culprit)) next.dropped.push(culprit);
      else if (!culprit && !next.hints.includes(m)) next.hints.push(m);
      else if (!culprit && !next.dropped.includes(m)) next.dropped.push(m);
    }
    const changed = next.dropped.length !== dropped.length || next.hints.length !== hints.length;
    if (!changed || i >= MAX_DROP_RETRIES) return { patch, compile, log, notes, dropped, hints };
    ({ dropped, hints } = next);
  }
}

const failed = (mug: MugOptions, c: Compiled): BuildResult => ({
  mug,
  patch: c.patch,
  compile: c.compile,
  notes: c.notes,
  dropped: c.dropped,
});

/** 幅いっぱいに置くと高さを超える場合は、高さに合わせて縮める */
const fitScale = (crop: Part['crop'], mug: MugOptions, height = availableHeight(mug)) =>
  Math.min(widthScale(crop, mug), mmToBp(height) / (crop.top - crop.bottom));
const isShrunk = (p: Part, mug: MugOptions) => p.scale < widthScale(p.crop, mug) * 0.995;

/** モードに応じて表紙を組む。 */
export async function buildCover(
  engine: TexEngine,
  files: ProjectFiles,
  mainPath: string,
  mug: MugOptions,
  adapterId?: string,
  dropped: string[] = [],
): Promise<BuildResult> {
  return mug.mode === 'reflow'
    ? buildReflow(engine, files, mainPath, mug, adapterId, dropped)
    : buildOriginal(engine, files, mainPath, mug, adapterId, dropped);
}

/** reflow：紙の幅を k で決めて 1 段組で組み、版面を幅いっぱいに置く（はみ出しは報告する） */
async function buildReflow(
  engine: TexEngine,
  files: ProjectFiles,
  mainPath: string,
  mug: MugOptions,
  adapterId: string | undefined,
  dropped: string[],
): Promise<BuildResult> {
  const c = await compileOnce(engine, files, mainPath, mug, 'front', { adapterId }, { dropped, hints: [] });
  if (!c.geom) return failed(mug, c);
  const g = c.geom;
  const crop = textCrop(g, g.textTop, g.contentBottom);
  const part: Part = { pdf: c.compile.pdf!, crop, scale: widthScale(crop, mug), place: 'top' };
  const fits = g.pageCount === 1 && c.log.pos !== undefined && partHeight(part) <= availableHeight(mug) + 0.01;
  const measure = summarize([part], mug, {
    pageCount: g.pageCount,
    scale: part.scale,
    shrunk: false,
    fits,
    bodyPt: c.log.baseSize !== undefined ? c.log.baseSize * part.scale : undefined,
    titlePt: c.log.titleSize !== undefined ? c.log.titleSize * part.scale : undefined,
  });
  return { mug, patch: c.patch, compile: c.compile, parts: [part], measure, notes: c.notes, dropped: c.dropped };
}

/**
 * original：ヘッダーとタイトルは元の本文幅で組んだものを、著者・Abstract・イントロは本文サイズに合わせた幅で組んだものを
 * それぞれ切り出して縦に並べる。フッターは元の本文幅で組んだものから切り出して下端に置く。
 */
async function buildOriginal(
  engine: TexEngine,
  files: ProjectFiles,
  mainPath: string,
  mug: MugOptions,
  adapterId: string | undefined,
  dropped: string[],
): Promise<BuildResult> {
  const notes: string[] = [];
  // 1. 元の本文幅：ヘッダー・タイトル・フッター
  const a = await compileOnce(engine, files, mainPath, mug, 'front', { adapterId, width: 'original' }, { dropped, hints: [] });
  if (!a.geom) return failed(mug, a);
  // 2. 本文サイズに合わせた幅：著者・Abstract（高さの計測を兼ねる）
  let b = await compileOnce(engine, files, mainPath, mug, 'front', { adapterId, width: 'body' }, a);
  if (!b.geom) return failed(mug, b);
  const ga = a.geom;
  let gb = b.geom;
  const withHF = mug.includeHeaderFooter;

  const result = (body: Compiled, parts: Part[], bodyPart: Part, titlePart?: Part): BuildResult => ({
    mug,
    patch: body.patch,
    compile: { ...body.compile, log: `${body.compile.log}\n\n==== ヘッダー・タイトル（元の本文幅） ====\n${a.compile.log}` },
    parts,
    measure: summarize(parts, mug, {
      pageCount: body.geom!.pageCount,
      scale: bodyPart.scale,
      shrunk: isShrunk(bodyPart, mug),
      fits: true,
      bodyPt: body.log.baseSize !== undefined ? body.log.baseSize * bodyPart.scale : undefined,
      titlePt: a.log.titleSize !== undefined ? a.log.titleSize * (titlePart ?? bodyPart).scale : undefined,
    }),
    notes: [...body.notes, ...notes],
    dropped: body.dropped,
  });

  // タイトルの終わりが分からない（\@title を使わないクラスなど）ときは、本文サイズで組んだものだけを置く
  if (ga.titleEnd === undefined || gb.titleEnd === undefined) {
    notes.push('タイトルの位置が分からないため、タイトルも本文と同じ縮尺で組みました');
    const crop = textCrop(gb, withHF ? gb.headerTop : gb.textTop, gb.contentBottom);
    const part: Part = { pdf: b.compile.pdf!, crop, scale: fitScale(crop, mug), place: 'top' };
    return result(b, [part], part);
  }

  // 上段の上端：ヘッダーがあればヘッダーの帯から。無ければ（または含めない設定なら）タイトルのすぐ上から（\maketitle が上に入れる空きを切り詰める）
  const titleTop = ga.titleTop !== undefined ? Math.min(ga.textTop, ga.titleTop + TITLE_TOP_ROOM_PT * (a.log.titleSize ?? 10)) : ga.textTop;
  const titleCrop = textCrop(ga, withHF && !ga.headEmpty ? ga.headerTop : titleTop, ga.titleEnd);
  const titlePart: Part = { pdf: a.compile.pdf!, crop: titleCrop, scale: widthScale(titleCrop, mug), place: 'top' };
  const footerPart: Part | undefined =
    withHF && !ga.footEmpty
      ? { pdf: a.compile.pdf!, crop: { ...titleCrop, top: ga.footer.top, bottom: Math.max(0, ga.footer.bottom) }, scale: titlePart.scale, place: 'bottom' }
      : undefined;
  const assemble = (bodyPart: Part) => [titlePart, bodyPart, ...(footerPart ? [footerPart] : [])];
  const done = (body: Compiled, bodyPart: Part) => result(body, assemble(bodyPart), bodyPart, titlePart);

  // 著者・Abstract・イントロに使える高さ (mm)
  const room = availableHeight(mug) - partHeight(titlePart) - (footerPart ? partHeight(footerPart) : 0);
  const frontOf = (c: Compiled): Part => {
    const crop = textCrop(c.geom!, c.geom!.titleEnd! - TITLE_CUT_BP - PAD_BP, c.geom!.contentBottom);
    return { pdf: c.compile.pdf!, crop, scale: widthScale(crop, mug), place: 'top' };
  };
  let frontPart = frontOf(b);

  // 3a. 著者と Abstract だけで入らなければ、本文の文字サイズを下げて組み直す（縮小すると幅いっぱいにならないため）。
  // 中身の面積はほぼ一定なので、最終的な高さは文字サイズの 2 乗にほぼ比例するとみなす
  let bodyMug = mug;
  for (let i = 0; i < MAX_REFIT && partHeight(frontPart) > room; i++) {
    const pt = Math.floor(bodyMug.bodyPt * Math.sqrt(room / partHeight(frontPart)) * REFIT_MARGIN * 10) / 10;
    if (pt < MIN_REFIT_PT) break;
    const next = { ...mug, bodyPt: pt };
    const c = await compileOnce(engine, files, mainPath, next, 'front', { adapterId, width: 'body' }, b);
    if (!c.geom || c.geom.titleEnd === undefined) break;
    [b, gb, bodyMug, frontPart] = [c, c.geom, next, frontOf(c)];
  }
  if (bodyMug !== mug) {
    notes.push(`本文 ${mug.bodyPt}pt では著者と Abstract が印刷範囲に収まらないため、${bodyMug.bodyPt}pt に下げて組みました`);
  }
  // それでも入らなければ、高さに合わせて縮める
  if (partHeight(frontPart) > room) {
    notes.push('著者と Abstract だけで印刷範囲の高さを超えるため、イントロは入れずに縮小しました');
    return done(b, { ...frontPart, scale: fitScale(frontPart.crop, mug, room) });
  }
  const left = room - partHeight(frontPart);
  if (!mug.includeIntro) return done(b, frontPart);
  if (left < MIN_INTRO_ROOM_MM) {
    notes.push(`Abstract の下の余白が ${left.toFixed(1)} mm しかないため、イントロは入れませんでした（本文の文字サイズを小さくすると入ります）`);
    return done(b, frontPart);
  }

  // 3b. イントロを流し込む。本文の高さ = 版面の上端からタイトルの終わりまで + 使える高さ ÷ 縮尺。TeX が 1 ページ目の末尾で行単位に切る
  const ratio = (room - HEIGHT_SLACK_MM) / availableWidth(mug);
  const full = await compileOnce(
    engine,
    files,
    mainPath,
    bodyMug,
    'full',
    { adapterId, width: 'body', fullHeight: { fixedSp: gb.titleDepthSp!, ratio } },
    b,
  );
  const fallback = (note: string) => {
    notes.push(note);
    return done(b, frontPart);
  };
  if (!full.geom) return fallback('イントロを含めるとコンパイルに失敗しました。イントロ無しで出力します');
  // イントロが 1 ページ目に入らないと、LaTeX はイントロを 2 ページ目に回す
  if (full.log.introPage !== 1 || full.geom.titleEnd === undefined) {
    return fallback('Abstract の下にイントロが入らなかったため、イントロ無しで出力します（本文の文字サイズを小さくすると入ります）');
  }
  const crop = textCrop(full.geom, full.geom.titleEnd - TITLE_CUT_BP - PAD_BP, full.geom.contentBottom);
  return done(full, { pdf: full.compile.pdf!, crop, scale: fitScale(crop, mug, room), place: 'top' });
}

export interface FitTrial {
  k: number;
  finalHeight?: number;
  pageCount?: number;
  fits: boolean;
}

const MAX_TRIALS = 5;
/** 利用可能な高さに対してこの割合以上埋まっていれば打ち切る */
const GOOD_FILL = 0.93;

/** reflow：収まる最小の k を探す。最終的な高さは k² にほぼ反比例するとみなして更新する。 */
export async function autoFit(
  engine: TexEngine,
  files: ProjectFiles,
  mainPath: string,
  mug: MugOptions,
  adapterId?: string,
  onTrial?: (t: FitTrial) => void,
): Promise<{ best?: BuildResult; last: BuildResult; trials: FitTrial[] }> {
  const trials: FitTrial[] = [];
  let best: BuildResult | undefined;
  let last!: BuildResult;
  let k = mug.k;
  let dropped: string[] = [];
  let lo: number = K_RANGE[0]; // 収まらなかった最大の k
  let hi: number = K_RANGE[1]; // 収まった最小の k

  for (let i = 0; i < MAX_TRIALS; i++) {
    last = await buildCover(engine, files, mainPath, { ...mug, mode: 'reflow', k }, adapterId, dropped);
    dropped = last.dropped;
    const m = last.measure;
    const t: FitTrial = { k, finalHeight: m?.finalHeight, pageCount: m?.pageCount, fits: !!m?.fits };
    trials.push(t);
    onTrial?.(t);
    if (!m) break; // コンパイル失敗
    if (m.fits) {
      if (!best || k < best.mug.k) best = last;
      hi = Math.min(hi, k);
      if (m.finalHeight >= m.available * GOOD_FILL) break;
    } else {
      lo = Math.max(lo, k);
    }
    // 2 ページ目に溢れた場合は高さが測れないので、大きめに広げる
    let next = m.pageCount > 1 ? k * 1.5 : nextK(k, m.finalHeight, m.available);
    if (next <= lo || next >= hi) next = (lo + hi) / 2;
    next = Math.round(Math.min(K_RANGE[1], Math.max(K_RANGE[0], next)) * 1000) / 1000;
    if (Math.abs(next - k) < 0.01) break;
    k = next;
  }
  return { best, last, trials };
}

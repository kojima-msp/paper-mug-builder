// 組版結果の PDF から必要な帯を切り出し、マグの印刷範囲のページにベクターのまま並べる。
import { PDFDocument } from 'pdf-lib';
import { availableHeight, availableWidth, mmToBp, spToBp, type MugOptions } from './mug';
import type { CompileLog } from './patch';

export interface CropBox {
  /** PDF 座標 (bp)、左下が原点 */
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** マグに置く部品。top は上から順に積み、bottom は下端に置く */
export interface Part {
  pdf: Uint8Array;
  crop: CropBox;
  /** 表紙 → マグの縮尺 */
  scale: number;
  place: 'top' | 'bottom';
}

/** 切り出し範囲の外側に足す余裕 (bp) */
export const PAD_BP = 1;
const PAD = PAD_BP;
/** フッターのベースラインより下に出る分 (bp) */
const FOOT_DEPTH = 4;
/** フッターのベースラインより上に出る分の上限 (bp) */
const FOOT_HEIGHT = 12;

export const toMm = (bp: number) => (bp * 25.4) / 72;
export const cropWidth = (c: CropBox) => c.right - c.left;
export const cropHeight = (c: CropBox) => c.top - c.bottom;
/** 部品のマグ上での高さ (mm) */
export const partHeight = (p: Pick<Part, 'crop' | 'scale'>) => toMm(cropHeight(p.crop) * p.scale);

/** 1 ページ目の版面などの位置（すべて bp、PDF 座標） */
export interface PageGeometry {
  pageCount: number;
  textLeft: number;
  textWidth: number;
  textTop: number;
  textBottom: number;
  /** ヘッダーの帯の上端 */
  headerTop: number;
  /** フッターの帯 */
  footer: { top: number; bottom: number };
  /** 中身の終端の高さ。ページが埋まっている（2 ページ以上、または終端が 2 段目）なら版面の下端 */
  contentBottom: number;
  pageFull: boolean;
  /** タイトルの終わりの高さ（版面の中で最初のもの） */
  titleEnd?: number;
  /** 版面の上端から、タイトルの終わりまでの長さ (sp) */
  titleDepthSp?: number;
  /** タイトルを組み始める高さ */
  titleTop?: number;
  /** 1 ページ目のヘッダー・フッターが空か（分からなければ空でないとみなす） */
  headEmpty: boolean;
  footEmpty: boolean;
}

/**
 * flowing：本文を流し込んで 1 ページ目で切らせた組版か。そうでなければ（縦長の紙に表紙だけを組んだもの）、
 * 終端のマーカーが 2 段目にあってもページは埋まっていない（REVTeX などはタイトルの後のマーカーを右の段に置く）
 */
export async function pageGeometry(pdf: Uint8Array, log: CompileLog, flowing = true): Promise<PageGeometry> {
  const doc = await PDFDocument.load(pdf);
  const pageCount = doc.getPageCount();
  const { height: pageHeight } = doc.getPage(0).getSize();
  const lay = log.layout;
  if (!lay) throw new Error('ログに版面の情報（MUG-LAYOUT）がありません');

  const textLeft = spToBp(lay.left);
  const textWidth = spToBp(lay.textWidth);
  const textTop = pageHeight - spToBp(lay.top);
  const textBottom = textTop - spToBp(lay.textHeight);
  const endsOnPage1 = pageCount === 1 && log.pos !== undefined;
  const inRightColumn = endsOnPage1 && spToBp(log.pos!.x) > textLeft + textWidth / 2;
  const pageFull = !endsOnPage1 || (flowing && inRightColumn);
  const footBase = textBottom - spToBp(lay.footSkip);
  // \@title はヘッダーなどでも使われうるので、版面の中（上端より下）で最も上のものをタイトルの終わりとする
  const textTopSp = lay.paperHeight - lay.top;
  const titleEndSp = Math.max(-Infinity, ...(log.titleEnds ?? []).filter((y) => y < textTopSp));
  const hasTitleEnd = Number.isFinite(titleEndSp);
  const titleTopSp = Math.max(-Infinity, ...(log.titleTops ?? []).filter((y) => y <= textTopSp && (!hasTitleEnd || y > titleEndSp)));
  return {
    pageCount,
    textLeft,
    textWidth,
    textTop,
    textBottom,
    headerTop: textTop + spToBp(lay.headSep + lay.headHeight),
    footer: { top: footBase + Math.min(FOOT_HEIGHT, spToBp(lay.footSkip) - 2), bottom: footBase - FOOT_DEPTH },
    contentBottom: pageFull ? textBottom : Math.max(textBottom, spToBp(log.pos!.y)),
    pageFull,
    titleEnd: hasTitleEnd ? spToBp(titleEndSp) : undefined,
    titleDepthSp: hasTitleEnd ? textTopSp - titleEndSp : undefined,
    titleTop: Number.isFinite(titleTopSp) ? spToBp(titleTopSp) : undefined,
    headEmpty: log.headEmpty === true,
    footEmpty: log.footEmpty === true,
  };
}

/** 版面の幅で、上下を指定して切り出す範囲 */
export const textCrop = (g: PageGeometry, top: number, bottom: number): CropBox => ({
  left: g.textLeft - PAD,
  right: g.textLeft + g.textWidth + PAD,
  top: top + PAD,
  bottom: Math.max(0, bottom - PAD),
});

/** 幅いっぱい（利用可能な幅）に置く縮尺 */
export const widthScale = (crop: CropBox, mug: MugOptions) => mmToBp(availableWidth(mug)) / cropWidth(crop);

export async function imposeParts(parts: Part[], mug: MugOptions): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const bleed = mmToBp(mug.bleed);
  const pw = mmToBp(mug.printWidth);
  const ph = mmToBp(mug.printHeight);
  const page = out.addPage([pw + 2 * bleed, ph + 2 * bleed]);
  const margin = mmToBp(mug.margin);
  const availW = pw - 2 * margin;
  const availTop = bleed + ph - margin;
  const availBottom = bleed + margin;

  const sources = new Map<Uint8Array, PDFDocument>();
  const load = async (pdf: Uint8Array) => sources.get(pdf) ?? sources.set(pdf, await PDFDocument.load(pdf)).get(pdf)!;
  const draw = async (p: Part, x: number, y: number) => {
    const embedded = await out.embedPage((await load(p.pdf)).getPage(0), p.crop);
    page.drawPage(embedded, { x, y, width: cropWidth(p.crop) * p.scale, height: cropHeight(p.crop) * p.scale });
  };
  const xOf = (p: Part) => bleed + margin + (availW - cropWidth(p.crop) * p.scale) / 2;
  const h = (p: Part) => cropHeight(p.crop) * p.scale;

  // 下端に置く部品（フッター）
  let floor = availBottom;
  for (const p of parts.filter((q) => q.place === 'bottom')) {
    await draw(p, xOf(p), floor);
    floor += h(p);
  }
  // 上から積む部品。縦位置の設定に従い、残りの範囲の中で中央か上に寄せる。はみ出す場合は上端を揃える
  const stack = parts.filter((q) => q.place === 'top');
  const free = availTop - floor - stack.reduce((s, p) => s + h(p), 0);
  let y = availTop - (free > 0 && mug.valign === 'center' ? free / 2 : 0);
  for (const p of stack) {
    y -= h(p);
    await draw(p, xOf(p), y);
  }

  out.setTitle('paper mug');
  out.setProducer('paper-mug-builder');
  return out.save();
}

/** 部品の並びの要約（UI 表示用） */
export interface CoverMeasure {
  pageCount: number;
  /** 本文部分の縮尺 */
  scale: number;
  /** 最終的な中身の大きさ (mm) */
  finalWidth: number;
  finalHeight: number;
  /** 利用可能な高さ (mm) */
  available: number;
  /** 高さに合わせて幅いっぱいより縮めた */
  shrunk: boolean;
  fits: boolean;
  /** マグ上での本文とタイトルの文字サイズ (pt)。ログから読めた場合のみ */
  bodyPt?: number;
  titlePt?: number;
}

export function summarize(parts: Part[], mug: MugOptions, extra: Omit<CoverMeasure, 'finalWidth' | 'finalHeight' | 'available'>): CoverMeasure {
  return {
    ...extra,
    finalWidth: Math.max(...parts.map((p) => toMm(cropWidth(p.crop) * p.scale))),
    finalHeight: parts.reduce((s, p) => s + partHeight(p), 0),
    available: availableHeight(mug),
  };
}

// マグの寸法と、紙・面付けの計算。

export type LayoutMode = 'original' | 'reflow';

export interface MugOptions {
  /** original: 論文の版面のまま（本文幅はクラスのまま）、reflow: 本文幅を k で組み直す */
  mode: LayoutMode;
  /** original のとき、余白にイントロの冒頭を流し込む */
  includeIntro: boolean;
  /** original のときの、マグ上での本文の文字サイズ (pt)。本文幅はこれに合わせて決める */
  bodyPt: number;
  /** original のとき、ヘッダー・フッターの帯も切り出す */
  includeHeaderFooter: boolean;
  /** mm, 印刷範囲の幅 */
  printWidth: number;
  /** mm, 印刷範囲の高さ */
  printHeight: number;
  /** mm, 印刷範囲の内側の余白（最終寸法） */
  margin: number;
  /** mm, 塗り足し */
  bleed: number;
  /** reflow のときの紙の拡大率。大きいほど最終的な文字は小さくなる */
  k: number;
  valign: 'center' | 'top';
}

export const MUG_PRESETS = {
  'square85': { label: '正面 85 × 85 mm（仮）', printWidth: 85, printHeight: 85 },
} as const;

export const DEFAULT_MUG: MugOptions = {
  mode: 'original',
  includeIntro: true,
  bodyPt: 6,
  includeHeaderFooter: true,
  printWidth: 85,
  printHeight: 85,
  margin: 4,
  bleed: 0,
  k: 1.5,
  valign: 'center',
};

export const MIN_FONT_PT = 6;
export const K_RANGE = [1.0, 4.0] as const;
export const BODY_PT_RANGE = [3.5, 9] as const;
/** 改ページを起こさないよう、紙は印刷範囲の何倍の高さにするか */
export const PAPER_HEIGHT_FACTOR = 3;

export const mmToBp = (mm: number) => (mm * 72) / 25.4;
/** TeX の sp（1/65536 pt）を PDF の bp に換算 */
export const spToBp = (sp: number) => ((sp / 65536) * 72) / 72.27;

export interface PaperGeometry {
  /** すべて mm */
  paperWidth: number;
  paperHeight: number;
  margin: number;
}

export function paperGeometry(o: MugOptions): PaperGeometry {
  return {
    paperWidth: round(o.printWidth * o.k),
    paperHeight: round(o.printHeight * o.k * PAPER_HEIGHT_FACTOR),
    margin: round(o.margin * o.k),
  };
}

/** 利用可能な範囲 (mm) */
export const availableWidth = (o: MugOptions) => o.printWidth - 2 * o.margin;
export const availableHeight = (o: MugOptions) => o.printHeight - 2 * o.margin;

/** 次に試す k。最終的な高さは k の 2 乗にほぼ反比例するとみなす。 */
export function nextK(k: number, finalHeight: number, avail: number): number {
  const kk = k * Math.sqrt(finalHeight / avail);
  return Math.min(K_RANGE[1], Math.max(K_RANGE[0], round(kk * 1.02)));
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// スタイル（文書クラス）ごとの対応。新しいスタイルは、フォルダを 1 つ足して下の一覧に加える（README.md 参照）。
import { generic } from './generic';
import { ieeeoj } from './ieeeoj';
import { ieeetran } from './ieeetran';
import { revtex } from './revtex';
import type { StyleAdapter } from './types';

export type { StyleAdapter } from './types';

/** 上から順に match するものを使う。generic は最後に置く。 */
export const styles: StyleAdapter[] = [ieeetran, ieeeoj, revtex, generic];

export function pickStyle(cls: string, options: string[], overrideId?: string): StyleAdapter {
  if (overrideId) {
    const s = styles.find((x) => x.id === overrideId);
    if (s) return s;
  }
  return styles.find((s) => s.match(cls, options))!;
}

/** 全スタイルの .bst の代わりを合わせたもの */
export const bstSubstitutes: Record<string, string> = Object.assign({}, ...styles.map((s) => s.bstSubstitutes ?? {}));

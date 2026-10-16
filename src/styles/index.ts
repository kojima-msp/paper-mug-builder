// スタイル（文書クラス）ごとの対応。新しいスタイルは、style.json と .tex を入れたフォルダを足す（README.md 参照）。
// 一覧（registry.ts）は scripts/gen-styles.mjs が作る（npm run styles。テスト・開発・ビルドの前にも自動で走る）
import { registry } from './registry';
import { fromSpec } from './spec';
import type { StyleAdapter } from './types';

export type { StyleAdapter } from './types';

/** 上から順に match するものを使う。generic は最後（どのクラスにも当てはまる） */
export const styles: StyleAdapter[] = registry.map(({ spec, files }) => fromSpec(spec, files));

export function pickStyle(cls: string, options: string[], overrideId?: string): StyleAdapter {
  if (overrideId) {
    const s = styles.find((x) => x.id === overrideId);
    if (s) return s;
  }
  return styles.find((s) => s.match(cls, options))!;
}

/** 全スタイルの .bst の代わりを合わせたもの */
export const bstSubstitutes: Record<string, string> = Object.assign({}, ...styles.map((s) => s.bstSubstitutes ?? {}));

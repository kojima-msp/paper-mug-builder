import { describe, expect, it } from 'vitest';
// @ts-expect-error 素の JavaScript のスクリプト
import { generate } from '../scripts/gen-styles.mjs';
import { pickStyle, styles } from '../src/styles';
import { fromSpec } from '../src/styles/spec';

describe('style.json', () => {
  it('すべてのスタイルの設定が正しく、generic が最後', () => {
    const ids: string[] = generate();
    expect(ids.at(-1)).toBe('generic');
    expect(styles.map((s) => s.id)).toEqual(ids);
  });
  it('クラス名は大文字小文字を区別せず、/…/ は正規表現として扱う', () => {
    expect(pickStyle('ieeeoj', []).id).toBe('ieeeoj');
    expect(pickStyle('aastex701', []).id).toBe('revtex');
    expect(pickStyle('revtex4-2', []).id).toBe('revtex');
    expect(pickStyle('nosuchclass', []).id).toBe('generic');
  });
  it('titleAbstract の ifOptions・unlessOptions と、reflow のオプションの書き換え', () => {
    const s = fromSpec(
      {
        id: 'x',
        label: 'X',
        match: { classes: ['x'] },
        original: { titleAbstract: { file: 't.tex', ifOptions: ['twocolumn'], unlessOptions: ['draft'] } },
        reflow: { removeOptions: ['twocolumn'], addOptions: ['onecolumn'] },
      },
      { 't.tex': 'A{{abstract}}B\n' },
    );
    expect(s.original.titleAbstract!('abs', ['twocolumn'])).toBe('AabsB\n');
    expect(s.original.titleAbstract!('abs', [])).toBeNull();
    expect(s.original.titleAbstract!('abs', ['twocolumn', 'draft'])).toBeNull();
    expect(s.reflow.editOptions(['twocolumn', '10pt'])).toEqual(['10pt', 'onecolumn']);
  });
});

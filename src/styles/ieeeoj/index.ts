// IEEEoj（IEEE Open Journal 系：OJSP、OJIM など）。IEEEtran をもとにしたクラス。
// Abstract と Index Terms は \maketitle より前に書き、クラスが箱にしまって、タイトル部分（全幅）の著者欄の下に出す。
// そのため Abstract を動かす必要はなく、元の書式（ABSTRACT の見出し、左右 3pc の字下げ）のまま組まれる。
import { ieeetran } from '../ieeetran';
import type { StyleAdapter } from '../types';

export const ieeeoj: StyleAdapter = {
  id: 'ieeeoj',
  label: 'IEEEoj（IEEE Open Journal）',
  // ファイル名は ieeeoj.cls、\documentclass{IEEEoj} と書かれることが多い（TeX はファイル名の大文字小文字を区別しない設定）
  match: (cls) => cls.toLowerCase() === 'ieeeoj',
  keywordEnvs: ['IEEEkeywords'],
  defaultFontSize: 10,
  bstSubstitutes: ieeetran.bstSubstitutes,
  original: {
    titleAbstract: () => null,
  },
  reflow: {
    editOptions: (options) => options,
  },
};

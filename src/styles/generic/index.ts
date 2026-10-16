// 汎用（article など）。どのスタイルにも当たらないときに使う。
import { fill } from '../template';
import { withoutOption, type StyleAdapter } from '../types';
import titleAbstract from './title-abstract.tex?raw';

export const generic: StyleAdapter = {
  id: 'generic',
  label: '汎用（article など）',
  match: () => true,
  // elsarticle は単数形の keyword
  keywordEnvs: ['keywords', 'keyword'],
  defaultFontSize: 10,
  original: {
    // 1 段組なら Abstract は元々全幅なので動かさない
    titleAbstract: (abs, options) => (options.includes('twocolumn') ? `${fill(titleAbstract, { abstract: abs })}\n` : null),
  },
  reflow: {
    editOptions: (options) => withoutOption(options, 'twocolumn'),
  },
};

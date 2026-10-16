// IEEEtran（IEEE の会議・論文誌）
import { fill } from '../template';
import { withoutOption, type StyleAdapter } from '../types';
import originalPreamble from './original-preamble.tex?raw';
import reflowPreamble from './reflow-preamble.tex?raw';
import titleAbstract from './title-abstract.tex?raw';

const isCompsoc = (options: string[]) => options.includes('compsoc');

export const ieeetran: StyleAdapter = {
  id: 'ieeetran',
  label: 'IEEEtran',
  match: (cls) => cls === 'IEEEtran',
  keywordEnvs: ['IEEEkeywords'],
  defaultFontSize: 10,
  check(masked) {
    const warnings: string[] = [];
    if (/\\IEEEtitleabstractindextext\b/.test(masked) || /\\documentclass\s*\[[^\]]*\bcompsoc\b/.test(masked)) {
      warnings.push('IEEEtran の compsoc（\\IEEEtitleabstractindextext）方式は PoC の対象外です。Abstract が出ないことがあります');
    }
    return warnings;
  },
  // IEEEtran.bst は BusyTeX に無い
  bstSubstitutes: { IEEEtran: 'ieeetr', IEEEtranN: 'unsrtnat', IEEEtranS: 'plain' },
  original: {
    // 1 段組と compsoc は Abstract を動かさない
    titleAbstract: (abs, options) =>
      options.includes('onecolumn') || isCompsoc(options) ? null : `${fill(titleAbstract, { abstract: abs })}\n`,
    preamble: () => fill(originalPreamble),
  },
  reflow: {
    // 既定が 2 段組なので onecolumn を明示する
    editOptions: (options) => [...withoutOption(withoutOption(options, 'twocolumn'), 'onecolumn'), 'onecolumn'],
    preamble: () => fill(reflowPreamble),
  },
};

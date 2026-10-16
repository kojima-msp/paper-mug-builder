// REVTeX 4.2（APS・AIP の雑誌：Physical Review など）と、REVTeX を内蔵した AASTeX（AAS の雑誌：ApJ・AJ など）。
// Abstract と \keywords は \maketitle より前に書き、クラスがタイトル部分（全幅）に組むので動かさない。
// \maketitle を書かなくても、最初の \section でタイトル部分が出る（ここでは \section の手前で切るので補う）。
import { fill } from '../template';
import { withoutOption, type StyleAdapter } from '../types';
import afterBibliography from './after-bibliography.tex?raw';
import beforeTextwidth from './before-textwidth.tex?raw';
import originalPreamble from './original-preamble.tex?raw';

export const revtex: StyleAdapter = {
  id: 'revtex',
  label: 'REVTeX（APS・AIP）・AASTeX（AAS）',
  match: (cls) => /^revtex4(-[12])?$/.test(cls) || /^aastex\d*$/.test(cls),
  keywordEnvs: ['keywords'],
  defaultFontSize: 10,
  original: {
    titleAbstract: () => null,
    ensureMaketitle: true,
    beforeTextwidth: () => fill(beforeTextwidth),
    afterBibliography: () => fill(afterBibliography),
    preamble: () => fill(originalPreamble),
  },
  reflow: {
    editOptions: (options) => withoutOption(withoutOption(options, 'twocolumn'), 'reprint'),
  },
};

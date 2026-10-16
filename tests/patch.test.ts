import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MUG, paperGeometry, type MugOptions } from '../src/mug';
import {
  BASE_MARKER,
  INTRO_MARKER,
  LAYOUT_MARKER,
  POS_MARKER,
  TITLE_END_MARKER,
  TITLE_MARKER,
  culpritPackage,
  missingFiles,
  parseCompileLog, patchProject, patchSource, PatchError, type PatchPhase } from '../src/patch';
import { detectMain, flatten, joinPath } from '../src/project';
import { maskComments, removeCommandWithArg, removeEnvironments, unclosedEnvironments } from '../src/texparse';
import { readZip, type ProjectFiles } from '../src/zip';
import { pickStyle, styles } from '../src/styles';
import { fill } from '../src/styles/template';
import endMarkerTex from '../src/styles/common/end-marker.tex?raw';
import introMarkerTex from '../src/styles/common/intro-marker.tex?raw';
import markersTex from '../src/styles/common/markers.tex?raw';

const FIXTURES = path.join(__dirname, 'fixtures');

function load(name: string, base = ''): ProjectFiles {
  const dir = path.join(FIXTURES, name, base);
  const files: ProjectFiles = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [p, c] of load(name, rel)) files.set(p, c);
    else files.set(rel, new Uint8Array(fs.readFileSync(path.join(dir, e.name))));
  }
  return files;
}

const mug = (o: Partial<MugOptions> = {}): MugOptions => ({ ...DEFAULT_MUG, ...o });
const reflow = (o: Partial<MugOptions> = {}) => mug({ mode: 'reflow', ...o });
const patch = (name: string, o: Partial<MugOptions> = {}, phase?: PatchPhase, files = load(name)) =>
  patchProject(files, 'main.tex', { mug: mug(o), phase });
const body = (src: string) => src.slice(src.indexOf('\\begin{document}'));

describe('texparse', () => {
  it('maskComments：同じ長さで % 以降を空白にし、\\% は残す', () => {
    const src = 'a % c\nb \\% d\ne \\\\% f\n';
    const m = maskComments(src);
    expect(m.length).toBe(src.length);
    expect(m).toBe('a    \nb \\% d\ne \\\\   \n');
  });
  it('unclosedEnvironments：閉じていない環境を開いた順に返す', () => {
    expect(unclosedEnvironments('\\begin{a}\\begin{b}\\end{b}\\begin{c}', 0, 100)).toEqual(['a', 'c']);
  });
  it('removeCommandWithArg：入れ子の波括弧ごと取り除き、\\{ やコメント内の } で迷わない', () => {
    const r = removeCommandWithArg('A\\thanks{x {y} \\} % }\n z}B\\thanks[1]{w}C\\thanksx', 'thanks');
    expect(r.source).toBe('ABC\\thanksx');
    expect(r.count).toBe(2);
  });
  it('removeEnvironments：入れ子ごと取り除く', () => {
    const r = removeEnvironments('A\\begin{figure}x\\begin{figure}y\\end{figure}\\end{figure}B\\begin{table*}t\\end{table*}C', ['figure', 'table*']);
    expect(r.source).toBe('ABC');
    expect(r.removed).toEqual(['figure', 'table*']);
  });
});

describe('detectMain', () => {
  it('コメント内の \\documentclass は候補にしない', () => {
    expect(detectMain(load('commented-docclass')).main).toBe('main.tex');
  });
  it('候補が複数なら main.tex を優先する', () => {
    const d = detectMain(load('multi-main'));
    expect(d.candidates).toEqual(['draft.tex', 'main.tex', 'supplement.tex']);
    expect(d.main).toBe('main.tex');
  });
  it('優先名が無ければ決めない', () => {
    const files = load('multi-main');
    files.delete('main.tex');
    expect(detectMain(files).main).toBeUndefined();
  });
});

describe('flatten', () => {
  it('\\input と \\include を展開し、末尾に改行を補う', () => {
    const r = flatten(load('input-abstract'), 'main.tex');
    expect(r.inlined).toEqual(['macros.tex', 'sections/abstract.tex', 'sections/intro.tex']);
    expect(r.source).toContain('\\newcommand{\\mug}{MUG}');
    expect(r.source).toContain('% trailing comment without newline\n\n\\section{Intro}');
    expect(r.source).not.toContain('\\input{sections/abstract}');
    expect(r.source).not.toContain('\\clearpage');
  });
  it('zip に無いファイルは残して情報ログを出す', () => {
    const files: ProjectFiles = new Map([['main.tex', strToU8('\\input{glyphtounicode}\n\\input{a}')]]);
    const r = flatten(files, 'main.tex');
    expect(r.source).toBe('\\input{glyphtounicode}\n\\input{a}');
    expect(r.info).toHaveLength(2);
  });
  it('波括弧なしの \\input は警告する', () => {
    const files: ProjectFiles = new Map([['main.tex', strToU8('\\input foo\n\\inputencoding{utf8}')]]);
    expect(flatten(files, 'main.tex').warnings).toHaveLength(1);
  });
  it('パスはメインのディレクトリ基準で解決する', () => {
    const files: ProjectFiles = new Map([
      ['paper/main.tex', strToU8('A\\input{sec/x}B')],
      ['paper/sec/x.tex', strToU8('\\input{sec/y}')],
      ['paper/sec/y.tex', strToU8('Y')],
    ]);
    expect(flatten(files, 'paper/main.tex').source).toBe('AY\nB');
  });
  it('joinPath', () => {
    expect(joinPath('a/b', '../c/./d')).toBe('a/c/d');
    expect(joinPath('', './x')).toBe('x');
  });
});

describe('original：IEEEtran conference', () => {
  const full = patch('ieee-conf');
  const front = patch('ieee-conf', {}, 'front');

  it('クラスオプションは変えない（2 段組のまま）', () => {
    expect(full.options).toEqual(['conference']);
    expect(full.source).toMatch(/^\\documentclass\[conference\]\{IEEEtran\}/);
  });
  it('Abstract を \\IEEEaftertitletext に移し、\\maketitle の前に置く', () => {
    expect(full.movedAbstract).toBe(true);
    const b = body(full.source);
    const moved = b.indexOf('\\IEEEaftertitletext{');
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(b.indexOf('\\maketitle'));
    expect(b.indexOf('\\begin{abstract}')).toBeGreaterThan(moved);
    expect(b.indexOf('\\end{abstract}')).toBeLessThan(b.indexOf('\\maketitle'));
  });
  it('コメント内の \\end{abstract} ではなく本物の後で切り、コメントは残す', () => {
    expect(full.source).toContain('% a comment with \\end{abstract} inside');
    expect(body(full.source)).toContain('Excepteur sint occaecat');
  });
  it('Abstract の直後の Keywords は常に含め、Abstract と一緒にタイトル直下へ移す', () => {
    expect(full.cutReason).toBe('keywords');
    const b = body(full.source);
    expect(b).toContain('mugs, typesetting, ceramics\n\\end{IEEEkeywords}');
    expect(b.indexOf('\\end{IEEEkeywords}')).toBeLessThan(b.indexOf('\\maketitle'));
  });
  it('full：イントロだけを流し込み、図は省き、次の節と文献リストは入れない', () => {
    expect(full.includedIntro).toBe(true);
    const b = body(full.source);
    expect(b).toContain('\\section{Introduction}');
    expect(b).toContain('Vivamus consectetuer hendrerit lacus.');
    expect(b).not.toContain('\\section{Related Work}');
    expect(b).not.toContain('A figure that must be dropped');
    expect(full.removedFloats).toEqual(['figure']);
    expect(b).toContain('\\AddToHookNext{para/begin}{\\pdfsavepos\\write-1{MUG-INTRO=\\thepage}}');
  });
  it('full：引用は捨て箱の中で BibTeX にかける（IEEEtran.bst は ieeetr で代用）', () => {
    expect(full.citeSource).toBe('bibtex');
    expect(full.bibtex).toBe(true);
    expect(full.source).toContain('\\begingroup\\makeatletter\\setbox0=\\vbox{\\bibliographystyle{ieeetr}\\bibliography{refs}}\\endgroup');
    expect(full.warnings.some((w) => w.includes('ieeetr'))).toBe(true);
  });
  it('full：本文幅をマグ上の本文サイズから決め、ヘッダー・フッターの帯を除いた高さを印刷範囲の縦横比に合わせる', () => {
    // 利用可能な幅 77 mm × 元の文字サイズ ÷ 6pt
    expect(full.source).toContain('\\setlength{\\textwidth}{\\fpeval{77.000*\\f@size/6}mm}');
    expect(full.source.indexOf('\\setlength{\\textwidth}')).toBeLessThan(full.source.indexOf('\\setlength{\\textheight}'));
    expect(full.source).toContain('\\setlength{\\textheight}{\\dimexpr1.00000\\textwidth-\\headheight-\\headsep-\\footskip-4bp\\relax}');
    const plain = patch('ieee-conf', { printWidth: 100, printHeight: 80, margin: 5, bodyPt: 4.5, includeHeaderFooter: false });
    expect(plain.source).toContain('\\setlength{\\textwidth}{\\fpeval{90.000*\\f@size/4.5}mm}');
    expect(plain.source).toContain('\\setlength{\\textheight}{\\dimexpr0.77778\\textwidth\\relax}');
    expect(full.source).not.toContain('{geometry}');
  });
  it('width: original なら本文幅は変えない。fullHeight を指定すれば本文の高さはそれに従う', () => {
    const a = patchProject(load('ieee-conf'), 'main.tex', { mug: mug(), phase: 'front', width: 'original' });
    expect(a.source).not.toContain('\\setlength{\\textwidth}');
    const f = patchProject(load('ieee-conf'), 'main.tex', { mug: mug(), phase: 'full', fullHeight: { fixedSp: 12345.6, ratio: 0.8 } });
    expect(f.source).toContain('\\setlength{\\textheight}{\\dimexpr12346sp+0.80000\\textwidth\\relax}');
  });
  it('タイトルの終わりの位置を出すマーカーを \\@title に付ける', () => {
    expect(full.source).toContain('\\@ifundefined{mug@origtitle}{\\let\\mug@origtitle\\@title\\def\\@title{\\mug@titletop\\mug@titlesize\\mug@origtitle\\mug@titleend}}{}');
    expect(full.source).toContain('\\write-1{MUG-TITLEEND=\\the\\pdflastypos}');
  });
  it('conference モードの \\IEEEaftertitletext のロックを解除する（解除しないと Abstract が黙って捨てられる）', () => {
    expect(full.source).toContain('\\IEEEoverridecommandlockouts');
  });
  it('タイトル部分の後の、行を格子に揃えるための空きを入れない', () => {
    expect(full.source).toContain('\\long\\def\\IEEEquantizevspace#1[#2]#3[#4]#5#6#7{#1}');
  });
  it('ページスタイルはクラスのまま（\\pagestyle{empty} にしない）', () => {
    expect(full.source).not.toContain('\\pagestyle{empty}');
    expect(full.source).not.toContain('\\thispagestyle{empty}');
  });
  it('front：イントロは入れず、縦長の紙にする', () => {
    expect(front.includedIntro).toBe(false);
    expect(body(front.source)).not.toContain('\\section{Introduction}');
    expect(front.source).toContain('\\setlength{\\textheight}{3\\paperheight}');
    expect(front.bibtex).toBe(false);
  });
  it('版面と終端の位置をログに出すコードを入れる', () => {
    expect(full.source).toContain('\\AtBeginDocument{\\typeout{MUG-LAYOUT=');
    expect(full.source).toContain('\\pdfsavepos\\write-1{MUG-POS=\\the\\pdflastxpos,\\the\\pdflastypos}');
    expect(full.source.indexOf('MUG-POS=')).toBeLessThan(full.source.indexOf('\\begingroup\\makeatletter\\setbox0=\\vbox{'));
    expect(full.source.trimEnd()).toMatch(/\\end\{document\}$/);
  });
  it('元の .bbl があればそれを使う', () => {
    const files = load('ieee-conf');
    files.set('main.bbl', strToU8('\\begin{thebibliography}{1}\\bibitem{smith2020}S.\\end{thebibliography}'));
    const r = patch('ieee-conf', {}, 'full', files);
    expect(r.citeSource).toBe('bbl');
    expect(r.source).toContain('\\setbox0=\\vbox{\\input{main.bbl}}');
  });
  it('イントロを入れない設定なら full でも入れない', () => {
    expect(patch('ieee-conf', { includeIntro: false }).includedIntro).toBe(false);
  });
});

describe('original：generic', () => {
  it('2 段組の article は \\@maketitle の末尾に Abstract を足す', () => {
    const r = patch('article-twocol');
    expect(r.options).toEqual(['twocolumn', '11pt']);
    expect(r.movedAbstract).toBe(true);
    expect(body(r.source)).toContain('\\g@addto@macro\\@maketitle{%\n\\begin{abstract}');
  });
  it('1 段組なら Abstract は動かさない', () => {
    const r = patch('input-abstract');
    expect(r.movedAbstract).toBe(false);
    expect(body(r.source)).toContain('lives in its own file');
    expect(body(r.source)).toContain('\\section{Intro}');
  });
  it('\\maketitle が無ければ Abstract（と直後の Keywords）の後で切り、frontmatter を閉じる', () => {
    const r = patch('elsarticle-like', {}, 'front');
    expect(r.cutReason).toBe('keywords');
    expect(r.closedEnvs).toEqual(['frontmatter']);
    expect(body(r.source)).toMatch(/\\end\{keywords\}\n\\end\{frontmatter\}\n/);
  });
});

describe('reflow', () => {
  const r = patchProject(load('ieee-conf'), 'main.tex', { mug: reflow() });

  it('IEEEtran：twocolumn を外して onecolumn にし、Abstract を「Abstract—」の書式に再定義する', () => {
    expect(r.adapter.id).toBe('ieeetran');
    expect(r.options).toEqual(['conference', 'onecolumn']);
    expect(r.movedAbstract).toBe(false);
    expect(r.source).toContain('\\def\\abstract{\\normalfont\\@IEEEabskeysecsize\\bfseries\\textit{\\abstractname}---');
  });
  it('ページスタイルは empty にする', () => {
    expect(r.source).toContain('\\pagestyle{empty}');
  });
  it('geometry で紙を印刷範囲 × k にし、イントロは入れない', () => {
    const g = paperGeometry(reflow());
    expect(r.source).toContain(`\\usepackage[paperwidth=${g.paperWidth}mm,paperheight=${g.paperHeight}mm,hmargin=${g.margin}mm,vmargin=${g.margin}mm]{geometry}`);
    expect(r.includedIntro).toBe(false);
    expect(body(r.source)).not.toContain('\\section');
  });
  it('article の twocolumn を外し、文字サイズを読む', () => {
    const a = patchProject(load('article-twocol'), 'main.tex', { mug: reflow() });
    expect(a.options).toEqual(['11pt']);
    expect(a.baseFontSize).toBe(11);
  });
  it('コメントアウトされた \\documentclass は書き換えない', () => {
    const a = patchProject(load('commented-docclass'), 'main.tex', { mug: reflow() });
    expect(a.source).toContain('% \\documentclass[twocolumn]{IEEEtran}');
    expect(a.source).toContain('\\documentclass[10pt]{article}');
    expect(body(a.source)).toContain('50\\% of the text');
  });
  it('アダプタを手動指定できる', () => {
    const a = patchProject(load('article-twocol'), 'main.tex', { mug: reflow(), adapterId: 'ieeetran' });
    expect(a.options).toEqual(['11pt', 'onecolumn']);
  });
});

describe('警告とパッケージの無効化', () => {
  it('IEEEtran compsoc は警告し、Abstract は動かさない', () => {
    const r = patch('ieee-compsoc');
    expect(r.warnings.some((w) => w.includes('compsoc'))).toBe(true);
    expect(r.movedAbstract).toBe(false);
  });
  it('minted と svg を外し、空定義を同じ位置に入れる。\\thanks は中身ごと取り除く', () => {
    const r = patch('stubbed', { includeIntro: false });
    expect(r.removedPackages).toEqual(['minted', 'svg']);
    expect(r.source).toContain('\\usepackage{amsmath,graphicx}');
    expect(r.source).toContain('% [paper-mug] removed svg: \\usepackage[inkscapelatex=false]{svg}');
    expect(r.source.indexOf('\\providecommand\\setminted')).toBeLessThan(r.source.indexOf('\\setminted{fontsize'));
    expect(r.removedThanks).toBe(1);
    expect(r.source).not.toContain('\\thanks');
    expect(r.source).not.toContain('Mug Foundation');
    expect(r.source).toContain('\\author{Grace Example}');
  });
  const pre = (usepkgs: string, body = '', extraPreamble = '') =>
    `\\documentclass{article}\n${usepkgs}\n${extraPreamble}\n\\begin{document}\\title{T}\\maketitle\\begin{abstract}A ${body}\\end{abstract}\\end{document}`;
  it('BusyTeX に無い tikz・soul は空定義に差し替え、常に外すもの（stfloats）と指定したものも外す', () => {
    const r = patchSource(pre('\\usepackage{tikz,soul,stfloats,amsmath}\n\\usetikzlibrary{arrows}\n\\usepackage[x]{foo}'), { mug: mug(), dropPackages: ['foo'] });
    expect(r.removedPackages).toEqual(['tikz', 'soul', 'stfloats', 'foo']);
    expect(r.keptPackages).toEqual(['amsmath']);
    expect(r.source).toContain('\\usepackage{amsmath}');
    expect(r.source).toContain('% [paper-mug] removed foo: \\usepackage[x]{foo}');
    // tikz が読み込んでいた xcolor を代わりに読み込み、設定コマンドは後続より前で空にする
    expect(r.source).toContain('\\usepackage{xcolor}');
    expect(r.source.indexOf('\\providecommand\\usetikzlibrary')).toBeLessThan(r.source.indexOf('\\usetikzlibrary{arrows}'));
    expect(r.source).toContain('\\providecommand\\ul[1]{#1}');
  });
  it('表紙とイントロで使われていない multirow・cleveref は外し、使われていれば残す', () => {
    const unused = patchSource(pre('\\usepackage{multirow,cleveref}', '', '\\crefname{figure}{Fig.}{Figs.}'), { mug: mug() });
    expect(unused.removedPackages).toEqual(['multirow', 'cleveref']);
    expect(unused.source.indexOf('\\providecommand\\crefname')).toBeLessThan(unused.source.indexOf('\\crefname{figure}'));
    const used = patchSource(pre('\\usepackage{multirow,cleveref}', 'see \\cref{sec:x}'), { mug: mug() });
    expect(used.removedPackages).toEqual(['multirow']);
    expect(used.keptPackages).toEqual(['cleveref']);
  });
  it('プリアンブルのマクロ定義で使われていれば残す', () => {
    const r = patchSource(pre('\\usepackage{cleveref}', '\\figref{a}', '\\newcommand{\\figref}[1]{\\cref{#1}}'), { mug: mug() });
    expect(r.removedPackages).toEqual([]);
  });
  it('todonotes は常に外し、\\todo を空にする', () => {
    const r = patchSource(pre('\\usepackage{todonotes}', '\\todo{fix}'), { mug: mug() });
    expect(r.removedPackages).toEqual(['todonotes']);
    expect(r.source).toContain('\\providecommand\\todo[2][]{}');
  });
  it('culpritPackage：見つからないファイルを要求したパッケージをログから探す', () => {
    // bar.sty はエラーの前に閉じている。エラーの時点で開いているのは foo.sty
    const log = "This is pdfTeX\n(./__mug_main.tex (/texmf/tex/latex/foo/foo.sty (/texmf/tex/latex/bar/bar.sty) (see note)\n! LaTeX Error: File `tikz.sty' not found.";
    expect(culpritPackage(log, 'tikz', ['foo', 'bar', 'amsmath'])).toBe('foo');
    expect(culpritPackage(log, 'tikz', ['tikz', 'bar'])).toBe('tikz');
    expect(culpritPackage(log, 'tikz', ['amsmath'])).toBeUndefined();
  });
  it('missingFiles：見つからない .sty と .cls をログから拾う', () => {
    const log = "! LaTeX Error: File `stfloats.sty' not found.\n! LaTeX Error: File `IEEEtran.cls' not found.\nFile `stfloats.sty' not found";
    expect(missingFiles(log)).toEqual({ packages: ['stfloats'], classes: ['IEEEtran'] });
  });
  it('\\maketitle も Abstract も無ければエラー', () => {
    expect(() => patchSource('\\documentclass{article}\\begin{document}x\\end{document}', { mug: mug() })).toThrow(PatchError);
  });
});

describe('IEEEoj（IEEE Open Journal）', () => {
  const src = [
    '\\documentclass{IEEEoj}',
    '\\begin{document}',
    '\\title{T}\\author{A}',
    '\\begin{abstract}Abs.\\end{abstract}',
    '\\begin{IEEEkeywords}k1, k2\\end{IEEEkeywords}',
    '\\maketitle',
    '\\section{Introduction}Intro.',
    '\\end{document}',
  ].join('\n');
  it('クラス名の大文字小文字を問わず当たり、Abstract は動かさない（クラスがタイトル部分に出す）', () => {
    const r = patchSource(src, { mug: mug() });
    expect(r.adapter.id).toBe('ieeeoj');
    expect(r.movedAbstract).toBe(false);
    expect(r.cutReason).toBe('maketitle');
    expect(pickStyle('ieeeoj', []).id).toBe('ieeeoj');
  });
  it('タイトル部分に書かれた Index Terms はそのまま含める', () => {
    expect(body(patchSource(src, { mug: mug() }).source)).toContain('\\begin{IEEEkeywords}k1, k2\\end{IEEEkeywords}');
  });
});

describe('Keywords の書き方', () => {
  const doc = (after: string, cls = 'article') =>
    `\\documentclass{${cls}}\n\\begin{document}\n\\title{T}\\author{A}\\maketitle\n\\begin{abstract}A.\\end{abstract}\n${after}\n\\section{Introduction}Intro.\n\\end{document}`;
  it('\\keywords{…} コマンドを含める', () => {
    const r = patchSource(doc('\\keywords{a, {b}, c}'), { mug: mug(), phase: 'front' });
    expect(r.cutReason).toBe('keywords');
    expect(body(r.source)).toContain('\\keywords{a, {b}, c}');
  });
  it('「Keywords:」で始まる段落を、次の空行まで含める', () => {
    const r = patchSource(doc('\\noindent\\textbf{Keywords:} robust; heavy tails\n\nNext paragraph.'), { mug: mug(), phase: 'front' });
    expect(r.cutReason).toBe('keywords');
    expect(body(r.source)).toContain('heavy tails');
    expect(body(r.source)).not.toContain('Next paragraph');
  });
  it('AASTeX は REVTeX のスタイルが当たり、\\maketitle が無ければ補う', () => {
    const src = '\\documentclass{aastex701}\n\\begin{document}\n\\title{T}\\author{A}\n\\begin{abstract}A.\\end{abstract}\n\\keywords{k1}\n\\section{Introduction}Intro.\n\\end{document}';
    const r = patchSource(src, { mug: mug(), phase: 'front' });
    expect(r.adapter.id).toBe('revtex');
    expect(body(r.source)).toMatch(/\\keywords\{k1\}\n\\maketitle\n/);
  });
});

describe('スタイルのコード片', () => {
  it('.tex に書いたマーカー名が、ログの解析で使う名前と一致する', () => {
    const tex = [markersTex, introMarkerTex, endMarkerTex].join('\n');
    for (const m of [LAYOUT_MARKER, BASE_MARKER, TITLE_MARKER, TITLE_END_MARKER, INTRO_MARKER, POS_MARKER]) expect(tex).toContain(`${m}=`);
  });
  it('fill：値を差し込み、足りなければエラーにする', () => {
    expect(fill('\\fpeval{{{w}}*2}\n\n', { w: 77 })).toBe('\\fpeval{77*2}');
    expect(() => fill('{{x}}')).toThrow();
  });
  it('どのクラスにも generic が当たる', () => {
    expect(pickStyle('IEEEtran', []).id).toBe('ieeetran');
    expect(pickStyle('somethingelse', []).id).toBe('generic');
    expect(styles.at(-1)!.id).toBe('generic');
  });
});

describe('zip', () => {
  it('単一のトップフォルダを剥がし、ゴミを除く', () => {
    const z = zipSync({
      'proj/main.tex': strToU8('x'),
      'proj/sec/a.tex': strToU8('y'),
      '__MACOSX/proj/._main.tex': strToU8('z'),
      'proj/.DS_Store': strToU8('z'),
    });
    expect([...readZip(z).keys()].sort()).toEqual(['main.tex', 'sec/a.tex']);
  });
});

describe('parseCompileLog', () => {
  it('ログから位置と版面を読む', () => {
    const r = parseCompileLog('This is pdfTeX\nMUG-BASE=10\nMUG-LAYOUT=1,2,3,4,5,6,7,8\nfoo\nMUG-TITLE=24.88\nMUG-POS=10,-20\n');
    expect(r.baseSize).toBe(10);
    expect(r.titleSize).toBe(24.88);
    expect(r.pos).toEqual({ x: 10, y: -20 });
    expect(r.layout).toEqual({ textWidth: 1, textHeight: 2, paperHeight: 3, left: 4, top: 5, headHeight: 6, headSep: 7, footSkip: 8 });
    // BusyTeX の連結ログ：最後の段のログファイル部分にだけ出るマーカー（\write-1）も読む
    const busy = '$ pdflatex a\nLOG:\nMUG-INTRO=2\n==\nSTDOUT:\nThis is pdfTeX\n$ pdflatex b\nLOG:\nThis is pdfTeX\nMUG-INTRO=1\n==\nSTDOUT:\nThis is pdfTeX\nMUG-BASE=10\n';
    expect(parseCompileLog(busy).introPage).toBe(1);
    expect(parseCompileLog(busy).baseSize).toBe(10);
    expect(parseCompileLog('$ a\nMUG-TITLEEND=500\nMUG-TITLEEND=-3\n').titleEnds).toEqual([500, -3]);
    expect(parseCompileLog('nothing')).toEqual({ pos: undefined, layout: undefined, baseSize: undefined, titleSize: undefined, introPage: undefined, titleEnds: [], titleTops: [], headEmpty: undefined, footEmpty: undefined });
  });
});

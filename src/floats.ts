// 本文の図表（figure・table とその * 版）を拾う。図表をマグに組むときの選択肢と、その中身。
import { flatten } from './project';
import { findBegin, findEndOf, maskComments } from './texparse';
import type { ProjectFiles } from './zip';

export type FloatKind = 'figure' | 'table';

export interface FloatItem {
  /** 本文での出現順（0 から） */
  index: number;
  env: string;
  kind: FloatKind;
  /** 元の論文での番号（その環境の前までのキャプションの数 + 1）。キャプションが無ければ undefined */
  number?: number;
  /** キャプションの先頭（UI に出す、コマンドを除いた文） */
  caption: string;
  /** 環境の中身（\begin{…}[…] と \end{…} を除く） */
  body: string;
}

const FLOAT_RE = /\\begin\s*\{(figure|table)(\*?)\}/g;

/** 図表を出現順に。\begin{document} より前のもの、図表の中の図表（入れ子）は除く */
export function findFloats(src: string): FloatItem[] {
  const masked = maskComments(src);
  const bodyStart = findBegin(masked, 'document');
  if (bodyStart < 0) return [];
  const endDoc = /\\end\s*\{document\}/.exec(masked.slice(bodyStart));
  const stop = endDoc ? bodyStart + endDoc.index : masked.length;
  const counts: Record<FloatKind, number> = { figure: 0, table: 0 };
  const out: FloatItem[] = [];
  FLOAT_RE.lastIndex = bodyStart;
  for (let m; (m = FLOAT_RE.exec(masked)) && m.index < stop; ) {
    const kind = m[1] as FloatKind;
    const env = `${kind}${m[2]}`;
    const end = findEndOf(masked, env, m.index);
    if (end < 0) break;
    // 位置の指定（[htbp]）を飛ばす
    let open = m.index + m[0].length;
    const opt = /^\s*\[[^\]]*\]/.exec(masked.slice(open));
    if (opt) open += opt[0].length;
    const close = masked.lastIndexOf('\\end', end - 1);
    const body = src.slice(open, close);
    const captions = captionTexts(maskComments(body));
    out.push({
      index: out.length,
      env,
      kind,
      number: captions.length ? counts[kind] + 1 : undefined,
      caption: plainText(captions[0] ?? ''),
      body,
    });
    counts[kind] += captions.length;
    FLOAT_RE.lastIndex = end;
  }
  return out;
}

/** プロジェクトの図表（\input を展開したメインから） */
export function listFloats(files: ProjectFiles, mainPath: string): FloatItem[] {
  return findFloats(flatten(files, mainPath).source);
}

/** \caption[短い]{長い} の長いほう。subcaption の \subcaption は数えない */
function captionTexts(masked: string): string[] {
  const out: string[] = [];
  const re = /\\caption\s*\*?\s*(\[[^\]]*\])?\s*\{/g;
  for (let m; (m = re.exec(masked)); ) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < masked.length; i++) {
      if (masked[i] === '\\') i++;
      else if (masked[i] === '{') depth++;
      else if (masked[i] === '}' && --depth === 0) break;
    }
    if (!m[0].includes('*')) out.push(masked.slice(open + 1, i));
    re.lastIndex = i;
  }
  return out;
}

/** UI に出すために、TeX のコマンドを大まかに取り除く */
export function plainText(tex: string, max = 80): string {
  const s = tex
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(cite\w*|ref|eqref|cref|Cref)\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, '[…]')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, '')
    .replace(/[{}~]/g, (c) => (c === '~' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

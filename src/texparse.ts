// TeX ソースの簡易パース。
// 位置の検索はコメントをマスクしたテキストで行い、切り貼りは元のテキストに同じ位置で行う。

/** `%` から行末までを同じ長さの空白に置き換える（直前の `\` が偶数個の `%` のみ）。 */
export function maskComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '%' && precedingBackslashes(src, i) % 2 === 0) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      out += ' '.repeat(j - i);
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function precedingBackslashes(src: string, i: number): number {
  let n = 0;
  while (i - 1 - n >= 0 && src[i - 1 - n] === '\\') n++;
  return n;
}

export interface DocumentClass {
  start: number;
  end: number;
  options: string[];
  cls: string;
}

const DOCUMENTCLASS_RE = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/;

export function parseDocumentClass(masked: string): DocumentClass | null {
  const m = DOCUMENTCLASS_RE.exec(masked);
  if (!m) return null;
  return {
    start: m.index,
    end: m.index + m[0].length,
    options: splitList(m[1] ?? ''),
    cls: m[2].trim(),
  };
}

export function formatDocumentClass(cls: string, options: string[]): string {
  return options.length ? `\\documentclass[${options.join(',')}]{${cls}}` : `\\documentclass{${cls}}`;
}

export function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

/** `\begin{env}` の開始位置。 */
export function findBegin(masked: string, env: string, from = 0): number {
  const re = new RegExp(`\\\\begin\\s*\\{${escapeRe(env)}\\}`, 'g');
  re.lastIndex = from;
  const m = re.exec(masked);
  return m ? m.index : -1;
}

/** `\end{env}` の終端位置。 */
export function findEndOf(masked: string, env: string, from = 0): number {
  const re = new RegExp(`\\\\end\\s*\\{${escapeRe(env)}\\}`, 'g');
  re.lastIndex = from;
  const m = re.exec(masked);
  return m ? m.index + m[0].length : -1;
}

/** 制御綴 `\name` の終端位置（`\namefoo` には一致しない）。 */
export function findCommandEnd(masked: string, name: string, from = 0): number {
  const re = new RegExp(`\\\\${escapeRe(name)}(?![A-Za-z@])`, 'g');
  re.lastIndex = from;
  const m = re.exec(masked);
  return m ? m.index + m[0].length : -1;
}

/** [from, to) で閉じていない環境を、開いた順に返す。 */
export function unclosedEnvironments(masked: string, from: number, to: number): string[] {
  const re = /\\(begin|end)\s*\{([^}]+)\}/g;
  const text = masked.slice(from, to);
  const stack: string[] = [];
  for (let m; (m = re.exec(text)); ) {
    const env = m[2].trim();
    if (m[1] === 'begin') {
      stack.push(env);
    } else {
      const k = stack.lastIndexOf(env);
      if (k >= 0) stack.length = k;
    }
  }
  return stack;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 制御綴 `\name`（`\name*` を含む）の開始位置。 */
export function findCommandStart(masked: string, name: string, from = 0): number {
  const re = new RegExp(`\\\\${escapeRe(name)}(?![A-Za-z@])`, 'g');
  re.lastIndex = from;
  const m = re.exec(masked);
  return m ? m.index : -1;
}

/** 指定した環境を（中身ごと）取り除く。同名の入れ子にも対応。 */
export function removeEnvironments(src: string, names: string[]): { source: string; removed: string[] } {
  const masked = maskComments(src);
  const re = /\\(begin|end)\s*\{([^}]+)\}/g;
  const ranges: [number, number, string][] = [];
  let open: { name: string; start: number; depth: number } | null = null;
  for (let m; (m = re.exec(masked)); ) {
    const env = m[2].trim();
    if (!open) {
      if (m[1] === 'begin' && names.includes(env)) open = { name: env, start: m.index, depth: 1 };
    } else if (env === open.name) {
      open.depth += m[1] === 'begin' ? 1 : -1;
      if (open.depth === 0) {
        ranges.push([open.start, m.index + m[0].length, env]);
        open = null;
      }
    }
  }
  let out = '';
  let last = 0;
  for (const [s, e] of ranges) {
    out += src.slice(last, s);
    last = e;
  }
  return { source: out + src.slice(last), removed: ranges.map((r) => r[2]) };
}

/** `\name{...}`（`\name[...]{...}` も）を引数ごと取り除く。波括弧の入れ子に対応。 */
export function removeCommandWithArg(src: string, name: string): { source: string; count: number } {
  const masked = maskComments(src);
  const re = new RegExp(`\\\\${escapeRe(name)}(?![A-Za-z@])\\s*(\\[[^\\]]*\\])?\\s*\\{`, 'g');
  let out = '';
  let last = 0;
  let count = 0;
  for (let m; (m = re.exec(masked)); ) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < masked.length && depth > 0; i++) {
      const ch = masked[i];
      if (ch === '\\') i++; // \{ や \} を飛ばす
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) break;
    out += src.slice(last, m.index);
    last = i;
    re.lastIndex = i;
    count++;
  }
  return { source: out + src.slice(last), count };
}

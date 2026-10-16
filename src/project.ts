import type { ProjectFiles } from './zip';
import { maskComments } from './texparse';

const decoder = new TextDecoder();
export const readText = (files: ProjectFiles, path: string): string | undefined => {
  const b = files.get(path);
  return b === undefined ? undefined : decoder.decode(b);
};

const PREFERRED_MAIN = ['main.tex', 'paper.tex', 'ms.tex', 'manuscript.tex'];

export interface MainDetection {
  candidates: string[];
  /** 一意に決まった場合のみ。 */
  main?: string;
}

export function detectMain(files: ProjectFiles): MainDetection {
  const candidates = [...files.keys()]
    .filter((p) => p.toLowerCase().endsWith('.tex'))
    .filter((p) => {
      const masked = maskComments(readText(files, p)!);
      return /\\documentclass\b/.test(masked) && /\\begin\s*\{document\}/.test(masked);
    })
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  if (candidates.length === 1) return { candidates, main: candidates[0] };
  for (const name of PREFERRED_MAIN) {
    const hit = candidates.filter((p) => basename(p) === name);
    if (hit.length >= 1) return { candidates, main: hit[0] };
  }
  return { candidates };
}

export interface FlattenResult {
  source: string;
  /** zip 内で展開できたファイル */
  inlined: string[];
  info: string[];
  warnings: string[];
}

const MAX_DEPTH = 10;
const INPUT_RE = /\\(input|include)(?![A-Za-z@])\s*\{([^}]*)\}/g;
const UNSUPPORTED_RE = /\\(subfile|import|subimport|includefrom|inputfrom)(?![A-Za-z@])|\\input(?![A-Za-z@])[ \t]*(?=[^\s{\\])/g;

/** メイン tex の `\input{}` / `\include{}` を再帰的に展開する。パスはメインのディレクトリ基準。 */
export function flatten(files: ProjectFiles, mainPath: string): FlattenResult {
  const baseDir = dirname(mainPath);
  const result: FlattenResult = { source: '', inlined: [], info: [], warnings: [] };

  const expand = (path: string, depth: number): string => {
    const src = readText(files, path)!;
    const masked = maskComments(src);
    for (const m of masked.matchAll(UNSUPPORTED_RE)) {
      result.warnings.push(`${path}: 未対応の読み込み「${src.slice(m.index, m.index + m[0].length + 20).split('\n')[0]}」は展開しません`);
    }
    let out = '';
    let last = 0;
    for (const m of masked.matchAll(INPUT_RE)) {
      const arg = m[2].trim();
      const target = resolveInput(files, baseDir, arg);
      if (!target) {
        result.info.push(`${path}: \\${m[1]}{${arg}} は zip 内に無いため、そのまま残します`);
        continue;
      }
      if (depth >= MAX_DEPTH) {
        result.warnings.push(`${path}: \\${m[1]}{${arg}} は深さ ${MAX_DEPTH} を超えるため展開しません`);
        continue;
      }
      let body = expand(target, depth + 1);
      if (!body.endsWith('\n')) body += '\n';
      out += src.slice(last, m.index) + body;
      last = m.index + m[0].length;
      result.inlined.push(target);
    }
    return out + src.slice(last);
  };

  result.source = expand(mainPath, 0);
  return result;
}

function resolveInput(files: ProjectFiles, baseDir: string, arg: string): string | undefined {
  const p = joinPath(baseDir, arg);
  const hasExt = /\.[A-Za-z0-9]+$/.test(basename(p));
  const tries = hasExt ? [p, `${p}.tex`] : [`${p}.tex`, p];
  return tries.find((t) => files.has(t));
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function depth(p: string): number {
  return p.split('/').length;
}

export function joinPath(dir: string, rel: string): string {
  const parts = (dir ? `${dir}/${rel}` : rel).replace(/^\.\//, '').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

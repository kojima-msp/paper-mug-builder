// BusyTeX のデータパッケージに無い TeX Live のファイルを、必要になったときだけ読み込む。
// TeX Live のパッケージごとの zip（public/texmf/p/<名前>.zip）と、どのファイルがどの zip にあるかの目録 index.json
// （どちらも scripts/build-texmf.mjs が TeX Live 2023 から作る）を使う。
import { unzipSync } from 'fflate';
import type { ProjectFiles } from './zip';

interface TexmfBundle {
  /** TeX Live のパッケージ名 */
  name: string;
  file: string;
  size: number;
  /** この一式の .sty・.cls が読み込むファイルを含む一式（番号） */
  deps?: number[];
  /** フォントの対応表（pdfTeX に \pdfmapfile で知らせる） */
  maps?: string[];
}

interface TexmfIndex {
  bundles: TexmfBundle[];
  /** ファイル名 → 一式の番号 */
  files: Record<string, number>;
}

/** texmf/ 以下のファイルを取ってくる関数。ブラウザでは fetch、Node（ギャラリーなど）では差し替える */
export type TexmfFetcher = (path: string) => Promise<Uint8Array>;

let fetcher: TexmfFetcher = async (path) => {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  const res = await fetch(new URL(`texmf/${path}`, base));
  if (!res.ok) throw new Error(`texmf/${path} を読み込めませんでした（${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
};
let index: Promise<TexmfIndex> | undefined;
const loaded = new Map<string, Promise<ProjectFiles>>();

export function setTexmfFetcher(f: TexmfFetcher) {
  fetcher = f;
  index = undefined;
  fonts = undefined;
  loaded.clear();
}

function readIndex(): Promise<TexmfIndex> {
  index ??= fetcher('index.json')
    .then((b) => JSON.parse(new TextDecoder().decode(b)) as TexmfIndex)
    .catch(() => ({ bundles: [], files: {} })); // 目録が無ければ、追加のファイルは無いものとして続ける
  return index;
}

/** 一式にあるファイルの名前を、すぐに引けるようにする（目録を読み込んでから使う） */
export async function texmfFileChecker(): Promise<(file: string) => boolean> {
  const { files } = await readIndex();
  return (file) => Object.hasOwn(files, file);
}

/** このファイル（例：tikz.sty、ntx-Regular-tlf-t1.tfm）を含む一式の名前 */
export async function bundleFor(file: string): Promise<string | undefined> {
  const { bundles, files } = await readIndex();
  const i = files[file];
  return i === undefined ? undefined : bundles[i].name;
}

/** 一式と、その一式が（目録の上で）読み込む一式をすべて */
export async function withDeps(names: string[]): Promise<string[]> {
  const { bundles } = await readIndex();
  const byName = new Map(bundles.map((b, i) => [b.name, i]));
  const seen = new Set<number>();
  const stack = names.map((n) => byName.get(n)).filter((i): i is number => i !== undefined);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    stack.push(...(bundles[i].deps ?? []));
  }
  return [...seen].map((i) => bundles[i].name);
}

let fonts: Promise<Record<string, string>> | undefined;

/** このフォント（TFM の名前）が載っているフォントの対応表（.map）。BusyTeX の pdftex.map に載っていないフォント用 */
export async function mapForFont(font: string): Promise<string | undefined> {
  fonts ??= fetcher('fonts.json')
    .then((b) => JSON.parse(new TextDecoder().decode(b)) as Record<string, string>)
    .catch(() => ({}));
  return (await fonts)[font];
}

/** 一式に含まれるフォントの対応表 */
export async function bundleMaps(names: string[]): Promise<string[]> {
  const { bundles } = await readIndex();
  return bundles.filter((b) => names.includes(b.name)).flatMap((b) => b.maps ?? []);
}

/**
 * .sty・.cls・tex が読み込むファイルの名前（\RequirePackage・\usepackage・\LoadClass・\usetikzlibrary・\bibliographystyle）。
 * 組版の前にまとめて読み込むための見込みで、漏れがあっても組版で補う。scripts/build-texmf.mjs の依存関係と同じ規則
 */
export function requiredFiles(text: string): string[] {
  const out = new Set<string>();
  const list = (s: string) => s.split(',').map((n) => n.trim()).filter(Boolean);
  for (const m of text.matchAll(/\\(?:RequirePackage|RequirePackageWithOptions|usepackage)\s*(?:\[[^\]]*\])?\s*\{([^}#\\]+)\}/g)) {
    for (const n of list(m[1])) out.add(`${n}.sty`);
  }
  for (const m of text.matchAll(/\\(?:LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}#\\]+)\}/g)) out.add(`${m[1].trim()}.cls`);
  for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}#\\]+)\}/g)) for (const n of list(m[1])) out.add(`tikzlibrary${n}.code.tex`);
  for (const m of text.matchAll(/\\bibliographystyle\s*\{([^}#\\]+)\}/g)) out.add(`${m[1].trim()}.bst`);
  return [...out];
}

/** 一式の中身（ファイル名 → 中身）。一度読んだものは使い回す */
export function loadBundle(name: string): Promise<ProjectFiles> {
  let p = loaded.get(name);
  if (!p) {
    p = readIndex().then(async ({ bundles }) => {
      const b = bundles.find((x) => x.name === name);
      if (!b) throw new Error(`追加のパッケージ ${name} がありません`);
      return new Map(Object.entries(unzipSync(await fetcher(b.file))));
    });
    loaded.set(name, p);
  }
  return p;
}

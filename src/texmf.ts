// BusyTeX のデータパッケージに無い TeX のパッケージ（pgf/TikZ など）を、必要になったときだけ読み込む。
// public/texmf/<名前>.zip と、どの zip にどのファイルがあるかの目録 index.json（scripts/fetch-texmf.sh が作る）を使う。
import { unzipSync } from 'fflate';
import type { ProjectFiles } from './zip';

export interface TexmfBundle {
  name: string;
  file: string;
  files: string[];
}

/** texmf/ 以下のファイルを取ってくる関数。ブラウザでは fetch、Node（ギャラリーなど）では差し替える */
export type TexmfFetcher = (path: string) => Promise<Uint8Array>;

let fetcher: TexmfFetcher = async (path) => {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  const res = await fetch(new URL(`texmf/${path}`, base));
  if (!res.ok) throw new Error(`texmf/${path} を読み込めませんでした（${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
};
let index: Promise<TexmfBundle[]> | undefined;
const loaded = new Map<string, Promise<ProjectFiles>>();

export function setTexmfFetcher(f: TexmfFetcher) {
  fetcher = f;
  index = undefined;
  loaded.clear();
}

async function bundles(): Promise<TexmfBundle[]> {
  index ??= fetcher('index.json')
    .then((b) => (JSON.parse(new TextDecoder().decode(b)) as { bundles: TexmfBundle[] }).bundles)
    .catch(() => []); // 目録が無ければ、追加のパッケージは無いものとして続ける
  return index;
}

/** このファイル（例：tikz.sty）を含む一式 */
export async function bundleFor(file: string): Promise<TexmfBundle | undefined> {
  return (await bundles()).find((b) => b.files.includes(file));
}

/** 一式の中身（ファイル名 → 中身）。一度読んだものは使い回す */
export function loadBundle(name: string): Promise<ProjectFiles> {
  let p = loaded.get(name);
  if (!p) {
    p = bundles().then(async (all) => {
      const b = all.find((x) => x.name === name);
      if (!b) throw new Error(`追加のパッケージ ${name} がありません`);
      return new Map(Object.entries(unzipSync(await fetcher(b.file))));
    });
    loaded.set(name, p);
  }
  return p;
}

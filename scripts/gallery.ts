// 分野別ジャーナルのギャラリーを作る：samples/journals/<id>/ の架空の論文を、
// (1) ローカルの pdflatex でそのまま組んだ 1 ページ目と、(2) BusyTeX でマグ用に組んだものを画像にして、README.md の表にまとめる。
//
// npm run gallery            … 全部
// npm run gallery -- revtex  … 指定したものだけ（README は全件の結果から作り直す）
//
// 必要なもの：public/busytex（npm run fetch-busytex）、ローカルの TeX Live（pdflatex・bibtex・kpsewhich）、poppler（pdftoppm）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { buildCover } from '../src/build';
import type { TexEngine } from '../src/engine';
import { imposeParts } from '../src/impose';
import { DEFAULT_MUG } from '../src/mug';
import type { ProjectFiles } from '../src/zip';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLES = path.join(ROOT, 'samples/journals');
const DIST = path.join(ROOT, 'public/busytex');
/** 画像の幅 (px) */
const IMAGE_PX = 360;

interface SampleConfig {
  /** 表の並び順 */
  order: number;
  field: string;
  journal: string;
  cls: string;
  /** zip に同梱されている想定で、ローカルの TeX Live からコピーするファイル（クラスと、その付属ファイル） */
  bundle: string[];
  /** 表に添える説明 */
  note?: string;
}

interface SampleResult {
  id: string;
  ok: boolean;
  originalOk: boolean;
  ms: number;
  bodyPt?: number;
  titlePt?: number;
  intro: boolean;
  messages: string[];
  error?: string;
}

const sh = (cmd: string, args: string[], cwd: string) => {
  try {
    return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? '';
  }
};

function readSample(dir: string, cfg: SampleConfig): ProjectFiles {
  const files: ProjectFiles = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (/^(sample\.json|README\.md|.*\.png)$/.test(name)) continue;
    files.set(name, new Uint8Array(fs.readFileSync(path.join(dir, name))));
  }
  // フォルダ付きの名前（config/APA7american.txt など）は、そのフォルダに置く
  for (const name of cfg.bundle) {
    const src = sh('kpsewhich', [path.basename(name)], dir).trim();
    if (!src) throw new Error(`${name} がローカルの TeX Live に見つかりません`);
    files.set(name, new Uint8Array(fs.readFileSync(src)));
  }
  return files;
}

/** ローカルの pdflatex で元の論文をそのまま組み、1 ページ目を画像にする */
function renderOriginal(files: ProjectFiles, out: string): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mug-gallery-'));
  for (const [p, c] of files) {
    fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, p), c);
  }
  const latex = () => sh('pdflatex', ['-interaction=nonstopmode', 'main.tex'], tmp);
  latex();
  if (fs.existsSync(path.join(tmp, 'main.aux')) && /\\bibdata/.test(fs.readFileSync(path.join(tmp, 'main.aux'), 'utf8'))) {
    sh('bibtex', ['main'], tmp);
  }
  latex();
  latex();
  const pdf = path.join(tmp, 'main.pdf');
  if (!fs.existsSync(pdf)) return false;
  sh('pdftoppm', ['-f', '1', '-l', '1', '-png', '-singlefile', '-scale-to', String(IMAGE_PX), pdf, out.replace(/\.png$/, '')], tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  return fs.existsSync(out);
}

async function renderMug(engine: TexEngine, id: string, files: ProjectFiles, out: string): Promise<SampleResult> {
  const r = await buildCover(engine, files, 'main.tex', DEFAULT_MUG);
  const messages = [...r.notes, ...r.patch.warnings];
  if (r.patch.removedPackages.length) messages.push(`外したパッケージ：${r.patch.removedPackages.join('、')}`);
  const base = { id, originalOk: false, ms: Math.round(r.compile.ms), intro: r.patch.includedIntro, messages };
  if (!r.parts || !r.measure) {
    const err = r.compile.log.split('\n').find((l) => l.startsWith('!')) ?? 'コンパイルに失敗';
    return { ...base, ok: false, error: err };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mug-gallery-'));
  const pdf = path.join(tmp, 'mug.pdf');
  fs.writeFileSync(pdf, await imposeParts(r.parts, r.mug));
  sh('pdftoppm', ['-png', '-singlefile', '-scale-to', String(IMAGE_PX), pdf, out.replace(/\.png$/, '')], tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ...base, ok: true, bodyPt: r.measure.bodyPt, titlePt: r.measure.titlePt };
}

function writeReadme(samples: [string, SampleConfig][], results: Map<string, SampleResult>) {
  const pt = (v?: number) => (v === undefined ? '—' : `${v.toFixed(1)}pt`);
  const rows = samples.map(([id, cfg]) => {
    const r = results.get(id);
    const img = (name: string, ok?: boolean) => (ok ? `<img src="${id}/${name}" width="240">` : '（失敗）');
    const status = !r
      ? '未実行'
      : !r.ok
        ? `**失敗**：${r.error}`
        : [`本文 ${pt(r.bodyPt)} / タイトル ${pt(r.titlePt)}`, `イントロ：${r.intro ? 'あり' : 'なし'}`, `組版 ${(r.ms / 1000).toFixed(1)} 秒`].join('<br>');
    const notes = [cfg.note, ...(r?.messages ?? [])].filter(Boolean).map((m) => `・${m}`).join('<br>');
    return `| ${cfg.field} | ${cfg.journal}<br>\`${cfg.cls}\` | ${img('original.png', r?.originalOk)} | ${img('mug.png', r?.ok)} | ${status} | ${notes} |`;
  });
  const md = `# 分野別ジャーナルのレンダリング例

論文の文書クラスごとに、このツールでマグ用に組んだ結果をまとめたもの。入力の論文（タイトル・著者・所属・本文・文献）はすべて**架空**である。

- 設定は既定値（印刷範囲 85 × 85 mm、余白 4 mm、本文 6pt、イントロあり、ヘッダー・フッターあり）。
- 「元の論文」は、同じ入力をローカルの TeX Live（pdflatex）でそのまま組んだ 1 ページ目。
- 「マグ」は、ブラウザと同じ BusyTeX（TeX Live 2023 の WASM 版）で組んだもの。
- クラスファイルは、ユーザーの zip に同梱されている想定で、ローカルの TeX Live からコピーして入力に含めている（各フォルダの \`sample.json\` の \`bundle\`）。
- 作り直すには \`npm run gallery\`（[scripts/gallery.ts](../../scripts/gallery.ts)）。

## 載せているクラスの選び方

TeX Live に入っているクラスでも、今は使われていないものがある。そこで 2026 年 10 月に arXiv の最近の投稿のソースを調べ、実際に使われているものだけを載せた。

- 8 分野（astro-ph.GA、cond-mat.mes-hall、physics.chem-ph、q-bio.QM、math.PR、econ.GN、physics.flu-dyn、stat.ME）から最近の投稿を 12 本ずつ、計 96 本。
- コメント欄に投稿先（MNRAS、Nature、ACS、Elsevier）が書かれた最近の投稿を 6 本ずつ。

| クラス | 見つかった数 | 扱い |
|---|---|---|
| \`article\`（汎用） | 96 本中 42 本（最多） | 掲載（汎用の扱いで組む） |
| \`revtex4-2\` | 12 本（物性 12 本中 8 など） | 掲載 |
| \`aa\`（A&A） | 天文 12 本中 8 本 | 未掲載（TeX Live に無く、公式の配布物が必要） |
| \`mnras\` | MNRAS 宛て 6 本中 6 本 | 掲載 |
| \`aastex7\`・\`aastex631\`（AAS） | 2 本 | aastex701 を掲載 |
| \`amsart\` | 3 本 | 掲載 |
| \`IEEEtran\` | 3 本 | 掲載 |
| \`sn-jnl\`（Springer Nature） | 3 本 | 未掲載（TeX Live に無く、公式の配布物が必要） |
| \`elsarticle\`、\`cas-dc\`・\`cas-sc\`（Elsevier） | 2 本、3 本 | elsarticle と cas-dc を掲載 |
| \`achemso\`（ACS） | 化学 12 本中 1 本 | 掲載（少数） |
| \`nature\`、\`oup-authoring-template\`、\`cje\`、\`asmejour\`、\`apa7\` | 0 本 | 試したが削除 |

| 分野 | ジャーナル（クラス） | 元の論文（1 ページ目） | マグ（85 × 85 mm） | 文字サイズなど | 備考 |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
  fs.writeFileSync(path.join(SAMPLES, 'README.md'), md);
}

async function main() {
  const only = process.argv.slice(2);
  const samples = fs
    .readdirSync(SAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SAMPLES, e.name, 'sample.json')))
    .map((e) => [e.name, JSON.parse(fs.readFileSync(path.join(SAMPLES, e.name, 'sample.json'), 'utf8')) as SampleConfig] as [string, SampleConfig])
    .sort((a, b) => a[1].order - b[1].order);

  const resultsPath = path.join(SAMPLES, 'results.json');
  const results = new Map<string, SampleResult>(
    fs.existsSync(resultsPath) ? Object.entries(JSON.parse(fs.readFileSync(resultsPath, 'utf8'))) : [],
  );

  const require = createRequire(import.meta.url);
  const engine: TexEngine = require('./node-engine.cjs')(DIST);
  await engine.init();

  for (const [id, cfg] of samples) {
    if (only.length && !only.includes(id)) continue;
    const dir = path.join(SAMPLES, id);
    process.stdout.write(`${id} … `);
    try {
      const files = readSample(dir, cfg);
      const originalOk = renderOriginal(files, path.join(dir, 'original.png'));
      const r = await renderMug(engine, id, files, path.join(dir, 'mug.png'));
      results.set(id, { ...r, originalOk });
      console.log(r.ok ? `ok（本文 ${r.bodyPt?.toFixed(1)}pt、${(r.ms / 1000).toFixed(1)} 秒）` : `失敗：${r.error}`);
    } catch (e) {
      results.set(id, { id, ok: false, originalOk: false, ms: 0, intro: false, messages: [], error: (e as Error).message });
      console.log(`失敗：${(e as Error).message}`);
    }
  }
  fs.writeFileSync(resultsPath, `${JSON.stringify(Object.fromEntries(results), null, 2)}\n`);
  writeReadme(samples, results);
  process.exit(0);
}

main();

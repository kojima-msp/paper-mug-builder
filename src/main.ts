import { styles } from './styles';
import { buildCover, type BuildResult } from './build';
import { BusytexEngine } from './engine';
import { imposeParts } from './impose';
import { DEFAULT_MUG, MIN_FONT_PT, type MugOptions } from './mug';
import { missingFiles, PatchError } from './patch';
import { detectMain } from './project';
import { readZip, type ProjectFiles } from './zip';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const engineStatus = $<HTMLParagraphElement>('engine-status');
const zipInput = $<HTMLInputElement>('zip');
const mainRow = $<HTMLLabelElement>('main-row');
const mainSelect = $<HTMLSelectElement>('main');
const adapterSelect = $<HTMLSelectElement>('adapter');
const introInput = $<HTMLInputElement>('includeIntro');
const headerFooterInput = $<HTMLInputElement>('includeHeaderFooter');
const bodyPtInput = $<HTMLInputElement>('bodyPt');
const bodyPtValue = $<HTMLOutputElement>('bodyPt-value');
const fontSize = $<HTMLParagraphElement>('font-size');
const buildBtn = $<HTMLButtonElement>('build');
const messages = $<HTMLUListElement>('messages');
const downloads = $<HTMLDivElement>('downloads');
const logPre = $<HTMLPreElement>('log');
const preview = $<HTMLIFrameElement>('preview');

const numberFields = ['printWidth', 'printHeight', 'margin', 'bleed'] as const;

for (const a of styles) adapterSelect.add(new Option(a.label, a.id));
for (const f of numberFields) $<HTMLInputElement>(f).value = String(DEFAULT_MUG[f]);
introInput.checked = DEFAULT_MUG.includeIntro;
headerFooterInput.checked = DEFAULT_MUG.includeHeaderFooter;
bodyPtInput.value = String(DEFAULT_MUG.bodyPt);

const engine = new BusytexEngine(new URL(`${import.meta.env.BASE_URL}busytex/`, document.baseURI).href);
let engineReady = false;
let files: ProjectFiles | undefined;
/** 直前の組版結果での、マグ上の本文とタイトルの文字サイズ (pt) */
let lastSizes: { body?: number; title?: number } | undefined;
let busy = false;
const urls: string[] = [];

const t0 = performance.now();
let readyText = '';
engine
  .init((s) => (engineStatus.textContent = `TeX エンジン：${s}`))
  .then(() => {
    engineReady = true;
    readyText = `TeX エンジン準備完了（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`;
    engineStatus.textContent = readyText;
    engineStatus.className = 'status ready';
    updateButtons();
  })
  .catch((e) => {
    engineStatus.textContent = `TeX エンジンの読み込みに失敗しました：${e.message}`;
    engineStatus.className = 'status error';
  });

function readMug(): MugOptions {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  return {
    // 「組み直して文字を大きく」（reflow）は UI から外している
    mode: 'original',
    includeIntro: introInput.checked,
    bodyPt: Number(bodyPtInput.value),
    includeHeaderFooter: headerFooterInput.checked,
    printWidth: num('printWidth'),
    printHeight: num('printHeight'),
    margin: num('margin'),
    bleed: num('bleed'),
    k: DEFAULT_MUG.k,
    valign: $<HTMLSelectElement>('valign').value as MugOptions['valign'],
  };
}

function updateFontHint() {
  bodyPtValue.textContent = `${Number(bodyPtInput.value).toFixed(1)}pt`;
  let pt: number;
  if (lastSizes?.body !== undefined) {
    pt = lastSizes.body;
    fontSize.textContent = `マグ上の文字サイズ：本文 ${pt.toFixed(1)}pt${lastSizes.title !== undefined ? ` / タイトル ${lastSizes.title.toFixed(1)}pt` : ''}`;
  } else {
    pt = Number(bodyPtInput.value);
    fontSize.textContent = 'ヘッダーとタイトルは元の版面の見た目のまま、著者以下をこの文字サイズで組みます（組版後に実際の値を表示）';
  }
  fontSize.className = pt < MIN_FONT_PT ? 'hint warn' : 'hint';
  if (pt < MIN_FONT_PT) fontSize.textContent += `：${MIN_FONT_PT}pt を下回っています`;
}

function updateButtons() {
  const can = engineReady && !!files && !!mainSelect.value && !busy;
  buildBtn.disabled = !can;
}

function say(text: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  messages.append(li);
}

zipInput.addEventListener('change', async () => {
  messages.replaceChildren();
  downloads.hidden = true;
  const file = zipInput.files?.[0];
  if (!file) return;
  try {
    files = readZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    files = undefined;
    say(`zip を読めませんでした：${(e as Error).message}`, 'error');
    updateButtons();
    return;
  }
  const det = detectMain(files);
  mainSelect.replaceChildren(...det.candidates.map((c) => new Option(c, c)));
  mainRow.hidden = det.candidates.length <= 1;
  if (det.candidates.length === 0) say('\\documentclass と \\begin{document} を含む .tex が見つかりません', 'error');
  else if (det.main) mainSelect.value = det.main;
  else {
    mainSelect.prepend(new Option('選択してください', ''));
    mainSelect.value = '';
    say('メイン tex の候補が複数あります。選んでください', 'warn');
  }
  say(`${files.size} 個のファイルを読み込みました`);
  updateButtons();
});

mainSelect.addEventListener('change', updateButtons);
bodyPtInput.addEventListener('input', () => {
  // 前回の組版結果の文字サイズは当てはまらなくなる
  lastSizes = undefined;
  updateFontHint();
});

buildBtn.addEventListener('click', run);

async function run() {
  if (!files || busy) return;
  busy = true;
  updateButtons();
  messages.replaceChildren();
  const mug = readMug();
  const adapterId = adapterSelect.value || undefined;
  try {
    say('組版中…');
    await show(await buildCover(engine, files, mainSelect.value, mug, adapterId));
  } catch (e) {
    say(e instanceof PatchError ? `パッチできません：${e.message}` : `エラー：${(e as Error).message}`, 'error');
    console.error(e);
  } finally {
    busy = false;
    // 組版中の追加データ読み込みで書き換わった表示を戻す
    if (readyText) engineStatus.textContent = readyText;
    updateButtons();
  }
}

async function show(r: BuildResult) {
  const { patch, compile, measure } = r;
  lastSizes = measure ? { body: measure.bodyPt, title: measure.titlePt } : undefined;
  updateFontHint();
  logPre.textContent = compile.log;
  say(`クラス：${patch.cls}（${patch.adapter.label}）、オプション：[${patch.options.join(', ')}]`);
  if (patch.movedAbstract) say('Abstract をタイトル直下の全幅の領域に移しました');
  if (patch.removedThanks) say(`\\thanks（${patch.removedThanks} 個）を取り除きました`);
  if (patch.includedIntro) say(`イントロの冒頭を流し込みました${patch.bibtex ? '（引用番号は BibTeX で解決）' : ''}`);
  if (patch.removedFloats.length) say(`流し込んだ部分の図表（${patch.removedFloats.length} 個）は省きました`);
  if (patch.removedPackages.length) say(`外したパッケージ（表紙に不要、または BusyTeX に無い）：${patch.removedPackages.join(', ')}`);
  for (const n of r.notes) say(n, 'warn');
  for (const w of patch.warnings) say(w, 'warn');
  for (const i of patch.info) say(i);

  while (urls.length) URL.revokeObjectURL(urls.pop()!);
  const blobUrl = (data: string | Uint8Array, type: string) => {
    const u = URL.createObjectURL(new Blob([data as BlobPart], { type }));
    urls.push(u);
    return u;
  };
  $<HTMLAnchorElement>('dl-tex').href = blobUrl(patch.source, 'text/x-tex');

  if (!compile.ok || !compile.pdf || !measure || !r.parts) {
    for (const c of missingFiles(compile.log).classes) say(`${c}.cls が見つかりません。zip に ${c}.cls を入れてください`, 'error');
    const err = compile.log.split('\n').find((l) => l.startsWith('!')) ?? '';
    say(`コンパイルに失敗しました（${(compile.ms / 1000).toFixed(1)} 秒）${err ? `：${err}` : ''}。ログを確認してください`, 'error');
    downloads.hidden = false;
    $<HTMLAnchorElement>('dl-mug').hidden = true;
    $<HTMLAnchorElement>('dl-cover').hidden = true;
    return;
  }
  say(`コンパイル完了（${(compile.ms / 1000).toFixed(1)} 秒）`);
  say(`中身 ${measure.finalWidth.toFixed(1)} × ${measure.finalHeight.toFixed(1)} mm（${measure.bodyPt !== undefined ? `本文 ${measure.bodyPt.toFixed(1)}pt` : ''}${measure.titlePt !== undefined ? `、タイトル ${measure.titlePt.toFixed(1)}pt` : ''}）`);

  const mugPdf = await imposeParts(r.parts, r.mug);
  const mugUrl = blobUrl(mugPdf, 'application/pdf');
  preview.src = mugUrl;
  $<HTMLAnchorElement>('dl-mug').href = mugUrl;
  $<HTMLAnchorElement>('dl-cover').href = blobUrl(compile.pdf, 'application/pdf');
  $<HTMLAnchorElement>('dl-mug').hidden = false;
  $<HTMLAnchorElement>('dl-cover').hidden = false;
  downloads.hidden = false;
}

updateFontHint();

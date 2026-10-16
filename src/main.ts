import '@picocss/pico/css/pico.pumpkin.min.css';
import './style.css';
import { renderDiagram, type DimPart } from './diagram';
import { styles } from './styles';
import { buildCover, buildFloat, buildFloatThumbs, type BuildResult } from './build';
import { listFloats, type FloatItem } from './floats';
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
const previewEmpty = $<HTMLDivElement>('preview-empty');
const dropzone = $<HTMLLabelElement>('dropzone');
const zipName = $<HTMLElement>('zip-name');
const pngBtn = $<HTMLButtonElement>('dl-png');
const pngDpi = $<HTMLSelectElement>('png-dpi');
const floatStep = $<HTMLElement>('float-step');
const floatList = $<HTMLDivElement>('float-list');
const floatStatus = $<HTMLParagraphElement>('float-status');
const coverOptions = $<HTMLFieldSetElement>('cover-options');
/** 直前に作ったマグ用 PDF（画像でダウンロードするため） */
let lastMugPdf: Uint8Array | undefined;
/** 作るもの：表紙か図表か */
let mode: 'cover' | 'figure' = 'cover';
let floats: FloatItem[] = [];
let selectedFloat: number | undefined;
/** 縮小画像を作った対象（zip とメイン）。作り直さないため */
let thumbsFor: string | undefined;
let filesKey = '';

const numberFields = ['printWidth', 'printHeight', 'margin', 'bleed'] as const;
const diagram = document.getElementById('dims-diagram') as unknown as SVGSVGElement;
let focusedDim: DimPart | undefined;
const updateDiagram = () => renderDiagram(diagram, readMug(), focusedDim);
for (const f of numberFields) {
  const input = $<HTMLInputElement>(f);
  input.addEventListener('input', updateDiagram);
  input.addEventListener('focus', () => {
    focusedDim = f;
    updateDiagram();
  });
  input.addEventListener('blur', () => {
    focusedDim = undefined;
    updateDiagram();
  });
}

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
    engineStatus.removeAttribute('aria-busy');
    updateButtons();
    makeThumbs();
  })
  .catch((e) => {
    engineStatus.textContent = `TeX エンジンの読み込みに失敗しました：${e.message}`;
    engineStatus.className = 'status error';
    engineStatus.removeAttribute('aria-busy');
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
    fontSize.textContent =
      mode === 'cover'
        ? 'ヘッダーとタイトルは元の版面の見た目のまま、著者以下をこの文字サイズで組みます（組版後に実際の値を表示）'
        : '本文をこの文字サイズで組んだときの大きさで、図表を組みます（キャプションは元の論文と同じ比率）';
  }
  fontSize.className = pt < MIN_FONT_PT ? 'hint warn' : 'hint';
  if (pt < MIN_FONT_PT) fontSize.textContent += `：${MIN_FONT_PT}pt を下回っています`;
}

function updateButtons() {
  const can = engineReady && !!files && !!mainSelect.value && !busy && (mode === 'cover' || selectedFloat !== undefined);
  buildBtn.disabled = !can;
  // 組版中は回転する印を出す（Pico の aria-busy）
  if (busy) buildBtn.setAttribute('aria-busy', 'true');
  else buildBtn.removeAttribute('aria-busy');
}

function say(text: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  messages.append(li);
}

zipInput.addEventListener('change', () => {
  const file = zipInput.files?.[0];
  if (file) loadZip(file);
});
// zip をドロップ枠に落としても読み込む
for (const ev of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
}
for (const ev of ['dragleave', 'drop'] as const) dropzone.addEventListener(ev, () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) loadZip(file);
});

async function loadZip(file: File) {
  messages.replaceChildren();
  downloads.hidden = true;
  zipName.textContent = file.name;
  dropzone.classList.add('loaded');
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
  filesKey = `${file.name}:${file.size}:${file.lastModified}`;
  refreshFloats();
  updateButtons();
}

mainSelect.addEventListener('change', () => {
  refreshFloats();
  updateButtons();
});

// --- 作るもの（表紙・図表）---
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  r.addEventListener('change', () => {
    mode = r.value as typeof mode;
    floatStep.hidden = mode !== 'figure';
    coverOptions.hidden = mode !== 'cover';
    lastSizes = undefined;
    updateFontHint();
    updateButtons();
    makeThumbs();
  });
}

const floatLabel = (f: FloatItem) =>
  `${f.kind === 'figure' ? '図' : '表'} ${f.number ?? '（番号なし）'}${f.env.endsWith('*') ? '（2 段幅）' : ''}`;

/** 図表の一覧を作り直す（縮小画像はまだ無い） */
function refreshFloats() {
  floats = files && mainSelect.value ? listFloats(files, mainSelect.value) : [];
  selectedFloat = undefined;
  thumbsFor = undefined;
  floatList.replaceChildren(
    ...floats.map((f) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'float-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.index = String(f.index);
      const thumb = Object.assign(document.createElement('div'), { className: 'thumb pending' });
      item.append(thumb, Object.assign(document.createElement('strong'), { textContent: floatLabel(f) }), Object.assign(document.createElement('small'), { textContent: f.caption || '（キャプションなし）' }));
      item.title = f.caption;
      item.addEventListener('click', () => {
        selectedFloat = f.index;
        for (const el of floatList.children) el.setAttribute('aria-selected', String(el === item));
        updateButtons();
      });
      return item;
    }),
  );
  floatStatus.textContent = !files ? 'zip を選ぶと、論文の図表が並びます' : floats.length ? `${floats.length} 個の図表があります。マグにするものを選んでください` : '図表（figure・table）が見つかりません';
  makeThumbs();
}

/** 縮小画像：すべての図表を 1 回で組み、それぞれを切り出して一覧に入れる。図表を選ぶ画面を開いたときだけ */
async function makeThumbs() {
  const key = `${filesKey}:${mainSelect.value}`;
  if (mode !== 'figure' || !engineReady || !files || !floats.length || thumbsFor === key) return;
  thumbsFor = key;
  const base = floatStatus.textContent;
  floatStatus.textContent = `${base}（縮小画像を作っています…）`;
  try {
    const t = await buildFloatThumbs(engine, files, mainSelect.value, readMug(), floats.map((f) => f.index), adapterSelect.value || undefined);
    if (thumbsFor !== key) return; // 途中で zip などが変わった
    if (!t.pdf || !t.items.length) {
      floatStatus.textContent = `${base}（縮小画像は作れませんでした。選んで組版はできます）`;
      return;
    }
    const { renderCrops } = await import('./raster');
    const canvases = await renderCrops(t.pdf, t.items.map((i) => ({ key: i.index, page: i.page, crop: i.crop })), 104);
    if (thumbsFor !== key) return;
    for (const el of floatList.querySelectorAll<HTMLElement>('.float-item')) {
      const c = canvases.get(Number(el.dataset.index));
      const thumb = el.querySelector('.thumb')!;
      if (c) {
        thumb.classList.remove('pending');
        thumb.replaceChildren(c);
      }
    }
    floatStatus.textContent = base;
  } catch (e) {
    console.error(e);
    if (thumbsFor === key) floatStatus.textContent = `${base}（縮小画像は作れませんでした）`;
  } finally {
    if (readyText) engineStatus.textContent = readyText;
  }
}
bodyPtInput.addEventListener('input', () => {
  // 前回の組版結果の文字サイズは当てはまらなくなる
  lastSizes = undefined;
  updateFontHint();
});

buildBtn.addEventListener('click', run);

// 画像（PNG）でダウンロード。pdf.js はここで初めて読み込む
pngBtn.addEventListener('click', async () => {
  if (!lastMugPdf) return;
  pngBtn.setAttribute('aria-busy', 'true');
  pngBtn.disabled = true;
  try {
    const dpi = Number(pngDpi.value);
    const { pdfToPng } = await import('./raster');
    const url = URL.createObjectURL(await pdfToPng(lastMugPdf, dpi));
    const a = Object.assign(document.createElement('a'), { href: url, download: `mug-${dpi}dpi.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) {
    say(`画像にできませんでした：${(e as Error).message}`, 'error');
  } finally {
    pngBtn.removeAttribute('aria-busy');
    pngBtn.disabled = false;
  }
});

async function run() {
  if (!files || busy) return;
  busy = true;
  updateButtons();
  messages.replaceChildren();
  const mug = readMug();
  const adapterId = adapterSelect.value || undefined;
  try {
    say('組版中…');
    const r =
      mode === 'figure' && selectedFloat !== undefined
        ? await buildFloat(engine, files, mainSelect.value, mug, selectedFloat, adapterId)
        : await buildCover(engine, files, mainSelect.value, mug, adapterId);
    await show(r);
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
  lastMugPdf = mugPdf;
  const mugUrl = blobUrl(mugPdf, 'application/pdf');
  preview.src = mugUrl;
  preview.hidden = false;
  previewEmpty.hidden = true;
  $<HTMLAnchorElement>('dl-mug').href = mugUrl;
  $<HTMLAnchorElement>('dl-cover').href = blobUrl(compile.pdf, 'application/pdf');
  const coverName = mode === 'figure' ? 'figure.pdf' : 'cover.pdf';
  $<HTMLAnchorElement>('dl-cover').download = coverName;
  $<HTMLAnchorElement>('dl-cover').textContent = coverName;
  $<HTMLAnchorElement>('dl-mug').hidden = false;
  $<HTMLAnchorElement>('dl-cover').hidden = false;
  downloads.hidden = false;
}

updateFontHint();
updateDiagram();
refreshFloats();

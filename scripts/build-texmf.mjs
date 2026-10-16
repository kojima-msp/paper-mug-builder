// BusyTeX のデータパッケージに無い TeX Live のファイルを、TeX Live 2023 の ISO（BusyTeX の texlive-basic と同じ 2023-03-13 版）から自動で集め、
// TeX Live のパッケージごとの zip（public/texmf/p/<名前>.zip）と目録（public/texmf/index.json）にする。
// 組版で足りないファイルがあったとき、ブラウザは目録を引いて、そのファイルを含むパッケージを読み込む（src/texmf.ts）。
// あわせて、フォント名 → フォントの対応表（.map）の目録 public/texmf/fonts.json も作る（BusyTeX の pdftex.map に載っていないフォント用）。
//
// node scripts/build-texmf.mjs
//
// 必要なもの：public/busytex（npm run fetch-busytex。BusyTeX にあるファイルは除くため）、tar（xz が使えるもの）
// ISO（5 GB）は丸ごとは取らず、HTTP の Range で目録と要るパッケージの部分だけを読む。
// 取得した TeX Live のパッケージは .cache/texlive-2023-iso/ に置き、次からは使い回す
//
// 版を揃える理由：BusyTeX の LaTeX 本体（pdflatex.fmt）は 2023-03 の版。TeX Live 2023 の最終版（tlnet-final, 2024-03）の
// パッケージには、それより新しい本体の命令を使うもの（tcolorbox の \tl_set:Ne など）があり、組版が止まる
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const ISO = 'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2023/texlive2023-20230313.iso';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache/texlive-2023-iso');
const BUSYTEX = path.join(ROOT, 'public/busytex');
const OUT = path.join(ROOT, 'public/texmf');
/** GitHub Pages の 1 サイトの上限（1 GB）から BusyTeX の分を引いた、この一式に使える大きさ */
const BUDGET_BYTES = 700e6;
/** これより小さいフォントのパッケージ（記号など）は、すべて含める（tar.xz の大きさ） */
const SMALL_FONT_BYTES = 3e6;
/** これより大きくても含めるフォント（論文でよく使うもの）。ほかの大きなフォントは含めず、そのパッケージは外して組む */
const FONT_ALLOW = new Set([
  'newtx', 'newtxsf', 'newtxtt', 'newpx', 'txfonts', 'txfontsb', 'pxfonts',
  'libertine', 'libertinus-type1', 'stix', 'stix2-type1', 'mnsymbol', 'mathdesign', 'kpfonts', 'fourier', 'utopia', 'erewhon',
  'charter', 'xcharter', 'baskervillef', 'ebgaramond', 'tex-gyre', 'tex-gyre-math', 'lm', 'lm-math', 'sansmathfonts',
  'inconsolata', 'sourcecodepro', 'sourcesanspro', 'sourceserifpro', 'fontawesome', 'fontawesome5',
]);
/** 含める TeX Live のフォルダ（pdfTeX と BibTeX が使うもの） */
const KEEP_DIR = /^(tex\/(latex|generic)|bibtex\/bst|fonts\/(tfm|type1|vf|enc|map\/pdftex|map\/dvips))\//;
const FONT_DIR = /^fonts\//;
/** 組版に使わないファイル */
const SKIP_FILE = /(^README|^LICEN[CS]E|^CHANGES|\.(txt|md|pdf|lua|dtx|ins|html?|log)$)/i;
const CONCURRENCY = 8;
/** BusyTeX が最初から読み込むデータパッケージ（src/engine.ts の PRELOAD_PACKAGES）。ここにあるファイルは一式に含めない。
 * 必要なときだけ読み込むもの（latex-extra）は、BusyTeX が \usepackage を見たときにしか読み込まないので、クラスが読む .cfg などのために一式にも含める */
const BUSYTEX_PRELOAD = /^(texlive-basic|ubuntu-texlive-(latex-base|latex-recommended|fonts-recommended|science))\.js$/;
const MAP_DIR = /^fonts\/map\/(pdftex|dvips)\/.*\.map$/;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30, ...opts });

// --- ISO 9660 を Range で読む ---
const SECTOR = 2048;

async function readRange(start, length) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(ISO, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
      if (res.status !== 206) throw new Error(`${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length !== length) throw new Error(`${buf.length} / ${length} バイト`);
      return buf;
    } catch (e) {
      if (attempt >= 5) throw new Error(`ISO の ${start} バイト目から読めませんでした：${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** ディレクトリの中身（名前 → 位置と大きさ）。長い名前は Joliet（UCS-2）で読む */
function parseDir(buf, joliet) {
  const out = new Map();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = 0; o < buf.length; ) {
    const len = buf[o];
    if (len === 0) {
      o = (Math.floor(o / SECTOR) + 1) * SECTOR; // 記録はセクターをまたがない
      continue;
    }
    const nameLen = buf[o + 32];
    const raw = buf.subarray(o + 33, o + 33 + nameLen);
    if (!(nameLen === 1 && raw[0] <= 1)) {
      let name = '';
      if (joliet) for (let i = 0; i + 1 < raw.length; i += 2) name += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
      else name = new TextDecoder('latin1').decode(raw);
      out.set(name.replace(/;1$/, ''), { lba: dv.getUint32(o + 2, true), size: dv.getUint32(o + 10, true), dir: (buf[o + 25] & 2) !== 0 });
    }
    o += len;
  }
  return out;
}

let isoRoot;
async function isoEntry(p) {
  if (!isoRoot) {
    // 補助ボリューム記述子（Joliet）があればそれを、無ければ基本ボリューム記述子を使う
    let primary;
    for (let s = 16; ; s++) {
      const d = await readRange(s * SECTOR, SECTOR);
      if (d[0] === 255) break;
      const root = { lba: new DataView(d.buffer).getUint32(156 + 2, true), size: new DataView(d.buffer).getUint32(156 + 10, true), dir: true };
      if (d[0] === 1) primary = { ...root, joliet: false };
      if (d[0] === 2 && d[88] === 0x25 && d[89] === 0x2f) isoRoot = { ...root, joliet: true };
    }
    isoRoot ??= primary;
  }
  let cur = isoRoot;
  for (const part of p.split('/')) {
    const list = parseDir(await readRange(cur.lba * SECTOR, cur.size), isoRoot.joliet);
    const next = list.get(part);
    if (!next) throw new Error(`ISO に ${p} がありません`);
    cur = { ...next, joliet: isoRoot.joliet };
  }
  return cur;
}

/** ISO の archive/ の中身（パッケージ名 → 位置と大きさ）。ISO ではファイル名に版が付いている（2up.r55076.tar.xz） */
let archiveDir;
async function archiveEntries() {
  if (!archiveDir) {
    const a = await isoEntry('archive');
    archiveDir = new Map();
    for (const [name, e] of parseDir(await readRange(a.lba * SECTOR, a.size), isoRoot.joliet)) {
      const m = /^(.+)\.r\d+\.tar\.xz$/.exec(name);
      if (m && !/\.(doc|source)$/.test(m[1])) archiveDir.set(m[1], e);
    }
  }
  return archiveDir;
}

// --- TeX Live の目録 ---
async function readTlpdb() {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, 'texlive.tlpdb');
  if (!fs.existsSync(file)) {
    console.log('fetch texlive.tlpdb');
    const e = await isoEntry('tlpkg/texlive.tlpdb');
    fs.writeFileSync(file, await readRange(e.lba * SECTOR, e.size));
  }
  const pkgs = new Map();
  let cur;
  let inRun = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) {
      cur = undefined;
      continue;
    }
    if (line.startsWith('name ')) {
      cur = { name: line.slice(5), category: '', size: 0, runfiles: [] };
      pkgs.set(cur.name, cur);
      inRun = false;
    } else if (!cur) continue;
    else if (line.startsWith(' ')) {
      if (inRun) cur.runfiles.push(line.trim().split(' ')[0].replace(/^(texmf-dist|RELOC)\//, ''));
    } else {
      inRun = line.startsWith('runfiles');
      if (line.startsWith('category ')) cur.category = line.slice(9);
      else if (line.startsWith('containersize ')) cur.size = Number(line.split(' ')[1]);
    }
  }
  return pkgs;
}

// --- BusyTeX にあるファイル（データパッケージの目録から） ---
function busytexFiles(only = /texlive.*\.js$/) {
  const names = new Set();
  for (const f of fs.readdirSync(BUSYTEX)) {
    if (!only.test(f)) continue;
    const js = fs.readFileSync(path.join(BUSYTEX, f), 'latin1');
    for (const m of js.matchAll(/"filename":\s*"([^"]+)"/g)) names.add(path.posix.basename(m[1]));
  }
  if (names.size === 0) throw new Error('public/busytex が空です。先に npm run fetch-busytex を実行してください');
  return names;
}

// --- 含めるパッケージを選ぶ ---
function select(pkgs, busy) {
  const chosen = [];
  const skippedFonts = [];
  for (const p of pkgs.values()) {
    if (p.category !== 'Package' || p.name.includes('.')) continue;
    const files = p.runfiles.filter((f) => KEEP_DIR.test(f) && !busy.has(path.posix.basename(f)) && !SKIP_FILE.test(path.posix.basename(f)));
    if (!files.length) continue;
    const hasFonts = files.some((f) => FONT_DIR.test(f));
    if (hasFonts && p.size > SMALL_FONT_BYTES && !FONT_ALLOW.has(p.name)) {
      skippedFonts.push(p.name);
      continue;
    }
    chosen.push({ name: p.name, files: new Set(files) });
  }
  return { chosen, skippedFonts };
}

/** フォントの対応表を持つパッケージ（含めなかった大きなフォントは除く） */
function mapPackages(pkgs, skipped) {
  return [...pkgs.values()]
    .filter((p) => p.category === 'Package' && !p.name.includes('.') && !skipped.has(p.name))
    .map((p) => ({ name: p.name, maps: p.runfiles.filter((f) => MAP_DIR.test(f)) }))
    .filter((p) => p.maps.length);
}

/** .map の行の最初の語（TFM の名前） */
const mapFonts = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[%#;*]/.test(l))
    .map((l) => l.split(/\s+/)[0]);

// --- 取得（並列、取得済みは使い回す） ---
async function download(names) {
  const queue = names.filter((n) => !fs.existsSync(path.join(CACHE, `${n}.tar.xz`)));
  if (queue.length) console.log(`fetch ${queue.length} packages`);
  const archive = queue.length ? await archiveEntries() : new Map();
  let done = 0;
  const worker = async () => {
    for (let n; (n = queue.shift()); ) {
      const dest = path.join(CACHE, `${n}.tar.xz`);
      const e = archive.get(n);
      if (!e) throw new Error(`ISO の archive/ に ${n} がありません`);
      fs.writeFileSync(`${dest}.part`, await readRange(e.lba * SECTOR, e.size));
      fs.renameSync(`${dest}.part`, dest);
      if (++done % 100 === 0) console.log(`  ${done}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// --- パッケージの中身を読む ---
function extract(name, wanted) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mug-texmf-'));
  try {
    sh('tar', ['-xJf', path.join(CACHE, `${name}.tar.xz`), '-C', tmp]);
    const files = {};
    const dup = [];
    // 移動可能（relocated）なパッケージは texmf-dist/ を付けずに入っている
    for (const base of ['texmf-dist', '.']) {
      const dir = path.join(tmp, base);
      if (!fs.existsSync(dir)) continue;
      for (const rel of wanted) {
        const p = path.join(dir, rel);
        if (!fs.existsSync(p)) continue;
        const b = path.posix.basename(rel);
        // TeX はカレントディレクトリしか探さないので、フォルダは平らにする。同じ名前があれば先のものを使う
        if (files[b]) dup.push(b);
        else files[b] = new Uint8Array(fs.readFileSync(p));
      }
    }
    return { files, dup };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** .sty・.cls が読み込むもの（目録の依存関係。組版の前にまとめて読み込むために使う。漏れがあっても組版で補う） */
function requires(text) {
  const out = new Set();
  for (const m of text.matchAll(/\\(?:RequirePackage|RequirePackageWithOptions|usepackage)\s*(?:\[[^\]]*\])?\s*\{([^}#\\]+)\}/g)) {
    for (const n of m[1].split(',')) if (n.trim()) out.add(`${n.trim()}.sty`);
  }
  for (const m of text.matchAll(/\\(?:LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}#\\]+)\}/g)) out.add(`${m[1].trim()}.cls`);
  for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}#\\]+)\}/g)) {
    for (const n of m[1].split(',')) if (n.trim()) out.add(`tikzlibrary${n.trim()}.code.tex`);
  }
  return out;
}

async function main() {
  const pkgs = await readTlpdb();
  const busy = busytexFiles(BUSYTEX_PRELOAD);
  const { chosen, skippedFonts } = select(pkgs, busy);
  const withMaps = mapPackages(pkgs, new Set(skippedFonts));
  await download([...new Set([...chosen.map((p) => p.name), ...withMaps.map((p) => p.name)])]);

  fs.rmSync(path.join(OUT, 'p'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'p'), { recursive: true });
  const index = new Map(); // ファイル名 → 一式の番号
  const bundles = [];
  const needs = [];
  let total = 0;
  let conflicts = 0;
  for (const p of chosen.sort((a, b) => a.name.localeCompare(b.name))) {
    const { files } = extract(p.name, p.files);
    const names = Object.keys(files);
    if (!names.length) continue;
    const id = bundles.length;
    const req = new Set();
    for (const n of names) {
      if (index.has(n)) conflicts++;
      else index.set(n, id);
      if (/\.(sty|cls)$/.test(n)) for (const r of requires(new TextDecoder('latin1').decode(files[n]))) req.add(r);
    }
    files['README.paper-mug'] = strToU8(`TeX Live 2023 の ${p.name} から取得。各ファイルのライセンスは元のパッケージに従う。\n`);
    const zip = zipSync(files, { level: 9, mtime: new Date('2023-01-01') });
    fs.writeFileSync(path.join(OUT, 'p', `${p.name}.zip`), zip);
    total += zip.length;
    bundles.push({ name: p.name, file: `p/${p.name}.zip`, size: zip.length, maps: names.filter((n) => n.endsWith('.map')) });
    needs.push(req);
  }
  // 依存関係は、読み込むファイルを含む一式の番号にする（BusyTeX にあるものと自分自身は除く）
  bundles.forEach((b, i) => {
    const deps = [...new Set([...needs[i]].map((f) => index.get(f)).filter((d) => d !== undefined && d !== i))];
    if (deps.length) b.deps = deps.sort((x, y) => x - y);
    if (!b.maps.length) delete b.maps;
  });
  const sorted = (m) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
  const out = { version: 2, texlive: 2023, bundles, files: sorted(index) };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(out));

  // フォント名 → 対応表。TFM が手に入るフォントだけ（BusyTeX のすべてのデータパッケージか、一式にあるもの）
  const tfms = busytexFiles();
  for (const n of index.keys()) if (n.endsWith('.tfm')) tfms.add(n);
  const fonts = new Map();
  for (const p of withMaps) {
    const { files } = extract(p.name, new Set(p.maps));
    for (const [map, c] of Object.entries(files)) {
      for (const f of mapFonts(new TextDecoder('latin1').decode(c))) if (tfms.has(`${f}.tfm`) && !fonts.has(f)) fonts.set(f, map);
    }
  }
  fs.writeFileSync(path.join(OUT, 'fonts.json'), JSON.stringify(sorted(fonts)));
  console.log(`フォントの対応表：${fonts.size} フォント`);
  // 古い形式の一式（手で選んでいたもの）を消す
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.zip')) fs.rmSync(path.join(OUT, f));

  console.log(`${bundles.length} 個の一式、${index.size} ファイル、${(total / 1e6).toFixed(0)} MB（同じ名前のファイル ${conflicts} 個は先のものを使用）`);
  console.log(`含めなかった大きなフォント（${skippedFonts.length} 個）：${skippedFonts.join(', ')}`);
  if (total > BUDGET_BYTES) throw new Error(`一式が大きすぎます（${(total / 1e6).toFixed(0)} MB > ${BUDGET_BYTES / 1e6} MB）`);
}

await main();

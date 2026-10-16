// TeX Live のパッケージを展開したフォルダから、LaTeX の組版に要るファイルだけを 1 つの zip に平らに詰める。
// node scripts/pack-texmf.mjs <名前> <展開したフォルダ> <出力先>   … <出力先>/<名前>.zip を作る
// node scripts/pack-texmf.mjs --index <出力先>                     … <出力先>/index.json（どの zip にどのファイルがあるか）を作る
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';

const args = process.argv.slice(2);
if (args[0] === '--index') {
  const dest = args[1];
  const bundles = fs
    .readdirSync(dest)
    .filter((f) => f.endsWith('.zip'))
    .sort()
    .map((f) => ({ name: f.replace(/\.zip$/, ''), file: f, files: Object.keys(unzipSync(new Uint8Array(fs.readFileSync(path.join(dest, f))))).sort() }));
  fs.writeFileSync(path.join(dest, 'index.json'), `${JSON.stringify({ bundles }, null, 1)}\n`);
  console.log(`index: ${bundles.map((b) => `${b.name}（${b.files.length} ファイル）`).join('、')}`);
  process.exit(0);
}

const [name, src, dest] = args;
// tex/latex と tex/generic だけ（ConTeXt・plain TeX 用と、LuaTeX でしか使わない .lua は除く）
const files = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!e.name.endsWith('.lua')) {
      // TeX はカレントディレクトリしか探さないので、フォルダは平らにする
      if (files[e.name]) throw new Error(`ファイル名が重複しています：${e.name}`);
      files[e.name] = new Uint8Array(fs.readFileSync(p));
    }
  }
};
for (const sub of ['tex/latex', 'tex/generic']) if (fs.existsSync(path.join(src, sub))) walk(path.join(src, sub));
files['README.paper-mug'] = strToU8(`TeX Live 2023 から取得（${new Date().toISOString().slice(0, 10)}）。各ファイルのライセンスは元のパッケージに従う。\n`);
const zip = zipSync(files, { level: 9, mtime: new Date('2023-01-01') });
fs.writeFileSync(path.join(dest, `${name}.zip`), zip);
console.log(`${name}.zip：${Object.keys(files).length} ファイル、${(zip.length / 1e6).toFixed(1)} MB`);

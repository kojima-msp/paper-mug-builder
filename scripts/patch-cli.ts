// パッチ CLI：zip（またはディレクトリ）にパッチを当て、プロジェクト一式と __mug_main.tex を書き出す。
// npm run patch-cli -- <project.zip|dir> --out <dir> [--mode original|reflow] [--phase front|full] [--no-intro] [--body 6] [--k 1.5] [--width 85] [--height 85] [--margin 4] [--main path] [--adapter id]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MUG, type MugOptions } from '../src/mug';
import { patchProject, type PatchPhase } from '../src/patch';
import { detectMain } from '../src/project';
import { readZip, type ProjectFiles } from '../src/zip';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    mode: { type: 'string' },
    phase: { type: 'string' },
    'no-intro': { type: 'boolean' },
    k: { type: 'string' },
    body: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    margin: { type: 'string' },
    main: { type: 'string' },
    adapter: { type: 'string' },
  },
});

const input = positionals[0];
if (!input || !values.out) {
  console.error('usage: patch-cli <project.zip|dir> --out <dir> [--mode original|reflow] [--phase front|full] [--no-intro] [--body 6] [--k 1.5] [--width 85] [--height 85] [--margin 4] [--main path] [--adapter id]');
  process.exit(2);
}

function readDir(dir: string, base = ''): ProjectFiles {
  const files: ProjectFiles = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [p, c] of readDir(path.join(dir, e.name), rel)) files.set(p, c);
    else files.set(rel, new Uint8Array(fs.readFileSync(path.join(dir, e.name))));
  }
  return files;
}

const files = fs.statSync(input).isDirectory() ? readDir(input) : readZip(new Uint8Array(fs.readFileSync(input)));
const det = detectMain(files);
const main = values.main ?? det.main;
if (!main) {
  console.error(`メイン tex を決められません。--main で指定してください。候補：${det.candidates.join(', ') || '(なし)'}`);
  process.exit(1);
}

const mug: MugOptions = {
  ...DEFAULT_MUG,
  ...(values.mode && { mode: values.mode as MugOptions['mode'] }),
  includeIntro: !values['no-intro'],
  ...(values.k && { k: Number(values.k) }),
  ...(values.body && { bodyPt: Number(values.body) }),
  ...(values.width && { printWidth: Number(values.width) }),
  ...(values.height && { printHeight: Number(values.height) }),
  ...(values.margin && { margin: Number(values.margin) }),
};
const r = patchProject(files, main, { mug, phase: values.phase as PatchPhase | undefined, adapterId: values.adapter });

for (const [p, c] of files) {
  const dest = path.join(values.out, p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, c);
}
fs.writeFileSync(path.join(values.out, r.outPath), r.source);

console.log(`main: ${main}`);
console.log(`class: ${r.cls} (adapter ${r.adapter.id}) options [${r.options.join(',')}]`);
console.log(`mode: ${mug.mode}; cut after: ${r.cutReason}; moved abstract: ${r.movedAbstract}; intro: ${r.includedIntro}; bibtex: ${r.bibtex}`);
console.log(`closed envs: [${r.closedEnvs.join(',')}]; removed packages: [${r.removedPackages.join(',')}]; removed floats: [${r.removedFloats.join(',')}]`);
for (const w of r.warnings) console.log(`warning: ${w}`);
for (const i of r.info) console.log(`info: ${i}`);
console.log(`wrote ${path.join(values.out, r.outPath)}`);

// src/styles/<名前>/style.json を集めて検証し、src/styles/registry.ts を作る。
// npm run styles（テスト・開発・ビルドの前にも自動で走る）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles');
const OUT = path.join(STYLES_DIR, 'registry.ts');
/** スタイルではないフォルダ */
const NOT_STYLES = new Set(['common']);

const TOP_KEYS = new Set(['id', 'label', 'description', 'match', 'keywordEnvs', 'defaultFontSize', 'warnings', 'bstSubstitutes', 'original', 'reflow']);
const ORIGINAL_KEYS = new Set(['titleAbstract', 'preamble', 'beforeTextwidth', 'afterBibliography', 'ensureMaketitle']);
const REFLOW_KEYS = new Set(['removeOptions', 'addOptions', 'preamble']);

/** style.json を検証する。問題があればメッセージの配列を返す */
function validate(dir, spec) {
  const errors = [];
  const err = (m) => errors.push(`${dir}/style.json：${m}`);
  const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const regex = (s, where) => {
    try {
      new RegExp(s);
    } catch (e) {
      err(`${where} の正規表現が正しくありません（${e.message}）`);
    }
  };
  const file = (name, where) => {
    if (typeof name !== 'string') return err(`${where} はファイル名（文字列）で書いてください`);
    if (!fs.existsSync(path.join(STYLES_DIR, dir, name))) err(`${where} のファイル ${name} がフォルダにありません`);
  };

  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) err(`知らない項目「${k}」があります（綴りを確かめてください）`);
  if (spec.id !== dir) err(`id はフォルダ名と同じ「${dir}」にしてください（今は「${spec.id}」）`);
  if (typeof spec.label !== 'string' || !spec.label) err('label（UI に出す名前）がありません');
  if (!spec.match || !isStrings(spec.match.classes) || spec.match.classes.length === 0) {
    err('match.classes に、当てはまるクラス名を 1 つ以上書いてください');
  } else {
    for (const c of spec.match.classes) {
      const m = /^\/(.*)\/$/.exec(c);
      if (m) regex(m[1], `match.classes の ${c}`);
    }
  }
  if (spec.keywordEnvs !== undefined && !isStrings(spec.keywordEnvs)) err('keywordEnvs は文字列の配列で書いてください');
  if (spec.defaultFontSize !== undefined && typeof spec.defaultFontSize !== 'number') err('defaultFontSize は数値で書いてください');
  for (const [i, w] of (spec.warnings ?? []).entries()) {
    if (typeof w.if !== 'string' || typeof w.message !== 'string') err(`warnings[${i}] には if と message を書いてください`);
    else regex(w.if, `warnings[${i}].if`);
  }
  const o = spec.original ?? {};
  for (const k of Object.keys(o)) if (!ORIGINAL_KEYS.has(k)) err(`original に知らない項目「${k}」があります`);
  if (o.titleAbstract) {
    file(o.titleAbstract.file, 'original.titleAbstract.file');
    const t = o.titleAbstract.file && fs.existsSync(path.join(STYLES_DIR, dir, o.titleAbstract.file))
      ? fs.readFileSync(path.join(STYLES_DIR, dir, o.titleAbstract.file), 'utf8')
      : '';
    if (t && !t.includes('{{abstract}}')) err(`${o.titleAbstract.file} に {{abstract}}（Abstract が入る場所）がありません`);
  }
  for (const k of ['preamble', 'beforeTextwidth', 'afterBibliography']) if (o[k] !== undefined) file(o[k], `original.${k}`);
  const r = spec.reflow ?? {};
  for (const k of Object.keys(r)) if (!REFLOW_KEYS.has(k)) err(`reflow に知らない項目「${k}」があります`);
  if (r.preamble !== undefined) file(r.preamble, 'reflow.preamble');
  return errors;
}

/** スタイルを集めて registry.ts を書く。問題があれば例外を投げる */
export function generate() {
  const dirs = fs
    .readdirSync(STYLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NOT_STYLES.has(e.name))
    .map((e) => e.name);
  const errors = [];
  const styles = [];
  for (const dir of dirs) {
    const p = path.join(STYLES_DIR, dir, 'style.json');
    if (!fs.existsSync(p)) {
      errors.push(`${dir}/：style.json がありません`);
      continue;
    }
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      errors.push(`${dir}/style.json：JSON として読めません（${e.message}）`);
      continue;
    }
    errors.push(...validate(dir, spec));
    styles.push({ dir, spec });
  }
  if (!styles.some((s) => s.dir === 'generic')) errors.push('generic/ がありません（どのスタイルにも当たらないときの受け皿）');
  if (errors.length) throw new Error(`スタイルの設定に問題があります：\n${errors.map((e) => `  - ${e}`).join('\n')}`);

  // 並び順：名前順、generic は最後（どのクラスにも当てはまるため）
  styles.sort((a, b) => (a.dir === 'generic') - (b.dir === 'generic') || a.dir.localeCompare(b.dir));
  const imports = [];
  const entries = styles.map(({ dir, spec }) => {
    const names = [...new Set(fs.readdirSync(path.join(STYLES_DIR, dir)).filter((f) => f.endsWith('.tex')))].sort();
    const files = names.map((name) => {
      const v = `${dir.replace(/\W/g, '_')}_${name.replace(/\W/g, '_')}`;
      imports.push(`import ${v} from './${dir}/${name}?raw';`);
      return `${JSON.stringify(name)}: ${v}`;
    });
    return `  { spec: ${JSON.stringify(spec)}, files: { ${files.join(', ')} } },`;
  });
  const out = [
    '// 自動生成（scripts/gen-styles.mjs）。手で編集しない。スタイルを足したら npm run styles',
    "import type { StyleFiles, StyleSpec } from './spec';",
    ...imports,
    '',
    'export const registry: { spec: StyleSpec; files: StyleFiles }[] = [',
    ...entries,
    '];',
    '',
  ].join('\n');
  if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== out) fs.writeFileSync(OUT, out);
  return styles.map((s) => s.dir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`スタイル：${generate().join(', ')}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

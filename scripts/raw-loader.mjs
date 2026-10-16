// Node（tsx）で Vite の `?raw` インポート（ファイルの中身を文字列として読む）を扱うためのフック。
// 使い方：tsx --import ./scripts/raw-loader.mjs scripts/patch-cli.ts ...
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const RAW = '?raw';

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.endsWith(RAW)) return next(specifier, context);
    const resolved = next(specifier.slice(0, -RAW.length), context);
    return { ...resolved, url: resolved.url + RAW, shortCircuit: true };
  },
  load(url, context, next) {
    if (!url.endsWith(RAW)) return next(url, context);
    const source = readFileSync(fileURLToPath(url.slice(0, -RAW.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  },
});

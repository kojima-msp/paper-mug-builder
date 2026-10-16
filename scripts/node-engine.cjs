// BusyTeX（WASM）を Node で動かす TexEngine の実装（検証・ギャラリー作成用）。
// ブラウザのワーカーの代わりに、ワーカーが使うグローバル（self、importScripts、fetch、location）を用意して busytex_pipeline.js を読み込む。
//
// 注意：BusyTeX は追加のデータパッケージを「カレントディレクトリ基準の相対パス」で読むので、
// 作成時にカレントディレクトリを public/busytex に移し、そのままにする（呼び出し側は絶対パスを使うこと）。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PRELOAD = [
  'texlive-basic',
  'ubuntu-texlive-latex-base',
  'ubuntu-texlive-latex-recommended',
  'ubuntu-texlive-fonts-recommended',
  'ubuntu-texlive-science',
].map((p) => `${p}.js`);
const ALL = [...PRELOAD, 'ubuntu-texlive-latex-extra.js'];
/** 1 回の組版の上限 (ms)。BusyTeX はデータの読み込みに失敗すると待ち続けるため */
const TIMEOUT_MS = 120_000;

module.exports = function createNodeEngine(dist) {
  globalThis.self = globalThis;
  globalThis.require = require;
  globalThis.location = { href: `file://${dist}/` };
  // データパッケージは IndexedDB にキャッシュしようとするので、無いことにして毎回読ませる
  globalThis.indexedDB = {
    open() {
      throw new Error('no IndexedDB in Node');
    },
  };
  globalThis.importScripts = (src) => vm.runInThisContext(fs.readFileSync(path.resolve(dist, src), 'utf8'), { filename: src });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) =>
    /^https?:/.test(url)
      ? realFetch(url, opts)
      : new Response(fs.readFileSync(path.resolve(dist, url)), {
          headers: { 'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' },
        });

  process.chdir(dist);
  importScripts('busytex_pipeline.js');
  const quiet = (fn) => async (...args) => {
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try {
      return await fn(...args);
    } finally {
      Object.assign(console, { log, error });
    }
  };
  const pipeline = new BusytexPipeline('busytex.js', 'busytex.wasm', ALL, PRELOAD, [], () => {}, () => {}, true, BusytexPipeline.ScriptLoaderWorker);

  return {
    init: quiet(async () => {
      await pipeline.on_initialized_promise;
    }),
    compile: quiet(async (files, mainPath, extra = {}, opts = {}) => {
      await pipeline.on_initialized_promise;
      // BusyTeX の依存解決は、メイン tex の中身が文字列のときだけ \usepackage を読む（extra は文字列のまま渡す）
      const list = [...files].map(([p, c]) => ({ path: p, contents: c }));
      for (const [p, c] of Object.entries(extra)) list.push({ path: p, contents: c });
      const t0 = performance.now();
      const r = await Promise.race([
        pipeline.compile(list, mainPath, !!opts.bibtex, 'silent', 'pdftex_bibtex8', ALL),
        new Promise((res) => setTimeout(() => res({ exit_code: -1, pdf: null, log: `TIMEOUT ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS)),
      ]);
      const ok = r.exit_code === 0 && !!r.pdf && r.pdf.length > 0;
      return { ok, pdf: ok ? r.pdf : undefined, log: r.log, ms: performance.now() - t0 };
    }),
  };
};

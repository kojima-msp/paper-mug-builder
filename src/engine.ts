// TeX エンジンの薄いインターフェースと、BusyTeX（WASM）による実装。
import type { ProjectFiles } from './zip';

export interface CompileResult {
  ok: boolean;
  pdf?: Uint8Array;
  log: string;
  ms: number;
}

export interface CompileOptions {
  /** pdflatex → bibtex → pdflatex × 2 の順に走らせる */
  bibtex?: boolean;
}

export interface TexEngine {
  /** 読み込み完了で resolve。onStatus に進捗の文字列が来る。 */
  init(onStatus?: (s: string) => void): Promise<void>;
  /** mainPath はプロジェクト内の相対パス。コンパイルはそのディレクトリで行われる。 */
  compile(files: ProjectFiles, mainPath: string, extra?: Record<string, string | Uint8Array>, opts?: CompileOptions): Promise<CompileResult>;
}

// 事前に読み込むデータパッケージ。フォントだけのパッケージは \usepackage から選ばれないため、ここに入れておく
const PRELOAD_PACKAGES = [
  'texlive-basic',
  'ubuntu-texlive-latex-base',
  'ubuntu-texlive-latex-recommended',
  'ubuntu-texlive-fonts-recommended',
  'ubuntu-texlive-science',
].map((p) => `${p}.js`);
// 必要になったときだけ読み込むもの。BusyTeX がメイン tex の \usepackage を見て選ぶ
const ON_DEMAND_PACKAGES = ['ubuntu-texlive-latex-extra'].map((p) => `${p}.js`);
const ALL_PACKAGES = [...PRELOAD_PACKAGES, ...ON_DEMAND_PACKAGES];

type WorkerMessage =
  | { print: string }
  | { initialized: Record<string, string> }
  | { exception: string }
  | { pdf: Uint8Array | null; log: string; exit_code: number };

/**
 * 組版中にワーカーから何も届かない時間の上限 (ms)。
 * BusyTeX はデータパッケージの読み込みに失敗すると、エラーを出さずに完了を待ち続けるため、ここで打ち切る。
 */
const IDLE_TIMEOUT_MS = 120_000;

export class BusytexEngine implements TexEngine {
  private worker?: Worker;
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private onPrint: (s: string) => void = () => {};
  /** 進捗（組版中に追加のデータを読み込むときも使う） */
  private onStatus: (s: string) => void = () => {};

  private handlePrint(text: string) {
    const m = /Preparing\.\.\. \((\d+)\/(\d+)\)|All downloads complete/.exec(text);
    if (m) this.onStatus(m[1] ? `データ読み込み中 ${m[1]}/${m[2]}` : 'データ読み込み完了、初期化中');
    this.onPrint(text);
  }

  constructor(private baseUrl: string) {}

  private reset() {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
  }

  init(onStatus?: (s: string) => void): Promise<void> {
    if (onStatus) this.onStatus = onStatus;
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const w = new Worker(new URL('busytex_worker.js', this.baseUrl));
      this.worker = w;
      w.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
        if ('print' in data) {
          this.handlePrint(data.print);
        } else if ('initialized' in data) {
          resolve();
        } else if ('exception' in data) {
          reject(new Error(data.exception));
        }
      };
      w.onerror = (e) => reject(new Error(e.message || 'worker error'));
      w.postMessage({
        busytex_js: 'busytex.js',
        busytex_wasm: 'busytex.wasm',
        preload_data_packages_js: PRELOAD_PACKAGES,
        data_packages_js: ALL_PACKAGES,
        texmf_local: [],
        preload: true,
      });
    });
    // 失敗したら次の呼び出しで作り直せるようにする
    this.ready.catch(() => this.reset());
    return this.ready;
  }

  compile(files: ProjectFiles, mainPath: string, extra: Record<string, string | Uint8Array> = {}, opts: CompileOptions = {}): Promise<CompileResult> {
    const run = async (): Promise<CompileResult> => {
      await this.init();
      const w = this.worker!;
      // BusyTeX の依存解決は、メイン tex の中身が文字列のときだけ \usepackage を読む
      const list: { path: string; contents: Uint8Array | string }[] = [...files].map(([path, contents]) => ({ path, contents }));
      for (const [path, contents] of Object.entries(extra)) list.push({ path, contents });
      const t0 = performance.now();
      const result = await new Promise<WorkerMessage | { failed: string }>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (r: WorkerMessage | { failed: string }) => {
          clearTimeout(timer);
          resolve(r);
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish({ failed: `TeX エンジンが ${IDLE_TIMEOUT_MS / 1000} 秒応答しませんでした（データの読み込みに失敗した可能性があります）` }),
            IDLE_TIMEOUT_MS,
          );
        };
        arm();
        w.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
          arm();
          if ('print' in data) this.handlePrint(data.print);
          else finish(data);
        };
        w.onerror = (e) => finish({ failed: `TeX エンジンでエラーが発生しました：${e.message || 'worker error'}` });
        w.postMessage({
          files: list,
          main_tex_path: mainPath,
          bibtex: !!opts.bibtex,
          verbose: 'silent',
          driver: 'pdftex_bibtex8',
          data_packages_js: ALL_PACKAGES,
        });
      });
      const ms = performance.now() - t0;
      if ('failed' in result) {
        // 状態が分からないので、ワーカーを捨てて次回作り直す
        this.reset();
        return { ok: false, log: result.failed, ms };
      }
      if ('exception' in result) return { ok: false, log: result.exception, ms };
      if (!('exit_code' in result)) return { ok: false, log: 'unexpected worker message', ms };
      const ok = result.exit_code === 0 && !!result.pdf && result.pdf.length > 0;
      return { ok, pdf: ok ? result.pdf! : undefined, log: result.log, ms };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

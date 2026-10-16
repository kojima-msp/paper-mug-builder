// PDF を画像にする：マグ用 PDF の PNG（画像でしか入稿できない印刷業者向け）と、図表の縮小画像。
// pdf.js は大きいので、ボタンを押したときだけ読み込む。

/** 1 ページ目を dpi の解像度で、白い背景の PNG にする。PNG には dpi も書き込む（印刷業者のソフトが寸法を正しく読むため） */
export async function pdfToPng(pdf: Uint8Array, dpi: number): Promise<Blob> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  // pdf.js は渡したバッファを手放すので、写しを渡す
  const task = pdfjs.getDocument({ data: pdf.slice() });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport, background: 'rgb(255, 255, 255)' }).promise;
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG にできませんでした'))), 'image/png'),
    );
    return withDpi(new Uint8Array(await png.arrayBuffer()), dpi);
  } finally {
    await task.destroy();
  }
}

/** PDF の範囲（bp、左下が原点）を幅 widthPx の画像にする。図表の縮小画像用 */
export async function renderCrops(
  pdf: Uint8Array,
  items: { key: number; page: number; crop: { left: number; right: number; bottom: number; top: number } }[],
  widthPx: number,
): Promise<Map<number, HTMLCanvasElement>> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const task = pdfjs.getDocument({ data: pdf.slice() });
  const out = new Map<number, HTMLCanvasElement>();
  try {
    const doc = await task.promise;
    for (const { key, page: index, crop } of items) {
      const page = await doc.getPage(index + 1);
      // 高解像度の画面でもぼやけないように、表示の 2 倍で描く
      const scale = (2 * widthPx) / (crop.right - crop.left);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((crop.right - crop.left) * scale);
      canvas.height = Math.round((crop.top - crop.bottom) * scale);
      // ページの上端から crop.top までをずらして、範囲だけを描く
      const pageHeight = page.view[3] - page.view[1];
      const transform = [1, 0, 0, 1, -crop.left * scale, -(pageHeight - crop.top) * scale];
      await page.render({ canvas, viewport, transform, background: 'rgb(255, 255, 255)' }).promise;
      out.set(key, canvas);
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/** PNG の IHDR の直後に pHYs（解像度）を入れる */
function withDpi(png: Uint8Array, dpi: number): Blob {
  const IHDR_END = 8 + 4 + 4 + 13 + 4; // 署名 + IHDR（長さ・種類・中身・CRC）
  const ppm = Math.round(dpi / 0.0254); // 1 メートルあたりの画素数
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, ppm);
  view.setUint32(4, ppm);
  data[8] = 1; // 単位はメートル
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  chunk.set(data, 8);
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  return new Blob([png.subarray(0, IHDR_END), chunk, png.subarray(IHDR_END)] as BlobPart[], { type: 'image/png' });
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

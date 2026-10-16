// EPS の画像の代わりに読ませる PDF。pdfTeX は EPS を読めない（変換には Ghostscript が要る）ので、
// 元の画像と同じ大きさ（%%BoundingBox）の枠を描き、組版を止めずに続ける。
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const DEFAULT_SIZE = { width: 100, height: 50 };

/** EPS の %%BoundingBox から大きさ (bp) を読む。読めなければ既定の大きさ */
export function epsSize(eps: Uint8Array): { width: number; height: number } {
  const head = new TextDecoder('latin1').decode(eps.subarray(0, 4096));
  const m = /%%(?:HiRes)?BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(head);
  if (!m) return DEFAULT_SIZE;
  const [x0, y0, x1, y1] = m.slice(1).map(Number);
  const width = x1 - x0;
  const height = y1 - y0;
  return width > 0 && height > 0 ? { width, height } : DEFAULT_SIZE;
}

const cache = new Map<string, Promise<Uint8Array>>();

/** 同じ大きさの枠（薄い灰色の線と、ファイル名）だけの PDF */
export function epsPlaceholder(name: string, eps: Uint8Array | undefined): Promise<Uint8Array> {
  const { width, height } = eps ? epsSize(eps) : DEFAULT_SIZE;
  const key = `${name}:${width}x${height}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([width, height]);
      const line = Math.max(0.5, Math.min(width, height) * 0.02);
      const gray = rgb(0.6, 0.6, 0.6);
      page.drawRectangle({ x: line / 2, y: line / 2, width: width - line, height: height - line, borderColor: gray, borderWidth: line });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const label = `EPS: ${name.split('/').pop()}`;
      const size = Math.min(height * 0.3, (width * 0.9) / Math.max(1, font.widthOfTextAtSize(label, 1)));
      if (size >= 2) {
        page.drawText(label, { x: (width - font.widthOfTextAtSize(label, size)) / 2, y: (height - size * 0.7) / 2, size, font, color: gray });
      }
      return doc.save();
    })();
    cache.set(key, p);
  }
  return p;
}

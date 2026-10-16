// 「マグの印刷範囲」の幅・高さ・余白・塗り足しがどこを指すかを示す図（入力した値の比率で描く）
export interface Dims {
  printWidth: number;
  printHeight: number;
  margin: number;
  bleed: number;
}
export type DimPart = 'printWidth' | 'printHeight' | 'margin' | 'bleed';

/** 図の大きさは固定（値を変えてもまわりのレイアウトが動かないように）。中身はこの中に収まるよう縮尺を合わせる */
const VIEW_W = 320;
const VIEW_H = 220;
/** 図の周りに寸法の矢印と文字を置く余白 (px) */
const PAD = { top: 34, right: 84, bottom: 48, left: 16 };
/** 塗り足しや余白が 0 や小さすぎても見えるようにする最小の太さ (px) */
const MIN_BAND = 4;

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function renderDiagram(svg: SVGSVGElement, d: Dims, focus?: DimPart) {
  const w = Math.max(1, d.printWidth);
  const h = Math.max(1, d.printHeight);
  const totalW = w + 2 * d.bleed;
  const totalH = h + 2 * d.bleed;
  const s = Math.min((VIEW_W - PAD.left - PAD.right) / totalW, (VIEW_H - PAD.top - PAD.bottom) / totalH);
  const band = (mm: number) => (mm > 0 ? Math.max(MIN_BAND, mm * s) : 0);
  const b = band(d.bleed);
  const m = band(d.margin);
  const pw = w * s;
  const ph = h * s;
  // 塗り足しを含めた外枠
  const ox = PAD.left + (VIEW_W - PAD.left - PAD.right - (pw + 2 * b)) / 2;
  const oy = PAD.top + (VIEW_H - PAD.top - PAD.bottom - (ph + 2 * b)) / 2;
  const px = ox + b; // 印刷範囲
  const py = oy + b;
  const cx = px + m; // 余白の内側（中身を置く範囲）
  const cy = py + m;
  const cw = Math.max(0, pw - 2 * m);
  const ch = Math.max(0, ph - 2 * m);
  // 中身（表紙）の目安の線。下の方は余白の矢印のために空けておく
  const lines = Array.from({ length: 4 }, (_, i) => {
    const y = cy + ch * (0.16 + i * 0.16);
    const x2 = cx + cw * (i === 0 ? 0.7 : i === 4 ? 0.55 : 0.9);
    return `<line class="text-line" x1="${cx + cw * 0.1}" y1="${y}" x2="${x2}" y2="${y}"/>`;
  }).join('');
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    `<line class="dim-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-start="url(#mug-arrow)" marker-end="url(#mug-arrow)"/>`;
  const part = (name: DimPart, body: string) => `<g class="part ${name}${focus === name ? ' focus' : ''}">${body}</g>`;

  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.innerHTML = `
    <defs>
      <marker id="mug-arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 1 L6 4 L0 7" fill="none" stroke="context-stroke" stroke-width="1.2"/>
      </marker>
      <pattern id="mug-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" class="hatch"/>
      </pattern>
    </defs>
    ${part('bleed', `
      ${b > 0 ? `<rect class="bleed-area" x="${ox}" y="${oy}" width="${pw + 2 * b}" height="${ph + 2 * b}"/>` : ''}
      <text class="label" x="${PAD.left}" y="${oy + ph + 2 * b + 18}">塗り足し ${fmt(d.bleed)}<tspan class="sub" dx="6">${b > 0 ? '斜線の帯（切り落とされる）' : '（なし）'}</tspan></text>`)}
    <rect class="print-area" x="${px}" y="${py}" width="${pw}" height="${ph}"/>
    ${part('margin', `
      <rect class="content-area" x="${cx}" y="${cy}" width="${cw}" height="${ch}"/>
      ${m > 0 ? arrow(px, cy + ch * 0.86, cx, cy + ch * 0.86) : ''}
      <text class="label" x="${cx + 5}" y="${cy + ch * 0.86 + 4}">余白 ${fmt(d.margin)}</text>`)}
    <g class="content">${lines}</g>
    ${part('printWidth', `
      ${arrow(px, oy - 14, px + pw, oy - 14)}
      <text class="label" text-anchor="middle" x="${px + pw / 2}" y="${oy - 20}">幅 ${fmt(d.printWidth)}</text>`)}
    ${part('printHeight', `
      ${arrow(ox + pw + 2 * b + 14, py, ox + pw + 2 * b + 14, py + ph)}
      <text class="label" x="${ox + pw + 2 * b + 20}" y="${py + ph / 2 + 4}">高さ ${fmt(d.printHeight)}</text>`)}
    <text class="caption" x="${PAD.left}" y="${VIEW_H - 4}">太枠：印刷範囲　破線の内側：表紙（mm）</text>`;
}

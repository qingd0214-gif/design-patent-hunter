// extract_views.js — 从 CNIPA 公告文本 PDF 提取各视图原图，按原始视角名称命名
// 原理：pdfjs 渲染整页 + 从文字层找「设计N主视图」等标题，按「视图在标题正上方、左右两栏」的版式裁切
// 白底转透明（近白像素抠掉，保留反锯齿边缘与灰阶照片区），文件名：作者_视图名_宽x高.png
// 用法: node extract_views.js <patent.pdf> <outDir> [--dpi 300] [--author 苹果公司]
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const VIEW_RE = /^(设计\s*(\d+))?\s*(主视图|后视图|左视图|右视图|俯视图|仰视图|立体图|剖视图)/;
const CAP_TOP_PAD = 14;     // 视图底部与标题/表格线之间留白（已含标题字底与网格线）
const COL_GAP = 6;          // 左右栏裁切时的中缝余量
const FIRST_TOP_PT = 80;    // 每栏首个视图的上界（页眉表格线之下）
const X_INSET = 8;          // 左右各收进几个像素，避开页面竖线

async function main() {
  const [pdfPath, outDir] = process.argv.slice(2);
  if (!pdfPath || !outDir) { console.error('用法: node extract_views.js <patent.pdf> <outDir> [--dpi 300]'); process.exit(1); }
  const dpiArg = process.argv.indexOf('--dpi');
  const dpi = dpiArg >= 0 ? Number(process.argv[dpiArg + 1]) : 300;
  const scale = dpi / 72;
  const authorArg = process.argv.indexOf('--author');
  const author = authorArg >= 0 ? process.argv[authorArg + 1] : '';

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno);
    const viewport = page.getViewport({ scale });

    // 文字层：找视图标题（pdfjs 文字项粒度足够细，右视图+设计2主视图同行也能分开拿到）
    const tc = await page.getTextContent();
    const caps = [];
    for (const it of tc.items) {
      const m = (it.str || '').match(VIEW_RE);
      if (!m) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const x = tx[4], yTop = tx[5] - it.height * scale, yBot = tx[5];
      const w = (it.width || 0) * scale;
      caps.push({ name: m[2] ? `设计${m[2]}${m[3]}` : m[3], x, yTop, yBot, w, mid: x + w / 2 });
    }
    if (!caps.length) continue;

    const pageMid = viewport.width / 2;
    const pageW = viewport.width, pageH = viewport.height;
    const margin = 71 * scale; // CNIPA 内容边距 ~71pt

    // 渲染整页
    const canvas = createCanvas(Math.round(pageW), Math.round(pageH));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    // 检测页眉表格横线的实际位置：顶部区域内横向暗像素占比超 60% 的最下面一条线
    let headerLineY = Math.round(60 * scale);
    {
      const probeEnd = Math.round(120 * scale);
      const row = ctx.getImageData(Math.round(margin), 0, Math.round(pageW - 2 * margin), probeEnd).data;
      const rw = Math.round(pageW - 2 * margin);
      for (let y = probeEnd - 1; y >= 0; y--) {
        let dark = 0;
        for (let x = 0; x < rw; x++) {
          const o = (y * rw + x) * 4;
          if (row[o] < 128) dark++;
        }
        if (dark > rw * 0.6) { headerLineY = y + 6; break; }
      }
    }

    // 每个标题：裁其正上方区域；上边界 = 同栏中上一个标题的底部（或页首）
    const rows = new Map();
    for (const cap of caps) {
      const isLeft = cap.mid < pageMid;
      const key = isLeft ? 'L' : 'R';
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(cap);
    }

    const pageCapCount = caps.length; // 该页标题越多，越可能是正式视图页
    for (const [col, list] of rows) {
      list.sort((a, b) => a.yTop - b.yTop); // 从上到下
      const x0 = Math.max(0, (col === 'L' ? margin : pageMid + COL_GAP)) + X_INSET;
      const x1 = Math.min(pageW, (col === 'L' ? pageMid - COL_GAP : pageW - margin)) - X_INSET;
      for (let i = 0; i < list.length; i++) {
        const cap = list[i];
        const prev = list[i - 1];
        const y0 = prev ? prev.yBot + CAP_TOP_PAD : headerLineY; // 页眉表格线之下（实测位置）
        const y1 = cap.yTop - CAP_TOP_PAD;
        if (y1 - y0 < 20) continue;
        const cw = Math.round(x1 - x0), ch = Math.round(y1 - y0);
        if (cw < 30 || ch < 30) continue;
        const crop = createCanvas(cw, ch);
        const cctx = crop.getContext('2d');
        cctx.drawImage(canvas, Math.round(x0), Math.round(y0), cw, ch, 0, 0, cw, ch);
        // 白底转透明：近白像素透明，边缘反锯齿渐变，灰阶照片区不受影响
        const img = cctx.getImageData(0, 0, cw, ch);
        const d = img.data;
        const HI = 248, LO = 225; // min(r,g,b) >= HI 全透明，<= LO 不透明，中间线性过渡
        for (let i = 0; i < d.length; i += 4) {
          const m = Math.min(d[i], d[i + 1], d[i + 2]);
          if (m >= HI) d[i + 3] = 0;
          else if (m > LO) d[i + 3] = Math.round(255 * (HI - m) / (HI - LO));
        }
        cctx.putImageData(img, 0, 0);
        // 墨迹包围盒收紧：按 alpha 检测实际图形边界，裁到原始上传图的精确范围
        const PAD = 0;
        let minX = cw, minY = ch, maxX = -1, maxY = -1;
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            if (d[(y * cw + x) * 4 + 3] > 16) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) continue; // 空白区域
        minX = Math.max(0, minX - PAD); minY = Math.max(0, minY - PAD);
        maxX = Math.min(cw - 1, maxX + PAD); maxY = Math.min(ch - 1, maxY + PAD);
        const tw = maxX - minX + 1, th = maxY - minY + 1;
        const tight = createCanvas(tw, th);
        tight.getContext('2d').drawImage(crop, minX, minY, tw, th, 0, 0, tw, th);
        saved.push({ name: cap.name, page: pno, px: `${tw}x${th}`, pageCapCount, buf: tight.toBuffer('image/png') });
      }
    }
  }

  // 同名去重：扉页/简要说明页的缩略图与正式视图页同名，保留标题数最多页上的那份
  const best = new Map();
  for (const v of saved) {
    const cur = best.get(v.name);
    if (!cur || v.pageCapCount > cur.pageCapCount) best.set(v.name, v);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const [name, v] of best) {
    const file = author ? `${author}_${name}_${v.px}.png` : `${name}_${v.px}.png`;
    fs.writeFileSync(path.join(outDir, file), v.buf);
    out.push({ file, name, page: v.page, px: v.px });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  console.log(JSON.stringify({ ok: true, outDir, count: out.length, views: out }, null, 2));
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });

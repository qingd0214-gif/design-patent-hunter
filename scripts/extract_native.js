// extract_native.js — 从 CNIPA 公告 PDF 按原始分辨率抽取内嵌视图位图（零插值）
// 配对方式：跟踪 opList 的 CTM 算出每张内嵌图在页面上的摆放区域，与文字层标题做几何匹配
// 用法: node extract_native.js <patent.pdf> <outDir> [--author 苹果公司] [--transparent]
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const VIEW_RE = /设计\s*(\d+)\s*(主视图|后视图|左视图|右视图|俯视图|仰视图|立体图|剖视图)/;

function mul(m, n) { // PDF 矩阵串联: 先应用 m 再应用 n
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

async function main() {
  const [pdfPath, outDir] = process.argv.slice(2);
  if (!pdfPath || !outDir) { console.error('用法: node extract_native.js <patent.pdf> <outDir> [--author X] [--transparent]'); process.exit(1); }
  const ai = process.argv.indexOf('--author');
  const author = ai >= 0 ? process.argv[ai + 1] : '';
  const transparent = process.argv.includes('--transparent');

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno);
    const tc = await page.getTextContent();
    const caps = [];
    for (const it of tc.items) {
      const m = (it.str || '').match(VIEW_RE);
      if (!m) continue;
      // 文字基线（PDF 坐标系，y 向上）
      caps.push({ name: `${m[1]}${m[2]}`, x: it.transform[4], y: it.transform[5], assigned: false });
    }
    if (caps.length < 2) continue;
    const pageMid = page.getViewport({ scale: 1 }).width / 2; // 左右栏分界

    // 走 opList：跟踪 CTM，拿到每张内嵌图的页面摆放区域（PDF 坐标，y 向上）
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const placed = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if (fn === OPS.save) { stack.push(ctm); }
      else if (fn === OPS.restore) { ctm = stack.pop() || ctm; }
      else if (fn === OPS.transform) { ctm = mul(args, ctm); }
      else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
        const name = String(args[0]);
        const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        placed.push({
          name,
          x0: Math.min(...xs), x1: Math.max(...xs),
          y0: Math.min(...ys), y1: Math.max(...ys), // y0 = 图底部（PDF 坐标）
          assigned: false, obj: null
        });
      }
    }

    // 几何配对：每张图找其正下方最近的未分配标题
    const pairs = [];
    for (const img of placed) {
      let bestCap = null, bestDist = Infinity;
      const imgCx = (img.x0 + img.x1) / 2;
      for (const cap of caps) {
        if (cap.assigned) continue;
        // 栏对不上则排除（窄侧视图居中于栏内，但标题按栏宽居中，x 范围不重叠）
        if ((cap.x < pageMid) !== (imgCx < pageMid)) continue;
        const dist = cap.y - img.y0; // 标题基线应在图底部之下（实测间隙约 -6pt）
        if (dist < -22 || dist > 25) continue;
        if (dist < bestDist) { bestDist = dist; bestCap = cap; }
      }
      if (bestCap) { bestCap.assigned = true; img.assigned = true; pairs.push([img, bestCap]); }
      else console.error(`PAGE ${pno}: 未配对内嵌图 ${img.name} bbox=[${img.x0.toFixed(0)},${img.y0.toFixed(0)} ~ ${img.x1.toFixed(0)},${img.y1.toFixed(0)}]`);
    }
    for (const cap of caps) {
      if (!cap.assigned) console.error(`PAGE ${pno}: 标题「设计${cap.name}」没有配到内嵌图`);
    }

    // 解码落盘
    for (const [img, cap] of pairs) {
      let obj;
      try { obj = page.objs.get(img.name); } catch { continue; }
      if (!obj || !obj.width || !obj.data) continue;
      const w = obj.width, h = obj.height, d = obj.data;
      const bpp = d.length / (w * h); // 1=灰度 3=RGB 4=RGBA
      const c = createCanvas(w, h);
      const cctx = c.getContext('2d');
      const imageData = cctx.createImageData(w, h);
      for (let p = 0; p < w * h; p++) {
        imageData.data[p * 4] = bpp >= 3 ? d[p * bpp] : d[p];
        imageData.data[p * 4 + 1] = bpp >= 3 ? d[p * bpp + 1] : d[p];
        imageData.data[p * 4 + 2] = bpp >= 3 ? d[p * bpp + 2] : d[p];
        imageData.data[p * 4 + 3] = bpp === 4 ? d[p * 4 + 3] : 255;
      }
      cctx.putImageData(imageData, 0, 0);
      if (transparent) {
        const im = cctx.getImageData(0, 0, w, h);
        const dd = im.data;
        const HI = 248, LO = 225;
        for (let p = 0; p < dd.length; p += 4) {
          const mmin = Math.min(dd[p], dd[p + 1], dd[p + 2]);
          if (mmin >= HI) dd[p + 3] = 0;
          else if (mmin > LO) dd[p + 3] = Math.round(255 * (HI - mmin) / (HI - LO));
        }
        cctx.putImageData(im, 0, 0);
      }
      const name = `设计${cap.name}`;
      const file = `${author ? author + '_' : ''}${name}_${w}x${h}.png`;
      fs.writeFileSync(path.join(outDir, file), c.toBuffer('image/png'));
      saved.push({ file, name, page: pno, px: `${w}x${h}` });
    }
  }

  saved.sort((x, y) => x.name.localeCompare(y.name, 'zh'));
  console.log(JSON.stringify({ ok: true, outDir, count: saved.length, views: saved }, null, 2));
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });

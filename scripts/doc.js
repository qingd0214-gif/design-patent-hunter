// doc.js — 公告文本版式：把著录项目 + 官方视图合成 HTML（再由 pdf.js 转 PDF）
const path = require('path');

function esc(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildDocHtml(meta, viewFiles = []) {
  const rows = [
    ['公开（公告）号', meta.publicNo], ['申请号', meta.appNo], ['申请日', meta.appDate],
    ['公开（公告）日', meta.publicDate], ['名称', meta.title], ['申请人', meta.applicant],
    ['外观设计分类号', meta.locarno || ''], ['法律状态', meta.legalStatus || '']
  ].filter(r => r[1]);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
@page { size: A4; margin: 14mm 12mm; }
body { font-family: "Microsoft YaHei","PingFang SC",sans-serif; color:#111; font-size:12.5px; }
h1 { font-size:19px; margin:0 0 2px; letter-spacing:.5px; }
.sub { color:#666; font-size:11px; margin-bottom:14px; }
table { width:100%; border-collapse:collapse; margin-bottom:16px; }
td { border:1px solid #d5d5d5; padding:6px 9px; vertical-align:top; }
td.k { width:26%; background:#f7f7f7; color:#444; font-weight:600; }
.note { font-size:11px; color:#777; line-height:1.7; margin-top:8px; }
.views { display:flex; flex-wrap:wrap; gap:10px; }
.views figure { margin:0; border:1px solid #e0e0e0; padding:8px; width:calc(50% - 6px); box-sizing:border-box; page-break-inside:avoid; }
.views img { width:100%; display:block; }
.views figcaption { font-size:10px; color:#888; text-align:center; margin-top:4px; }
.foot { margin-top:14px; font-size:10px; color:#999; border-top:1px solid #eee; padding-top:6px; }
</style></head><body>
<h1>${esc(meta.title || '外观设计专利')}</h1>
<div class="sub">国家知识产权局 外观设计专利 · 公告文本（著录项目 + 官方视图）</div>
<table>${rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${viewFiles.length ? `<div class="views">${viewFiles.map((f, i) =>
    `<figure><img src="${path.basename(f)}"><figcaption>视图 ${i + 1}</figcaption></figure>`).join('')}</div>` : ''}
${meta.abstract ? `<div class="note"><strong>简要说明：</strong><br>${esc(meta.abstract)}</div>` : ''}
<div class="foot">来源：pss-system.cponline.cnipa.gov.cn · 抓取时间 ${new Date().toLocaleString('zh-CN')} · 仅供内部检索参考，法律效力以官方公告为准</div>
</body></html>`;
}

function buildIndexHtml(items, dirName) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(dirName)} · 外观专利检索结果</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;background:#f5f6f8;margin:0;padding:26px;color:#1a1a1a}
h1{font-size:20px;margin:0 0 4px}.sub{color:#777;font-size:12px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.card img{width:100%;height:150px;object-fit:contain;background:#fafafa;border-radius:6px}
.no{font-family:ui-monospace,monospace;font-size:13px;color:#0a58ca;font-weight:700;margin:8px 0 2px}
.t{font-size:13px;margin:2px 0}.m{font-size:11.5px;color:#777}
a.dl{display:inline-block;margin-top:8px;font-size:12px;color:#fff;background:#1f6feb;padding:5px 10px;border-radius:6px;text-decoration:none}
</style></head><body>
<h1>${esc(dirName)} · 外观设计专利</h1>
<div class="sub">共 ${items.length} 件 · 检索自国家知识产权局专利检索及分析系统 · ${new Date().toLocaleString('zh-CN')}</div>
<div class="grid">${items.map(it => `<div class="card">
  ${it.thumb ? `<img src="${esc(it.thumb)}">` : ''}
  <div class="no">${esc(it.publicNo)}</div>
  <div class="t">${esc(it.title)}</div>
  <div class="m">${esc(it.applicant)} · 申请日 ${esc(it.appDate)}</div>
  ${it.pdf ? `<a class="dl" href="${esc(it.pdf)}">打开公告 PDF</a>` : ''}
</div>`).join('')}</div></body></html>`;
}

module.exports = { buildDocHtml, buildIndexHtml, esc };

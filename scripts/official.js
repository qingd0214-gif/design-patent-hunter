// official.js — 走 CNIPA 官方导出接口下载公告文本（FullTextImage PDF）
// 流程：取页面 token → POST /tools/literature/export → 得到 zip 地址 → 用会话 cookie 下载 → 解包
// 这是「官方原件」路径，优先于本地合成 PDF。
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const { unzip } = require('./zip.js');

const EXPORT_API = '/api/pubsearch-app-tools/tools/literature/export';
const FIELDS = ['TIVIEW', 'ANID', 'APD', 'PNID', 'PD', 'IC', 'PAVIEW', 'INVIEW', 'PR', 'ABVIEW', 'ABS_IMG', 'DESC', 'CLMS', 'FULLTEXT_IMG'];

// 申请号规范化：CN202130547907.0 / 202130547907 → CN202130547907（保留 CN 前缀，去小数点）
// 重要：导出接口的 anId 不带校验位！CN202530344171.5 → CN202530344171（带校验位会报 400/500）
function normalizeAppNo(s = '') {
  let t = String(s).replace(/[.\s]/g, '').trim().toUpperCase();
  if (!t.startsWith('CN')) t = 'CN' + t;
  // 13 位 = 12 位主编号 + 1 位校验位，去掉校验位
  if (/^CN\d{13}$/.test(t)) t = t.slice(0, 14);
  return t;
}

async function getToken(page) {
  const token = await page.evaluate(() => {
    const stores = [localStorage, sessionStorage];
    for (const st of stores) {
      for (const k of Object.keys(st)) {
        const v = st.getItem(k) || '';
        if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return v;
        const m = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
        if (m && v.length < 4000) return m[0];
      }
    }
    return null;
  }).catch(() => null);
  return token;
}

// 触发导出，返回 zip 的绝对 URL
async function requestExport(page, appNos) {
  const token = await getToken(page);
  if (!token) throw new Error('页面里找不到登录 token，可能未登录');
  const body = {
    literatures: appNos.map(a => ({ anId: normalizeAppNo(a), dbName: 'CNDB' })),
    fields: FIELDS,
    type: 2
  };
  const resp = await page.evaluate(async ({ api, body, token }) => {
    const r = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', authorization: 'Bearer ' + token },
      body: JSON.stringify(body)
    });
    return { status: r.status, text: await r.text() };
  }, { api: EXPORT_API, body, token });

  if (resp.status !== 200) throw new Error('导出接口返回 ' + resp.status + '：' + resp.text.slice(0, 200));
  let j;
  try { j = JSON.parse(resp.text); } catch { throw new Error('导出返回非 JSON：' + resp.text.slice(0, 200)); }
  if (!j.t) throw new Error('导出未返回下载地址：' + resp.text.slice(0, 300));
  return j.t.startsWith('http') ? j.t : lib.BASE + j.t;
}

// 下载 zip（用 context.request，自动带会话 cookie）
async function downloadZip(ctx, url, outZip) {
  const r = await ctx.request.get(url, { timeout: 120000 });
  if (!r.ok()) throw new Error('下载 zip 失败 HTTP ' + r.status());
  const buf = await r.body();
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  fs.writeFileSync(outZip, buf);
  return { bytes: buf.length, outZip };
}

// 一站式：按申请号列表拉官方公告文本，解包到 outDir
async function fetchOfficial(ctx, page, appNos, outDir) {
  const url = await requestExport(page, appNos);
  const zipPath = path.join(outDir, '_bundle.zip');
  const { bytes } = await downloadZip(ctx, url, zipPath);
  const files = unzip(zipPath, outDir);
  const pdfs = files.filter(f => /_FullTextImage\.pdf$/i.test(f.name));
  return { zipUrl: url, bytes, files, pdfs };
}

module.exports = { fetchOfficial, requestExport, downloadZip, getToken, normalizeAppNo, FIELDS };

if (require.main === module) {
  (async () => {
    const ids = (process.argv[2] || '').split(',').filter(Boolean);
    const outDir = path.resolve(process.argv[3] || './patent_out');
    if (!ids.length) { console.error('用法: node official.js CN202130547907,CN202130547916 --outdir ./out/xxx'); process.exit(1); }
    const { ctx } = await lib.connect();
    const { page, loggedIn, needLogin } = await lib.ensureLoggedIn(ctx);
    if (!loggedIn) { console.log(JSON.stringify({ ok: false, code: 'NEED_LOGIN' })); process.exit(3); }
    const r = await fetchOfficial(ctx, page, ids, outDir);
    console.log(JSON.stringify({ ok: true, count: r.pdfs.length, pdfs: r.pdfs, bytes: r.bytes }, null, 2));
    process.exit(0);
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}

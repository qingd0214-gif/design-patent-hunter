#!/usr/bin/env node
// hunt.js — 一条命令跑完「检索 → 定位 → 验证 → 下载 → 出图」
// 设计目标（2026-11-22 复盘后重写）：
//   1) 检索走高级检索 /seniorSearch：外观设计在服务端筛选，不再点假的筛选芯片
//   2) 列表解析用叶节点爬行 + 申请号/申请日一致性断言，不再用 innerText 全局正则
//   3) 分页用 .el-pager li.number / .btn-next，每页 40
//   4) stdout 只输出紧凑 JSON（<2KB），日志写文件 —— 控制上下文消耗
//   5) 下载前必须过「主视图目视」，避免用配额换错误候选
//
// 用法：
//   node hunt.js search --name 耳机 --applicant 苹果公司 --kw 耳机,盒,充电
//   node hunt.js verify CN309792845S --out E:/WorkBuddyOutput/AirPods
//   node hunt.js dl CN309792845S --out E:/WorkBuddyOutput/AirPods          # 打开下载弹窗并抓验证码
//   node hunt.js dlsub CN309792845S 5575 --out E:/WorkBuddyOutput/AirPods  # 提交 + 解包 + 出图
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.js');
const official = require('./official.js');
const { unzip } = require('./zip.js');

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'search').match(/^[a-z]+$/) ? argv[0] : 'search';
const rest = cmd === 'search' ? argv : argv.slice(1);
function arg(name, def = '') {
  const i = rest.indexOf('--' + name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
}
const pos = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));

let OUT = arg('out') || 'E:/WorkBuddyOutput/专利检索';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_hunt.log');
const T0 = Date.now();
const log = (...a) => fs.appendFileSync(LOG, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}\n`);
const emit = o => { process.stdout.write(JSON.stringify(o) + '\n'); };

// 在结果页定位某公开号：先查当前页，再向后翻，最多翻 maxPages 页
async function gotoRow(listPage, pn, maxPages = 8) {
  for (let i = 0; i < maxPages; i++) {
    const has = await listPage.evaluate(p => document.body.innerText.includes(p), pn).catch(() => false);
    if (has) return true;
    const moved = await lib.nextPage(listPage);
    log('gotoRow flip ->', moved);
    if (!moved) return false;
  }
  return false;
}

async function openByNo(ctx, listPage, pn) {
  const found = await gotoRow(listPage, pn);
  if (!found) throw new Error('结果集中找不到 ' + pn);
  const dp = await lib.openDetail(listPage, ctx, pn);
  if (!dp) throw new Error('打开详情页失败 ' + pn);
  await dp.waitForTimeout(4000);
  return dp;
}

(async () => {
  fs.writeFileSync(LOG, '');
  const { ctx } = await lib.connect();
  const sess = await lib.checkSession(ctx);
  if (!sess.ok) {
    const lg = await lib.ensureLoggedIn(ctx);
    log('relogin =>', lg.loggedIn);
    if (!lg.loggedIn) { emit({ ok: false, code: 'NEED_LOGIN', minutesLeft: sess.minutes }); process.exit(3); }
  }

  // ---------- search ----------
  if (cmd === 'search') {
    const name = arg('name');
    const applicant = arg('applicant');
    const kw = (arg('kw') || [name, applicant].filter(Boolean).join(',')).split(/[,，]/).filter(Boolean);
    const top = Number(arg('top', '12'));
    const maxPages = Number(arg('max-pages', '8'));
    const r = await lib.seniorSearch(ctx, { name, applicant, pageSize: 40, onLog: m => log(m) });
    log('search total', r.total, 'expr', r.expr);
    const h = await lib.harvestAll(r.listPage, { maxPages });
    log('harvest', h.rows.length, 'pages', h.pagesUsed, 'warn', h.warnings.length);
    const ranked = lib.rankCandidates(h.rows, kw);
    emit({
      ok: true,
      expr: r.expr,
      total: h.total,
      harvested: h.rows.length,
      pagesUsed: h.pagesUsed,
      warnings: h.warnings.slice(0, 3),
      candidates: ranked.slice(0, top).map((c, i) => ({
        i: i + 1, pn: c.pn, ap: c.ap, apd: c.apd, ti: c.ti, score: c.score
      }))
    });
    process.exit(0);
  }

  // ---------- verify ----------
  if (cmd === 'verify') {
    const pn = pos[0];
    if (!pn) { emit({ ok: false, error: '缺少公开号' }); process.exit(1); }
    const listPage = ctx.pages().filter(p => p.url().includes('retrieveList')).pop();
    if (!listPage) { emit({ ok: false, error: '没有结果页，请先跑 search' }); process.exit(1); }
    const dp = await openByNo(ctx, listPage, pn);
    await dp.locator(':text-is("主视图")').first().click({ timeout: 8000 }).catch(() => {});
    await dp.waitForTimeout(3500);
    const data = await dp.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => (i.src || '').includes('service-image-url') && i.naturalWidth > 80);
      const out = [];
      imgs.slice(0, 1).forEach(img => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          out.push(c.toDataURL('image/png'));
        } catch (e) {}
      });
      return out;
    });
    if (!data.length) { emit({ ok: false, error: '主视图未渲染' }); process.exit(1); }
    const f = path.join(OUT, `验证_${pn}.png`);
    fs.writeFileSync(f, Buffer.from(data[0].split(',')[1], 'base64'));
    const meta = await dp.evaluate(() => document.body.innerText.slice(0, 400));
    emit({ ok: true, pn, image: f, metaHint: meta.split('\n').filter(Boolean).slice(0, 6).join(' | ') });
    process.exit(0);
  }

  // ---------- dl：打开下载弹窗，落验证码图 ----------
  if (cmd === 'dl') {
    const pn = pos[0];
    const listPage = ctx.pages().filter(p => p.url().includes('retrieveList')).pop();
    if (!listPage) { emit({ ok: false, error: '没有结果页，请先跑 search' }); process.exit(1); }
    const dp = await openByNo(ctx, listPage, pn);
    let b64 = null;
    dp.on('response', async r => {
      if (/questionShowPic/.test(r.url())) { try { const j = JSON.parse(await r.text()); if (j.t) b64 = j.t; } catch {} }
    });
    const marked = await dp.evaluate(() => {
      const el = [...document.querySelectorAll('a,span,div')].find(e => e.children.length === 0 && e.textContent.trim() === '下载' && e.getBoundingClientRect().width > 0);
      if (el) { el.setAttribute('data-dl', '1'); return true; }
      return false;
    });
    if (!marked) { emit({ ok: false, error: '找不到下载入口' }); process.exit(1); }
    await dp.locator('[data-dl="1"]').click({ force: true });
    await dp.waitForTimeout(4000);
    const dlg = dp.locator('.el-dialog').filter({ hasText: '文献下载设置' }).first();
    await dlg.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await dlg.locator('.el-checkbox').filter({ hasText: '全文图像' }).first().click({ force: true }).catch(() => {});
    await dp.waitForTimeout(600);
    const capFile = path.join(OUT, `验证码_${pn}.jpg`);
    if (b64) fs.writeFileSync(capFile, Buffer.from(b64, 'base64'));
    emit({ ok: !!b64, pn, captcha: b64 ? capFile : null, next: b64 ? `node hunt.js dlsub ${pn} <验证码> --out ${OUT}` : '未捕获验证码，重试 dl' });
    process.exit(b64 ? 0 : 1);
  }

  // ---------- dlsub：提交验证码 → 下载 zip → 解包 → 出图 ----------
  if (cmd === 'dlsub') {
    const pn = pos[0], code = pos[1];
    if (!pn || !code) { emit({ ok: false, error: '用法: dlsub <公开号> <验证码>' }); process.exit(1); }
    const dp = ctx.pages().filter(p => p.url().includes('detail')).pop();
    if (!dp) { emit({ ok: false, error: '没有详情页，请先跑 dl' }); process.exit(1); }
    await dp.bringToFront();
    let zipUrl = null;
    dp.on('response', async r => {
      if (/literature\/export/.test(r.url())) { try { const j = JSON.parse(await r.text()); if (j.t) zipUrl = j.t; } catch {} }
    });
    const dlg = dp.locator('.el-dialog').filter({ hasText: '文献下载设置' }).first();
    await dlg.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await dlg.locator('input[placeholder="请输入验证码"]').fill(code);
    await dp.waitForTimeout(300);
    await dlg.locator('button:has-text("确定")').click({ force: true });
    for (let i = 0; i < 15; i++) { await dp.waitForTimeout(2000); if (zipUrl) break; }
    if (!zipUrl) { emit({ ok: false, error: '验证码错误或导出失败（配额 5 次/天）' }); process.exit(2); }
    const zipPath = path.join(OUT, '_bundle.zip');
    await official.downloadZip(ctx, zipUrl, zipPath);
    const files = unzip(zipPath, OUT);
    const pdf = files.map(f => path.join(OUT, f.name)).find(f => /_FullTextImage\.pdf$/i.test(f));
    if (!pdf) { emit({ ok: false, error: 'zip 内未找到 FullTextImage.pdf' }); process.exit(3); }
    const author = arg('author', '');
    const viewDir = path.join(OUT, `${pn}_视图`);
    const args = [path.join(__dirname, 'extract_views.js'), pdf, viewDir];
    if (author) args.push('--author', author);
    let views = [];
    try {
      execFileSync(process.execPath, args, { stdio: 'pipe' });
      views = fs.readdirSync(viewDir).filter(f => /\.png$/i.test(f));
    } catch (e) { log('extract err', e.message.slice(0, 200)); }
    emit({ ok: true, pn, pdf, views: views.length, viewDir: views.length ? viewDir : null, quotaNote: '每次 = 1 次配额（5/天）' });
    process.exit(0);
  }

  emit({ ok: false, error: '未知命令: ' + cmd });
  process.exit(1);
})().catch(e => {
  log('FATAL', e.message);
  emit({ ok: false, error: String(e.message).slice(0, 300) });
  process.exit(1);
});

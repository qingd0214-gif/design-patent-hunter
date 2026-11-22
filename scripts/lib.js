// lib.js — CNIPA 专利检索系统驱动库
// 依赖：playwright-core（同目录 npm i playwright-core）
// 设计要点：
//  1) 复用专用 Chrome 档案（patent_profile），登录态保存在档案里，避免反复登录
//  2) 会话过期时若存在 credentials.json 则自动重登；没有则抛 NEED_LOGIN 让上层提示用户
//  3) 所有操作带节流，避免触发瑞数风控
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const SKILL_DIR = path.resolve(__dirname, '..');
const PROFILE = process.env.PATENT_PROFILE || path.join(SKILL_DIR, 'patent_profile');
const PORT = Number(process.env.PATENT_CDP_PORT || 9333);
const CHROME = process.env.PATENT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CRED_FILE = path.join(SKILL_DIR, 'credentials.json');
const BASE = 'https://pss-system.cponline.cnipa.gov.cn';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function launchChrome(url = BASE + '/conventionalSearch') {
  if (await cdpAlive()) return { reused: true };
  fs.mkdirSync(PROFILE, { recursive: true });
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
    try { fs.unlinkSync(path.join(PROFILE, f)); } catch {}
  });
  const child = spawn(CHROME, [
    '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1380,920', url
  ], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpAlive()) return { reused: false, pid: child.pid };
    await sleep(500);
  }
  throw new Error('Chrome 调试端口未就绪：' + PORT);
}

async function connect() {
  await launchChrome();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  return { browser, ctx };
}

function pickPage(ctx, { prefer } = {}) {
  const pages = ctx.pages();
  if (prefer) {
    const hit = pages.find(p => p.url().includes(prefer));
    if (hit) return hit;
  }
  return pages.find(p => p.url().includes('cponline')) || pages[0] || null;
}

function isLoginUrl(url = '') {
  return url.includes('tysf') && url.includes('login');
}

function readCreds() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    return c && c.account && c.password ? c : null;
  } catch { return null; }
}

// 确保处于已登录状态；返回 { page, loggedIn, needLogin }
// 判定依据改为 sessionId cookie（40 分钟有效），不再看页面文案——
// 旧实现用「有没有关键词输入框」判断，踩过误判 loggedIn=true 后拿失效会话空转 12 分钟的坑。
async function ensureLoggedIn(ctx, { allowAutoLogin = true } = {}) {
  const sess = await checkSession(ctx);
  let page = pickPage(ctx, { prefer: 'conventionalSearch' });
  if (sess.ok) {
    if (!page || !page.url().includes('cponline')) page = await ctx.newPage();
    return { page, loggedIn: true, minutesLeft: sess.minutes };
  }
  // 需要（重新）登录
  const cred = allowAutoLogin ? readCreds() : null;
  if (!cred) return { page, loggedIn: false, needLogin: true, minutesLeft: sess.minutes };

  const lp = await ctx.newPage();
  await lp.goto('https://tysf.cponline.cnipa.gov.cn/am/#/user/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await lp.waitForTimeout(2500);
  try {
    await lp.locator('input[placeholder*="手机号"]').first().fill(cred.account, { timeout: 15000 });
    await lp.locator('input[type="password"]').first().fill(cred.password, { timeout: 10000 });
    await sleep(400);
    await lp.locator('button:has-text("登录"), .el-button:has-text("登录")').first().click();
    // 登录可能弹滑块：轮询等 sessionId 出现/刷新，最多 45 秒
    let ok = false;
    for (let i = 0; i < 15; i++) {
      await lp.waitForTimeout(3000);
      const s = await checkSession(ctx, { minMinutes: 1 });
      if (s.ok) { ok = true; break; }
    }
    await lp.close().catch(() => {});
    return { page: pickPage(ctx, { prefer: 'conventionalSearch' }), loggedIn: ok, needLogin: !ok, minutesLeft: ok ? 'auto' : 0 };
  } catch (e) {
    return { page: lp, loggedIn: false, needLogin: true, error: e.message };
  }
}

// ==========================================================================
// 新链路（2026-11-22 验证）：高级检索 /seniorSearch + 每页 40 + .el-pager 翻页
// 旧链路 search()（常规检索 + 筛选芯片）保留兼容，但不要再用于新任务：
//   - 筛选芯片是 div 假芯片，状态易丢，常导致「暂无检索数据」
//   - 分页控件不是 li，旧 goNext 永远点不到（这是 30 分钟空转的根因）
// ==========================================================================

const BASE_SENIOR = BASE + '/seniorSearch';

// 瑞数反爬会先返回 HTTP 412 挑战页（DOM 全空，html 只有 39 字符），跑完 JS 才真正渲染。
// 直接 waitForSelector 会因上下文被替换而失败 —— 必须先等 body 有内容。这是「白屏」的真因。
async function gotoWithChallenge(p, url, { tries = 3, settle = 40000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const ok = await p.waitForFunction(
      () => document.body && document.body.innerText.trim().length > 150,
      { timeout: settle }
    ).then(() => true).catch(() => false);
    if (ok) return true;
    await sleep(2000);
  }
  return false;
}

// 会话守卫：看 sessionId cookie 剩余时间（实测有效期 40 分钟）
async function checkSession(ctx, { minMinutes = 6 } = {}) {
  const cs = (await ctx.cookies()).filter(c => /cponline/.test(c.domain) && c.name === 'sessionId');
  if (!cs.length) return { ok: false, reason: 'NO_SESSION', minutes: 0 };
  const left = (cs[0].expires * 1000 - Date.now()) / 60000;
  return { ok: left > minMinutes, reason: left > minMinutes ? 'OK' : 'EXPIRING', minutes: Math.round(left) };
}

// 在高级检索页勾选检索范围（发明/实用新型/外观设计）
async function pickScope(page, names = ['外观设计']) {
  for (const nm of names) {
    const el = page.locator('.searchLiLabel span', { hasText: new RegExp('^\\s*' + nm + '\\s*$') }).first();
    if (!(await el.count())) continue;
    await el.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  return await page.evaluate(() => [...document.querySelectorAll('.searchLiLabel span')]
    .filter(e => /hover/.test(e.className) || /active|selected/.test(e.className))
    .map(e => e.textContent.trim()));
}

// 高级检索：一次搞定「外观设计 + 名称/申请人」服务端筛选
// opts: { name, applicant, extraExpr, designOnly, pageSize, timeoutMs }
async function seniorSearch(ctx, { name, applicant, extraExpr = '', designOnly = true, pageSize = 40, onLog = () => {} } = {}) {
  // 关掉旧结果页，避免选错标签（新旧标签 URL 完全相同，是之前「拿到旧列表」的隐藏坑）
  for (const p of ctx.pages().filter(x => x.url().includes('retrieveList'))) await p.close().catch(() => {});

  const p = await ctx.newPage();
  const ok1 = await gotoWithChallenge(p, BASE_SENIOR);
  if (!ok1) throw new Error('高级检索页未渲染（412 挑战未通过，可能触发风控，稍后重试）');
  // 注意 state 必须是 attached：检索式 textarea 初始处于隐藏面板里，visible 会一直等不到
  const ready = await p.waitForSelector('textarea.el-textarea__inner', { state: 'attached', timeout: 25000 }).then(() => true).catch(() => false);
  if (!ready) throw new Error('高级检索页无检索式输入框（页面结构可能已改版）');
  // 必须给 SPA 完整初始化时间：过早提交会打开一个永远不加载数据的空白结果页（实测踩过）
  await p.waitForTimeout(5000);
  // 等检索项列表真正渲染（过早点击字段名不会注册到表单模型，导致检索式为空）
  await p.locator(':text-is("发明名称")').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

  if (designOnly) await pickScope(p, ['外观设计']);

  // 关键：必须先点字段名，让前端把检索项注册进表单模型（textarea 只是投影，直接 fill 不生效）
  const parts = [];
  if (name) {
    const ok1 = await clickField(p, '发明名称');
    if (!ok1) throw new Error('点击「发明名称」未注册检索项（页面未就绪）');
    parts.push(`发明名称=(${name})`);
  }
  if (applicant) {
    const ok2 = await clickField(p, '申请（专利权）人');
    if (!ok2) throw new Error('点击「申请（专利权）人」未注册检索项（页面未就绪）');
    parts.push(`申请（专利权）人=(${applicant})`);
  }
  if (extraExpr) parts.push(extraExpr);
  const expr = parts.join(' AND ');

  await p.locator('textarea.el-textarea__inner').fill(expr);
  await p.waitForTimeout(400);
  const gotVal = await p.locator('textarea.el-textarea__inner').inputValue().catch(() => '');
  if (gotVal !== expr) throw new Error('检索式未写入：' + gotVal);

  const btn = p.locator('div.btn,button,.el-button').filter({ hasText: /^\s*检索\s*$/ }).first();
  await btn.waitFor({ state: 'visible', timeout: 20000 });

  // 点检索会开新标签；新标签偶发卡在 412 挑战不渲染。
  // 表单状态仍在，直接再点一次检索即可重开标签 —— 最多 3 次。
  let list = null;
  for (let attempt = 0; attempt < 3 && !list; attempt++) {
    if (attempt > 0) onLog(`重新点检索（第 ${attempt + 1} 次）`);
    await btn.click({ timeout: 15000 }).catch(() => {});

    let cand = null;
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(1000);
      const ls = ctx.pages().filter(x => x.url().includes('retrieveList'));
      if (ls.length) { cand = ls[ls.length - 1]; break; }
    }
    if (!cand) { onLog('未出现结果页'); continue; }
    await cand.bringToFront();

    const hasBody = await cand.waitForFunction(() => document.body && document.body.innerText.trim().length > 150, { timeout: 30000 }).then(() => true).catch(() => false);
    const hasData = hasBody && await cand.waitForFunction(() => /(\d+)\s*条数据/.test(document.body.innerText), { timeout: 25000 }).then(() => true).catch(() => false);
    onLog(`attempt#${attempt} body=${hasBody} data=${hasData} url=${cand.url().slice(-30)}`);
    if (hasData) { list = cand; break; }
    await cand.close().catch(() => {});
    await p.bringToFront();
    await p.waitForTimeout(1500);
  }
  if (!list) throw new Error('结果页始终未渲染（412 风控），稍后重试或手动在窗口里检索一次');
  onLog('list ready: ' + list.url());

  let info = { total: null, rows: [], nextEnabled: false };
  for (let i = 0; i < 12; i++) {
    info = await readPage(list).catch(e => { onLog('readPage err ' + e.message.slice(0, 80)); return info; });
    if (info.total !== null && info.rows.length > 0) break;
    await list.waitForTimeout(900);
  }
  onLog(`total=${info.total} rows=${info.rows.length}`);
  if (info.total === null) throw new Error('结果页无数据（检索式可能未提交）：' + expr);
  if (pageSize && pageSize !== 10) await setPageSize(list, pageSize).catch(() => {});
  return { listPage: list, searchPage: p, expr, total: info.total, firstPageRows: (await readPage(list)).rows };
}

// 点检索项字段名，让前端插入 <字段>=() 模板；返回是否真的注册成功
async function clickField(page, label) {
  const el = page.locator(`:text-is("${label}")`).first();
  if (!(await el.count())) return false;
  await el.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const ta = page.locator('textarea.el-textarea__inner');
  const before = await ta.inputValue().catch(() => '');
  await el.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const after = await ta.inputValue().catch(() => '');
  return after !== before && after.includes(label.slice(0, 4));
}

// 每页条数：5/10/20/30/40
async function setPageSize(page, n) {
  const sel = page.locator('.el-select').filter({ hasText: '条/页' }).first();
  await sel.click({ timeout: 8000 });
  await page.waitForTimeout(500);
  const opt = page.locator('.el-select-dropdown__item', { hasText: `${n} 条/页` }).first();
  await opt.click({ force: true, timeout: 8000 });
  await page.waitForTimeout(3000);
  return n;
}

// 读当前页：叶节点公开号 → 向上爬到行容器，取 5 个字段
// （禁用 innerText 全局正则：跨行会把邻行标题错配到本行，这是 Beats 误配的根源）
async function readPage(page) {
  return await page.evaluate(() => {
    const rows = [];
    const anchors = [...document.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && /^CN\d{6,}[SU]$/.test((e.textContent || '').trim()));
    for (const a of anchors) {
      let row = a;
      for (let i = 0; i < 8 && row.parentElement; i++) {
        row = row.parentElement;
        const t = row.innerText || '';
        if (/CN\d{6,}[SU]/.test(t) && /CN\d{11,13}/.test(t) && t.length < 900) break;
      }
      const L = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      rows.push({ pn: a.textContent.trim(), ap: L[1] || '', apd: L[2] || '', ti: L[3] || '', pa: L[4] || '' });
    }
    const m = document.body.innerText.match(/(\d+)\s*条数据/);
    const nx = document.querySelector('.el-pager li.btn-next, .btn-next');
    return {
      total: m ? Number(m[1]) : null,
      rows,
      nextEnabled: nx ? !nx.disabled && !/is-disabled|disabled/.test(nx.className) : false,
      curPage: (document.querySelector('.el-pager li.number.active') || {}).textContent || ''
    };
  });
}

async function nextPage(page) {
  const nx = page.locator('.el-pager li.btn-next, .btn-next').first();
  if (!(await nx.count())) return false;
  const dis = await nx.evaluate(e => e.disabled || /is-disabled|disabled/.test(e.className)).catch(() => true);
  if (dis) return false;
  const before = (await readPage(page)).rows[0];
  await nx.click({ timeout: 8000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(900);
    const now = (await readPage(page)).rows[0];
    if (now && (!before || now.pn !== before.pn)) return true;
  }
  return false;
}

// 断言：申请号年份必须与申请日一致（防错行）
function auditRows(rows) {
  const warnings = [];
  for (const r of rows) {
    const y1 = r.ap.replace(/^CN/, '').slice(0, 4);
    const y2 = (r.apd || '').slice(0, 4);
    if (y1 && y2 && y1 !== y2) warnings.push({ pn: r.pn, ap: r.ap, apd: r.apd, msg: '申请号年份与申请日不一致' });
    if (!/S$/.test(r.pn)) warnings.push({ pn: r.pn, msg: '非外观设计编号（筛选可能失效）' });
  }
  return warnings;
}

// 翻页收全量，按公开号去重
async function harvestAll(page, { maxPages = 8, delay = 0 } = {}) {
  const all = [];
  let guard = 0, total = null, pagesUsed = 0;
  while (guard++ < maxPages) {
    const info = await readPage(page);
    total = info.total;
    all.push(...info.rows);
    pagesUsed++;
    if (!info.nextEnabled) break;
    if (all.length >= (total || 0)) break;
    const moved = await nextPage(page);
    if (!moved) break;
    if (delay) await page.waitForTimeout(delay);
  }
  const seen = new Set(); const out = [];
  for (const r of all) { if (seen.has(r.pn)) continue; seen.add(r.pn); out.push(r); }
  return { rows: out, total, pagesUsed, warnings: auditRows(out) };
}

// 候选打分：标题命中产品词越多分越高；局部外观（主体/部分）降权提示
function rankCandidates(rows, keywords = []) {
  const kws = keywords.filter(Boolean);
  return rows.map(r => {
    let score = 0; const hits = [];
    for (const k of kws) if (r.ti.includes(k)) { score += 2; hits.push(k); }
    if (/主体|部分|局部|内部|外部/.test(r.ti)) score -= 1;
    if (/盒|充电/.test(r.ti) && kws.some(k => /盒/.test(k))) score += 1;
    return { ...r, score, hits };
  }).sort((a, b) => b.score - a.score || (b.apd > a.apd ? 1 : -1));
}

// 旧链路（保留兼容，勿用于新任务）
async function search(page, ctx, { query, designOnly = true, maxPages = 10 }) {
  await page.bringToFront();
  const input = page.locator('input[placeholder*="关键词"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.click();
  await input.fill(query);
  await sleep(400);

  const popupPromise = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
  await page.locator('div.btn', { hasText: '检索' }).first().click();
  await popupPromise;
  // 点检索可能先弹门户欢迎页，轮询等真正的结果页标签
  let list = null;
  for (let i = 0; i < 20; i++) {
    list = ctx.pages().find(p => p.url().includes('retrieveList'));
    if (list) break;
    await sleep(1000);
  }
  if (!list) throw new Error('检索未跳转到结果页');

  if (designOnly) await filterDesign(list);

  // 轮询等结果真正渲染（“N 条数据”出现且行内容就位）
  for (let i = 0; i < 20; i++) {
    const ready = await list.evaluate(() => /条数据/.test(document.body.innerText) && /CN\d{6,}[SU]/.test(document.body.innerText)).catch(() => false);
    if (ready) break;
    await sleep(1500);
  }

  const records = [];
  for (let p = 0; p < maxPages; p++) {
    const rows = await list.evaluate(() => {
      const txt = document.body.innerText;
      const hits = [...txt.matchAll(/^(CN\d{6,}[SU])\s*\n\s*(CN[\d.]+)\s*\n\s*([\d.]+)\s*\n\s*(.+?)\s*\n\s*(.+)$/gm)];
      return hits.map(m => ({
        publicNo: m[1], appNo: m[2], appDate: m[3], title: m[4].trim(), applicant: m[5].trim()
      }));
    });
    records.push(...rows);
    const advanced = await list.evaluate(() => {
      const ls = [...document.querySelectorAll('li')].filter(e => {
        const r = e.getBoundingClientRect();
        return r.top > window.innerHeight * 0.4 && e.className.includes('pagination') && e.textContent.trim() === '1';
      });
      return ls.length > 0;
    }).catch(() => false);
    const moved = await goNext(list, p + 1);
    if (!moved) break;
    await list.waitForTimeout(3500);
    if (!advanced) break;
  }
  return { records: dedupe(records), page: list };
}

async function filterDesign(list) {
  // 必须用真实鼠标事件（CDP 输入），合成 el.click() 会被前端忽略
  const els = list.locator(':text-is("外观设计")');
  const n = await els.count();
  for (let i = 0; i < n; i++) {
    const el = els.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width > 20 && box.width < 160 && box.height < 60) {
      await el.click().catch(() => {});
      await list.waitForTimeout(3500);
      return true;
    }
  }
  return false;
}

// 勾选结果行（跳过表头全选框），真实点击
async function selectRows(list, count = 1) {
  const boxes = list.locator('.el-checkbox');
  const n = await boxes.count();
  let done = 0;
  for (let i = 1; i <= Math.min(n - 1, count); i++) {
    await boxes.nth(i).click().catch(() => {});
    done++;
    await list.waitForTimeout(300);
  }
  return done;
}

// 旧翻页（已废弃）：Element UI 分页器是 .el-pager li.number，不是裸 li
async function goNext(list, pageNo) {
  const li = list.locator('.el-pager li.number').filter({ hasText: new RegExp('^\\s*' + pageNo + '\\s*$') }).first();
  if (await li.count().catch(() => 0)) { await li.click({ timeout: 8000 }).catch(() => {}); return true; }
  return false;
}

function dedupe(recs) {
  const seen = new Set(); const out = [];
  for (const r of recs) {
    const k = r.publicNo + '|' + r.appNo;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out;
}

// 打开某条专利详情（在结果列表里按公开号点击），返回详情页
async function openDetail(listPage, ctx, publicNo) {
  await listPage.bringToFront();
  await listPage.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  const before = new Set(ctx.pages().map(p => p.url()));
  // 公开号是叶子节点上的文本，用真实点击
  const els = listPage.locator(`:text-is("${publicNo}")`);
  const m = await els.count();
  let clicked = false;
  for (let i = 0; i < m; i++) {
    const el = els.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click().catch(() => {});
    clicked = true;
    break;
  }
  if (!clicked) throw new Error('结果页找不到 ' + publicNo + '，可能不在当前页');
  await listPage.waitForTimeout(6000);
  const fresh = ctx.pages().find(p => !before.has(p.url()) && p.url().includes('documents/detail'));
  return fresh || ctx.pages().find(p => p.url().includes('documents/detail')) || null;
}

// 从详情页抽取著录项目 + 视图图片（图片以 base64 落地，绕过外链鉴权）
async function extractDetail(detailPage, outDir) {
  await detailPage.bringToFront();
  await detailPage.waitForTimeout(2500);
  const meta = await detailPage.evaluate(() => {
    const txt = document.body.innerText;
    const grab = (label) => {
      const m = txt.match(new RegExp(label + '\\s*[:：]?\\s*\\n?\\s*([^\\n]{2,80})'));
      return m ? m[1].trim() : '';
    };
    return {
      text: txt.slice(0, 3000),
      appNo: grab('申请号'), publicNo: grab('公开号'), appDate: grab('申请日'),
      publicDate: grab('公开（公告）日'), applicant: grab('申请人'), title: grab('发明名称')
    };
  });

  // 切到主视图并抓取图片
  let images = [];
  const hasViewTab = await detailPage.locator(':text("主视图")').count().catch(() => 0);
  if (hasViewTab) {
    await detailPage.locator(':text("主视图")').first().click().catch(() => {});
    await detailPage.waitForTimeout(4000);
  }
  images = await detailPage.evaluate(async () => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 200);
    const out = [];
    for (const img of imgs.slice(0, 30)) {
      try {
        const src = img.currentSrc || img.src;
        if (!src || src.startsWith('data:')) { if (src) out.push({ src, data: src.split(',')[1] }); continue; }
        const r = await fetch(src, { credentials: 'include' });
        const b = await r.blob();
        const buf = await b.arrayBuffer();
        let bin = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        out.push({ src, b64: btoa(bin), type: b.type });
      } catch (e) { /* skip */ }
    }
    return out;
  });

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    let n = 0;
    for (const im of images) {
      const b64 = im.b64 || im.data;
      if (!b64) continue;
      const ext = (im.type || '').includes('png') ? 'png' : 'jpg';
      fs.writeFileSync(path.join(outDir, `view-${String(++n).padStart(2, '0')}.${ext}`), Buffer.from(b64, 'base64'));
    }
  }
  return { ...meta, imageCount: images.length };
}

module.exports = {
  BASE, PROFILE, PORT, SKILL_DIR, sleep,
  cdpAlive, launchChrome, connect, pickPage, isLoginUrl,
  ensureLoggedIn, search, filterDesign, selectRows, openDetail, extractDetail, readCreds,
  // 新链路
  checkSession, pickScope, seniorSearch, setPageSize, readPage, nextPage,
  harvestAll, auditRows, rankCandidates, goNext
};

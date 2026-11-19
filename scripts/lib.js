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

// 确保处于已登录的检索页；返回 { page, loggedIn, needLogin }
async function ensureLoggedIn(ctx, { allowAutoLogin = true } = {}) {
  let page = pickPage(ctx, { prefer: 'conventionalSearch' }) || await ctx.newPage();
  if (!page.url().includes('cponline')) {
    await page.goto(BASE + '/conventionalSearch', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  await page.waitForTimeout(2500);
  if (!isLoginUrl(page.url())) {
    const hasInput = await page.locator('input[placeholder*="关键词"]').count().catch(() => 0);
    if (hasInput) return { page, loggedIn: true };
  }
  // 需要登录
  const cred = allowAutoLogin ? readCreds() : null;
  if (!cred) return { page, loggedIn: false, needLogin: true };

  if (!isLoginUrl(page.url())) {
    await page.goto('https://tysf.cponline.cnipa.gov.cn/am/#/user/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  try {
    await page.locator('input[placeholder*="手机号"]').first().fill(cred.account, { timeout: 15000 });
    await page.locator('input[type="password"]').first().fill(cred.password, { timeout: 10000 });
    await sleep(400);
    await page.locator('button:has-text("登录"), .el-button:has-text("登录")').first().click();
    await page.waitForTimeout(7000);
    // 登录后回到检索页
    if (!page.url().includes('conventionalSearch')) {
      await page.goto(BASE + '/conventionalSearch', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const ok = await page.locator('input[placeholder*="关键词"]').count().catch(() => 0);
    return { page, loggedIn: !!ok, needLogin: !ok };
  } catch (e) {
    return { page, loggedIn: false, needLogin: true, error: e.message };
  }
}

// 执行检索。opts: { query, designOnly=true, maxPages=10 }
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

async function goNext(list, pageNo) {
  return await list.evaluate((n) => {
    const lis = [...document.querySelectorAll('li')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.top > window.innerHeight * 0.4 && e.textContent.trim() === String(n) && r.width < 80 && r.width > 0;
    });
    if (lis.length) { lis[0].click(); return true; }
    return false;
  }, pageNo);
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
  ensureLoggedIn, search, filterDesign, selectRows, openDetail, extractDetail, readCreds
};

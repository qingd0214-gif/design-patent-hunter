// capture_add.js — 走通「加入批量下载库」，抓入库 API + 查库状态
const lib = require('./lib.js');
const path = require('path');
const TMP = 'C:/Users/Administrator/WorkBuddy/2026-11-17-17-36-30/.workbuddy/tmp';

(async () => {
  const { ctx } = await lib.connect();
  const hits = [];
  const hook = p => p.on('request', r => {
    const u = r.url();
    if (/api\//i.test(u)) hits.push({ m: r.method(), u: u.slice(0, 200), d: (r.postData() || '').slice(0, 500) });
  });
  ctx.on('page', hook);
  for (const p of ctx.pages()) hook(p);

  const { page, loggedIn } = await lib.ensureLoggedIn(ctx);
  if (!loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // 查当前下载库状态
  const state = await page.evaluate(async () => {
    const token = (() => { for (const st of [localStorage, sessionStorage]) for (const k of Object.keys(st)) { const m = (st.getItem(k) || '').match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/); if (m) return m[0]; } return null; })();
    try {
      const r = await fetch('/api/pubsearch-app-tools/export/db/find', { headers: { authorization: 'Bearer ' + token } });
      return { s: r.status, t: (await r.text()).slice(0, 600) };
    } catch (e) { return { err: e.message }; }
  }).catch(e => ({ err: e.message }));
  console.log('LIB STATE:', JSON.stringify(state, null, 1));

  // 干净检索
  const res = await lib.search(page, ctx, { query: '鼠标 AND 小米', designOnly: true, maxPages: 1 });
  const list = res.page;
  const records = res.records;
  console.log('records:', records.map(r => r.publicNo).join(','));

  // 轮询复选框
  let boxCount = 0;
  for (let i = 0; i < 20; i++) {
    boxCount = await list.locator('.el-checkbox').count().catch(() => 0);
    if (boxCount > 1) break;
    await lib.sleep(1500);
  }
  console.log('checkboxes:', boxCount);
  if (boxCount < 2) process.exit(2);

  // 勾选前 2 条
  const boxes = list.locator('.el-checkbox');
  for (let i = 1; i <= 2; i++) { await boxes.nth(i).click().catch(() => {}); await lib.sleep(500); }
  await list.bringToFront();

  // 加入批量下载库（重试点击）
  let clicked = false;
  for (let a = 0; a < 3 && !clicked; a++) {
    try {
      await list.locator('div:visible', { hasText: /^加入批量下载库$/ }).first().click({ timeout: 8000 });
      clicked = true;
    } catch (e) { console.log('add attempt', a, e.message.slice(0, 60)); await lib.sleep(2000); }
  }
  console.log('add clicked:', clicked);
  await lib.sleep(4000);
  await list.screenshot({ path: path.join(TMP, 'cap_add.png') }).catch(() => {});
  console.log('HITS:', JSON.stringify(hits, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

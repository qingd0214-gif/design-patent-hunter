// probe_ui3.js — 完整走一遍 UI 下载流，抓所有 /api/ 请求
const lib = require('./lib.js');
const fs = require('fs');
const path = require('path');
const TMP = 'C:/Users/Administrator/WorkBuddy/2026-11-17-17-36-30/.workbuddy/tmp';

(async () => {
  const { ctx } = await lib.connect();
  const { page, loggedIn } = await lib.ensureLoggedIn(ctx);
  if (!loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  const res = await lib.search(page, ctx, { query: '鼠标 AND 小米', designOnly: true, maxPages: 1 });
  const list = res.page;
  const hits = [];
  list.on('request', r => {
    const u = r.url();
    if (/api\/|download|export/i.test(u)) hits.push({ m: r.method(), u: u.slice(0, 220), d: (r.postData() || '').slice(0, 800) });
  });
  await list.bringToFront();
  await lib.sleep(1500);

  // 勾选 2 条
  const boxes = list.locator('.el-checkbox');
  const n = Math.min((await boxes.count()) - 1, 2);
  for (let i = 1; i <= n; i++) { await boxes.nth(i).click().catch(() => {}); await lib.sleep(400); }
  console.log('checked', n);

  // 加入批量下载库
  const addBtn = list.locator('div:visible', { hasText: /^加入批量下载库$/ }).first();
  await addBtn.click().catch(e => console.log('add warn:', e.message.slice(0, 80)));
  await lib.sleep(3500);
  await list.screenshot({ path: path.join(TMP, 'ui3_after_add.png') }).catch(() => {});
  console.log('HITS after add:', JSON.stringify(hits.slice(-4), null, 1));

  // 弹窗里找「下载」按钮并点击
  const dlBtn = list.locator('button:visible', { hasText: /下载/ }).last();
  const cnt = await dlBtn.count().catch(() => 0);
  console.log('download-ish buttons:', cnt);
  if (cnt) {
    await dlBtn.click().catch(e => console.log('dl warn:', e.message.slice(0, 80)));
    await lib.sleep(6000);
    await list.screenshot({ path: path.join(TMP, 'ui3_after_dl.png') }).catch(() => {});
    console.log('HITS after dl:', JSON.stringify(hits.slice(-6), null, 1));
  }
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

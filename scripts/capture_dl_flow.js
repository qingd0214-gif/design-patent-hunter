// capture_dl_flow.js — 从结果页一路点到批量下载库的「下载」，抓全部 API 请求
const lib = require('./lib.js');
const path = require('path');
const TMP = 'C:/Users/Administrator/WorkBuddy/2026-11-17-17-36-30/.workbuddy/tmp';

(async () => {
  const { ctx } = await lib.connect();
  const hits = [];
  const hook = p => p.on('request', r => {
    const u = r.url();
    if (/api\/|download|export|batch/i.test(u)) hits.push({ m: r.method(), u: u.slice(0, 250), d: (r.postData() || '').slice(0, 900) });
  });
  ctx.on('page', hook);
  for (const p of ctx.pages()) hook(p);

  const { page, loggedIn } = await lib.ensureLoggedIn(ctx);
  if (!loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // 复用/新建结果页（刚跑过 full_flow，列表应该还在）
  let list = ctx.pages().find(p => p.url().includes('retrieveList'));
  if (!list) {
    const res = await lib.search(page, ctx, { query: '鼠标 AND 小米', designOnly: true, maxPages: 1 });
    list = res.page;
  }
  await list.bringToFront();
  await lib.sleep(1500);

  // 勾选
  const boxes = list.locator('.el-checkbox');
  const n = Math.min((await boxes.count()) - 1, 2);
  for (let i = 1; i <= n; i++) { await boxes.nth(i).click().catch(() => {}); await lib.sleep(400); }

  // 加入批量下载库 → 弹窗
  await list.locator('div:visible', { hasText: /^加入批量下载库$/ }).first().click().catch(e => console.log('add warn:', e.message.slice(0, 60)));
  await lib.sleep(3000);
  await list.screenshot({ path: path.join(TMP, 'cap_dialog.png') }).catch(() => {});
  console.log('HITS-1:', JSON.stringify(hits.slice(-3), null, 1));

  // 点「进入批量下载库」
  await list.locator('button:visible, a:visible, div:visible, span:visible', { hasText: /^进入批量下载库$/ }).last().click().catch(e => console.log('enter warn:', e.message.slice(0, 60)));
  await lib.sleep(6000);
  const lib2 = ctx.pages().find(p => /batch|download|space|library/i.test(p.url())) || ctx.pages().filter(p => p !== list).pop();
  console.log('lib page:', lib2 && lib2.url().slice(0, 110));
  if (lib2) {
    hook(lib2);
    await lib2.bringToFront();
    await lib2.screenshot({ path: path.join(TMP, 'cap_libpage.png') }).catch(() => {});
    // 枚举页面按钮文本
    const btns = await lib2.evaluate(() => {
      const out = [];
      document.querySelectorAll('button,div,a,span').forEach(e => {
        const t = (e.textContent || '').trim();
        const r = e.getBoundingClientRect();
        if (t && t.length <= 10 && r.width > 25 && r.width < 200 && r.height > 12 && r.height < 50) out.push({ t, tag: e.tagName, cls: (e.className || '').toString().slice(0, 40) });
      });
      return out.filter((v, i, a) => a.findIndex(x => x.t === v.t && x.cls === v.cls) === i).slice(0, 30);
    }).catch(e => []);
    console.log('BTNS:', JSON.stringify(btns, null, 1));
  }
  console.log('HITS-2:', JSON.stringify(hits.slice(-6), null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

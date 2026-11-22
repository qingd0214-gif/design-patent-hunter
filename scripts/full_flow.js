// full_flow.js — 干净单轮：清场 → 检索(轮询数据加载) → 勾选 → 加下载库 → 导出 → 解包
// 用法: node full_flow.js <query> <outDir> [maxSelect]
const lib = require('./lib.js');
const off = require('./official.js');
const { unzip } = require('./zip.js');
const fs = require('fs');
const path = require('path');
const TMP = 'C:/Users/Administrator/WorkBuddy/2026-11-17-17-36-30/.workbuddy/tmp';

(async () => {
  const [query, outDir, maxSel = '2'] = process.argv.slice(2);
  if (!query || !outDir) { console.error('用法: node full_flow.js <query> <outDir> [maxSelect]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  const { ctx } = await lib.connect();
  const { page, loggedIn } = await lib.ensureLoggedIn(ctx);
  if (!loggedIn) { console.log(JSON.stringify({ ok: false, code: 'NEED_LOGIN' })); process.exit(3); }

  // 清场：关掉旧的结果页/详情页标签
  for (const p of ctx.pages()) {
    if (/retrieveList|documents\/detail/.test(p.url())) await p.close().catch(() => {});
  }
  await lib.sleep(1500);

  const res = await lib.search(page, ctx, { query, designOnly: true, maxPages: 1 });
  const list = res.page;
  const records = res.records;
  console.log('records:', records.map(r => `${r.publicNo}(${r.appNo})`).join(', ') || 'NONE');
  if (!records.length) { console.log('NO_RESULTS'); process.exit(2); }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(records, null, 2));

  // 轮询等列表数据真正渲染（出现“条数据”且复选框就位）
  let boxCount = 0;
  for (let i = 0; i < 20; i++) {
    boxCount = await list.locator('.el-checkbox').count().catch(() => 0);
    const hasData = await list.evaluate(() => /条数据/.test(document.body.innerText)).catch(() => false);
    if (boxCount > 1 && hasData) break;
    await lib.sleep(1500);
  }
  console.log('checkboxes:', boxCount);
  if (boxCount < 2) {
    await list.screenshot({ path: path.join(TMP, 'ff_no_checkbox.png') });
    console.log('NO_CHECKBOX — 见截图');
    process.exit(2);
  }

  // 勾选前 N 条
  const boxes = list.locator('.el-checkbox');
  const n = Math.min(boxCount - 1, Number(maxSel), records.length);
  for (let i = 1; i <= n; i++) { await boxes.nth(i).click().catch(() => {}); await lib.sleep(500); }
  console.log('selected:', n);

  // 加入批量下载库
  const addBtn = list.locator('div:visible', { hasText: /^加入批量下载库$/ }).first();
  await addBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await addBtn.click().catch(e => console.log('add warn:', e.message.slice(0, 80)));
  await lib.sleep(3500);
  await list.screenshot({ path: path.join(TMP, 'ff_after_add.png') }).catch(() => {});

  // 调导出接口
  const appNos = records.slice(0, n).map(r => r.appNo);
  console.log('exporting:', appNos.join(','));
  const url = await off.requestExport(list, appNos);
  console.log('zip ok');
  const dl = await off.downloadZip(ctx, url, path.join(outDir, '_bundle.zip'));
  const files = unzip(dl.outZip, outDir);
  console.log(JSON.stringify({ ok: true, bytes: dl.bytes, files: files.map(x => x.name) }, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

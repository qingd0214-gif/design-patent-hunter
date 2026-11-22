// fetch_via_library.js — 走 UI 加下载库 → 导出接口 → zip → 解包（完整交付链）
// 用法: node fetch_via_library.js <query> <outDir> [maxSelect]
const lib = require('./lib.js');
const off = require('./official.js');
const { unzip } = require('./zip.js');
const fs = require('fs');
const path = require('path');

(async () => {
  const [query, outDir, maxSel = '2'] = process.argv.slice(2);
  if (!query || !outDir) { console.error('用法: node fetch_via_library.js <query> <outDir> [maxSelect]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  const { ctx } = await lib.connect();
  const { page, loggedIn } = await lib.ensureLoggedIn(ctx);
  if (!loggedIn) { console.log(JSON.stringify({ ok: false, code: 'NEED_LOGIN' })); process.exit(3); }

  const res = await lib.search(page, ctx, { query, designOnly: true, maxPages: 1 });
  const list = res.page;
  const records = res.records;
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(records, null, 2));
  console.log('records:', records.map(r => `${r.publicNo}(${r.appNo})`).join(', '));
  if (!records.length) { console.log('NO_RESULTS'); process.exit(2); }

  // 勾选前 N 条（真实点击）
  const boxes = list.locator('.el-checkbox');
  const n = Math.min(await boxes.count() - 1, Number(maxSel), records.length);
  for (let i = 1; i <= n; i++) {
    await boxes.nth(i).click().catch(e => console.log('checkbox warn:', e.message.slice(0, 80)));
    await lib.sleep(400);
  }
  console.log('selected:', n);
  await list.bringToFront();

  // 点「加入批量下载库」（真实点击）
  const addBtn = list.locator('div:visible', { hasText: /^加入批量下载库$/ }).first();
  await addBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await addBtn.click().catch(e => console.log('add warn:', e.message.slice(0, 80)));
  await lib.sleep(3500);
  await list.screenshot({ path: path.join(outDir, '_after_add.png') }).catch(() => {});

  // 关闭可能的弹窗（按 Esc 或点关闭）
  await list.keyboard.press('Escape').catch(() => {});
  await lib.sleep(1500);

  // 调导出接口（申请号从 records 取）
  const appNos = records.slice(0, n).map(r => r.appNo);
  console.log('exporting:', appNos.join(','));
  const url = await off.requestExport(list, appNos);
  console.log('zip url ok');
  const dl = await off.downloadZip(ctx, url, path.join(outDir, '_bundle.zip'));
  const files = unzip(dl.outZip, outDir);
  console.log(JSON.stringify({ ok: true, bytes: dl.bytes, files: files.map(f => f.name) }, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

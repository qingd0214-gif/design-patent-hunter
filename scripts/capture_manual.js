// capture_manual.js — 挂监听等用户手动操作：抓 API + 自动保存下载的 zip
// 用法: node capture_manual.js <secs> <saveDir>
const lib = require('./lib.js');
const fs = require('fs');
const path = require('path');

(async () => {
  const [secs = '600', saveDir = '.'] = process.argv.slice(2);
  fs.mkdirSync(saveDir, { recursive: true });
  const { ctx } = await lib.connect();
  const log = [];
  const hook = p => {
    p.on('request', r => {
      const u = r.url();
      if (/api\/|download|export|batch/i.test(u)) {
        const rec = { m: r.method(), u: u.slice(0, 260), d: (r.postData() || '').slice(0, 900), t: new Date().toISOString().slice(11, 19) };
        log.push(rec);
        console.log('REQ', JSON.stringify(rec));
      }
    });
    p.on('download', async d => {
      const f = path.join(saveDir, d.suggestedFilename() || ('dl_' + Date.now() + '.zip'));
      try { await d.saveAs(f); console.log('SAVED', f); log.push({ saved: f, url: d.url() }); }
      catch (e) { console.log('SAVE FAIL', e.message.slice(0, 80), d.url().slice(0, 120)); }
    });
  };
  ctx.on('page', hook);
  for (const p of ctx.pages()) hook(p);

  console.log('LISTENING', secs, 's — 请在浏览器里手动完成：勾选2行 → 加入批量下载库 → 进入批量下载库 → 下载');
  await lib.sleep(Number(secs) * 1000);
  fs.writeFileSync(path.join(saveDir, '_requests.json'), JSON.stringify(log, null, 1));
  console.log('DONE', log.length, 'requests');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

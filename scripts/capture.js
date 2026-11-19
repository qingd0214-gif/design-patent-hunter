// capture.js — 记录浏览器网络请求，用于抓取 CNIPA 批量下载的真实接口
// 用法: node capture.js [--secs 120] [--filter download,zip,batch,pdf]
// 运行后请在窗口里手动完成一次「加入批量下载库 → 下载」，脚本会把可疑请求打印出来。
const lib = require('./lib.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const secs = Number(arg('secs', 120));
const filters = arg('filter', 'download,zip,batch,pdf,export,outline').split(',');

(async () => {
  const { browser, ctx } = await lib.connect();
  const seen = new Set();

  const hook = (page) => {
    page.on('request', req => {
      const u = req.url();
      const low = u.toLowerCase();
      if (!filters.some(f => low.includes(f))) return;
      if (seen.has(u)) return;
      seen.add(u);
      console.log(JSON.stringify({
        method: req.method(), url: u,
        postData: (req.postData() || '').slice(0, 600),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => /cookie|referer|content-type|authorization|token/i.test(k)))
      }));
    });
    page.on('download', async d => {
      console.log(JSON.stringify({ download: d.suggestedFilename(), url: d.url() }));
    });
  };

  for (const p of ctx.pages()) hook(p);
  ctx.on('page', hook);

  console.log('CAPTURING for ' + secs + 's ...');
  await lib.sleep(secs * 1000);
  console.log('DONE, captured ' + seen.size + ' unique urls');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

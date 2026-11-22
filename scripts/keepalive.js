// keepalive.js — 启动 Chrome 并常驻保活（父进程存活期间浏览器不退出）
// 用法: node keepalive.js [起始URL]  （配合 run_in_background 使用）
const lib = require('./lib.js');

(async () => {
  const url = process.argv[2] || 'https://pss-system.cponline.cnipa.gov.cn/conventionalSearch';
  const r = await lib.launchChrome(url);
  console.log('chrome ready:', JSON.stringify(r));
  const { ctx } = await lib.connect();
  await lib.sleep(3000);
  let page = lib.pickPage(ctx) || ctx.pages()[0];
  if (page) {
    if (!page.url().includes('cnipa') || page.url() === 'about:blank') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await lib.sleep(2500);
    }
    await page.bringToFront().catch(() => {});
    console.log('page:', page.url().slice(0, 110));
  }
  console.log('=== keepalive: 浏览器就绪，本进程常驻直到浏览器被关闭 ===');
  let dead = 0;
  for (let i = 0; i < 86400; i++) {
    await lib.sleep(5000);
    if (await lib.cdpAlive()) dead = 0; else dead++;
    if (dead >= 3) { console.log('浏览器已关闭，保活退出'); process.exit(0); }
  }
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

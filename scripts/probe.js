// probe.js — 页面诊断：输出当前标签页 URL 与检索页关键元素是否在位
const lib = require('./lib.js');
(async () => {
  const { ctx } = await lib.connect();
  for (const p of ctx.pages()) console.log('PAGE:', p.url().slice(0, 120));
  const page = lib.pickPage(ctx, { prefer: 'conventionalSearch' });
  if (page) {
    const r = await page.evaluate(() => ({
      hasSearchInput: !!document.querySelector('input[placeholder*="关键词"]'),
      hasSearchBtn: [...document.querySelectorAll('div.btn')].some(e => e.textContent.trim() === '检索'),
      bodyChars: document.body.innerText.length
    })).catch(e => ({ err: e.message }));
    console.log('CHECK:', JSON.stringify(r));
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

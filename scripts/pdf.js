// pdf.js — 用本机 Chrome 无头模式把 HTML 渲染成 PDF（零额外依赖，走 CDP printToPDF）
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const CHROME = process.env.PATENT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function htmlToPdf(htmlPath, pdfPath, { landscape = false } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(600);
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      landscape,
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' }
    });
    return pdfPath;
  } finally {
    await browser.close();
  }
}

module.exports = { htmlToPdf };

if (require.main === module) {
  const [html, pdf] = process.argv.slice(2);
  if (!html || !pdf) { console.error('用法: node pdf.js <input.html> <output.pdf>'); process.exit(1); }
  htmlToPdf(html, pdf).then(p => console.log('PDF:', p)).catch(e => { console.error('ERR:', e.message); process.exit(1); });
}

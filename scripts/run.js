// run.js — 外观专利检索主流程
// 用法:
//   node run.js search  --query "遥控器 AND 苹果公司" [--max 20] [--pages 5] [--json out.json]
//   node run.js fetch   --ids CN307048716S,CN308401280S --out ./out/产品名 [--pdf]
//   node run.js all     --query "..." --ids CN307048716S --out ./out/产品名
// 说明：识别照片由上层 Agent 用视觉能力完成，本脚本只负责检索与文档落地。
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const { htmlToPdf } = require('./pdf.js');
const { buildDocHtml, buildIndexHtml } = require('./doc.js');
const official = require('./official.js');
const { unzip } = require('./zip.js');

const argv = process.argv.slice(2);
const cmd = argv[0];
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const flag = (name) => argv.includes('--' + name);

(async () => {
  if (!cmd || !['search', 'fetch', 'all'].includes(cmd)) {
    console.error('用法: node run.js search|fetch|all [--query ...] [--ids ...] [--out dir] [--pdf]');
    process.exit(1);
  }
  const outDir = path.resolve(arg('out', './patent_out'));
  const { browser, ctx } = await lib.connect();
  try {
    const { page, loggedIn, needLogin, error } = await lib.ensureLoggedIn(ctx);
    if (!loggedIn) {
      console.log(JSON.stringify({ ok: false, code: 'NEED_LOGIN', message: 'CNIPA 需要登录。请在此 Chrome 窗口完成登录后重试；或在 credentials.json 配置账号密码以自动登录。', error: error || null }));
      process.exit(3);
    }

    let records = [];
    if (cmd === 'search' || cmd === 'all') {
      const query = arg('query');
      if (!query) throw new Error('缺少 --query');
      const maxPages = Number(arg('pages', 10));
      const res = await lib.search(page, ctx, { query, designOnly: true, maxPages });
      records = res.records;
      const max = Number(arg('max', 0));
      if (max > 0) records = records.slice(0, max);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(records, null, 2));
      console.log(JSON.stringify({ ok: true, step: 'search', count: records.length, records }, null, 2));
      if (cmd === 'search') { process.exit(0); }
    }

    const ids = (arg('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (cmd === 'all' && !ids.length) { process.exit(0); }

    const items = [];
    fs.mkdirSync(outDir, { recursive: true });

    // ---- 主路径：官方导出接口（一次调用打包全部申请号，节省每日 5 次配额）----
    // ids 可传公开号或申请号；接口只认申请号，优先从检索结果映射
    const appNos = ids.map(id => {
      const rec = records.find(r => r.publicNo === id || r.appNo.replace(/[.]/g, '') === id.replace(/[.]/g, ''));
      return rec ? rec.appNo : (/^CN?\d{8,}[.]?\d?$/.test(id) ? id : null);
    }).filter(Boolean);

    let officialOk = false;
    if (appNos.length) {
      try {
        const url = await official.requestExport(page, appNos);
        console.log(JSON.stringify({ ok: true, step: 'export', zipUrl: url }));
        const zipPath = path.join(outDir, '_bundle.zip');
        const dl = await official.downloadZip(ctx, url, zipPath);
        const files = unzip(zipPath, outDir);
        officialOk = true;
        console.log(JSON.stringify({ ok: true, step: 'unzip', files: files.map(f => f.name) }));
      } catch (e) {
        console.log(JSON.stringify({ ok: false, step: 'official-export', error: e.message, hint: '官方接口失败（可能当日配额用完或任务冲突），回退到本地合成 PDF' }));
      }
    }

    for (const id of ids) {
      const target = records.find(r => r.publicNo === id);
      const appNo = (target && target.appNo) || id;
      const bare = appNo.replace(/^CN/i, '').replace(/[.\s]/g, '');
      const pdir = path.join(outDir, id);
      // 官方包内容：<申请号>/<申请号>_FullTextImage.pdf + images/Abstract.png
      const officialPdf = path.join(outDir, bare, `${bare}_FullTextImage.pdf`);
      const abstractImg = path.join(outDir, bare, 'images', 'Abstract.png');
      let pdfRel = null, thumb = null;
      if (officialOk && fs.existsSync(officialPdf)) {
        pdfRel = path.join(bare, path.basename(officialPdf));
        if (fs.existsSync(abstractImg)) thumb = path.join(bare, 'images', 'Abstract.png');
        items.push({ publicNo: id, title: target ? target.title : '', applicant: target ? target.applicant : '', appDate: target ? target.appDate : '', pdf: pdfRel, thumb, source: 'official' });
        console.log(JSON.stringify({ ok: true, id, source: 'official', pdf: pdfRel }));
        continue;
      }
      // ---- 兜底：合成 PDF ----
      try {
        const listPage = records.length ? lib.pickPage(ctx, { prefer: 'retrieveList' }) : null;
        if (!listPage) throw new Error('没有结果页上下文');
        const detail = await lib.openDetail(listPage, ctx, id);
        if (!detail) throw new Error('详情页未打开');
        const meta = await lib.extractDetail(detail, pdir);
        const views = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(f => /^view-\d+\.(png|jpg)$/.test(f)).sort() : [];
        const merged = { ...(target || {}), ...meta, title: meta.title || (target && target.title) || '', applicant: meta.applicant || (target && target.applicant) || '' };
        delete merged.text;
        const htmlPath = path.join(pdir, 'doc.html');
        fs.writeFileSync(htmlPath, buildDocHtml(merged, views), 'utf8');
        const pdfPath = path.join(pdir, `${id}.pdf`);
        await htmlToPdf(htmlPath, pdfPath);
        items.push({ publicNo: id, title: merged.title, applicant: merged.applicant, appDate: merged.appDate, pdf: path.join(id, path.basename(pdfPath)), thumb: views.length ? path.join(id, views[0]) : null, source: 'synthesized' });
        fs.writeFileSync(path.join(pdir, 'meta.json'), JSON.stringify({ ...merged, views }, null, 2));
        console.log(JSON.stringify({ ok: true, id, source: 'synthesized' }));
        await detail.close().catch(() => {});
        await lib.sleep(2500);
      } catch (e) {
        items.push({ publicNo: id, title: (target && target.title) || '', error: e.message });
        console.log(JSON.stringify({ ok: false, id, error: e.message }));
      }
    }

    fs.writeFileSync(path.join(outDir, 'index.html'), buildIndexHtml(items, path.basename(outDir)), 'utf8');
    console.log(JSON.stringify({ ok: true, step: 'fetch', outDir, items }, null, 2));
  } finally {
    process.exit(0);
  }
})().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });

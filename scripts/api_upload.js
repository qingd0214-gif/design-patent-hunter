// api_upload.js — 通过 GitHub Contents API 上传仓库文件（git push 不可用时走 API）
// 带重试：422（sha 过期/缺失）时刷新 sha 重传，网络抖动时退避重试
// 用法: node api_upload.js <repo> <branch> <commitMessage>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GH = process.env.GH_PATH || 'C:/Program Files/GitHub CLI/gh.exe';
const [repo, branch, msg] = process.argv.slice(2);
if (!repo || !branch || !msg) { console.error('用法: node api_upload.js owner/repo branch "message"'); process.exit(1); }

const TMP = path.join(require('os').tmpdir(), 'gh_body.json');
const encPath = p => p.split('/').map(s => encodeURIComponent(s)).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function gh(args, opt = {}) {
  return execFileSync(GH, ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opt });
}
function getSha(ep) {
  try { const s = gh([ep, '--jq', '.sha']).trim(); return s || undefined; } catch { return undefined; }
}

async function upload(f) {
  const ep = `repos/${repo}/contents/${encPath(f)}`;
  const content = fs.readFileSync(f).toString('base64');
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const body = { message: `${msg}: ${f}`, branch, content };
      const sha = getSha(ep);
      if (sha) body.sha = sha;
      fs.writeFileSync(TMP, JSON.stringify(body));
      gh([ep, '-X', 'PUT', '--input', TMP, '--jq', '.commit.sha'], { stdio: ['ignore', 'pipe', 'pipe'] });
      return 'OK';
    } catch (e) {
      const s = String(e.stderr || e.message || '');
      if (s.includes('422') && attempt < 4) continue; // sha 过期 → 刷新重试
      if (attempt < 4) { await sleep(3000 * attempt); continue; } // 网络 → 退避重试
      return 'FAIL: ' + s.slice(0, 180);
    }
  }
}

(async () => {
  const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  let ok = 0;
  const fails = [];
  for (const f of files) {
    const r = await upload(f);
    if (r === 'OK') { ok++; console.log('OK', f); }
    else { fails.push(f); console.log('FAIL', f, r); }
    await sleep(400); // 温和节流
  }
  try { fs.unlinkSync(TMP); } catch { }
  console.log(JSON.stringify({ ok, fail: fails.length, total: files.length }));
})();

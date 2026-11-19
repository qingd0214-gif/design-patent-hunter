// zip.js — 极简 ZIP 解包（仅依赖 Node 内置 zlib），避免系统 unzip 对中文文件名编码的破坏
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decodeName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  // 未置 UTF-8 标志：CNIPA 的包多为 GBK
  try { return new TextDecoder('gbk').decode(buf); }
  catch { return buf.toString('latin1'); }
}

function unzip(zipPath, outDir) {
  const data = fs.readFileSync(zipPath);
  // 定位 EOCD
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 66000); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效 ZIP：找不到 EOCD');
  const total = data.readUInt16LE(eocd + 10);
  let off = data.readUInt32LE(eocd + 16);

  const files = [];
  for (let n = 0; n < total; n++) {
    if (data.readUInt32LE(off) !== 0x02014b50) break;
    const flags = data.readUInt16LE(off + 8);
    const method = data.readUInt16LE(off + 10);
    const compSize = data.readUInt32LE(off + 20);
    const nameLen = data.readUInt16LE(off + 28);
    const extraLen = data.readUInt16LE(off + 30);
    const commentLen = data.readUInt16LE(off + 32);
    const localOff = data.readUInt32LE(off + 42);
    const name = decodeName(data.subarray(off + 46, off + 46 + nameLen), !!(flags & 0x800));

    // 本地头：取数据起点
    const lNameLen = data.readUInt16LE(localOff + 26);
    const lExtraLen = data.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = data.subarray(dataStart, dataStart + compSize);

    if (!name.endsWith('/')) {
      let buf;
      if (method === 0) buf = Buffer.from(raw);
      else if (method === 8) buf = zlib.inflateRawSync(raw);
      else throw new Error('不支持的压缩方式 ' + method + '（' + name + '）');
      const dest = path.join(outDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      files.push({ name, size: buf.length });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

module.exports = { unzip };

if (require.main === module) {
  const [zipPath, outDir] = process.argv.slice(2);
  if (!zipPath || !outDir) { console.error('用法: node zip.js <a.zip> <outdir>'); process.exit(1); }
  const files = unzip(zipPath, outDir);
  console.log(JSON.stringify({ count: files.length, files }, null, 2));
}

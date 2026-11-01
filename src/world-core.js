'use strict';
/* 世界（存档）下载的核心：目录名清洗、zip 内层前缀识别、重名避让、流式解压。
 *
 * 为什么单独成文件：
 *   1) 判定逻辑（名字 / 前缀 / 重名）是纯函数，qa/world-unit.js 用纯 node 就能覆盖；
 *   2) 解压必须**流式** —— 世界存档动辄几百 MB，zipio / zip-write 那两套是
 *      「整包 readFileSync + inflateRawSync」，峰值内存要到 2~3 倍。这里只把中央目录
 *      读进内存，数据段一律 fs 流 → zlib 流 → 落盘，边解边写。
 *   主进程 main.js 只负责「搜 / 下 / 装到哪」，文件系统细节都在这里。 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

/* 存档目录名清洗：
 *   - Windows 不允许 \ / : * ? " < > | 与控制字符 → 换成空格
 *   - Windows 不认结尾的点和空格（"我的世界." 会被静默截断）→ 一律去掉
 *   - 限长 60（存档目录名太长会让路径超限，尤其是带版本隔离的实例）
 *   - 清完为空（比如名字全是符号）→ 兜底 World */
function sanitizeName(s) {
  let v = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (v.length > 60) v = v.slice(0, 60).replace(/[. ]+$/, '');
  return v || 'World';
}

/* 从 zip 条目名里认出「存档根目录」，返回要剥掉的前缀（含结尾斜杠）：
 *   ['level.dat', 'region/r.0.0.mca']            → ''             （文件直接躺在包根）
 *   ['MyWorld/level.dat', 'MyWorld/region/…']    → 'MyWorld/'     （常见形态）
 *   ['pack/MyWorld/level.dat', …]                → 'pack/MyWorld/'（外面多套了一层）
 *   取「最浅的那个 level.dat」：深层的多半是备份 / 附带世界。
 *   没有 level.dat → 返回 null（不是存档，交给调用方报错）。 */
function detectPrefix(names) {
  const list = Array.isArray(names) ? names : [];
  let best = null;
  for (const raw of list) {
    const n = String(raw || '').replace(/\\/g, '/');
    if (!n || n.endsWith('/')) continue;
    if (!n.toLowerCase().endsWith('level.dat')) continue;
    const dir = n.slice(0, n.length - 'level.dat'.length);
    if (best === null || dir.split('/').length < best.split('/').length) best = dir;
  }
  return best;
}

/* 重名避让：saves 下已有同名目录时依次试「名字 (2)」「名字 (3)」…
 *   exists 传函数（主进程传 fs.existsSync），这里不碰文件系统，便于单测。
 *   上限 99：再往上基本是有人堆了一堆同名垃圾，继续加序号没有意义。 */
function uniqueName(name, exists) {
  const base = String(name || 'World');
  if (!exists || !exists(base)) return base;
  for (let i = 2; i < 100; i++) {
    const cand = base + ' (' + i + ')';
    if (!exists(cand)) return cand;
  }
  return base + ' (' + Date.now() + ')';
}

/* 该文件能不能解：CF 上偶尔混着 .rar / .7z，提前说清楚比下载完再报错好 */
function isZipLike(filename) {
  return /\.(zip|jar)$/i.test(String(filename || ''));
}

/* ---- 读中央目录（只读目录区，数据段不碰） ---- */
async function listEntries(zipPath) {
  const st = await fsp.stat(zipPath);
  if (!st.size) throw new Error('下载到的文件是空的');
  const tailLen = Math.min(st.size, 66000);        /* EOCD 最多往回找 65557 字节 */
  const fh = await fsp.open(zipPath, 'r');
  try {
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, st.size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (!cdSize || cdOff + cdSize > st.size) throw new Error('ZIP 中央目录损坏');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const out = [];
    let pos = 0;
    for (let n = 0; n < count; n++) {
      if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) break;
      const method = cd.readUInt16LE(pos + 10);
      let csize = cd.readUInt32LE(pos + 20);
      let usize = cd.readUInt32LE(pos + 24);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const cmtLen = cd.readUInt16LE(pos + 32);
      let lho = cd.readUInt32LE(pos + 42);
      const name = cd.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
      const extra = cd.slice(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
      pos += 46 + nameLen + extraLen + cmtLen;
      /* ZIP64：字段为 0xFFFFFFFF 时真实值在 extra 的 0x0001 里，
         顺序固定为 原始大小 → 压缩后大小 → 本地头偏移（缺席的字段不占位） */
      if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
        for (let e = 0; e + 4 <= extra.length;) {
          const id = extra.readUInt16LE(e), sz = extra.readUInt16LE(e + 2);
          if (id === 1) {
            const end = e + 4 + sz;
            let p2 = e + 4;
            if (usize === 0xFFFFFFFF && p2 + 8 <= end) { usize = Number(extra.readBigUInt64LE(p2)); p2 += 8; }
            if (csize === 0xFFFFFFFF && p2 + 8 <= end) { csize = Number(extra.readBigUInt64LE(p2)); p2 += 8; }
            if (lho === 0xFFFFFFFF && p2 + 8 <= end) { lho = Number(extra.readBigUInt64LE(p2)); }
            break;
          }
          if (sz < 0) break;
          e += 4 + sz;
        }
      }
      if (name.endsWith('/')) continue;            /* 目录条目：解压时按文件路径自动建 */
      out.push({ name, method, csize, usize, lho });
    }
    return out;
  } finally { await fh.close(); }
}

async function listNames(zipPath) {
  return (await listEntries(zipPath)).map(e => e.name);
}

/* 流式解压：prefix 为空表示解全部条目；否则只解该前缀下的，并剥掉前缀。
   zip-slip：规范化后必须仍落在 destDir 内，越界条目直接跳过。
   不支持的压缩方法（bzip2 / 加密）跳过，不影响其它文件。 */
async function extractZipStream(zipPath, destDir, prefix) {
  const entries = await listEntries(zipPath);
  const rootAbs = path.resolve(destDir);
  const fh = await fsp.open(zipPath, 'r');
  let n = 0;
  try {
    for (const it of entries) {
      if (prefix && !it.name.startsWith(prefix)) continue;
      const rel = prefix ? it.name.slice(prefix.length) : it.name;
      if (!rel) continue;
      const dest = path.resolve(rootAbs, rel.replace(/\\/g, '/').split('/').join(path.sep));
      if (dest === rootAbs || !dest.startsWith(rootAbs + path.sep)) continue;
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, it.lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;   /* 本地头签名不对，跳过 */
      const dataStart = it.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (!it.csize) { await fsp.writeFile(dest, Buffer.alloc(0)); n++; continue; }
      if (it.method !== 0 && it.method !== 8) continue;
      const src = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + it.csize - 1 });
      const out = fs.createWriteStream(dest);
      if (it.method === 0) await pipeline(src, out);
      else await pipeline(src, zlib.createInflateRaw(), out);
      n++;
    }
  } finally { await fh.close(); }
  return n;
}

module.exports = { sanitizeName, detectPrefix, uniqueName, isZipLike, listNames, extractZipStream };

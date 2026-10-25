'use strict';
/* LMC - ZIP 读写工具（导出/导入整合包用）
 * 写入：deflate + UTF-8 文件名；读取：支持 method 0/8
 * 依赖：zlib / path（无 Electron 依赖，可独立测试） */
const zlib = require('zlib');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/* files: [{name, data:Buffer|string}] → ZIP Buffer */
function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}
/* 按 filter 读取 zip 内条目到内存 → [{name, data}] */
function findZipEntries(zipBuf, filterFn) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 ZIP 文件');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let pos = zipBuf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const cSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const cmtLen = zipBuf.readUInt16LE(pos + 32);
    const lho = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + cmtLen;
    if (name.endsWith('/') || (filterFn && !filterFn(name))) continue;
    const lNameLen = zipBuf.readUInt16LE(lho + 26);
    const lExtraLen = zipBuf.readUInt16LE(lho + 28);
    const ds = lho + 30 + lNameLen + lExtraLen;
    const data = zipBuf.slice(ds, ds + cSize);
    out.push({ name, data: method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data) });
  }
  return out;
}
function zipReadEntry(zipBuf, name) {
  const hit = findZipEntries(zipBuf, n => n === name);
  if (!hit.length) throw new Error('包内缺少 ' + name);
  return hit[0].data;
}
/* 只列条目名，不解压任何数据（资源包 / 光影包判断「有没有 shaders/ 目录、pack.mcmeta」用）。
   走中央目录，和 findZipEntries 同一套解析；目录条目（以 / 结尾）也一并返回。 */
function listZipNames(zipBuf) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 ZIP 文件');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let pos = zipBuf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const cmtLen = zipBuf.readUInt16LE(pos + 32);
    out.push(zipBuf.slice(pos + 46, pos + 46 + nameLen).toString('utf8'));
    pos += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
/* 解压 zip 内 prefix/ 前缀内容到 outDir（剥前缀），返回解压数。
   注意：条目名来自 zip，必须做 zip-slip 校验（规范化后仍须落在 outDir 内）。
   当前主进程未调用此函数，保留作导出/导入整合包的工具，勿删。 */
function extractZipPrefix(zipBuf, outDir, prefix) {
  const items = findZipEntries(zipBuf, n => n.startsWith(prefix) && !n.endsWith('/'));
  const fs = require('fs');
  const rootAbs = path.resolve(outDir);
  let n = 0;
  for (const it of items) {
    const rel = it.name.slice(prefix.length).replace(/\//g, path.sep);
    const dest = path.resolve(rootAbs, rel);
    if (dest !== rootAbs && !dest.startsWith(rootAbs + path.sep)) continue; /* zip-slip：跳过越界条目 */
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, it.data);
    n++;
  }
  return n;
}
module.exports = { crc32, buildZip, findZipEntries, zipReadEntry, extractZipPrefix, listZipNames };

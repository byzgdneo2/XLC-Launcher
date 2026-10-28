'use strict';
/* 目录 ⇄ ZIP 文件（逐文件读写，峰值内存 = 最大单文件）
 *
 * 为什么不用 zipio.buildZip：那个是「整个 zip 攒在内存里再写出去」。存档动辄几十上百 MB，
 * 一次备份就要几十 MB 堆 + 一份压缩结果；自动备份（启动前 / 退出后）连做几个存档，
 * 主进程内存直接顶上去，还会卡 UI 线程。这里写一个最小的流式 ZIP writer：
 *   本地头（flag bit3：crc 与压缩后大小用 data descriptor 补）
 *   → 压缩数据 → data descriptor → 全部写完后补中央目录 + EOCD。
 *
 * 解压同理：只读中央目录，逐条 inflateRawSync 落盘，绝不把整个包读进内存。
 * 不依赖任何 npm 包，格式就是 PKZIP 2.0 —— Windows 资源管理器 / 7-Zip / 游戏都能读。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('../zipio');

/* 递归列出目录里的文件（返回相对路径，统一用 / 分隔） */
function walkFiles(dir, out, base, skip) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of names) {
    const abs = path.join(dir, ent.name);
    const rel = base ? base + '/' + ent.name : ent.name;
    if (skip && skip(rel, ent)) continue;
    if (ent.isDirectory()) walkFiles(abs, out, rel, skip);
    else if (ent.isFile()) out.push({ abs, rel });
  }
  return out;
}

/* session.lock 是游戏运行时持有的锁文件（内容是进程信息），备份进去没意义 */
const SKIP_NAMES = new Set(['session.lock']);
const defaultSkip = (rel, ent) => SKIP_NAMES.has(ent.name);

/**
 * 把目录打包成 zip 文件。
 * @param {string} dir 源目录
 * @param {string} outFile 目标 zip（父目录不存在会自动建）
 * @param {{skip?:Function, level?:number, onProgress?:Function}} [opt]
 * @returns {{ok:true, files:number, bytes:number, path:string}}
 */
function zipDirToFile(dir, outFile, opt) {
  const o = opt || {};
  const skip = o.skip || defaultSkip;
  const level = o.level === undefined ? 6 : o.level;
  const files = walkFiles(dir, [], '', skip);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'w');
  let offset = 0;
  const central = [];
  try {
    files.forEach((f, i) => {
      const raw = fs.readFileSync(f.abs);          /* 单文件读入：region 文件也就几 MB */
      const comp = zlib.deflateRawSync(raw, { level });
      const crc = crc32(raw);
      const nameBuf = Buffer.from(f.rel, 'utf8');

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);                     /* version needed */
      lh.writeUInt16LE(0x0808, 6);                 /* UTF-8 名 + data descriptor */
      lh.writeUInt16LE(8, 8);                      /* deflate */
      lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
      lh.writeUInt32LE(0, 14);                     /* crc 待定 */
      lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);

      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(comp.length, 8);
      dd.writeUInt32LE(raw.length, 12);

      fs.writeSync(fd, lh); fs.writeSync(fd, nameBuf); fs.writeSync(fd, comp); fs.writeSync(fd, dd);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(8, 10);
      ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(comp.length, 20);
      ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE(0, 38);
      ch.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([ch, nameBuf]));

      offset += 30 + nameBuf.length + comp.length + 16;
      if (o.onProgress) { try { o.onProgress(i + 1, files.length, f.rel); } catch (_) {} }
    });

    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, cd); fs.writeSync(fd, eocd);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
  const bytes = fs.statSync(outFile).size;
  return { ok: true, files: files.length, bytes, path: outFile };
}

/* 读中央目录：拿到每个条目的名字 / 方式 / 大小 / 本地头偏移 */
function readCentral(zipBuf) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let pos = zipBuf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const csize = zipBuf.readUInt32LE(pos + 20);
    const usize = zipBuf.readUInt32LE(pos + 24);
    const nlen = zipBuf.readUInt16LE(pos + 28);
    const elen = zipBuf.readUInt16LE(pos + 30);
    const clen = zipBuf.readUInt16LE(pos + 32);
    const lho = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.slice(pos + 46, pos + 46 + nlen).toString('utf8');
    out.push({ name, method, csize, usize, lho });
    pos += 46 + nlen + elen + clen;
  }
  return out;
}

/**
 * 把 zip 解压到目标目录（覆盖同名文件，保留目录里原有的其他文件）。
 * @param {string} zipFile
 * @param {string} destDir
 * @param {{skip?:Function}} [opt] skip(name) 返回 true 的条目跳过
 * @returns {{ok:true, files:number}}
 */
function extractZipTo(zipFile, destDir, opt) {
  const o = opt || {};
  const buf = fs.readFileSync(zipFile);
  const items = readCentral(buf);
  let n = 0;
  for (const it of items) {
    if (o.skip && o.skip(it.name)) continue;
    /* 防目录穿越：条目名里不许出现 ../ 或绝对路径 */
    const rel = it.name.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) continue;
    const lnlen = buf.readUInt16LE(it.lho + 26);
    const lelen = buf.readUInt16LE(it.lho + 28);
    const start = it.lho + 30 + lnlen + lelen;
    const chunk = buf.slice(start, start + it.csize);
    const raw = it.method === 0 ? chunk : zlib.inflateRawSync(chunk);
    const dest = path.join(destDir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, raw);
    n++;
  }
  return { ok: true, files: n };
}

module.exports = { zipDirToFile, extractZipTo, walkFiles, readCentral };

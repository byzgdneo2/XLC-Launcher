'use strict';
/* MOD 更新的纯逻辑（主进程 main.js 引用；qa/modupd-unit.js 单测）
 *
 * muMurmur2 —— CurseForge 指纹用的 MurmurHash2（按 CF 的口径跳过 9/10/13/32 四个空白字节）。
 *   行为与 PCL 的 LocalResourceFile.CurseForgeHash 一致（PCL 是《分发有限许可》+ VB.NET，这里独立实现）。
 *   输入 Buffer，返回无符号 32 位整数。
 *
 * muPickLatest —— 从一个 Modrinth 版本数组里挑「这个 MC 版本 + 加载器」能用的最新版：
 *   先按 MC 版本 + 加载器过滤（过滤空了就退回只按 MC 版本），再按发布时间取最新。
 *   都筛不出 → null（表示这个源上没有适配当前实例的版本，不算更新）。 */

function muMurmur2(buf) {
  const data = [];
  for (const b of buf) { if (b !== 9 && b !== 10 && b !== 13 && b !== 32) data.push(b); }
  const len = data.length;
  const m = 0x5bd1e995;
  let h = (1 ^ len) >>> 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    k ^= (k >>> 24);
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
  }
  const rest = len - i;
  if (rest === 3) { h = (h ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16))) >>> 0; h = Math.imul(h, m) >>> 0; }
  else if (rest === 2) { h = (h ^ (data[i] | (data[i + 1] << 8))) >>> 0; h = Math.imul(h, m) >>> 0; }
  else if (rest === 1) { h = (h ^ data[i]) >>> 0; h = Math.imul(h, m) >>> 0; }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

function muPickLatest(versions, mcVer, loaderMr) {
  const byMc = (v) => !mcVer || (Array.isArray(v.game_versions) && v.game_versions.includes(mcVer));
  const byLoader = (v) => !loaderMr || (Array.isArray(v.loaders) && v.loaders.some(l => String(l).toLowerCase() === loaderMr));
  /* 加载器筛空时的退回口径：只按 MC 版本，但**排除明确不兼容的加载器** ——
     quilt 能跑 fabric 的 mod（反向也是）、neoforge 与 forge 同源；除此之外声明了别的加载器就不算适配 */
  const COMPAT = { fabric: ['fabric', 'quilt'], quilt: ['fabric', 'quilt'], forge: ['forge', 'neoforge'], neoforge: ['forge', 'neoforge'] };
  const notExplicitlyIncompatible = (v) => {
    if (!loaderMr) return true;
    const lds = Array.isArray(v.loaders) ? v.loaders : [];
    if (!lds.length) return true;
    const allow = COMPAT[loaderMr] || null;
    return !allow || lds.some(l => allow.includes(String(l).toLowerCase()));
  };
  let pool = (versions || []).filter(v => byMc(v) && byLoader(v));
  if (!pool.length) pool = (versions || []).filter(v => byMc(v) && notExplicitlyIncompatible(v));
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => String(b.date_published || '').localeCompare(String(a.date_published || '')))[0];
}

module.exports = { muMurmur2, muPickLatest };

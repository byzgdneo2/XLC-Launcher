'use strict';
/* 模组清单对齐的纯逻辑（无文件系统、无网络，可单测）
 *
 * 清单文本（人类可读、可以直接粘在聊天框里，也可以走好友通道）：
 *   XLC-MODS/1
 *   <sha1 前 12 位> <字节数> <文件名>
 * 用 sha1 前 12 位而不是整段：同一份 40 位哈希在聊天框里又长又容易被折行截断，
 * 12 位够区分（4.3e18 分之一撞车）；真要完整哈希时这里也能读 40 位的。
 */

const PREFIX = 'XLC-MODS/1';
const MAX_MODS = 600;               /* 单次最多列这么多，防止有人拿巨型清单刷屏 */

function isModFile(name) {
  return /\.(jar|zip|litemod)$/i.test(String(name || ''));
}

/** 把 mods 目录扫出来的文件列表规整成清单项（过滤非模组、按名字排序、限长）
 *  返回数组（兼容原有调用）；需要知道有没有被截断时用 normalizeModsInfo() */
function normalizeModsInfo(list) {
  const out = [];
  for (const m of (list || [])) {
    const name = String((m && m.name) || '').trim();
    if (!name || !isModFile(name)) continue;
    const sha = String((m && m.sha1) || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    out.push({
      name,
      size: Number((m && m.size) || 0) || 0,
      sha1: sha
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const total = out.length;
  return { mods: out.slice(0, MAX_MODS), total, truncated: total > MAX_MODS };
}
function normalizeMods(list) { return normalizeModsInfo(list).mods; }

/** 生成清单文本 */
function buildManifest(mods) {
  const info = normalizeModsInfo(mods);
  const lines = [PREFIX];
  for (const m of info.mods) lines.push((m.sha1 ? m.sha1.slice(0, 12) : '-'.repeat(12)) + ' ' + m.size + ' ' + m.name);
  /* 截断要在清单里留痕：否则两边都少了同一批时会显示「完全一致」，
     而用户以为 600 个之外的那些也对比过了（审计 F8）。# 开头是注释，老版本解析器会跳过。 */
  if (info.truncated) {
    lines.push('# 清单已截断：目录里共 ' + info.total + ' 个模组，这里只列出前 ' + MAX_MODS + ' 个（按文件名排序）');
  }
  return lines.join('\n');
}

/**
 * 解析清单文本（宽松：允许没有头、允许只有文件名、允许 40 位 sha1、忽略空行与 # 注释）
 * @returns {{ok:boolean, mods:Array, error?:string}}
 */
function parseManifest(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return { ok: false, mods: [], error: '清单是空的' };
  const mods = [];
  let total = 0;        /* 有效模组行总数（可能被 MAX_MODS 截断） */
  let declared = 0;     /* 清单里「已截断：共 N 个」声明的原始总数 */
  let sawTruncNote = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      /* 新版清单在截断时带一行注释：`# 清单已截断：目录里共 610 个模组，这里只列出前 600 个` */
      if (/清单已截断/.test(line)) {
        sawTruncNote = true;
        const m2 = line.match(/共\s*(\d+)\s*个模组/);
        if (m2) declared = Number(m2[1]) || 0;
      }
      continue;
    }
    if (/^XLC-MODS\/\d+$/i.test(line)) continue;
    /* 两种行：`sha1 size name` 或裸文件名 */
    const m = /^([0-9a-fA-F]{6,40}|-+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) {
      total++;
      if (mods.length < MAX_MODS) mods.push({ sha1: /^[0-9a-fA-F]/.test(m[1]) ? m[1].toLowerCase() : '', size: Number(m[2]) || 0, name: m[3].trim() });
    } else if (isModFile(line)) {
      total++;
      if (mods.length < MAX_MODS) mods.push({ sha1: '', size: 0, name: line });
    }
  }
  if (!mods.length) return { ok: false, mods: [], total: 0, truncated: false, error: '没在清单里找到 .jar / .zip 模组文件' };
  if (declared > total) total = declared;
  return { ok: true, mods, total, truncated: sawTruncNote || total > mods.length };
}

/**
 * 算差异。口径以「文件名」为准（CF / Modrinth 同一版本的文件名是稳定的），
 * 同名但哈希不同 = 版本或来源不同，单独列出来。
 * @param {string} mineText 我的清单
 * @param {string} theirsText 对方清单
 * @returns {{ok:boolean, error?:string, missing:Array, extra:Array, differ:Array, same:number,
 *            mineCount:number, theirsCount:number}}
 */
function diffManifests(mineText, theirsText) {
  const a = parseManifest(mineText);
  const b = parseManifest(theirsText);
  if (!a.ok) return { ok: false, error: '你的清单读不出来：' + a.error, missing: [], extra: [], differ: [], same: 0, mineCount: 0, theirsCount: 0 };
  if (!b.ok) return { ok: false, error: '对方清单读不出来：' + b.error, missing: [], extra: [], differ: [], same: 0, mineCount: 0, theirsCount: 0 };

  const key = (n) => String(n || '').trim().toLowerCase();
  const mineMap = new Map(a.mods.map(m => [key(m.name), m]));
  const theirMap = new Map(b.mods.map(m => [key(m.name), m]));

  const missing = [];   /* 对方有、我没有 */
  const extra = [];     /* 我有、对方没有 */
  const differ = [];    /* 同名但哈希不同 */
  let same = 0;

  for (const [k, t] of theirMap) {
    const m = mineMap.get(k);
    if (!m) { missing.push(t); continue; }
    /* 两边都有哈希才比；只有名字的清单只能判「有 / 没有」 */
    if (m.sha1 && t.sha1 && m.sha1.slice(0, 12) !== t.sha1.slice(0, 12)) differ.push({ name: t.name, mine: m, theirs: t });
    else same++;
  }
  for (const [k, m] of mineMap) if (!theirMap.has(k)) extra.push(m);

  const byName = (x, y) => x.name.localeCompare(y.name, 'en');
  missing.sort(byName); extra.sort(byName); differ.sort((x, y) => x.name.localeCompare(y.name, 'en'));
  return {
    ok: true, missing, extra, differ, same,
    mineCount: a.mods.length, theirsCount: b.mods.length,
    /* 任一边被截断时「完全一致」并不可靠：600 个之外的差异看不到（审计 F8） */
    mineTotal: a.total, theirsTotal: b.total,
    mineTruncated: !!a.truncated, theirsTruncated: !!b.truncated,
    truncated: !!(a.truncated || b.truncated)
  };
}

/** 一行结论（界面标题 / 提示用） */
function diffSummary(d) {
  if (!d || !d.ok) return (d && d.error) || '无法比较';
  const parts = [];
  if (d.missing.length) parts.push('少 ' + d.missing.length + ' 个');
  if (d.extra.length) parts.push('多 ' + d.extra.length + ' 个');
  if (d.differ.length) parts.push('版本不同 ' + d.differ.length + ' 个');
  const base = parts.length ? parts.join(' · ') : '完全一致（' + d.same + ' 个模组）';
  return d.truncated ? base + '（清单已截断到 ' + MAX_MODS + ' 条，之外的未比对）' : base;
}

module.exports = {
  PREFIX, MAX_MODS, isModFile, normalizeMods, normalizeModsInfo, buildManifest,
  parseManifest, diffManifests, diffSummary
};

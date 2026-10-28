'use strict';
/* 存档备份的纯逻辑（无文件系统、无网络，可单测）
 *
 * 备份文件长这样：
 *   <备份根>/<存档名>/<存档名>__20261027-183000.zip
 * 旁边的 <同名>.json sidecar 记 { save, instance, at, files, bytes } —— 恢复时要靠它知道
 * 这个备份属于哪个实例（同名存档可能同时存在于全局 saves 和某个隔离实例里）。
 */

const pad2 = (n) => String(n).padStart(2, '0');
/** 时间戳 → 20261027-183000 */
function stamp(ts) {
  const d = new Date(ts || Date.now());
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
/** 20261027-183000 → 毫秒时间戳（解析失败返回 0） */
function parseStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(s || ''));
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
/** 文件名里不能出现的字符换掉；存档名可能带空格 / 括号 / 中文，都保留 */
function safeName(s) {
  const t = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return t || 'save';
}
function backupFileName(saveName, ts) { return safeName(saveName) + '__' + stamp(ts) + '.zip'; }
/** 从备份文件名解析 { save, at }；不是备份文件返回 null */
function parseBackupName(file) {
  const m = /^(.+)__(\d{8}-\d{6})\.zip$/.exec(String(file || ''));
  if (!m) return null;
  return { save: m[1], at: parseStamp(m[2]) };
}

/**
 * 这次需不需要自动备份？
 * 判据只有一条：存档目录比上次备份「更新」。所以「开着游戏没退出」不会反复备份，
 * 而「进游戏玩了一会儿」一定会在下次启动前被备上。
 * @param {{lastAt:number, saveMtime:number, gapMs?:number}} p
 *   lastAt: 上次备份时间（0 = 从没备过）；saveMtime: 存档目录里文件的最新 mtime
 *   gapMs: 容忍窗口（默认 2 分钟，避免时区 / 秒级抖动导致每次都备）
 */
function shouldBackup(p) {
  const o = p || {};
  const lastAt = Number(o.lastAt) || 0;
  const mtime = Number(o.saveMtime) || 0;
  if (mtime <= 0) return false;
  if (lastAt <= 0) return true;
  const gap = o.gapMs === undefined ? 2 * 60 * 1000 : o.gapMs;
  return mtime - lastAt > gap;
}

/**
 * 保留策略：按时间倒序留着最新的 keep 份，返回该删的列表。
 * keep <= 0 视为「全部保留」（返回空数组）。
 * @param {Array<{at:number}>} items
 * @param {number} keep
 */
function planPrune(items, keep) {
  const k = Number(keep);
  if (!k || k <= 0) return [];
  const sorted = (items || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  return sorted.slice(k);
}

function humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 自动备份设置规整（缺字段 / 脏值都落回默认；目录为空 = XLC数据/存档备份） */
function normalizeBackupCfg(cfg) {
  const c = cfg || {};
  const rawKeep = parseInt(c.keep, 10);
  /* 0 是合法值（= 全部保留），所以不能用 `|| 10` 兜底 */
  const keep = Number.isFinite(rawKeep) ? Math.max(0, Math.min(200, rawKeep)) : 10;
  return {
    auto: c.auto === true,                                   /* 默认关：不替用户偷偷占盘 */
    onLaunch: c.onLaunch !== false,                          /* 启动前备一次 */
    onExit: c.onExit !== false,                              /* 游戏退出后备一次 */
    dir: String(c.dir || ''),                                /* 空 = 数据目录/存档备份 */
    keep
  };
}

module.exports = {
  stamp, parseStamp, safeName, backupFileName, parseBackupName,
  shouldBackup, planPrune, humanBytes, normalizeBackupCfg
};

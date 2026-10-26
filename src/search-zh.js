'use strict';
/* 中文搜索词处理（纯函数：无网络、无依赖、可单测）
 *
 * 背景（真实现象）：搜索框输入「钅」后，列表看起来「根本没搜索」——
 *   · Modrinth 对单字中文查询返回 0 条；
 *   · CurseForge 会把不认识的 CJK 串**当空条件**，返回全站下载量最高的前 100 名
 *     （实测 searchFilter=钅 → totalCount=10000，前几条正是 JEI / Mouse Tweaks / AppleSkin）；
 *   · 「综合」源把两边合并后，屏幕上就只剩一堆不相干的热门 MOD。
 *
 * 所以中文查询必须先在本地词库里解析出英文关键词（main.js 的 zhKeywordsFor），
 * 词库没收录时再走一次在线翻译（钠 → Sodium、小地图 → mini map）。
 * 但翻译对生僻字 / 单个部首会返回垃圾（实测「钅」→「ư」），直接拿去搜等于没搜，
 * 因此这里负责把译文清洗成「能真正用于检索的英文关键词」，判不出就返回 null。
 */

/* 基本汉字 + 扩展 A + 兼容汉字 + 扩展 B 及以后（代理对，须带 u 标志） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{3ffff}]/u;
function hasCJK(s) { return CJK_RE.test(String(s == null ? '' : s)); }

/* 译文里的虚词与通用词：留在查询里只会把相关性冲淡（Modrinth 是整句 relevance 排序） */
const STOP = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'at', 'with', 'by', 'from',
  'is', 'are', 'be', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
  'mod', 'mods', 'minecraft', 'mc', 'plugin', 'plugins'
]);

/**
 * 在线译文 → 检索关键词数组（最多 3 个），判不出有效词时返回 null。
 * @param {string} zh 原始中文查询
 * @param {string} en 翻译接口返回的英文
 * @returns {string[]|null}
 */
function enKeywordsFromTranslation(zh, en) {
  const src = String(zh == null ? '' : zh).trim();
  const dst = String(en == null ? '' : en).trim();
  if (!src || !dst) return null;
  if (dst === src) return null;                 /* 原样返回 = 没翻出来 */
  if (hasCJK(dst)) return null;                 /* 译文里还夹着中文 = 没翻干净 */

  const words = dst.toLowerCase()
    /* 去掉标点与非 ASCII（「ư」这种垃圾就死在这）；撇号当分隔符，连字符留在词内
       （sodium's → sodium，extra-sodium 不拆） */
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^-+|-+$/g, ''))
    .filter(w => w.length >= 2 && !STOP.has(w));
  if (!words.length) return null;               /* 只剩单字母 / 符号 → 无检索价值 */

  return [...new Set(words)].slice(0, 3);
}

module.exports = { hasCJK, enKeywordsFromTranslation, STOP_WORDS: STOP };

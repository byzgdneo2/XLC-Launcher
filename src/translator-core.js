'use strict';
/* ================================================================
 * 模组翻译器 · 纯逻辑层（不 require electron、不发网络请求）
 * ================================================================
 * 主进程那边只负责「读 jar / 联网翻译 / 落盘」，凡是能单独跑、能写单元测试的
 * 判断都放在这里（qa/translator-unit.js 直接 require 本文件，不启动 Electron）：
 *   · 哪些字符串值得翻（跳过已中文、纯符号、纯数字、只有格式码）
 *   · 占位符保护：%s / %1$d / {0} / §a / \n —— 翻译前换成 __XLC0__，翻完换回来
 *   · en_us + 原有 zh_cn + 新译文 → 最终语言表（原有汉化优先，不覆盖别人的成果）
 *   · 资源包 pack.mcmeta（按模组声明的 MC 版本推 pack_format）
 *   · 老版 .lang 文件（1.12 及以前）的读写
 * 注意：这里所有函数都必须是纯函数（同样的输入永远得到同样的输出），别引入全局状态。
 */
const crypto = require('crypto');

/* ---------------- 文本判定 ---------------- */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/* 纯符号 / 纯数字 / 纯空白：翻了也没意义，还可能把排版弄坏 */
const MEANINGLESS_RE = /^[\s\p{P}\p{S}\d]+$/u;
/* 只有 § 格式码（如 "§7"、"§l§c"）：整串没有可读文本 */
const ONLY_FMT_RE = /^(?:§[0-9a-fk-or])+$/i;

function hasCJK(s) { return CJK_RE.test(String(s || '')); }

/* 这条英文值值不值得送去翻译 */
function isTranslatable(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 2) return false;
  if (CJK_RE.test(t)) return false;          /* 已经是中文（或中英混排）就不动 */
  if (MEANINGLESS_RE.test(t)) return false;
  if (ONLY_FMT_RE.test(t)) return false;
  /* 把占位符摘掉之后还要剩下至少两个字母 —— 「%s」「%1$d」「§7」这种整条都是格式的，翻了没意义 */
  const bare = protectPlaceholders(t).text.replace(/_{1,4}\s*XLC\s*\d+\s*_{1,4}/gi, '');
  return /[A-Za-z]{2,}/.test(bare);
}

/* ---------------- 占位符保护 ----------------
 * 顺序很重要：先 %1$s 这种带位次的，再 {0}，最后 § 格式码。
 * 换成 __XLC<n>__ 是因为实测翻译服务会原样保留它（下划线 + 大写字母不会被翻）。 */
const PH_PATTERNS = [
  /%(?:\d+\$)?[-#+ 0,(]*\d*(?:\.\d+)?[a-zA-Z%]/g,  /* %s %1$d %2$.2f %% */
  /\{[0-9]+\}/g,                                    /* {0} {1} */
  /§[0-9a-fk-or]/gi                                /* §7 §l */
];
function protectPlaceholders(s) {
  const str = String(s == null ? '' : s);
  const tokens = [];
  let out = str;
  for (const re of PH_PATTERNS) {
    out = out.replace(re, (m) => {
      tokens.push(m);
      return '__XLC' + (tokens.length - 1) + '__';
    });
  }
  return { text: out, tokens };
}
/* 翻完把占位符换回来；少了一个就返回 null（这条译文作废，宁可不写也别写坏格式） */
function restorePlaceholders(s, tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  let bad = false;
  let hit = 0;
  /* 前后下划线允许 0 个：两个占位符挨在一起时（"__XLC2____XLC3__"）后一个会被前一个
     的下划线吃掉一部分，这里必须能从 "XLC3__" 接着认出来。 */
  const out = String(s == null ? '' : s).replace(/_{0,4}\s*XLC\s*(\d+)\s*_{0,4}/gi, (m, n) => {
    const i = Number(n);
    if (!(i >= 0 && i < list.length)) { bad = true; return m; }
    hit++;
    return list[i];
  });
  if (bad) return null;
  /* 占位符少了一个（模型把它吞了 / 拆开了）也算失败：宁可这条不写，也别把格式弄坏 */
  if (list.length && hit < list.length) return null;
  if (/XLC\s*\d+/i.test(out)) return null;
  return out;
}

/* ---------------- 纯文本 / 语言表 ---------------- */
function hashText(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

/* 收集 en_us 里所有值得翻译的叶子字符串（去重，保持出现顺序） */
function collectStrings(enObj) {
  const seen = new Set();
  const out = [];
  (function walk(node) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (isTranslatable(node) && !seen.has(node)) { seen.add(node); out.push(node); }
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') { for (const k of Object.keys(node)) walk(node[k]); }
  })(enObj);
  return out;
}

/* 合并：原有 zh_cn 优先 → 这次新翻的 → 剩下的不写（游戏会自动回落到 en_us） */
function mergeLang(enObj, zhObj, map) {
  const tr = map && typeof map.get === 'function' ? map : new Map(Object.entries(map || {}));
  const zh = zhObj && typeof zhObj === 'object' ? zhObj : {};
  function walk(en, old) {
    if (typeof en === 'string') {
      if (typeof old === 'string' && old.trim()) return old;      /* 已有汉化不动 */
      const hit = tr.get(en);
      return (typeof hit === 'string' && hit.trim()) ? hit : undefined;
    }
    if (Array.isArray(en)) {
      const arr = en.map((x, i) => walk(x, Array.isArray(old) ? old[i] : undefined));
      return arr.some(x => x !== undefined) ? arr : undefined;
    }
    if (en && typeof en === 'object') {
      const out = {};
      let any = false;
      for (const k of Object.keys(en)) {
        const v = walk(en[k], old && typeof old === 'object' ? old[k] : undefined);
        if (v !== undefined) { out[k] = v; any = true; }
      }
      return any ? out : undefined;
    }
    return undefined;
  }
  const res = walk(enObj, zh);
  return (res && typeof res === 'object') ? res : {};
}

/* ---------------- 老版 .lang（1.12 及以前：key=value 一行一条） ---------------- */
function parseLangFile(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i <= 0) return;
    const k = t.slice(0, i).trim();
    if (!k) return;
    out[k] = t.slice(i + 1).trim();
  });
  return out;
}
function buildLangFile(obj) {
  const lines = ['# 由 XLC 模组翻译器生成'];
  for (const k of Object.keys(obj || {})) {
    if (typeof obj[k] !== 'string') continue;
    lines.push(k + '=' + obj[k]);
  }
  return lines.join('\n') + '\n';
}

/* ---------------- 资源包 ---------------- */
/* MC 版本 → 资源包 pack_format。只列常用档位；认不出来就用 15（1.20.x），
   再靠 supported_formats 把范围放宽，新版本不会因为版本号不对直接判「不兼容」。 */
const PACK_FORMAT_TABLE = [
  [/^1\.21\.[6-9]/, 63], [/^1\.21\.[5]/, 55], [/^1\.21\.4/, 46],
  [/^1\.21\.[23]/, 42], [/^1\.21(?:\.[01])?$/, 34],
  [/^1\.20\.[56]/, 32], [/^1\.20\.[34]/, 22], [/^1\.20\.2/, 18], [/^1\.20(?:\.[01])?$/, 15],
  [/^1\.19\.4/, 13], [/^1\.19\.3/, 12], [/^1\.19(?:\.[0-2])?$/, 9],
  [/^1\.18/, 8], [/^1\.17/, 7], [/^1\.16\.[2-9]/, 6], [/^1\.1[56]/, 5],
  [/^1\.1[34]/, 4], [/^1\.(?:[6-9]|1[0-2])/, 3]
];
function packFormatOf(mcVer) {
  const v = String(mcVer || '').match(/\d+\.\d+(?:\.\d+)?/);
  const s = v ? v[0] : '';
  if (!s) return 15;
  if (/^26\.|^2[7-9]\./.test(s)) return 63;     /* 新版本号体系：按最新格式走 */
  for (const [re, n] of PACK_FORMAT_TABLE) if (re.test(s)) return n;
  return 15;
}
function packMeta(mcVer, desc) {
  const fmt = packFormatOf(mcVer);
  return {
    pack: {
      pack_format: fmt,
      supported_formats: { min_inclusive: fmt, max_inclusive: 99 },
      description: String(desc || 'XLC 模组翻译器')
    }
  };
}

/* 输出文件名：只留字母数字中文和 - _ . ，其余换成 -（避免路径穿越 / 非法字符） */
function safeFileName(s, fallback) {
  const t = String(s || '').trim().replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/\s+/g, '-');
  const cut = t.slice(0, 60).replace(/^[.-]+|[.-]+$/g, '');
  return cut || String(fallback || 'mod');
}

module.exports = {
  hasCJK, isTranslatable, protectPlaceholders, restorePlaceholders,
  hashText, collectStrings, mergeLang, parseLangFile, buildLangFile,
  packFormatOf, packMeta, safeFileName
};

'use strict';
/* Modrinth 的项目描述（body）是 Markdown 源码。以前直接塞进 .md-html 容器，于是
 * ![img1](https://cdn.modrinth.com/...) / **粗体** / "- 列表" 全都被当纯文本原样显示出来
 * （用户在 MOD 详情里看到满屏 ![](url) 就是这个原因）。
 *
 * 这里做一份「够用」的轻量 Markdown → HTML：代码块 / 标题 / 列表 / 引用 / 分割线 / 表格 /
 * 图片 / 链接 / 粗体 / 斜体 / 删除线 / 行内代码。不追求 CommonMark 全量规范。
 *
 * 注意：项目描述里本来就允许合法 HTML（<br> / <img> / <details> / <div align>），
 * 所以**不做整体转义**、保持直通；危险标签、on* 事件属性、javascript: 链接由调用方
 * （main.js 的 sanitizeHtml）继续清掉。纯函数、无依赖，便于单测。
 */

function attrEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 只放行 http(s) 与站内相对路径；javascript: / data: 一律不生成标签（原文保留，由上层清洗） */
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/[^/\s]/.test(s)) return s;
  return '';
}

/* 行内语法：图片 → 链接 → 粗体 / 斜体 / 删除线，行内代码先摘出来避免里面的符号被误判 */
function mdInline(s) {
  let t = String(s == null ? '' : s);
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push('<code>' + c + '</code>');
    return '\u0001C' + (codes.length - 1) + '\u0001';
  });
  /* 图片 ![alt](url)：alt 可空；URL 到空白或右括号为止。
     Modrinth 的图片几乎都是 https://cdn.modrinth.com/... ，转成真图就能看了 */
  t = t.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g, (m, alt, url) => {
    const u = safeUrl(url);
    return u ? '<img src="' + u + '" alt="' + attrEsc(alt) + '" loading="lazy">' : m;
  });
  /* 原文常把图片写成 "!![img](url)"（多敲一个感叹号），别在图片前留个孤零零的 "!" */
  t = t.replace(/!<img /g, '<img ');
  /* 链接 [文字](url)。文字为空（截图里那种 "[]"）时直接把 URL 显示出来，不留空链接 */
  t = t.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g, (m, txt, url) => {
    const u = safeUrl(url);
    if (!u) return m;
    return '<a href="' + u + '" target="_blank" rel="noreferrer">' +
      (String(txt).trim() || attrEsc(u)) + '</a>';
  });
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0001C(\d+)\u0001/g, (_m, i) => codes[+i]);
  return t;
}

const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
const isTableSep = (s) => /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/.test(s);

function mdToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0, list = '', para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => { if (list) { out.push('</' + list + '>'); list = ''; } };

  while (i < lines.length) {
    const line = lines[i];
    const trim = line.trim();
    /* 围栏代码块：内容原样保留（不再走行内语法） */
    if (/^```[\w+-]*\s*$/.test(trim)) {
      flushPara(); flushList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;   /* 跳过结束围栏 */
      out.push('<pre><code>' + buf.join('\n') + '</code></pre>');
      continue;
    }
    if (!trim) { flushPara(); flushList(); i++; continue; }
    const h = trim.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      flushPara(); flushList();
      const lv = Math.min(4, h[1].length);   /* 弹窗里 h5/h6 太小，统一压到 h4 */
      out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>');
      i++; continue;
    }
    if (/^([-*_])\s*\1\s*\1[\s-*_]*$/.test(trim)) { flushPara(); flushList(); out.push('<hr>'); i++; continue; }
    /* 表格：| a | b | + |---|---| */
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table class="md-table"><thead><tr>' +
        head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }
    const q = trim.match(/^>\s?(.*)$/);
    if (q) { flushPara(); flushList(); out.push('<blockquote>' + mdInline(q[1]) + '</blockquote>'); i++; continue; }
    /* 描述里本来就有的块级 HTML（<div align> / <details> / <table> / 单独一行的 <img>）
       原样直通 —— 包进 <p> 会被浏览器隐式截断，结构就乱了 */
    if (/^<\/?(div|table|thead|tbody|tfoot|tr|td|th|details|summary|ul|ol|li|h[1-6]|p|center|section|article|figure|figcaption|img|hr|br|iframe|video|audio|blockquote|font|span)\b/i.test(trim)) {
      flushPara(); flushList();
      out.push(trim);
      i++; continue;
    }
    const ul = trim.match(/^[-*+]\s+(.*)$/);
    const ol = trim.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { flushList(); out.push('<' + kind + '>'); list = kind; }
      out.push('<li>' + mdInline((ul || ol)[1]) + '</li>');
      i++; continue;
    }
    flushList();
    para.push(trim);
    i++;
  }
  flushPara(); flushList();
  return out.join('\n');
}

module.exports = { mdToHtml, mdInline, safeUrl, attrEsc };

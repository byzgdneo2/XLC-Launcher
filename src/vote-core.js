'use strict';
/* 「新功能投票」页的纯逻辑（主进程 main.js 引用；qa/vote-unit.js 单测）
 *
 * 数据来自 GitHub Discussions（仓库 byzgdneo2/XLC-Launcher）。功能投票用讨论区的
 * 投票（Poll）发布：启动器侧只负责把讨论列表取回来展示，真正投一票仍然要登录
 * GitHub 网页 —— 所以界面上每一条都可以点开，落到对应讨论页。
 *
 * 排序规则：
 *   1. 「投票进行中」的讨论（分类 slug 含 poll）排最前面 —— 用户进来就是为了投票；
 *   2. 其余按创建时间倒序，新的在前。
 * 匿名拉不到讨论里的 Poll 票数（那要 GraphQL 鉴权），所以列表只展示分类、评论数
 * 和时间，不谎报票数。 */

/* 判定是不是投票贴：投票讨论建议用带 Poll 的分类（slug 含 poll，如 polls / 功能投票-poll） */
function isPollDiscussion(d) {
  const slug = String(d && d.category && d.category.slug || '').toLowerCase();
  return /poll/.test(slug);
}

/* 抽成界面能直接用的字段（体积小、不含 GitHub 的原始大对象） */
function voteItem(d) {
  const cat = (d && d.category) || {};
  return {
    n: Number(d && d.number) || 0,
    title: String((d && d.title) || '(无标题)'),
    url: String((d && d.html_url) || ''),
    catName: String(cat.name || ''),
    catEmoji: String(cat.emoji || ''),
    catSlug: String(cat.slug || ''),
    isPoll: isPollDiscussion(d),
    comments: Number(d && d.comments) || 0,
    createdAt: Date.parse((d && d.created_at) || '') || 0,
    author: String((d && d.user && d.user.login) || '')
  };
}

/* 整批排序：过滤脏数据 → 投票贴在前 → 各自按创建时间倒序 */
function voteSummarize(list) {
  const items = (Array.isArray(list) ? list : [])
    .filter(x => x && Number(x.number) > 0)
    .map(voteItem);
  const polls = items.filter(x => x.isPoll).sort((a, b) => b.createdAt - a.createdAt);
  const rest = items.filter(x => !x.isPoll).sort((a, b) => b.createdAt - a.createdAt);
  return { items: polls.concat(rest), polls: polls.length, total: items.length };
}

module.exports = { isPollDiscussion, voteItem, voteSummarize };

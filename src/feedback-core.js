'use strict';
/* 反馈页的纯逻辑（主进程 main.js 引用；qa/feedback-unit.js 单测）
 *
 * 数据来自 GitHub Issues（仓库 byzgdneo2/XLC-Launcher），按「处理状态」分成六档，
 * 对应界面上六个可折叠分组：正在处理 / 等待处理 / 等待 / 已完成 / 已忽略 / 重复。
 *
 * 分档规则（照 PCL CE 反馈页的口径）：
 *   重复     —— 带 duplicate 标签（不管开还是关）
 *   已忽略   —— 带 wontfix / invalid 标签，或关闭时标记为 not_planned
 *   已完成   —— 已关闭且是正常完成
 *   正在处理 —— 开着且已指派负责人，或带 processing / in progress 标签
 *   等待处理 —— 开着且已经有分类标签（已受理、排队中）
 *   等待     —— 开着且没有任何标签（还没人看过）
 * 没有 number 的条目、以及 Pull Request 都不算反馈（GitHub 的 issues 接口会混进 PR）。 */

const FEEDBACK_KEYS = ['processing', 'pending', 'waiting', 'done', 'ignored', 'duplicate'];

const FB_PROCESSING = ['processing', 'in progress', 'doing', '正在处理', '处理中'];
const FB_IGNORED = ['wontfix', 'invalid', 'ignored', '已忽略', '不处理', '不予处理'];

/* 标签名统一成小写字符串（GitHub 的 labels 可能是对象数组，也可能是字符串数组） */
function fbLabelNames(iss) {
  const raw = (iss && Array.isArray(iss.labels)) ? iss.labels : [];
  return raw
    .map(l => String((l && typeof l === 'object') ? (l.name || '') : (l || '')).trim().toLowerCase())
    .filter(Boolean);
}

/* 归到六档里的哪一档 */
function feedbackBucket(iss) {
  const labels = fbLabelNames(iss);
  const closed = String((iss && iss.state) || '') === 'closed';
  if (labels.includes('duplicate') || labels.includes('重复')) return 'duplicate';
  if (labels.some(n => FB_IGNORED.includes(n))) return 'ignored';
  if (closed) return String((iss && iss.state_reason) || '') === 'not_planned' ? 'ignored' : 'done';
  const assigned = !!(iss && Array.isArray(iss.assignees) && iss.assignees.length);
  if (assigned || labels.some(n => FB_PROCESSING.includes(n))) return 'processing';
  if (labels.length) return 'pending';
  return 'waiting';
}

/* 抽成界面能直接用的字段（体积小、不含 GitHub 的原始大对象） */
function feedbackItem(iss) {
  const labels = fbLabelNames(iss).slice(0, 3);
  return {
    n: Number(iss && iss.number) || 0,
    title: String((iss && iss.title) || '(无标题)'),
    url: String((iss && iss.html_url) || ''),
    user: String((iss && iss.user && iss.user.login) || ''),
    state: String((iss && iss.state) || ''),
    comments: Number((iss && iss.comments)) || 0,
    updatedAt: Date.parse((iss && iss.updated_at) || '') || 0,
    labels
  };
}

/* 整批分组：过滤 PR / 脏数据 → 逐条分档 → 每档按更新时间倒序 */
function feedbackSummarize(list) {
  const groups = {};
  FEEDBACK_KEYS.forEach(k => { groups[k] = []; });
  const items = (Array.isArray(list) ? list : [])
    .filter(x => x && Number(x.number) > 0 && !x.pull_request);
  items.forEach(iss => {
    const k = feedbackBucket(iss);
    (groups[k] || groups.waiting).push(feedbackItem(iss));
  });
  FEEDBACK_KEYS.forEach(k => {
    groups[k].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  });
  return { groups, total: items.length };
}

module.exports = { FEEDBACK_KEYS, fbLabelNames, feedbackBucket, feedbackItem, feedbackSummarize };

/* 综合源（Modrinth + CurseForge）跨源去重。
 *
 * 为什么需要：同一个 MOD 常常两边都有（Sodium、JEI、AppleSkin…）。合并结果时原来只按
 * 「来源 + 项目 id」去重 —— 那只能挡住同源重复，跨源的两条会并排出现在列表里，
 * 用户会以为装了两份，或者挑了其中一条装完发现是同一个东西。
 *
 * 判据（宁可少合并，不肯错合并）：
 *   1. 归一化 slug 相同（两源都用项目短名，如 sodium / jei），最可靠；
 *   2. slug 缺失或不同时，用归一化标题兜底（"Iris Shaders" vs "iris-shaders" 这种能对上）。
 * 只在**跨源**之间判重：同一个源里的同名项目（不同作者）照常都显示，不替用户做判断。
 *
 * 保留哪一条：**按下载量降序排完后，先出现的那条**（也就是原本排在更前面的那条）。
 * 早先的版本固定留 Modrinth —— 结果是列表被整体换掉：CurseForge 的下载量普遍比
 * Modrinth 高，重复项目的 CF 条目往往排在很前面，删掉它之后该项目的位置整体后移，
 * 后面的 Modrinth 长尾条目全被顶上来（实测搜「api」前 20 条换了 17 条，用户看到的就是
 * 「整个列表都变了」）。改成留靠前那条之后，列表只是少了几行重复，位置不动
 * （同条件前 20 条只变 2~5 条，且变的全是被合并的重复项）。下载量相同时按 Modrinth 优先
 * （它的直链更稳、项目信息更全），靠稳定排序天然满足：合并时 Modrinth 先入数组。
 */
function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dedupeAcrossSources(mrHits, cfHits) {
  const mr = Array.isArray(mrHits) ? mrHits : [];
  const cf = Array.isArray(cfHits) ? cfHits : [];
  /* 先合并排序：判重顺序 = 用户看到的顺序，留下的那条自然就是位置靠前的那条 */
  const merged = mr.concat(cf)
    .filter(h => h && typeof h === 'object')
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

  const keysOf = { modrinth: new Set(), curseforge: new Set() };   /* 各源已占用的 slug / 标题 */
  const seenId = new Set();                                        /* 同源同 id 去重（原有行为） */
  const pool = [];
  let dropped = 0;

  for (const h of merged) {
    const src = h.src === 'curseforge' ? 'curseforge' : 'modrinth';
    const other = src === 'curseforge' ? 'modrinth' : 'curseforge';
    const idk = src + ':' + String(h.id == null ? '' : h.id);
    if (seenId.has(idk)) { dropped++; continue; }
    const keys = [normKey(h.slug), normKey(h.title)].filter(Boolean);
    /* 只拿对侧的键判重：同源同名（不同作者的两个项目）继续都显示 */
    if (keys.some(k => keysOf[other].has(k))) { dropped++; continue; }
    keys.forEach(k => keysOf[src].add(k));
    seenId.add(idk);
    pool.push(h);
  }

  return { pool, dropped };
}

module.exports = { dedupeAcrossSources, normKey };

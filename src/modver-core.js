/* 模组版本列表的加载器归一化与筛选（纯函数，单测在 qa/modver-unit.js）
 *
 * 两个源给的字段形状完全不同：
 *   Modrinth    version.loaders = ['fabric'] / ['forge'] / ['neoforge'] / ['quilt']（小写）
 *   CurseForge  file.gameVersions = ['Client','NeoForge','Server','26.3']（加载器名字混在版本号里）
 * 这里统一成显示名（Fabric / NeoForge / Forge / Quilt …），供版本选择页的筛选按钮使用。
 * 只按加载器分类，**不按游戏版本**筛选。 */

/* 识别表：key 是去空格去横线后的小写写法 */
const LOADER_MAP = {
  fabric: 'Fabric',
  fabricloader: 'Fabric',
  legacyfabric: 'Legacy Fabric',
  forge: 'Forge',
  minecraftforge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  quiltloader: 'Quilt',
  liteloader: 'LiteLoader',
  rift: 'Rift'
};
/* 按钮顺序：常用加载器在前，其余按出现顺序排后面 */
const LOADER_ORDER = ['Fabric', 'NeoForge', 'Forge', 'Quilt', 'Legacy Fabric', 'LiteLoader', 'Rift'];

function normLoader(raw) {
  if (!raw) return '';
  const key = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
  return LOADER_MAP[key] || '';
}
/* 单个版本带的加载器（去重，保持识别表顺序） */
function loadersOf(v) {
  const set = new Set();
  for (const x of (v && (v.loaders || v.gameVersions || v.game_versions) || [])) {
    const n = normLoader(x);
    if (n) set.add(n);
  }
  return LOADER_ORDER.filter(n => set.has(n)).concat(
    [...set].filter(n => LOADER_ORDER.indexOf(n) < 0)
  );
}
/* 版本列表里出现过的加载器 + 各自版本数（按 LOADER_ORDER，其余按字母） */
function collectLoaders(versions) {
  const counts = new Map();
  for (const v of (versions || [])) {
    for (const n of loadersOf(v)) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const known = LOADER_ORDER.filter(n => counts.has(n));
  const extra = [...counts.keys()].filter(n => LOADER_ORDER.indexOf(n) < 0).sort();
  return known.concat(extra).map(name => ({ name, count: counts.get(name) }));
}
/* 按加载器筛版本；loader 为空 / '__all__' 时原样返回。
   一个版本同时标多个加载器（Fabric + Quilt）时，两边都能筛到它。 */
function filterByLoader(versions, loader) {
  if (!loader || loader === '__all__') return (versions || []).slice();
  return (versions || []).filter(v => loadersOf(v).indexOf(loader) >= 0);
}
/* 默认选中项：优先目标实例的加载器；实例没选（'' / 未知）则「全部」 */
function defaultLoader(versions, prefer) {
  const want = normLoader(prefer);
  if (!want) return '__all__';
  return (versions || []).some(v => loadersOf(v).indexOf(want) >= 0) ? want : '__all__';
}

module.exports = { LOADER_MAP, LOADER_ORDER, normLoader, loadersOf, collectLoaders, filterByLoader, defaultLoader };

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

/* ===== 模组详情页（PCL 式）：游戏版本条 / 加载器分组 / 前置依赖 =====
 * 这一组同样只做数据整形，不碰 DOM、不联网（单测在 qa/modver-unit.js）。
 * 版本对象形状（主进程 modrinth:mod-page 归一化后）：
 *   { ref, name, date, filename, size, loaders:['Fabric'], gv:['1.21.8'],
 *     downloads, deps:[{ pid, type, vid }] }                                        */

/* 版本号拆成数值段：'26.3' → [26,3]、'1.21.11' → [1,21,11]；
   非纯数字串（'24w14a' 这类快照）返回 null，排序时统一沉到正式版本后面 */
function mcParts(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split('.').map(Number);
}
/* 比较两个游戏版本，**大的在前**（返回负数表示 a 更新）。数值逐段比，缺段按 0 补 */
function cmpMc(a, b) {
  const pa = mcParts(a), pb = mcParts(b);
  if (pa && pb) {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return y - x;
    }
    return 0;
  }
  if (pa) return -1;              /* 正式版本号永远排在快照串前面 */
  if (pb) return 1;
  return String(b).localeCompare(String(a));
}
/* 版本列表里出现过的游戏版本 + 各自版本数（新的在前）。
   **只要正式版本号**：Modrinth 会把 '26.3-rc-2'、'24w14a' 也塞进 game_versions，
   Sodium 一个项目就能凑出 44 个标签，标签条直接变角标墙 —— 这类版本仍然能在「全部」里
   找到对应文件，只是不单独给一个标签。 */
function collectGameVersions(versions) {
  const counts = new Map();
  for (const v of (versions || [])) {
    for (const g of (v.gv || v.game_versions || [])) {
      if (g && mcParts(g)) counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  return [...counts.keys()].sort(cmpMc).map(name => ({ name, count: counts.get(name) }));
}
/* 按游戏版本筛；gv 为空 / '__all__' 时原样返回（返回新数组） */
function filterByGame(versions, gv) {
  if (!gv || gv === '__all__') return (versions || []).slice();
  return (versions || []).filter(v => (v.gv || v.game_versions || []).indexOf(gv) >= 0);
}
/* 一个版本声明的**必需**前置项目 id（去重、保持声明顺序）；可选 / 不兼容的不算 */
function depsOf(v) {
  const out = [];
  for (const d of ((v && (v.deps || v.dependencies)) || [])) {
    const type = d.type || d.dependency_type || 'required';
    if (type !== 'required') continue;
    const pid = d.pid || d.project_id || d.projectId;
    if (pid && out.indexOf(pid) < 0) out.push(pid);
  }
  return out;
}
/* 版本行里「N 项前置」的 N */
function needCount(v) { return depsOf(v).length; }
/* 版本 → 中文 Minecraft Wiki 页面（下载页每行的「详情」按钮）。
   正式版 / 快照 / 预发布 / 候选版都叫「Java版<id>」（Java版26.3、Java版24w14a、Java版26.3-rc-1 实测 200）；
   远古 Alpha / Beta 用维基自己的命名「Alpha 1.2.6」「Beta 1.7.3」——
   写成「Java版a1.2.6」是 404。 */
function mcWikiUrl(v) {
  const id = String((v && v.id) || '').trim();
  if (!id) return '';
  const type = String((v && v.type) || '');
  let title;
  if (type === 'old_alpha') title = 'Alpha ' + id.replace(/^a(?=\d)/i, '');
  else if (type === 'old_beta') title = 'Beta ' + id.replace(/^b(?=\d)/i, '');
  else title = 'Java版' + id;
  /* 维基习惯用下划线代空格（/w/Beta_1.7.3），encodeURIComponent 会给出 %20 */
  return 'https://zh.minecraft.wiki/w/' + encodeURIComponent(title).replace(/%20/g, '_');
}
/* 按加载器分组（Fabric → NeoForge → Forge → Quilt …，没标加载器的归「其他」） */
function groupByLoader(versions) {
  const map = new Map();
  for (const v of (versions || [])) {
    const names = loadersOf(v);
    for (const n of (names.length ? names : ['其他'])) {
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(v);
    }
  }
  const order = LOADER_ORDER.concat(['其他']);
  const rank = n => { const i = order.indexOf(n); return i < 0 ? 99 : i; };
  return [...map.keys()].sort((a, b) => rank(a) - rank(b))
    .map(loader => ({ loader, versions: map.get(loader) }));
}
/* Modrinth 分类 slug → 中文；认不出来的原样显示（首字母大写），别丢信息 */
const CAT_ZH = {
  adventure: '冒险', decoration: '装饰', optimization: '优化', library: '支持库',
  technology: '科技', magic: '魔法', utility: '实用', worldgen: '世界生成',
  'world-generation': '世界生成', storage: '存储', equipment: '装备', mobs: '生物',
  food: '食物', 'game-mechanics': '游戏机制', transportation: '运输', combat: '战斗',
  cursed: '整活', management: '管理', social: '社交', minigame: '小游戏', economy: '经济'
};
function catLabel(slug) {
  const s = String(slug == null ? '' : slug).trim();
  if (!s) return '';
  const zh = CAT_ZH[s.toLowerCase()];
  if (zh) return zh;
  const hit = Object.keys(CAT_ZH).find(k => k.replace(/-/g, '') === s.toLowerCase().replace(/-/g, ''));
  if (hit) return CAT_ZH[hit];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  LOADER_MAP, LOADER_ORDER, normLoader, loadersOf, collectLoaders, filterByLoader, defaultLoader,
  mcParts, cmpMc, collectGameVersions, filterByGame, depsOf, needCount, mcWikiUrl, groupByLoader, CAT_ZH, catLabel
};

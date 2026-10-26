'use strict';
/* ============================================================
 * XLC Launcher - 渲染进程
 * ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, cls, html) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* ---------------- 功能临时下架开关（只禁不删） ----------------
 * 需要「临时下架」某功能时把对应值改成 true；恢复时改回 false 即可，功能代码一行没动。
 *   downloadGame：下载页的 4 个游戏分类 tab（正式版 / 快照版 / 远古版本 / 全部）——游戏版本下载入口
 *   modpack    ：下载页「整合包」tab + 「导入 / 整合包」页的「导入整合包」按钮
 * 不受影响：联机 / MOD / 资源包 / 光影 / 数据包 / 导入目录 / 导入插件 / 导出整合包。 */
const FEATURE_OFF = { downloadGame: true, modpack: true };

/* ---------------- 全局状态 ---------------- */
const S = {
  config: null,
  manifest: null,
  manifestVia: '',
  installed: [],   // [{id, folder, loader, hasJar}]
  broken: [],      // 残留实例目录 [{folder, path, reason}]（目录在但版本 JSON 缺失/损坏）
  brokenHinted: false,
  saves: [],
  launching: false,      // 启动流程进行中（含游戏已跑起来，需等 launch:exit 才复位）
  gameRunning: false,    // 游戏客户端进程确实跑起来了（主进程 launch:stage=running 通知）
  gameStopping: false    // 正在关闭游戏（已请求主进程 kill，等退出事件）
};
const LOADERS = ['Vanilla', 'Forge', 'Fabric', 'Quilt', 'NeoForge', 'OptiFine'];
const LOADER_INFO = {
  Vanilla: '官方原版客户端，无模组支持',
  Forge: '老牌模组加载器，生态最大（静默安装器）',
  Fabric: '轻量快速，新版本跟进最快',
  Quilt: 'Fabric 分支，兼容 Fabric 模组',
  NeoForge: 'Forge 社区分支，面向新版本（1.20.1+）',
  OptiFine: '画质优化与增强'
};

/* ---------------- 确认框 ---------------- */
/* 一律走主进程的原生确认框，不要用 window.confirm：
   后者是阻塞式的，弹出时渲染进程停摆 —— 界面画着但点什么都没反应、打不了字（还会跑到窗口后面，
   表现为「启动器卡死」）。await 期间界面照常响应，且对话框一定挂在启动器窗口上。
   用法：if (!(await askConfirm('确定删除…', { danger: true, detail: '…' }))) return; */
async function askConfirm(message, opts) {
  const o = opts || {};
  try {
    const r = await window.lmc.confirmBox({
      message,
      detail: o.detail || '',
      danger: !!o.danger,
      okText: o.okText || '确定',
      cancelText: o.cancelText || '取消'
    });
    if (r && r.error) {
      /* 对话框没弹出来：明确告知，别让用户以为点了没反应 */
      toast('确认框打开失败：' + r.error, 'error');
      return false;
    }
    return !!(r && r.ok);
  } catch (e) {
    /* 极端情况下（主进程未就绪）保守返回 false，避免误删 */
    toast('确认框调用失败：' + ((e && e.message) || e), 'error');
    return false;
  }
}

/* ---------------- Toast / 状态 ---------------- */
function toast(msg, type) {
  const box = $('#toasts');
  /* 防洪：同时最多 6 条，超出的移除最旧的（长按回车连点会瞬间堆几十条） */
  while (box.children.length >= 6) box.firstChild.remove();
  const t = el('div', 'toast' + (type && type !== 'ok' ? ' ' + type : ''), esc(msg));
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3400);
}
window.lmc.on('app:toast', (d) => toast(d.msg, d.type));
function setStatus(text, busy) {
  $('#stText').textContent = text;
  $('#stDot').className = 'st-dot' + (busy ? ' busy' : '');
}
window.lmc.on('app:status', (d) => setStatus(d.text, d.busy));

/* 插件改了启动器设置（需要 control 权限）：主进程已经把改动落盘了，这里负责两件事 ——
   ① 让界面跟上（重读配置、重上主题，必要时重扫实例）；
   ② 明确告诉用户「哪个插件、改了哪几项」。插件的改动不许是悄悄发生的：
      用户即使不打开设置页，也得知道自己的启动器被动了哪几处。
   守门在主进程（插件不能改插件开关 / 公告已读 / 账户凭据，也不能把窗口藏起来），这里只管呈现。 */
window.lmc.on('plugin:cfg-changed', async (d) => {
  const name = (d && d.name) || '插件';
  const labels = (d && d.labels) || [];
  const keys = (d && d.keys) || [];
  toast('插件「' + name + '」改动了设置：' + (labels.join('、') || '（未知项）'), 'warn');
  try {
    await loadConfigUI();
    applyPersonalize();
    /* 换游戏目录 / 换默认实例会改变「本机有哪些版本」，重扫一遍免得主页与实例页还是旧的 */
    if (keys.some(k => /^(gameDir|defaultVersion|lastVersion)/.test(k))) await scanDir();
  } catch (e) {
    console.warn('应用插件改的设置失败:', e);
  }
});

/* 渲染端 JS 错误上报主进程留档（渲染进程崩溃主进程此前无从感知） */
function reportRrError(m) { try { window.lmc.rendererError(m); } catch (_) {} }
window.addEventListener('error', (e) => {
  if (e && (e.error || e.message)) reportRrError('error: ' + ((e.error && (e.error.stack || e.error.message)) || e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  reportRrError('unhandledrejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* ---------------- 工具 ---------------- */
function parseVer(id) {
  const m = String(id).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [1, +m[1], +m[2]] : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
function fmtDate(iso) {
  try { return new Date(iso).toISOString().slice(0, 10); } catch (_) { return ''; }
}
function typeName(t) {
  return { release: '正式版', snapshot: '快照', old_beta: 'Beta', old_alpha: 'Alpha' }[t] || t;
}

/* ---------------- 版本类型 → 方块图标（照 PCL 的版本图标映射） ----------------
 * PCL / HMCL 的版本列表每行前面有个方块图标：正式版 = 草方块、快照 = 命令方块、
 * 远古版 = 圆石（见 PCL2 的 McVersionState.DefaultLogo）。这里照同一套映射来，
 * 但方块图是自绘素材（assets/blocks/，由 tools/gen-block-icons.js 生成）——
 * 不引用游戏贴图 / 第三方启动器的美术资源，理由见 THIRD-PARTY.md 的合规说明。 */
const BLOCK_ICONS = { release: 'grass', snapshot: 'command', old_beta: 'cobblestone', old_alpha: 'cobblestone' };
function blockIconHtml(type) {
  const f = BLOCK_ICONS[type];
  return f ? '<img class="v-block" src="../assets/blocks/' + f + '.png" alt="" draggable="false">' : '';
}
/* 已安装实例的类型判定（实例扫描没有现成 type，按优先级兜底）：
   ① 主进程扫描时读到的 version.json `type`（原版实例一定有）
   ② 用 mcVersion / id 去版本清单里查（改过名的实例靠这条对上号）
   ③ id 形状兜底：b1.x → Beta、a1.x → Alpha、带 snapshot/pre/rc/周快照 → 快照 */
function blockTypeForInstalled(v) {
  if (v.type && BLOCK_ICONS[v.type]) return v.type;
  const key = v.mcVersion || v.id;
  const map = S._typeById || (S._typeById = new Map((S.manifest ? S.manifest.versions : []).map(x => [x.id, x.type])));
  if (map.has(key)) return map.get(key);
  if (/^b1\./i.test(key)) return 'old_beta';
  if (/^a1\./i.test(key)) return 'old_alpha';
  if (/snapshot|pre\d|rc\d|\d+w\d{2}[a-z]/i.test(key)) return 'snapshot';
  return 'release';
}

/* 加载器兼容性
 * ============================================================
 * 这里只是「初判」（同步、不联网），让弹窗一打开就有东西可渲染。
 * 真实结论一律以各家官方元数据为准 —— 见 loaderCompatAsync() / loader:probe IPC。
 *
 * 【为什么不能硬编码】各加载器对「快照版 / 预发布版」的支持规则完全不同，
 * 而且同一加载器对不同版本也不一样（Quilt 有 26.3-snapshot-1 却没有 26.4-snapshot-2）。
 * 实测矩阵（2026-10-04，构建数量）：
 *            1.21.11   26.1   26.2   26.3   26.4-snapshot-2
 *   Fabric     253      253    253    253        253        ← 快照也支持
 *   Quilt      307      307    307    307        ✗ 404       ← 正式版都支持，快照看具体版本
 *   Forge       31        8     14      8        ✗           ← 不为快照提供构建
 *   NeoForge    ✗       161     89     47        ✗           ← 版本号按次版本号走，不为快照提供
 *   OptiFine    18       ✗      1       ✗        ✗           ← 只在该版本有发布时才有（26.2 有 1 个预览）
 *
 * 结论：除 Vanilla 外全部必须联网确认。这里只对「明显不可能」的情况做快速否定，
 * 其余一律先给 ok:true + pending，等元数据回填后刷新界面。 */
function loaderCompat(v) {
  const rel = v.type === 'release';
  const p = parseVer(v.id);
  const isOld = v.type === 'old_beta' || v.type === 'old_alpha';
  const pending = { ok: true, why: '', pending: true };
  return {
    Vanilla:  { ok: true, why: '' },
    /* 远古版（old_beta / old_alpha，如 b1.7.3、a1.2.6）连 Forge 都没有，直接否定且不联网。
       注意 pending 必须为 false，否则界面会永远停在「检测中」而不是明确的「不兼容」。 */
    Forge:    isOld ? { ok: false, why: '远古版本无 Forge 构建' }
                    : (rel ? { ok: true, why: '' } : pending),
    Fabric:   isOld ? { ok: false, why: '远古版本无 Fabric 构建' }
                    : (rel && p && cmpVer(p, [1, 14, 0]) < 0
                        ? { ok: false, why: 'Fabric 支持自 1.14 开始' }
                        : pending),
    Quilt:    isOld ? { ok: false, why: '远古版本无 Quilt 构建' }
                    : (rel && p && cmpVer(p, [1, 14, 0]) < 0
                        ? { ok: false, why: 'Quilt 支持自 1.14 开始' }
                        : pending),
    NeoForge: isOld ? { ok: false, why: '远古版本无 NeoForge 构建' }
                    : (rel && p && cmpVer(p, [1, 20, 1]) < 0
                        ? { ok: false, why: 'NeoForge 仅支持 1.20.1 及以上版本' }
                        : pending),
    /* OptiFine 以前写死 ok:false（提示「后续版本支持」），但实际 BMCLAPI 有完整的
       OptiFine 版本清单，26.2 都已经有预览版了。改为联网查清单判断。 */
    OptiFine: isOld ? { ok: false, why: '远古版本无 OptiFine 构建' } : pending
  };
}

/* 需要联网确认的加载器（Vanilla 不需要，任何版本都是原版） */
const LOADER_VERSIONED = { Forge: true, Fabric: true, Quilt: true, NeoForge: true, OptiFine: true };
/* 支持「选择具体加载器版本」的加载器（与主进程 loaderBuildsOf 支持的范围一致）。
   OptiFine 不在此列：它自带一套 HD_U 版本体系，安装走的是「模组 drops 进 mods/」那条路。 */
const LOADER_PICKABLE = { Forge: true, Fabric: true, Quilt: true, NeoForge: true };
/* 联网确认结果：按 MC 版本 id 存，供 compatOf() 覆盖初判。
   注意这里不做「跨次复用」的长缓存 —— 用户要求每次安装都实时查询一遍，
   所以每次 refineLoaderCompat()/loaderCompatAsync() 都会重新请求；这个 Map 只用于
   「本次弹窗会话内」，并且是**增量写入**的（每个加载器单独回来就单独合并），
   这样界面可以先显示已确定的那几个，不必等最慢的那个。 */
const loaderCompatOverride = new Map();
/* 是否正在查询（供界面显示「检测中」） */
let loaderProbing = false;
/* 查询单个加载器并把结论写进本次弹窗会话的覆盖表。
 * 【为什么拆成单加载器】一次并发查 5 个加载器时，弹窗要等「最慢的那个」才重绘，
 * 用户盯着「… 检测中」的时间 = 5 个请求里最慢的那个（常见是被墙的 NeoForge 官方源）。
 * 拆开后「选中的加载器」优先查、回来立刻重绘，其余在后台并行补，感知延迟降到 1 个请求。
 * 另外同一 (kind, 版本) 在途请求会去重（inFlight），切换单选项来回点不会重复发请求。 */
const loaderProbeInFlight = new Map();     /* key = kind + '@' + verId → Promise<结果> */
function probeOneLoader(kind, verId, force) {
  const key = kind + '@' + verId;
  if (loaderProbeInFlight.has(key)) return loaderProbeInFlight.get(key);
  const p = (async () => {
    try {
      const r = await window.lmc.loaderProbe(kind, verId, !!force);
      return (r && r.ok)
        ? { ok: true, why: '', loaderVer: r.loaderVer || '', builds: r.builds || 0, preview: !!r.preview, at: Date.now() }
        : { ok: false, unknown: !!r.unknown, slow: !!r.slow,
            why: (r && r.why) || (kind + ' 尚未提供 ' + verId + ' 的构建'), builds: 0, at: Date.now() };
    } catch (e) {
      return { ok: false, why: kind + ' 构建信息获取失败（网络不可达）：' + ((e && e.message) || e), at: Date.now() };
    }
  })();
  loaderProbeInFlight.set(key, p);
  /* 落地后从在途表移除 —— 这样下一次 force 查询会重新发请求（不做跨次缓存） */
  p.finally(() => { if (loaderProbeInFlight.get(key) === p) loaderProbeInFlight.delete(key); });
  return p;
}
/* 把单个加载器的结论合并进覆盖表（增量写入，供界面随时读取已回来的部分） */
function mergeLoaderResult(verId, kind, res) {
  const cur = loaderCompatOverride.get(verId) || {};
  cur[kind] = res;
  loaderCompatOverride.set(verId, cur);
  return cur;
}
/* 批量查询（opts.kinds 可指定只查哪些；缺省查全部）。
 * 逐个落地、逐个合并：调用方可以在每个 onOne 回调里重绘，先回来的先显示。 */
async function loaderCompatAsync(v, opts) {
  const want = (opts && opts.kinds)
    ? (Array.isArray(opts.kinds) ? opts.kinds : [opts.kinds]).filter(k => LOADER_VERSIONED[k])
    : Object.keys(LOADER_VERSIONED);
  loaderProbing = true;
  const onOne = opts && opts.onOne;
  try {
    await Promise.all(want.map(async (kind) => {
      const res = await probeOneLoader(kind, v.id, !!(opts && opts.force));
      mergeLoaderResult(v.id, kind, res);
      if (typeof onOne === 'function') { try { onOne(kind, res); } catch (_) {} }
    }));
  } finally {
    loaderProbing = false;
  }
  return loaderCompatOverride.get(v.id) || {};
}

/* ---------------- 导航 ---------------- */
/* 侧边栏滑动指示条：跟随当前页平滑移动（弹性缓动 + 辉光，见 #railInd 样式） */
let railIndPlaced = false;   /* 首次落位直接摆到位：否则会看到指示条从侧栏顶端一路滑下来 */
function moveRailInd() {
  const ind = $('#railInd');
  const btn = $('#railNav .rail-btn.active');
  if (!ind) return;
  if (!btn) { ind.style.opacity = '0'; return; }   // 二级页（存档管理等）无侧栏入口 → 隐藏指示条
  const rb = btn.getBoundingClientRect(), rr = $('#rail').getBoundingClientRect();
  if (!rr.height) return;
  if (!railIndPlaced) ind.style.transition = 'none';   /* 只跳过这一次的过渡 */
  ind.style.top = (rb.top - rr.top + rb.height * 0.24) + 'px';
  ind.style.height = (rb.height * 0.52) + 'px';
  ind.style.opacity = '1';
  if (!railIndPlaced) {
    railIndPlaced = true;
    requestAnimationFrame(() => { ind.style.transition = ''; });   /* 恢复 CSS 里的弹性过渡 */
  }
}
window.addEventListener('resize', moveRailInd);
function gotoPage(name) {
  $$('#railNav .rail-btn').forEach(x => x.classList.toggle('active', x.dataset.page === name));
  moveRailInd();
  $$('.page').forEach(p => p.classList.remove('active'));
  const page = $('#page-' + name);
  if (page) page.classList.add('active');
  /* 面包屑：主进程日志里留一行「切到了哪一页」——排查「用着用着就崩了」时靠它定位 */
  try { window.lmc.uiTrace('page:' + name); } catch (_) {}
  /* 切页回到顶部：#content 是所有页面共用的滚动容器，不回顶会「继承」上一页的滚动位置 */
  const content = $('#content');
  if (content) content.scrollTop = 0;
  if (name === 'instances') renderInstances();
  if (name === 'account') loadAccounts();
  if (name === 'diag') {
    const di = $('#diagInstance');
    const prev = di.value;
    di.innerHTML = S.installed.map(v => '<option value="' + esc(v.id) + '">' + esc(v.id) + '</option>').join('') +
      '<option value="">（全局 .minecraft）</option>';
    if (prev && S.installed.some(v => v.id === prev)) di.value = prev;
    loadDiagReports();
    refreshDiagLauncher();
  }
  if (name === 'mp') mpOnEnter(); else mpStopPolling();
  if (name === 'friends') { loadFriends(); frStartPolling(); } else frStopPolling();
  if (name === 'saves') renderSavesPage();
  if (name === 'tools') renderTools();
  if (name === 'plugins') {
    renderPlugins();
    /* 停留在一键开服面板时，回页顺带刷新服务器列表与控制台（进程状态可能已变化） */
    if (PLG.pane === 'server') loadServerList();
  }
  if (name.startsWith('plugin-')) ensurePluginWebview(name.slice('plugin-'.length));   /* 插件页面：首次进入才建 webview */
  if (name === 'download') requestAnimationFrame(() => moveTabInd($('#dlTabs'))); // 页面显示后再定位（隐藏时 offsetWidth 为 0）
  if (name === 'settings') refreshUpdatePane();
}
$$('#railNav .rail-btn').forEach(b => {
  /* 无 data-page 的按钮（如「反馈」）不是页面入口，不进 gotoPage，各自单独挂事件 */
  if (!b.dataset.page) return;
  b.addEventListener('click', () => gotoPage(b.dataset.page));
});
/* 侧边栏「反馈」：直接去 GitHub Issues（系统默认浏览器打开） */
const FEEDBACK_URL = 'https://github.com/byzgdneo2/XLC-Launcher/issues';
$('#btnFeedback').addEventListener('click', () => {
  window.lmc.openUrl(FEEDBACK_URL).catch(() => {});
});

/* ---------------- 窗口控制 ---------------- */
$('#btnMin').addEventListener('click', () => window.lmc.win.minimize());
$('#btnMax').addEventListener('click', () => window.lmc.win.maximizeToggle());
$('#btnClose').addEventListener('click', () => window.lmc.win.close());
/* 最大化状态同步（主进程事件 → body class，可供样式区分最大化形态） */
window.lmc.on('win:maximized', (on) => document.body.classList.toggle('maximized', !!on));

/* ---------------- 启动日志 ---------------- */
const logPanel = $('#logPanel');
function appendLog(line, cls) {
  const d = el('div', cls || '', esc(line));
  logPanel.appendChild(d);
  while (logPanel.children.length > 500) logPanel.firstChild.remove();
  logPanel.scrollTop = logPanel.scrollHeight;
}
$('#btnClearLog').addEventListener('click', () => { logPanel.innerHTML = '<div class="t-dim">已清空</div>'; });
/* ---------------- 启动按钮：开始 / 关闭（一个按钮两副面孔） ----------------
 * 待机 = ▶「启动游戏」；游戏跑起来后 = ■「关闭游戏」—— 跟视频播放器的开始 / 停止一样，
 * 同一个位置换图标。运行中的判定来自主进程（launch:stage），不是渲染层自己猜的。 */
function applyLaunchUI() {
  const btn = $('#btnLaunch');
  /* 副标题与按钮同源推导：任何路径改了状态（点击 / 主进程事件 / Ctrl+R 后重建）都不会出现
     「按钮已变成关闭、文案还写着就绪」这种对不上的情况 */
  const phase = S.gameStopping ? '正在关闭…' : (S.gameRunning ? '运行中' : (S.launching ? '启动中…' : '就绪'));
  const st = $('#heroState');
  if (st) st.textContent = phase;
  if (!btn) return;
  const ic = btn.querySelector('use');
  const running = S.gameRunning;
  btn.classList.toggle('running', running);
  btn.disabled = S.gameStopping || (S.launching && !running);
  if (ic) ic.setAttribute('href', running ? '#i-stop' : '#i-play');
  btn.title = S.gameStopping ? '正在关闭游戏…' : (running ? '关闭游戏' : '启动游戏');
}
/* 状态复位：游戏退出 / 启动失败 / 被主进程启动锁拒绝，都走这里 */
function resetLaunchState() {
  S.launching = false; S.gameRunning = false; S.gameStopping = false;
  applyLaunchUI();
}
/* 关闭游戏：进程树交给主进程收，等退出事件回来再复位界面 */
async function stopGame() {
  if (S.gameStopping) return;
  S.gameStopping = true;
  applyLaunchUI();
  toast('正在关闭游戏…');
  try {
    const r = await window.lmc.stopGame();
    if (!r || !r.ok) {
      toast((r && r.error) || '关闭游戏失败', 'warn');
      S.gameStopping = false;
      applyLaunchUI();
    }
  } catch (e) {
    toast('关闭游戏失败: ' + e.message, 'error');
    S.gameStopping = false;
    applyLaunchUI();
  }
}
/* 启动游戏：主页大按钮、存档「用该版本启动」、最近游玩「快速启动」共用这一条路 */
async function startGame(o) {
  const opt = o || {};
  if (S.gameRunning) { toast('游戏已经在运行中，先把它关掉再启动', 'warn'); return false; }
  if (S.launching) { toast('游戏正在启动中，请稍候…', 'warn'); return false; }
  const versionId = opt.versionId || $('#selVersion').value;
  if (!versionId) { toast('请先在「下载」页安装一个版本', 'warn'); return false; }
  S.launching = true;
  S.gameStopping = false;
  applyLaunchUI();
  logPanel.innerHTML = '';
  appendLog('[XLC] ' + (opt.reason || ('准备启动 ' + versionId + ' …')), 't-dim');
  try {
    const r = await window.lmc.launch({
      versionId,
      username: $('#inpName').value.trim() || 'Steve',
      world: opt.world || null,
      /* 智能分配开启时不传 mem，由主进程按物理内存推荐 */
      mem: S.config.memAuto === false ? S.config.mem : undefined
    });
    if (r && r.started === false) {  /* 主进程启动锁拒绝：复位本地状态 */
      resetLaunchState();
      toast(r.error || '已有游戏正在运行，无法重复启动', 'warn');
      return false;
    }
    return true;
  } catch (e) {
    resetLaunchState();
    toast('启动失败: ' + e.message, 'error');
    return false;
  }
}

window.lmc.on('launch:log', (d) => {
  let cls = '';
  if (/ERROR|Exception|错误|失败/i.test(d)) cls = 't-err';
  else if (/WARN|警告/i.test(d)) cls = 't-warn';
  appendLog(d, cls);
});
/* 游戏进程状态（主进程推送）：running = 真的跑起来了 → 按钮切成「关闭游戏」 */
window.lmc.on('launch:stage', (d) => {
  if (!d) return;
  if (d.stage === 'running') {
    S.gameRunning = true;
    S.gameStopping = false;
  } else if (d.stage === 'idle') {
    S.gameRunning = false;
  }
  applyLaunchUI();
});
window.lmc.on('launch:exit', (d) => {
  appendLog('[XLC] 游戏进程已退出 (code ' + d.code + ')', d.code === 0 ? 't-dim' : 't-warn');
  const byUser = !!d.byUser;
  resetLaunchState();
  /* 用户自己按的「关闭游戏」：正常收尾，不报异常、不跑崩溃诊断 */
  if (byUser) { toast('游戏已关闭'); return; }
  if (d.diag && d.diag.found) {
    /* 异常退出且诊断出结果：自动跳到诊断页展示 */
    S.lastDiag = d.diag;
    document.querySelector('[data-page="diag"]').click();
    const di = $('#diagInstance');
    if (d.diag.instance && S.installed.some(v => v.id === d.diag.instance)) di.value = d.diag.instance;
    renderDiagResult(d.diag);
    toast('检测到游戏崩溃，已自动诊断 —— 见「诊断」页', 'warn');
  }
});

/* ---------------- 配置 ---------------- */
/* ---------------- 极速模式（1.2-snapshot2） ----------------
 * 开关 = 左下角的小圆圈（#avatar）长按 10 秒。开启后：body.turbo（CSS 把动画/过渡/昂贵特效压到瞬间）、
 * 弹窗退场不等 180ms、主进程收缩 Mod 搜索缓存。默认关闭，配置存在 lmc.config.json 的 turboMode。 */
let TURBO_ON = false;
function applyTurbo(on) {
  TURBO_ON = !!on;
  document.body.classList.toggle('turbo', TURBO_ON);
  MODAL_EXIT_MS = (TURBO_ON || REDUCED_MOTION) ? 0 : 180;
  setAvatarLetter();
}
function setAvatarLetter() {
  const av = $('#avatar');
  if (!av) return;
  av.classList.toggle('turbo-on', TURBO_ON);
  /* 字母固定：L = Launcher 正常模式，S = Speed 极速模式（不跟账户首字母走，用户 2026-10-18 定） */
  if (TURBO_ON) { av.textContent = 'S'; av.title = '极速模式已开启（长按 10 秒切回正常模式）'; return; }
  av.textContent = 'L';
  av.title = '长按 10 秒开启极速模式';
}
(function initTurboToggle() {
  const av = $('#avatar');
  if (!av) return;
  const HOLD_MS = 10000;
  let t0 = 0, raf = 0, fired = false;
  function stopRing() { if (raf) cancelAnimationFrame(raf); raf = 0; av.style.removeProperty('background'); }
  function tick() {
    const left = HOLD_MS - (Date.now() - t0);
    const p = Math.min(100, (Date.now() - t0) / HOLD_MS * 100);
    av.style.background = 'conic-gradient(var(--acc2) ' + p.toFixed(1) + '%, rgba(128,128,128,.3) 0)';
    av.title = '松开取消 · ' + (TURBO_ON ? '关闭' : '开启') + '极速模式（还差 ' + Math.ceil(left / 1000) + ' 秒）';
    if (p >= 100) { fired = true; stopRing(); doToggle(); return; }
    raf = requestAnimationFrame(tick);
  }
  function cancel() {
    if (!raf) return;
    const held = Date.now() - t0;
    stopRing();
    setAvatarLetter();
    if (!fired && held > 1200) toast('按住满 10 秒才会切换极速模式（刚按了 ' + Math.round(held / 1000) + ' 秒）', 'warn');
  }
  async function doToggle() {
    try {
      S.config = await window.lmc.saveConfig({ turboMode: !TURBO_ON });
      applyTurbo(!!(S.config && S.config.turboMode));
      toast(TURBO_ON ? '极速模式已开启：动画与特效已压到最低' : '极速模式已关闭', TURBO_ON ? 'ok' : 'info');
    } catch (e) {
      toast('切换极速模式失败：' + ((e && e.message) || e), 'error');
    }
  }
  av.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    fired = false; t0 = Date.now();
    try { av.setPointerCapture(e.pointerId); } catch (_) {}
    raf = requestAnimationFrame(tick);
  });
  av.addEventListener('pointerup', cancel);
  av.addEventListener('pointercancel', cancel);
})();
async function loadConfigUI() {
  S.config = await window.lmc.getConfig();
  /* 启动器重启 / Ctrl+R 后游戏可能还在跑（主进程启动锁还握着）：按钮直接恢复成「关闭游戏」，
     否则界面显示「启动游戏」、点了却被主进程拦下，两头对不上 */
  if (S.config && S.config.gameRunning) {
    S.gameRunning = true;
    applyLaunchUI();
  }
  /* 窗口标题 / 侧栏 logo 提示跟着主进程版本号走（index.html 里写的是静态兜底值）——
     发版只改 main.js 的 APP_VERSION，这里自动同步，不会出现标题停在旧版本的情况。 */
  /* 极速模式（1.2-snapshot2）：配置到位后立即应用，重启后保持上次的选择 */
  applyTurbo(!!(S.config && S.config.turboMode));
  if (S.config && S.config.appVersion) {
    const t = 'Xero Lite Craft Launcher ' + S.config.appVersion;
    if (document.title !== t) document.title = t;
    const lg = document.querySelector('.rail-logo');
    if (lg && lg.title !== t) lg.title = t;
  }
  $('#inpName').value = S.config.username || '';
  $('#heroName').textContent = S.config.username || 'Steve';
  $('#setUsername').value = S.config.username || '';
  $('#setJavaPath').value = S.config.javaPath || '';
  $('#setMem').value = S.config.mem || 4;
  $('#memVal').textContent = (S.config.mem || 4) + ' GB';
  $('#setGameDir').value = S.config.gameDir || '';
  $('#setCustomSrc').value = S.config.customSource || '';
  $('#setDlThreads').value = S.config.dlThreads || 16;
  $('#setDlConcurrency').value = S.config.dlConcurrency || 32;
  /* 版本更新 */
  $('#updCurVer').textContent = S.config.appVersion || '—';
  /* 更新源锁定：地址栏只读，永远显示官方地址（不接受自定义） */
  const updUrlEl = $('#setUpdateUrl');
  if (updUrlEl) { updUrlEl.value = S.config.updateDefaultUrl || ''; updUrlEl.readOnly = true; }
  $('#setAutoUpd').checked = S.config.autoCheckUpdate !== false;
  $('#setSkipPreUpd').checked = S.config.skipPreviewUpdate === true;
  /* 主页顶部的测试版提示：只有当前跑的是快照 / 预发布 / 候选版才出现（判定由主进程按版本阶段给出） */
  applySnapTip(!!S.config.appVersionPre);
  $$('#page-settings input[name=src]').forEach(r => { r.checked = r.value === S.config.source; });
  const ai = S.config.aiApi || {};
  $('#aiBase').value = ai.base || '';
  $('#aiKey').value = ai.key || '';
  $('#aiModel').value = ai.model || 'gpt-4o-mini';
  /* 游戏设置页的「内存分配 / 高级选项」是**按实例**存的（PCL 式）：
     三个单选、滑块、Java 虚拟机参数与游戏参数都由 fillVersionCard() 按当前实例填，
     这里不再从全局配置写这一页 —— 全局默认值在「设置 → 性能与目录」里改。 */
  $('#setJvm').value = S.config.jvmArgs || '';
  $('#gsChinese').checked = S.config.forceChinese !== false;
  /* 设置页补充项（照 PCL 补齐）：全局启动选项 / 高级 / 下载限速 / 数据目录 */
  $('#setGameArgs').value = S.config.gameArgs || '';
  $('#setPreCmd').value = S.config.preLaunchCmd || '';
  $('#setWinTitle').value = S.config.winTitle || '';
  const ws = S.config.winSize || {};
  $('#setWinW').value = ws.w || '';
  $('#setWinH').value = ws.h || '';
  $('#setWinMax').checked = ws.max === true;
  $('#setIsolate').value = S.config.forceIsolate || 'auto';
  $('#setProcPrio').value = S.config.procPriority || 'normal';
  $('#setLaunchVisib').value = S.config.launcherVisibility || 'keep';
  $('#setChinese').checked = S.config.forceChinese !== false;
  $('#setGpuPref').checked = S.config.gpuPref === true;
  $('#setSpeedLimit').value = S.config.speedLimit || 0;
  $('#setDataDir').value = S.config.dataDir || '';
  /* 内存三选一（全局）：memAuto=true 走自动配置，否则自定义 */
  const memModeEl = document.querySelector('#page-settings input[name=memMode][value="' + (S.config.memAuto !== false ? 'auto' : 'custom') + '"]');
  if (memModeEl) memModeEl.checked = true;
  syncMemMode();
  /* 离线皮肤卡：跟随当前账户 */
  refreshSkinCard();
  refreshMemHint();
  applyPersonalize();
  $('#tbSource').textContent = S.config.source === 'official' ? '官方源' :
    S.config.source === 'custom' ? '自定义源' : 'BMCLAPI';
  updateStatusBarRight();
}
/* 智能内存分配提示（PCL 式）：按「该实例的模组数量 + 此刻系统可用内存」四阶段给出推荐值。
   推荐值同时写回手动滑块，方便先看清「自动会给多少」再决定要不要手动改；
   手动滑块的上限跟随物理内存（原来写死 16G，32G 的机器想多给都拖不上去）。 */
async function refreshMemHint() {
  try {
    const dvEl = $('#gsDefaultVer');
    const m = await window.lmc.sysMem({ instance: dvEl ? dvEl.value : '' });
    if (!m.ok) return;
    const maxMem = Math.max(4, Math.min(64, Math.floor(m.totalGB)));
    ['#gsMem', '#setMem'].forEach(sel => {
      const el = $(sel);
      if (!el) return;
      el.max = String(maxMem);
      if (Number(el.value) > maxMem) el.value = String(maxMem);
      if (!(Number(el.value) >= 1)) el.value = '1';   /* 下限 1G（滑块的 min 也是 1，别让它夹住推荐值） */
    });
    const t = m.targets || {};
    $('#gsMemHint').textContent = '物理内存 ' + m.totalGB + ' GB · 当前可用 ' + m.availGB + ' GB · 该实例 ' +
      (m.mods ? m.mods + ' 个模组' : '无模组') + (m.optifine ? '（含 OptiFine）' : '') +
      ' · 智能推荐 ' + m.recommendGB + ' GB';
    $('#gsMemHint').title = '按实例需求（起步 ' + t.t1 + ' / 舒适 ' + t.t2 + ' / 充裕 ' + t.t3 +
      ' GB）与当前可用内存分档发放：0~' + t.t1 + ' GB 全给，之后分别按 70% / 40% / 15% 给。' +
      '模组越多给得越多，内存越紧张给得越保守；手动分配请对着「智能推荐」调。';
    /* 只有「自动配置」这一档才把推荐值回填到滑块（让人先看清自动会给多少）；
       「自定义」是玩家自己定的值，不该被推荐值覆盖。 */
    if (gsRamType() === 0) {
      $('#gsMem').value = String(m.recommendGB);
      $('#gsMemVal').textContent = m.recommendGB + ' GB';
      showMemNow();
    }
    const gh = $('#gsRamGlobalHint');
    if (gh) gh.textContent = '用「设置 → 性能与目录」里的内存设置（当前 ' +
      (S.config.memAuto !== false ? '智能分配' : (S.config.mem || 4) + ' GB') + '）';
    $('#memVal').textContent = ($('#setMem').value || 4) + ' GB';   /* 上限收紧后同步设置页的显示 */
  } catch (_) {}
}
function updateStatusBarRight() {
  $('#stRight').textContent = (S.config ? (S.config.source === 'official' ? '官方源' : S.config.source === 'custom' ? '自定义镜像' : 'BMCLAPI 镜像') : '—') +
    ' · Java ' + (S.javaMajor || '?') + ' · 内存 ' + (S.config ? S.config.mem : 4) + ' GB';
}

/* ---------------- 主页 ---------------- */
function refreshHome() {
  const sel = $('#selVersion');
  sel.innerHTML = '';
  if (!S.installed.length) {
    sel.innerHTML = '<option value="">尚未安装版本 · 去「下载」页安装</option>';
  } else {
    S.installed.forEach(v => {
      const o = el('option', '', v.id + (v.loader !== 'Vanilla' ? '  (' + v.loader + ')' : ''));
      o.value = v.id;
      sel.appendChild(o);
    });
  }
  const cur = sel.value;
  $('#heroVer').textContent = cur || '未安装';
  renderVsel();
  // 存档下拉：当前实例有版本隔离存档 → 显示实例存档；否则显示全局存档（两者都显示时标注归属）
  rebuildWorldOptions();
}
function rebuildWorldOptions() {
  const sw = $('#selWorld');
  const ver = $('#selVersion').value;
  /* 只显示与当前选中版本匹配的存档：版本隔离实例 → 该实例目录里的存档；否则 → 全局存档 */
  const iso = S.saves.filter(w => w.instance === ver);
  const list = iso.length ? iso : S.saves.filter(w => !w.instance);
  sw.innerHTML = '<option value="">不指定 · 进入游戏后选择</option>';
  list.forEach(w => {
    const o = el('option', '', esc(w.name));
    o.value = w.name;
    sw.appendChild(o);
  });
  if (!list.length) {
    const o = el('option', '', '（该版本暂无存档）');
    o.disabled = true;
    sw.appendChild(o);
  }
}
/* 选中版本统一入口：persist=true 时写入配置，重启后自动恢复上次选择 */
function selectVersion(id, persist) {
  $('#selVersion').value = id;
  $('#heroVer').textContent = id || '未安装';
  renderVsel();
  rebuildWorldOptions();
  renderWorlds();
  if (persist && id) {
    S.config.lastVersion = id;
    window.lmc.saveConfig({ lastVersion: id });
  }
}

/* ---------------- 自定义版本下拉（每行带 设置/删除 实例操作） ---------------- */
function renderVsel() {
  const sel = $('#selVersion');
  const cur = sel.value;
  const curV = S.installed.find(v => v.id === cur);
  $('#vselBtn').innerHTML =
    '<span class="cv-name">' + (cur ? esc(cur + (curV && curV.loader !== 'Vanilla' ? ' (' + curV.loader + ')' : '')) : '尚未安装版本 · 去「下载」页安装') + '</span>' +
    '<svg class="ic sm cv-chev"><use href="#i-chev-d"/></svg>';
  const panel = $('#vselPanel');
  panel.innerHTML = '';
  if (!S.installed.length) {
    panel.innerHTML = '<div class="vsel-empty">尚未安装版本 · 去「下载」页安装</div>';
    return;
  }
  S.installed.forEach(v => {
    const row = el('div', 'vsel-row' + (v.id === cur ? ' cur' : ''));
    row.title = '点击切换到该版本；悬浮显示 设置 / 删除 按钮';
    row.innerHTML =
      blockIconHtml(blockTypeForInstalled(v)) +
      '<span class="vr-name">' + esc(v.id) + (v.loader !== 'Vanilla' ? '<i class="vr-loader">' + esc(v.loader) + '</i>' : '') + '</span>' +
      '<span class="vr-act">' +
      '<button type="button" class="vsel-ico" title="实例设置（基础参数 / MOD 管理）"><svg class="ic sm"><use href="#i-settings"/></svg></button>' +
      '<button type="button" class="vsel-ico vr-del" title="删除实例"><svg class="ic sm"><use href="#i-trash"/></svg></button>' +
      '</span>';
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      selectVersion(v.id, true);
      closeVsel();
    });
    gpMark(row);                       /* 手柄要能选中版本行（见 GP_SEL） */
    row.querySelector('.vsel-ico').addEventListener('click', (ev) => { ev.stopPropagation(); openInstSettings(v.id); });
    row.querySelector('.vr-del').addEventListener('click', (ev) => { ev.stopPropagation(); deleteInstance(v.id); });
    panel.appendChild(row);
  });
}
function openVsel() { $('#vsel').classList.add('open'); }
function closeVsel() { $('#vsel').classList.remove('open'); }
$('#vselBtn').addEventListener('click', () => $('#vsel').classList.toggle('open'));
document.addEventListener('click', (ev) => { if (!ev.target.closest('#vsel')) closeVsel(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeVsel(); });

/* 齿轮 → 打开该实例的游戏设置（MOD 管理 tab 定位到该实例）
   点了谁的齿轮，整页的操作对象就跟着切到谁：等价于在「基础设置 → 默认启动实例」里选一次它（不写盘，
   跟手动选一样要按「保存游戏设置」才落配置）。否则会出现「我明明点的是这个版本，设置页还让我再选一遍」。
   三张跟实例绑定的卡（版本信息 / 加载器 / 导出整合包）+ 内存推荐都靠 change 事件统一刷新。 */
function openInstSettings(id) {
  closeVsel();
  selectVersion(id, false);
  gotoPage('gsettings');
  const dv = $('#gsDefaultVer');
  if (dv && [...dv.options].some(o => o.value === id)) {
    dv.value = id;
    dv.dispatchEvent(new Event('change'));   /* → refreshMemHint + loadLoaderCard + syncExportBtn */
    toast('已切到实例「' + id + '」—— 下面的设置都作用于它');
  }
  $$('#gsTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.gs === 'mods'));
  gsShowPane('mods');   /* 子页统一由 gsShowPane 切换（新增资源包 / 光影包后不用再逐个显式隐藏） */
  const mt = $('#modTarget');
  if ([...mt.options].some(o => o.value === id)) mt.value = id;
  loadMods();
}
/* 垃圾桶 → 删除实例（含版本隔离目录） */
async function deleteInstance(id) {
  if (!(await askConfirm('确定删除实例「' + id + '」吗？', { danger: true, detail: '该实例版本隔离目录里的 mods、saves、资源包等文件会一并删除，无法恢复！' }))) return;
  const r = await window.lmc.instanceDelete({ id });
  if (!r || !r.ok) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
  toast('实例「' + id + '」已删除');
  await scanDir();
  if (!$('#selVersion').value && S.installed.length) selectVersion(S.installed[0].id, true);
}
$('#selVersion').addEventListener('change', () => {
  selectVersion($('#selVersion').value, true);  /* 记住选择 + 刷新存档下拉 */
  renderWorlds();                                /* 存档卡片跟随当前实例 */
});
$('#inpName').addEventListener('input', () => {
  const v = $('#inpName').value.trim();
  $('#heroName').textContent = v || 'Steve';
  setAvatarLetter();
  $('#setUsername').value = $('#inpName').value;
  heroHeadFor(v);
});
/* 设置页改玩家名 → 主页实时联动 */
$('#setUsername').addEventListener('input', () => {
  const v = $('#setUsername').value.trim();
  $('#heroName').textContent = v || 'Steve';
  setAvatarLetter();
  $('#inpName').value = $('#setUsername').value;
  heroHeadFor(v);
});
$('#btnLaunch').addEventListener('click', async () => {
  /* 同一个按钮两副面孔：游戏跑起来了它就是「关闭游戏」，否则才是「启动游戏」 */
  if (S.gameStopping) return;
  if (S.gameRunning) { stopGame(); return; }
  if (S.launching) { toast('游戏正在启动中，请稍候…', 'warn'); return; }
  startGame({ versionId: $('#selVersion').value });
});

/* 存档/最近游玩 渲染：只显示当前选中实例自己的存档（版本隔离实例 → 实例目录；非隔离 → 全局 saves） */
function renderWorlds() {
  const box = $('#worldList');
  const ver = $('#selVersion').value;
  const iso = S.saves.filter(w => w.instance === ver);
  const list = iso.length ? iso : S.saves.filter(w => !w.instance);
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-sm">该实例暂无存档</div>';
    return;
  }
  list.forEach(w => {
    const item = el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-globe"/></svg></div>' +
      '<div class="mi-main"><b>' + esc(w.name) + '</b><span>' + (w.instance ? esc(w.instance) + ' · ' : '') + esc(w.path) + '</span></div>' +
      '<button class="btn ghost mi-act" title="用该存档所属版本启动"><svg class="ic sm" style="color:var(--acc2)"><use href="#i-play"/></svg></button>');
    item.querySelector('button').addEventListener('click', () => {
      /* 实例隔离存档 → 自动切到所属实例启动；全局存档 → 用当前选中版本 */
      if (w.instance && S.installed.some(v => v.id === w.instance)) selectVersion(w.instance, true);
      const versionId = $('#selVersion').value;
      startGame({ versionId, world: w.name, reason: '以存档「' + w.name + '」启动 ' + versionId + ' …' });
    });
    box.appendChild(item);
  });
}

/* 最近游玩：主进程在游戏进程成功拉起后记录（同名去重，最多 5 条） */
function renderRecent() {
  const box = $('#playList');
  const rec = (S.config && S.config.recent) || [];
  if (!rec.length) { box.innerHTML = '<div class="empty-sm">暂无记录</div>'; return; }
  box.innerHTML = '';
  rec.forEach(r => {
    const inst = S.installed.find(v => v.id === r.id);
    if (!inst) return; // 已删除的实例不再展示
    const item = el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-clock"/></svg></div>' +
      '<div class="mi-main"><b>' + esc(r.id) + '</b><span>' + fmtTime(r.time) + '</span></div>' +
      '<button class="btn ghost mi-act" title="快速启动"><svg class="ic sm" style="color:var(--acc2)"><use href="#i-play"/></svg></button>');
    item.querySelector('button').addEventListener('click', () => {
      selectVersion(r.id, true);
      startGame({ versionId: r.id });
    });
    box.appendChild(item);
  });
  if (!box.children.length) box.innerHTML = '<div class="empty-sm">暂无记录</div>';
}
function fmtTime(ts) {
  try {
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    return sameDay ? '今天 ' + hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  } catch (_) { return ''; }
}

/* ---------------- 扫描本地目录 ---------------- */
async function scanDir() {
  const r = await window.lmc.scan();
  S.installed = r.versions || [];
  S.broken = r.broken || [];
  S.saves = r.saves || [];
  $('#curGameDir').textContent = r.gameDir;
  $('#scanSummary').innerHTML = r.exists
    ? '已识别 <b>' + S.installed.length + '</b> 个版本 · <b>' + S.saves.length + '</b> 个存档' +
      (S.broken.length ? ' · <b style="color:var(--warn,#f59e0b)">' + S.broken.length + '</b> 个残留目录' : '')
    : '目录不存在，将在安装时自动创建';
  /* 残留目录提示：只说一次，避免每次扫描都弹（可在「实例」页处理） */
  if (S.broken.length && !S.brokenHinted) {
    S.brokenHinted = true;
    toast('检测到 ' + S.broken.length + ' 个未安装完成的残留目录（如 ' + S.broken[0].folder + '），已跳过；可到「实例」页删除', 'warn');
  }
  /* 恢复选中：本次会话选择 > 上次选择（重启记住） > 默认启动实例 > 留空 */
  const cur = $('#selVersion').value;
  refreshHome();
  const want = cur ||
    (S.config && S.config.lastVersion && S.installed.some(v => v.id === S.config.lastVersion) ? S.config.lastVersion : '') ||
    (S.config && S.config.defaultVersion && S.installed.some(v => v.id === S.config.defaultVersion) ? S.config.defaultVersion : '');
  if (want) selectVersion(want, false);
  rebuildWorldOptions();
  renderWorlds();
  refreshAuxSelects();
  renderRecent();
  if (S.manifest) renderVersionList(); /* 下载页的「已安装 / 残留」标记跟随扫描结果刷新 */
}
/* 光影页落点提示：明确写到哪个 shaderpacks，以及这个实例现在到底能不能用光影
   （原版实例装了光影也不会生效 —— 得先有 Iris / OptiFine，先讲清楚省得装完一脸问号） */
function updateShaderHint() {
  const box = $('#spHint'), sel = $('#spTarget');
  if (!box || !sel) return;
  const v = sel.value;
  const rootDir = ((S.config && S.config.gameDir) || '') + '\\shaderpacks';
  if (!v || v === '__all__') {
    box.innerHTML = '将装到游戏根目录的 <b>' + esc(rootDir) + '</b>，所有实例共用；' +
      '光影需要 <b>Iris</b> 或 <b>OptiFine</b> 才能在游戏内选中生效。';
    box.style.display = '';
    return;
  }
  const inst = S.installed.find(x => x.id === v);
  const ld = String((inst && inst.loader) || '').toLowerCase();
  const hasLoader = ld && ld !== 'vanilla';
  box.innerHTML = '将装到实例 <b>' + esc(v) + '</b> 的 shaderpacks' + (hasLoader
    ? '；该实例是 ' + esc(inst.loader) + '，装好 Iris（Fabric / Quilt / NeoForge 用）或 OptiFine 后即可在游戏内选中光影。'
    : '；该实例是<b>原版（无模组加载器）</b> —— 只装光影不会生效，还需要先给它装上 Iris 或 OptiFine。');
  box.style.display = '';
}
$('#spTarget') && $('#spTarget').addEventListener('change', updateShaderHint);

/* 资源页用的版本下拉（带加载器的版本排前）+ 数据包存档下拉 + 光影目标版本 */
function refreshAuxSelects() {
  const target = $('#resTarget');
  const dw = $('#dpWorld');
  const prevT = target.value, prevW = dw.value;
  const withLoader = S.installed.filter(v => v.loader && v.loader !== 'Vanilla');
  const rest = S.installed.filter(v => !withLoader.includes(v));
  const opts = (list) => list.map(v => '<option value="' + esc(v.id) + '">' +
    esc(v.id) + (v.loader !== 'Vanilla' ? ' (' + esc(v.loader) + ')' : '') + '</option>').join('');
  /* 目标版本：首项固定为「全部」（不筛 MC 版本与加载器，全站资源都能看到、都能直接安装）
   * 默认停在「全部」—— 下载时不需要先装版本；想按版本筛适配再手动选具体实例 */
  target.innerHTML = '<option value="__all__">全部</option>' + (opts(withLoader.concat(rest)) || '<option value="">（无已安装版本）</option>');
  /* 数据包存档下拉：实例隔离存档 value = "实例|世界名"，安装时写入实例目录的 datapacks */
  dw.innerHTML = S.saves.map(s =>
    '<option value="' + esc(s.instance ? s.instance + '|' + s.name : s.name) + '">' +
    esc(s.name) + (s.instance ? '（' + esc(s.instance) + '）' : '') + '</option>').join('') || '<option value="">（无存档，先启动一次游戏创建世界）</option>';
  /* 光影目标版本下拉：首项「全部」= 游戏根目录的 shaderpacks（所有实例共用）；
     选具体实例 → 装进该实例目录（版本隔离实例读的是 versions/<实例>/shaderpacks） */
  const sp = $('#spTarget');
  if (sp) {
    const prevS = sp.value;
    sp.innerHTML = '<option value="__all__">全部（游戏根目录）</option>' + (opts(S.installed) || '');
    if (prevS && (prevS === '__all__' || S.installed.some(v => v.id === prevS))) sp.value = prevS;
    updateShaderHint();
  }
  // 游戏设置：默认启动实例。优先级 = 本会话已选过 > 配置里的「默认启动实例」 > 主页当前选中的实例。
  // 最后那条兜底很要紧：不然玩家一直在玩 B，「游戏设置」却让他「先选一个实例才给设置」。
  const dv = $('#gsDefaultVer');
  const prevD = dv.value;
  dv.innerHTML = '<option value="">（每次启动时选择）</option>' + (opts(S.installed) || '');
  const homeId = $('#selVersion') ? $('#selVersion').value : '';
  if (prevD && S.installed.some(v => v.id === prevD)) dv.value = prevD;
  else if (S.config.defaultVersion && S.installed.some(v => v.id === S.config.defaultVersion)) dv.value = S.config.defaultVersion;
  else if (homeId && S.installed.some(v => v.id === homeId)) dv.value = homeId;
  // MOD 管理目标实例（支持版本隔离：选实例读 versions/<实例>/mods，全局读 mods/）
  const mt = $('#modTarget');
  const prevM = mt.value;
  mt.innerHTML = '<option value="">🌐 全局 mods 目录</option>' + (opts(withLoader.concat(rest)) || '');
  if (prevM && (prevM === '' || S.installed.some(v => v.id === prevM))) mt.value = prevM;
  /* 目标版本回填：保留用户选择；「全部」也保留；首次进入默认停在「全部」（不强制挑版本） */
  if (prevT === '__all__' || !prevT) target.value = '__all__';
  else if (S.installed.some(v => v.id === prevT)) target.value = prevT;
  else target.value = '__all__';
  if (prevW && S.saves.some(s => s.name === prevW)) dw.value = prevW;
  /* 导出卡（「导出整合包」tab）与加载器卡（基础设置）跟着最新的实例列表刷一遍 ——
     导出目标行读的就是上面刚回填好的「默认启动实例」。 */
  syncExportBtn();
  loadLoaderCard().catch(() => {});
}
/* ---------------- 存档管理页（启动旁 ⋮ / 侧栏「存档」进入） ---------------- */
const SAVE_HUB = { list: [], sel: -1 };
function fmtSizeB(n) {
  if (!n || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtFull(ts) {
  try {
    const d = new Date(Number(ts));
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch (_) { return '—'; }
}
/* ---------------- 工具箱：MC 实用网站资源集合 ---------------- */
const TOOL_SITES = [
  { g: '百科攻略', items: [
    { n: 'Minecraft Wiki', d: '最权威的中文百科', u: 'https://zh.minecraft.wiki' },
    { n: 'MC百科', d: '中文 Mod 百科镜像站', u: 'https://www.mcmod.cn' },
    { n: 'DigMinecraft', d: '全球通用教程站', u: 'https://www.digminecraft.com' }
  ] },
  { g: '模组与整合包', items: [
    { n: 'CurseForge', d: '全球最大 Mod 整合包平台', u: 'https://www.curseforge.com' },
    { n: 'Modrinth', d: '新兴开源 Mod 平台', u: 'https://modrinth.com' },
    { n: 'Planet Minecraft', d: '全球最大 MC 社区', u: 'https://www.planetminecraft.com' },
    { n: 'MCPEDL', d: '基岩版资源大全', u: 'https://mcpedl.com' }
  ] },
  { g: '玩家社区', items: [
    { n: 'MineBBS', d: '国内外 MC 中文论坛', u: 'https://www.minebbs.com' },
    { n: '苦力怕论坛', d: '资源丰富的中文社区', u: 'https://klpbbs.com' },
    { n: 'Bilibili MC', d: '视频教程 / 直播 / 攻略', u: 'https://www.bilibili.com' }
  ] },
  { g: '材质与光影', items: [
    { n: 'ResourcePack', d: '海量材质包下载', u: 'https://resourcepack.net' },
    { n: 'ShadersMods', d: '光影资源合集', u: 'https://shadersmods.com' },
    { n: 'Vanilla Tweaks', d: '原版增强调整包', u: 'https://vanillatweaks.net' }
  ] },
  { g: '地图与建筑', items: [
    { n: '投影工坊', d: 'Litematica 投影分享下载', u: 'https://www.mcimg.com' },
    { n: 'Plotz', d: '圆环 / 球体建筑生成', u: 'https://www.plotz.co.uk' },
    { n: 'Block Palettes', d: '方块配色方案库', u: 'https://www.blockpalettes.com' },
    { n: 'Minecraft Maps', d: '地图介绍与地图下载', u: 'https://www.minecraftmaps.com' }
  ] },
  { g: '在线工具', items: [
    { n: 'Chunkbase', d: '种子地图 / 结构定位', u: 'https://www.chunkbase.com' },
    { n: 'MCStacker', d: '命令生成器', u: 'https://mcstacker.net' },
    { n: 'MC Tools', d: '合成器 / 结构预览', u: 'https://mctools.org' },
    { n: 'Misode', d: '数据包 / 世界生成器', u: 'https://misode.github.io' },
    { n: 'mclo.gs', d: '游戏日志分析工具', u: 'https://mclo.gs' },
    { n: 'Minecraft Heads', d: '头颅数据库 /give 命令', u: 'https://minecraft-heads.com' },
    { n: 'Colorize FUN', d: 'MC 彩色文本生成器', u: 'https://colorize.fun' },
    { n: 'Textcraft', d: 'MC 风格 Logo 生成', u: 'https://textcraft.net' }
  ] },
  { g: '皮肤资源', items: [
    { n: 'NameMC', d: '正版皮肤 / UUID 查询', u: 'https://namemc.com' },
    { n: 'LittleSkin', d: '国内皮肤站', u: 'https://littleskin.cn' },
    { n: 'Nova Skin', d: '3D 皮肤编辑器', u: 'https://minecraft.novaskin.me' },
    { n: 'The Skindex', d: '正版皮肤分享社区', u: 'https://www.minecraftskins.com' },
    { n: 'SkinMC', d: '3D 皮肤编辑器 / 披风', u: 'https://skinmc.net' }
  ] },
  { g: '服务器与插件', items: [
    { n: 'FindMCServer', d: 'Mojang 官方服务器列表', u: 'https://findmcserver.com' },
    { n: 'MC Servers', d: '服务器排行榜', u: 'https://minecraftservers.org' },
    { n: 'SpigotMC', d: '服务端插件 (Spigot)', u: 'https://www.spigotmc.org' },
    { n: 'PaperMC', d: '高性能服务端 / 插件', u: 'https://papermc.io' }
  ] },
  { g: '资源导航', items: [
    { n: 'MC Versions', d: '原版版本下载站', u: 'https://mcversions.net' },
    { n: 'Fabric 官网', d: 'Fabric 加载器官网', u: 'https://fabricmc.net' },
    { n: 'Forge 官网', d: 'Forge 加载器下载', u: 'https://files.minecraftforge.net' },
    { n: 'NeoForge 官网', d: 'NeoForge 加载器官网', u: 'https://neoforged.net' }
  ] }
];
const TOOL_IC_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#6366f1'];
function renderTools(force) {
  const wrap = $('#toolsWrap');
  if (wrap.dataset.done && !force) return;
  wrap.innerHTML = TOOL_SITES.map(g =>
    '<h3 class="tools-group">' + esc(g.g) + '</h3>' +
    '<div class="tools-grid">' + g.items.map(it => {
      const dom = it.u.replace(/^https?:\/\//, '').split('/')[0];
      const c = TOOL_IC_COLORS[(it.n.charCodeAt(0) + dom.length) % TOOL_IC_COLORS.length];
      return '<a class="tool-card" href="javascript:void(0)" data-url="' + esc(it.u) + '" title="' + esc(it.u) + '">' +
        '<span class="tool-ic" data-dom="' + esc(dom) + '" style="background:' + c + '22;color:' + c + '">' + esc(it.n[0].toUpperCase()) + '</span>' +
        '<b>' + esc(it.n) + '</b><span>' + esc(it.d) + '</span></a>';
    }).join('') + '</div>').join('');
  wrap.dataset.done = '1';
  /* favicon 懒加载：站点 /favicon.ico → 国内镜像源 → 保留字母色块 */
  $$('#toolsWrap .tool-ic').forEach(el => {
    const dom = el.dataset.dom;
    const tryLoad = (src, next) => {
      const img = new Image();
      img.onload = () => { el.textContent = ''; el.style.background = '#fff'; el.appendChild(img); };
      img.onerror = next;
      img.src = src;
    };
    tryLoad('https://' + dom + '/favicon.ico', () =>
      tryLoad('https://api.iowen.cn/favicon/' + dom + '.png', () => {}));
  });
  /* 工具箱卡片是 <a href>，本来就在 GP_SEL 里，无需额外标记 */
  $$('#toolsWrap .tool-card').forEach(c =>
    c.addEventListener('click', () => {
      toast('正在打开：' + c.dataset.url);
      window.lmc.openUrl(c.dataset.url);
    }));
}

async function renderSavesPage(force) {
  const box = $('#savesList');
  if (force || !SAVE_HUB.list.length) {
    box.innerHTML = '<div class="empty-sm">扫描存档中…</div>';
    const r = await window.lmc.savesList();
    if (!r.ok) { box.innerHTML = '<div class="empty-sm">扫描失败：' + esc(r.error || '') + '</div>'; return; }
    SAVE_HUB.list = r.saves || [];
    SAVE_HUB.sel = -1;
    /* 同步主页存档数据（selWorld 下拉 / 我的存档卡片共用） */
    S.saves = SAVE_HUB.list.map(w => ({ name: w.name, path: w.path, instance: w.instance }));
  }
  box.innerHTML = '';
  if (!SAVE_HUB.list.length) {
    box.innerHTML = '<div class="empty-sm">没有找到存档<br><span style="font-size:11px">进入游戏创建世界后会出现在这里</span></div>';
    $('#savesDetail').innerHTML = '<div class="empty-sm">暂无存档</div>';
    return;
  }
  SAVE_HUB.list.forEach((w, i) => {
    const card = el('div', 'save-card' + (i === SAVE_HUB.sel ? ' sel' : ''),
      '<div class="save-thumb">' + (w.icon ? '<img src="' + w.icon + '" alt="">' : '<svg class="ic"><use href="#i-globe"/></svg>') + '</div>' +
      '<div class="sc-main"><b>' + esc(w.levelName || w.name) + '</b>' +
      '<span>' + (w.instance ? esc(w.instance) + ' · 版本隔离' : '全局存档') + (w.mcVersion ? ' · ' + esc(w.mcVersion) : '') + '</span>' +
      '<span>' + fmtSizeB(w.size) + ' · ' + (w.lastPlayed ? fmtFull(w.lastPlayed) : '从未进入') + (w.hardcore ? ' · <b style="color:#e5484d">硬核</b>' : '') + '</span></div>' +
      '<div class="sc-acts">' +
      '<button class="btn ghost" data-act="preview" title="地图预览"><svg class="ic sm"><use href="#i-map"/></svg></button>' +
      '<button class="btn ghost" data-act="folder" title="打开目录"><svg class="ic sm"><use href="#i-folder"/></svg></button>' +
      '<button class="btn ghost" data-act="del" title="删除（移入回收站）"><svg class="ic sm"><use href="#i-trash"/></svg></button>' +
      '</div>');
    const select = () => { SAVE_HUB.sel = i; $$('#savesList .save-card').forEach((c, j) => c.classList.toggle('sel', j === i)); showSaveDetail(w); };
    card.addEventListener('click', (e) => { if (!e.target.closest('button')) select(); });
    gpMark(card);                      /* 存档卡片整张可点 → 手柄也要够得着 */
    card.querySelector('[data-act=preview]').addEventListener('click', select);
    card.querySelector('[data-act=folder]').addEventListener('click', () => window.lmc.openPath(w.path));
    card.querySelector('[data-act=del]').addEventListener('click', () => deleteSave(w));
    box.appendChild(card);
  });
  /* 懒加载地图缩略图（没有游戏内截图的存档用生成的地图顶上），串行避免 I/O 风暴。
     ⚠️ 这里**不看**列表扫描时那份 hasRegion 快照：每张卡都现场问一次主进程
     （saves:preview 每次真扫 region 目录），否则「启动扫描之后才进过世界」的存档
     会一直顶着灰地球图标 —— 用户要求：预览一律自动检测区块文件，不存缓存。 */
  (async () => {
    for (const [i, w] of SAVE_HUB.list.entries()) {
      if (w.icon) continue;
      try {
        const pv = await window.lmc.savesPreview({ path: w.path });
        w.hasRegion = !!pv.ok;
        if (!pv.ok) continue;
        w.regions = pv.regions; w.dims = pv.dims;
        w._map = pv.png;
        const card = box.children[i];
        const thumb = card && card.querySelector('.save-thumb');
        if (thumb && !thumb.querySelector('img')) thumb.innerHTML = '<img src="' + pv.png + '" alt="">';
      } catch (_) {}
    }
  })();
}
/* 存档地图交互：滚轮以鼠标为锚点缩放 + 拖拽平移 + 双击/⟲ 复位 */
function setupMapZoom(box, img) {
  const view = el('div', 'map-view');
  img.replaceWith(view);
  view.appendChild(img);

  const tag = el('div', 'map-zoom-tag', '100%');
  const tools = el('div', 'map-tools');
  const mkBtn = (label, title, fn) => {
    const b = el('button', null, label); b.title = title; b.addEventListener('click', fn); tools.appendChild(b);
  };

  let s = 1, tx = 0, ty = 0;
  const MIN = 1, MAX = 12;
  const apply = () => {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    tag.textContent = Math.round(s * 100) + '%';
    view.classList.toggle('zoomed', s > 1.001);
  };
  const reset = () => { s = 1; tx = 0; ty = 0; apply(); };

  /* 放大后限制平移范围：图片至少留 80px 在视野内，避免拖丢 */
  const clampPan = () => {
    if (s <= 1) { tx = 0; ty = 0; return; }
    const W = img.offsetWidth, H = img.offsetHeight, VW = view.clientWidth, VH = view.clientHeight;
    const bx = (VW - W) / 2, by = (VH - H) / 2;   // 布局居中偏移
    const keep = 80;
    const lo = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
    tx = lo(tx, keep - (bx + s * W), VW - keep - bx);
    ty = lo(ty, keep - (by + s * H), VH - keep - by);
  };

  const zoomAt = (cx, cy, factor) => {
    const ns = Math.min(MAX, Math.max(MIN, s * factor));
    if (Math.abs(ns - s) < 1e-4) return;
    const r = img.getBoundingClientRect();
    const px = (cx - r.left) / s, py = (cy - r.top) / s;   // 鼠标点 → 图片自身坐标
    tx += px * (s - ns);
    ty += py * (s - ns);
    s = ns;
    if (s <= 1.001) { s = 1; tx = 0; ty = 0; } else clampPan();
    apply();
  };

  view.addEventListener('wheel', (e) => {
    if (!img.offsetWidth) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (s <= 1 || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty, id: e.pointerId };
    view.classList.add('dragging');
    try { view.setPointerCapture(e.pointerId); } catch (_) {}
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    tx = drag.tx + (e.clientX - drag.x);
    ty = drag.ty + (e.clientY - drag.y);
    clampPan(); apply();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null; view.classList.remove('dragging');
    try { view.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('dblclick', reset);

  const midZoom = (f) => { const r = view.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
  mkBtn('+', '放大', () => midZoom(1.4));
  mkBtn('−', '缩小', () => midZoom(1 / 1.4));
  mkBtn('⟲', '复位（双击地图亦可）', reset);

  view.appendChild(tag);
  view.appendChild(tools);
  apply();
}

async function showSaveDetail(w) {
  const d = $('#savesDetail');
  const gameType = ['生存', '创造', '冒险'][w.gameType] || w.gameType;
  const diffZh = { peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' };
  const diffTxt = w.difficultyName ? (diffZh[w.difficultyName] || w.difficultyName) : (['和平', '简单', '普通', '困难'][w.difficulty] || w.difficulty);
  const metaRows = [
    ['种子', (w.seed === null || w.seed === undefined) ? '—' : String(w.seed)],
    ['生成点', w.spawn ? 'X ' + w.spawn.x + ' · Y ' + w.spawn.y + ' · Z ' + w.spawn.z : '—'],
    ['游戏版本', w.mcVersion || '—'],
    ['模式', gameType + (w.hardcore ? ' · 硬核' : '') + ' · ' + diffTxt],
    ['已游玩', w.day + ' 个游戏日'],
    ['最后进入', w.lastPlayed ? fmtFull(w.lastPlayed) : '从未'],
    ['占用空间', fmtSizeB(w.size)],
    ['位置', w.instance ? w.instance + '（版本隔离）' : '全局 saves']
  ];
  d.innerHTML =
    '<h3 style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><svg class="ic sm"><use href="#i-map"/></svg> ' + esc(w.levelName || w.name) + '</h3>' +
    '<div class="map-box" id="saveMapBox"><div class="empty-sm">正在渲染已加载区块…</div></div>' +
    '<div class="meta-grid">' + metaRows.map(r => '<div class="k">' + r[0] + '</div><div class="v">' + esc(r[1]) + '</div>').join('') + '</div>' +
    '<div class="sc-btns">' +
    '<button class="btn primary" id="sdLaunch"><svg class="ic sm"><use href="#i-play"/></svg> 启动到此存档</button>' +
    '<button class="btn ghost" id="sdSeedMap"><svg class="ic sm"><use href="#i-external"/></svg> 种子地图</button>' +
    '<button class="btn ghost" id="sdCopySeed">复制种子</button>' +
    '<button class="btn ghost" id="sdFolder"><svg class="ic sm"><use href="#i-folder"/></svg> 打开目录</button>' +
    '<button class="btn ghost" id="sdDel" style="margin-left:auto"><svg class="ic sm"><use href="#i-trash"/></svg> 删除存档</button>' +
    '</div>';
  $('#sdLaunch').addEventListener('click', () => launchToWorld(w));
  $('#sdSeedMap').addEventListener('click', () => {
    if (w.seed === null || w.seed === undefined) { toast('该存档没有记录种子', 'warn'); return; }
    toast('正在打开种子地图（Chunkbase）…');
    window.lmc.openUrl('https://www.chunkbase.com/apps/seed-map#seed=' + w.seed);
  });
  $('#sdCopySeed').addEventListener('click', async () => {
    if (w.seed === null || w.seed === undefined) return toast('该存档没有记录种子', 'warn');
    const txt = String(w.seed);
    let okCopy = false;
    try { await navigator.clipboard.writeText(txt); okCopy = true; } catch (_) {}
    if (!okCopy) { try { okCopy = !!(await window.lmc.copyText(txt)); } catch (_) {} }
    if (okCopy) toast('种子已复制：' + txt); else toast('复制失败，请手动选择种子文本复制', 'error');
  });
  $('#sdFolder').addEventListener('click', () => window.lmc.openPath(w.path));
  $('#sdDel').addEventListener('click', () => deleteSave(w));
  const box = $('#saveMapBox');
  /* ⚠️ 别在这里拿列表扫描时缓存的 w.hasRegion 提前返回（那份快照是启动/上次刷新时扫的，
     而玩家随时会进世界、随手导入存档）。统一走 renderMap()，由主进程现场检测区块文件；
     真没有区块时它返回 noRegion，提示语在下面同一处给。用户要求：每次预览都自动检测，不用缓存。 */
  async function renderMap(dimKey) {
    if (dimKey !== undefined) w._dim = dimKey;
    box.innerHTML = '<div class="empty-sm">正在检测区块文件…</div>';
    try {
      const pv = await window.lmc.savesPreview({ path: w.path, dim: w._dim || '' });
      if (!pv.ok) {
        w.hasRegion = false;
        if (pv.noRegion) {
          box.innerHTML = '<div class="empty-sm">该存档还没有已加载的区块（尚未进入过世界）<br><span style="font-size:11px">进一次世界后再来预览</span></div>';
        } else {
          box.innerHTML = '<div class="empty-sm">' + esc(pv.error || '渲染失败') + '</div>';
        }
        return;
      }
      w.hasRegion = true; w.regions = pv.regions; w.dims = pv.dims;
      w._map = pv.png;
      box.innerHTML = '<img src="' + pv.png + '" alt="存档地图">';
      setupMapZoom(box, box.querySelector('img'));
      const cap = el('div', 'map-cap');
      if (pv.dims && pv.dims.length > 1) {
        const sel = el('select', 'dim-sel');
        sel.innerHTML = pv.dims.map(dd =>
          '<option value="' + esc(dd.key) + '"' + (dd.key === pv.dim ? ' selected' : '') + '>' + esc(dd.label) + '（' + dd.count + ' 个区块文件）</option>').join('');
        sel.addEventListener('change', () => renderMap(sel.value));
        cap.appendChild(sel);
      }
      cap.appendChild(el('span', null,
        esc((pv.dimLabel ? '【' + pv.dimLabel + '】' : '') + 'X ' + pv.bounds.x0 + '~' + pv.bounds.x1 + ' · Z ' + pv.bounds.z0 + '~' + pv.bounds.z1 +
          ' · 已加载区块 ' + pv.chunksLoaded + ' 个 · 深色 = 未探索') + (pv.spawnPx ? ' · <b style="color:#e5484d">红十字 = 生成点</b>' : '')));
      cap.appendChild(el('em', null, '滚轮缩放 · 拖拽平移 · 双击复位'));
      /* 重新检测：游戏还开着 / 刚存过档时点一下就能重新扫一遍区块文件（saves:preview 无缓存） */
      const re = el('button', 'btn ghost recheck', '<svg class="ic sm"><use href="#i-refresh"/></svg> 重新检测');
      re.title = '重新扫描这个存档的区块文件（不使用缓存）' +
        (pv.scannedAt ? ' · 本次检测 ' + new Date(pv.scannedAt).toTimeString().slice(0, 8) : '');
      re.addEventListener('click', () => renderMap());
      cap.appendChild(re);
      box.appendChild(cap);
    } catch (e) { box.innerHTML = '<div class="empty-sm">渲染失败: ' + esc(e.message) + '</div>'; }
  }
  renderMap(w._dim || '');
}
async function deleteSave(w) {
  if (!(await askConfirm('确定删除存档「' + (w.levelName || w.name) + '」吗？', { danger: true, detail: '整个存档目录会移入系统回收站（可在回收站还原），不影响其他存档。' }))) return;
  const r = await window.lmc.savesDelete({ path: w.path });
  if (!r.ok) { toast(r.error || '删除失败', 'error'); return; }
  SAVE_HUB.list = []; SAVE_HUB.sel = -1;
  await renderSavesPage(true);
  await scanDir();   // 同步主页的存档下拉与列表
}
function launchToWorld(w) {
  if (w.instance && S.installed.some(v => v.id === w.instance)) selectVersion(w.instance, true);
  const versionId = $('#selVersion').value;
  startGame({ versionId, world: w.name, reason: '以存档「' + w.name + '」启动 ' + versionId + ' …' });
}
$('#btnSaveHub').addEventListener('click', () => gotoPage('saves'));
$('#btnSaveBack').addEventListener('click', () => gotoPage('home'));
$('#btnSaveRefresh').addEventListener('click', () => { toast('正在重新扫描存档…'); renderSavesPage(true); });

$('#btnRescan').addEventListener('click', async () => { await scanDir(); toast('已重新扫描游戏目录'); });
/* 首页致谢：社会边Studio（点击前往抖音主页） */
$('#creditSsb').addEventListener('click', () => {
  window.lmc.openUrl('https://www.douyin.com/user/MS4wLjABAAAAMqBxn7WBQJcUA26bgPRDjk7Mgp3RZeRA7HUX3OEbLpI?from_tab_name=main');
  toast('正在打开抖音主页：社会边Studio');
});
$('#btnOpenDir').addEventListener('click', () => window.lmc.openPath(S.config.gameDir));

/* ---------------- 下载页 ---------------- */
/* 功能临时下架（FEATURE_OFF）：给被禁的分类 tab 打上 .tab-off 置灰。
   这里**只做标记、不动 active** —— active 的迁移放在下方 tab 点击 handler 绑定完成之后，
   用程序化 click() 走正常切换路径（内容区 / 标题 / dlCat / 懒加载全部一致），不会两处写断。
   游戏分类列表在这里手写（TYPE_GROUPS 定义在 dlCat 之后，提前引用会 TDZ 崩溃）。 */
const OFF_GAME_CATS = ['release', 'snapshot', 'old', 'all'];
$$('#dlTabs .tab').forEach(t => {
  const c = t.dataset.cat;
  const off = (FEATURE_OFF.downloadGame && OFF_GAME_CATS.includes(c)) || (FEATURE_OFF.modpack && c === 'modpack');
  if (!off) return;
  t.classList.add('tab-off');
  t.title = '该功能暂时下架';
});
/* 下载页当前分类：**读 DOM 的初始 active**（HTML 里默认标的是哪一个，这里就是哪一个）。
   写死成 'release' 会出现「HTML 标 active 的明明是「全部」、JS 却按正式版筛」的两处打架。 */
let dlCat = (($$('#dlTabs .tab.active')[0] || {}).dataset || {}).cat || 'release';
let dlQuery = '';
const TYPE_GROUPS = { release: ['release'], snapshot: ['snapshot'], old: ['old_beta', 'old_alpha'], all: ['release', 'snapshot', 'old_beta', 'old_alpha'] };

/* 分类指示条：绿色长条在标签下方滑动跟随当前选中项 */
function moveTabInd(tabsEl) {
  if (!tabsEl) return;
  let ind = tabsEl.querySelector('.tab-ind');
  if (!ind) { ind = document.createElement('i'); ind.className = 'tab-ind'; tabsEl.appendChild(ind); }
  const act = tabsEl.querySelector('.tab.active');
  if (!act) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.left = (act.offsetLeft + 8) + 'px';
  ind.style.width = (act.offsetWidth - 16) + 'px';
}
/* 内容区切换时的短淡入：避免整个列表「啪」地换掉（连点也能重播） */
function paneIn(el) {
  if (!el) return;
  el.classList.remove('pane-in');
  void el.offsetWidth;                    /* 强制重排 */
  el.classList.add('pane-in');
}
/* 下载页顶部标题随分类切换。
   以前标题写死为「下载游戏 · 官方版本清单…Vanilla/Fabric/Forge」，点 MOD / 整合包 /
   资源包 / 数据包 时顶栏纹丝不动 —— 用户会以为「页面没切过去，还是游戏下载」。 */
const DL_HEAD = {
  release: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  snapshot: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  old: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  all: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  mod: ['下载 MOD', '从 <b>Modrinth</b> / <b>CurseForge</b> 搜索模组，直接装入指定实例的 <b>mods</b> 文件夹'],
  modpack: ['下载整合包', '搜索整合包并一键下载安装，自动创建带加载器的实例'],
  resourcepack: ['下载资源包', '搜索资源包并装入游戏目录的 <b>resourcepacks</b>'],
  shader: ['下载光影', '从 <b>Modrinth</b> / <b>CurseForge</b> 搜索光影包，装进 <b>shaderpacks</b> 目录，游戏内用 <b>Iris / OptiFine</b> 选中即可生效'],
  datapack: ['下载数据包', '搜索数据包并装入指定存档的 <b>datapacks</b> 文件夹（进入世界后自动生效）']
};
function updateDlHead(cat) {
  const h = DL_HEAD[cat] || DL_HEAD.release;
  const t = $('#dlTitle'), s = $('#dlSub');
  if (t) t.textContent = h[0];
  if (s) s.innerHTML = h[1];
}
$$('#dlTabs .tab').forEach(t => t.addEventListener('click', () => {
  if (t.classList.contains('tab-off')) { toast('该功能暂时下架，敬请期待', 'warn'); return; }
  $$('#dlTabs .tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  moveTabInd($('#dlTabs'));
  dlCat = t.dataset.cat;
  updateDlHead(dlCat);
  const res = DL_RES_TABS[dlCat];
  // 版本列表 / 各资源区三选一显示；资源类隐藏版本列表与版本搜索框
  Object.values(DL_RES_TABS).forEach(x => { $('#' + x.area).style.display = 'none'; });
  $('#verList').style.display = res ? 'none' : '';
  $('#verSearch').closest('.searchbox').style.display = res ? 'none' : '';
  if (res) {
    const area = $('#' + res.area);
    area.style.display = '';
    paneIn(area);
    const pg = res.page();
    if (!pg.loaded) { pg.loaded = true; pg.search(); } // 首次切到该 tab 自动拉热门
  } else {
    $('#verList').style.display = '';
    paneIn($('#verList'));
    renderVersionList();
  }
}));
window.addEventListener('resize', () => moveTabInd($('#dlTabs')));
$('#verSearch').addEventListener('input', () => { dlQuery = $('#verSearch').value.trim().toLowerCase(); renderVersionList(); });
/* 功能临时下架的 active 迁移**不在**这里做：click handler 内部引用了后面才定义的
   DL_RES_TABS（const，TDZ），提前 click 会抛 ReferenceError 把 handler 与后续顶层初始化打断。
   迁移放在启动 IIFE 里（updateDlHead 旁，见 bootStep 流程末段），此时全部定义已就绪。 */

async function loadManifest() {
  $('#verList').innerHTML = '<div class="empty-sm">正在获取版本清单…</div>';
  const r = await window.lmc.getManifest();
  if (!r.ok) {
    $('#verList').innerHTML = '<div class="empty-sm">清单获取失败：' + esc(r.error) + '<br>请到设置中切换下载源后重试</div>';
    return;
  }
  S.manifest = r.manifest;
  S.manifestVia = r.via;
  renderVersionList();
}
function installedIds() { return new Set(S.installed.map(v => v.id)); }
/* 版本列表的一行。pinTag 非空 = 这一行来自顶部「置顶区」，会多一个徽标
   （如「最新正式版」「最新预览版」）并加 .pinned 类。 */
function verRow(v, pinTag, pinCls) {
  const installed = installedIds().has(v.id);
  const residual = !installed && (S.broken || []).some(b => b.folder === v.id);
  const row = el('div', 'ver-row' + (pinTag ? ' pinned' : ''),
    blockIconHtml(v.type) +
    '<div class="v-name">' + esc(v.id) +
      (pinTag ? '<span class="badge ' + (pinCls || '') + '">' + esc(pinTag) + '</span>' : '') +
      (residual ? '<span class="badge" style="background:rgba(245,158,11,.16);color:#f59e0b" title="上次安装未完成，留下的不完整目录；点安装会自动归档并重装">残留</span>' : '') + '</div>' +
    '<div class="v-type"><span class="pill ' + esc(v.type) + '">' + esc(typeName(v.type)) + '</span></div>' +
    '<div class="v-date">' + fmtDate(v.releaseTime) + '</div>' +
    '<div class="v-act"></div>');
  const act = row.querySelector('.v-act');
  if (installed) {
    act.innerHTML = '<span class="ok-tag"><svg class="ic sm"><use href="#i-check"/></svg>已安装</span>';
    const re = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-refresh"/></svg> 再装一份');
    re.title = '重新下载安装（可修复损坏的实例）或以自定义名称再装一份';
    re.addEventListener('click', () => openInstallModal(v, true));
    act.appendChild(re);
  } else {
    const btn = el('button', 'btn primary', '<svg class="ic sm"><use href="#i-download"/></svg> 安装');
    btn.addEventListener('click', () => openInstallModal(v));
    act.appendChild(btn);
  }
  /* 整行可点 = 点「安装」：以前只有那个小按钮能点，点行体没任何反应，
     既是鼠标用户的困惑源，也让手柄完全够不到这一行（见 GP_SEL 的 data-gpclick）。 */
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    openInstallModal(v, installed);
  });
  gpMark(row);
  return row;
}
/* 置顶条目：最新正式版 + 最新预览版。
   来源是版本清单自带的 latest.release / latest.snapshot（不是自己按日期猜）——
   「预览版」在这里指 latest.snapshot，即最新快照/预发布/候选版（26.4-snapshot-2 这类）。
   清单本身已按时间降序，所以正式版 tab 原本最新的就在第一行；置顶区的意义是
   **把这一对同时固定在最上面**，不用切 tab 就能一眼看到「现在最新的是什么」。
   搜索时不置顶（否则「明明没匹配，顶上却挂着两条」会让人以为搜索没生效）；
   远古版本 tab 也不置顶（那里是专门翻 b1.7.3 的，顶上塞个 26.3 只会添乱）。 */
function verPins() {
  if (dlQuery || dlCat === 'old') return [];
  const L = (S.manifest && S.manifest.latest) || {};
  const byId = new Map(S.manifest.versions.map(v => [v.id, v]));
  const out = [];
  [[L.release, '最新正式版', ''], [L.snapshot, '最新预览版', 'pin-preview']].forEach(([id, tag, cls]) => {
    if (id && byId.has(id) && !out.some(p => p.v.id === id)) out.push({ v: byId.get(id), tag, cls });
  });
  return out;
}
function renderVersionList() {
  const box = $('#verList');
  if (!S.manifest) return;
  box.innerHTML = '';
  const cats = TYPE_GROUPS[dlCat] || ['release'];
  const latest = S.manifest.latest && S.manifest.latest.release;
  const pins = verPins();
  const pinSet = new Set(pins.map(p => p.v.id));
  if (pins.length) {
    const wrap = el('div', 'ver-pin');
    wrap.appendChild(el('div', 'ver-pin-head', '置顶 · 当前最新版本'));
    pins.forEach(p => wrap.appendChild(verRow(p.v, p.tag, p.cls)));
    box.appendChild(wrap);
  }
  let list = S.manifest.versions.filter(v => dlQuery ? v.id.toLowerCase().includes(dlQuery) : cats.includes(v.type));
  /* 置顶区已经给过的那两条不重复出现在下面 */
  if (pinSet.size) list = list.filter(v => !pinSet.has(v.id));
  list.slice(0, 400).forEach(v => box.appendChild(verRow(v, v.id === latest ? '最新' : '')));
  if (!list.length) box.appendChild(el('div', 'empty-sm', '没有匹配的版本'));
  else if (list.length > 400) box.appendChild(el('div', 'empty-sm', '仅显示前 400 个结果，请使用搜索缩小范围'));
}

/* ---------------- 安装弹窗 ---------------- */
let modalVer = null, modalLoader = null, modalReinstall = false;
/* 用户在安装弹窗里选中的加载器版本（'' = 最新）。
   必须放在模块级：加载器兼容性探测回来会重绘整个弹窗，存在 DOM 里会被冲掉。 */
let modalBuild = '';
const modalMask = $('#modalMask'), modalBox = $('#modalBox');
/* 「开始安装」按钮的原始样子：安装中转后台后要能还原 */
const GO_IDLE_HTML = '<svg class="ic sm"><use href="#i-download"/></svg> 开始安装';

/* ---- 弹窗统一开合：进出场都有动画 + 遮罩点击分级 ----
 * openModal(maskClose)：
 *   maskClose === false → 该弹窗点遮罩空白不关闭（更新公告、账户引导等「必须看完/必须选择」的内容）。
 * closeModal()：先播 175ms 退场动画，再 display:none；用令牌防止「刚关又开」时旧定时器误伤新弹窗。 */
let modalClosing = false, modalCloseToken = 0;
/* 系统开了「减少动态效果」时，退场动画时长压到 0（不能让用户白等 180ms 才看到窗口消失） */
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let MODAL_EXIT_MS = REDUCED_MOTION ? 0 : 180;   /* 极速模式开启时也会压成 0（见 applyTurbo） */
function openModal(maskClose) {
  modalCloseToken++;                                  /* 作废上一次没播完的关闭定时器 */
  modalClosing = false;
  modalMask.classList.remove('closing');
  modalMask.dataset.maskClose = (maskClose === false) ? 'off' : 'on';
  modalMask.style.display = 'flex';
}
function closeModal() {
  if (!modalMask || modalMask.style.display === 'none' || modalClosing) return;
  modalClosing = true;
  modalMask.classList.add('closing');
  const token = modalCloseToken;
  setTimeout(() => {
    if (token !== modalCloseToken) return;            /* 期间又打开了新弹窗 → 不要动它 */
    modalMask.style.display = 'none';
    modalMask.classList.remove('closing');
    modalClosing = false;
    const box = $('#modalBox');
    if (box) box.classList.remove('cl-wide');         /* 更新公告专用的加宽只在公告里生效 */
    if (!installingNow) { modalVer = null; modalReinstall = false; modalBuild = ''; }
  }, MODAL_EXIT_MS);
}
/* 点空白但当前不允许关闭 → 抖一下给出反馈（不然用户会以为界面卡了） */
function modalNudge() {
  const box = $('#modalBox');
  if (!box) return;
  box.classList.remove('nudge');
  void box.offsetWidth;                               /* 强制重排：连点也能重播动画 */
  box.classList.add('nudge');
  setTimeout(() => box.classList.remove('nudge'), 400);
}
modalMask.addEventListener('click', e => {
  if (e.target !== modalMask) return;
  /* 下载/安装进行中：点空白不关闭（要退出请点「转入后台」，要中止请点「停止安装」） */
  if (installingNow) { modalNudge(); toast('正在下载，请用弹窗里的「转入后台」或「停止安装」按钮', 'warn'); return; }
  if (modalMask.dataset.maskClose === 'off') { modalNudge(); return; }
  closeModal();
});
/* Esc 与「点空白」同一套规则：不允许关的弹窗按 Esc 也只抖一下（不再像以前那样关得掉或关不掉全凭运气） */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || modalMask.style.display === 'none') return;
  if (installingNow) { modalNudge(); return; }
  if (modalMask.dataset.maskClose === 'off') { modalNudge(); return; }
  closeModal();
});
/* 安装中关闭弹窗 = 转入后台：主进程下载不中断，进度在右下角「下载任务」浮窗里看，完成时会 toast + 自动刷新 */
function closeToBackground() {
  closeModal();
  toast('安装已转入后台继续下载，进度见右下角「下载任务」浮窗；完成后会自动刷新版本列表', 'warn');
}

/* ---------------- 加载器「选择版本」通用组件 ----------------
 * 无论从哪个入口进（下载页「安装版本」弹窗 / 基础设置「更改加载器」弹窗），
 * 选版本的交互必须一模一样 —— 所以只写这一份，两个弹窗各自 mount 一次。
 *   · 默认项「最新」= 不传 build，由安装器自己取最新（与加这个功能之前的行为完全一致）
 *   · 版本多到需要找的时候（Forge 常有几百个 build）自动出现过滤框
 * 返回 { val(), sel }：val() 是当前选中的版本串（'' = 用最新）。 */
let loaderVerCache = new Map();   /* 'Fabric@1.21.4' → 接口结果；同一次弹窗内来回切换单选不重复联网 */
let loaderVerSeq = 0;             /* 竞态令牌：先点 Fabric 再点 Forge，Fabric 的响应不能覆盖 Forge 的列表 */
function resetLoaderVerCache() { loaderVerCache = new Map(); loaderVerSeq++; }
/* 取某加载器在某 MC 版本下能装的版本列表。
 * 单独包一层是为了**可打桩**：测试要避免真联网时替换这个顶层函数即可
 * （直接改 window.lmc.loaderBuilds 不行 —— contextBridge 暴露的对象是 frozen 的，赋值会静默失败）。 */
async function fetchLoaderBuilds(kind, mcVer) {
  try { return await window.lmc.loaderBuilds(kind, mcVer); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
/* opts.restore  ：重绘后要恢复的已选版本（加载器检测结果回来会重绘弹窗，不能把用户的选择冲掉）
   opts.onChange ：用户改动选中版本时回调 */
function mountLoaderVerPicker(host, kind, mcVer, opts) {
  const o = opts || {};
  host.style.display = '';
  host.innerHTML =
    '<span>加载器版本</span>' +
    '<div class="lver">' +
      '<select class="lver-sel"><option value="">正在获取版本列表…</option></select>' +
      '<input class="lver-flt" type="text" placeholder="过滤版本号…" spellcheck="false">' +
    '</div>';
  const sel = host.querySelector('.lver-sel');
  const flt = host.querySelector('.lver-flt');
  flt.style.display = 'none';
  const key = kind + '@' + mcVer;
  const token = ++loaderVerSeq;
  let restored = false;

  const fill = (list, latest) => {
    const q = flt.value.trim().toLowerCase();
    sel.innerHTML = '';
    const add = (val, text) => {
      const op = document.createElement('option');
      op.value = val; op.textContent = text;
      sel.appendChild(op);
    };
    add('', '最新' + (latest ? '（' + latest + '）' : ''));
    let n = 0;
    (list || []).forEach(it => {
      const s = String(it.v);
      if (q && s.toLowerCase().indexOf(q) < 0) return;
      add(s, s + (it.tag ? '   · ' + it.tag : ''));
      n++;
    });
    /* 过滤到一条不剩时给个占位项：空的 <select> 在部分主题下会塌成一条细线 */
    if (!n && q) add('', '没有匹配「' + flt.value.trim() + '」的版本');
    /* 首次填充时恢复用户已选版本（重绘前选的），之后就交给用户自己控制 */
    if (!restored) {
      restored = true;
      const want = String(o.restore || '');
      if (want) for (const op of sel.options) if (op.value === want) { sel.value = want; break; }
    }
    flt.style.display = (list || []).length > 24 ? '' : 'none';
  };

  const paint = (r) => {
    if (token !== loaderVerSeq) return;   /* 用户已经切到别的加载器，丢弃这个过期响应 */
    if (r && r.ok && r.list && r.list.length) { fill(r.list, r.latest); return; }
    const why = (r && (r.why || r.error)) || '未知原因';
    sel.innerHTML = '';
    const op = document.createElement('option');
    op.value = '';
    op.textContent = '最新（版本列表没拿到：' + why + '）';
    sel.appendChild(op);
    flt.style.display = 'none';
  };

  if (loaderVerCache.has(key)) paint(loaderVerCache.get(key));
  else {
    (async () => {
      const r = await fetchLoaderBuilds(kind, mcVer);
      /* 只缓存成功结果：失败多是网络抖动，用户切回来时重试一次比记住「失败」更有用 */
      if (r && r.ok) loaderVerCache.set(key, r);
      paint(r);
    })();
  }
  flt.addEventListener('input', () => {
    const r = loaderVerCache.get(key);
    if (r && r.ok) fill(r.list, r.latest);
  });
  sel.addEventListener('change', () => { if (typeof o.onChange === 'function') o.onChange(sel.value.trim()); });
  return { val: () => sel.value.trim(), sel };
}

function openInstallModal(v, reinstall) {
  modalVer = v;
  modalLoader = 'Vanilla';
  modalBuild = '';
  modalReinstall = !!reinstall;
  /* 先清掉上一版的结果，避免用户看到别的版本残留的结论 */
  loaderCompatOverride.delete(v.id);
  resetLoaderVerCache();   /* 每次重开弹窗都重新取版本列表（上游随时会发新版本） */
  renderModal();
  openModal(true);   /* 安装弹窗：没有任务在跑时点空白可以关（下载开始后由遮罩逻辑拦住） */
  /* 每次打开安装弹窗都实时查询一遍（用户要求：必须确认加载器是否适配、要实时同步）。
     默认选中 Vanilla（不需要联网），所以优先查「最可能用到」的 Fabric —— 它是新版本跟进
     最快的加载器，用户大概率会选它；其余加载器在后台并行补齐。 */
  refineLoaderCompat(v, () => { if (modalVer === v) { refreshModalLoaderOpts(); } }, { priority: 'Fabric' });
}
/* 实时确认各加载器对该版本的真实可用性，然后重渲染。
 * 除 Vanilla 外所有加载器都要查（规则差异太大，硬编码必错）；远古版没必要查。
 * 注意：不做跨次缓存，每次调用都重新联网 —— 「每次安装都要查询一次」。
 *
 * opts.priority = 当前选中的加载器名：先只查它、回来立刻重绘（用户最关心的那一条秒变确定），
 * 其余加载器在后台并行补齐，每回来一个就重绘一次。这样「… 检测中」的感知时间 = 1 个请求，
 * 而不是等最慢的那个（NeoForge 官方源被墙时以前要干等好几秒）。 */
async function refineLoaderCompat(v, rerender, opts) {
  if (!v || v.type === 'old_beta' || v.type === 'old_alpha') return; /* 远古版没必要查 */
  const priority = (opts && opts.priority && LOADER_VERSIONED[opts.priority]) ? opts.priority : null;
  const force = !(opts && opts.keepOld === true);
  if (force) loaderCompatOverride.delete(v.id);   /* 立刻失效旧结果，界面会显示「检测中」 */
  if (typeof rerender === 'function') rerender();
  const repaint = () => { if (typeof rerender === 'function') rerender(); };
  try {
    if (priority) {
      /* 第一优先：选中项单独查（并在途去重，切换来回点不会重复发请求） */
      const first = await probeOneLoader(priority, v.id, force);
      mergeLoaderResult(v.id, priority, first);
      repaint();
      /* 其余加载器后台补齐（不 await，避免拖住「选中项已经出结果」这件事） */
      const rest = Object.keys(LOADER_VERSIONED).filter(k => k !== priority);
      loaderCompatAsync(v, { kinds: rest, force, onOne: repaint }).catch(() => {});
      return;
    }
    await loaderCompatAsync(v, { force });
    repaint();
  } catch (_) {}
}
function compatOf(v) {
  const base = loaderCompat(v);
  const ov = loaderCompatOverride.get(v.id);
  return ov ? Object.assign({}, base, ov) : base;
}
/* 选中某个加载器后按需补查：结论已落地（非 pending）就什么都不做。
   在途去重（probeOneLoader）保证不会和后台那批重复发请求。 */
function maybeProbeSelected(v, _from) {
  if (!v || !modalLoader || !LOADER_VERSIONED[modalLoader]) return;
  const c = compatOf(v)[modalLoader];
  if (!c || !c.pending) return;
  const kind = modalLoader;
  probeOneLoader(kind, v.id, false).then(res => {
    mergeLoaderResult(v.id, kind, res);
    if (modalVer === v) refreshModalLoaderOpts();
  }).catch(() => {});
}
/* 单个加载器选项的 HTML（全量渲染与局部刷新共用一份，避免两处走样） */
function loaderOptHtml(L, cur, c) {
  return '<label class="loader-opt' + (L === cur ? ' sel' : '') + (c.ok ? '' : ' bad') + '">' +
    '<input type="radio" name="mloader" value="' + L + '"' + (L === cur ? ' checked' : '') + '>' +
    '<div class="lo-main"><b>' + L + '</b><span>' + LOADER_INFO[L] + '</span></div>' +
    '<span class="lo-stat ' + (c.ok ? 'ok' : 'bad') + '">' + (c.pending ? '… 检测中' : (c.ok ? '✓ 兼容' : (c.unknown ? '? 查询超时' : '✗ 不兼容'))) + '</span>' +
  '</label>';
}
function bindModalLoaderRadios(v) {
  modalBox.querySelectorAll('input[name=mloader]').forEach(r => {
    r.addEventListener('change', () => {
      modalLoader = r.value;
      modalBuild = '';   /* 换了加载器：之前选的版本号作废（Forge 的 47.4.23 对 Fabric 没有意义） */
      modalBox.querySelectorAll('.loader-opt').forEach(o => o.classList.remove('sel'));
      r.closest('.loader-opt').classList.add('sel');
      syncModalBuildLine(v);
      updateModalWarn();
      /* 用户点了别的加载器：若它还没确定结论，立刻优先查它（回来即重绘），
         不用等后台那批排队 —— 这也是「感知变快」的关键一步。 */
      maybeProbeSelected(v, 'mloader');
    });
  });
}
/* 探测结果回来时的刷新：**只重建加载器选项区**，不重建整个弹窗。
   整弹窗重建会把「加载器版本」下拉的已选版本、过滤框里刚打的字一起清掉
   （实测：一边过滤版本一边等探测结果回来，输入会被吃掉）。 */
function refreshModalLoaderOpts() {
  const box = $('#mLoaderOpts');
  if (!box || !modalVer) { if (modalVer) renderModal(); return; }
  const compat = compatOf(modalVer);
  box.innerHTML = LOADERS.map(L => loaderOptHtml(L, modalLoader, compat[L])).join('');
  bindModalLoaderRadios(modalVer);
  updateModalWarn();
}
function renderModal() {
  const v = modalVer;
  const compat = compatOf(v);
  let html =
    '<h3>安装 <b>' + esc(v.id) + '</b></h3>' +
    '<div class="mmeta">' + esc(typeName(v.type)) + ' · 发布于 ' + fmtDate(v.releaseTime) + ' · 清单来源: ' + esc(S.manifestVia === 'official' ? 'Mojang 官方' : 'BMCLAPI 镜像') + '</div>' +
    (modalReinstall ? '<div class="warnbar tip">将以「覆盖安装」方式重装（可用于修复损坏的实例）；想保留原实例请在「版本名称」填一个新名字</div>' : '') +
    '<div class="field-line modal-name"><span>版本名称（留空使用默认）</span><input type="text" id="mCustomName" maxlength="60" placeholder="' + esc(v.id) + '"></div>' +
    '<div style="font-size:12.5px;color:var(--tx2);margin-bottom:10px">选择模组加载器：</div>';
  html += '<div id="mLoaderOpts">' + LOADERS.map(L => loaderOptHtml(L, modalLoader, compat[L])).join('') + '</div>';
  html += '<div class="field-line" id="mBuildLine" style="display:none"></div>';
  html += '<div id="modalWarn"></div>';
  html += '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">准备中…</div></div>';
  html += '<div class="mfoot" id="mfoot">' +
    '<button class="btn ghost" id="mCancel">取消</button>' +
    '<button class="btn primary" id="mGo">' + GO_IDLE_HTML + '</button></div>';
  modalBox.innerHTML = html;

  bindModalLoaderRadios(v);
  $('#mCancel').addEventListener('click', () => { if (installingNow) doCancelInstall(); else closeModal(); });
  $('#mGo').addEventListener('click', startInstall);
  syncModalBuildLine(v);
  updateModalWarn();
  if (installingNow) markInstallingFoot();   /* 下载中重绘（加载器结论回来）也要保持「转入后台 / 停止安装」 */
}
/* 「安装版本」弹窗里的「加载器版本」下拉：只有能选版本的加载器才显示。
   已经挂着同一个加载器时**不重挂**（重挂会清掉用户刚选的版本和过滤框里的字）。 */
function syncModalBuildLine(v) {
  const host = $('#mBuildLine');
  if (!host) return;
  if (!v || !LOADER_PICKABLE[modalLoader]) {
    host.style.display = 'none'; host.innerHTML = ''; delete host.dataset.kind; return;
  }
  const key = modalLoader + '@' + v.id;
  if (host.dataset.kind === key && host.querySelector('.lver-sel')) return;
  host.dataset.kind = key;
  mountLoaderVerPicker(host, modalLoader, v.id, {
    restore: modalBuild,
    onChange: (val) => { modalBuild = val; }
  });
}
function updateModalWarn() {
  const v = modalVer;
  if (!v) return;
  const compat = compatOf(v);
  const c = compat[modalLoader];
  const w = $('#modalWarn');
  const go = $('#mGo');
  go.disabled = !c.ok;
  if (c.pending) {
    w.innerHTML = '<div class="warnbar tip">… 正在向 ' + modalLoader + ' 官方源确认 ' + esc(v.id) + ' 是否有可用构建</div>';
  } else if (!c.ok && c.unknown) {
    /* 查询超时 ≠ 不兼容：源太慢（Quilt 官方源国内 20s+）或网络抖动，别误导用户 */
    w.innerHTML = '<div class="warnbar tip">⚠ ' + modalLoader + ' 构建信息未能确认（' + esc(c.why) +
      '）—— 这不代表不兼容，可稍后重试。<button class="btn ghost sm" id="mRetryProbe" style="margin-left:8px">重新检测</button></div>';
    const rb = $('#mRetryProbe');
    if (rb) rb.addEventListener('click', () => {
      if (!modalVer) return;
      rb.disabled = true; rb.textContent = '正在重查…';
      refineLoaderCompat(modalVer, () => { if (modalVer === v) refreshModalLoaderOpts(); }, { priority: modalLoader });
    });
  } else if (!c.ok) {
    w.innerHTML = '<div class="warnbar err">✗ ' + modalLoader + ' 与 ' + esc(v.id) + ' 不兼容：' + esc(c.why) + '</div>';
  } else if (modalLoader === 'Fabric' || modalLoader === 'Quilt') {
    w.innerHTML = '<div class="warnbar tip">⚠ ' + modalLoader + ' 与 OptiFine 存在已知冲突，画质优化建议改用 Sodium / Iris 模组。</div>';
  } else if (modalLoader === 'OptiFine') {
    /* 新版 OptiFine 本质是 Forge/NeoForge 模组 —— 安装时会自动确保有前置加载器，
       然后把 OptiFine 放进该实例的 mods/（与玩家手动装法一致） */
    w.innerHTML = '<div class="warnbar tip">ℹ OptiFine 以模组形式安装：会先确保该版本装有 NeoForge 或 Forge，' +
      '再把 OptiFine 放进该实例的 mods/ 目录（与手动安装效果一致）。装好后选中该实例即可启动。</div>';
  } else {
    w.innerHTML = '';
  }
}
let installingNow = false;
/* 安装中的按钮态：主按钮变「转入后台」（点空白已拦掉，必须给用户明确出口），
   取消键变「停止安装」（红色，真能停主进程任务）。重绘弹窗时也会重新调用，保证状态不丢。 */
function markInstallingFoot() {
  const go = $('#mGo'), c = $('#mCancel');
  if (go) { go.disabled = false; go.className = 'btn ghost'; go.textContent = '转入后台'; }
  if (c) { c.disabled = false; c.className = 'btn danger'; c.textContent = '停止安装'; }
}
async function startInstall() {
  if (installingNow) { closeToBackground(); return; }   /* 下载中再点这个位置 = 转入后台 */
  installingNow = true;
  markInstallingFoot();
  $('#mprog').style.display = 'block';
  setStatus('安装中: ' + modalVer.id, true);
  try {
    /* 加载器版本：优先读下拉当前值（最准），读不到再退回记忆值；空 = 装最新 */
    const vsel = $('#mBuildLine .lver-sel');
    const build = (vsel ? vsel.value.trim() : (modalBuild || ''));
    const r = await window.lmc.install({ id: modalVer.id, loader: modalLoader, customName: $('#mCustomName').value.trim(), reinstall: modalReinstall, build: build || undefined });
    if (!r.started) { toast(r.reason || '任务已存在', 'warn'); installingNow = false; resetModalFoot(); }
  } catch (e) {
    toast('安装启动失败: ' + e.message, 'error');
    installingNow = false;
    resetModalFoot();
  }
}
/* 弹窗内「停止安装」：请求主进程终止该下载任务，install:done(cancelled) 回来后关弹窗 */
async function doCancelInstall() {
  if (!installingNow || !modalVer) return;
  const btn = $('#mCancel');
  if (btn) { btn.disabled = true; btn.textContent = '正在停止…'; }
  try {
    const r = await window.lmc.installCancel({ id: modalVer.id, loader: modalLoader });
    if (!r.ok) { toast(r.error || '无法停止该任务', 'warn'); installingNow = false; resetModalFoot(); }
  } catch (e) {
    toast('停止失败: ' + e.message, 'error');
    installingNow = false;
    resetModalFoot();
  }
}
function resetModalFoot() {
  const go = $('#mGo'), c = $('#mCancel');
  if (go) { go.disabled = false; go.className = 'btn primary'; go.innerHTML = GO_IDLE_HTML; }
  if (c) { c.disabled = false; c.className = 'btn ghost'; c.textContent = '取消'; }
  const p = $('#mprog'); if (p) p.style.display = 'none';
}
/* ---------------- 下载任务浮窗（PCL 式）：下载期间常驻右下角，点开可看进度/阶段/实时速度/预计剩余 ----------------
   速度与剩余时间不再从「进度百分比跳变」硬算（那会让大文件下载期间数字冻结在「预计剩余 1 秒」），
   而是读主进程 install:speed 推来的真实字节速率 + 当前阶段总字节。 */
const dlTask = { shown: false, exp: false, wrap: null, sum: null, bar: null, txt: null, p: 0, text: '', eta: '', bps: 0, bytes: 0, bytesTotal: 0, done: false };
function fmtSpeed(bps) {
  if (!(bps > 0)) return '';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s';
  return Math.round(bps) + ' B/s';
}
function fmtEta(sec) {
  if (!(sec > 0)) return '';
  if (sec < 60) return '预计剩余 ' + Math.max(1, Math.round(sec)) + ' 秒';
  if (sec < 3600) return '预计剩余 ' + Math.floor(sec / 60) + ' 分 ' + Math.round(sec % 60) + ' 秒';
  return '预计剩余 ' + (sec / 3600).toFixed(1) + ' 小时';
}
/* 剩余时间 = 当前阶段剩余字节 / 真实速度。拿不到总字节（natives 解压、安装器运行等阶段）就返回空 —— 
   宁可什么都不显示，也不给一个假的「1 秒」 */
function dlEtaText() {
  const bps = dlTask.bps, total = dlTask.bytesTotal, got = dlTask.bytes;
  if (!(bps > 4096) || !(total > 0)) return '';
  const left = total - got;
  if (left <= 0) return '';
  if (left < 524288) return '即将完成';
  return fmtEta(left / bps);
}
function dlTaskBuild() {
  const w = document.createElement('div');
  w.id = 'dlTaskPill';   /* 外观、进出场动画、展开过渡都在 styles.css 的 #dlTaskPill 规则里 */
  w.innerHTML =
    '<div class="dl-head">' +
    '<svg class="ic sm" style="color:#3ddc84;flex:none"><use href="#i-download"/></svg>' +
    '<b class="dl-title">下载任务</b>' +
    '<span class="dl-sum" id="dlPillSum"></span>' +
    '<span class="dl-chev" id="dlPillChev">详情 ▾</span></div>' +
    '<div class="dl-detail" id="dlPillDetail"><div>' +
    '<div class="prog" style="height:6px"><i id="dlPillBar" style="width:0%"></i></div>' +
    '<div class="dl-txt" id="dlPillTxt"></div></div></div>';
  w.addEventListener('click', () => {
    dlTask.exp = !dlTask.exp;
    w.querySelector('#dlPillChev').textContent = dlTask.exp ? '收起 ▴' : '详情 ▾';
    dlTaskRender();
  });
  gpMark(w);                           /* 下载浮窗（展开 / 收起）也要能手柄操作 */
  document.body.appendChild(w);
  dlTask.wrap = w;
  dlTask.sum = w.querySelector('#dlPillSum');
  dlTask.bar = w.querySelector('#dlPillBar');
  dlTask.txt = w.querySelector('#dlPillTxt');
}
function dlTaskRender() {
  if (!dlTask.wrap || dlTask.done) return;
  dlTask.wrap.classList.toggle('exp', dlTask.exp);   /* 展开/收起交给 CSS 行高过渡，不再 display 硬切 */
  dlTask.bar.style.width = dlTask.p + '%';
  const sp = fmtSpeed(dlTask.bps);
  const eta = dlEtaText();
  dlTask.eta = eta;
  dlTask.sum.textContent = dlTask.p + '%' + (sp ? ' · ↓ ' + sp : '');
  dlTask.txt.textContent = dlTask.text + (sp ? ' · ↓ ' + sp : '') + (eta ? ' · ' + eta : '') +
    '（进度条按整体安装流程计算，各阶段快慢不同）';
}
function dlTaskShow(d) {
  if (dlTask.done) return;   /* 任务已结束：别让尾随的进度事件把「完成」文案覆盖回去 */
  dlTask.p = d.percent || 0;
  dlTask.text = d.text || d.stage || '下载中';
  if (!dlTask.shown) {
    dlTaskBuild(); dlTask.shown = true;
    dlTask.bps = 0; dlTask.bytes = 0; dlTask.bytesTotal = 0;
  }
  dlTaskRender();
}
function dlTaskFinish(ok, errMsg, cancelled) {
  if (!dlTask.shown || dlTask.done) return;
  dlTask.done = true;
  dlTask.p = ok ? 100 : dlTask.p;
  dlTask.eta = '';
  dlTask.text = ok ? '✓ 下载完成' : (cancelled ? '已取消安装' : '✗ 下载失败' + (errMsg ? '：' + errMsg : ''));
  dlTask.wrap.querySelector('#dlPillSum').textContent = ok ? '100% · 完成' : '失败';
  dlTask.wrap.querySelector('#dlPillChev').textContent = '';
  dlTask.bar.style.width = dlTask.p + '%';
  dlTask.bar.style.background = ok ? '#3ddc84' : '#ff5c5c';
  dlTask.txt.textContent = dlTask.text;
  /* 结束：先淡出下滑（.out），再真正移除 —— 以前是「啪」地凭空消失 */
  setTimeout(() => { if (dlTask.wrap) dlTask.wrap.classList.add('out'); }, 3600);
  setTimeout(() => {
    if (dlTask.wrap) dlTask.wrap.remove();
    dlTask.shown = false; dlTask.done = false; dlTask.bps = 0; dlTask.bytes = 0; dlTask.bytesTotal = 0;
  }, 4000);
}

/* 安装弹窗里的进度行（stage / 文本 / 百分比 / 实时速度 / 剩余时间）统一在这里渲染，
   进度事件与速度事件都调它，避免互相覆盖 */
let mpLast = { stage: '', text: '', percent: 0 };
function renderMpStatus() {
  const bar = $('#mpBar'), txt = $('#mpText');
  if (!bar || !txt) return;
  bar.style.width = (mpLast.percent || 0) + '%';
  const sp = fmtSpeed(dlTask.bps);
  const eta = dlEtaText();
  txt.textContent = '[' + mpLast.stage + '] ' + mpLast.text +
    (mpLast.percent ? ' · ' + mpLast.percent + '%' : '') +
    (sp ? ' · ↓ ' + sp : '') + (eta ? ' · ' + eta : '');
}
window.lmc.on('install:progress', (d) => {
  mpLast = { stage: d.stage || '', text: d.text || '', percent: d.percent || 0 };
  if (!dlTask.done) renderMpStatus();
  dlTaskShow(d);
});
/* 主进程每 500ms 推一次真实下载速率（字节/秒）与阶段字节进度 */
window.lmc.on('install:speed', (d) => {
  dlTask.bps = d.bps || 0;
  dlTask.bytes = d.bytes || 0;
  dlTask.bytesTotal = d.bytesTotal || 0;
  if (dlTask.done) return;
  if (dlTask.shown) dlTaskRender();
  renderMpStatus();
});
window.lmc.on('install:done', async (d) => {
  installingNow = false;
  dlTaskFinish(!!d.ok, d.error || '', !!d.cancelled);
  if (d.ok) {
    closeModal();
    await scanDir();
    if (d.versionId) selectVersion(d.versionId, true);
  } else if (d.cancelled) {
    closeModal(); /* 停止安装：关弹窗并刷新（半截目录会以残留徽标显示，下次安装自动归档） */
    await scanDir();
  } else {
    resetModalFoot();
  }
});

/* ---------------- 导入页 ---------------- */
$('#btnImportDir').addEventListener('click', async () => {
  const dir = await window.lmc.pickFolder();
  if (!dir) return;
  S.config = await window.lmc.saveConfig({ gameDir: dir });
  $('#setGameDir').value = dir;
  await scanDir();
  await loadManifest();
  toast('已切换游戏目录并完成扫描: ' + dir);
});

/* ---------------- 设置页 ---------------- */
$$('#page-settings input[name=src]').forEach(r => {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    S.config = await window.lmc.saveConfig({ source: r.value });
    $('#tbSource').textContent = r.value === 'official' ? '官方源' : r.value === 'custom' ? '自定义源' : 'BMCLAPI';
    updateStatusBarRight();
    toast('下载源已切换，正在刷新版本清单…');
    loadManifest();
  });
});
$('#setCustomSrc').addEventListener('change', async () => {
  const v = $('#setCustomSrc').value.trim();
  S.config = await window.lmc.saveConfig({ customSource: v, source: v ? 'custom' : 'bmclapi' });
  $('#tbSource').textContent = v ? '自定义源' : 'BMCLAPI';
  toast(v ? '已使用自定义镜像源' : '已恢复 BMCLAPI 镜像源');
  loadManifest();
});
$('#setMem').addEventListener('input', () => { $('#memVal').textContent = $('#setMem').value + ' GB'; });
$('#btnPickDir').addEventListener('click', async () => {
  const dir = await window.lmc.pickFolder();
  if (dir) $('#setGameDir').value = dir;
});
/* 设置页「打开」= 打开输入框里的目录（可能是还没保存的新路径）。
   注意 id 不能与诊断页那个 btnOpenDir 重名：$('#id') 只取第一个匹配，
   重名会让两段处理器都绑到诊断页按钮上、设置页按钮彻底失灵（审计 B1）。 */
$('#btnOpenGameDir').addEventListener('click', () => {
  const d = $('#setGameDir').value.trim();
  if (d) window.lmc.openPath(d).catch(() => toast('打不开该目录', 'warn'));
});
$('#btnOpenData').addEventListener('click', () => {
  const d = $('#setDataDir').value.trim();
  if (d) window.lmc.openPath(d).catch(() => toast('打不开该目录', 'warn'));
});
/* 内存三选一：选「自定义」才显示滑块（照 PCL 的内存分配卡） */
function syncMemMode() {
  const sel = document.querySelector('#page-settings input[name=memMode]:checked');
  const custom = sel && sel.value === 'custom';
  const row = $('#memCustomRow');
  if (row) row.style.display = custom ? '' : 'none';
}
$$('#page-settings input[name=memMode]').forEach(r => r.addEventListener('change', syncMemMode));
/* 离线皮肤卡：显示当前账户名 / 皮肤文件 / 模型，并支持就地挑选与清除 */
async function refreshSkinCard() {
  try {
    const r = await window.lmc.accountList();
    const acc = (r.accounts || []).find(a => a.name === r.active);
    if (!acc) { $('#skinAccName').textContent = '（尚未创建账户）'; $('#setSkinFile').value = ''; return; }
    $('#skinAccName').textContent = acc.name + (acc.type === 'ms' ? '（微软正版）' : acc.type === 'authlib' ? '（外置登录）' : '（离线）');
    $('#setSkinModel').value = acc.model === 'slim' ? 'slim' : 'classic';
    $('#setSkinFile').value = acc.skinUrl ? '已设置（' + (acc.model === 'slim' ? '苗条' : '经典') + '模型）' : '';
    const disabled = acc.type === 'ms' || acc.type === 'authlib';
    ['#btnSkinPick', '#btnSkinClear', '#setSkinModel'].forEach(s => { const el = $(s); if (el) el.disabled = disabled; });
    $('#setSkinFile').placeholder = disabled ? '该账户的皮肤由官方 / 认证服务器提供' : '未设置（使用游戏默认皮肤）';
  } catch (_) {}
}
$('#btnSkinPick').addEventListener('click', async () => {
  const r = await window.lmc.accountSkin({ name: S.config.activeAccount });
  if (r.canceled) return;
  if (!r.ok) { toast(r.error || '设置皮肤失败', 'error'); return; }
  toast('皮肤已设置');
  await refreshSkinCard();
  heroHeadFor(S.config.username);
});
$('#btnSkinClear').addEventListener('click', async () => {
  const yes = await askConfirm('清除皮肤', '确定清除当前账户的自定义皮肤吗？清除后将使用游戏默认皮肤。', '清除', true);
  if (!yes) return;
  const r = await window.lmc.accountSkinRemove({ name: S.config.activeAccount });
  if (!r.ok) { toast(r.error || '清除失败', 'error'); return; }
  toast('皮肤已清除');
  await refreshSkinCard();
  heroHeadFor(S.config.username);
});
$('#setSkinModel').addEventListener('change', async () => {
  const r = await window.lmc.accountModel({ name: S.config.activeAccount, model: $('#setSkinModel').value });
  if (r && r.ok === false) { toast(r.error || '切换失败', 'warn'); return; }
  toast('皮肤模型已切换（' + ($('#setSkinModel').value === 'slim' ? '苗条' : '经典') + '）');
  await refreshSkinCard();
});
$('#btnSkinToAccount').addEventListener('click', () => gotoPage('account'));
/* 配置迁移与缓存 */
$('#btnExportCfg').addEventListener('click', async () => {
  const r = await window.lmc.exportConfig();
  if (r.canceled) return;
  toast(r.ok ? '设置已导出: ' + r.path : ('导出失败: ' + (r.error || '未知错误')), r.ok ? undefined : 'error');
});
$('#btnImportCfg').addEventListener('click', async () => {
  const r = await window.lmc.importConfig();
  if (r.canceled) return;
  if (!r.ok) { toast('导入失败: ' + (r.error || '未知错误'), 'error'); return; }
  toast('设置已导入，正在重新加载…');
  setTimeout(() => location.reload(), 600);
});
$('#btnClearCache').addEventListener('click', async () => {
  const yes = await askConfirm('清理缓存', '将删除下载缓存与图标缓存（不动存档 / 模组 / 账户）。继续吗？', '清理', true);
  if (!yes) return;
  const r = await window.lmc.clearCache();
  toast(r.ok ? ('已清理 ' + (r.freed || 0) + ' 项缓存' + (r.bytes ? '（' + Math.round(r.bytes / 1048576) + ' MB）' : '')) : ('清理失败: ' + (r.error || '')), r.ok ? undefined : 'error');
});
/* 开源许可与致谢：正文在 asar 里，用户点不开文件 —— 由主进程读出来在弹窗里显示。
   小型 markdown 渲染：只认标题 / 列表 / 表格分隔 / 粗体，够读许可声明即可。 */
function renderLicMd(src) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  const out = [];
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^---+$/.test(line)) { out.push('<hr>'); continue; }
    let m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) { out.push('<h' + (m[1].length + 1) + '>' + inline(m[2]) + '</h' + (m[1].length + 1) + '>'); continue; }
    /* 表格行：跳过分隔行，单元格单独成段 */
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      const cells = line.replace(/^\||\|$/g, '').split('|').map(x => inline(x.trim())).filter(Boolean);
      if (cells.length) out.push('<p class="lic-md-tr">' + cells.join(' <span class="lic-md-sep">·</span> ') + '</p>');
      continue;
    }
    m = line.match(/^[-*]\s+(.*)$/);
    if (m) { out.push('<p class="lic-md-li">• ' + inline(m[1]) + '</p>'); continue; }
    /* 缩进 2 格以上的续行也算正文 */
    out.push('<p>' + inline(line) + '</p>');
  }
  return out.join('');
}
$('#btnViewLicenses').addEventListener('click', async () => {
  const r = await window.lmc.getLicenses();
  /* Terracotta 是随包带出去的二进制（AGPL-3.0 + 例外），它的许可正文副本也要能在这里看到。
     正文是 GNU 的纯文本条款，原样放进 <pre>（不做 markdown 转换，免得条款被改写）。 */
  const tcLic = (r && r.terracottaLicense) ? String(r.terracottaLicense) : '';
  const body = r && r.ok
    ? '<div class="lic-doc">' +
        '<p class="lic-doc-head"><b>' + esc(r.name || 'XLC') + '</b> ' + esc(r.version || '') + '</p>' +
        '<h4>本程序许可（MIT）</h4>' + renderLicMd(r.license) +
        '<h4>第三方组件与致谢</h4>' + renderLicMd(r.thirdParty) +
        (tcLic
          ? '<h4>Terracotta 许可正文（AGPL-3.0，随程序分发副本）</h4>' +
            '<details class="lic-verbatim-box"><summary>展开查看完整法律条款</summary>' +
            '<pre class="lic-verbatim">' + esc(tcLic) + '</pre></details>'
          : '') +
      '</div>'
    : '<p class="hint">读取许可声明失败。</p>';
  modalBox.innerHTML =
    '<h3><svg class="ic sm"><use href="#i-list"/></svg> 开源许可与致谢</h3>' +
    '<div class="lic-scroll">' + body + '</div>' +
    '<div class="mfoot"><button class="btn ghost" id="licClose">关闭</button></div>';
  openModal(true);
  const c = $('#licClose'); if (c) c.addEventListener('click', closeModal);
});
$('#btnSaveSettings').addEventListener('click', async () => {
  const w = parseInt($('#setWinW').value, 10) || 0;
  const h = parseInt($('#setWinH').value, 10) || 0;
  const memSel = document.querySelector('#page-settings input[name=memMode]:checked');
  S.config = await window.lmc.saveConfig({
    javaPath: $('#setJavaPath').value.trim(),
    mem: parseInt($('#setMem').value, 10) || 4,
    memAuto: !(memSel && memSel.value === 'custom'),
    jvmArgs: $('#setJvm').value.trim(),
    gameArgs: $('#setGameArgs').value.trim(),
    preLaunchCmd: $('#setPreCmd').value.trim(),
    winTitle: $('#setWinTitle').value.trim(),
    winSize: { w, h, max: $('#setWinMax').checked },
    forceIsolate: $('#setIsolate').value,
    procPriority: $('#setProcPrio').value,
    launcherVisibility: $('#setLaunchVisib').value,
    forceChinese: $('#setChinese').checked,
    gpuPref: $('#setGpuPref').checked,
    speedLimit: Math.min(Math.max(parseInt($('#setSpeedLimit').value, 10) || 0, 0), 1000000),
    gameDir: $('#setGameDir').value.trim(),
    username: $('#setUsername').value.trim() || 'Steve',
    dlThreads: Math.min(Math.max(parseInt($('#setDlThreads').value, 10) || 16, 1), 64),
    dlConcurrency: Math.min(Math.max(parseInt($('#setDlConcurrency').value, 10) || 32, 4), 64)
  });
  $('#inpName').value = S.config.username;
  $('#heroName').textContent = S.config.username;
  heroHeadFor(S.config.username);
  updateStatusBarRight();
  toast('设置已保存');
  await scanDir();
});
/* 版本更新：检测 / 打开下载页 / 自动检测开关（更新源已锁定，设置页只读展示） */
$('#btnCheckUpdate').addEventListener('click', () => { UPD.autoTried = true; checkUpdateNow(false); });
/* 「打开下载页」一律打开官网下载页：
   即使这次检测走的是 GitHub（pageUrl 是 Release 页面），也不把用户导到 GitHub 去 ——
   官网下载页才是对外的分发口，页面上列着各版本与网盘直链。 */
function updateOpenPageUrl() {
  return (S.config && S.config.updateDefaultUrl) || (UPD.info && UPD.info.pageUrl) || '';
}
$('#btnUpdOpenPage').addEventListener('click', () => {
  const u = updateOpenPageUrl();
  if (!u) { toast('下载页地址缺失', 'warn'); return; }
  window.lmc.openUrl(u).catch(() => toast('无法打开下载页', 'error'));
});
/* 更新检测地址：1.2 起界面上不再显示这一行（内置并锁定，GitHub Releases 优先、官方下载页兜底），
   但输入框仍保留在 DOM 里做兜底：主进程会拒绝任何非官方地址，这里万一被改 DOM 写入也回弹官方地址。 */
function lockUpdateUrlField() {
  const el = $('#setUpdateUrl');
  if (!el) return;
  const official = () => (S.config && S.config.updateDefaultUrl) || '';
  const sync = () => { const o = official(); if (o && el.value !== o) el.value = o; };
  el.readOnly = true;
  sync();
  el.addEventListener('change', () => { sync(); if (official()) toast('更新源已锁定，不可修改', 'warn'); });
  el.addEventListener('input', sync);
}
lockUpdateUrlField();
$('#setAutoUpd').addEventListener('change', async () => {
  S.config = await window.lmc.saveConfig({ autoCheckUpdate: $('#setAutoUpd').checked });
  toast($('#setAutoUpd').checked ? '已开启启动时自动检测更新' : '已关闭启动时自动检测更新');
});
/* 跳过快照版更新：只影响「预发布会不会被提示」，正式版更新照旧。
   开关一改就自动重新检测一次，结果区与下面的版本回退区立刻按新设置刷新
   （开着的时候还会给出「回退到最新正式版」的入口），不用再手点「检测更新」 */
$('#setSkipPreUpd').addEventListener('change', async () => {
  const on = $('#setSkipPreUpd').checked;
  S.config = await window.lmc.saveConfig({ skipPreviewUpdate: on });
  toast(on ? '已开启跳过快照版更新：只提示正式版更新，正在重新检测…' : '已关闭跳过快照版更新：快照版也会提示，正在重新检测…');
  UPD.info = null;
  await checkUpdateNow(true);
});
/* 更新公告：随时查看本版本改了什么 */
$('#btnUpdChangelog').addEventListener('click', () => showChangelog());
$('#btnDetectJava').addEventListener('click', detectJavaUI);
async function detectJavaUI() {
  $('#javaList').innerHTML = '<div class="empty-sm">检测中…</div>';
  const list = await window.lmc.detectJava();
  S.javaMajor = list.length ? list[0].major : null;
  updateStatusBarRight();
  const box = $('#javaList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-sm">未检测到 Java · 请安装 Java 17+ 或手动填写路径</div>';
    return;
  }
  list.forEach(j => {
    box.appendChild(el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-cpu"/></svg></div>' +
      '<div class="mi-main"><b>Java ' + j.major + (j.major >= 17 ? '' : ' （低于推荐）') + '</b><span>' + esc(j.path) + '</span></div>' +
      '<button class="btn ghost mi-act">使用</button>'));
    box.lastChild.querySelector('button').addEventListener('click', () => {
      $('#setJavaPath').value = j.path;
      toast('已选择: ' + j.path);
    });
  });
}

/* 测速 */
$('#btnPing').addEventListener('click', () => pingSources(false));
$('#btnPingAuto').addEventListener('click', () => pingSources(true));
async function pingSources(autoPick) {
  const lo = $('#latOfficial'), lb = $('#latBmclapi');
  lo.textContent = '…'; lb.textContent = '…';
  lo.className = 'lat'; lb.className = 'lat';
  setStatus('正在测速…', true);
  const [ro, rb] = await Promise.all([
    window.lmc.pingSource('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'),
    window.lmc.pingSource('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json')
  ]);
  setLat(lo, ro); setLat(lb, rb);
  setStatus('就绪');
  if (autoPick) {
    let pick = null;
    if (ro.ok && rb.ok) pick = ro.ms <= rb.ms ? 'official' : 'bmclapi';
    else if (ro.ok) pick = 'official';
    else if (rb.ok) pick = 'bmclapi';
    if (pick) {
      S.config = await window.lmc.saveConfig({ source: pick });
      $$('#page-settings input[name=src]').forEach(r => { r.checked = r.value === pick; });
      $('#tbSource').textContent = pick === 'official' ? '官方源' : 'BMCLAPI';
      updateStatusBarRight();
      toast('已自动选择最快源: ' + (pick === 'official' ? 'Mojang 官方' : 'BMCLAPI'));
      loadManifest();
    } else {
      toast('两个源均不可达，请检查网络', 'error');
    }
  }
}
function setLat(elm, r) {
  if (!r.ok) { elm.textContent = '不可达'; elm.className = 'lat fail'; return; }
  elm.textContent = r.ms + ' ms';
  elm.className = 'lat' + (r.ms > 500 ? ' slow' : '');
}

/* ---------------- MOD / 整合包下载页（Modrinth，两页共用内核） ---------------- */
const RES_PAGE_SIZE = 20;
/* 「全部」模式下自动挑一个能装 MOD 的实例：默认实例优先，其次最近启动过的带加载器实例 */
function pickModInstance() {
  const LD_OK = ['fabric', 'forge', 'quilt', 'neoforge'];
  const okList = S.installed.filter(v => v.loader && LD_OK.includes(String(v.loader).toLowerCase()));
  if (!okList.length) return '';
  const def = S.config && S.config.defaultVersion;
  if (def && okList.some(v => v.id === def)) return def;
  if (S.config && S.config.lastVersion && okList.some(v => v.id === S.config.lastVersion)) return S.config.lastVersion;
  return okList[0].id;
}
function setupResPage(cfg) {
  let query = '', timer = null, page = 1, total = 0, fallback = false;
  let composing = false, seq = 0;
  /* MOD 页可切换下载源：modrinth | curseforge | all（综合 = 两源合并，按下载量降序）
     默认值直接读 HTML 上带 .active 的按钮（当前是「综合」），避免两处写死互相失配 */
  let source = (function () {
    if (!cfg.sourceSel) return 'modrinth';
    const a = $(cfg.sourceSel + ' button.active');
    return (a && a.dataset.src) || 'modrinth';
  })();
  const SRC_LABEL = { modrinth: 'Modrinth', curseforge: 'CurseForge', all: '综合' };
  const srcName = () => SRC_LABEL[source] || 'Modrinth';
  /* 页面级文案里的源称呼：综合模式要说清是「两源一起查」，而不是「综合 源不可达」这种别扭说法 */
  const srcText = () => (source === 'all' ? 'Modrinth + CurseForge' : srcName());
  /* 「综合」模式下每条结果自带来源（h.src），卡片/安装/详情都按条走，不能再用页面级的 source */
  const itemSrc = (h) => ((h && h.src) ? h.src : source);
  const itemSrcLabel = (h) => SRC_LABEL[itemSrc(h)] || srcName();
  if (cfg.sourceSel) {
    $$(cfg.sourceSel + ' button').forEach(b => b.addEventListener('click', () => {
      if (source === b.dataset.src) return;
      source = b.dataset.src;
      $$(cfg.sourceSel + ' button').forEach(x => x.classList.toggle('active', x === b));
      newSearch();
    }));
  }
  const TYPE_NAME = { mod: 'MOD', modpack: '整合包', resourcepack: '资源包', shader: '光影', datapack: '数据包' };
  const TYPE_ICON = { mod: 'i-puzzle', modpack: 'i-package', resourcepack: 'i-box', shader: 'i-shader', datapack: 'i-sq' };
  const typeName = TYPE_NAME[cfg.type] || cfg.type;
  const box = $(cfg.list);
  const inputEl = $(cfg.search);
  /* 输入法正在组合（拼音 / 五笔还没选出汉字）时不发请求：那会儿 value 里只有拼音或半个字，
     搜出去必然是 0 条；提交（compositionend）后立刻再搜一次，保证「打完字一定会搜」。
     ——「输入中文后列表没反应」的元凶就是这个：搜的是半成品，正确那次又被旧回包盖掉。 */
  const kick = () => {
    query = inputEl.value.trim();
    clearTimeout(timer);
    timer = setTimeout(newSearch, 350);
  };
  inputEl.addEventListener('compositionstart', () => { composing = true; });
  inputEl.addEventListener('compositionend', () => { composing = false; kick(); });
  inputEl.addEventListener('input', () => { if (!composing) kick(); });
  /* 回车立即搜，不必等防抖（输入法组合中的回车是「选字」，不能抢） */
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || composing) return;
    e.preventDefault();
    query = inputEl.value.trim();
    clearTimeout(timer);
    newSearch();
  });
  if (cfg.targetSel) $(cfg.targetSel).addEventListener('change', () => newSearch());
  function newSearch() { page = 1; fallback = false; search(); }
  function gotoPage(n) { page = n; search(fallback); }
  function targetInfo() {
    if (!cfg.targetSel) return { target: '', mc: '', ld: '', world: '', all: cfg.targetType !== 'world' };
    const v = $(cfg.targetSel).value;
    if (cfg.targetType === 'world') return { target: v, mc: '', ld: '', world: v, all: false };
    /* 「全部」= 不筛 MC 版本与加载器，全站资源都可见、可直接安装（无需先装版本） */
    if (v === '__all__') return { target: '__all__', mc: '', ld: '', world: '', all: true };
    const inst = S.installed.find(x => x.id === v);
    const LD_OK = ['fabric', 'forge', 'quilt', 'neoforge'];
    /* 光影不按模组加载器分类（Modrinth 上是 iris / optifine / canvas），传 fabric 上去必然
       0 结果 → 光影页只按 MC 版本筛，加载器一律不传 */
    const ld = cfg.type === 'shader' ? '' :
      (inst && LD_OK.includes(String(inst.loader || '').toLowerCase()) ? inst.loader.toLowerCase() : '');
    return {
      target: v,
      mc: inst ? (inst.mcVersion || inst.id) : '',
      // Vanilla 不是 Modrinth 的 MOD 分类，传上去必然 0 结果；原版实例不筛 loader，安装时再拦截
      ld,
      world: '',
      all: false
    };
  }
  async function search(forceAll) {
    const my = ++seq;                     /* 只认最后一次搜索的回包：旧请求晚回来不许覆盖新结果 */
    const q = query;                      /* 钉住本次查询词（await 期间用户可能继续打字） */
    const qHasZh = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(q);
    box.innerHTML = '<div class="empty-sm">正在搜索 ' + esc(srcText()) + '…</div>';
    const ti = targetInfo();
    let r = await window.lmc.modrinthSearch({
      query: q, type: cfg.type, source,
      mcVersion: forceAll ? '' : ti.mc,
      loader: forceAll ? '' : ti.ld,
      page
    });
    if (my !== seq) return;
    let fallbackNote = '';
    // 当前版本社区暂无适配资源时，自动回退展示全站热门，安装时再严格校验
    if (r.ok && !r.hits.length && !forceAll && !fallback && (ti.mc || ti.ld)) {
      r = await window.lmc.modrinthSearch({ query: q, type: cfg.type, source, mcVersion: '', loader: '', page: 1 });
      if (my !== seq) return;
      fallback = true; page = 1;
      fallbackNote = esc(srcText()) + ' 暂无适配 <b>' + esc(ti.mc || '该版本') + '</b>' +
        (ti.ld ? ' (' + esc(ti.ld) + ')' : '') + ' 的' + typeName +
        '，以下为其他版本的热门内容；安装不兼容的资源时启动器会明确提示';
    }
    if (!r.ok) {
      box.innerHTML = '<div class="empty-sm">' + esc(srcText()) + ' 源不可达：' + esc(r.error) +
        (source === 'modrinth' ? '<br>（已自动尝试 api.modrinth.com 与国内镜像，请检查网络）' : '') + '</div>';
      const retry = el('button', 'btn', '重试');
      retry.style.marginTop = '10px';
      retry.addEventListener('click', () => { box.innerHTML = '<div class="empty-sm">正在搜索 ' + esc(srcText()) + '…</div>'; search(forceAll); });
      box.appendChild(retry);
      return;
    }
    total = r.total || 0;
    box.innerHTML = '';
    if (fallbackNote) box.appendChild(el('div', 'warnbar tip res-note', '⚠ ' + fallbackNote));
    /* 中文查询走的是「词库 / 在线翻译」得到的英文关键词，让用户看得见实际搜的是什么，
       免得以为「明明搜了这个词，出来的却是别的」 */
    if (qHasZh && r.zhQuery) box.appendChild(el('div', 'res-zhnote', '中文「' + esc(q) + '」→ 按关键词 ' + esc(r.zhQuery) + ' 搜索'));
    if (!r.hits.length) {
      /* 中文词既没进词库、也没翻出可用英文名：直说「没搜到」并给建议，
         绝不能让上游的「全站热门」冒充搜索结果（那会看着像搜索没生效） */
      box.innerHTML += r.zhMiss
        ? '<div class="empty-sm">没找到与「' + esc(q) + '」相关的内容。<br>' +
          '这个词不在内置中文词库里，也没能翻译出对应的英文名 —— 换个更完整的说法（如「小地图」），或者直接输入英文名试试。</div>'
        : '<div class="empty-sm">没有匹配的资源</div>';
      renderPager(); return;
    }
    r.hits.forEach(h => {
      /* PCL 式标题区：主标题 + 原名/版次副标题（副标题灰字小号，同行换行显示） */
      const mainTitle = esc(h.titleMain || dispTitle(h.titleZh, h.title));
      const subs = (h.titleSub || []).filter(Boolean);
      const subHtml = subs.map(s => '<span class="res-sub">' + esc(s) + '</span>').join('<span class="res-sub-sep">·</span>');
      const row = el('div', 'ver-row res-row',
        '<div class="res-ic">' + (h.icon ? '<img src="' + esc(h.icon) + '">' : '<svg class="ic"><use href="#' + (TYPE_ICON[cfg.type] || 'i-package') + '"/></svg>') + '</div>' +
        '<div class="v-name res-name">' +
          '<div class="res-title"><span class="res-title-main">' + mainTitle + '</span>' +
            (subHtml ? '<span class="res-title-subs">' + subHtml + '</span>' : '') + '</div>' +
          '<div class="res-meta"><span class="res-src" title="' + esc(itemSrcLabel(h)) + '">' + esc(itemSrcLabel(h)) + '</span>' +
            '<span class="res-dl"><svg class="ic sm"><use href="#i-download"/></svg> ' + fmtNum(h.downloads) + '</span>' +
            (h.author ? '<span class="res-author">' + esc(h.author) + '</span>' : '') + '</div>' +
          '<div class="res-desc">' + esc(h.descZh || h.desc || '') + '</div></div>' +
        '<div class="v-act"></div>');
      const act = row.querySelector('.v-act');
      const nameEl = row.querySelector('.res-name');
      nameEl.classList.add('clickable');
      gpMark(nameEl);                  /* 资源行标题可点开详情 → 手柄也要够得着 */
      nameEl.addEventListener('click', () => openResDetail(h, itemSrc(h), cfg.targetSel, typeName, cfg.type));
      const btnLabel = cfg.type === 'mod' ? '安装' : cfg.type === 'modpack' ? '安装整合包'
        : cfg.type === 'resourcepack' ? '安装资源包' : cfg.type === 'shader' ? '安装光影' : '装入选中存档';
      const btn = el('button', 'btn primary', '<svg class="ic sm"><use href="#i-download"/></svg> ' + btnLabel);
      const dbtn = el('button', 'btn ghost', '详情');
      dbtn.addEventListener('click', () => openResDetail(h, itemSrc(h), cfg.targetSel, typeName, cfg.type));
      btn.addEventListener('click', async () => {
        if (cfg.type === 'mod') {
          let t = $(cfg.targetSel).value;
          /* 选「全部」时没有指定实例：自动挑一个能装 MOD 的实例（优先默认实例，其次最近启动过的带加载器实例） */
          if (t === '__all__') {
            t = pickModInstance();
            if (!t) { toast('还没有带模组加载器的版本 —— 请先到「下载」页安装一个 Fabric / Forge / NeoForge 版本，或在上方「目标版本」里指定一个', 'warn'); return; }
          }
          if (!t) { toast('请先安装一个版本', 'warn'); return; }
          const ti2 = S.installed.find(v => v.id === t);
          if (ti2 && (ti2.loader === 'Vanilla' || !ti2.loader)) {
            toast('「' + t + '」是原版（无模组加载器），MOD 无法生效 —— 请先安装 Fabric / Forge 版本', 'warn');
            return;
          }
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallMod({ projectId: h.id, versionId: t, instance: t, source: itemSrc(h) });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
          else toast('已装入 ' + t + '：' + rr.file);
        } else if (cfg.type === 'modpack') {
          btn.disabled = true; btn.textContent = '下载安装中…';
          const rr = await window.lmc.modrinthInstallModpack({ projectId: h.id, name: h.title });
          dlTaskFinish(!!rr.ok, rr.error || '');
          if (!rr.ok) { toast('安装失败: ' + rr.error, 'error'); btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装整合包'; return; }
          await scanDir();
          selectVersion(rr.versionId, true);
          toast('整合包就绪: ' + rr.versionId);
        } else if (cfg.type === 'resourcepack') {
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallPack({ type: 'resourcepack', projectId: h.id });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装资源包';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
        } else if (cfg.type === 'shader') {
          /* 目标版本选「全部」→ 不指定实例，装到游戏根目录的 shaderpacks */
          const rawT = cfg.targetSel ? $(cfg.targetSel).value : '';
          const inst = rawT === '__all__' ? '' : rawT;
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallPack({ type: 'shader', projectId: h.id, instance: inst, source: itemSrc(h) });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装光影';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
          else toast('光影已装到 ' + (inst || '游戏根目录') + '：' + rr.file + '（游戏内用 Iris / OptiFine 选中即可生效）');
        } else { // datapack
          const w = cfg.targetSel ? $(cfg.targetSel).value : '';
          if (!w) { toast('请先选择一个存档（世界）', 'warn'); return; }
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallPack({ type: 'datapack', projectId: h.id, world: w });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 装入选中存档';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
        }
      });
      act.appendChild(dbtn);
      act.appendChild(btn);
      box.appendChild(row);
    });
    renderPager();
  }
  function renderPager() {
    const pg = $(cfg.pager);
    const totalPages = Math.max(1, Math.min(Math.ceil(total / RES_PAGE_SIZE), 250));
    if (totalPages <= 1) { pg.innerHTML = total ? '<span class="pg-info">共 ' + fmtNum(total) + ' 个' + typeName + '</span>' : ''; return; }
    let html = '<button class="btn ghost"' + (page <= 1 ? ' disabled' : '') + ' id="pgPrev_' + cfg.type + '">‹ 上一页</button>';
    // 页码：首页 / 尾页 / 当前页 ±2，间隙省略
    const nums = [...new Set([1, totalPages, page - 1, page, page + 1, page - 2, page + 2])]
      .filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b);
    let last = 0;
    for (const n of nums) {
      if (n - last > 1) html += '<span class="pg-ellipsis">…</span>';
      html += '<button class="btn ghost pg-num' + (n === page ? ' pg-cur' : '') + '" data-p="' + n + '">' + n + '</button>';
      last = n;
    }
    html += '<button class="btn ghost"' + (page >= totalPages ? ' disabled' : '') + ' id="pgNext_' + cfg.type + '">下一页 ›</button>' +
      '<span class="pg-info">第 ' + page + ' / ' + totalPages + ' 页 · 共 ' + fmtNum(total) + ' 个</span>';
    pg.innerHTML = html;
    const prev = $('#pgPrev_' + cfg.type), next = $('#pgNext_' + cfg.type);
    if (prev) prev.addEventListener('click', () => gotoPage(page - 1));
    if (next) next.addEventListener('click', () => gotoPage(page + 1));
    $$(cfg.pager + ' .pg-num').forEach(b => b.addEventListener('click', () => gotoPage(+b.dataset.p)));
    pg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  return { search, refresh: newSearch, loaded: false };
}
const modPage = setupResPage({ type: 'mod', search: '#resSearch', list: '#resList', pager: '#resPager', targetSel: '#resTarget', targetType: 'version', sourceSel: '#resSource' });
const mpPage = setupResPage({ type: 'modpack', search: '#mpSearch', list: '#mpList', pager: '#mpPager' });
const rpPage = setupResPage({ type: 'resourcepack', search: '#rpSearch', list: '#rpList', pager: '#rpPager' });
const spPage = setupResPage({ type: 'shader', search: '#spSearch', list: '#spList', pager: '#spPager', targetSel: '#spTarget', targetType: 'version' });
const dpPage = setupResPage({ type: 'datapack', search: '#dpSearch', list: '#dpList', pager: '#dpPager', targetSel: '#dpWorld', targetType: 'world' });
/* 下载页资源类 tab → 区块/工厂实例映射 */
const DL_RES_TABS = {
  mod: { area: 'resArea', page: () => modPage },
  modpack: { area: 'mpArea', page: () => mpPage },
  resourcepack: { area: 'rpArea', page: () => rpPage },
  shader: { area: 'spArea', page: () => spPage },
  datapack: { area: 'dpArea', page: () => dpPage }
};
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
/* 展示标题：有中文译名且不同于原名 → 中文名（原名），否则原名 */
function dispTitle(zh, en) {
  if (zh && en && zh !== en) return zh + '（' + en + '）';
  return en || zh || '';
}

/* ---------------- 整合包导入 / 导出 ----------------
 * 导出整合包**只有一个入口**：游戏设置 → 导出整合包（tab；见下方 openExportModal）。
 * 导出的目标不用挑 —— 就是「基础设置 → 默认启动实例」那个游戏（PCL 式）。
 * 导入页原来那张「选版本 + 一键导出」的卡片已删除 —— 与这里重复，
 * 而且那边不能勾选打包内容（要连存档一起导、或只想导配置，只有弹窗支持）。 */
/* 功能临时下架：导入整合包按钮置灰（disabled；恢复时 FEATURE_OFF.modpack 改回 false 即复原） */
if (FEATURE_OFF.modpack) {
  const b = $('#btnImportModpack');
  if (b) { b.disabled = true; b.title = '该功能暂时下架'; }
}
$('#btnImportModpack').addEventListener('click', async () => {
  const r = await window.lmc.importModpack();
  dlTaskFinish(!!r.ok, r.error || '');
  if (r.canceled) return;
  if (!r.ok) { toast('导入失败: ' + r.error, 'error'); return; }
  await scanDir();
  selectVersion(r.versionId, true);
  if (r.warn) toast(r.warn, 'warn');
});
/* 导入社区插件（拓展插件）：实现见下方「社区插件」一节（两步：先看权限清单，确认后才装） */
$('#btnImportPlugin').addEventListener('click', () => importPluginZip());

/* ---------------- 实例管理 ---------------- */
function renderInstances() {
  const box = $('#instList');
  if (!S.installed.length && !S.broken.length) { box.innerHTML = '<div class="empty-sm">尚未安装任何实例 —— 去「下载」页安装一个吧</div>'; return; }
  box.innerHTML = '';
  const defVer = (S.config && S.config.defaultVersion) || '';
  S.installed.forEach(v => {
    const isDefault = defVer === v.id;
    const row = el('div', 'ver-row',
      blockIconHtml(blockTypeForInstalled(v)) +
      '<div class="v-name">' + esc(v.id) + (isDefault ? '<span class="badge">默认</span>' : '') + '</div>' +
      '<div class="v-type"><span class="pill release">' + esc(v.loader || 'Vanilla') + '</span></div>' +
      '<div class="v-date">' + (v.mcVersion && v.mcVersion !== v.id ? 'MC ' + esc(v.mcVersion) : '&nbsp;') + '</div>' +
      '<div class="v-act"></div>');
    const act = row.querySelector('.v-act');
    const play = el('button', 'btn primary', '<svg class="ic sm"><use href="#i-play"/></svg> 启动');
    play.addEventListener('click', () => { selectVersion(v.id, true); startGame({ versionId: v.id }); });
    const rn = el('button', 'btn ghost', '重命名');
    rn.addEventListener('click', () => {
      const nameDiv = row.querySelector('.v-name');
      nameDiv.innerHTML = '<input type="text" class="rn-input" value="' + esc(v.id) + '" maxlength="64">';
      const inp = nameDiv.querySelector('input');
      inp.focus(); inp.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        const nv = inp.value.trim();
        if (!nv || nv === v.id) { renderInstances(); return; }
        const r = await window.lmc.instanceRename({ from: v.id, to: nv });
        if (!r.ok) { toast('重命名失败: ' + r.error, 'error'); renderInstances(); return; }
        await scanDir(); renderInstances();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') { done = true; renderInstances(); }
      });
      inp.addEventListener('blur', commit);
    });
    const del = el('button', 'btn ghost', '删除');
    del.addEventListener('click', async () => {
      if (!(await askConfirm('确定删除实例「' + v.id + '」？', { danger: true, detail: '此操作不可恢复。' }))) return;
      const r = await window.lmc.instanceDelete({ id: v.id });
      if (!r.ok) { toast('删除失败: ' + r.error, 'error'); return; }
      await scanDir(); renderInstances();
    });
    const open = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-folder"/></svg>');
    open.title = '打开实例目录';
    open.addEventListener('click', () => window.lmc.openPath((S.config.gameDir || '') + '\\versions\\' + v.id));
    act.appendChild(play); act.appendChild(rn); act.appendChild(del); act.appendChild(open);
    box.appendChild(row);
  });
  /* 残留目录（目录在但版本 JSON 缺失/损坏）：列出并允许删除，
     否则它既不会出现在版本列表里，又会永久挡住同名版本的安装 */
  S.broken.forEach(b => {
    const row = el('div', 'ver-row',
      '<div class="v-name">' + esc(b.folder) + '<span class="badge" style="background:rgba(245,158,11,.16);color:#f59e0b">残留</span></div>' +
      '<div class="v-type"><span class="pill snapshot">不完整</span></div>' +
      '<div class="v-date" title="' + esc(b.reason) + '">' + esc(b.reason) + '</div>' +
      '<div class="v-act"></div>');
    const act = row.querySelector('.v-act');
    const del = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-trash"/></svg> 删除');
    del.title = '删除这个不完整的实例目录（安装中断/其它启动器留下的残留）';
    del.addEventListener('click', async () => {
      if (!(await askConfirm('确定删除残留目录「' + b.folder + '」吗？', { danger: true, detail: '它不包含可用的版本信息（' + b.reason + '），删除后可以重新安装该版本。' }))) return;
      const r = await window.lmc.instanceDelete({ id: b.folder });
      if (!r || !r.ok) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
      toast('残留目录已删除: ' + b.folder);
      await scanDir(); renderInstances();
    });
    const open = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-folder"/></svg>');
    open.title = '打开该目录';
    open.addEventListener('click', () => window.lmc.openPath(b.path));
    act.appendChild(del); act.appendChild(open);
    box.appendChild(row);
  });
}
$('#btnInstRefresh').addEventListener('click', async () => { await scanDir(); renderInstances(); toast('已刷新'); });

/* ---------------- 游戏设置 ---------------- */
/* 子页一览：新增 pane 只改这里 + index.html，避免「漏一个导致两页叠着显示」（曾踩过） */
const GS_PANES = { basic: 'gsBasic', mods: 'gsMods', rp: 'gsRp', sp: 'gsSp', ver: 'gsVer', modify: 'gsModify' };
function gsShowPane(g) {
  Object.keys(GS_PANES).forEach(k => {
    const el = $('#' + GS_PANES[k]);
    if (el) el.style.display = k === g ? '' : 'none';
  });
  const cur = $('#' + (GS_PANES[g] || 'gsBasic'));
  if (cur) paneIn(cur);   /* 内容短淡入 */
  return cur;
}
$$('#gsTabs .tab').forEach(t => t.addEventListener('click', () => {
  $$('#gsTabs .tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  const g = t.dataset.gs;
  gsShowPane(g);
  try { window.lmc.uiTrace('gsettings:' + g); } catch (_) {}
  if (g === 'mods') loadMods();
  if (g === 'rp' || g === 'sp') resLoad(g, false);
  if (g === 'basic') loadLoaderCard();   /* 加载器卡在基础设置里，跟着那里选的「默认启动实例」 */
  if (g === 'ver') syncExportBtn();
  if (g === 'modify') loadModifyPage();
}));
/* ---------------- 模组加载器（基础设置里：HMCL 式更改 / 卸载） + 导出整合包（独立 tab：PCL 式勾选导出） ----------------
   两者操作的是**同一个实例**：基础设置里的「默认启动实例」。
   加载器卡原来挂在旧「版本管理」页、配一个独立的「选择实例」下拉；现在挪进「基础设置」。
   导出那边原来也有一张自己的实例下拉，现已删掉 —— 跟 PCL 一样直接导出当前实例，不再挑。 */
let vsInfo = null;
/* 「更改加载器」弹窗里选中的加载器版本（'' = 最新）。
   与 modalBuild 同理：兼容性探测回来会重绘选项区，放 DOM 里会被冲掉。 */
let vsBuild = '';
async function loadLoaderCard() {
  const id = $('#gsDefaultVer').value;
  const box = $('#vsInfo');
  if (!box) return;   /* 老结构 / 别人改了 DOM 时静默跳过，别抛异常打断后面的初始化 */
  $('#btnVsChange').disabled = $('#btnVsUninstall').disabled = !id;
  if (!id) { box.textContent = '先在上面选一个「默认启动实例」（还没有实例就先到「下载」页装一个）'; vsInfo = null; fillVersionCard(null); return; }
  box.textContent = '读取实例信息…';
  let r;
  try { r = await window.lmc.versionInfo({ id }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (!r || !r.ok) { box.innerHTML = '<span style="color:var(--tx2)">读取失败: ' + esc((r && r.error) || '未知错误') + '</span>'; vsInfo = null; fillVersionCard(null); return; }
  vsInfo = r;
  box.innerHTML =
    '加载器：<b>' + esc(r.loader) + (r.loaderVer ? ' ' + esc(r.loaderVer) : '') + '</b> · MC ' + esc(r.mcVer) +
    (r.isolated ? ' · <span class="pill release">版本隔离</span>' : '') +
    (r.hasChildren ? '<br><span style="color:#f59e0b">⚠ 被 ' + esc(r.children.join(' / ')) + ' 继承 —— 请先更改/删除子版本，再操作此实例</span>' : '');
  $('#btnVsChange').disabled = r.hasChildren;
  $('#btnVsUninstall').disabled = r.hasChildren || r.loader === 'Vanilla';
  $('#btnVsUninstall').title = r.loader === 'Vanilla' ? '已经是原版，无需卸载' : '重建为同 MC 版本的原版实例（MOD 保留但不再加载）';
  fillVersionCard(r);
}
/* 已载入哪一个实例的「版本 / 启动选项 / 内存 / 高级选项」——
   同实例重复进入基础设置时不重填，免得把没保存的输入冲掉（切换实例才重新填） */
let gsFilledVer = null;
/* 实例级设置卡（对齐 PCL「版本设置 → 设置」子页）：
   版本名称 / 版本文件夹 / 版本隔离 / 游戏窗口标题 / Java（四种模式）/ 内存分配 / 高级选项 */
function fillVersionCard(r) {
  const nameEl = $('#gsVerName');
  if (!nameEl) return;   /* DOM 被改过就静默跳过 */
  if (!r) {
    nameEl.value = ''; $('#gsVerFolder').value = '';
    $('#gsWinTitle').value = ''; $('#gsWinTitle').disabled = true;
    $('#gsIsolated').value = ''; $('#gsIsolated').disabled = true;
    $('#btnVsRename').disabled = $('#btnVsOpenDir').disabled = true;
    $('#gsJavaMode').value = 'auto'; $('#gsJavaMode').disabled = true;
    $('#gsJavaSel').disabled = true; $('#btnJavaBrowse').disabled = true;
    $('#gsJavaRange').value = '';
    setJavaModeRows('auto');
    $('#gsJvm').value = ''; $('#gsGameArgs').value = '';
    setRamType(2);
    $('#gsJavaNow').textContent = '先选「默认启动实例」';
    $('#gsMemNow').textContent = '先选「默认启动实例」';
    gsFilledVer = null;
    return;
  }
  $('#gsWinTitle').disabled = false;
  $('#gsIsolated').disabled = false;
  $('#btnVsRename').disabled = $('#btnVsOpenDir').disabled = false;
  $('#gsJavaMode').disabled = false;
  $('#gsJavaSel').disabled = false; $('#btnJavaBrowse').disabled = false;
  const st = r.settings || {};
  if (gsFilledVer !== r.id) {
    gsFilledVer = r.id;
    nameEl.value = r.id;
    $('#gsVerFolder').value = r.folder || '';
    $('#gsWinTitle').value = st.title || '';
    $('#gsIsolated').value = st.isolated || '';
    $('#gsJvm').value = st.jvmArgs || '';
    $('#gsGameArgs').value = st.gameArgs || '';
    setRamType(st.ramType === undefined ? 2 : st.ramType, st.ramCustom || 0);
    $('#gsJavaRange').value = st.javaRange || '';
    $('#gsJavaMode').value = st.javaMode || 'auto';
    setJavaModeRows(st.javaMode || 'auto');
    fillJavaSelect(st.javaPath || '');
  }
  showJavaNow();
  showMemNow();
}
/* Java 的两个条件行：只有「按区间」「用指定路径」模式才显示对应输入框 */
function setJavaModeRows(mode) {
  const rr = $('#gsJavaRangeRow'), pr = $('#gsJavaPickRow');
  if (rr) rr.style.display = mode === 'range' ? '' : 'none';
  if (pr) pr.style.display = mode === 'custom' ? '' : 'none';
}
/* 内存分配三选一（PCL 式）：2 跟随全局 / 0 自动配置 / 1 自定义 */
function gsRamType() {
  const r = document.querySelector('input[name=gsRamType]:checked');
  return r ? (parseInt(r.value, 10) || 0) : 2;
}
function setRamType(t, customGB) {
  document.querySelectorAll('input[name=gsRamType]').forEach(r => { r.checked = (parseInt(r.value, 10) === t); });
  const row = $('#gsMemManualRow');
  if (row) row.style.display = t === 1 ? '' : 'none';
  if (t === 1 && customGB) {
    $('#gsMem').value = String(customGB);
    $('#gsMemVal').textContent = customGB + ' GB';
  }
}
/* 「当前使用」那行：四种 Java 模式分别写清到底会怎么挑，别让人以为选了就一定生效 */
function showJavaNow() {
  const el = $('#gsJavaNow'); if (!el) return;
  const mode = $('#gsJavaMode') ? $('#gsJavaMode').value : 'auto';
  if (mode === 'custom') {
    const p = $('#gsJavaSel') ? ($('#gsJavaSel').value || '') : '';
    const o = $('#gsJavaSel') && $('#gsJavaSel').selectedOptions && $('#gsJavaSel').selectedOptions[0];
    const m = o && /Java\s+(\d+)/.exec(o.textContent || '');
    el.innerHTML = p
      ? '使用指定的 Java：<b>Java ' + esc(m ? m[1] : '?') + '</b> · ' + esc(p)
      : '使用指定的 Java：还没挑，点右边「浏览…」选一个 javaw.exe';
  } else if (mode === 'dir') {
    el.textContent = '使用版本文件夹中的 Java：启动时在该实例目录里找（找不到会回到自动）';
  } else if (mode === 'range') {
    const r = $('#gsJavaRange') ? $('#gsJavaRange').value.trim() : '';
    el.textContent = r
      ? '自动选择 ' + r + ' 区间内的 Java（本机没有就自动下载这个版本需要的）'
      : '自动选择指定版本的 Java：先在左边填版本区间，例如 [17.0, 25.0)';
  } else {
    el.textContent = '自动：按这个版本需要的 Java 大版本挑（本机没有就自动下载安装）';
  }
}
/* 「内存分配」下面那行：写清这一档实际会怎么给 */
function showMemNow() {
  const el = $('#gsMemNow'); if (!el) return;
  const t = gsRamType();
  if (t === 1) el.textContent = '自定义：该实例固定 ' + (parseInt($('#gsMem').value, 10) || 2) + ' GB（32 位 Java 会被压到 1 GB）';
  else if (t === 0) el.textContent = '自动配置：启动时按该实例的模组数量与当时可用内存算';
  else el.textContent = '跟随全局设置：用「设置 → 性能与目录」里的内存设置';
}
/* Java 下拉：从主进程拿「已检测到的 Java」列表（60 秒缓存，不会每次都全盘扫描）。
   当前保存的手动路径若不在列表里，也补一条出来 —— 否则下拉会因为值对不上而跳到「自动」。 */
async function fillJavaSelect(cur) {
  const sel = $('#gsJavaSel'); if (!sel) return;
  sel.innerHTML = '<option value="">（未指定）</option>' + (cur ? '<option value="' + esc(cur) + '">' + esc(cur) + '</option>' : '');
  sel.value = cur || '';
  let list = [];
  try { const r = await window.lmc.javaList(); list = (r && r.javas) || []; } catch (_) {}
  const seen = new Set();
  let html = '<option value="">（未指定）</option>';
  for (const j of list) {
    if (!j || !j.path || seen.has(j.path)) continue;
    seen.add(j.path);
    html += '<option value="' + esc(j.path) + '">Java ' + esc(j.major) + (j.ver ? ' (' + esc(j.ver) + ')' : '') + ' · ' + esc(j.path) + '</option>';
  }
  if (cur && !seen.has(cur)) html += '<option value="' + esc(cur) + '">（已指定）' + esc(cur) + '</option>';
  sel.innerHTML = html;
  sel.value = cur || '';
}
/* 「导出此实例…」的可用性与目标提示都跟着「基础设置 → 默认启动实例」走 ——
   PCL 式：不在这里挑实例，导出就是当前那个游戏（卡片里原来的实例下拉已删）。 */
function syncExportBtn() {
  const dv = $('#gsDefaultVer');
  const id = dv ? dv.value : '';
  const b = $('#btnVsExport'), tip = $('#vsExportTarget');
  if (b) b.disabled = !id;
  if (tip) {
    tip.innerHTML = id
      ? '当前实例：<b>' + esc(id) + '</b> <span style="color:var(--tx2)">（来自「基础设置 → 默认启动实例」）</span>'
      : '<span style="color:var(--tx2)">还没选「默认启动实例」—— 先到「基础设置」选一个，或到「下载」页装一个新版本</span>';
  }
}

function openLoaderChangeModal() {
  if (!vsInfo) return;
  const info = vsInfo;
  let sel = info.loader === 'Vanilla' ? 'Forge' : info.loader;
  vsBuild = '';
  resetLoaderVerCache();   /* 每次打开都重新取版本列表 */
  const list = ['Vanilla', 'Forge', 'Fabric', 'Quilt', 'NeoForge', 'OptiFine'];
  /* 已装实例的 mcVer 是真实版本号（26.4-snapshot-2 这种）。
     先按 type:'release' 初判（只影响 ≥1.14 / ≥1.20.1 这类版本下限），
     随后联网按真实版本号确认，结论会覆盖初判。 */
  const mcEntry = (S.manifest && Array.isArray(S.manifest.versions) && S.manifest.versions.find(x => x.id === info.mcVer))
    || { id: info.mcVer, type: 'release' };
  const compat = (L) => {
    const base = loaderCompat(mcEntry);
    const ov = loaderCompatOverride.get(info.mcVer);
    const merged = ov ? Object.assign({}, base, ov) : base;
    return merged[L] || { ok: false, why: '未知加载器' };
  };
  let html =
    '<h3>更改加载器 · <b>' + esc(info.id) + '</b></h3>' +
    '<div class="mmeta">MC ' + esc(info.mcVer) + ' · 当前: ' + esc(info.loader) + (info.loaderVer ? ' ' + esc(info.loaderVer) : '') + '</div>';
  const renderOpts = () => {
    let h = '';
    list.forEach(L => {
      const c = compat(L);
      h +=
        '<label class="loader-opt' + (L === sel ? ' sel' : '') + (c.ok ? '' : ' bad') + '">' +
          '<input type="radio" name="vsloader" value="' + L + '"' + (L === sel ? ' checked' : '') + '>' +
          '<div class="lo-main"><b>' + L + '</b><span>' + LOADER_INFO[L] + '</span></div>' +
          '<span class="lo-stat ' + (c.ok ? 'ok' : 'bad') + '">' + (c.pending ? '… 检测中' : (c.ok ? '✓ 兼容' : (c.unknown ? '? 查询超时' : '✗ 不兼容'))) + '</span>' +
        '</label>';
    });
    return h;
  };
  html += '<div id="vsLoaderOpts">' + renderOpts() + '</div>';
  html += '<div class="field-line" id="vsBuildLine" style="display:none;margin-top:10px"></div>';
  html += '<div id="vsWarn" style="margin-top:8px"><div class="warnbar tip">⚠ 更改会重建该实例：MOD、存档、设置全部保留；安装失败自动回滚，原实例不受影响。</div></div>';
  html += '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">准备中…</div></div>';
  html += '<div class="mfoot"><button class="btn ghost" id="vsCancel">取消</button><button class="btn primary" id="vsGo"><svg class="ic sm"><use href="#i-download"/></svg> 开始更改</button></div>';
  modalBox.innerHTML = html;
  openModal(true);   /* 更改加载器弹窗：无任务跑着时点空白可关 */
  const bindRadios = () => {
    modalBox.querySelectorAll('input[name=vsloader]').forEach(r => r.addEventListener('change', () => {
      vsBuild = '';   /* 换了加载器：之前选的版本号作废 */
      upd(); onPick();
    }));
  };
  const upd = () => {
    const v = modalBox.querySelector('input[name=vsloader]:checked');
    if (v) sel = v.value;
    modalBox.querySelectorAll('.loader-opt').forEach(o => o.classList.remove('sel'));
    if (v) v.closest('.loader-opt').classList.add('sel');
    /* 「加载器版本」下拉：能选版本的加载器才显示（Forge / Fabric / Quilt / NeoForge）。
       已经挂着同一个加载器时不重挂 —— 重挂会清掉用户已选的版本和过滤框里的字。 */
    const bhost = $('#vsBuildLine');
    if (bhost) {
      const bkey = sel + '@' + info.mcVer;
      if (!LOADER_PICKABLE[sel]) {
        bhost.style.display = 'none'; bhost.innerHTML = ''; delete bhost.dataset.kind;
      } else if (!(bhost.dataset.kind === bkey && bhost.querySelector('.lver-sel'))) {
        bhost.dataset.kind = bkey;
        mountLoaderVerPicker(bhost, sel, info.mcVer, { restore: vsBuild, onChange: (x) => { vsBuild = x; } });
      }
    }
    const c = compat(sel);
    if (c.pending) {
      $('#vsWarn').innerHTML = '<div class="warnbar tip">… 正在向 ' + sel + ' 官方源确认 ' + esc(info.mcVer) + ' 的构建</div>';
    } else if (!c.ok && c.unknown) {
      /* 查询超时 ≠ 不兼容（与主安装弹窗同一套语义：源慢/网络抖动时别把网络问题说成「不支持」） */
      $('#vsWarn').innerHTML = '<div class="warnbar tip">⚠ ' + esc(sel) + ' 构建信息未能确认（' + esc(c.why) +
        '）—— 这不代表不兼容，可稍后重试。<button class="btn ghost sm" id="vsRetryProbe" style="margin-left:8px">重新检测</button></div>';
      const rb = $('#vsRetryProbe');
      if (rb) rb.addEventListener('click', () => { rb.disabled = true; rb.textContent = '正在重查…'; reprobe(sel); });
    } else {
      $('#vsWarn').innerHTML = c.ok
        ? '<div class="warnbar tip">⚠ 更改会重建该实例：MOD、存档、设置全部保留；安装失败自动回滚，原实例不受影响。</div>'
        : '<div class="warnbar err">✗ ' + sel + ' 与 ' + esc(info.mcVer) + ' 不兼容：' + esc(c.why) + '</div>';
    }
    $('#vsGo').disabled = !c.ok;
  };
  /* 重查某个加载器并重绘整组选项（切换单选时自动触发；「查询超时」时由用户点按钮触发）。
     force=true：明确要求真去上游重查一次（不做跨次缓存），这正是「重新检测」该有的语义。 */
  const reprobe = (kind) => {
    if (!LOADER_VERSIONED[kind]) return;
    probeOneLoader(kind, info.mcVer, true).then(res => {
      mergeLoaderResult(info.mcVer, kind, res);
      const box = $('#vsLoaderOpts');
      if (!box) return;
      box.innerHTML = renderOpts();
      bindRadios();
      upd();
    }).catch(() => {});
  };
  bindRadios();
  /* 切换单选时：选中的加载器若还没结论，立刻优先查（回来即重绘整组选项） */
  const onPick = () => {
    const c = compat(sel);
    if (!c || !c.pending) return;
    reprobe(sel);
  };
  $('#vsCancel').addEventListener('click', () => closeModal());
  /* 联网确认真实可用性后重绘选项（结论按真实 mcVer 查，不是按 type 猜）。
     优先查当前选中的加载器，其余后台补齐 —— 用户马上能看到自己目标项能否用。 */
  refineLoaderCompat(mcEntry, () => {
    const box = $('#vsLoaderOpts');
    if (!box) return;
    box.innerHTML = renderOpts();
    bindRadios();
    upd();
  }, { priority: LOADER_VERSIONED[sel] ? sel : null });
  $('#vsGo').addEventListener('click', async () => {
    $('#vsGo').disabled = true; $('#vsCancel').disabled = true;
    $('#mprog').style.display = 'block';
    $('#mpText').textContent = '正在重建实例（可能需要几分钟）…';
    /* 加载器版本：读下拉当前值；空 = 重建为最新版 */
    const bsel = $('#vsBuildLine .lver-sel');
    const build = bsel ? bsel.value.trim() : (vsBuild || '');
    const r = await window.lmc.loaderChange({ id: info.id, loader: sel, build });
    if (!r.ok) {
      $('#mprog').style.display = 'none';
      $('#vsGo').disabled = false; $('#vsCancel').disabled = false;
      $('#vsWarn').innerHTML = '<div class="warnbar err">✗ ' + esc(r.error) + '</div>';
      return;
    }
    closeModal();
    await scanDir();
    await loadLoaderCard();
  });
  upd();
}
$('#btnVsChange').addEventListener('click', openLoaderChangeModal);
$('#btnVsUninstall').addEventListener('click', async () => {
  if (!vsInfo) return;
  if (!(await askConfirm('确定卸载实例「' + vsInfo.id + '」的 ' + vsInfo.loader + ' 加载器？', { danger: true, detail: '实例将重建为原版 MC ' + vsInfo.mcVer + '（实例名不变，MOD 文件保留但不再被加载）。此操作不可撤销。' }))) return;
  const btn = $('#btnVsUninstall');
  btn.disabled = true;
  $('#vsInfo').textContent = '正在重建原版实例…';
  const r = await window.lmc.loaderUninstall({ id: vsInfo.id });
  if (!r.ok) { toast('卸载失败: ' + r.error, 'error'); await loadLoaderCard(); return; }
  await scanDir();
  await loadLoaderCard();
});

/* ---------------- 「修改」页（对齐 PCL「版本设置 → 修改」子页） ----------------
   一行一个组件：Forge / NeoForge / Fabric / Quilt / Fabric API / OptiFine。
   行为与基础设置的「更改加载器」走同一批通道（loaderChange / loaderUninstall /
   modrinthInstallMod / optifineAsMod / modsDelete），交互对齐 PCL 的真实行为：
   点「✕」移除 → 行进对比视图「旧版本 » 新状态」并出现 ↻ 撤销更改；
   移除 Fabric / Quilt 时 Fabric API 联动挂起移除并灰字注明原因；
   多个改动可同时挂起，点「开始修改」先弹修改确认，再按
   「加载器 → Fabric API → OptiFine」的顺序执行，失败即停并提示。 */
let gsModInfo = null;      /* versionInfo 结果缓存（切实例 / 应用完改动后重取） */
let gsModMods = [];        /* mods:list 结果缓存（找 Fabric API / OptiFine 的 jar） */
let gsModPending = {};     /* 待应用操作：键=行槽（loader / fabricapi / optifine），值=op —— 对齐 PCL 允许多个组件同时挂起 */
function gsModHasPending() { return Object.keys(gsModPending).length > 0; }
const GS_MOD_LOADERS = ['Forge', 'NeoForge', 'Fabric', 'Quilt'];
function gsModMcEntry() {
  const r = gsModInfo;
  return (S.manifest && Array.isArray(S.manifest.versions) && S.manifest.versions.find(x => x.id === r.mcVer))
    || { id: r.mcVer, type: 'release' };
}
/* 某加载器对这个实例 MC 版本的兼容结论（与更改加载器弹窗同一套缓存 / 覆盖） */
function gsModCompatOf(L) {
  const r = gsModInfo;
  const base = loaderCompat(gsModMcEntry());
  const ov = loaderCompatOverride.get(r.mcVer);
  const merged = ov ? Object.assign({}, base, ov) : base;
  return merged[L] || { ok: false, why: '未知加载器' };
}
/* 在实例 mods 里找匹配的 jar（含已禁用），返回 {name, ver, disabled} 或 null */
function gsModJar(re, strip) {
  for (const m of gsModMods) {
    const base = m.name.replace(/\.disabled$/i, '').replace(/\.jar$/i, '');
    if (!re.test(base)) continue;
    const ver = strip ? base.replace(strip, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '') : '';
    return { name: m.name, ver: ver || base, disabled: !!m.disabled };
  }
  return null;
}
async function loadModifyPage() {
  const id = $('#gsDefaultVer').value;
  const rows = $('#gsModRows');
  if (!rows) return;
  gsModPending = {};
  const btn = $('#btnGsModApply');
  if (btn) btn.disabled = true;
  const st = $('#gsModStat'); if (st) { st.textContent = ''; st.style.display = 'none'; }
  if (!id) {
    $('#gsModName').value = '';
    rows.innerHTML = '<div class="empty-sm">先到「基础设置」选一个「默认启动实例」</div>';
    gsModInfo = null;
    return;
  }
  rows.innerHTML = '<div class="empty-sm">读取实例信息…</div>';
  let r;
  try { r = await window.lmc.versionInfo({ id }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (!r || !r.ok) { rows.innerHTML = '<div class="empty-sm">读取失败: ' + esc((r && r.error) || '未知错误') + '</div>'; gsModInfo = null; return; }
  gsModInfo = r;
  $('#gsModName').value = r.id;
  let ml = null;
  try { ml = await window.lmc.modsList({ instance: r.id }); } catch (_) {}
  gsModMods = (ml && ml.ok && ml.mods) || [];
  gsModRender();   /* 注意：renderModRows 是 MOD 管理页已有的函数（带 instance 参数），别撞名 */
  /* 兼容性还有「检测中」的项：后台补齐后重绘（与更改加载器弹窗同一套 refine 逻辑） */
  refineLoaderCompat(gsModMcEntry(), () => {
    if (gsModInfo && gsModInfo.id === r.id) gsModRender();
  }, { priority: (r.loader && LOADER_VERSIONED[r.loader]) ? r.loader : null });
}
function gsModRowHtml(title, stat, o) {
  o = o || {};
  /* stat 传对象 = 挂起行的对比视图（PCL：旧版本 » 新状态），否则是纯文本 */
  const statHtml = (stat && stat.cmp) ? stat.cmp : esc(stat);
  return '<div class="mrow' + (o.cls ? ' ' + o.cls : '') + (o.clickable ? ' click' : '') + '"' + (o.clickable || '') + '>' +
    '<b class="mrow-name">' + esc(title) + '</b>' +
    '<span class="mrow-stat">' + statHtml + '</span>' +
    '<span class="mrow-acts">' + (o.actions || '') + '</span>' +
  '</div>';
}
/* 挂起行的对比视图（PCL 的 ComparePanel）：旧版本 » 新状态 —— 移除是红字，依赖缺失时灰字补原因 */
function gsModCompare(oldTxt, newTxt, o) {
  o = o || {};
  return '<span class="mrow-compare"><span class="pold">' + esc(oldTxt) + '</span>' +
    '<span class="parr">»</span>' +
    '<b class="pto' + (o.rm ? ' rm' : '') + '">' + esc(newTxt) + '</b>' +
    (o.why ? '<i class="pwhy">（' + esc(o.why) + '）</i>' : '') +
  '</span>';
}
function gsModRender() {
  const rows = $('#gsModRows');
  if (!rows || !gsModInfo) return;
  const r = gsModInfo;
  const cur = r.loader;
  const pend = gsModPending;
  /* ✕ 移除钮（PCL 的 ClearButton：图标钮 + ToolTip「移除」）；
     挂起行的操作按钮整组换成 ↻ 撤销更改（PCL 的 RestoreButton 与它同位置互换） */
  const xBtn = (title, label, slot, o) => {
    o = o || {};
    return '<button class="mrow-btn" data-x="1" title="' + esc(title) + '" data-label="' + esc(label) + '"' +
      (slot ? ' data-slot="' + esc(slot) + '"' : '') +
      (o.loader ? ' data-loader="' + esc(o.loader) + '"' : '') +
      (o.name ? ' data-name="' + esc(o.name) + '"' : '') + '>✕</button>';
  };
  const moreBtn = (attrs, title) => '<button class="mrow-btn more" title="' + esc(title) + '" ' + attrs + '>›</button>';
  const undoBtn = (slot) => '<button class="mrow-btn undo" data-undo="' + esc(slot) + '" title="撤销更改"><svg class="ic sm"><use href="#i-sync"/></svg></button>';
  let html = '';
  /* 四个加载器行：挂起的操作只画在自己的行上（对比视图 + ↻）；其余状态照 PCL 写 */
  for (const L of GS_MOD_LOADERS) {
    const op = pend.loader && pend.loader.loader === L ? pend.loader : null;
    let stat, cls = '', actions = '', clickable = '';
    if (op) {
      cls = ' pend';
      /* PCL：挂起行是 ↻ 撤销 + › 换目标版本（点了挑版本会把挂起操作改写成换/装那个版本） */
      actions = undoBtn('loader') +
        (LOADER_PICKABLE[L] ? moreBtn('data-more="' + (op.kind === 'loader' ? 'build' : 'pick') + '" data-loader="' + L + '"', '更改版本') : '');
      const oldTxt = L === cur ? (r.loaderVer ? String(r.loaderVer) : (L === 'Vanilla' ? '官方原版' : '已安装')) : '未安装';
      stat = { cmp: gsModCompare(oldTxt, op.kind === 'uninstall' ? '移除' : (op.build || '最新'), { rm: op.kind === 'uninstall' }) };
    } else if (L === cur) {
      stat = r.loaderVer ? String(r.loaderVer) : (cur === 'Vanilla' ? '官方原版' : '已安装');
      if (cur !== 'Vanilla') actions += xBtn('移除', cur + ' 加载器', 'loader', { loader: L });
      if (LOADER_PICKABLE[cur]) actions += moreBtn('data-more="build" data-loader="' + L + '"', '更改版本');
    } else if (cur !== 'Vanilla') {
      stat = '与 ' + cur + ' 不兼容'; cls = ' bad';
    } else {
      const c = gsModCompatOf(L);
      if (c.pending) stat = '… 检测中';
      else if (!c.ok && c.unknown) { stat = '? 查询超时（点一下重试）'; clickable = ' data-more="probe" data-loader="' + L + '"'; }
      else if (!c.ok) { stat = '✗ ' + c.why; cls = ' bad'; }
      else { stat = '可以添加'; clickable = ' data-more="pick" data-loader="' + L + '"'; }
    }
    html += gsModRowHtml(L, stat, { cls, actions, clickable });
  }
  /* Fabric API：mod 形态装在 mods 里 —— 认文件名；只有 Fabric / Quilt 实例能装。
     移除 Fabric / Quilt 时它没法保留 → 自动跟着挂起移除并灰字注明原因（PCL 同款联动） */
  {
    const jar = gsModJar(/^fabric-?api/i, /^fabric-?api[-_]?/i);
    const op = pend.fabricapi;
    let stat, cls = '', actions = '', clickable = '';
    if (op) {
      cls = ' pend';
      /* PCL：联动产生的移除不能单独撤销（行上没有按钮），撤加载器时会一起撤掉；自己点的 ✕ 才有 ↻ */
      actions = op.fromLoader ? '' : undoBtn('fabricapi');
      const oldTxt = jar ? (jar.disabled ? '已禁用 · ' : '') + (jar.ver || jar.name) : '未安装';
      stat = { cmp: gsModCompare(oldTxt, op.kind === 'delfile' ? '移除' : '最新',
        { rm: op.kind === 'delfile', why: op.dep ? '需要安装 ' + op.dep : '' }) };
    } else if (jar) {
      stat = (jar.disabled ? '已禁用 · ' : '已安装 · ') + (jar.ver || jar.name);
      actions += xBtn('移除', 'Fabric API', 'fabricapi', { name: jar.name });
      if (cur === 'Fabric' || cur === 'Quilt') actions += moreBtn('data-more="fabricapi"', '更新到最新');
    } else if (cur === 'Fabric' || cur === 'Quilt') {
      stat = '未安装'; clickable = ' data-more="fabricapi"';
    } else if (cur === 'Forge' || cur === 'NeoForge') {
      stat = '与 ' + cur + ' 不兼容'; cls = ' bad';
    } else {
      stat = '需要先安装 Fabric / Quilt'; cls = ' bad';
    }
    html += gsModRowHtml('Fabric API', stat, { cls, actions, clickable });
  }
  /* OptiFine：XLC 把它以模组形式放进 mods（前置 Forge / NeoForge 自动补齐） */
  {
    const jar = gsModJar(/^optifine/i, /^optifine[-_]?/i);
    const op = pend.optifine;
    let stat, cls = '', actions = '', clickable = '';
    if (op) {
      cls = ' pend';
      actions = op.fromLoader ? '' : undoBtn('optifine');
      const oldTxt = jar ? (jar.disabled ? '已禁用 · ' : '') + (jar.ver.replace(/_/g, ' ') || jar.name) : '未安装';
      stat = { cmp: gsModCompare(oldTxt, op.kind === 'delfile' ? '移除' : (op.build || '最新'), { rm: op.kind === 'delfile' }) };
    } else if (jar) {
      stat = (jar.disabled ? '已禁用 · ' : '已安装 · ') + (jar.ver.replace(/_/g, ' ') || jar.name);
      actions += xBtn('移除', 'OptiFine', 'optifine', { name: jar.name });
    } else if (cur === 'Fabric' || cur === 'Quilt') {
      stat = '与 ' + cur + ' 不兼容'; cls = ' bad';
    } else {
      const c = gsModCompatOf('OptiFine');
      if (c.pending) stat = '… 检测中';
      else if (!c.ok && c.unknown) { stat = '? 查询超时（点一下重试）'; clickable = ' data-more="probe" data-loader="OptiFine"'; }
      else if (!c.ok) { stat = '✗ ' + c.why; cls = ' bad'; }
      else {
        stat = cur === 'Vanilla' ? '未安装（会先自动装 NeoForge 作前置）' : '未安装';
        clickable = ' data-more="optifine"';
      }
    }
    html += gsModRowHtml('OptiFine', stat, { cls, actions, clickable });
  }
  rows.innerHTML = html;
  const btn = $('#btnGsModApply');
  if (btn) btn.disabled = !gsModHasPending();
}
/* 「›」打开版本挑选弹窗（复用下载页同一套 mountLoaderVerPicker：列表 / 过滤 / 缓存全通用） */
function openModBuildPicker(L, isChange) {
  if (!gsModInfo) return;
  const r = gsModInfo;
  resetLoaderVerCache();
  modalBox.innerHTML =
    '<h3>' + (isChange ? '更改' : '安装') + ' ' + esc(L) + ' · <b>' + esc(r.id) + '</b></h3>' +
    '<div class="mmeta">MC ' + esc(r.mcVer) + ' · 留空 = 最新版' +
      (isChange ? ' · 更改会重建该实例（MOD / 存档 / 设置保留，失败自动回滚）' : '') + '</div>' +
    '<div class="field-line" id="gsModPick" style="margin-top:10px"></div>' +
    '<div class="mfoot"><button class="btn ghost" id="gsModPickCancel">取消</button>' +
    '<button class="btn primary" id="gsModPickOk"><svg class="ic sm"><use href="#i-check"/></svg> 确定</button></div>';
  openModal(true);
  mountLoaderVerPicker($('#gsModPick'), L, r.mcVer, { restore: isChange ? String(r.loaderVer || '') : '', onChange: () => {} });
  $('#gsModPickCancel').addEventListener('click', () => closeModal());
  $('#gsModPickOk').addEventListener('click', () => {
    const sel = $('#gsModPick .lver-sel');
    const build = sel ? sel.value.trim() : '';
    gsModPending.loader = { kind: 'loader', loader: L, build };
    closeModal();
    gsModRender();
  });
}
/* 单个加载器重新探测（「查询超时」的行点一下重试，与更改加载器弹窗同一套语义） */
function gsModReprobe(L) {
  if (!gsModInfo || !LOADER_VERSIONED[L]) return;
  const mcVer = gsModInfo.mcVer;
  probeOneLoader(L, mcVer, true).then(res => {
    mergeLoaderResult(mcVer, L, res);
    if (gsModInfo && gsModInfo.mcVer === mcVer) gsModRender();
  }).catch(() => {});
}
$('#gsModRows').addEventListener('click', (ev) => {
  if (!gsModInfo) return;
  const u = ev.target.closest('.mrow-btn[data-undo]');
  if (u) {
    const slot = u.dataset.undo;
    const op = gsModPending[slot];
    delete gsModPending[slot];
    /* 撤销加载器操作时，连带撤掉由它联动挂起的依赖组件（PCL 的「还原」回到初始选择） */
    if (slot === 'loader' && op && op.loader) {
      for (const k of ['fabricapi', 'optifine']) {
        if (gsModPending[k] && gsModPending[k].fromLoader === op.loader) delete gsModPending[k];
      }
    }
    gsModRender();
    return;
  }
  const x = ev.target.closest('.mrow-btn[data-x]');
  if (x) {
    const label = x.dataset.label || '该组件';
    if (x.dataset.name) {
      /* Fabric API / OptiFine：从 mods 里删 jar，按行槽挂起（slot 决定画在哪一行） */
      gsModPending[x.dataset.slot] = { kind: 'delfile', name: x.dataset.name, label };
    } else {
      const op = { kind: 'uninstall', label, loader: x.dataset.loader };
      gsModPending.loader = op;
      /* PCL 联动：移除 Fabric / Quilt 时 Fabric API 没法保留 → 自动跟着挂起移除并注明原因 */
      if (op.loader === 'Fabric' || op.loader === 'Quilt') {
        const jar = gsModJar(/^fabric-?api/i, /^fabric-?api[-_]?/i);
        if (jar) gsModPending.fabricapi = { kind: 'delfile', name: jar.name, label: 'Fabric API', dep: op.loader, fromLoader: op.loader };
      }
    }
    gsModRender();
    return;
  }
  const t = ev.target.closest('[data-more]');
  if (!t) return;
  const kind = t.dataset.more, L = t.dataset.loader;
  if (kind === 'pick') openModBuildPicker(L, false);
  else if (kind === 'build') openModBuildPicker(L, true);
  else if (kind === 'probe') gsModReprobe(L);
  else if (kind === 'fabricapi') { gsModPending.fabricapi = { kind: 'fabricapi' }; gsModRender(); }
  else if (kind === 'optifine') { gsModPending.optifine = { kind: 'optifine' }; gsModRender(); }
});
$('#btnGsModApply').addEventListener('click', async () => {
  const info = gsModInfo;
  const ops = ['loader', 'fabricapi', 'optifine'].map(k => [k, gsModPending[k]]).filter(([, p]) => p);
  if (!ops.length || !info) return;
  /* PCL 的「修改确认」：把要做的每件事列出来 + 兼容性警告，确认后才动手 */
  const items = ops.map(([, p]) => {
    if (p.kind === 'loader') return '· ' + (info.loader === p.loader ? '更改 ' : '安装 ') + p.loader + ' → ' + (p.build || '最新');
    if (p.kind === 'uninstall') return '· 移除 ' + p.label + '（实例将重建为原版 MC ' + info.mcVer + '）';
    if (p.kind === 'fabricapi') return '· 安装 Fabric API（最新）';
    if (p.kind === 'optifine') return '· 安装 OptiFine';
    return '· 移除 ' + (p.label || p.name);
  });
  const danger = ops.some(([, p]) => p.kind === 'uninstall');
  if (!(await askConfirm('开始修改实例「' + info.id + '」？', {
    danger,
    okText: '开始修改',
    detail: items.join('\n') + '\n\n现有的 Mod、资源包等在修改后可能会不兼容！' +
      (danger ? '\n卸载加载器会把实例重建为原版，此操作不可撤销。' : '')
  }))) return;
  const btn = $('#btnGsModApply');
  btn.disabled = true;
  const st = $('#gsModStat');
  const say = (t) => { st.textContent = t || ''; st.style.display = t ? '' : 'none'; };
  try {
    for (const [slot, p] of ops) {
      if (p.kind === 'loader') {
        say('正在' + (info.loader === p.loader ? '更改' : '安装') + ' ' + p.loader + '（可能需要几分钟）…');
        const res = await window.lmc.loaderChange({ id: info.id, loader: p.loader, build: p.build || '' });
        if (!res.ok) throw new Error(res.error);
      } else if (p.kind === 'uninstall') {
        say('正在重建原版实例…');
        const res = await window.lmc.loaderUninstall({ id: info.id });
        if (!res.ok) throw new Error(res.error);
      } else if (p.kind === 'fabricapi') {
        say('正在下载 Fabric API（Modrinth）…');
        const res = await window.lmc.modrinthInstallMod({ projectId: 'fabric-api', versionId: info.id, instance: info.id });
        if (!res.ok) throw new Error(res.error);
      } else if (p.kind === 'optifine') {
        say('正在安装 OptiFine…');
        const res = await window.lmc.optifineAsMod(info.mcVer, info.id);
        if (!res.ok) throw new Error(res.error);
      } else if (p.kind === 'delfile') {
        say('正在删除 ' + (p.label || p.name) + '…');
        const res = await window.lmc.modsDelete({ name: p.name, instance: info.id });
        if (!res.ok) throw new Error(res.error);
      }
      delete gsModPending[slot];
    }
    say('');
    await scanDir();
    await loadModifyPage();
    loadLoaderCard();   /* 基础设置的加载器卡显示同一个实例，一并刷新 */
  } catch (e) {
    say('✗ ' + ((e && e.message) || e) + '（剩余改动仍挂起，可重试或点 ↻ 撤销）');
    gsModRender();
  }
});

/* PCL 式导出选项弹窗（勾选打包内容）
   选项清单不在这边硬编码 —— 主进程按 PCL 的规则表算好「有哪些项、默认勾不勾、各命中多少文件」，
   这里只负责画。三档行：master=动态父项（总开关，勾上会连子项一起开关）、kid=动态子项（资源包/光影包/存档
   的具体条目）、sub=静态子项（如 Mod 下的「已禁用的 Mod」，受父项显示控制但各自独立勾选）。 */
let expCache = null;   /* 上次拿到的选项清单，「重置」直接拿它重画 */
function syncExpRows(box) {
  const on = new Set([...box.querySelectorAll('input[name=expopt]:checked')].map(c => c.value));
  box.querySelectorAll('.exp-opt').forEach(row => {
    const p = row.dataset.parent;
    row.classList.toggle('hide', !!p && !on.has(p));
  });
}
function renderExpList(res) {
  const box = $('#expList');
  if (!box) return;
  const row = (o, role, parent) => {
    const stat = o.locked ? '必选'
      : (o.count ? o.count + ' 个文件 · ' + fmtSizeB(o.bytes) : '空');
    return '<label class="exp-opt' + (role === 'kid' ? ' sub2' : role === 'sub' ? ' sub' : '') +
        (o.def ? ' on' : '') + (o.locked ? ' lock' : '') + '"' +
        ' data-role="' + role + '"' + (parent ? ' data-parent="' + esc(parent) + '"' : '') + '>' +
      '<input type="checkbox" name="expopt" value="' + esc(o.id) + '"' +
        (o.def ? ' checked' : '') + (o.locked ? ' disabled' : '') + '>' +
      '<div class="lo-main"><b>' + esc(o.title) + '</b>' + (o.desc ? '<span>' + esc(o.desc) + '</span>' : '') + '</div>' +
      '<span class="exp-stat">' + esc(stat) + '</span></label>';
  };
  let html = '';
  for (const o of (res.options || [])) {
    /* 静态子项（带 group）只是缩进 + 受父项显示控制，勾选是独立的；动态子项那档另有 total-switch 语义 */
    html += row(o, o.group ? 'sub' : o.dyn ? 'master' : 'top', o.group || '');
    for (const k of (o.kids || [])) html += row(k, 'kid', o.id);
  }
  box.innerHTML = html;
  syncExpRows(box);
  box.querySelectorAll('input[name=expopt]').forEach(c => c.addEventListener('change', () => {
    const r = c.closest('.exp-opt');
    r.classList.toggle('on', c.checked);
    if (r.dataset.role === 'master') {   /* 父项 = 总开关：连子项一起开关 */
      box.querySelectorAll('.exp-opt[data-parent="' + c.value + '"] input').forEach(k => {
        k.checked = c.checked;
        k.closest('.exp-opt').classList.toggle('on', c.checked);
      });
    }
    syncExpRows(box);
  }));
}
/* 收集勾选项：master 收它勾上的子项（父项本身不带规则），kid 由 master 收，其余各算各的 */
function collectExpSelection(box) {
  const sel = [];
  box.querySelectorAll('input[name=expopt]').forEach(c => {
    const r = c.closest('.exp-opt');
    if (r.classList.contains('hide')) return;         /* 没被展开的子项不算 */
    const role = r.dataset.role;
    if (role === 'kid') return;
    if (role === 'master') {
      if (!c.checked) return;
      box.querySelectorAll('.exp-opt[data-parent="' + c.value + '"] input').forEach(k => { if (k.checked) sel.push(k.value); });
      return;
    }
    if (c.checked) sel.push(c.value);
  });
  return sel;
}
async function openExportModal(versionId) {
  if (!versionId) { toast('请先安装一个版本', 'warn'); return; }
  const res = await window.lmc.exportOptions(versionId);
  expCache = res;
  let html = '<h3>导出整合包 · <b>' + esc(versionId) + '</b></h3>' +
    '<div class="mmeta">打包成 .lmcmod —— 对端用 XLC 导入后按原路径还原（游戏本体与加载器在导入时联网下载）</div>';
  if (!res || !res.ok) {
    html += '<div class="warnbar err">✗ ' + esc((res && res.error) || '读取实例内容失败') + '</div>' +
      '<div class="mfoot"><button class="btn ghost" id="expCancel">关闭</button></div>';
    modalBox.innerHTML = html;
    openModal(true);
    $('#expCancel').addEventListener('click', () => closeModal());
    return;
  }
  html +=
    '<div class="exp-head">' +
      '<label class="exp-nv"><span>整合包名称</span><input type="text" id="expName" maxlength="60" placeholder="' + esc(versionId) + '"></label>' +
      '<label class="exp-nv"><span>整合包版本</span><input type="text" id="expVer" maxlength="20" placeholder="1.0.0"></label>' +
      '<button class="btn ghost" id="expReset" title="把所有勾选恢复成默认">重置</button>' +
    '</div>' +
    '<div class="exp-list" id="expList"></div>' +
    '<div class="warnbar tip exp-hint">已经命中的内容才列出来；「游戏本体」必选但不用打包（导入时自动下载）。' +
      '整包超过 640MB 会被拒（打包在内存里做），太大就分几次导。</div>' +
    '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">打包中…</div></div>' +
    '<div class="mfoot"><button class="btn ghost" id="expCancel">取消</button><button class="btn primary" id="expGo"><svg class="ic sm"><use href="#i-upload"/></svg> 开始导出</button></div>';
  modalBox.innerHTML = html;
  openModal(true);                       /* 导出整合包弹窗（无任务跑着时点空白可关） */
  modalBox.classList.add('cl-wide');     /* 选项多，单独加宽（closeModal 会摘掉） */
  renderExpList(res);
  $('#expReset').addEventListener('click', () => {
    $('#expName').value = ''; $('#expVer').value = '';
    renderExpList(expCache);
  });
  $('#expCancel').addEventListener('click', () => closeModal());
  $('#expGo').addEventListener('click', async () => {
    const sel = collectExpSelection(modalBox);
    if (!sel.length) { toast('至少勾选一项内容', 'warn'); return; }
    const name = $('#expName').value.trim() || versionId;
    const version = $('#expVer').value.trim();
    $('#expGo').disabled = true; $('#expCancel').disabled = true;
    $('#mprog').style.display = 'block';
    $('#mpText').textContent = '正在打包（共 ' + sel.length + ' 项内容）…';
    const r = await window.lmc.exportModpack(versionId, { options: sel, name: name, version: version });
    if (r.canceled) { closeModal(); return; }
    if (!r.ok) {
      $('#mprog').style.display = 'none';
      $('#expGo').disabled = false; $('#expCancel').disabled = false;
      $('#mpText').textContent = '导出失败: ' + r.error;
      toast('导出失败: ' + r.error, 'error');
      return;
    }
    closeModal();
    if (r.warns && r.warns.length) toast('有 ' + r.warns.length + ' 个文件被跳过（详见日志）', 'warn');
  });
}
$('#btnVsExport').addEventListener('click', () => openExportModal($('#gsDefaultVer').value));

/* ---------------- 实例级设置（PCL「版本设置」式）：版本名称 / 版本文件夹 / 窗口标题 / Java ---------------- */
/* 版本文件夹：走 shell:open（主进程只放行游戏目录 / 数据目录子树内的路径，这里天然在其中） */
$('#btnVsOpenDir').addEventListener('click', async () => {
  const p = $('#gsVerFolder').value.trim();
  if (!p) { toast('先选「默认启动实例」', 'warn'); return; }
  const ok = await window.lmc.openPath(p);
  if (!ok) toast('打开失败（目录可能已被移除）', 'error');
});
/* 重命名实例：改名走 instance:rename（主进程会把「默认启动实例 / 上次选中 / 实例设置」一起迁过去） */
$('#btnVsRename').addEventListener('click', async () => {
  const from = $('#gsDefaultVer').value;
  const to = $('#gsVerName').value.trim();
  if (!from) { toast('先选「默认启动实例」', 'warn'); return; }
  if (!to || to === from) { $('#gsVerName').value = from; toast('名称没变'); return; }
  if (!(await askConfirm('把实例「' + from + '」改名为「' + to + '」？', {
    detail: 'MOD / 存档 / 设置都会跟着保留。被其他实例继承的版本不能改名。'
  }))) { $('#gsVerName').value = from; return; }
  const r = await window.lmc.instanceRename({ from, to });
  if (!r.ok) { toast('重命名失败: ' + r.error, 'error'); $('#gsVerName').value = from; return; }
  toast('已重命名为: ' + r.id);
  await scanDir();                     /* 刷新实例列表（下载页 / 实例管理页共用） */
  S.config = Object.assign({}, S.config, { defaultVersion: r.id });
  /* 下拉换上新名字，并顺带把版本卡重填成新名字 / 新路径
     （fillVersionCard 只在「实例名和上次填的不一样」时重填，正好这次会重填） */
  await refreshAuxSelects();
});
/* 「浏览…」：直接在资源管理器里挑一个 javaw.exe / java.exe，主进程顺手探测大版本 */
$('#btnJavaBrowse').addEventListener('click', async () => {
  const r = await window.lmc.versionPickJava();
  if (!r.ok) { toast('选择失败: ' + r.error, 'error'); return; }
  if (r.canceled) return;
  await fillJavaSelect(r.path);
  $('#gsJavaSel').value = r.path;
  showJavaNow();
  toast('已选择 Java ' + r.major + '（点「保存游戏设置」生效）');
});
/* Java 下拉换了：立刻把「当前使用」那行跟着变（真正落盘还在保存按钮里） */
$('#gsJavaSel').addEventListener('change', showJavaNow);

/* ---------------- 自定义文件下载 ---------------- */
function openCustomDlModal() {
  const instOpts = S.installed.filter(v => v.loader && v.loader !== 'Vanilla')
    .map(v => '<option value="' + esc(v.id) + '">' + esc(v.id) + '</option>').join('');
  let html = '<h3><svg class="ic sm"><use href="#i-upload"/></svg> 自定义文件下载</h3>' +
    '<div class="mmeta">粘贴任意 http(s) 直链（多线程分块下载），保存到游戏目录对应位置</div>' +
    '<div class="field-line" style="margin-top:10px"><span>下载地址</span><input type="text" id="cdUrl" placeholder="https://example.com/mod-file.jar" spellcheck="false"></div>' +
    '<div class="field-line"><span>保存到</span><select id="cdTarget">' +
      '<option value="mods">MOD 目录（mods）</option>' +
      '<option value="resourcepacks">资源包目录（resourcepacks）</option>' +
      '<option value="shaderpacks">光影目录（shaderpacks）</option>' +
      '<option value="pick">自选位置（另存为）</option>' +
    '</select></div>' +
    '<div class="field-line" id="cdInstRow" style="display:none"><span>目标实例（版本隔离 mods）</span><select id="cdInst">' +
      (instOpts || '<option value="">（无带加载器的实例 → 存全局 mods）</option>') +
    '</select></div>' +
    '<div id="cdWarn"></div>' +
    '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">下载中…</div></div>' +
    '<div class="mfoot"><button class="btn ghost" id="cdCancel">取消</button><button class="btn primary" id="cdGo"><svg class="ic sm"><use href="#i-download"/></svg> 开始下载</button></div>';
  modalBox.innerHTML = html;
  openModal(true);   /* 下载 MOD 弹窗 */
  $('#cdTarget').addEventListener('change', () => {
    $('#cdInstRow').style.display = $('#cdTarget').value === 'mods' ? '' : 'none';
  });
  $('#cdCancel').addEventListener('click', () => closeModal());
  $('#cdGo').addEventListener('click', async () => {
    const url = $('#cdUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) { $('#cdWarn').innerHTML = '<div class="warnbar err">✗ 请输入有效的 http(s) 下载地址</div>'; return; }
    $('#cdGo').disabled = true; $('#cdCancel').disabled = true;
    $('#mprog').style.display = 'block';
    $('#mpText').textContent = '下载中（多线程）…';
    const r = await window.lmc.customDownload({
      url,
      target: $('#cdTarget').value,
      instance: $('#cdInst') ? $('#cdInst').value : ''
    });
    if (r.canceled) { closeModal(); return; }
    if (!r.ok) {
      dlTaskFinish(false, r.error || '');
      $('#mprog').style.display = 'none';
      $('#cdGo').disabled = false; $('#cdCancel').disabled = false;
      $('#cdWarn').innerHTML = '<div class="warnbar err">✗ ' + esc(r.error) + '</div>';
      return;
    }
    dlTaskFinish(true, '');
    closeModal();
    toast('文件已下载: ' + r.path);
  });
}
$('#btnCustomDl').addEventListener('click', openCustomDlModal);

/* 内存三选一：切换时只切界面（哪些行可用 / 说明文案），真正的落盘在「保存游戏设置」里 */
$$('input[name=gsRamType]').forEach(r => r.addEventListener('change', () => {
  setRamType(gsRamType());
  showMemNow();
  refreshMemHint();
}));
/* 换默认实例 → 模组数量变了，智能推荐跟着重算（原版 2.5G 起步 vs 两百模组 7G 起步）；
   「加载器卡」与「导出整合包」的目标行显示的都是这个实例，一并刷新。 */
$('#gsDefaultVer').addEventListener('change', () => { refreshMemHint(); loadLoaderCard(); syncExportBtn();
  /* 「修改」页显示的也是这个实例：页签开着就重载，关着就作废缓存（下次进来重取） */
  if ($('#gsModify') && $('#gsModify').style.display !== 'none') loadModifyPage();
  else { gsModInfo = null; gsModPending = null; }
  /* 资源包 / 光影包操作的也是这个实例：页签开着就按新实例重载 */
  ['rp', 'sp'].forEach(k => {
    const pane = $(RES_UI[k].pane);
    if (pane && pane.style.display !== 'none') resLoad(k, false);
  }); });
$('#gsMem').addEventListener('input', () => { $('#gsMemVal').textContent = $('#gsMem').value + ' GB'; showMemNow(); });
/* Java 模式切换：显示 / 隐藏对应的输入行，「当前使用」那行同步改写 */
$('#gsJavaMode').addEventListener('change', () => { setJavaModeRows($('#gsJavaMode').value); showJavaNow(); });
$('#gsJavaRange').addEventListener('input', showJavaNow);
$('#btnSaveGs').addEventListener('click', async () => {
  const instId = $('#gsDefaultVer').value;
  /* 全局项（默认启动实例 / 简中）走 saveConfig。内存与 JVM 参数已改成**按实例**存，
     这一页不再写全局的那两份（它们在「设置 → 性能与目录」里改），免得两边互相覆盖。 */
  S.config = await window.lmc.saveConfig({
    defaultVersion: instId,
    forceChinese: $('#gsChinese').checked
  });
  /* 实例级设置跟着这个按钮一起存（PCL 那边也是「设置」页里一起改一起存，不另加按钮）。
     存的实例名取「默认启动实例」：这一页所有东西操作的都是它。 */
  if (instId) {
    const jmode = $('#gsJavaMode').value;
    const rs = await window.lmc.versionSettingsSave({
      id: instId,
      title: $('#gsWinTitle').value.trim(),
      isolated: $('#gsIsolated').value,
      javaMode: jmode,
      javaRange: jmode === 'range' ? $('#gsJavaRange').value.trim() : '',
      javaPath: jmode === 'custom' ? ($('#gsJavaSel').value || '') : '',
      ramType: gsRamType(),
      ramCustom: parseInt($('#gsMem').value, 10) || 2,
      jvmArgs: $('#gsJvm').value.trim(),
      gameArgs: $('#gsGameArgs').value.trim()
    });
    if (!rs.ok) { toast('实例设置保存失败: ' + rs.error, 'error'); return; }
    showJavaNow();
    showMemNow();
  } else {
    toast('没选「默认启动实例」，隔离 / 窗口标题 / Java / 内存都没保存', 'warn');
  }
  updateStatusBarRight();
  toast('游戏设置已保存');
});

/* MOD 管理（PCL 式：支持版本隔离；VersePC 式在线图标/名称 + PCL 式详情卡） */
let currentMods = [], currentModsMeta = {};
/* MOD 更新（PCL 式）：modsUpd = { 文件名: {src,title,current,latest,fileName,...} }，来自 mods:check-updates */
let modsUpd = null, modsUpdBusy = false;
function modsUpdBar(html) {
  const b = $('#modsUpdBar');
  if (!b) return;
  b.style.display = html ? '' : 'none';
  b.innerHTML = html;
  const all = $('#btnModsUpdAll');
  if (all) all.addEventListener('click', () => doModsUpdate(Object.keys(modsUpd || {})));
}
async function checkModUpdates(instance, refresh) {
  if (modsUpdBusy || !instance) return;
  modsUpdBusy = true;
  const btn = $('#btnModsCheck'); if (btn) btn.disabled = true;
  modsUpdBar('正在检查 MOD 更新…（按文件指纹比对 Modrinth' + (refresh ? '，强制刷新' : '') + '）');
  try {
    const r = await window.lmc.modsCheckUpdates({ instance, refresh: !!refresh });
    if ($('#modTarget').value !== instance) return;
    modsUpd = (r && r.ok) ? r.updates : null;
    const n = modsUpd ? Object.keys(modsUpd).length : 0;
    if (!r || !r.ok) modsUpdBar('✗ MOD 更新检查失败：' + esc((r && r.error) || '未知错误'));
    else if (n > 0) modsUpdBar('有 <b>' + n + '</b> 个 MOD 可以更新 <button class="btn ghost" id="btnModsUpdAll">全部更新</button>');
    else modsUpdBar('✓ 全部 MOD 都是最新的（在线匹配到 ' + r.checked + ' 个文件' + (r.unmatched ? '，' + r.unmatched + ' 个未收录' : '') + '）');
    renderModRows(instance);
  } finally {
    modsUpdBusy = false;
    const btn2 = $('#btnModsCheck'); if (btn2) btn2.disabled = false;
  }
}
/* 更新执行（PCL 同款流程：确认风险 → 逐个下载换新 → 旧文件进回收站） */
async function doModsUpdate(names) {
  const instance = $('#modTarget').value || '';
  const list = (names || []).map(n => (modsUpd && modsUpd[n]) || null).filter(Boolean);
  if (!list.length) return;
  const desc = list.map(u => '· ' + (u.title || '?') + '：' + (u.current || '?') + ' → ' + (u.latest || '?')).join('\n');
  if (!(await askConfirm('更新 ' + list.length + ' 个 MOD？', {
    okText: '继续更新',
    detail: desc + '\n\n新版本 Mod 可能与旧存档或其他 Mod 不兼容，甚至导致游戏崩溃！更新前请先备份存档；更新前的文件会移入系统回收站，出问题可以找回。'
  }))) return;
  let done = 0, fail = 0;
  for (let i = 0; i < names.length; i++) {
    const u = (modsUpd && modsUpd[names[i]]) || null;
    if (!u) continue;
    modsUpdBar('正在更新 ' + (i + 1) + '/' + names.length + '：' + esc(u.title || names[i]) + '…');
    const r = await window.lmc.modsUpdate({ instance, names: [names[i]] });
    if (r && r.results && r.results[0] && r.results[0].ok) done++; else fail++;
  }
  modsUpdBar('');
  toast('已更新 ' + done + ' 个 MOD' + (fail ? '，' + fail + ' 个失败（详见提示）' : ''), fail ? 'warn' : 'ok');
  await loadMods();
}
/* ---------------- 资源包 / 光影包（游戏设置页，照 PCL CE 的实例设置） ----------------
 * PCL CE 的实例设置里「资源包」「光影包」各是一页（Pages/PageInstance/PageInstanceCompResource）：
 *   搜索框 + 打开文件夹 / 从文件安装 / 下载新资源包 / 全选 / 导出信息 + 筛选（全部 / 可更新 / 错误 / 重复）
 *   + 排序（资源名称 / 文件名 / 大小 / 添加时间，文件夹置顶）+ 资源卡（图标 / 名称 / 描述 / 版本徽章）。
 * 两个页面都**没有启用禁用**：资源包与光影由游戏内「选项 → 资源包 / 光影」选择，PCL 也是隐藏 ED 按钮的。
 * 列表数据来自主进程 res:*（本地 pack.mcmeta + sha1 匹配 Modrinth），这里只负责渲染与交互。 */
const RES_UI = {
  rp: {
    kind: 'resourcepack', label: '资源包', icon: 'i-image',
    pane: '#gsRp', list: '#gsRpList', search: '#gsRpSearch', filters: '#gsRpFilters', sort: '#gsRpSort',
    target: '#gsRpTarget', batch: '#gsRpBatch', batchTx: '#gsRpBatchTx', batchDel: '#gsRpBatchDel',
    batchClear: '#gsRpBatchClear', batchUpd: '#gsRpBatchUpdate',
    open: '#gsRpOpen', install: '#gsRpInstall', download: '#gsRpDownload', selectAll: '#gsRpSelectAll', export: '#gsRpExport'
  },
  sp: {
    kind: 'shader', label: '光影包', icon: 'i-shader',
    pane: '#gsSp', list: '#gsSpList', search: '#gsSpSearch', filters: '#gsSpFilters', sort: '#gsSpSort',
    target: '#gsSpTarget', batch: '#gsSpBatch', batchTx: '#gsSpBatchTx', batchDel: '#gsSpBatchDel',
    batchClear: '#gsSpBatchClear', batchUpd: '#gsSpBatchUpdate',
    open: '#gsSpOpen', install: '#gsSpInstall', download: '#gsSpDownload', selectAll: '#gsSpSelectAll', export: '#gsSpExport'
  }
};
const RES_SORT_LABEL = { name: '资源名称', file: '文件名', size: '文件大小', time: '添加时间' };
Object.keys(RES_UI).forEach(k => {
  RES_UI[k].st = { items: [], dir: '', info: {}, updates: {}, filter: 'all', sort: 'name', q: '', sel: new Set(), loaded: false };
});
function resInstance() { return ($('#gsDefaultVer') && $('#gsDefaultVer').value) || ''; }
function resDupSet(items) {
  const cnt = new Map();
  items.forEach(it => { if (it.sha1) cnt.set(it.sha1, (cnt.get(it.sha1) || 0) + 1); });
  const dup = new Set();
  items.forEach(it => { if (it.sha1 && cnt.get(it.sha1) > 1) dup.add(it.name); });
  return dup;
}
function resFiltered(key) {
  const c = RES_UI[key], st = c.st;
  const dup = resDupSet(st.items);
  let arr = st.items.slice();
  if (st.filter === 'upd') arr = arr.filter(it => st.updates[it.name]);
  else if (st.filter === 'err') arr = arr.filter(it => it.error);
  else if (st.filter === 'dup') arr = arr.filter(it => dup.has(it.name));
  if (st.q) {
    const q = st.q.toLowerCase();
    arr = arr.filter(it => {
      const inf = st.info[it.name] || {};
      return ((inf.title || '') + ' ' + it.name + ' ' + (inf.desc || it.desc || '')).toLowerCase().includes(q);
    });
  }
  const cName = (x) => { const inf = st.info[x.name] || {}; return String(inf.title || x.name.replace(/\.zip$/i, '')).toLowerCase(); };
  const cmp = {
    name: (a, b) => cName(a).localeCompare(cName(b), 'zh-Hans-CN'),
    file: (a, b) => a.name.localeCompare(b.name),
    size: (a, b) => b.size - a.size,
    time: (a, b) => b.mtime - a.mtime
  }[st.sort] || ((a, b) => cName(a).localeCompare(cName(b), 'zh-Hans-CN'));
  /* 文件夹置顶（PCL 的 folderFirstCompare 同样如此） */
  arr.sort((a, b) => (a.isFolder === b.isFolder ? cmp(a, b) : (a.isFolder ? -1 : 1)));
  return arr;
}
function resRenderFilters(key) {
  const c = RES_UI[key], st = c.st;
  const dup = resDupSet(st.items);
  const defs = [
    ['all', '全部', st.items.length],
    ['upd', '可更新', Object.keys(st.updates || {}).length],
    ['err', '错误', st.items.filter(i => i.error).length],
    ['dup', '重复', dup.size]
  ];
  /* 当前筛选没内容了（比如刚更新完）就退回「全部」，否则会停在一个空列表上 */
  if (!defs.some(d => d[0] === st.filter && (d[0] === 'all' || d[2] > 0))) st.filter = 'all';
  const host = $(c.filters);
  host.innerHTML = '';
  defs.forEach(([f, label, n]) => {
    if (f !== 'all' && !n) return;   /* PCL 只显示有内容的筛选项（截图里只有「全部 / 可更新」） */
    const b = el('button', 'tab' + (st.filter === f ? ' active' : ''), label + '（' + n + '）');
    b.addEventListener('click', () => { st.filter = f; resRender(key); });
    host.appendChild(b);
  });
}
function resRenderBatch(key) {
  const c = RES_UI[key], st = c.st;
  const n = st.sel.size;
  $(c.batch).style.display = n ? '' : 'none';
  if (!n) return;
  $(c.batchTx).textContent = '已选择 ' + n + ' 个' + c.label;
  const updN = [...st.sel].filter(nm => st.updates[nm]).length;
  $(c.batchUpd).style.display = updN ? '' : 'none';
  $(c.batchUpd).textContent = '更新所选（' + updN + '）';
}
function resRow(key, it) {
  const c = RES_UI[key], st = c.st;
  const inf = st.info[it.name] || {};
  const title = inf.title || it.name.replace(/\.zip$/i, '');
  const desc = inf.desc || it.desc || '';
  const icon = inf.icon || it.icon || '';
  const upd = st.updates[it.name];
  const row = el('div', 'ver-row mod-row res-pack' + (st.sel.has(it.name) ? ' res-pack-sel' : '') + (it.error ? ' res-pack-err' : ''));
  row.title = (st.dir ? st.dir + '\\' : '') + it.name + (it.sha1 ? '\nsha1：' + it.sha1 : '') + '\n单击选中，可批量删除 / 更新';
  const meta = [it.name, (it.size / 1048576).toFixed(2) + ' MB', it.isFolder ? '文件夹' : '', it.format ? '包格式 ' + it.format : ''].filter(Boolean).join(' · ');
  row.innerHTML =
    '<div class="mod-ic-wrap">' + (icon ? '<img class="mod-ic" src="' + icon + '" alt="">' : '<div class="mod-ic ph"><svg class="ic"><use href="#' + c.icon + '"/></svg></div>') + '</div>' +
    '<div class="mod-main">' +
      '<div class="mod-title"><b>' + esc(title) + '</b>' +
        (inf.version ? '<span class="pill release">' + esc(inf.version) + '</span>' : '') +
        (upd ? '<span class="pill snapshot">可更新 → ' + esc(upd.latest) + '</span>' : '') +
        (it.error ? '<span class="pill old_beta">' + esc(it.error) + '</span>' : '') +
      '</div>' +
      '<div class="mod-file">' + esc(meta) + '</div>' +
      (desc ? '<p class="mod-desc">' + esc(desc) + '</p>' : '') +
    '</div>' +
    '<div class="v-act"></div>';
  const act = row.querySelector('.v-act');
  if (upd) {
    const ub = el('button', 'btn upd', '更新');
    ub.title = '当前版本：' + (upd.current || '?') + '\n最新版本：' + (upd.latest || '?') + '（Modrinth）\n点击更新，旧文件会移入系统回收站';
    ub.addEventListener('click', (e) => { e.stopPropagation(); resDoUpdate(key, [it.name]); });
    act.appendChild(ub);
  }
  const del = el('button', 'btn ghost', '删除');
  del.addEventListener('click', (e) => { e.stopPropagation(); resDelete(key, [it.name]); });
  act.appendChild(del);
  row.addEventListener('click', () => {
    if (st.sel.has(it.name)) st.sel.delete(it.name); else st.sel.add(it.name);
    resRender(key);
  });
  return row;
}
function resRender(key) {
  const c = RES_UI[key], st = c.st;
  ressTargetUpdate(key);
  resRenderFilters(key);
  const list = $(c.list);
  const arr = resFiltered(key);
  if (!st.items.length) {
    list.innerHTML = '<div class="empty-sm">' + (resInstance()
      ? '这个实例还没有' + c.label + ' —— 点「从文件安装」或「下载新' + c.label + '」'
      : '先在「基础设置 → 默认启动实例」里选一个实例') + '</div>';
  } else if (!arr.length) {
    list.innerHTML = '<div class="empty-sm">没有符合当前筛选的' + c.label + '</div>';
  } else {
    list.innerHTML = '';
    arr.forEach(it => list.appendChild(resRow(key, it)));
  }
  resRenderBatch(key);
  $(c.batch).style.display = st.sel.size ? '' : 'none';
}
function ressTargetUpdate(key) {
  const c = RES_UI[key], st = c.st;
  const inst = resInstance();
  const label = { resourcepack: 'resourcepacks', shader: 'shaderpacks' }[c.kind];
  $(c.target).textContent = '目标实例：' + (inst || '（未选择）') + (st.dir ? ' · ' + st.dir : '') + '（' + label + '）';
}
async function resLoad(key, refresh) {
  const c = RES_UI[key], st = c.st;
  const instance = resInstance();
  st.sel.clear(); st.info = {}; st.updates = {};
  ressTargetUpdate(key);
  $(c.list).innerHTML = '<div class="empty-sm">正在读取' + c.label + '目录…</div>';
  const r = await window.lmc.resList({ kind: c.kind, instance });
  if (!r || !r.ok) { $(c.list).innerHTML = '<div class="empty-sm">读取失败：' + esc((r && r.error) || '未知错误') + '</div>'; return; }
  st.items = r.items || [];
  st.dir = r.dir || '';
  st.loaded = true;
  resRenderFilters(key); /* 先让筛选条回到合法状态，再渲染列表 */
  resRender(key);
  if (!st.items.length) return;
  /* 在线名称 / 简介 / 图标 + 可更新（主进程 15 分钟缓存；没网就只用本地信息，不影响使用） */
  const ur = await window.lmc.resCheckUpdates({ kind: c.kind, instance, refresh: !!refresh });
  if (!ur || !ur.ok || resInstance() !== instance) return;
  st.info = ur.info || {};
  st.updates = ur.updates || {};
  resRender(key);
}
async function resDelete(key, names) {
  const c = RES_UI[key];
  const list = (names && names.length ? names : [...c.st.sel]);
  if (!list.length) return;
  if (!(await askConfirm('删除 ' + list.length + ' 个' + c.label + '？', {
    danger: true, okText: '删除',
    detail: list.slice(0, 8).join('\n') + (list.length > 8 ? '\n…' : '') + '\n\n文件会移入系统回收站，可以找回。'
  }))) return;
  let ok = 0, fail = 0;
  for (const name of list) {
    const r = await window.lmc.resDelete({ kind: c.kind, instance: resInstance(), name });
    if (r && r.ok) ok++; else fail++;
  }
  toast('已删除 ' + ok + ' 个' + c.label + (fail ? '，' + fail + ' 个失败' : ''), fail ? 'warn' : 'ok');
  await resLoad(key, false);
}
async function resDoUpdate(key, names) {
  const c = RES_UI[key], st = c.st;
  const list = (names || []).map(n => ({ name: n, u: st.updates[n] })).filter(x => x.u);
  if (!list.length) return;
  const desc = list.map(x => '· ' + (x.u.title || x.name) + '：' + (x.u.current || '?') + ' → ' + (x.u.latest || '?')).join('\n');
  if (!(await askConfirm('更新 ' + list.length + ' 个' + c.label + '？', {
    okText: '继续更新',
    detail: desc + '\n\n新版本可能与当前游戏版本或其它资源不兼容；旧文件会移入系统回收站，出问题可以找回。'
  }))) return;
  let ok = 0, fail = 0;
  for (const x of list) {
    const r = await window.lmc.resUpdate({ kind: c.kind, instance: resInstance(), name: x.name });
    if (r && r.ok) ok++; else fail++;
  }
  toast('已更新 ' + ok + ' 个' + c.label + (fail ? '，' + fail + ' 个失败' : ''), fail ? 'warn' : 'ok');
  await resLoad(key, true);
}
async function resInstall(key) {
  const c = RES_UI[key];
  const pick = await window.lmc.resPickFiles();
  if (!pick || !pick.ok || !pick.files || !pick.files.length) return;
  let r = await window.lmc.resInstall({ kind: c.kind, instance: resInstance(), files: pick.files });
  if (r && r.conflicts && r.conflicts.length) {
    const yes = await askConfirm('有 ' + r.conflicts.length + ' 个同名文件已存在，要覆盖吗？', {
      okText: '覆盖', detail: r.conflicts.slice(0, 8).join('\n') + (r.conflicts.length > 8 ? '\n…' : '')
    });
    if (yes) r = await window.lmc.resInstall({ kind: c.kind, instance: resInstance(), files: r.conflictFiles, overwrite: true });
  }
  const inN = (r && r.installed && r.installed.length) || 0;
  const badN = (r && r.failed && r.failed.length) || 0;
  if (inN) toast('已安装 ' + inN + ' 个' + c.label);
  else if (!badN) toast('没有安装任何文件', 'warn');
  if (badN) toast(badN + ' 个文件安装失败：' + r.failed[0].error, 'error');
  await resLoad(key, false);
}
async function resExport(key) {
  const c = RES_UI[key], st = c.st;
  const arr = resFiltered(key);
  if (!arr.length) { toast('没有可导出的' + c.label, 'warn'); return; }
  const head = ['文件名', '资源名称', '描述', '包格式', '文件大小（字节）', '当前版本', '可更新版本', '文件路径'];
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = [head.join(',')];
  arr.forEach(it => {
    const inf = st.info[it.name] || {};
    const upd = st.updates[it.name];
    lines.push([
      it.name, inf.title || '', String(inf.desc || it.desc || '').replace(/\s+/g, ' '),
      it.format || '', it.size, inf.version || '', upd ? upd.latest : '',
      (st.dir || '') + '\\' + it.name
    ].map(q).join(','));
  });
  const r = await window.lmc.resExportCsv({
    defaultName: c.kind === 'shader' ? 'shaderpacks.csv' : 'resourcepacks.csv',
    content: lines.join('\r\n')
  });
  if (r && r.ok) toast('已导出到 ' + r.path);
  else if (r && !r.canceled) toast('导出失败：' + (r.error || '未知错误'), 'error');
}
function resGoDownload(key) {
  const cat = key === 'sp' ? 'shader' : 'resourcepack';
  gotoPage('download');
  const tab = $('#dlTabs .tab[data-cat="' + cat + '"]');
  if (tab) tab.click();
  if (key === 'sp') {
    /* 光影下载页支持按版本筛：把目标版本设成当前实例，列表直接对上号 */
    const sel = $('#spTarget'), inst = resInstance();
    if (sel && inst && [...sel.options].some(o => o.value === inst)) {
      sel.value = inst;
      sel.dispatchEvent(new Event('change'));
    }
  }
}
Object.keys(RES_UI).forEach(key => {
  const c = RES_UI[key], st = c.st;
  $(c.open).addEventListener('click', async () => {
    const r = await window.lmc.resOpenFolder({ kind: c.kind, instance: resInstance() });
    if (r && !r.ok) toast('打开失败：' + (r.error || '未知错误'), 'error');
  });
  $(c.install).addEventListener('click', () => resInstall(key));
  $(c.download).addEventListener('click', () => resGoDownload(key));
  $(c.selectAll).addEventListener('click', () => {
    const arr = resFiltered(key);
    if (st.sel.size >= arr.length && arr.length) st.sel.clear();
    else arr.forEach(it => st.sel.add(it.name));
    resRender(key);
  });
  $(c.export).addEventListener('click', () => resExport(key));
  $(c.sort).addEventListener('click', () => {
    const order = ['name', 'file', 'size', 'time'];
    st.sort = order[(order.indexOf(st.sort) + 1) % order.length];
    $(c.sort).textContent = '排序：' + RES_SORT_LABEL[st.sort] + ' ⇅';
    resRender(key);
  });
  $(c.search).addEventListener('input', () => { st.q = $(c.search).value.trim(); resRender(key); });
  $(c.batchDel).addEventListener('click', () => resDelete(key));
  $(c.batchClear).addEventListener('click', () => { st.sel.clear(); resRender(key); });
  $(c.batchUpd).addEventListener('click', () => resDoUpdate(key, [...st.sel].filter(nm => st.updates[nm])));
});

async function loadMods() {
  const box = $('#modList');
  const instance = $('#modTarget').value || '';
  box.innerHTML = '<div class="empty-sm">正在读取 MOD 目录…</div>';
  const r = await window.lmc.modsList({ instance });
  if (!r.ok) { box.innerHTML = '<div class="empty-sm">读取失败: ' + esc(r.error) + '</div>'; return; }
  const mods = r.mods;
  currentMods = mods; currentModsMeta = {};
  const sum = $('#modsSummary');
  sum.style.display = mods.length ? '' : 'none';
  sum.innerHTML = '「' + esc(instance || '全局 mods 目录') + '」共 <b>' + mods.length + '</b> 个 MOD · 启用 <b>' + mods.filter(m => !m.disabled).length + '</b> · 禁用 <b>' + mods.filter(m => m.disabled).length + '</b>（禁用只是改名 .disabled，不删文件）';
  renderModRows(instance);
  if (!mods.length) return;
  /* 异步富化：批量读 jar 元数据 + Modrinth 匹配，回来后带图标重渲染 */
  const er = await window.lmc.modsEnrich({ instance, names: mods.map(m => m.name) });
  if (er.ok && $('#modTarget').value === instance && currentMods === mods) {
    currentModsMeta = er.meta || {};
    renderModRows(instance);
  }
  /* 富化完顺手查更新（主进程有 15 分钟缓存，切页不会反复联网；「检查更新」按钮才强制刷新） */
  checkModUpdates(instance, false);
}
function renderModRows(instance) {
  const box = $('#modList');
  const on = currentMods.filter(m => !m.disabled).length;
  const sum = $('#modsSummary');
  sum.style.display = currentMods.length ? '' : 'none';
  if (currentMods.length) sum.innerHTML = '「' + esc(instance || '全局 mods 目录') + '」共 <b>' + currentMods.length + '</b> 个 MOD · 启用 <b>' + on + '</b> · 禁用 <b>' + (currentMods.length - on) + '</b>（禁用只是改名 .disabled，不删文件）';
  box.innerHTML = '';
  if (!currentMods.length) { box.innerHTML = '<div class="empty-sm">' + (instance ? '该实例的 mods 目录为空' : 'MOD 目录为空') + ' —— 到「下载 → MOD」安装一些吧</div>'; return; }
  currentMods.forEach(m => {
    const meta = currentModsMeta[m.name] || {};
    const title = dispTitle(meta.online && meta.online.titleZh, meta.online && meta.online.title) || (meta.local && meta.local.name) || m.name.replace(/\.jar(\.disabled)?$/i, '');
    const desc = (meta.online && meta.online.description) || (meta.local && meta.local.description) || '';
    const icon = (meta.online && meta.online.iconDataUri) || meta.localIconDataUri || '';
    const row = el('div', 'ver-row mod-row' + (m.disabled ? ' mod-off' : ''));
    row.innerHTML =
      '<div class="mod-ic-wrap">' + (icon ? '<img class="mod-ic" src="' + icon + '" alt="">' : '<div class="mod-ic ph"><svg class="ic"><use href="#i-puzzle"/></svg></div>') + '</div>' +
      '<div class="mod-main">' +
        '<div class="mod-title"><b>' + esc(title) + '</b>' + (meta.version ? '<span class="pill release">' + esc(meta.version) + '</span>' : '') + '</div>' +
        '<div class="mod-file">' + esc(m.name) + ' · ' + (m.size / 1048576).toFixed(1) + ' MB' + (meta.loaders && meta.loaders.length ? ' · ' + esc(meta.loaders.join('/')) : '') + '</div>' +
        (desc ? '<p class="mod-desc">' + esc(desc) + '</p>' : '') +
      '</div>' +
      '<div class="v-type"><span class="pill ' + (m.disabled ? 'old_beta' : 'release') + '">' + (m.disabled ? '已禁用' : '启用中') + '</span></div>' +
      '<div class="v-act"></div>';
    const act = row.querySelector('.v-act');
    const info = el('button', 'btn ghost', '详情');
    info.addEventListener('click', () => openModDetail(m, instance));
    const upd = modsUpd && modsUpd[m.name];
    if (upd && !m.disabled) {
      /* PCL 式更新按钮：有新版才出现，悬停能看到「当前 → 最新」（来源也标明） */
      const ub = el('button', 'btn upd', '更新');
      ub.title = '当前版本：' + (upd.current || '?') + '\n最新版本：' + (upd.latest || '?') +
        '（' + (upd.src === 'curseforge' ? 'CurseForge' : 'Modrinth') + '）\n点击更新，旧文件会移入系统回收站';
      ub.addEventListener('click', () => doModsUpdate([m.name]));
      act.appendChild(ub);
    }
    const tg = el('button', 'btn ghost', m.disabled ? '启用' : '禁用');
    tg.addEventListener('click', async () => {
      const rr = await window.lmc.modsToggle({ name: m.name, instance });
      if (rr.ok) loadMods(); else toast('操作失败: ' + rr.error, 'error');
    });
    const del = el('button', 'btn ghost', '删除');
    del.addEventListener('click', async () => {
      if (!(await askConfirm('删除 MOD「' + m.name + '」？', { danger: true }))) return;
      const rr = await window.lmc.modsDelete({ name: m.name, instance });
      if (rr.ok) loadMods(); else toast('删除失败: ' + rr.error, 'error');
    });
    act.appendChild(info); act.appendChild(tg); act.appendChild(del);
    box.appendChild(row);
  });
}
/* PCL 式 MOD 详情卡 */
function openModDetail(m, instance) {
  const meta = currentModsMeta[m.name] || {};
  const local = meta.local || {}, online = meta.online || {};
  const title = dispTitle(online.titleZh, online.title) || local.name || m.name.replace(/\.jar(\.disabled)?$/i, '');
  const desc = online.descZh || online.description || local.description || '（没有找到该 MOD 的简介信息）';
  const icon = online.iconDataUri || '';
  const gv = meta.gameVersions || [];
  const gvText = gv.length ? (gv.length > 3 ? gv.slice(0, 3).join(', ') + ' 等 ' + gv.length + ' 个' : gv.join(', ')) : '';
  modalVer = null;
  modalBox.innerHTML =
    '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> MOD 详情</h3>' +
    '<div class="mod-detail">' +
      '<div class="md-head">' +
        (icon ? '<img class="md-icon" src="' + icon + '" alt="">' : '<div class="md-icon ph"><svg class="ic"><use href="#i-puzzle"/></svg></div>') +
        '<div class="md-title"><b>' + esc(title) + '</b>' +
          '<div class="md-pills">' +
            (meta.version ? '<span class="pill release">' + esc(meta.version) + '</span>' : '') +
            (meta.loaders && meta.loaders.length ? '<span class="pill">' + esc(meta.loaders.join(' / ')) + '</span>' : '') +
            '<span class="pill ' + (m.disabled ? 'old_beta' : 'release') + '">' + (m.disabled ? '已禁用' : '启用中') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p class="md-desc">' + esc(desc) + '</p>' +
      '<div class="md-meta">' +
        '<div><span>文件</span><b>' + esc(m.name) + '</b></div>' +
        '<div><span>所属实例</span><b>' + esc(instance || '全局 mods 目录') + '</b></div>' +
        '<div><span>大小</span><b>' + (meta.size != null ? (meta.size / 1048576).toFixed(2) + ' MB' : (m.size / 1048576).toFixed(2) + ' MB') + '</b></div>' +
        (local.id ? '<div><span>Mod ID</span><b>' + esc(local.id) + '</b></div>' : '') +
        (local.authors ? '<div><span>作者</span><b>' + esc(local.authors) + '</b></div>' : '') +
        (gvText ? '<div><span>支持版本</span><b>' + esc(gvText) + '</b></div>' : '') +
        (meta.sha1 ? '<div><span>SHA1</span><b class="mono">' + esc(meta.sha1.slice(0, 16)) + '…</b></div>' : '') +
      '</div>' +
      (online.title || local.description ? '' : '<div class="warnbar tip">该 MOD 未在 Modrinth 收录或离线状态，仅显示文件内置信息</div>') +
    '</div>' +
    '<div class="mfoot">' +
      '<button class="btn ghost" id="mdClose">关闭</button>' +
      (online.pageUrl ? '<button class="btn primary" id="mdOpen"><svg class="ic sm"><use href="#i-external"/></svg> 查看 Modrinth 页面</button>' : '') +
    '</div>';
  openModal(true);   /* MOD 详情弹窗 */
  $('#mdClose').addEventListener('click', closeModal);
  const ob = $('#mdOpen');
  if (ob) ob.addEventListener('click', () => window.lmc.openUrl(online.pageUrl));
}
$('#btnModsRefresh').addEventListener('click', () => loadMods());
$('#btnModsCheck').addEventListener('click', () => checkModUpdates($('#modTarget').value || '', true));
/* 下载页 PCL 式详情：源站简介 + 截图 + 适配文件列表 + 外链（CurseForge / MC 百科 / Modrinth） */
const WIKI_SEARCH = t => 'https://zh.minecraft.wiki/w/Special:%E6%90%9C%E7%B4%A2?search=' + encodeURIComponent(t);
/* kind = 资源类型（mod / modpack / resourcepack / shader / datapack）。详情页里的「安装」
   按钮要按类型路由：MOD 走 install-mod（认加载器、认实例），其余走 install-pack（固定目录）。 */
async function openResDetail(h, source, targetSel, typeName, kind) {
  modalVer = null;
  modalBox.innerHTML = '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> 详情</h3><div class="empty-sm">正在加载详情…</div>';
  openModal(true);   /* 资源详情：先显示占位，详情取回后重绘 */
  /* 「全部」= 不指定实例：详情列出全部文件，安装时自动挑一个带加载器的实例 */
  const rawTid = targetSel ? $(targetSel).value : '';
  const allMode = rawTid === '__all__';
  const tid = allMode ? '' : rawTid;
  const r = await window.lmc.modrinthDetail({ source, projectId: h.id, versionId: tid });
  if (!r.ok) {
    modalBox.innerHTML = '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> 详情</h3>' +
      '<div class="empty-sm">详情加载失败：' + esc(r.error || '') + '</div>' +
      '<div class="mfoot"><button class="btn ghost" id="mdClose">关闭</button></div>';
    $('#mdClose').addEventListener('click', closeModal);
    return;
  }
  /* PCL 式详情标题：中文名作主标题，英文原名/版次作副标题 */
  const rawTitle = r.title || h.title || '';
  const zhForTitle = h.titleZh || '';
  const titleMain = zhForTitle && zhForTitle !== rawTitle ? zhForTitle.split(' (')[0] : (rawTitle || zhForTitle);
  const titleSubs = (h.titleSub && h.titleSub.length) ? h.titleSub : (zhForTitle && zhForTitle !== rawTitle ? [rawTitle] : []);
  const titleHtml = esc(titleMain) + titleSubs.filter(Boolean)
    .map(s => '<span class="md-title-sub">' + esc(s) + '</span>').join('');
  const metaBits = [fmtNum(r.downloads || h.downloads || 0) + ' 下载'];
  if (h.author) metaBits.unshift('作者 ' + h.author);
  (r.tags || []).forEach(t => metaBits.push(t));
  const links = [];
  if (r.pageUrl) links.push('<button class="btn primary" id="mdSrc"><svg class="ic sm"><use href="#i-external"/></svg> ' + (source === 'curseforge' ? 'CurseForge 页面' : 'Modrinth 页面') + '</button>');
  links.push('<button class="btn ghost" id="mdWiki"><svg class="ic sm"><use href="#i-globe"/></svg> MC 百科</button>');
  if (r.sourceUrl) links.push('<button class="btn ghost" id="mdRepo"><svg class="ic sm"><use href="#i-globe"/></svg> 源代码</button>');
  const kindName = kind || 'mod';
  const fileDest = kindName === 'datapack' ? '所选存档的 datapacks'
    : kindName === 'shader' ? '所选实例的 shaderpacks（选「全部」则放游戏根目录）'
      : kindName === 'resourcepack' ? '游戏目录的 resourcepacks'
        : allMode ? '自动选择的实例' : '目标实例';
  const filesHtml = (r.files && r.files.length)
    ? '<div class="md-files"><div class="md-sec">适配 ' + esc(tid || '全部版本') + ' 的文件（最新 ' + r.files.length + ' 个，点击行内按钮安装到' + esc(fileDest) + '）</div>' +
      r.files.map((f, i) =>
        '<div class="ver-row md-frow"><div class="v-name">' + esc(f.name) +
        '<span class="res-meta">' + fmtDate(f.date) + ' · ' + ((f.size || 0) / 1048576).toFixed(2) + ' MB' +
        (f.tags && f.tags.length ? ' · ' + esc(f.tags.join(' / ')) : '') + '</span></div>' +
        '<div class="v-act"><button class="btn ghost md-fi" data-fi="' + i + '">安装</button></div></div>').join('') + '</div>'
    : (tid ? '<div class="warnbar tip">没有查到适配该版本的文件记录</div>' : '');
  const galHtml = (r.gallery && r.gallery.length) ? '<div class="md-gallery">' + r.gallery.map(u => '<img src="' + u + '" alt="">').join('') + '</div>' : '';
  modalBox.innerHTML =
    '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> ' + esc(typeName || '资源') + '详情</h3>' +
    '<div class="mod-detail">' +
      '<div class="md-head">' +
        (r.icon ? '<img class="md-icon" src="' + r.icon + '" alt="">' : '<div class="md-icon ph"><svg class="ic"><use href="#i-puzzle"/></svg></div>') +
        '<div class="md-title"><b>' + titleHtml + '</b><div class="md-pills">' +
          metaBits.map(x => '<span class="pill">' + esc(x) + '</span>').join('') + '</div></div>' +
      '</div>' +
      '<div class="md-linkrow">' + links.join('') + '</div>' +
      galHtml +
      (r.descHtml ? '<div class="md-html">' + r.descHtml + '</div>' : '<p class="md-desc">（暂无详细介绍）</p>') +
      filesHtml +
    '</div>' +
    '<div class="mfoot"><button class="btn ghost" id="mdClose">关闭</button></div>';
  $('#mdClose').addEventListener('click', closeModal);
  const sBtn = $('#mdSrc'); if (sBtn) sBtn.addEventListener('click', () => window.lmc.openUrl(r.pageUrl));
  const wBtn = $('#mdWiki'); if (wBtn) wBtn.addEventListener('click', () => window.lmc.openUrl(WIKI_SEARCH(h.title || r.title || '')));
  const rBtn = $('#mdRepo'); if (rBtn) rBtn.addEventListener('click', () => window.lmc.openUrl(r.sourceUrl));
  /* 中文翻译二阶段：先出原文，译完无缝替换；CF 的完整描述（cfwidget）到达后再翻一次 */
  const applyTr = (html) => { const el2 = modalBox.querySelector('.md-html'); if (el2 && html) el2.innerHTML = html; };
  window.lmc.modrinthTranslate({ projectId: h.id }).then(tr => {
    if (tr && tr.ok && !tr.alreadyZh && tr.descHtml) applyTr(tr.descHtml);
  }).catch(() => {});
  if (source === 'curseforge' && r.slug) {
    window.lmc.modrinthCfDesc({ slug: r.slug }).then(async d2 => {
      if (d2 && d2.ok && d2.descHtml && d2.descHtml.length > 100) {
        applyTr(d2.descHtml);
        const tr = await window.lmc.modrinthTranslate({ projectId: h.id }).catch(() => null);
        if (tr && tr.ok && !tr.alreadyZh && tr.descHtml) applyTr(tr.descHtml);
      }
    }).catch(() => {});
  }
  modalBox.querySelectorAll('button.md-fi').forEach(b => b.addEventListener('click', async () => {
    const f = r.files[+b.dataset.fi];
    let tgt = tid;
    if (kindName === 'mod') {
      /* 「全部」模式下未指定实例 → 自动挑一个带加载器的实例；其余情况必须显式指定 */
      if (!tgt) {
        if (!allMode) { toast('请先在下载页选择目标版本', 'warn'); return; }
        tgt = pickModInstance();
        if (!tgt) { toast('还没有带模组加载器的版本 —— 请先安装一个 Fabric / Forge / NeoForge 版本', 'warn'); return; }
      }
      b.disabled = true; b.textContent = '下载中…';
      const rr = await window.lmc.modrinthInstallMod({ projectId: h.id, versionId: tgt, instance: tgt, source, fileRef: f.ref });
      b.disabled = false; b.textContent = '安装';
      if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
      else toast('已装入 ' + tgt + '：' + rr.file);
      return;
    }
    /* 数据包必须选中存档；资源包 / 光影装到各自固定目录（光影 tid 为空即游戏根目录，不必挑实例） */
    if (kindName === 'datapack' && !tgt) { toast('请先在下载页选择一个存档（世界）', 'warn'); return; }
    b.disabled = true; b.textContent = '下载中…';
    const rr = await window.lmc.modrinthInstallPack({
      type: kindName, projectId: h.id, source,
      world: kindName === 'datapack' ? tgt : '',
      instance: kindName === 'shader' ? tgt : '',
      fileRef: f.ref
    });
    b.disabled = false; b.textContent = '安装';
    if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
    else toast('已安装：' + rr.file);
  }));
}
$('#modTarget').addEventListener('change', () => loadMods());
$('#btnModsOpen').addEventListener('click', () => {
  const instance = $('#modTarget').value || '';
  window.lmc.openPath(instance
    ? (S.config.gameDir || '') + '\\versions\\' + instance + '\\mods'
    : (S.config.gameDir || '') + '\\mods');
});

/* ---------------- 账户（多账户 / 自定义皮肤） ---------------- */
function syncAccountUI(activeName) {
  if (activeName) {
    $('#inpName').value = activeName;
    $('#heroName').textContent = activeName;
    setAvatarLetter();
    $('#setUsername').value = activeName;
    heroHeadFor(activeName);
  }
}
function accBtn(label, fn) {
  const b = el('button', 'btn ghost', label);
  b.addEventListener('click', fn);
  return b;
}
async function applyAccounts(r, okMsg) {
  if (r && r.ok) {
    if (okMsg) toast(okMsg);
    syncAccountUI(r.active);
    renderAccounts(r.accounts, r.active);
  } else if (r && !r.canceled) {
    toast(r.error || '操作失败', 'error');
  }
}
/* 主页头像：从当前账户的离线皮肤 PNG 裁出头部（面部 8,8 + 帽子/头发行 40,8）按像素风放大绘制
 * 皮肤可能是 64x64（含独立帽子层）或 64x32（旧版，无独立层），无皮肤时画默认头像兜底 */
/* 默认头像 = 标准 Minecraft 史蒂夫（官方皮肤配色，无自定义皮肤时使用）
 * 8x8 网格：眼睛留白一格（史蒂夫是 2px 宽的白眼 + 2px 蓝瞳） */
function drawSteveHead(ctx, u) {
  const S = {
    skin: '#b5836c',   /* 史蒂夫肤色 */
    shade: '#9c6f58',  /* 面部阴影 */
    hair: '#1f1409',   /* 深棕头发 */
    eyeW: '#ffffff',   /* 眼白 */
    iris: '#3b2c8f',   /* 蓝瞳 */
    brow: '#4b2f1c',   /* 眉 / 鼻影 */
    mouth: '#6b4535',  /* 嘴 */
    beard: '#2d1c10'   /* 下巴胡茬 */
  };
  const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(u * x, u * y, u * w, u * h); };
  rect(0, 0, 8, 8, S.skin);
  /* 头发：顶部一整层 + 两侧鬓角向下 */
  rect(0, 0, 8, 2, S.hair);
  rect(0, 0, 1, 3, S.hair); rect(7, 0, 1, 3, S.hair);
  rect(0, 3, 1, 1, S.shade); rect(7, 3, 1, 1, S.shade);
  /* 眉毛 */
  rect(1, 2.6, 2, 0.5, S.brow); rect(5, 2.6, 2, 0.5, S.brow);
  /* 眼睛：眼白 + 蓝瞳（史蒂夫瞳色偏右） */
  rect(1, 3.2, 2, 1, S.eyeW); rect(5, 3.2, 2, 1, S.eyeW);
  rect(1.6, 3.2, 1.2, 1, S.iris); rect(5.6, 3.2, 1.2, 1, S.iris);
  /* 鼻影 + 嘴 + 下巴胡茬 */
  rect(3.4, 4.4, 1.2, 0.8, S.brow);
  rect(3, 5.6, 2, 0.6, S.mouth);
  rect(2.5, 6.6, 3, 0.6, S.beard);
}
function renderHeroHead(dataUrl) {
  const cv = $('#heroHead');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, u = W / 8;   /* 面部按 8x8 像素网格缩放 */
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  /* 没有自定义皮肤 → 画标准史蒂夫头像（不是抽象占位） */
  const drawDefault = () => { ctx.clearRect(0, 0, W, H); drawSteveHead(ctx, u); };
  if (!dataUrl) { drawDefault(); return; }
  const img = new Image();
  img.onload = () => {
    const legacy = img.width === 64 && img.height === 32;   /* 旧版皮肤没有独立帽子层 */
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, W, H);             /* 面部 */
    if (!legacy) ctx.drawImage(img, 40, 8, 8, 8, 0, 0, W, H); /* 帽子/头发层（透明处自然叠加） */
  };
  img.onerror = drawDefault;
  img.src = dataUrl;
}
/* 按玩家名找账户皮肤并刷新主页头像；返回用到的皮肤 dataURL（无则 null） */
function heroHeadFor(name) {
  const list = S.accounts || [];
  const a = list.find(x => x.name === (name || ''));
  renderHeroHead(a ? a.skinUrl : null);
  const wrap = $('#heroHeadWrap');
  if (wrap) wrap.title = (a && a.skinUrl ? '当前皮肤头像：' : '默认皮肤头像（史蒂夫）：') + (name || 'Steve');
  return (a && a.skinUrl) || null;
}
/* 启动时只刷主页头像：拉一次账户列表，不动账户页、不触发「还没账户」引导提示 */
async function loadHeroHead() {
  try {
    const r = await window.lmc.accountList();
    if (r && r.ok) {
      S.accounts = r.accounts || [];
      heroHeadFor(r.active);
      setAvatarLetter();   /* 侧栏左下角小圆的字母：L=正常 / S=极速，不跟随账户首字母 */
      return;
    }
  } catch (_) {}
  renderHeroHead(null);
}
/* 皮肤前视图绘制（64x64 / 64x32 均支持，含帽子层）
   拆成「按画布画」+「按固定 id 画」两层：账户页底部那张预览用 #skinPreview，
   账户设置弹窗里用自己那块画布 —— 同一套绘制逻辑只写一份，免得两处走形。 */
function renderSkinPreview(dataUrl) { const cv = $('#skinPreview'); if (cv) paintSkinPreview(cv, dataUrl); }
function paintSkinPreview(cv, dataUrl) {
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!dataUrl) {
    /* 默认史蒂夫全身（经典 4px 手臂配色），未上传皮肤时展示标准形象 */
    const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
    const SKIN = '#b5836c', SKIN2 = '#9c6f58', HAIR = '#1f1409', EYEW = '#ffffff', IRIS = '#3b2c8f';
    const SHIRT = '#00afaf', SHIRT2 = '#00a0a0';     /* 史蒂夫青色上衣 */
    const PANTS = '#3f3fbf', PANTS2 = '#3535a8';     /* 蓝色裤子 */
    const SHOE = '#6b6b6b';
    /* 头（80x80 / 8px 网格） */
    px(40, 0, 80, 80, SKIN);
    px(40, 0, 80, 20, HAIR); px(40, 0, 10, 30, HAIR); px(110, 0, 10, 30, HAIR);
    px(50, 26, 20, 5, '#4b2f1c'); px(90, 26, 20, 5, '#4b2f1c');
    px(50, 32, 20, 10, EYEW); px(90, 32, 20, 10, EYEW);
    px(56, 32, 12, 10, IRIS); px(96, 32, 12, 10, IRIS);
    px(74, 44, 12, 8, SKIN2); px(70, 56, 20, 6, '#6b4535'); px(65, 66, 30, 6, '#2d1c10');
    /* 躯干 */
    px(40, 84, 80, 116, SHIRT); px(40, 84, 80, 10, SHIRT2);
    /* 双臂（经典 4px：前后各一） */
    px(0, 84, 40, 116, SHIRT); px(0, 190, 40, 10, SKIN); px(120, 84, 40, 116, SHIRT); px(120, 190, 40, 10, SKIN);
    /* 双腿 */
    px(40, 204, 40, 116, PANTS); px(80, 204, 40, 116, PANTS);
    px(40, 310, 40, 10, SHOE); px(80, 310, 40, 10, SHOE);
    px(40, 204, 40, 8, PANTS2); px(80, 204, 40, 8, PANTS2);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const w = img.width, legacy = w === 64 && img.height === 32;
    const draw = (sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    draw(8, 8, 8, 8, 40, 0, 80, 80);           /* 头 */
    if (!legacy) draw(40, 8, 8, 8, 40, 0, 80, 80); /* 帽子层（64x32 无独立帽子层时跳过） */
    draw(20, 20, 8, 12, 40, 80, 80, 120);      /* 身体 */
    draw(44, 20, 4, 12, 0, 80, 40, 120);       /* 右臂 */
    if (!legacy) draw(36, 52, 4, 12, 120, 80, 40, 120); /* 左臂 */
    else draw(44, 20, 4, 12, 120, 80, 40, 120);
    draw(4, 16, 4, 12, 40, 200, 40, 120);      /* 右腿 */
    if (!legacy) draw(20, 52, 4, 12, 80, 200, 40, 120); /* 左腿 */
    else draw(4, 16, 4, 12, 80, 200, 40, 120);
  };
  img.src = dataUrl;
}
function renderAccounts(accounts, active) {
  const box = $('#accList');
  const list = accounts || [];
  S.accounts = list;   /* 主页头像按名字取皮肤用（改玩家名时实时联动） */
  S.accActive = active || '';   /* 账户设置弹窗判定「当前账户」用（别读 S.config：切账户后它不一定同步） */
  $('#accCurTag').textContent = list.length ? '（当前：' + active + '）' : '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-sm">还没有账户。先在上方输入玩家名点「添加」，或用微软正版 / 外置登录创建；<br>创建后可以上传自定义皮肤，进游戏即生效。</div>';
    renderSkinPreview(null);
    heroHeadFor(active);
    return;
  }
  box.innerHTML = '';
  list.forEach(a => {
    const isCur = a.name === active;
    const typeTag = a.type === 'ms'
      ? '<span class="pill release">微软正版</span>'
      : a.type === 'authlib'
        ? '<span class="pill snapshot">外置 · ' + esc(String(a.serverUrl || '').replace(/^https?:\/\//, '').split('/')[0]) + '</span>'
        : '<span class="pill loader">离线</span>';
    /* 微软账户：把「有没有买」直接标在卡片上（owned / gamepass / unknown 三种） */
    const ownTag = a.type === 'ms'
      ? (a.ownership === 'owned' ? '<span class="pill release">已购买</span>'
        : a.ownership === 'gamepass' ? '<span class="pill warn">未查到购买记录</span>'
          : '<span class="pill loader">购买状态未确认</span>')
      : '';
    const row = el('div', 'ver-row mod-row');
    row.innerHTML =
      '<div class="mod-ic-wrap">' + (a.skinUrl
        ? '<img class="mod-ic" style="image-rendering:pixelated" src="' + a.skinUrl + '" alt="">'
        : '<div class="mod-ic ph"><svg class="ic"><use href="#i-user"/></svg></div>') + '</div>' +
      '<div class="mod-main">' +
        '<div class="mod-title"><b>' + esc(a.name) + '</b>' + typeTag + ownTag + (isCur ? '<span class="pill release">当前</span>' : '') +
          (a.type === 'offline' && a.skin ? '<span class="pill ' + (a.model === 'slim' ? 'snapshot' : 'release') + '">' + (a.model === 'slim' ? '苗条 (Alex)' : '经典 (Steve)') + '</span>' : '') + '</div>' +
        '<div class="mod-file">' + (a.type === 'ms'
          ? '微软正版 · ' + (a.ownership === 'owned' ? '名下已确认 Minecraft 许可'
            : a.ownership === 'gamepass' ? '靠 Game Pass 等权益可用（名下未查到购买记录）'
              : '购买状态未确认（可能是网络未通）') +
            (a.gamertag ? ' · Xbox 玩家代号 ' + esc(String(a.gamertag)) : '') + ' · 令牌自动续期'
          : a.type === 'authlib' ? '外置登录 · 皮肤/披风由认证服务器提供 · 启动时正版方式验证'
          : (a.skin ? '自定义皮肤已设置（启动游戏自动生效）' : '默认皮肤（史蒂夫）')) + '</div>' +
      '</div>' +
      '<div class="v-act"></div>';
    const act = row.querySelector('.v-act');
    if (!isCur) act.appendChild(accBtn('设为当前', async () => {
      applyAccounts(await window.lmc.accountSwitch({ name: a.name }), '已切换到 ' + a.name);
    }));
    /* 皮肤 / 模型 / 玩家名统一收进「账户设置」弹窗（这些按钮以前全摊在行上，一行能挤出 6 个）。
       入口按要求放在「删除」左边：想改哪个账户，就在它自己那行点「设置」。 */
    act.appendChild(accBtn('设置', () => openAccountSettings(a.name)));
    act.appendChild(accBtn('删除', async () => {
      if (!(await askConfirm('确定删除账户「' + a.name + '」？', { danger: true, detail: a.type === 'offline' ? '其皮肤文件也会一并删除。' : '将退出该在线账户。' }))) return;
      applyAccounts(await window.lmc.accountDelete({ name: a.name }), '账户已删除');
    }));
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      renderSkinPreview(a.skinUrl);
    });
    gpMark(row);                       /* 账户行点击预览皮肤 → 手柄也要够得着 */
    box.appendChild(row);
  });
  const cur = list.find(x => x.name === active);
  renderSkinPreview(cur ? cur.skinUrl : null);
  heroHeadFor(active);
}
/* ---------------- 账户设置弹窗 ----------------
 * 入口：账户列表每行的「设置」按钮（按要求放在「删除」左边）—— 就地改这个账户：
 *   皮肤（上传 / 更换 / 移除）、皮肤模型（经典 / 苗条）、玩家名（仅离线账户）。
 * 在线账户（微软 / 外置登录）的皮肤与玩家名都由认证服务器说话：这里照实说明「谁在提供」并
 * 收起文件类操作，而不是给一个点了没反应的按钮。
 * 每次改动后走 applyAccounts（列表 + 主页头像一起刷新）再 paint() 重画弹窗，弹窗始终显示最新状态。 */
function openAccountSettings(name) {
  let cur = String(name || '');
  const accOf = () => (S.accounts || []).find(x => x.name === cur);

  function paint() {
    const a = accOf();
    if (!a) { closeModal(); toast('该账户已不存在', 'warn'); return; }
    const online = a.type === 'ms' || a.type === 'authlib';
    const isCur = cur === (S.accActive || '');
    const slim = a.model === 'slim';
    const src = a.type === 'ms' ? '微软官方皮肤服务器'
      : '认证服务器（' + esc(String(a.serverUrl || '').replace(/^https?:\/\//, '').split('/')[0] || '外置登录') + '）';
    const typeTxt = a.type === 'ms' ? '微软正版账户' : a.type === 'authlib' ? '外置登录账户 · ' + src : '离线账户';

    const skinSec = online
      ? '<p class="hint">皮肤由 ' + src + ' 提供，启动器不参与 —— 想换皮肤请到对应的网站上传，进游戏后会自动同步。</p>'
      : '<p class="hint">支持 64x64（新版）与 64x32（旧版）的 PNG。上传后启动游戏即生效，单人游戏与局域网 / 联机房间里的玩家都能看到。</p>' +
        '<div class="btn-row">' +
          '<button class="btn primary" id="accSetSkinPick">' + (a.skin ? '更换皮肤' : '上传皮肤') + '</button>' +
          '<button class="btn ghost" id="accSetSkinDel"' + (a.skin ? '' : ' disabled') + '>移除皮肤</button>' +
        '</div>';
    const modelSec = online
      ? '<p class="hint">模型（经典 / 苗条）由服务器跟着皮肤一起下发，启动器不覆盖。</p>'
      : '<div class="btn-row">' +
          '<button class="btn ' + (slim ? 'ghost' : 'primary') + '" data-model="classic">经典（Steve · 4px 手臂）</button>' +
          '<button class="btn ' + (slim ? 'primary' : 'ghost') + '" data-model="slim">苗条（Alex · 3px 手臂）</button>' +
        '</div>' +
        '<p class="hint">必须与皮肤文件匹配：宽手臂的皮肤配经典，细手臂的配苗条，选错了游戏里手臂会变形。</p>';
    const nameSec = online
      ? '<div class="field-line"><input value="' + esc(a.name) + '" disabled></div>' +
        '<p class="hint">在线账户的玩家名由认证服务器决定，不能在这里改。</p>'
      : '<div class="field-line">' +
          '<input id="accSetName" maxlength="16" value="' + esc(a.name) + '" placeholder="2-16 个字母 / 数字 / 下划线">' +
          '<button class="btn" id="accSetNameSave">保存</button>' +
        '</div>' +
        '<p class="hint">只改启动器里这个账户的名字，不影响任何正版账号；它的皮肤文件会跟着一起改名。</p>';

    modalBox.innerHTML =
      '<h3><svg class="ic sm"><use href="#i-user"/></svg> 账户设置 · <b>' + esc(a.name) + '</b></h3>' +
      '<div class="mmeta">' + typeTxt + (isCur ? ' · 当前正在使用的账户' : '') + '</div>' +
      '<div class="acc-set">' +
        '<div class="acc-set-side">' +
          '<canvas id="accSetSkin" width="160" height="320"></canvas>' +
          '<div class="acc-set-cap">' + (a.skin ? '自定义皮肤' : '默认皮肤（史蒂夫）') + '</div>' +
        '</div>' +
        '<div class="acc-set-body">' +
          '<div class="acc-set-sec"><div class="acc-set-h"><svg class="ic sm"><use href="#i-user-check"/></svg> 皮肤</div>' + skinSec + '</div>' +
          '<div class="acc-set-sec"><div class="acc-set-h"><svg class="ic sm"><use href="#i-user"/></svg> 皮肤模型</div>' + modelSec + '</div>' +
          '<div class="acc-set-sec"><div class="acc-set-h"><svg class="ic sm"><use href="#i-user-plus"/></svg> 玩家名</div>' + nameSec + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mfoot">' +
        '<button class="btn ghost" id="accSetClose">关闭</button>' +
        (isCur ? '' : '<button class="btn primary" id="accSetUse">设为当前账户</button>') +
      '</div>';
    paintSkinPreview($('#accSetSkin'), a.skinUrl);

    const on = (sel, ev, fn) => { const e = $(sel); if (e) e.addEventListener(ev, fn); };
    on('#accSetClose', 'click', closeModal);
    on('#accSetUse', 'click', async () => {
      applyAccounts(await window.lmc.accountSwitch({ name: cur }), '已切换到 ' + cur);
      paint();
    });
    on('#accSetSkinPick', 'click', async () => {
      const r = await window.lmc.accountSkin({ name: cur, model: slim ? 'slim' : 'classic' });
      applyAccounts(r, r && r.ok ? '皮肤已更新（启动游戏后生效）' : '');
      paint();
    });
    on('#accSetSkinDel', 'click', async () => {
      if (!(await askConfirm('移除皮肤', '确定移除「' + cur + '」的自定义皮肤吗？移除后将使用游戏默认皮肤（史蒂夫）。', '移除', true))) return;
      applyAccounts(await window.lmc.accountSkinRemove({ name: cur }), '已恢复默认皮肤');
      paint();
    });
    on('#accSetNameSave', 'click', async () => {
      const to = String(($('#accSetName') || {}).value || '').trim();
      if (to === cur) { toast('玩家名没有变化'); return; }
      const r = await window.lmc.accountRename({ name: cur, to });
      if (r && r.ok) { cur = to; toast('账户已改名为 ' + to); }
      applyAccounts(r, '');
      paint();
    });
    on('#accSetName', 'keydown', (e) => { if (e.key === 'Enter' && $('#accSetNameSave')) $('#accSetNameSave').click(); });
    modalBox.querySelectorAll('[data-model]').forEach(b => b.addEventListener('click', async () => {
      const want = b.dataset.model === 'slim' ? 'slim' : 'classic';
      if (want === (slim ? 'slim' : 'classic')) return;
      applyAccounts(await window.lmc.accountModel({ name: cur, model: want }), '皮肤模型已切换为' + (want === 'slim' ? '苗条（Alex）' : '经典（Steve）'));
      paint();
    }));
  }

  paint();
  openModal(true);
}
async function loadAccounts() {
  const r = await window.lmc.accountList();
  if (r.ok) {
    renderAccounts(r.accounts, r.active); syncAccountUI(r.active);
    /* 无账户引导已改为「启动时弹窗」（见 showNoAccountGuide / bootGuideChain），
       这里不再用右下角 toast —— 那种提示太不起眼，用户容易错过。
       进入本页时若无账户，上方空状态文案本身已经说明了怎么创建。 */
  }
  if (S.config && S.config.msClientId) $('#msClientId').value = S.config.msClientId;
  /* 只有「既没内置、也没自填」应用 ID 时才提示（正常情况永远不提示）—— 每次会话查一次即可 */
  if (!S.msAppInfoChecked) { S.msAppInfoChecked = true; refreshMsAppInfo(); }
}
$('#btnAccAdd').addEventListener('click', async () => {
  const name = $('#accName').value.trim();
  if (!name) { toast('请输入玩家名', 'warn'); return; }
  const r = await window.lmc.accountAdd({ name });
  if (r.ok) { $('#accName').value = ''; toast('账户已添加'); syncAccountUI(r.active); }
  else toast(r.error || '添加失败', 'error');
  renderAccounts(r.accounts, r.active);
});
$('#accName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAccAdd').click(); });

/* ---------------- 添加账户：离线 / 微软正版 / 第三方外置 ---------------- */
$$('.acc-type').forEach(b => b.addEventListener('click', () => {
  $$('.acc-type').forEach(x => x.classList.toggle('active', x === b));
  $('#accFormOffline').style.display = b.dataset.atype === 'offline' ? '' : 'none';
  $('#accFormMs').style.display = b.dataset.atype === 'ms' ? '' : 'none';
  $('#accFormAuthlib').style.display = b.dataset.atype === 'authlib' ? '' : 'none';
}));
$('#authlibPreset').addEventListener('change', () => {
  $('#authlibCustomRow').style.display = $('#authlibPreset').value === 'custom' ? '' : 'none';
});

/* ---------------- 微软正版登录（默认：启动器内置窗口，零配置） ---------------- */
/* 登录进度：主进程按 4 步推送（打开登录页 → 账户信息 → 购买检查 → 角色档案），界面逐条打勾。
   和 PCL2 一样把过程摊开给用户看，而不是干等一个转圈。 */
const MS_STEPS = ['打开微软官方登录页', '获取 Xbox 账户信息', '检查是否已购买 Minecraft', '获取角色档案'];
function renderMsSteps(cur, note) {
  const box = $('#msSteps');
  if (!box) return;
  if (!cur) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = MS_STEPS.map((t, i) => {
    const n = i + 1;
    const state = n < cur ? 'ok' : (n === cur ? 'run' : 'idle');
    return '<div class="ms-step ' + state + '"><span class="mk">' +
      (state === 'ok' ? '✓' : (state === 'run' ? '●' : '○')) + '</span><span>' + t +
      (n === cur && note ? ' <i>' + esc(note) + '</i>' : '') + '</span></div>';
  }).join('');
}
window.lmc.on('account:ms-progress', (d) => {
  if (!d) return;
  renderMsSteps(d.step | 0, d.text);
  if (d.step > 0 && d.text) $('#msStatus').textContent = d.text;
});
/* 购买状态 → 人话 */
function msOwnershipText(ownership) {
  return ownership === 'owned' ? '已购买 Minecraft 正版'
    : ownership === 'gamepass' ? '可用（未查到购买记录，通常是 Xbox Game Pass）'
      : '可用（本次未确认到购买状态）';
}
/* 只有「自建应用」相关的备用流程才需要应用 ID；默认流程永远零配置 */
async function refreshMsAppInfo() {
  let info = null;
  try { info = await window.lmc.accountMsAppInfo(); } catch (_) {}
  S.msAppInfo = info || {};
  const box = $('#msNeedId');
  if (box) box.style.display = (!info || !info.aadReady) ? '' : 'none';
  return info;
}
let msLoginBusy = false, msBtnIdleHtml = '';
/* 默认流程：点按钮 → 在启动器自己的窗口里打开**微软官方**登录页 → 自动截获授权码 →
 * 主进程走 XBL/XSTS → **检查是否已购买** → 角色档案 → 自动添加账户。
 * 不用注册任何应用、不跳系统浏览器、不用抄代码；登录中再点一次 = 取消。 */
$('#btnMsLogin').addEventListener('click', async () => {
  const btn = $('#btnMsLogin'), st = $('#msStatus');
  if (!msBtnIdleHtml) msBtnIdleHtml = btn.innerHTML;
  if (msLoginBusy) {
    st.textContent = '正在取消…';
    await window.lmc.accountMsWebCancel().catch(() => {});
    return;
  }
  msLoginBusy = true;
  btn.textContent = '取消登录';
  renderMsSteps(1, '');
  st.textContent = '正在打开登录窗口…';
  let r;
  try { r = await window.lmc.accountMsWebLogin({}); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  msLoginBusy = false;
  btn.innerHTML = msBtnIdleHtml;
  renderMsSteps(0, '');
  if (r && r.ok) { applyAccounts(r, '已登录 ' + r.name + ' · ' + msOwnershipText(r.ownership)); return; }
  if (r && r.canceled) { st.textContent = ''; toast('已取消登录'); return; }
  /* 失败原因（例如「没有 Minecraft 正版」）留在状态行上，比一闪而过的 toast 更容易看清 */
  st.textContent = (r && r.error) || '登录失败';
  toast((r && r.error) || '登录失败', 'error');
  /* 主进程判定是网络类失败时会顺带跑一次连通性自检，把结果带回来 —— 直接摊在界面上，不用玩家再点一次 */
  if (r && r.netResults && r.netResults.length) {
    renderMsNet({ ok: false, via: r.netVia, results: r.netResults, advice: r.netAdvice });
  }
});

/* 网络自检：玩家报「微软登录不了」时最有用的第一步 —— 把「哪个服务连不上 / 有没有走代理」摆出来，
   一眼就能把「网络/代理问题」和「账号问题（未购买、儿童账户、地区限制）」分开。 */
function renderMsNet(r) {
  const box = $('#msNetBox');
  if (!box) return;
  const list = (r && r.results) || [];
  const rows = list.map(x =>
    '<div class="ms-net-row"><b class="' + (x.ok ? 'okr' : 'badr') + '">' + (x.ok ? '\u2713' : '\u2717') + '</b>' +
    '<span class="nm">' + esc(x.name) + '</span>' +
    '<span class="mut">' + (x.ok ? ((x.status ? 'HTTP ' + x.status + ' · ' : '') + x.ms + 'ms') : esc(String(x.error || '连不上'))) + '</span></div>'
  ).join('');
  box.innerHTML =
    '<div class="ms-net-head ' + (r && r.ok ? 'good' : 'bad') + '">' + (r && r.ok ? '网络正常：登录链路都连得上' : '有服务连不上') + '</div>' +
    rows +
    (r && r.advice ? '<p class="hint">' + esc(r.advice) + '</p>' : '') +
    '<p class="hint">代理路径：' + esc((r && r.via) || '未知') + '（DIRECT = 直连，没走系统代理）</p>';
  box.style.display = '';
}
$('#btnMsNetCheck').addEventListener('click', async () => {
  const btn = $('#btnMsNetCheck'), st = $('#msStatus');
  const idle = btn.innerHTML;
  btn.disabled = true; btn.textContent = '正在检测…';
  st.textContent = '正在逐个连接微软 / Xbox / Minecraft 服务…';
  let r;
  try { r = await window.lmc.accountMsNetCheck(); }
  catch (e) { r = { ok: false, advice: (e && e.message) || String(e), results: [] }; }
  btn.disabled = false; btn.innerHTML = idle;
  st.textContent = '';
  renderMsNet(r);
  if (!r.ok) toast('自检发现问题，详情见下方结果', 'warn');
});

/* 备用流程之一：自建 Azure 应用 + 系统浏览器回调 */
let msAadBusy = false;
$('#btnMsBrowser').addEventListener('click', async () => {
  const btn = $('#btnMsBrowser'), st = $('#msStatus');
  const cid = $('#msClientId').value.trim();
  const idle = btn.innerHTML;
  if (msAadBusy) { await window.lmc.accountMsLoginCancel().catch(() => {}); return; }
  if (!cid) {
    const d = $('#msClientId').closest('details'); if (d) d.open = true;
    toast('请先填入你自己的 Azure 应用 ID', 'warn');
    return;
  }
  msAadBusy = true;
  btn.textContent = '取消';
  let start;
  try { start = await window.lmc.accountMsLoginStart({ clientId: cid }); }
  catch (e) { start = { ok: false, error: (e && e.message) || String(e) }; }
  if (!start.ok) {
    msAadBusy = false; btn.innerHTML = idle;
    st.textContent = ''; toast(start.error || '无法开始登录', 'error');
    return;
  }
  st.textContent = '已在系统浏览器打开微软登录页，请登录并同意授权…';
  const r = await window.lmc.accountMsLoginWait({ clientId: cid });
  msAadBusy = false; btn.innerHTML = idle; st.textContent = '';
  if (r.ok) { applyAccounts(r, '已登录 ' + r.active); return; }
  toast(r.error || '登录失败', 'error');
});

/* 备用：设备码流程（浏览器打不开 / 想把代码给别人代登录时用） */
let msPolling = null;
$('#btnMsDevice').addEventListener('click', async () => {
  const btn = $('#btnMsDevice');
  btn.disabled = true;
  const r = await window.lmc.accountMsStart({ clientId: $('#msClientId').value.trim() });
  btn.disabled = false;
  if (!r.ok) {
    if (r.needId) { const d = $('#msClientId').closest('details'); if (d) d.open = true; toast('请先填入应用 ID', 'warn'); }
    else toast(r.error || '获取设备码失败', 'error');
    return;
  }
  $('#msUserCode').textContent = r.userCode;
  $('#msVerifyUrl').textContent = r.verifyUrl;
  $('#msDevStatus').textContent = '等待授权中…（代码 15 分钟内有效）';
  $('#msAuthBox').style.display = '';
  window.lmc.openUrl(r.verifyUrl);
  if (msPolling) clearInterval(msPolling);
  const interval = Math.max(3, r.interval) * 1000;
  msPolling = setInterval(async () => {
    const p = await window.lmc.accountMsPoll({ clientId: $('#msClientId').value.trim(), deviceCode: r.deviceCode });
    if (p.pending) { $('#msDevStatus').textContent = p.slow ? '微软服务繁忙，已自动放慢轮询…' : '等待授权中…'; return; }
    clearInterval(msPolling); msPolling = null;
    if (p.ok) {
      $('#msAuthBox').style.display = 'none';
      applyAccounts(p, '微软账户 ' + p.active + ' 登录成功');
    } else {
      $('#msDevStatus').textContent = '登录失败：' + (p.error || '未知错误');
      toast(p.error || '登录失败', 'error');
    }
  }, interval);
});
$('#btnMsCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#msUserCode').textContent.trim()); toast('代码已复制'); }
  catch (_) { toast('复制失败，请手动记下代码', 'warn'); }
});
$('#btnMsOpen').addEventListener('click', () => window.lmc.openUrl($('#msVerifyUrl').textContent.trim() || 'https://www.microsoft.com/link'));

/* 第三方外置登录（authlib-injector 协议） */
$('#btnAuthlibLogin').addEventListener('click', async () => {
  const btn = $('#btnAuthlibLogin');
  const server = $('#authlibPreset').value === 'custom' ? $('#authlibServer').value.trim() : $('#authlibPreset').value;
  btn.disabled = true; btn.textContent = '登录中…';
  const r = await window.lmc.accountAuthlibLogin({
    serverUrl: server,
    username: $('#authlibUser').value.trim(),
    password: $('#authlibPass').value
  });
  btn.disabled = false; btn.textContent = '登录';
  if (r.ok) {
    $('#authlibUser').value = ''; $('#authlibPass').value = '';
    applyAccounts(r, '外置账户 ' + r.active + ' 登录成功');
  } else toast(r.error || '登录失败', 'error');
});
$('#authlibPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAuthlibLogin').click(); });

/* ---------------- 个性化 ---------------- */
const ACCENT_PRESETS = ['#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#06b6d4', '#64748b'];
const BG_PRESETS = ['#0b0d11', '#ffffff', '#101820', '#0e1226', '#160f1c', '#171208', '#0a1210'];
let personalBgData = '';  // 自定义背景图的 dataURL（启动时从主进程读一次）

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function shade(hex, f) { const c = hexToRgb(hex).map(v => f >= 0 ? Math.round(v + (255 - v) * f) : Math.round(v * (1 + f))); return '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''); }
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }
function isLightColor(hex) { const [r, g, b] = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) > 160; }

/* 应用个性化外观：主题色 / 背景色 / 背景图（实时生效，不落盘） */
function applyPersonalize() {
  const cfg = S.config, root = document.documentElement, body = document.body;
  /* 浅色底（白底等）时 accent 高亮文字/图标要加深而不是提亮，否则白底上看不清 */
  const lightBg = !!(cfg.bgColor && /^#[0-9a-fA-F]{6}$/.test(cfg.bgColor) && isLightColor(cfg.bgColor));
  if (cfg.accentColor && /^#[0-9a-fA-F]{6}$/.test(cfg.accentColor)) {
    const a = cfg.accentColor;
    root.style.setProperty('--acc', a);
    root.style.setProperty('--acc2', lightBg ? shade(a, -0.18) : shade(a, 0.28));
    root.style.setProperty('--acc-dark', shade(a, -0.28));
    root.style.setProperty('--grad', lightBg
      ? 'linear-gradient(135deg,' + shade(a, 0.05) + ',' + shade(a, -0.32) + ')'
      : 'linear-gradient(135deg,' + shade(a, 0.28) + ',' + shade(a, -0.28) + ')');
    root.style.setProperty('--acc-soft1', rgba(a, 0.18));
    root.style.setProperty('--acc-soft2', rgba(shade(a, -0.35), 0.12));
    root.style.setProperty('--acc-border', rgba(a, 0.25));
  } else if (lightBg) {
    /* 默认主题色 + 浅色底：清除 inline，让 CSS 的 light-bg 加深版生效 */
    ['--acc', '--acc2', '--acc-dark', '--grad', '--acc-soft1', '--acc-soft2', '--acc-border'].forEach(v => root.style.removeProperty(v));
  } else {
    ['--acc', '--acc2', '--acc-dark', '--grad', '--acc-soft1', '--acc-soft2', '--acc-border'].forEach(v => root.style.removeProperty(v));
  }
  if (cfg.bgColor && /^#[0-9a-fA-F]{6}$/.test(cfg.bgColor)) {
    root.style.setProperty('--bg0', cfg.bgColor);
    root.style.setProperty('--bg1', shade(cfg.bgColor, 0.14));
    /* 浅色背景 → 自动切浅色文字/卡片，避免白底白字 */
    document.body.classList.toggle('light-bg', isLightColor(cfg.bgColor));
  } else {
    root.style.removeProperty('--bg0');
    root.style.removeProperty('--bg1');
    document.body.classList.remove('light-bg');
  }
  body.classList.remove('has-bg');
  /* 主题变化同步给已挂载的插件页面（它们的文案颜色跟随启动器明暗） */
  for (const it of PLUGIN_PAGES.items) {
    if (it.built) { try { window.lmc.pluginPageTheme({ id: it.id, theme: pluginPageTheme() }); } catch (_) {} }
  }
  body.style.backgroundImage = '';
  if (cfg.bgMode === 'panorama') {
    body.classList.add('has-bg');
    body.style.backgroundImage = 'url(../assets/panorama.png)';
  } else if (cfg.bgMode === 'image' && personalBgData) {
    body.classList.add('has-bg');
    body.style.backgroundImage = 'url(' + personalBgData + ')';
  }
  /* 同步个性化页控件状态 */
  $$('#page-personal input[name=bgMode]').forEach(r => { r.checked = r.value === (cfg.bgMode || 'default'); });
  $('#pAccent').value = cfg.accentColor || '#10b981';
  $('#pBgColor').value = cfg.bgColor || '#0b0d11';
  $$('#accentSwatches .swatch').forEach(s => s.classList.toggle('on', s.dataset.c === (cfg.accentColor || '')));
  $$('#bgSwatches .swatch').forEach(s => s.classList.toggle('on', s.dataset.c === (cfg.bgColor || '')));
  if (cfg.bgImage) $('#bgImgHint').textContent = '当前：' + cfg.bgImage + '（重新选择可更换）';
}

function setupPersonalize() {
  const swatches = (box, list) => {
    box.innerHTML = list.map(c => '<button class="swatch" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') +
      '<button class="swatch" data-c="" style="background:conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f87171)" title="自定义颜色…（点击打开取色器）"></button>';
  };
  swatches($('#accentSwatches'), ACCENT_PRESETS);
  swatches($('#bgSwatches'), BG_PRESETS);

  /* 预设色块：点击即预览；彩色渐变块 = 打开系统取色器 */
  $('#accentSwatches').addEventListener('click', e => {
    const b = e.target.closest('.swatch'); if (!b) return;
    if (b.dataset.c === '') { $('#pAccent').click(); return; }
    S.config.accentColor = b.dataset.c;
    applyPersonalize();
  });
  $('#bgSwatches').addEventListener('click', e => {
    const b = e.target.closest('.swatch'); if (!b) return;
    if (b.dataset.c === '') { $('#pBgColor').click(); return; }
    S.config.bgColor = b.dataset.c;
    applyPersonalize();
  });
  /* 取色器：实时预览 */
  $('#pAccent').addEventListener('input', () => { S.config.accentColor = $('#pAccent').value; applyPersonalize(); });
  $('#pBgColor').addEventListener('input', () => { S.config.bgColor = $('#pBgColor').value; applyPersonalize(); });
  $('#btnAccentReset').addEventListener('click', () => { S.config.accentColor = ''; applyPersonalize(); });
  $('#btnBgReset').addEventListener('click', () => { S.config.bgColor = ''; applyPersonalize(); });

  /* 背景模式：切换即预览（MC 全景 = 用户主动选择即视为同意启用） */
  $$('#page-personal input[name=bgMode]').forEach(r => r.addEventListener('change', () => {
    S.config.bgMode = r.value;
    applyPersonalize();
  }));
  /* 选自定义图片：主进程复制进数据目录并落盘 */
  $('#btnPickBg').addEventListener('click', async () => {
    const r = await window.lmc.pickBg();
    if (!r || r.canceled) return;
    if (!r.ok) { toast(r.error || '选择失败'); return; }
    S.config.bgImage = r.file;
    S.config.bgMode = 'image';
    const bg = await window.lmc.getBg();
    personalBgData = bg && bg.ok ? bg.dataUrl : '';
    applyPersonalize();
    toast('背景图已选择，点「保存个性化设置」生效持久化');
  });

  $('#btnSavePersonal').addEventListener('click', async () => {
    S.config = await window.lmc.saveConfig({
      bgMode: S.config.bgMode || 'default',
      bgColor: S.config.bgColor || '',
      accentColor: S.config.accentColor || '',
      bgImage: S.config.bgImage || ''
    });
    applyPersonalize();
    toast('个性化设置已保存');
  });
}

/* ---------------- 联机（陶瓦 Terracotta）---------------- */
const MP = { polling: null, lastState: '', lastIndex: -1 };
function mpRoomCodeValid(c) {
  const m = String(c).toUpperCase().replace(/\s/g, '').match(/U\/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  return m ? m[0] : null;
}
function mpSetStatus(line, hint) {
  $('#mpStatusCard').style.display = '';
  $('#mpStatusLine').textContent = line;
  $('#mpHint').textContent = hint || '';
}
async function mpEnsureRunning() {
  const st = await window.lmc.mpStatus();
  if (!st.ok) throw new Error(st.error || '状态获取失败');
  if (!st.installed) throw new Error('请先下载联机组件');
  if (!st.running) {
    const r = await window.lmc.mpStart();
    if (!r.ok) throw new Error(r.error);
  }
  return true;
}
function mpRenderState(s) {
  if (s.state === MP.lastState && s.index === MP.lastIndex) return;
  MP.lastState = s.state; MP.lastIndex = s.index;
  $('#mpBtnLeave').style.display = s.state === 'waiting' ? 'none' : '';
  $('#mpCodeRow').style.display = 'none';
  $('#mpUrlRow').style.display = 'none';
  switch (s.state) {
    case 'waiting':
      mpSetStatus('待机中', '创建房间，或输入房间码加入朋友的房间。');
      break;
    case 'host-scanning':
      mpSetStatus('正在扫描你的局域网世界…', '启动游戏进入单人世界 → 按 Esc → 点「对局域网开放」，陶瓦检测到后会自动接管。');
      break;
    case 'host-starting':
      mpSetStatus('房间建立中…', '正在与联机网络建立连接，请稍候。');
      $('#mpCodeBig').textContent = s.room; $('#mpCodeRow').style.display = '';
      break;
    case 'host-ok':
      mpSetStatus('房间已就绪 ✓', '把房间码发给朋友即可。你继续在游戏里玩，朋友加入后会直接出现在你的世界中。');
      $('#mpCodeBig').textContent = s.room; $('#mpCodeRow').style.display = '';
      break;
    case 'guest-connecting':
      mpSetStatus('正在加入房间 …', '与房主建立 P2P 连接中，若网络受限可能需要较长时间。');
      break;
    case 'guest-starting': {
      const d = { EASIEST: '极佳', SIMPLE: '良好', MEDIUM: '一般', TOUGH: '较差', UNKNOWN: '检测中' }[s.difficulty] || s.difficulty;
      mpSetStatus('连接建立中…', 'P2P 网络质量：' + d + '。正在准备联机隧道。');
      break;
    }
    case 'guest-ok':
      mpSetStatus('已加入房间 ✓', '打开游戏 → 多人游戏，服务器列表会出现「陶瓦联机大厅」，双击进入；也可在「直接连接」里输入下方地址。');
      $('#mpUrlBig').textContent = s.url; $('#mpUrlRow').style.display = '';
      break;
    case 'exception':
      mpSetStatus('联机出现异常（错误码 ' + s.type + '）', '点「中断联机」后重试；若反复失败，可能是双方网络均无法 P2P 打洞。');
      break;
  }
}
async function mpPoll() {
  try {
    const r = await window.lmc.mpState();
    if (r.ok) mpRenderState(r.state);
  } catch (_) {}
}
function mpStartPolling() {
  if (MP.polling) return;
  MP.polling = setInterval(mpPoll, 1000);
  mpPoll();
}
function mpStopPolling() {
  if (MP.polling) { clearInterval(MP.polling); MP.polling = null; }
  MP.lastState = ''; MP.lastIndex = -1;
}
async function mpOnEnter() {
  const st = await window.lmc.mpStatus().catch(() => null);
  if (!st || !st.ok || !st.installed) {
    $('#mpSetup').style.display = ''; $('#mpMain').style.display = 'none';
    return;
  }
  $('#mpSetup').style.display = 'none'; $('#mpMain').style.display = '';
  try { await mpEnsureRunning(); } catch (e) { mpSetStatus('联机服务未运行', e.message); }
  mpStartPolling();
}
$('#mpBtnDownload').addEventListener('click', async () => {
  const btn = $('#mpBtnDownload'); const info = $('#mpDlInfo');
  btn.disabled = true; info.style.display = ''; info.textContent = '正在获取下载地址…';
  const off = window.lmc.on('mp:progress', p => {
    info.textContent = p.stage === 'extract' ? '下载完成，解压安装中…' : '下载中 ' + p.percent + '%';
  });
  let r;
  try { r = await window.lmc.mpDownload(); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  finally { try { if (typeof off === 'function') off(); } catch (_) {} } /* 必须解绑：否则每点一次下载就多挂一个永久监听器 */
  btn.disabled = false;
  if (r.ok) {
    info.textContent = r.already ? '已安装最新版本' : '安装完成';
    toast(r.already ? '联机组件已是最新（v' + r.version + '），无需重复下载' : '联机组件安装完成: v' + r.version);
    mpOnEnter();
  }
  else { info.textContent = '下载失败: ' + r.error; toast('下载失败: ' + r.error, 'error'); }
});
$('#mpBtnHost').addEventListener('click', async () => {
  try {
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'scanning', player: $('#inpName').value.trim() || S.config.username || 'Steve' });
    if (!r.ok) throw new Error('创建房间失败 (HTTP ' + r.status + ')');
    mpStartPolling(); mpPoll();
  } catch (e) { toast(e.message, 'error'); }
});
$('#mpBtnJoin').addEventListener('click', async () => {
  const code = mpRoomCodeValid($('#mpInputCode').value);
  if (!code) { toast('房间码格式不对，应为 U/XXXX-XXXX-XXXX-XXXX', 'error'); return; }
  try {
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'guesting', room: code, player: $('#inpName').value.trim() || S.config.username || 'Steve' });
    if (!r.ok) throw new Error('加入失败 (HTTP ' + r.status + ')，请检查房间码是否正确');
    mpStartPolling(); mpPoll();
  } catch (e) { toast(e.message, 'error'); }
});
$('#mpBtnLeave').addEventListener('click', async () => {
  await window.lmc.mpAct({ action: 'ide' }).catch(() => {});
  mpPoll();
});
$('#mpBtnCopy').addEventListener('click', () => { navigator.clipboard.writeText($('#mpCodeBig').textContent); toast('房间码已复制'); });
$('#mpBtnCopyUrl').addEventListener('click', () => { navigator.clipboard.writeText($('#mpUrlBig').textContent); toast('地址已复制'); });

/* ---------------- 好友页（专属好友码 + 在线状态） ---------------- */
let frTimer = null;
function frFmtSeen(ms) {
  if (!ms) return '从未上线';
  const d = Date.now() - ms;
  if (d < 120000) return '刚刚在线';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前在线';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前在线';
  return '超过 1 天未上线';
}
async function loadFriends() {
  const r = await window.lmc.friendsGet();
  if (!r || !r.ok) { $('#frMyCode').textContent = '—'; return; }
  $('#frMyCode').textContent = r.code;
  const pr = await window.lmc.friendsPresence().catch(() => null);
  const pres = pr && pr.ok ? pr : { connected: false, status: {} };
  $('#frPresenceHint').textContent = pres.connected
    ? '● 在线状态实时检测中（心跳每 30 秒刷新 · 断网或退出启动器即显示离线）'
    : '● 正在连接在线状态服务…（连接不上时好友显示为离线）';
  const box = $('#frList');
  box.innerHTML = '';
  if (!r.friends.length) {
    box.innerHTML = '<div class="empty-sm">还没有好友，把上方的好友码发给朋友吧</div>';
    return;
  }
  r.friends.forEach(f => {
    const st = pres.status[f.code] || {};
    const online = !!st.online;
    const dotCol = online ? '#34d399' : '#8a929c';
    const stTxt = online ? '在线' : esc(frFmtSeen(st.lastSeen || 0));
    box.appendChild(el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-user"/></svg></div>' +
      '<div class="mi-main"><b>' + esc(f.name) + '</b>' +
      '<span style="display:inline-flex;align-items:center;gap:6px">' +
      '<span title="' + (online ? '在线' : '离线') + '" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:' + dotCol + ';box-shadow:0 0 6px ' + dotCol + '"></span>' +
      '<span style="color:' + (online ? '#34d399' : '') + ';font-weight:' + (online ? '700' : '400') + '">' + stTxt + '</span>' +
      '<span style="color:var(--mut,#8a929c)">· 好友码: ' + esc(f.code) + '</span></span></div>' +
      '<div class="mi-act" style="display:flex;gap:8px">' +
      (online ? '<button class="btn primary fr-invite"><svg class="ic sm"><use href="#i-user-check"/></svg> 邀请联机</button>' : '') +
      '<button class="btn ghost fr-play"><svg class="ic sm"><use href="#i-play"/></svg> 联机</button>' +
      '<button class="btn ghost fr-del"><svg class="ic sm"><use href="#i-trash"/></svg> 删除</button></div>'));
    const pending = S.frPending && S.frPending.get(f.code);
    if (pending && pending.btn) { /* 恢复"等待回应"状态（页面刷新后） */
      const ib = box.lastChild.querySelector('.fr-invite');
      if (ib) { ib.disabled = true; ib.textContent = '等待回应…'; pending.btn = ib; }
    }
    const invBtn = box.lastChild.querySelector('.fr-invite');
    if (invBtn) invBtn.addEventListener('click', () => frInvite(f, invBtn));
    box.lastChild.querySelector('.fr-play').addEventListener('click', () => frQuickPlay(f));
    box.lastChild.querySelector('.fr-del').addEventListener('click', async () => {
      if (!(await askConfirm('删除好友「' + f.name + '」？', { danger: true }))) return;
      await window.lmc.friendsRemove({ code: f.code });
      toast('已删除好友: ' + f.name);
      loadFriends();
    });
  });
}
function frStartPolling() { if (!frTimer) frTimer = setInterval(loadFriends, 15000); }
function frStopPolling() { if (frTimer) { clearInterval(frTimer); frTimer = null; } }

/* ---------------- 好友联机（MQTT 信令：邀请 / 同意 / 拒绝 / 房间码） ---------------- */
S.frPending = new Map(); /* 我发出的邀请: code -> {inviteId, btn, timer} */
S.frInvites = [];        /* 收到的邀请队列（弹窗一次只显示一个） */
function frMyName() { return ($('#inpName').value.trim()) || (S.config && S.config.username) || 'Steve'; }

async function frInvite(f, btn) {
  const inviteId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const r = await window.lmc.friendsSignalSend({ to: f.code, payload: { type: 'invite', inviteId } });
  if (!r || !r.ok) { toast('邀请发送失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
  toast('已向 ' + f.name + ' 发送联机邀请，等待回应…');
  btn.disabled = true; btn.textContent = '等待回应…';
  const timer = setTimeout(() => {
    const p = S.frPending.get(f.code);
    if (p && p.inviteId === inviteId) {
      if (p.btn && p.btn.isConnected) { p.btn.disabled = false; p.btn.innerHTML = '<svg class="ic sm"><use href="#i-user-check"/></svg> 邀请联机'; }
      S.frPending.delete(f.code);
      toast(f.name + ' 没有回应，邀请已超时', 'warn');
    }
  }, 60000);
  S.frPending.set(f.code, { inviteId, btn, timer });
}

/* 好友列表「联机」按钮：先查在线状态，再检测局域网世界，检测成功直接开联机 */
async function frQuickPlay(f) {
  /* 1. 实时在线检查 */
  const pres = await window.lmc.friendsPresence().catch(() => null);
  const st = pres && pres.ok && pres.status ? pres.status[f.code] : null;
  if (!st || !st.online) { toast((f.name || '好友') + ' 不在线，无法进行联机', 'warn'); return; }
  /* 2. 检测局域网世界（创建扫描会话并等待房间码 = 检测成功） */
  toast('正在检测局域网世界…');
  gotoPage('mp');
  mpSetStatus('正在检测局域网世界…', '检测成功后将自动与 ' + (f.name || '好友') + ' 开始联机。请确保游戏已进入世界并对局域网开放。');
  try {
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'scanning', player: frMyName() });
    if (!r.ok) throw new Error('检测失败 (HTTP ' + r.status + ')');
    mpStartPolling();
    /* 最多检测 1 分钟：超时自动退出扫描并提示 */
    const deadline = Date.now() + 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 1500));
      const s = await window.lmc.mpState().catch(() => null);
      if (s && s.ok && s.state && s.state.room) {
        /* 检测成功：把房间码发给好友，直接开始联机 */
        await window.lmc.friendsSignalSend({ to: f.code, payload: { type: 'room', room: s.state.room } });
        mpSetStatus('检测成功，已开始与 ' + (f.name || '好友') + ' 联机 ✓', '请在游戏里进入世界 → Esc → 「对局域网开放」，对方加入后即可一起玩。');
        toast('检测成功，' + (f.name || '好友') + ' 正在加入你的联机房间');
        return;
      }
    }
    mpStopPolling();
    await window.lmc.mpStop().catch(() => {});
    mpSetStatus('未检测到局域网世界，已自动退出扫描', '超过 1 分钟没有检测到可联机的世界。请先进游戏世界 → Esc → 「对局域网开放」，再回到好友页点「联机」。');
    toast('超过 1 分钟未检测到局域网世界，已自动退出扫描', 'warn');
  } catch (e) {
    mpSetStatus('好友联机失败', e.message);
    toast('联机失败: ' + e.message, 'error');
  }
}

function showInviteDialog(inv) {
  /* 同一时间只弹一个，其余排队 */
  if (document.getElementById('frInviteMask')) { S.frInvites.push(inv); return; }
  const mask = document.createElement('div');
  mask.id = 'frInviteMask';
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;animation:fadeIn .18s ease';
  mask.innerHTML = '<div style="background:#161b23;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:30px 36px;max-width:430px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.5);animation:pop .22s cubic-bezier(.2,.9,.3,1.2)">' +
    '<h3 style="margin:0 0 8px;font-size:19px">🎮 ' + esc(inv.name || '好友') + ' 邀请你一起玩 MC</h3>' +
    '<p style="margin:0 0 20px;color:#8a929c;font-size:13px">接受后将自动加入对方的联机房间</p>' +
    '<div style="display:flex;gap:12px;justify-content:center">' +
    '<button class="btn primary" id="frInvAccept" style="min-width:110px">同意</button>' +
    '<button class="btn ghost" id="frInvReject" style="min-width:110px">拒绝</button></div></div>';
  document.body.appendChild(mask);
  mask.querySelector('#frInvAccept').addEventListener('click', async () => {
    mask.remove();
    await window.lmc.friendsSignalSend({ to: inv.from, payload: { type: 'accept', inviteId: inv.inviteId } });
    gotoPage('mp');
    mpSetStatus('正在加入 ' + (inv.name || '好友') + ' 的联机房间…', '等待对方创建房间，通常几秒内完成。');
    nextInviteDialog();
  });
  mask.querySelector('#frInvReject').addEventListener('click', async () => {
    mask.remove();
    await window.lmc.friendsSignalSend({ to: inv.from, payload: { type: 'reject', inviteId: inv.inviteId } });
    toast('已拒绝 ' + (inv.name || '好友') + ' 的邀请');
    nextInviteDialog();
  });
}
function nextInviteDialog() { if (S.frInvites.length) showInviteDialog(S.frInvites.shift()); }

function frResetPendingBtn(code) {
  const p = S.frPending.get(code);
  if (p) {
    clearTimeout(p.timer);
    if (p.btn && p.btn.isConnected) { p.btn.disabled = false; p.btn.innerHTML = '<svg class="ic sm"><use href="#i-user-check"/></svg> 邀请联机'; }
    S.frPending.delete(code);
  }
}

/* 发起方：对方同意后自动建房，把房间码发给对方 */
async function frHostForFriend(s) {
  try {
    gotoPage('mp');
    mpSetStatus('正在为 ' + (s.name || '好友') + ' 创建联机房间…', '创建后房间码会自动发送给对方。');
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'scanning', player: frMyName() });
    if (!r.ok) throw new Error('创建房间失败 (HTTP ' + r.status + ')');
    mpStartPolling();
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 1500));
      const st = await window.lmc.mpState().catch(() => null);
      if (st && st.ok && st.state && st.state.room) {
        await window.lmc.friendsSignalSend({ to: s.from, payload: { type: 'room', room: st.state.room } });
        mpSetStatus('房间已创建 ✓', '房间码已自动发送给 ' + (s.name || '好友') + '。请在游戏里进入世界 → Esc → 「对局域网开放」，对方加入后即可一起玩。');
        toast('房间码已发送给 ' + (s.name || '好友'));
        return;
      }
    }
    throw new Error('等待房间码超时');
  } catch (e) {
    mpSetStatus('好友联机创建失败', e.message);
    toast('创建房间失败: ' + e.message, 'error');
  }
}

/* 受邀方：收到房间码后自动加入 */
async function frJoinRoom(s) {
  try {
    gotoPage('mp');
    mpSetStatus('正在加入 ' + (s.name || '好友') + ' 的联机房间…', '房间码: ' + (s.room || ''));
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'guesting', room: s.room, player: frMyName() });
    if (!r.ok) throw new Error('加入失败 (HTTP ' + r.status + ')');
    mpStartPolling(); mpPoll();
    toast('已加入 ' + (s.name || '好友') + ' 的房间，进游戏多人模式即可看到');
  } catch (e) {
    mpSetStatus('加入好友房间失败', e.message);
    toast('加入房间失败: ' + e.message, 'error');
  }
}

async function frHandleSignal(s) {
  switch (s.type) {
    case 'invite': showInviteDialog(s); break;
    case 'accept':
      frResetPendingBtn(s.from);
      toast((s.name || '好友') + ' 接受了你的联机邀请！');
      await frHostForFriend(s);
      break;
    case 'reject':
      frResetPendingBtn(s.from);
      toast('对方拒绝了你的邀请', 'warn');
      break;
    case 'room': await frJoinRoom(s); break;
  }
}

function frSignalStart() {
  if (frSignalTimer) return;
  frSignalTimer = setInterval(async () => {
    try {
      const r = await window.lmc.friendsSignalPoll();
      if (r && r.ok && r.signals.length) for (const s of r.signals) frHandleSignal(s);
    } catch (_) {}
  }, 2500);
}
let frSignalTimer = null;
$('#frBtnCopy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#frMyCode').textContent);
  toast('好友码已复制，快发给朋友吧');
});
$('#frInputCode').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#frBtnAdd').click(); });
$('#frBtnAdd').addEventListener('click', async () => {
  const btn = $('#frBtnAdd');
  btn.disabled = true;
  const r = await window.lmc.friendsAdd({ code: $('#frInputCode').value });
  btn.disabled = false;
  if (!r || !r.ok) { toast((r && r.error) || '添加失败', 'error'); return; }
  $('#frInputCode').value = '';
  toast('已添加好友');
  loadFriends();
});

/* ---------------- 下载 Java（设置页） ---------------- */
$('#btnDlJava').addEventListener('click', async () => {
  const btn = $('#btnDlJava');
  const major = parseInt($('#javaDlVer').value, 10);
  btn.disabled = true; btn.textContent = '下载中…';
  setStatus('下载 Java ' + major + '…', true);
  const r = await window.lmc.javaDownload(major);
  btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 下载安装';
  if (!r || !r.ok) { toast('Java ' + major + ' 安装失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
  detectJavaUI();
});

/* ---------------- 诊断页 ---------------- */
S.lastDiag = null;
async function loadDiagReports() {
  const sel = $('#diagReport');
  const instance = $('#diagInstance').value || '';
  const r = await window.lmc.diagReports({ instance });
  sel.innerHTML = '';
  S.diagReports = (r.ok && r.reports) || [];
  if (!S.diagReports.length) {
    sel.innerHTML = '<option value="">（没有崩溃报告 —— 只分析游戏日志）</option>';
    return;
  }
  sel.innerHTML = S.diagReports.map((rp, i) =>
    '<option value="' + esc(rp.path) + '">' + (i === 0 ? '〔最新〕' : '') +
    new Date(rp.time).toLocaleString() + ' · ' + esc(rp.headline) + '</option>').join('');
  sel.value = S.diagReports[0].path;
}
function tierLabel(t) { return t === 'sure' ? '确定原因' : '疑似原因'; }
function renderDiagResult(dg) {
  const box = $('#diagGameOut');
  if (!dg.found) { box.innerHTML = '<div class="empty-sm">' + esc(dg.note || '没有可分析的崩溃报告或游戏日志。') + '</div>'; return; }
  if (dg.clean) {
    box.innerHTML = '<div class="diag-verdict"><span class="pill release">日志干净</span> <b>游戏日志里没有发现错误</b> —— 游戏应该是正常退出或还没启动过。</div>' +
      '<div class="diag-src"><div>游戏日志: <code>' + esc(dg.logPath || '') + '</code></div></div>';
    return;
  }
  const pills = [
    dg.reportFresh ? '<span class="pill release">崩溃报告 · 刚刚发生</span>'
      : (dg.reportPath ? '<span class="pill old_beta">崩溃报告 · ' + new Date(S.lastDiagTime || 0).toLocaleString() + '</span>' : ''),
    dg.logFresh ? '<span class="pill old_beta">游戏日志 · 新鲜</span>' : ''
  ].filter(Boolean).join(' ');
  let html = '<div class="diag-verdict">' + pills;
  if (dg.headline) html += '<div class="diag-headline"><code>' + esc(dg.headline) + '</code></div>';
  const sure = dg.rules.filter(r => r.tier === 'sure').length;
  html += sure
    ? ' <b>识别出 ' + sure + ' 个确定原因' + (dg.rules.length - sure ? '（另有 ' + (dg.rules.length - sure) + ' 个疑似）' : '') + '：</b>'
    : (dg.rules.length ? ' <b>疑似原因 ' + dg.rules.length + ' 个（来自日志，非崩溃报告直接命中）：</b>'
      : (dg.logOnly ? ' <b>日志里没有命中内置规则</b>（可用下方 AI 深度分析）' : ' <b>崩溃报告未命中内置规则</b>（可用下方 AI 深度分析）'));
  html += '</div>';
  dg.rules.forEach((r, i) => {
    html += '<div class="diag-rule"><div class="diag-rule-t">' + (i + 1) + '. ' + esc(r.title) +
      ' <span class="pill ' + (r.tier === 'sure' ? 'release' : 'old_beta') + '">' + tierLabel(r.tier) + ' · ' + esc(r.src) + '</span></div>' +
      '<div class="diag-rule-b"><b>原因：</b>' + esc(r.why) + '</div>' +
      '<div class="diag-rule-b"><b>建议：</b>' + esc(r.fix) + '</div>' +
      '<div class="diag-rule-m">匹配到: ' + esc(r.match) + '</div></div>';
  });
  if (dg.causedBy && dg.causedBy.length) {
    html += '<div class="diag-rule"><div class="diag-rule-t">异常链（Caused by）</div>' +
      dg.causedBy.map(c => '<div class="diag-rule-m"><code>' + esc(c) + '</code></div>').join('') + '</div>';
  }
  if (dg.javaNeed) html += '<div class="warnbar tip">需要 Java ' + dg.javaNeed + ' —— 启动该版本时会自动下载安装；也可到「设置 → Java 运行时」手动装或指定路径。</div>';
  if (dg.modsInvolved.length) html += '<div class="diag-rule-b"><b>涉及的 MOD：</b>' + dg.modsInvolved.map(esc).join('、') + '</div>';
  if (dg.evidence && dg.evidence.length) {
    html += '<details class="diag-evidence"><summary>关键日志行（' + dg.evidence.length + ' 行）</summary>' +
      dg.evidence.map(l => '<div class="diag-rule-m"><code>' + esc(l) + '</code></div>').join('') + '</details>';
  }
  html += '<div class="diag-src">';
  if (dg.reportPath) html += '<div>崩溃报告: <code>' + esc(dg.reportPath) + '</code>' + (dg.reportFresh ? '' : '（历史报告，已照常分析）') + '</div>';
  if (dg.logPath) html += '<div>游戏日志: <code>' + esc(dg.logPath) + '</code></div>';
  html += '</div>';
  box.innerHTML = html;
}
async function runGameDiag(logOnly) {
  const box = $('#diagGameOut');
  box.innerHTML = '<div class="empty-sm">正在分析…</div>';
  const instance = $('#diagInstance').value || '';
  const report = logOnly ? '' : ($('#diagReport') ? $('#diagReport').value : '');
  const r = await window.lmc.diagGame({ instance, report, logOnly: !!logOnly });
  if (!r.ok) { box.innerHTML = '<div class="empty-sm">诊断失败: ' + esc(r.error) + '</div>'; return; }
  S.lastDiag = r.diag;
  const rec = (S.diagReports || []).find(x => x.path === (r.diag.reportPath || ''));
  S.lastDiagTime = rec ? rec.time : 0;
  renderDiagResult(r.diag);
}
async function refreshDiagLauncher() {
  const box = $('#diagLaunchList');
  const r = await window.lmc.diagLauncher();
  if (!r.ok) { box.innerHTML = '<div class="empty-sm">读取失败: ' + esc(r.error) + '</div>'; return; }
  if (!r.crashes.length) { box.innerHTML = '<div class="empty-sm">暂无启动器崩溃记录 —— 一切正常。</div>'; return; }
  box.innerHTML = r.crashes.map(c =>
    '<div class="diag-launch"><div><b>' + esc(new Date(c.time).toLocaleString()) + '</b> <code>' + esc(c.head) + '</code></div>' +
    '<button class="btn ghost diag-open-file" data-f="' + esc(c.path) + '">查看</button></div>').join('');
  box.querySelectorAll('.diag-open-file').forEach(b => b.addEventListener('click', () => window.lmc.openPath(b.dataset.f)));
}
$('#btnDiagGame').addEventListener('click', () => runGameDiag(false));
$('#btnDiagLog').addEventListener('click', () => runGameDiag(true));
$('#btnDiagRefresh').addEventListener('click', () => { loadDiagReports(); toast('崩溃报告列表已刷新'); });
$('#diagInstance').addEventListener('change', loadDiagReports);
$('#btnDiagOpenDir').addEventListener('click', async () => {
  const r = await window.lmc.diagLauncher();
  if (r.ok && r.diagDir) window.lmc.openPath(r.diagDir);
});
$('#btnAiSave').addEventListener('click', async () => {
  await window.lmc.saveConfig({ aiApi: { base: $('#aiBase').value.trim(), key: $('#aiKey').value.trim(), model: $('#aiModel').value.trim() || 'gpt-4o-mini' } });
  toast('AI 设置已保存');
});
$('#btnDiagAi').addEventListener('click', async () => {
  if (!S.lastDiag || !S.lastDiag.found) { toast('请先运行一次游戏崩溃诊断', 'warn'); return; }
  const out = $('#diagAiOut');
  out.innerHTML = '<div class="empty-sm">AI 分析中（最长 60 秒）…</div>';
  const r = await window.lmc.diagAi({ excerpt: S.lastDiag.excerpt, rules: S.lastDiag.rules });
  out.innerHTML = r.ok
    ? '<div class="diag-ai">' + esc(r.text).replace(/\n/g, '<br>') + '</div>'
    : '<div class="warnbar tip">' + esc(r.error) + '</div>';
});

/* ================================================================
 * 插件（内置插件：种子地图 / 一键开服）
 * ================================================================ */
const PLUGIN_DEFS = [
  {
    id: 'seedmap', name: '种子地图', ver: '1.0.1', tag: '工具', ic: '#i-map', color: '#10b981',
    desc: '输入任意种子，直接在启动器内查看该世界的生物群系、村庄、要塞与结构分布；支持从已有存档一键读取种子。'
  },
  {
    id: 'server', name: '一键开服', ver: '1.0.0', tag: '联机', ic: '#i-server', color: '#f59e0b',
    desc: '选择 Paper / Purpur / 原版 / Fabric 与游戏版本，自动下载服务端、生成 eula 与 server.properties，一键启动并实时查看日志。'
  },
  {
    id: 'gamepad', name: '手柄控制', ver: '1.0.0', tag: '操作', ic: '#i-gamepad', color: '#8b5cf6',
    desc: '用手柄操作启动器：摇杆或十字键移动焦点、A 确认、B 返回、LB/RB 切页、Start 启动游戏，不碰键鼠也能走完「选版本 → 进游戏」全流程。'
  },
  {
    id: 'translator', name: '模组翻译器', ver: '1.0.0', tag: '工具', ic: '#i-globe', color: '#0ea5e9',
    desc: '上传一个模组 JAR，把里面的英文文本翻成中文，生成一个汉化资源包；不改原模组、不占多少内存，翻过的文本会缓存。'
  }
];
const PLG = { on: {}, pane: '', third: [] };
/* 权限 key → 界面上的短标签（社区插件卡片与面板头部用） */
const PLG_PERM_LABEL = { notify: '弹提示', storage: '存储数据', launcher: '读启动器信息', versions: '读版本列表', control: '改启动器设置', openExternal: '打开网站', http: '联网请求' };
function coreName(id) {
  return ({ paper: 'Paper', purpur: 'Purpur', vanilla: '原版', fabric: 'Fabric' })[id] || id;
}
async function renderPlugins(force) {
  const wrap = $('#pluginsList');
  if (!wrap) return;
  if (!force && wrap.dataset.done) return;
  let third = [];
  try {
    const r = await window.lmc.pluginList();
    if (r && r.ok) {
      PLG.on = r.plugins || {};
      third = Array.isArray(r.third) ? r.third : [];
      if (r.preloadUrl) PLUGIN_PAGES.preloadUrl = r.preloadUrl;
    }
  } catch (_) {}
  PLG.third = third;
  wrap.className = 'plg-grid';
  /* 内置插件 */
  const builtinHtml = PLUGIN_DEFS.map(p => {
    const on = PLG.on[p.id] !== false;
    return '<div class="plg-card' + (on ? '' : ' off') + '">' +
      '<div class="plg-top">' +
        '<span class="plg-ic" style="background:' + p.color + '1f;color:' + p.color + '"><svg class="ic"><use href="' + p.ic + '"/></svg></span>' +
        '<div class="plg-main"><b>' + esc(p.name) +
          '<span class="plg-tag">' + esc(p.tag) + '</span><span class="plg-tag">v' + esc(p.ver) + '</span></b>' +
          '<span>' + esc(p.desc) + '</span></div>' +
        '<div class="plg-acts">' +
          '<span class="plg-sw' + (on ? ' on' : '') + '" data-sw="' + p.id + '" title="' + (on ? '点击停用' : '点击启用') + '"></span>' +
          '<button class="btn ' + (on ? 'primary' : 'ghost') + '" data-open="' + p.id + '"' + (on ? '' : ' disabled') + '>打开</button>' +
        '</div>' +
      '</div>' +
      /* 内置插件是启动器自带功能，卡片下方只写清「不能删」——社区插件那一行才是删除入口 */
      '<div class="plg-foot"><span class="plg-note">内置插件 · 随启动器一起发布，只能启用或停用</span></div>' +
      '</div>';
  }).join('');
  /* 社区插件（拓展插件）：信息全部来自它自己的 plugin.json，界面这边不写死任何一份 */
  const thirdHtml = third.map(p => {
    const on = PLG.on[p.id] !== false;
    const ic = p.iconUrl
      ? '<span class="plg-ic"><img class="plg-img" src="' + esc(p.iconUrl) + '" alt=""></span>'
      : '<span class="plg-ic" style="background:#38bdf81f;color:#38bdf8"><svg class="ic"><use href="#i-puzzle"/></svg></span>';
    const tags = '<span class="plg-tag comm">社区</span>' +
      (p.author ? '<span class="plg-tag">' + esc(p.author) + '</span>' : '') +
      '<span class="plg-tag">v' + esc(p.version) + '</span>';
    const parts = [];
    if (p.description) parts.push(p.description);
    parts.push(p.entry ? '有独立面板' : '无面板（只提供后台能力）');
    if (p.hasPage) parts.push('带侧栏页面「' + (p.pageTitle || p.name) + '」');
    parts.push(p.permissions.length ? '权限 ' + p.granted.length + '/' + p.permissions.length + ' 项已授权' : '无需额外权限');
    const canOpen = on && !!p.entry;
    return '<div class="plg-card' + (on ? '' : ' off') + '">' +
      '<div class="plg-top">' + ic +
        '<div class="plg-main"><b>' + esc(p.name) + tags + '</b><span>' + esc(parts.join(' · ')) + '</span></div>' +
        '<div class="plg-acts">' +
          '<span class="plg-sw' + (on ? ' on' : '') + '" data-sw="' + p.id + '" title="' + (on ? '点击停用' : '点击启用') + '"></span>' +
          '<button class="btn ' + (canOpen ? 'primary' : 'ghost') + '" data-open="' + p.id + '"' + (canOpen ? '' : ' disabled') + '>' +
            (p.entry ? '打开' : '无面板') + '</button>' +
        '</div>' +
      '</div>' +
      /* 卡片下方：左侧打开它自己的目录，右侧「删除插件」（红色，点了会先问一遍） */
      '<div class="plg-foot">' +
        '<button class="ghost-btn" data-dir="' + p.id + '" title="打开这个插件的目录"><svg class="ic sm"><use href="#i-folder"/></svg> 打开目录</button>' +
        '<button class="btn danger plg-del" data-rm="' + p.id + '" title="删除这个插件"><svg class="ic sm"><use href="#i-trash"/></svg> 删除插件</button>' +
      '</div></div>';
  }).join('');
  wrap.innerHTML = builtinHtml + thirdHtml;
  wrap.dataset.done = '1';
  $$('#pluginsList [data-sw]').forEach(sw => sw.addEventListener('click', async () => {
    const id = sw.dataset.sw;
    const now = !(PLG.on[id] !== false);
    try {
      const r = await window.lmc.pluginToggle({ id, enabled: now });
      if (r && r.plugins) PLG.on = r.plugins;
    } catch (e) { toast('操作失败：' + e.message, 'error'); return; }
    const def = PLUGIN_DEFS.find(x => x.id === id) || PLG.third.find(x => x.id === id);
    toast('插件「' + (def ? def.name : id) + '」已' + (now ? '启用' : '停用'), now ? 'ok' : 'warn');
    /* 停用的插件若正被打开 → 自动退回列表 */
    if (!now && PLG.pane === id) closePlugin();
    if (id === 'gamepad') gpApply();   /* 手柄插件：启用/停用立刻生效，不用重启 */
    renderPlugins(true);
  }));
  $$('#pluginsList [data-open]').forEach(b => b.addEventListener('click', () => openPlugin(b.dataset.open)));
  /* 社区插件：打开插件目录（方便看它的文件，含它存的 .xlc-data.json） */
  $$('#pluginsList [data-dir]').forEach(b => b.addEventListener('click', async () => {
    const r = await window.lmc.pluginOpenDir({ id: b.dataset.dir });
    if (!r || !r.ok) toast('打开失败：' + ((r && r.error) || '未知错误'), 'error');
  }));
  /* 社区插件：删除（删插件目录 + 清授权，不碰游戏目录与启动器设置）——先问一遍，确认了才动手 */
  $$('#pluginsList [data-rm]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.rm;
    const p = PLG.third.find(x => x.id === id);
    const name = p ? p.name : id;
    if (!(await askConfirm('删除插件「' + name + '」？', {
      danger: true,
      okText: '删除',
      detail: '插件自己的目录（含它在插件目录里存的数据）会被删除，它的授权记录也会一并清掉；游戏目录、存档与启动器设置不受影响。以后想用可以重新导入插件包。'
    }))) return;
    destroyPluginPage(id);   /* 先拆侧栏页面（webview 持着插件文件的句柄，不拆干净目录会删不掉） */
    const r = await window.lmc.pluginRemove({ id });
    if (!r || !r.ok) { toast('删除失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    if (PLG.pane === id) closePlugin();
    toast('插件「' + name + '」已删除', 'warn');
    renderPlugins(true);
  }));
  /* 插件页面（page.html）：插件列表到位后重建侧栏入口（启用/停用/删除/升级都会走到这） */
  refreshPluginPages();
}

/* ---------------- 插件自定义页面（page.html，1.2-snapshot2） ----------------
 * 插件包根目录带 page.html 时侧栏多一项，点击在主窗口内容区里切换（不开新窗口）。
 * 页面用 <webview> 承载：与主文档进程隔离；preload 用插件桥 plugin-preload.js，
 * session 沿用插件分区（主进程侧断网闸门），出入口与设置面板完全一致（window.xlcPlugin）。
 * 入口名字 = 清单 pageTitle（没写用插件名）；入口图标 = 插件 Images/Logo.png（必须这个文件名）。 */
const PLUGIN_PAGES = { items: [], preloadUrl: '' };   /* items: { id, title, pageUrl, iconUrl, built } */
function pluginPageTheme() { return document.body.classList.contains('light-bg') ? 'light' : 'dark'; }
/* 拆掉某个插件的页面（停用 / 删除时）：移除 webview + 侧栏按钮 + pane */
function destroyPluginPage(id) {
  const host = $('#pp-host-' + id);
  if (host) host.innerHTML = '';
  const pane = $('#page-plugin-' + id);
  if (pane) pane.remove();
  const btn = $('#railNav .rail-btn[data-page="plugin-' + id + '"]');
  if (btn) btn.remove();
  const i = PLUGIN_PAGES.items.findIndex(x => x.id === id);
  if (i >= 0) PLUGIN_PAGES.items.splice(i, 1);
  moveRailInd();
}
/* 按最新插件列表重建「插件页面」的侧栏入口与 pane（renderPlugins 每次刷新后调用） */
function refreshPluginPages(preloadUrl) {
  if (preloadUrl) PLUGIN_PAGES.preloadUrl = preloadUrl;
  const rail = $('#railNav');
  if (!rail) return;
  /* 先按旧清单把入口全拆掉，再按新清单装 —— 插件的启用 / 停用 / 删除都会走到这 */
  for (const it of PLUGIN_PAGES.items.slice()) {
    const on = PLG.on[it.id] !== false;
    const t = (PLG.third || []).find(x => x.id === it.id);
    if (!t || !on || !t.hasPage) destroyPluginPage(it.id);
  }
  const anchor = rail.querySelector('[data-page="plugins"]');
  for (const p of (PLG.third || [])) {
    const on = PLG.on[p.id] !== false;
    if (!on || !p.hasPage || !p.pageUrl) continue;
    if (PLUGIN_PAGES.items.some(x => x.id === p.id)) continue;   /* 已在 → 保留（webview 不重建，页面状态不丢） */
    const title = (p.pageTitle || p.name || p.id).slice(0, 24);
    const it = { id: p.id, title, pageUrl: p.pageUrl, iconUrl: p.pageIconUrl || '', built: false };
    PLUGIN_PAGES.items.push(it);
    const btn = el('button', 'rail-btn');
    btn.dataset.page = 'plugin-' + p.id;
    btn.title = title + '（插件页面）';
    btn.innerHTML = it.iconUrl
      ? '<img class="ic rail-img" src="' + esc(it.iconUrl) + '" alt="">'
      : '<svg class="ic"><use href="#i-puzzle"/></svg>';
    btn.addEventListener('click', () => gotoPage('plugin-' + p.id));
    if (anchor && anchor.nextSibling) anchor.after(btn); else rail.appendChild(btn);
    const sec = el('section', 'page plugin-page');
    sec.id = 'page-plugin-' + p.id;
    sec.innerHTML = '<div class="pp-head"><b class="pp-title">' + esc(title) + '</b>' +
      '<span class="pp-by">插件页面 · 由「' + esc(p.name) + '」提供 · 点侧栏其他按钮可随时离开</span></div>' +
      '<div class="pp-host" id="pp-host-' + esc(p.id) + '"></div>';
    $('#content').appendChild(sec);
  }
  moveRailInd();
}
/* 首次进入某插件的页面时才建 webview（懒加载：没点过的页面一个字节都不加载） */
function ensurePluginWebview(id) {
  const it = PLUGIN_PAGES.items.find(x => x.id === id);
  const host = $('#pp-host-' + id);
  if (!it || !host || host.firstChild) return;
  const wv = document.createElement('webview');
  wv.setAttribute('src', it.pageUrl);
  if (PLUGIN_PAGES.preloadUrl) wv.setAttribute('preload', PLUGIN_PAGES.preloadUrl);
  wv.setAttribute('partition', 'persist:xlc-plugin-' + id);
  wv.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, sandbox=no, spellcheck=no');
  host.appendChild(wv);
  wv.addEventListener('dom-ready', () => {
    try { window.lmc.pluginPageTheme({ id, theme: pluginPageTheme() }); } catch (_) {}
  });
  it.built = true;
}

/* 插件面板 id → DOM 容器（新增内置插件面板时在这里登记一行） */
const PLG_PANES = { seedmap: '#plgSeedmap', server: '#plgServer', gamepad: '#plgGamepad', translator: '#plgTranslator' };
function plgShowPane(which) {
  $('#plgHome').style.display = which ? 'none' : '';
  for (const k of Object.keys(PLG_PANES)) {
    const pane = $(PLG_PANES[k]);
    if (pane) pane.style.display = (which === k) ? '' : 'none';
  }
}
function openPlugin(id) {
  if (PLG.on[id] === false) { toast('插件已停用，请先在列表里启用', 'warn'); return; }
  /* 社区插件：面板是主进程开的独立窗口，这里只负责把它开起来 */
  const t = PLG.third.find(x => x.id === id);
  if (t) { openThirdParty(t); return; }
  PLG.pane = id;
  plgShowPane(id);
  if (id === 'seedmap') initSeedmap();
  else if (id === 'server') initServerPane();
  else if (id === 'gamepad') initGamepadPane();
  else if (id === 'translator') initTranslatorPane();
  /* 打开面板后把焦点落到第一个控件，纯手柄也能继续操作 */
  if (typeof gpResetFocus === 'function') gpResetFocus();
}
function closePlugin() {
  PLG.pane = '';
  plgShowPane('');
  if (typeof gpResetFocus === 'function') gpResetFocus();
}

/* ================================================================
 * 内置插件：模组翻译器
 * ================================================================
 * 界面只做三件事：选 JAR（按钮 / 拖拽）→ 展示要翻什么 → 看进度与结果。
 * 真正的读包、翻译、写资源包全在主进程（见 main.js「插件：模组翻译器」），
 * 这里一个字节的模组内容都不碰，也就不会把启动器内存顶上去。 */
const TRP = { path: '', info: null, running: false, dir: '' };
function trFmtSize(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function trLog(line) {
  const box = $('#trLog');
  if (!box) return;
  const t = new Date().toTimeString().slice(0, 8);
  box.innerHTML += '<div class="tr-line"><span>' + t + '</span>' + esc(line) + '</div>';
  box.scrollTop = box.scrollHeight;
}
function trBar(pct, text) {
  const fill = $('#trBarFill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  const tx = $('#trBarTx');
  if (tx && text) tx.textContent = text;
  const wrap = $('#trInfoCard');
  if (wrap) wrap.classList.toggle('busy', !!TRP.running);
}
function trSetRunning(on) {
  TRP.running = !!on;
  const run = $('#btnTrRun'); if (run) run.disabled = !!on;
  const pick = $('#btnTrPick'); if (pick) pick.disabled = !!on;
  const cancel = $('#btnTrCancel'); if (cancel) cancel.disabled = !on;
  const again = $('#btnTrAgain'); if (again) again.disabled = !!on;
}
function trResetView() {
  TRP.info = null;
  TRP.path = '';
  const info = $('#trInfoCard'); if (info) { info.style.display = 'none'; info.classList.remove('busy'); }
  const out = $('#trOutCard'); if (out) out.style.display = 'none';
  const file = $('#trFile'); if (file) { file.style.display = 'none'; file.innerHTML = ''; }
  const log = $('#trLog'); if (log) log.innerHTML = '';
  trBar(0, '准备就绪');
}
async function initTranslatorPane() {
  const drop = $('#trDrop');
  if (drop && !drop.dataset.bound) {
    drop.dataset.bound = '1';
    drop.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('#btnTrPick')) return;  /* 按钮自己处理 */
      trPickJar();
    });
    $('#btnTrPick').addEventListener('click', (e) => { e.stopPropagation(); trPickJar(); });
    $('#btnTrBack').addEventListener('click', () => closePlugin());
    $('#btnTrRun').addEventListener('click', () => trRunNow());
    $('#btnTrCancel').addEventListener('click', async () => {
      try { await window.lmc.translatorCancel(); } catch (_) {}
      trLog('已请求取消，正在收尾…');
    });
    $('#btnTrOpenDir').addEventListener('click', async () => {
      const r = await window.lmc.translatorOpenDir(TRP.dir || (TRP.info && TRP.info.dir) || '');
      if (r && !r.ok) toast('打不开目录：' + (r.error || '未知错误'), 'error');
    });
    $('#btnTrAgain').addEventListener('click', () => {
      trResetView();
      trPickJar();
    });
    /* 翻译通道开关：默认关闭（走 MyMemory 官方免费接口），只有用户自己勾了才走备用通道 */
    const bing = $('#trBing');
    if (bing) {
      bing.checked = !!(S.config && S.config.translatorBing);
      bing.addEventListener('change', async () => {
        const on = !!bing.checked;
        try { await window.lmc.saveConfig({ translatorBing: on }); } catch (_) {}
        if (S.config) S.config.translatorBing = on;
        toast(on ? '已启用备用通道：Bing 网页接口（非开放 API，可能随时失效）' : '已切回官方免费接口（MyMemory）',
          on ? 'warn' : 'ok');
      });
    }
  }
}
async function trPickJar() {
  if (TRP.running) { toast('正在翻译，等这一次跑完再选下一个吧', 'warn'); return; }
  let r = null;
  try { r = await window.lmc.translatorPick(); }
  catch (e) { toast('选择文件失败：' + ((e && e.message) || e), 'error'); return; }
  if (!r || !r.ok) return;
  trInspect(r.path);
}
async function trInspect(p) {
  if (TRP.running) return;
  if (!p) return;
  trResetView();
  const file = $('#trFile');
  file.style.display = '';
  file.innerHTML = '<svg class="ic sm"><use href="#i-package"/></svg> <b>' + esc(String(p).split(/[\\/]/).pop()) + '</b>' +
    '<span class="tr-dots">正在读取…</span>';
  let info = null;
  try { info = await window.lmc.translatorInspect(p); }
  catch (e) { info = { ok: false, error: (e && e.message) || String(e) }; }
  if (!info || !info.ok) {
    file.innerHTML = '<svg class="ic sm"><use href="#i-warn"/></svg> <b>' + esc(String(p).split(/[\\/]/).pop()) + '</b>' +
      '<span class="tr-bad">' + esc((info && info.error) || '读取失败') + '</span>';
    return;
  }
  TRP.path = info.file.path;
  TRP.info = info;
  file.innerHTML = '<svg class="ic sm"><use href="#i-package"/></svg> <b>' + esc(info.file.name) + '</b>' +
    '<span class="tr-dots">' + trFmtSize(info.file.size) + '</span>' +
    '<button class="ghost-btn" id="btnTrChange">换一个</button>';
  const chg = $('#btnTrChange');
  if (chg) chg.addEventListener('click', (e) => { e.stopPropagation(); trPickJar(); });

  const m = info.mod || {};
  const rows = [
    ['模组', m.name || '（清单里没写名字）'],
    ['标识', m.id || '（未识别）'],
    ['版本', m.version || '（未识别）'],
    ['加载器', (m.loader || '（未识别）') + (m.mcVer ? ' · MC ' + m.mcVer : '')],
    ['语言文件', (info.faces || []).map(f => 'assets/' + f.ns + '/lang/en_us.' + (f.kind === 'json' ? 'json' : 'lang')).join('、') || '—'],
    ['条目', info.total + ' 条，其中 ' + info.translatable + ' 条是英文文本'],
    ['待翻译', info.todo + ' 条' + (info.cached ? '（另有 ' + info.cached + ' 条已缓存或模组自带汉化）' : '')]
  ];
  $('#trFacts').innerHTML = rows.map(([k, v]) =>
    '<div class="tr-fact"><span>' + esc(k) + '</span><b>' + esc(String(v)) + '</b></div>').join('');
  $('#trInfoCard').style.display = '';
  trLog('已读取 ' + info.file.name + '：待翻译 ' + info.todo + ' 条');
  if (info.capped) trLog('这个模组文本很多，本次先翻前 ' + info.limit + ' 条；剩下的再点一次「开始翻译」接着翻（已翻的会命中缓存）');
  if (!info.todo) {
    trBar(100, '这个模组已经全部汉化过了');
    $('#btnTrRun').disabled = true;
    trLog('没有需要翻译的文本，直接进游戏看中文就行');
  } else {
    trBar(0, '准备就绪 · 共 ' + info.todo + ' 条待翻译');
  }
}
async function trRunNow() {
  if (TRP.running) return;
  if (!TRP.path) { toast('先选一个模组 JAR', 'warn'); return; }
  const out = $('#trOutCard');
  out.style.display = 'none';
  $('#trLog').innerHTML = '';
  trSetRunning(true);
  trBar(3, '正在读取模组…');
  trLog('开始翻译，翻译服务需要联网，第一次会慢一点');
  let r = null;
  try { r = await window.lmc.translatorRun({ path: TRP.path }); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  trSetRunning(false);
  if (!r || !r.ok) {
    if (r && r.canceled) {
      trBar(0, '已取消');
      trLog('已取消，没有生成资源包');
      return;
    }
    trBar(0, '翻译失败');
    trLog('失败：' + ((r && r.error) || '未知错误'));
    toast('翻译失败：' + ((r && r.error) || '未知错误'), 'error');
    return;
  }
  TRP.dir = r.dir || '';
  trBar(100, '完成 · 用时 ' + r.seconds + ' 秒');
  trLog('资源包已生成：' + r.packName);
  trLog('翻译 ' + r.translated + ' 条，写入 ' + r.written + ' 条' +
    (r.failed ? '，' + r.failed + ' 条没翻成（保留英文）' : '') +
    (r.capped ? '；还有剩余文本，再点一次「开始翻译」可继续' : ''));
  if (r.quota) trLog('今日免费额度已用完（约 5 万字符/天）：已翻好的都已写进资源包，明天再点一次可接着翻，或勾选「备用通道」继续');
  const m = r.mod || {};
  $('#trOut').innerHTML =
    '<div class="tr-ok"><svg class="ic"><use href="#i-check"/></svg>' +
      '<div><b>' + esc(r.packName) + '</b><span>' + esc(r.pack || '') + '</span></div></div>' +
    '<div class="tr-facts">' +
      '<div class="tr-fact"><span>翻译</span><b>' + r.translated + ' 条</b></div>' +
      '<div class="tr-fact"><span>写入资源包</span><b>' + r.written + ' 条</b></div>' +
      '<div class="tr-fact"><span>用时</span><b>' + r.seconds + ' 秒</b></div>' +
      '<div class="tr-fact"><span>模组</span><b>' + esc(m.name || m.id || '—') + '</b></div>' +
    '</div>' +
    '<div class="tr-hint">进游戏后在「选项 → 资源包」里把「' + esc(r.packName) + '」挪到右边启用即可；' +
    '多个模组汉化包可以一起启用，它们互不影响。</div>';
  out.style.display = '';
  toast('汉化资源包已生成：' + r.packName, 'ok');
}
/* 主进程推来的进度：只在翻译器面板里、正在跑的时候更新界面 */
window.lmc.on('translator:progress', (d) => {
  if (!d || !TRP.running) return;
  if (d.phase === 'read') { trBar(5, d.note || '正在读取…'); return; }
  if (d.phase === 'translate') {
    const pct = 5 + (d.total ? (d.done / d.total) * 90 : 0);
    trBar(pct, (d.note || '正在翻译…') + (d.total ? '（' + d.done + '/' + d.total + '）' : ''));
    return;
  }
  if (d.phase === 'write') { trBar(97, d.note || '正在写入资源包…'); }
});
/* 从界面拖进来的 JAR（preload 取到真实路径后转过来） */
window.lmc.on('translator:drop', (p) => {
  if (PLG.pane !== 'translator' || !p) return;
  trInspect(p);
});

/* ================================================================
 * 社区插件（拓展插件）：面板 = 独立窗口
 * ================================================================
 * 面板是**主进程开的独立窗口**里的顶层文档（file://），跟启动器这个页面没有任何 DOM 关系，
 * 也就摸不到这里的 window.lmc；它想做事只能通过主进程挂在那个窗口上的桥（window.xlcPlugin.call），
 * 由主进程按「导入时用户勾选过的权限」逐条放行。所以这一层只负责「把窗口开起来」。
 * 面板作者按 docs/plugin-api.md 写自己的 panel.html 即可，一行启动器代码都不用看。 */
async function openThirdParty(t) {
  if (!t.entry) { toast('插件「' + t.name + '」没有独立面板（它只提供后台能力）', 'warn'); return; }
  let r = null;
  try { r = await window.lmc.pluginPanelOpen({ id: t.id, theme: document.body.classList.contains('light-bg') ? 'light' : 'dark' }); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (!r || !r.ok) { toast('「' + t.name + '」面板打不开：' + ((r && r.error) || '未知错误'), 'error'); return; }
  toast('已打开「' + t.name + '」面板' + (r.focused ? '（它本来就开着，已切到前台）' : ''), 'ok');
}

/* ---------------- 导入社区插件：选包 → 看清单与权限 → 确认后才安装 ---------------- */
async function importPluginZip() {
  let r = null;
  try { r = await window.lmc.pluginImportPick(); }
  catch (e) { toast('导入失败：' + ((e && e.message) || e), 'error'); return; }
  if (!r || r.canceled) return;
  if (!r.ok) { toast('插件包不可用：' + (r.error || '未知错误'), 'error'); return; }
  openPluginInstallModal(r);
}
function openPluginInstallModal(r) {
  const m = r.manifest || {};
  const perms = Array.isArray(r.permissions) ? r.permissions : [];
  const hosts = Array.isArray(r.hosts) ? r.hosts : [];
  let html = '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> ' + (r.update ? '升级插件' : '导入插件') + '</h3>' +
    '<div class="mmeta">来自 ' + esc(r.zipName || '') + ' · 社区插件（网友制作，非官方内置）</div>' +
    '<div class="plug-info">' +
      '<div class="plug-info-row"><span>名称</span><b>' + esc(m.name || '') + '</b></div>' +
      '<div class="plug-info-row"><span>标识</span><b>' + esc(m.id || '') + '</b></div>' +
      '<div class="plug-info-row"><span>版本</span><b>v' + esc(m.version || '') +
        (r.update ? '<i class="plug-warn">覆盖本机已装的 v' + esc(r.fromVersion || '') + '，启用状态会保留</i>' : '') + '</b></div>' +
      (m.author ? '<div class="plug-info-row"><span>作者</span><b>' + esc(m.author) + '</b></div>' : '') +
      (m.homepage ? '<div class="plug-info-row"><span>主页</span><b>' + esc(m.homepage) + '</b></div>' : '') +
      (m.description ? '<div class="plug-info-row"><span>简介</span><b>' + esc(m.description) + '</b></div>' : '') +
      '<div class="plug-info-row"><span>界面</span><b>' + (m.hasPanel ? '有独立面板' : '无面板（只提供后台能力）') + '</b></div>' +
    '</div>';
  if (perms.length) {
    html += '<div class="mmeta" style="margin-top:12px">它申请这些权限 —— <b>不勾的就不授权</b>，插件调用时会被启动器直接拒绝：</div>';
    for (const p of perms) {
      /* 高危权限（改设置）单独标出来：它和「读个版本号」不是一个量级，用户该在勾选前就知道 */
      const danger = !!p.danger;
      html += '<label class="loader-opt sel' + (danger ? ' danger' : '') + '">' +
        '<input type="checkbox" name="plgperm" value="' + esc(p.key) + '" checked>' +
        '<div class="lo-main"><b>' + esc(PLG_PERM_LABEL[p.key] || p.key) +
          (danger ? '<i class="plug-warn">高权限</i>' : '') + '</b>' +
          '<span>' + esc(p.label || '') + '</span></div>' +
        '<span class="lo-stat ' + (danger ? 'bad' : 'ok') + '">' + (danger ? '慎给' : '可撤销') + '</span></label>';
    }
  } else {
    html += '<div class="mmeta" style="margin-top:12px">这个插件没有申请任何额外权限：它只能显示自己的面板内容。</div>';
  }
  if (hosts.length) {
    html += '<div class="plug-hosts"><b>允许访问的网站</b><span>' + hosts.map(h => esc(h)).join('、') + '</span></div>';
  }
  html += '<div class="plg-tip" style="margin-top:12px"><svg class="ic sm"><use href="#i-lock"/></svg>' +
    '<span>插件面板在自己的独立窗口里打开：看不到启动器源码，也读不了游戏目录与存档。' +
    '它能做的事都被上面这张权限表管住 —— 没勾「改启动器设置」时连设置都读不到；即便勾了，' +
    '插件也只能改设置，<b>不能把任何功能、窗口、公告或更新提示藏起来</b>，而且每次改动启动器都会提示你。' +
    '随时可以停用或移除。</span></div>';
  html += '<div class="mfoot"><button class="btn ghost" id="plgImpCancel">取消</button>' +
    '<button class="btn primary" id="plgImpGo"><svg class="ic sm"><use href="#i-check"/></svg> ' +
    (r.update ? '确认升级' : '确认导入') + '</button></div>';
  modalBox.innerHTML = html;
  openModal(false);
  modalBox.querySelectorAll('input[name=plgperm]').forEach(c => {
    c.addEventListener('change', () => c.closest('.loader-opt').classList.toggle('sel', c.checked));
  });
  $('#plgImpCancel').addEventListener('click', () => closeModal());
  $('#plgImpGo').addEventListener('click', async () => {
    const granted = Array.prototype.slice.call(modalBox.querySelectorAll('input[name=plgperm]:checked')).map(c => c.value);
    $('#plgImpGo').disabled = true; $('#plgImpCancel').disabled = true;
    const res = await window.lmc.pluginImportInstall({ token: r.token, id: m.id, perms: granted });
    if (!res || !res.ok) {
      $('#plgImpGo').disabled = false; $('#plgImpCancel').disabled = false;
      toast('导入失败：' + ((res && res.error) || '未知错误'), 'error');
      return;
    }
    closeModal();
    toast('插件「' + m.name + '」' + (r.update ? '已升级到 v' : '已导入 v') + m.version +
      (granted.length ? '（授权 ' + granted.length + ' 项）' : ''), 'ok');
    if (res.third) PLG.third = res.third;
    gotoPage('plugins');
    renderPlugins(true);
  });
}

$('#btnPlgRefresh').addEventListener('click', () => { renderPlugins(true); toast('插件列表已刷新'); });
$('#btnSeedBack').addEventListener('click', closePlugin);
$('#btnSrvBack').addEventListener('click', closePlugin);
$('#btnGpBack').addEventListener('click', closePlugin);
/* 社区插件没有「面板页」这一层 DOM 了（面板是独立窗口），所以没有返回/打开目录的处理；
   想看它目录直接用卡片右侧那个文件夹按钮（[data-dir]）。 */

/* ================================================================
 * 插件：手柄控制（Gamepad API）
 * 手柄 → 启动器界面：摇杆/十字键移动焦点、A 确认、B 返回、X 刷新、Y 本面板、
 * LB·RB 切页、右摇杆滚动、Start 启动游戏、Back 跳插件页。
 * 焦点用「空间最近邻」算法找相邻控件（按几何位置，不是 DOM 顺序），更符合直觉；
 * 鼠标一动就撤掉手柄焦点 —— 两套输入互不干扰，不插手柄时零开销。
 * ================================================================ */
const GP_DEFAULTS = { enabled: true, deadzone: 0.28, speed: 'normal', vibrate: true, osd: true, cursor: true, cursorSpeed: 1, hideMouse: true };
const GP_REPEAT = { slow: 170, normal: 115, fast: 75 };   /* 长按方向的重复间隔（ms） */
const GP_CURSOR_SPEED = 1020;   /* 光标 1.0 倍速时的最大像素/秒（推到底） */
const GP_WHEEL_SPEED = 1560;    /* 右摇杆推到底时的滚轮速度（像素/秒） */
const GP_CURSOR_HOLD = 360;     /* 长按 A 多久算「拖拽」（也是蓄力环涨满的时间） */
/* 手柄能落的候选控件。
   注意末尾的 [data-gpclick]：版本下拉行、存档卡片、工具箱卡片这些「div + JS 点击」的
   自定义可点元素都不在原生控件之列，不打标记手柄就永远够不着 —— 用户报的
   「选择版本点了没反应」正是这个（焦点模式跳不过去、光标模式点不到）。 */
const GP_SEL = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, .plg-sw, [data-gpclick]';
/* 给自定义可点元素打标：挂 click 监听的地方顺手标一下，手柄就认识它了 */
function gpMark(el) { if (el && el.dataset) el.dataset.gpclick = '1'; return el; }
const GP_MAP_ROWS = [
  ['十字键 / 左摇杆', '移动焦点（光标模式下移动光标）'],
  ['右摇杆', '模拟鼠标滚轮：上下滚动内容'],
  ['A（下方按钮）', '确认 · 点击当前焦点（光标模式下点指针所在位置，长按可拖拽）'],
  ['B（右侧按钮）', '返回 · 关闭弹窗 / 退出插件面板'],
  ['X（左侧按钮）', '刷新当前页面'],
  ['Y（上方按钮）', '打开 / 关闭手柄控制面板'],
  ['LB / RB', '上一个 / 下一个页面'],
  ['R3（按下右摇杆）', '切换「光标模式 / 焦点模式」'],
  ['Start', '启动当前实例'],
  ['Back（Select）', '跳到插件页']
];
const GP_OSD_TEXT = [['左摇杆/十字键', '移动'], ['右摇杆', '滚动'], ['A', '确认'], ['B', '返回'], ['LB/RB', '切页'], ['Y', '手柄面板'], ['R3', '光标'], ['Start', '启动游戏']];
const GP_KEY_CELLS = [[0, 'A'], [1, 'B'], [2, 'X'], [3, 'Y'], [4, 'LB'], [5, 'RB'], [6, 'LT'], [7, 'RT'], [8, 'Back'], [9, 'Start'], [11, 'R3'], [12, '↑'], [13, '↓'], [14, '←'], [15, '→']];
const GP = {
  cfg: Object.assign({}, GP_DEFAULTS),
  timer: 0, running: false, paneInit: false,
  pad: null, prev: null, cur: null, dir: '', nextMoveAt: 0,
  osdEl: null, osdTimer: 0,
  hideMouse: false            /* 当前是否已把系统鼠标指针藏起来（手柄操作中） */
};
/* 虚拟光标（把右摇杆当鼠标用）。
   x/y 是视口坐标；hover 是当前指针下的可交互元素；down/drag 处理长按拖拽（滑块等）。 */
GP.curs = { on: false, x: 0, y: 0, el: null, hover: null, hidden: false, down: false, downAt: 0, moved: false, dragEl: null, lastTick: 0, scrollAt: 0 };
function gpPads() {
  try { return Array.prototype.slice.call(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean); }
  catch (_) { return []; }
}
/* 「真的可见」：display:none 的祖先、折叠区、零尺寸控件都要排除掉 */
function gpVisible(el) {
  if (!el || el.disabled) return false;
  if (el.closest && el.closest('[aria-hidden="true"]')) return false;
  const rs = el.getClientRects();
  if (!rs.length) return false;
  return rs[0].width > 1 && rs[0].height > 1;
}
function gpInModal() { return !!(modalMask && modalMask.style.display !== 'none'); }
function gpScope() { return gpInModal() ? modalMask : ($('.page.active') || document.body); }
function gpFocusables() {
  return Array.prototype.slice.call(gpScope().querySelectorAll(GP_SEL)).filter(gpVisible);
}
function gpVibrate(strong, weak, ms) {
  if (!GP.cfg.vibrate || !GP.pad || !GP.pad.vibrationActuator) return;
  try {
    GP.pad.vibrationActuator.playEffect('dual-rumble', {
      duration: ms || 40,
      strongMagnitude: strong == null ? 0.3 : strong,
      weakMagnitude: weak == null ? 0.3 : weak
    });
  } catch (_) {}
}
/* ---------------- 手柄操作时隐藏系统鼠标指针 ----------------
 * 手柄在手时，屏幕上那个白色箭头是多余的：焦点模式有焦点环、光标模式有圆形准星，
 * 都指明「现在停在哪」。所以手柄一有输入（按键按下 / 摇杆推过阈值）就把系统指针藏起来；
 * 鼠标一动（移动 / 点击 / 滚轮）立刻现回来 —— 和焦点、虚拟光标同一套「谁的输入最新谁说话」。
 * 光标模式拖滑块时，手柄自己派发的合成 mousemove / wheel 会被打上 __gp 标记并跳过，
 * 否则「手柄正在拖」会被误认成「鼠标动了」，指针一闪一闪。
 * 指针是靠 <html> 上的 .gp-nocursor（cursor:none !important）隐起来的，纯渲染层，不碰系统设置。 */
function gpMouseHide(on) {
  const want = !!on && GP.cfg.hideMouse !== false;
  if (GP.hideMouse === want) return;
  GP.hideMouse = want;
  document.documentElement.classList.toggle('gp-nocursor', want);
}
/* 手柄这一帧算不算「有人在操作」：任意按键按下 / 扳机过半，或任一轴推过一半。
   阈值取 0.5（比死区 0.28 大）：轻微漂移不至于把指针藏起来，隐藏是视觉变化，宁可迟钝一点。 */
function gpAnyInput(btns, axes) {
  for (let i = 0; i < btns.length; i++) { const b = btns[i]; if (b && (b.pressed || b.value > 0.5)) return true; }
  for (let i = 0; i < axes.length; i++) { if (Math.abs(Number(axes[i]) || 0) > 0.5) return true; }
  return false;
}
function gpOsdShow() {
  if (GP.cfg.osd === false) return;
  if (!GP.osdEl) { GP.osdEl = el('div', 'gp-osd'); document.body.appendChild(GP.osdEl); }
  if (!GP.osdEl.dataset.built) {
    GP.osdEl.innerHTML = GP_OSD_TEXT.map(r => '<span><i>' + esc(r[0]) + '</i>' + esc(r[1]) + '</span>').join('');
    GP.osdEl.dataset.built = '1';
  }
  GP.osdEl.classList.add('on');
  clearTimeout(GP.osdTimer);
  GP.osdTimer = setTimeout(() => { if (GP.osdEl) GP.osdEl.classList.remove('on'); }, 2600);
}
function gpSetFocus(target, silent) {
  /* 先清掉所有残留高亮：切页 / 列表重建后旧元素可能还挂着 gp-focus，
     全量清理才能保证「同一时刻只有一个焦点」 */
  Array.prototype.slice.call(document.querySelectorAll('.gp-focus')).forEach(e => { if (e !== target) e.classList.remove('gp-focus'); });
  GP.cur = target || null;
  if (!target) return;
  target.classList.add('gp-focus');
  try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
  if (!silent) gpVibrate(0.22, 0.35, 30);
  gpOsdShow();
}
function gpResetFocus() {
  GP.cur = null; GP.dir = '';
  const list = gpFocusables();
  if (list.length) gpSetFocus(list[0], true);
}
function gpMove(dir) {
  const list = gpFocusables();
  if (!list.length) return;
  const cur = GP.cur;
  /* 焦点在滑块上：左右直接微调数值（比跳走更符合直觉） */
  if (cur && cur.tagName === 'INPUT' && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
    const step = Number(cur.step) || 1;
    const lo = Number(cur.min) || 0, hi = Number(cur.max) || 100;
    cur.value = Math.min(hi, Math.max(lo, Number(cur.value) + (dir === 'right' ? step : -step)));
    cur.dispatchEvent(new Event('input', { bubbles: true }));
    gpVibrate(0.15, 0.22, 16);
    return;
  }
  if (!cur || list.indexOf(cur) === -1 || !gpVisible(cur)) { gpSetFocus(list[0]); return; }
  const r0 = cur.getBoundingClientRect();
  const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
  let best = null, bestScore = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t === cur) continue;
    const r = t.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - cx, dy = (r.top + r.height / 2) - cy;
    let main, cross;
    if (dir === 'up') { if (dy > -8) continue; main = -dy; cross = Math.abs(dx); }
    else if (dir === 'down') { if (dy < 8) continue; main = dy; cross = Math.abs(dx); }
    else if (dir === 'left') { if (dx > -8) continue; main = -dx; cross = Math.abs(dy); }
    else { if (dx < 8) continue; main = dx; cross = Math.abs(dy); }
    const score = main + cross * 2.4;   /* 侧向偏移加权：优先正上/下/左/右的邻居 */
    if (score < bestScore) { bestScore = score; best = t; }
  }
  if (best) gpSetFocus(best);
}
function gpConfirm() {
  let target = GP.cur;
  if (!target || !gpVisible(target)) {
    const list = gpFocusables();
    if (!list.length) return;
    target = list[0];
    gpSetFocus(target, true);
  }
  gpVibrate(0.5, 0.7, 70);
  try { target.click(); } catch (_) { toast('这个控件没法用手柄操作', 'warn'); }
}
function gpBack() {
  if (gpInModal()) {
    if (installingNow) { modalNudge(); toast('正在下载，请用弹窗里的「转入后台」或「停止安装」', 'warn'); return; }
    if (modalMask.dataset.maskClose === 'off') { modalNudge(); return; }
    gpVibrate(0.3, 0.4, 40);
    closeModal();
    return;
  }
  /* 展开着的版本下拉先收起：手柄打开的面板，B 就该能关掉（否则会直接退出整页） */
  const vs = $('#vsel');
  if (vs && vs.classList.contains('open')) { gpVibrate(0.3, 0.4, 40); closeVsel(); return; }
  if (PLG.pane) { gpVibrate(0.3, 0.4, 40); closePlugin(); return; }
  const pg = $('.page.active');
  if (pg && pg.id !== 'page-home') { gpVibrate(0.3, 0.4, 40); gotoPage('home'); }
}
function gpRefreshPage() {
  const pg = $('.page.active');
  const id = pg ? pg.id : '';
  gpVibrate(0.3, 0.4, 40);
  if (id === 'page-plugins') { renderPlugins(true); toast('插件列表已刷新'); }
  else if (id === 'page-instances') { renderInstances(); toast('实例列表已刷新'); }
  else if (id === 'page-tools') renderTools();
  else if (id === 'page-account') loadAccounts();
  else if (id === 'page-saves') renderSavesPage();
  else if (id === 'page-friends') loadFriends();
  else toast('当前页面没有可刷新的内容', 'warn');
}
function gpTogglePane() {
  gpVibrate(0.3, 0.4, 40);
  if (PLG.pane === 'gamepad') { closePlugin(); return; }
  if (PLG.on.gamepad === false) { toast('插件「手柄控制」已停用，请先在列表里启用', 'warn'); return; }
  gotoPage('plugins');
  openPlugin('gamepad');
}
function gpRail(step) {
  const btns = Array.prototype.slice.call($$('#railNav .rail-btn')).filter(gpVisible);
  if (!btns.length) return;
  const pg = $('.page.active');
  const cur = pg ? pg.id.replace(/^page-/, '') : '';
  let i = btns.findIndex(b => b.dataset.page === cur);
  if (i < 0) i = 0;
  const next = btns[(i + step + btns.length) % btns.length];
  gotoPage(next.dataset.page);
  gpVibrate(0.25, 0.35, 35);
  toast('已切到：' + (next.title || next.dataset.page), 'ok');
}
function gpLaunch() {
  gpVibrate(0.5, 0.7, 60);
  const btn = $('#btnLaunch');
  if (btn) btn.click(); else toast('没找到启动按钮', 'warn');
}
function gpOpenPlugins() {
  gpVibrate(0.3, 0.4, 40);
  gotoPage('plugins');
  closePlugin();
}
/* ---------------- 虚拟光标：把右摇杆当鼠标用 ----------------
 * 焦点模式是「一格一格跳控件」，滑块、滚动条、卡片上的空白处都够不着；
 * 光标模式让摇杆直接控制一个可见指针，指哪点哪（长按 A 还能拖拽滑块）。
 * 两种模式互斥（R3 或面板开关切换），鼠标一动就让位给真鼠标 —— 谁的输入最新谁说话。 */
function gpCursorEl() {
  if (GP.curs.el) return GP.curs.el;
  const d = el('div', 'gp-cursor');
  d.id = 'gpCursor';
  d.setAttribute('aria-hidden', 'true');
  /* 圆形准星（不是鼠标箭头）：蓄力环 + 外环 + 中心点，纯 CSS 画，任何缩放下都清晰。
     形状参考主机 / 电视遥控的指针：方向无关、在杂乱背景上也一眼能找到。 */
  d.innerHTML = '<span class="gp-cur-charge"></span><span class="gp-cur-ring"></span><span class="gp-cur-dot"></span>';
  document.body.appendChild(d);
  GP.curs.el = d;
  return d;
}
function gpCursorOn() {
  return GP.curs.on && GP.cfg.enabled !== false && !!GP.pad && !GP.curs.hidden;
}
function gpCursorVisible() {
  const d = GP.curs.el;
  if (!d) return;
  d.classList.toggle('on', gpCursorOn());
}
function gpCursorClamp() {
  /* 圆心定位：留出光标半径，别让圆环被推到屏幕外只剩半个 */
  const m = 12;
  GP.curs.x = Math.max(m, Math.min(window.innerWidth - m, GP.curs.x));
  GP.curs.y = Math.max(m, Math.min(window.innerHeight - m, GP.curs.y));
}
/* 指针下真正能点的元素：命中的可能是装饰性子节点，往上找最近的控件 */
function gpCursorTargetAt(x, y) {
  let hit = null;
  try { hit = document.elementFromPoint(x, y); } catch (_) {}
  if (!hit) return null;
  if (hit.closest && hit.closest('.gp-cursor')) return null;
  const btn = hit.closest ? hit.closest(GP_SEL) : null;
  return (btn && gpVisible(btn)) ? btn : null;
}
function gpCursorHover(target) {
  const t = target || null;
  if (GP.curs.hover === t) return;
  if (GP.curs.hover) GP.curs.hover.classList.remove('gp-hover');
  GP.curs.hover = t;
  if (t) t.classList.add('gp-hover');
  /* 环随手上有东西就放大变色 —— 不用等按下去才知道「这个能点」 */
  if (GP.curs.el) GP.curs.el.classList.toggle('hot', !!t);
}
function gpCursorPaint() {
  const d = GP.curs.el;
  if (!d) return;
  d.style.transform = 'translate3d(' + Math.round(GP.curs.x) + 'px,' + Math.round(GP.curs.y) + 'px,0)';
  /* 拖拽中锁定起点元素，中途划过别的控件也不会改目标 */
  gpCursorHover(GP.curs.down ? GP.curs.dragEl : gpCursorTargetAt(GP.curs.x, GP.curs.y));
  gpCursorVisible();
}
function gpCursorShow() {
  if (!GP.curs.hidden) return;
  GP.curs.hidden = false;
  gpCursorVisible();
}
/* 摇杆推量 → 位移。死区边缘起算、推到底满速，且用平方曲线：
   轻推可以一格一格精确定位，推到底能快速横跨整屏。 */
function gpCursorMove(vx, vy, dt) {
  const dz = Number(GP.cfg.deadzone) || 0.28;
  const sp = GP_CURSOR_SPEED * (Number(GP.cfg.cursorSpeed) || 1);
  const norm = (v) => {
    const a = Math.abs(v);
    if (a <= dz) return 0;
    return (v < 0 ? -1 : 1) * Math.min(1, (a - dz) / Math.max(0.01, 1 - dz));
  };
  const nx = norm(vx), ny = norm(vy);
  if (!nx && !ny) return;
  GP.curs.x += nx * Math.abs(nx) * sp * dt;
  GP.curs.y += ny * Math.abs(ny) * sp * dt;
  gpCursorClamp();
  gpCursorShow();
  gpCursorPaint();
}
/* 滚动宿主：优先指针底下那个「真的能滚」的容器（列表、弹窗正文…），
   找不到再退回当前页面容器 —— 光标指哪滚哪，才像鼠标滚轮。 */
function gpScrollHost() {
  if (gpInModal()) return modalBox;
  let node = null;
  try { node = document.elementFromPoint(GP.curs.x, GP.curs.y); } catch (_) {}
  while (node && node !== document.body) {
    const st = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 2) return node;
    node = node.parentElement;
  }
  return $('#content') || document.scrollingElement;
}
function gpScrollBy(dy) {
  const box = gpInModal() ? modalBox : $('#content');
  if (box) box.scrollTop += dy;
  else window.scrollBy(0, dy);
}
/* 右摇杆 = 鼠标滚轮。
   合成的 WheelEvent 在 Chromium 里**不会真的滚动**，所以两件事都要做：
   ① 自己滚指针底下的容器 ② 照样派发 wheel 事件，让页面里自写的滚轮逻辑
   （种子地图缩放这类）也能收到 —— 只做①，那些组件就成了「滚不动的地方」。 */
function gpWheelBy(dy) {
  /* 焦点模式没有指针位置可依据，退回「弹窗正文 / 当前页面」这个老规矩 */
  if (!GP.curs.on) { gpScrollBy(dy); return; }
  const host = gpScrollHost();
  if (host) host.scrollTop += dy;
  else window.scrollBy(0, dy);
  let t = null;
  try { t = document.elementFromPoint(GP.curs.x, GP.curs.y); } catch (_) {}
  if (t && t.dispatchEvent) {
    try {
      const ev = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: dy, deltaMode: 0,
        clientX: Math.round(GP.curs.x), clientY: Math.round(GP.curs.y)
      });
      ev.__gp = 1;    /* 手柄合成的滚轮，不算「鼠标动了」 */
      t.dispatchEvent(ev);
    } catch (_) {}
  }
}
/* 摇杆推量 → 滚轮速度。死区边缘起算、推到底满速，带平方曲线：
   轻推慢慢滚（能停在想看的位置），推到底快速翻长列表。 */
function gpWheelSpeed(v) {
  const dz = Number(GP.cfg.deadzone) || 0.28;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  const n = Math.min(1, (a - dz) / Math.max(0.01, 1 - dz));
  return (v < 0 ? -1 : 1) * n * n * GP_WHEEL_SPEED;
}
function gpCursorDispatch(t, type) {
  if (!t || !t.dispatchEvent) return;
  try {
    const ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX: Math.round(GP.curs.x), clientY: Math.round(GP.curs.y)
    });
    ev.__gp = 1;      /* 手柄合成的，冒泡到 window 时不许当成「鼠标动了」 */
    t.dispatchEvent(ev);
  } catch (_) {}
}
/* 拖拽时直接改 range 的值：合成的 mousemove 驱动不了 Chromium 原生滑块，
   按指针在轨道上的比例算值反而更准、也不飘。 */
function gpCursorDragRange(r) {
  const b = r.getBoundingClientRect();
  if (!b.width) return;
  const p = Math.max(0, Math.min(1, (GP.curs.x - b.left) / b.width));
  const lo = Number(r.min) || 0, hi = Number(r.max) || 100, step = Number(r.step) || 1;
  let v = lo + (hi - lo) * p;
  v = Math.round((v - lo) / step) * step + lo;
  r.value = String(Math.min(hi, Math.max(lo, v)));
  r.dispatchEvent(new Event('input', { bubbles: true }));
}
function gpCursorPress() {
  const t = GP.curs.hover;
  GP.curs.down = true; GP.curs.downAt = Date.now(); GP.curs.moved = false; GP.curs.dragEl = t;
  if (GP.curs.el) {
    GP.curs.el.classList.add('down');
    GP.curs.el.classList.remove('charging', 'drag');
    GP.curs.el.style.setProperty('--gpCharge', '0');
  }
  gpVibrate(0.45, 0.6, 50);
  if (t) gpCursorDispatch(t, 'mousedown');
}
function gpCursorDragTick() {
  const t = GP.curs.dragEl;
  if (!t) return;
  /* 按住的前 360ms 画蓄力环（涨满才进拖拽），避免手抖把单击变成拖拽，
     也让「长按能拖」这件事被看见，而不是靠用户猜。 */
  const p = Math.min(1, (Date.now() - GP.curs.downAt) / GP_CURSOR_HOLD);
  const d = GP.curs.el;
  if (d) {
    d.style.setProperty('--gpCharge', p.toFixed(3));
    if (GP.curs.moved) d.classList.add('drag');
    else d.classList.toggle('charging', p < 1);
  }
  if (!GP.curs.moved && p < 1) return;
  GP.curs.moved = true;
  if (d) { d.classList.remove('charging'); d.classList.add('drag'); }
  if (t.tagName === 'INPUT' && t.type === 'range') { gpCursorDragRange(t); return; }
  gpCursorDispatch(t, 'mousemove');
}
function gpCursorRelease() {
  const t = GP.curs.dragEl, wasDrag = GP.curs.moved;
  GP.curs.down = false; GP.curs.moved = false; GP.curs.dragEl = null;
  if (GP.curs.el) {
    GP.curs.el.classList.remove('down', 'charging', 'drag');
    GP.curs.el.style.setProperty('--gpCharge', '0');
  }
  if (!t) return;
  gpCursorDispatch(t, 'mouseup');
  if (!wasDrag) {
    gpVibrate(0.5, 0.7, 65);
    try { t.click(); } catch (_) { toast('这个控件没法用手柄操作', 'warn'); }
  }
  gpCursorPaint();
}
function gpCursorApply(on, silent) {
  GP.curs.on = !!on;
  gpCursorEl();          /* 惰性创建 —— 不在这里建的话元素永远不进 DOM，指针也就永远不显示 */
  if (GP.curs.on) {
    /* 显式切到光标模式 = 用户明确要用光标了，把「刚才用鼠标」的隐藏状态清掉，
       否则会切了模式却看不到指针，还得先推一下摇杆才出现。 */
    GP.curs.hidden = false;
    if (!GP.curs.x && !GP.curs.y) {
      GP.curs.x = Math.round(window.innerWidth / 2);
      GP.curs.y = Math.round(window.innerHeight / 2);
    }
    /* 焦点环撤掉：光标模式下 A 是「点指针处」，留着焦点环会让人搞不清点哪个 */
    gpSetFocus(null);
    gpCursorPaint();
  } else {
    gpCursorHover(null);
    gpCursorVisible();
  }
  if (!silent) toast(GP.curs.on ? '已切到光标模式：摇杆移动指针，A 点击' : '已切到焦点模式：摇杆在控件间跳转', 'ok');
}
/* 主循环：30Hz 轮询（跟手且不烧 CPU），最小化时浏览器自动降频 */
function gpTick() {
  const pads = gpPads();
  const pad = pads[0] || null;
  GP.pad = pad;
  if (PLG.pane === 'gamepad') gpPaint(pad, pads);
  if (!pad) { GP.prev = null; gpCursorVisible(); gpMouseHide(false); return; }
  const btns = pad.buttons || [];
  const axes = pad.axes || [];
  const on = i => !!(btns[i] && (btns[i].pressed || btns[i].value > 0.5));
  const now = Date.now();
  const dt = Math.min(0.06, Math.max(0.004, (now - (GP.curs.lastTick || now)) / 1000));
  GP.curs.lastTick = now;
  /* 刚接上手柄的第一帧只记基线、不执行动作：否则「按任意键唤醒手柄」会把那个键
     当成新按下，直接触发一次点击 / 切页（假手柄注入时撞到过这个坑）。 */
  if (!GP.prev) { GP.prev = btns.map(b => !!(b && (b.pressed || b.value > 0.5))); return; }
  const edge = i => on(i) && !GP.prev[i];
  const dz = Number(GP.cfg.deadzone) || 0.28;
  /* 手柄真有输入 → 收起系统鼠标指针，把屏幕让给焦点环 / 圆形光标；
     鼠标一动就还回来（文件末尾的鼠标监听）。只有「这一帧确实有输入」时才动手，
     无输入不传 false —— 否则摇杆一回中就等于「自己把指针放出来」，隐藏根本保持不住。 */
  if (gpAnyInput(btns, axes)) gpMouseHide(true);

  if (GP.curs.on) {
    /* ---------------- 光标模式 ---------------- */
    /* 左摇杆 = 移光标（十字键左右同义）；右摇杆让位给滚轮，见下 */
    let mx = axes[0] || 0, my = axes[1] || 0;
    if (on(15)) mx = 1; else if (on(12)) mx = -1;
    gpCursorMove(mx, my, dt);
    /* 右摇杆上下 = 鼠标滚轮：轻推慢慢滚、推到底快速翻长列表 */
    const wy = gpWheelSpeed(axes[3] || 0);
    if (wy) gpWheelBy(wy * dt);
    /* 十字键上下 = 逐格滚动（比摇杆精准，翻列表时想「一格一格」用这个） */
    const sc = (on(13) ? -1 : 0) + (on(14) ? 1 : 0);
    if (sc) { if (now >= (GP.curs.scrollAt || 0)) { GP.curs.scrollAt = now + 85; gpScrollBy(sc * 66); } }
    else GP.curs.scrollAt = 0;
    /* A 分「按下 / 松开」两段：按住可以拖动（滑块），松开才算点击 */
    if (on(0) && !GP.curs.down) gpCursorPress();
    else if (on(0) && GP.curs.down) gpCursorDragTick();
    else if (!on(0) && GP.curs.down) gpCursorRelease();
  } else {
    /* ---------------- 焦点模式 ---------------- */
    let dir = '';
    /* 十字键优先于摇杆，避免摇杆回中过程中「抢方向」 */
    if (on(13)) dir = 'up'; else if (on(14)) dir = 'down';
    else if (on(15)) dir = 'right'; else if (on(12)) dir = 'left';
    const ax = axes[0] || 0, ay = axes[1] || 0, ry = axes[3] || 0;
    if (!dir) {
      if (ay < -dz) dir = 'up'; else if (ay > dz) dir = 'down';
      else if (ax < -dz) dir = 'left'; else if (ax > dz) dir = 'right';
    }
    if (!dir) GP.dir = '';
    else if (GP.dir !== dir) { GP.dir = dir; GP.nextMoveAt = now + 260; gpMove(dir); }   /* 首次延迟稍长，长按后变快 */
    else if (now >= GP.nextMoveAt) { GP.nextMoveAt = now + (GP_REPEAT[GP.cfg.speed] || 115); gpMove(dir); }
    /* 右摇杆上下 = 鼠标滚轮（与光标模式同一套，不用记「哪个模式怎么滚」） */
    const wy = gpWheelSpeed(ry);
    if (wy) gpWheelBy(wy * dt);
  }

  if (edge(1)) gpBack();
  if (edge(2)) gpRefreshPage();
  if (edge(3)) gpTogglePane();
  if (edge(4)) gpRail(-1);
  if (edge(5)) gpRail(1);
  if (edge(8)) gpOpenPlugins();
  if (edge(9)) gpLaunch();
  if (edge(11)) gpCursorToggle();
  /* A 在光标模式下走上面的「按下 / 松开」两段逻辑，这里不能重复点一次 */
  if (!GP.curs.on && edge(0)) gpConfirm();
  GP.prev = btns.map(b => !!(b && (b.pressed || b.value > 0.5)));
}
/* R3 / 面板开关：切换光标模式，并记住选择 */
function gpCursorToggle(silent) {
  GP.cfg.cursor = !GP.curs.on;
  gpCursorApply(GP.cfg.cursor, !!silent);
  gpSaveCfg();
  const sw = $('#gpCursorSw');
  if (sw) sw.checked = !!GP.cfg.cursor;
}
function gpSaveCfg() {
  try { window.lmc.saveConfig({ gamepad: Object.assign({}, GP.cfg) }); } catch (_) {}
}
function gpStart() { if (GP.running) return; GP.running = true; GP.timer = setInterval(gpTick, 33); }
function gpStop() {
  GP.running = false;
  if (GP.timer) clearInterval(GP.timer);
  GP.timer = 0; GP.prev = null; GP.dir = '';
  if (GP.cur) { GP.cur.classList.remove('gp-focus'); GP.cur = null; }
  if (GP.osdEl) GP.osdEl.classList.remove('on');
  /* 停用时连光标一起收掉，别在界面上留一个动不了的圆环 */
  gpMouseHide(false);           /* 手柄停用了，系统鼠标指针立刻还回来 */
  gpCursorHover(null);
  GP.curs.down = false; GP.curs.moved = false; GP.curs.dragEl = null;
  if (GP.curs.el) {
    GP.curs.el.classList.remove('down', 'charging', 'drag');
    GP.curs.el.style.setProperty('--gpCharge', '0');
  }
  gpCursorVisible();
}
function gpApply() {
  const on = (PLG.on.gamepad !== false) && (GP.cfg.enabled !== false);
  if (on) gpStart(); else gpStop();
  /* 重启轮询后光标状态跟着配置走（静默，不弹提示） */
  gpCursorApply(GP.cfg.cursor !== false, true);
}
async function gpSync() {
  try {
    const r = await window.lmc.pluginList();
    if (r && r.ok) PLG.on = r.plugins || {};
  } catch (_) {}
  if (S.config && S.config.gamepad) GP.cfg = Object.assign({}, GP_DEFAULTS, S.config.gamepad);
  gpApply();
}
/* 面板：连接状态 + 实时按键/摇杆可视化 */
function gpPaint(pad, pads) {
  const dot = $('#gpDot');
  if (!dot) return;
  const list = pads || [];
  dot.classList.toggle('on', !!pad);
  const tx = $('#gpConnTx'), meta = $('#gpMeta'), sd = $('#gpStickDot');
  if (tx) tx.textContent = pad ? '已连接' : (list.length ? '检测到手柄，等待输入…' : '未检测到手柄');
  if (meta) {
    meta.textContent = pad
      ? (String(pad.id || '手柄').slice(0, 58) + ' · 映射 ' + (pad.mapping === 'standard' ? '标准' : '非标准')
        + ' · ' + (pad.buttons || []).length + ' 键 / ' + (pad.axes || []).length + ' 轴')
      : '接上手柄后按下任意键即可被识别（个别手柄需先按一下再等 1~2 秒）';
  }
  const kw = $('#gpKeys');
  if (kw) {
    if (!kw.dataset.built) {
      kw.innerHTML = GP_KEY_CELLS.map(c => '<i data-gp="' + c[0] + '">' + c[1] + '</i>').join('');
      kw.dataset.built = '1';
    }
    const btns = (pad && pad.buttons) || [];
    Array.prototype.slice.call(kw.querySelectorAll('[data-gp]')).forEach(cell => {
      const b = btns[Number(cell.dataset.gp)];
      cell.classList.toggle('on', !!(b && (b.pressed || b.value > 0.5)));
    });
  }
  if (sd) {
    const a = (pad && pad.axes) || [];
    sd.style.left = (50 + (a[0] || 0) * 42) + '%';
    sd.style.top = (50 + (a[1] || 0) * 42) + '%';
  }
}
async function initGamepadPane() {
  if (!GP.paneInit) {
    GP.paneInit = true;
    if (S.config && S.config.gamepad) GP.cfg = Object.assign({}, GP_DEFAULTS, S.config.gamepad);
    const en = $('#gpEnable'), dead = $('#gpDead'), deadV = $('#gpDeadVal');
    const sp = $('#gpSpeed'), vib = $('#gpVib'), osd = $('#gpOsd'), map = $('#gpMap');
    if (en) en.checked = GP.cfg.enabled !== false;
    if (dead) dead.value = String(GP.cfg.deadzone);
    if (deadV) deadV.textContent = Number(GP.cfg.deadzone).toFixed(2);
    if (sp) sp.value = GP.cfg.speed;
    if (vib) vib.value = GP.cfg.vibrate ? '1' : '0';
    if (osd) osd.checked = GP.cfg.osd !== false;
    if (map) map.innerHTML = GP_MAP_ROWS.map(r => '<div class="gp-map-row"><i>' + esc(r[0]) + '</i><span>' + esc(r[1]) + '</span></div>').join('');
    const save = gpSaveCfg;
    if (en) en.addEventListener('change', () => {
      GP.cfg.enabled = en.checked; save(); gpApply();
      toast(en.checked ? '手柄导航已启用' : '手柄导航已关闭', en.checked ? 'ok' : 'warn');
    });
    if (dead) {
      dead.addEventListener('input', () => { GP.cfg.deadzone = Number(dead.value); if (deadV) deadV.textContent = GP.cfg.deadzone.toFixed(2); });
      dead.addEventListener('change', save);
    }
    if (sp) sp.addEventListener('change', () => { GP.cfg.speed = sp.value; save(); });
    if (vib) vib.addEventListener('change', () => { GP.cfg.vibrate = vib.value === '1'; save(); });
    if (osd) osd.addEventListener('change', () => { GP.cfg.osd = osd.checked; save(); if (!osd.checked && GP.osdEl) GP.osdEl.classList.remove('on'); });
    /* 隐藏系统鼠标指针：手柄操作时把白箭头收起来，鼠标一动立刻回来（默认开） */
    const hm = $('#gpHideMouse');
    if (hm) {
      hm.checked = GP.cfg.hideMouse !== false;
      hm.addEventListener('change', () => {
        GP.cfg.hideMouse = hm.checked; save();
        if (!hm.checked) gpMouseHide(false);   /* 关掉开关：立刻把指针还回来，不用等下次动鼠标 */
      });
    }
    /* 光标模式：开关 = R3；速度影响摇杆推满时的位移，10 档够用 */
    const cSw = $('#gpCursorSw'), cSpd = $('#gpCurSpd'), cSpdV = $('#gpCurSpdVal');
    if (cSw) cSw.addEventListener('change', () => {
      GP.cfg.cursor = cSw.checked; gpCursorApply(cSw.checked, false); save();
    });
    if (cSpd) {
      cSpd.addEventListener('input', () => {
        GP.cfg.cursorSpeed = Number(cSpd.value) || 1;
        if (cSpdV) cSpdV.textContent = GP.cfg.cursorSpeed.toFixed(1);
      });
      cSpd.addEventListener('change', save);
    }
  }
  /* 光标模式这两项每次进面板都同步一次（R3 切换后回面板要看到最新状态） */
  const cSw = $('#gpCursorSw'), cSpd = $('#gpCurSpd'), cSpdV = $('#gpCurSpdVal');
  if (cSw) cSw.checked = GP.cfg.cursor !== false && GP.curs.on;
  const hmSw = $('#gpHideMouse');
  if (hmSw) hmSw.checked = GP.cfg.hideMouse !== false;
  if (cSpd) cSpd.value = String(Number(GP.cfg.cursorSpeed) || 1);
  if (cSpdV) cSpdV.textContent = (Number(GP.cfg.cursorSpeed) || 1).toFixed(1);
  const pads = gpPads();
  gpPaint(pads[0] || null, pads);
  gpApply();
}
/* 启动自检：进界面 1.2s 后同步一次插件状态与配置（不插手柄时什么都不做） */
setTimeout(gpSync, 1200);
window.addEventListener('gamepadconnected', () => { gpSync(); gpOsdShow(); });
/* 鼠标一动就让位给真鼠标：撤掉手柄焦点，并把虚拟光标收起来（下次碰摇杆立刻回来），
   同时把被手柄藏起来的系统指针显示回来 —— 「鼠标有动态就显示」。
   注意最后那道 __gp 判断：手柄合成的事件（光标模式拖拽 / 滚动）会在 window 上冒泡，
   那不是「鼠标动了」，放它过去指针就会在拖拽途中一闪一闪。 */
window.addEventListener('mousemove', (e) => {
  if (e && e.__gp) return;
  gpMouseHide(false);
  if (!GP.cur && !GP.curs.el) return;
  if (GP.cur) { GP.cur.classList.remove('gp-focus'); GP.cur = null; }
  if (GP.curs.el && !GP.curs.hidden) {
    GP.curs.hidden = true;
    gpCursorHover(null);
    GP.curs.down = false; GP.curs.moved = false; GP.curs.dragEl = null;
    gpCursorVisible();
  }
}, true);
/* 点击 / 滚轮也算「手在鼠标上」：指针立刻现身，不用先晃一下才看得见 */
const gpMouseWake = (e) => { if (!e || !e.__gp) gpMouseHide(false); };
window.addEventListener('mousedown', gpMouseWake, true);
window.addEventListener('wheel', gpMouseWake, true);
/* 窗口失焦（切到别的应用去点鼠标）：把指针状态复位，回来时不会是一把看不见的鼠标 */
window.addEventListener('blur', () => gpMouseHide(false));

/* ---------------- 插件：种子地图 ---------------- */
const SM = { init: false, saves: [] };
/* 默认版本 = 最新的 Java 正式版（与 Chunkbase 自己的默认值一致）；
   清单来自主进程（见 main.js SEEDMAP_PLATFORMS），按 group 拆成 Java 版 / 基岩版两组。 */
const SM_DEFAULT_PLATFORM = 'java_26_3';
function fillSmPlatforms(list) {
  const sel = $('#smPlatform');
  let html = '', cur = null;
  for (const p of list) {
    const g = p.group || '';
    if (g !== cur) {
      if (cur) html += '</optgroup>';
      cur = g;
      if (g) html += '<optgroup label="' + esc(g) + '">';
    }
    html += '<option value="' + esc(p.code) + '">' + esc(p.label) + '</option>';
  }
  if (cur) html += '</optgroup>';
  sel.innerHTML = html;
  const opts = [...sel.options];
  const want = opts.find(o => o.value === SM_DEFAULT_PLATFORM);
  sel.value = want ? want.value : (opts[0] ? opts[0].value : '');
}
async function initSeedmap() {
  if (!SM.init) {
    SM.init = true;
    try {
      const r = await window.lmc.seedmapPlatforms();
      fillSmPlatforms((r && r.platforms) || []);
    } catch (_) {}
    loadSmSaves();
  }
  if (!$('#smSeed').value) $('#smSeed').value = String(Math.floor(Math.random() * 9e8) + 1e8);
}
async function loadSmSaves() {
  const sel = $('#smSave');
  try {
    const r = await window.lmc.savesList();
    SM.saves = (r && r.saves) || [];
    sel.innerHTML = '<option value="">选择存档自动填入种子…</option>' + SM.saves.map((s, i) =>
      '<option value="' + i + '">' + esc(s.levelName || s.name) +
      '（' + (s.instance ? esc(s.instance) + ' · 隔离' : '全局') + '）</option>').join('');
  } catch (_) { sel.innerHTML = '<option value="">读取存档失败</option>'; }
}
$('#btnSmRand').addEventListener('click', () => {
  /* 随机种子：一半正数一半负数，负数更接近游戏内「随机种子」的手感 */
  const n = Math.floor(Math.random() * 9e8) + 1;
  $('#smSeed').value = String(Math.random() < 0.5 ? -n : n);
  toast('已生成随机种子');
});
$('#btnSmSaveSeed').addEventListener('click', () => {
  const i = parseInt($('#smSave').value, 10);
  const s = SM.saves[i];
  if (!s) { toast('请先选择一个存档', 'warn'); return; }
  if (s.seed == null || s.seed === '') { toast('该存档没有记录种子（旧版本或 level.dat 缺失）', 'warn'); return; }
  $('#smSeed').value = String(s.seed);
  toast('已填入「' + (s.levelName || s.name) + '」的种子：' + s.seed);
});
$('#btnSmOpen').addEventListener('click', async () => {
  const seed = $('#smSeed').value.trim();
  if (!seed) { toast('请先输入种子', 'warn'); return; }
  const btn = $('#btnSmOpen');
  btn.disabled = true;
  try {
    const r = await window.lmc.seedmapOpen({ seed, platform: $('#smPlatform').value, dimension: $('#smDim').value });
    toast(r && r.external ? '已在系统浏览器打开种子地图' : '种子地图已在新窗口打开');
  } catch (e) { toast('打开失败：' + e.message, 'error'); }
  finally { setTimeout(() => { btn.disabled = false; }, 800); }
});

/* ---------------- 插件：一键开服 ---------------- */
const SRV = { init: false, cores: [], core: 'paper', list: [], sel: '', logs: {}, creating: false, bound: false, lan: [], ready: {} };
async function initServerPane() {
  if (!SRV.init) {
    SRV.init = true;
    try {
      const r = await window.lmc.serverCores();
      SRV.cores = (r && r.cores) || [];
    } catch (_) {}
    if (!SRV.cores.length) {
      SRV.cores = [
        { id: 'paper', name: 'Paper', desc: '高性能服务端，支持 Bukkit/Spigot 插件（推荐）' },
        { id: 'purpur', name: 'Purpur', desc: 'Paper 分支，可玩性设置更多' },
        { id: 'vanilla', name: '原版', desc: 'Mojang 官方服务端，纯净无插件' },
        { id: 'fabric', name: 'Fabric', desc: '轻量模组服务端，支持 Fabric 模组' }
      ];
    }
    renderCoreCards();
    bindServerEvents();
  }
  loadServerVersions(SRV.core);
  loadServerList();
}
function renderCoreCards() {
  const box = $('#srvCores');
  box.innerHTML = SRV.cores.map(c =>
    '<div class="core-card' + (c.id === SRV.core ? ' on' : '') + '" data-core="' + esc(c.id) + '">' +
    '<b>' + esc(c.name) + '</b><span>' + esc(c.desc) + '</span></div>').join('');
  $$('#srvCores .core-card').forEach(c => c.addEventListener('click', () => {
    SRV.core = c.dataset.core;
    renderCoreCards();
    loadServerVersions(SRV.core);
  }));
}
async function loadServerVersions(core) {
  const sel = $('#srvVersion');
  sel.innerHTML = '<option value="">正在获取版本…</option>';
  try {
    const r = await window.lmc.serverVersions({ core });
    if (!r || !r.ok) throw new Error((r && r.error) || '获取版本失败');
    const vs = r.versions || [];
    if (!vs.length) throw new Error('没有获取到可用版本');
    sel.innerHTML = vs.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
  } catch (e) {
    sel.innerHTML = '<option value="">获取失败：' + esc(e.message) + '</option>';
  }
}
async function loadServerList() {
  try {
    const r = await window.lmc.serverList();
    SRV.list = (r && r.servers) || [];
    SRV.lan = (r && r.lan) || [];
  } catch (_) { SRV.list = []; }
  renderServerList();
  /* 之前选中的服务器仍在 → 同步刷新控制台（回页/刷新时保持上下文） */
  if (SRV.sel && SRV.list.some(x => x.name === SRV.sel)) showServerConsole(SRV.sel);
}
/* 某服务器的连接地址：优先用主进程算好的，缺失时用端口 + 缓存的局域网 IP 兜底 */
function srvAddrInfo(s) {
  const port = (s && parseInt(s.port, 10)) || 25565;
  const a = (s && s.addr) || {};
  const local = a.local || ('127.0.0.1:' + port);
  let lan = [], ifaces = [];
  if (a.lan && a.lan.length) {
    lan = a.lan;
    ifaces = a.lanIfaces || [];
  } else {
    const cached = SRV.lan || [];
    lan = cached.map(x => ((typeof x === 'string' ? x : x.ip) + ':' + port));
    ifaces = cached.map(x => (typeof x === 'string' ? '' : (x.iface || '')));
  }
  return { port, local, lan, ifaces };
}
async function copySrvAddr(text) {
  if (!text) return;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
  if (!ok) { try { ok = !!(await window.lmc.copyText(text)); } catch (_) {} }
  toast(ok ? '已复制：' + text : '复制失败，请手动选中地址', ok ? 'ok' : 'warn');
}
/* 「怎么让玩家进来」地址面板：本机 / 局域网两种地址 + 一键复制 */
function renderServerAddr(s) {
  const box = $('#srvAddrBox');
  if (!box) return;
  if (!s) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const { local, lan, ifaces } = srvAddrInfo(s);
  const offline = s.onlineMode === false;
  const running = !!s.running;
  const ready = !!(s.name && SRV.ready[s.name]);
  /* 状态标签跟着进程走：未启动 → 启动中（等到 Done 才真正开始监听端口）→ 已就绪 */
  const badge = !running ? '<span class="srv-addr-idle">启动后才可连入</span>'
    : ready ? '<span class="srv-addr-live">已就绪</span>'
    : '<span class="srv-addr-idle">启动中…（等到日志出现 Done）</span>';
  box.style.display = '';
  box.innerHTML =
    '<div class="srv-addr-head">' +
      '<svg class="ic sm"><use href="#i-globe"/></svg>' +
      '<b>连接地址</b>' +
      '<span class="t-dim">游戏里：多人游戏 → 添加服务器 → 服务器地址粘贴下面这串 → 完成</span>' +
      badge +
    '</div>' +
    '<div class="srv-addr-grid">' +
      '<div class="srv-addr-row"><span class="srv-addr-role">本机（自己进服）</span>' +
        '<code class="srv-addr-val">' + esc(local) + '</code>' +
        '<button class="btn ghost sm" data-addr="' + esc(local) + '">复制</button></div>' +
      (lan.length
        ? '<div class="srv-addr-row"><span class="srv-addr-role">好友（' + esc(ifaces[0] || '同一 WiFi / 局域网') + '）</span>' +
            '<code class="srv-addr-val">' + esc(lan[0]) + '</code>' +
            '<button class="btn ghost sm" data-addr="' + esc(lan[0]) + '">复制</button></div>'
        : '<div class="srv-addr-row"><span class="srv-addr-role">好友（同一 WiFi / 局域网）</span>' +
            '<span class="srv-addr-none">未检测到局域网地址：请先连上路由器 / 热点（或该网卡被禁用）</span></div>') +
    '</div>' +
    '<div class="srv-addr-tips">' +
      (lan.length > 1
        ? '其他网卡地址：' + lan.slice(1).map((ad, i) =>
            ((ifaces[i + 1] ? esc(ifaces[i + 1]) + ' ' : '') + esc(ad))).join('、') + '<br>'
        : '') +
      '发给好友时用「局域网」地址；同一台电脑自己玩用「本机」地址即可。<br>' +
      '首次开服若 Windows 防火墙弹窗，请勾选「专用网络」并点「允许访问」，否则好友连不上。<br>' +
      '不在同一网络（外网联机）需要内网穿透或公网 IP 端口映射，本机地址对外不可用。' +
      (offline ? '<br><span class="srv-addr-warn">该服务器是离线模式（未开启正版验证）：好友需在启动器里关闭正版验证才能进服。</span>' : '') +
    '</div>';
  $$('#srvAddrBox [data-addr]').forEach(b =>
    b.addEventListener('click', () => copySrvAddr(b.dataset.addr)));
}
/* 「刚进服就被断开」识别：Fabric 服务端没装客户端 mod 时，玩家侧看到的是「网络协议错误」，
   服务端日志只有一句 lost connection: Disconnected —— 光看日志完全不知道为什么。
   这里把「进服后 30 秒内掉线」+「服务端 mods 为空」两步对上，直接把该怎么做说出来。 */
const SRV_JOIN_AT = {};
function srvWatchModKick(d) {
  const line = String(d.line || '');
  if (d.self) return;
  let m = /]:\s+([A-Za-z0-9_\-.]+) joined the game/.exec(line);
  if (m) { SRV_JOIN_AT[d.name + '|' + m[1]] = Date.now(); return; }
  m = /]:\s+([A-Za-z0-9_\-.]+) lost connection: Disconnected/.exec(line);
  if (!m) return;
  const key = d.name + '|' + m[1];
  const at = SRV_JOIN_AT[key];
  delete SRV_JOIN_AT[key];
  if (!at || Date.now() - at > 30000) return;   /* 玩了一会儿才退出属正常，不打扰 */
  const s = SRV.list.find(x => x.name === d.name);
  if (!s || String(s.core) !== 'fabric' || s.modsCount) return;
  toast('玩家「' + m[1] + '」刚进服就被断开：这台服务端还没装 mod。点卡片上的「同步 mod」再重启服务端即可（客户端那边会提示「网络协议错误」）', 'warn');
  loadServerList();
}
function renderServerList() {
  const box = $('#srvList');
  if (!SRV.list.length) {
    box.innerHTML = '<div class="empty-sm">还没有服务器<br><span style="font-size:11px">在上面选择核心与版本，点「下载并创建服务器」</span></div>';
    return;
  }
  box.innerHTML = SRV.list.map(s => {
    const { local, lan } = srvAddrInfo(s);
    const isFab = String(s.core) === 'fabric';
    const modTag = isFab
      ? (s.modsCount ? ' <span class="plg-tag" style="color:#22c55e">mod ' + s.modsCount + '</span>'
                     : ' <span class="plg-tag srv-modwarn">未装 mod</span>')
      : '';
    return '<div class="srv-card' + (s.name === SRV.sel ? ' sel' : '') + '" data-srv="' + esc(s.name) + '">' +
    '<span class="srv-state' + (s.running ? ' on' : '') + '"></span>' +
    '<div class="srv-info"><b>' + esc(s.name) + (s.running ? ' <span class="plg-tag" style="color:#22c55e">运行中</span>' : '') + modTag + '</b>' +
    '<span>' + esc(coreName(s.core)) + ' ' + esc(s.ver) + ' · 端口 ' + (s.port || 25565) + ' · 内存 ' +
    ((s.memMB || 2048) / 1024).toFixed(1) + 'G · ' + (s.onlineMode ? '正版验证' : '离线模式') + '</span>' +
    '<span class="srv-addr-line" data-addr="' + esc(local) + '" title="点击复制本机地址">进服地址 ' + esc(local) +
    (lan.length ? ' · 局域网 ' + esc(lan[0]) : '') + '</span>' +
    (isFab && !s.modsCount
      ? '<span class="srv-addr-warn">客户端装了 mod 的话，不点「同步 mod」直接进服会提示「网络协议错误」并被踢出。</span>'
      : '') +
    '<span class="t-dim">' + esc(s.dir) + '</span></div>' +
    '<div class="srv-acts">' +
    '<button class="btn ghost" data-a="start" title="启动服务器"><svg class="ic sm"><use href="#i-play"/></svg></button>' +
    '<button class="btn ghost" data-a="stop" title="停止服务器"><svg class="ic sm"><use href="#i-x"/></svg></button>' +
    (isFab ? '<button class="btn ghost" data-a="sync" title="把客户端实例里「服务端也要装」的 mod 同步到这台服务器"><svg class="ic sm"><use href="#i-sync"/></svg></button>' : '') +
    '<button class="btn ghost" data-a="dir" title="打开目录"><svg class="ic sm"><use href="#i-folder"/></svg></button>' +
    '<button class="btn ghost" data-a="del" title="删除（移入回收站）"><svg class="ic sm"><use href="#i-trash"/></svg></button>' +
    '</div></div>';
  }).join('');
}
/* 同步客户端 mod → 服务端（Fabric 服必做，否则客户端进服会被注册表校验踢掉） */
async function syncServerMods(name) {
  const s = SRV.list.find(x => x.name === name);
  if (s && s.running) {
    toast('服务器正在运行，同步后需要重启才生效', 'warn');
  }
  let r = null;
  try { r = await window.lmc.serverSyncMods({ name }); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { toast('同步失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
  const add = (r.added || []).length, upd = (r.updated || []).length, sk = (r.clientOnly || []).length;
  if (!add && !upd) {
    toast('服务端 mod 已是最新（已装 ' + (s ? s.modsCount : 0) + ' 个，跳过纯客户端 ' + sk + ' 个）');
    return;
  }
  await loadServerList();
  renderServerList();
  showServerConsole(name);
  toast('已同步 mod：新增 ' + add + '、更新 ' + upd + '，跳过纯客户端 ' + sk +
    '。' + (s && s.running ? '请点「停止」再「启动」让 mod 生效。' : '可以启动服务器了。'), 'ok');
}
/* ---------------- 外网联机：把「陶瓦联机」接进服务器面板 ----------------
 * 独立服务器不像单机世界能「对局域网开放」，所以用法是：
 *   房主创建房间（陶瓦把双方组进同一个 EasyTier 虚拟局域网）→ 朋友凭房间码加入 →
 *   朋友用「房主虚拟网卡 IP:服务器端口」直连。房间建立后虚拟网卡地址会自动出现在
 *   上方「连接地址」面板里（lanIPv4 特意保留了 EasyTier / ZeroTier / Radmin 这类网卡）。*/
const SRVWAN = { open: false, room: '', state: '', code: '', timer: null, busy: false };
const WAN_VIRTUAL_RE = /EasyTier|ZeroTier|Radmin|Tailscale|Hamachi|OpenVPN|WireGuard/i;

function srvWanHide() {
  SRVWAN.open = false; SRVWAN.room = ''; SRVWAN.state = ''; SRVWAN.code = '';
  if (SRVWAN.timer) { clearInterval(SRVWAN.timer); SRVWAN.timer = null; }
  const box = $('#srvWanBox');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}
function srvWanHead(right) {
  return '<div class="srv-wan-head"><svg class="ic sm"><use href="#i-globe"/></svg><b>外网联机</b>' +
    '<span class="t-dim">陶瓦联机 · 点对点直连，不用公网 IP</span>' + (right || '') + '</div>';
}
function srvWanAddrRows(s) {
  const { lan, ifaces } = srvAddrInfo(s || {});
  if (!lan.length) {
    return '<div class="srv-wan-tips">暂时没检测到可用的局域网地址 —— 房间建立后虚拟网卡地址会出现在这里，稍等几秒会自动刷新。</div>';
  }
  return '<div class="srv-wan-grid">' + lan.map((a, i) => {
    const v = WAN_VIRTUAL_RE.test(ifaces[i] || '');
    return '<div class="srv-wan-row"><span class="srv-addr-role">' +
      esc(v ? '虚拟局域网（外网联机用）' : (ifaces[i] || '局域网')) + '</span>' +
      '<code class="srv-addr-val">' + esc(a) + '</code>' +
      '<button class="btn ghost sm" data-addr="' + esc(a) + '">复制</button></div>';
  }).join('') + '</div>';
}
function srvWanRender(st) {
  const box = $('#srvWanBox');
  if (!box) return;
  if (st) {
    SRVWAN.state = st.state || SRVWAN.state;
    if (st.type !== undefined && st.type !== null) SRVWAN.code = String(st.type);
    if (st.room) SRVWAN.room = st.room;
  }
  const s = SRV.list.find(x => x.name === SRV.sel) || {};
  const bad = /exception/.test(SRVWAN.state);
  const ok = SRVWAN.state === 'host-ok';
  const badge = ok ? '<span class="srv-wan-badge ok">房间已就绪</span>'
    : bad ? '<span class="srv-wan-badge" style="color:#f87171;background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.4)">联机异常</span>'
    : '<span class="srv-wan-badge">建立中…</span>';
  let html = srvWanHead(badge);
  if (ok) {
    html += '<div class="srv-wan-code"><span class="srv-wan-big" id="srvWanCode" title="点击复制">' + esc(SRVWAN.room || '—') + '</span>' +
      '<button class="btn ghost sm" id="btnSrvWanCopyCode">复制房间码</button>' +
      '<button class="btn ghost sm" id="btnSrvWanStop">中断联机</button></div>' +
      '<div class="srv-wan-tips">把<b>房间码</b>发给朋友 → 他在「联机」页加入房间 → 再用下面的地址直连你的服务器：</div>' +
      srvWanAddrRows(s) +
      '<div class="srv-wan-tips">朋友那边看到「已加入房间 ✓」后，游戏里走<b>多人游戏 → 直接连接</b>粘贴上面的地址即可。' +
      (s && s.running ? '' : '<span class="srv-wan-warn">注意：服务器还没启动，请先点上方的「启动」，否则连进来是空的。</span>') +
      (s && s.onlineMode === false ? '<span class="srv-wan-warn">当前是离线模式，公开房间码等于公开入口，建议先执行 whitelist on 开白名单。</span>' : '') +
      '</div>';
  } else if (bad) {
    html += '<div class="srv-wan-tips">联机出现异常（错误码 ' + esc(SRVWAN.code || '未知') + '）。可能是网络无法点对点打洞，或联机组件未登录。' +
      '<span class="srv-wan-warn">可到「联机」页确认组件状态后重试。</span></div>' +
      '<div class="srv-wan-code"><button class="btn ghost sm" id="btnSrvWanRetry">重新创建房间</button>' +
      '<button class="btn ghost sm" id="btnSrvWanStop">关闭</button></div>';
  } else {
    html += '<div class="srv-wan-tips">正在与联机网络建立房间通道…（首次使用会先下载约 8 MB 的联机组件，可能要几十秒）' +
      (s && s.running ? '' : '<span class="srv-wan-warn">服务器尚未启动：朋友加入房间前请先点「启动」。</span>') + '</div>';
  }
  box.style.display = '';
  box.innerHTML = html;
  box.querySelectorAll('[data-addr]').forEach(b => b.addEventListener('click', () => copySrvAddr(b.dataset.addr)));
  const code = $('#srvWanCode');
  if (code) code.addEventListener('click', () => copySrvAddr(SRVWAN.room));
  const cc = $('#btnSrvWanCopyCode');
  if (cc) cc.addEventListener('click', () => copySrvAddr(SRVWAN.room));
  const cs = $('#btnSrvWanStop');
  if (cs) cs.addEventListener('click', srvWanStop);
  const rt = $('#btnSrvWanRetry');
  if (rt) rt.addEventListener('click', srvWanStart);
}
async function srvWanPoll() {
  try {
    const r = await window.lmc.mpState();
    if (!r || !r.ok) return;
    const prev = SRVWAN.state;
    srvWanRender(r.state);
    /* 房间刚就绪：刷新服务器列表，把新出现的虚拟网卡地址（EasyTier）带进地址面板 */
    if (SRVWAN.state === 'host-ok' && prev !== 'host-ok') {
      await loadServerList();
      renderServerList();
      const s = SRV.list.find(x => x.name === SRV.sel);
      if (s) renderServerAddr(s);
      srvWanRender(r.state);
    }
  } catch (_) {}
}
async function srvWanStart() {
  if (SRVWAN.busy) return;
  if (!SRV.sel) { toast('请先选择一个服务器', 'warn'); return; }
  const s0 = SRV.list.find(x => x.name === SRV.sel);
  if (s0 && !s0.running) toast('提示：服务器还没启动，朋友连进来之前记得先点「启动」', 'warn');
  SRVWAN.busy = true;
  const box = $('#srvWanBox');
  if (box) { box.style.display = ''; box.innerHTML = srvWanHead('<span class="srv-wan-badge">准备中…</span>'); }
  try {
    const st = await window.lmc.mpStatus();
    if (!st || !st.ok) throw new Error((st && st.error) || '联机服务状态获取失败');
    if (!st.installed) {
      if (box) box.innerHTML = srvWanHead('<span class="srv-wan-badge">下载组件…</span>') +
        '<div class="srv-wan-tips">首次使用需要下载联机组件（约 8 MB，走国内镜像加速）…</div>';
      const off = window.lmc.on('mp:progress', p => {
        const t = box && box.querySelector('.srv-wan-tips');
        if (t) t.textContent = p.stage === 'extract' ? '下载完成，解压安装中…' : '下载联机组件 ' + p.percent + '%';
      });
      const d = await window.lmc.mpDownload();
      try { if (typeof off === 'function') off(); } catch (_) {}
      if (!d || !d.ok) throw new Error('联机组件下载失败：' + ((d && d.error) || '未知错误'));
    }
    if (!st.running) {
      const r = await window.lmc.mpStart();
      if (!r || !r.ok) throw new Error((r && r.error) || '联机服务启动失败');
    }
    const act = await window.lmc.mpAct({
      action: 'scanning',
      player: (S.config && S.config.username) || 'Steve'
    });
    if (!act || !act.ok) throw new Error('创建房间失败（HTTP ' + ((act && act.status) || '?') + '）');
    SRVWAN.open = true;
    SRVWAN.state = ''; SRVWAN.room = ''; SRVWAN.code = '';
    srvWanPoll();
    if (!SRVWAN.timer) SRVWAN.timer = setInterval(srvWanPoll, 1500);
    toast('外网联机房间创建中 —— 就绪后会显示房间码');
  } catch (e) {
    SRVWAN.open = false;
    if (box) {
      box.innerHTML = srvWanHead('<span class="srv-wan-badge" style="color:#f87171;background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.4)">未启动</span>') +
        '<div class="srv-wan-tips">' + esc(e.message) +
        '<span class="srv-wan-warn">也可以手动走另一条路：装 ZeroTier / Radmin VPN，和朋友加入同一网络后，用上面的「连接地址」面板里的地址直连。</span></div>' +
        '<div class="srv-wan-code"><button class="btn ghost sm" id="btnSrvWanRetry">重试</button>' +
        '<button class="btn ghost sm" id="btnSrvWanStop">关闭</button></div>';
      const rt = box.querySelector('#btnSrvWanRetry');
      if (rt) rt.addEventListener('click', srvWanStart);
      const cs = box.querySelector('#btnSrvWanStop');
      if (cs) cs.addEventListener('click', srvWanHide);
    }
    toast('外网联机未启动：' + e.message, 'error');
  } finally { SRVWAN.busy = false; }
}
async function srvWanStop() {
  if (SRVWAN.timer) { clearInterval(SRVWAN.timer); SRVWAN.timer = null; }
  try { await window.lmc.mpAct({ action: 'ide' }); } catch (_) {}
  srvWanHide();
  toast('已中断外网联机');
}
function showServerConsole(name) {
  const s = SRV.list.find(x => x.name === name);
  $('#srvConsole').style.display = '';
  $('#srvConName').textContent = name;
  $('#srvConMeta').textContent = s
    ? coreName(s.core) + ' ' + s.ver + ' · localhost:' + (s.port || 25565) + ' · ' + (s.onlineMode ? '正版验证' : '离线模式')
    : '';
  $('#srvDot').classList.toggle('on', !!(s && s.running));
  renderServerAddr(s);
  /* 切换服务器时同步刷新外网联机面板（房间是机器级的，地址列表跟着当前服务器） */
  if (SRVWAN.open) srvWanRender();
  const box = $('#srvLog');
  box.innerHTML = '';
  const logs = SRV.logs[name] || [];
  if (!logs.length) {
    box.innerHTML = '<div class="t-dim">' + (s && s.running ? '等待服务器输出…' : '服务器未运行，点击上方「启动」开始') + '</div>';
  } else logs.forEach(srvLogLine);
}
function srvLogLine(entry) {
  const box = $('#srvLog');
  if (!box) return;
  if (box.children.length === 1 && box.firstChild.classList.contains('t-dim')) box.innerHTML = '';
  let cls = '';
  if (/ERROR|Exception|错误|失败|Caused by|FAILED/i.test(entry.line)) cls = 't-err';
  else if (/WARN|警告|WARNING/i.test(entry.line)) cls = 't-warn';
  if (entry.self) cls = (cls + ' t-dim').trim();
  box.appendChild(el('div', cls, esc(entry.line)));
  while (box.children.length > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function setSrvProgress(pct, text) {
  const bar = $('#srvProgBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  const tx = $('#srvProgTx');
  if (tx) tx.textContent = text || '';
}
async function startServer(name) {
  const s = SRV.list.find(x => x.name === name);
  if (s && s.running) { toast('服务器已在运行中', 'warn'); return; }
  SRV.sel = name;
  renderServerList();
  showServerConsole(name);
  toast('正在启动服务器「' + name + '」…');
  try {
    const r = await window.lmc.serverStart({ name });
    if (s) { s.running = true; if (r && r.addr) s.addr = r.addr; }
    renderServerList();
    showServerConsole(name);
    const { local, lan } = srvAddrInfo(s);
    toast('服务器已启动 · 进服地址 ' + local + (lan.length ? '（好友 ' + lan[0] + '）' : '') +
      '，看到日志出现 Done 即可连入');
  } catch (e) {
    toast('启动失败：' + e.message, 'error');
  }
}
async function stopServer(name) {
  try {
    const r = await window.lmc.serverStop({ name });
    if (r && !r.ok) toast(r.error, 'warn');
    else toast('已发送停止指令，服务器保存世界后退出', 'ok');
  } catch (e) { toast('停止失败：' + e.message, 'error'); }
}
async function deleteServer(name) {
  if (!(await askConfirm('确定删除服务器「' + name + '」？', { danger: true, detail: '整个服务器目录（含世界存档、插件）会被移入回收站，可从回收站还原。' }))) return;
  try {
    await window.lmc.serverDelete({ name });
    toast('服务器「' + name + '」已移入回收站');
    if (SRV.sel === name) { SRV.sel = ''; $('#srvConsole').style.display = 'none'; }
    await loadServerList();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}
function bindServerEvents() {
  if (SRV.bound) return;
  SRV.bound = true;
  $('#srvList').addEventListener('click', async (e) => {
    const card = e.target.closest('.srv-card');
    if (!card) return;
    const name = card.dataset.srv;
    /* 点地址行 = 复制地址（不进「选中服务器」逻辑） */
    const addrEl = e.target.closest('[data-addr]');
    if (addrEl) { e.stopPropagation(); copySrvAddr(addrEl.dataset.addr); return; }
    const actEl = e.target.closest('[data-a]');
    if (!actEl) { SRV.sel = name; renderServerList(); showServerConsole(name); return; }
    e.stopPropagation();
    const act = actEl.dataset.a;
    if (act === 'start') startServer(name);
    else if (act === 'stop') stopServer(name);
    else if (act === 'sync') syncServerMods(name);
    else if (act === 'dir') { try { await window.lmc.serverOpenDir({ name }); } catch (err) { toast(err.message, 'error'); } }
    else if (act === 'del') deleteServer(name);
  });
  $('#btnSrvCreate').addEventListener('click', async () => {
    if (SRV.creating) return;
    const name = $('#srvName').value.trim();
    const ver = $('#srvVersion').value;
    if (!name) { toast('请填写服务器名称', 'warn'); $('#srvName').focus(); return; }
    if (!ver) { toast('请选择游戏版本（若列表为空请稍候或切换核心）', 'warn'); return; }
    if (SRV.list.some(x => x.name === name)) { toast('已存在同名服务器，请换个名称', 'warn'); return; }
    SRV.creating = true;
    const btn = $('#btnSrvCreate');
    btn.disabled = true;
    $('#srvProgWrap').style.display = '';
    setSrvProgress(0, '准备中…');
    try {
      const r = await window.lmc.serverCreate({
        name, ver, core: SRV.core,
        memMB: parseInt($('#srvMem').value, 10) || 2048,
        port: parseInt($('#srvPort').value, 10) || 25565,
        maxPlayers: parseInt($('#srvMax').value, 10) || 20,
        motd: $('#srvMotd').value.trim(),
        difficulty: $('#srvDiff').value,
        gamemode: $('#srvMode').value,
        seed: $('#srvSeed').value.trim(),
        onlineMode: $('#srvOnline').checked
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '创建失败');
      setSrvProgress(100, '创建完成');
      $('#srvName').value = '';
      $('#srvMotd').value = '';
      await loadServerList();
      SRV.sel = name;
      const ns = SRV.list.find(x => x.name === name);
      if (ns && r.addr) ns.addr = r.addr;
      renderServerList();
      showServerConsole(name);
      /* 创建完成后的第一件事：把「玩家怎么进来」的地址直接摆出来（不用再去翻配置） */
      const ai = srvAddrInfo(ns || { port: (r.meta && r.meta.port) || 25565 });
      toast('「' + name + '」创建完成 · 进服地址 ' + ai.local +
        (ai.lan.length ? '，好友用 ' + ai.lan[0] : ''), 'ok');
      const ab = $('#srvAddrBox');
      if (ab && ab.scrollIntoView) { try { ab.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {} }
    } catch (e) {
      setSrvProgress(0, '失败：' + e.message);
      toast('创建失败：' + e.message, 'error');
    } finally {
      SRV.creating = false;
      btn.disabled = false;
      setTimeout(() => { $('#srvProgWrap').style.display = 'none'; }, 3500);
    }
  });
  $('#btnSrvStart').addEventListener('click', () => SRV.sel && startServer(SRV.sel));
  $('#btnSrvStop').addEventListener('click', () => SRV.sel && stopServer(SRV.sel));
  $('#btnSrvWan').addEventListener('click', () => {
    if (SRVWAN.open) { srvWanRender(); $('#srvWanBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    srvWanStart();
  });
  $('#btnSrvDir').addEventListener('click', async () => {
    if (!SRV.sel) return;
    try { await window.lmc.serverOpenDir({ name: SRV.sel }); } catch (e) { toast(e.message, 'error'); }
  });
  const sendCmd = async () => {
    const v = $('#srvCmd').value.trim();
    if (!v) return;
    if (!SRV.sel) { toast('请先选择一个服务器', 'warn'); return; }
    $('#srvCmd').value = '';
    try {
      const r = await window.lmc.serverCmd({ name: SRV.sel, cmd: v });
      if (r && !r.ok) toast(r.error, 'warn');
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#btnSrvCmd').addEventListener('click', sendCmd);
  $('#srvCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCmd(); });
}
$('#btnSrvJavas').addEventListener('click', async () => {
  try {
    const r = await window.lmc.serverJavas();
    if (!r || !r.ok) { toast('检测失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    if (!r.javas.length) { toast('本机未检测到 Java，请到「设置 → Java 下载」安装后重试', 'warn'); return; }
    toast('已检测到 ' + r.javas.length + ' 个 Java：' + r.javas.map(j => 'Java ' + j.major).join(' / '));
  } catch (e) { toast('检测失败：' + e.message, 'error'); }
});
/* 主进程推送：服务器日志 / 状态 / 创建进度 */
window.lmc.on('server:log', (d) => {
  if (!d || !d.name) return;
  const arr = SRV.logs[d.name] = SRV.logs[d.name] || [];
  arr.push({ line: d.line, self: d.self });
  while (arr.length > 800) arr.shift();
  if (PLG.pane === 'server' && SRV.sel === d.name) srvLogLine({ line: d.line, self: d.self });
  srvWatchModKick(d);
  /* 服务端加载完成（日志出现 "Done (x.xxxs)!"）→ 这时端口才真正在监听，提示「可以进服了」并亮一次地址 */
  if (!d.self && /Done \([\d.]+s\)!/.test(d.line) && !SRV.ready[d.name]) {
    SRV.ready[d.name] = true;
    const s = SRV.list.find(x => x.name === d.name);
    if (s) s.running = true;
    const ai = srvAddrInfo(s || {});
    toast('「' + d.name + '」已就绪，可以进服了 · 地址 ' + ai.local +
      (ai.lan.length ? '（好友 ' + ai.lan[0] + '）' : ''), 'ok');
    if (PLG.pane === 'server' && SRV.sel === d.name) { renderServerList(); renderServerAddr(s); }
  }
});
window.lmc.on('server:state', (d) => {
  if (!d || !d.name) return;
  const s = SRV.list.find(x => x.name === d.name);
  if (s) s.running = !!d.running;
  if (!d.running) delete SRV.ready[d.name];
  if (PLG.pane === 'server') {
    renderServerList();
    if (SRV.sel === d.name) {
      $('#srvDot').classList.toggle('on', !!d.running);
      renderServerAddr(s);
    }
  }
  if (d.error) toast('服务器「' + d.name + '」启动失败：' + d.error, 'error');
});
window.lmc.on('server:progress', (d) => {
  if (!d || PLG.pane !== 'server') return;
  setSrvProgress(d.pct, d.text);
});

/* ---------------- 版本更新（设置页） ----------------
 * 检测开发者发布的下载页 → 对比本机版本 → 发现新版可直接在启动器内下载、
 * 运行安装包，或（便携版）一键覆盖重启，全程不需要开发者模式。 */
const UPD = { info: null, dl: null, busy: false, autoTried: false, hist: [] };

function fmtSize(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}
function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return '—'; }
}
function setUpdState(kind, text) {
  const st = $('#updState');
  if (st) st.className = 'upd-state' + (kind ? ' ' + kind : '');
  if (text && $('#updStateTx')) $('#updStateTx').textContent = text;
}
function updKindOf(name) {
  return /portable/i.test(name) ? '便携版' : /setup|install/i.test(name) ? '安装版' : '更新包';
}
/* 主页顶部的测试版提示：只有当前运行的是快照 / 预发布 / 候选（rc）版时才出现 ——
   正式版用户不该看到「测试版可能有严重 BUG」这句话（那是给尝鲜用户的提醒）。
   判定 pre 由主进程按同一套版本阶段规则给出（configPublic 的 appVersionPre）。
   1.2-rc3 起文案从「快照版」改为「测试版」—— rc 阶段 isPreVer 也为 true，
   再写「快照版」对候选版用户是错位文案。 */
function applySnapTip(pre) {
  const tip = $('#snapTip');
  if (tip) tip.style.display = pre ? '' : 'none';
}
/* 提示条里的「Issue」：点一下用系统浏览器打开仓库的 GitHub Issues（反馈入口）。
   链接单独提出来，以后换仓库地址只改这一行。 */
const GITHUB_ISSUES_URL = 'https://github.com/byzgdneo2/XLC-Launcher/issues';
(function bindSnapTipLink() {
  const a = $('#snapTipRepo');
  if (!a) return;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.lmc.openUrl(GITHUB_ISSUES_URL);
    toast('正在打开 GitHub Issues');
  });
})();
/* 渲染检测结果（info=null 表示清空） */
function renderUpdateResult(info) {
  const box = $('#updResult');
  if (!box) return;
  if (!info) { box.innerHTML = ''; setUpdState('', '尚未检测'); return; }
  if (info.ok === false) {
    setUpdState('err', '检测失败');
    box.innerHTML = '<div class="upd-box"><b>检测更新失败</b><p>' + esc(info.error || '未知错误') +
      '</p><p>可以点「打开下载页」手动查看最新版本。更新源为 GitHub Releases（优先）与官方下载页（备用），' +
      (info.locked
        ? '本次请求用的是非官方地址，已被启动器拒绝。'
        : '两条通道都暂时连不上，可能是网络不通，稍后再试。') +
      '</p></div>';
    return;
  }
  /* 更新源上是快照 / 预发布，而设置里开着「跳过快照版更新」→ 说清是「被跳过」而不是「已是最新」 */
  if (info.skippedPre) {
    setUpdState('ok', '已跳过快照版 ' + info.latest);
    box.innerHTML = '<div class="upd-box"><b>更新源上的 ' + esc(info.latest) + ' 是快照 / 预发布版，已按设置跳过</b>' +
      '<p>你在「设置 → 版本更新」里开启了<b>跳过快照版更新</b>，所以这一版不再提示。想尝鲜的话关掉那个开关，再点「检测更新」即可。</p>' +
      '<p>检测时间：' + fmtTime(info.checkedAt) + (info.via ? ' · 更新来源：' + esc(info.via) : '') + '</p></div>';
    return;
  }
  if (!info.hasUpdate) {
    setUpdState('ok', '已是最新版本');
    box.innerHTML = '<div class="upd-box"><b>已是最新版本 · ' + esc(info.current) + '</b><p>' +
      (info.newerThanRemote
        ? '当前版本比更新源上的版本还要新（本地开发版？）。'
        : '更新源上的最新版本是 ' + esc(info.latest) + (info.preRelease ? '（快照 / 预发布版）' : '') + '，与当前版本一致。') +
      '</p><p>检测时间：' + fmtTime(info.checkedAt) + (info.via ? ' · 更新来源：' + esc(info.via) : '') + '</p></div>';
    return;
  }
  setUpdState('new', '发现新版本 ' + info.latest);
  const dls = Array.isArray(info.downloads) ? info.downloads : [];
  let html = '<div class="upd-box new"><b>发现新版本 ' + esc(info.latest) + '（当前 ' + esc(info.current) + '）</b>' +
    '<p>可以直接在启动器内下载新版本，也可以让浏览器下载；装好后启动器就是新版了。' +
    (info.via ? '更新来源：' + esc(info.via) + '。' : '') + '</p>';
  if (info.notes) html += '<div class="upd-notes">' + esc(info.notes) + '</div>';
  if (dls.length) {
    html += dls.map((d, i) => {
      const ic = /portable/i.test(d.name) ? '🚀' : /setup|install/i.test(d.name) ? '⚙️' : '📦';
      const sub = [updKindOf(d.name), d.size].filter(Boolean).join(' · ');
      return '<div class="upd-dl">' +
        '<span class="upd-dl-ic">' + ic + '</span>' +
        '<span class="upd-dl-meta"><b>' + esc(d.name) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span>' +
        '<span class="upd-dl-acts">' +
        '<button class="btn ghost" data-upd-browser="' + i + '"><svg class="ic sm"><use href="#i-external"/></svg> 浏览器下载</button>' +
        '<button class="btn primary" data-upd-dl="' + i + '"><svg class="ic sm"><use href="#i-download"/></svg> 启动器内下载</button>' +
        '</span></div>';
    }).join('');
  } else {
    html += '<p>更新源没有给出可识别的下载直链，请点「打开下载页」手动下载。</p>';
  }
  html += '<div class="btn-row" style="margin-top:12px"><button class="btn ghost" id="btnUpdIgnore">' +
    '<svg class="ic sm"><use href="#i-x"/></svg> 跳过此版本</button></div><div id="updDlBox"></div></div>';
  box.innerHTML = html;
  $$('#updResult [data-upd-browser]').forEach(b => b.addEventListener('click', () => {
    const d = dls[parseInt(b.dataset.updBrowser, 10)];
    if (d) window.lmc.openUrl(d.url).catch(() => toast('无法打开链接', 'error'));
  }));
  $$('#updResult [data-upd-dl]').forEach(b => b.addEventListener('click', () => {
    const d = dls[parseInt(b.dataset.updDl, 10)];
    if (d) startUpdateDownload(d);
  }));
  const ig = $('#btnUpdIgnore');
  if (ig) ig.addEventListener('click', async () => {
    const r = await window.lmc.updateIgnore({ version: info.latest });
    if (r && r.config) S.config = r.config;
    UPD.info = null;
    setUpdState('', '已跳过 ' + info.latest);
    $('#updDlBox').innerHTML = '';
    toast('已跳过版本 ' + info.latest + '，之后不再提示');
  });
}
/* 版本回退：把更新源上比当前更旧的版本列出来，一键下载旧版 exe → 替换当前程序即完成回退。
   数据来自主进程解析的 info.history（按版本归组、倒序、带 relation 标记），
   这里只渲染 relation==='older' 的那些 —— 比当前新的走上面的「更新」流程。
   下载的是**免安装的便携版 exe**（主进程已把便携版排在各版本文件列表首位）：
   下载完点「替换并重启」覆盖当前程序文件即可，不需要跑安装向导。
   当前跑的是快照版时，额外给一张「回到正式版」的提示卡（最新正式版一键回退）。
   （那张卡 1.1 正式版期间曾移除，1.2-snapshot1 起恢复 —— 只有快照 / 预发布版才会看到。） */
function renderUpdateHistory(info) {
  const box = $('#updHistory');
  if (!box) return;
  const hist = (info && info.ok && Array.isArray(info.history)) ? info.history : [];
  const older = hist.filter(h => h && h.relation === 'older' && Array.isArray(h.downloads) && h.downloads.length);
  UPD.hist = older;
  if (!older.length) { box.innerHTML = ''; return; }
  const cur = (info && info.current) || (S.config && S.config.appVersion) || '';
  const curPre = !!(S.config && S.config.appVersionPre);
  const latestRel = older.find(h => !h.pre) || null;   /* 列表已倒序，第一个正式版就是最新正式版 */
  /* 只给一个下载项：优先便携版 exe（免安装），该版本只有安装包时才退回安装版 */
  const pickDl = (h) => {
    const arr = h.downloads || [];
    let k = arr.findIndex(d => /portable/i.test(d.name));
    if (k < 0) k = 0;
    return { d: arr[k], k };
  };
  const rowBtns = (h, label) => {
    const { d, k } = pickDl(h);
    if (!d) return '';
    return '<span class="acts"><button class="btn ghost" data-hv="' + esc(h.version) + '" data-hk="' + k + '">' +
      '<svg class="ic sm"><use href="#i-download"/></svg> ' + esc(label) + ' ' + esc(h.version) +
      '（' + esc(updKindOf(d.name)) + '）</button></span>';
  };
  let html = '<div class="upd-hist">' +
    '<div class="upd-hist-head"><b><svg class="ic sm" style="vertical-align:-2px"><use href="#i-refresh"/></svg> 版本回退</b>' +
    '<span class="cnt">可回退到以下 ' + older.length + ' 个历史版本</span></div>' +
    '<p>回退拿到的是<b>免安装的便携版 exe</b>：下载完点「替换并重启」，启动器就用这个 exe 覆盖当前的程序文件再打开，回到那一版 —— <b>不需要跑安装向导</b>，游戏目录、存档、设置与账户都不会动。' +
    '当前版本：<b>' + esc(cur) + '</b>。</p>';
  /* 跑的是快照版时：单独给一张「回到稳定版」的卡（最新正式版一键回退）。
     判定用主进程下发的 appVersionPre，而不是正在跑的那一版在历史里的位置 ——
     更新源上还没有更新的正式版时（latestRel 为空）不出现。 */
  if (curPre && latestRel) {
    html += '<div class="upd-fallback"><b>当前是快照版，想回到稳定版？</b>' +
      '<p>最新正式版是 <b>' + esc(latestRel.version) + '</b>。回退过去就能退出快照版；' +
      '再打开上面的「跳过快照版更新」，之后只会收到正式版更新。</p>' +
      '<div class="btn-row" style="margin-top:9px">' + rowBtns(latestRel, '回到') + '</div></div>';
  }
  html += older.map(h => '<div class="upd-hist-row">' +
    '<span class="v">' + esc(h.version) + '</span>' +
    (h.pre ? '<span class="tag pre">快照 / 预发布</span>' : '<span class="tag rel">正式版</span>') +
    '<span class="sp"></span>' + rowBtns(h, '回退') + '</div>').join('');
  html += '<div id="updHistDl"></div></div>';
  box.innerHTML = html;
  $$('#updHistory [data-hv]').forEach(b => b.addEventListener('click', () => {
    const h = UPD.hist.find(x => x.version === b.dataset.hv);
    const d = h && h.downloads[parseInt(b.dataset.hk, 10)];
    if (!d) { toast('这个版本没有可下载的文件', 'warn'); return; }
    if (h.relation === 'same') { toast('这就是你现在用的版本', 'warn'); return; }
    startUpdateDownload(d, '#updHistDl', { mode: 'revert', version: h.version });
    toast('开始下载 ' + h.version + ' 的便携版 exe，下载完点「替换并重启」即可回退');
  }));
}
/* 已下载完成：展示路径与后续操作。
   host：把进度/结果画到哪个容器 —— 更新流程用 #updDlBox，回退流程用 #updHistDl
   opts.mode==='revert' 时是回退：拿到的是免安装便携版 exe，操作是「替换并重启」
   （覆盖当前程序文件再打开），不给「运行安装包」—— 回退不需要安装 */
function renderUpdateDownloaded(r, host, opts) {
  const box = host || $('#updDlBox') || $('#updHistDl');
  if (!box) return;
  const o = opts || {};
  const ver = o.version || '';
  const head = '<div class="upd-bar"><i style="width:100%"></i></div>' +
    '<span class="upd-bar-tx">已下载：' + esc(r.path) + (r.size ? '（' + fmtSize(r.size) + '）' : '') + '</span>';
  if (o.mode === 'revert') {
    box.innerHTML = head +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn primary" id="btnUpdSwap"><svg class="ic sm"><use href="#i-refresh"/></svg> 替换并重启' +
      (ver ? '（回到 ' + esc(ver) + '）' : '') + '</button>' +
      '<button class="btn ghost" id="btnUpdReveal"><svg class="ic sm"><use href="#i-folder"/></svg> 打开所在文件夹</button>' +
      '</div><p class="upd-bar-tx">点「替换并重启」会关闭启动器、用这个 exe 覆盖当前的程序文件，然后自动打开旧版本。' +
      '<b>不需要安装向导</b>，游戏目录、存档、设置与账户都不会动。</p>';
    $('#btnUpdReveal').addEventListener('click', () => window.lmc.updateReveal({ path: r.path }));
    $('#btnUpdSwap').addEventListener('click', async () => {
      const rr = await window.lmc.updateSelfReplace({ path: r.path, sha256: r.sha256 || '' });
      if (!rr.ok) { toast('自动替换失败：' + rr.error, 'error'); return; }
      setUpdState('busy', '正在重启并回退…');
      toast('即将关闭启动器替换为 ' + (ver || '旧版本') + '，请稍候…');
      setTimeout(() => window.lmc.updateQuit(), 1500);
    });
    return;
  }
  const portable = !!(S.config && S.config.portableMode);
  box.innerHTML = head +
    '<div class="btn-row" style="margin-top:10px">' +
    '<button class="btn primary" id="btnUpdRun"><svg class="ic sm"><use href="#i-play"/></svg> 运行安装包</button>' +
    '<button class="btn ghost" id="btnUpdReveal"><svg class="ic sm"><use href="#i-folder"/></svg> 打开所在文件夹</button>' +
    (portable ? '<button class="btn ghost" id="btnUpdSelf"><svg class="ic sm"><use href="#i-refresh"/></svg> 一键更新并重启</button>' : '') +
    '</div><p class="upd-bar-tx">' + (portable
      ? '「一键更新并重启」会关闭启动器、用新版本覆盖当前的便携版文件，然后自动重新打开。'
      : '运行安装包即可更新到新版本（安装向导会保留你的游戏目录与设置）。') + '</p>';
  $('#btnUpdRun').addEventListener('click', async () => {
    const rr = await window.lmc.updateRun({ path: r.path });
    if (!rr.ok) toast('无法运行安装包：' + rr.error, 'error');
    else toast('已启动安装程序，按提示完成更新即可');
  });
  $('#btnUpdReveal').addEventListener('click', () => window.lmc.updateReveal({ path: r.path }));
  const sb = $('#btnUpdSelf');
  if (sb) sb.addEventListener('click', async () => {
    const rr = await window.lmc.updateSelfReplace({ path: r.path, sha256: r.sha256 || '' });
    if (!rr.ok) { toast('自动更新失败：' + rr.error, 'error'); return; }
    setUpdState('busy', '正在重启并更新…');
    toast('即将关闭启动器替换为新版本，请稍候…');
    setTimeout(() => window.lmc.updateQuit(), 1500);
  });
}
/* 启动器内下载更新包（复用主进程多线程下载 + 进度推送）
   hostSel：进度画到哪个容器（回退流程传 '#updHistDl'），默认更新流程的 #updDlBox
   opts：回退流程传 { mode:'revert', version } —— 下载完成后给的是「替换并重启」 */
async function startUpdateDownload(d, hostSel, opts) {
  if (UPD.busy) { toast('已有一个更新下载任务在进行中', 'warn'); return; }
  if (!d || !d.url) { toast('下载地址缺失', 'error'); return; }
  const revert = !!(opts && opts.mode === 'revert');
  UPD.busy = true;
  const box = $(hostSel || '#updDlBox') || $('#updDlBox') || $('#updHistDl');
  const other = (hostSel === '#updHistDl') ? $('#updDlBox') : $('#updHistDl');
  if (other) other.innerHTML = '';   /* 同一时间只在一个地方显示下载进度 */
  if (box) {
    box.innerHTML = '<div class="upd-bar"><i id="updBarI"></i></div>' +
      '<span class="upd-bar-tx" id="updBarTx">准备下载 ' + esc(d.name) + '…</span>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn ghost" id="btnUpdDlCancel">' +
      '<svg class="ic sm"><use href="#i-x"/></svg> 取消下载</button></div>';
    const cb = $('#btnUpdDlCancel');
    if (cb) cb.addEventListener('click', async () => {
      const r = await window.lmc.updateCancel();
      if (!r.ok) toast(r.error || '无法取消', 'warn');
    });
  }
  let r;
  try { r = await window.lmc.updateDownload({ url: d.url, name: d.name, sha256: d.sha256 || '' }); }
  catch (e) { r = { ok: false, error: e.message || String(e) }; }
  UPD.busy = false;
  if (!r.ok) {
    if (box) box.innerHTML = '<span class="upd-bar-tx">下载未完成：' + esc(r.error || '未知错误') + '</span>';
    toast((revert ? '旧版本下载失败：' : '更新包下载失败：') + (r.error || '未知错误'), 'error');
    return;
  }
  UPD.dl = r;
  renderUpdateDownloaded(r, box, opts);
  toast(revert ? (opts.version ? '已下载 ' + opts.version + ' 的便携版 exe，点「替换并重启」即可回退' : '旧版本已下载完成，点「替换并重启」即可回退') : '更新包已下载完成');
}
/* 一次检测结果的统一出口：结果区 + 版本回退区一起刷（两处都在用同一份 info） */
function applyUpdateInfo(info) {
  UPD.info = info || null;
  renderUpdateResult(info);
  renderUpdateHistory(info);
}
async function checkUpdateNow(silent) {
  if (UPD.busy) { toast('下载进行中，请稍后再检测', 'warn'); return null; }
  setUpdState('busy', '正在检测…');
  const box = $('#updResult');
  if (box && !silent) box.innerHTML = '<div class="empty-sm">正在检测更新…</div>';
  let info;
  try { info = await window.lmc.updateCheck({}); }
  catch (e) { info = { ok: false, error: e.message || String(e) }; }
  applyUpdateInfo(info);
  return info;
}
/* 进入设置页时展示更新状态：有缓存直接用；没有则静默检测一次（每次启动仅一次） */
async function refreshUpdatePane() {
  if (UPD.info) { applyUpdateInfo(UPD.info); return; }
  const cached = await window.lmc.updateCached();
  if (cached) { applyUpdateInfo(cached); return; }
  if (UPD.autoTried || (S.config && S.config.autoCheckUpdate === false)) { setUpdState('', '尚未检测'); return; }
  UPD.autoTried = true;
  await checkUpdateNow(true);
}
/* 更新源推送：启动时自动检测到新版本 */
window.lmc.on('update:available', (info) => {
  if (!info || !info.hasUpdate) return;
  applyUpdateInfo(info);
  toast('发现新版本 ' + info.latest + '，可在「设置 → 版本更新」里更新', 'warn');
});
/* 下载进度推送 */
window.lmc.on('update:progress', (d) => {
  if (!d) return;
  const bar = $('#updBarI'), tx = $('#updBarTx');
  if (d.phase === 'start') {
    if (tx) tx.textContent = '开始下载 ' + d.name + '…';
  } else if (d.phase === 'downloading') {
    const pct = d.pct >= 0 ? d.pct : 0;
    if (bar) bar.style.width = pct + '%';
    /* 速度取全局下载速率（netTick 推的 install:speed），更新包下载同样有真实速度可看 */
    const sp = fmtSpeed(dlTask.bps);
    if (tx) {
      tx.textContent = '正在下载 ' + d.name + ' · ' + (d.pct >= 0 ? d.pct + '%' : '连接中') +
        (d.total ? '（' + fmtSize(d.got) + ' / ' + fmtSize(d.total) + '）' : '') +
        (sp ? ' · ↓ ' + sp : '');
    }
  } else if (d.phase === 'cancelled' && tx) {
    tx.textContent = '已取消下载';
  }
});

/* ---------------- 更新公告（随版本内置） ----------------
 * 公告内容写在主进程的 CHANGELOG 里；这里只负责渲染。
 * 自动弹窗策略：这个版本第一次运行时（config.seenVersion ≠ 当前版本）弹一次。 */
/* 公告文案里的 **粗体** 标记 → <b>。注意顺序：先 esc 再做替换，
   反过来就是把外部文本当 HTML 注入（XSS） */
function clRich(s) {
  return esc(String(s == null ? '' : s)).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
function renderChangelog(data, onOk) {
  const box = $('#modalBox');
  if (!box || !data || !data.ok) return false;
  box.classList.add('cl-wide'); /* 条目较长，公告单独加宽 */
  const entry = data.entry || (data.list && data.list[0]) || null;
  let html = '<div class="cl-head">' +
    '<div class="cl-badge"><svg class="ic"><use href="#i-list"/></svg></div>' +
    '<div class="cl-head-tx"><h3>更新公告</h3><p><span class="cl-ver">' + esc(data.current) + '</span>' +
    (entry && entry.tag ? '<span class="cl-tag">' + esc(entry.tag) + '</span>' : '') +
    (entry && entry.date ? '<span>' + esc(entry.date) + '</span>' : '') +
    '</p></div></div>';
  if (!entry) {
    html += '<p class="hint">这个版本没有内置公告内容。</p>';
  } else {
    if (entry.notice) {
      html += '<div class="cl-notice"><svg class="ic"><use href="#i-warn"/></svg><span>' +
        clRich(entry.notice) + '</span></div>';
    }
    const groups = entry.groups || [];
    if (groups.length) {
      html += '<div class="cl-body">' + groups.map(g =>
        '<div class="cl-group">' +
          '<div class="cl-group-head">' +
            (g.icon ? '<span class="cl-gic"><svg class="ic"><use href="#' + esc(g.icon) + '"/></svg></span>' : '') +
            '<b>' + esc(g.title) + '</b>' +
            (g.tag ? '<span class="cl-gtag">' + esc(g.tag) + '</span>' : '') +
          '</div>' +
          '<ul class="cl-list">' + (g.items || []).map(t => '<li>' + clRich(t) + '</li>').join('') + '</ul>' +
        '</div>').join('') + '</div>';
    } else {
      html += '<div class="cl-body"><ul class="cl-list">' +
        (entry.items || []).map(t => '<li>' + clRich(t) + '</li>').join('') + '</ul></div>';
    }
    const older = (data.list || []).filter(x => x.version !== entry.version);
    if (older.length) {
      html += '<div class="cl-hist"><b>历史版本</b>' + older.map(x =>
        '<div class="cl-row"><b>' + esc(x.version) + '</b><span>' + esc(x.date || '') + '</span></div>'
      ).join('') + '</div>';
    }
  }
  html += '<div class="cl-foot"><button class="btn primary" id="btnClOk">知道了</button></div>';
  box.innerHTML = html;
  openModal(false);   /* 更新公告：点空白不关闭 —— 要真看完点「知道了」（误点空白不该跳过公告） */
  const ok = $('#btnClOk');
  if (ok) ok.addEventListener('click', () => { closeModal(); if (typeof onOk === 'function') onOk(); });
  return true;
}
async function showChangelog() {
  let d;
  try { d = await window.lmc.updateChangelog(); }
  catch (e) { toast('无法读取更新公告：' + (e.message || e), 'error'); return; }
  if (!renderChangelog(d)) toast('更新公告读取失败', 'error');
}
/* ---------------- 首次使用引导链（启动时） ----------------
 * 顺序：① 这个版本第一次运行 → 先弹「更新公告」；
 *       ② 点「知道了」后，如果还没有任何账户 → 再弹「还没有账户」引导窗；
 *       ③ 点「知道了」→ 关窗并跳到「账户」页的创建界面，光标落在名字输入框。
 * 已有账户则完全不打扰（②直接跳过）。本次启动只引导一次。 */
let accGuideShown = false;
async function hasAnyAccount() {
  try { const r = await window.lmc.accountList(); return !!(r && r.ok && (r.accounts || []).length); }
  catch (_) { return true; }   /* 读不到就当有账户处理，宁可少打扰 */
}
/* 「还没有账户」引导窗（替代原来右下角不起眼的 toast） */
function showNoAccountGuide() {
  const box = $('#modalBox');
  if (!box) return false;
  box.classList.remove('cl-wide');
  box.innerHTML =
    '<div class="cl-head">' +
      '<div class="cl-badge"><svg class="ic"><use href="#i-user-plus"/></svg></div>' +
      '<div class="cl-head-tx"><h3>还没有玩家账户</h3>' +
      '<p><span>首次使用需要先创建一个账户</span></p></div>' +
    '</div>' +
    '<div class="cl-notice"><svg class="ic"><use href="#i-warn"/></svg><span>' +
      '创建账户后才能保存你的玩家名与自定义皮肤，进游戏也会用这个名字。' +
      '支持离线账户（随便起个名字即可）、微软正版登录、第三方外置登录三种方式。' +
    '</span></div>' +
    '<div class="cl-foot"><button class="btn primary" id="btnAccGuideOk">知道了</button></div>';
  openModal(false);   /* 无账户引导：点空白不关闭（必须点「知道了」才会跳到创建账户） */
  const ok = $('#btnAccGuideOk');
  if (ok) ok.addEventListener('click', () => {
    closeModal();
    gotoPage('account');                       /* 跳到创建账户界面 */
    const n = $('#accName');                   /* 光标落在名字输入框，可直接开始创建 */
    if (n) { try { n.focus(); } catch (_) {} }
  });
  return true;
}
/* 启动引导：公告（若有）→ 账户引导（若无账户） */
async function bootGuideChain() {
  const nextStep = async () => {
    if (accGuideShown) return;
    if (await hasAnyAccount()) return;         /* 已有账户 → 不提示 */
    accGuideShown = true;
    showNoAccountGuide();
  };
  let d = null;
  try { d = await window.lmc.updateChangelog(); } catch (_) { d = null; }
  if (d && d.ok && d.unseen && renderChangelog(d, nextStep)) {
    try { await window.lmc.updateSeen(); } catch (_) {}
    return;                                    /* 「知道了」→ nextStep */
  }
  await nextStep();
}

/* ---------------- 初始化 ---------------- */
/* 启动遮罩：主窗口已显示但数据还在拉，用进度条 + 文案告诉用户「正在启动」，拉完淡出 */
function bootStep(pct, tip) {
  const bar = document.getElementById('bootBarFill');
  const t = document.getElementById('bootTip');
  if (bar) bar.style.width = Math.max(8, Math.min(100, pct)) + '%';
  if (t && tip) t.textContent = tip;
}
function bootDone() {
  const m = document.getElementById('bootMask');
  if (!m) return;
  bootStep(100, '已就绪');
  setTimeout(() => {
    m.classList.add('hide');
    setTimeout(() => { try { m.remove(); } catch (_) {} }, 400);
  }, 160);
}
(async function init() {
  bootStep(12, '正在读取背景…');
  const bg = await window.lmc.getBg();
  personalBgData = bg && bg.ok ? bg.dataUrl : '';
  setupPersonalize();
  bootStep(28, '正在载入设置…');
  await loadConfigUI();
  loadHeroHead();   /* 主页头像：当前账户的离线皮肤（不阻塞启动） */
  appendLog('Xero Lite Craft Launcher ' + (S.config.appVersion || '') + ' 已就绪', 't-dim');
  bootStep(50, '正在扫描游戏目录…');
  await scanDir();
  bootStep(74, '正在检测 Java 环境…');
  detectJavaUI();
  loadManifest();
  frSignalStart(); // 好友联机信令轮询：随时接收邀请/同意/拒绝/房间码（不局限于好友页）
  /* 插件页面（page.html）：启动时就拉一次插件列表，装了带页面的插件侧栏立刻有入口
     （不等用户先进插件页 —— renderPlugins 只在进插件页时才跑） */
  renderPlugins(true).catch(() => {});
  // MOD / 整合包区在下载页 tab 内懒加载：首次切换到对应 tab 自动拉热门（PCL 式进页有内容）
  moveRailInd(); // 初始定位侧边栏滑动指示条（主页默认 active）
  /* 功能临时下架（FEATURE_OFF）的 active 迁移：默认 active 的 tab 被禁时（HTML 里标的是「全部」），
     程序化点击第一个可用 tab —— 走正常 click 路径，内容区 / 标题 / dlCat / 懒加载一次到位。
     必须放在这里（全部 const 定义就绪）而不是脚本前段：click handler 引用 DL_RES_TABS，提前跑会 TDZ。 */
  {
    const act0 = $('#dlTabs .tab.active');
    if (act0 && act0.classList.contains('tab-off')) {
      const first = $('#dlTabs .tab:not(.tab-off)');
      if (first) first.click();
    } else {
      moveTabInd($('#dlTabs')); // 未迁移时才需要初始定位（click 路径内会自己定位）
    }
  }
  updateDlHead(dlCat);      // 标题与初始分类保持一致（迁移 click 已把 dlCat 切到可用分类）
  bootStep(100, '已就绪');
  /* 界面可交互后再撤遮罩：等两帧让首屏绘制完成，避免露出半成品画面 */
  requestAnimationFrame(() => requestAnimationFrame(() => bootDone()));
  /* 启动引导链：先弹更新公告（本版本首次），「知道了」后无账户再弹账户引导 → 跳创建界面 */
  setTimeout(() => { bootGuideChain(); }, 700);
})();

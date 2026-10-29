'use strict';
/* ============================================================
 * Xero Lite Craft Launcher (XLC) - Electron 主进程
 * 版本清单(官方/BMCLAPI 双源) · 资源下载 · 本地导入 · 游戏启动
 * ============================================================ */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } = require('electron');
// 保险：若 ELECTRON_RUN_AS_NODE 被污染，require('electron') 会返回路径字符串而非 API
if (typeof ipcMain === 'undefined' || !app) {
  console.error('[XLC] 错误：Electron 以纯 Node 模式运行（请清除环境变量 ELECTRON_RUN_AS_NODE 后重试）');
  process.exit(1);
}
/* 社区插件的面板是怎么打开的 —— 三条路都试过，前两条都不行，现在是第③条：
   ① 自定义协议（xlc-plugin://）：能加载图片等**子资源**，但**子框架导航会被 Chromium 静默拦掉**
      —— 请求已到主进程、也回了 200，iframe 却永远收不到 load，控制台连一条报错都没有。
   ② iframe 加载本机 http 服务 / file:// 文档：http 那条同样是「请求 200、导航不提交」（窗口顶层也试过，一样）；
      file:// 那条能加载，但**这里的 file:// 文档彼此同源** —— 面板一句 parent.lmc 就能拿到启动器的全部接口，
      整套权限模型当场作废（实测父页也能直接读面板 DOM）。
   ③ 独立窗口（现在这个）：面板是它自己窗口里的**顶层文档**（file://），与启动器窗口之间没有任何 DOM 关系
      （没有 parent、opener 也是 null），隔离由「窗口 + 进程」本身保证，不靠源的细节；
      它想做事，只能通过挂在窗口上的 plugin-preload.js 那一个接口求启动器代办。
      这条跟启动器里既有的做法一致：微软登录窗口、种子地图窗口都是独立窗口。
   附注：本机环境（软件渲染 + in-process-gpu）里 sandbox:true 的渲染进程**加载任何 URL 都 ERR_FAILED(-2)**
   （data: / file: / loadFile / 无 webPreferences 变体全试过），所以面板窗口与启动器其它窗口一样用
   sandbox:false —— 面板的隔离不靠这个开关，靠「独立窗口 + 独立分区 + 无 nodeIntegration + 只挂桥 + 导航白名单 + CSP」。 */
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn, execFile, spawnSync } = require('child_process');
const zlib = require('zlib');
const os = require('os');
const http = require('http');

const ROOT = __dirname;
/* 「启动器本体所在目录」——打包后所有随身文件（XLC数据 / .minecraft）都落在这里。
 * ⚠️ portable 版（目前唯一的产物）双击后会把程序解压到 %TEMP% 再运行，此时
 * app.getPath('exe') 指的是那个**关掉就被删掉的临时 exe**；真正被双击的 exe 所在目录
 * 由 electron-builder 的 portable 外壳放进 PORTABLE_EXECUTABLE_DIR。
 * 不优先用它的话，用户的配置 / 存档目录会建在临时目录里，重启就没了
 * （用户报的现象：下载下来点开，旁边什么文件都没生成）。 */
function exeBaseDir() {
  if (!app.isPackaged) return ROOT;
  const p = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim();
  return p ? p : path.dirname(app.getPath('exe'));
}
/* 打包后可变数据（配置/日志/缓存）优先放 exe 旁的 XLC数据 目录（随启动器走，方便装在 D 盘）；
 * exe 旁不可写（如 Program Files）则回退 %APPDATA%\XLC Launcher；asar 只读、portable 临时目录不可持久 */
function pickDataDir() {
  if (!app.isPackaged) return ROOT;
  try {
    const cand = path.join(exeBaseDir(), 'XLC数据');
    fs.mkdirSync(cand, { recursive: true });
    fs.accessSync(cand, fs.constants.W_OK);
    return cand;
  } catch (_) {}
  return path.join(app.getPath('appData'), 'XLC Launcher');
}
/* 冒烟 / 自测进程（LMC_SMOKE_*）使用独立的 userData 目录：
   用户本体启动器开着时，二者会抢同一个 Chromium 用户数据目录（缓存 lock），
   测试实例只能报「Unable to create cache / 拒绝访问」并静默退出 —— 看着像测试失败，
   实际是一行都没跑。这里只隔离浏览器侧数据，DATA_DIR（配置 / 服务器 / 存档）照旧。 */
const SMOKE_EARLY = !!(process.argv.includes('--lmc-smoke') || process.env.LMC_SMOKE_UI ||
  process.env.LMC_SMOKE_UI_JS || process.env.LMC_SMOKE_UPDATE || process.env.LMC_SMOKE_VER ||
  process.env.LMC_SMOKE_PLUGIN || process.env.LMC_SMOKE_MS || process.env.LMC_SMOKE_T4 ||
  process.env.LMC_SMOKE_LAUNCH);
if (SMOKE_EARLY) {
  try {
    const smokeUserData = path.join(os.tmpdir(), 'xlc-smoke-' + process.pid);
    fs.mkdirSync(smokeUserData, { recursive: true });
    app.setPath('userData', smokeUserData);
  } catch (_) {}
}
/* 【严重修复 2026-10-04】
   自测进程必须**连 DATA_DIR 一起隔离**。此前 DATA_DIR 在未打包时恒等于 ROOT，
   于是「改 qa/lmc.config.json 来隔离 gameDir」的测试写法全是无效的 ——
   主进程读的是 <ROOT>/lmc.config.json（用户真实配置，gameDir 指向真实 .minecraft），
   结果真装测试会把 QA 实例、mods 文件写进**用户的真实游戏目录**。
   现在 HEADLESS 时 DATA_DIR 也指向 %TEMP%/xlc-smoke-data-<pid>，
   测试再怎么写都不会碰到用户的数据；需要真实 gameDir 的测试改用环境变量显式注入。 */
/* 数据目录覆盖（测试用）：
 *   LMC_DATA_DIR      → 任意进程可用（含 eval main.js 的 Node 测试）强制指定数据目录
 *   LMC_SMOKE_DATA_DIR → 冒烟 / Electron 测试用（等价，优先级更低）
 * 这两条是测试隔离的唯一正道 —— 直接改写根目录的 lmc.config.json 是无效的
 * （配置路径由 DATA_DIR 决定），且会污染用户的真实配置。 */
let DATA_DIR;
if (process.env.LMC_DATA_DIR) {
  try { DATA_DIR = path.resolve(process.env.LMC_DATA_DIR); } catch (_) { DATA_DIR = pickDataDir(); }
} else {
  DATA_DIR = pickDataDir();
}
if (SMOKE_EARLY && process.env.LMC_SMOKE_DATA_DIR && !process.env.LMC_DATA_DIR) {
  try { DATA_DIR = path.resolve(process.env.LMC_SMOKE_DATA_DIR); } catch (_) {}
}
if (SMOKE_EARLY && !process.env.LMC_DATA_DIR && !process.env.LMC_SMOKE_DATA_DIR) {
  try { DATA_DIR = path.join(os.tmpdir(), 'xlc-smoke-data-' + process.pid); } catch (_) {}
}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
/* 自测进程一律「无窗口」运行：
   窗口照常创建（渲染进程 / IPC / 截图都是真的），但绝不 show()。
   否则跑一次测试就在用户桌面上弹一个启动器窗口，测试若被中断（父进程被杀 / 超时）
   窗口会一直留在屏幕上 —— 用户回来看到一排没关的启动器，非常糟糕。 */
const HEADLESS = SMOKE_EARLY;
/* 自测进程的「硬退出」。
   踩过的坑（实测）：在「窗口不显示 + 禁用 GPU」的自测环境里，app.exit() 会卡在 Electron 的
   关闭流程里不再返回 —— 进程和它的 GPU / 渲染子进程就那样一直挂在后台（每个 150~200MB），
   跑几轮测试就能吃掉 1G 内存，运行的终端也永远等不到退出。
   所以自测退出不走 app.exit()：直接 taskkill 收掉整棵进程树（含自己），再兜底 process.exit()。 */
function hardExit(code) {
  try { console.error('[SMOKE] hardExit code=' + code + ' pid=' + process.pid); } catch (_) {}
  try {
    spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
  } catch (_) {}
  try { process.exit(code); } catch (_) {}
}
const CONFIG_PATH = path.join(DATA_DIR, 'lmc.config.json');
/* 旧数据（exe 旁 LMC数据 或 %APPDATA%\LMC Launcher / XLC Launcher）一次性搬到新数据目录
   （仅复制不删除原件）。最后一项是给「1.1 便携版把数据写到 %APPDATA% 回退目录」的用户兜底 —— 
   数据目录修好之后他们会在 exe 旁重新起一份，旧配置顺手带过来，省得重新填一遍。 */
try {
  if (app.isPackaged) {
    const legacies = [
      path.join(exeBaseDir(), 'LMC数据'),
      path.join(app.getPath('appData'), 'LMC Launcher'),
      path.join(app.getPath('appData'), 'XLC Launcher')
    ];
    for (const legacy of legacies) {
      if (DATA_DIR === legacy || !fs.existsSync(path.join(legacy, 'lmc.config.json')) || fs.existsSync(CONFIG_PATH)) continue;
      for (const item of ['lmc.config.json', 'mod-names.json', 'detail-trans.json', 'icon-cache', 'skins', 'personalize', 'terracotta', 'diagnostics', 'logs', 'authlib-injector.jar']) {
        const s = path.join(legacy, item), d = path.join(DATA_DIR, item);
        if (!fs.existsSync(s) || fs.existsSync(d)) continue;
        try { fs.cpSync(s, d, { recursive: true }); } catch (_) {}
      }
      break;
    }
  }
} catch (_) {}
/* 版本号：Alpha1.0 → Alpha1.1 → Beta1.0 → Pre1 → RC1 → **1.0（首个正式版，2026-10-05）**
   → 1.1-snapshot1 → 1.1-snapshot2 → 1.1-pre1 → 1.1-rc1 → **1.1（1.1 正式版：设置页照 PCL 分类、
   离线皮肤改用标准的本地签名 Yggdrasil 服务、版本列表方块图标、修复启动后窗口消失）**
   → **1.2-snapshot2（1.2 第二个快照：可见性默认改「保持显示」+ 老配置迁移、快照版专用 UI 回归、账户设置、存档预览实时检测、插件读写设置 control、极速模式）**
   → 1.2-snapshot3（删加载器「推荐」标记、内置插件「模组翻译器」）→ 1.2-pre1（1.2 预发布：游戏设置「修改」页，PCL 式组件行）→ 1.2-rc1（1.2 候选：下载游戏与整合包暂时下架，只禁不删）→ 1.2-rc2（游戏设置资源包/光影包页 + 下载多线程提速 + Forge/NeoForge 安装映射预热）→ **1.2-rc3（侧边栏「反馈」入口直达 GitHub Issues）**→ 1.2-rc4（游戏诊断 v2：崩溃报告可选可析、规则 25 条、不限日志新旧）→ **1.2（正式版：诊断 v2 / 反馈入口转正 + 更新源 GitHub 优先、官网兜底）**
   → **1.3-snapshot1（1.3 首个快照：内置插件「存档备份」+「模组清单对齐」，插件首次能往宿主页面注入界面）**
   → 1.3-snapshot2（审计 F1~F8：配置原子写 + 坏文件备份、退出时等在跑的自动备份、启动提示按登录方式、启动前命令防注入、开服模组同步判定、删除 MOD 进回收站、反馈页翻页、清单截断提示）
   排序规则见 verParts/compareVer：版本号拆成「目标版本 + 阶段」两段比。
   早期 0 系列的预发布（Beta1.0 / Pre1 / RC1）目标版本算 0，任何正式版都盖过它们 ——
   所以 1.0 会让 RC1/Pre/Beta 用户收到更新；而带目标版本号的预发布（1.1-snapshot1）
   目标版本是 1.1，因此比 1.0 新、但仍被 1.1 正式版盖过。
   阶段权重 VER_STAGE_RANK：alpha/snapshot(1) < beta(2) < pre(3) < rc(4) < 正式版(5)
   —— 所以 1.1-pre1 比 1.1-snapshot2 新，装快照版的用户能收到这次更新。
   ⚠️ 1.0 老客户端只认「正式版形态」（带 snapshot/beta/pre/rc 的一律当 0 系列），
   要覆盖所有用户只能发这种纯版本号形态。 */
const APP_VERSION = '1.3-snapshot2';

/* ---------------- 诊断：启动器崩溃捕获 ---------------- */
/* 同 logLine：自测进程的诊断记录也写到临时目录，不碰用户数据目录里的 boot.json / 崩溃记录 */
const DIAG_DIR = HEADLESS
  ? path.join(os.tmpdir(), 'xlc-smoke-data-' + process.pid, 'diagnostics')
  : path.join(DATA_DIR, 'diagnostics');
const BOOT_MARKER = path.join(DIAG_DIR, 'boot.json');
function captureLauncherCrash(kind, err) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const body = 'type: ' + kind + '\ntime: ' + new Date().toISOString() + '\nversion: ' + APP_VERSION +
      '\n\n' + ((err && err.stack) || String(err)).slice(0, 60000);
    fs.writeFileSync(path.join(DIAG_DIR, 'launcher-' + Date.now() + '.log'), body);
  } catch (_) {}
}
process.on('uncaughtException', (e) => { captureLauncherCrash('uncaughtException', e); });
process.on('unhandledRejection', (r) => { captureLauncherCrash('unhandledRejection', (r && r.reason) || r); });
/* 渲染进程 / GPU 等子进程崩溃此前完全不落日志（“闪一下就退出”查无此案的主因），补上 */
app.on('child-process-gone', (_e, d) => {
  captureLauncherCrash('child-process-gone:' + (d && d.type || '?'),
    new Error('reason=' + (d && d.reason) + ' exitCode=' + (d && d.exitCode) + (d && d.service ? ' service=' + d.service : '')));
});
/* 启动时打点：崩溃文件早于本次启动时间 = 上次会话的崩溃 */
try {
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  fs.writeFileSync(BOOT_MARKER, JSON.stringify({ bootAt: Date.now(), version: APP_VERSION }));
} catch (_) {}

/* 默认游戏目录：exe 旁的 .minecraft（PCL 式随身携带，新电脑自动创建，不占 C 盘）；
 * exe 旁不可写（如 Program Files）则回退官方目录 %APPDATA%\.minecraft */
function pickDefaultGameDir() {
  const base = exeBaseDir();
  try {
    const cand = path.join(base, '.minecraft');
    fs.mkdirSync(cand, { recursive: true });
    fs.accessSync(cand, fs.constants.W_OK);
    return cand;
  } catch (_) {}
  return path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
}

/* ---------------- 配置 ---------------- */
const DEFAULT_CONFIG = {
  source: 'bmclapi',
  customSource: '',
  gameDir: pickDefaultGameDir(),
  javaPath: '',
  mem: 4,
  memAuto: true,          // 智能内存分配（按物理内存推荐值）
  jvmArgs: '',            // 额外 JVM 参数（空格分隔）
  gameArgs: '',           // 附加在游戏后的参数（照 PCL 的「游戏参数」）
  preLaunchCmd: '',       // 启动前执行命令（支持 ${gameDir} / ${version} 占位）
  winTitle: '',           // 全局游戏窗口标题（空 = 用游戏默认）
  winSize: { w: 0, h: 0, max: false },  // 全局窗口大小（0 = 不指定）
  forceIsolate: 'auto',   // 默认版本隔离：auto=按实例判断 | on=强制隔离 | off=共用目录
  procPriority: 'normal', // 游戏进程优先级：normal/abovenormal/high/below
  launcherVisibility: 'keep',  // 启动后启动器可见性：keep=保持 | min=最小化 | hide=隐藏（旧默认是 hide，坑过用户：点启动窗口就没了，见下方迁移）
  gpuPref: false,         // 请求使用高性能显卡（双显卡笔记本优先独显）
  speedLimit: 0,          // 下载限速（KB/s，0 = 不限速）
  dlConcurrency: 32,      // 文件级并发数（依赖库 / 资源文件的批量下载池，4~64）
  forceChinese: true,     // 启动前强制语言为简体中文
  defaultVersion: '',     // 默认启动的实例（游戏设置里显式设置）
  lastVersion: '',        // 主页上次选中的实例（重启后自动恢复选中）
  /* 实例级设置（对齐 PCL「版本设置」）：{ '<实例名>': { title, javaPath, javaMajor } }
     title = 游戏窗口标题；javaPath/javaMajor = 手动指定的 Java（空 = 按版本需求自动挑）。
     改实例名时键会一起迁移；实例删除时清掉。 */
  versionSettings: {},
  username: 'Steve',
  /* 多账户：offline [{name,skin,model}] / ms {uuid,msRefresh,mcToken,expiresAt} / authlib {uuid,serverUrl,accessToken,serverMeta} */
  accounts: [],
  msClientId: '',        /* 微软正版登录的 Azure 应用 ID（公共客户端，XboxLive.signin offline_access 权限） */
  activeAccount: '',
  /* 个性化 */
  bgMode: 'default',      // default=纯色 | panorama=MC全景（需用户主动开启）| image=自定义图片
  bgColor: '',            // 自定义背景颜色（空=默认主题）
  accentColor: '',        // 自定义窗口/主题色（空=默认绿）
  bgImage: '',            // 自定义背景图文件名（存 DATA_DIR/personalize/）
  turboMode: false,       // 极速模式：动画特效压到最低 + 收缩 Mod 搜索缓存（左下角小圆长按 10 秒开关，默认关）
  translatorBing: false,   // 模组翻译器：是否启用备用通道（Bing 网页接口）。默认关，走 MyMemory 官方免费接口
  /* 最近游玩（游戏进程成功拉起后记录，同名去重，最多 5 条） */
  recent: [],
  /* 好友系统：friendCode 为本机专属好友码（每人仅一个，生成后不变）；friends 为好友列表 */
  friendCode: '',
  friends: [],
  /* 诊断 AI（OpenAI 兼容接口） */
  aiApi: { base: '', key: '', model: 'gpt-4o-mini' },
  /* 插件启用状态：{ seedmap:true, server:true }（键缺省 = 启用） */
  plugins: {},
  /* 内置插件「存档备份」的设置。
     auto 默认 **关** —— 自动备份会实实在在占盘，不能替用户默认打开；
     打开后两个时机都备（启动前 / 游戏退出后），dir 为空 = 数据目录下的「存档备份」。
     keep = 每个存档保留几份（0 = 全留）。 */
  backup: { auto: false, onLaunch: true, onExit: true, dir: '', keep: 10 },
  /* 社区插件（拓展插件）实际被授权的权限：{ '<插件id>': ['notify','storage'] }。
     清单里声明了什么是一回事，用户导入时点了哪些才是真正放行的 —— 这里存用户的选择。
     没装过的 id 不在表里 = 一项都没授权。 */
  pluginPerms: {},
  /* 手柄控制插件设置：enabled=手柄导航总开关；deadzone=摇杆死区；
     speed=方向重复速率档（slow/normal/fast）；vibrate=震动反馈；osd=按键提示浮层；
     cursor=光标模式（左摇杆当鼠标）；cursorSpeed=光标速度；hideMouse=手柄操作时隐藏系统鼠标指针 */
  gamepad: { enabled: true, deadzone: 0.28, speed: 'normal', vibrate: true, osd: true, cursor: true, cursorSpeed: 1, hideMouse: true },
  /* 启动器自更新：更新源锁定为官方下载页（见 updateSourceUrl）；
     updateUrl 是早期版本的可自定义字段，现已废弃 —— 一律忽略并在启动时清空 */
  updateUrl: '',
  autoCheckUpdate: true,
  /* 跳过快照版更新：开启后更新源上是快照 / 预发布 / 候选版时不再提示更新，只接受正式版 */
  skipPreviewUpdate: false,
  ignoredVersion: '',
  lastUpdateCheck: 0
};
const PERSONALIZE_DIR = path.join(DATA_DIR, 'personalize');
const BG_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
/* ---------------- 智能内存分配（对齐 PCL 的思路：先看实例要多少，再看此刻系统剩多少） ----------------
   ① 按「这个实例到底需要多少内存」算四个目标值（PCL 同款公式，模组数 = 实例 mods 目录里
      启用的 .jar / .zip / .litemod，被改名成 *.disabled 的不算）：
          无论如何要给的  RamMininum = 0.5 + 模组数 / 150
          勉强能带动      RamTarget1 = 1.5 + 模组数 / 90
          没啥问题        RamTarget2 = 2.7 + 模组数 / 50   （原版 2.5，带 OptiFine 3.0）
          放一万个模组    RamTarget3 = 4.5 + 模组数 / 25   （原版 4.0，带 OptiFine 5.0）
      所以原版给得少、装了几百个模组的整合包给得多 —— 不像从前只看物理内存总量。
   ② 再按「此刻系统真正剩多少可用内存」逐档发：0~T1 全给，T1~T2 给 70%，T2~T3 给 40%，
      再多只给 15%。内存紧张时优先保住「能启动」，内存充裕时才逐步放宽。
   ③ 兜底：不低于 1G；不超过「物理内存 - 1G」（给系统留余量）且不超过 64G。
   参数全部显式传入（不读 os）—— 便于自测，也便于按指定机器算给别人看。 */
function memTargetsGB(mods, optifine) {
  const n = Math.max(0, Number(mods) || 0);
  return {
    min: 0.5 + n / 150,
    t1: 1.5 + n / 90,
    t2: n > 0 ? 2.7 + n / 50 : (optifine ? 3.0 : 2.5),
    t3: n > 0 ? 4.5 + n / 25 : (optifine ? 5.0 : 4.0)
  };
}
function calcSmartMemGB(totalGB, availGB, mods, optifine) {
  const t = memTargetsGB(mods, optifine);
  let avail = Math.max(0, Number(availGB) || 0);
  let give = Math.min(avail, t.t1);
  avail -= t.t1;
  if (avail > 0) give += Math.min(avail * 0.7, Math.max(0, t.t2 - t.t1));
  if (avail > 0) give += Math.min(avail * 0.4, Math.max(0, t.t3 - t.t2));
  if (avail > 0) give += Math.min(avail * 0.15, t.t3);
  const cap = Math.max(2, Math.min(64, Math.floor(Math.max(1, Number(totalGB) || 1)) - 1));
  const rec = Math.max(Math.max(1, t.min), give);
  return Math.max(1, Math.floor(Math.min(rec, cap)));   /* JVM 的 -Xmx<N>G 只认整数，向下取整 */
}
/* 数一组目录里启用的模组：只认 .jar / .zip / .litemod（被禁用而改名成 *.jar.disabled 的不算），
   同名（忽略大小写）只算一次；顺带认一下有没有装 OptiFine（它是模组形态装进 mods 的）。 */
function countModsInDirs(dirs) {
  let mods = 0, optifine = false;
  const seen = new Set();
  for (const d of (dirs || [])) {
    if (!d) continue;
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of names) {
      if (!/\.(jar|zip|litemod)$/i.test(n)) continue;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      mods++;
      if (/optifine/i.test(n)) optifine = true;
    }
  }
  return { mods, optifine };
}
/* 一个实例的模组统计：实例隔离目录 versions/<实例>/mods 优先，再并上全局 mods/ */
function modStatsFor(instance) {
  const dirs = [];
  const inst = safeInstanceDir(instance);
  if (inst) dirs.push(path.join(inst, 'mods'));
  dirs.push(MODS_DIR());
  return countModsInDirs(dirs);
}
function smartMemGB(ctx) {
  const st = ctx && (ctx.mods !== undefined) ? ctx : modStatsFor(ctx && ctx.instance);
  return calcSmartMemGB(os.totalmem() / 1073741824, os.freemem() / 1073741824, st.mods, st.optifine);
}
/* 32 位 JVM 的堆上限在 1.5G 左右，给多了直接起不来（PCL 也是这么处理的）。
   读 PE 头判断：IMAGE_FILE_MACHINE_I386 = 0x014c。读不到就当 64 位（不误伤）。 */
function is32BitJavaExe(exe) {
  try {
    const buf = Buffer.alloc(1024);
    const fd = fs.openSync(exe, 'r');
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (n < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return false;   /* 'MZ' */
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > n || buf.readUInt32LE(pe) !== 0x00004550) return false;  /* 'PE\0\0' */
    return buf.readUInt16LE(pe + 4) === 0x014c;
  } catch (_) { return false; }
}
/* 启动内存钳制：下限 1G；上限 = min(64G, 物理内存)。
   渲染层传入的 opts.mem 与 config.mem 都只是键名白名单、没有值域校验，
   999 这种值会变成 -Xmx999G 让 JVM 直接起不来，且报错与「内存设置」毫无关联。 */
function clampMemGB(v) {
  const totalGB = Math.max(1, Math.floor(os.totalmem() / (1024 * 1024 * 1024)));
  const max = Math.min(64, totalGB);
  const n = parseInt(v, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 4, 1), max);
}
/* classpath 分隔符：Windows 为 ';'，类 Unix 为 ':'（硬编码 ';' 会让 Linux/macOS 上整条 classpath 被当成单个路径） */
const CP_SEP = process.platform === 'win32' ? ';' : ':';
ipcMain.handle('sys:meminfo', (_e, p) => {
  const totalGB = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
  const availGB = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
  const st = modStatsFor(p && p.instance);
  const tg = memTargetsGB(st.mods, st.optifine);
  return {
    ok: true, totalGB, availGB,
    mods: st.mods, optifine: st.optifine,
    recommendGB: calcSmartMemGB(totalGB, availGB, st.mods, st.optifine),
    targets: {
      min: Math.round(tg.min * 10) / 10,
      t1: Math.round(tg.t1 * 10) / 10,
      t2: Math.round(tg.t2 * 10) / 10,
      t3: Math.round(tg.t3 * 10) / 10
    }
  };
});

/* ---------------- 个性化 ---------------- */
ipcMain.handle('personalize:pick-bg', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const src = r.filePaths[0];
    const ext = path.extname(src).toLowerCase() || '.png';
    if (!BG_EXT_MIME[ext]) return { ok: false, error: '不支持的图片格式' };
    fs.mkdirSync(PERSONALIZE_DIR, { recursive: true });
    /* 清掉旧背景图，只保留当前一张 */
    try { for (const f of fs.readdirSync(PERSONALIZE_DIR)) if (f.startsWith('bg.')) fs.unlinkSync(path.join(PERSONALIZE_DIR, f)); } catch (_) {}
    const dest = path.join(PERSONALIZE_DIR, 'bg' + ext);
    fs.copyFileSync(src, dest);
    const rel = 'bg' + ext;
    config.bgImage = rel;
    if (config.bgMode === 'default' || config.bgMode === 'panorama') config.bgMode = 'image';
    saveConfigNow();
    return { ok: true, file: rel };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('personalize:get-bg', () => {
  try {
    if (!config.bgImage) return { ok: false };
    const p = path.join(PERSONALIZE_DIR, path.basename(config.bgImage));
    if (!fs.existsSync(p)) return { ok: false };
    const mime = BG_EXT_MIME[path.extname(p).toLowerCase()] || 'image/png';
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64') };
  } catch (_) { return { ok: false }; }
});

/* ---------------- 实例管理 ---------------- */
ipcMain.handle('instance:rename', async (_e, p) => {
  try {
    const from = String(p.from || ''), to = sanitizeVersionId(String(p.to || ''));
    if (!from || !to) throw new Error('名称无效');
    /* 严格防路径穿越：名称必须是纯目录名 */
    if (path.basename(from) !== from || from === '.' || from === '..') throw new Error('名称无效');
    if (from === to) return { ok: true, id: to };
    const vDir = path.join(config.gameDir, 'versions');
    const src = path.join(vDir, from), dst = path.join(vDir, to);
    if (!fs.existsSync(src)) throw new Error('实例不存在: ' + from);
    if (fs.existsSync(dst)) throw new Error('名称已存在: ' + to);
    // 有其他实例继承它（Fabric/Forge 等）则禁止重命名，会破坏继承链
    const children = [];
    for (const sub of fs.readdirSync(vDir)) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(vDir, sub, sub + '.json'), 'utf8'));
        if (j.inheritsFrom === from) children.push(sub);
      } catch (_) {}
    }
    if (children.length) throw new Error('该实例被 ' + children.join(', ') + ' 继承，无法重命名');
    await fsp.rename(src, dst);
    /* 目录改名后，里面的 <旧名>.json / <旧名>.jar 还叫旧名 —— 必须按旧名读、再落到新名。
       曾按新名读，于是每次重命名都在这里 ENOENT 失败（目录已改、json 没跟上）。 */
    const jsonOld = path.join(dst, from + '.json');
    const jsonNew = path.join(dst, to + '.json');
    const j = JSON.parse(await fsp.readFile(jsonOld, 'utf8'));
    j.id = to;
    await fsp.writeFile(jsonNew, JSON.stringify(j, null, 2));
    if (jsonOld !== jsonNew && fs.existsSync(jsonOld)) await fsp.rm(jsonOld, { force: true });
    const jarOld = path.join(dst, from + '.jar');
    if (fs.existsSync(jarOld)) await fsp.rename(jarOld, path.join(dst, to + '.jar'));
    if (config.defaultVersion === from) { config.defaultVersion = to; saveConfigNow(); }
    /* 实例级设置跟着改名迁移，否则「窗口标题 / 手动 Java」会在改名后丢失 */
    if (config.versionSettings && config.versionSettings[from]) {
      const vsMap = Object.assign({}, config.versionSettings);
      vsMap[to] = vsMap[from];
      delete vsMap[from];
      config.versionSettings = vsMap;
      saveConfigNow();
    }
    if (config.lastVersion === from) { config.lastVersion = to; saveConfigNow(); }
    logLine('[instance] 重命名 ' + from + ' -> ' + to);
    toast('实例已重命名: ' + to);
    return { ok: true, id: to };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('instance:delete', async (_e, p) => {
  try {
    const id = String(p.id || '');
    /* 严格防路径穿越：basename 校验（startsWith 前缀检查挡不住 ..） */
    if (!id || path.basename(id) !== id || id === '.' || id === '..') throw new Error('名称无效');
    const vDir = path.join(config.gameDir, 'versions');
    const dir = path.join(vDir, id);
    if (!fs.existsSync(dir)) throw new Error('实例不存在: ' + id);
    // 独立实例被继承时不给删（删除会连带破坏加载器实例）
    const children = [];
    for (const sub of fs.readdirSync(vDir)) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(vDir, sub, sub + '.json'), 'utf8'));
        if (j.inheritsFrom === id) children.push(sub);
      } catch (_) {}
    }
    if (children.length) throw new Error('该实例被 ' + children.join(', ') + ' 继承，请先删除它们');
    await fsp.rm(dir, { recursive: true, force: true });
    if (config.defaultVersion === id) { config.defaultVersion = ''; saveConfigNow(); }
    if (config.lastVersion === id) { config.lastVersion = ''; saveConfigNow(); }
    /* 实例没了，它那套「窗口标题 / 手动 Java」也一并清掉（否则同名重建会继承旧设置） */
    if (config.versionSettings && config.versionSettings[id]) {
      const vsMap = Object.assign({}, config.versionSettings);
      delete vsMap[id];
      config.versionSettings = vsMap;
      saveConfigNow();
    }
    logLine('[instance] 删除 ' + id);
    toast('实例已删除: ' + id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- MOD 管理（PCL 式：启用/禁用/删除） ---------------- */
const MODS_DIR = () => path.join(config.gameDir, 'mods');
/* 版本隔离：实例 MOD 目录 = versions/<实例>/mods（PCL 式隔离兼容） */
function safeInstanceDir(instance) {
  const id = String(instance || '');
  if (!id || /\.\.|[/\\:*?"<>|]/.test(id)) return null;
  return path.join(config.gameDir, 'versions', id);
}
function modsDirFor(instance) {
  const d = safeInstanceDir(instance);
  return d ? path.join(d, 'mods') : MODS_DIR();
}
/* 光影目录：版本隔离实例（实例目录下已有 mods/ 或 saves/）游戏实际读取的是
   versions/<实例>/shaderpacks；否则读游戏根目录的 shaderpacks。判定口径与启动时的
   版本隔离判定保持一致（见 launch 的 isolated 判断），避免装完游戏里看不到。 */
function shaderpacksDirFor(instance) {
  const d = safeInstanceDir(instance);
  if (d && (fs.existsSync(path.join(d, 'mods')) || fs.existsSync(path.join(d, 'saves')))) {
    return path.join(d, 'shaderpacks');
  }
  return path.join(config.gameDir, 'shaderpacks');
}
function safeModsPath(name, instance) {
  const base = path.basename(String(name || ''));
  if (!/\.jar(\.disabled)?$/i.test(base)) return null;
  return path.join(modsDirFor(instance), base);
}
ipcMain.handle('mods:list', async (_e, p) => {
  try {
    const dir = modsDirFor(p && p.instance);
    let names = [];
    try { names = await fsp.readdir(dir); } catch (_) { return { ok: true, mods: [] }; }
    const mods = [];
    for (const n of names) {
      if (!/\.(jar|disabled)$/i.test(n)) continue;
      try {
        const st = await fsp.stat(path.join(dir, n));
        mods.push({ name: n, disabled: /\.disabled$/i.test(n), size: st.size, mtime: st.mtimeMs });
      } catch (_) {}
    }
    mods.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, mods };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mods:toggle', async (_e, p) => {
  try {
    const f = safeModsPath(p.name, p.instance);
    if (!f || !fs.existsSync(f)) throw new Error('文件不存在');
    const target = /\.disabled$/i.test(f) ? f.replace(/\.disabled$/i, '') : f + '.disabled';
    await fsp.rename(f, target);
    return { ok: true, now: path.basename(target) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mods:delete', async (_e, p) => {
  try {
    const f = safeModsPath(p.name, p.instance);
    if (!f || !fs.existsSync(f)) throw new Error('文件不存在');
    /* 和存档 / 实例删除保持一致：先扔回收站（误删能捞回来），回收站不可用再退化为直接删除。
       原来这里是 fsp.rm —— 手动改过的 jar 误删就找不回来了（审计 F6）。 */
    try { await shell.trashItem(f); }
    catch (_) { await fsp.rm(f, { force: true }); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* MOD 在线信息富化：读 jar 内置元数据（fabric.mod.json / mods.toml / mcmod.info），
   再按 sha1 批量匹配 Modrinth（名称/简介/图标/详情页）——VersePC 式图标列表 + PCL 式详情 */
async function mrPost(p, body) {
  return fetchMrJson(mrUrls(p, 12000), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
function parseModsToml(src) {
  const s = String(src);
  const grab = (k) => {
    const m = s.match(new RegExp('^' + k + '\\s*=\\s*"""([\\s\\S]*?)"""', 'm')) ||
              s.match(new RegExp("^" + k + "\\s*=\\s*'''([\\s\\S]*?)'''", 'm')) ||
              s.match(new RegExp('^' + k + '\\s*=\\s*"([^"]*)"', 'm')) ||
              s.match(new RegExp("^" + k + "\\s*=\\s*'([^']*)'", 'm'));
    return m ? m[1].trim() : '';
  };
  const id = grab('modId');
  let ver = grab('version');
  if (/\$\{/.test(ver)) ver = '';
  return { id, name: grab('displayName') || id, version: ver, description: grab('description'), iconEntry: grab('logoFile') };
}
async function modsEnrichInner(instance, names) {
  const files = [];
  for (const n of names) {
    const f = safeModsPath(n, instance);
    if (!f || !fs.existsSync(f)) continue;
    try {
      const data = await fsp.readFile(f);
      files.push({ name: n, buf: data, size: data.length, sha1: crypto.createHash('sha1').update(data).digest('hex') });
    } catch (_) {}
  }
    /* 批量 sha1 → Modrinth 版本/项目匹配 */
    let hashMap = {};
    if (files.length) {
      try { hashMap = await mrPost('/version_files', { hashes: files.map(f => f.sha1), algorithm: 'sha1' }) || {}; } catch (_) {}
    }
    const projectIds = [...new Set(Object.values(hashMap).map(v => v.project_id).filter(Boolean))];
    let projById = {};
    if (projectIds.length) {
      try {
        const projects = await mrJson('/projects?ids=' + encodeURIComponent(JSON.stringify(projectIds))) || [];
        for (const pr of projects) projById[pr.id] = pr;
      } catch (_) {}
    }
    /* 中文名（AI 翻译缓存）+ 中文简介（MCIM），最多等 9 秒，慢的后台补 */
    const zhPromise = projectIds.length
      ? zhFill(projectIds, Object.fromEntries(projectIds.map(id => [id, (projById[id] || {}).title || ''])))
      : Promise.resolve({});
    const zhMap = await Promise.race([zhPromise, new Promise(r => setTimeout(() => r({}), 9000))]);
    const out = {};
    await Promise.all(files.map(async (f) => {
      /* 1. jar 内置元数据（离线兜底） */
      let local = {};
      try {
        const fb = zipReadEntry(f.buf, 'fabric.mod.json');
        if (fb) {
          const j = JSON.parse(fb.toString('utf8'));
          local = {
            id: j.id || '', name: j.name || j.id || '', version: (j.version && !/\$\{/.test(j.version)) ? j.version : '',
            description: j.description || '',
            iconEntry: typeof j.icon === 'string' ? j.icon : (j.icon && j.icon.default) || '',
            authors: (j.authors || []).map(a => a.name || a).filter(Boolean).join(', ')
          };
        }
      } catch (_) {}
      if (!local.id) {
        try { local = parseModsToml(zipReadEntry(f.buf, 'META-INF/mods.toml').toString('utf8')); } catch (_) {}
      }
      if (!local.id) {
        try {
          const mb = zipReadEntry(f.buf, 'mcmod.info');
          if (mb) {
            const j = JSON.parse(mb.toString('utf8').replace(/^\uFEFF/, ''));
            const m0 = (j.modList || j.mods || [])[0] || {};
            local = { id: m0.modid || '', name: m0.name || m0.modid || '', version: m0.version || '', description: m0.description || '', iconEntry: m0.logoFile || '', authors: (m0.authorList || []).join(', ') };
          }
        } catch (_) {}
      }
      let localIcon = '';
      if (local.iconEntry) { try { localIcon = bufToDataUri(zipReadEntry(f.buf, local.iconEntry)); } catch (_) {} }
      /* 2. 在线信息 + 图标（磁盘缓存） */
      const ver = hashMap[f.sha1];
      const pr = ver && projById[ver.project_id];
      let online = null;
      if (pr) {
        const z = zhMap[pr.id] || {};
        online = {
          title: pr.title || '', titleZh: z.zh || '', slug: pr.slug || '', description: pr.description || '', descZh: z.descZh || '',
          pageUrl: pr.slug ? 'https://modrinth.com/mod/' + pr.slug : '',
          iconDataUri: ''
        };
        try { online.iconDataUri = await fetchIconData(pr.icon_url, pr.id); } catch (_) {}
      }
      /* 3. 无 Modrinth 匹配时按 modid 查内置中文名表（离线兜底，中英混装模组包也能正确显示） */
      if (local.id && (!online || !online.titleZh)) {
        const localZh = zhByModId(local.id);
        if (localZh) { if (!online) online = {}; online.titleZh = localZh; }
      }
      out[f.name] = {
        size: f.size, sha1: f.sha1, local, online,
        localIconDataUri: localIcon || '',
        version: (ver && ver.version_number) || local.version || '',
        loaders: (ver && ver.loaders) || [],
        gameVersions: ver ? (ver.game_versions || []) : []
      };
    }));
    return { ok: true, meta: out };
}
ipcMain.handle('mods:enrich', async (_e, p) => {
  try { return await modsEnrichInner(p && p.instance, Array.isArray(p && p.names) ? p.names.slice(0, 200) : []); }
  catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- MOD 更新（PCL 式） ----------------
 * 检查：本地 jar 算 sha1（Modrinth）+ murmur2 指纹（CurseForge），批量匹配在线项目拿到「当前版本」，
 *       再取该项目在「这个 MC 版本 + 加载器」下的最新版，id 不同 = 有更新。
 *       纯逻辑（murmur2 / 挑最新版）在 src/modupd-core.js，qa/modupd-unit.js 单测守着。
 * 更新：下载新 jar（.part 中转 + sha1 校验）→ 旧文件移入系统回收站（PCL 同款兜底，可找回）→ 换上新的。 */
const MU_CORE = require('./src/modupd-core');
const MU_ST = { instance: '', key: '', res: null, at: 0, cfOk: false };
function muCfPost(p, body) {
  return fetch(CF_API + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': mrUA() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  }).then(async res => {
    if (!res.ok) throw new Error('CurseForge 接口 HTTP ' + res.status);
    return res.json();
  });
}
async function modsCheckUpdatesInner(instance, refresh) {
  const dir = modsDirFor(instance);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.jar$/i.test(n)).sort().slice(0, 200); } catch (_) {}
  if (!names.length) {
    MU_ST.instance = instance; MU_ST.key = ''; MU_ST.res = { updates: {}, checked: 0, unmatched: 0 }; MU_ST.at = Date.now();
    return { ok: true, updates: {}, checked: 0, unmatched: 0, cfOk: false };
  }
  /* 结果缓存：同实例 + 同一批文件（名字/大小/分钟级 mtime）15 分钟内直接复用，切页不重复联网 */
  let sig = '';
  try { sig = names.map(n => { const s = fs.statSync(path.join(dir, n)); return n + ':' + s.size + ':' + Math.floor(s.mtimeMs / 60000); }).join('|'); }
  catch (_) { sig = names.join('|'); }
  if (!refresh && MU_ST.instance === instance && MU_ST.key === sig && Date.now() - MU_ST.at < 15 * 60 * 1000 && MU_ST.res) {
    return Object.assign({ ok: true, cached: true, cfOk: MU_ST.cfOk }, MU_ST.res);
  }
  /* 实例的 MC 版本与加载器（挑「最新版」的过滤条件） */
  let mcVer = '', loaderMr = '';
  try {
    const chain = await loadVersionChain(instance, config.gameDir, 0);
    mcVer = chain.rootId || '';
    loaderMr = loaderToMr(detectLoaderOf(chain.json)) || '';
  } catch (_) {}
  /* 逐文件算两种哈希，读完立刻放内存 */
  const files = [];
  for (const n of names) {
    const f = safeModsPath(n, instance);
    if (!f || !fs.existsSync(f)) continue;
    try {
      const buf = await fsp.readFile(f);
      files.push({ name: n, sha1: crypto.createHash('sha1').update(buf).digest('hex'), fp: MU_CORE.muMurmur2(buf), size: buf.length });
    } catch (_) {}
  }
  /* Modrinth：sha1 批量（每 100 个一批）→ 当前版本。注意 /version_files 返回的是「hash → version」对象 */
  const shaToVer = {};
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    try {
      const map = await mrPost('/version_files', { hashes: chunk.map(f => f.sha1), algorithm: 'sha1' }) || {};
      for (const f of chunk) if (map[f.sha1]) shaToVer[f.sha1] = map[f.sha1];
    } catch (_) {}
  }
  /* CurseForge：murmur2 指纹批量（每 100 个一批）；镜像不可用就只用 Modrinth，不报错 */
  let cfOk = false;
  const fpToFile = {};
  for (let i = 0; i < files.length; i += 100) {
    try {
      const j = await muCfPost('/fingerprints', { fingerprints: files.slice(i, i + 100).map(f => f.fp) });
      const d = (j && j.data) || {};
      cfOk = true;
      for (const m of (d.exactMatches || [])) if (m && m.file && m.file.id != null) fpToFile[m.file.fileFingerprint] = m.file;
    } catch (_) {}
  }
  /* 每个匹配到的项目拉版本列表（并发 4），挑「MC 版本 + 加载器」下的最新版 */
  const projVersions = {};
  const mrPids = [...new Set(Object.values(shaToVer).map(v => v.project_id).filter(Boolean))];
  const cfIds = [...new Set(Object.values(fpToFile).map(f => f.modId).filter(Boolean))];
  let projById = {};
  try {
    const projects = await mrJson('/projects?ids=' + encodeURIComponent(JSON.stringify(mrPids))) || [];
    for (const pr of projects) projById[pr.id] = pr;
  } catch (_) {}
  for (let i = 0; i < mrPids.length; i += 4) {
    await Promise.all(mrPids.slice(i, i + 4).map(async pid => {
      try { projVersions['mr:' + pid] = await mrJson('/project/' + pid + '/version') || []; } catch (_) { projVersions['mr:' + pid] = []; }
    }));
  }
  for (let i = 0; i < cfIds.length; i += 4) {
    await Promise.all(cfIds.slice(i, i + 4).map(async mid => {
      try {
        const j = await cfJson('/mods/' + mid + '/files');
        projVersions['cf:' + mid] = (j && j.data) || [];
      } catch (_) { projVersions['cf:' + mid] = []; }
    }));
  }
  /* 汇总：有「更新的版本」才进 updates */
  const updates = {};
  let checked = 0, unmatched = 0;
  for (const f of files) {
    checked++;
    const mv = shaToVer[f.sha1];
    const cfFile = fpToFile[f.fp];
    if (!mv && !cfFile) { unmatched++; continue; }
    try {
      if (mv) {
        const latest = MU_CORE.muPickLatest(projVersions['mr:' + mv.project_id] || [], mcVer, loaderMr);
        const file = latest && ((latest.files || []).find(x => x.primary) || (latest.files || [])[0]);
        if (latest && file && latest.id !== mv.id) {
          const pr = projById[mv.project_id] || {};
          updates[f.name] = {
            src: 'modrinth', title: pr.title || mv.version_number || f.name,
            pageUrl: pr.slug ? 'https://modrinth.com/mod/' + pr.slug : '',
            current: mv.version_number || '', latest: latest.version_number || '',
            fileName: file.filename, url: file.url, size: file.size || 0,
            sha1: (file.hashes && file.hashes.sha1) || '', date: latest.date_published || ''
          };
        }
      } else if (cfFile) {
        const pool = (projVersions['cf:' + cfFile.modId] || []).filter(x => (x.gameVersions || []).includes(mcVer));
        const latest = pool.sort((a, b) => String(b.fileDate || '').localeCompare(String(a.fileDate || '')))[0] || null;
        if (latest && latest.id !== cfFile.id && latest.downloadUrl) {
          updates[f.name] = {
            src: 'curseforge', title: cfFile.displayName || f.name, pageUrl: '',
            current: cfFile.displayName || '', latest: latest.displayName || latest.fileName || '',
            fileName: latest.fileName, url: latest.downloadUrl, size: latest.fileLength || 0,
            sha1: '', date: latest.fileDate || ''
          };
        }
      }
    } catch (_) {}
  }
  MU_ST.instance = instance; MU_ST.key = sig; MU_ST.at = Date.now(); MU_ST.cfOk = cfOk;
  MU_ST.res = { updates, checked, unmatched };
  return { ok: true, updates, checked, unmatched, cfOk, mcVer };
}
ipcMain.handle('mods:check-updates', async (_e, p) => {
  try { return await modsCheckUpdatesInner((p && p.instance) || '', !!(p && p.refresh)); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mods:update', async (_e, p) => {
  const instance = (p && p.instance) || '';
  const names = Array.isArray(p && p.names) ? p.names : [];
  const results = [];
  for (const name of names) {
    try {
      const u = (MU_ST.instance === instance && MU_ST.res && MU_ST.res.updates[name]) || null;
      if (!u) throw new Error('没有该 MOD 的更新信息，请先重新「检查更新」');
      const dest = safeModsPath(u.fileName, instance);
      if (!dest) throw new Error('目标文件名不合法: ' + u.fileName);
      /* 先下到 .part 中转（带 sha1 校验），成功才动旧文件 —— 下载失败不影响现有 MOD */
      const part = dest + '.part';
      try { await fsp.rm(part, { force: true }); } catch (_) {}
      await downloadTo(u.url, part, u.sha1 || undefined, undefined, u.size);
      const old = safeModsPath(name, instance);
      if (old && fs.existsSync(old)) {
        /* PCL 同款兜底：旧文件移入系统回收站，更新出问题可以找回 */
        try { await shell.trashItem(old); } catch (_) { await fsp.rm(old, { force: true }); }
      }
      await fsp.rename(part, dest);
      if (MU_ST.res) delete MU_ST.res.updates[name];
      results.push({ name, ok: true, to: u.fileName });
    } catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  const updated = results.filter(r => r.ok).length;
  return { ok: updated > 0, allOk: updated === names.length, results, updated };
});
/* ---------------- 资源包 / 光影包（照 PCL CE 的实例设置页） ----------------
 * PCL CE 的「实例设置 → 资源包 / 光影包」行为（源码 Pages/PageInstance/PageInstanceCompResource）：
 *   · 各自扫一个目录：resourcepacks/ 与 shaderpacks/（版本隔离时取 versions/<实例>/ 下的同名目录）
 *   · 列表里读包内 pack.mcmeta（描述、包格式）与 pack.png（图标）；坏包 / 缺 shaders 目录标成「错误」
 *   · 筛选：全部 / 可更新 / 错误 / 重复；排序：资源名称 / 文件名 / 大小 / 添加时间（文件夹置顶）
 *   · 按钮：打开文件夹 / 从文件安装 / 下载新资源包 / 全选 / 导出信息
 *   · **没有启用 / 禁用** —— 资源包与光影由游戏内「选项 → 资源包 / 光影」选择，PCL 也是把 ED 按钮隐藏的
 * 我们的实现与 PCL 独立（行为对齐）：包信息本地解析 + sha1 匹配 Modrinth 拿在线名称/简介/图标，可更新复用 MOD 的
 * muPickLatest（src/modupd-core.js）。 */
/* Modrinth 的项目描述是 Markdown：详情弹窗里必须先转成 HTML，否则 ![图](url)、**粗体**、
   列表符号会当纯文本原样露出来（src/md-core.js，纯函数、有单测） */
const { mdToHtml } = require('./src/md-core');
/* 中文搜索词的译文清洗（纯函数，单测在 qa/search-zh-unit.js） */
const { hasCJK, enKeywordsFromTranslation } = require('./src/search-zh');
/* 内置插件「存档备份」：命名 / 保留策略 / 是否该备（纯函数，qa/savebackup-unit.js）
   + 自己写的流式 ZIP 读写（存档几十 MB，不能整包塞内存） */
const SB_CORE = require('./src/savebackup-core');
const ZIPW = require('./src/zip-write');
/* 内置插件「模组清单对齐」：清单生成 / 解析 / 差异（纯函数，qa/modalign-unit.js） */
const MA_CORE = require('./src/modalign-core');
const RES_ZIP = require('./zipio');
const RES_ST = { key: '', res: null, at: 0 };
function resourcepacksDirFor(instance) {
  /* 隔离口径与 shaderpacksDirFor 一致：实例目录下有 mods/ 或 saves/ 就是隔离实例 */
  const d = safeInstanceDir(instance);
  if (d && (fs.existsSync(path.join(d, 'mods')) || fs.existsSync(path.join(d, 'saves')))) {
    return path.join(d, 'resourcepacks');
  }
  return path.join(config.gameDir, 'resourcepacks');
}
function resDirFor(kind, instance) {
  return kind === 'shader' ? shaderpacksDirFor(instance) : resourcepacksDirFor(instance);
}
function resSafePath(kind, instance, name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..' || /[\\/:*?"<>|]/.test(base)) return null;
  return path.join(resDirFor(kind, instance), base);
}
/* pack.mcmeta 的 description 可能是字符串 / 文本组件 / 文本组件数组（1.20 后会带 § 颜色码） */
function packDescText(d) {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(packDescText).join('');
  if (typeof d === 'object') return String(d.text || d.translate || '');
  return '';
}
function parsePackMeta(buf) {
  const j = JSON.parse(String(buf).replace(/^\uFEFF/, ''));
  const p = (j && j.pack) || j || {};
  let fmt = p.pack_format;
  if (fmt == null && p.supported_formats) {
    const sf = p.supported_formats;
    fmt = Array.isArray(sf) ? sf[0] : (sf && sf.min_inclusive != null ? sf.min_inclusive + '~' + sf.max_inclusive : '');
  }
  return {
    format: fmt == null ? '' : String(fmt),
    desc: packDescText(p.description).replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim()
  };
}
async function resScanOne(kind, dir, name, isFolder) {
  const full = path.join(dir, name);
  const item = { name, isFolder: !!isFolder, size: 0, mtime: 0, desc: '', format: '', icon: '', sha1: '', error: '' };
  try { const st = await fsp.stat(full); item.size = st.size; item.mtime = st.mtimeMs; }
  catch (e) { item.error = '读取失败：' + e.message; return item; }
  if (isFolder) {
    try { const pm = parsePackMeta(await fsp.readFile(path.join(full, 'pack.mcmeta'))); item.desc = pm.desc; item.format = pm.format; }
    catch (_) { item.error = '不是有效的' + (kind === 'shader' ? '光影包' : '资源包') + '（缺少 pack.mcmeta）'; }
    try { item.icon = bufToDataUri(await fsp.readFile(path.join(full, 'pack.png')), 512 * 1024); } catch (_) {}
    return item;
  }
  let buf;
  /* 超大的包不整包读进内存（光影包动辄上百 MB）：列表照样列出来，只是没有包内描述 / 图标 */
  if (item.size > 256 * 1024 * 1024) { item.error = '文件超过 256MB，未解析包内信息'; return item; }
  try { buf = await fsp.readFile(full); }
  catch (e) { item.error = '读取失败：' + e.message; return item; }
  item.size = buf.length;
  try { item.sha1 = crypto.createHash('sha1').update(buf).digest('hex'); } catch (_) {}
  let names = [];
  try { names = RES_ZIP.listZipNames(buf); }
  catch (_) { item.error = '压缩包损坏或不是 ZIP'; return item; }
  try {
    const pm = parsePackMeta(RES_ZIP.zipReadEntry(buf, 'pack.mcmeta'));
    item.desc = pm.desc; item.format = pm.format;
  } catch (_) {
    if (kind === 'resourcepack') item.error = '不是有效的资源包（缺少 pack.mcmeta）';
  }
  try { item.icon = bufToDataUri(RES_ZIP.zipReadEntry(buf, 'pack.png'), 512 * 1024); } catch (_) {}
  if (kind === 'shader') {
    if (!names.some(n => n.startsWith('shaders/'))) item.error = item.error || '不是有效的光影包（缺少 shaders 目录）';
    if (!item.desc) {
      /* 光影包描述常在 shaders/shaders.properties（Iris/OptiFine 通用）里，退而取第一行 name/screen */
      try {
        const sp = String(RES_ZIP.zipReadEntry(buf, 'shaders/shaders.properties'));
        const m = sp.match(/^\s*(?:screen|name|description)\s*[=:]\s*(.+)$/im);
        if (m) item.desc = m[1].trim();
      } catch (_) {}
    }
  }
  return item;
}
ipcMain.handle('res:list', async (_e, p) => {
  const kind = p && p.kind === 'shader' ? 'shader' : 'resourcepack';
  const instance = (p && p.instance) || '';
  const dir = resDirFor(kind, instance);
  let ents = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (_) { return { ok: true, dir, instance, items: [] }; }
  const items = [];
  for (const e of ents) {
    const n = e.name;
    if (!n || n.startsWith('.') || n.startsWith('$')) continue;
    if (e.isDirectory()) items.push(await resScanOne(kind, dir, n, true));
    else if (/\.zip$/i.test(n)) items.push(await resScanOne(kind, dir, n, false));
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, dir, instance, items };
});
/* 在线信息 + 可更新：sha1 批量匹配 Modrinth，再按「实例 MC 版本」挑最新版（资源包/光影不看加载器） */
async function resCheckUpdatesInner(kind, instance, refresh) {
  const dir = resDirFor(kind, instance);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.zip$/i.test(n)).sort().slice(0, 200); } catch (_) {}
  if (!names.length) return { ok: true, info: {}, updates: {}, mcVer: '' };
  let sig = '';
  try {
    sig = kind + '|' + instance + '|' + names.map(n => { const s = fs.statSync(path.join(dir, n)); return n + ':' + s.size + ':' + Math.floor(s.mtimeMs / 60000); }).join('|');
  } catch (_) { sig = kind + '|' + instance + '|' + names.join('|'); }
  if (!refresh && RES_ST.key === sig && RES_ST.res && Date.now() - RES_ST.at < 15 * 60 * 1000) {
    return Object.assign({ ok: true, cached: true }, RES_ST.res);
  }
  let mcVer = '';
  try { const chain = await loadVersionChain(instance, config.gameDir, 0); mcVer = chain.rootId || ''; } catch (_) {}
  const files = [];
  for (const n of names) {
    try {
      const buf = await fsp.readFile(path.join(dir, n));
      files.push({ name: n, sha1: crypto.createHash('sha1').update(buf).digest('hex') });
    } catch (_) {}
  }
  const shaToVer = {};
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    try {
      /* 与 MOD 一样：/version_files 返回的是「hash → version」对象，不是数组 */
      const map = await mrPost('/version_files', { hashes: chunk.map(f => f.sha1), algorithm: 'sha1' }) || {};
      for (const f of chunk) if (map[f.sha1]) shaToVer[f.sha1] = map[f.sha1];
    } catch (_) {}
  }
  const pids = [...new Set(Object.values(shaToVer).map(v => v.project_id).filter(Boolean))];
  let projById = {};
  try {
    const projects = await mrJson('/projects?ids=' + encodeURIComponent(JSON.stringify(pids))) || [];
    for (const pr of projects) projById[pr.id] = pr;
  } catch (_) {}
  const versions = {};
  for (let i = 0; i < pids.length; i += 4) {
    await Promise.all(pids.slice(i, i + 4).map(async pid => {
      try { versions['mr:' + pid] = await mrJson('/project/' + pid + '/version') || []; }
      catch (_) { versions['mr:' + pid] = []; }
    }));
  }
  const info = {}, updates = {};
  for (const f of files) {
    const mv = shaToVer[f.sha1];
    if (!mv) continue;
    const pr = projById[mv.project_id] || {};
    let icon = '';
    try { if (pr.icon_url) icon = await fetchIconData(pr.icon_url, pr.id, 512 * 1024); } catch (_) {}
    const cur = mv.version_number || '';
    const pageUrl = pr.slug ? 'https://modrinth.com/' + (kind === 'shader' ? 'shader/' : 'resourcepack/') + pr.slug : '';
    info[f.name] = {
      title: pr.title || '', desc: pr.description || '', slug: pr.slug || '', icon, pageUrl,
      cats: Array.isArray(pr.categories) ? pr.categories.slice(0, 5) : [],
      version: cur
    };
    const latest = MU_CORE.muPickLatest(versions['mr:' + mv.project_id] || [], mcVer, '');
    const file = latest && ((latest.files || []).find(x => x.primary) || (latest.files || [])[0]);
    if (latest && file && latest.id !== mv.id) {
      updates[f.name] = {
        src: 'modrinth', title: info[f.name].title || cur, pageUrl,
        current: cur, latest: latest.version_number || '',
        fileName: file.filename, url: file.url, size: file.size || 0,
        sha1: (file.hashes && file.hashes.sha1) || ''
      };
    }
  }
  RES_ST.key = sig; RES_ST.at = Date.now(); RES_ST.res = { info, updates, mcVer };
  return { ok: true, info, updates, mcVer };
}
ipcMain.handle('res:check-updates', async (_e, p) => {
  const kind = p && p.kind === 'shader' ? 'shader' : 'resourcepack';
  try { return await resCheckUpdatesInner(kind, (p && p.instance) || '', !!(p && p.refresh)); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('res:update', async (_e, p) => {
  const kind = p && p.kind === 'shader' ? 'shader' : 'resourcepack';
  const instance = (p && p.instance) || '';
  const name = (p && p.name) || '';
  let part = '';
  try {
    const u = (RES_ST.res && RES_ST.res.updates && RES_ST.res.updates[name]) || null;
    if (!u) throw new Error('没有该资源包的更新信息，请先重新「检查更新」');
    const dest = resSafePath(kind, instance, u.fileName);
    if (!dest) throw new Error('目标文件名不合法: ' + u.fileName);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    part = dest + '.part';
    try { await fsp.rm(part, { force: true }); } catch (_) {}
    await downloadTo(u.url, part, u.sha1 || undefined, undefined, u.size);
    const old = resSafePath(kind, instance, name);
    if (old && fs.existsSync(old)) {
      /* 与 MOD 更新同一套兜底：旧文件进回收站，下载失败不会先删旧的 */
      try { await shell.trashItem(old); } catch (_) { await fsp.rm(old, { force: true }); }
    }
    await fsp.rename(part, dest);
    part = '';
    if (RES_ST.res) delete RES_ST.res.updates[name];
    return { ok: true, to: u.fileName };
  } catch (e) {
    if (part) { try { await fsp.rm(part, { force: true }); } catch (_) {} }
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('res:open-folder', async (_e, p) => {
  const kind = p && p.kind === 'shader' ? 'shader' : 'resourcepack';
  const dir = resDirFor(kind, (p && p.instance) || '');
  try { await fsp.mkdir(dir, { recursive: true }); } catch (_) {}
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true, dir };
});
ipcMain.handle('res:pick-files', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: '选择要安装的资源包 / 光影包',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '资源包 / 光影包（.zip）', extensions: ['zip'] }]
    });
    if (r.canceled) return { ok: false, canceled: true, files: [] };
    return { ok: true, files: r.filePaths };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('res:install', async (_e, p) => {
  const kind = p && p.kind === 'shader' ? 'shader' : 'resourcepack';
  const instance = (p && p.instance) || '';
  const overwrite = !!(p && p.overwrite);
  const files = Array.isArray(p && p.files) ? p.files.slice(0, 50) : [];
  const dir = resDirFor(kind, instance);
  const installed = [], conflicts = [], conflictFiles = [], failed = [];
  try { await fsp.mkdir(dir, { recursive: true }); } catch (_) {}
  for (const src of files) {
    try {
      const st = await fsp.stat(src);
      if (!st.isFile() || !/\.zip$/i.test(src)) { failed.push({ name: path.basename(src), error: '只支持 .zip 文件' }); continue; }
      const base = path.basename(src);
      const dest = path.join(dir, base);
      if (fs.existsSync(dest) && !overwrite) { conflicts.push(base); conflictFiles.push(src); continue; }
      await fsp.copyFile(src, dest);
      installed.push(base);
    } catch (e) { failed.push({ name: path.basename(src), error: e.message }); }
  }
  return { ok: true, dir, installed, conflicts, conflictFiles, failed };
});
ipcMain.handle('res:delete', async (_e, p) => {
  const kind = p && p.kind === 'shader' ? 'shader' : 'resourcepack';
  const f = resSafePath(kind, (p && p.instance) || '', (p && p.name) || '');
  try {
    if (!f || !fs.existsSync(f)) throw new Error('文件不存在');
    try { await shell.trashItem(f); } catch (_) { await fsp.rm(f, { recursive: true, force: true }); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('res:export-csv', async (_e, p) => {
  try {
    const content = String((p && p.content) || '');
    const def = String((p && p.defaultName) || 'resourcepacks.csv');
    const r = await dialog.showSaveDialog({
      title: '导出资源信息',
      defaultPath: path.join(app.getPath('documents'), def),
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }, { name: '文本文件', extensions: ['txt'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(r.filePath, '\uFEFF' + content, 'utf8');
    try { shell.showItemInFolder(r.filePath); } catch (_) {}
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('shell:open-external', (_e, url) => {
  const u = String(url || '').trim();
  if (/^https:\/\//i.test(u)) { shell.openExternal(u); return { ok: true }; }
  if (/^http:\/\//i.test(u)) {
    const msg = '出于安全考虑仅允许打开 https:// 链接，请改用该页面的 https 地址';
    toast('链接打开失败: ' + msg, 'warn');
    return { ok: false, error: msg };
  }
  const msg = '不支持的链接类型：' + u.slice(0, 80);
  toast('链接打开失败: ' + msg, 'warn');
  return { ok: false, error: msg };
});
/* 配置损坏时的说明：loadConfig 发生在 logLine / toast 就绪之前（LOG_DIR 在下方声明，
   提前调用会踩 TDZ），所以先把原因存起来，等主窗口加载完成再写日志 + 弹提示。 */
let CONFIG_LOAD_WARN = '';
function loadConfig() {
  let raw = null;
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch (_) { return Object.assign({}, DEFAULT_CONFIG); }   /* 没有文件 = 首次运行，属正常 */
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('配置根节点不是对象');
    return Object.assign({}, DEFAULT_CONFIG, obj);
  } catch (e) {
    /* 配置坏了：**先改名保留**再用默认值启动 —— 绝不直接覆盖，否则原始内容永久丢失。
       之前的行为是静默返回默认配置，用户只会看到「所有设置变回默认」。 */
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const bad = CONFIG_PATH + '.bad-' + stamp;
    let kept = '';
    try { fs.renameSync(CONFIG_PATH, bad); kept = bad; }
    catch (_) {
      try { fs.copyFileSync(CONFIG_PATH, bad); kept = bad; } catch (_) {}
    }
    CONFIG_LOAD_WARN = '配置文件解析失败（' + e.message + '）' +
      (kept ? '，原文件已备份为 ' + path.basename(kept) : '') + '，本次先用默认配置启动';
    try { console.error('[config] ' + CONFIG_LOAD_WARN); } catch (_) {}
    return Object.assign({}, DEFAULT_CONFIG);
  }
}
/* 原子写：写 .xlc-tmp → fsync → rename 覆盖。直接 writeFileSync 目标文件时，
   写一半断电/进程被杀/磁盘满会留下半截 JSON（下一次启动就成了 F1 里那种「设置全丢」）。
   失败不再静默：写日志 + 弹提示，让用户知道「这次设置没保存成功」。 */
function saveConfigNow() {
  const tmp = CONFIG_PATH + '.xlc-tmp';
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2));
      try { fs.fsyncSync(fd); } catch (_) {}   /* 尽量把内容刷到盘上再改名 */
    } finally { try { fs.closeSync(fd); } catch (_) {} }
    fs.renameSync(tmp, CONFIG_PATH);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { logLine('[config] 保存失败: ' + e.message); } catch (_) {}
    try { toast('设置保存失败：' + e.message + '（请检查磁盘空间与文件权限）', 'error'); } catch (_) {}
    return false;
  }
}
let config = loadConfig();
/* 存档备份设置规整：老配置里没有 backup 字段、或者被外部改脏了，都在这里落回合法值 */
config.backup = SB_CORE.normalizeBackupCfg(config.backup);
/* 首次运行（照 PCL 的做法「点开就有文件」）：默认配置直接落盘。
 * 此时 XLC数据 / .minecraft / diagnostics 目录已在启动阶段建好，再加上这份 lmc.config.json，
 * 用户双击 exe 之后就能在它旁边看到一整套文件，而不是「打开一次什么都没留下」。
 * 这里故意不调 logLine —— LOG_DIR 在下方才声明，提前调用会踩 TDZ。 */
try {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (saveConfigNow()) console.log('[首次运行] 已创建默认配置: ' + CONFIG_PATH);
  }
} catch (_) {}

/* 诊断出口：LMC_DIAG_DIRS=<文件路径> 时只把「这台机器上的数据落在哪」写成 JSON 然后退出，不开窗口。
   用途 ① 便携版数据目录回归 qa/check-portable-dirs.js（真跑一次 portable exe 看文件建在哪）；
   ② 用户报「设置不保存 / 找不到存档」时，让他带这个变量跑一次，一眼看出目录是不是被丢到临时目录。 */
if (process.env.LMC_DIAG_DIRS) {
  try {
    fs.writeFileSync(process.env.LMC_DIAG_DIRS, JSON.stringify({
      version: APP_VERSION,
      packaged: app.isPackaged,
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR || '',
      exePath: app.getPath('exe'),
      dataDir: DATA_DIR,
      gameDir: config.gameDir,
      configPath: CONFIG_PATH,
      configExists: fs.existsSync(CONFIG_PATH),
      /* 联机核心是否被打进了安装包（asar 内存在 = true）。1.2-snapshot1 起应为 false */
      bundledCore: fs.existsSync(path.join(__dirname, 'terracotta', 'terracotta.exe'))
    }, null, 2));
  } catch (_) {}
  setTimeout(() => { try { app.exit(0); } catch (_) { process.exit(0); } }, 80);
}

/* 自测进程可用 LMC_SMOKE_GAME_DIR 强制指定游戏目录（真装测试的隔离手段）。
   比让测试去改配置文件更可靠 —— 配置文件路径随 DATA_DIR 变化，测试无从下手。 */
if (SMOKE_EARLY && process.env.LMC_SMOKE_GAME_DIR) {
  try {
    config.gameDir = path.resolve(process.env.LMC_SMOKE_GAME_DIR);
    logLine('[smoke] gameDir 已隔离到: ' + config.gameDir);
  } catch (_) {}
}

/* 游戏目录迁移：默认改为启动器旁 .minecraft（PCL 式，不占 C 盘）。
 * 仍为旧默认（C 盘官方 .minecraft）的自动切到新默认；用户显式选择的目录保持不动；目录不存在则自动创建 */
try {
  const OLD_DEF_GAME_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
  if (!config.gameDir || config.gameDir === OLD_DEF_GAME_DIR) {
    config.gameDir = DEFAULT_CONFIG.gameDir;
    saveConfigNow();
    logLine('[config] 游戏目录已迁移到启动器旁: ' + config.gameDir);
  }
  fs.mkdirSync(config.gameDir, { recursive: true });
} catch (_) {}

/* 启动器可见性迁移（1.2 起）：
 * 上一版的默认值是「启动游戏后隐藏启动器」—— 玩家每次点启动，启动器窗口就消失，
 * 看起来完全就是「启动器崩了 / 被关掉了」（用户实际报障）。默认改成「保持显示」：
 * 窗口留着，用户想藏再自己去设置里选。旧配置里存的 `hide` 一起迁过来；
 * 迁移只做一次（visKeepMigrated 落盘），之后用户在设置里手动选「隐藏」仍然生效。 */
try {
  if (!config.visKeepMigrated) {
    const from = config.launcherVisibility;
    if (from === 'hide') {
      config.launcherVisibility = DEFAULT_CONFIG.launcherVisibility;
      logLine('[config] 启动器可见性由「启动后隐藏」迁移为「' + config.launcherVisibility + '」（旧默认值会让窗口在点启动后消失）');
    }
    config.visKeepMigrated = true;
    saveConfigNow();
  }
} catch (_) {}

let win = null;
const SMOKE = process.argv.includes('--lmc-smoke');
function send(ch, payload) {
  /* install:speed 每 500ms 一条，自测时刷屏没意义（判定只看落盘结果的 [UI-JS] 标记），跳过日志 */
  if (SMOKE && ch !== 'install:speed') console.log('[ipc:' + ch + '] ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)));
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

/* ---------------- 下载流量统计（真实速度 + 阶段字节进度） ----------------
   为什么需要它：install:progress 是按「文件条数」跳的（依赖库 12/156、资源文件 2400/5200），
   两个事件之间可能几十秒不动，界面只能拿百分比硬算速度 —— 于是出现「预计剩余 1 秒」还永远不变。
   这里统计两头：
     real —— 真实从网络读下来的字节（算瞬时速度，含多线程分段）
     done —— 逻辑完成字节（把「已存在被跳过」的文件也算进去，算阶段剩余量）
   各阶段用 phaseBegin(name, 总字节) 报出总量，于是 剩余时间 = (总 - 已下) / 速度，才有意义。 */
const netStat = { real: 0, done: 0 };
let netPhase = { name: '', startDone: 0, total: 0 };
let netBps = 0, netLastReal = 0, netLastT = 0, netTimer = null;
function netAddReal(n) { netStat.real += n; netStat.done += n; }
function netAddSkip(n) { netStat.done += n; }
function netReset() {
  netStat.real = 0; netStat.done = 0; netBps = 0;
  netLastReal = 0; netLastT = Date.now();
  netPhase = { name: '', startDone: 0, total: 0 };
}
/* ---------------- 下载限速（设置 → 下载 → 速度限制，KB/s；0 = 不限速） ----------------
 * 令牌桶：按真实下载字节数扣令牌，桶空了就等，等到下一批令牌攒够再放行。
 * 为什么放在 netAddReal 这一层而不是每个 fetch 里：所有下载（游戏本体 / 资源 /
 * Java / 组件 / 插件）都会经过它，一处收口就全局限速，不会漏掉某条下载路径。
 * 桶容量 = 1 秒的量，允许短时突发到满速，体感比严格匀速更接近「没限速」。 */
const speedBucket = { tokens: 0, last: 0 };
function speedLimitBytesPerSec() {
  const kb = Math.min(Math.max(parseInt(config.speedLimit, 10) || 0, 0), 1000000);
  return kb > 0 ? kb * 1024 : 0;
}
async function speedThrottle(n) {
  const rate = speedLimitBytesPerSec();
  if (!rate) { speedBucket.tokens = 0; return; }
  const now = Date.now();
  if (!speedBucket.last) { speedBucket.last = now; speedBucket.tokens = rate; }
  speedBucket.tokens = Math.min(rate, speedBucket.tokens + (now - speedBucket.last) / 1000 * rate);
  speedBucket.last = now;
  speedBucket.tokens -= n;
  if (speedBucket.tokens >= 0) return;
  const waitMs = Math.min(2000, Math.ceil(-speedBucket.tokens / rate * 1000));
  await new Promise(r => setTimeout(r, waitMs));
  speedBucket.last = Date.now();
}
function phaseBegin(name, totalBytes) {
  netPhase = { name: name || '', startDone: netStat.done, total: Math.max(0, Math.round(totalBytes || 0)) };
}
function netSnap() {
  const bytes = netPhase.name ? Math.max(0, netStat.done - netPhase.startDone) : netStat.done;
  return { bps: Math.round(netBps), bytes, bytesTotal: netPhase.total || 0, phase: netPhase.name || '' };
}
/* 常驻 500ms 采样：只在真有流量（或速度尚未衰减掉）时推给界面，空闲时安静 */
function netTick() {
  const now = Date.now();
  const dt = Math.max(0.001, (now - netLastT) / 1000);
  const inst = Math.max(0, (netStat.real - netLastReal) / dt);
  netLastReal = netStat.real; netLastT = now;
  netBps = netBps ? netBps * 0.55 + inst * 0.45 : inst;   /* EMA 平滑，避免数字乱跳 */
  if (netBps < 4096) netBps = 0;   /* 低于 4KB/s 视为断了：既不显示 0.0 MB/s，也不给出天文数字的剩余时间 */
  if (netBps > 0) send('install:speed', netSnap());
}
function setStatus(text, busy) { send('app:status', { text: text || '就绪', busy: !!busy }); }

/* ---------------- 日志落盘 ---------------- */
/* 自测进程（HEADLESS）不往用户数据目录写日志：否则跑一次测试就污染用户的 logs/latest.log、
   diagnostics/boot.json（曾经因此把用户真实的崩溃时间线覆盖掉，排查时被误导）。 */
const LOG_DIR = HEADLESS
  ? path.join(os.tmpdir(), 'xlc-smoke-data-' + process.pid, 'logs')
  : path.join(DATA_DIR, 'logs');
function logLine(s) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'latest.log'),
      '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + s + '\n');
  } catch (_) {}
}

function toast(msg, type) { logLine('[toast:' + (type || 'ok') + '] ' + msg); send('app:toast', { msg, type: type || 'ok' }); }

/* ---------------- HTTP ---------------- */
const UA_STR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 XLC/' + APP_VERSION;
async function fetchBuf(url, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': UA_STR }, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
  return Buffer.from(await res.arrayBuffer());
}
/* 写入流错误守门：createWriteStream 若写入失败（磁盘满 ENOSPC / 权限 EACCES / 路径被占用），
   只在流上 emit 'error'——没有监听者时 Promise 会永远卡在 drain/end 上（界面表现为进度条永久卡住）。
   这里把 error 收敛成"可 race 的拒绝"，让下载链路照常走失败清理（unlink tmp）。 */
function wsErrGuard(ws) {
  let fail = null;
  const waiters = [];
  ws.on('error', e => { fail = e; while (waiters.length) waiters.shift()(e); });
  return {
    /* 用 race 包住 drain/end 等待：流一报错立刻失败 */
    wait: (pr) => Promise.race([
      pr,
      new Promise((_, rej) => { if (fail) return rej(fail); waiters.push(rej); })
    ])
  };
}
/* 先下到 .xlc-tmp 临时文件，校验通过后原子改名到最终位置——
   取消/断网/校验失败都不会在 versions/、mods/ 等最终位置留下半截文件 */
async function downloadSingle(url, dest, onProgress, signal, opts) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.xlc-tmp';
  const res = await fetch(url, { headers: { 'User-Agent': UA_STR }, redirect: 'follow', signal });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const ws = fs.createWriteStream(tmp);
  const guard = wsErrGuard(ws);
  const reader = res.body.getReader();
  let got = 0, lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      netAddReal(value.length);   /* 计入实时流量（界面速度显示 + 阶段剩余时间） */
      await speedThrottle(value.length);   /* 限速（设置 → 下载 → 速度限制；0 = 不限速） */
      if (!ws.write(value)) await guard.wait(new Promise(r => ws.once('drain', r)));
      if (onProgress) { /* total 未知时也上报（pct=-1），否则上层"首字节看门狗"会误判 0 字节中止 */
        const pct = total ? Math.floor(got / total * 100) : -1;
        if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total); }
      }
    }
    await guard.wait(new Promise(r => ws.end(r)));
  } catch (e) {
    try { ws.destroy(); } catch (_) {}
    try { await fsp.unlink(tmp); } catch (_) {}
    throw e;
  }
  if (total && got !== total && !(opts && opts.noLenCheck)) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw new Error('下载不完整 ' + got + '/' + total);
  }
  await fsp.rename(tmp, dest);
  return got;
}

/* PCL 式多线程分块下载：Range 探测 → N 段并行 → 每段独立重试断点续传。
   任一环节不支持/失败（abort 除外）→ 抛错由上层自动回退单流 */
const MT_SEG_BYTES = 4 * 1024 * 1024; // 每段约 4MB
/* 多线程分段的最小文件体积：低于它的文件单流更快（探测 Range 也要一个来回） */
const MT_MIN_BYTES = 8 * 1024 * 1024;
async function downloadMultiThread(url, dest, onProgress, signal) {
  /* 1. Range 支持探测 */
  const probe = await fetch(url, { headers: { 'User-Agent': UA_STR, Range: 'bytes=0-0' }, redirect: 'follow', signal });
  try { await probe.body.cancel(); } catch (_) {}
  if (probe.status !== 206) throw new Error('RANGE_UNSUPPORTED (HTTP ' + probe.status + ')');
  const cm = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
  if (!cm) throw new Error('RANGE_UNSUPPORTED (no content-range)');
  const total = parseInt(cm[1], 10);
  if (!(total > 0)) throw new Error('RANGE_UNSUPPORTED (total=' + total + ')');
  /* 2. 分段：线程数可配置（config.dlThreads），每 4MB 一段，上限 64 */
  const wantThreads = Math.min(Math.max(parseInt(config.dlThreads, 10) || 16, 1), 64);
  const segCount = Math.max(1, Math.min(wantThreads, Math.ceil(total / MT_SEG_BYTES)));
  const segSize = Math.ceil(total / segCount);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  /* 预分配临时文件（.xlc-tmp），全部段写完并校验通过后才改名到最终位置 */
  const tmp = dest + '.xlc-tmp';
  const fd = await fsp.open(tmp, 'w');
  await fd.truncate(total);
  await fd.close();
  const segGot = new Array(segCount).fill(0);
  let aborted = false, lastPct = -1;
  const onAbort = () => { aborted = true; };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const report = () => {
    if (!onProgress) return;
    let got = 0; for (const g of segGot) got += g;
    const pct = Math.floor(got / total * 100);
    if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total); }
  };
  async function fetchSeg(i) {
    const start = i * segSize, end = Math.min(total, start + segSize) - 1;
    if (start > end) return;
    let got = segGot[i];
    for (;;) { /* 连接被提前掐断时从中断处续传 */
      if (aborted) throw new Error('aborted');
      const res = await fetch(url, { headers: { 'User-Agent': UA_STR, Range: 'bytes=' + (start + got) + '-' + end }, redirect: 'follow', signal });
      /* 分段必须拿到 206：若服务器无视 Range 回 200，body 从 0 开始，写进分段会损坏文件 */
      if (res.status !== 206) throw new Error('RANGE_UNSUPPORTED (HTTP ' + res.status + ' seg ' + i + ')');
      const ws = fs.createWriteStream(tmp, { flags: 'r+', start: start + got });
      const guard = wsErrGuard(ws);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) throw new Error('aborted');
          got += value.length; segGot[i] = got;
          netAddReal(value.length);   /* 多线程分段同样计入实时流量 */
          await speedThrottle(value.length);   /* 限速（0 = 不限速；分段并发时按段各自扣令牌） */
          if (!ws.write(value)) await guard.wait(new Promise(r => ws.once('drain', r)));
          report();
        }
      } finally {
        try { await reader.cancel(); } catch (_) {}
        await guard.wait(new Promise(r => ws.end(r)));
      }
      if (start + got >= end + 1) return;
      if (got === 0) throw new Error('分段 ' + i + ' 无数据返回');
    }
  }
  try {
    await Promise.all(Array.from({ length: segCount }, (_, i) =>
      (async () => {
        for (let a = 0; a < 3; a++) {
          try { await fetchSeg(i); return; }
          catch (e) {
            if (aborted || (signal && signal.aborted)) throw new Error('aborted');
            if (a === 2) throw new Error('分段 ' + i + ' 重试 3 次仍失败: ' + e.message);
            await new Promise(r => setTimeout(r, 400 * (a + 1)));
          }
        }
      })()
    ));
    if (signal) signal.removeEventListener('abort', onAbort);
    if (aborted) throw new Error('aborted');
    const gotAll = segGot.reduce((a, b) => a + b, 0);
    report();
    if (gotAll !== total) throw new Error('下载不完整 ' + gotAll + '/' + total);
    await fsp.rename(tmp, dest);
    return gotAll;
  } catch (e) {
    /* 失败/取消：清掉临时文件，绝不在最终位置留半截文件 */
    if (signal) signal.removeEventListener('abort', onAbort);
    try { await fsp.unlink(tmp); } catch (_) {}
    throw e;
  }
}

/* 对外入口：先试多线程，失败自动回退单流（全站生效：客户端 jar / Forge 安装器 / CF 下载等） */
async function downloadBig(url, dest, onProgress, signal, opts) {
  try {
    return await downloadMultiThread(url, dest, onProgress, signal);
  } catch (e) {
    if (signal && signal.aborted) throw new Error('已取消');
    logLine('[download] 多线程下载回退单流: ' + String(url).slice(0, 120) + ' · ' + e.message);
    return downloadSingle(url, dest, onProgress, signal, opts);
  }
}
async function fetchJson(url, signal) { return JSON.parse((await fetchBuf(url, signal)).toString('utf8')); }

function mapUrl(u) {
  if (config.source === 'custom' && config.customSource) {
    const base = config.customSource.replace(/\/+$/, '');
    return u
      .replace('https://piston-meta.mojang.com', base)
      .replace('https://launchermeta.mojang.com', base);
  }
  if (config.source === 'bmclapi') {
    return u
      .replace('https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com')
      .replace('https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com')
      .replace('https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com')
      .replace('https://launcher.mojang.com', 'https://bmclapi2.bangbang93.com')
      .replace('https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets');
  }
  return u;
}
const MANIFEST_URL = {
  official: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  bmclapi: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
};

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
/* 大文件算 SHA1 走流式，别把整个 client.jar 读进内存 */
function sha1File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p)
      .on('data', d => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

/* downloadTo(url, dest, expectSha1, signal, sizeHint)：
   第 3 参是 SHA1，不是进度回调；第 5 参 sizeHint = 调用方已知的文件大小（版本 json 里都有），
   ≥8MB 时自动升级为多线程分段下载 —— 「30 分钟才下载完一个游戏」的主因就是
   client.jar 这类大文件此前一直走单流。 */
async function downloadTo(url, dest, expectSha1, signal, sizeHint) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    const st = await fsp.stat(dest);
    if (st.isFile() && st.size > 0) {
      if (!expectSha1) { netAddSkip(st.size); return 0; }        /* 无校验值：已有文件直接用 */
      if (await sha1File(dest) === expectSha1) { netAddSkip(st.size); return 0; }
    }
  } catch (_) {}
  /* 流式下载（原来用 fetchBuf 把整个文件读进内存 —— 下 client.jar 那几十秒里进度一动不动，
     界面只能拿百分比硬算速度，于是出现「预计剩余 1 秒」还永不变化的假象）。
     noLenCheck：服务端若做了 gzip，content-length 与解压后字节数不等，交给 SHA1 兜底校验。
     signal：安装任务的 AbortController —— 用户点「停止安装」时立刻打断进行中的 fetch，
     而不是等这个文件下完才在下一个检查点生效。abort 引发的失败统一改标 cancelled，
     这样 runPool 立即中止整个池、调度层也走「已取消」分支而不是「安装失败」。 */
  let got;
  try {
    /* 大文件（调用方给了 sizeHint 且 ≥ MT_MIN_BYTES）走多线程分段（downloadBig 内部失败自动回退单流）；
       小文件直接单流 —— 资源文件平均只有十几 KB，发 Range 探测纯亏 */
    got = (sizeHint && sizeHint >= MT_MIN_BYTES)
      ? await downloadBig(mapUrl(url), dest, null, signal, { noLenCheck: true })
      : await downloadSingle(mapUrl(url), dest, null, signal, { noLenCheck: true });
  } catch (e) {
    if (signal && signal.aborted) {
      const ce = new Error('安装已被用户取消');
      ce.cancelled = true;
      throw ce;
    }
    throw e;
  }
  if (expectSha1 && await sha1File(dest) !== expectSha1) {
    try { await fsp.unlink(dest); } catch (_) {}
    throw new Error('SHA1 校验失败: ' + url);
  }
  return got;
}

/* 文件级并发池大小（设置 → 下载 → 文件并发数）：默认 32，可 4~64。
   依赖库 / 资源文件是「几千个小文件」的批量下载，瓶颈在单连接往返延迟，
   池子开大一点吞吐立刻上去（PCL 的批量下载同样是几十个文件同时在跑）。 */
function dlPoolSize() { return Math.min(Math.max(parseInt(config.dlConcurrency, 10) || 32, 4), 64); }
/* 并发池（带进度与容错）。worker 抛出 e.cancelled=true 的错误时立即中止整个池 */
async function runPool(items, limit, worker, onProgress) {
  let idx = 0, done = 0;
  const failed = [];
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { await worker(items[i]); }
      catch (e) {
        if (e && e.cancelled) throw e; /* 用户取消：不再吞进 failed，立刻终止池 */
        failed.push({ item: String(items[i] && items[i].path || i), error: e.message });
      }
      done++;
      if (onProgress && (done % 5 === 0 || done === items.length)) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return failed;
}

/* ---------------- ZIP 解压（提取 natives dll） ---------------- */
function extractZipEntries(zipBuf, outDir, filterFn) {
  // 定位 EOCD
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 ZIP 文件');
  let count = zipBuf.readUInt16LE(eocd + 10);
  let pos = zipBuf.readUInt32LE(eocd + 16);
  let extracted = 0;
  for (let n = 0; n < count; n++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const cSize = zipBuf.readUInt32LE(pos + 20);
    const uSize = zipBuf.readUInt32LE(pos + 24);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const cmtLen = zipBuf.readUInt16LE(pos + 32);
    const lho = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + cmtLen;
    if (filterFn && !filterFn(name, uSize)) continue;
    const lNameLen = zipBuf.readUInt16LE(lho + 26);
    const lExtraLen = zipBuf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = zipBuf.slice(dataStart, dataStart + cSize);
    const out = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    /* zip-slip 防护：条目名来自 zip 中央目录，可能含 ../ 或绝对路径；
       规范化后必须仍落在 outDir 之内，否则跳过（natives 里不该出现这种条目） */
    const rootAbs = path.resolve(outDir);
    const dest = path.resolve(rootAbs, name.replace(/\//g, path.sep));
    if (dest !== rootAbs && !dest.startsWith(rootAbs + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    extracted++;
  }
  return extracted;
}

/* ---------------- ZIP 写入 / 定点读取（整合包导出导入，实现见 zipio.js） ---------------- */
const { buildZip, findZipEntries, zipReadEntry, extractZipPrefix, crc32, listZipNames } = require('./zipio');
/* 版本名清洗：仅字母数字与 . _ -（防路径穿越） */
function sanitizeVersionId(s) {
  const v = String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 60);
  return v;
}
/* 把已安装版本目录改名（Forge/NeoForge 安装器产物固定名，需要改名以支持自定义版本名） */
async function renameInstalledVersion(oldId, newName) {
  const vd = path.join(config.gameDir, 'versions', oldId);
  const nv = path.join(config.gameDir, 'versions', newName);
  if (!fs.existsSync(vd) || fs.existsSync(nv)) throw new Error('版本重命名失败: ' + oldId + ' → ' + newName);
  const jsonFile = path.join(vd, oldId + '.json');
  const json = JSON.parse(await fsp.readFile(jsonFile, 'utf8'));
  json.id = newName;
  try { await fsp.rename(path.join(vd, oldId + '.jar'), path.join(vd, newName + '.jar')); } catch (_) {} /* Fabric 等继承版本无本地 jar */
  await fsp.writeFile(path.join(vd, newName + '.json'), JSON.stringify(json, null, 2));
  await fsp.unlink(jsonFile);
  await fsp.rename(vd, nv);
  return newName;
}

/* ---------------- 版本清单 ---------------- */
async function findInManifest(id) {
  const j = await getManifestInner();
  const v = j.versions.find(v => v.id === id);
  if (!v) throw new Error('版本清单中不存在: ' + id);
  return v;
}
async function getManifestInner() {
  const order = config.source === 'official' ? ['official', 'bmclapi'] : ['bmclapi', 'official'];
  let lastErr = null;
  for (const key of order) {
    try { return await fetchJson(MANIFEST_URL[key]); }
    catch (e) { lastErr = e; }
  }
  throw new Error('版本清单获取失败（官方源与镜像源均不可达）: ' + (lastErr && lastErr.message));
}

/* ---------------- 库/规则处理 ---------------- */
function rulePass(rules, features) {
  if (!rules || !rules.length) return true;
  features = features || {};
  let allow = false;
  for (const r of rules) {
    const osOk = !r.os || r.os.name === 'windows';
    // features 条件：声明的 feature 与启用集不匹配 → 该规则不适用（不得改变 allow 状态）
    // 否则 --demo / --width ${resolution_width} 等演示与快捷进入参数会被错误注入启动命令
    if (r.features) {
      let featOk = true;
      for (const k of Object.keys(r.features)) {
        if (!!features[k] !== !!r.features[k]) { featOk = false; break; }
      }
      if (!featOk) continue;
    }
    if (r.action === 'allow' && osOk) allow = true;
    else if (r.action === 'disallow' && osOk) allow = false;
  }
  return allow;
}
// Maven 坐标 -> {url, path}
function mavenArtifact(name, urlBase) {
  const parts = name.split(':');
  const g = parts[0], a = parts[1], v = parts[2], c = parts[3];
  const file = a + '-' + v + (c ? '-' + c : '') + '.jar';
  const p = g.replace(/\./g, '/') + '/' + a + '/' + v + '/' + file;
  const base = (urlBase || 'https://repo1.maven.org/maven2/').replace(/\/?$/, '/');
  return { name, downloads: { artifact: { url: base + p, path: p } } };
}

/* ---------------- 实例目录完整性（统一"已安装"口径） ----------------
 * 界面判定"已安装"的唯一数据源是 dir:scan，它要求 versions/<id>/<id>.json 存在且可解析。
 * 但安装入口过去只用 fs.existsSync(versions/<id>) 判断，于是会出现这种两头堵的死局：
 *   目录存在但 JSON 缺失/损坏（上次安装被中断、其它启动器残留、手动复制了半个目录）
 *   → 主页列表里看不到这个版本，点安装又被"版本名已存在"拦住，用户自己永远修不好。
 * 这里统一口径：ok = 真已安装 / partial = 残留（自动归档后继续安装）/ none = 可直接安装 */
function instanceStateOf(gd, id) {
  const dir = path.join(gd, 'versions', id);
  let st;
  try { st = fs.statSync(dir); } catch (_) { return { state: 'none' }; }
  if (!st.isDirectory()) return { state: 'partial', reason: '同名文件（不是目录）' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { state: 'partial', reason: '版本 JSON 内容异常' };
    return { state: 'ok' };
  } catch (_) {
    return { state: 'partial', reason: '缺少或损坏的 ' + id + '.json' };
  }
}
/* 安装前清理目标位置：残留目录自动归档（改名保留，绝不删用户文件）；已安装则给出可操作提示。
 * force=true（界面「再装一份」）表示允许覆盖已安装实例，用于重装修复损坏的实例 */
function prepareInstallSlot(gd, id, force) {
  const r = instanceStateOf(gd, id);
  if (r.state === 'none') return;
  if (r.state === 'ok') {
    if (force) { logLine('[install] 「' + id + '」重装覆盖（用户选择再装一份）'); return; }
    throw new Error('「' + id + '」已经安装过了 —— 回到主页选中它就能直接启动；' +
      '想再装一份请在安装弹窗的「版本名称」里填一个不同的名字；想重装修复请在下载页点该版本的「再装一份」');
  }
  const bak = id + '.__broken-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const from = path.join(gd, 'versions', id), to = path.join(gd, 'versions', bak);
  try {
    fs.renameSync(from, to);
  } catch (e) {
    throw new Error('实例目录「' + id + '」不完整（' + r.reason + '）且无法自动归档（' + e.message + '），' +
      '请手动删除该目录后重试：' + from);
  }
  logLine('[install] 「' + id + '」存在不完整残留（' + r.reason + '），已归档为 ' + bak + '，继续安装');
  toast('发现「' + id + '」上次未安装完成的残留目录，已自动归档（' + bak + '），正在重新安装', 'warn');
}

/* ---------------- 安装：原版 ---------------- */
/* opt.noAssets: 跳过资源文件与 natives（加载器安装预热用，启动前不需要）
 * cancelKey + signal: 前者是阶段/worker 边界的检查点，后者直接打断进行中的 fetch（「停止安装」立即生效） */
async function installVanillaFiles(meta, gameId, opt, cancelKey, signal) {
  opt = opt || {};
  const gd = config.gameDir;
  const vd = path.join(gd, 'versions', gameId);
  await fsp.mkdir(vd, { recursive: true });
  chkCancel(cancelKey);

  // 1. 版本 JSON（内容先留在内存，所有下载完成后再落盘——
  //    避免取消/中断后留下「有 json 没 jar」的半截目录被误判为已安装）
  setStatus('获取版本清单: ' + gameId, true);
  phaseBegin('json', 0);
  send('install:progress', { stage: 'json', percent: 2, text: '下载版本清单' });
  const vjson = await fetchJson(mapUrl(meta.url), signal);
  vjson.id = gameId; // 支持自定义版本名：json.id 必须与目录/文件名一致

  // 2. 客户端 jar
  chkCancel(cancelKey);
  if (vjson.downloads && vjson.downloads.client) {
    const c = vjson.downloads.client;
    phaseBegin('client', c.size || 0);
    send('install:progress', { stage: 'client', percent: 5, text: '下载客户端 client.jar' });
    setStatus('下载客户端: ' + gameId, true);
    await downloadTo(c.url, path.join(vd, gameId + '.jar'), c.sha1, signal, c.size);
  }

  // 3. libraries
  chkCancel(cancelKey);
  const libs = (vjson.libraries || []).filter(l => rulePass(l.rules) && l.downloads && l.downloads.artifact);
  let libDone = 0;
  phaseBegin('libraries', libs.reduce((s, l) => s + (l.downloads.artifact.size || 0), 0));
  setStatus('下载依赖库 (0/' + libs.length + ')', true);
  const libFails = await runPool(libs, dlPoolSize(), async (l) => {
    chkCancel(cancelKey);
    const a = l.downloads.artifact;
    await downloadTo(a.url, path.join(gd, 'libraries', a.path), a.sha1, signal, a.size);
    libDone++;
    send('install:progress', { stage: 'libraries', current: libDone, total: libs.length, percent: 8 + Math.round(libDone / libs.length * 22), text: '依赖库 ' + libDone + '/' + libs.length });
  }, (d, t) => {
    send('install:progress', { stage: 'libraries', current: d, total: t, percent: 8 + Math.round(d / t * 22), text: '依赖库 ' + d + '/' + t });
  });
  if (libFails.length) throw new Error(libFails.length + ' 个依赖库下载失败，例如 ' + libFails[0].item);

  // 4. assetIndex + assets（noAssets 预热模式跳过：启动时再补）
  chkCancel(cancelKey);
  if (vjson.assetIndex && !opt.noAssets) {
    const ai = vjson.assetIndex;
    phaseBegin('assets-index', ai.size || 0);
    send('install:progress', { stage: 'assets-index', percent: 32, text: '下载资源索引' });
    const idxPath = path.join(gd, 'assets', 'indexes', ai.id + '.json');
    await downloadTo(ai.url, idxPath, ai.sha1, signal, ai.size);
    const idx = JSON.parse(await fsp.readFile(idxPath, 'utf8'));
    const objects = Object.entries(idx.objects || {});
    let aDone = 0;
    phaseBegin('assets', objects.reduce((s, [, o]) => s + (o.size || 0), 0));
    setStatus('下载资源文件 (0/' + objects.length + ')', true);
    const aFails = await runPool(objects, dlPoolSize(), async ([_name, o]) => {
      chkCancel(cancelKey);
      const url = 'https://resources.download.minecraft.net/' + o.hash.slice(0, 2) + '/' + o.hash;
      const dest = path.join(gd, 'assets', 'objects', o.hash.slice(0, 2), o.hash);
      await downloadTo(url, dest, o.hash, signal, o.size);
      aDone++;
      if (aDone % 25 === 0) send('install:progress', { stage: 'assets', current: aDone, total: objects.length, percent: 32 + Math.round(aDone / objects.length * 62), text: '资源文件 ' + aDone + '/' + objects.length });
    }, (d, t) => {
      send('install:progress', { stage: 'assets', current: d, total: t, percent: 32 + Math.round(d / t * 62), text: '资源文件 ' + d + '/' + t });
    });
    if (aFails.length) toast(aFails.length + ' 个资源文件下载失败，启动器将在下次安装时重试', 'warn');
  }

  // 5. natives
  chkCancel(cancelKey);
  if (!opt.noAssets) {
  send('install:progress', { stage: 'natives', percent: 96, text: '解压本地库 natives' });
  const nativesDir = path.join(vd, 'natives');
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });
  const nativeLibs = (vjson.libraries || []).filter(l => rulePass(l.rules) && l.natives && l.natives.windows && l.downloads && l.downloads.classifiers);
  for (const l of nativeLibs) {
    chkCancel(cancelKey);
    const classifier = l.natives.windows.replace('${arch}', os.arch() === 'x64' ? '64' : '32');
    const c = l.downloads.classifiers[classifier] || l.downloads.classifiers['natives-windows'];
    if (!c) continue;
    const jarPath = path.join(gd, 'libraries', c.path);
    if (!fs.existsSync(jarPath)) await downloadTo(c.url, jarPath, c.sha1, signal, c.size);
    extractZipEntries(await fsp.readFile(jarPath), nativesDir, n => n.endsWith('.dll') && !n.startsWith('META-INF'));
  }
  }
  // 6. 全部就绪后才落盘版本 JSON
  await fsp.writeFile(path.join(vd, gameId + '.json'), JSON.stringify(vjson, null, 2));
  if (!opt.noAssets) send('install:progress', { stage: 'done', percent: 100, text: '安装完成' });
}

/* ---------------- 安装：Fabric / Quilt（元数据组装） ---------------- */
async function installFabricLike(gameVer, kind, customName, opt) {
  const gd = config.gameDir;
  const meta = await findInManifest(gameVer);
  const api = kind === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/loader/' : 'https://meta.quiltmc.org/v3/versions/loader/';
  setStatus('获取 ' + (kind === 'fabric' ? 'Fabric' : 'Quilt') + ' 元数据…', true);
  send('install:progress', { stage: 'loader', percent: 4, text: '获取加载器元数据' });

  const list = await fetchJson(api + gameVer, opt && opt.signal);
  if (!list || !list.length) throw new Error((kind === 'fabric' ? 'Fabric' : 'Quilt') + ' 尚未提供 ' + gameVer + ' 的构建');
  /* opt.build = 用户在「选择版本」下拉里指定的加载器版本（如 0.16.5）。
     元数据第一项就是最新版（上游按新→旧返回），不指定时沿用旧行为取最新。
     指定了却匹配不上必须报错 —— 静默装成最新版等于「选了不生效」。 */
  const wantLoader = String((opt && opt.build) || '').trim();
  let pick = list[0];
  if (wantLoader) {
    const hit = list.find(x => x && x.loader && String(x.loader.version) === wantLoader);
    if (!hit) throw new Error((kind === 'fabric' ? 'Fabric' : 'Quilt') + ' 未找到加载器版本 ' + wantLoader +
      '（' + gameVer + ' 可用: ' + list.slice(0, 3).map(x => x.loader && x.loader.version).filter(Boolean).join(' / ') + ' …）');
    pick = hit;
  }
  const lm = pick.launcherMeta;
  const loaderVer = pick.loader.version;
  const versionId = sanitizeVersionId(customName) || (gameVer + '-' + kind + '-' + loaderVer);
  if (instanceStateOf(gd, versionId).state !== 'none') prepareInstallSlot(gd, versionId, !!(opt && opt.force));
  const mavenBase = kind === 'fabric' ? 'https://maven.fabricmc.net/' : 'https://maven.quiltmc.org/repository/release/';

  const libs = [];
  const seenLib = new Set();
  const pushLib = (l) => {
    if (!l || !l.name) return;
    const a = mavenArtifact(l.name, l.url);
    if (seenLib.has(a.downloads.artifact.path)) return;
    seenLib.add(a.downloads.artifact.path);
    libs.push(a);
  };
  if (pick.intermediary && pick.intermediary.maven) pushLib({ name: pick.intermediary.maven, url: mavenBase });
  /* loader 自带库（Fabric/Quilt 元数据里可能是数组） */
  for (const l of (pick.loader && Array.isArray(pick.loader.libraries) ? pick.loader.libraries : [])) pushLib(l);
  /* launcherMeta.libraries：Fabric v2 / Quilt v3 现返回 {client, common, server, development} 对象，
   * 旧版是数组——两种形态都兼容（取 client+common，客户端启动所需） */
  const lml = lm.libraries || {};
  const lmlArr = Array.isArray(lml) ? lml : [].concat(lml.client || [], lml.common || []);
  for (const l of lmlArr) pushLib(l);

  // 父版本资源必须齐全
  chkCancel(opt && opt.cancelKey);
  await installVanillaFiles(meta, gameVer, {}, opt && opt.cancelKey, opt && opt.signal);

  const vd = path.join(gd, 'versions', versionId);
  await fsp.mkdir(vd, { recursive: true });
  const n = libs.length;
  let i = 0;
  phaseBegin('loader-libs', libs.reduce((s, l) => s + ((l.downloads.artifact && l.downloads.artifact.size) || 0), 0));
  const fails = await runPool(libs, dlPoolSize(), async (l) => {
    chkCancel(opt && opt.cancelKey);
    const a = l.downloads.artifact;
    await downloadTo(a.url, path.join(gd, 'libraries', a.path), a.sha1 || null, opt && opt.signal, a.size);
    i++;
    send('install:progress', { stage: 'loader-libs', current: i, total: n, percent: 50 + Math.round(i / n * 45), text: '加载器依赖 ' + i + '/' + n });
  });
  if (fails.length) throw new Error(fails.length + ' 个加载器依赖下载失败');

  const vjson = {
    id: versionId,
    inheritsFrom: gameVer,
    releaseTime: new Date().toISOString(),
    time: new Date().toISOString(),
    type: 'release',
    mainClass: (lm.mainClass && lm.mainClass.client) || pick.loader.mainClass,
    libraries: libs
  };
  await fsp.writeFile(path.join(vd, versionId + '.json'), JSON.stringify(vjson, null, 2));
  send('install:progress', { stage: 'done', percent: 100, text: '安装完成' });
  return versionId;
}

/* ---------------- 安装：Forge / NeoForge（官方安装器静默安装） ---------------- */
/* 安装器只需「有 Java 能跑起来」；本机一个都没有时自动下载安装（按目标版本所需的大版本） */
async function requireJavaAny(major) {
  const j = await resolveJavaFor(major || 17, null, 'Forge / NeoForge 安装器');
  return j.path;
}
/* 安装器依赖预热：解析安装器 jar 内 install_profile.json / version.json 的库清单，
 * 以及 install_profile.json 里 processors 的工具 jar 与 classpath（guava/SpecialSource/
 * opencsv/commons-beanutils 等——安装器内部执行步骤用，不在 libraries 清单里，最易漏下），
 * 全部经 BMCLAPI 镜像预下载到 libraries/。安装器对本地已存在且校验一致的库会跳过下载，
 * 从而避开其内置下载走 Mojang/Forge 官方源在境内被拖慢/卡死的问题。
 * 返回 {total, failed}：失败会写日志，调用方据此决定是否重试 */
async function preheatInstallerLibs(jarPath, gameDir, onProgress, signal) {
  let zipBuf = null;
  try { zipBuf = await fsp.readFile(jarPath); } catch (_) { return { total: 0, failed: 0 }; }
  const wanted = [];
  const seen = new Set();
  const pushLib = (l) => {
    if (!l) return;
    const art = l.downloads && l.downloads.artifact;
    let p = null, sha1 = null;
    if (art && art.path) { p = art.path; sha1 = art.sha1 || null; }
    else if (l.name && l.name.split(':').length >= 3) p = mavenArtifact(l.name, '').downloads.artifact.path;
    if (p && !seen.has(p)) { seen.add(p); wanted.push({ path: p, sha1 }); }
  };
  const pushCoord = (coord) => {
    const c = String(coord || '').trim();
    if (c.split(':').length >= 3) {
      const p = mavenArtifact(c, '').downloads.artifact.path;
      if (p && !seen.has(p)) { seen.add(p); wanted.push({ path: p, sha1: null }); }
    }
  };
  let profile = null;
  for (const key of ['install_profile.json', 'version.json']) {
    try {
      const j = JSON.parse(zipReadEntry(zipBuf, key).toString('utf8'));
      if (key === 'install_profile.json') profile = j;
      for (const l of (j.libraries || [])) pushLib(l);
    } catch (_) {}
  }
  /* processors：安装器内部工具链（jar 本体 + classpath 依赖），官方源直连最易失败的一批 */
  for (const pr of ((profile && profile.processors) || [])) {
    pushCoord(pr.jar);
    for (const c of (pr.classpath || [])) pushCoord(c);
  }
  if (!wanted.length) return { total: 0, failed: 0 };
  const total = wanted.length;
  const failedList = [];
  let done = 0;
  await runPool(wanted, 10, async (l) => {
    try { await downloadTo('https://bmclapi2.bangbang93.com/maven/' + l.path, path.join(gameDir, 'libraries', l.path), l.sha1, signal); }
    catch (e) { failedList.push(l.path + ' · ' + e.message); }
    done++;
    if (onProgress) onProgress(done, total);
  });
  if (failedList.length) logLine('[preheat] ' + failedList.length + '/' + total + ' 个安装器依赖预热失败（安装器将自行下载）: ' + failedList.slice(0, 5).join(' ; '));
  return { total, failed: failedList.length };
}
/* 预热 + 一轮失败重试（NeoForge/Forge 共用）：processors 工具链在境内直连官方源极易失败，
 * 预热失败库会让安装器内置下载走官方源导致整装失败（退出码 1），所以重试一轮显著降低失败率 */
async function preheatInstallerLibsRetry(jarPath, gameDir, onProgress, signal) {
  const r1 = await preheatInstallerLibs(jarPath, gameDir, onProgress, signal);
  if (r1.failed > 0) {
    logLine('[preheat] 3 秒后重试预热失败的 ' + r1.failed + ' 个依赖…');
    await new Promise(r => setTimeout(r, 3000));
    const r2 = await preheatInstallerLibs(jarPath, gameDir, onProgress, signal);
    return { total: r1.total, failed: r2.failed };
  }
  return r1;
}
/* DownloadMojmaps 预热：Forge 安装器的 DOWNLOAD_MOJMAPS 步骤要从 launchermeta + piston-data
 * 直连下载 Mojang 反混淆映射（境内必超时，是「Forge 装到一半退出码 1」的最常见根因，
 * 日志特征 java.net.ConnectException at DownloadMojmaps.process）。
 * 处理两件事：
 *   ① 从镜像预下 mappings 到安装器期望的 libraries/ 路径（复用 downloadTo：多线程 + sha1 校验）；
 *   ② 改写安装器 jar 内 install_profile.json，给 DOWNLOAD_MOJMAPS 步骤加 --skipIfExists ——
 *      不加的话该步骤发现文件已存在仍会强制联网重下（实测 Skip: false）。
 * 任何一步失败只写日志不阻断：安装器行为退化为从前（自己联网，失败了报退出码 1）。
 * NeoForge 等没有 DOWNLOAD_MOJMAPS 步骤的安装器在此直接返回。 */
async function preheatMojmaps(jarPath, gameDir, mcVer, signal) {
  let zipBuf = null;
  try { zipBuf = await fsp.readFile(jarPath); } catch (_) { return; }
  let profile = null;
  try { profile = JSON.parse(zipReadEntry(zipBuf, 'install_profile.json').toString('utf8')); } catch (_) { return; }
  const procs = (profile && profile.processors) || [];
  if (!procs.some(pr => (pr.args || []).includes('DOWNLOAD_MOJMAPS'))) return;
  /* {MOJMAPS} token 形如 [net.minecraft:client:1.20.1-20230612.114412:mappings@txt]
   * → maven 坐标 → libraries 相对路径（与安装器自己的坐标展开规则一致） */
  const tok = profile.data && profile.data.MOJMAPS && profile.data.MOJMAPS.client;
  const m = String(tok || '').match(/^\[([^@\]]+?)(?:@([A-Za-z0-9]+))?\]$/);
  if (!m) return;
  const parts = m[1].split(':');
  if (parts.length < 3) return;
  const [grp, art, ver] = parts, cls = parts[3] || '';
  const relPath = grp.replace(/\./g, '/') + '/' + art + '/' + ver + '/' +
    art + '-' + ver + (cls ? '-' + cls : '') + '.' + (m[2] || 'jar');
  const dest = path.join(gameDir, 'libraries', relPath);
  /* ① 预下 mappings：版本 JSON 走镜像清单，文件 URL 先镜像后官方 */
  try {
    const meta = await findInManifest(mcVer);
    const vj = await fetchJson(mapUrl(meta.url), signal);
    const cm = vj.downloads && vj.downloads.client_mappings;
    if (!cm || !cm.url) throw new Error('版本 JSON 缺少 client_mappings');
    let ok = false;
    if (fs.existsSync(dest)) {
      ok = cm.sha1 ? (await sha1File(dest) === cm.sha1) : fs.statSync(dest).size > 0;
    }
    if (!ok) {
      try { await fsp.unlink(dest); } catch (_) {} /* 上次失败的残留文件必须清掉，否则 sha1 永远对不上 */
      const urls = [...new Set([mapUrl(cm.url), cm.url])];
      let done = false, lastErr = null;
      for (const u of urls) {
        try { await downloadTo(u, dest, cm.sha1 || null, signal, cm.size); done = true; break; }
        catch (e) { if (e && e.cancelled) throw e; lastErr = e; }
      }
      if (!done) throw (lastErr || new Error('下载失败'));
    }
    logLine('[mojmaps] 预热完成: ' + relPath);
  } catch (e) {
    if (e && e.cancelled) throw e;
    logLine('[mojmaps] 预热失败（安装器将自行下载，可能因网络失败）: ' + ((e && e.message) || e));
    return;
  }
  /* ② 改写 install_profile.json 加 --skipIfExists（文件已就位时安装器直接跳过该步骤）。
   * 幂等：tmp jar 可能是上次已打过补丁的（downloadTo 对无校验值的文件直接复用），别重复追加 */
  try {
    const needPatch = procs.some(pr => (pr.args || []).includes('DOWNLOAD_MOJMAPS') && !pr.args.includes('--skipIfExists'));
    if (needPatch) {
      const patched = procs.map(pr => (pr.args || []).includes('DOWNLOAD_MOJMAPS')
        ? { ...pr, args: [...pr.args, '--skipIfExists'] } : pr);
      const newJson = Buffer.from(JSON.stringify({ ...profile, processors: patched }), 'utf8');
      const files = [];
      for (const name of listZipNames(zipBuf)) {
        if (name.endsWith('/')) continue; /* 目录条目重建可省，Java 按 name 读条目 */
        files.push({ name, data: name === 'install_profile.json' ? newJson : zipReadEntry(zipBuf, name) });
      }
      await fsp.writeFile(jarPath + '.tmp', buildZip(files));
      await fsp.rename(jarPath + '.tmp', jarPath);
      logLine('[mojmaps] 安装器已打补丁: DOWNLOAD_MOJMAPS 加 --skipIfExists');
    }
  } catch (e) {
    try { await fsp.unlink(jarPath + '.tmp'); } catch (_) {}
    logLine('[mojmaps] 安装器补丁失败（不影响继续安装）: ' + ((e && e.message) || e));
  }
}
async function runInstallerSilently(jarPath, gameDir, label, javaMajor) {
  /* 安装器强制要求 gameDir 已有 launcher_profiles.json，全新目录缺失会导致退出码 1，缺失时生成最小文件 */
  const prof = path.join(gameDir, 'launcher_profiles.json');
  if (!fs.existsSync(prof)) {
    try { await fsp.writeFile(prof, JSON.stringify({ profiles: {} }, null, 2)); } catch (_) {}
  }
  const java = await requireJavaAny(javaMajor);
  setStatus('运行 ' + label + ' 安装器…（可能需要几分钟）', true);
  send('install:progress', { stage: 'installer', percent: 10, text: label + ' 安装器运行中' });
  await new Promise((resolve, reject) => {
    const p = spawn(java, ['-jar', jarPath, '--installClient', gameDir], { cwd: gameDir });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('exit', code => {
      /* 安装器输出全部落盘（退出码非 0 时排障全靠它；此前只带最后 500 字进错误消息，
         多行内容在界面上被截断，等于没日志） */
      logLine('[installer:' + label + '] exit=' + code + ' · 输出 ' + out.length + ' 字节');
      if (out.trim()) {
        const tail = out.trim().split('\n').slice(-40).join('\n');
        logLine('[installer:' + label + '] tail://n' + tail);
      }
      if (code === 0) resolve();
      else reject(new Error(label + ' 安装器退出码 ' + code + '\n' + out.slice(-500)));
    });
  });
}
/* 选 Forge 构建：want 命中则用命中的，否则取最新。
 * 注意 bmclapi 列表是旧→新排序，必须按 build 号排序后取末尾，取 [0] 会拿到最老构建。
 * want 的三种形态都要认（界面「选择版本」下拉里都会出现）：
 *   1) 纯构建号      47.4.23          → 后缀匹配（version 形如 "47.4.23"）
 *   2) 带 MC 前缀    1.7.10-10.13.4.1564 → 整串精确匹配（老版本 bmclapi 的 version 就长这样）
 *   3) build 数字    1564（老式构建号）  → 直接比 build 字段
 * 以前只认 1)，于是老版本选版本会被**静默忽略**、装成最新构建 —— 用户以为选了其实没选。 */
function pickForgeBuild(builds, want) {
  const sorted = [...builds].sort((a, b) => (a.build || 0) - (b.build || 0));
  const w = String(want || '').trim();
  let best = null;
  if (w) {
    best = sorted.find(b => String(b.version || '') === w)
        || sorted.find(b => String(b.version || '').endsWith(w))
        || sorted.find(b => String(b.build || '') === w)
        || null;
  }
  const pick = best || sorted[sorted.length - 1];
  const branch = (pick && pick.branch) ? '-' + pick.branch : '';
  return { best, pick, branch };
}
async function installForge(mcVer, customName, build, signal) {
  setStatus('查询 Forge 构建列表…', true);
  const builds = await fetchJson('https://bmclapi2.bangbang93.com/forge/minecraft/' + mcVer, signal);
  if (!builds || !builds.length) throw new Error('镜像源未找到 ' + mcVer + ' 的 Forge 构建');
  /* build 参数（更改加载器时指定构建）优先；customName 为纯数字时视为构建号（旧逻辑保留） */
  const want = String(build || customName || '').trim();
  const { best, pick, branch } = pickForgeBuild(builds, want);
  /* 显式指定了构建但匹配不上 → 必须报错，不能退回最新（否则「选了版本却装成另一个」） */
  if (build && !best) {
    throw new Error('未找到 Forge 构建 ' + build + '（' + mcVer + ' 可用示例: ' +
      [...builds].sort((a, b) => (b.build || 0) - (a.build || 0)).slice(0, 3).map(x => x.version).join(' / ') + ' …）');
  }
  /* maven 完整版本号：bmclapi 的 version 字段可能不带 MC 前缀（1.20.1 → "47.4.23"），
   * 也可能自带（1.7.10 → "1.7.10-10.13.4.1564"）；maven 路径 + 文件名都要补全并接 branch */
  const buildVer = String(pick.version || pick.build || '');
  const fullVer = buildVer.startsWith(mcVer + '-') ? buildVer : (mcVer + '-' + buildVer);
  const mavenVer = fullVer + branch;
  const url = 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/' + mavenVer + '/forge-' + mavenVer + '-installer.jar';
  const tmp = path.join(os.tmpdir(), 'forge-installer-' + mavenVer + '.jar');
  send('install:progress', { stage: 'installer-dl', percent: 3, text: '下载 Forge 安装器' });
  setStatus('下载 Forge 安装器…', true);
  await downloadTo(url, tmp, null, signal);
  /* 镜像预热：原版 client jar/依赖库 + 安装器自带库，全部走 BMCLAPI，安装器近乎离线秒装 */
  try {
    const meta = await findInManifest(mcVer);
    await installVanillaFiles(meta, mcVer, { noAssets: true }, undefined, signal);
  } catch (e) { if (e && e.cancelled) throw e; /* 预热失败不阻断，安装器自行下载（但取消要照常终止整个任务） */ }
  await preheatInstallerLibsRetry(tmp, config.gameDir, (d, n) => {
    send('install:progress', { stage: 'preheat', percent: 30 + Math.round(d / n * 45), text: '镜像预热安装器依赖 ' + d + '/' + n });
  }, signal);
  try { await preheatMojmaps(tmp, config.gameDir, mcVer, signal); } catch (e) { if (e && e.cancelled) throw e; }
  /* 安装器生成的版本目录名各代不同（如 1.20.1-forge-47.4.23），用安装前后目录差集确定 */
  const vdAll = path.join(config.gameDir, 'versions');
  const before = new Set(await fsp.readdir(vdAll).catch(() => []));
  await runInstallerSilently(tmp, config.gameDir, 'Forge', requiredJavaMajor(mcVer));
  try { await fsp.unlink(tmp); } catch (_) {}
  const after = await fsp.readdir(vdAll).catch(() => []);
  const added = after.filter(d => !before.has(d));
  const installed = added.find(d => /forge/i.test(d)) || added[0] || mavenVer;
  const finalName = sanitizeVersionId(customName && !/^\d+(\.\d+)*$/.test(customName) ? customName : '');
  if (finalName && finalName !== installed) return renameInstalledVersion(installed, finalName);
  return installed;
}
/* 把 OptiFine 以 mod 形式装进指定实例的 mods/ 目录。
 * 返回 { ok:true, file, size, modsDir }；失败抛错。
 * 这是 OptiFine 安装的核心（不再跑官方 GUI 安装器）。 */
async function optifineDropAsMod(mcVer, instName) {
  /* 目标实例必须先存在（mods 丢进不存在的实例毫无意义，且会误造空壳目录） */
  const instDir = path.join(config.gameDir, 'versions', String(instName));
  if (!fs.existsSync(path.join(instDir, String(instName) + '.json'))) {
    throw new Error('目标实例「' + instName + '」不存在，无法放入 OptiFine');
  }
  const builds = await optifineBuildsOf(mcVer);
  if (!builds.length) throw new Error('OptiFine 尚未提供 ' + mcVer + ' 的构建');
  const pick = pickOptifineBuild(builds);
  const type = String(pick.type || '');
  const patch = String(pick.patch || '');
  const fileName = String(pick.filename || ('OptiFine_' + mcVer + '_' + type + '_' + patch + '.jar'));
  const isPreview = /^preview_/i.test(fileName);
  /* 下载直链：BMCLAPI 的 /optifine/<mcver>/<type>/<patch>（不带文件名）
     —— 带 filename 会 404（实测），必须用三段式路径 */
  const url = 'https://bmclapi2.bangbang93.com/optifine/' +
    encodeURIComponent(mcVer) + '/' + encodeURIComponent(type) + '/' + encodeURIComponent(patch);
  /* 最终文件名：用清单里的 filename（去掉 preview_ 前缀更清爽），保证是 .jar */
  const outName = (isPreview ? fileName.replace(/^preview_/i, '') : fileName).replace(/[^\w.\-]/g, '_');
  /* 目标实例的 mods 目录（PCL 版本隔离 → versions/<名>/mods） */
  const modsDir = path.join(instDir, 'mods');
  send('install:progress', { stage: 'installer-dl', percent: 5, text: '下载 OptiFine' + (isPreview ? '（预览版）' : '') });
  setStatus('下载 OptiFine…', true);
  await fsp.mkdir(modsDir, { recursive: true });
  const dest = path.join(modsDir, outName);
  /* downloadTo(url, dest, expectSha1)：第 3 参是 SHA1，不是进度回调。
     OptiFine 的 BMCLAPI 接口不提供校验值，传 null（skip 校验）；
     要进度就得用 downloadSingle。 */
  await downloadSingle(url, dest, (pct) => {
    if (pct >= 0) send('install:progress', { stage: 'installer-dl', percent: 5 + Math.round(pct * 0.85), text: '下载 OptiFine ' + pct + '%' });
  });
  let size = 0;
  try { size = (await fsp.stat(dest)).size; } catch (_) {}
  logLine('[optifine] 已放入 mods: ' + dest + '（' + size + ' 字节）');
  send('install:progress', { stage: 'done', percent: 100, text: 'OptiFine 已放入 ' + instName + ' 的 mods' });
  return { ok: true, file: outName, size, modsDir };
}
/* 安装 OptiFine（以 mod 形式）。
 * 重大认知修正（2026-10-04 实测）：
 *   新版 OptiFine（1.21.x 之后的构建）**本质上就是一个 Forge/NeoForge 模组** ——
 *   安装器 jar 内部就有 META-INF/mods.toml（modLoader="javafml"）+ ModLauncher 的
 *   ITransformationService 服务声明（optifine.OptiFineTransformationService）。
 *   它的官方「安装器」是个 Swing GUI 程序（Main-Class: optifine.InstallerFrame），
 *   在无人值守/无图形环境下调用会卡死在 AWT 初始化（实测 jstack 停在
 *   java.awt.Component$AWTTreeLock）—— 无论 -installClient 还是 QUIET 都绕不过。
 *
 * 所以正确做法不是跑安装器，而是：
 *   1) 确保该版本装了 Forge 或 NeoForge（OptiFine 依赖它，mods.toml 要求 loaderVersion >= 14）
 *   2) 把 OptiFine 的 jar 丢进该实例的 mods/ 目录
 * 这样零 GUI、零挂起，且和玩家手动装法完全一致。
 * 下载源：BMCLAPI 三段式直链（/optifine/<mcver>/<type>/<patch>）。 */
/* 找一个可用的 Forge/NeoForge 实例（OptiFine 的前置加载器）。
   返回 { name, loader } 或 null。优先用户指定的实例名，其次按 mtime 找最新一个。
   【坑】不能用 id / inheritsFrom 判断加载器类型：实例被重命名后（如装成
   QA-OptiFine-Carrier），json 里的 id 和 inheritsFrom 都不再含 "forge" 字样，
   会误判成非 Forge 实例。必须用 detectLoaderOf()（看 libraries / mainClass）。 */
async function findForgeLikeInstance(preferName) {
  const versionsDir = path.join(config.gameDir, 'versions');
  let dirs = [];
  try { dirs = await fsp.readdir(versionsDir); } catch (_) { return null; }
  const loaderOfDir = (d) => {
    try {
      const jp = path.join(versionsDir, d, d + '.json');
      if (!fs.existsSync(jp)) return null;
      const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
      const L = detectLoaderOf(j);
      return (L === 'Forge' || L === 'NeoForge') ? L : null;
    } catch (_) { return null; }
  };
  /* 指定名字：只认这个名字 */
  if (preferName && dirs.includes(preferName)) {
    const L = loaderOfDir(preferName);
    if (L) return { name: preferName, loader: L };
  }
  /* 未指定（或指定的不存在）：挑最近修改过的 Forge/NeoForge 实例 */
  const cands = [];
  for (const d of dirs) {
    const L = loaderOfDir(d);
    if (!L) continue;
    let mt = 0;
    try { mt = (await fsp.stat(path.join(versionsDir, d))).mtimeMs; } catch (_) {}
    cands.push({ name: d, loader: L, mt });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mt - a.mt);
  return { name: cands[0].name, loader: cands[0].loader };
}
/* 安装 OptiFine：不再跑官方安装器，而是「确保有 Forge/NeoForge 实例 → 把 OptiFine 丢进 mods/」。 */
async function installOptiFine(mcVer, customName, signal) {
  /* 1) 找一个 Forge/NeoForge 实例作为载体 */
  let carrier = await findForgeLikeInstance(customName);
  if (!carrier) {
    /* 没有前置加载器 → 自动装一个 NeoForge（优先）或 Forge */
    const nfProbe = await probeLoaderBuilds('NeoForge', mcVer).catch(() => null);
    const fgProbe = (!nfProbe || !nfProbe.ok) ? await probeLoaderBuilds('Forge', mcVer).catch(() => null) : null;
    const useNF = !!(nfProbe && nfProbe.ok);
    const useFG = !useNF && !!(fgProbe && fgProbe.ok);
    if (!useNF && !useFG) {
      throw new Error('OptiFine 需要 NeoForge 或 Forge 作为前置，但 ' + mcVer + ' 两个都没有可用构建');
    }
    const needLoader = useNF ? 'NeoForge' : 'Forge';
    setStatus('OptiFine 需要先装 ' + needLoader + '，正在自动安装…', true);
    toast('OptiFine 依赖 ' + needLoader + '，正在先装 ' + needLoader, 'info');
    const carrierName = sanitizeVersionId(customName || (mcVer + '-' + (useNF ? 'neoforge' : 'forge') + '-OptiFine'));
    if (useNF) await installNeoForge(mcVer, carrierName, undefined, signal);
    else await installForge(mcVer, carrierName, undefined, signal);
    carrier = { name: carrierName, loader: needLoader };
    logLine('[optifine] 已自动安装前置 ' + needLoader + ' → ' + carrierName);
  }
  /* 2) 把 OptiFine 丢进该实例的 mods/ */
  setStatus('安装 OptiFine 到 ' + carrier.name + '…', true);
  await optifineDropAsMod(mcVer, carrier.name);
  return carrier.name;
}
async function optifineBuildsOf(mcVer) {
  const list = await fetchJson('https://bmclapi2.bangbang93.com/optifine/' + encodeURIComponent(mcVer));
  const arr = Array.isArray(list) ? list : [];
  return arr.filter(x => x && x.mcversion === String(mcVer));
}
/* 选 OptiFine 构建：优先正式版（filename 不以 preview_ 开头），都没有则退回预览版。
   同类型下 patch 序号最大的更新（J9 > J8；pre12 > pre1）—— 注意 "pre12" 的数字是 12，比 "J8" 的 8 大，
   但两者不会混在一起比（正式版优先已经排除了），所以简单取数字最大值即可。 */
function pickOptifineBuild(builds) {
  if (!builds.length) return null;
  const stable = builds.filter(x => !/^preview_/i.test(String(x.filename || '')));
  const pool = stable.length ? stable : builds;
  const score = (s) => {
    const m = String(s).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  return pool.reduce((best, cur) => score(cur.patch) > score(best.patch) ? cur : best, pool[0]);
}
/* 带超时的 HTTP（NeoForge 官方源国内常被重置/挂起，避免卡死） */
async function fetchBufT(url, ms) {
  const res = await fetch(url, { headers: { 'User-Agent': UA_STR }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
  return Buffer.from(await res.arrayBuffer());
}
async function fetchJsonT(url, ms) { return JSON.parse((await fetchBufT(url, ms)).toString('utf8')); }
/* NeoForge 版本列表：官方 API 与 BMCLAPI maven-metadata **并行竞速**（谁先回用谁）。
   官方源在国内常被重置/挂起；BMCLAPI 也不再是稳定的快源 —— 它现在会 302 跳到对象存储的
   签名地址，实测同一台机器上冷启动 1.0s / 8.7s / 15.6s 都出现过。原来的 10s 超时经常被
   它撑破，加上官方源偶发直接失败，就会误报「版本列表获取失败」→ 界面显示成「✗ 不兼容」
   （真实事故：首次打开安装弹窗查 NeoForge 26.1 得到 builds=0，而上游明明有 161 条）。
   所以镜像给 20s；官方源本身通常 <1.5s，留 12s 余量即可。
   注意超时值只在「另一个源也挂了」时才体现成本：并行竞速的正常路径 1 秒内就返回。
 * artifact: 'neoforge'（1.20.2+，版本形如 21.1.77）或 'forge'（1.20.1 旧坐标，版本形如 1.20.1-47.1.106） */
async function neoforgeVersionList(artifact) {
  const official = (async () => {
    const data = await fetchJsonT('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/' + artifact, 12000);
    if (Array.isArray(data.versions) && data.versions.length) return data.versions;
    throw new Error('官方源返回空版本列表');
  })();
  const mirror = (async () => {
    const xml = (await fetchBufT('https://bmclapi2.bangbang93.com/maven/net/neoforged/' + artifact + '/maven-metadata.xml', 20000)).toString('utf8');
    const all = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g)).map(m => m[1]);
    if (!all.length) throw new Error('镜像返回空版本列表');
    return all;
  })();
  try { return await Promise.any([official, mirror]); }
  catch (_) { throw new Error('NeoForge 版本列表获取失败（官方源与 BMCLAPI 镜像均不可达）'); }
}
async function installNeoForge(mcVer, customName, build, signal) {
  setStatus('查询 NeoForge 构建列表…', true);
  /* 1.20.1 走旧坐标 net.neoforged:forge（版本形如 1.20.1-47.1.x），其余走 neoforge 坐标。
     前缀一律交给 neoforgeBuildPrefix —— 不要再用 /^1\.(\d+)\.(\d+)/ 自己解析：
     新版本号方案（26.x）没有 "1." 前缀，那样会直接抛「无法解析版本号 xxx」，
     而界面上 NeoForge 明明显示「✓ 兼容」（真缺陷，探针侧早就改用前缀匹配了）。 */
  const legacy = mcVer === '1.20.1';
  const artifact = legacy ? 'forge' : 'neoforge';
  if (!neoforgeBuildPrefix(mcVer, artifact)) throw new Error('无法解析版本号: ' + mcVer);
  const all = await neoforgeVersionList(artifact);
  /* 正式版优先；一个正式版都没有时退回最新预发布版（策略见 neoforgeInstallCandidates）。 */
  const candidates = neoforgeInstallCandidates(all, mcVer, artifact);
  if (!candidates.length) throw new Error('NeoForge 尚未提供 ' + mcVer + ' 的构建');
  let v = candidates[candidates.length - 1];
  if (build) {
    /* 三种形态都要认（界面下拉里都会出现）：
       · 完整版本号 21.1.77 / 1.20.1-47.1.106 / 26.3.0.42-beta（预发布只能这样指定）
       · 纯数字后缀 47.1.106（旧式手输习惯）
       以前要求必须匹配 ^\d+(\.\d+)*$，带 -beta 的版本永远选不中、还会静默退回最新。 */
    const bw = String(build).trim();
    const hit = candidates.find(c => String(c) === bw) || candidates.find(c => String(c).endsWith(bw));
    if (!hit) throw new Error('NeoForge 未找到构建 ' + build + '（' + mcVer + ' 可用: ' + candidates.slice(-3).map(x => x.replace(/^.*-/, '')).join(' / ') + '）');
    v = hit;
  }
  const tmp = path.join(os.tmpdir(), 'neoforge-installer-' + v + '.jar');
  send('install:progress', { stage: 'installer-dl', percent: 3, text: '下载 NeoForge 安装器' });
  setStatus('下载 NeoForge 安装器…', true);
  /* 安装器 jar：官方 maven 优先，失败回退 BMCLAPI 镜像（1.20.1 文件名前缀 forge-） */
  const fileBase = (legacy ? 'forge-' : 'neoforge-') + v + '-installer.jar';
  const jarUrls = [
    'https://maven.neoforged.net/releases/net/neoforged/' + artifact + '/' + v + '/' + fileBase,
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/' + artifact + '/' + v + '/' + fileBase
  ];
  let lastErr = null;
  for (const u of jarUrls) {
    try { await downloadTo(u, tmp, null, signal); lastErr = null; break; } catch (e) { if (e && e.cancelled) throw e; lastErr = e; }
  }
  if (lastErr) throw new Error('NeoForge 安装器下载失败: ' + lastErr.message);
  /* 镜像预热：同 Forge，避免安装器内置下载走官方源被拖慢 */
  try {
    const meta = await findInManifest(mcVer);
    await installVanillaFiles(meta, mcVer, { noAssets: true }, undefined, signal);
  } catch (e) { if (e && e.cancelled) throw e; }
  /* NeoForge 1.20.1 等旧安装器的 processors 工具链走官方源极易失败 → 预热失败重试一轮 */
  await preheatInstallerLibsRetry(tmp, config.gameDir, (d, n) => {
    send('install:progress', { stage: 'preheat', percent: 30 + Math.round(d / n * 45), text: '镜像预热安装器依赖 ' + d + '/' + n });
  }, signal);
  try { await preheatMojmaps(tmp, config.gameDir, mcVer, signal); } catch (e) { if (e && e.cancelled) throw e; }
  /* 安装器生成的版本目录名用安装前后差集确定（比猜测更可靠） */
  const vdAll = path.join(config.gameDir, 'versions');
  const before = new Set(await fsp.readdir(vdAll).catch(() => []));
  await runInstallerSilently(tmp, config.gameDir, 'NeoForge', requiredJavaMajor(mcVer));
  try { await fsp.unlink(tmp); } catch (_) {}
  const after = await fsp.readdir(vdAll).catch(() => []);
  const added = after.filter(d => !before.has(d));
  const instName = added.find(d => /neoforge/i.test(d)) || added[0] || (mcVer + '-neoforge-' + (legacy ? v.replace(/^1\.20\.1-/, '') : v));
  const finalName = sanitizeVersionId(customName);
  if (finalName && finalName !== instName) return renameInstalledVersion(instName, finalName);
  return instName;
}

/* ---------------- 安装调度（支持取消） ---------------- */
const installing = new Set();
const installCancelReq = new Set(); /* 已请求取消的任务 key */
const INSTALL_ACS = new Map();      /* key → AbortController：取消时直接打断「正在进行中」的 fetch（光靠检查点只能等到当前文件下完） */
/* 取消检查点：命中则抛出带 cancelled 标记的错误，runPool 会立即中止 */
function chkCancel(key) {
  if (key && installCancelReq.has(key)) {
    const e = new Error('安装已被用户取消');
    e.cancelled = true;
    throw e;
  }
}
ipcMain.handle('install:start', (_e, payload) => {
  netReset();   /* 新任务：速度/字节统计归零，界面剩余时间从头算 */
  const key = payload.id + '|' + payload.loader;
  if (installing.has(key)) return { started: false, reason: '该任务已在进行中' };
  installing.add(key);
  installCancelReq.delete(key);
  const ac = new AbortController();
  INSTALL_ACS.set(key, ac);
  runInstall(payload, key, ac.signal)
    .then(versionId => {
      send('install:done', { ok: true, versionId, loader: payload.loader });
      toast('安装完成: ' + versionId);
      setStatus('就绪');
    })
    .catch(err => {
      if (err && err.cancelled) {
        send('install:done', { ok: false, cancelled: true, error: '已取消' });
        toast('已取消安装: ' + payload.id, 'warn');
        setStatus('就绪');
      } else {
        send('install:done', { ok: false, error: err.message });
        toast('安装失败: ' + err.message, 'error');
        setStatus('安装失败');
      }
    })
    .finally(() => { installing.delete(key); installCancelReq.delete(key); INSTALL_ACS.delete(key); });
  return { started: true };
});
ipcMain.handle('install:cancel', (_e, payload) => {
  const key = payload.id + '|' + payload.loader;
  if (!installing.has(key)) return { ok: false, error: '该任务不在进行中' };
  installCancelReq.add(key);
  const ac = INSTALL_ACS.get(key);
  if (ac) { try { ac.abort(); } catch (_) {} }   /* 立刻打断进行中的 fetch —— 不用等当前文件下完 */
  logLine('[install] 收到取消请求: ' + key);
  return { ok: true };
});
async function runInstall(payload, cancelKey, signal) {
  const meta = await findInManifest(payload.id);
  const customName = sanitizeVersionId(payload.customName || '');
  const force = !!payload.reinstall; /* 界面「再装一份」→ 允许覆盖已安装实例（用于重装修复） */
  /* payload.build：界面「选择版本」里指定的加载器版本；空 = 由各安装器自己取最新 */
  const build = String(payload.build || '').trim() || undefined;
  switch (payload.loader) {
    case 'Vanilla': {
      const id = customName || payload.id;
      prepareInstallSlot(config.gameDir, id, force);
      await installVanillaFiles(meta, id, {}, cancelKey, signal);
      return id;
    }
    case 'Fabric': return installFabricLike(payload.id, 'fabric', customName, { force, cancelKey, build, signal });
    case 'Quilt': return installFabricLike(payload.id, 'quilt', customName, { force, cancelKey, build, signal });
    case 'Forge':
      if (customName) prepareInstallSlot(config.gameDir, customName, force);
      chkCancel(cancelKey); /* 外部安装器阶段无法中断，取消在进入前生效 */
      return installForge(payload.id, customName, build, signal);
    case 'NeoForge':
      if (customName) prepareInstallSlot(config.gameDir, customName, force);
      chkCancel(cancelKey);
      return installNeoForge(payload.id, customName, build, signal);
    case 'OptiFine':
      chkCancel(cancelKey);
      return installOptiFine(payload.id, customName, signal);
    default: throw new Error('暂不支持的加载器: ' + payload.loader);
  }
}

/* ---------------- Modrinth 在线资源（MOD / 整合包） ---------------- */
const MODRINTH_API = 'https://api.modrinth.com/v2';
/* 智能双源：尽量官方源；官方超时/失败自动切镜像（MCIM），切换后 10 分钟内优先镜像 */
const MR_MIRROR = 'https://mod.mcimirror.top';
const MR_OFFICIAL_TIMEOUT = 6000;   // 官方源响应时限（超时视为"加载缓慢"）
let mrMirrorUntil = 0;              // 该时间戳之前优先走镜像
function mrUA() { return 'XLC/' + APP_VERSION + ' (launcher; +https://github.com/lmc-launcher)'; }
function mrUseMirror() {
  if (Date.now() >= mrMirrorUntil) logLine('[Modrinth] 官方源超时/不可用，已切换镜像源（10 分钟内优先镜像）');
  mrMirrorUntil = Date.now() + 10 * 60 * 1000;
}
function mrOfficialOk() { mrMirrorUntil = 0; }
/* 生成尝试顺序：默认官方优先；冷却窗口内镜像优先。officialMs 可覆盖官方超时（POST 批量接口更宽） */
function mrUrls(p, officialMs) {
  const off = { url: MODRINTH_API + p, ms: officialMs || MR_OFFICIAL_TIMEOUT };
  const mir = { url: MR_MIRROR + '/modrinth/v2' + p, ms: 20000 };
  return Date.now() < mrMirrorUntil ? [mir, off] : [off, mir];
}
/* CDN/图标地址的镜像映射：cdn.modrinth.com/xx → mod.mcimirror.top/xx */
function mrBinUrls(url) {
  let mir = null;
  try { const u = new URL(url); if (u.hostname === 'cdn.modrinth.com') mir = MR_MIRROR + u.pathname; } catch (_) {}
  if (!mir) return [{ url, ms: 15000, official: true }];
  return Date.now() < mrMirrorUntil
    ? [{ url: mir, ms: 20000, official: false }, { url, ms: 15000, official: true }]
    : [{ url, ms: 15000, official: true }, { url: mir, ms: 20000, official: false }];
}
async function fetchMrJson(attempts, init) {
  /* 共两轮：每个源各试一次后若全部失败，等 1.5 秒再整体重试一轮，抗瞬时网络抖动 */
  const errs = [];
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 1500));
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, Object.assign({}, init, {
          headers: Object.assign({ 'User-Agent': mrUA() }, (init && init.headers) || {}),
          signal: AbortSignal.timeout(a.ms)
        }));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
        if (!a.url.startsWith(MR_MIRROR)) mrOfficialOk(); /* 官方成功才清除冷却窗口；镜像成功则保持 */
        return j;
      } catch (e) {
        errs.push((a.url.startsWith(MR_MIRROR) ? '镜像' : '官方') + '(' + e.name + ': ' + e.message + ')');
        if (!a.url.startsWith(MR_MIRROR)) mrUseMirror();
      }
    }
  }
  logLine('[Modrinth] 双源请求失败 · ' + errs.join(' ; '));
  throw new Error('官方源与镜像源均失败（' + errs[errs.length - 1] + '）');
}
async function mrJson(p) { return fetchMrJson(mrUrls(p)); }
/* ---------------- 内容下载的「停止」----------------
   MOD / 整合包 / 资源包 / 光影 / 数据包下载没有 runPool，用这张表登记进行中的任务：
   渲染层点「停止」→ download:cancel → abort，fetch 当场打断。
   key 由渲染层生成并随安装参数一起传过来（jobKey），主进程不猜。 */
const DL_ACS = new Map();          /* jobKey → AbortController */
function dlSignalOf(key) {
  const ac = new AbortController();
  DL_ACS.set(String(key), ac);
  return ac.signal;
}
function dlRelease(key) { DL_ACS.delete(String(key)); }
ipcMain.handle('download:cancel', (_e, key) => {
  const ac = DL_ACS.get(String(key || ''));
  if (!ac) return { ok: false, error: '当前没有正在进行的下载' };
  ac.abort();
  return { ok: true };
});
/* 冒烟测试专用（仅 LMC_SMOKE_DL=1 时注册）：让测试直接驱动 downloadBig 打本地慢速服务器，
   验证「停止」能打断分段下载、并保证不留半截文件。生产环境根本不注册这个通道。 */
if (SMOKE_EARLY && process.env.LMC_SMOKE_DL) {
  ipcMain.handle('smoke:download', async (_e, p) => {
    const key = String((p && p.jobKey) || '');
    const dest = String((p && p.dest) || '');
    const sig = key ? dlSignalOf(key) : null;
    const t0 = Date.now();
    let got = 0, err = '';
    try {
      got = await downloadBig(String(p.url), dest, null, sig, {});
    } catch (e) { err = e.message; }
    const out = {
      ok: !err,
      cancelled: !!(sig && sig.aborted),
      error: err,
      got,
      ms: Date.now() - t0,          /* 下到一半被打断时 got 拿不到（分段路径是抛错退出），用耗时判「确实在传」 */
      destExists: dest ? fs.existsSync(dest) : false,
      tmpExists: dest ? fs.existsSync(dest + '.xlc-tmp') : false
    };
    if (key) dlRelease(key);
    return out;
  });
}
/* 外部取消信号 → 转给本轮内部 AbortController（mrDownload / cfDownload 每轮自建 ac 挂看门狗） */
function relayAbort(ext, ac) {
  if (!ext) return;
  if (ext.aborted) ac.abort();
  else ext.addEventListener('abort', () => ac.abort(), { once: true });
}
/* Modrinth CDN 文件下载：官方优先，首字节 10 秒未到/失败自动切镜像；两轮抗抖动 */
async function mrDownload(url, dest, onProgress, extSignal) {
  const attempts = mrBinUrls(url);
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    if (extSignal && extSignal.aborted) throw new Error('已取消');
    if (round > 0) await new Promise(r => setTimeout(r, 1500));
    for (const a of attempts) {
      const ac = new AbortController();
      relayAbort(extSignal, ac);
      let got = 0;
      const kick = (pct, g, t) => { got = g; if (onProgress) onProgress(pct, g, t); };
      const watchdog = setTimeout(() => { if (got === 0) ac.abort(); }, 10000);
      try {
        await downloadBig(a.url, dest, kick, ac.signal);
        if (a.official) mrOfficialOk(); /* 官方成功才清除冷却窗口 */
        return;
      } catch (e) {
        /* 用户点了「停止」：不再切镜像 / 不再重试，直接出去 */
        if (extSignal && extSignal.aborted) throw new Error('已取消');
        lastErr = e;
        if (a.official && attempts.length > 1) mrUseMirror();
      } finally { clearTimeout(watchdog); }
    }
  }
  throw lastErr;
}
function loaderToMr(l) { return { Fabric: 'fabric', Quilt: 'quilt', Forge: 'forge', NeoForge: 'neoforge' }[l] || null; }
/* 图标本地化：下载 → 磁盘缓存 → base64 data URI（渲染进程直连 CDN 不可靠，统一由主进程代理） */
const ICON_CACHE = path.join(DATA_DIR, 'icon-cache');
function bufToDataUri(buf, maxBytes) {
  if (!buf || buf.length < 12 || buf.length > (maxBytes || 2 * 1024 * 1024)) return '';
  let mime = '';
  if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf[0] === 0xFF && buf[1] === 0xD8) mime = 'image/jpeg';
  else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
  return mime ? 'data:' + mime + ';base64,' + buf.toString('base64') : '';
}
async function fetchIconData(uri, projectId, maxBytes) {
  if (!uri) return '';
  const cacheFile = path.join(ICON_CACHE, projectId);
  try { return bufToDataUri(await fsp.readFile(cacheFile), maxBytes); } catch (_) {}
  for (const a of mrBinUrls(uri)) {
    try {
      const res = await fetch(a.url, { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(a.ms) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const uri2 = bufToDataUri(buf, maxBytes);
      if (uri2) { await fsp.mkdir(ICON_CACHE, { recursive: true }); await fsp.writeFile(cacheFile, buf); }
      return uri2;
    } catch (_) {}
  }
  return '';
}
/* ---------------- MOD 详情（PCL 式）：源站简介 HTML + 图库 + 适配文件列表 + 外链 ---------------- */
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}
ipcMain.handle('modrinth:detail', async (_e, p) => {
  try {
    const src = p && p.source === 'curseforge' ? 'curseforge' : 'modrinth';
    const out = { ok: true, files: [], gallery: [] };
    let mcVer = '', loaderLc = '';
    if (p.versionId) {
      try {
        const chain = await loadVersionChain(p.versionId, config.gameDir, 0);
        mcVer = chain.rootId;
        loaderLc = loaderToMr(detectLoaderOf(chain.json)) || '';
      } catch (_) {}
    }
    if (src === 'modrinth') {
      const pr = await mrJson('/project/' + encodeURIComponent(p.projectId));
      out.title = pr.title;
      /* 站内链接按项目类型走：/mod/ | /shader/ | /resourcepack/ | /datapack/ | /modpack/ */
      const prType = String(pr.project_type || 'mod').toLowerCase();
      const typePath = { mod: 'mod', shader: 'shader', resourcepack: 'resourcepack', datapack: 'datapack', modpack: 'modpack' }[prType] || 'mod';
      out.pageUrl = pr.slug ? 'https://modrinth.com/' + typePath + '/' + pr.slug : '';
      out.sourceUrl = pr.source_url || '';
      out.descHtml = sanitizeHtml(mdToHtml(pr.body || ''));
      out.downloads = pr.downloads || 0;
      out.tags = (pr.categories || []).map(catZh).slice(0, 4);
      out.icon = await fetchIconData(pr.icon_url || '', p.projectId, 4 * 1024 * 1024);
      for (const g of (pr.gallery || []).filter(g => g && g.url).slice(0, 4)) {
        try {
          const res = await fetch(g.url, { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(12000) });
          if (!res.ok) continue;
          const du = bufToDataUri(Buffer.from(await res.arrayBuffer()), 6 * 1024 * 1024);
          if (du) out.gallery.push(du);
        } catch (_) {}
      }
      if (p.versionId) {
        const parts = [];
        if (mcVer) parts.push('game_versions=' + encodeURIComponent(JSON.stringify([mcVer])));
        if (loaderLc) parts.push('loaders=' + encodeURIComponent(JSON.stringify([loaderLc])));
        let vers = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version' + (parts.length ? '?' + parts.join('&') : '')).catch(() => []);
        if (!vers.length && parts.length) vers = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version').catch(() => []);
        out.files = vers.slice(0, 8).map(v => {
          const f = (v.files || []).find(x => x.primary) || (v.files || [])[0] || {};
          return { ref: v.id, name: v.name || f.filename || v.version_number, date: v.date_published, size: f.size || 0, tags: (v.game_versions || []).slice(0, 4) };
        });
      }
    } else {
      const modId = String(p.projectId || '').replace(/^cf/, '');
      const pr = (await cfJson('/mods/' + modId)).data || {};
      out.title = pr.name;
      out.slug = pr.slug || '';
      out.pageUrl = (pr.links && pr.links.websiteUrl) || '';
      out.sourceUrl = (pr.links && pr.links.sourceUrl) || '';
      out.downloads = pr.downloadCount || 0;
      out.tags = (pr.categories || []).map(c => catZh(c.name)).slice(0, 4);
      out.icon = pr.logo ? await fetchIconData(pr.logo.url || pr.logo.thumbnailUrl || '', p.projectId, 4 * 1024 * 1024) : '';
      /* MCIM 镜像未代理 /description 端点（404），CF 网页有 Cloudflare 403 —— 退化为 summary + 截图 */
      let html = '';
      try { html = (await cfJson('/mods/' + modId + '/description')).data || ''; } catch (_) {}
      /* MCIM 镜像无 /description 端点；summary 为主，完整描述由 modrinth:cf-desc 走 cfwidget 二阶段补全 */
      out.descHtml = sanitizeHtml(html || (pr.summary || ''));
      for (const s of (pr.screenshots || []).filter(s => s && (s.url || s.thumbnailUrl)).slice(0, 4)) {
        try {
          const res = await fetch(s.url || s.thumbnailUrl, { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(12000) });
          if (!res.ok) continue;
          const du = bufToDataUri(Buffer.from(await res.arrayBuffer()), 6 * 1024 * 1024);
          if (du) out.gallery.push(du);
        } catch (_) {}
      }
      if (p.versionId) {
        const lt = CF_LOADER[loaderLc] || 0;
        let files = [];
        for (const u of [
          '/mods/' + modId + '/files?gameVersion=' + encodeURIComponent(mcVer) + (lt ? '&modLoaderType=' + lt : '') + '&pageSize=12',
          '/mods/' + modId + '/files?gameVersion=' + encodeURIComponent(mcVer) + '&pageSize=12'
        ]) { files = (await cfJson(u).catch(() => ({ data: [] }))).data || []; if (files.length) break; }
        files.sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0));
        out.files = files.slice(0, 8).map(f => ({
          ref: String(f.id), name: f.displayName || f.fileName, date: f.fileDate, size: f.fileLength || 0,
          tags: (f.gameVersions || []).filter(g => /^(forge|fabric|neoforge|quilt|\d)/i.test(g)).slice(0, 4)
        }));
      }
    }
    cacheDescOrig(String(p.projectId || ''), out.descHtml);
    return out;
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 详情原文缓存（供 modrinth:translate 二阶段翻译），容量 30 */
const descOrigCache = new Map();
function cacheDescOrig(key, html) {
  if (!key || !html) return;
  descOrigCache.set(key, html);
  if (descOrigCache.size > 30) descOrigCache.delete(descOrigCache.keys().next().value);
}
/* CF 详情描述二阶段补全：MCIM 镜像无 /description、官网 403，走 cfwidget（响应慢 ~20s，前端异步追加渲染） */
ipcMain.handle('modrinth:cf-desc', async (_e, p) => {
  try {
    const slug = String(p && p.slug || '');
    if (!/^[\w-]+$/.test(slug)) throw new Error('slug 无效');
    const res = await fetch('https://api.cfwidget.com/minecraft/mc-mods/' + encodeURIComponent(slug), { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error('cfwidget HTTP ' + res.status);
    const w = await res.json();
    const html = w && w.description ? sanitizeHtml(w.description) : '';
    if (html && w.id) cacheDescOrig('cf' + w.id, html);
    return { ok: true, descHtml: html };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 详情描述翻译二阶段：MyMemory 逐段翻译（整体 40s 超时；译文整体缓存；失败/限额回退原文） */
ipcMain.handle('modrinth:translate', async (_e, p) => {
  try {
    const id = String(p && p.projectId || '');
    const html = descOrigCache.get(id);
    if (!html) return { ok: false, error: 'no-origin' };
    if (zhRatio(html) >= 0.3) return { ok: true, descHtml: html, alreadyZh: true };
    const cache = loadTransCache();
    const fullKey = 'FULL:' + strHash(html);
    if (cache[fullKey]) return { ok: true, descHtml: cache[fullKey], cached: true };
    const zh = await Promise.race([
      translateHtmlDesc(html),
      new Promise((_, rej) => setTimeout(() => rej(new Error('翻译超时')), 40000))
    ]);
    let result = zh;
    if (zhRatio(zh) < 0.15) result = html; /* 限额/失败，保留原文 */
    else { cache[fullKey] = zh; saveTransCache(); }
    return { ok: true, descHtml: result };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* ---------------- MOD 中文名 / 中文简介 ----------------
 * 中文名来源优先级：
 *   1) 内置中文数据库 data/mod-zh-db.json（来自 PCL2 内置 MC 百科数据库，1 万+ 条，离线可用）
 *   2) 本地缓存 mod-names.json
 *   3) AI 翻译（需用户配置 AI Key，作为兜底增量）
 * 中文简介：MCIM 批量翻译接口（免费镜像，失败静默降级英文） */
const ZHDB_PATH = path.join(__dirname, 'data', 'mod-zh-db.json');
let zhdb = null;
function loadZhDb() {
  if (zhdb) return zhdb;
  zhdb = { entries: {}, keywords: {} };
  try {
    const j = JSON.parse(fs.readFileSync(ZHDB_PATH, 'utf8'));
    if (j && j.entries) zhdb.entries = j.entries;
    if (j && j.keywords) zhdb.keywords = j.keywords;
  } catch (_) {}
  /* 值统一成字符串（兼容早期的 { zh, descZh } 结构） */
  for (const k of Object.keys(zhdb.entries)) {
    const v = zhdb.entries[k];
    if (v && typeof v === 'object') zhdb.entries[k] = v.zh || '';
    if (!zhdb.entries[k]) delete zhdb.entries[k];
  }
  return zhdb;
}
/* 归一化查找键：小写、去分隔符、去常见前后缀（加载器/API/lib 等），
 * PCL 也是靠这类归一化在 modid 与数据库键之间做容错匹配 */
function zhKey(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[\s_.\-']+(fabric|forge|neoforge|quilt)$/i, '') /* 先剥 "xxx_fabric" 这类后缀 */
    .replace(/[\s_.\-']+/g, '')
    .replace(/^(the)/, '')                                      /* 冠词 */
    .replace(/(fabric|forge|neoforge|quilt|api|lib|mod|plugin|core)$/i, '');
}
/* 归一化键的容错比较：把「所有格 s」的插入/删除都视为等价
 * （数据库里是 xaeros_minimap，Modrinth 的 modid 是 xaero_minimap，差一个 s） */
function zhVariants(k) {
  const out = [k];
  if (!k) return out;
  /* 去掉内部「s+分隔符」形成所有格的情况：xaerosminimap → xaerominimap */
  const m = k.match(/^(.+?)s(?=[a-z]{2,}$)/);
  if (m) out.push(m[1] + k.slice(m[0].length));
  /* 补上所有格 s */
  out.push(k.replace(/^([a-z]{3,8}?)(?=[a-z]{3,}$)/, '$1s'));
  return [...new Set(out)];
}
function zhKeyEq(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return zhVariants(a).includes(b) || zhVariants(b).includes(a);
}
/* 按 modid / slug 查内置中文名；未命中返回 '' */
function zhByModId(id) {
  const k = String(id || '').toLowerCase().trim();
  if (!k) return '';
  const e = loadZhDb().entries;
  if (e[k]) return e[k];
  const nk = zhKey(k);
  if (nk && e[nk]) return e[nk];
  for (const key in e) if (zhKeyEq(zhKey(key), nk)) return e[key];
  return '';
}
/* 兜底：标题里不含中文时，用去符号小写标题在条目里做一次宽松匹配
 * （Modrinth 的 title 常是 slug 的可读形式，如 "Xaero's Minimap" 对应 xaeros_minimap） */
function zhBySlug(title) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t.length < 3) return '';
  const e = loadZhDb().entries;
  if (e[t]) return e[t];
  const nt = zhKey(title);
  if (nt && e[nt]) return e[nt];
  for (const key in e) if (zhKeyEq(zhKey(key), t) || zhKeyEq(zhKey(key), nt)) return e[key];
  return '';
}
/* ===== PCL 式标题 / 副标题拆分 =====
 * 实现思路对齐 PCL2 社区资源列表的标题/副标题拆分规则（ResourceProject.GetControlTitle）。
 * 规则：中文名里若含「 (English Name)」「 - 后缀」「[缩写]」等成分，
 *       把主体中文名作为标题，其余（英文名、加载器版次、缩写、后缀）作为副标题。
 * 例：「Xaero的小地图 (Xaero's Minimap) - 默认版（功能完整）」
 *   → 标题「Xaero的小地图」，副标题「Xaero's Minimap」「默认版（功能完整）」
 * 无中文名时：按分隔符切段，缩写段与 Forge/Fabric 版本标记进副标题，其余拼成标题。 */
const LOADER_WORDS = [
  ['neoforge', 'NeoForge'], ['forge', 'Forge'], ['fabric', 'Fabric'], ['quilt', 'Quilt']
];
function isLoaderToken(s) {
  const l = String(s || '').toLowerCase();
  return LOADER_WORDS.some(([w]) => l.includes(w));
}
/* 去掉加载器词后还有别的字母 → 不是纯版本标记 */
function loaderOnly(s) {
  let l = String(s || '').toLowerCase();
  for (const [w] of LOADER_WORDS) l = l.split(w).join('');
  return !/[a-z]+/.test(l);
}
function splitWords(s, seps) {
  const re = new RegExp('(' + seps.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')');
  return String(s).split(re)
    .map(x => x.trim().replace(/^[\/\\ ]+|[\/\\ ]+$/g, ''))
    .filter(x => x && !seps.includes(x));
}
function stripOuter(s) {
  return String(s).replace(/^[\(\[\{ ]+|[\)\]\} ]+$/g, '').trim();
}
function upperIsAbbr(s) {
  const t = String(s).trim();
  return t.length > 0 && t === t.toUpperCase() && /\p{Lu}/u.test(t) && t !== 'FPS' && t !== 'HUD';
}
function pclTitle(zh, raw) {
  const zhName = String(zh || '').trim();
  const rawName = String(raw || '').trim();
  let title = rawName || zhName;
  let sub = [];
  const SEPS = [' | ', ' - ', '(', ')', '[', ']', '{', '}'];

  if (!zhName || zhName === rawName) {
    /* —— 没有中文翻译：切段后挑出缩写 / 版本标记作副标题 —— */
    const parts = splitWords(zhName || rawName, SEPS);
    if (parts.length > 1) {
      const normals = [], subtitles = [];
      for (const p of parts) {
        if (upperIsAbbr(p)) subtitles.push(p);
        else if (isLoaderToken(p) && loaderOnly(p)) subtitles.push(p);
        else normals.push(p);
      }
      if (normals.length && subtitles.length) {
        title = normals.join(' - ');
        sub = subtitles;
      } else {
        title = zhName || rawName;
        sub = [];
      }
    }
  } else {
    /* —— 有中文翻译：拆成「标题 (英文名) - 后缀」 —— */
    title = zhName.includes(' (') ? zhName.slice(0, zhName.indexOf(' (')) : zhName.slice(0, zhName.lastIndexOf(' - ') === -1 ? undefined : zhName.lastIndexOf(' - '));
    let suffix = '';
    const afterParen = zhName.includes(')') ? zhName.slice(zhName.lastIndexOf(')') + 1) : '';
    if (afterParen.includes(' - ')) suffix = afterParen.slice(afterParen.lastIndexOf(' - ') + 3).trim();
    let englishName = zhName;
    if (suffix) englishName = englishName.split(' - ' + suffix).join('');
    englishName = englishName.split(title).join('').trim()
      .replace(/^[\(\[\{ ]+|[\)\]\} ]+$/g, '');
    let list = splitWords(englishName, [' | ', ' - ', '(', ')', '[', ']', '{', '}']).map(stripOuter).filter(Boolean);
    const hasLoader = list.some(s => isLoaderToken(s));
    const last = list[list.length - 1];
    if (list.length > 1 && !hasLoader && !(list.length === 2 && last && upperIsAbbr(last))) {
      list = englishName ? [englishName] : [];
    }
    sub = list;
    if (suffix) sub.push(suffix);
  }

  /* 去重 + 加载器标记规整 + 生成最终副标题串 */
  sub = [...new Set(sub.filter(Boolean))];
  const out = [];
  for (let ex of sub) {
    if (ex.length < 16 && ex.toLowerCase().includes('fabric') && ex.toLowerCase().includes('forge')) continue;
    if (isLoaderToken(ex) && loaderOnly(ex) && !/版/.test(ex)) {
      const base = ex.replace(/Edition|edition/g, '').trim();
      if (base) ex = base.charAt(0).toUpperCase() + base.slice(1) + ' 版';
    }
    out.push(ex);
  }
  return { title: title || rawName || zhName, sub: out };
}
/* 中文检索词 → 英文关键词列表（内置表，命中即返回对应的英文 query） */
function zhKeywordsFor(q) {
  const s = String(q || '').trim();
  if (!s || !/[\u4e00-\u9fff]/.test(s)) return null;
  const kw = loadZhDb().keywords;
  if (kw[s]) return kw[s].slice();
  /* 包含式兜底：「小地图模组」→ 命中「小地图」 */
  for (const key in kw) if (key.length >= 2 && s.includes(key)) return kw[key].slice();
  /* 逐字退化：拿内置条目里的中文别名做一次模糊命中 */
  const hit = [];
  for (const id in loadZhDb().entries) {
    const e = loadZhDb().entries[id];
    const kwList = [].concat(e.kw || [], e.obj || [], e.zh || []);
    if (kwList.some(w => w && (s.includes(w) || w.includes(s)))) hit.push(id);
    if (hit.length >= 8) break;
  }
  return hit.length ? hit : null;
}
const NAMES_CACHE = path.join(DATA_DIR, 'mod-names.json');
let namesCache = null, nameTransBusy = new Set();
function loadNamesCache() {
  if (!namesCache) { try { namesCache = JSON.parse(fs.readFileSync(NAMES_CACHE, 'utf8')) || {}; } catch (_) { namesCache = {}; } }
  return namesCache;
}
function saveNamesCache() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(NAMES_CACHE, JSON.stringify(namesCache)); } catch (_) {}
}
async function mcimZhDesc(projectIds) {
  const ids = (projectIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    const res = await fetch('https://mod.mcimirror.top/translate/modrinth', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': mrUA() },
      body: JSON.stringify({ project_ids: ids }), signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return {};
    const arr = await res.json();
    const m = {};
    for (const it of (Array.isArray(arr) ? arr : [])) if (it && it.project_id && it.translated) m[it.project_id] = it.translated;
    return m;
  } catch (_) { return {}; }
}
async function aiTranslateTitles(pairs) {
  /* pairs: [{ id, title }] → { id: 中文名 }；未配置 AI 返回空 */
  const api = config.aiApi || {};
  if (!api.base || !api.key || !pairs.length) return {};
  const list = pairs.map(p => p.id + '|' + p.title).join('\n');
  const prompt = '把下面每一行竖线后面的 Minecraft 模组名称翻译成简体中文（模组名通常保留英文专有名词或用社区通用译名），只输出一个 JSON 对象：键是竖线前面的 id，值是中文译名，不要输出任何其他内容：\n' + list;
  const base = api.base.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api.key },
    body: JSON.stringify({ model: api.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  const obj = JSON.parse(m[0]);
  const out = {};
  for (const p of pairs) if (typeof obj[p.id] === 'string' && obj[p.id].trim()) out[p.id] = obj[p.id].trim().slice(0, 60);
  return out;
}
/* 为一组 project_id 补全中文名与中文简介（内置库 > 缓存 > AI，AI 仅为兜底增量）
 * skipMcim: 非 Modrinth 源（如 CurseForge）的 id 在 MCIM 无映射，跳过简介批量接口 */
async function zhFill(projectIds, titlesById, skipMcim) {
  const cache = loadNamesCache();
  const out = {};
  const needAi = [];
  const needDesc = [];
  for (const id of projectIds) {
    const c = cache[id];
    const rawTitle = (titlesById || {})[id] || '';
    /* 内置库里能按 project_id / slug / 标题匹配到中文名 → 直接用，不调 AI */
    const builtin = zhByModId(id) || zhByModId(rawTitle) || zhBySlug(id) || zhBySlug(rawTitle);
    if (builtin) {
      out[id] = { zh: builtin, descZh: (c && c.descZh) || '' };
      if (!(c && c.descZh)) needDesc.push(id);
      continue;
    }
    if (c && c.zh) out[id] = { zh: c.zh, descZh: c.descZh || '' };
    else {
      if (c && c.descZh) out[id] = { zh: '', descZh: c.descZh };
      else needDesc.push(id);
      if (rawTitle && !nameTransBusy.has(id)) { needAi.push({ id, title: rawTitle }); nameTransBusy.add(id); }
    }
  }
  if (!skipMcim && needDesc.length) {
    const d = await mcimZhDesc(needDesc);
    for (const id of needDesc) if (d[id]) {
      cache[id] = Object.assign({}, cache[id] || {}, { descZh: d[id] });
      out[id] = Object.assign({ zh: (cache[id] || {}).zh || '' }, out[id], { descZh: d[id] });
      if (out[id] && !out[id].zh) out[id].zh = cache[id].zh || '';
    }
  }
  if (needAi.length) {
    try {
      const t = await aiTranslateTitles(needAi);
      for (const p of needAi) if (t[p.id]) {
        cache[p.id] = Object.assign({ descZh: '' }, cache[p.id] || {}, { zh: t[p.id] });
        out[p.id] = Object.assign({}, out[p.id] || {}, { zh: t[p.id] });
      }
    } catch (_) {} /* AI 失败静默，下次重试 */
  }
  for (const p of needAi) nameTransBusy.delete(p.id);
  if (!skipMcim && needDesc.length || needAi.length) saveNamesCache();
  return out;
}
/* ===== 详情页描述英→中翻译（MyMemory 免费接口，逐段翻译 + 磁盘缓存，尽力而为） ===== */
const TRANS_CACHE = path.join(DATA_DIR, 'detail-trans.json');
let transCache = null;
function loadTransCache() {
  if (!transCache) { try { transCache = JSON.parse(fs.readFileSync(TRANS_CACHE, 'utf8')) || {}; } catch (_) { transCache = {}; } }
  return transCache;
}
function saveTransCache() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(TRANS_CACHE, JSON.stringify(transCache)); } catch (_) {}
}
function strHash(s) { return crypto.createHash('md5').update(s).digest('hex').slice(0, 16); }
const escHtmlText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unent = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/* MyMemory 单请求 ≤ ~460 字符；长文本按句分组合并请求 */
async function mmOne(text) {
  const url = 'https://api.mymemory.translated.net/get?langpair=en|zh-CN&de=lmclauncher@outlook.com&q=' + encodeURIComponent(text.slice(0, 460));
  const res = await fetch(url, { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const t = j && j.responseData && j.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|QUERY LENGTH|INVALID/i.test(t)) throw new Error(t || 'empty');
  return t;
}
async function mmTranslate(text) {
  const sents = text.length > 440 ? (text.match(/[^.!?]+[.!?]*\s*/g) || [text]) : [text];
  const groups = [];
  let cur = '';
  for (const s of sents) { if ((cur + s).length > 440 && cur) { groups.push(cur); cur = ''; } cur += s; }
  if (cur) groups.push(cur);
  const rs = [];
  for (const g of groups) rs.push(await mmOne(unent(g)));
  return rs.join(' ');
}
/* 只翻文本节点，标签原样保留；片段缓存 key=md5(原文片段) */
async function translateHtmlDesc(html) {
  const cache = loadTransCache();
  const parts = html.split(/(<[^>]*>)/);
  const out = [];
  const jobs = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('<')) { out.push(p); continue; }
    const t = p.trim();
    if (!t || !/[A-Za-z]{3}/.test(t) || /[\u4e00-\u9fff]/.test(t)) { out.push(p); continue; }
    const key = strHash(t);
    if (cache[key]) { out.push(p.replace(t, escHtmlText(cache[key]))); continue; }
    jobs.push({ t, key, raw: p, res: '' });
    out.push(null);
  }
  if (jobs.length) {
    await runPool(jobs, 3, async (j) => {
      try { j.res = await mmTranslate(j.t); cache[j.key] = j.res; } catch (_) {}
    });
    saveTransCache();
  }
  let ji = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    const j = jobs[ji++];
    out[i] = j.res ? j.raw.replace(j.t, escHtmlText(j.res)) : j.raw;
  }
  return out.join('');
}
function zhRatio(html) {
  const txt = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  if (!txt) return 1;
  const zh = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
  return zh / txt.length;
}
/* 分类英文→中文（未命中保留原文） */
const CAT_ZH = [
  [/technolog|tech/, '科技'], [/adventure|rpg/, '冒险'], [/magic/, '魔法'], [/utility/, '实用'],
  [/storage/, '存储'], [/equipment|armor|weapon/, '装备'], [/world gen|worldgen/, '世界生成'],
  [/mobs|creature/, '生物'], [/performance|optimiz/, '性能'], [/energy|power/, '能源'],
  [/transport/, '物流运输'], [/processing|automation/, '加工自动化'], [/librar|api/, '前置库'],
  [/cosmetic|decoration|deco/, '装饰建筑'], [/build/, '建筑'], [/explor/, '探索'],
  [/economy/, '经济'], [/social|vot/, '社交'], [/education/, '教育'], [/quest/, '任务'],
  [/mini.?game/, '小游戏'], [/futur|scifi|sci-fi/, '科幻'], [/medieval/, '中世纪'],
  [/skyblock/, '空岛'], [/hardcore/, '极限生存'], [/combat/, '战斗'], [/farm|food/, '农业食物'],
  [/map/, '地图'], [/optimiz/, '优化'], [/bug fix/, '修复'], [/tweaks|misc/, '杂项改进']
];
function catZh(name) {
  const n = String(name || '').toLowerCase();
  if (/[\u4e00-\u9fff]/.test(n)) return name;
  for (const [re, zh] of CAT_ZH) if (re.test(n)) return zh;
  return name;
}

/* 图标并发转 base64 + 中文名/简介（Modrinth 与 CurseForge 搜索共用）
 * 标题按 PCL 规则拆成「标题 / 副标题」：中文名作主标题，英文原名、加载器版次、
 * 缩写等成分进副标题（对应 PCL 的 LabTitle + LabTitleRaw + LabInfo 布局）。 */
async function decorateHits(hits, skipMcim) {
  const zhPromise = zhFill(hits.map(h => h.id), Object.fromEntries(hits.map(h => [h.id, h.title])), skipMcim);
  await runPool(hits, 6, async (h) => { h.icon = await fetchIconData(h.icon, h.id); });
  /* 中文名/中文简介：MCIM 最多等 9 秒；AI 翻译慢时后台继续并写缓存，下次搜索生效 */
  const zhMap = await Promise.race([zhPromise, new Promise(r => setTimeout(() => r({}), 9000))]);
  for (const h of hits) {
    const z = zhMap[h.id] || {};
    h.titleZh = z.zh || '';
    h.descZh = z.descZh || '';
    const t = pclTitle(h.titleZh, h.title);
    h.titleMain = t.title;          /* 主标题（有中文名时=中文名） */
    h.titleSub = t.sub || [];       /* 副标题数组（英文原名 / 加载器版次 / 缩写 / 后缀） */
  }
}
/* 搜索内核（handler 与冒烟测试共用），page 从 1 开始，每页 20 条；type ∈ mod/modpack/resourcepack/datapack */
const MR_TYPES = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'];
/* 中文检索词 → 英文关键词数组（PCL 式中文搜索：用内置关键词表把中文映射成英文关键词）
 * 关键：多词必须分头查询再合并，不能拼成一个 query —— 实测 「journeymap voxelmap minimap」
 * 这种 OR 串在 Modrinth 的 relevance 排序下会返回 0 条（两个词都不满足整句匹配）。 */
function toSearchKeywords(q) {
  const list = zhKeywordsFor(q);
  if (!list || !list.length) return null;
  const uniq = [...new Set(list.map(s => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 3);
  return uniq.length ? uniq : null;
}
/* 词库没收录的中文词 → 在线翻译兜底（钠 → Sodium、小地图 → mini map）。
 * 为什么必须有这一步：中文查询原样发给上游等于「没搜索」——
 *   · Modrinth 对单字中文基本 0 条；
 *   · CurseForge 会把不认识的 CJK 串当**空条件**，返回全站下载量前 100 名
 *     （实测 searchFilter=钅 → totalCount=10000，头几条是 JEI / Mouse Tweaks / AppleSkin），
 *     「综合」源合并后屏幕上就只剩一堆不相干的热门，用户以为搜索没生效。
 * 译文还会过一遍 src/search-zh.js 的清洗：生僻字常被翻成垃圾（钅 → ư），判不出就返回 null。 */
const ZH_TR_CACHE = new Map();          /* 中文查询 → { kws, at } */
const ZH_TR_TTL = 30 * 60 * 1000;
async function translateZhKeywords(q) {
  const s = String(q || '').trim();
  if (!hasCJK(s) || s.length > 40) return null;     /* 纯英文 / 长句不翻（避免误伤） */
  const c = ZH_TR_CACHE.get(s);
  if (c && Date.now() - c.at < ZH_TR_TTL) return c.kws;
  let kws = null;
  try {
    const url = 'https://api.mymemory.translated.net/get?langpair=zh-CN%7Cen&mt=1&de=' +
      encodeURIComponent(TR_CONTACT) + '&q=' + encodeURIComponent(s);
    const res = await fetch(url, { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(5000) });
    const j = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
    kws = enKeywordsFromTranslation(s, (j && j.responseData || {}).translatedText);
  } catch (_) { kws = null; }        /* 翻译不可用就当没有，绝不阻断搜索本身 */
  if (ZH_TR_CACHE.size > 300) ZH_TR_CACHE.clear();
  ZH_TR_CACHE.set(s, { kws, at: Date.now() });
  return kws;
}
/* 统一入口：内置词库优先（快且准），没收录再翻译 */
async function resolveKeywords(q) {
  return toSearchKeywords(q) || await translateZhKeywords(q);
}
/* 英文关键词按 relevance 查询，合并去重（保持首词结果在前） */
async function mrSearchByKeywords(kws, type, mcVersion, loader, limit) {
  const facets = [['project_type:' + (MR_TYPES.includes(type) ? type : 'mod')]];
  if (mcVersion) facets.push(['versions:' + mcVersion]);
  if (loader) facets.push(['categories:' + loader]);
  const seen = new Set(), out = [];
  const groups = await Promise.all(kws.map(kw => fetchMrJson(mrUrls(
    '/search?limit=' + limit + '&offset=0&index=relevance&query=' + encodeURIComponent(kw) +
    '&facets=' + encodeURIComponent(JSON.stringify(facets)), 8000)).catch(() => null)));
  for (const j of groups) {
    if (!j || !j.hits) continue;
    for (const h of j.hits) {
      if (seen.has(h.project_id)) continue;
      seen.add(h.project_id);
      out.push(h);
    }
  }
  return out;
}
async function modrinthSearchInner(query, type, mcVersion, loader, page) {
  const PAGE_SIZE = 20;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const kws = await resolveKeywords(query); /* 中文检索词 → 英文关键词数组（词库 → 在线翻译） */
  let rawHits = null, total = 0;
  if (kws) {
    /* 中文搜索：逐关键词查询后合并去重（每词取 PAGE_SIZE 条，保证翻页有料） */
    const merged = await mrSearchByKeywords(kws, type, mcVersion, loader, PAGE_SIZE);
    rawHits = merged.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
    total = 0; /* 合并结果无权威总数，下面用已取条数推下界 */
  } else {
    const facets = [['project_type:' + (MR_TYPES.includes(type) ? type : 'mod')]];
    if (mcVersion) facets.push(['versions:' + mcVersion]);
    if (loader) facets.push(['categories:' + loader]);
    const url = '/search?limit=' + PAGE_SIZE + '&offset=' + ((p - 1) * PAGE_SIZE) +
      '&index=downloads&query=' + encodeURIComponent(query || '') +
      '&facets=' + encodeURIComponent(JSON.stringify(facets));
    const j = await fetchMrJson(mrUrls(url, 8000));
    rawHits = j.hits || [];
    total = j.total_hits || rawHits.length;
  }
  const hits = rawHits.map(h => ({
    id: h.project_id, slug: h.slug, title: h.title, desc: h.description,
    downloads: h.downloads, icon: h.icon_url || '', author: h.author || '',
    src: 'modrinth'   /* 逐条标记来源：「综合」源下界面按条显示 Modrinth / CurseForge，安装也按条路由 */
  }));
  // 图标并发转 base64（runPool：6 并发，单图 6s 超时，失败留空走 SVG 占位）
  await decorateHits(hits, false);
  if (kws) total = hits.length + (p - 1) * PAGE_SIZE;
  return { hits, total, zhQuery: kws ? kws.join(' / ') : '', zhMiss: !kws && hasCJK(query) };
}
/* ---------------- CurseForge 源（MCIM 镜像代理 /curseforge，免 API key） ----------------
 * 官方 api.curseforge.com 需要 key；MCIM 镜像提供免 key 代理，转发 /v1 全部端点 */
const CF_API = 'https://mod.mcimirror.top/curseforge/v1';
/* classId 见 CurseForge 官方类目表：6=Mods 4471=Modpacks 12=Resource Packs 6552=Shaders 6945=Data Packs */
const CF_CLASS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, datapack: 6945 };
const CF_LOADER = { forge: 1, fabric: 4, neoforge: 5, quilt: 6 };
async function cfJson(p) {
  let lastErr = null;
  for (let i = 0; i < 2; i++) { /* 镜像偶发抖动，失败等 1.2s 重试一次 */
    if (i > 0) await new Promise(r => setTimeout(r, 1200));
    try {
      const res = await fetch(CF_API + p, { headers: { 'User-Agent': mrUA() }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('CurseForge 接口 HTTP ' + res.status);
      return JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('CurseForge 接口请求失败');
}
async function curseforgeSearchInner(query, type, mcVersion, loader, page) {
  const PAGE_SIZE = 20;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const kws = await resolveKeywords(query);
  /* CF 不支持中文检索：不认识的 CJK 串会被当「空条件」，返回全站下载量最高的前 100 名
     （实测 searchFilter=钅 → totalCount=10000，头几条是 JEI / Mouse Tweaks），
     界面看起来和「没搜索」完全一样。所以中文没解析出英文词时直接按 0 条处理。 */
  if (!kws && hasCJK(query)) return { hits: [], total: 0, zhQuery: '', zhMiss: true };
  /* CF 的 searchFilter 是整串匹配（不做 OR），多词拼接会 0 结果 → 只取最相关的一个关键词 */
  const cfQuery = kws ? (kws.slice().sort((a, b) => b.length - a.length)[0]) : (query || '');
  const qs = new URLSearchParams({
    gameId: '432', classId: String(CF_CLASS[type] || 6), searchFilter: cfQuery,
    sortField: '6', sortOrder: 'desc', index: String((p - 1) * PAGE_SIZE), pageSize: String(PAGE_SIZE)
  });
  if (mcVersion) qs.set('gameVersion', mcVersion);
  const lt = CF_LOADER[(loader || '').toLowerCase()];
  if (lt && type === 'mod') qs.set('modLoaderType', String(lt));
  const j = await cfJson('/mods/search?' + qs.toString());
  const hits = (j.data || []).map(m => ({
    id: 'cf' + m.id, slug: m.slug, title: m.name,
    desc: (m.summary || '').replace(/\s+/g, ' ').slice(0, 200),
    downloads: m.downloadCount || 0,
    icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || '',
    author: ((m.authors || []).find(a => a.isPrimary) || (m.authors || [])[0] || {}).name || '',
    src: 'curseforge'
  }));
  await decorateHits(hits, true); /* CF 无 MCIM 简介，中文名走内置库 + AI 兜底 */
  const pg = j.pagination || {};
  return { hits, total: pg.totalCount != null ? pg.totalCount : (j.totalCount || hits.length), zhQuery: kws ? cfQuery : '', zhMiss: false };
}
/* ---------------- 「综合」源：Modrinth + CurseForge 合并，按下载量降序 ----------------
 * 为什么不能「翻页时各取一页再合并」：两个源的下载量量级和排名都不一样，逐页合并会出现
 * 「第 2 页第 1 名的下载量还低于第 1 页第 20 名」这种错序。这里一次性把两源各取
 * COMBINED_POOL 条、合并排序后缓存进内存，翻页只在合并结果上切片 —— 排序始终是全局正确的，
 * 且翻页不再发网络请求。图标 / 中文名只对「当前要显示的 20 条」做本地化，避免一次拉 200 个图标。 */
const COMBINED_PAGE = 20;
const COMBINED_POOL = 100;                 /* 每源预取条数：Modrinth 单次上限 100；CF 每页 50 → 取两次 */
const COMBINED_TTL = 5 * 60 * 1000;
const combinedCache = new Map();
async function modrinthPoolRaw(query, type, mcVersion, loader, limit, kwsIn) {
  const kws = kwsIn === undefined ? await resolveKeywords(query) : kwsIn;
  let raw;
  if (kws) {
    raw = await mrSearchByKeywords(kws, type, mcVersion, loader, limit);
  } else {
    const facets = [['project_type:' + (MR_TYPES.includes(type) ? type : 'mod')]];
    if (mcVersion) facets.push(['versions:' + mcVersion]);
    if (loader) facets.push(['categories:' + loader]);
    const j = await fetchMrJson(mrUrls('/search?limit=' + limit + '&offset=0&index=downloads&query=' +
      encodeURIComponent(query || '') + '&facets=' + encodeURIComponent(JSON.stringify(facets)), 8000));
    raw = j.hits || [];
  }
  return raw.map(h => ({
    id: h.project_id, slug: h.slug, title: h.title, desc: h.description,
    downloads: h.downloads, icon: h.icon_url || '', author: h.author || '', src: 'modrinth'
  }));
}
async function curseforgePoolRaw(query, type, mcVersion, loader, limit, kwsIn) {
  const kws = kwsIn === undefined ? await resolveKeywords(query) : kwsIn;
  /* 同 curseforgeSearchInner：CF 会把不认识的 CJK 当空条件返回全站热门，中文无英文词就不查 */
  if (!kws && hasCJK(query)) return [];
  /* CF 的 searchFilter 是整串匹配（不做 OR），多词只取最相关的一个（与单源模式一致） */
  const cfQuery = kws ? (kws.slice().sort((a, b) => b.length - a.length)[0]) : (query || '');
  const lt = CF_LOADER[(loader || '').toLowerCase()];
  const out = [];
  for (let off = 0; off < limit; off += 50) {
    const pageSize = Math.min(50, limit - off);
    const qs = new URLSearchParams({
      gameId: '432', classId: String(CF_CLASS[type] || 6), searchFilter: cfQuery,
      sortField: '6', sortOrder: 'desc', index: String(off), pageSize: String(pageSize)
    });
    if (mcVersion) qs.set('gameVersion', mcVersion);
    if (lt && type === 'mod') qs.set('modLoaderType', String(lt));
    const j = await cfJson('/mods/search?' + qs.toString());
    const arr = j.data || [];
    out.push(...arr.map(m => ({
      id: 'cf' + m.id, slug: m.slug, title: m.name,
      desc: (m.summary || '').replace(/\s+/g, ' ').slice(0, 200),
      downloads: m.downloadCount || 0,
      icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || '',
      author: ((m.authors || []).find(a => a.isPrimary) || (m.authors || [])[0] || {}).name || '',
      src: 'curseforge'
    })));
    if (arr.length < pageSize) break;   /* 该源已到底，不必再翻 */
  }
  return out;
}
async function combinedSearchInner(query, type, mcVersion, loader, page) {
  const key = [String(query || '').trim().toLowerCase(), type, mcVersion, loader].join('|');
  /* 关键词只解析一次（词库 → 翻译，带缓存），两个源共用，避免同一句中文翻两遍 */
  const kws = await resolveKeywords(query);
  const zhMiss = !kws && hasCJK(query);
  /* 极速模式（config.turboMode）：缓存条目上限 24→8、保存 5 分钟→2 分钟，降低常驻内存 */
  const turbo = !!config.turboMode;
  const ttl = turbo ? 2 * 60 * 1000 : COMBINED_TTL;
  const cap = turbo ? 8 : 24;
  let ent = combinedCache.get(key);
  if (!ent || Date.now() - ent.at > ttl) {
    const [mr, cf] = await Promise.all([
      modrinthPoolRaw(query, type, mcVersion, loader, COMBINED_POOL, kws).catch(() => null),
      curseforgePoolRaw(query, type, mcVersion, loader, COMBINED_POOL, kws).catch(() => null)
    ]);
    if (!mr && !cf) throw new Error('Modrinth 与 CurseForge 都连不上（可先切回单个下载源）');
    const seen = new Set();
    const pool = [].concat(mr || [], cf || [])
      .filter(h => { const k = h.src + ':' + h.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    ent = { pool, at: Date.now() };
    combinedCache.set(key, ent);
    if (combinedCache.size > cap) combinedCache.delete(combinedCache.keys().next().value);   /* 简单淘汰 */
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const hits = ent.pool.slice((p - 1) * COMBINED_PAGE, p * COMBINED_PAGE).map(h => Object.assign({}, h));
  /* 只给当前页做中文名 / 图标本地化；按来源分两批，保持各源原有的中文策略 */
  const mrHits = hits.filter(h => h.src === 'modrinth');
  const cfHits = hits.filter(h => h.src === 'curseforge');
  await Promise.all([
    mrHits.length ? decorateHits(mrHits, false) : null,
    cfHits.length ? decorateHits(cfHits, true) : null
  ]);
  return { hits, total: ent.pool.length, zhQuery: kws ? kws.join(' / ') : '', zhMiss };
}
/* CurseForge 文件候选直链：API downloadUrl（edge.forgecdn.net）部分 404，补 mediafilez 拼接回退 */
function cfFileUrls(file) {
  const urls = [];
  if (file.downloadUrl) urls.push(file.downloadUrl);
  const id = Number(file.id) || 0;
  if (id > 0 && file.fileName)
    urls.push('https://mediafilez.forgecdn.net/files/' + Math.floor(id / 1000) + '/' + (id % 1000) + '/' + encodeURIComponent(file.fileName));
  return [...new Set(urls)];
}
async function cfDownload(file, dest, onProgress, extSignal) {
  const attempts = cfFileUrls(file);
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    if (extSignal && extSignal.aborted) throw new Error('已取消');
    if (round > 0) await new Promise(r => setTimeout(r, 1500));
    for (const url of attempts) {
      const ac = new AbortController();
      relayAbort(extSignal, ac);
      let got = 0, lastGot = -1;
      /* 看门狗：每 30s 检查一次，数据有增长就续期；CDN 首字节可能慢至 ~10s，不能按 10s 误杀 */
      const watchdog = setInterval(() => {
        if (got === lastGot) ac.abort(); else lastGot = got;
      }, 30000);
      try { await downloadBig(url, dest, (pct, g, t) => { got = g; if (onProgress) onProgress(pct, g, t); }, ac.signal); return; }
      catch (e) {
        /* 用户点了「停止」：不再换 CDN 地址重试 */
        if (extSignal && extSignal.aborted) throw new Error('已取消');
        lastErr = e;
      }
      finally { clearInterval(watchdog); }
    }
  }
  throw lastErr || new Error('下载失败');
}
ipcMain.handle('modrinth:search', async (_e, p) => {
  try {
    const src = (p && p.source) || 'modrinth';
    const r = src === 'curseforge'
      ? await curseforgeSearchInner(p.query, p.type, p.mcVersion, p.loader, p.page)
      : src === 'all'
        ? await combinedSearchInner(p.query, p.type, p.mcVersion, p.loader, p.page)
        : await modrinthSearchInner(p.query, p.type, p.mcVersion, p.loader, p.page);
    return { ok: true, hits: r.hits, total: r.total, zhQuery: r.zhQuery || '', zhMiss: !!r.zhMiss };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 按加载器安装 MC 版本（整合包导入共用） */
async function installMcWithLoader(mcVer, loader, customName) {
  const meta = await findInManifest(mcVer);
  switch ((loader || 'Vanilla').toLowerCase()) {
    case 'vanilla': return installVanillaFiles(meta, customName || mcVer);
    case 'fabric': return installFabricLike(mcVer, 'fabric', customName);
    case 'quilt': return installFabricLike(mcVer, 'quilt', customName);
    case 'forge': return installForge(mcVer, customName);
    case 'neoforge': return installNeoForge(mcVer, customName);
    default: throw new Error('整合包加载器暂不支持: ' + loader);
  }
}
/* MOD 重复安装拦截：目标 jar 或其 .disabled 变体已存在时给出明确提示，
 * 不静默覆盖（覆盖会丢失用户的 .disabled 禁用状态） */
function modAlreadyInstalledError(dest) {
  const name = path.basename(dest);
  if (fs.existsSync(dest)) return '该 MOD 已安装（' + name + '），如需更新版本请先到「MOD 管理」页删除旧文件';
  if (fs.existsSync(dest + '.disabled')) return '该 MOD 已安装但当前处于禁用状态（' + name + '.disabled），如需更新请先到「MOD 管理」页删除旧文件';
  return null;
}
/* 「没选版本」时安装 MOD：照 PCL 的做法问用户存哪里，不擅自塞进某个实例。
   顺序 = 先查出 jar 文件名 → 系统「选择保存位置」（默认落在 mods 目录、文件名预填）→ 下载到该路径。
   用户点取消就什么都不做（返回 canceled，界面按「已取消」提示，不当成安装失败）。 */
const SMOKE_SAVE_MODE = String(process.env.LMC_SMOKE_SAVE_MODE || '');
const SMOKE_SAVE_PATH = String(process.env.LMC_SMOKE_SAVE_PATH || '');
async function installModPicked(p, dlsig) {
  logLine('[modsave] enter mode=' + SMOKE_SAVE_MODE + ' src=' + p.source + ' id=' + p.projectId);
  let fileName = '', url = '', cfFile = null;
  if (p.source === 'curseforge') {
    const modId = String(p.projectId || '').replace(/^cf/, '');
    if (!/^\d+$/.test(modId)) throw new Error('CurseForge 项目 ID 无效');
    const files = (await cfJson('/mods/' + modId + '/files?pageIndex=0&pageSize=50')).data || [];
    files.sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0));
    cfFile = (p.fileRef && files.find(f => String(f.id) === String(p.fileRef))) || files[0];
    if (!cfFile || !cfFile.fileName) throw new Error('该项目没有可下载的文件');
    fileName = cfFile.fileName;
  } else {
    const vers = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version');
    if (!vers.length) throw new Error('该项目没有可下载的文件');
    const chosen = (p.fileRef && vers.find(v => v.id === p.fileRef)) || vers[0];
    const files = chosen.files || [];
    const file = files.find(f => f.primary) || files.find(f => /\.jar$/i.test(f.filename || f.url)) || files[0];
    if (!file || !file.url) throw new Error('版本下没有可用文件');
    url = file.url;
    fileName = file.filename || path.basename(new URL(file.url).pathname);
  }
  /* 文件名里绝不能带路径分隔符（有些项目的 filename 直接给了子路径） */
  fileName = String(fileName).replace(/[\\/:*?"<>|]/g, '_').trim() || ('mod-' + Date.now() + '.jar');
  const defDir = MODS_DIR();
  try { fs.mkdirSync(defDir, { recursive: true }); } catch (_) {}
  logLine('[modsave] file=' + fileName + ' defDir=' + defDir);
  let dest = '';
  if (SMOKE_SAVE_MODE === 'cancel') {
    /* 冒烟：模拟用户在系统对话框里点了「取消」 */
    return { ok: false, canceled: true };
  } else if (SMOKE_SAVE_MODE === 'path' && SMOKE_SAVE_PATH) {
    /* 冒烟/自动化：不弹系统窗口，直接落到指定路径（生产环境这个变量不存在） */
    dest = SMOKE_SAVE_PATH;
  } else {
    const r = await dialog.showSaveDialog(win || undefined, {
      title: '选择保存位置',
      buttonLabel: '保存',
      defaultPath: path.join(defDir, fileName),
      filters: [{ name: 'Mod 文件 (*.jar)', extensions: ['jar'] }, { name: '全部文件', extensions: ['*'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true };
    dest = r.filePath;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  setStatus('下载 MOD: ' + path.basename(dest), true);
  if (cfFile) await cfDownload(cfFile, dest, () => {}, dlsig);
  else await mrDownload(url, dest, () => {}, dlsig);
  setStatus('就绪');
  logLine('[download] MOD 另存为: ' + dest);
  toast('MOD 已保存到: ' + dest);
  let size = 0;
  try { size = fs.statSync(dest).size; } catch (_) {}
  return { ok: true, saved: true, path: dest, size, file: path.basename(dest) };
}
/* 下载 mod 文件到 gd/mods（目标 = 本地已安装的带加载器版本） */
ipcMain.handle('modrinth:install-mod', async (_e, p) => {
  /* jobKey：渲染层生成的一次性任务号，点「停止」时凭它找到这个任务打断 */
  const dlsig = p.jobKey ? dlSignalOf(p.jobKey) : null;
  try {
    netReset();
    /* 下载页「目标版本」停在「全部」（没选具体实例）→ 走「选择保存位置」，不猜实例 */
    if (p.pickPath && !p.instance) return await installModPicked(p, dlsig);
    const chain = await loadVersionChain(p.versionId, config.gameDir, 0);
    const mcVer = chain.rootId;
    const loader = loaderToMr(detectLoaderOf(chain.json));
    if (!loader) throw new Error('目标版本是 Vanilla，无法安装 MOD（请先安装 Fabric / Forge 等加载器版本）');
    if (p.source === 'curseforge') {
      /* CurseForge：按 MC 版本 + 加载器筛文件，无结果时放宽加载器重试 */
      const modId = String(p.projectId || '').replace(/^cf/, '');
      if (!/^\d+$/.test(modId)) throw new Error('CurseForge 项目 ID 无效');
      const lt = CF_LOADER[loader] || 0;
      let files = [];
      for (const u of [
        '/mods/' + modId + '/files?gameVersion=' + encodeURIComponent(mcVer) + (lt ? '&modLoaderType=' + lt : ''),
        '/mods/' + modId + '/files?gameVersion=' + encodeURIComponent(mcVer)
      ]) { files = (await cfJson(u)).data || []; if (files.length) break; }
      if (!files.length) {
        /* 查该 MOD 实际支持的版本，给出明确指引 */
        let hint = '';
        try {
          const all = (await cfJson('/mods/' + modId + '/files?pageIndex=0&pageSize=8')).data || [];
          const gv = new Set();
          for (const f of all) for (const g of (f.gameVersions || [])) if (/^\d+\.\d+(\.\d+)?$/.test(g)) gv.add(g);
          if (gv.size) hint = ' · 它最新支持: ' + [...gv].sort().reverse().slice(0, 5).join(' / ');
        } catch (_) {}
        throw new Error('该 MOD 无适配 ' + mcVer + ' (' + loader + ') 的构建' + hint + ' —— 请换用匹配版本的实例，或等待 MOD 更新');
      }
      files.sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0));
      const file = (p.fileRef && files.find(f => String(f.id) === String(p.fileRef))) || files[0];
      if (!file || !file.fileName) throw new Error('版本下没有可用 jar 文件');
      const dest = path.join(modsDirFor(p.instance), file.fileName);
      const dupErr = modAlreadyInstalledError(dest);
      if (dupErr) throw new Error(dupErr);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      setStatus('下载 MOD: ' + file.fileName, true);
      await cfDownload(file, dest, () => {}, dlsig);
      setStatus('就绪');
      toast('MOD 已安装到「' + (p.instance ? p.instance : '全局 mods') + '」: ' + file.fileName);
      return { ok: true, file: file.fileName };
    }
    const vers = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version?game_versions=' +
      encodeURIComponent(JSON.stringify([mcVer])) + '&loaders=' + encodeURIComponent(JSON.stringify([loader])));
    if (!vers.length) {
      /* 版本不匹配提示：查该 MOD 实际支持的版本，给出明确指引 */
      let hint = '';
      try {
        const all = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version?loaders=' +
          encodeURIComponent(JSON.stringify([loader])));
        const gv = new Set();
        for (const v of all.slice(0, 8)) for (const g of (v.game_versions || [])) gv.add(g);
        if (gv.size) hint = ' · 它最新支持: ' + [...gv].sort().reverse().slice(0, 5).join(' / ');
      } catch (_) {}
      throw new Error('该 MOD 无适配 ' + mcVer + ' (' + loader + ') 的构建' + hint + ' —— 请换用匹配版本的实例，或等待 MOD 更新');
    }
    const chosen = (p.fileRef && vers.find(v => v.id === p.fileRef)) || vers[0];
    const file = (chosen.files || []).find(f => f.primary) || (chosen.files || []).find(f => /\.jar$/i.test(f.filename || f.url));
    if (!file) throw new Error('版本下没有可用 jar 文件');
    const dest = path.join(modsDirFor(p.instance), file.filename || path.basename(file.url));
    const dupErr = modAlreadyInstalledError(dest);
    if (dupErr) throw new Error(dupErr);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    setStatus('下载 MOD: ' + path.basename(dest), true);
    await mrDownload(file.url, dest, () => {}, dlsig);
    setStatus('就绪');
    toast('MOD 已安装到「' + (p.instance ? p.instance : '全局 mods') + '」: ' + path.basename(dest));
    return { ok: true, file: path.basename(dest) };
  } catch (e) {
    setStatus('就绪');
    return { ok: false, cancelled: !!(dlsig && dlsig.aborted), error: e.message };
  } finally { if (p.jobKey) dlRelease(p.jobKey); }   /* 成功/失败都注销，别留过期任务号 */
});
/* 下载资源包 / 数据包：资源包 → gd/resourcepacks/；数据包 → gd/saves/<world>/datapacks/ */
ipcMain.handle('modrinth:install-pack', async (_e, p) => {
  const dlsig = p.jobKey ? dlSignalOf(p.jobKey) : null;
  try {
    netReset();
    const type = ['datapack', 'shader'].includes(p.type) ? p.type : 'resourcepack';
    const typeName = type === 'datapack' ? '数据包' : type === 'shader' ? '光影' : '资源包';
    /* fileRef = 详情页里用户点的那一条具体版本；不带则取该项目最新版本 */
    let ver;
    if (p.fileRef) ver = await mrJson('/version/' + encodeURIComponent(String(p.fileRef)));
    else {
      const vers = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version');
      if (!vers.length) throw new Error('该' + typeName + '没有可用版本');
      ver = vers[0];
    }
    const file = (ver.files || []).find(f => f.primary) || (ver.files || [])[0];
    if (!file) throw new Error('没有可下载的文件');
    const baseName = file.filename || path.basename(file.url);
    let dest;
    if (type === 'resourcepack') {
      dest = path.join(config.gameDir, 'resourcepacks', baseName);
    } else if (type === 'shader') {
      /* 指定实例 → 按该实例是否版本隔离决定落点；不指定 → 游戏根目录（所有实例共用） */
      dest = path.join(shaderpacksDirFor(p.instance), baseName);
    } else {
      /* world 值可能带实例前缀（版本隔离存档）："实例名|世界名"；全局存档为纯世界名 */
      const raw = String(p.world || '');
      const sep = raw.indexOf('|');
      const inst = sep > -1 ? raw.slice(0, sep) : '';
      const wName = sep > -1 ? raw.slice(sep + 1) : raw;
      if (!wName || /\.\.|[/\\:*?"<>|]/.test(wName)) throw new Error('请先选择一个有效的存档（世界）');
      let sBase = path.join(config.gameDir, 'saves');
      if (inst) {
        const iDir = safeInstanceDir(inst);
        if (!iDir) throw new Error('实例名无效: ' + inst);
        const iSaves = path.join(iDir, 'saves');
        if (fs.existsSync(iSaves)) sBase = iSaves;
      }
      const wDir = path.join(sBase, wName);
      if (!fs.existsSync(wDir)) throw new Error('存档不存在: ' + wName);
      dest = path.join(wDir, 'datapacks', file.filename || path.basename(file.url));
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    setStatus('下载' + typeName + ': ' + path.basename(dest), true);
    await mrDownload(file.url, dest, () => {}, dlsig);
    setStatus('就绪');
    toast(type === 'datapack'
      ? '数据包已装入「' + p.world + '」：' + path.basename(dest) + '（进入世界后自动生效）'
      : type === 'shader'
        ? '光影已装入 shaderpacks：' + path.basename(dest) + '（游戏内用 Iris / OptiFine 选中即可生效）'
        : typeName + '已安装: ' + path.basename(dest));
    return { ok: true, file: path.basename(dest) };
  } catch (e) {
    setStatus('就绪');
    return { ok: false, cancelled: !!(dlsig && dlsig.aborted), error: e.message };
  } finally { if (p.jobKey) dlRelease(p.jobKey); }
});
/* 下载并安装 Modrinth 整合包（.mrpack） */
async function installModrinthIndex(index, packBuf, displayName, dlsig) {
  const deps = index.dependencies || {};
  const mcVer = deps.minecraft || deps['minecraft'];
  let loader = 'vanilla';
  if (deps['fabric-loader']) loader = 'fabric';
  else if (deps['quilt-loader']) loader = 'quilt';
  else if (deps.forge) loader = 'forge';
  else if (deps.neoforge) loader = 'neoforge';
  const name = sanitizeVersionId(displayName || index.name || ('modpack-' + mcVer));
  prepareInstallSlot(config.gameDir, name); /* 已安装→友好提示；残留目录→自动归档 */
  send('launch:log', '[整合包] 安装 Minecraft ' + mcVer + ' (' + loader + ') · 名称 ' + name);
  /* 注意：installMcWithLoader 走的是游戏安装那套（无取消信号），「停止」在这个阶段
     只能等到下一个整合包文件开始时才生效 —— 先这么用，深改游戏安装超本次范围 */
  const versionId = await installMcWithLoader(mcVer, loader, name);
  const gd = config.gameDir;
  // mod 文件（path 相对 gameDir，禁止越界）
  const files = index.files || [];
  let i = 0;
  phaseBegin('modpack-files', files.reduce((s, f) => s + (f.fileSize || 0), 0));
  for (const f of files) {
    if (dlsig && dlsig.aborted) throw new Error('已取消');
    i++;
    if (!f.path || /\.\./.test(f.path) || path.isAbsolute(f.path)) continue;
    const url = (f.downloads || [])[0];
    if (!url) continue;
    send('install:progress', { stage: 'modpack-files', current: i, total: files.length, percent: Math.round(i / files.length * 100), text: '整合包文件 ' + i + '/' + files.length });
    const dest = path.join(gd, f.path);
    await mrDownload(url, dest, () => {}, dlsig);
  }
  // overrides 覆盖到 gameDir（options.txt 不覆盖已有）
  if (packBuf) {
    const ovr = findZipEntries(packBuf, n => n.startsWith('overrides/') && !n.endsWith('/'));
    let copied = 0;
    for (const it of ovr) {
      const rel = it.name.slice('overrides/'.length);
      if (!rel || /\.\./.test(rel)) continue;
      const dest = path.join(gd, rel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, it.data);
      copied++;
    }
    send('launch:log', '[整合包] overrides 应用 ' + copied + ' 个文件');
  }
  return { versionId, mods: files.length };
}
ipcMain.handle('modrinth:install-modpack', async (_e, p) => {
  const dlsig = p.jobKey ? dlSignalOf(p.jobKey) : null;
  try {
    netReset();
    const vers = await mrJson('/project/' + encodeURIComponent(p.projectId) + '/version');
    if (!vers.length) throw new Error('该整合包没有可用版本');
    const file = (vers[0].files || []).find(f => f.primary) || vers[0].files[0];
    if (!file || !/\.mrpack$/i.test(file.filename || '')) throw new Error('未找到 .mrpack 主文件');
    const tmp = path.join(os.tmpdir(), 'lmc-' + file.filename);
    setStatus('下载整合包: ' + file.filename, true);
    await mrDownload(file.url, tmp, () => {}, dlsig);
    const buf = await fsp.readFile(tmp);
    const index = JSON.parse(zipReadEntry(buf, 'modrinth.index.json').toString('utf8'));
    const r = await installModrinthIndex(index, buf, p.name || vers[0].name || p.projectId, dlsig);
    await fsp.unlink(tmp).catch(() => {});
    setStatus('就绪');
    toast('整合包安装完成: ' + r.versionId);
    return { ok: true, versionId: r.versionId };
  } catch (e) {
    setStatus('就绪');
    return { ok: false, cancelled: !!(dlsig && dlsig.aborted), error: e.message };
  } finally { if (p.jobKey) dlRelease(p.jobKey); }
});

/* ---------------- 整合包导出 / 本地导入 ---------------- */
/* ============================================================================
   导出内容选项（对齐 PCL2「导出整合包」页的选项清单与规则语义）
   ----------------------------------------------------------------------------
   PCL 的做法不是「逐项去收集目录」，而是：
     ① 把**勾选了的**选项展开成一份**有序的规则表**（`!` 开头=反选；靠后的行覆盖靠前的）
     ② 递归遍历实例目录（根上的 assets/versions/libraries 跳过），逐个文件按规则表判定去留
   「最后命中的那条说了算」是关键 —— 所以「Mod」整包收了 mods/ 之后，勾上
   「已禁用的 Mod」还能把 *.disabled 单独捞回来；「Mod 设置」排除了 config/jei/world/
   之后，「JEI 个人信息」又能把它加回来。这里采用同一套语义。
   动态子项（资源包 / 光影包 / 存档）用 `dyn:<相对路径>` 当 id，路径本身就是规则。
   ============================================================================ */
const EXP_SKIP_ROOT = ['assets', 'versions', 'libraries'];   /* 实例根目录里这几个不扫（PCL 同款） */
const EXP_SKIP_ANY = ['structureCacheV1', '.fabric', '.git', 'avatar-cache', 'cosmetic-cache'];
/* 兜底反选（拼在规则表末尾，PCL 同款）：日志、旧存档残留、别家启动器的痕迹一律不打包 */
const EXP_TAIL = ['!*.log', '!*.dat_old', '!*.BakaCoreInfo', '!hmclversion.cfg', '!log4j2.xml'];
const EXP_MAX_FILE = 256 * 1024 * 1024;    /* 单文件上限（zip 在内存里拼） */
const EXP_MAX_TOTAL = 640 * 1024 * 1024;   /* 整包上限 */
/* 「整合包重要数据」的那一大串：脚本 / 内置资源包 / 数据包 / 老版本 mods 附带目录 */
const EXP_RULES_DATA = ('hotai/|bansoukou/|addons/|multiblocked/|modpack-update-checker/|global_packs/|' +
  'global_resource_packs/|global_data_packs/|optional_data_packs/|moonlight-global-datapacks/|maps/|icon.png|' +
  'mods-resourcepacks/|matmos/|resource_assorts/|resource_assorts.json|patchouli_books/|datapacks/|kubejs*/|' +
  '!kubejs*/probe/|!kubejs*/exported/|!kubejs*/jsconfig.json|!kubejs*/README.txt|openloader/|worldshape/|' +
  'resources/|scripts/|structures/|fontfiles/|oresources/|packmenu/|craftpresence/|pointblanks/|template*/|' +
  '!template*/playerdata/|!template*/stats/').split('|');
/* 「Mod 设置」：config 为主，再把「各 Mod 存在游戏目录里的私有配置」逐条点名收进来 */
const EXP_RULES_CONFIG = ('config/|!config/jei/world/|!config/worldedit/|config/worldedit/worldedit.properties|' +
  '!config/spark/|config/spark/config.json|defaultconfigs/|journeymap/config/|journeymap/server/|' +
  'TrashSlotSaveState.json|customfov.txt|gg.essential.mod/|essential/|!essential/*/|!essential/*.jar*|' +
  '!essential/screenshot-checksum-caches.json|!essential/microsoft_accounts.json|paragliderSettings.nbt|' +
  'local/client_config.json|local/ftbl.json|local/client/sidebar_buttons.json|local/client/ftbutilities.cfg|' +
  'local/client/ftblib.cfg|local/client/xencraft.cfg|liteloader.properties|default_reference.xml|' +
  'CustomSkinLoader/CustomSkinLoader.json|!config/tacz/custom').split('|');
const EXP_OPTIONS = [
  { id: 'basic', title: '游戏本体', desc: '版本信息与库文件（导入时联网下载，不进包）', def: true, locked: true, rules: [] },
  { id: 'options', title: '游戏本体设置', desc: '键位、音量、视频设置等', def: true, rules: ['options.txt', 'configureddefaults/'] },
  { id: 'personal', title: '游戏本体个人信息', desc: '命令历史、已保存的快捷栏', def: false, rules: ['hotbar.nbt', 'command_history.txt'] },
  { id: 'optifine', title: 'OptiFine 设置', need: 'optifine', def: true, rules: ['optionsof.txt', 'optionsshaders.txt'] },
  { id: 'mods', title: 'Mod', desc: '模组', need: 'mods', def: true,
    rules: ['mods/', '!mods/*.disabled', '!mods/*.old', '!mods/.connector/', 'coremods/', 'lib/'] },
  { id: 'mods-disabled', title: '已禁用的 Mod', group: 'mods', def: false, rules: ['mods/*.disabled', 'mods/*.old'] },
  { id: 'mods-data', title: '整合包重要数据', desc: '脚本文件、内置资源包、数据包等', group: 'mods', def: true, rules: EXP_RULES_DATA },
  { id: 'mods-config', title: 'Mod 设置', group: 'mods', def: true, rules: EXP_RULES_CONFIG },
  { id: 'mods-tacz', title: 'TaCZ 枪包', group: 'mods', def: true, rules: ['tacz/', 'config/tacz/custom/'] },
  { id: 'mods-paint', title: '已上传的沉浸画', group: 'mods', def: true, rules: ['immersive_paintings/'] },
  { id: 'mods-map', title: '已绘制的地图', desc: '地图类 Mod 记下的地图、路标点等', group: 'mods', def: false,
    rules: ['journeymap/data/', 'xaero/', 'XaeroWaypoints/', 'XaeroWorldMap/'] },
  { id: 'mods-jei', title: 'JEI 个人信息', desc: '物品收藏夹等', group: 'mods', def: false, rules: ['config/jei/world/'] },
  { id: 'mods-emi', title: 'EMI 个人信息', desc: '物品收藏夹、默认配方、合成历史记录等', group: 'mods', def: false, rules: ['emi.json'] },
  { id: 'mods-patchouli', title: '帕秋莉手册个人信息', desc: '教程书的已读记录、书签、阅读历史等', group: 'mods', def: false, rules: ['patchouli_data.json'] },
  /* 动态子项（资源包/光影包/存档）：父项自己也带一份「整目录」规则 ——
     界面走的是「勾了哪些子项收哪些子项」，但老调用方还在按目录名选（include:['saves']），
     有这条兜底才不至于选了父项却什么都没打包。 */
  { id: 'resourcepacks', title: '资源包', desc: '纹理包 / 材质包', def: true, dyn: 'resourcepacks',
    folders: ['resourcepacks', 'texturepacks'], acceptFiles: ['.zip', '.rar'], acceptDir: true,
    rules: ['resourcepacks/', 'texturepacks/'] },
  { id: 'shaderpacks', title: '光影包', def: true, dyn: 'shaderpacks',
    folders: ['shaderpacks'], acceptFiles: ['.zip', '.rar'], acceptDir: true, rules: ['shaderpacks/'] },
  { id: 'shaderpacks-settings', title: '光影包设置', desc: '已选光影包的自定义设置', group: 'shaderpacks', def: true, rules: [] },
  { id: 'screenshots', title: '截图', def: false, rules: ['screenshots/'] },
  { id: 'schematics', title: '导出的结构', desc: 'schematics 文件夹', def: false, rules: ['schematics/'] },
  { id: 'replay', title: '录像回放', desc: 'Replay Mod 的录像文件', need: 'mods', def: false, rules: ['replay_recordings/', 'replay_videos/'] },
  { id: 'saves', title: '单人游戏存档', desc: '世界 / 地图', def: false, dyn: 'saves',
    folders: ['saves'], acceptFiles: [], acceptDir: true, rules: ['saves/'] },
  { id: 'licence', title: '协议', desc: 'Licence 文件', def: true, rules: ['LICEN*'] },
  { id: 'servers', title: '多人游戏服务器列表', def: false, rules: ['servers.dat'] },
  { id: 'java', title: '版本文件夹中的 Java', desc: '把启动器自动下载的 Java 一起打包（体积很大，一般不必）', def: false, rules: ['runtime/'] }
];
const EXP_OPT_BY_ID = new Map(EXP_OPTIONS.map(o => [o.id, o]));
/* 旧签名用的目录名 → 新选项 id（feat-smoke 等老调用方还在传 include:['mods',...]） */
const EXP_LEGACY = { mods: 'mods', config: 'mods-config', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', saves: 'saves' };
/* 反向：新选项 id → 老 manifest 里的目录名（只为兼容老字段 folders 的展示） */
const EXP_LEGACY_NAME = { mods: 'mods', 'mods-config': 'config', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', saves: 'saves', options: 'options.txt' };

/* VB 的 Like 通配：`*` 连路径分隔符一起吞（所以 `mods/` 标准化成 `mods/*` 后能匹配整棵子树） */
function expLikeRe(pat) {
  let s = '';
  for (const ch of pat) {
    if (ch === '*') s += '[\\s\\S]*';
    else if (ch === '?') s += '[\\s\\S]';
    else s += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + s + '$', 'i');
}
/* 规则行 → 匹配器；末尾带 / 的按 PCL 的做法补一个 *（＝整个子树） */
function expMatcher(line) {
  const neg = line.startsWith('!');
  let p = line.replace(/^!+/, '');
  if (p.endsWith('/')) p += '*';
  return { re: expLikeRe(p), neg, raw: line };
}
function expNormalizeRules(lines) {
  const out = [];
  for (const l of lines) {
    const s = String(l == null ? '' : l).trim();
    if (!s || s.startsWith('#')) continue;
    out.push(s);
  }
  return out;
}
/* 选中的选项 id 列表 → 有序规则表（动态子项的 id 本身就是规则，直接入表） */
function expRuleLines(selected) {
  const lines = [];
  for (const id of (selected || [])) {
    if (typeof id !== 'string') continue;
    if (id.startsWith('dyn:')) { lines.push(id.slice(4)); continue; }
    const o = EXP_OPT_BY_ID.get(id);
    if (!o || id === 'shaderpacks-settings') continue;   /* 光影包设置由下面按勾选的光影包展开 */
    if (o.rules && o.rules.length) lines.push(...o.rules);
  }
  /* 光影包设置：只导出「勾选了的那些光影包」对应的 <包名>.txt（与 PCL 同款） */
  if ((selected || []).includes('shaderpacks-settings')) {
    for (const id of selected) {
      if (typeof id !== 'string' || !id.startsWith('dyn:shaderpacks/')) continue;
      lines.push(id.slice(4).replace(/\/+$/, '') + '.txt');
    }
  }
  return expNormalizeRules(lines.concat(EXP_TAIL));
}
/* 末条命中为准 */
function expKeep(rel, matchers) {
  let keep = false;
  for (const m of matchers) if (m.re.test(rel)) keep = !m.neg;
  return keep;
}
const expMatch = (rules) => expNormalizeRules(rules).map(expMatcher);
/* 递归列出实例目录里的文件（相对路径用 / 分隔）；只走路，不读内容 */
async function expWalk(dir, rel, out, depth) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (depth === 0 && EXP_SKIP_ROOT.includes(e.name)) continue;
      if (EXP_SKIP_ANY.includes(e.name)) continue;
      await expWalk(path.join(dir, e.name), r, out, depth + 1);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
}
/* 隔离实例里 runtime/ 在游戏目录下（Java 不在实例目录），单独补一根根目录 */
async function expWalkAll(baseDir, gd, isolated) {
  const out = [];
  await expWalk(baseDir, '', out, 0);
  if (isolated) {
    const rt = path.join(gd, 'runtime');
    try { if (fs.statSync(rt).isDirectory()) await expWalk(rt, 'runtime', out, 1); } catch (_) {}
  }
  return out;
}
/* 相对路径 → 绝对路径（隔离实例的 runtime/ 落在游戏目录里） */
function expAbsOf(baseDir, gd, rel) {
  const a = path.join(baseDir, rel);
  try { fs.statSync(a); return a; } catch (_) {}
  const b = path.join(gd, rel);
  try { fs.statSync(b); return b; } catch (_) {}
  return a;
}
/* 遍历时顺手把大小记下来，避免统计阶段再 stat 一遍 */
const EXP_SIZE_HINT = new Map();
/* 一组规则命中的文件数 / 总字节（界面上的「N 个文件 · X MB」与「没内容就不显示」都靠它） */
function expStats(rels, rules) {
  const ms = expMatch(rules.concat(EXP_TAIL));
  let count = 0, bytes = 0;
  for (const rel of rels) {
    if (!expKeep(rel, ms)) continue;
    count++;
    bytes += EXP_SIZE_HINT.get(rel) || 0;
  }
  return { count, bytes };
}
function expSizeOf(baseDir, gd, rel) {
  try { return fs.statSync(expAbsOf(baseDir, gd, rel)).size; } catch (_) { return 0; }
}
/* 动态子项：资源包 / 光影包 / 存档 下逐项列出（PCL 同款；存档按修改时间倒序） */
function expDynChildren(o, baseDir, rels, gd) {
  const kids = [];
  for (const folder of o.folders) {
    const dir = path.join(baseDir, folder);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    const subs = [];
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!o.acceptDir) continue;
        let inner = [];
        try { inner = fs.readdirSync(path.join(dir, e.name)); } catch (_) { continue; }
        if (!inner.length) continue;                     /* 空文件夹不列（PCL 同款） */
        let mt = 0;
        try { mt = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch (_) {}
        subs.push({ id: 'dyn:' + folder + '/' + e.name + '/', title: e.name, desc: '文件夹', def: true, mtime: mt });
      } else if (e.isFile() && (o.acceptFiles || []).some(x => e.name.toLowerCase().endsWith(x))) {
        subs.push({ id: 'dyn:' + folder + '/' + e.name, title: e.name, desc: '', def: true, mtime: 0 });
      }
    }
    if (o.dyn === 'saves') subs.sort((a, b) => b.mtime - a.mtime);
    for (const s of subs) {
      const st = expStats(rels, [s.id.slice(4)]);
      s.count = st.count; s.bytes = st.bytes; s.dyn = true; s.parent = o.id;
      kids.push(s);
    }
  }
  return kids;
}
/* 生成界面要的选项清单（带可用性、默认勾选、文件数/体积） */
async function buildExportOptions(versionId) {
  const gd = config.gameDir;
  const instDir = path.join(gd, 'versions', versionId);
  if (!fs.existsSync(instDir)) return { ok: false, error: '实例目录不存在' };
  const isolated = fs.existsSync(path.join(instDir, 'mods')) || fs.existsSync(path.join(instDir, 'saves'));
  const baseDir = isolated ? instDir : gd;
  const rels = await expWalkAll(baseDir, gd, isolated);
  EXP_SIZE_HINT.clear();
  for (const rel of rels) EXP_SIZE_HINT.set(rel, expSizeOf(baseDir, gd, rel));
  const modsStat = modStatsFor(versionId);
  let loader = 'Vanilla';
  try { loader = detectLoaderOf((await loadVersionChain(versionId, gd, 0)).json); } catch (_) {}
  const list = [];
  for (const o of EXP_OPTIONS) {
    /* 可用性（对应 PCL 的 RequireModLoader / RequireOptiFine / ShowRules） */
    if (o.need === 'optifine' && !modsStat.optifine) continue;
    if (o.need === 'mods' && !modsStat.mods && loader === 'Vanilla') continue;
    if (o.group) {
      const gs = expStats(rels, o.rules || []);
      if (!gs.count) continue;                           /* 子项也按 PCL 的做法：命中不了就不显示 */
      list.push({ id: o.id, title: o.title, desc: o.desc || '', def: !!o.def, group: o.group, count: gs.count, bytes: gs.bytes });
      continue;
    }
    if (o.dyn) {
      const kids = expDynChildren(o, baseDir, rels, gd);
      if (!kids.length) continue;                        /* 目录里没东西就不显示（PCL 同款） */
      const count = kids.reduce((a, k) => a + k.count, 0);
      const bytes = kids.reduce((a, k) => a + k.bytes, 0);
      list.push({ id: o.id, title: o.title, desc: o.desc || '', def: !!o.def, dyn: true, count, bytes, kids });
      continue;
    }
    if (o.locked) { list.push({ id: o.id, title: o.title, desc: o.desc || '', def: true, locked: true, count: 0, bytes: 0 }); continue; }
    const st = expStats(rels, o.rules || []);
    if (!st.count) continue;                             /* 一个文件都命不中 → 不显示（PCL 的 IsVisible） */
    list.push({ id: o.id, title: o.title, desc: o.desc || '', def: !!o.def, count: st.count, bytes: st.bytes });
  }
  return { ok: true, versionId, isolated, loader, options: list };
}
/* 核心：构建整合包 zip（handler 只负责保存对话框）。
   opts.options: 选中的选项 id 列表（新签名）；
   opts.include / opts.includeOptions: 旧签名（['mods','config',...] / 是否带 options.txt），仍然认 */
async function buildModpackBuffer(versionId, opts) {
  opts = opts || {};
  let selected = [];
  if (Array.isArray(opts.options)) {
    selected = opts.options.slice();
  } else {
    if (Array.isArray(opts.include)) for (const f of opts.include) if (EXP_LEGACY[f]) selected.push(EXP_LEGACY[f]);
    if (opts.includeOptions !== false) selected.unshift('options');
    if (!selected.length) selected = ['mods'];
  }
  const gd = config.gameDir;
  const chain = await loadVersionChain(versionId, gd, 0);
  const loader = detectLoaderOf(chain.json);
  /* 版本隔离实例：内容从实例目录取，并在 manifest 标记 isolated（导入端照原样放回去） */
  const instDir = path.join(gd, 'versions', versionId);
  const isolated = fs.existsSync(path.join(instDir, 'mods')) || fs.existsSync(path.join(instDir, 'saves'));
  const baseDir = isolated ? instDir : gd;
  const rules = expNormalizeRules(expRuleLines(selected));
  const matchers = rules.map(expMatcher);
  const argues = selected.filter(s => typeof s === 'string' && !s.startsWith('dyn:'));
  const dynPaths = selected.filter(s => typeof s === 'string' && s.startsWith('dyn:')).map(s => s.slice(4));
  const warns = [];
  /* 整棵目录只走一遍，再按规则表逐文件判定 —— 与 PCL 完全同序 */
  const rels = await expWalkAll(baseDir, gd, isolated);
  const files = [];
  let total = 0;
  for (const rel of rels) {
    if (!expKeep(rel, matchers)) continue;
    const abs = expAbsOf(baseDir, gd, rel);
    let st = null;
    try { st = await fsp.stat(abs); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (st.size > EXP_MAX_FILE) { warns.push(rel + '（超 ' + Math.round(EXP_MAX_FILE / 1048576) + 'MB，已跳过）'); continue; }
    total += st.size;
    if (total > EXP_MAX_TOTAL) {
      throw new Error('要打包的内容超过 ' + Math.round(EXP_MAX_TOTAL / 1048576) +
        ' MB，内存里塞不下 —— 请少勾几项（比如「单人游戏存档」/「资源包」/「Java」）再试');
    }
    try { files.push({ name: rel, data: await fsp.readFile(abs) }); }
    catch (e) { warns.push(rel + '（读取失败）'); }
  }
  const modsCount = files.filter(f => /^mods\/[^/]+$/i.test(f.name)).length;
  const manifest = {
    format: 'lmc-modpack', formatVersion: 3, name: versionId,
    packName: opts.name || versionId, packVersion: opts.version || '',
    mcVersion: chain.rootId, loader, modsCount,
    isolated: !!isolated,
    options: argues.slice(), dyn: dynPaths.slice(),
    /* 兼容旧字段：老版本 XLC 的导入端只认 folders / includeOptions */
    folders: argues.map(id => EXP_LEGACY_NAME[id]).filter(Boolean),
    includeOptions: argues.includes('options'),
    ruleCount: rules.length,
    exportedAt: new Date().toISOString()
  };
  const out = [{ name: 'lmc-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }];
  out.push(...files);
  return { buf: buildZip(out), manifest, warns, files: files.length, bytes: total };
}
/* 核心：从 buffer 导入 LMC 格式整合包 */
/* 把包里的文件按原路径还原到 instDir（已存在的文件不覆盖，避免冲掉玩家本机的东西）。
   formatVersion 2 起包里就是「实例目录相对路径」的原样快照，所以不再逐目录点名 ——
   mods / options.txt / config / 资源包 / 光影 / 存档 / 地图 / 脚本 … 一视同仁。 */
async function restoreLmcFiles(buf, instDir) {
  const SKIP = new Set(['lmc-manifest.json', 'modrinth.index.json']);
  let mods = 0, count = 0;
  for (const it of findZipEntries(buf, () => true)) {
    if (SKIP.has(it.name) || it.name.endsWith('/')) continue;
    if (/\.\./.test(it.name) || path.isAbsolute(it.name)) continue;
    const dest = path.join(instDir, it.name);
    const rel = path.relative(instDir, dest);
    if (!rel || rel.startsWith('..')) continue;
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) { continue; }
    if (fs.existsSync(dest)) continue;
    try { await fsp.writeFile(dest, it.data); } catch (_) { continue; }
    count++;
    if (/^mods\/[^/]+$/i.test(it.name)) mods++;
  }
  return { mods, count };
}
async function importLmcPack(buf) {
  const man = JSON.parse(zipReadEntry(buf, 'lmc-manifest.json').toString('utf8'));
  const name = sanitizeVersionId(man.name);
  prepareInstallSlot(config.gameDir, name); /* 已安装→友好提示；残留目录→自动归档 */
  const versionId = await installMcWithLoader(man.mcVersion, man.loader, name);
  const gd = config.gameDir;
  /* 隔离包（来自隔离实例）→ 内容放回新实例的 versions/<name>/ 里，保持隔离；
     普通包（来自非隔离实例）→ 放回游戏目录。导出时 manifest 里记了 isolated，这里照它走。 */
  const instDir = man.isolated ? path.join(gd, 'versions', versionId) : gd;
  const r = await restoreLmcFiles(buf, instDir);
  return { versionId, mods: r.mods, extras: r.count - r.mods };
}
/* 界面渲染导出选项清单（PCL 式：可用性、默认勾选、每项命中的文件数/体积都在这里算好） */
ipcMain.handle('modpack:export-options', async (_e, versionId) => {
  try { return await buildExportOptions(versionId); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('modpack:export', async (_e, versionId, opts) => {
  opts = opts || {};
  try {
    const packName = String(opts.name || versionId).trim() || versionId;
    const packVer = String(opts.version || '').trim();
    const base = (packName + (packVer ? ' ' + packVer : '')).replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog({
      title: '导出整合包', defaultPath: base + '.lmcmod',
      filters: [{ name: 'XLC 整合包', extensions: ['lmcmod'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    setStatus('打包整合包…', true);
    const { buf, manifest, warns, files, bytes } = await buildModpackBuffer(versionId, opts);
    await fsp.writeFile(r.filePath, buf);
    setStatus('就绪');
    const mb = (bytes / 1048576).toFixed(1);
    toast('整合包已导出: ' + r.filePath + '（' + files + ' 个文件 · ' + mb + ' MB）');
    if (warns && warns.length) logLine('[export] 跳过文件: ' + warns.join(', '));
    return { ok: true, path: r.filePath, mods: manifest.modsCount, files, bytes, warns: warns || [] };
  } catch (e) { setStatus('就绪'); return { ok: false, error: e.message }; }
});
ipcMain.handle('modpack:import', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: '导入整合包',
      filters: [{ name: '整合包', extensions: ['lmcmod', 'mrpack', 'zip'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const fp = r.filePaths[0];
    setStatus('导入整合包…', true);
    const buf = await fsp.readFile(fp);
    setStatus('导入整合包…', true);
    // LMC 自有格式
    try {
      const rr = await importLmcPack(buf);
      setStatus('就绪');
      toast('整合包导入完成: ' + rr.versionId + '（' + rr.mods + ' 个 MOD）');
      return { ok: true, versionId: rr.versionId, mods: rr.mods };
    } catch (_) { /* 不是 LMC 格式，继续尝试其他 */ }
    // Modrinth mrpack
    try {
      const index = JSON.parse(zipReadEntry(buf, 'modrinth.index.json').toString('utf8'));
      const rr = await installModrinthIndex(index, buf, path.basename(fp).replace(/\.(mrpack|zip)$/i, ''));
      setStatus('就绪');
      toast('Modrinth 整合包安装完成: ' + rr.versionId);
      return { ok: true, versionId: rr.versionId, mods: rr.mods };
    } catch (_) { /* 不是 mrpack */ }
    // CurseForge zip（尽力而为：装版本 + 解 overrides，mod 需手动补）
    try {
      const man = JSON.parse(zipReadEntry(buf, 'manifest.json').toString('utf8'));
      if (man.manifestType !== 'minecraftModpack') throw new Error('not CF');
      const mcVer = man.minecraft && man.minecraft.version;
      const ml = (man.minecraft && man.minecraft.modloaders || []).find(x => x.primary) || (man.minecraft && man.minecraft.modloaders || [])[0];
      const loader = ml && /^forge-(.+)/.test(ml.id) ? 'forge' : ml && /^neoforge-(.+)/.test(ml.id) ? 'neoforge' : 'vanilla';
      const build = ml && /^forge-(.+)/.exec(ml.id) ? /^forge-(.+)/.exec(ml.id)[1] : '';
      const name = sanitizeVersionId((man.name || 'cf-pack') + '-' + (man.version || mcVer));
      const versionId = await installMcWithLoader(mcVer, loader, name);
      const gd = config.gameDir;
      const prefix = (man.overrides || 'overrides') + '/';
      const ovr = findZipEntries(buf, n => n.startsWith(prefix) && !n.endsWith('/'));
      for (const it of ovr) {
        const rel = it.name.slice(prefix.length);
        if (!rel || /\.\./.test(rel)) continue;
        const dest = path.join(gd, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, it.data);
      }
      const needMods = (man.files || []).length;
      setStatus('就绪');
      toast('CurseForge 整合包已导入 ' + versionId + '；其中 ' + needMods + ' 个 MOD 需手动下载放入 mods 目录', 'warn');
      return { ok: true, versionId, warn: needMods ? needMods + ' 个 CurseForge MOD 需手动下载（CF 无公开直链）' : '' };
    } catch (_) { throw new Error('无法识别的整合包格式（支持 XLC .lmcmod / Modrinth .mrpack / CurseForge .zip）'); }
  } catch (e) { setStatus('就绪'); return { ok: false, error: e.message }; }
});

/* ---------------- 游戏设置：加载器信息 / 更改 / 卸载（HMCL 式） ---------------- */
const INST_DATA_DIRS = ['mods', 'saves', 'config', 'resourcepacks', 'shaderpacks'];
function detectLoaderVer(json) {
  const libs = (json.libraries || []).map(l => l.name || '').join(' ');
  let m;
  if ((m = libs.match(/net\.fabricmc:fabric-loader:([^:\s]+)/))) return m[1];
  if ((m = libs.match(/org\.quiltmc:quilt-loader:([^:\s]+)/))) return m[1];
  if ((m = libs.match(/net\.neoforged:neoforge:([^:\s]+)/))) return m[1];
  if ((m = libs.match(/net\.minecraftforge:forge:([^:\s]+)/))) return m[1].split('-').pop();
  const mm = /forge-([\d.]+)/.exec(json.id || '');
  return mm ? mm[1] : '';
}
/* 更改加载器时的兼容性检查（与下载页口径一致） */
function loaderChangeCompat(mcVer, loader) {
  if (loader === 'Vanilla') return null;
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mcVer || '');
  if (!m) return loader === 'Forge' ? '该版本无法安装 Forge' : null;
  const [maj, min, pat] = [+m[1], +m[2], +m[3] || 0];
  if (loader === 'NeoForge' && !(maj > 1 || (maj === 1 && (min > 20 || (min === 20 && pat >= 1)))))
    return 'NeoForge 仅支持 1.20.1 及以上版本';
  if ((loader === 'Fabric' || loader === 'Quilt') && !(maj > 1 || (maj === 1 && min >= 14)))
    return loader + ' 支持自 1.14 开始';
  return null;
}
/* 把实例本体的数据（mods/saves/config/resourcepacks/shaderpacks/options.txt）搬到目标实例目录 */
async function moveInstanceData(srcDir, dstDir) {
  for (const n of INST_DATA_DIRS) {
    const s = path.join(srcDir, n), d = path.join(dstDir, n);
    if (!fs.existsSync(s)) continue;
    await fsp.rename(s, d).catch(() => { fs.cpSync(s, d, { recursive: true }); fs.rmSync(s, { recursive: true, force: true }); });
  }
  const osrc = path.join(srcDir, 'options.txt');
  if (fs.existsSync(osrc)) await fsp.rename(osrc, path.join(dstDir, 'options.txt')).catch(() => {});
}
/* ---------------- 实例级设置（对齐 PCL「版本设置 → 设置」） ----------------
   config.versionSettings[实例名] = {
     title      游戏窗口标题（启动时以 --title 传给客户端）
     isolated   ''=自动（有 mods / saves 就隔离）｜'on'=强制隔离 ｜'off'=强制不隔离
     javaMode   'auto' 自动选择 ｜ 'range' 按版本区间自动挑 ｜ 'dir' 用版本文件夹里的 Java ｜ 'custom' 用指定路径
     javaRange  版本区间，如 [17.0, 25.0)
     javaPath / javaMajor   'custom' 模式下的 Java 路径与大版本
     ramType    2=跟随全局 ｜ 0=自动配置 ｜ 1=自定义
     ramCustom  自定义内存（GB，ramType=1 时有效）
     jvmArgs    额外 JVM 参数（留空 = 跟随全局设置里的那份）
     gameArgs   额外游戏参数（直接拼在启动参数末尾）
   }
   实例改名时键跟着迁移；实例删除时清掉键；全是默认值的实例不占键。 */
function versionSettingsOf(id) {
  const m = (config.versionSettings && typeof config.versionSettings === 'object') ? config.versionSettings : {};
  const v = (id && m[id] && typeof m[id] === 'object') ? m[id] : {};
  const ramType = parseInt(v.ramType, 10);
  return {
    title: String(v.title || ''),
    isolated: (v.isolated === 'on' || v.isolated === 'off') ? v.isolated : '',
    javaMode: ['auto', 'range', 'dir', 'custom'].indexOf(v.javaMode) >= 0 ? v.javaMode : 'auto',
    javaRange: String(v.javaRange || ''),
    javaPath: String(v.javaPath || ''),
    javaMajor: Math.max(0, parseInt(v.javaMajor, 10) || 0),
    ramType: (ramType === 0 || ramType === 1 || ramType === 2) ? ramType : 2,
    ramCustom: Math.max(0, parseInt(v.ramCustom, 10) || 0),
    jvmArgs: String(v.jvmArgs || ''),
    gameArgs: String(v.gameArgs || '')
  };
}
/* 全是默认值就不在配置里占键（免得留下空壳、也让「有没有改过」一眼可见） */
function isDefaultVersionSettings(v) {
  return !v.title && !v.isolated && v.javaMode === 'auto' && !v.javaRange && !v.javaPath &&
    v.ramType === 2 && !v.ramCustom && !v.jvmArgs && !v.gameArgs;
}
function saveVersionSettings(id, patch) {
  const next = Object.assign({}, versionSettingsOf(id), patch || {});
  const map = Object.assign({}, config.versionSettings || {});
  if (isDefaultVersionSettings(next)) delete map[id];
  else map[id] = next;
  config.versionSettings = map;
  saveConfigNow();
  return next;
}
ipcMain.handle('version:settings-save', async (_e, p) => {
  try {
    const id = String((p && p.id) || '');
    if (!id || path.basename(id) !== id) throw new Error('实例名无效');
    if (!fs.existsSync(path.join(config.gameDir, 'versions', id))) throw new Error('实例不存在: ' + id);
    const patch = {};
    if (p && typeof p.title === 'string') patch.title = p.title.trim().slice(0, 80);
    if (p && typeof p.isolated === 'string') patch.isolated = (p.isolated === 'on' || p.isolated === 'off') ? p.isolated : '';
    if (p && typeof p.javaMode === 'string') {
      patch.javaMode = ['auto', 'range', 'dir', 'custom'].indexOf(p.javaMode) >= 0 ? p.javaMode : 'auto';
    }
    if (p && typeof p.javaRange === 'string') {
      const r = p.javaRange.trim().slice(0, 100);
      if (r) { try { parseJavaRange(r); } catch (e) { throw new Error('Java 版本区间格式不对：' + e.message); } }
      patch.javaRange = r;
    }
    if (p && typeof p.javaPath === 'string') {
      const jp = p.javaPath.trim();
      if (!jp) { patch.javaPath = ''; patch.javaMajor = 0; }
      else {
        if (!fs.existsSync(jp)) throw new Error('这个路径不存在: ' + jp);
        if (!/\.exe$/i.test(jp)) throw new Error('请选择 Java 的 exe（javaw.exe / java.exe）');
        let major = 0;
        try { major = await probeJavaVersion(jp); }
        catch (e) { throw new Error('这个文件不是可用的 Java: ' + (e && e.message || e)); }
        patch.javaPath = jp;
        patch.javaMajor = major;
      }
    }
    if (p && p.ramType !== undefined) {
      const t = parseInt(p.ramType, 10);
      if (t !== 0 && t !== 1 && t !== 2) throw new Error('内存分配方式无效');
      patch.ramType = t;
      if (t === 1) patch.ramCustom = Math.max(1, Math.min(64, parseInt(p.ramCustom, 10) || 2));
    }
    if (p && typeof p.jvmArgs === 'string') patch.jvmArgs = p.jvmArgs.trim().slice(0, 4000);
    if (p && typeof p.gameArgs === 'string') patch.gameArgs = p.gameArgs.trim().slice(0, 500);
    const vs = saveVersionSettings(id, patch);
    logLine('[version] 实例设置已保存 ' + id + ' · 窗口标题=' + (vs.title || '默认') + ' · Java=' + (vs.javaPath || '自动'));
    return { ok: true, settings: vs };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
/* 选一个本机的 Java 可执行文件（浏览器/资源管理器式文件对话框），顺手探测大版本 */
ipcMain.handle('version:pick-java', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: '选择 Java 可执行文件（javaw.exe / java.exe）',
      properties: ['openFile'],
      filters: [{ name: 'Java 可执行文件', extensions: ['exe'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: true, canceled: true };
    const p = r.filePaths[0];
    let major = 0;
    try { major = await probeJavaVersion(p); }
    catch (e) { throw new Error('这个文件不是可用的 Java: ' + (e && e.message || e)); }
    return { ok: true, path: p, major };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
/* 在版本文件夹里找 Java（PCL 的「使用版本文件夹中的 Java」：整合包自带 Java 的场景）。
   常见摆法：<版本文件夹>/java/bin/javaw.exe、<版本文件夹>/jre/bin/javaw.exe，或直接放在里面。
   只在这个版本目录里往下找 3 层，跳过存档 / MOD 一类的目录，不会去扫盘。 */
function findJavaInVersionDir(vDir) {
  const SKIP = /^(natives|logs|crash-reports|screenshots|saves|mods|resourcepacks|shaderpacks|config|defaultconfigs|data|assets|libraries)$/i;
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 3 || seen.has(dir)) return '';
    seen.add(dir);
    for (const n of ['javaw.exe', 'java.exe']) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
    }
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ''; }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.test(e.name) || e.name.startsWith('.')) continue;
      const r = walk(path.join(dir, e.name), depth + 1);
      if (r) return r;
    }
    return '';
  };
  return walk(vDir, 0);
}
ipcMain.handle('version:info', async (_e, p) => {
  try {
    const id = String(p.id || '');
    if (!id || path.basename(id) !== id) throw new Error('实例名无效');
    const chain = await loadVersionChain(id, config.gameDir, 0);
    const vDir = path.join(config.gameDir, 'versions');
    const iDir = path.join(vDir, id);
    /* 该实例是否被其他实例继承（继承链顶端不能改加载器，会弄坏子版本） */
    const children = [];
    for (const sub of await fsp.readdir(vDir)) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(vDir, sub, sub + '.json'), 'utf8'));
        if (j.inheritsFrom === id) children.push(sub);
      } catch (_) {}
    }
    return {
      ok: true, id, mcVer: chain.rootId,
      loader: detectLoaderOf(chain.json), loaderVer: detectLoaderVer(chain.json),
      isolated: fs.existsSync(path.join(iDir, 'mods')) || fs.existsSync(path.join(iDir, 'saves')),
      hasChildren: children.length > 0, children,
      folder: iDir,                                  /* 版本文件夹（「版本」卡里显示 / 打开用） */
      settings: versionSettingsOf(id)                /* 实例级设置：窗口标题 / 手动 Java */
    };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 主进程重算：该实例是否被其他实例继承（不信任渲染进程传来的 hasChildren，可绕过拦截弄坏继承链） */
async function instanceChildrenOf(id, vDir) {
  const children = [];
  for (const sub of await fsp.readdir(vDir).catch(() => [])) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(vDir, sub, sub + '.json'), 'utf8'));
      if (j.inheritsFrom === id) children.push(sub);
    } catch (_) {}
  }
  return children;
}
/* 更改加载器：先备份旧目录 → 安装新加载器到临时名 → 数据搬回 → 换名；失败自动回滚 */
ipcMain.handle('version:loader-change', async (_e, p) => {
  const id = String(p.id || '');
  if (!id || path.basename(id) !== id) return { ok: false, error: '实例名无效' };
  const loader = String(p.loader || '');
  const build = String(p.build || '').trim();
  const vDir = path.join(config.gameDir, 'versions');
  const oldDir = path.join(vDir, id);
  const bak = id + '__old', tmp = id + '__new';
  try {
    const chain = await loadVersionChain(id, config.gameDir, 0);
    const mcVer = chain.rootId;
    const cur = detectLoaderOf(chain.json);
    if (!loader) throw new Error('请选择目标加载器');
    if (loader === cur && !build) throw new Error('当前已是 ' + cur + '；如需换构建请在「加载器版本」里选一个具体版本');
    const bad = loaderChangeCompat(mcVer, loader);
    if (bad) throw new Error(mcVer + ' 无法安装 ' + loader + '：' + bad);
    const children = await instanceChildrenOf(id, vDir);
    if (children.length) throw new Error('该实例被其他版本继承（' + children.join(', ') + '），请先处理子版本再更改加载器');
    if (!fs.existsSync(oldDir)) throw new Error('实例目录不存在: ' + id);
    await fsp.rm(path.join(vDir, bak), { recursive: true, force: true });
    await fsp.rm(path.join(vDir, tmp), { recursive: true, force: true });
    await fsp.rename(oldDir, path.join(vDir, bak)); /* 先挪走，避免安装器写同名目录冲突 */
    try {
      setStatus('安装 ' + loader + ' → 实例 ' + id, true);
      if (loader === 'Vanilla') await installVanillaFiles(await findInManifest(mcVer), tmp);
      else if (loader === 'Fabric') await installFabricLike(mcVer, 'fabric', tmp, { build });
      else if (loader === 'Quilt') await installFabricLike(mcVer, 'quilt', tmp, { build });
      else if (loader === 'Forge') await installForge(mcVer, tmp, build || undefined);
      else if (loader === 'NeoForge') await installNeoForge(mcVer, tmp, build || undefined);
      else throw new Error('暂不支持的加载器: ' + loader);
    } catch (e) {
      /* 回滚：新目录清掉、旧目录搬回 */
      await fsp.rm(path.join(vDir, tmp), { recursive: true, force: true }).catch(() => {});
      await fsp.rename(path.join(vDir, bak), oldDir).catch(() => {});
      setStatus('就绪');
      return { ok: false, error: e.message + '（已回滚，原实例未受影响）' };
    }
    await moveInstanceData(path.join(vDir, bak), path.join(vDir, tmp));
    await fsp.rm(path.join(vDir, bak), { recursive: true, force: true });
    const finalId = await renameInstalledVersion(tmp, id);
    const nv = detectLoaderVer(JSON.parse(await fsp.readFile(path.join(vDir, id, id + '.json'), 'utf8')));
    toast('加载器已更改为 ' + (nv ? loader + ' ' + nv : loader) + ' · 实例 ' + finalId);
    setStatus('就绪');
    return { ok: true, id: finalId, loader, loaderVer: nv };
  } catch (e) {
    setStatus('就绪');
    return { ok: false, error: e.message };
  }
});
/* 卸载加载器：重建为同 MC 版本的原版实例（保留 mods/存档/设置），失败不动原实例 */
ipcMain.handle('version:loader-uninstall', async (_e, p) => {
  const id = String(p.id || '');
  if (!id || path.basename(id) !== id) return { ok: false, error: '实例名无效' };
  const vDir = path.join(config.gameDir, 'versions');
  const oldDir = path.join(vDir, id);
  const tmp = id + '__new';
  try {
    const chain = await loadVersionChain(id, config.gameDir, 0);
    const mcVer = chain.rootId;
    const cur = detectLoaderOf(chain.json);
    if (cur === 'Vanilla') throw new Error('该实例已经是原版（Vanilla），无需卸载');
    await fsp.rm(path.join(vDir, tmp), { recursive: true, force: true });
    setStatus('重建原版实例: ' + id, true);
    await installVanillaFiles(await findInManifest(mcVer), tmp); /* 库/资源已存在则秒过，仅重下 client jar */
    await moveInstanceData(oldDir, path.join(vDir, tmp));
    await fsp.rm(oldDir, { recursive: true, force: true });
    const finalId = await renameInstalledVersion(tmp, id);
    toast('已卸载 ' + cur + '，实例 ' + finalId + ' 重建为原版（MC ' + mcVer + '）');
    setStatus('就绪');
    return { ok: true, id: finalId };
  } catch (e) {
    await fsp.rm(path.join(vDir, tmp), { recursive: true, force: true }).catch(() => {});
    setStatus('就绪');
    return { ok: false, error: e.message };
  }
});

/* ---------------- 自定义文件下载 ---------------- */
ipcMain.handle('custom:download', async (_e, p) => {
  try {
    netReset();
    const url = String(p.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('请输入有效的 http(s) 下载地址');
    let fileName = '';
    try { fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (_) {}
    fileName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!fileName || fileName === '_') { fileName = 'download-' + Date.now() + '.bin'; }
    if (!/\.[A-Za-z0-9]{1,8}$/.test(fileName)) fileName += '.jar';
    let dest;
    if (p.target === 'pick') {
      const r = await dialog.showSaveDialog({ title: '保存自定义文件', defaultPath: fileName });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      dest = r.filePath;
    } else {
      const base = p.target === 'mods' ? modsDirFor(p.instance)
        : path.join(config.gameDir, p.target === 'resourcepacks' ? 'resourcepacks' : 'shaderpacks');
      dest = path.join(base, fileName);
      if (fs.existsSync(dest)) throw new Error('文件已存在: ' + dest);
    }
    setStatus('下载文件: ' + fileName, true);
    const fmtMB = n => (n / 1024 / 1024).toFixed(1) + ' MB';
    await downloadBig(url, dest, (pct, got, total) => {
      const txt = '下载文件 ' + fileName + (pct >= 0 ? ' ' + pct + '%' : ' ' + fmtMB(got) + (total ? ' / ' + fmtMB(total) : ''));
      setStatus(txt, true);
      send('install:progress', { stage: 'custom-dl', percent: pct >= 0 ? pct : 50, text: txt });
    });
    logLine('[download] 自定义文件完成: ' + dest);
    toast('文件已下载到: ' + dest);
    setStatus('就绪');
    return { ok: true, path: dest };
  } catch (e) { setStatus('就绪'); return { ok: false, error: e.message }; }
});

/* ---------------- Java 检测 ---------------- */
function candidateJavaPaths() {
  const list = [];
  const add = (p) => { if (p && !list.includes(p)) list.push(p); };
  if (config.javaPath) add(config.javaPath);
  /* 名字含 Java 相关关键词的目录命中规则（JDK8u312、jbr、zulu…都能覆盖） */
  const JAVA_NAME_RE = /java|jdk|jre|jbr|zulu|corretto|temurin|semeru|graalvm|liberica|kona|dragonwell|bellsoft|adoptium|adoptopenjdk/i;
  /* 固定盘符（C-Z 存在即扫） */
  const drives = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const r = L + ':\\'; if (fs.existsSync(r)) drives.push(r); }
  /* 1. 各盘 Program Files 下的各发行商目录（一级 + 二级） */
  const vendorRootNames = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Microsoft',
    'Zulu', 'Azul', 'Amazon Corretto', 'BellSoft', 'RedHat', 'GraalVM', 'Semeru', 'IBM',
    'Tencent', 'Alibaba', 'JetBrains', 'JavaSoft'];
  for (const d of drives) {
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      for (const v of vendorRootNames) {
        const root = path.join(d, pf, v);
        try {
          for (const sub of fs.readdirSync(root)) {
            add(path.join(root, sub, 'bin', 'javaw.exe'));
            try { for (const sub2 of fs.readdirSync(path.join(root, sub))) add(path.join(root, sub, sub2, 'bin', 'javaw.exe')); } catch (_) {}
          }
        } catch (_) {}
      }
    }
    /* 2. 盘符根目录的一级子目录：全部探测 <目录>\bin\javaw.exe（名字没规律的自定义安装也能找到）；
          名字带 java/jdk 关键词的再深挖两层（覆盖 D:\Java\jdk-21\bin 这类嵌套）。
          这里用 withFileTypes 一次 readdir 拿到「是不是目录」—— 原来是逐个 statSync，
          在机械盘 / 冷缓存下每个 stat 要几十毫秒，光这一步就能吃掉 2 秒多（实测）。 */
    try {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;   /* 链接（junction）也当目录看，保持旧行为 */
        const sub = ent.name;
        const p1 = path.join(d, sub);
        add(path.join(p1, 'bin', 'javaw.exe'));
        if (JAVA_NAME_RE.test(sub)) {
          try { for (const sub2 of fs.readdirSync(p1)) add(path.join(p1, sub2, 'bin', 'javaw.exe')); } catch (_) {}
        }
        /* 3. 一级目录下的 java 命名子目录再进一层（如 D:\工具\jdk-21） */
        try {
          for (const ent2 of fs.readdirSync(p1, { withFileTypes: true })) {
            if (!ent2.isDirectory() && !ent2.isSymbolicLink()) continue;
            const sub2 = ent2.name;
            if (!JAVA_NAME_RE.test(sub2)) continue;
            add(path.join(p1, sub2, 'bin', 'javaw.exe'));
            try { for (const sub3 of fs.readdirSync(path.join(p1, sub2))) add(path.join(p1, sub2, sub3, 'bin', 'javaw.exe')); } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  /* 4. 用户目录：IntelliJ .jdks、JetBrains jbr、Adoptium 用户级安装 */
  const home = os.homedir();
  for (const u of [path.join(home, '.jdks'), path.join(home, 'AppData', 'Local', 'Programs', 'Eclipse Adoptium'),
    path.join(home, 'AppData', 'Local', 'JetBrains'), path.join(home, 'scoop', 'apps')]) {
    try {
      for (const sub of fs.readdirSync(u)) {
        add(path.join(u, sub, 'bin', 'javaw.exe'));
        try { for (const sub2 of fs.readdirSync(path.join(u, sub))) add(path.join(u, sub, sub2, 'bin', 'javaw.exe')); } catch (_) {}
      }
    } catch (_) {}
  }
  /* 5. Oracle javapath（Oracle 安装器写入的系统级链接） */
  add('C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\javaw.exe');
  /* 6. JAVA_HOME */
  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe'));
  /* 收尾：只保留真实存在的 javaw.exe */
  return list.filter(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
}
/* Java 版本号归一化成 [主, 次, 修订] 三元组，便于按区间挑选（PCL 的「自动选择指定版本的 Java」用）：
   `1.8.0_302` → [8,0,302]（Java 8 时代的 1.x 前缀去掉，更新号当修订号）；
   `17.0.1` → [17,0,1]；`21` → [21,0,0]。 */
function javaVerTriple(verStr) {
  const s = String(verStr || '').trim();
  const nums = s.split(/[._+\-]/).map(x => parseInt(x, 10) || 0);
  if (/^1\./.test(s)) return [nums[1] || 0, nums[2] || 0, nums[3] || 0];
  return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
}
/* 比较两个三元组：a<b 返回 -1，相等 0，a>b 返回 1 */
function cmpTriple(a, b) {
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1; }
  return 0;
}
/* 解析 PCL 风格的 Java 版本区间：[17.0, 25.0) —— 方括号含端点、圆括号不含，缺哪边就不限哪边。
   返回 { min, minInc, max, maxInc }；解析不了直接抛错（调用方负责提示）。 */
function parseJavaRange(s) {
  const t = String(s || '').trim();
  const m = /^([\[(])\s*([0-9.]*)\s*,\s*([0-9.]*)\s*([\])])$/.exec(t);
  if (!m) throw new Error('应当形如 [17.0, 25.0)');
  const toT = (x) => {
    const v = String(x || '').trim();
    if (!v) return null;
    if (!/^[0-9]+(\.[0-9]+)*$/.test(v)) throw new Error('「' + v + '」不是版本号');
    return javaVerTriple(v.replace(/\.$/, ''));
  };
  const min = toT(m[2]), max = toT(m[3]);
  if (!min && !max) throw new Error('两端都空着，等于没写');
  return { min, minInc: m[1] === '[', max, maxInc: m[4] === ']' };
}
/* 某个 Java 版本三元组是否落在区间内 */
function javaInRange(tri, r) {
  if (r.min) { const c = cmpTriple(tri, r.min); if (c < 0 || (c === 0 && !r.minInc)) return false; }
  if (r.max) { const c = cmpTriple(tri, r.max); if (c > 0 || (c === 0 && !r.maxInc)) return false; }
  return true;
}
/* 探测 Java：同时拿到大版本与归一化版本串（大版本给内存/32 位判断用，版本串给区间挑选用） */
/* JDK/JRE 安装目录里有个 `release` 文件，自己写着版本（JAVA_VERSION="21.0.1"）。
   读它比 spawn 一个 `java -version` 快两个数量级（文件读 ~0.1ms vs 进程 150~400ms）——
   候选 Java 可能有十几个，逐个 spawn 就是好几秒，这是启动前等待的大头之一。
   读不到（老 JRE 没这个文件）才退回 spawn。 */
function javaVerFromReleaseFile(exePath) {
  try {
    const home = path.dirname(path.dirname(exePath));   /* <home>/bin/javaw.exe → <home> */
    /* JDK8 那种 <jdk>\jre\bin\javaw.exe：release 文件在上一层（<jdk>\release），也认 */
    for (const h of [home, path.dirname(home)]) {
      try {
        const txt = fs.readFileSync(path.join(h, 'release'), 'utf8');
        const m = txt.match(/JAVA_VERSION\s*=\s*"([^"]+)"/);
        if (!m) continue;
        const triple = javaVerTriple(m[1]);
        if (triple[0]) return { major: triple[0], ver: triple.join('.'), triple };
      } catch (_) {}
    }
    return null;
  } catch (_) { return null; }
}
function probeJavaRaw(p) {
  const fast = javaVerFromReleaseFile(p);
  if (fast) return Promise.resolve(fast);
  return new Promise((resolve, reject) => {
    execFile(p, ['-version'], { timeout: 8000 }, (err, _o, stderr) => {
      if (err) return reject(err);
      const m = String(stderr).match(/version "([^"]+)"/);
      if (!m) return reject(new Error('无法解析 Java 版本'));
      const triple = javaVerTriple(m[1]);
      resolve({ major: triple[0], ver: triple.join('.'), triple });
    });
  });
}
function probeJavaVersion(p) {
  return probeJavaRaw(p).then(r => r.major);
}
/* 有并发上限的 map（保留结果）：探测 Java 时别一次性 spawn 几十个进程 */
async function mapLimit(items, limit, fn) {
  const arr = Array.from(items || []);
  const out = new Array(arr.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit || 1, arr.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  }));
  return out;
}
let javaDetectCache = { t: 0, list: [] };
/* ---- Java 探测结果的落盘缓存 ---------------------------------------------------
   candidateJavaPaths() 要扫遍所有盘符的 Program Files 与各盘根目录（几十到上千次 stat），
   实测冷启动要 ~9 秒 —— 玩家点了「启动游戏」得干等这 9 秒。
   这里把「路径 → 大版本」记进 <数据目录>/java-cache.json：
   下次启动只做一次 stat 校验（大小与修改时间都没变就直接用），启动前等待压到几十毫秒；
   同时后台再重扫一遍刷新缓存，保证新装的 Java 下一次启动就能被认出来。
   缓存文件删掉无害（会自动重建）。 */
function javaCacheFile() { return path.join(DATA_DIR, 'java-cache.json'); }
function readJavaDiskCache() {
  try {
    const j = JSON.parse(fs.readFileSync(javaCacheFile(), 'utf8'));
    return (j && Array.isArray(j.list)) ? j : { t: 0, list: [] };
  } catch (_) { return { t: 0, list: [] }; }
}
function writeJavaDiskCache(list) {
  try { fs.writeFileSync(javaCacheFile(), JSON.stringify({ t: Date.now(), list }, null, 2)); } catch (_) {}
}
/* 按磁盘缓存拼一份可用列表：逐条 stat，文件没了或换过版本（大小/时间变了）就丢掉 */
function javaListFromDiskCache() {
  const out = [];
  for (const it of (readJavaDiskCache().list || [])) {
    if (!it || !it.path) continue;
    try {
      const st = fs.statSync(it.path);
      if (!st.isFile() || st.size !== it.size || Math.abs(st.mtimeMs - it.mtimeMs) > 1000) continue;
      out.push({ path: it.path, major: it.major, ver: it.ver });
    } catch (_) {}
  }
  return out;
}
/* 后台重扫（延迟几秒，避开启动时的 IO 高峰）：只为刷新磁盘缓存，结果不阻塞任何人 */
let javaRescanTimer = null;
function scheduleJavaRescan() {
  if (javaRescanTimer) return;
  javaRescanTimer = setTimeout(() => {
    javaRescanTimer = null;
    detectJavaInner(true).catch(() => {});
  }, 4000);
  if (javaRescanTimer.unref) javaRescanTimer.unref();
}
/* need：可选。数字 = 需要的大版本（缓存能挑出来才走快速路径）；
   函数 = 自定义判断（如「区间里有没有能用的」）。给不出答案就走全量扫描，宁慢不错。 */
async function detectJavaInner(force, need) {
  if (!force && javaDetectCache.list.length && Date.now() - javaDetectCache.t < 60000) return javaDetectCache.list;
  const cacheOk = (list) => {
    if (!list.length) return false;
    if (!need) return true;
    if (typeof need === 'function') return !!need(list);
    return !!pickJavaFor(list, need);
  };
  /* 快速路径：磁盘缓存能用就立刻返回，后台再去慢扫一遍 */
  if (!force) {
    const fast = javaListFromDiskCache();
    if (cacheOk(fast)) {
      javaDetectCache = { t: Date.now(), list: fast };
      logLine('[java] 磁盘缓存命中 ' + fast.length + ' 个 Java（后台重扫刷新）');
      scheduleJavaRescan();
      return fast;
    }
  }
  const t0 = Date.now();
  /* `where javaw` 与全盘扫描并行跑：它最坏要等 2.5s，别让它单独拖住整条链路 */
  const whereP = new Promise((resolve) => {
    execFile('where', ['javaw'], { timeout: 2500 }, (e, o) => resolve(e ? '' : String(o || '')));
  });
  const candidates = candidateJavaPaths();
  // 补充：Mojang 官方运行时与 LMC 自动安装的运行时（gameDir/runtime/*/bin/javaw.exe）
  try {
    const rtd = path.join(config.gameDir, 'runtime');
    for (const sub of fs.readdirSync(rtd)) {
      const p = path.join(rtd, sub, 'bin', 'javaw.exe');
      if (fs.existsSync(p) && !candidates.includes(p)) candidates.push(p);
    }
  } catch (_) {}
  const whereOut = await whereP;
  for (const line of String(whereOut).split(/\r?\n/)) {
    const p = line.trim();
    if (/^[A-Za-z]:\\.+javaw\.exe$/i.test(p) && !candidates.includes(p)) candidates.push(p);
  }
  const tScan = Date.now() - t0;
  const tProbe = Date.now();
  /* 并行探测（并发 6）：读 release 文件基本是零成本，退回 spawn 的那几个才慢 */
  const found = (await mapLimit(candidates, 6, async (p) => {
    try { const r = await probeJavaRaw(p); return { path: p, major: r.major, ver: r.ver }; }
    catch (_) { return null; }
  })).filter(Boolean);
  found.sort((a, b) => b.major - a.major);
  /* 去重：同一个 Java 常有多条路径（Oracle javapath / java8path 是它的副本、JDK 自带的 jre 子目录…），
     重复项只会让「Java 列表」变乱、让磁盘缓存变大。按「二进制指纹」去重（大小 + 修改时间 + 大版本），
     只有真·同一份文件才合并 —— 32 位与 64 位同版本号的两份大小不同，不会被误合并。 */
  const uniq = [];
  const seen = new Set();
  for (const j of found) {
    let key = j.path.toLowerCase();
    try { const st = fs.statSync(j.path); key = st.size + ':' + Math.round(st.mtimeMs) + ':' + j.major; } catch (_) {}
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(j);
  }
  javaDetectCache = { t: Date.now(), list: uniq };
  /* 连 size/mtime 一起存，下次才能一条 stat 就认定「没变过」 */
  writeJavaDiskCache(uniq.map(j => {
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(j.path); size = st.size; mtimeMs = st.mtimeMs; } catch (_) {}
    return { path: j.path, major: j.major, ver: j.ver, size, mtimeMs };
  }));
  logLine('[java] 检测到 ' + uniq.length + ' 个 Java（候选 ' + candidates.length + ' 个 · 收集 ' +
    tScan + 'ms · 探测 ' + (Date.now() - tProbe) + 'ms）: ' + uniq.map(j => j.major + '@' + j.path).join('; '));
  return uniq;
}
ipcMain.handle('java:detect', async () => {
  setStatus('正在检测 Java…', true);
  const list = await detectJavaInner(true);
  setStatus('就绪');
  if (list.length) toast('检测到 ' + list.length + ' 个 Java（最高 Java ' + list[0].major + '）');
  else toast('未检测到 Java，启动游戏时会自动安装官方运行时', 'warn');
  return list;
});
/* 只要列表、不改状态：走检测缓存（60 秒内不重扫），供「游戏设置 → Java 选择」下拉用。
   与 java:detect 的区别是它不弹 toast、不刷状态栏 —— 那个是设置页上手动点「检测」用的。 */
ipcMain.handle('java:list', async () => {
  try {
    const list = await detectJavaInner();
    return { ok: true, javas: list.map(j => ({ path: j.path, major: j.major, ver: j.ver || '' })) };
  } catch (e) { return { ok: false, error: e.message, javas: [] }; }
});
/* 手动下载指定版本的 Java 运行时（设置页"下载 Java"，复用自动安装的多源下载+解压逻辑，已装过则直接复用） */
ipcMain.handle('java:download', async (_e, major) => {
  major = parseInt(major, 10) || 21;
  try {
    setStatus('下载 Java ' + major + '（首次需 1-5 分钟）…', true);
    const rt = await ensureJavaRuntime(major);
    await detectJavaInner(true);
    setStatus('就绪');
    toast('Java ' + major + ' 安装完成');
    logLine('[java] 手动安装 Java ' + major + ' 完成: ' + rt.javaw);
    send('launch:log', '[XLC] Java ' + major + ' 安装完成: ' + rt.javaw);
    return { ok: true, javaw: rt.javaw };
  } catch (e) { setStatus('就绪'); return { ok: false, error: e.message }; }
});
function requiredJavaMajor(mcVer) {
  const m = String(mcVer).match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 25; // 1.x 之外的新版本号方案（如 26.3）取当前高版本，配合自动安装运行时
  const minor = parseInt(m[1], 10), patch = parseInt(m[2] || '0', 10);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}
// 版本 json 中的官方 Java 需求（javaVersion.majorVersion 是权威值）
function javaRequirementOf(json, rootId) {
  if (json.javaVersion && json.javaVersion.majorVersion) {
    return { major: json.javaVersion.majorVersion, component: json.javaVersion.component || null };
  }
  return { major: requiredJavaMajor(rootId), component: null };
}
/* 从已检测到的 Java 里挑一个能跑该版本的：
   ① 优先精确匹配所需大版本（官方要求多少就用多少）
   ② 没有精确匹配时，取「满足要求里最低的」——比取最高更安全，
      因为 Java 过新会让老版本/老加载器起不来（如 1.12.2 的 Forge 需要 Java 8） */
function pickJavaFor(list, need) {
  const arr = (list || []).filter(j => j && j.major);
  const exact = arr.find(j => j.major === need);
  if (exact) return exact;
  const above = arr.filter(j => j.major > need).sort((a, b) => a.major - b.major);
  return above[0] || null;
}
function supportsQuickPlay(rootId) {
  const m = String(rootId).match(/^1\.(\d+)/);
  if (!m) return true; // 1.x 之外的新版本号方案默认支持
  return parseInt(m[1], 10) >= 20;
}

/* ---------------- 自动安装 Java 运行时（微软/Oracle/Adoptium 多源回退） ---------------- */
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
async function ensureJavaRuntime(major, component) {
  // 官方组件目录（Mojang 标准布局）已存在则直接复用
  if (component) {
    const oj = path.join(config.gameDir, 'runtime', component, 'bin', 'javaw.exe');
    if (fs.existsSync(oj)) return { javaw: oj, dir: path.join(config.gameDir, 'runtime', component) };
  }
  const rtDir = path.join(config.gameDir, 'runtime', 'lmc-java-' + major);
  const marker = path.join(rtDir, '.lmc-complete');
  if (fs.existsSync(marker)) {
    const saved = fs.readFileSync(marker, 'utf8').trim();
    if (saved && fs.existsSync(saved)) return { javaw: saved, dir: rtDir };
  }
  const zipPath = path.join(rtDir, 'java-' + major + '.zip');
  // 下载源：微软 JDK（国内 CDN）→ Oracle JDK → Adoptium JRE（GitHub）
  const sources = [
    { name: 'Microsoft JDK ' + major, url: 'https://aka.ms/download-jdk/microsoft-jdk-' + major + '-windows-x64.zip' },
    { name: 'Oracle JDK ' + major, url: 'https://download.oracle.com/java/' + major + '/latest/jdk-' + major + '_windows-x64_bin.zip' },
    { name: 'Adoptium JRE ' + major, adoptium: true }
  ];
  await fsp.mkdir(rtDir, { recursive: true });
  let lastErr = null;
  for (const s of sources) {
    try {
      if (s.adoptium) {
        const assets = await fetchJson('https://api.adoptium.net/v3/assets/latest/' + major + '/hotspot?os=windows&architecture=x64&image_type=jre');
        const asset = Array.isArray(assets) && assets.find(a => a.binary && a.binary.package && /\.zip$/i.test(a.binary.package.name || ''));
        if (!asset) throw new Error('无构建');
        const pkg = asset.binary.package;
        await downloadBig(pkg.link, zipPath, () => {});
        const buf = await fsp.readFile(zipPath);
        if (pkg.checksum && sha256(buf) !== pkg.checksum.toLowerCase()) throw new Error('SHA256 校验失败');
      } else {
        setStatus('下载 ' + s.name + '（首次运行需 1-5 分钟）…', true);
        let lastLogged = -10;
        await downloadBig(s.url, zipPath, (pct, got, total) => {
          if (pct >= lastLogged + 10) {
            lastLogged = Math.floor(pct / 10) * 10;
            send('launch:log', '[XLC] ' + s.name + ' 下载中 ' + pct + '%（' + Math.round(got / 1048576) + '/' + Math.round(total / 1048576) + ' MB）');
          }
        });
      }
      logLine('[java] 已下载 ' + s.name + ' → ' + zipPath);
      break;
    } catch (e) { lastErr = e; logLine('[java] 源 ' + s.name + ' 失败: ' + e.message); }
  }
  if (!fs.existsSync(zipPath)) throw new Error('所有下载源均失败（' + ((lastErr && lastErr.message) || '未知错误') + '）');
  setStatus('解压 Java 运行时…', true);
  extractZipEntries(await fsp.readFile(zipPath), rtDir, n => !n.endsWith('/'));
  try { await fsp.unlink(zipPath); } catch (_) {}
  // 递归定位 bin/javaw.exe
  let javaw = null;
  (function walk(d) {
    if (javaw) return;
    let entries;
    try { entries = fs.readdirSync(d); } catch (_) { return; }
    for (const f of entries) {
      const p = path.join(d, f);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) walk(p);
      else if (/^javaw\.exe$/i.test(f) && /bin$/i.test(d)) { javaw = p; return; }
    }
  })(rtDir);
  if (!javaw) throw new Error('解压后未找到 bin/javaw.exe');
  fs.writeFileSync(marker, javaw);
  logLine('[java] Java ' + major + ' 运行时安装完成: ' + javaw);
  return { javaw, dir: rtDir };
}

/* 统一的「要哪个 Java 就给哪个」：
   ① 官方运行时组件目录命中 ② 本机已装的（含之前自动装的）选最合适的 ③ 都没有就自动下载安装。
   label 只用于日志/提示文案（如版本号）。安装失败会抛错，文案由调用方补上下文。 */
async function resolveJavaFor(major, component, label) {
  if (component) {
    const oj = path.join(config.gameDir, 'runtime', component, 'bin', 'javaw.exe');
    if (fs.existsSync(oj)) {
      send('launch:log', '[XLC] 使用官方运行时组件 ' + component + ' (Java ' + major + '): ' + oj);
      return { path: oj, major, runtime: true, official: true };
    }
  }
  const hit = pickJavaFor(await detectJavaInner(false, major), major);
  if (hit) {
    send('launch:log', '[XLC] 使用本机 Java ' + hit.major + ': ' + hit.path);
    return hit;
  }
  const why = '本机没有' + (label ? '「' + label + '」需要的' : '') + ' Java ' + major + '，正在自动下载安装（首次约需 1-5 分钟）…';
  send('launch:log', '[XLC] ' + why);
  logLine('[java] ' + why);
  toast(why, 'warn');
  const rt = await ensureJavaRuntime(major, component);
  javaDetectCache = { t: 0, list: [] };   /* 装完清缓存：设置页与后续启动立刻能识别到 */
  await detectJavaInner(true);
  send('launch:log', '[XLC] Java ' + major + ' 已就绪: ' + rt.javaw);
  return { path: rt.javaw, major, runtime: true };
}

/* ---------------- 版本链合并（Fabric/Forge 继承原版） ---------------- */
async function loadVersionChain(id, gd, depth) {
  if (depth > 5) throw new Error('版本继承链过深');
  /* 版本 id 由渲染层传入（launch:start / version:info 等），继承链递归同样经此校验：
     只允许纯名字，杜绝 ../ 形态读到游戏目录之外（与 instance:rename/delete 的 basename 校验一致） */
  if (typeof id !== 'string' || !id || path.basename(id) !== id) throw new Error('版本名不合法: ' + id);
  const file = path.join(gd, 'versions', id, id + '.json');
  if (!fs.existsSync(file)) throw new Error('版本配置缺失: ' + id + '（请重新安装）');
  const json = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (json.inheritsFrom) {
    const parent = await loadVersionChain(json.inheritsFrom, gd, depth + 1);
    return {
      rootId: parent.rootId,
      jarPath: parent.jarPath,
      json: Object.assign({}, parent.json, json, {
        libraries: [].concat(parent.json.libraries || [], json.libraries || [])
      })
    };
  }
  /* PCL 等外部实例的 JSON 是自包含合并版（无 inheritsFrom），其 id 为实例名而非 MC 版本；
     真实 MC 版本记录在 clientVersion 字段，必须优先使用，否则按版本筛选/Java 需求都会拿错值 */
  return { rootId: json.clientVersion || id, jarPath: path.join(gd, 'versions', id, id + '.jar'), json };
}

/* ---------------- 启动游戏 ---------------- */
function offlineUUID(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}
function subVars(s, values) { return String(s).replace(/\$\{(\w+)\}/g, (m, k) => (values[k] !== undefined ? values[k] : m)); }
/* 启动前命令是用户自己填的 shell 字符串，但 ${gameDir} / ${version} 的取值来自游戏路径与实例名 ——
   实例名在「导入整合包 / 手动建目录」时可以含 & | < > ^ % 和引号，原样替换进 shell:true 的命令行
   就会被 cmd 当成命令分隔符 / 变量展开（审计 F4）。含这些字符时不替换、整条命令跳过并明确提示：
   宁可少跑一次可选脚本，也不把外部可控字符串拼进 shell。 */
const SHELL_UNSAFE_VALUE_RE = /["%&|<>^\r\n]/;
function cmdVarUnsafe(v) { return SHELL_UNSAFE_VALUE_RE.test(String(v == null ? '' : v)); }
/* 启动前确保游戏语言为简体中文：options.txt 的 lang 行缺失或为英文缺省(en_us)时写入 zh_cn；
   用户在游戏里主动选择过的其他语言保持不动 */
function ensureChineseLang(gd) {
  try {
    const p = path.join(gd, 'options.txt');
    let txt = '';
    try { txt = fs.readFileSync(p, 'utf8'); } catch (_) {}
    const lines = txt ? txt.split(/\r?\n/) : [];
    let idx = -1;
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      if (/^lang:/.test(lines[i])) { idx = i; cur = lines[i].slice(5).trim(); break; }
    }
    if (idx >= 0 && cur && cur !== 'en_us') return; // 已有非英文语言设置，尊重用户选择
    if (idx >= 0) lines[idx] = 'lang:zh_cn';
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push('lang:zh_cn');
    }
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    logLine('[launch] options.txt lang 已设为 zh_cn（原值: ' + (cur || '缺失') + '）');
    send('launch:log', '[XLC] 游戏语言已自动设置为简体中文');
  } catch (e) { logLine('[launch] 设置中文语言失败: ' + e.message); }
}
function expandArgs(arr, values, features) {
  const out = [];
  for (const it of arr || []) {
    if (typeof it === 'string') out.push(subVars(it, values));
    else if (it && it.rules && rulePass(it.rules, features)) {
      if (Array.isArray(it.value)) it.value.forEach(v => out.push(subVars(v, values)));
      else out.push(subVars(it.value, values));
    }
  }
  return out;
}
/* 主进程级启动锁：窗口刷新（Ctrl+R）会重置渲染层状态，防双开必须由主进程把关；
   锁在「启动失败」或「游戏进程退出」时释放（见下方 child.on('exit')） */
let LAUNCHING = false;
/* 游戏启动后启动器被自动隐藏 / 最小化（「启动器可见性」设置），游戏退出时要把窗口收回来 */
let LAUNCHER_HIDDEN_FOR_GAME = false;
/* 「游戏起来后隐藏窗口」的挂起定时器（见 scheduleLauncherHide / restoreLauncherWindow） */
let LAUNCHER_HIDE_TIMER = null;

/* 是否真的该藏窗口（纯函数，便于离线自测）：
   ① 可见性 = keep → 永不藏；
   ② 这次 spawn 出来的游戏进程必须**还在跑**（没退出、没被 kill），而且它仍是当前那个游戏进程；
   ③ 否则不藏 —— 这是「点了启动，进程几十毫秒就挂了」这条竞态的最后一道闸门。 */
function shouldHideLauncherOnGame(vis, child, gameProc) {
  if (vis === 'keep' || !child) return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return false;
  if (child.killed) return false;
  if (gameProc !== child) return false;
  return true;
}
/* 安排「游戏起来后自动隐藏 / 最小化启动器窗口」（设置 → 启动 → 启动器可见性）。
   延迟一点点是为了不干扰启动准备；到点前会再确认进程还活着。
   deps 只是给自测注入假窗口 / 假进程用，正常调用只传前两个参数。 */
function scheduleLauncherHide(vis, child, deps) {
  const d = deps || {};
  const delay = d.delay === undefined ? 1200 : d.delay;
  const getProc = d.getGameProc || (() => GAME_PROC);
  const getWin = d.getWin || (() => win);
  const log = d.log || ((s) => logLine(s));
  if (vis === 'keep') return () => {};
  if (LAUNCHER_HIDE_TIMER) { clearTimeout(LAUNCHER_HIDE_TIMER); LAUNCHER_HIDE_TIMER = null; }
  LAUNCHER_HIDDEN_FOR_GAME = true;
  LAUNCHER_HIDE_TIMER = setTimeout(() => {
    LAUNCHER_HIDE_TIMER = null;
    if (!LAUNCHER_HIDDEN_FOR_GAME) return;                   /* 延时内已经恢复过（游戏退出） */
    if (!shouldHideLauncherOnGame(vis, child, getProc())) {   /* 竞态兜底：进程没在跑就别藏 */
      LAUNCHER_HIDDEN_FOR_GAME = false;
      log('[launch] 游戏进程在隐藏延时内已结束 → 保持启动器窗口可见');
      return;
    }
    const w = getWin();
    if (!w || w.isDestroyed()) { LAUNCHER_HIDDEN_FOR_GAME = false; return; }
    try {
      if (vis === 'hide') w.hide(); else w.minimize();
      send('launch:log', '[XLC] 启动器已' + (vis === 'hide' ? '隐藏' : '最小化') + '（游戏退出后自动恢复）');
      startLauncherHideWatchdog({ getWin: getWin, getGameProc: getProc, log: log, watchdogMs: d.watchdogMs });
    } catch (_) {}
  }, delay);
  return () => restoreLauncherWindow(d);
}
/* 隐藏之后的看门狗：万一将来有哪条路径把窗口藏了却没有游戏在跑（进程退出事件丢失、
   新加的分支忘了恢复…），每 3 秒确认一次，发现「既没在启动也没有游戏进程」就把窗口拉回来。
   一个 tick 的代价，换的是「窗口不会凭空消失还找不回来」。 */
let LAUNCHER_HIDE_WATCHDOG = null;
function startLauncherHideWatchdog(deps) {
  const d = deps || {};
  const every = d.watchdogMs || 3000;
  const getProc = d.getGameProc || (() => GAME_PROC);
  const getWin = d.getWin || (() => win);
  const log = d.log || ((s) => logLine(s));
  if (LAUNCHER_HIDE_WATCHDOG) return;
  LAUNCHER_HIDE_WATCHDOG = setInterval(() => {
    if (!LAUNCHER_HIDDEN_FOR_GAME) return;   /* 窗口没被藏（或已恢复过） */
    if (LAUNCHING || getProc()) return;      /* 还在启动 / 游戏在跑 → 正常，不动 */
    log('[launch] 看门狗：没有游戏在跑但启动器仍被隐藏 → 恢复窗口');
    restoreLauncherWindow({ getWin: getWin });
  }, every);
  if (LAUNCHER_HIDE_WATCHDOG.unref) LAUNCHER_HIDE_WATCHDOG.unref();
}
function stopLauncherHideWatchdog() {
  if (LAUNCHER_HIDE_WATCHDOG) { clearInterval(LAUNCHER_HIDE_WATCHDOG); LAUNCHER_HIDE_WATCHDOG = null; }
}
/* 把因「启动器可见性」藏起来（或正准备藏）的窗口收回来：
   清掉挂起的隐藏定时器；窗口真被藏了就 show 回前台。游戏退出 / 启动失败 / 关闭游戏都走这里。
   关键点：即使窗口此刻还看得见，也必须清定时器 —— 否则会出现「进程秒退 → 退出事件把窗口收回
   → 1.2 秒后挂起的定时器又把窗口藏掉」，而这时已经没有游戏可退回，用户只能以为启动器被关了。 */
function restoreLauncherWindow(deps) {
  const getWin = (deps && deps.getWin) || (() => win);
  if (LAUNCHER_HIDE_TIMER) { clearTimeout(LAUNCHER_HIDE_TIMER); LAUNCHER_HIDE_TIMER = null; }
  stopLauncherHideWatchdog();
  if (!LAUNCHER_HIDDEN_FOR_GAME) return;
  LAUNCHER_HIDDEN_FOR_GAME = false;
  try {
    const w = getWin();
    if (w && !w.isDestroyed()) { w.show(); w.focus(); }
  } catch (_) {}
}
/* 正在运行的游戏客户端进程（主页「启动游戏」按钮在游戏跑起来后会变成「关闭游戏」，走 launch:stop）
   GAME_STOP_BY_USER：用户自己按的关闭 —— 退出时不报「异常退出」、不跑崩溃诊断 */
let GAME_PROC = null;
let GAME_STOP_BY_USER = false;
/* 本次启动实际用的登录方式：ms（微软正版）/ authlib（外置登录）/ offline（离线）。
   启动成功的提示按它给文案 —— 原来不管什么账户都弹「离线模式」，
   正版玩家会以为自己掉线了（审计 F3）。 */
let LAST_LAUNCH_MODE = 'offline';
function launchModeLabel() {
  return LAST_LAUNCH_MODE === 'ms' ? '微软正版登录' : LAST_LAUNCH_MODE === 'authlib' ? '外置登录' : '离线模式';
}
/* 干跑（只为测「启动准备」耗时，不真拉游戏进程）：`LMC_SMOKE_LAUNCH` 自测用，见文件末尾冒烟块。
   走完整条准备链路（版本链 / 账户 / Java / 内存 / classpath / natives / 启动参数），
   到 spawn 之前停下并打印分段耗时 —— 这样优化启动速度能有可复现的对照数字。 */
let LAUNCH_DRYRUN = false;
ipcMain.handle('launch:start', (_e, opts) => {
  if (LAUNCHING) {
    logLine('[launch] 已拦截重复启动请求（主进程启动锁）');
    return { started: false, error: '已有游戏正在启动/运行中，请等待其退出后再启动' };
  }
  LAUNCHING = true;
  runLaunch(opts)
    .then((r) => { if (!(r && r.dryRun)) toast('游戏进程已启动（' + launchModeLabel() + '）'); })
    .catch(err => {
      LAUNCHING = false;
      restoreLauncherWindow();   /* 启动流程中途失败也要确保窗口没被藏起来 */
      toast('启动失败: ' + err.message, 'error'); setStatus('启动失败'); send('launch:exit', { code: -1, error: err.message });
    });
  return { started: true };
});
async function runLaunch(opts) {
  const gd = config.gameDir;
  const versionId = opts.versionId;
  if (!versionId) throw new Error('请先选择一个版本');
  /* 分段耗时：启动慢时能直接从日志看出卡在哪一段（干跑自测也读这一行）。开销只有几次 Date.now */
  const T0 = Date.now();
  let TPrev = T0;
  const phase = [];
  const mark = (k) => { const now = Date.now(); phase.push(k + '=' + (now - TPrev) + 'ms'); TPrev = now; };

  const chain = await loadVersionChain(versionId, gd, 0);
  const json = chain.json;
  mark('版本链');
  const username = (opts.username || config.username || 'Steve').slice(0, 16);
  /* 无账户提醒：不阻断启动，但明确告诉玩家去创建账户 */
  if (!accountList().length) {
    logLine('[XLC] 你还没有创建账户，当前以「' + username + '」临时身份启动；到「账户」页添加玩家账号后可保存名称并自定义皮肤');
    toast('还没有账户：建议到「账户」页创建玩家账号（可自定义皮肤），当前以「' + username + '」临时身份启动', 'warn');
  }
  /* 账户凭据解析：微软/外置账户使用真实 UUID + 令牌（过期自动续期），离线账户用离线 UUID */
  let launchAcc = null, authUuid = '', authToken = '0', userType = 'legacy';
  launchAcc = await resolveLaunchAccount(logLine);
  LAST_LAUNCH_MODE = launchAcc ? (launchAcc.type === 'ms' ? 'ms' : 'authlib') : 'offline';
  if (launchAcc) {
    authUuid = launchAcc.uuid;
    authToken = launchAcc.mcToken || launchAcc.accessToken || '0';
    userType = launchAcc.type === 'ms' ? 'msa' : 'mojang';
  }
  mark('账户');
  // 内存：在解析出 Java 之后再算（32 位 JVM 要额外压到 1G），见下面的分配逻辑

  if (!fs.existsSync(chain.jarPath)) throw new Error('客户端 jar 缺失，请重新安装该版本');

  /* Java 需求：优先读版本 json 的 javaVersion（Mojang 官方标注），没有标注就按 MC 版本推算。
     缺哪个大版本就自动下载安装哪个 —— 不依赖「版本自带官方运行时组件」这个条件，
     外置实例 / 自包含 json（PCL 导入的）/ 快照 / 新版本号方案同样能自动补齐。 */
  const req = javaRequirementOf(json, chain.rootId);
  /* 「游戏设置 → 基础设置 → 启动选项 → Java」按实例指定（PCL 式四种模式）：
     auto 自动选择｜range 按版本区间自动挑本机的｜dir 用版本文件夹里自带的｜custom 用指定路径。
     没选 / 选的东西已经不在（路径被删、文件夹里没有）就回到自动挑选 + 自动下载，并明确提示。
     挑到的 Java 大版本可能不合适（比如给 1.20 指了 Java 8），这时只警告不阻断 —— 让玩家自己决定。 */
  const vsCfg = versionSettingsOf(versionId);
  let java = null;
  const useManual = async (jp, why) => {
    let major = 0;
    try { major = await probeJavaVersion(jp); } catch (_) { major = 0; }
    java = { path: jp, major: major || req.major, runtime: false, manual: true };
    logLine('[launch] ' + why + '：Java ' + (major || '未知') + ' @ ' + jp);
    if (major && major !== req.major) {
      logLine('[launch] ⚠ 指定的 Java ' + major + ' 与该版本建议的 Java ' + req.major + ' 不一致（仍按指定值启动）');
      toast('注意：' + versionId + ' 建议 Java ' + req.major + '，实际用的是 Java ' + major, 'warn');
    }
  };
  if (vsCfg.javaMode === 'custom' && vsCfg.javaPath) {
    if (fs.existsSync(vsCfg.javaPath)) await useManual(vsCfg.javaPath, '「' + versionId + '」指定了 Java');
    else {
      logLine('[launch] 指定的 Java 已不存在，回到自动挑选: ' + vsCfg.javaPath);
      toast('「' + versionId + '」指定的 Java 已不存在，本次自动挑选', 'warn');
    }
  } else if (vsCfg.javaMode === 'dir') {
    const inDir = findJavaInVersionDir(path.join(gd, 'versions', versionId));
    if (inDir) await useManual(inDir, '使用版本文件夹内的 Java');
    else {
      logLine('[launch] 版本文件夹里没有 Java，回到自动挑选');
      toast('「' + versionId + '」的版本文件夹里没找到 Java，本次自动挑选', 'warn');
    }
  } else if (vsCfg.javaMode === 'range' && vsCfg.javaRange) {
    let rng = null;
    try { rng = parseJavaRange(vsCfg.javaRange); } catch (_) { rng = null; }
    if (rng) {
      /* 缓存里要是有符合区间的就不用全盘重扫（没有才去扫） */
      const inRng = (l) => (l || []).some(j => javaInRange(javaVerTriple(j.ver || String(j.major)), rng));
      const list = await detectJavaInner(false, inRng).catch(() => []);
      const cand = list.filter(j => javaInRange(javaVerTriple(j.ver || String(j.major)), rng));
      if (cand.length) await useManual(cand[0].path, '按区间 ' + vsCfg.javaRange + ' 挑到 Java');
      else {
        logLine('[launch] 没有符合区间 ' + vsCfg.javaRange + ' 的本机 Java，回退自动挑选');
        toast('没有符合 ' + vsCfg.javaRange + ' 的 Java，本次自动挑选并下载', 'warn');
      }
    }
  }
  if (!java) {
    try {
      java = await resolveJavaFor(req.major, req.component, chain.rootId);
    } catch (e) {
      logLine('[launch] 自动安装 Java ' + req.major + ' 失败: ' + e.message);
      throw new Error('运行 ' + chain.rootId + ' 需要 Java ' + req.major + '，自动安装失败：' + e.message +
        '（也可到「设置 → Java 运行时」手动下载，或到「游戏设置 → 基础设置 → 启动选项」指定 Java）');
    }
  }
  if (java.runtime && !java.official) toast('Java ' + req.major + ' 已自动安装完成，继续启动 ' + versionId);
  mark('Java');

  /* 内存：实例级设置优先（PCL 的「跟随全局设置 / 自动配置 / 自定义」三选一），
     再往上是调用方显式传入的 opts.mem（主页那种临时调整）。
     智能分配按「这个实例的模组数量 + 此刻系统可用内存」四阶段算（见 calcSmartMemGB）；
     最后统一钳到 [1G, min(64G, 物理内存)]。32 位 Java 的堆上限只有 ~1.5G，给多了起不来。 */
  const instMods = modStatsFor(versionId);
  const ramType = vsCfg.ramType;                       /* 2=跟随全局 0=自动配置 1=自定义 */
  const baseMem = ramType === 1
    ? (vsCfg.ramCustom || 2)
    : ((ramType === 0 || config.memAuto !== false) ? smartMemGB(instMods) : config.mem);
  const memAuto = ramType !== 1 && (ramType === 0 || config.memAuto !== false) && !opts.mem;
  let mem = clampMemGB(opts.mem || baseMem);
  if (is32BitJavaExe(java.path) && mem > 1) {
    mem = 1;
    logLine('[launch] 检测到 32 位 Java，内存按上限 1G 分配（32 位 JVM 用不了更大的堆，给多了会起不来）');
  }
  mark('内存');

  // classpath（兼容两种库格式：Mojang 的 downloads.artifact 与 PCL/Fabric meta 的 maven 坐标 name+url）
  const cpList = [chain.jarPath];
  const mavenDl = []; /* 本地缺失、需要从 maven 源补下的库 */
  for (const l of json.libraries || []) {
    if (!rulePass(l.rules)) continue;
    const a = l.downloads && l.downloads.artifact;
    if (a && a.path) { cpList.push(path.join(gd, 'libraries', a.path)); continue; }
    if (l.name) {
      /* maven 坐标: group:artifact:version → group/artifact/version/artifact-version.jar */
      const parts = String(l.name).split(':');
      if (parts.length === 3) {
        const rel = parts[0].replace(/\./g, '/') + '/' + parts[1] + '/' + parts[2] + '/' + parts[1] + '-' + parts[2] + '.jar';
        const p = path.join(gd, 'libraries', rel);
        cpList.push(p);
        if (!fs.existsSync(p)) {
          const base = (l.url || 'https://libraries.minecraft.net/').endsWith('/') ? (l.url || 'https://libraries.minecraft.net/') : (l.url || 'https://libraries.minecraft.net/') + '/';
          mavenDl.push({ url: base + rel, dest: p, sha1: l.sha1 || null, name: l.name });
        }
      }
    }
  }
  /* 补下缺失的 maven 库（fabric-loader / ASM / sponge-mixin 等，PCL 实例常见） */
  for (const d of mavenDl) {
    logLine('[launch] 补下缺失库: ' + d.name);
    try { await downloadTo(d.url, d.dest, d.sha1); }
    catch (e) { throw new Error('缺失库 ' + d.name + ' 且自动下载失败（' + e.message + '），请检查网络后重试'); }
  }
  const missing = cpList.filter(p => !fs.existsSync(p));
  if (missing.length) throw new Error('缺少 ' + missing.length + ' 个库文件（如 ' + path.basename(missing[0]) + '），请重新安装该版本');
  mark('classpath');

  // natives
  const nativesDir = path.join(gd, 'versions', versionId, 'natives');
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const l of json.libraries || []) {
    if (!rulePass(l.rules) || !l.natives || !l.natives.windows || !l.downloads || !l.downloads.classifiers) continue;
    const classifier = l.natives.windows.replace('${arch}', os.arch() === 'x64' ? '64' : '32');
    const c = l.downloads.classifiers[classifier] || l.downloads.classifiers['natives-windows'];
    if (!c) continue;
    const jarPath = path.join(gd, 'libraries', c.path);
    if (fs.existsSync(jarPath)) {
      try { extractZipEntries(await fsp.readFile(jarPath), nativesDir, n => n.endsWith('.dll') && !n.startsWith('META-INF')); } catch (_) {}
    }
  }
  mark('natives');

  // 版本隔离（PCL 式）：实例里显式设过就听它的（开启 / 关闭），没设过才自动判定
  // （装了 mods/ 或存过档 = 隔离）。隔离只改游戏的工作目录、不搬文件 ——
  // 关掉隔离后读的是根目录的 mods/saves，所以「切完存档不见了」是预期现象，不是丢档。
  /* 版本隔离三档：实例级设置 > 全局默认（设置 → 启动 → 默认版本隔离）> 自动判断。
     auto 的判定 = 实例目录里有 mods/ 或 saves/（装了模组或存过档就算隔离实例）。 */
  const isoPref = vsCfg.isolated === 'on' ? 'on' : vsCfg.isolated === 'off' ? 'off' : (config.forceIsolate || 'auto');
  const isolated = isoPref === 'on' ? true
    : isoPref === 'off' ? false
      : (fs.existsSync(path.join(gd, 'versions', versionId, 'mods')) ||
         fs.existsSync(path.join(gd, 'versions', versionId, 'saves')));
  const launchDir = isolated ? path.join(gd, 'versions', versionId) : gd;

  /* 存档快速启动校验：世界必须位于游戏实际工作目录，否则静默去掉 quick play（游戏进多人才不会找不到目录） */
  if (opts.world) {
    const inLaunch = fs.existsSync(path.join(launchDir, 'saves', opts.world, 'level.dat'));
    const inGlobal = fs.existsSync(path.join(gd, 'saves', opts.world, 'level.dat'));
    if (!inLaunch) {
      if (isolated && inGlobal) {
        send('launch:log', '[XLC] 存档「' + opts.world + '」在全局 saves 目录，而实例 ' + versionId + ' 为版本隔离（存档在实例目录内），本次启动忽略指定存档');
        toast('存档「' + opts.world + '」属于全局目录，与版本隔离实例不匹配，已忽略', 'warn');
      } else if (!inGlobal) {
        toast('未找到存档「' + opts.world + '」，已按普通方式启动', 'warn');
      }
      opts.world = null;
    }
  }

  const values = {
    auth_player_name: username,
    version_name: versionId,
    game_directory: launchDir,
    assets_root: path.join(gd, 'assets'),
    assets_index_name: (json.assetIndex && json.assetIndex.id) || 'legacy',
    auth_uuid: authUuid || offlineUUID(username),
    auth_access_token: authToken,
    user_type: userType,
    user_properties: '{}',
    version_type: json.type || 'release',
    launcher_name: 'XLC',
    launcher_version: APP_VERSION,
    natives_directory: nativesDir,
    classpath: cpList.join(CP_SEP),
    classpath_separator: CP_SEP,
    library_directory: path.join(gd, 'libraries'),
    classifier_separator: '-',
    resolution_width: '', resolution_height: '',
    quickPlayPath: '', quickPlaySingleplayer: '', quickPlayMultiplayer: '', quickPlayRealms: ''
  };

  // 快捷进入存档：仅当版本 json 的 game 参数含对应 feature 条目时启用该 feature（否则走手动 push 兜底）
  const gameArgItems = (json.arguments && json.arguments.game) || [];
  const hasQpItem = gameArgItems.some(it => it && it.rules && it.rules.some(r => r.features && r.features.is_quick_play_singleplayer));
  const features = {};
  if (opts.world && hasQpItem) {
    features.is_quick_play_singleplayer = true;
    values.quickPlaySingleplayer = opts.world;
  }

  const args = ['-Xmx' + mem + 'G', '-Xms512m', '-XX:+UseG1GC'];
  // 额外 JVM 参数：实例里填了就用实例的（PCL 式「留空跟随全局设置」），否则用全局那份
  const jvmRaw = vsCfg.jvmArgs || config.jvmArgs;
  if (jvmRaw) {
    const extra = String(jvmRaw).trim().split(/\s+/).filter(Boolean);
    if (extra.length) args.push(...extra);
  }
  if (json.arguments && json.arguments.jvm) {
    args.push(...expandArgs(json.arguments.jvm, values, features));
    // 主类必须紧跟 JVM/classpath 参数之后、游戏参数之前，否则 --username 会被 JVM 当作选项而启动即崩
    if (json.mainClass) args.push(json.mainClass);
  } else {
    args.push('-Djava.library.path=' + nativesDir, '-cp', cpList.join(CP_SEP), json.mainClass);
  }
  if (gameArgItems.length) {
    args.push(...expandArgs(json.arguments.game, values, features));
  } else if (json.minecraftArguments) {
    args.push(...json.minecraftArguments.split(' ').map(s => subVars(s, values)));
  } else {
    /* 兜底分支（版本 json 既无 arguments 也无 minecraftArguments，极老/异常实例）：
       --gameDir 必须跟 values.game_directory 同源用 launchDir —— 隔离实例的 cwd 是
       versions/<id>，这里再传根目录会让存档/MOD 读写错位置（审计 B3）。 */
    args.push('--username', username, '--version', versionId, '--accessToken', '0',
      '--gameDir', launchDir, '--assetsDir', values.assets_root, '--assetIndex', values.assets_index_name);
  }
  /* 自定义游戏窗口标题（PCL 同款做法：以 --title 传给客户端）。
     实例级的优先，没填就用「设置 → 启动 → 游戏窗口标题」里的全局那份。
     原版客户端在部分版本上不认这个参数 —— 客户端的参数解析开着 allowsUnrecognizedOptions，
     多传一个它不认识的参数会被忽略、不会让游戏起不来；装了「自定义窗口标题」类 Mod 时才真正生效。 */
  const winTitle = vsCfg.title || config.winTitle;
  if (winTitle) args.push('--title', winTitle);
  /* 全局窗口大小（设置 → 启动 → 窗口大小）：实例级想单独指定就在实例的游戏参数里写。
     0 / 空值 = 不指定，交给游戏自己决定。--width/--height 是官方客户端认得的参数。 */
  const wsz = config.winSize || {};
  if (Number(wsz.w) > 0 && Number(wsz.h) > 0) args.push('--width', String(Number(wsz.w)), '--height', String(Number(wsz.h)));
  if (wsz.max === true) args.push('--fullscreen');
  /* 额外游戏参数（PCL 的「游戏参数」）：实例级优先，其次全局。
     原样拼在启动参数末尾；支持引号包裹带空格的参数（"a b"）；
     不认识的参数会被客户端忽略，不会让游戏起不来。 */
  const gameArgsRaw = vsCfg.gameArgs || config.gameArgs;
  if (gameArgsRaw) {
    const parts = (gameArgsRaw.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(s => s.replace(/^["']|["']$/g, ''));
    if (parts.length) { args.push(...parts); logLine('[launch] 追加游戏参数: ' + parts.join(' ')); }
  }
  // 指定存档快速启动：json 未提供 feature 条目时的兜底（1.20+ 或新版本号方案）
  if (opts.world && !hasQpItem && supportsQuickPlay(chain.rootId)) {
    args.push('--quickPlaySingleplayer', opts.world);
  }

  // 账户注入：外置登录 javaagent / 离线自定义皮肤本地服务器（失败不阻断启动，但必须留痕）
  mark('参数');
  try {
    const agentArgs = await ensureSkinLaunch(logLine);
    if (agentArgs && agentArgs.length) args.unshift(...agentArgs);
  } catch (e) { logLine('[XLC] 皮肤/外置登录注入失败（' + e.message + '），本次以默认方式启动'); }
  mark('皮肤注入');

  logLine('[launch] ' + versionId + ' · java=' + java.path + ' (Java ' + java.major + (java.runtime ? ', 自动安装' : '') + (java.manual ? ', 手动指定' : '') + ') · Xmx=' + mem + 'G' + (memAuto ? '（智能分配·模组 ' + instMods.mods + ' 个' + (instMods.optifine ? '·含 OptiFine' : '') + '·当时可用 ' + (os.freemem() / 1073741824).toFixed(1) + 'G）' : '') + (isolated ? ' · 版本隔离' : '') + (vsCfg.title ? ' · 窗口标题=' + vsCfg.title : '') + (opts.world ? ' · world=' + opts.world : ''));

  logLine('[launch] 准备耗时 ' + (Date.now() - T0) + 'ms · ' + phase.join(' '));
  /* 干跑：测速用。走完整条准备链路后原地返回，不 spawn 游戏进程（也就不会真的开游戏）。 */
  if (LAUNCH_DRYRUN) {
    LAUNCHING = false;
    send('launch:log', '[XLC] 干跑：准备完成，未启动游戏进程（仅测速）');
    return { dryRun: true, ms: Date.now() - T0, phase };
  }

  // 启动前确保游戏语言为简体中文（隔离实例写入实例目录的 options.txt）
  if (config.forceChinese !== false) ensureChineseLang(launchDir);

  /* 启动前执行命令（设置 → 启动 → 高级选项）：支持 ${gameDir} / ${version} 占位。
     同步执行、等它跑完再启动游戏 —— 典型用途是「启动前把某处配置同步进实例」。
     失败不阻断启动（只记日志），免得一个可有可无的脚本把游戏卡在门外。 */
  if (config.preLaunchCmd) {
    const vars = { gameDir: launchDir, version: versionId };
    const unsafe = Object.keys(vars).filter(k => cmdVarUnsafe(vars[k]));
    if (unsafe.length) {
      /* 不阻断启动：只跳过这条可选脚本，并把原因同时写日志 + 告诉用户 */
      const msg = '实例名或游戏路径含 shell 特殊字符（' + unsafe.map(k => '${' + k + '}').join(' / ') +
        '），已跳过「启动前命令」以免被当成命令分隔符';
      logLine('[launch] ' + msg);
      send('launch:log', '[XLC] ' + msg);
      toast(msg, 'warn');
    } else {
      const cmdStr = subVars(String(config.preLaunchCmd).trim(), vars);
      if (cmdStr) {
        send('launch:log', '[XLC] 执行启动前命令: ' + cmdStr);
        try {
          await new Promise((resolve) => {
            const sh = spawn(cmdStr, { cwd: launchDir, shell: true });
            let ob = '';
            sh.stdout.on('data', d => { ob += d.toString(); });
            sh.stderr.on('data', d => { ob += d.toString(); });
            sh.on('error', (e) => { send('launch:log', '[XLC] 启动前命令执行失败: ' + e.message); resolve(); });
            sh.on('exit', (c) => {
              if (ob.trim()) send('launch:log', ob.trim().split(/\r?\n/).slice(0, 20).join('\n'));
              if (c !== 0) send('launch:log', '[XLC] 启动前命令退出码 ' + c + '（不阻断启动）');
              resolve();
            });
          });
        } catch (e) { send('launch:log', '[XLC] 启动前命令异常: ' + e.message + '（不阻断启动）'); }
      }
    }
  }

  setStatus('游戏运行中: ' + versionId, true);
  /* 内置插件「存档备份」：启动前给「变过的存档」拍一张。
     预算 20 秒 —— 备份再重要也不能让玩家点了启动干等；超时的存档下次再备。
     失败只写日志，绝不影响启动。 */
  try {
    const bk = await autoBackupSaves('launch', 20000);
    if (bk && bk.done && bk.done.length) {
      send('launch:log', '[XLC] 存档备份：已备份 ' + bk.done.map(d => d.name).join('、') + '（启动前）');
    }
  } catch (e) { logLine('[backup] 启动前自动备份失败: ' + e.message); }
  send('launch:log', '[XLC] 启动命令: ' + path.basename(java.path) + ' ' + args.join(' ').slice(0, 400) + ' …');
  /* 请求使用高性能显卡（设置 → 启动）：Windows 上给子进程加这一条启动信息，
     双显卡笔记本会优先用独显（不保证 100% 生效，取决于驱动与系统设置）。 */
  const child = spawn(java.path, args, {
    cwd: launchDir,
    windowsHide: false,
    ...(config.gpuPref === true ? { env: Object.assign({}, process.env, { SHIM_MCCOMPAT: '0x800000001' }) } : {})
  });
  /* 游戏进程优先级（设置 → 启动 → 进程优先级）：只在 Windows 上有意义。 */
  try {
    const prio = { high: 'high', abovenormal: 'abovenormal', below: 'below', normal: 'normal' }[config.procPriority];
    if (prio && prio !== 'normal' && process.platform === 'win32') {
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `(Get-Process -Id ${child.pid}).PriorityClass = '${prio === 'high' ? 'High' : prio === 'below' ? 'BelowNormal' : 'AboveNormal'}'`],
        { windowsHide: true, stdio: 'ignore' });
      ps.on('error', () => {});
      send('launch:log', '[XLC] 已把游戏进程优先级设为 ' + prio);
    }
  } catch (_) {}
  /* 启动器可见性（设置 → 启动 → 启动器可见性）：等进程**真的 spawn 成功**再安排隐藏，
     免得「启动失败/进程秒退」时窗口被藏在一个没有游戏的世界里
     （见 scheduleLauncherHide / restoreLauncherWindow 的注释）。 */
  try {
    const vis = config.launcherVisibility || 'keep';
    child.once('spawn', () => { try { scheduleLauncherHide(vis, child); } catch (_) {} });
  } catch (_) {}
  /* 记下进程 → 主页按钮自此变成「关闭游戏」；进程真起来了才通知（启动流程前面还有 Java 下载 / 校验） */
  GAME_PROC = child;
  GAME_STOP_BY_USER = false;
  send('launch:stage', { stage: 'running', pid: child.pid, versionId });
  setStatus('游戏中');
  /* 最近游玩记录：进程成功拉起即记一条（同名去重、最多 5 条） */
  try {
    const rec = [{ id: versionId, time: Date.now() },
      ...(config.recent || []).filter(r => r.id !== versionId)].slice(0, 5);
    config.recent = rec;
    saveConfigNow();
  } catch (_) {}
  let buf = '';
  const stream = (data) => {
    buf += data.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) if (line.trim()) send('launch:log', line);
  };
  child.stdout.on('data', stream);
  child.stderr.on('data', stream);
  child.on('error', (err) => {
    LAUNCHING = false;
    if (GAME_PROC === child) GAME_PROC = null;
    send('launch:stage', { stage: 'idle' });
    /* spawn 失败（Java 路径不对 / 权限不足 / 被杀软拦）也必须把窗口带回前台：
       否则在「启动器可见性 = 隐藏」下，用户点完启动界面就没了，看起来像启动器被关了 */
    restoreLauncherWindow();
    toast('游戏进程启动失败: ' + err.message, 'error');
  });
  child.on('exit', (code) => {
    LAUNCHING = false; /* 游戏进程退出，释放主进程启动锁 */
    const byUser = GAME_STOP_BY_USER;   /* 用户自己按的「关闭游戏」 */
    if (GAME_PROC === child) GAME_PROC = null;
    GAME_STOP_BY_USER = false;
    /* 游戏退出后把因「启动器可见性」藏起来的主窗口收回来，否则用户会以为启动器被关掉了；
       顺带清掉可能还挂着的隐藏定时器（进程秒退时它本会把窗口藏掉） */
    restoreLauncherWindow();
    /* 内置插件「存档备份」：游戏退出后再备一次（这次覆盖本次游玩全部进度）。
       延迟 2.5 秒 —— 进程刚退时 region 文件可能还在 flush，太早打包会读到半截文件。
       定时器登记在 EXIT_BAK_TIMER 里：玩家这时关启动器，before-quit 会接管并等它跑完。 */
    scheduleExitBackup();
    send('launch:stage', { stage: 'idle', code, byUser });
    setStatus('就绪');
    /* 主动关闭属于正常收尾：taskkill 出来的退出码当然不是 0，但这不是崩溃 ——
       不报「异常退出」、也不跑崩溃诊断（否则每次关游戏都弹一次诊断，很吵） */
    if (byUser) {
      toast('游戏已关闭');
      send('launch:exit', { code, byUser: true });
      return;
    }
    toast(code === 0 ? '游戏已退出' : '游戏已退出（代码 ' + code + '）', code === 0 ? 'ok' : 'warn');
    if (code !== 0) {
      /* 异常退出：自动跑一次崩溃诊断，结果随 launch:exit 发给界面 */
      diagnoseGameCrash(gd, versionId).then(diag => {
        send('launch:exit', { code, diag });
      }).catch(() => send('launch:exit', { code }));
    } else {
      send('launch:exit', { code });
    }
  });
  return child;
}

/* 启动后台预热 Java 探测缓存：把「扫全盘找 Java」这段慢活挪到启动器空闲的时候做，
   用户点「启动游戏」时就不用再等它（缓存 6 小时内有效就不重复扫）。
   自测进程一律不掺和（会干扰用例的进程 / 计时）。 */
function warmJavaCacheLater() {
  if (SMOKE_EARLY) return;
  try {
    const c = readJavaDiskCache();
    if (c.list && c.list.length && Date.now() - (c.t || 0) < 6 * 3600 * 1000) return;
  } catch (_) {}
  const t = setTimeout(() => {
    if (LAUNCHING || GAME_PROC) return;      /* 正在启动 / 游戏在跑就别添乱 */
    logLine('[java] 后台预热 Java 缓存…');
    detectJavaInner(true).catch(() => {});
  }, 6000);
  if (t.unref) t.unref();
}
/* 启动耗时自测（`LMC_SMOKE_LAUNCH=<版本名>`；值为 1 / true / 空 则自动挑一个实例）：
   干跑一次完整的启动准备链路（版本链 / 账户 / Java / 内存 / classpath / natives / 启动参数 / 皮肤注入），
   到 spawn 之前停下，把分段耗时打到 stdout。用途：优化启动速度时拿可复现的前后对照数字。
   注意：要量真实配置就得同时给 `LMC_DATA_DIR=<数据目录>`（否则冒烟模式会把数据目录换成临时目录）。 */
async function launchTimingProbe(arg) {
  const want = (arg && arg !== '1' && arg !== 'true') ? arg : '';
  let id = want || config.defaultVersion || config.lastVersion || '';
  if (!id) {
    try {
      const vDir = path.join(config.gameDir, 'versions');
      id = fs.readdirSync(vDir).filter(n => fs.existsSync(path.join(vDir, n, n + '.json')))[0] || '';
    } catch (_) {}
  }
  if (!id) throw new Error('没有可用实例（' + path.join(config.gameDir, 'versions') + ' 里没有带 json 的版本）');
  LAUNCH_DRYRUN = true;
  console.log('[LAUNCH-TIME] 实例: ' + id + ' · gameDir=' + config.gameDir + ' · 账户=' + (activeName() || '(无)'));
  const r = await runLaunch({ versionId: id, username: config.username || 'Steve' });
  const ms = (r && r.dryRun) ? r.ms : -1;
  console.log('[LAUNCH-TIME] 准备耗时 ' + ms + 'ms · ' + (((r && r.phase) || []).join(' ')));
  return { ms, phase: (r && r.phase) || [] };
}

/* 关闭正在运行的游戏（主页按钮变「关闭游戏」后点它走这里）。
   一律收整棵进程树：游戏本体是 java.exe，但模组 / 参数可能再 fork 出子进程，
   只杀父进程会留下一堆孤儿 java 继续吃内存。 */
ipcMain.handle('launch:stop', () => {
  const c = GAME_PROC;
  if (!c || !c.pid) return { ok: false, error: '当前没有正在运行的游戏' };
  if (c.exitCode !== null && c.exitCode !== undefined) return { ok: false, error: '游戏进程已经结束了' };
  logLine('[launch] 用户请求关闭游戏 pid=' + c.pid + '（收整棵进程树）');
  GAME_STOP_BY_USER = true;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
    } else {
      try { process.kill(-c.pid, 'SIGTERM'); } catch (_) { c.kill('SIGTERM'); }
    }
  } catch (e) {
    GAME_STOP_BY_USER = false;
    return { ok: false, error: e.message };
  }
  return { ok: true, pid: c.pid };
});

/* ---------------- 目录扫描 / 导入 ---------------- */
function detectLoaderOf(json) {
  const names = (json.libraries || []).map(l => l.name || (l.downloads && l.downloads.artifact && l.downloads.artifact.path) || '').join(' ');
  if (/fabricmc/i.test(names) || /fabric/i.test(json.mainClass || '')) return 'Fabric';
  if (/quiltmc/i.test(names)) return 'Quilt';
  if (/neoforged/i.test(names)) return 'NeoForge';
  if (/minecraftforge/i.test(names) || /forge/i.test(json.mainClass || '')) return 'Forge';
  if (/optifine/i.test(names) || /optifine/i.test(json.mainClass || '')) return 'OptiFine';
  return 'Vanilla';
}
ipcMain.handle('dir:scan', async () => {
  const gd = config.gameDir;
  const out = { gameDir: gd, exists: fs.existsSync(gd), versions: [], saves: [], broken: [] };
  if (!out.exists) return out;
  const vDir = path.join(gd, 'versions');
  try {
    for (const sub of await fsp.readdir(vDir)) {
      const subDir = path.join(vDir, sub);
      try { if (!(await fsp.stat(subDir)).isDirectory()) continue; } catch (_) { continue; }
      const jsonFile = path.join(subDir, sub + '.json');
      /* 目录在但版本 JSON 缺失/损坏 → 记为"残留目录"，界面单独展示并可删除
         （不能当已安装实例：启动不了；也不能默默忽略：会永久挡住该版本的安装） */
      if (!fs.existsSync(jsonFile)) { out.broken.push({ folder: sub, path: subDir, reason: '缺少 ' + sub + '.json' }); continue; }
      try {
        const json = JSON.parse(await fsp.readFile(jsonFile, 'utf8'));
        const item = {
          id: json.id || sub,
          folder: sub,
          loader: detectLoaderOf(json),
          /* version.json 自带的类型（release/snapshot/old_beta/old_alpha）——
             版本列表的方块图标要用；改过名 / 继承链上的实例渲染层还有清单匹配和 id 形状兜底 */
          type: (typeof json.type === 'string' && json.type) ? json.type : null,
          inherits: !!json.inheritsFrom,
          hasJar: fs.existsSync(path.join(subDir, sub + '.jar')),
          mcVersion: null
        };
        try { item.mcVersion = (await loadVersionChain(item.id, gd, 0)).rootId; } catch (_) {}
        out.versions.push(item);
      } catch (e) {
        out.broken.push({ folder: sub, path: subDir, reason: '版本 JSON 损坏: ' + e.message });
      }
    }
  } catch (_) {}
  const sDir = path.join(gd, 'saves');
  try {
    for (const sub of await fsp.readdir(sDir)) {
      if (fs.existsSync(path.join(sDir, sub, 'level.dat'))) out.saves.push({ name: sub, path: path.join(sDir, sub), instance: '' });
    }
  } catch (_) {}
  /* 版本隔离（PCL 式）：实例目录下自己的 saves/，存档带 instance 标记 */
  try {
    for (const sub of await fsp.readdir(vDir)) {
      const iDir = path.join(vDir, sub, 'saves');
      let names = [];
      try { names = await fsp.readdir(iDir); } catch (_) { continue; }
      for (const w of names) {
        if (fs.existsSync(path.join(iDir, w, 'level.dat'))) out.saves.push({ name: w, path: path.join(iDir, w), instance: sub });
      }
    }
  } catch (_) {}
  return out;
});
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog({ title: '选择 .minecraft 目录', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
/* 打开本地路径（资源管理器）。防御纵深：只放行游戏目录 / 数据目录子树内的路径，
   渲染层若被污染也不能借此打开系统任意位置（与 shell:open-external 的协议白名单同一思路） */
ipcMain.handle('shell:open', (_e, p) => {
  const abs = path.resolve(String(p || ''));
  const roots = [config.gameDir, DATA_DIR]
    .filter(Boolean)
    .map(r => path.resolve(String(r)));
  const inside = roots.some(r => abs === r || abs.startsWith(r + path.sep));
  if (!inside) {
    logLine('[shell:open] 拒绝打开允许范围外的路径: ' + abs);
    toast('出于安全考虑，只能打开游戏目录或数据目录内的文件', 'warn');
    return false;
  }
  shell.openPath(abs);
  return true;
});
/* 剪贴板：渲染端 navigator.clipboard 在部分环境不可用，走主进程兜底 */
ipcMain.handle('clipboard:write', (_e, t) => {
  try { clipboard.writeText(String(t === undefined || t === null ? '' : t)); return true; } catch (_) { return false; }
});
/* 统一确认框（替代渲染层的 window.confirm）。
   window.confirm 是**阻塞式**的：弹出期间渲染进程 JS 线程停摆，界面照常画着但点什么都没反应、
   打字也没反应；在无边框窗口上它还可能跑到窗口后面，用户看到的就是「启动器卡死」。
   这里改成主进程的原生对话框（正确挂在窗口上 → 一定显示在最前），await 期间渲染层照常响应。 */
ipcMain.handle('ui:confirm', async (e, p) => {
  /* 冒烟测试（headless）弹不出真对话框 —— 自动确认，让 e2e 能走完「开始修改」这类链路 */
  if (process.env.LMC_SMOKE_UI_JS) return { ok: true, smoke: true };
  const o = p || {};
  const parent = BrowserWindow.fromWebContents(e.sender) || win || null;
  const opts = {
    type: o.danger ? 'warning' : 'question',
    buttons: [o.okText || '确定', o.cancelText || '取消'],
    defaultId: o.danger ? 1 : 0, /* 危险操作默认停在「取消」，防误触 */
    cancelId: 1,
    noLink: true,
    title: o.title || 'XLC 启动器',
    message: o.message || '确定继续吗？'
  };
  if (o.detail) opts.detail = o.detail;
  try {
    const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    return { ok: r.response === 0 };
  } catch (e) {
    /* 打不开对话框时把原因带回渲染层（渲染层会 toast 出来），避免用户点了删除却毫无反应 */
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ================= 存档管理：NBT / Region 解析 + 已加载区块预览渲染 ================= */
/* 极简 NBT 读取器（只解析存档需要的类型；Long 用 BigInt 防精度丢失） */
function nbtReadName(buf, o) {
  const n = buf.readUInt16BE(o);
  return [buf.toString('utf8', o + 2, o + 2 + n), o + 2 + n];
}
function nbtReadTag(buf, o, t) {
  switch (t) {
    case 1: return [buf.readInt8(o), o + 1];
    case 2: return [buf.readInt16BE(o), o + 2];
    case 3: return [buf.readInt32BE(o), o + 4];
    case 4: return [buf.readBigInt64BE(o), o + 8];
    case 5: return [buf.readFloatBE(o), o + 4];
    case 6: return [buf.readDoubleBE(o), o + 8];
    case 7: { const n = buf.readInt32BE(o); return [buf.subarray(o + 4, o + 4 + n), o + 4 + n]; }
    case 8: return nbtReadName(buf, o);
    case 9: {
      const et = buf.readInt8(o), n = buf.readInt32BE(o + 1);
      let p = o + 5; const arr = [];
      for (let i = 0; i < n; i++) { const r = nbtReadTag(buf, p, et); arr.push(r[0]); p = r[1]; }
      return [arr, p];
    }
    case 10: {
      const obj = {}; let p = o;
      for (;;) {
        const tt = buf.readInt8(p); p += 1;
        if (tt === 0) break;
        const nr = nbtReadName(buf, p); p = nr[1];
        const r = nbtReadTag(buf, p, tt); p = r[1];
        obj[nr[0]] = r[0];
      }
      return [obj, p];
    }
    case 11: { const n = buf.readInt32BE(o); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = buf.readInt32BE(o + 4 + i * 4); return [a, o + 4 + n * 4]; }
    case 12: { const n = buf.readInt32BE(o); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = buf.readBigInt64BE(o + 4 + i * 8); return [a, o + 4 + n * 8]; }
    default: throw new Error('未知 NBT 类型: ' + t);
  }
}
function nbtParse(raw) {
  const buf = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw) : raw;
  const t = buf.readUInt8(0);
  const nr = nbtReadName(buf, 1);
  return nbtReadTag(buf, nr[1], t)[0];
}
/* 高度图解码：每项 9 bit，每个 long 装 7 项，索引 = z*16 + x */
function decodeHeightmap(longs) {
  if (!Array.isArray(longs) || !longs.length) return null;
  const out = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const li = (i / 7) | 0;
    if (li >= longs.length) { out[i] = 0; continue; }
    out[i] = Number((longs[li] >> BigInt((i % 7) * 9)) & 0x1FFn);
  }
  return out;
}
/* 旧格式（pre-1.18）回退：扫描 Sections 的 Blocks/Palette 求每列最高非空气方块 */
const LEGACY_BLOCK = {
  1: 'stone', 2: 'grass_block', 3: 'dirt', 4: 'stone', 5: 'oak_planks', 7: 'bedrock', 8: 'water', 9: 'water',
  10: 'lava', 11: 'lava', 12: 'sand', 13: 'gravel', 14: 'gold_ore', 15: 'iron_ore', 16: 'coal_ore',
  17: 'oak_log', 18: 'oak_leaves', 24: 'sandstone', 31: 'grass', 35: 'white_wool', 41: 'gold_block',
  42: 'iron_block', 45: 'bricks', 48: 'mossy_cobblestone', 49: 'obsidian', 56: 'diamond_ore', 57: 'diamond_block',
  78: 'snow', 79: 'ice', 80: 'snow_block', 81: 'cactus', 82: 'clay', 83: 'sugar_cane', 87: 'netherrack',
  88: 'soul_sand', 89: 'glowstone', 98: 'stone_bricks', 110: 'mycelium', 121: 'end_stone', 129: 'emerald_ore',
  155: 'quartz_block', 159: 'terracotta', 174: 'packed_ice'
};
function scanTopBlocksOf(chunk) {
  const secs = Array.isArray(chunk.Sections) ? chunk.Sections : (chunk.Level && Array.isArray(chunk.Level.Sections) ? chunk.Level.Sections : null);
  if (!secs) return null;
  const tops = new Int16Array(256).fill(-1);
  const names = new Array(256).fill('');
  for (const sec of secs) {
    const blocks = sec && sec.Blocks;
    if (!blocks || !blocks.length) continue;
    const pal = Array.isArray(sec.Palette) ? sec.Palette.map(p => String((p && p.Name) || '')) : null;
    const add = sec.Add && sec.Add.length ? sec.Add : null;
    const sy = Number(sec.Y || 0) * 16;
    for (let y = 0; y < 16; y++) {
      const wy = sy + y;
      for (let c = 0; c < 256; c++) {
        const i = y * 256 + c;
        let id = blocks[i] & 0xff;
        if (add) id |= ((add[i >> 1] >> ((i & 1) * 4)) & 0x0f) << 8;
        const nm = pal ? (pal[id] || '') : (LEGACY_BLOCK[id] || '');
        if (!nm || /(^|_)air$/.test(nm)) continue;   // 空气 / cave_air / void_air 跳过
        if (wy > tops[c]) { tops[c] = wy; names[c] = nm; }
      }
    }
  }
  return tops.some ? { tops, names } : null;
}
/* 方块名 → 颜色（无匹配则交给高度渐变着色） */
const BLOCK_COLOR = {
  water: [58, 122, 190], lava: [200, 84, 30], sand: [222, 210, 161], sandstone: [216, 203, 155],
  gravel: [136, 130, 127], dirt: [134, 96, 67], grass_block: [124, 168, 88], grass: [124, 168, 88],
  oak_leaves: [92, 146, 66], snow: [244, 247, 250], snow_block: [240, 245, 250], ice: [150, 186, 226],
  packed_ice: [141, 180, 219], clay: [160, 166, 179], stone: [128, 128, 128], cobblestone: [122, 122, 122],
  bedrock: [72, 72, 72], obsidian: [22, 18, 30], netherrack: [110, 54, 52], soul_sand: [85, 66, 52],
  end_stone: [219, 222, 158], terracotta: [152, 94, 67], mycelium: [111, 100, 111], mossy_cobblestone: [90, 108, 70],
  oak_log: [150, 124, 78], birch_log: [216, 214, 205], gold_block: [246, 220, 88], iron_block: [220, 220, 220],
  diamond_block: [94, 219, 213], bricks: [150, 84, 68], quartz_block: [235, 231, 224], white_wool: [233, 236, 236]
};
function columnColor(name, water, hNorm, shade) {
  let base = null;
  if (water) {
    base = [58, 122, 190];
    base = base.map(c => Math.round(c * (0.82 + 0.28 * hNorm)));
  } else if (name && BLOCK_COLOR[name]) {
    base = BLOCK_COLOR[name].slice();
  } else {
    /* 高度渐变：低地草绿 → 中海拔黄褐 → 高地岩石/雪 */
    const stops = [
      [0.00, [104, 156, 82]], [0.28, [126, 168, 92]], [0.5, [150, 152, 96]],
      [0.68, [156, 132, 96]], [0.84, [150, 146, 140]], [1.0, [236, 240, 244]]
    ];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (hNorm >= stops[i][0] && hNorm <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const t = (hNorm - a[0]) / Math.max(1e-6, b[0] - a[0]);
    base = [0, 1, 2].map(k => Math.round(a[1][k] + (b[1][k] - a[1][k]) * t));
  }
  return base.map(c => Math.max(0, Math.min(255, Math.round(c * shade))));
}
/* 手写 PNG 编码（8 位 RGBA，filter 0） */
function pngEncode(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const mkChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(mkChunk('IHDR', ihdr));
  chunks.push(mkChunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(mkChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
/* 已加载区块所在目录：兼容旧布局（根 region/、DIM-1、DIM1）
 * 与 1.21.9+（25w31a 起）新布局（dimensions/<命名空间>/<维度>/region/） */
function findRegionDirs(saveDir) {
  const out = [];
  const add = (label, key, dir) => {
    if (!fs.existsSync(dir)) return;
    if (out.some(o => o.dir === dir)) return;
    out.push({ label, key, dir });
  };
  add('主世界', 'overworld', path.join(saveDir, 'region'));
  add('下界', 'the_nether', path.join(saveDir, 'DIM-1', 'region'));
  add('末地', 'the_end', path.join(saveDir, 'DIM1', 'region'));
  const dimRoot = path.join(saveDir, 'dimensions');
  let nsList = [];
  try { nsList = fs.readdirSync(dimRoot); } catch (_) {}
  for (const ns of nsList) {
    let paths = [];
    try { paths = fs.readdirSync(path.join(dimRoot, ns)); } catch (_) { continue; }
    for (const p of paths) {
      const dir = path.join(dimRoot, ns, p, 'region');
      if (!fs.existsSync(dir)) continue;
      let label = ns + ':' + p, key = ns + ':' + p;
      if (ns === 'minecraft' && p === 'overworld') { label = '主世界'; key = 'overworld'; }
      else if (ns === 'minecraft' && p === 'the_nether') { label = '下界'; key = 'the_nether'; }
      else if (ns === 'minecraft' && p === 'the_end') { label = '末地'; key = 'the_end'; }
      add(label, key, dir);
    }
  }
  return out;
}
function regionFilesIn(dir) {
  try { return fs.readdirSync(dir).filter(f => /^r\.-?\d+\.-?\d+\.mca$/i.test(f)); } catch (_) { return []; }
}
/* 种子：新格式（1.21.9+）level.dat 里已没有种子，改存 data/minecraft/world_gen_settings.dat */
async function readWorldGenSeed(saveDir) {
  const cands = [
    ['data', 'minecraft', 'world_gen_settings.dat'],
    ['data', 'minecraft', 'world_gen_settings.dat_old'],
    ['data', 'world_gen_settings.dat']
  ];
  for (const c of cands) {
    try {
      const o = nbtParse(await fsp.readFile(path.join(saveDir, ...c)));
      const g = o && o.data ? o.data : (o && o.Data ? o.Data : o);
      if (g && g.seed !== undefined && g.seed !== null) return String(g.seed);
    } catch (_) {}
  }
  return null;
}
const DIFF_ORDER = ['peaceful', 'easy', 'normal', 'hard'];
/* 解析 level.dat → 存档元信息（兼容旧格式与 1.21.9+ 新存档格式） */
async function readLevelMeta(saveDir) {
  const meta = {
    name: path.basename(saveDir), levelName: '', seed: null, lastPlayed: 0, mcVersion: '',
    gameType: 0, hardcore: false, day: 0, spawn: null, spawnDim: '', difficulty: 0,
    difficultyName: '', dataVersion: 0
  };
  let dat = null;
  try { dat = nbtParse(await fsp.readFile(path.join(saveDir, 'level.dat'))); } catch (_) { return meta; }
  const d = dat && dat.Data ? dat.Data : dat;
  if (!d) return meta;
  meta.levelName = String(d.LevelName || '');
  meta.dataVersion = Number(d.DataVersion || (d.Version && d.Version.Id) || 0);
  /* 种子：旧格式 RandomSeed / WorldGenSettings.seed；新格式读 world_gen_settings.dat */
  const seedRaw = (d.WorldGenSettings && d.WorldGenSettings.seed !== undefined) ? d.WorldGenSettings.seed : d.RandomSeed;
  if (seedRaw !== undefined && seedRaw !== null) meta.seed = String(seedRaw);
  else meta.seed = await readWorldGenSeed(saveDir);
  meta.lastPlayed = Number(d.LastPlayed || 0);
  meta.mcVersion = String((d.Version && d.Version.Name) || d.VersionId || '');
  meta.gameType = Number(d.GameType !== undefined ? d.GameType : 0);
  /* 难度/硬核：新格式在 difficulty_settings 子标签（difficulty 是名字字符串） */
  const ds = d.difficulty_settings || d.DifficultySettings;
  if (ds && typeof ds === 'object') {
    const dv = ds.difficulty;
    if (typeof dv === 'number') { meta.difficulty = dv; meta.difficultyName = DIFF_ORDER[dv] || ''; }
    else { meta.difficultyName = String(dv || ''); const i = DIFF_ORDER.indexOf(meta.difficultyName.toLowerCase()); meta.difficulty = i < 0 ? 0 : i; }
    meta.hardcore = Number(ds.hardcore || 0) === 1;
  } else {
    meta.difficulty = Number(d.Difficulty || 0);
    meta.difficultyName = DIFF_ORDER[meta.difficulty] || '';
    meta.hardcore = (d.Hardcore === 1 || d.Hardcore === true);
  }
  /* 游戏天数：旧 DayTime（当天时间）/ 新 Time（世界存活时长） */
  const t = (d.DayTime !== undefined) ? d.DayTime : d.Time;
  meta.day = Math.max(0, Math.floor(Number(t || 0) / 24000));
  /* 生成点：旧 SpawnX/Y/Z；新 spawn = { pos:[x,y,z], dimension } */
  const sp = d.spawn;
  if (sp && typeof sp === 'object' && Array.isArray(sp.pos) && sp.pos.length >= 3) {
    meta.spawn = { x: Number(sp.pos[0]), y: Number(sp.pos[1]), z: Number(sp.pos[2]) };
    meta.spawnDim = String(sp.dimension || 'minecraft:overworld');
  } else {
    const sx = (d.SpawnX !== undefined) ? d.SpawnX : (d.spawnX !== undefined ? d.spawnX : null);
    const sy = (d.SpawnY !== undefined) ? d.SpawnY : (d.spawnY !== undefined ? d.spawnY : 64);
    const sz = (d.SpawnZ !== undefined) ? d.SpawnZ : (d.spawnZ !== undefined ? d.spawnZ : null);
    if (sx !== null && sz !== null) { meta.spawn = { x: Number(sx), y: Number(sy || 64), z: Number(sz) }; meta.spawnDim = 'minecraft:overworld'; }
  }
  return meta;
}
/* 目录体积（限深度，避免超大存档卡住） */
async function dirSize(p, depth) {
  let total = 0;
  let items = [];
  try { items = await fsp.readdir(p, { withFileTypes: true }); } catch (_) { return 0; }
  for (const it of items) {
    const fp = path.join(p, it.name);
    if (it.isDirectory()) { if ((depth || 0) < 4) total += await dirSize(fp, (depth || 0) + 1); }
    else { try { total += (await fsp.stat(fp)).size; } catch (_) {} }
  }
  return total;
}
async function scanSaveDirs() {
  const gd = config.gameDir;
  const out = [];
  const push = (name, dir, instance) => out.push({ name, path: dir, instance: instance || '' });
  try {
    for (const sub of await fsp.readdir(path.join(gd, 'saves'))) {
      const wd = path.join(gd, 'saves', sub);
      if (fs.existsSync(path.join(wd, 'level.dat'))) push(sub, wd, '');
    }
  } catch (_) {}
  try {
    const vDir = path.join(gd, 'versions');
    for (const sub of await fsp.readdir(vDir)) {
      const iSaves = path.join(vDir, sub, 'saves');
      let names = [];
      try { names = await fsp.readdir(iSaves); } catch (_) { continue; }
      for (const w of names) {
        const wd = path.join(iSaves, w);
        if (fs.existsSync(path.join(wd, 'level.dat'))) push(w, wd, sub);
      }
    }
  } catch (_) {}
  return out;
}
ipcMain.handle('saves:list', async () => {
  try {
    const list = await scanSaveDirs();
    const res = [];
    for (const s of list) {
      const meta = await readLevelMeta(s.path);
      /* 已加载区块：兼容旧布局与新布局（dimensions/...），按维度汇总 */
      const dims = [];
      let regions = 0;
      for (const rd of findRegionDirs(s.path)) {
        const n = regionFilesIn(rd.dir).length;
        if (!n) continue;
        dims.push({ key: rd.key, label: rd.label, count: n });
        regions += n;
      }
      const hasRegion = dims.length > 0;
      let icon = null;
      try {
        const ip = path.join(s.path, 'icon.png');
        const st = await fsp.stat(ip);
        if (st.size < 300 * 1024) icon = 'data:image/png;base64,' + (await fsp.readFile(ip)).toString('base64');
      } catch (_) {}
      res.push({
        name: s.name, path: s.path, instance: s.instance, levelName: meta.levelName,
        seed: meta.seed, lastPlayed: meta.lastPlayed, mcVersion: meta.mcVersion,
        gameType: meta.gameType, hardcore: meta.hardcore, day: meta.day, difficulty: meta.difficulty,
        difficultyName: meta.difficultyName, spawn: meta.spawn, spawnDim: meta.spawnDim,
        size: await dirSize(s.path, 0), hasRegion, regions, dims, icon,
        legacy: !hasRegion
      });
    }
    res.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    return { ok: true, gameDir: config.gameDir, saves: res };
  } catch (e) { return { ok: false, error: e.message, saves: [] }; }
});
/* 已加载区块预览：读 region 高度图 → 逐列着色 → PNG
 * ⚠️ 这条链路**不许任何缓存**（用户明确要求：每次预览都现场检测区块文件）——
 *    每次都重新 findRegionDirs() + regionFilesIn() 扫盘、重新 open 读文件头，
 *    这样「列表扫描之后又进过世界 / 手动导入过存档」也能立刻看到新区块。
 *    别为了省一次 readdir 加记忆化：region 目录是玩家随时在写的活数据。 */
ipcMain.handle('saves:preview', async (_e, p) => {
  const saveDir = String((p && p.path) || '');
  /* 预览期间打开的 .mca 句柄：正常返回 / 提前 return / 抛异常都要关。
     只在「正常读完」那条路径上 close，一旦 decodeHeightmap / scanTopBlocksOf / pngEncode
     抛错就会从外层 catch 直接返回，句柄越积越多 → 反复预览畸形存档最终 EMFILE（审计 B2）。
     统一放进 finally，异常路径同样收口。 */
  const handles = new Map();
  try {
    if (!fs.existsSync(path.join(saveDir, 'level.dat'))) return { ok: false, error: '不是有效的存档目录' };
    const maxChunks = 32;                      // 渲染窗口上限（32×32 区块 = 512×512 像素）
    const scannedAt = Date.now();              // 本次现场检测的时间戳（渲染层「重新检测」按钮用来显示新鲜度）
    /* 维度目录：旧布局根 region/ 与新布局 dimensions/<ns>/<dim>/region/ 都收 */
    const allDims = findRegionDirs(saveDir)
      .map(d => ({ key: d.key, label: d.label, dir: d.dir, files: regionFilesIn(d.dir) }))
      .filter(d => d.files.length);
    if (!allDims.length) return { ok: false, error: '该存档还没有已加载的区块（尚未进入过世界）', noRegion: true };
    const want = String((p && p.dim) || '');
    const dimKeys = allDims.map(d => d.key);
    const dims = allDims.map(d => ({ key: d.key, label: d.label, count: d.files.length }));
    const cur = allDims.find(d => d.key === want) || allDims.find(d => d.key === 'overworld') || allDims[0];
    const regionDir = cur.dir;
    const files = cur.files;
    /* 收集区块坐标 + 保留读句柄（只读取，预览结束后统一在 finally 关闭） */
    const chunks = [];
    for (const f of files) {
      const fp = path.join(regionDir, f);
      let fh = null, head = Buffer.alloc(4096);
      try {
        fh = await fsp.open(fp, 'r');
        const st = await fh.stat();
        if (st.size < 8192) { await fh.close(); continue; }
        await fh.read(head, 0, 4096, 0);
      } catch (_) {
        /* open 成功但 stat/read 失败时句柄还没进 handles，这里就地关掉 */
        try { if (fh) await fh.close(); } catch (_) {}
        continue;
      }
      handles.set(f, fh);
      const mm = f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/i);
      const rx = Number(mm[1]), rz = Number(mm[2]);
      for (let i = 0; i < 1024; i++) {
        if (!head.readUIntBE(i * 4, 4)) continue;
        const lx = i % 32, lz = (i / 32) | 0;
        chunks.push({ rx, rz, lx, lz, cx: rx * 32 + lx, cz: rz * 32 + lz, f, idx: i });
      }
    }
    if (!chunks.length) return { ok: false, error: '该存档还没有已加载的区块', noRegion: true };
    /* 渲染窗口：包围盒放得下就用整个包围盒；放不下则以生成点（或包围盒中心）为中心裁剪 maxChunks 窗口 */
    const meta = await readLevelMeta(saveDir);
    const xs = chunks.map(c => c.cx), zs = chunks.map(c => c.cz);
    const bbox = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    const bw = bbox.x1 - bbox.x0 + 1, bh = bbox.z1 - bbox.z0 + 1;
    let originX, originZ, W, H;
    if (bw <= maxChunks && bh <= maxChunks) {
      originX = bbox.x0 * 16; originZ = bbox.z0 * 16; W = bw * 16; H = bh * 16;
      /* 用变量记录窗口区块范围，供过滤使用 */
      var win = { x0: bbox.x0, x1: bbox.x1, z0: bbox.z0, z1: bbox.z1 };
    } else {
      let ccx, ccz;
      if (meta.spawn) { ccx = Math.floor(meta.spawn.x / 16); ccz = Math.floor(meta.spawn.z / 16); }
      else { ccx = Math.round((bbox.x0 + bbox.x1) / 2); ccz = Math.round((bbox.z0 + bbox.z1) / 2); }
      const inWinOf = (ax, az) => chunks.filter(c => Math.abs(c.cx - ax) <= maxChunks / 2 && Math.abs(c.cz - az) <= maxChunks / 2).length;
      /* 生成点附近区块太少（生成点在海里/远处）→ 改用包围盒中心 */
      if (inWinOf(ccx, ccz) < 4) { ccx = Math.round((bbox.x0 + bbox.x1) / 2); ccz = Math.round((bbox.z0 + bbox.z1) / 2); }
      const half = Math.floor(maxChunks / 2);
      originX = (ccx - half) * 16; originZ = (ccz - half) * 16; W = maxChunks * 16; H = maxChunks * 16;
      var win = { x0: ccx - half, x1: ccx - half + maxChunks - 1, z0: ccz - half, z1: ccz - half + maxChunks - 1 };
    }
    const keep = chunks.filter(c => c.cx >= win.x0 && c.cx <= win.x1 && c.cz >= win.z0 && c.cz <= win.z1);
    const cols = new Int16Array(W * H).fill(-9999);   // 高度（-9999 = 未加载）
    const colNames = new Array(W * H).fill('');
    const colWater = new Uint8Array(W * H);
    let loaded = 0, usedHeightmap = 0, minH = 999, maxH = -999;
    const failed = [];
    for (const c of keep) {
      const fh = handles.get(c.f);
      if (!fh) continue;
      let data = null;
      try {
        const hdr = Buffer.alloc(5);
        const entry = Buffer.alloc(4);
        await fh.read(entry, 0, 4, c.idx * 4);
        const off = entry.readUIntBE(0, 3) * 4096;
        if (!off) continue;
        await fh.read(hdr, 0, 5, off);
        const len = hdr.readUInt32BE(0), comp = hdr.readUInt8(4);
        if (!len || len > 8 * 1024 * 1024) continue;
        const raw = Buffer.alloc(len);
        await fh.read(raw, 0, len, off + 5);
        data = comp === 1 ? zlib.gunzipSync(raw) : (comp === 2 ? zlib.inflateSync(raw) : raw);
      } catch (e) { failed.push(c.cx + ',' + c.cz); continue; }
      let chunk = null;
      try { chunk = nbtParse(data); } catch (_) { continue; }
      const hm = chunk.Heightmaps || (chunk.Level && chunk.Level.Heightmaps) || null;
      const hb = hm ? decodeHeightmap(hm.MOTION_BLOCKING) : null;
      const of = hm ? decodeHeightmap(hm.OCEAN_FLOOR) : null;
      const fallback = (!hb && !of) ? scanTopBlocksOf(chunk) : null;
      if (!hb && !of && !fallback) continue;
      usedHeightmap += (hb || of) ? 1 : 0;
      loaded++;
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const ci = z * 16 + x;
          const wx = c.cx * 16 + x - originX, wz = c.cz * 16 + z - originZ;
          if (wx < 0 || wz < 0 || wx >= W || wz >= H) continue;
          const gi = wz * W + wx;
          let h = -9999, water = false, nm = '';
          if (hb || of) {
            const hv = hb ? hb[ci] : of[ci];
            h = hv;
            /* MOTION_BLOCKING 含流体、OCEAN_FLOOR 不含 → 差值判水体 */
            water = !!(hb && of && hb[ci] > of[ci]);
            if (!hb) { water = false; }
          } else if (fallback && fallback.tops[ci] >= 0) {
            h = fallback.tops[ci]; nm = fallback.names[ci] || '';
            water = /water|ice/.test(nm);
          }
          if (h === -9999) continue;
          cols[gi] = h; colNames[gi] = nm; colWater[gi] = water ? 1 : 0;
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }
    }
    if (!loaded) return { ok: false, error: '区块数据解析失败（可能为不支持的存档格式）', failed: failed.length };
    /* 着色（高度归一化 + 西北向山体阴影） */
    const range = Math.max(8, maxH - minH);
    const rgba = Buffer.alloc(W * H * 4);
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const gi = z * W + x, o = gi * 4;
        if (cols[gi] === -9999) { rgba[o] = 18; rgba[o + 1] = 20; rgba[o + 2] = 26; rgba[o + 3] = 255; continue; }
        const hNorm = Math.max(0, Math.min(1, (cols[gi] - minH) / range));
        const hL = x > 0 && cols[gi - 1] !== -9999 ? cols[gi - 1] : cols[gi];
        const hU = z > 0 && cols[gi - W] !== -9999 ? cols[gi - W] : cols[gi];
        const shade = Math.max(0.55, Math.min(1.35, 1 + ((hL - cols[gi]) + (hU - cols[gi])) * 0.02));
        const c0 = columnColor(colNames[gi], colWater[gi], hNorm, shade);
        rgba[o] = c0[0]; rgba[o + 1] = c0[1]; rgba[o + 2] = c0[2]; rgba[o + 3] = 255;
      }
    }
    /* 生成点标记（红色十字）——仅在渲染主世界且生成点确实在主世界时绘制 */
    let spawnPx = null;
    const spawnIsHere = meta.spawn && (!meta.spawnDim || meta.spawnDim === 'minecraft:overworld') && cur.key === 'overworld';
    if (spawnIsHere) {
      const sx = meta.spawn.x - originX, sz = meta.spawn.z - originZ;
      if (sx >= 0 && sz >= 0 && sx < W && sz < H) {
        spawnPx = { x: sx, z: sz };
        const put = (px, pz, col) => {
          if (px < 0 || pz < 0 || px >= W || pz >= H) return;
          const o = (pz * W + px) * 4;
          rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
        };
        for (let d = -5; d <= 5; d++) { put(sx + d, sz, [232, 62, 62]); put(sx, sz + d, [232, 62, 62]); }
      }
    }
    const png = pngEncode(W, H, rgba);
    return {
      ok: true, w: W, h: H, png: 'data:image/png;base64,' + png.toString('base64'),
      chunksLoaded: loaded, chunksTotal: chunks.length, regions: files.length,
      bounds: { x0: originX, z0: originZ, x1: originX + W, z1: originZ + H },
      spawnPx, minH, maxH, usedHeightmap: usedHeightmap > 0,
      dim: cur.key, dimLabel: cur.label, dims, scannedAt,
      meta: Object.assign({}, meta, { size: await dirSize(saveDir, 0) })
    };
  } catch (e) { return { ok: false, error: e.message }; }
  finally {
    /* 所有路径（成功 / 提前 return / 异常）都在这里关句柄；close 失败不影响返回结果 */
    for (const fh of handles.values()) { try { await fh.close(); } catch (_) {} }
    handles.clear();
  }
});
/* 删除存档：只允许游戏目录内 saves/ 下、含 level.dat 的目录；走回收站可恢复 */
ipcMain.handle('saves:delete', async (_e, p) => {
  try {
    const dir = path.resolve(String((p && p.path) || ''));
    const gd = path.resolve(config.gameDir);
    const rel = path.relative(gd, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '拒绝操作：目标不在游戏目录内' };
    if (path.basename(path.dirname(dir)).toLowerCase() !== 'saves') return { ok: false, error: '拒绝操作：目标不是存档目录' };
    if (!fs.existsSync(path.join(dir, 'level.dat'))) return { ok: false, error: '该目录不是有效存档（缺少 level.dat）' };
    const name = path.basename(dir);
    try { await shell.trashItem(dir); }
    catch (e) { return { ok: false, error: '移入回收站失败: ' + e.message }; }
    logLine('[saves] 存档已移入回收站: ' + dir);
    toast('存档「' + name + '」已移入回收站（可从回收站还原）');
    return { ok: true, name };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ================================================================
 * 内置插件：存档备份（savebackup）
 * ================================================================
 * 用户要的两件事：① 存档详情里「打开目录」旁边多一个「备份存档」；
 *                 ② 插件设置里能开「自动备份」，默认备到 XLC数据。
 *
 * 几个刻意的选择：
 *   · 备份是**逐个文件流式**写 zip（src/zip-write.js），不是整包塞内存 —— 存档几十上百 MB，
 *     自动备份还要连着做好几个，攒内存会直接顶爆主进程。
 *   · 每个 zip 旁边放一份同名 .json（save / instance / at / 文件数 / 体积）：同名存档
 *     可能同时存在于全局 saves 和某个隔离实例里，恢复时必须知道它原来属于谁。
 *   · 恢复前先把「现在的存档」也备一份（tag=before-restore）——否则用户手滑点了恢复，
 *     刚玩的进度就没了，这个插件反而成了数据丢失的元凶。
 *   · 自动备份只在「存档目录比上次备份更新」时才动（SB_CORE.shouldBackup），
 *     不会每启动一次就多一份一模一样的包。
 * ================================================================ */
function backupRoot() {
  const c = SB_CORE.normalizeBackupCfg(config.backup);
  return c.dir ? path.resolve(c.dir) : path.join(DATA_DIR, '存档备份');
}
function backupDirOf(saveName) { return path.join(backupRoot(), SB_CORE.safeName(saveName)); }
/* 存档目录里最新的文件时间：level.dat / region 文件都会被算进去，比目录 mtime 准 */
async function dirNewestMtime(dir) {
  let max = 0;
  const walk = async (d) => {
    let names = [];
    try { names = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of names) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { await walk(p); continue; }
      try { const st = await fsp.stat(p); if (st.mtimeMs > max) max = st.mtimeMs; } catch (_) {}
    }
  };
  await walk(dir);
  return max;
}
/* 备份目录里最新的备份时间（没有备份 = 0） */
function newestBackupAt(saveName) {
  const dir = backupDirOf(saveName);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  let max = 0;
  for (const n of names) {
    const b = SB_CORE.parseBackupName(n);
    if (b && b.at > max) max = b.at;
  }
  return max;
}
function pruneBackupsOf(saveName) {
  const cfg = SB_CORE.normalizeBackupCfg(config.backup);
  const dir = backupDirOf(saveName);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  const items = [];
  for (const n of names) {
    const b = SB_CORE.parseBackupName(n);
    if (b) items.push({ file: n, at: b.at });
  }
  const del = SB_CORE.planPrune(items, cfg.keep);
  for (const d of del) {
    try { fs.unlinkSync(path.join(dir, d.file)); } catch (_) {}
    try { fs.unlinkSync(path.join(dir, d.file.replace(/\.zip$/, '.json'))); } catch (_) {}
  }
  return del.length;
}
/* 真做一次备份：调用方保证 save = { name, path, instance } */
async function doSaveBackup(save, tag) {
  let at = Date.now();
  const dir = backupDirOf(save.name);
  fs.mkdirSync(dir, { recursive: true });
  /* 文件名精确到「秒」：同一秒里连备两次（恢复前的兜底 vs 手动备份、连点两下）会撞名 → 后来的把前一份覆盖掉。
     撞了就往后挪一秒再试（最多 60 次），保证「每备一次就多一份」。 */
  let file = path.join(dir, SB_CORE.backupFileName(save.name, at));
  for (let i = 1; fs.existsSync(file) && i <= 60; i++) {
    at = Date.now() + i * 1000;
    file = path.join(dir, SB_CORE.backupFileName(save.name, at));
  }
  const r = ZIPW.zipDirToFile(save.path, file);
  const meta = { save: save.name, instance: save.instance || '', at, files: r.files, bytes: r.bytes, tag: tag || '' };
  try { fs.writeFileSync(file.replace(/\.zip$/, '.json'), JSON.stringify(meta, null, 1), 'utf8'); } catch (_) {}
  const pruned = pruneBackupsOf(save.name);
  logLine('[backup] 已备份存档「' + save.name + '」→ ' + file + '（' + r.files + ' 个文件 / ' + SB_CORE.humanBytes(r.bytes) + (tag ? ' / ' + tag : '') + '，清理旧备份 ' + pruned + ' 份）');
  return { ok: true, file, name: save.name, at, files: r.files, bytes: r.bytes, tag: tag || '', pruned };
}
/* 按名字 + 实例找存档（**不信任渲染层传来的路径**：只认扫描结果） */
async function findSaveByName(name, instance) {
  const want = String(name || '');
  const inst = String(instance || '');
  const list = await scanSaveDirs();
  return list.find(s => s.name === want && String(s.instance || '') === inst) || null;
}
/* 备份清单：扫备份根目录下每个存档子目录 */
function listSaveBackups() {
  const root = backupRoot();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      const b = SB_CORE.parseBackupName(n);
      if (!b) continue;
      const full = path.join(dir, n);
      let st = null, meta = null;
      try { st = fs.statSync(full); } catch (_) { continue; }
      try { meta = JSON.parse(fs.readFileSync(full.replace(/\.zip$/, '.json'), 'utf8')); } catch (_) {}
      out.push({
        save: (meta && meta.save) || b.save,
        instance: (meta && meta.instance) || '',
        at: (meta && meta.at) || b.at,
        file: full,
        name: n,
        bytes: (meta && meta.bytes) || st.size,
        files: (meta && meta.files) || 0,
        tag: (meta && meta.tag) || ''
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}
/* 自动备份：启动前 / 退出后各调一次。phase 决定要不要跑（用户在插件设置里能分别关掉） */
let AUTO_BAK_BUSY = false;
/* 退出后自动备份的 2.5 秒延迟定时器 —— 玩家关掉游戏后立刻关启动器的话，
   原来这个定时器会随进程一起消失，备份**根本不会开始**（审计 F2）。
   现在 before-quit 会把它提前触发并等它跑完（最多 3 秒）。 */
let EXIT_BAK_TIMER = null;
/* 任一自动备份在跑的 Promise：退出时用它判断「要不要等」 */
let BAK_INFLIGHT = null;
/* 已经为本次退出等过一次，避免 before-quit 重入时反复拦截 */
let QUIT_BAK_WAITED = false;
async function autoBackupSavesInner(phase, budgetMs) {
  const cfg = SB_CORE.normalizeBackupCfg(config.backup);
  if (!cfg.auto) return { ok: true, skipped: 'auto-off' };
  if (phase === 'launch' ? !cfg.onLaunch : !cfg.onExit) return { ok: true, skipped: 'phase-off' };
  if (AUTO_BAK_BUSY) return { ok: true, skipped: 'busy' };
  AUTO_BAK_BUSY = true;
  const t0 = Date.now();
  const done = [];
  try {
    const saves = await scanSaveDirs();
    for (const s of saves) {
      if (budgetMs && Date.now() - t0 > budgetMs) { logLine('[backup] 自动备份超出时间预算，剩下的下次再备'); break; }
      const mtime = await dirNewestMtime(s.path);
      if (!SB_CORE.shouldBackup({ lastAt: newestBackupAt(s.name), saveMtime: mtime })) continue;
      try { done.push(await doSaveBackup(s, 'auto-' + phase)); }
      catch (e) { logLine('[backup] 自动备份「' + s.name + '」失败: ' + e.message); }
    }
    if (done.length) send('backup:auto-done', { phase, items: done.map(d => ({ name: d.name, at: d.at, bytes: d.bytes })) });
  } finally { AUTO_BAK_BUSY = false; }
  return { ok: true, done };
}
/* 包一层只为了拿到「在跑的 Promise」给 before-quit 用（不改动内部逻辑） */
function autoBackupSaves(phase, budgetMs) {
  const p = autoBackupSavesInner(phase, budgetMs);
  BAK_INFLIGHT = p;
  return p.finally(() => { if (BAK_INFLIGHT === p) BAK_INFLIGHT = null; });
}
/* 游戏退出后调用：2.5 秒后再开始备份（等 region 文件 flush），并登记定时器供退出时接管 */
function scheduleExitBackup() {
  if (EXIT_BAK_TIMER || BAK_INFLIGHT) return;
  EXIT_BAK_TIMER = setTimeout(() => {
    EXIT_BAK_TIMER = null;
    autoBackupSaves('exit', 90000).catch(() => {});
  }, 2500);
}
ipcMain.handle('saves:backup', async (_e, p) => {
  try {
    const save = await findSaveByName(p && p.name, p && p.instance);
    if (!save) return { ok: false, error: '找不到这个存档（可能刚被移动或删除）' };
    return await doSaveBackup(save, (p && p.tag) || 'manual');
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('saves:backups', () => {
  try { return { ok: true, root: backupRoot(), items: listSaveBackups(), cfg: SB_CORE.normalizeBackupCfg(config.backup) }; }
  catch (e) { return { ok: false, error: e.message, items: [] }; }
});
ipcMain.handle('saves:backup-all', async () => {
  const t0 = Date.now();
  const done = [];
  try {
    for (const s of await scanSaveDirs()) {
      try { done.push(await doSaveBackup(s, 'manual-all')); }
      catch (e) { logLine('[backup] 备份「' + s.name + '」失败: ' + e.message); }
    }
    return { ok: true, items: done, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: e.message, items: done }; }
});
ipcMain.handle('saves:backup-dir', async () => {
  const root = backupRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  const r = await shell.openPath(root);
  return r ? { ok: false, error: r } : { ok: true, path: root };
});
/* 删一份备份（连同 sidecar）；只允许删备份目录里的文件 */
ipcMain.handle('saves:backup-delete', async (_e, p) => {
  try {
    const file = path.resolve(String((p && p.file) || ''));
    const rel = path.relative(path.resolve(backupRoot()), file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '拒绝操作：文件不在备份目录里' };
    if (!/\.zip$/i.test(file)) return { ok: false, error: '只允许删除备份文件' };
    await shell.trashItem(file);                                   /* 先扔回收站，删错了还能捞回来 */
    try { await shell.trashItem(file.replace(/\.zip$/, '.json')); } catch (_) {}
    logLine('[backup] 已删除备份: ' + file);
    return { ok: true, file };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('saves:restore', async (_e, p) => {
  try {
    /* 游戏还开着就覆盖存档目录 = 一边写一边删，轻则这次白存，重则整个档坏掉。
       备份可以边玩边做（最多是这次快照不太整齐），恢复必须先关游戏。 */
    if (GAME_PROC && GAME_PROC.exitCode === null) {
      return { ok: false, error: '游戏正在运行 —— 先退出游戏再恢复存档（边玩边覆盖会把档写坏）' };
    }
    const file = path.resolve(String((p && p.file) || ''));
    const root = path.resolve(backupRoot());
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '拒绝操作：备份文件不在备份目录里' };
    if (!fs.existsSync(file)) return { ok: false, error: '备份文件不存在（可能已被删除）' };
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(file.replace(/\.zip$/, '.json'), 'utf8')); } catch (_) {}
    const b = SB_CORE.parseBackupName(path.basename(file));
    const saveName = (meta && meta.save) || (b && b.save) || '';
    const instance = (meta && meta.instance) || '';
    if (!saveName) return { ok: false, error: '这个文件不像是本插件生成的备份' };
    const save = await findSaveByName(saveName, instance);
    if (!save) return { ok: false, error: '找不到存档「' + saveName + '」' + (instance ? '（实例 ' + instance + '）' : '') + '，请先确认它还在存档列表里' };
    /* 先把当前存档备一份：手滑点了恢复也能回来 */
    let safety = null;
    try { safety = await doSaveBackup(save, 'before-restore'); } catch (e) { logLine('[backup] 恢复前备份失败（继续恢复）: ' + e.message); }
    const r = ZIPW.extractZipTo(file, save.path);
    logLine('[backup] 已恢复存档「' + saveName + '」← ' + file + '（' + r.files + ' 个文件）');
    return { ok: true, name: saveName, instance, files: r.files, safety: safety ? safety.file : '' };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ================================================================
 * 内置插件：模组清单对齐（modalign）
 * ================================================================
 * 场景：朋友发你整合包 / 一起联机，进游戏崩了或提示缺少模组 —— 两边模组清单不一样。
 * 做法：把 mods 目录扫成一份「清单文本」（sha1 前 12 位 + 体积 + 文件名），
 *       走好友通道（MQTT 信令）直接发给对方，也可以在联机页复制/粘贴；
 *       收到后算差异：**少几个（要去下载）/ 多几个 / 同名但版本不同（要换文件）**。
 *
 * 哈希只取「前 4MB + 文件大小」：这是给「判断两边是不是同一个文件」用的标识，
 * 不是完整性校验 —— 整份 300MB 的整合包没必要为了清单全读一遍。
 * ================================================================ */
const MODALIGN_INBOX = [];      /* 最近收到的清单：{ from, name, text, at }，最多 5 条 / 30 分钟 */
function fileSig(p) {
  try {
    const st = fs.statSync(p);
    const fd = fs.openSync(p, 'r');
    const len = Math.min(st.size, 4 << 20);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return { size: st.size, sha1: crypto.createHash('sha1').update(buf).update(String(st.size)).digest('hex') };
  } catch (_) { return null; }
}
ipcMain.handle('mods:manifest', async (_e, p) => {
  try {
    const instance = String((p && p.instance) || '');
    const dir = modsDirFor(instance);
    let names = [];
    try { names = await fsp.readdir(dir); } catch (_) { return { ok: false, error: '这个实例还没有 mods 目录：' + dir }; }
    const list = [];
    for (const n of names) {
      if (!MA_CORE.isModFile(n)) continue;
      const abs = path.join(dir, n);
      const sig = fileSig(abs);
      if (sig) list.push({ name: n, size: sig.size, sha1: sig.sha1 });
    }
    const info = MA_CORE.normalizeModsInfo(list);
    return {
      ok: true, instance, dir, count: info.mods.length, total: info.total, truncated: info.truncated,
      text: MA_CORE.buildManifest(list), mods: info.mods
    };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mods:diff', (_e, p) => {
  try { return Object.assign({ ok: true }, MA_CORE.diffManifests(String((p && p.mine) || ''), String((p && p.theirs) || ''))); }
  catch (e) { return { ok: false, error: e.message, missing: [], extra: [], differ: [], same: 0 }; }
});
ipcMain.handle('modlist:inbox', () => {
  const now = Date.now();
  while (MODALIGN_INBOX.length && now - MODALIGN_INBOX[MODALIGN_INBOX.length - 1].at > 30 * 60 * 1000) MODALIGN_INBOX.pop();
  return { ok: true, items: MODALIGN_INBOX };
});
ipcMain.handle('modlist:clear', () => { MODALIGN_INBOX.length = 0; return { ok: true }; });
/* ---------------- 网络测速 ---------------- */
/* 只允许给「下载源」测速：渲染层被 XSS 时也不能拿这个通道去探内网端口。
   白名单 = 两个官方清单主机 + 用户在设置里填的自定义下载源主机。 */
const PING_ALLOW_HOSTS = new Set(['launchermeta.mojang.com', 'bmclapi2.bangbang93.com', 'bmclapi.bangbang93.com']);
function pingHostAllowed(u) {
  const h = String(u.hostname || '').toLowerCase();
  if (!h) return false;
  if (PING_ALLOW_HOSTS.has(h)) return true;
  try {
    const cs = new URL(String(config.customSource || ''));
    if (cs.hostname && cs.hostname.toLowerCase() === h) return true;
  } catch (_) {}
  return false;
}
ipcMain.handle('net:ping', async (_e, url) => {
  let u = null;
  try { u = new URL(String(url || '')); } catch (_) { return { ok: false, ms: -1, error: '测速地址无效' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, ms: -1, error: '只支持 http/https 测速' };
  if (!pingHostAllowed(u)) {
    logLine('[net] 已拒绝非白名单测速地址: ' + u.host);
    return { ok: false, ms: -1, error: '该主机不在测速白名单内（只允许官方源与自定义下载源）' };
  }
  const t0 = Date.now();
  const opt = { signal: AbortSignal.timeout(8000) };
  try {
    const res = await fetch(u.href, Object.assign({ method: 'HEAD' }, opt));
    return { ok: res.ok, ms: Date.now() - t0 };
  } catch (_) {
    try {
      const res2 = await fetch(u.href, opt);
      return { ok: res2.ok, ms: Date.now() - t0 };
    } catch (e2) { return { ok: false, ms: -1, error: e2.message }; }
  }
});

/* ================================================================
 * 插件系统（内置插件：种子地图 / 一键开服）
 * 插件为启动器内置能力模块，可在「插件」页启用或停用；
 * 启用状态持久化到 config.plugins（缺省视为启用）
 * ================================================================ */
const BUILTIN_PLUGINS = [
  { id: 'seedmap', name: '种子地图', ver: '1.0.1', tag: '工具' },
  { id: 'server', name: '一键开服', ver: '1.0.0', tag: '联机' },
  { id: 'gamepad', name: '手柄控制', ver: '1.0.0', tag: '操作' },
  { id: 'translator', name: '模组翻译器', ver: '1.0.0', tag: '工具' },
  /* 1.3 起：这两个内置插件的特别之处是「改宿主页面」——不是独立面板，
     而是往存档详情弹窗 / 联机页里插自己的按钮与卡片（见 renderer.js 的 UI_HOOKS） */
  { id: 'savebackup', name: '存档备份', ver: '1.0.0', tag: '存档' },
  { id: 'modalign', name: '模组清单对齐', ver: '1.0.0', tag: '联机' }
];
function pluginEnabled(id) {
  const m = config.plugins || {};
  return m[id] !== false; /* 缺省启用 */
}
function pluginsPublic() {
  const m = config.plugins || {};
  const out = {};
  for (const p of BUILTIN_PLUGINS) out[p.id] = m[p.id] !== false;
  /* 社区插件（拓展插件）：id 来自它自己的 plugin.json，缺省同样是启用 */
  for (const t of installedPlugins()) out[t.id] = m[t.id] !== false;
  return out;
}
ipcMain.handle('plugin:list', () => {
  /* 给每个社区插件的 session 分区预装联网闸门 + 登记 PLUGIN_SESSIONS：
     面板窗口是 openPluginPanel 现建现装，但插件页面的 <webview> 由渲染层直接用
     partition 属性创建 —— Chromium 会自己 fromPartition 出同一个 session，
     要赶在它创建之前把闸门装好，否则 guest 能自己发请求、宿主钩子也认不出它。 */
  for (const t of installedPlugins()) { try { pluginPanelSession(t.id); } catch (_) {} }
  return {
    ok: true, plugins: pluginsPublic(), third: installedPlugins(),
    /* 渲染层建插件页面的 <webview> 时要用：preload 桥的绝对路径（file:// 形式） */
    preloadUrl: pathToFileURL(path.join(ROOT, 'plugin-preload.js')).href
  };
});
ipcMain.handle('plugin:toggle', (_e, p) => {
  const id = String((p && p.id) || '');
  const known = BUILTIN_PLUGINS.some(x => x.id === id) || installedPlugins().some(x => x.id === id);
  if (!known) throw new Error('未知插件: ' + id);
  config.plugins = Object.assign({}, config.plugins, { [id]: !!(p && p.enabled) });
  saveConfigNow();
  /* 停用的插件不该还开着面板窗口 */
  if (!(p && p.enabled)) closePluginPanel(id, '插件被停用');
  return { ok: true, plugins: pluginsPublic(), third: installedPlugins() };
});

/* ================================================================
 * 拓展插件（社区插件）：ZIP 导入 · 独立面板窗口 · 权限白名单
 * ================================================================
 * 「怎么让网友做插件，又不泄露启动器源码」的答案（设计原则）：
 *   插件作者**不需要**、也**拿不到**启动器源码。插件只接触两样东西：
 *     ① 插件包里的 plugin.json —— 一份写死的字段清单（见 docs/plugin-api.md）
 *     ② 一组文档化的宿主接口 —— 面板窗口里用 window.xlcPlugin.call() 调，宿主按用户勾选的权限逐条放行
 *   插件怎么被加载、开关怎么存、包怎么解压，全在启动器这一侧，插件包里一个字节都不会出现。
 *   反过来插件也拿不到本机能力：面板是**独立窗口里的 file:// 顶层文档**，跟启动器窗口没有 DOM 关系
 *   （没有 parent、opener 也是 null），没有 Node，读不了游戏目录，也改不了启动器文件；
 *   它想要什么，只能走宿主白名单接口「求启动器代办」，用户还能在导入时逐条否掉权限。
 *
 * 插件包（zip）结构：
 *   plugin.json   必需   清单：id / name / version / author / description / entry / permissions / allowedHosts
 *   panel.html    可选   插件面板（entry 指向它）；可引同目录的 js / css / 图片
 *   icon.png      可选   插件卡片图标
 *   README.md     可选   说明文件（导入后可在插件目录里看到）
 * ================================================================ */
const PLUGIN_DIR = path.join(DATA_DIR, 'plugins');
/* 插件 id：小写字母开头，只含小写字母 / 数字 / - / _（避免与文件名、URL、内置插件打架） */
const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
/* 内置插件与保留字的 id 不许社区插件占用，否则插件页会出现两张同名卡片、开关互相打架 */
const RESERVED_PLUGIN_IDS = new Set(BUILTIN_PLUGINS.map(p => p.id).concat(['xlc', 'core', 'launcher', 'system', 'plugin', 'plugins']));
const PLUGIN_LIM = {
  zip: 8 << 20,      /* 包体上限 8MB：插件是界面 + 资源，正常远小于它 */
  entries: 600,      /* 条目数上限 */
  file: 2 << 20,     /* 单文件解压后上限 */
  total: 20 << 20,   /* 解压后总大小上限（防「小包炸大盘」的 zip 炸弹） */
  storage: 64 << 10, /* 插件私有存储上限 */
  http: 1 << 20      /* 插件单次 http 取回上限 */
};
/* 允许出现在插件包里的文件类型：只放「界面能用的静态资源」，不放 exe / dll / jar / bat */
const PLUGIN_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.mp3', '.ogg', '.wav']);
/* 权限清单：键是写进 plugin.json 的名字，值是导入确认弹窗里给用户看的人话 */
const PLUGIN_PERM_INFO = {
  notify: '在启动器里弹提示',
  storage: '在插件自己的目录里存一小份数据（上限 64 KB）',
  launcher: '读取启动器基础信息（版本号、游戏目录、下载源设置）',
  versions: '读取本机已安装的版本 / 实例列表',
  control: '读取并修改启动器的设置（下载源 / 内存 / Java / 主题 / 实例设置…），改了什么都会记进日志；' +
    '不允许把任何功能、窗口、公告或更新提示藏起来',
  openExternal: '用系统默认浏览器打开清单里声明的网站',
  http: '访问清单里声明的网站（只读 GET，取回内容交给插件）'
};
const PLUGIN_PERM_ALL = Object.keys(PLUGIN_PERM_INFO);
/* 高危权限：导入弹窗里单独标红，并把「能改到什么程度、不能改什么」讲在明面上。
   装插件时用户看到的措辞比文档更管用 —— 这一项必须让人一眼看出它比「读个版本号」重得多。 */
const PLUGIN_PERM_DANGER = new Set(['control']);
/* 面板文档的 CSP（安装时补进面板入口 HTML 的 <head>，见 injectPanelCsp）。
   面板是**独立窗口里的顶层 file:// 文档**：跟启动器窗口没有任何 DOM 关系，也拿不到 preload 之外的接口；
   这条 CSP 再加一层 —— 面板必须是自包含的静态资源：脚本 / 样式 / 字体只许来自它自己的包。
   资源源用 file: 这种 scheme 源而不是 'self'：语义上就是「本地文件」，不依赖 'self' 在 file:// 下的
   具体实现（实测两种都能加载同目录资源，见 qa/probe-csp-self.js），但 scheme 源更直白。
   connect-src 'none' 把 fetch / XHR / WebSocket 全部禁掉（连读它自己那份文件都读不了），
   联网取数据一律走宿主托管接口，这样「没申请 http 权限」的插件一个字节都发不出去。
   img-src 放行 https: 是有意留的：远端头像 / 图标是常见需求，而图片带不走它本来不知道的信息。
   frame-src / object-src / base-uri / form-action 一律关掉，防止面板套娃或偷偷提交表单。 */
const PLUGIN_PANEL_CSP = "default-src 'none'; script-src file: 'unsafe-inline'; style-src file: 'unsafe-inline'; " +
  "img-src file: data: https:; font-src file: data:; media-src file:; connect-src 'none'; " +
  "frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
/* 往面板入口 HTML 里补 CSP（面板是 file:// 文档，没有响应头可挂，只能写成 meta）。
   作者自己写的那条不删 —— 多条 CSP 取交集，只会更严不会更松。
   插入位置讲究：能塞进 <head> 就塞 <head>（规范要求），没有 head 就现造一个 ——
   绝不要把 <meta> 顶到 <!doctype> 前面，那会把整个文档推进怪异模式。 */
function injectPanelCsp(html) {
  const src = String(html || '');
  if (src.indexOf(PLUGIN_PANEL_CSP) >= 0) return src;   /* 已经是补过的（例如作者从安装目录里重新打包） */
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + PLUGIN_PANEL_CSP + '">';
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, m => m + meta);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, m => m + '<head>' + meta + '</head>');
  if (/^\s*<!doctype[^>]*>/i.test(src)) return src.replace(/^\s*<!doctype[^>]*>/i, m => m + '<head>' + meta + '</head>');
  return '<head>' + meta + '</head>' + src;
}

/* ================================================================
 * control 权限：插件读写启动器设置 —— 「能改的都让改，不能藏的绝不许藏」
 * ================================================================
 * 之前插件只能「看」：版本号、实例列表。想让它真正有用，就得让它能改设置 ——
 * 但「改设置」这件事有两个天然的红线，这里直接写死在代码里，而不是靠文档劝：
 *
 *   ① **不能藏东西**。任何会让「功能入口 / 窗口 / 公告 / 更新提示从用户眼前消失」的改动
 *      一律拒绝，并把原因用人话回给插件（见 PLUGIN_CFG_NEVER 与各 spec 的 only / why）。
 *      用户装了插件之后，启动器该有的东西必须一件不少地留在原地 ——
 *      否则卸载插件之前，用户根本不知道自己的启动器被改成了什么样。
 *   ② **改动必须可见**。每一次写入都会：落日志（哪一项、从什么改成什么）、
 *      实时通知启动器界面刷新、并由界面弹一条「插件 X 改动了设置」的提示。
 *      没有「悄悄改一下」这条路。
 *
 * 除这两条之外的都开放：下载源、游戏目录、Java、内存、JVM / 游戏参数、窗口、隔离、优先级、
 * 限速、主题色、背景、手柄、实例级设置（窗口标题 / Java）…… 作者用 config.schema 就能拿到
 * 全部可写项的类型与范围（含被禁项的拒绝原因），照着画一个设置界面即可。
 * ================================================================ */
/* 宿主接口的版本号：接口只增不改，但作者可以用它判断「这个启动器支不支持某项能力」
   （1 = 最初的 notify/storage/launcher/versions/openExternal/http；2 = 增加 control 读写设置） */
const PLUGIN_API_VERSION = 2;
/* 永远不开放给插件的键：不是「技术上做不到」，而是「一旦放开就等于把东西藏起来了」。
   这张表先于 PLUGIN_CFG_SPEC 判定 —— 就算以后有人往 spec 里加错了，这里仍然拦得住。 */
const PLUGIN_CFG_NEVER = new Map([
  ['plugins', '插件开关决定哪些功能出现在插件页上 —— 插件不能把别的功能关掉，也不能给自己偷偷开一项'],
  ['pluginPerms', '权限只能由用户在导入时逐条勾选，插件不能给自己加权限'],
  ['seenVersion', '它决定更新公告还弹不弹 —— 插件不能把公告藏起来'],
  ['updateUrl', '更新源锁定为官方地址，改它等于让用户收不到更新'],
  ['ignoredVersion', '它会永远吞掉某个版本的更新提示'],
  ['accounts', '账户与登录凭据由启动器自己维护，插件改它会让登录态错乱'],
  ['activeAccount', '当前账户由账户页维护，插件改它会让登录态错乱'],
  ['friendCode', '好友码生成后终身不变，由启动器维护'],
  ['friends', '好友关系由启动器维护'],
  ['recent', '「最近游玩」由启动器在游戏启动后自动记录']
]);
/* 设置项规格表。type 决定怎么校验；writable:false / only 决定「不许改」，
   并在 config.schema 里如实告诉作者为什么 —— 让作者一眼看到边界，比让他试错强。 */
const PLUGIN_CFG_SPEC = {
  /* ---- 下载 ---- */
  source: { group: '下载', label: '下载源', type: 'enum', values: ['bmclapi', 'official', 'custom'] },
  customSource: { group: '下载', label: '自定义下载源地址', type: 'str', max: 300 },
  dlThreads: { group: '下载', label: '下载线程数', type: 'int', min: 1, max: 64 },
  dlConcurrency: { group: '下载', label: '文件并发数（同时下载几个文件，4~64）', type: 'int', min: 4, max: 64 },
  speedLimit: { group: '下载', label: '下载限速（KB/s，0 = 不限）', type: 'int', min: 0, max: 1048576 },
  /* ---- 目录与 Java ---- */
  gameDir: { group: '目录', label: '游戏目录', type: 'path', kind: 'dir' },
  javaPath: { group: 'Java', label: 'Java 可执行文件（空 = 按版本自动挑）', type: 'path', kind: 'file', empty: true },
  /* ---- 性能 ---- */
  mem: { group: '性能', label: '内存上限（GB）', type: 'int', min: 1, max: 64 },
  memAuto: { group: '性能', label: '智能内存分配', type: 'bool' },
  jvmArgs: { group: '性能', label: 'JVM 参数', type: 'str', max: 2000 },
  /* ---- 启动 ---- */
  gameArgs: { group: '启动', label: '游戏参数', type: 'str', max: 2000 },
  preLaunchCmd: { group: '启动', label: '启动前命令', type: 'str', max: 2000 },
  winTitle: { group: '启动', label: '游戏窗口标题', type: 'str', max: 200 },
  winSize: {
    group: '启动', label: '游戏窗口大小', type: 'obj',
    fields: { w: { type: 'int', min: 0, max: 16384, label: '宽（0 = 不指定）' }, h: { type: 'int', min: 0, max: 16384, label: '高（0 = 不指定）' }, max: { type: 'bool', label: '启动即最大化' } }
  },
  forceIsolate: { group: '启动', label: '版本隔离', type: 'enum', values: ['auto', 'on', 'off'] },
  procPriority: { group: '启动', label: '游戏进程优先级', type: 'enum', values: ['normal', 'abovenormal', 'high', 'below'] },
  /* hide 不在可选值里：藏窗口是老版本坑过用户的默认值，插件更不许这么干 */
  launcherVisibility: {
    group: '启动', label: '启动后启动器可见性', type: 'enum', values: ['keep', 'min'],
    hideText: '不允许把启动器窗口藏起来 —— 启动游戏后窗口消失会让用户以为启动器崩了；只能设 keep（保持）或 min（最小化）'
  },
  gpuPref: { group: '启动', label: '优先使用独立显卡', type: 'bool' },
  forceChinese: { group: '启动', label: '启动前强制简体中文', type: 'bool' },
  /* ---- 实例 ---- */
  defaultVersion: { group: '实例', label: '默认启动的实例', type: 'instance', empty: true },
  lastVersion: { group: '实例', label: '主页上次选中的实例', type: 'instance', empty: true },
  versionSettings: { group: '实例', label: '实例级设置（窗口标题 / Java）', type: 'versionSettings' },
  /* ---- 外观 ---- */
  bgMode: { group: '外观', label: '背景模式', type: 'enum', values: ['default', 'panorama', 'image'] },
  bgColor: { group: '外观', label: '背景色（空 = 跟随主题）', type: 'color' },
  accentColor: { group: '外观', label: '强调色（空 = 默认绿）', type: 'color' },
  bgImage: { group: '外观', label: '背景图文件名', type: 'str', max: 200 },
  /* ---- 插件 / 诊断 ---- */
  gamepad: {
    group: '插件', label: '手柄控制设置', type: 'obj',
    fields: {
      enabled: { type: 'bool', label: '手柄导航总开关' },
      deadzone: { type: 'num', min: 0.05, max: 0.9, label: '摇杆死区' },
      speed: { type: 'enum', values: ['slow', 'normal', 'fast'], label: '方向重复速率' },
      vibrate: { type: 'bool', label: '震动反馈' },
      osd: { type: 'bool', label: '按键提示浮层' },
      cursor: { type: 'bool', label: '左摇杆当鼠标' },
      cursorSpeed: { type: 'num', min: 0.2, max: 4, label: '光标速度' },
      hideMouse: { type: 'bool', label: '手柄操作时隐藏鼠标指针' }
    }
  },
  aiApi: {
    group: '诊断', label: '诊断 AI 接口', type: 'obj',
    fields: { base: { type: 'str', max: 300, label: '接口地址' }, model: { type: 'str', max: 80, label: '模型名' } }
  },
  /* ---- 只能朝一个方向改的两项（改成另一头等于把提示关掉） ---- */
  autoCheckUpdate: {
    group: '更新', label: '自动检查更新', type: 'bool', only: true,
    why: '关掉它启动器就不再提示新版本 —— 等于把更新提醒藏起来，插件只能确保它开着'
  },
  skipPreviewUpdate: {
    group: '更新', label: '跳过快照版更新', type: 'bool', only: false,
    why: '打开它会吞掉快照 / 预发布版的更新提示 —— 插件只能确保它关着'
  },
  /* ---- 明文列出来但只能读：作者在 schema 里能看到「为什么」 ---- */
  seenVersion: { group: '更新', label: '已读公告的版本', type: 'blocked', why: PLUGIN_CFG_NEVER.get('seenVersion') },
  plugins: { group: '插件', label: '插件开关', type: 'blocked', why: PLUGIN_CFG_NEVER.get('plugins') },
  pluginPerms: { group: '插件', label: '插件授权记录', type: 'blocked', why: PLUGIN_CFG_NEVER.get('pluginPerms') },
  accounts: { group: '账户', label: '账户列表（含凭据）', type: 'blocked', why: PLUGIN_CFG_NEVER.get('accounts') },
  activeAccount: { group: '账户', label: '当前账户', type: 'blocked', why: PLUGIN_CFG_NEVER.get('activeAccount') }
};
/* 实例级设置（config.versionSettings[实例]）能改的字段 */
const PLUGIN_CFG_VS_FIELDS = {
  title: { type: 'str', max: 200, label: '窗口标题' },
  javaPath: { type: 'path', kind: 'file', empty: true, label: 'Java 路径' },
  javaMajor: { type: 'int', min: 1, max: 99, label: 'Java 主版本' }
};
/* 读设置时也不给的东西：凭据与私密数据一律不出宿主（写更是早就禁了） */
const PLUGIN_CFG_SECRET = new Set(['accounts', 'friends', 'friendCode', 'msClientId', 'pluginPerms']);
function pluginCfgSpecPublic(key) {
  const s = PLUGIN_CFG_SPEC[key];
  const out = { key, label: s.label, group: s.group, type: s.type };
  if (s.type === 'blocked' || s.writable === false) { out.writable = false; out.why = s.why || ''; return out; }
  if (s.type === 'bool') {
    if (s.only !== undefined) { out.writable = true; out.only = s.only; out.why = s.why || ''; }
    else out.writable = true;
  } else out.writable = true;
  if (s.type === 'int' || s.type === 'num') { out.min = s.min; out.max = s.max; }
  if (s.type === 'str' || s.type === 'color' || s.type === 'path') out.max = s.max || (s.type === 'path' ? 260 : 2000);
  if (s.type === 'path') { out.kind = s.kind; out.empty = !!s.empty; }
  if (s.type === 'enum') { out.values = s.values.slice(); if (s.hideText) out.why = s.hideText; }
  if (s.type === 'instance') out.empty = !!s.empty;
  if (s.type === 'obj') {
    out.fields = Object.keys(s.fields || {}).map(f => Object.assign({ key: f, label: s.fields[f].label || f }, (() => {
      const fs = s.fields[f], o = { type: fs.type };
      if (fs.type === 'int' || fs.type === 'num') { o.min = fs.min; o.max = fs.max; }
      if (fs.type === 'enum') o.values = fs.values.slice();
      return o;
    })()));
  }
  if (s.type === 'versionSettings') {
    out.fields = Object.keys(PLUGIN_CFG_VS_FIELDS).map(f => Object.assign({ key: f, label: PLUGIN_CFG_VS_FIELDS[f].label || f, type: PLUGIN_CFG_VS_FIELDS[f].type }));
  }
  return out;
}
function pluginCfgSchema() {
  return Object.keys(PLUGIN_CFG_SPEC).map(pluginCfgSpecPublic);
}
/* 本机已安装的实例 id（用来校验 defaultVersion / versionSettings 指向的实例是否存在） */
function pluginInstanceIds() {
  const out = [];
  const vDir = path.join(config.gameDir, 'versions');
  try {
    for (const sub of fs.readdirSync(vDir)) {
      if (fs.existsSync(path.join(vDir, sub, sub + '.json'))) out.push(sub);
    }
  } catch (_) {}
  return out;
}
/* 单值校验：类型不对 / 超范围 / 越界一律抛错，错误信息里带上「这项是什么、能取什么」
   这样作者在 DevTools 里看一条报错就知道怎么改，不用翻文档 */
function pluginCfgCoerce(spec, raw, label) {
  const t = spec.type;
  if (t === 'bool') {
    if (typeof raw !== 'boolean') throw new Error(label + ' 需要 true / false（收到 ' + JSON.stringify(raw) + '）');
    if (spec.only !== undefined && raw !== spec.only) {
      throw new Error(label + ' 只能设成 ' + (spec.only ? 'true' : 'false') + '：' + (spec.why || '这一项只能朝这个方向改'));
    }
    return raw;
  }
  if (t === 'int' || t === 'num') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(label + ' 需要数字（收到 ' + JSON.stringify(raw) + '）');
    if (t === 'int' && !Number.isInteger(n)) throw new Error(label + ' 需要整数（收到 ' + n + '）');
    if (n < spec.min || n > spec.max) throw new Error(label + ' 需要在 ' + spec.min + ' ~ ' + spec.max + ' 之间（收到 ' + n + '）');
    return n;
  }
  if (t === 'str' || t === 'color') {
    const s = String(raw == null ? '' : raw);
    if (s.length > (spec.max || 2000)) throw new Error(label + ' 太长（上限 ' + (spec.max || 2000) + ' 字符）');
    if (t === 'color' && s && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) {
      throw new Error(label + ' 需要 #RGB / #RRGGBB 形式的颜色值（收到 ' + s + '）');
    }
    return s;
  }
  if (t === 'enum') {
    const s = String(raw == null ? '' : raw);
    if (!spec.values.includes(s)) {
      throw new Error(label + ' 只能是 ' + spec.values.join(' / ') + '（收到 ' + s + '）' +
        (s === 'hide' && spec.hideText ? '：' + spec.hideText : ''));
    }
    return s;
  }
  if (t === 'instance') {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) {
      if (spec.empty) return '';
      throw new Error(label + ' 不能为空');
    }
    const ids = pluginInstanceIds();
    if (!ids.includes(s)) {
      throw new Error(label + ' 指向的实例不存在：' + s + '（本机有：' + (ids.slice(0, 12).join('、') || '（没有已安装的实例）') + '）');
    }
    return s;
  }
  if (t === 'path') {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) {
      if (spec.empty) return '';
      throw new Error(label + ' 不能为空');
    }
    const abs = path.resolve(s);
    if (!fs.existsSync(abs)) throw new Error(label + ' 指向的路径不存在：' + abs);
    let st = null;
    try { st = fs.statSync(abs); } catch (_) {}
    if (spec.kind === 'dir' && !(st && st.isDirectory())) throw new Error(label + ' 需要是一个目录：' + abs);
    if (spec.kind === 'file' && !(st && st.isFile())) throw new Error(label + ' 需要是一个文件：' + abs);
    return abs;
  }
  throw new Error(label + ' 这一项暂不支持写入（type=' + t + '）');
}
/* 把「键路径 + 值」规划成一条待执行的写入（只校验、不改 config）。
   支持三种路径写法：
 *   'mem'                                 → 普通项
 *   'gamepad.deadzone' / 'aiApi.model'    → 对象里的字段
 *   'versionSettings.<实例>.title'         → 某个实例的实例级设置
 */
function pluginCfgPlan(pathStr, raw) {
  const p = String(pathStr == null ? '' : pathStr).trim();
  if (!p) throw new Error('设置项名称不能为空');
  const segs = p.split('.').map(s => s.trim());
  const root = segs[0];
  if (PLUGIN_CFG_NEVER.has(root)) throw new Error('「' + root + '」不允许插件修改：' + PLUGIN_CFG_NEVER.get(root));
  const spec = PLUGIN_CFG_SPEC[root];
  if (!spec) throw new Error('没有这个设置项：' + root + '（可用：' + Object.keys(PLUGIN_CFG_SPEC).join('、') + '）');
  const label = spec.label || root;
  if (spec.type === 'blocked' || spec.writable === false) throw new Error('「' + label + '」不允许插件修改：' + (spec.why || ''));
  if (spec.type === 'versionSettings') {
    const inst = segs[1], field = segs[2];
    if (!inst) throw new Error('实例级设置要写全：「versionSettings.<实例名>.<字段>」，字段可用 ' + Object.keys(PLUGIN_CFG_VS_FIELDS).join(' / '));
    const ids = pluginInstanceIds();
    if (!ids.includes(inst)) throw new Error('本机没有这个实例：' + inst + '（实例级设置只能改已安装实例的）');
    if (!field) {
      const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
      if (!obj) throw new Error('要给 versionSettings.' + inst + ' 一个对象，或写全 versionSettings.' + inst + '.<字段>');
      const merged = {};
      for (const k of Object.keys(obj)) {
        const f = PLUGIN_CFG_VS_FIELDS[k];
        if (!f) throw new Error('实例级设置里没有「' + k + '」这一项（可用：' + Object.keys(PLUGIN_CFG_VS_FIELDS).join('、') + '）');
        merged[k] = pluginCfgCoerce(f, obj[k], '实例「' + inst + '」的 ' + (f.label || k));
      }
      return { path: 'versionSettings.' + inst, root, label: '实例「' + inst + '」的设置', mode: 'vsMerge', inst, value: merged };
    }
    const f = PLUGIN_CFG_VS_FIELDS[field];
    if (!f) throw new Error('实例级设置里没有「' + field + '」这一项（可用：' + Object.keys(PLUGIN_CFG_VS_FIELDS).join('、') + '）');
    return {
      path: 'versionSettings.' + inst + '.' + field, root, label: '实例「' + inst + '」的 ' + (f.label || field),
      mode: 'vsField', inst, field, value: pluginCfgCoerce(f, raw, '实例「' + inst + '」的 ' + (f.label || field))
    };
  }
  if (spec.type === 'obj') {
    const fields = spec.fields || {};
    if (segs.length === 1) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(label + ' 需要一个对象，例如 { ' + Object.keys(fields)[0] + ': … }；也可以只改一项：' + root + '.' + Object.keys(fields)[0]);
      }
      const patch = {};
      for (const k of Object.keys(raw)) {
        if (!fields[k]) throw new Error(label + ' 里没有「' + k + '」这一项（可用：' + Object.keys(fields).join('、') + '）');
        patch[k] = pluginCfgCoerce(fields[k], raw[k], label + ' · ' + (fields[k].label || k));
      }
      return { path: root, root, label, mode: 'merge', value: patch };
    }
    const f = segs[1], fs = fields[f];
    if (!fs) throw new Error(label + ' 里没有「' + f + '」这一项（可用：' + Object.keys(fields).join('、') + '）');
    return {
      path: root + '.' + f, root, label: label + ' · ' + (fs.label || f), mode: 'field', field: f,
      value: pluginCfgCoerce(fs, raw, label + ' · ' + (fs.label || f))
    };
  }
  if (segs.length > 1) throw new Error(label + ' 是一整项，不能再往下拆（写成「' + root + '」即可）');
  return { path: root, root, label, mode: 'set', value: pluginCfgCoerce(spec, raw, label) };
}
/* 真正落到 config 上（规划阶段已经全部校验过，这里只赋值，保证批量写不会写一半） */
function pluginCfgApply(plan) {
  const prev = (() => {
    try {
      if (plan.mode === 'vsMerge' || plan.mode === 'vsField') return ((config.versionSettings || {})[plan.inst] || {});
      if (plan.mode === 'merge') return config[plan.root] || {};
      if (plan.mode === 'field') return config[plan.root] || {};
      return config[plan.root];
    } catch (_) { return undefined; }
  })();
  if (plan.mode === 'vsMerge' || plan.mode === 'vsField') {
    const vs = Object.assign({}, config.versionSettings);
    const cur = Object.assign({}, vs[plan.inst] || {});
    if (plan.mode === 'vsMerge') Object.assign(cur, plan.value);
    else cur[plan.field] = plan.value;
    vs[plan.inst] = cur;
    config.versionSettings = vs;
  } else if (plan.mode === 'merge') {
    config[plan.root] = Object.assign({}, config[plan.root] || {}, plan.value);
  } else if (plan.mode === 'field') {
    config[plan.root] = Object.assign({}, config[plan.root] || {}, { [plan.field]: plan.value });
  } else {
    config[plan.root] = plan.value;
  }
  return prev;
}
/* 给插件看的当前设置：凭据类整项不出宿主，AI 密钥打码（作者能看出「配了没有」，但拿不到值） */
function pluginCfgPublic() {
  const out = {};
  for (const k of Object.keys(config)) {
    if (PLUGIN_CFG_SECRET.has(k)) continue;
    if (k === 'aiApi') {
      const a = config.aiApi || {};
      out.aiApi = { base: a.base || '', model: a.model || 'gpt-4o-mini', key: a.key ? '***已配置***' : '' };
      continue;
    }
    out[k] = config[k];
  }
  out.appVersion = APP_VERSION;
  out.apiVersion = PLUGIN_API_VERSION;
  return out;
}
/* 按点路径读（'gamepad.deadzone' / 'versionSettings.实例.title'），不传就返回整份（已脱敏） */
function pluginCfgRead(pathStr) {
  const p = String(pathStr == null ? '' : pathStr).trim();
  if (!p) return pluginCfgPublic();
  const segs = p.split('.').map(s => s.trim());
  const root = segs[0];
  if (PLUGIN_CFG_SECRET.has(root) || (root === 'aiApi' && segs[1] === 'key')) {
    throw new Error('「' + p + '」属于账户 / 凭据数据，不向插件开放读取');
  }
  if (!(root in config)) throw new Error('没有这个设置项：' + root);
  let cur = root === 'aiApi' ? pluginCfgPublic().aiApi : config[root];
  for (let i = 1; i < segs.length; i++) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[segs[i]];
  }
  return cur === undefined ? null : cur;
}
/* 最近几次「插件改设置」的通知（保留 20 条）。
   一是给排查用：用户说「我的设置莫名其妙变了」，日志里能看到是谁改的；
   二是给自测用：去改 win.webContents.send 这种 Electron 原生方法不可靠，
   但「有没有通知界面」这件事必须能验 —— 记一份同样的 payload，自测就查它。 */
const PLUGIN_CFG_PUSH = [];
function pluginCfgNotifyUi(id, t, changed) {
  const payload = { id, name: t.name, keys: changed.map(c => c.key), labels: changed.map(c => c.label) };
  PLUGIN_CFG_PUSH.push(Object.assign({ at: Date.now() }, payload));
  while (PLUGIN_CFG_PUSH.length > 20) PLUGIN_CFG_PUSH.shift();
  try {
    if (win && !win.isDestroyed()) win.webContents.send('plugin:cfg-changed', payload);
  } catch (e) {
    logLine('[plugin] 通知界面刷新设置失败: ' + ((e && e.message) || e));
  }
  return payload;
}
/* 一次写入的完整流程：全部校验 → 全部落盘 → 记日志 → 通知界面。
   校验与写分离，是为了「批量里有一项不合法就整批不写」，不留半套配置。 */
function pluginCfgWrite(id, t, items) {
  if (!pluginRate(id, 'cfg', 0, 120)) throw new Error('改设置太频繁了（每分钟最多 120 次）');
  const keys = Object.keys(items);
  if (!keys.length) throw new Error('没有要改的项');
  if (keys.length > 20) throw new Error('一次最多改 20 项（收到 ' + keys.length + ' 项）');
  const plans = keys.map(k => pluginCfgPlan(k, items[k]));   /* 先全部校验：任何一项不合法都整批不写 */
  const changed = [];
  for (const pl of plans) {
    const before = pluginCfgApply(pl);
    changed.push({ key: pl.path, label: pl.label, from: before, to: pl.value });
  }
  saveConfigNow();
  /* 改动必须可见：日志留痕（哪一项、改成什么），界面上再弹一条提示 */
  const brief = changed.map(c => c.label + ' → ' + (typeof c.to === 'object' ? JSON.stringify(c.to) : String(c.to))).join('；');
  logLine('[plugin] ' + id + ' 修改启动器设置：' + brief);
  pluginCfgNotifyUi(id, t, changed);
  return { changed, keys: changed.map(c => c.key), labels: changed.map(c => c.label) };
}

let PLUGIN_CACHE = null;
function invalidatePlugins() { PLUGIN_CACHE = null; }
/* 用户**实际**授权给某个社区插件的权限：导入确认弹窗里勾选的结果。
   与「清单里声明了什么」分开存 —— 声明是插件要求，授权是用户给的，宿主按后者放行。 */
function grantedPluginPerms(id) {
  const m = config.pluginPerms || {};
  const arr = m[id];
  return Array.isArray(arr) ? arr.filter(k => PLUGIN_PERM_ALL.includes(k)) : [];
}
function pluginDir(id) {
  const s = String(id || '');
  if (!PLUGIN_ID_RE.test(s) || s.length > 32) return '';
  const root = path.resolve(PLUGIN_DIR);
  const dir = path.resolve(root, s);
  if (!dir.startsWith(root + path.sep)) return '';
  return dir;
}
function pluginNameOf(id) {
  const t = installedPlugins().find(p => p.id === id);
  const b = BUILTIN_PLUGINS.find(p => p.id === id);
  return (t && t.name) || (b && b.name) || id;
}
/* 已安装的社区插件（读磁盘清单，带内存缓存；安装 / 卸载后 invalidatePlugins） */
function installedPlugins() {
  if (PLUGIN_CACHE) return PLUGIN_CACHE;
  const out = [];
  let subs = [];
  try { subs = fs.readdirSync(PLUGIN_DIR); } catch (_) { subs = []; }
  for (const sub of subs) {
    if (!PLUGIN_ID_RE.test(sub) || RESERVED_PLUGIN_IDS.has(sub)) continue;
    const dir = pluginDir(sub);
    if (!dir) continue;
    let man = null;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      man = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    } catch (_) { continue; }   /* 目录坏了 / 清单读不出来 → 当没装（不炸整个插件页） */
    const m = normalizePluginManifest(man);
    if (!m || m.id !== sub) continue;
    out.push(Object.assign({}, m, {
      dir,
      builtin: false,
      enabled: pluginEnabled(sub),
      granted: grantedPluginPerms(sub),
      /* 卡片图标直接用文件路径（图标是给启动器页面自己贴的图，不走面板那条路）。
         面板不给地址：面板是独立窗口，由 openPluginPanel() 现建现开。 */
      iconUrl: m.icon ? pathToFileURL(path.join(dir, m.icon)).href : '',
      /* 插件页面（可选）：包根目录有 page.html 就给启动器侧栏多一项。
         侧栏名字用清单 pageTitle（没写用插件名）；入口图标固定取 Images/Logo.png，没有就落空（渲染层给默认图） */
      hasPage: fs.existsSync(path.join(dir, 'page.html')),
      pageUrl: (function () {
        try { const p = path.join(dir, 'page.html'); return fs.existsSync(p) ? pathToFileURL(p).href : ''; } catch (_) { return ''; }
      })(),
      pageIconUrl: (function () {
        try { const p = path.join(dir, 'Images', 'Logo.png'); return fs.existsSync(p) ? pathToFileURL(p).href : ''; } catch (_) { return ''; }
      })()
    }));
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  PLUGIN_CACHE = out;
  return out;
}
/* 清单归一化 + 校验（导入与读取磁盘共用一份规则，避免「导入宽松、读取严格」两边不一致） */
function normalizePluginManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  const id = str(raw.id, 32);
  if (!PLUGIN_ID_RE.test(id) || RESERVED_PLUGIN_IDS.has(id)) return null;
  const name = str(raw.name, 24);
  if (!name) return null;
  const version = str(raw.version, 16) || '1.0.0';
  if (!/^\d+(\.\d+){0,3}$/.test(version)) return null;
  let entry = str(raw.entry, 120).replace(/^\/+/, '');
  if (entry && !/\.html?$/i.test(entry)) return null;   /* 面板必须是 html */
  let icon = str(raw.icon, 120).replace(/^\/+/, '');
  if (icon && !/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(icon)) icon = '';
  const perms = [];
  for (const p of (Array.isArray(raw.permissions) ? raw.permissions : [])) {
    const k = str(p, 24).toLowerCase();
    if (PLUGIN_PERM_ALL.includes(k) && !perms.includes(k)) perms.push(k);
  }
  const hosts = [];
  for (const h of (Array.isArray(raw.allowedHosts) ? raw.allowedHosts : [])) {
    const k = str(h, 80).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(k) && !hosts.includes(k)) hosts.push(k);
    if (hosts.length >= 20) break;
  }
  /* 声明了要联网 / 外链，却没写 allowedHosts → 这类权限等于空转，直接摘掉，免得用户以为它被授权了 */
  const kept = perms.filter(p => (p !== 'http' && p !== 'openExternal') || hosts.length);
  return {
    id, name, version, permissions: kept, allowedHosts: hosts,
    author: str(raw.author, 32), description: str(raw.description, 120),
    homepage: /^https:\/\//i.test(str(raw.homepage, 200)) ? str(raw.homepage, 200) : '',
    /* 插件页面的侧栏名字（可选）：只有包里带了 page.html 才生效，见 installedPlugins 的 hasPage */
    pageTitle: str(raw.pageTitle, 24),
    entry, icon
  };
}
/* 包内相对路径是否安全：挡 zip-slip、绝对路径、盘符、Windows 保留名与非法字符 */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function safeEntryName(raw) {
  const s = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.length > 160) return '';
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('//')) return '';
  const norm = path.posix.normalize(s);
  if (!norm || norm === '.' || norm.startsWith('../') || norm.includes('/../') || norm.endsWith('/..')) return '';
  if (/[\u0000-\u001f<>:"|?*]/.test(norm)) return '';
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.' || seg === '..' || WIN_RESERVED_RE.test(seg) || /[ .]$/.test(seg)) return '';
  }
  return norm;
}
/* 解析并校验一个插件包（纯函数：只看内存里的条目，不落盘 —— 便于离线自测） */
function validatePluginPackage(buf) {
  if (!buf || buf.length < 22) throw new Error('插件包为空，或不是有效的 ZIP 文件');
  if (buf.length > PLUGIN_LIM.zip) throw new Error('插件包太大（上限 ' + (PLUGIN_LIM.zip >> 20) + ' MB）');
  let raw = [];
  try { raw = findZipEntries(buf, () => true); } catch (e) { throw new Error('无法读取插件包：' + e.message); }
  if (!raw.length) throw new Error('插件包里没有任何文件（是不是把文件夹本身压进去了？请把 plugin.json 放在压缩包根目录）');
  if (raw.length > PLUGIN_LIM.entries) throw new Error('插件包文件太多（上限 ' + PLUGIN_LIM.entries + ' 个）');
  const files = [];
  let total = 0;
  for (const it of raw) {
    const name = safeEntryName(it.name);
    if (!name) throw new Error('插件包里有非法路径：' + String(it.name).slice(0, 80));
    const ext = path.extname(name).toLowerCase();
    if (!PLUGIN_EXT.has(ext)) throw new Error('插件包里不允许放这种文件：' + name);
    if (it.data.length > PLUGIN_LIM.file) throw new Error('单个文件过大：' + name);
    total += it.data.length;
    if (total > PLUGIN_LIM.total) throw new Error('解压后体积超过上限（' + (PLUGIN_LIM.total >> 20) + ' MB）');
    files.push({ name, data: it.data });
  }
  const manFile = files.find(f => f.name === 'plugin.json');
  if (!manFile) throw new Error('插件包里缺少 plugin.json（插件清单）');
  let rawMan = null;
  try { rawMan = JSON.parse(manFile.data.toString('utf8')); }
  catch (_) { throw new Error('plugin.json 不是合法的 JSON（注意别带注释、别用中文引号）'); }
  const man = normalizePluginManifest(rawMan);
  if (!man) throw new Error('plugin.json 内容不合法：id 需为小写字母/数字/-/_ 开头字母、name 不能为空、version 需形如 1.0.0、entry 必须是 .html');
  if (man.entry && !files.some(f => f.name === man.entry)) throw new Error('清单里的面板文件不存在：' + man.entry);
  if (man.icon && !files.some(f => f.name === man.icon)) man.icon = '';
  /* 插件页面（可选）：固定叫 page.html、放包根目录 —— 有它侧栏才会多一项，没有就是纯设置型插件 */
  const hasPage = files.some(f => f.name === 'page.html');
  return { manifest: man, files, hasPanel: !!man.entry, hasPage };
}
/* 落盘安装（覆盖安装 = 升级，保留启用状态）：先解到临时目录，再整体换名，失败能回滚 */
function installPluginPackage(buf, expectId) {
  const v = validatePluginPackage(buf);
  const id = v.manifest.id;
  if (expectId && expectId !== id) throw new Error('插件包与刚才确认的不是同一个，请重新选择文件');
  const dir = pluginDir(id);
  if (!dir) throw new Error('插件 id 不合法或与内置插件冲突');
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const tmp = path.join(PLUGIN_DIR, '.' + id + '.installing');
  const bak = path.join(PLUGIN_DIR, '.' + id + '.backup');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bak, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const f of v.files) {
      const dest = path.resolve(tmp, f.name.split('/').join(path.sep));
      if (!dest.startsWith(path.resolve(tmp) + path.sep)) continue;   /* 双保险：写之前再校一次 */
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
    }
    /* 面板入口补一条 CSP：面板从此只能加载自己包里的资源，联网必须走托管接口。
       作者自己写的 CSP 留着不删（多条取交集，只会更严），这里只负责「没有也得有」。 */
    if (v.manifest.entry) {
      try {
        const abs = path.resolve(tmp, v.manifest.entry.split('/').join(path.sep));
        const raw = fs.readFileSync(abs, 'utf8');
        const next = injectPanelCsp(raw);
        if (next !== raw) fs.writeFileSync(abs, next);
      } catch (_) { /* 读不出来就算了：面板照常装，宿主那侧照样按权限放行 */ }
    }
    /* 插件页面（page.html）与面板同一套 CSP：只许加载自己包里的静态资源，联网走托管接口 */
    if (v.hasPage) {
      try {
        const abs = path.resolve(tmp, 'page.html');
        const raw = fs.readFileSync(abs, 'utf8');
        const next = injectPanelCsp(raw);
        if (next !== raw) fs.writeFileSync(abs, next);
      } catch (_) {}
    }
    const existed = fs.existsSync(dir);
    if (existed) fs.renameSync(dir, bak);
    try { fs.renameSync(tmp, dir); }
    catch (e) { if (existed && fs.existsSync(bak)) fs.renameSync(bak, dir); throw e; }
    fs.rmSync(bak, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  invalidatePlugins();
  return installedPlugins().find(p => p.id === id) || null;
}
/* 卸载：删目录 + 清掉开关状态（只动插件自己的目录；文件进回收站太麻烦，这里直接删） */
function removePluginPackage(id) {
  const dir = pluginDir(id);
  if (!dir) throw new Error('插件 id 不合法');
  if (!installedPlugins().some(p => p.id === id)) throw new Error('没有装过这个插件：' + id);
  /* 面板还开着的话先把窗口关掉：Windows 下面板页面对自己的文件持有句柄，不关窗口删不干净 */
  closePluginPanel(id, '插件被移除');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  if (config.plugins && Object.prototype.hasOwnProperty.call(config.plugins, id)) {
    delete config.plugins[id];
  }
  if (config.pluginPerms && Object.prototype.hasOwnProperty.call(config.pluginPerms, id)) {
    delete config.pluginPerms[id];
  }
  saveConfigNow();
  invalidatePlugins();
  return { ok: true, third: installedPlugins(), plugins: pluginsPublic() };
}

/* ---------------- 面板窗口：社区插件的面板 = 独立窗口里的顶层文档 ----------------
 * 隔离由「窗口 + 进程」本身保证（文件顶部记了三条路的实测结论）：面板与启动器窗口之间没有任何 DOM 关系，
 * 也没有 node / preload 之外的接口；它想要什么能力，只能通过 plugin-preload.js 挂出来的那一个 call()
 * 求启动器代办 —— 主进程按「导入时用户勾选的权限」逐条放行。另外两条硬护栏：
 *   ① 面板窗口用自己的 session 分区，并把分区里所有 http(s) / ws 请求整个砍掉（要联网只能走托管接口）；
 *   ② 面板入口 HTML 在安装时被注入一条 CSP（injectPanelCsp），连 fetch 本地文件都被禁掉。 */
const PLUGIN_WIN_BY_ID = new Map();   /* 插件 id → BrowserWindow（同一个插件只开一个面板窗口） */
const PLUGIN_WIN_INFO = new Map();    /* webContents.id → { id, theme }（IPC 靠它认「是哪个面板在说话」） */
function pluginWinInfoOf(sender) {
  if (!sender || sender.isDestroyed()) return null;
  return PLUGIN_WIN_INFO.get(sender.id) || null;
}
function closePluginPanel(id, why) {
  const w = PLUGIN_WIN_BY_ID.get(id);
  PLUGIN_WIN_BY_ID.delete(id);
  if (!w) return false;
  try { PLUGIN_WIN_INFO.delete(w.webContents.id); } catch (_) {}
  try { if (!w.isDestroyed()) w.destroy(); } catch (_) {}   /* 用 destroy：跟登录窗口一个做法，干脆利落 */
  if (why) logLine('[plugin] 关闭插件面板 ' + id + '（' + why + '）');
  return true;
}
/* 面板分区的联网闸门：http(s) / ws 一律拒绝（面板自己发不出任何请求，只能求宿主代办） */
const PLUGIN_SESSIONS = new Map();   /* 'persist:xlc-plugin-<id>' → session（插件页面的 webview 靠它认主） */
function pluginPanelSession(id) {
  const ses = session.fromPartition('persist:xlc-plugin-' + id);
  if (ses.__xlcNoNet) { PLUGIN_SESSIONS.set('persist:xlc-plugin-' + id, ses); return ses; }
  ses.__xlcNoNet = true;
  try {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
  } catch (e) { logLine('[plugin] 面板联网限制设置失败: ' + ((e && e.message) || e)); }
  PLUGIN_SESSIONS.set('persist:xlc-plugin-' + id, ses);
  return ses;
}
/* 打开（已在开着就聚焦）插件面板窗口 */
function openPluginPanel(id, theme) {
  const t = installedPlugins().find(x => x.id === id);
  if (!t) return { ok: false, error: '插件不存在' };
  if (!pluginEnabled(id)) return { ok: false, error: '插件已停用，请先在列表里启用' };
  if (!t.entry) return { ok: false, error: '这个插件没有界面（它只提供后台能力）' };
  const abs = path.join(t.dir, t.entry.split('/').join(path.sep));
  if (!fs.existsSync(abs)) return { ok: false, error: '面板文件不存在：' + t.entry };
  const old = PLUGIN_WIN_BY_ID.get(id);
  if (old && !old.isDestroyed()) { try { old.show(); old.focus(); } catch (_) {} return { ok: true, focused: true }; }
  let w = null;
  try {
    pluginPanelSession(id);   /* 先把分区的联网闸门装上，再创建窗口 */
    w = new BrowserWindow({
      width: 940, height: 660, minWidth: 700, minHeight: 440,
      title: t.name + ' · 插件面板',
      backgroundColor: '#0b0d11', autoHideMenuBar: true, show: false,
      parent: (win && !win.isDestroyed()) ? win : undefined,   /* 挂在启动器窗口下：跟着一起关、不会被压在后面 */
      webPreferences: {
        preload: path.join(ROOT, 'plugin-preload.js'),
        /* sandbox 必须 false：实测（软件渲染 + in-process-gpu 的环境）sandbox:true 的渲染进程
           加载任何页面都以 ERR_FAILED(-2) 收场 —— 启动器的其它窗口同样都是 sandbox:false。
           面板的隔离不靠它：没有 nodeIntegration，页面拿不到 Node；preload 只挂出桥；
           又是独立窗口（没有 parent / opener），摸不到启动器窗口。 */
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        partition: 'persist:xlc-plugin-' + id, spellcheck: false
      }
    });
  } catch (e) { return { ok: false, error: '面板窗口创建失败：' + ((e && e.message) || e) }; }
  PLUGIN_WIN_BY_ID.set(id, w);
  PLUGIN_WIN_INFO.set(w.webContents.id, { id, theme: theme === 'light' ? 'light' : 'dark' });
  const wc = w.webContents;
  const entryUrl = pathToFileURL(abs).href;
  const dirPrefix = path.resolve(t.dir) + path.sep;
  const inPanelDir = (u) => {
    try { return path.resolve(fileURLToPath(u)).startsWith(dirPrefix); } catch (_) { return false; }
  };
  /* 面板窗口只许在自己那堆文件里转；外链不给它跳（真要开浏览器得声明 openExternal 权限走托管接口） */
  wc.on('will-navigate', (e, u) => {
    if (u === entryUrl || inPanelDir(u)) return;
    e.preventDefault();
    toast('「' + t.name + '」想打开外部地址，已拦下：' + String(u).slice(0, 60), 'warn');
  });
  wc.setWindowOpenHandler(({ url }) => {
    toast('「' + t.name + '」想开新窗口，已拦下：' + String(url).slice(0, 60), 'warn');
    return { action: 'deny' };
  });
  wc.on('render-process-gone', (_e, d) => {
    logLine('[plugin] 面板进程退出 ' + id + ' · reason=' + ((d && d.reason) || '?'));
    closePluginPanel(id);
  });
  w.once('ready-to-show', () => { if (!HEADLESS && !w.isDestroyed()) w.show(); });
  w.on('closed', () => {
    try { PLUGIN_WIN_INFO.delete(w.webContents.id); } catch (_) {}
    if (PLUGIN_WIN_BY_ID.get(id) === w) PLUGIN_WIN_BY_ID.delete(id);
  });
  w.loadURL(entryUrl).catch((e) => {
    toast('「' + t.name + '」面板加载失败：' + ((e && e.message) || e), 'error');
    closePluginPanel(id);
  });
  logLine('[plugin] 打开插件面板 ' + id + '（' + t.entry + '）');
  return { ok: true, name: t.name, version: t.version, perms: t.permissions, theme: theme === 'light' ? 'light' : 'dark' };
}
/* 面板窗口 → 启动器：唯一入口。用 sender 判断「是哪个插件在说话」（不让面板自报家门，避免冒名顶替） */
ipcMain.handle('plugin:win-info', (e) => {
  const info = pluginWinInfoOf(e.sender);
  if (!info) return { ok: false, error: '这个窗口不是插件面板' };
  const t = installedPlugins().find(p => p.id === info.id);
  if (!t) return { ok: false, error: '插件已被移除' };
  return {
    ok: true, id: t.id, name: t.name, version: t.version, author: t.author, theme: info.theme || 'dark',
    apiVersion: PLUGIN_API_VERSION,
    granted: t.granted, grantedLabels: t.granted.map(k => PLUGIN_PERM_INFO[k] || k)
  };
});
ipcMain.handle('plugin:win-call', async (e, p) => {
  const info = pluginWinInfoOf(e.sender);
  if (!info) return { ok: false, error: '未识别的调用来源' };
  const o = p || {};
  return pluginCallApi(info.id, String(o.method || ''), o.params);
});

/* ---------------- 插件页面：主窗口内容区里的 <webview> 宿主 ----------------
 * 插件包根目录带 page.html 时，侧栏多一项，点击在主窗口里切换（不开新窗口）。
 * guest 与主文档进程隔离（webview 天性），宿主再补四道护栏：
 *   ① 只认「分区属于某个已启用插件」的 webview，冒名分区一律不管（不登记 = 桥用不了）；
 *   ② 导航只许在插件自己目录内；新窗口 / 外链一律拒；
 *   ③ 分区沿用面板的联网闸门（pluginPanelSession，http/ws 全砍）；
 *   ④ 页面 HTML 安装时注入与面板同一条 CSP（见 installPluginPackage）。
 * 出入口与面板完全一致：plugin-preload.js 的 window.xlcPlugin，主进程按 sender 判插件。 */
app.on('web-contents-created', (_e, wc) => {
  try {
    if (!wc || wc.getType() !== 'webview') return;
    let pid = null;
    for (const [part, ses] of PLUGIN_SESSIONS) {
      if (ses && wc.session === ses) { pid = part.slice('persist:xlc-plugin-'.length); break; }
    }
    if (!pid) return;                       /* 不是插件分区（比如 seedmap 的 webview 类需求）→ 不归这套管 */
    const t = installedPlugins().find(x => x.id === pid);
    if (!t || !t.enabled || !t.hasPage) return;   /* 已停用 / 卸载 / 没页面的插件 → 不登记，桥就是死的 */
    PLUGIN_WIN_INFO.set(wc.id, { id: pid, theme: 'dark' });   /* 主题由渲染层在创建后用 plugin:page-theme 修正 */
    const dirPrefix = path.resolve(t.dir) + path.sep;
    const inPluginDir = (u) => {
      try { return path.resolve(fileURLToPath(u)).startsWith(dirPrefix); } catch (_) { return false; }
    };
    wc.on('will-navigate', (ev, u) => {
      if (inPluginDir(u)) return;
      ev.preventDefault();
      toast('「' + t.name + '」页面想打开外部地址，已拦下：' + String(u).slice(0, 60), 'warn');
    });
    wc.setWindowOpenHandler(({ url }) => {
      toast('「' + t.name + '」页面想开新窗口，已拦下：' + String(url).slice(0, 60), 'warn');
      return { action: 'deny' };
    });
    wc.on('render-process-gone', (_e2, d) => {
      logLine('[plugin] 页面进程退出 ' + pid + ' · reason=' + ((d && d.reason) || '?'));
    });
    wc.once('destroyed', () => { PLUGIN_WIN_INFO.delete(wc.id); });
    logLine('[plugin] 插件页面已挂载 ' + pid + '（page.html）');
  } catch (_) { /* 钩子绝不能炸主进程 */ }
});
/* 渲染层把启动器当前主题同步给插件页面（面板是每次打开传一次，页面常驻所以要可更新） */
ipcMain.handle('plugin:page-theme', (_e, p) => {
  try {
    const id = String((p && p.id) || '');
    const theme = (p && p.theme) === 'light' ? 'light' : 'dark';
    let n = 0;
    for (const [, info] of PLUGIN_WIN_INFO) { if (info.id === id) { info.theme = theme; n++; } }
    return { ok: true, updated: n };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

/* ---------------- 导入流程：选包 → 校验 → 展示申请权限 → 用户确认后才落盘 ----------------
 * pick 只把包读进内存并返回清单（不写任何文件），install 才真正解压 ——
 * 用户点了「取消」就什么都没发生。token 用一次性随机串，防止渲染层拿任意路径当插件包装。 */
let PLUGIN_PICK = null;   /* { token, path, id, at } */
ipcMain.handle('plugin:import-pick', async () => {
  try {
    const r = await dialog.showOpenDialog({ title: '选择插件包（.zip）', filters: [{ name: 'XLC 插件包', extensions: ['zip', 'xlcplugin'] }, { name: '全部文件', extensions: ['*'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const fp = r.filePaths[0];
    const st = await fsp.stat(fp);
    if (st.size > PLUGIN_LIM.zip) return { ok: false, error: '插件包太大（上限 ' + (PLUGIN_LIM.zip >> 20) + ' MB）' };
    const buf = await fsp.readFile(fp);
    const v = validatePluginPackage(buf);
    const installed = installedPlugins().find(p => p.id === v.manifest.id);
    PLUGIN_PICK = { token: crypto.randomBytes(12).toString('hex'), path: fp, id: v.manifest.id, at: Date.now() };
    return {
      ok: true,
      token: PLUGIN_PICK.token,
      zipName: path.basename(fp),
      /* update=true：本机已装同 id → 界面换成「升级」措辞 */
      update: !!installed,
      fromVersion: installed ? installed.version : '',
      manifest: {
        id: v.manifest.id, name: v.manifest.name, version: v.manifest.version,
        author: v.manifest.author, description: v.manifest.description,
        homepage: v.manifest.homepage, hasPanel: v.hasPanel, icon: v.manifest.icon
      },
      permissions: v.manifest.permissions.map(k => ({ key: k, label: PLUGIN_PERM_INFO[k] || k, danger: PLUGIN_PERM_DANGER.has(k) })),
      hosts: v.manifest.allowedHosts
    };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('plugin:import-install', async (_e, p) => {
  const o = p || {};
  try {
    if (!PLUGIN_PICK || o.token !== PLUGIN_PICK.token) return { ok: false, error: '导入已过期，请重新选择插件包' };
    if (Date.now() - PLUGIN_PICK.at > 10 * 60 * 1000) { PLUGIN_PICK = null; return { ok: false, error: '导入已过期，请重新选择插件包' }; }
    const fp = PLUGIN_PICK.path;
    const buf = await fsp.readFile(fp);
    const info = installPluginPackage(buf, o.id || PLUGIN_PICK.id);
    PLUGIN_PICK = null;
    if (!info) return { ok: false, error: '安装失败：清单校验未通过' };
    /* 用户勾选的权限 = 真正放行的权限（清单里没声明的即便勾了也不给） */
    const granted = (Array.isArray(o.perms) ? o.perms : [])
      .map(k => String(k).toLowerCase())
      .filter(k => PLUGIN_PERM_ALL.includes(k) && info.permissions.includes(k));
    config.pluginPerms = Object.assign({}, config.pluginPerms, { [info.id]: granted });
    saveConfigNow();
    invalidatePlugins();
    logLine('[plugin] 已导入社区插件 ' + info.id + ' v' + info.version + '（' + path.basename(fp) + '）· 授权 ' + (granted.join(',') || '无'));
    return { ok: true, plugin: installedPlugins().find(x => x.id === info.id) || info, third: installedPlugins(), plugins: pluginsPublic() };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('plugin:remove', (_e, p) => {
  try {
    const id = String((p && p.id) || '');
    const name = pluginNameOf(id);
    const r = removePluginPackage(id);
    logLine('[plugin] 已移除社区插件 ' + id);
    return Object.assign({ ok: true, name }, r);
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('plugin:open-dir', async (_e, p) => {
  try {
    const dir = pluginDir(String((p && p.id) || ''));
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: '插件目录不存在' };
    await shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('plugin:panel-open', (_e, p) => {
  try { return openPluginPanel(String((p && p.id) || ''), (p && p.theme) || 'dark'); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

/* ---------------- 面板窗口 → 宿主白名单接口（按「导入时用户勾选的权限」放行） ----------------
 * 面板里这样调用：
 *   const r = await window.xlcPlugin.call('http.get', { url: 'https://api.example.com/x' });
 * 宿主只认这份白名单；没申请 / 没勾选的权限一律拒绝，拒绝原因会回给插件（便于作者调试）。 */
const PLUGIN_RATE = {};   /* { '<id>:<bucket>': [上次时间, 计数窗口起点, 窗口内次数] } */
function pluginRate(id, bucket, minGapMs, maxPerMin) {
  const key = id + ':' + bucket;
  const now = Date.now();
  const r = PLUGIN_RATE[key] || (PLUGIN_RATE[key] = { last: 0, win: now, n: 0 });
  if (minGapMs && now - r.last < minGapMs) return false;
  if (now - r.win > 60000) { r.win = now; r.n = 0; }
  if (maxPerMin && r.n >= maxPerMin) return false;
  r.last = now; r.n++;
  return true;
}
/* 插件的私有存储：藏在插件目录里的点文件（面板服务不供出隐藏文件，
   所以插件自己 fetch 不到它 —— 想读写得走被授权的 storage 接口） */
function pluginStorageFile(id) {
  const dir = pluginDir(id);
  if (!dir) throw new Error('插件 id 不合法');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, '.xlc-data.json');
}
function pluginStorageRead(id) {
  try { return JSON.parse(fs.readFileSync(pluginStorageFile(id), 'utf8')) || {}; } catch (_) { return {}; }
}
/* 白名单接口的实现在这里；对外统一出口是下面的 pluginApiCall（把异常变成「拒绝 + 原因」） */
function pluginApiDispatch(id, method, params) {
  const t = installedPlugins().find(p => p.id === id);
  if (!t) return { ok: false, error: '插件不存在：' + id };
  if (!pluginEnabled(id)) return { ok: false, error: '插件已停用' };
  const has = k => t.granted.includes(k) ||
    /* control 是「读写设置」的总权限：有了它，读启动器信息与实例列表自然也该有
       （否则改完设置没法确认结果，作者只能瞎猜） */
    (t.granted.includes('control') && (k === 'launcher' || k === 'versions'));
  const p = params && typeof params === 'object' ? params : {};
  const needPerm = (k) => {
    if (has(k)) return;
    const declared = t.permissions.includes(k);
    throw new Error('「' + (PLUGIN_PERM_INFO[k] ? k : k) + '」权限未授权' +
      (declared ? '（插件清单里申请了，但导入时没有勾选它，可重新导入并允许）' : '（插件清单里没有声明这项权限）'));
  };
  switch (String(method || '')) {
    case 'notify': {
      needPerm('notify');
      if (!pluginRate(id, 'notify', 600)) throw new Error('提示太频繁了，请慢一点');
      const text = String(p.text == null ? '' : p.text).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) throw new Error('notify 需要 text');
      toast('「' + t.name + '」 ' + text, p.kind === 'warn' ? 'warn' : p.kind === 'error' ? 'error' : 'ok');
      return { ok: true, data: true };
    }
    case 'storage.get': {
      needPerm('storage');
      const s = pluginStorageRead(id);
      const k = String(p.key || '');
      return { ok: true, data: s[k] === undefined ? null : s[k] };
    }
    case 'storage.set': {
      needPerm('storage');
      const k = String(p.key || '').slice(0, 64);
      if (!k) throw new Error('storage.set 需要 key');
      const s = pluginStorageRead(id);
      s[k] = p.value === undefined ? null : p.value;
      const buf = Buffer.from(JSON.stringify(s), 'utf8');
      if (buf.length > PLUGIN_LIM.storage) throw new Error('插件数据超过上限（' + (PLUGIN_LIM.storage >> 10) + ' KB），请清理后再存');
      fs.writeFileSync(pluginStorageFile(id), buf);
      return { ok: true, data: buf.length };
    }
    case 'storage.remove': {
      needPerm('storage');
      const s = pluginStorageRead(id);
      delete s[String(p.key || '')];
      fs.writeFileSync(pluginStorageFile(id), Buffer.from(JSON.stringify(s), 'utf8'));
      return { ok: true, data: true };
    }
    case 'launcher.info': {
      needPerm('launcher');
      return { ok: true, data: { version: APP_VERSION, gameDir: config.gameDir, source: config.source, theme: config.theme || 'dark' } };
    }
    case 'versions.list': {
      needPerm('versions');
      const vDir = path.join(config.gameDir, 'versions');
      const out = [];
      try {
        for (const sub of fs.readdirSync(vDir)) {
          try {
            const json = JSON.parse(fs.readFileSync(path.join(vDir, sub, sub + '.json'), 'utf8'));
            out.push({ id: json.id || sub, loader: detectLoaderOf(json), inherits: !!json.inheritsFrom });
          } catch (_) {}
        }
      } catch (_) {}
      return { ok: true, data: out.slice(0, 200) };
    }
    case 'openExternal': {
      needPerm('openExternal');
      const u = String(p.url || '').trim();
      if (!/^https:\/\//i.test(u)) throw new Error('只允许打开 https:// 链接');
      let host = '';
      try { host = new URL(u).hostname.toLowerCase(); } catch (_) { throw new Error('链接无效'); }
      if (!t.allowedHosts.some(h => host === h || host.endsWith('.' + h))) throw new Error('该网站不在插件清单声明的 allowedHosts 里：' + host);
      if (!pluginRate(id, 'open', 2000)) throw new Error('打开链接太频繁了');
      shell.openExternal(u);
      return { ok: true, data: true };
    }
    case 'http.get': {
      needPerm('http');
      if (!pluginRate(id, 'http', 0, 30)) throw new Error('请求太频繁（每分钟上限 30 次）');
      const u = String(p.url || '').trim();
      if (!/^https:\/\//i.test(u)) throw new Error('只允许 https:// 地址');
      let host = '';
      try { host = new URL(u).hostname.toLowerCase(); } catch (_) { throw new Error('地址无效'); }
      if (!t.allowedHosts.some(h => host === h || host.endsWith('.' + h))) throw new Error('该网站不在插件清单声明的 allowedHosts 里：' + host);
      return { pending: true, host };
    }
    case 'config.schema': {
      needPerm('control');
      return {
        ok: true,
        data: {
          apiVersion: PLUGIN_API_VERSION,
          appVersion: APP_VERSION,
          items: pluginCfgSchema(),
          /* 这一份是「永远不给」的清单：连写都别写，直接拒绝（见 PLUGIN_CFG_NEVER） */
          never: Array.from(PLUGIN_CFG_NEVER, ([key, why]) => ({ key, why }))
        }
      };
    }
    case 'config.get': {
      needPerm('control');
      return { ok: true, data: pluginCfgRead(p.key) };
    }
    case 'config.set': {
      needPerm('control');
      let items = null;
      if (p.items && typeof p.items === 'object' && !Array.isArray(p.items)) items = p.items;
      else if (p.key !== undefined) items = { [String(p.key)]: p.value };
      if (!items) throw new Error('config.set 需要 { key, value } 或 { items: { 设置项: 值 } }');
      return { ok: true, data: pluginCfgWrite(id, t, items) };
    }
    case 'config.reset': {
      needPerm('control');
      const key = String(p.key || '').trim();
      if (!key) throw new Error('config.reset 需要 key');
      const segs = key.split('.').map(s => s.trim());
      const root = segs[0];
      if (PLUGIN_CFG_NEVER.has(root)) throw new Error('「' + root + '」不允许插件修改：' + PLUGIN_CFG_NEVER.get(root));
      if (!(root in DEFAULT_CONFIG)) throw new Error('没有这个设置项：' + root);
      /* 实例级设置：只回收指定实例，不许一把清空（那等于替用户做了个看不见的决定） */
      if (root === 'versionSettings') {
        const inst = segs[1];
        if (!inst) throw new Error('要指定实例：config.reset { key: "versionSettings.<实例名>" }');
        const vs = Object.assign({}, config.versionSettings);
        if (!vs[inst]) return { ok: true, data: { changed: [], keys: [], labels: [] } };
        delete vs[inst];
        config.versionSettings = vs;
        saveConfigNow();
        logLine('[plugin] ' + id + ' 恢复了实例「' + inst + '」的实例级设置');
        pluginCfgNotifyUi(id, t, [{ key: 'versionSettings.' + inst, label: '实例「' + inst + '」的设置' }]);
        return { ok: true, data: { changed: [], keys: ['versionSettings.' + inst], labels: ['实例「' + inst + '」的设置'] } };
      }
      let def = DEFAULT_CONFIG[root];
      if (def === undefined) throw new Error('「' + root + '」没有默认值可恢复');
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        /* 对象项只取 spec 里认识的字段（默认值里可能带凭据类字段，那些不该被写回去） */
        const fields = (PLUGIN_CFG_SPEC[root] && PLUGIN_CFG_SPEC[root].fields) || {};
        const picked = {};
        for (const k of Object.keys(fields)) if (def[k] !== undefined) picked[k] = def[k];
        def = picked;
      }
      return { ok: true, data: pluginCfgWrite(id, t, { [root]: def }) };
    }
    default:
      return { ok: false, error: '未开放的接口：' + method + '（可用：' + PLUGIN_API_LIST.join('、') + '）' };
  }
}
const PLUGIN_API_LIST = ['notify', 'storage.get', 'storage.set', 'storage.remove', 'launcher.info', 'versions.list',
  'config.schema', 'config.get', 'config.set', 'config.reset', 'openExternal', 'http.get'];
/* 对外统一出口：权限不足 / 参数不合法 / 配额超限一律变成「拒绝 + 原因」回给插件，
   而不是抛异常 —— 面板那边等的是一个 {ok:false, error}，好让作者能直接看到被拒的原因 */
function pluginApiCall(id, method, params) {
  try { return pluginApiDispatch(id, method, params); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}/* http.get 是异步的（要真联网），单独一层，避免把上面那个同步 switch 变成 async 影响其它接口的返回值形状 */
async function pluginCallApi(id, method, params) {
  const t = installedPlugins().find(p => p.id === id);
  if (!t) return { ok: false, error: '插件不存在：' + id };
  try {
    const r = pluginApiCall(id, method, params);
    if (r && r.pending) {
      const u = String((params && params.url) || '');
      const buf = await fetchBufT(u, 15000);
      if (buf.length > PLUGIN_LIM.http) throw new Error('返回内容过大（上限 ' + (PLUGIN_LIM.http >> 20) + ' MB）');
      return { ok: true, data: { status: 200, text: buf.toString('utf8').slice(0, 400000) } };
    }
    return r;
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}


/* 面板窗口 + 桥的端到端自测（就地真开一个窗口，窗口在自测环境下不显示）。
   社区插件最核心的一条路就是它 —— 面板能不能开起来，开起来之后是不是**只能**拿到该给它的东西：
   · 文档加载（file:// 顶层，跟启动器窗口之间没有 DOM 关系）
   · 经 preload 桥写 storage（面板 → preload → 主进程）
   · 没勾选的权限被拒，且原因回到面板
   · 面板自己发的网络请求出不去（CSP connect-src 'none' + 分区里砍掉 http(s)） */
async function pluginBridgeSelfTest(id) {
  const lines = [];
  let fail = 0;
  const ok = (cond, label, extra) => {
    lines.push((cond ? 'PASS' : 'FAIL') + ' ' + label + (extra ? ' · ' + extra : ''));
    if (!cond) fail++;
  };
  const r = openPluginPanel(id, 'dark');
  ok(!!r && r.ok, 'C15 打开插件面板窗口', r ? (r.error || r.name) : '没有返回');
  const w = PLUGIN_WIN_BY_ID.get(id);
  if (!w) { ok(false, 'C15b 面板窗口已登记', '窗口没建起来，后面的用例无从谈起'); return { lines, fail }; }
  const wc = w.webContents;
  /* 用轮询等文档加载完：面板是 file://，可能在我们挂监听之前就加载完了（只挂事件会白等） */
  const t0 = Date.now();
  let loaded = 'TIMEOUT';
  while (Date.now() - t0 < 15000) {
    if (wc.isDestroyed()) { loaded = 'DESTROYED'; break; }
    if (!wc.isLoading() && wc.getURL()) { loaded = true; break; }
    await new Promise(res => setTimeout(res, 250));
  }
  ok(loaded === true, 'C15b 面板顶层文档加载完成', loaded === true ? 'ok' : String(loaded));
  const js = (code) => wc.executeJavaScript(code, true).catch(e => 'ERR ' + ((e && e.message) || e));
  const see = await js('(function(){ return { bridge: typeof window.xlcPlugin, lmc: typeof window.lmc, ' +
    'root: window.parent === window, opener: String(window.opener), node: typeof process }; })()');
  const s = (see && typeof see === 'object') ? see : {};
  ok(s.bridge === 'object' && s.lmc === 'undefined' && s.root === true && s.opener === 'null' && s.node === 'undefined',
    'C15c 面板只拿得到桥：没有启动器接口 / 没有 parent / 没有 opener / 没有 Node',
    'bridge=' + s.bridge + ' lmc=' + s.lmc + ' parent=self:' + s.root + ' opener=' + s.opener + ' process=' + s.node);
  const wrote = await js('window.xlcPlugin.call("storage.set", { key: "fromPanel", value: "ok" }).then(r => r.ok ? "ok" : "ERR " + r.error)');
  const got = pluginApiDispatch(id, 'storage.get', { key: 'fromPanel' });
  ok(wrote === 'ok' && !!got && got.ok && got.data === 'ok',
    'C15d 面板经桥写 storage 并落盘（面板 → preload → 主进程）', 'call=' + wrote + ' 落盘值=' + (got && got.data));
  const denied = await js('window.xlcPlugin.call("launcher.info").then(r => r.ok ? "ALLOWED" : String(r.error))');
  ok(/未授权/.test(String(denied)), 'C15e 没勾选的权限被拒，原因回到面板', String(denied).slice(0, 90));
  const net = await js('fetch("https://example.com/").then(() => "ALLOWED").catch(() => "BLOCKED")');
  ok(net === 'BLOCKED', 'C15f 面板自己发不出网络请求（只能走托管接口）', String(net));
  const inf = await js('window.xlcPlugin.info().then(r => r.ok ? r.id : "ERR")');
  ok(inf === id, 'C15g 面板身份由主进程按窗口认定（面板自报家门不算数）', String(inf));
  closePluginPanel(id, '自测结束');
  await new Promise(res => setTimeout(res, 500));   /* 给窗口一点时间真的关掉：下面要删目录 */
  ok(!PLUGIN_WIN_BY_ID.has(id), 'C15h 关掉面板窗口后登记表已清干净');
  return { lines, fail };
}

/* 拓展插件自测（LMC_SMOKE_PLUGIN=1 触发；离线可跑，不联网，只在自己造的插件目录里折腾，
   跑完把目录与配置痕迹清掉）——覆盖「包校验 / 权限归一化 / 安装 / 授权闸门 / 卸载」五段 */
async function pluginSelfTest() {
  const lines = [];
  let fail = 0;
  const ok = (cond, label, extra) => {
    lines.push((cond ? 'PASS' : 'FAIL') + ' ' + label + (extra ? ' · ' + extra : ''));
    if (!cond) fail++;
  };
  const zip = (files) => buildZip(files.map(f => ({ name: f[0], data: Buffer.from(f[1], 'utf8') })));
  const J = (o) => JSON.stringify(o);
  const TID = 'qa-plugin-demo';
  const base = { id: TID, name: '示例插件', version: '1.2.0', author: 'QA', description: '自测用',
    entry: 'panel.html', permissions: ['notify', 'storage', 'http'], allowedHosts: ['example.com'] };
  const goodZip = () => zip([
    ['plugin.json', J(base)],
    ['panel.html', '<!doctype html><meta charset="utf-8"><title>demo</title><b>hi</b>'],
    ['panel.js', 'console.log("hi")'],
    ['icon.png', 'not-a-real-png']
  ]);
  const bad = (buf, label, expect) => {
    let msg = '（没有报错）';
    try { validatePluginPackage(buf); } catch (e) { msg = (e && e.message) || ''; }
    ok(msg.includes(expect), label, msg);
  };
  /* ① 包校验 */
  let v = null;
  try { v = validatePluginPackage(goodZip()); } catch (e) { v = null; }
  ok(!!v && v.manifest.id === TID && v.manifest.entry === 'panel.html' && v.hasPanel,
    'C1 合法包通过校验并解析出清单', v ? v.manifest.id + ' v' + v.manifest.version : '校验失败');
  ok(!!v && v.files.length === 4, 'C2 包内文件全部识别', v ? v.files.map(f => f.name).join(',') : '');
  bad(zip([['panel.html', 'x']]), 'C3 缺 plugin.json 被拒', 'plugin.json');
  bad(zip([['plugin.json', '{oops']]), 'C4 plugin.json 非法 JSON 被拒', 'JSON');
  bad(zip([['plugin.json', J(Object.assign({}, base, { id: 'Bad-Id' }))]]), 'C5 非法 id 被拒', '不合法');
  bad(zip([['plugin.json', J(Object.assign({}, base, { id: 'seedmap' }))]]), 'C6 与内置插件重名被拒', '不合法');
  bad(zip([['plugin.json', J(base)], ['../evil.txt', 'x']]), 'C7 zip-slip 条目被拒', '非法路径');
  bad(zip([['plugin.json', J(base)], ['/abs.txt', 'x']]), 'C8 绝对路径条目被拒', '非法路径');
  bad(zip([['plugin.json', J(base)], ['evil.exe', 'MZ']]), 'C9 可执行文件被拒', '不允许');
  bad(zip([['plugin.json', J(base)]]), 'C10 清单里的面板文件不存在被拒', '不存在');
  /* ② 权限归一化 */
  let v2 = null;
  try {
    v2 = validatePluginPackage(zip([
      ['plugin.json', J(Object.assign({}, base, { permissions: ['notify', 'hack', 'http'], allowedHosts: [] }))],
      ['panel.html', 'x']
    ]));
  } catch (_) { v2 = null; }
  ok(!!v2 && v2.manifest.permissions.length === 1 && v2.manifest.permissions[0] === 'notify',
    'C11 未声明的权限 / 没有域名的联网权限被摘掉', v2 ? v2.manifest.permissions.join(',') : '校验失败');
  ok(safeEntryName('panel.html') === 'panel.html' && safeEntryName('../evil.txt') === '' &&
    safeEntryName('a/../../evil.txt') === '' && safeEntryName('CON.txt') === '',
    'C12 包内路径规范化：危险路径与 Windows 保留名一律拒绝');
  /* ③ 安装 + 面板（文件落盘 / CSP 注入 / 窗口能开 / 桥能通 / 越权被拒）
     先只授权 storage —— 桥的用例正好用得上「一个授权、一个没授权」两种状态 */
  let info = null;
  try { info = installPluginPackage(goodZip(), TID); } catch (e) { info = null; }
  const dir = pluginDir(TID);
  ok(!!info && fs.existsSync(path.join(dir, 'panel.html')), 'C13 安装后插件文件落盘', dir);
  /* 插件页面是可选的：不带 page.html 的老包照常安装，且不产生侧栏入口 */
  const noPage = installedPlugins().find(p => p.id === TID) || {};
  ok(noPage.hasPage === false && !noPage.pageUrl,
    'C13b 不带 page.html 的插件 hasPage=false（纯设置型插件不添侧栏项）',
    'hasPage=' + noPage.hasPage);
  let panelHtml = '';
  try { panelHtml = fs.readFileSync(path.join(dir, 'panel.html'), 'utf8'); } catch (_) { panelHtml = ''; }
  ok(panelHtml.indexOf('http-equiv="Content-Security-Policy"') > 0 && panelHtml.indexOf("connect-src 'none'") > 0,
    'C14 安装时给面板补了 CSP（面板自己上不了网）');
  ok(panelHtml.startsWith('<!doctype html>') && panelHtml.indexOf('<b>hi</b>') > 0,
    'C14b 补 CSP 不挪动原文、不破坏 doctype');
  config.pluginPerms = Object.assign({}, config.pluginPerms, { [TID]: ['storage'] });
  invalidatePlugins();
  const br = await pluginBridgeSelfTest(TID);
  for (const l of br.lines) lines.push(l);
  fail += br.fail;
  ok(installedPlugins().some(p => p.id === TID), 'C16 已装列表包含新插件');
  ok(pluginsPublic()[TID] === true, 'C17 社区插件默认启用');
  ok(!!pluginDir(TID) && pluginDir('../evil') === '', 'C18 插件 id → 目录映射挡住穿越');
  ok(closePluginPanel(TID) === false, 'C18b 面板已关闭后再关一次不再重复处理');
  /* ④ 授权闸门（只授权 storage，其它一律不放行） */
  config.pluginPerms = Object.assign({}, config.pluginPerms, { [TID]: ['storage'] });
  invalidatePlugins();
  const r1 = pluginApiCall(TID, 'notify', { text: 'x' });
  ok(!r1.ok && /未授权/.test(r1.error || ''), 'C19 未授权接口被拒（notify）', r1.ok ? '竟然放行了' : r1.error);
  const r2 = pluginApiCall(TID, 'storage.set', { key: 'k', value: { n: 1 } });
  const r3 = pluginApiCall(TID, 'storage.get', { key: 'k' });
  ok(r2.ok && r3.ok && r3.data && r3.data.n === 1, 'C20 已授权接口可用（storage 读写）');
  const r4 = pluginApiCall(TID, 'openExternal', { url: 'https://evil.example.org/' });
  ok(!r4.ok, 'C21 未授权 + 非白名单域名被拒', r4.error || '');
  const r5 = pluginApiCall(TID, 'nothing.here', {});
  ok(!r5.ok && /未开放的接口/.test(r5.error || ''), 'C22 白名单外的接口被拒', r5.error || '');
  /* ⑤ control 权限：能改设置，但不能藏东西 —— 这一组是「放开权限」时最要紧的护栏。
     改的是自测临时目录里的配置（LMC_SMOKE_DATA_DIR），跑完原样还原。 */
  const cfgBackup = { mem: config.mem, deadzone: (config.gamepad || {}).deadzone, gameArgs: config.gameArgs };
  const denyNotGranted = pluginApiCall(TID, 'config.get', {});
  ok(!denyNotGranted.ok && /未授权/.test(denyNotGranted.error || ''),
    'C23 没勾「改启动器设置」时连读设置都被拒', denyNotGranted.ok ? '竟然放行了' : denyNotGranted.error);
  config.pluginPerms = Object.assign({}, config.pluginPerms, { [TID]: ['storage', 'control'] });
  invalidatePlugins();
  const sch = pluginApiCall(TID, 'config.schema', {});
  const schItems = (sch.ok && sch.data && sch.data.items) || [];
  const schByKey = {};
  for (const it of schItems) schByKey[it.key] = it;
  ok(sch.ok && sch.data.apiVersion === PLUGIN_API_VERSION && schItems.length >= 25,
    'C24 config.schema 给出全部设置项与接口版本（作者照着画界面）',
    'apiVersion=' + (sch.data && sch.data.apiVersion) + ' n=' + schItems.length);
  ok(!!schByKey.mem && schByKey.mem.writable === true && schByKey.mem.min === 1 && schByKey.mem.max === 64,
    'C25 schema 带上类型与范围（mem 1~64）', schByKey.mem ? JSON.stringify(schByKey.mem) : '缺失');
  ok(!!schByKey.plugins && schByKey.plugins.writable === false && /藏|关掉/.test(schByKey.plugins.why || ''),
    'C26 schema 如实标出「插件开关」不可写并给出原因（作者不用试错）',
    schByKey.plugins ? schByKey.plugins.why : '缺失');
  ok(!!schByKey.launcherVisibility && schByKey.launcherVisibility.values.indexOf('hide') < 0 && /藏/.test(schByKey.launcherVisibility.why || ''),
    'C27 可见性只给出 keep / min（hide 不在可选值里，并写明为什么）',
    schByKey.launcherVisibility ? schByKey.launcherVisibility.values.join('/') : '缺失');
  const all = pluginApiCall(TID, 'config.get', {});
  ok(all.ok && all.data && typeof all.data.mem === 'number' && all.data.accounts === undefined &&
    typeof all.data.aiApi.key === 'string' && !/^[A-Za-z0-9]{8,}$/.test(all.data.aiApi.key || ''),
    'C28 config.get 读得到设置，但账户数据不出现、AI 密钥只回「配没配」',
    all.ok ? ('keys=' + Object.keys(all.data).length + ' aiKey=' + JSON.stringify(all.data.aiApi && all.data.aiApi.key)) : all.error);
  const deniedRead = pluginApiCall(TID, 'config.get', { key: 'accounts' });
  ok(!deniedRead.ok && /不向插件开放/.test(deniedRead.error || ''),
    'C29 按路径单独读 accounts 也被拒', deniedRead.error || '竟然读到了');
  /* 写入要「立即可见」：主进程落盘 + 推给界面（界面据此弹提示），两条都要验 */
  const pushBefore = PLUGIN_CFG_PUSH.length;
  const w1 = pluginApiCall(TID, 'config.set', { key: 'mem', value: 8 });
  const disk1 = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).mem; } catch (_) { return null; } })();
  ok(w1.ok && config.mem === 8 && disk1 === 8, 'C30 config.set 改内存上限并立刻落盘（config + 磁盘一致）',
    'config.mem=' + config.mem + ' 磁盘=' + disk1);
  const pushed = PLUGIN_CFG_PUSH.length > pushBefore ? PLUGIN_CFG_PUSH[PLUGIN_CFG_PUSH.length - 1] : null;
  ok(!!pushed && pushed.id === TID && Array.isArray(pushed.keys) && pushed.keys.indexOf('mem') >= 0,
    'C31 改动会推给界面（用户一定能看到「谁改了哪几项」）',
    pushed ? pushed.name + ' → ' + (pushed.labels || []).join('、') : '没收到推送');
  const w2 = pluginApiCall(TID, 'config.set', { key: 'gamepad.deadzone', value: 0.35 });
  ok(w2.ok && config.gamepad && config.gamepad.deadzone === 0.35 && config.gamepad.enabled !== undefined,
    'C32 点路径改对象里的字段（gamepad.deadzone），其余字段原样保留',
    'deadzone=' + ((config.gamepad || {}).deadzone));
  const before = config.mem;
  const w3 = pluginApiCall(TID, 'config.set', { items: { mem: 12, 'gamepad.deadzone': 5 } });
  ok(!w3.ok && config.mem === before, 'C33 批量写里只要有一项不合法，整批都不写（不留半套配置）',
    'mem=' + config.mem + ' · ' + (w3.error || ''));
  const w4 = pluginApiCall(TID, 'config.set', { key: 'mem', value: 999 });
  ok(!w4.ok && /1 ~ 64/.test(w4.error || ''), 'C34 超范围的数字被拒（并回可取值范围）', w4.error || '');
  const w5 = pluginApiCall(TID, 'config.set', { key: 'procPriority', value: 'urgent' });
  ok(!w5.ok && /只能是/.test(w5.error || ''), 'C35 枚举项给了不认识的值被拒（并回可选值）', w5.error || '');
  const w6 = pluginApiCall(TID, 'config.set', { key: 'nope', value: 1 });
  ok(!w6.ok && /没有这个设置项/.test(w6.error || ''), 'C36 不存在的设置项被拒（并列出可用的）', w6.error || '');
  /* ---- 守门：这五条红了就等于「插件能把东西藏起来」 ---- */
  const g1 = pluginApiCall(TID, 'config.set', { key: 'plugins', value: {} });
  ok(!g1.ok && /不允许插件修改/.test(g1.error || '') && /插件开关/.test(g1.error || ''),
    'C37 守门①：改「插件开关」被拒（否则插件能把别的功能藏掉）', g1.error || '竟然放行了');
  const g2 = pluginApiCall(TID, 'config.set', { key: 'seenVersion', value: '0.0' });
  ok(!g2.ok && /公告/.test(g2.error || ''), 'C38 守门②：改「已读公告版本」被拒（否则公告再也不会弹）', g2.error || '');
  const g3 = pluginApiCall(TID, 'config.set', { key: 'launcherVisibility', value: 'hide' });
  ok(!g3.ok && /藏/.test(g3.error || ''), 'C39 守门③：把启动器窗口设成「隐藏」被拒（窗口不能消失）', g3.error || '');
  const g4 = pluginApiCall(TID, 'config.set', { key: 'autoCheckUpdate', value: false });
  ok(!g4.ok && /更新提醒/.test(g4.error || '') && pluginApiCall(TID, 'config.set', { key: 'autoCheckUpdate', value: true }).ok,
    'C40 守门④：关掉自动检查更新被拒，设回 true 则允许（不能把更新提示藏起来）', g4.error || '');
  const g5 = pluginApiCall(TID, 'config.set', { key: 'skipPreviewUpdate', value: true });
  ok(!g5.ok && /更新提示/.test(g5.error || ''),
    'C41 守门⑤：打开「跳过更新」被拒（不能吞掉更新提示）', g5.error || '');
  const g6 = pluginApiCall(TID, 'config.set', { key: 'pluginPerms', value: { [TID]: ['http'] } });
  ok(!g6.ok && /权限/.test(g6.error || ''), 'C42 守门⑥：给自己加权限被拒', g6.error || '');
  const g7 = pluginApiCall(TID, 'config.set', { key: 'versionSettings.根本没有这个实例.title', value: 'x' });
  ok(!g7.ok && /没有这个实例/.test(g7.error || ''), 'C43 实例级设置只能改已安装实例（乱写实例名被拒）', g7.error || '');
  const g8 = pluginApiCall(TID, 'config.set', { key: 'gameDir', value: 'Z:\\不存在的目录\\' });
  ok(!g8.ok && /不存在/.test(g8.error || ''), 'C44 游戏目录必须真实存在（拒绝把路径写坏）', g8.error || '');
  const g9 = pluginApiCall(TID, 'config.reset', { key: 'plugins' });
  ok(!g9.ok && /不允许插件修改/.test(g9.error || ''), 'C45 config.reset 也走同一套守门（不能靠「恢复默认」绕过）', g9.error || '');
  const r6 = pluginApiCall(TID, 'config.reset', { key: 'mem' });
  ok(r6.ok && config.mem === DEFAULT_CONFIG.mem, 'C46 config.reset 恢复默认值（内存回到 ' + DEFAULT_CONFIG.mem + ' GB）',
    'mem=' + config.mem);
  const implied = pluginApiCall(TID, 'versions.list', {});
  ok(implied.ok && Array.isArray(implied.data), 'C47 有 control 就等于也能读实例列表（改完能自己确认）', implied.ok ? 'n=' + implied.data.length : implied.error);
  /* 还原自测动过的配置项 */
  config.mem = cfgBackup.mem;
  config.gameArgs = cfgBackup.gameArgs;
  config.gamepad = Object.assign({}, config.gamepad, { deadzone: cfgBackup.deadzone });
  config.pluginPerms = Object.assign({}, config.pluginPerms, { [TID]: ['storage'] });
  saveConfigNow();
  invalidatePlugins();
  /* ⑤ 卸载（顺带验证「面板开着时移除」不会因为文件句柄删不掉） */
  openPluginPanel(TID, 'dark');
  let removed = null;
  try { removed = removePluginPackage(TID); } catch (e) { removed = null; }
  ok(!!removed && !fs.existsSync(dir), 'C48 移除后插件目录被删掉');
  ok(!installedPlugins().some(p => p.id === TID), 'C49 移除后不在已装列表里');
  ok(!config.pluginPerms || config.pluginPerms[TID] === undefined, 'C50 移除后授权记录一起清掉');
  ok(RESERVED_PLUGIN_IDS.has('seedmap') && RESERVED_PLUGIN_IDS.has('server') && RESERVED_PLUGIN_IDS.has('gamepad') && RESERVED_PLUGIN_IDS.has('translator'),
    'C51 四个内置插件的 id 全部保留');
  /* ⑥ 示例插件真跑一遍：docs/examples/hello-xlc 是给网友照着抄的样板，必须保证它真的能用。
     它最脆的地方是「外链 js / css」—— 面板要同时吃两条 CSP（插件自己声明的 + 安装时注入的），
     而面板是 file:// 顶层文档（源不透明），'self' 到底认不认同目录只有真开窗口才知道。
     这条红了就是模板会坑人，必须改模板而不是改测试。 */
  const EX = 'hello-xlc';
  const exSrc = path.join(__dirname, 'docs', 'examples', 'hello-xlc');
  if (!fs.existsSync(path.join(exSrc, 'plugin.json'))) {
    lines.push('SKIP C52~C58 示例插件真跑（当前环境没有 docs/examples/hello-xlc，打包版会命中这里）');
  } else {
    let exZip = null;
    try {
      exZip = buildZip(['plugin.json', 'panel.html', 'panel.js', 'panel.css',
        'page.html', 'page.js', 'page.css', 'Images/Logo.png'].map(n =>
        ({ name: n, data: fs.readFileSync(path.join(exSrc, n)) })));
    } catch (e) { exZip = null; }
    ok(!!exZip, 'C52 仓库里的示例插件能打进 ZIP（9 个文件，含页面与 Images/Logo.png）', exZip ? 'ok' : '读取失败');
    let exInfo = null;
    try { exInfo = exZip ? installPluginPackage(exZip, EX) : null; } catch (e) { exInfo = null; }
    const exDir = pluginDir(EX);
    ok(!!exInfo && fs.existsSync(path.join(exDir, 'panel.js')) && fs.existsSync(path.join(exDir, 'panel.css')),
      'C53 示例插件按 ZIP 正常安装（css / js 一起落盘）', exDir);
    /* 插件页面（page.html）：安装后元数据齐全，且吃到了宿主注入的 CSP */
    const exAfter = installedPlugins().find(p => p.id === EX) || {};
    ok(exAfter.hasPage === true && /^file:\/\//.test(String(exAfter.pageUrl || '')),
      'C59 示例插件带侧栏页面（page.html 被认出来，pageUrl 可用）',
      'hasPage=' + exAfter.hasPage + ' pageUrl=' + String(exAfter.pageUrl || '').slice(0, 50));
    ok(/^file:\/\//.test(String(exAfter.pageIconUrl || '')),
      'C60 侧栏入口图标取 Images/Logo.png（约定文件名）', String(exAfter.pageIconUrl || '（空）').slice(0, 60));
    let exPageCsp = '';
    try { exPageCsp = fs.readFileSync(path.join(exDir, 'page.html'), 'utf8'); } catch (_) {}
    ok(exPageCsp.indexOf(PLUGIN_PANEL_CSP) >= 0,
      'C61 page.html 安装时被注入宿主 CSP（与面板同一套护栏）', exPageCsp ? 'ok' : '读不到');
    config.pluginPerms = Object.assign({}, config.pluginPerms, { [EX]: ['notify', 'storage', 'launcher'] });
    invalidatePlugins();
    const exOpen = openPluginPanel(EX, 'dark');
    ok(!!exOpen && exOpen.ok, 'C54 示例插件面板窗口能打开', exOpen ? (exOpen.error || exOpen.name) : '没有返回');
    const exWin = PLUGIN_WIN_BY_ID.get(EX);
    if (!exWin) {
      ok(false, 'C54b 示例插件面板窗口已登记', '窗口没建起来');
    } else {
      const exWc = exWin.webContents;
      const t1 = Date.now();
      let exLoaded = 'TIMEOUT';
      while (Date.now() - t1 < 15000) {
        if (exWc.isDestroyed()) { exLoaded = 'DESTROYED'; break; }
        if (!exWc.isLoading() && exWc.getURL()) { exLoaded = true; break; }
        await new Promise(res => setTimeout(res, 250));
      }
      ok(exLoaded === true, 'C54b 示例插件面板文档加载完成', exLoaded === true ? 'ok' : String(exLoaded));
      const exJs = (code) => exWc.executeJavaScript(code, true).catch(e => 'ERR ' + ((e && e.message) || e));
      /* 外链 CSS 生效：背景色来自 panel.css，说明 style-src 在 file:// 面板里放行了同目录 */
      const exBg = await exJs('getComputedStyle(document.body).backgroundColor');
      ok(String(exBg) === 'rgb(21, 25, 34)', 'C55 示例面板的外链 CSS 生效（style-src 放行同目录）', String(exBg));
      /* 外链 JS 执行：panel.js 里的 boot() 会改写 #who（info() 是异步的，轮询等它） */
      let who = '';
      for (let i = 0; i < 20; i++) {
        who = await exJs('(document.getElementById("who")||{}).textContent || ""');
        if (/示例插件/.test(String(who))) break;
        await new Promise(res => setTimeout(res, 250));
      }
      ok(/示例插件.*hello-xlc/.test(String(who)), 'C56 示例面板的外链 JS 执行了（script-src 放行同目录）', String(who).slice(0, 70));
      let exVer = '';
      for (let i = 0; i < 20; i++) {
        exVer = await exJs('(document.getElementById("hostVer")||{}).textContent || ""');
        if (/启动器版本/.test(String(exVer))) break;
        await new Promise(res => setTimeout(res, 250));
      }
      ok(/启动器版本/.test(String(exVer)), 'C57 示例插件经桥调到 launcher.info（模板照抄即可用）',
        String(exVer).slice(0, 70).replace(/\n/g, ' / '));
      /* 模板的核心：这是「插件自己的设置页」—— 默认值渲染进表单、点保存写进插件私有存储。
         这一条红了 = 发给网友当模板的示例坏了，比启动器自己坏更严重。 */
      const exNick = await exJs('(document.getElementById("stNick")||{}).value || ""');
      ok(String(exNick) === '玩家', 'C57b 示例面板把默认设置渲染进了表单（没存过时用默认值）', '面板=' + exNick);
      await exJs('(function(){ document.getElementById("stNick").value="测试玩家"; document.getElementById("stTheme").value="light"; document.getElementById("btnSaveSt").click(); return 1; })()');
      let exSaved = null;
      for (let i = 0; i < 20; i++) {
        const got = pluginApiCall(EX, 'storage.get', { key: 'settings' });
        if (got.ok && got.data && got.data.nick === '测试玩家') { exSaved = got.data; break; }
        await new Promise(res => setTimeout(res, 250));
      }
      ok(!!exSaved, 'C57c 示例面板点「保存设置」真的写进了插件自己的存储（storage 链路通）',
        exSaved ? JSON.stringify(exSaved) : '没读到存的值');
      /* 模板不再碰启动器设置：清单里就不该有 control，免得网友照抄后又撞红线 */
      const exManifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(exSrc, 'plugin.json'), 'utf8')); } catch (_) { return {}; } })();
      const exPerms = Array.isArray(exManifest.permissions) ? exManifest.permissions : [];
      ok(exPerms.length && exPerms.indexOf('control') < 0 && exPerms.every(k => ['notify', 'storage', 'launcher'].includes(k)),
        'C57d 示例插件只申请 notify / storage / launcher（插件自己的设置，不碰启动器设置）', exPerms.join(','));
      closePluginPanel(EX, '自测结束');
      await new Promise(res => setTimeout(res, 400));
    }
    try { removePluginPackage(EX); } catch (_) {}
    ok(!fs.existsSync(exDir), 'C58 示例插件卸载后目录已清掉');
    if (config.plugins && config.plugins[EX] !== undefined) { delete config.plugins[EX]; saveConfigNow(); }
    if (config.pluginPerms && config.pluginPerms[EX] !== undefined) { delete config.pluginPerms[EX]; saveConfigNow(); }
    invalidatePlugins();
  }
  /* 收尾：别在数据目录里留垃圾 */
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  if (config.plugins && config.plugins[TID] !== undefined) { delete config.plugins[TID]; saveConfigNow(); }
  if (config.pluginPerms && config.pluginPerms[TID] !== undefined) { delete config.pluginPerms[TID]; saveConfigNow(); }
  invalidatePlugins();
  return { lines, fail };
}

/* ---------------- 插件：种子地图（Chunkbase 世界地图） ---------------- */
/* 以独立窗口加载 chunkbase.com 的种子地图，seed / 平台 / 维度通过 URL 参数预填 */
const SEEDMAP_HOSTS = ['www.chunkbase.com', 'chunkbase.com'];
/* 平台清单 = Chunkbase「版本」下拉里 option value（`java//java_26_3` 的后半段）的原样抄录，
   抓取日期 2026-10-11：Java 版 1.7 ~ 26.3（26.x 起为年份版本号）、基岩版 1.14 ~ 26.50。
   未收录 Chunkbase 的实验版（Java 26.4 / 基岩版 26.60）与「巨大化世界」（LB）变体。
   一个编码覆盖多个小版本时，编码取区间内**最低**那个版本；标签用 Chunkbase 给的区间写法。 */
const SEEDMAP_PLATFORMS = [
  ['Java 版', 'java_26_3', '26.3'],
  ['Java 版', 'java_26_2', '26.2'],
  ['Java 版', 'java_26_1', '26.1'],
  ['Java 版', 'java_1_21_9', '1.21.9 – 1.21.11'],
  ['Java 版', 'java_1_21_6', '1.21.6 – 1.21.8'],
  ['Java 版', 'java_1_21_5', '1.21.5'],
  ['Java 版', 'java_1_21_4', '1.21.4'],
  ['Java 版', 'java_1_21_2', '1.21.2 – 1.21.3'],
  ['Java 版', 'java_1_21', '1.21 – 1.21.1'],
  ['Java 版', 'java_1_20', '1.20'],
  ['Java 版', 'java_1_19_3', '1.19.3 – 1.19.4'],
  ['Java 版', 'java_1_19', '1.19 – 1.19.2'],
  ['Java 版', 'java_1_18', '1.18'],
  ['Java 版', 'java_1_17', '1.17'],
  ['Java 版', 'java_1_16', '1.16'],
  ['Java 版', 'java_1_15', '1.15'],
  ['Java 版', 'java_1_14', '1.14'],
  ['Java 版', 'java_1_13', '1.13'],
  ['Java 版', 'java_1_12', '1.12'],
  ['Java 版', 'java_1_11', '1.11'],
  ['Java 版', 'java_1_10', '1.10'],
  ['Java 版', 'java_1_9', '1.9'],
  ['Java 版', 'java_1_8', '1.8'],
  ['Java 版', 'java_1_7', '1.7'],
  ['基岩版', 'bedrock_26_50', '26.50 – 26.52'],
  ['基岩版', 'bedrock_26_30', '26.30 – 26.45'],
  ['基岩版', 'bedrock_26_0', '26.0 – 26.23'],
  ['基岩版', 'bedrock_1_21_120', '1.21.120 – 1.21.132'],
  ['基岩版', 'bedrock_1_21_110', '1.21.111 – 1.21.114'],
  ['基岩版', 'bedrock_1_21_90', '1.21.90 – 1.21.101'],
  ['基岩版', 'bedrock_1_21_60', '1.21.60 – 1.21.84'],
  ['基岩版', 'bedrock_1_21_50', '1.21.50'],
  ['基岩版', 'bedrock_1_21', '1.21 – 1.21.40'],
  ['基岩版', 'bedrock_1_20_60', '1.20.60 – 1.20.81'],
  ['基岩版', 'bedrock_1_20', '1.20.0 – 1.20.51'],
  ['基岩版', 'bedrock_1_19', '1.19'],
  ['基岩版', 'bedrock_1_18', '1.18'],
  ['基岩版', 'bedrock_1_17', '1.17'],
  ['基岩版', 'bedrock_1_16', '1.16'],
  ['基岩版', 'bedrock_1_14', '1.14']
];
const SEEDMAP_DEFAULT_PLATFORM = 'java_26_3';
const SEEDMAP_PLATFORM_CODES = new Set(SEEDMAP_PLATFORMS.map(x => x[1]));
function seedMapPlatforms() {
  return SEEDMAP_PLATFORMS.map(([group, code, label]) => ({ group, code, label }));
}
let seedMapWin = null;
ipcMain.handle('plugin:seedmap-platforms', () => ({ ok: true, platforms: seedMapPlatforms() }));
ipcMain.handle('plugin:seedmap-open', async (_e, p) => {
  if (!pluginEnabled('seedmap')) throw new Error('插件「种子地图」已停用，请先在插件页启用');
  const o = p || {};
  const seed = String(o.seed == null ? '' : o.seed).trim().slice(0, 64);
  if (!seed) throw new Error('请先输入种子（或从存档读取）');
  /* 允许中文/字母/数字/常见符号，仅拦截控制字符与可能破坏 URL 的引号尖括号 */
  if (/[\x00-\x1f"'<>\\]/.test(seed)) throw new Error('种子包含非法字符，请重新输入');
  const platform = String(o.platform || SEEDMAP_DEFAULT_PLATFORM);
  /* 白名单校验（替代原来的正则）：清单是固定枚举，顺带把注入类字符一并挡掉 */
  if (!SEEDMAP_PLATFORM_CODES.has(platform)) throw new Error('平台参数不合法');
  const dim = ['overworld', 'nether', 'end'].includes(String(o.dimension)) ? String(o.dimension) : 'overworld';
  const dimLabel = { overworld: '主世界', nether: '下界', end: '末地' }[dim];
  const url = 'https://www.chunkbase.com/apps/seed-map#seed=' + encodeURIComponent(seed) +
    '&platform=' + platform + '&dimension=' + dim + '&x=0&z=0&zoom=0.5';
  const winTitle = '种子地图 · ' + dimLabel + ' · ' + seed;
  try {
    let host = new URL(url).hostname;
    if (!SEEDMAP_HOSTS.includes(host)) throw new Error('non-whitelist host');
    if (seedMapWin && !seedMapWin.isDestroyed()) {
      seedMapWin.focus();
      await seedMapWin.loadURL(url);
      seedMapWin.setTitle(winTitle);
      return { ok: true, url, reused: true };
    }
    seedMapWin = new BrowserWindow({
      width: 1380, height: 880, minWidth: 900, minHeight: 600,
      title: winTitle, autoHideMenuBar: true, backgroundColor: '#12161d',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:seedmap' }
    });
    seedMapWin.on('closed', () => { seedMapWin = null; });
    await seedMapWin.loadURL(url);
    return { ok: true, url };
  } catch (e) {
    /* 窗口加载失败（如网络被墙）→ 回落系统浏览器打开，保证插件仍然可用 */
    logLine('[plugin:seedmap] 内嵌窗口失败，改用系统浏览器: ' + e.message);
    shell.openExternal(url);
    return { ok: true, url, external: true };
  }
});

/* ---------------- 插件：模组翻译器（上传 JAR → 生成汉化资源包） ----------------
 * 设计取舍（为什么是「资源包」而不是「改 JAR」）：
 *   ① 改 JAR 要把整包解压再压回去，一百多 MB 的模组会把启动器内存顶上去；
 *      资源包只装几条 zh_cn.json，几百 KB，轻得多 —— 用户要求「别占太大」。
 *   ② 改 JAR 一旦写坏，模组就进不去游戏；资源包是独立文件，不想要了删掉即可，
 *      原来的 JAR 一个字节都不动。
 *   ③ 资源包里的 zh_cn.json 会覆盖模组自带的那份，效果与直接改 JAR 一致。
 * 内存控制：
 *   · 一次只读一个 JAR（读完只留语言文件，其余字节立刻放开）
 *   · 只送「真正没被汉化过」的字符串去翻，同一条文本只翻一次
 *   · 译文落盘缓存（XLC数据/translator-cache.json，最多 2.4 万条），翻过的模组再翻几乎不联网
 *   · 批量翻：一次把 10 条用换行拼起来发（实测翻译服务会保留换行），请求数降到 1/10
 * 翻译源（两条通道）：
 *   ① MyMemory 官方免费接口（默认）：有公开文档的 REST API，免密钥；带 de 邮箱时
 *      每天 5 万字符额度，单次 q ≤ 500 字节，多条用 \n 拼一批。署名见面板底部与
 *      THIRD-PARTY.md 第 5 节。
 *   ② Bing 网页翻译接口（备用，默认关闭）：那是网页端自用的接口，没有 API 承诺，
 *      也不在微软开放 API 之列，所以**只允许用户自己在面板里启用**；启用后同样按
 *      「这条没翻成」处理失败，绝不让整个流程炸掉。
 * 两条通道都是尽力而为：任何失败都只影响那几条文本。 */
const TR_CORE = require('./src/translator-core');
const TR_CACHE_FILE = path.join(DATA_DIR, 'translator-cache.json');
const TR_CONTACT = 'lmclauncher@outlook.com';   /* MyMemory 的 de 参数：出问题能联系到我们，同时把额度从 5k 提到 50k */
const TR_UA = 'XLC-Launcher/' + APP_VERSION;    /* 诚实 UA，不伪装成浏览器 */
const TR_LIM = { jar: 256 << 20, keys: 3000, cache: 24000, batchChars: 460, batchCount: 10, pool: 2 };
const TR_ST = {
  cache: null, dirty: false, cancel: false, running: false,
  engine: 'mm', quota: false, stopped: '',
  key: '', token: '', tokenAt: 0, ig: ''
};
const TR_LANG_RE = /^assets\/([^/]+)\/lang\/(en_us|zh_cn)\.json$/i;
const TR_LANG_OLD_RE = /^assets\/([^/]+)\/lang\/(en_US|zh_CN)\.lang$/;
const TR_META_FILES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'mcmod.info'];

function trCache() {
  if (TR_ST.cache) return TR_ST.cache;
  try {
    const raw = JSON.parse(fs.readFileSync(TR_CACHE_FILE, 'utf8'));
    TR_ST.cache = new Map(Object.entries((raw && raw.map) || {}));
  } catch (_) { TR_ST.cache = new Map(); }
  return TR_ST.cache;
}
function trCacheSave() {
  if (!TR_ST.dirty || !TR_ST.cache) return;
  try {
    const all = [...TR_ST.cache.entries()];
    const keep = all.slice(Math.max(0, all.length - TR_LIM.cache));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TR_CACHE_FILE, JSON.stringify({ v: 1, map: Object.fromEntries(keep) }));
    TR_ST.dirty = false;
  } catch (e) { logLine('[translator] 译文缓存写入失败：' + e.message); }
}
/* 统计「这条文本是不是已经被翻译服务翻过」（模组自带的 zh_cn 里已有也算） */
function trCacheGet(s) {
  const v = trCache().get(TR_CORE.hashText(s));
  return typeof v === 'string' && v.trim() ? v : '';
}
function trCacheSet(en, zh) {
  if (!en || !zh) return;
  trCache().set(TR_CORE.hashText(en), zh);
  TR_ST.dirty = true;
}

/* ========== 通道①：MyMemory 官方免费接口（默认，见 THIRD-PARTY.md 第 5 节） ==========
   文档：https://mymemory.translated.net/doc/spec.php（q 上限 500 字节）
   额度：https://mymemory.translated.net/doc/usagelimits.php（带 de 邮箱 5 万字符/天）
   多条用 \n 拼成一次请求；返回行数对不上就交给上层逐条兜底。 */
let trMmAt = 0;
async function trMmBatch(texts) {
  const q = texts.join('\n');
  if (Buffer.byteLength(q, 'utf8') > 500) return null;
  /* 官方接口没有并发承诺，两次请求之间留点间隔，别把免费额度通道打挂 */
  const wait = 140 - (Date.now() - trMmAt);
  trMmAt = Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const url = 'https://api.mymemory.translated.net/get?langpair=en%7Czh-CN&mt=1'
    + '&de=' + encodeURIComponent(TR_CONTACT)
    + '&q=' + encodeURIComponent(q);
  const res = await netFetch(url, { headers: { 'User-Agent': TR_UA } }, 25000);
  if (res.status === 429) {
    const err = new Error('翻译服务限流（HTTP 429）');
    err.quota = true;
    throw err;
  }
  if (!res.ok) throw new Error('翻译服务暂时不可用（HTTP ' + res.status + '）');
  const data = await res.json().catch(() => null);
  const txt = data && data.responseData && typeof data.responseData.translatedText === 'string'
    ? data.responseData.translatedText : '';
  if (!txt) return null;
  if (/MYMEMORY WARNING|ALL AVAILABLE FREE TRANSLATIONS|QUOTA/i.test(txt)) {
    const err = new Error('今日免费翻译额度已用完（约 5 万字符/天）');
    err.quota = true;
    throw err;
  }
  if (/QUERY LENGTH LIMIT|INVALID QUERY|PLEASE SELECT TWO DISTINCT/i.test(txt)) return null;
  if (texts.length === 1) return [txt];
  const lines = txt.split('\n');
  return lines.length === texts.length ? lines : null;
}

/* ========== 通道②：Bing 网页接口（备用，用户手动启用才走这里） ==========
   握手：从翻译页里取 key / token / IG（三样都是页面内的短时令牌，约 1 小时有效）。
   这条通道不是开放 API，可能随时失效；只在用户明确启用时使用。 */
async function trBingAuth(force) {
  if (!force && TR_ST.token && Date.now() - TR_ST.tokenAt < 30 * 60 * 1000) return;
  const res = await netFetch('https://www.bing.com/translator', {
    headers: { 'User-Agent': TR_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  }, 20000);
  if (!res.ok) throw new Error('翻译服务临时不可用（HTTP ' + res.status + '），请稍后再试');
  const html = await res.text();
  const m = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+)\s*,\s*"([^"]+)"/);
  if (!m) throw new Error('翻译服务握手失败（页面结构可能变了），请稍后再试');
  const ig = html.match(/IG\s*:\s*"([A-F0-9]{16,})"/i);
  TR_ST.key = m[1];
  TR_ST.token = m[2];
  TR_ST.ig = ig ? ig[1] : '';
  TR_ST.tokenAt = Date.now();
}
/* 发一批（内部用换行拼接多条）。返回原文对应的译文数组；条数对不上返回 null。 */
async function trBingBatch(texts) {
  await trBingAuth(false);
  const body = new URLSearchParams({
    fromLang: 'en', to: 'zh-Hans', text: texts.join('\n'),
    token: TR_ST.token, key: TR_ST.key
  }).toString();
  const url = 'https://cn.bing.com/ttranslatev3?isVertical=1' +
    (TR_ST.ig ? '&IG=' + encodeURIComponent(TR_ST.ig) : '') + '&IID=translator.5028.1';
  const res = await netFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': TR_UA,
      Referer: 'https://cn.bing.com/translator',
      Origin: 'https://cn.bing.com'
    },
    body
  }, 25000);
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const err = new Error('翻译服务限流（HTTP ' + res.status + '）');
    err.retryAuth = true;
    throw err;
  }
  if (!res.ok) throw new Error('翻译失败（HTTP ' + res.status + '）');
  const data = await res.json().catch(() => null);
  const hit = Array.isArray(data) && data[0] && data[0].translations && data[0].translations[0];
  if (!hit || typeof hit.text !== 'string') return null;
  if (texts.length === 1) return [hit.text];
  const lines = hit.text.split('\n');
  return lines.length === texts.length ? lines : null;
}
/* 统一入口：按当前通道分发（默认 MyMemory，用户启用备用通道才走 Bing） */
async function trPostBatch(texts) {
  return TR_ST.engine === 'bing' ? trBingBatch(texts) : trMmBatch(texts);
}
/* 单条翻译（批量失败时逐条兜底）：带一次重握手 + 一次退避重试 */
async function trTranslateOne(raw) {
  const { text, tokens } = TR_CORE.protectPlaceholders(raw);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const got = await trPostBatch([text]);
      if (!got) return '';
      const back = TR_CORE.restorePlaceholders(got[0], tokens);
      return back ? back.trim() : '';
    } catch (e) {
      if (attempt === 0) {
        if (e && e.retryAuth) { try { await trBingAuth(true); } catch (_) {} }
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      return '';
    }
  }
  return '';
}

/* ---------------- JAR 解析 ---------------- */
function trStatJar(p) {
  const abs = path.resolve(String(p || ''));
  if (!/\.jar$/i.test(abs)) throw new Error('请选择一个 .jar 文件（模组本体）');
  let st = null;
  try { st = fs.statSync(abs); } catch (_) { throw new Error('读不到这个文件，可能已被移动或删除'); }
  if (!st.isFile()) throw new Error('请选择一个 .jar 文件');
  if (st.size > TR_LIM.jar) {
    throw new Error('这个 JAR 有 ' + Math.round(st.size / 1048576) + ' MB，超过 256 MB 上限（这么大的包通常是整合包而不是模组）');
  }
  return { path: abs, name: path.basename(abs), size: st.size };
}
/* 从 JAR 里挑出「语言文件 + 清单文件」两类条目 */
function trPickEntries(buf) {
  return findZipEntries(buf, n =>
    TR_LANG_RE.test(n) || TR_LANG_OLD_RE.test(n) || TR_META_FILES.includes(n));
}
/* 模组基本信息：id / 名字 / 版本 / 加载器 / 声明支持的 MC 版本（拿不准的字段一律留空） */
function trParseMeta(entries) {
  const byName = new Map(entries.map(e => [e.name, e.data]));
  const out = { id: '', name: '', version: '', loader: '', mcVer: '' };
  const jsonOf = (n) => {
    if (!byName.has(n)) return null;
    try { return JSON.parse(byName.get(n).toString('utf8')); } catch (_) { return null; }
  };
  const fm = jsonOf('fabric.mod.json');
  if (fm) {
    out.loader = 'Fabric';
    out.id = String(fm.id || '');
    out.name = String(fm.name || '');
    out.version = String(fm.version || '');
    const dep = fm.depends && fm.depends.minecraft;
    if (typeof dep === 'string') out.mcVer = dep;
  }
  const qm = jsonOf('quilt.mod.json');
  if (qm && qm.quilt_loader) {
    out.loader = 'Quilt';
    out.id = out.id || String(qm.quilt_loader.id || '');
    const md = qm.quilt_loader.metadata || {};
    out.name = out.name || String(md.name || '');
    out.version = out.version || String(qm.quilt_loader.version || '');
    const dep = (qm.quilt_loader.depends || []).find(d => d && (d.id === 'minecraft'));
    if (!out.mcVer && dep && dep.version) out.mcVer = String(dep.version);
  }
  const tomlText = (n) => (byName.has(n) ? byName.get(n).toString('utf8') : '');
  const nf = tomlText('META-INF/neoforge.mods.toml');
  const fg = tomlText('META-INF/mods.toml');
  if (nf || fg) {
    const t = nf || fg;
    out.loader = out.loader || (nf ? 'NeoForge' : 'Forge');
    const pick = (re) => { const m = t.match(re); return m ? m[1] : ''; };
    out.id = out.id || pick(/^\s*modId\s*=\s*"([^"]+)"/m);
    out.name = out.name || pick(/^\s*displayName\s*=\s*"([^"]+)"/m);
    out.version = out.version || pick(/^\s*version\s*=\s*"([^"]+)"/m);
    if (!out.mcVer) {
      const vr = t.match(/versionRange\s*=\s*"\[?\s*([\d.]+)/);
      if (vr) out.mcVer = vr[1];
    }
  }
  const mi = jsonOf('mcmod.info');
  if (Array.isArray(mi) && mi[0]) {
    out.loader = out.loader || 'Forge';
    out.id = out.id || String(mi[0].modid || '');
    out.name = out.name || String(mi[0].name || '');
    out.version = out.version || String(mi[0].version || '');
    if (!out.mcVer) out.mcVer = String(mi[0].mcversion || '');
  }
  return out;
}
/* 把 JAR 读成「按命名空间分组的语言表」 */
function trReadLangs(buf) {
  const entries = trPickEntries(buf);
  const meta = trParseMeta(entries);
  const groups = new Map();   /* 'ns|json' → { ns, kind, path, en, zh } */
  for (const e of entries) {
    let ns = '', kind = '', lang = '';
    const j = e.name.match(TR_LANG_RE);
    if (j) { ns = j[1]; kind = 'json'; lang = j[2].toLowerCase(); }
    const l = e.name.match(TR_LANG_OLD_RE);
    if (l) { ns = l[1]; kind = 'lang'; lang = l[2].toLowerCase(); }
    if (!ns) continue;
    const key = ns + '|' + kind;
    if (!groups.has(key)) groups.set(key, { ns, kind, en: null, zh: null, enPath: '', zhPath: '' });
    const g = groups.get(key);
    const text = e.data.toString('utf8');
    if (kind === 'json') {
      let obj = null;
      try { obj = JSON.parse(text); } catch (_) { continue; }
      if (!obj || typeof obj !== 'object') continue;
      if (lang === 'en_us') { g.en = obj; g.enPath = e.name; } else { g.zh = obj; g.zhPath = e.name; }
    } else {
      const obj = TR_CORE.parseLangFile(text);
      if (lang === 'en_us') { g.en = obj; g.enPath = e.name; } else { g.zh = obj; g.zhPath = e.name; }
    }
  }
  return { meta, groups: [...groups.values()].filter(g => g.en) };
}
/* 统计：总条目 / 值得翻的 / 已有汉化覆盖的 */
function trSurvey(groups) {
  let total = 0, translatable = 0, covered = 0;
  const todo = new Set();
  for (const g of groups) {
    const en = g.en || {};
    if (g.kind === 'json') {
      /* 按「键路径」判断已有汉化：同一个键在 zh_cn 里有非空值，就算覆盖 ——
         不能拿英文原文去比对，因为汉化文件里的值是译文，永远不会等于英文。 */
      const enLeaves = new Map(), zhLeaves = new Map();
      (function walk(node, pre, dst) {
        if (typeof node === 'string') { dst.set(pre, node); return; }
        if (Array.isArray(node)) { node.forEach((v, i) => walk(v, pre + '[' + i + ']', dst)); return; }
        if (node && typeof node === 'object') Object.keys(node).forEach(k => walk(node[k], pre ? pre + '.' + k : k, dst));
      })(en, '', enLeaves);
      (function walk(node, pre, dst) {
        if (typeof node === 'string') { dst.set(pre, node); return; }
        if (Array.isArray(node)) { node.forEach((v, i) => walk(v, pre + '[' + i + ']', dst)); return; }
        if (node && typeof node === 'object') Object.keys(node).forEach(k => walk(node[k], pre ? pre + '.' + k : k, dst));
      })(g.zh, '', zhLeaves);
      total += enLeaves.size;
      for (const [k, s] of enLeaves) {
        if (!TR_CORE.isTranslatable(s)) continue;
        translatable++;
        const old = zhLeaves.get(k);
        if ((typeof old === 'string' && old.trim()) || trCacheGet(s)) covered++;
        else todo.add(s);
      }
    } else {
      const zhObj = g.zh || {};
      for (const k of Object.keys(en)) {
        const v = en[k];
        total++;
        if (!TR_CORE.isTranslatable(v)) continue;
        translatable++;
        const old = zhObj[k];
        if ((typeof old === 'string' && old.trim()) || trCacheGet(v)) covered++;
        else todo.add(v);
      }
    }
  }
  return { total, translatable, covered, todo: [...todo] };
}

/* 主流程：读 JAR → 统计 → 翻译 → 写资源包 */
async function trRun(p, onEvent) {
  const st = trStatJar(p.path || p);
  if (TR_ST.running) throw new Error('上一次翻译还没结束，请稍等或先取消');
  TR_ST.running = true;
  TR_ST.cancel = false;
  /* 翻译通道：默认官方免费接口；用户在面板里勾了「备用通道」才走 Bing */
  TR_ST.engine = config.translatorBing ? 'bing' : 'mm';
  TR_ST.quota = false;
  TR_ST.stopped = '';
  const started = Date.now();
  try {
    onEvent({ phase: 'read', done: 0, total: 1, note: '正在读取 ' + st.name });
    let buf = fs.readFileSync(st.path);
    let parsed = null;
    try { parsed = trReadLangs(buf); } finally { buf = null; }   /* 语言文件已解析完，整包字节立刻放开 */
    const groups = parsed.groups;
    if (!groups.length) {
      throw new Error('这个 JAR 里没有找到语言文件（assets/*/lang/en_us.json）—— 它可能不是模组，或文本是硬编码在代码里的');
    }
    const meta = parsed.meta;
    const survey = trSurvey(groups);
    let todo = survey.todo;
    const capped = todo.length > TR_LIM.keys;
    if (capped) todo = todo.slice(0, TR_LIM.keys);
    const total = todo.length;
    const result = new Map();     /* 原文 → 译文 */
    let cachedHit = survey.covered;
    let failed = 0;

    /* 先吃缓存（survey 里已经算过一遍，这里只把命中项装进 result） */
    for (const s of todo) {
      const hit = trCacheGet(s);
      if (hit) result.set(s, hit);
    }
    const need = todo.filter(s => !result.has(s));

    if (need.length) {
      onEvent({ phase: 'translate', done: 0, total: need.length, cached: cachedHit, note: '正在翻译 ' + need.length + ' 条文本…' });
      /* 拼批：换行分隔（翻译服务会保留换行），太长的单条不与别人拼 */
      const batches = [];
      let cur = [], curLen = 0;
      for (const s of need) {
        if (/\n/.test(s) || s.length > TR_LIM.batchChars) { batches.push([s]); continue; }
        if (cur.length >= TR_LIM.batchCount || curLen + s.length + 1 > TR_LIM.batchChars) {
          if (cur.length) batches.push(cur);
          cur = []; curLen = 0;
        }
        cur.push(s); curLen += s.length + 1;
      }
      if (cur.length) batches.push(cur);

      let doneCount = 0;
      const pool = async (worker) => {
        let i = 0;
        /* 官方免费接口走单并发（配额与限流都更稳），备用通道可以并发 2 */
        const want = TR_ST.engine === 'bing' ? TR_LIM.pool : 1;
        const n = Math.min(want, batches.length) || 1;
        await Promise.all(Array.from({ length: n }, async () => {
          while (true) {
            if (TR_ST.cancel || TR_ST.stopped) return;
            const idx = i++;
            if (idx >= batches.length) return;
            await worker(batches[idx]);
          }
        }));
      };
      await pool(async (batch) => {
        if (TR_ST.cancel) return;
        const prot = batch.map(s => TR_CORE.protectPlaceholders(s));
        let lines = null;
        try {
          lines = await trPostBatch(prot.map(x => x.text));
          if (!lines && batch.length > 1) {
            /* 条数对不上（模型把两行并了 / 拆了）：这批改逐条翻，宁可慢也不写错行 */
            lines = [];
            for (const one of prot) {
              const got = await trPostBatch([one.text]).catch(() => null);
              lines.push(got && got[0] ? got[0] : '');
            }
          }
        } catch (e) {
          /* 免费额度用完：这一轮就别再发了，已经翻好的照样写进包 */
          if (e && e.quota) TR_ST.stopped = 'quota';
          if (e && e.retryAuth) { try { await trBingAuth(true); } catch (_) {} }
          lines = null;
        }
        prot.forEach((x, k) => {
          const raw = lines ? lines[k] : '';
          const back = raw ? TR_CORE.restorePlaceholders(raw, x.tokens) : null;
          const zh = back ? back.trim() : '';
          if (zh && zh !== batch[k]) { result.set(batch[k], zh); trCacheSet(batch[k], zh); }
          else failed++;
          doneCount++;
        });
        onEvent({ phase: 'translate', done: doneCount, total: need.length, cached: cachedHit,
          note: '已翻译 ' + result.size + ' / ' + total + ' 条' });
      });
    }

    if (TR_ST.cancel) {
      return { ok: false, canceled: true, message: '已取消，未生成资源包' };
    }

    /* 写资源包：只包含语言文件 + pack.mcmeta */
    onEvent({ phase: 'write', done: total, total, note: '正在生成汉化资源包…' });
    const packFiles = [];
    packFiles.push({
      name: 'pack.mcmeta',
      data: JSON.stringify(TR_CORE.packMeta(meta.mcVer, 'XLC 模组翻译器 · ' + (meta.name || st.name)), null, 2)
    });
    let written = 0;
    for (const g of groups) {
      if (g.kind === 'json') {
        const merged = TR_CORE.mergeLang(g.en, g.zh, result);
        if (!merged || !Object.keys(merged).length) continue;
        packFiles.push({
          name: 'assets/' + g.ns + '/lang/zh_cn.json',
          data: JSON.stringify(merged, null, 2)
        });
        written += Object.keys(merged).length;
      } else {
        /* 1.12 老格式：key=value。原有 zh_CN 优先，其余按英文值查译文 */
        const zhOld = g.zh || {};
        const out = {};
        for (const k of Object.keys(g.en)) {
          const old = zhOld[k];
          if (typeof old === 'string' && old.trim()) { out[k] = old; continue; }
          const zh = result.get(g.en[k]);
          if (zh) out[k] = zh;
        }
        if (!Object.keys(out).length) continue;
        packFiles.push({
          name: 'assets/' + g.ns + '/lang/zh_CN.lang',
          data: TR_CORE.buildLangFile(out)
        });
        written += Object.keys(out).length;
      }
    }
    if (packFiles.length <= 1) {
      throw new Error(TR_ST.stopped === 'quota'
        ? '今日免费翻译额度已用完（约 5 万字符/天），这次没能翻出内容；明天再试，或在面板里启用备用通道'
        : '这次没有翻出任何内容（可能全部已汉化，或翻译服务暂时不可用）');
    }

    const RpDir = path.join(config.gameDir, 'resourcepacks');
    fs.mkdirSync(RpDir, { recursive: true });
    const base = TR_CORE.safeFileName(meta.id || st.name.replace(/\.jar$/i, ''), 'mod');
    const outName = 'XLC模组汉化-' + base + '.zip';
    const outPath = path.join(RpDir, outName);
    fs.writeFileSync(outPath, buildZip(packFiles));
    trCacheSave();

    logLine('[translator] ' + st.name + ' → ' + outName + '（译 ' + result.size + ' 条 / 写 ' + written + ' 条，用时 ' +
      ((Date.now() - started) / 1000).toFixed(1) + 's）');
    return {
      ok: true,
      pack: outPath,
      packName: outName,
      dir: RpDir,
      mod: meta,
      translated: result.size,
      written,
      failed,
      capped,
      total,
      cached: cachedHit,
      engine: TR_ST.engine,
      quota: TR_ST.stopped === 'quota',
      seconds: Math.round((Date.now() - started) / 1000)
    };
  } finally {
    TR_ST.running = false;
    TR_ST.cancel = false;
  }
}

ipcMain.handle('translator:pick', async () => {
  if (!pluginEnabled('translator')) throw new Error('插件「模组翻译器」已停用，请先在插件页启用');
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择要翻译的模组 JAR',
    filters: [{ name: '模组 JAR', extensions: ['jar'] }, { name: '全部文件', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('translator:inspect', async (_e, p) => {
  if (!pluginEnabled('translator')) throw new Error('插件「模组翻译器」已停用，请先在插件页启用');
  const st = trStatJar(p);
  const buf = fs.readFileSync(st.path);
  let parsed = null;
  try { parsed = trReadLangs(buf); } finally { /* buf 在函数结束时自动释放 */ }
  const groups = parsed.groups;
  if (!groups.length) {
    return { ok: false, error: '这个 JAR 里没有找到语言文件（assets/*/lang/en_us.json）—— 它可能不是模组，或文本是硬编码在代码里的' };
  }
  const survey = trSurvey(groups);
  const faces = groups.map(g => ({
    ns: g.ns, kind: g.kind,
    keys: g.kind === 'json' ? Object.keys(g.en).length : Object.keys(g.en).length,
    zhKeys: g.zh ? Object.keys(g.zh).length : 0
  }));
  return {
    ok: true,
    file: { name: st.name, size: st.size, path: st.path },
    mod: parsed.meta,
    faces,
    total: survey.total,
    translatable: survey.translatable,
    cached: survey.covered,
    todo: survey.todo.length,
    capped: survey.todo.length > TR_LIM.keys,
    limit: TR_LIM.keys
  };
});
ipcMain.handle('translator:run', async (e, p) => {
  if (!pluginEnabled('translator')) throw new Error('插件「模组翻译器」已停用，请先在插件页启用');
  const send = (d) => { try { e.sender.send('translator:progress', d); } catch (_) {} };
  try {
    return await trRun(p, send);
  } catch (err) {
    logLine('[translator] 失败：' + ((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('translator:cancel', () => { TR_ST.cancel = true; return { ok: true }; });
ipcMain.handle('translator:open-dir', async (_e, p) => {
  const dir = String(p || path.join(config.gameDir, 'resourcepacks'));
  const r = await shell.openPath(dir);
  return r ? { ok: false, error: r } : { ok: true };
});
/* 拖拽：preload 拿到真实路径后发过来（File 对象过不了 contextBridge），这里转给启动器界面 */
ipcMain.on('translator:drop', (e, p) => {
  try { e.sender.send('translator:drop', String(p || '')); } catch (_) {}
});

/* ---------------- 插件：一键开服（服务端下载 / 配置 / 启停） ---------------- */
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
/* 运行中的服务器进程表：name → { child, exited, buf, port, startedAt } */
const SERVER_PROCS = new Map();
const SERVER_CORES = [
  { id: 'paper', name: 'Paper', desc: '高性能服务端，支持 Bukkit/Spigot 插件（推荐）' },
  { id: 'purpur', name: 'Purpur', desc: 'Paper 分支，可玩性设置更多' },
  { id: 'vanilla', name: '原版', desc: 'Mojang 官方服务端，纯净无插件' },
  { id: 'fabric', name: 'Fabric', desc: '轻量模组服务端，支持 Fabric 模组' }
];
function safeServerName(n) {
  const s = String(n == null ? '' : n).trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  if (!s || s === '.' || s === '..') throw new Error('服务器名称不合法');
  return s;
}
function serverDirOf(name) { return path.join(SERVERS_DIR, safeServerName(name)); }
/* 本机可用于联机的局域网 IPv4（同一个路由器/WiFi 下的玩家用这个地址连服务器）
 * 排掉回环、APIPA(169.254)、以及 VMware/VirtualBox/Hyper-V 这类虚拟网卡（联机根本用不上，列出来只会误导）；
 * Radmin / ZeroTier / Tailscale 等虚拟局域网保留 —— 外网联机正是靠它们 */
function lanIPv4() {
  const VIRTUAL = /VMware|VirtualBox|Hyper-V|vEthernet|Loopback|Bluetooth|WAN Miniport|Npcap|TAP-Windows|Docker|WSL|Npcap/i;
  const PHYSICAL = /WLAN|Wi-?Fi|无线|以太网|Ethernet|Realtek|Intel|Qualcomm|MediaTek|Broadcom/i;
  const list = [];
  try {
    const nis = os.networkInterfaces();
    for (const iface of Object.keys(nis)) {
      if (VIRTUAL.test(iface)) continue;
      for (const ni of (nis[iface] || [])) {
        /* Node 18+ family 既可能是数字 4 也可能是字符串 'IPv4'，两种都兼容 */
        if (!(ni.family === 'IPv4' || ni.family === 4) || ni.internal) continue;
        const ip = String(ni.address || '');
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
        if (/^(127\.|169\.254\.)/.test(ip)) continue;
        list.push({ ip, iface, physical: PHYSICAL.test(iface) });
      }
    }
  } catch (_) {}
  const priv = (ip) => (/^192\.168\./.test(ip) ? 0
    : /^10\./.test(ip) ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  /* 物理网卡优先，其次家用网段（这样"第一个地址"通常就是能直接发给好友的那个） */
  list.sort((a, b) => (a.physical === b.physical ? priv(a.ip) - priv(b.ip) : (a.physical ? -1 : 1)));
  const seen = new Set();
  return list.filter(x => (seen.has(x.ip) ? false : (seen.add(x.ip), true)));
}
/* 生成某服务器的连接地址：本机（127.0.0.1）与局域网（局域网 IPv4），供界面直接展示/复制 */
function serverAddrOf(meta, lanList) {
  const port = parseInt(meta && meta.port, 10) || 25565;
  const lan = lanList || lanIPv4();
  return {
    port,
    local: '127.0.0.1:' + port,
    lan: lan.map(x => x.ip + ':' + port),
    lanIps: lan.map(x => x.ip),
    lanIfaces: lan.map(x => x.iface)
  };
}
function serverMetaPath(dir) { return path.join(dir, 'xlc-server.json'); }
function readServerMeta(dir) {
  try { return JSON.parse(fs.readFileSync(serverMetaPath(dir), 'utf8')); } catch (_) { return null; }
}
/* 读取 server.properties 的真实取值（键 → 字符串）。服务端启动时会把缺失键补全并重写文件，
   所以这里的值才是「真正生效」的配置，用于校验启动器显示与实际是否一致 */
function readServerProps(dir) {
  const map = {};
  try {
    const txt = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line[0] === '#' || line[0] === '!') continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch (_) { return null; }
  return map;
}
/* 各核心的版本清单 */
/* PaperMC 于 2025 年启用新的 Downloads Service（fill.papermc.io v3），旧 api.papermc.io/v2 返回 410；
   新服务要求 User-Agent 明确标识软件并带联系方式，否则会被拒绝 */
const PAPER_UA = 'XLC-Launcher/' + APP_VERSION + ' (+https://github.com/lmc-launcher)';
async function paperJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': PAPER_UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
  const j = JSON.parse(await res.text());
  if (j && j.ok === false) throw new Error(j.message || 'PaperMC 接口返回错误');
  return j;
}
function cmpMcVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
async function serverVersions(core) {
  if (core === 'paper') {
    const j = await paperJson('https://fill.papermc.io/v3/projects/paper');
    const groups = j.versions || {};
    const all = [];
    for (const k of Object.keys(groups)) for (const v of (groups[k] || [])) all.push(String(v));
    /* 只用正式版本（1.20.1 这种），快照/预发布排除，最新的排最前 */
    return [...new Set(all)].filter(v => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => cmpMcVer(b, a));
  }
  if (core === 'purpur') {
    const j = await fetchJson('https://api.purpurmc.org/v2/purpur');
    return (j.versions || []).slice().reverse();
  }
  if (core === 'fabric') {
    const j = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
    return j.filter(v => v.stable).map(v => v.version);
  }
  /* vanilla：走当前下载源（BMCLAPI 镜像更快） */
  const url = config.source === 'official'
    ? 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
    : MANIFEST_URL.bmclapi;
  const j = await fetchJson(url);
  return j.versions.filter(v => v.type === 'release').map(v => v.id);
}
ipcMain.handle('server:cores', () => ({ ok: true, cores: SERVER_CORES }));
ipcMain.handle('server:versions', async (_e, p) => {
  const core = String((p && p.core) || 'paper');
  try { return { ok: true, core, versions: await serverVersions(core) }; }
  catch (e) { return { ok: false, error: '获取版本列表失败：' + e.message }; }
});
/* 解析某核心某版本的下载地址 */
async function resolveServerDownload(core, ver) {
  if (core === 'paper') {
    const builds = await paperJson('https://fill.papermc.io/v3/projects/paper/versions/' + ver + '/builds');
    if (!Array.isArray(builds) || !builds.length) throw new Error('Paper 没有 ' + ver + ' 的可用构建');
    const stable = builds.filter(b => String(b.channel || '').toUpperCase() === 'STABLE');
    const b = (stable.length ? stable : builds)[0]; /* 数组按构建号降序，取最新 */
    const a = b.downloads && (b.downloads['server:default'] || b.downloads.server);
    if (!a || !a.url) throw new Error('未找到 Paper ' + ver + ' 构建 ' + b.id + ' 的服务端下载地址');
    return {
      url: a.url,
      file: a.name || ('paper-' + ver + '-' + b.id + '.jar'),
      build: b.id,
      sha256: (a.checksums && a.checksums.sha256) || null,
      size: a.size || null
    };
  }
  if (core === 'purpur') {
    return { url: 'https://api.purpurmc.org/v2/purpur/' + ver + '/latest/download', file: 'server.jar' };
  }
  if (core === 'fabric') {
    const loaders = await fetchJson('https://meta.fabricmc.net/v2/versions/loader/' + ver);
    if (!loaders || !loaders.length) throw new Error('Fabric 没有 ' + ver + ' 的加载器');
    const loader = loaders[0].loader.version;
    const inst = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
    const installer = (inst && inst[0] && inst[0].version) || '1.0.1';
    return {
      url: 'https://meta.fabricmc.net/v2/versions/loader/' + ver + '/' + loader + '/' + installer + '/server/jar',
      file: 'fabric-server-launch.jar', loader
    };
  }
  /* vanilla */
  const man = await fetchJson(config.source === 'official'
    ? 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
    : MANIFEST_URL.bmclapi);
  const v = (man.versions || []).find(x => x.id === ver);
  if (!v) throw new Error('未找到原版版本 ' + ver);
  const vj = await fetchJson(mapUrl(v.url));
  if (!vj.downloads || !vj.downloads.server) throw new Error(ver + ' 没有官方服务端');
  return { url: mapUrl(vj.downloads.server.url), file: 'server.jar', sha1: vj.downloads.server.sha1 };
}
/* 服务端所需 Java 大版本（依据 Mojang/Paper 官方要求）
 * 1.12.2- → 8 | 1.13-1.16.5 → 8 | 1.17 → 16 | 1.18-1.20.4 → 17
 * 1.20.5-1.21.x → 21 | 26.1 及更高（a>=2）→ 25 */
function serverJavaMajor(ver) {
  const p = String(ver).split(/[.\-+]/).map(x => parseInt(x, 10) || 0);
  const a = p[0], b = p[1] || 0, c = p[2] || 0;
  if (a >= 2) return 25;
  if (b >= 21) return 21;
  if (b >= 20) return c >= 5 ? 21 : 17;
  if (b >= 18) return 17;
  if (b >= 17) return 16;
  return 8;
}
async function findServerJava(major) {
  const list = await detectJavaInner(false, major);   /* 缓存里挑得出来才走快速路径，否则老实重扫 */
  const ok = list.filter(j => j.major >= major).sort((x, y) => x.major - y.major);
  return ok[0] || null;
}
/* 服务端必须用 java.exe（控制台子系统）而非 javaw.exe：
 * javaw 没有控制台，JLine/控制台处理在管道 stdin 下容易在关闭阶段触发 JVM native 崩溃；
 * java.exe 配合 windowsHide 同样不会弹黑窗口，但标准流与 stdin 行为完全正常 */
function javaExeOf(p) {
  try {
    if (/^javaw\.exe$/i.test(path.basename(p))) {
      const alt = path.join(path.dirname(p), 'java.exe');
      if (fs.existsSync(alt)) return alt;
    }
  } catch (_) {}
  return p;
}
function writeServerProps(dir, o) {
  const src = o || {};
  const props = [
    ['server-port', parseInt(src.port, 10) || 25565],
    ['motd', String(src.motd == null ? '' : src.motd).replace(/[\r\n]+/g, ' ').slice(0, 120)],
    ['max-players', parseInt(src.maxPlayers, 10) || 20],
    ['online-mode', src.onlineMode === false ? 'false' : 'true'],
    ['difficulty', ['peaceful', 'easy', 'normal', 'hard'].includes(src.difficulty) ? src.difficulty : 'easy'],
    ['gamemode', ['survival', 'creative', 'adventure', 'spectator'].includes(src.gamemode) ? src.gamemode : 'survival'],
    ['level-name', 'world'],
    ['level-seed', String(src.seed || '').slice(0, 64)],
    ['pvp', 'true'],
    ['spawn-protection', '16'],
    ['view-distance', '10'],
    ['simulation-distance', '10'],
    ['allow-flight', 'false'],
    ['enable-command-block', 'false'],
    ['white-list', 'false'],
    ['sync-chunk-writes', 'false'],
    ['network-compression-threshold', '256']
  ];
  const txt = '#Minecraft server properties\n#由 XLC 启动器一键开服生成\n' +
    props.map(([k, v]) => k + '=' + v).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'server.properties'), txt, 'utf8');
}
function writeStartBat(dir, o) {
  const jar = o.jarFile;
  const mem = Math.max(512, parseInt(o.memMB, 10) || 2048);
  const flags = ['-Xms' + Math.min(mem, 1024) + 'M', '-Xmx' + mem + 'M'];
  /* 26.x 起 Paper 官方启动脚本推荐 jdk.incubator.vector（Java 25 自带） */
  if (Number(o.javaMajor) >= 25) flags.push('--add-modules=jdk.incubator.vector');
  flags.push('-XX:+UseG1GC');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    /* o.name 可能缺失（readServerMeta 回来的 meta 里没有 name）→ 兜底用目录名，
       否则 window title 会变成「undefined - XLC 服务器」 */
    'title ' + (o.name || path.basename(dir)) + ' - XLC 服务器',
    (o.javaExe ? '"' + o.javaExe + '"' : 'java') + ' ' + flags.join(' ') + ' -jar "' + jar + '" nogui',
    'echo.',
    'echo 服务器已退出，按任意键关闭窗口...',
    'pause >nul'
  ];
  fs.writeFileSync(path.join(dir, 'start.bat'), lines.join('\r\n'), 'utf8');
}
/* ---------------- 服务端 mod 同步（Fabric 服专用） ----------------
   Fabric 服必须装齐客户端里「两端都要装」（environment = * 或 server）的 mod。
   漏装的后果不是"少个功能"，而是**根本进不去**：客户端在配置阶段按服务端下发的注册表
   构建物品/唱片等对象时找不到对应注册项，直接抛异常断线 —— 玩家看到的是
   「网络协议错误 / 刚进服就被踢」，服务端日志只有一句 lost connection: Disconnected。
   典型报错：java.lang.IllegalStateException: Missing element ResourceKey[minecraft:jukebox_song / xxx] */
function jarEnvOf(file) {
  try {
    const t = zipReadEntry(fs.readFileSync(file), 'fabric.mod.json').toString('utf8');
    const m = /"environment"\s*:\s*"(client|server|\*)"/.exec(t);
    return m ? m[1] : '*';
  } catch (_) {
    /* 读不到元数据（Forge 系 / 元数据含非法控制字符解析不了）→ 按「两端都要装」处理，宁可多同步 */
    return '*';
  }
}
/* 客户端 mod 来源：指定实例 → 最近启动的实例 → 全局 mods → 各实例目录（按修改时间新→旧）
   最后一条是兜底：PCL 式版本隔离下 mod 都放在 versions/<实例>/mods，
   若 lastVersion 为空（新装的启动器还没启动过任何实例）也要能找到 */
function clientModsDirs(instance) {
  const out = [];
  const push = (d) => { if (d && fs.existsSync(d) && !out.includes(d)) out.push(d); };
  if (instance) push(modsDirFor(instance));
  push(modsDirFor(config.lastVersion));
  push(MODS_DIR());
  try {
    const vd = path.join(config.gameDir, 'versions');
    const cands = [];
    for (const n of fs.readdirSync(vd)) {
      const m = path.join(vd, n, 'mods');
      try { if (!fs.statSync(m).isDirectory()) continue; } catch (_) { continue; }
      cands.push({ m, t: fs.statSync(m).mtimeMs });
    }
    cands.sort((a, b) => b.t - a.t);
    for (const c of cands) push(c.m);
  } catch (_) {}
  return out;
}
ipcMain.handle('server:sync-mods', async (_e, p) => {
  try {
    if (!pluginEnabled('server')) throw new Error('插件「一键开服」已停用，请先在插件页启用');
    const o = p || {};
    const name = safeServerName(o.name);
    const dir = serverDirOf(name);
    const meta = readServerMeta(dir);
    if (!meta) throw new Error('服务器不存在或信息缺失');
    if (String(meta.core) !== 'fabric') {
      throw new Error('「' + name + '」是 ' + (meta.core || '未知') + ' 核心，不能加载 Fabric mod');
    }
    const dirs = clientModsDirs(o.instance);
    const outDir = path.join(dir, 'mods');
    fs.mkdirSync(outDir, { recursive: true });
    const preview = !!o.preview;
    const added = [], updated = [], clientOnly = [], failed = [];
    let from = '';
    for (const s of dirs) {
      let files = [];
      try { files = fs.readdirSync(s).filter(f => /\.jar$/i.test(f)); } catch (_) { continue; }
      if (!files.length) continue;
      from = s;
      for (const f of files) {
        const src = path.join(s, f);
        /* 纯客户端 mod（光影/优化/界面类）装了服务端也用不上，且 Fabric 会直接跳过，不必拷 */
        if (jarEnvOf(src) === 'client') { clientOnly.push(f); continue; }
        const dst = path.join(outDir, f);
        let srcStat = null;
        try { srcStat = fs.statSync(src); } catch (e) { failed.push(f + '（读取源文件失败）'); continue; }
        let need = true, isUpd = false;
        try {
          const b = fs.statSync(dst);
          /* 只比体积会漏：同体积但内容不同（换了构建 / 被替换过）原来会被判成「已同步」（审计 F5）。
             体积 + 毫秒级 mtime 足够区分实际改动，又不用给几百个 jar 逐个复算哈希。
             拷完把目标 mtime 对齐源文件（下面 utimesSync），否则每次同步都会因为 mtime 不同而重拷。 */
          need = srcStat.size !== b.size || Math.abs(srcStat.mtimeMs - b.mtimeMs) > 1;
          isUpd = true;
        } catch (_) { need = true; isUpd = false; }
        if (!need) continue;
        if (!preview) {
          try {
            fs.copyFileSync(src, dst);
            try { fs.utimesSync(dst, srcStat.atime, srcStat.mtime); } catch (_) {}
          } catch (e) { failed.push(f + '（' + e.message + '）'); continue; }
        }
        (isUpd ? updated : added).push(f);
      }
      break;   /* 只用第一个有 mod 的目录，避免把全局与实例目录混在一起 */
    }
    if (!from) throw new Error('没找到客户端的 mods 目录（先在启动器里装好/启动一个实例）');
    logLine('[server] 同步 mod → ' + name + '：新增 ' + added.length + '、更新 ' + updated.length +
      '、跳过纯客户端 ' + clientOnly.length + '、失败 ' + failed.length + '（来源 ' + from + '）');
    if (failed.length) logLine('[server] 同步失败的 mod: ' + failed.slice(0, 10).join(' / ') +
      (failed.length > 10 ? ' …' : ''));
    return { ok: true, from, dir: outDir, added, updated, clientOnly, failed, preview };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server:list', () => {
  const out = [];
  const lanList = lanIPv4();
  try {
    if (fs.existsSync(SERVERS_DIR)) {
      for (const n of fs.readdirSync(SERVERS_DIR)) {
        const d = path.join(SERVERS_DIR, n);
        try { if (!fs.statSync(d).isDirectory()) continue; } catch (_) { continue; }
        const meta = readServerMeta(d);
        if (!meta) continue;
        const live = SERVER_PROCS.get(n);
        /* 关键文件是否齐全（jar / eula / 配置 / 启动脚本），缺失时界面可提示重新创建 */
        const files = {};
        for (const [k, f] of Object.entries({
          jar: meta.jarFile || 'server.jar', eula: 'eula.txt',
          props: 'server.properties', bat: 'start.bat'
        })) {
          try { files[k] = fs.statSync(path.join(d, f)).isFile(); } catch (_) { files[k] = false; }
        }
        /* Fabric 服要装 mod 才进得去：数一下 mods/ 里有多少 jar，界面据此提示「未装 mod」 */
        let modsCount = 0;
        if (String(meta.core) === 'fabric') {
          try {
            const md = path.join(d, 'mods');
            if (fs.existsSync(md)) modsCount = fs.readdirSync(md).filter(f => /\.jar$/i.test(f)).length;
          } catch (_) {}
        }
        out.push(Object.assign({}, meta, {
          name: n, dir: d, files, modsCount,
          /* 连接地址：本机 + 局域网，界面直接展示，玩家不用再猜怎么进服 */
          addr: serverAddrOf(meta, lanList),
          /* 附带 server.properties 的真实取值：界面校验 / 排查「显示与生效不一致」 */
          props: readServerProps(d),
          running: !!(live && live.child && !live.exited)
        }));
      }
    }
  } catch (_) {}
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { ok: true, servers: out, dir: SERVERS_DIR, java: null, lan: lanList };
});
ipcMain.handle('server:create', async (_e, p) => {
  if (!pluginEnabled('server')) throw new Error('插件「一键开服」已停用，请先在插件页启用');
  netReset();
  const o = p || {};
  const name = safeServerName(o.name);
  const core = SERVER_CORES.some(c => c.id === o.core) ? o.core : 'paper';
  const ver = String(o.ver || '').trim();
  if (!/^[0-9][0-9A-Za-z._\-+ ]*$/.test(ver)) throw new Error('请选择游戏版本');
  const dir = serverDirOf(name);
  const memMB = Math.min(Math.max(parseInt(o.memMB, 10) || 2048, 512), 65536);
  fs.mkdirSync(dir, { recursive: true });
  const prog = (pct, text) => send('server:progress', { name, pct, text });
  try {
    prog(0, '解析下载地址…');
    const dl = await resolveServerDownload(core, ver);
    prog(2, '下载 ' + (core === 'paper' ? 'Paper' : core === 'purpur' ? 'Purpur' : core === 'vanilla' ? '原版' : 'Fabric') + ' 服务端 ' + ver + '…');
    const dest = path.join(dir, dl.file);
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        send('server:progress', { name, pct: 3, text: '下载中…' + (attempt > 1 ? '（第 ' + attempt + ' 次尝试）' : '') });
        await downloadSingle(dl.url, dest, (pct) => {
          prog(3 + Math.floor(Math.max(0, pct) * 0.87), '下载中… ' + Math.max(0, pct) + '%');
        });
        done = true;
      } catch (e) {
        if (attempt >= 3) throw new Error('服务端下载失败：' + e.message);
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    if (dl.sha1 || dl.sha256) {
      prog(91, '校验文件完整性…');
      const buf = await fsp.readFile(dest);
      if (dl.sha1 && sha1(buf) !== dl.sha1) throw new Error('服务端文件校验失败（SHA1 不一致），请重试');
      if (dl.sha256 && sha256(buf) !== dl.sha256) throw new Error('服务端文件校验失败（SHA256 不一致），请重试');
    }
    prog(93, '生成配置文件…');
    fs.writeFileSync(path.join(dir, 'eula.txt'),
      '#同意 Minecraft EULA 才能启动服务器（https://aka.ms/MinecraftEULA）\neula=true\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    /* 规范化一次：server.properties 与 xlc-server.json 必须基于同一份取值，
       否则会出现「启动器里显示 MOTD、服务端里却为空」这类不一致 */
    const cfg = {
      port: parseInt(o.port, 10) || 25565,
      motd: String(o.motd || (name + ' · XLC 服务器')).replace(/[\r\n]+/g, ' ').slice(0, 120),
      maxPlayers: parseInt(o.maxPlayers, 10) || 20,
      onlineMode: o.onlineMode !== false,
      difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(o.difficulty) ? o.difficulty : 'easy',
      gamemode: ['survival', 'creative', 'adventure', 'spectator'].includes(o.gamemode) ? o.gamemode : 'survival',
      seed: String(o.seed || '').slice(0, 64)
    };
    writeServerProps(dir, cfg);
    const meta = Object.assign({
      core, ver, build: dl.build || null, loader: dl.loader || null,
      jarFile: dl.file, memMB
    }, cfg, { createdAt: Date.now() });
    fs.writeFileSync(serverMetaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
    /* start.bat 里的 java 用当前探测到的最佳 Java（找不到则用 PATH 中的 java） */
    const need = serverJavaMajor(ver);
    const jv = await findServerJava(need).catch(() => null);
    writeStartBat(dir, Object.assign({}, meta, { jarFile: dl.file, javaExe: jv ? javaExeOf(jv.path) : '', javaMajor: jv ? jv.major : 0 }));
    prog(100, '创建完成');
    logLine('[server] 创建服务器 ' + name + ' · ' + core + ' ' + ver + ' · ' + dir);
    toast('服务器「' + name + '」创建完成，可以启动了');
    return { ok: true, name, dir, meta, addr: serverAddrOf(meta) };
  } catch (e) {
    /* 失败不留半成品：仅当目录是本次新建且无其他文件时清理 */
    try {
      const files = fs.readdirSync(dir);
      if (files.length <= 2) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
    logLine('[server] 创建失败 ' + name + ': ' + e.message);
    return { ok: false, error: e.message };
  }
});
/* 启动服务器：探测 Java → spawn（windowsHide）→ stdout/stderr 实时经 server:log 推送 */
ipcMain.handle('server:start', async (_e, p) => {
  const name = safeServerName(p && p.name);
  const dir = serverDirOf(name);
  const meta = readServerMeta(dir);
  if (!meta) throw new Error('服务器不存在或元数据缺失');
  const live = SERVER_PROCS.get(name);
  if (live && !live.exited) throw new Error(live.stopping ? '服务器正在关闭中，请稍候再启动' : '服务器已在运行中');
  const need = serverJavaMajor(meta.ver);
  let jv = await findServerJava(need);
  if (!jv) {
    /* 缺对应 Java 就直接装上，别让用户自己去设置页折腾 */
    try {
      const rj = await resolveJavaFor(need, null, meta.ver + ' 服务端');
      jv = { path: rj.path, major: need };
      send('server:log', { name, line: '[XLC] 本机没有 Java ' + need + '，已自动安装：' + rj.path });
    } catch (e) {
      logLine('[server] 自动安装 Java ' + need + ' 失败: ' + e.message);
      throw new Error('启动 ' + meta.ver + ' 服务端需要 Java ' + need + '，自动安装失败：' + e.message +
        '（也可到「设置 → Java 运行时」手动下载）');
    }
  }
  const jar = path.join(dir, meta.jarFile || 'server.jar');
  if (!fs.existsSync(jar)) throw new Error('服务端文件缺失：' + (meta.jarFile || 'server.jar') + '，请重新创建');
  const mem = Math.min(Math.max(parseInt(meta.memMB, 10) || 2048, 512), 65536);
  const javaExe = javaExeOf(jv.path);
  const args = ['-Xms' + Math.min(mem, 1024) + 'M', '-Xmx' + mem + 'M',
    '-XX:+UseG1GC', '-Dfile.encoding=UTF-8'];
  if (jv.major >= 25) args.push('--add-modules=jdk.incubator.vector');
  args.push('-jar', meta.jarFile || 'server.jar', 'nogui');
  const child = spawn(javaExe, args, { cwd: dir, windowsHide: true });
  const st = { child, exited: false, buf: '', port: meta.port, startedAt: Date.now() };
  SERVER_PROCS.set(name, st);
  send('server:log', { name, line: '[XLC] 启动命令: ' + javaExe + ' ' + args.join(' ') + '（Java ' + jv.major + '）' });
  send('server:state', { name, running: true, port: meta.port });
  logLine('[server] 启动 ' + name + ' · ' + javaExe + ' · Xmx=' + mem + 'M');
  setStatus('服务器运行中: ' + name, true);
  const stream = (data) => {
    st.buf += data.toString('utf8');
    const lines = st.buf.split(/\r?\n/);
    st.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      send('server:log', { name, line });
      /* 收到 stop 后，等世界保存完成（"All dimensions are saved" / "Closing Thread Pool"）
         再关闭 stdin —— 过早关闭会让控制台线程在保存过程中拿到 EOF，
         在 Windows 上容易触发 JVM 退出阶段的 native 崩溃（世界虽已保存但退出码非 0） */
      if (st.stopping && !st.stdinClosed &&
          /All dimensions are saved|Closing Thread Pool|Closing Server/i.test(line)) {
        st.stdinClosed = true;
        if (st.stdinFallback) { clearTimeout(st.stdinFallback); st.stdinFallback = null; }
        setTimeout(() => { try { st.child.stdin.end(); } catch (_) {} }, 500);
      }
    }
  };
  child.stdout.on('data', stream);
  child.stderr.on('data', stream);
  child.on('error', (err) => {
    st.exited = true;
    send('server:log', { name, line: '[XLC] 进程启动失败: ' + err.message });
    send('server:state', { name, running: false, port: meta.port, error: err.message });
    toast('服务器启动失败: ' + err.message, 'error');
  });
  child.on('exit', (code, signal) => {
    st.exited = true;
    if (st.killTimer) { clearTimeout(st.killTimer); st.killTimer = null; }
    if (st.stdinFallback) { clearTimeout(st.stdinFallback); st.stdinFallback = null; }
    send('server:log', {
      name,
      line: '[XLC] 服务器进程已退出 (code ' + code + (signal ? ', signal ' + signal : '') + ')'
        + (signal ? ' —— 进程被强制结束，世界可能未完整保存' : '')
    });
    send('server:state', { name, running: false, port: meta.port, code, signal: signal || null });
    setStatus('就绪');
    if (signal) toast('服务器「' + name + '」被强制结束，请优先使用「停止」以便保存世界', 'warn');
    else toast('服务器「' + name + '」已停止', code === 0 ? 'ok' : 'warn');
    setTimeout(() => { const c = SERVER_PROCS.get(name); if (c === st) SERVER_PROCS.delete(name); }, 1500);
  });
  return { ok: true, pid: child.pid, java: javaExe, memMB: mem, addr: serverAddrOf(meta) };
});
function serverProcOf(name) {
  const st = SERVER_PROCS.get(name);
  if (!st || st.exited || !st.child || st.stopping) return null;
  return st;
}
ipcMain.handle('server:stop', (_e, p) => {
  const name = safeServerName(p && p.name);
  const st = SERVER_PROCS.get(name);
  if (!st || st.exited) return { ok: false, error: '服务器未在运行' };
  if (st.stopping) return { ok: false, error: '服务器正在关闭中，请稍候' };
  st.stopping = true;
  try {
    st.child.stdin.write('stop\n');
    send('server:log', { name, line: '[XLC] 已发送停止指令，服务器保存世界后退出…' });
    /* stdin 的关闭时机：优先等世界保存完成的日志（见 stream），
       12 秒内没等到则兜底关闭，避免进程长期挂起 */
    if (!st.stdinFallback) {
      st.stdinFallback = setTimeout(() => {
        st.stdinFallback = null;
        if (!st.stdinClosed) {
          st.stdinClosed = true;
          try { st.child.stdin.end(); } catch (_) {}
        }
      }, 12000);
    }
    /* 兜底：大世界保存较慢，60 秒仍未退出则强制结束 */
    if (!st.killTimer) {
      st.killTimer = setTimeout(() => {
        st.killTimer = null;
        if (!st.exited) {
          try {
            send('server:log', { name, line: '[XLC] 服务器未在 60 秒内退出，已强制结束' });
            st.child.kill();
          } catch (_) {}
        }
      }, 60000);
    }
    return { ok: true };
  } catch (e) {
    st.stopping = false;
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('server:kill', (_e, p) => {
  const name = safeServerName(p && p.name);
  const st = SERVER_PROCS.get(name);
  if (!st || st.exited) return { ok: false, error: '服务器未在运行' };
  st.stopping = true;
  try {
    send('server:log', { name, line: '[XLC] 强制结束服务器进程（未保存的世界改动可能丢失）' });
    st.child.kill();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server:cmd', (_e, p) => {
  const name = safeServerName(p && p.name);
  const st = serverProcOf(name);
  if (!st) return { ok: false, error: '服务器未在运行' };
  const cmd = String((p && p.cmd) || '').replace(/[\r\n]/g, '').slice(0, 200);
  if (!cmd) return { ok: false, error: '命令为空' };
  try {
    st.child.stdin.write(cmd + '\n');
    send('server:log', { name, line: '> ' + cmd, self: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server:delete', async (_e, p) => {
  const name = safeServerName(p && p.name);
  if (serverProcOf(name)) throw new Error('服务器正在运行，请先停止');
  const dir = serverDirOf(name);
  if (!fs.existsSync(dir)) throw new Error('服务器目录不存在');
  try {
    await shell.trashItem(dir);
    logLine('[server] 已删除服务器 ' + name);
    return { ok: true };
  } catch (e) {
    /* 回收站不可用 → 直接删除（仅限 servers 目录内的自有目录） */
    if (dir.startsWith(SERVERS_DIR)) { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true, hard: true }; }
    throw e;
  }
});
ipcMain.handle('server:open-dir', (_e, p) => {
  const dir = serverDirOf(p && p.name);
  if (!fs.existsSync(dir)) throw new Error('目录不存在');
  shell.openPath(dir);
  return { ok: true };
});
/* 可用的 Java 列表（供开服面板显示与选择） */
ipcMain.handle('server:javas', async () => {
  try {
    const list = await detectJavaInner();
    return { ok: true, javas: list.map(j => ({ path: j.path, major: j.major, ver: j.ver || '' })) };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- 陶瓦联机（Terracotta，基于 EasyTier 的 P2P 联机）---------------- */
const TC_DIR = path.join(DATA_DIR, 'terracotta');
const TC_META = path.join(TC_DIR, 'meta.json');
const TC_PORT_FILE = path.join(TC_DIR, 'port.json');
const TC_FALLBACK_VERSION = '0.4.2';
const TC_GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];
let tcPort = 0;
let tcDownloading = false;
function tcExe() {
  /* 优先用数据目录里释放出来的 exe（打包版 asar 内的无法直接执行） */
  const local = path.join(TC_DIR, 'terracotta.exe');
  if (fs.existsSync(local)) return local;
  try { return JSON.parse(fs.readFileSync(TC_META, 'utf8')).exePath || local; } catch (_) { return local; }
}
/* 陶瓦联机组件（Terracotta）**不随包分发**：安装包里只带许可正文，核心在用户第一次用联机时
   由「下载陶瓦联机组件」按钮现下（GitHub Releases + 国内镜像，见 mp:download），
   这样安装包小一截，也不会让不用联机的人白背一个 9 MB 的 exe。
   下面是老包（≤1.2-snapshot 之前自带 exe 的版本）的兼容分支：包里要是还有就释放出来，没有就跳过。
   许可正文（AGPL-3.0）照旧释放到数据目录 —— 下载下来的是同一个二进制，副本该给还是给。 */
try {
  const bundled = path.join(__dirname, 'terracotta', 'terracotta.exe');
  if (fs.existsSync(bundled) && !fs.existsSync(path.join(TC_DIR, 'terracotta.exe'))) {
    fs.mkdirSync(TC_DIR, { recursive: true });
    fs.copyFileSync(bundled, path.join(TC_DIR, 'terracotta.exe'));
    try { fs.copyFileSync(path.join(__dirname, 'terracotta', 'meta.json'), TC_META); } catch (_) {}
  }
  const bundledLic = path.join(__dirname, 'terracotta', 'LICENSE.txt');
  const targetLic = path.join(TC_DIR, 'LICENSE.txt');
  if (fs.existsSync(bundledLic) && !fs.existsSync(targetLic)) {
    fs.mkdirSync(TC_DIR, { recursive: true });
    fs.copyFileSync(bundledLic, targetLic);
  }
} catch (_) {}
/* GitHub 直连与镜像双源（国内 gh-proxy 通常更快） */
async function tcFetchJson(url, ms) {
  let lastErr = null;
  for (const u of [url, ...TC_GH_MIRRORS.map(m => m + url)]) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA_STR }, signal: AbortSignal.timeout(ms || 8000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function tcAlive(p) {
  try {
    const res = await fetch('http://127.0.0.1:' + p + '/meta', { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_) { return false; }
}
ipcMain.handle('mp:status', async () => {
  const installed = fs.existsSync(tcExe());
  let version = '';
  try { version = JSON.parse(fs.readFileSync(TC_META, 'utf8')).version || ''; } catch (_) {}
  /* 端口文件可能是上次会话留下的，验证活性 */
  if (!tcPort) { try { tcPort = JSON.parse(fs.readFileSync(TC_PORT_FILE, 'utf8')).port || 0; } catch (_) {} }
  if (tcPort && !(await tcAlive(tcPort))) tcPort = 0;
  return { ok: true, installed, version, running: !!tcPort, port: tcPort };
});
ipcMain.handle('mp:download', async (_e, p) => {
  if (tcDownloading) return { ok: false, error: '正在下载中' };
  tcDownloading = true;
  try {
    await fsp.mkdir(TC_DIR, { recursive: true });
    /* 已安装完成（.ok 标记 + exe 存在）则直接返回成功（不必先问 GitHub API），
       避免重复点下载时循环整体跳过、抛出 "下载失败: null" 的误导性错误 */
    if (fs.existsSync(path.join(TC_DIR, 'tc-pkg.tar.gz') + '.ok') && fs.existsSync(tcExe())) {
      let cur = '';
      try { cur = JSON.parse(fs.readFileSync(TC_META, 'utf8')).version || ''; } catch (_) {}
      logLine('[联机] Terracotta v' + (cur || '?') + ' 已安装，跳过重复下载');
      return { ok: true, version: cur || TC_FALLBACK_VERSION, already: true };
    }
    let version = TC_FALLBACK_VERSION;
    try {
      const rel = await tcFetchJson('https://api.github.com/repos/burningtnt/Terracotta/releases/latest', 6000);
      if (rel && typeof rel.tag_name === 'string' && /^v?\d+\.\d+\.\d+/.test(rel.tag_name)) version = rel.tag_name.replace(/^v/, '');
    } catch (_) { /* API 不可达时用内置版本号 */ }
    const asset = 'https://github.com/burningtnt/Terracotta/releases/download/v' + version + '/terracotta-' + version + '-windows-x86_64-pkg.tar.gz';
    const pkg = path.join(TC_DIR, 'tc-pkg.tar.gz');
    const urls = [...TC_GH_MIRRORS.map(m => m + asset), asset]; /* 镜像优先（直连 GitHub 国内不通） */
    let lastErr = null;
    for (let round = 0; round < 2 && !fs.existsSync(pkg + '.ok'); round++) {
      if (round > 0) await new Promise(r => setTimeout(r, 1500));
      for (const u of urls) {
        try {
          fs.rmSync(pkg, { force: true });
          await downloadBig(u, pkg, (pct) => send('mp:progress', { stage: 'download', percent: pct }));
          send('mp:progress', { stage: 'extract', percent: 100 });
          break;
        } catch (e) { lastErr = e; }
      }
      if (!fs.existsSync(pkg)) continue;
      fs.rmSync(path.join(TC_DIR, 'pkg'), { recursive: true, force: true });
      await new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', pkg, '-C', TC_DIR], { windowsHide: true }, (err) => err ? reject(err) : resolve());
      });
      /* 找出解压出的 exe（可能在子目录） */
      let exe = null;
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          if (exe) return;
          const fp = path.join(d, f.name);
          if (f.isDirectory()) walk(fp);
          else if (/^terracotta.*\.exe$/i.test(f.name)) exe = fp;
        }
      };
      walk(TC_DIR);
      if (!exe) throw new Error('解压后未找到 terracotta.exe');
      if (path.resolve(exe) !== path.resolve(tcExe())) await fsp.rename(exe, tcExe()).catch(() => {});
      await fsp.writeFile(TC_META, JSON.stringify({ version, exePath: tcExe(), updatedAt: new Date().toISOString() }));
      fs.rmSync(pkg, { force: true });
      fs.writeFileSync(pkg + '.ok', 'ok');
      logLine('[联机] Terracotta v' + version + ' 下载安装完成');
      return { ok: true, version };
    }
    throw new Error('下载失败: ' + (lastErr && lastErr.message));
  } catch (e) { return { ok: false, error: e.message }; }
  finally { tcDownloading = false; }
});
ipcMain.handle('mp:start', async () => {
  try {
    if (!fs.existsSync(tcExe())) return { ok: false, error: '未安装陶瓦联机组件' };
    if (tcPort && await tcAlive(tcPort)) return { ok: true, port: tcPort };
    fs.rmSync(TC_PORT_FILE, { force: true });
    const child = spawn(tcExe(), ['--hmcl', TC_PORT_FILE], { stdio: 'ignore', detached: false });
    child.unref();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await new Promise(r => setTimeout(r, 400));
      try {
        const j = JSON.parse(fs.readFileSync(TC_PORT_FILE, 'utf8'));
        if (j.port && await tcAlive(j.port)) { tcPort = j.port; return { ok: true, port: tcPort }; }
      } catch (_) {}
    }
    throw new Error('陶瓦服务启动超时（15 秒）');
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mp:state', async () => {
  if (!tcPort) return { ok: false, error: 'not-running' };
  try {
    const res = await fetch('http://127.0.0.1:' + tcPort + '/state/', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const j = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
    return { ok: true, state: j };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mp:act', async (_e, p) => {
  try {
    if (!tcPort) return { ok: false, error: 'not-running' };
    const q = new URLSearchParams();
    if (p.player) q.set('player', String(p.player).slice(0, 16));
    if (p.room) q.set('room', String(p.room).trim().toUpperCase());
    if (p.publicNodes && Array.isArray(p.publicNodes)) p.publicNodes.slice(0, 4).forEach(n => q.append('public_nodes', n));
    const url = 'http://127.0.0.1:' + tcPort + '/state/' + p.action + (q.toString() ? '?' + q.toString() : '');
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mp:stop', async () => {
  try {
    if (tcPort) { await fetch('http://127.0.0.1:' + tcPort + '/panic?peaceful=true', { signal: AbortSignal.timeout(3000) }).catch(() => {}); }
  } catch (_) {}
  try { execFile('taskkill', ['/F', '/IM', 'terracotta.exe'], { windowsHide: true }, () => {}); } catch (_) {}
  tcPort = 0;
  fs.rmSync(TC_PORT_FILE, { force: true });
  return { ok: true };
});
app.on('before-quit', (e) => {
  /* 退出打点：日志里看到这一行 = 走的是正常退出流程（关窗 / 更新替换）。
     看不到这一行、日志却停在某处 = 非正常死亡（原生崩溃 / 被外部杀掉），
     与「用户点了关闭」可以一眼区分开。 */
  logLine('[app] before-quit —— 收到退出请求（正常关闭流程）');
  try {
    if (tcPort) { fetch('http://127.0.0.1:' + tcPort + '/panic?peaceful=true', { signal: AbortSignal.timeout(1500) }).catch(() => {}); tcPort = 0; }
  } catch (_) {}
  /* 自动备份保护（审计 F2）：玩家关掉游戏后 2.5 秒内关启动器，或者备份正在写 zip 时关启动器，
     原来的实现会让这次备份**静默消失**（定时器随进程死掉 / zip 留半截）。
     这里先拦下退出：还在延迟里就立刻开始备份，已经在跑就等它，最多 3 秒。
     超时放弃并写日志 —— 宁可少等，也不能让启动器关不掉。 */
  if (!QUIT_BAK_WAITED && (EXIT_BAK_TIMER || BAK_INFLIGHT)) {
    QUIT_BAK_WAITED = true;
    e.preventDefault();
    if (EXIT_BAK_TIMER) { clearTimeout(EXIT_BAK_TIMER); EXIT_BAK_TIMER = null; logLine('[backup] 退出时发现待执行的「退出后备份」，立即开始'); }
    const job = (BAK_INFLIGHT || autoBackupSaves('exit', 90000)).catch(() => {});
    const timeout = new Promise(r => setTimeout(() => r('timeout'), 3000));
    Promise.race([job, timeout]).then(r => {
      logLine(r === 'timeout'
        ? '[backup] 退出等待超时（3s），放弃未完成的自动备份'
        : '[backup] 退出前已等待自动备份完成');
      app.quit();
    });
  }
});
app.on('will-quit', () => {
  logLine('[app] will-quit —— 进程即将结束');
  /* 好友在线状态：清掉 30s 心跳与重连定时器，别让定时器拖到进程收尾（审计 B5） */
  try { presenceStop(); } catch (_) {}
  /* 本地皮肤服务只在这台机器上、只服务本进程启动的游戏；退出时一并关掉，
     免得端口留着、旧注册表被下一次启动复用（注册表本来就该随进程生灭）。 */
  stopSkinServer();
});

/* ---------------- 诊断：游戏崩溃分析 ---------------- */
/* 规则引擎：从崩溃报告 / 日志识别已知错误原因并给出修复建议。
 * 匹配分两档：在崩溃报告里命中 = 确定原因（tier:'sure'）；只在日志里命中 = 疑似原因（tier:'maybe'）。
 * 分析不限日志新旧 —— 选哪份报告就分析哪份，新鲜度只用来标记「是不是刚刚发生的」。 */
const CRASH_RULES = [
  { re: /UnsupportedClassVersionError|class file version .* this version/i, title: 'Java 版本过旧', why: '当前使用的 Java 无法运行这个版本的游戏（class 文件版本不受支持）。', fix: '在「设置 → 检测 Java」里选用更高版本的 Java（26.x 需要 Java 21+；老版本需要 Java 8）。启动器会自动安装官方运行时。' },
  { re: /OutOfMemoryError|Could not reserve enough space|Ran out of memory/i, title: '内存不足（OOM）', why: '游戏堆内存耗尽。MOD 越多、渲染距离越大，需要的内存越多。', fix: '「游戏设置 → 基础设置 → 内存」调大分配（建议 6-8G）；也可以开启智能内存分配。' },
  { re: /Invalid maximum heap size|Could not reserve enough space for object heap/i, title: '内存参数超出限制', why: '分配的内存超过了当前 Java（通常是 32 位）能接受的上限。', fix: '装 64 位 Java（设置 → Java 运行时可自动安装），再把内存调到 32 位上限以内（约 1.5G）。' },
  { re: /ModResolutionException|Missing or unsupported mandatory dependencies|Missing mods/i, title: 'MOD 依赖缺失', why: '有 MOD 的前置（依赖）MOD 没装或版本不对。', fix: '看崩溃报告里 requires 后面的依赖名，到「下载 → MOD」安装对应前置；或直接删除不需要的 MOD。' },
  { re: /Incompatible mod set!|incompatible mods set|found incompatible mod/i, title: 'MOD 兼容冲突', why: 'MOD 之间声明的环境互相冲突（通常是同一 MOD 装了两份或加载器不匹配）。', fix: '到「游戏设置 → MOD 管理」检查是否重复安装；确认 MOD 是给当前加载器（Fabric/Forge）的版本。' },
  { re: /MixinApplyError|Critical injection failure|Mixin .* failed|MixinTargets not matched/i, title: 'Mixin 注入失败', why: '某个 MOD 的代码注入与当前游戏版本或其他 MOD 不兼容。', fix: '把报错里提到的 MOD 更新到与当前 MC 版本匹配的版本，或暂时禁用它验证。' },
  { re: /Duplicate mod|Duplicate Mods|duplicated mod|DuplicateModsFoundException/i, title: 'MOD 重复安装', why: '同一个 MOD（可能新旧不同文件名）被装了两份。', fix: '在「游戏设置 → MOD 管理」删除其中一个（注意 .disabled 文件不算，但要留意类似 xxx-1.0 和 xxx-1.2 并存的情况）。' },
  { re: /requires minecraft (\d+\.\d+(?:\.\d+)?)/i, title: '游戏版本不匹配', why: 'MOD 声明它只支持特定的 Minecraft 版本，与当前实例不符。', fix: '换用与实例版本匹配的 MOD 版本（下载页会按版本筛选；安装时也会检测提示）。' },
  { re: /Attempting to load a Fabric mod .* (?:with|on) .*Forge|Found 1 Fabric mod .* Forge|not a Forge mod/i, title: '加载器不匹配（Fabric MOD 装在了 Forge 实例）', why: 'MOD 的加载器和实例不一致。', fix: '到「下载 → MOD」筛选与实例相同的加载器重新下载；删掉装错的 jar。' },
  { re: /Attempting to load a Forge mod .* Fabric|is not a Fabric mod|fabric.*(?:incompatible|non-fabric)/i, title: '加载器不匹配（Forge MOD 装在了 Fabric 实例）', why: 'MOD 的加载器和实例不一致。', fix: '到「下载 → MOD」筛选与实例相同的加载器重新下载；删掉装错的 jar。' },
  { re: /GL_KHR|OpenGL|GLError|pixel format|Failed to create window|dxdiag|GLFW (?:error|init)|Unable to (?:create|initialize) GLFW/i, title: '显卡 / OpenGL 问题', why: '显卡驱动或 OpenGL 环境异常（常见于集显、远程桌面或老驱动）。', fix: '更新显卡驱动；笔记本双显卡时在显卡控制面板里强制游戏使用独立显卡。' },
  { re: /Access is denied|Permission denied|OptiFine.*unable|Unable to (?:write|create|access)/i, title: '文件权限问题', why: '游戏目录里有文件被占用或权限不足（常见：杀毒软件锁定）。', fix: '把游戏目录加入杀毒软件白名单，关闭占文件的程序后重试。' },
  { re: /Failed to (?:download|verify)|Error downloading|Could not (?:download|resolve)/i, title: '资源下载失败', why: '启动时下载库文件 / 资源文件失败（网络波动）。', fix: '重试启动；必要时在「设置」里切换下载源。' },
  { re: /mod\.toml|META-INF.*mod|Invalid mod|not a valid (?:jar|mod)/i, title: '损坏的 MOD 文件', why: '某个 jar 文件下载不完整或已损坏。', fix: '在「游戏设置 → MOD 管理」删除报错文件后重新下载。' },
  /* ---- 扩充规则（v2）---- */
  { re: /InaccessibleObjectException|Unable to make .* accessible|module .* does not .* (?:opens|export)|cannot access class .* module .* does not/i, title: 'Java 版本过新（模块系统拦截）', why: '游戏或 MOD 用了 Java 模块系统不允许的反射访问，常见于用太新的 Java 跑老游戏。', fix: '改用与游戏版本匹配的 Java（1.17→Java 16、1.18~1.20.4→Java 17、1.20.5+→Java 21）；启动器会按版本自动选。' },
  { re: /NoClassDefFoundError/i, title: '依赖库缺失或损坏', why: '运行时找不到某个类——通常是库文件损坏、被杀毒软件误删，或 MOD 前置版本不对。', fix: '看报错里缺的类属于哪个 MOD/库，重装对应 MOD；确认游戏文件完整（必要时重装该版本）。' },
  { re: /java\.lang\.StackOverflowError/i, title: '调用栈溢出（递归冲突）', why: '代码无限递归——常见于 MOD 事件互相触发或配置死循环。', fix: '按崩溃栈里反复出现的 MOD 名排查，先禁用最可疑的 MOD 验证。' },
  { re: /Bad magic number|VerifyError|IncompatibleClassChangeError/i, title: '类文件损坏', why: '某个 jar 里的字节码损坏（下载不完整、磁盘错误或被杀毒软件改写）。', fix: '删除报错对应的 jar 后重新下载；必要时重装该实例的加载器。' },
  { re: /Could not find or load main class|Main class .* (?:not found|missing)/i, title: '启动主类缺失', why: '加载器/游戏核心文件没装全，JVM 找不到入口类。', fix: '到「游戏设置 → 修改」重装一次加载器；确认实例目录里 libraries 完整（不要手动删）。' },
  { re: /nightconfig|Parsing error.*\.toml|Failed to (?:load|parse) (?:the )?config|ConfigFileNotFoundException|TomlParseError/i, title: 'MOD 配置文件损坏', why: '某个 MOD 的配置文件（.toml/.json）内容损坏或版本不兼容。', fix: '到实例 config 目录把报错里提到的配置文件删掉（或改后缀备份），重启游戏让它重新生成。' },
  { re: /# A fatal error has been detected|SIGSEGV|EXCEPTION_ACCESS_VIOLATION|EXCEPTION_ILLEGAL_INSTRUCTION/i, title: 'JVM 原生崩溃', why: 'Java 虚拟机本身崩了——多半是显卡驱动、系统库或内存条不稳定，游戏 MOD 一般管不到这一层。', fix: '更新显卡驱动；关闭超频/内存超频；到实例目录找 hs_err_pid*.log 把「Problematic frame」里的模块名对号入座。' },
  { re: /Connection refused|UnknownHostException|SocketTimeoutException|Connection timed out/i, title: '网络连接失败', why: '游戏或 MOD 连不上服务器（联机、正版会话、在线资源）。', fix: '检查网络与代理；联机看服务器地址与端口；正版会话问题可稍后重试。' },
  { re: /Invalid session|Failed to verify username|Session servers|bound to a profile|authentication servers are down/i, title: '会话验证失败', why: '以离线/外置登录身份进入了要求正版会话的服务器，或会话服务器暂时不可用。', fix: '正版服务器需要微软正版账户登录；外置登录确认认证服务器地址与账号正确。' },
  { re: /Failed to (?:create|compile|link) (?:the )?shader|GLSL|ShaderLinkException|shader.*(?:error|failed)|Iris.*(?:error|fatal)/i, title: '光影 / 着色器加载失败', why: '光影包与当前显卡或游戏版本不兼容（部分光影只支持较新的显卡特性）。', fix: '换一个光影包试试；更新显卡驱动；确认光影包支持当前游戏版本与 Iris/OptiFine。' },
  { re: /IOException.*region|AnvilParser|corrupt(?:ed)? (?:chunk|region|save)|MalformedNBT|Tried to load a block entity|Failed to (?:read|load) (?:chunk|level)/i, title: '存档 / 区块损坏', why: '存档文件部分损坏（强退、磁盘故障或版本降级都可能导致）。', fix: '先备份整个存档；用 MCEdit/NBTExplorer 删掉损坏区块；测试实例建议开「版本隔离」避免互相影响。' }
];

/* 解析崩溃报告结构：Description / 首个异常 / Caused by 链 / Suspected Mods / 证据行 */
function parseCrashReport(text) {
  const lines = text.split('\n');
  let desc = null;
  const di = lines.findIndex(l => /^Description:\s*/.test(l));
  if (di >= 0 && lines[di + 1] && lines[di + 1].trim()) desc = lines[di + 1].trim().slice(0, 180);
  if (!desc) {
    const ex = lines.find(l => /(?:Exception|Error)\b/.test(l) && !/^\s*at /.test(l) && l.trim());
    if (ex) desc = ex.trim().slice(0, 180);
  }
  const head = (lines.find(l => /(?:Exception|Error)\b/.test(l) && l.trim()) || '').trim().slice(0, 180);
  const causedBy = lines.filter(l => /^\s*Caused by:/.test(l)).map(l => l.trim().slice(0, 180)).slice(0, 4);
  const suspected = [];
  const susIdx = lines.findIndex(l => /Suspected Mods:/i.test(l));
  if (susIdx >= 0) {
    for (let i = susIdx + 1; i < lines.length && suspected.length < 10; i++) {
      const l = lines[i].trim();
      if (!l || /^(?:Stacktrace|Detail|System Details)/i.test(l)) break;
      const m = l.match(/(\S+\.jar)/i);
      if (m) suspected.push(path.basename(m[1]));
    }
  }
  for (const l of lines) {
    const m = l.match(/-->\s*(?:MOD )?(\S+\.jar)/i);
    if (m) suspected.push(path.basename(m[1]));
  }
  const evidence = [];
  for (const l of lines) {
    const s = l.trim();
    if (!s) continue;
    if (/(?:Exception|Error)\b/.test(s) || /^\tat /.test(l) || /^Caused by/.test(s) || /^Description/.test(s)) {
      evidence.push(l.length > 220 ? l.slice(0, 220) + '…' : l);
      if (evidence.length >= 12) break;
    }
  }
  return { desc, head, causedBy, suspected: [...new Set(suspected)], evidence };
}

function findCrashFiles(gameDir, instanceId) {
  const roots = [gameDir];
  /* 版本隔离实例的崩溃报告在 versions/<id>/ 下 */
  if (instanceId && safeInstanceDir(instanceId)) {
    const vDir = path.join(gameDir, 'versions', instanceId);
    try { if (fs.statSync(vDir).isDirectory()) roots.unshift(vDir); } catch (_) {}
  }
  const out = { report: null, log: null };
  for (const root of roots) {
    if (!out.report) {
      const dir = path.join(root, 'crash-reports');
      try {
        const files = fs.readdirSync(dir).filter(f => /^crash-.*\.txt$/i.test(f));
        if (files.length) {
          const newest = files.map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
          out.report = { path: path.join(dir, newest.f), time: newest.t };
        }
      } catch (_) {}
    }
    if (!out.log) {
      const p = path.join(root, 'logs', 'latest.log');
      try { const st = fs.statSync(p); out.log = { path: p, time: st.mtimeMs }; } catch (_) {}
    }
  }
  return out;
}

/* 列出实例可诊断的崩溃报告（不限时间），带解析出的异常标题供下拉选择。
 * 指定隔离实例时只列该实例的 reports（不混入全局的，避免排序抢位）；未指定才列全局。 */
function listCrashReports(gameDir, instanceId) {
  const roots = [];
  if (instanceId) {
    if (safeInstanceDir(instanceId)) {
      const vDir = path.join(gameDir, 'versions', instanceId);
      try { if (fs.statSync(vDir).isDirectory()) roots.push(vDir); } catch (_) {}
    }
  } else {
    roots.push(gameDir);
  }
  if (!roots.length) return [];
  const out = [];
  for (const root of roots) {
    const dir = path.join(root, 'crash-reports');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^crash-.*\.txt$/i.test(f)); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        const fh = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(Math.min(st.size, 4096));
        fs.readSync(fh, buf, 0, buf.length, 0);
        fs.closeSync(fh);
        const p = parseCrashReport(buf.toString('utf8'));
        out.push({
          path: fp, time: st.mtimeMs,
          fresh: Date.now() - st.mtimeMs < 30 * 60 * 1000,
          headline: (p.desc || p.head || '（未识别到异常行）').slice(0, 130)
        });
      } catch (_) {}
    }
  }
  out.sort((a, b) => b.time - a.time);
  return out.slice(0, 30);
}

async function readLogTail(p, bytes = 300000) {
  try {
    const st = fs.statSync(p);
    const fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(Math.min(st.size, bytes));
    await fh.read(buf, 0, buf.length, Math.max(0, st.size - buf.length));
    await fh.close();
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

async function diagnoseGameCrash(gameDir, instanceId, reportPath, logOnly) {
  const files = findCrashFiles(gameDir, instanceId);
  const now = Date.now();
  const FRESH = 30 * 60 * 1000;
  /* 选定要分析的崩溃报告：显式指定 > 实例最新 > 全局最新（都不限时间）；
     logOnly=true 时一律不读报告，只分析 latest.log */
  let chosen = null;
  if (!logOnly) {
    if (reportPath) {
      try { chosen = { path: reportPath, time: fs.statSync(reportPath).mtimeMs }; }
      catch (_) { return { found: false, note: '所选崩溃报告文件不存在或已被移动。' }; }
    } else if (files.report) chosen = files.report;
  }
  let reportText = '';
  if (chosen) { try { reportText = fs.readFileSync(chosen.path, 'utf8'); } catch (_) {} }
  const logText = files.log ? await readLogTail(files.log.path) : '';
  const reportFresh = !!(chosen && now - chosen.time < FRESH);
  const logFresh = !!(files.log && now - files.log.time < FRESH);
  if (!reportText && !logText.trim()) {
    return { found: false, note: instanceId ? '该实例没有崩溃报告，也没有可分析的游戏日志。' : '没有崩溃报告，也没有可分析的游戏日志。' };
  }

  const parsed = reportText ? parseCrashReport(reportText) : null;
  /* 规则匹配：报告命中 = 确定原因，仅日志命中 = 疑似原因 */
  const rules = [];
  for (const r of CRASH_RULES) {
    const mR = reportText ? reportText.match(r.re) : null;
    const mL = logText ? logText.match(r.re) : null;
    if (mR) rules.push({ title: r.title, why: r.why, fix: r.fix, match: mR[0].slice(0, 120), tier: 'sure', src: '崩溃报告' });
    else if (mL) rules.push({ title: r.title, why: r.why, fix: r.fix, match: mL[0].slice(0, 120), tier: 'maybe', src: '游戏日志' });
  }
  /* 提取涉及的 MOD 文件名 */
  const haystack = reportText + '\n' + logText;
  const modsInvolved = [];
  const modRe = /(?:mods[/\\])?([\w\-\.\[\]\u4e00-\u9fff+ ]+\.jar(?:\.disabled)?)/gi;
  let mm; const seen = new Set();
  while ((mm = modRe.exec(haystack)) && modsInvolved.length < 8) {
    const tail = mm[1].match(/[\w\-\.\[\]\u4e00-\u9fff+]+\.(?:jar(?:\.disabled)?)$/i);
    const n = tail ? tail[0] : '';
    if (n && /\.jar(\.disabled)?$/i.test(n) && !seen.has(n)) { seen.add(n); modsInvolved.push(n); }
  }
  if (parsed && parsed.suspected.length) for (const n of parsed.suspected) {
    if (modsInvolved.length >= 10) break;
    if (!seen.has(n)) { seen.add(n); modsInvolved.unshift(n); }
  }
  /* 游戏要求的 Java 版本（class file version → Java 大版本） */
  let javaNeed = null;
  const cfv = haystack.match(/class file version ([\d.]+)/i);
  if (cfv) { const v = parseFloat(cfv[1]); javaNeed = Math.max(8, Math.round(v - 44)); }
  /* 无报告时展示日志里的错误行 */
  const errorLines = [];
  if (!reportText && logText) {
    for (const l of logText.split('\n')) {
      if (/\/ERROR\]|\bException\b|\bERROR\b/.test(l)) {
        errorLines.push(l.length > 220 ? l.slice(0, 220) + '…' : l);
        if (errorLines.length >= 8) break;
      }
    }
  }
  const clean = !reportText && !rules.length && !errorLines.length && !!logText.trim();
  const excerpt = (reportText || logText || '').slice(-6000);
  return {
    found: true,
    reportPath: chosen ? chosen.path : null,
    logPath: files.log ? files.log.path : null,
    reportFresh, logFresh,
    headline: parsed ? parsed.desc : null,
    causedBy: parsed ? parsed.causedBy : [],
    evidence: parsed ? parsed.evidence : errorLines,
    logOnly: !reportText,
    clean, rules, modsInvolved, javaNeed, excerpt, instance: instanceId || ''
  };
}

/* AI 深度分析（OpenAI 兼容接口，用户在诊断页配置） */
async function aiDiagnose(excerpt, rules) {
  const api = config.aiApi || {};
  if (!api.base || !api.key) throw new Error('请先在下方填写 AI 接口地址与 API Key（任意 OpenAI 兼容接口均可）');
  const rulesTxt = rules.length ? rules.map(r => '- ' + r.title + '：' + r.why).join('\n') : '（内置规则未识别出确定原因）';
  const prompt = '你是一名 Minecraft（Java 版）启动器与模组故障排查专家。下面是一次游戏崩溃的内置规则初诊结果与崩溃报告/日志摘录。请用简体中文回答：\n1. 最可能的崩溃原因（按可能性排序，不超过 3 条）\n2. 每条原因给出具体可操作的修复步骤\n3. 如果是 MOD 版本/依赖问题，指出具体是哪个 MOD、需要什么版本。\n回答要简洁实用，不要客套。\n\n【内置规则初诊】\n' + rulesTxt + '\n\n【崩溃报告/日志摘录】\n' + excerpt.slice(0, 6000);
  const base = api.base.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api.key },
    body: JSON.stringify({ model: api.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('AI 接口 HTTP ' + res.status + (t ? ' · ' + t.slice(0, 200) : ''));
  }
  const j = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('AI 返回内容为空');
  return text;
}

/* ---------------- 版本更新检测 / 自更新 ----------------
 * 更新源（1.2 起）= GitHub Releases 优先、官方下载页兜底：
 *   ① GitHub Releases（GH_RELEASE_API）：版本、公告、附件全在仓库里，发版即生效；
 *   ② 官方下载页（UPDATE_DEFAULT_URL）：页面里的 XLC-Launcher-<版本>-Setup.exe /
 *      XLC-Launcher-<版本>-portable.exe 是权威来源，版本号从文件名解析（回退页面文案），
 *      同时解析出下载直链与版本说明；返回 JSON（{version, notes, downloads}）同样兼容。
 * GitHub 连不上（被墙 / 限流 / 超时）时自动回退 ②，用户无感。
 * 开发态（未打包）可用环境变量 XLC_UPDATE_URL 指向本地调试页 —— 此时跳过 GitHub，
 * 直接走页面源（保证测试封闭性）。 */
const UPDATE_DEFAULT_URL = 'https://neo2-pan.app.workbuddy.host/index5.html';
const UPDATE_TIMEOUT = 20000;
const GH_RELEASE_API = 'https://api.github.com/repos/byzgdneo2/XLC-Launcher/releases/latest';
/* 给「打开下载页」用的人类可读地址：API 端点返回的是 JSON，不能让用户点开看一坨数据 */
const GH_RELEASE_PAGE = 'https://github.com/byzgdneo2/XLC-Launcher/releases/latest';
const GH_UPDATE_TIMEOUT = 12000;
/* ---------------- 更新源锁定（安全） ----------------
 * 只认内置的官方源（GitHub Releases + 官方下载页）。早期版本允许在设置里自定义更新源
 * （config.updateUrl），这里一律忽略 —— 否则别人改一下配置文件、或诱导用户在设置页换个地址，
 * 就能让启动器从伪造页面读取「新版本」，进而下载并运行任意 exe 覆盖启动器。
 * 唯一例外：开发态（未打包）可以用环境变量 XLC_UPDATE_URL 指向本地调试页。 */
function updateSourceUrl() {
  if (!app.isPackaged) {
    const dev = String(process.env.XLC_UPDATE_URL || '').trim();
    if (dev) return dev;
  }
  return UPDATE_DEFAULT_URL;
}
/* 传进来的地址是否是官方源（空 = 未指定，允许；渲染层只传空） */
function isOfficialSource(u) {
  const s = String(u || '').trim();
  if (!s) return true;
  return s === updateSourceUrl() || s === UPDATE_DEFAULT_URL || s === GH_RELEASE_API;
}
/* 更新包只允许从官方更新源所在主机下载（防下载阶段被换成第三方地址）。
   GitHub 直链（github.com/…/releases/download/…）会 302 到附件域，一并放行。 */
function updateHostAllowed(u) {
  try {
    const host = new URL(String(u)).hostname.toLowerCase();
    const allow = new Set([new URL(updateSourceUrl()).hostname.toLowerCase()]);
    if (!app.isPackaged) { allow.add('127.0.0.1'); allow.add('localhost'); }
    allow.add('github.com');
    allow.add('objects.githubusercontent.com');
    allow.add('release-assets.githubusercontent.com');
    return allow.has(host);
  } catch (_) { return false; }
}
/* 历史遗留：老配置里的自定义更新源已失效，启动时清掉并留痕 */
if (config.updateUrl) {
  try { console.log('[update] 清除历史自定义更新源（已锁定为官方地址）：' + config.updateUrl); } catch (_) {}
  config.updateUrl = '';
  saveConfigNow();
}

/* 版本号比较：'Beta 1.0' / 'beta1.0' / 'Beta1.0' 视为同一版本。
 * 把版本号拆成「目标版本 + 阶段」两段来比：
 *   - 目标版本 = 阶段关键字**之前**的数字段（'1.1-snapshot1' → 1.1；纯 '1.0' → 1.0）。
 *     于是 1.1-snapshot1 > 1.0（目标版本 1.1 比 1.0 新），
 *     而 1.1-snapshot1 < 1.1（同一个目标版本，正式版盖过快照）。
 *   - 关键字之前没有数字的，是早期 0 系列预发布的老写法（Beta1.0 → Pre1 → RC1 → 正式版 1.0），
 *     目标版本记 0 系列 —— 这条必须保留：任何正式版都要盖过它们，否则预发布用户收不到正式版。
 * 比较顺序：目标版本逐段 → 阶段 rank（release > rc > pre > beta > snapshot/alpha）→ 剩余数字段
 * （快照 / RC 的计数器：Pre1 < Pre2、1.1-snapshot1 < 1.1-snapshot2）。返回 1 / 0 / -1 */
const VER_STAGE_RANK = { alpha: 1, snapshot: 1, beta: 2, pre: 3, preview: 3, rc: 4, release: 5, stable: 5 };
function normVer(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_]+/g, ''); }
function verParts(v) {
  const s = normVer(v).replace(/^v/, '');
  const sm = s.match(/(alpha|beta|rc|preview|snapshot|pre|release|stable)/);
  const stage = sm ? sm[1] : 'release';
  const head = sm ? s.slice(0, sm.index) : s;            /* 阶段关键字之前的部分 */
  const nums = (s.match(/\d+/g) || []).map(n => parseInt(n, 10));
  const lead = (head.match(/\d+/g) || []).map(n => parseInt(n, 10));
  /* 老写法（Beta1.0 / Pre1 / RC1：关键字前没有数字）→ 目标版本视为 0 系列 */
  const base = lead.length ? lead : ((stage === 'release' || stage === 'stable') ? nums : []);
  return { stage, rank: VER_STAGE_RANK[stage] || 0, base, tail: nums.slice(base.length) };
}
function segCmp(p, q) {
  const n = Math.max(p.length, q.length);
  for (let i = 0; i < n; i++) {
    const u = p[i] || 0, w = q[i] || 0;
    if (u !== w) return u > w ? 1 : -1;
  }
  return 0;
}
function compareVer(a, b) {
  const x = verParts(a), y = verParts(b);
  const byBase = segCmp(x.base, y.base);
  if (byBase) return byBase;
  if (x.rank !== y.rank) return x.rank > y.rank ? 1 : -1;
  return segCmp(x.tail, y.tail);
}
/* 是否是「快照 / 预发布」版本（相对正式版）：1.1-snapshot1、Beta1.0、Pre1、RC1 都算；
   纯版本号（1.0 / 1.1 / 1.2.0）算正式版。设置里的「跳过快照版更新」据此判断。 */
function isPreVer(v) {
  const s = verParts(v).stage;
  return s !== 'release' && s !== 'stable';
}
/* 「跳过快照版更新」的判定（纯函数，便于离线自测）：
   pre=更新源上的版本是快照 / 预发布；skipped=按设置应当跳过它。
   注意 skipped 只看「是不是预发布 + 开关开没开」，是否真的「有更新」由 compareVer 决定（调用方再与 cmp > 0 相与）。 */
function preUpdateDecision(remoteVer, skipEnabled) {
  const pre = isPreVer(remoteVer);
  return { pre, skipped: pre && !!skipEnabled };
}
/* 相对链接 → 绝对 URL（更新页里的下载直链是相对路径，如 pan/xlc-launcher/xxx.exe） */
function absUrl(u, base) {
  try { return new URL(String(u), base).href; } catch (_) { return String(u || ''); }
}
/* 官方网盘的下载目录：版本回退一律从这里下 —— 官网是唯一的分发口，
   不从 GitHub 附件下（GitHub 只负责「发现版本 / 读公告」） */
const OFFICIAL_PAN_BASE = absUrl('pan/xlc-launcher/', UPDATE_DEFAULT_URL);
function officialDlUrl(name) {
  const n = String(name || '').trim();
  return n ? OFFICIAL_PAN_BASE + encodeURIComponent(n) : OFFICIAL_PAN_BASE;
}
function isOfficialPanUrl(u) {
  return /^https:\/\/neo2-pan\.app\.workbuddy\.host\//i.test(String(u || ''));
}
function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}
/* 从下载文件名解析版本号：XLC-Launcher-Beta1.0-Setup.exe → Beta1.0
   （更新页上历史版本与最新版的文件名是同一套规则，靠这个把历史版本一个个认出来） */
function verFromFileName(name) {
  const m = String(name || '').match(/XLC-Launcher-([A-Za-z0-9][A-Za-z0-9._-]*?)-(?:Setup|setup|portable|Portable)\.exe/i);
  return m ? m[1] : '';
}
/* 解析更新源内容：HTML 下载页 或 JSON 接口（纯函数，便于单测） */
function parseUpdatePage(body, pageUrl) {
  const raw = String(body || '');
  const out = { version: '', notes: '', downloads: [], pageUrl };
  const t = raw.trim();
  let j = null;
  if (t.startsWith('{') || t.startsWith('[')) { try { j = JSON.parse(t); } catch (_) { j = null; } }
  if (j && !Array.isArray(j)) {
    out.version = String(j.version || j.latest || j.tag || '').trim();
    out.notes = stripTags(j.notes || j.changelog || j.intro || '').slice(0, 800);
    const arr = Array.isArray(j.downloads) ? j.downloads : (Array.isArray(j.files) ? j.files : []);
    for (const d of arr) {
      if (!d) continue;
      const u = String(d.url || d.href || '').trim();
      if (!u) continue;
      const dname = String(d.name || d.file || u.split('/').pop()).trim();
      const sha = String(d.sha256 || d.sha || d.checksum || '').trim().toLowerCase();
      out.downloads.push({
        name: dname,
        url: absUrl(u, pageUrl),
        kind: String(d.kind || d.type || '').trim(),
        size: String(d.size || '').trim(),
        version: String(d.version || '').trim() || verFromFileName(dname),
        sha256: /^[a-f0-9]{64}$/.test(sha) ? sha : ''
      });
    }
  }
  /* 版本号：优先从下载文件名解析（最可靠，例：XLC-Launcher-Beta1.1-Setup.exe）。
     ⚠ 不能只认**第一处**出现的那个文件名：历史版本的直链与最新版在同一个页面上
     （「回退到历史版本」就是靠它们），谁排在前面完全取决于下载页的 HTML 结构 ——
     只认第一处的话，只要页面里先出现一条旧版直链，就会把旧版当成「最新版本」，
     于是所有用户都检测不到更新（老客户端只认第一处是既成事实、改不了，新代码没必要继续沿用）。
     这里扫全页所有产物名，用同一个版本比较函数取**版本最高**的那个。 */
  if (!out.version) {
    const reNames = /XLC-Launcher-([A-Za-z0-9][A-Za-z0-9._-]*?)-\s*(?:Setup|setup|portable|Portable)\s*\.exe/gi;
    let best = '', nm;
    while ((nm = reNames.exec(raw))) {
      if (!best || compareVer(nm[1], best) > 0) best = nm[1];
    }
    if (best) out.version = best;
  }
  if (!out.version) {
    /* 回退：页面文案「XLC 启动器 <b>Beta 1.0</b>」或「XLC-Launcher Beta 1.0 ·」 */
    const bm = raw.match(/启动器[\s\S]{0,120}?<b>\s*([A-Za-z]+\s*\d[\d.]*)\s*<\/b>/i) ||
      raw.match(/XLC-Launcher\s+([A-Za-z]+\s*\d[\d.]*)/i);
    if (bm) out.version = bm[1].replace(/\s+/g, '');
  }
  /* 下载直链：<a ... href="xxx.exe" download="名字">（相对路径按页面地址补全） */
  if (!out.downloads.length) {
    const re = /<a\b[^>]*href="([^"]+\.exe)"[^>]*>/gi;
    let m;
    while ((m = re.exec(raw))) {
      const href = m[1];
      const dn = m[0].match(/download="([^"]+)"/i);
      let name = dn ? dn[1] : href.split('/').pop().split('?')[0];
      try { name = decodeURIComponent(name); } catch (_) {}
      const kind = /setup|install/i.test(name) ? '安装版' : /portable/i.test(name) ? '便携版' : '';
      /* 下载页可选提供 <a href="..." data-sha256="<64 hex>">：有就带上，下载/替换时强校验 */
      const sm = m[0].match(/data-sha256="([a-fA-F0-9]{64})"/);
      out.downloads.push({ name, url: absUrl(href, pageUrl), kind, size: '', version: verFromFileName(name), sha256: sm ? sm[1].toLowerCase() : '' });
    }
  }
  /* 版本说明：下载页的 .intro 段落 */
  if (!out.notes) {
    const im = raw.match(/<p class="intro">([\s\S]*?)<\/p>/i);
    if (im) out.notes = stripTags(im[1]).slice(0, 800);
  }
  return out;
}

/* 字节数 → 人读尺寸（GitHub Release 附件 size 是字节数） */
function humanSize(n) {
  const b = Number(n);
  if (!isFinite(b) || b <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i ? v.toFixed(1) : String(v)) + ' ' + u[i];
}
/* 解析 GitHub Releases（/releases/latest 响应）为与 parseUpdatePage 同形的更新档案。
   - 版本 = tag_name 去掉开头的 v（v1.2-rc4 → 1.2-rc4）；
   - notes = release body 去 HTML 片段；
   - downloads = exe 附件（浏览器直链 + 字节数 + 可选 digest sha256）；
   - /releases/latest 本身就跳过 draft 与 prerelease，rc 候选不会抢在正式版前面。
   （纯函数，便于离线自测。） */
function parseGitHubRelease(j) {
  const out = { version: '', notes: '', downloads: [], pageUrl: GH_RELEASE_PAGE };
  if (!j || typeof j !== 'object') return out;
  /* 「打开下载页」要落到人类可读的 Release 页面（API 端点只会甩一坨 JSON）；
     只认 github.com 的 html_url，防止被伪造 JSON 引导到别处 */
  const hu = String(j.html_url || '');
  if (/^https:\/\/github\.com\//i.test(hu)) out.pageUrl = hu;
  out.version = String(j.tag_name || '').replace(/^v/i, '').trim();
  if (!out.version) out.version = String(j.name || '').trim();
  out.notes = stripTags(j.body || '').slice(0, 800);
  for (const a of (Array.isArray(j.assets) ? j.assets : [])) {
    const name = String((a && a.name) || '').trim();
    if (!/\.exe$/i.test(name)) continue;
    const kind = /portable/i.test(name) ? '便携版' : /setup|install/i.test(name) ? '安装版' : '';
    const dg = String((a && a.digest) || '');
    out.downloads.push({
      name,
      url: String((a && a.browser_download_url) || ''),
      kind,
      size: humanSize(a && a.size),
      version: verFromFileName(name),
      sha256: /^sha256:[a-fA-F0-9]{64}$/.test(dg) ? dg.slice(7).toLowerCase() : ''
    });
  }
  return out;
}

/* 更新源上的「版本档案」（纯函数）：把解析出的下载直链按版本归组，倒序排好，
   并标出每一版与当前版本的关系 —— 界面据此做「回退到历史任意版本」。
   relation：newer=比当前新（走更新流程）、same=正在用的这一版、older=比当前旧（可回退）。
   下载页上历史版本的直链与最新版是同一套命名（XLC-Launcher-<版本>-Setup.exe），
   所以只要页面里还挂着旧版本的链接，就能回退过去。 */
function buildUpdateHistory(downloads, current) {
  const map = new Map();
  for (const d of (downloads || [])) {
    if (!d || !d.url) continue;
    const v = String(d.version || '').trim() || verFromFileName(d.name);
    if (!v) continue;
    const key = normVer(v);
    if (!map.has(key)) map.set(key, { version: v, pre: isPreVer(v), downloads: [] });
    const item = map.get(key);
    if (!item.downloads.some(x => x.name === d.name)) {
      /* 直链统一归到官网网盘：页面源解析出来的本来就是官网直链（原样保留，页面换目录也不受影响），
         GitHub 附件直链一律换成官网地址 —— 「版本回退」只能从官网下载。 */
      const u = String(d.url || '');
      item.downloads.push({ name: d.name, url: isOfficialPanUrl(u) ? u : officialDlUrl(d.name), kind: d.kind || '' });
    }
  }
  const list = Array.from(map.values());
  for (const it of list) {
    const c = compareVer(it.version, current);
    it.relation = c > 0 ? 'newer' : (c < 0 ? 'older' : 'same');
    /* 回退首选便携版 exe（免安装：下载完直接覆盖程序文件即可，不用跑安装向导），
       没有便携版的版本才退回安装版 */
    it.downloads.sort((a, b) => (/portable/i.test(a.name) ? 0 : 1) - (/portable/i.test(b.name) ? 0 : 1));
  }
  list.sort((a, b) => compareVer(b.version, a.version));   /* 新 → 旧 */
  return list;
}

/* 版本解析 / 比较的纯函数自测（LMC_SMOKE_UPDATE=1 触发，离线可跑） */
function updateParserSelfTest() {
  const lines = [];
  let fail = 0;
  const ok = (cond, name, extra) => {
    lines.push((cond ? 'PASS' : 'FAIL') + ' · ' + name + (extra === undefined || extra === '' ? '' : '  [' + extra + ']'));
    if (!cond) fail++;
  };
  const PAGE = '<html><head><title>XLC 启动器下载 · NEO2</title></head><body>'
    + '<p class="intro">XLC 启动器 <b>Beta 1.0</b>：两个版本选一个下载即可。</p>'
    + '<span class="fname">XLC-Launcher-Beta1.0-Setup.exe</span>'
    + '<a class="btn" href="pan/xlc-launcher/XLC-Launcher-Beta1.0-Setup.exe" download="XLC-Launcher-Beta1.0-Setup.exe">⬇ 下载</a>'
    + '<a class="btn" href="pan/xlc-launcher/XLC-Launcher-Beta1.0-portable.exe" download="XLC-Launcher-Beta1.0-portable.exe">⬇ 下载</a>'
    + '</body></html>';
  const BASE = 'https://neo2-pan.app.workbuddy.host/index5.html';
  const p = parseUpdatePage(PAGE, BASE);
  ok(p.version === 'Beta1.0', 'T1 从下载文件名解析版本号', p.version);
  ok(p.downloads.length === 2, 'T2 解析出两个下载直链', 'n=' + p.downloads.length);
  ok(p.downloads.every(d => /^https:\/\/neo2-pan\.app\.workbuddy\.host\/pan\//.test(d.url)), 'T3 相对直链补全为绝对地址', p.downloads[0] && p.downloads[0].url);
  ok(p.downloads.some(d => d.kind === '安装版'), 'T4 识别安装版');
  ok(p.downloads.some(d => d.kind === '便携版'), 'T5 识别便携版');
  ok(/^XLC 启动器 Beta 1\.0/.test(p.notes || ''), 'T6 解析出版本说明', String(p.notes || '').slice(0, 40));
  /* 线上还是旧版 Beta1.0、本地已是正式版 → 本地领先（开发版不会被打扰着"更新"） */
  ok(compareVer(p.version, APP_VERSION) === -1, 'T7 线上旧版被判定为「本地更新」，不提示更新', p.version + ' vs ' + APP_VERSION);
  /* 构造一个比当前版本更高的一版验证「有更新」分支。
     动态推算（当前主版本 + 1）—— 发版后不用再改测试：1.0 → 2.0、2.3 → 3.0。 */
  const HI = ((parseInt((String(APP_VERSION).match(/\d+/) || ['1'])[0], 10) || 1) + 1) + '.0';
  const NEXT = PAGE.replace(/Beta1\.0/g, HI).replace('Beta 1.0', HI);
  const p2 = parseUpdatePage(NEXT, BASE);
  ok(p2.version === HI && compareVer(p2.version, APP_VERSION) === 1, 'T8 更高版本判定为「有更新」', p2.version + ' vs ' + APP_VERSION);
  ok(parseUpdatePage(NEXT, BASE).downloads[0].url.indexOf(HI) > 0, 'T9 新版本直链随之更新', parseUpdatePage(NEXT, BASE).downloads[0].url);
  /* JSON 形式的更新源同样兼容 */
  const j = parseUpdatePage(JSON.stringify({
    version: '1.2.0', notes: '修复若干问题',
    downloads: [{ name: 'XLC-Launcher-1.2.0-Setup.exe', url: 'https://x.test/a.exe', size: '80 MB' }]
  }), 'https://x.test/u.json');
  ok(j.version === '1.2.0' && j.downloads.length === 1 && j.notes === '修复若干问题', 'T10 兼容 JSON 更新源', j.version);
  ok(parseUpdatePage('<html>没有版本信息的页面</html>', BASE).version === '', 'T11 无版本信息时返回空（上层提示）');
  ok(parseUpdatePage('<p>XLC-Launcher Beta 2.0 · 免登录</p>', BASE).version === 'Beta2.0', 'T12 回退到页面文案解析版本');
  const cmp = [
    ['Beta 1.0', 'Beta1.0', 0], ['Beta1.1', 'Beta1.0', 1], ['Beta1.0', 'Beta1.1', -1],
    ['Alpha1.0', 'Beta1.0', -1], ['Beta1.0', 'Alpha2.0', 1], ['1.2.0', 'Beta1.1', 1],
    ['Beta1.10', 'Beta1.9', 1], ['1.0.0', '1.0.0', 0]
  ];
  let cmpOk = true;
  for (const c of cmp) {
    const got = compareVer(c[0], c[1]);
    if (got !== c[2]) { cmpOk = false; lines.push('  · 比较异常: ' + c[0] + ' vs ' + c[1] + ' = ' + got + '（期望 ' + c[2] + '）'); }
  }
  ok(cmpOk, 'T13 版本比较（阶段 / 数字逐段）');
  /* 下载页（站点上传本机当前版本之后的真实形态）：用 APP_VERSION 构造，
     这样每次发版不用再改测试；旧版/新版两种情形在 T7 / T8 已覆盖 */
  const CV = APP_VERSION;
  const CUR = PAGE.replace(/Beta1\.0/g, CV).replace('Beta 1.0', 'Pre ' + CV.replace(/^Pre/i, ''));
  const p3 = parseUpdatePage(CUR, BASE);
  ok(p3.version === CV && compareVer(p3.version, APP_VERSION) === 0,
    'T14 解析当前版本下载页并与本机版本一致', p3.version + ' vs ' + APP_VERSION);
  ok(p3.downloads.length === 2 && p3.downloads.some(d => d.url.endsWith(CV + '-Setup.exe')),
    'T15 当前版本安装包直链解析正常', p3.downloads[0] && p3.downloads[0].url);
  /* 下载页里历史版本的直链与最新版同在一页（「回退到历史版本」就靠它们），
     谁排在前面取决于下载页的 HTML 结构 —— 不能只认第一处出现的文件名：
     页面里先出现一条旧版直链时，也必须认出真正的最新版，否则所有用户都检测不到更新。
     回归：旧实现用 raw.match（无 /g，只取第一处）→ 这个页面会解析出 1.0。 */
  const MIX = '<html><body>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-1.0-Setup.exe" download="XLC-Launcher-1.0-Setup.exe">旧版</a>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-' + HI + '-portable.exe" download="XLC-Launcher-' + HI + '-portable.exe">新版</a>'
    + '</body></html>';
  const pmix = parseUpdatePage(MIX, BASE);
  ok(pmix.version === HI, 'T15b 旧版直链排在前面时仍取版本最高的那一版（不认「第一处」）',
    pmix.version + ' → 期望 ' + HI);
  const cmp2 = [
    ['Pre1', 'Beta1.0', 1], ['Beta1.0', 'Pre1', -1],
    ['Pre2', 'Pre1', 1], ['Pre1', 'Pre2', -1], ['Pre1', 'Pre1', 0],
    ['RC1', 'Pre1', 1], ['Pre1', 'RC1', -1], ['RC2', 'RC1', 1],
    ['1.0', 'Pre1', 1], ['Pre1', '1.0', -1], ['1.0', 'RC1', 1],
    ['RC1', 'Pre2', 1], ['RC1', '1.0', -1], ['1.0.0', '1.0', 0], ['2.0', '1.9', 1]
  ];
  let cmp2Ok = true;
  for (const c of cmp2) {
    const got = compareVer(c[0], c[1]);
    if (got !== c[2]) { cmp2Ok = false; lines.push('  · 预发布比较异常: ' + c[0] + ' vs ' + c[1] + ' = ' + got + '（期望 ' + c[2] + '）'); }
  }
  ok(cmp2Ok, 'T16 预发布系列排序（Beta/Pre 用户能收到 RC1；正式版盖过 RC）');
  /* 带「目标版本号」的预发布（1.1-snapshot1 这类 1.0 之后的开发快照）。
     回归：本机 1.1-snapshot1 曾被判成「比线上 1.0 老」，设置里于是提示「发现新版本 1.0」。 */
  const cmp3 = [
    ['1.1-snapshot1', '1.0', 1], ['1.0', '1.1-snapshot1', -1],
    ['1.1-snapshot1', '1.1', -1], ['1.1', '1.1-snapshot1', 1],
    ['1.1-snapshot2', '1.1-snapshot1', 1], ['1.1-snapshot1', '1.1-snapshot2', -1],
    ['1.1-snapshot1', '1.0-rc1', 1], ['1.0-rc1', '1.0', -1],
    ['1.0-rc1', '1.0-beta1', 1], ['1.2.0-rc1', '1.2.0', -1],
    ['2.0', '1.1-snapshot1', 1], ['1.1-snapshot1', 'Pre1', 1]
  ];
  let cmp3Ok = true;
  for (const c of cmp3) {
    const got = compareVer(c[0], c[1]);
    if (got !== c[2]) { cmp3Ok = false; lines.push('  · 目标版本比较异常: ' + c[0] + ' vs ' + c[1] + ' = ' + got + '（期望 ' + c[2] + '）'); }
  }
  ok(cmp3Ok, 'T16b 带目标版本的预发布（1.1-snapshot1 比 1.0 新、比 1.1 旧）');
  /* 「跳过快照版更新」：先认得出哪些是快照 / 预发布，再看开关是否对它生效 */
  ok(isPreVer('1.1-snapshot1') && isPreVer('1.1-snapshot2') && isPreVer('Beta1.0') &&
    isPreVer('Pre1') && isPreVer('RC1') && isPreVer('1.2.0-rc1'),
    'T16c 快照 / 预发布 / 候选版都能被识别');
  ok(!isPreVer('1.0') && !isPreVer('1.1') && !isPreVer('1.2.0') && !isPreVer('v2.0'),
    'T16d 纯版本号（正式版）不算预发布');
  ok(preUpdateDecision('1.1-snapshot1', true).skipped && !preUpdateDecision('1.1-snapshot1', false).skipped,
    'T16e 「跳过快照版更新」只对快照 / 预发布生效，且跟随开关');
  ok(!preUpdateDecision('1.1', true).skipped && !preUpdateDecision('1.0', true).skipped,
    'T16f 正式版更新不会被「跳过快照版更新」拦下（照样提示）');
  /* 「更新回退」：把更新源上的历史版本认出来、排好序，并标清与当前版本的关系 */
  ok(verFromFileName('XLC-Launcher-1.0-Setup.exe') === '1.0' &&
    verFromFileName('XLC-Launcher-Beta1.0-portable.exe') === 'Beta1.0' &&
    verFromFileName('XLC-Launcher-1.1-snapshot1-Setup.exe') === '1.1-snapshot1' &&
    verFromFileName('随便一个名字.exe') === '',
    'T16g 从下载文件名解析版本号（含带后缀的预发布版）');
  const HIST_PAGE = '<p class="intro">XLC 启动器 <b>1.0 正式版</b>：下方另附旧版本。</p>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-1.0-Setup.exe" download="XLC-Launcher-1.0-Setup.exe">下载</a>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-1.0-portable.exe" download="XLC-Launcher-1.0-portable.exe">下载</a>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-RC1-Setup.exe" download="XLC-Launcher-RC1-Setup.exe">下载</a>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-Pre1-Setup.exe" download="XLC-Launcher-Pre1-Setup.exe">下载</a>'
    + '<a href="pan/xlc-launcher/XLC-Launcher-Beta1.0-Setup.exe" download="XLC-Launcher-Beta1.0-Setup.exe">下载</a>';
  const hp = parseUpdatePage(HIST_PAGE, BASE);
  const hist = buildUpdateHistory(hp.downloads, '1.1-snapshot1');
  ok(hist.length === 4, 'T16h 历史版本按版本归组（同版本的 Setup / portable 合成一条）',
    'n=' + hist.length + ' [' + hist.map(h => h.version).join(', ') + ']');
  ok(hist[0].version === '1.0' && hist[0].relation === 'older' && !hist[0].pre,
    'T16i 当前跑快照版时，最新正式版被标成「可回退」（older）', hist[0].version + '/' + hist[0].relation);
  ok(hist[1].version === 'RC1' && hist[1].pre && hist[hist.length - 1].version === 'Beta1.0',
    'T16j 历史版本倒序排列（RC1 在 Pre1 / Beta 之前）', hist.map(h => h.version).join(' > '));
  ok(buildUpdateHistory(hp.downloads, '1.0').find(h => h.version === '1.0').relation === 'same',
    'T16k 正在用的这一版标成 same（界面不拿它当回退目标）');
  ok(hist[0].downloads.length === 2 && /portable/i.test(hist[0].downloads[0].name),
    'T16l 同一版本的便携版 exe 排在安装版前面（回退用免安装 exe，不跑安装向导）',
    hist[0].downloads.map(d => d.name).join(' | '));
  /* GitHub Releases 解析（1.2 起更新源通道一）：tag / 附件 / 字节尺寸 / digest / notes */
  const gh = parseGitHubRelease({
    tag_name: 'v' + HI,
    body: '**标题**\n\n- 条目一 <b>加粗</b>',
    assets: [
      { name: 'XLC-Launcher-' + HI + '-portable.exe', browser_download_url: 'https://github.com/byzgdneo2/XLC-Launcher/releases/download/v' + HI + '/XLC-Launcher-' + HI + '-portable.exe', size: 75546420, digest: 'sha256:' + 'a'.repeat(64) },
      { name: 'Source code (zip)', browser_download_url: 'https://github.com/x/x/zip' }
    ]
  });
  ok(gh.version === HI, 'T16m GitHub Release 从 tag 解析版本（去 v 前缀）', gh.version);
  ok(gh.downloads.length === 1 && gh.downloads[0].kind === '便携版' && /github\.com.*releases\/download/.test(gh.downloads[0].url),
    'T16n 只收 exe 附件且认出便携版', gh.downloads.map(d => d.name).join('|'));
  ok(gh.downloads[0].size === '72.0 MB', 'T16o 附件字节数转人读尺寸', gh.downloads[0].size);
  ok(gh.downloads[0].sha256 === 'a'.repeat(64), 'T16p digest sha256 落到下载档案（下载后强校验）', gh.downloads[0].sha256);
  ok(/条目一/.test(gh.notes) && !/<b>/.test(gh.notes), 'T16q release body 转成纯文本说明', String(gh.notes).slice(0, 40));
  ok(parseGitHubRelease(null).version === '' && parseGitHubRelease({ tag_name: '' }).version === '' &&
    parseGitHubRelease({ tag_name: 'v2.0' }).downloads.length === 0, 'T16r 空响应 / 无附件安全返回');
  /* 版本回退只能从官网网盘下：GitHub 只负责发现版本，回退/下载直链一律归到官网 */
  const ghHist = buildUpdateHistory(gh.downloads, '0.9');
  ok(ghHist.length === 1 && /^https:\/\/neo2-pan\.app\.workbuddy\.host\/pan\/xlc-launcher\//.test(ghHist[0].downloads[0].url),
    'T16s GitHub 附件直链在回退列表里被换成官网网盘地址', ghHist[0].downloads[0].url);
  ok(hp.downloads.every(d => /^https:\/\/neo2-pan\.app\.workbuddy\.host\//.test(d.url)) &&
    buildUpdateHistory(hp.downloads, '1.1').every(h => h.downloads.every(d => isOfficialPanUrl(d.url))),
    'T16t 官网下载页解析出的直链原样保留（不重复改写）');
  ok(officialDlUrl('XLC-Launcher-1.2-portable.exe') ===
    'https://neo2-pan.app.workbuddy.host/pan/xlc-launcher/XLC-Launcher-1.2-portable.exe',
    'T16u 官网直链拼接规则', officialDlUrl('XLC-Launcher-1.2-portable.exe'));
  const cl = currentChangelog();
  ok(!!cl, 'T17 当前版本有内置更新公告', cl ? cl.version : '缺失');
  /* 开发中的版本（dev:true）允许公告还没写完 —— 否则每开一个新版本都会立刻
     因为「公告还是空的」把自测打红，逼得人往里塞没意义的占位内容 */
  ok(CHANGELOG.every(x => {
    const e = changelogOut(x);
    if (!e || !e.version || !e.date) return false;
    return e.dev === true || (Array.isArray(e.items) && e.items.length > 0);
  }), 'T18 公告条目结构完整（版本 / 日期 / 至少一条内容；开发中的版本豁免）', '共 ' + CHANGELOG.length + ' 条');
  /* 三条功能公告在 Pre1 那条完整公告里（后续小版本只写本次改动，不重复罗列历史功能） */
  /* 用「历史完整公告」（Pre1：更新 / 插件 / 工具箱 三组）校验公告模板。
   * 必须按版本号精准定位：若按「组数 ≥3」挑，当前版本公告一多就会误选到它自己。 */
  const clFull = CHANGELOG.find(x => x.version === 'Pre1')
    || CHANGELOG.find(x => (x.groups || []).length >= 3) || cl;
  const clOut = changelogOut(clFull) || { items: [], groups: [] };
  const clText = clOut.items.join('\n');
  const gTitles = (clOut.groups || []).map(g => g.title).join(' | ');
  ok((clOut.groups || []).length >= 3, 'T19 公告按功能分组（更新 / 插件 / 工具箱）', clFull.version + ' · ' + gTitles);
  ok(/插件/.test(clText) && /种子地图/.test(clText) && /一键开服/.test(clText),
    'T20 公告写明插件功能（种子地图 / 一键开服）');
  ok(/版本更新|检测更新/.test(clText), 'T21 公告写明版本更新功能');
  ok(/工具箱/.test(clText), 'T22 公告写明工具箱功能', (clOut.groups || []).map(g => g.items.length).join('/') + ' 条');
  /* 智能内存分配（对齐 PCL）：先按实例需求（模组数量 / 是否 OptiFine）定四个目标，
     再按「此刻可用内存」四阶段发放（0~T1 全给，之后 70% / 40% / 15%）。
     纯函数 calcSmartMemGB(物理内存, 可用内存, 模组数, 是否 OptiFine)，单位 GB。 */
  const mt0 = memTargetsGB(0, false);
  ok(mt0.min === 0.5 && mt0.t1 === 1.5 && mt0.t2 === 2.5 && mt0.t3 === 4.0,
    'T23 原版实例的内存目标（最低 0.5 / 起步 1.5 / 舒适 2.5 / 充裕 4.0 GB）', JSON.stringify(mt0));
  const mtOf = memTargetsGB(0, true);
  ok(mtOf.t2 === 3.0 && mtOf.t3 === 5.0, 'T23b 装了 OptiFine 的原版各抬一档（3.0 / 5.0 GB）', JSON.stringify(mtOf));
  const mtMod = memTargetsGB(150, false);
  ok(Math.abs(mtMod.t1 - 3.1667) < 0.01 && Math.abs(mtMod.t2 - 5.7) < 0.01 && Math.abs(mtMod.t3 - 10.5) < 0.01,
    'T23c 目标值随模组数量抬高（150 个模组 → 3.2 / 5.7 / 10.5 GB）', JSON.stringify(mtMod));
  ok(calcSmartMemGB(32, 24, 0, false) === 7,
    'T23d 32G 机器 / 24G 可用 / 原版 → 7 GB（不再按「总内存的档位表」硬给）',
    'rec=' + calcSmartMemGB(32, 24, 0, false));
  ok(calcSmartMemGB(16, 3, 0, false) === 3,
    'T23e 同机器只剩 3G 可用 → 收紧到 3 GB（可用内存成了主约束，不再是固定档位）',
    'rec=' + calcSmartMemGB(16, 3, 0, false));
  ok(calcSmartMemGB(32, 24, 200, false) === 15,
    'T23f 200 个模组的整合包同样条件下给到 15 GB（原版同条件只有 7 GB）',
    'rec=' + calcSmartMemGB(32, 24, 200, false));
  ok(calcSmartMemGB(8, 8, 0, false) === 4 && calcSmartMemGB(4, 2, 0, false) === 2 && calcSmartMemGB(2, 0.5, 0, false) === 1,
    'T23g 小内存机器不会算超（8G → 4G、4G 机 → 2G、2G 机 → 1G）',
    [calcSmartMemGB(8, 8, 0, false), calcSmartMemGB(4, 2, 0, false), calcSmartMemGB(2, 0.5, 0, false)].join(' / '));
  const memInts = [calcSmartMemGB(16, 8, 0, false), calcSmartMemGB(64, 60, 500, false), calcSmartMemGB(24, 1, 300, false)];
  ok(memInts.every(v => Number.isInteger(v) && v >= 1) && calcSmartMemGB(64, 60, 500, false) <= 63,
    'T23h 结果一定是 ≥1 的整数，且不超过「物理内存 - 1G」（-Xmx 只认整数，且要给系统留余量）',
    memInts.join(' / '));
  /* 模组计数：只算启用的（改名的 .jar.disabled 不算），同名去重，认得 OptiFine */
  const modTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlc-modcount-'));
  try {
    fs.writeFileSync(path.join(modTmp, 'sodium.jar'), 'x');
    fs.writeFileSync(path.join(modTmp, 'create.jar'), 'x');
    fs.writeFileSync(path.join(modTmp, 'pack.zip'), 'x');
    fs.writeFileSync(path.join(modTmp, 'off.jar.disabled'), 'x');
    fs.writeFileSync(path.join(modTmp, 'readme.txt'), 'x');
    fs.writeFileSync(path.join(modTmp, 'OptiFine_1.20.1_HD_U_I6.jar'), 'x');
    const st = countModsInDirs([modTmp, modTmp]);
    ok(st.mods === 4 && st.optifine === true,
      'T23i 模组计数：启用的 jar/zip 才算、被禁用的不算、重复目录去重、认得 OptiFine',
      'mods=' + st.mods + ' optifine=' + st.optifine);
  } catch (e) {
    ok(false, 'T23i 模组计数（临时目录创建失败）', e.message);
  } finally {
    try { fs.rmSync(modTmp, { recursive: true, force: true }); } catch (_) {}
  }
  return { fail, lines };
}

/* ---------------- 更新公告（随版本内置） ----------------
 * 每次发布新版本时在这里补一条；启动器首次以新版本运行时会自动弹出公告，
 * 设置 → 版本更新 里也能随时查看。
 * 公告「属于当前版本」：改完就往 version 与 APP_VERSION 相同的那条里加条目 ——
 * 已经发出去的老版本条目不要再动（用户看到的公告就是它，改了等于改写历史）。 */
const CHANGELOG = [
  {
    version: '1.3-snapshot2',
    date: '2026-10-29',
    /* 开发中的版本：公告没写完也不至于把自测打红。**打包前删掉这一行** */
    dev: true,
    tag: '1.3 快照版',
    notice: '这一版没有新功能，全部在修「出问题时让你更安全」的细节：配置保存改成原子写（断电 / 磁盘满不会再让设置整份丢失，坏掉的配置会自动留一份备份）、关启动器时会等「退出后自动备份」跑完、正版账户启动不再误报「离线模式」、启动前命令不会被实例名里的特殊字符注入、开服同步模组能认出「同体积但内容不同」的文件、删除 MOD 改走回收站。',
    groups: [
      {
        icon: 'i-drive',
        title: '修复 · 设置不再可能整份丢失',
        items: [
          '**保存改成原子写**：先写临时文件、刷盘、再改名覆盖。以前直接覆盖原文件，写到一半断电 / 进程被杀 / 磁盘满就会留下半截 JSON',
          '**坏配置自动留档**：如果下次启动发现配置解析不了，会把原文件改名成 `lmc.config.json.bad-<时间戳>` 留着，再用默认值启动，并在界面上告诉你 —— 以前是静默用默认值，原始内容还会被下一次保存覆盖',
          '**保存失败会说**：磁盘满 / 文件被占用时，日志和界面都会明确提示「设置保存失败」，不再显示已保存却什么都没落盘'
        ]
      },
      {
        icon: 'i-clock',
        title: '修复 · 关启动器不再吞掉「退出后自动备份」',
        items: [
          '关掉游戏后 2.5 秒内顺手关掉启动器，以前这次备份**根本不会开始**（定时器随进程一起消失）',
          '现在退出前会先把它触发并等它跑完；备份正在写 zip 时关启动器也会等最多 3 秒，超时才放弃并写日志'
        ]
      },
      {
        icon: 'i-user',
        title: '修复 · 启动成功的提示按登录方式显示',
        items: [
          '以前不管用什么账户都弹「游戏进程已启动（离线模式）」，正版玩家会以为登录失败、掉到离线了',
          '现在按实际情况显示「微软正版登录 / 外置登录 / 离线模式」'
        ]
      },
      {
        icon: 'i-terminal',
        title: '安全 · 启动前命令不再被实例名注入',
        items: [
          '`${gameDir}` / `${version}` 的取值来自游戏路径和实例名，导入整合包时实例名可能含 `& | < > ^ %` 这类 shell 特殊字符',
          '含这些字符时**跳过这条可选脚本**并在日志 / 界面说明原因，不再把它拼进命令行执行'
        ]
      },
      {
        icon: 'i-server',
        title: '修复 · 开服「同步模组」更准、失败可见',
        items: [
          '以前只比文件体积：体积相同但内容不同的 jar（换过构建 / 被替换过）会被判成「已同步」；现在按体积 + 修改时间判断，并在拷贝后对齐时间戳，避免每次都重拷',
          '单个 mod 复制失败不再静默跳过：同步结果里会给出失败清单和数量'
        ]
      },
      {
        icon: 'i-trash',
        title: '修复 · 删除 MOD 改走回收站',
        items: [
          '和存档 / 实例删除保持一致：先移入系统回收站，回收站不可用才退化为直接删除 —— 误删自己改过的 jar 还能捞回来'
        ]
      },
      {
        icon: 'i-feedback',
        title: '修复 · 反馈页会翻页，条数不再虚报',
        items: [
          'Issue 超过 100 条后，更早的条目以前会静默消失、页面上的「共 N 条」也只是本页条数',
          '现在顺着分页拉取（最多 5 页），还有更多没取时显示「已加载最近 N 条」并提示去 GitHub 看全部'
        ]
      },
      {
        icon: 'i-list',
        title: '修复 · 模组清单截断会说明',
        items: [
          '超过 600 个模组时清单只列前 600 个，以前没有任何提示，两边都少了同一批时可能显示「完全一致」',
          '现在截断时清单里会加一行说明，比对结论也会标注「清单已截断，之外的未比对」'
        ]
      }
    ]
  },
  {
    version: '1.3-snapshot1',
    date: '2026-10-28',
    tag: '1.3 快照版',
    notice: '1.3 首个快照（snapshot1）：两个内置插件 —— 「存档备份」和「模组清单对齐」，侧边栏「反馈」改成启动器内的独立页面，下载也终于能中途停下来了。这一版还有个底层变化：内置插件第一次能往启动器的页面里注入界面，不再只能待在插件页或独立窗口里。快照版可能有不稳定的地方，遇到问题欢迎到侧边栏「反馈」提 Issue。',
    groups: [
      {
        icon: 'i-drive',
        title: '新增 · 内置插件「存档备份」',
        items: [
          '**存档详情里直接备份**：存档管理点开某个世界，「打开目录」右边多了「备份存档」，一下把这个存档打包成一个 zip',
          '**自动备份**：插件设置里可以开总开关，选「启动游戏前」和「退出游戏后」两个时机；只备份**变过的**存档（按存档目录最新改动时间判断），没动过的不会重复备',
          '**默认存在启动器数据目录**：`XLC数据\\存档备份\\<存档名>\\<存档名>__20261027-183000.zip`，旁边一份同名 `.json` 记着存档名、所属实例、时间、文件数；备份目录也能改，面板里可直接打开',
          '**保留份数可调**：默认每个存档留 10 份，旧的自动清掉；填 0 就是不删',
          '**可恢复、可删除**：备份列表里逐份恢复 / 打开位置 / 删除（进回收站）。恢复前会先自动兜底一份「恢复前」的备份，手滑也回得去',
          '**不耽误启动**：启动前最多花 20 秒、退出后最多 90 秒，超时剩下的下次再备；游戏正在运行时**拒绝恢复**，避免边玩边覆盖把存档写坏',
          '备份是流式写盘的，备多大的存档都不会把内存吃满；打包时自动跳过 `session.lock` 这类不能碰的文件'
        ]
      },
      {
        icon: 'i-sync',
        title: '新增 · 内置插件「模组清单对齐」',
        items: [
          '**联机页多了一张卡**：「好友联机」下面就是它 —— 选实例 → 生成我的清单 → 发给好友 → 比对',
          '**清单走好友通道自动送达**：发出去对方在联机页会直接看到一行提示（不依赖复制粘贴，复制清单码也还能用）',
          '**差异分三组**：对方有我没有 / 我有对方没有 / 同名但版本不一样，一眼看出该补什么、该换什么',
          '有缺失时可以「复制缺失清单」，发给对方让他照着装',
          '清单是纯文本（`XLC-MODS/1` 开头，每行 `哈希前 12 位 体积 文件名`），**只比对文件名和体积 + 前 4MB 的哈希，不上传任何模组内容**；手机拍的哈希只用来判断「是不是同一个文件」，不是完整性校验',
          '联机前先对一遍清单，能省掉一大半「进去就掉线 / 方块对不上」的排查'
        ]
      },
      {
        icon: 'i-feedback',
        title: '新增 · 侧边栏「反馈」变成独立页面',
        items: [
          '**不再一按就跳浏览器**：点侧边栏「反馈」，在启动器里就能看到反馈情况；要提新的再去网页，不用先被甩出去再找回来',
          '**六档折叠列表**：正在处理 / 等待处理 / 等待 / 已完成 / 已忽略 / 重复，标题右边带数量角标，默认全部收起，点开才展开',
          '条目行是 `#编号 · 标题 · 标签 · 多久之前`，点任意一条直接在浏览器打开对应的 Issue；每档按最后更新时间倒序排',
          '**分档规则**（按仓库里的真实状态分，不靠人工维护）：`duplicate` 标签 → 重复；`wontfix` / `invalid` 或关闭时标了「不计划」→ 已忽略；已关闭 → 已完成；已指派或带 `processing` 标签 → 正在处理；有分类标签 → 等待处理；一个标签都没有 → 等待',
          'PR 和字段不全的脏数据会被丢掉，不会在列表里出现半截条目',
          '**两个出口**：「前往反馈」直接新建 Issue，「在 GitHub 查看全部」打开完整 Issue 列表 —— 页面上也写明了这里不是全部反馈',
          '**自动刷新 + 缓存**：进页面自动拉一次，主进程缓存 10 分钟，点右上「刷新」强制重取；界面自己也缓存 5 分钟，来回切页不会反复请求',
          '**拉不到不会空白**：断网或 GitHub 限流时，页面上写清原因（比如 403），并保留去网页的出口，不会只剩一片空白'
        ]
      },
      {
        icon: 'i-tools',
        title: '改动 · 插件能改启动器页面了',
        items: [
          '新增「页面注入钩子」：内置插件可以往启动器的具体页面里插按钮和卡片（这次的两个插件就是），社区插件仍然进不了主窗口，边界没放开',
          '钩子是**可重复执行**的：页面重绘后按钮还在，不会消失',
          '插件停用后注入的东西立刻不见，异常也不会连累宿主页面崩溃'
        ]
      },
      {
        icon: 'i-stop',
        title: '新增 · 下载可以中途停止',
        items: [
          '**下载中按钮就是「停止」**：下 MOD、整合包、资源包、光影包、数据包的时候，安装按钮会变成红色的「停止」，点一下立刻断',
          '**停了是真停**：不会再偷偷换个镜像、换个 CDN 接着下，也不会自己再试第二轮 —— 以前点了没反应，就是因为它默默换了条路',
          '**不留半截垃圾**：已经写下的临时文件（`.xlc-tmp`）一并清掉，不会在 mods 里留个打不开的坏包；停掉的任务号立刻作废，重新点安装是干净的一次',
          '**提示说人话**：停完提示「已取消下载」，不是吓人的「安装失败」',
          '正常下完、断网后重试这些老行为一条没变，只有你亲手点停止才会中断',
          '**边界说清楚**：整合包里「装游戏本体」那一段停不下来，要等它装完；「MOD 一键更新」和「资源包批量更新」走的是另一条链路，这次还没接上'
        ]
      },
      {
        icon: 'i-download',
        title: '改动 · 没选版本装 MOD 会问你存哪',
        items: [
          '下载页「目标版本」停在「全部」时点安装，不再自己挑一个实例塞进去 —— 弹系统「选择保存位置」，文件名预填好，默认就在 mods 目录',
          '想直接装进某个实例，就在「目标版本」里选它，行为跟以前一样，装完进游戏就能看到',
          '在保存对话框点取消就什么都不做：不下载、不留半截文件、也不会误报「安装失败」'
        ]
      }
    ]
  },
  {
    version: '1.2',
    date: '2026-10-26',
    tag: '正式版',
    notice: '1.2 正式版发布：游戏诊断全面重做、侧边栏反馈入口、下载多线程提速与 Forge 境内安装修复全部转正；更新检测升级为「GitHub 优先、官网兜底」。感谢每一位试用候选版并反馈问题的用户。',
    groups: [
      {
        icon: 'i-pulse',
        title: '转正 · 1.2 全部候选版内容',
        items: [
          '**游戏诊断 v2**：崩溃报告可选可析（Description / Caused by / 涉案 MOD / 关键日志行）、识别规则 13 → 25 条、不再有「日志太旧就不看」的限制',
          '**下载提速**：大文件多线程分段下载（30 分钟下不完一个游戏 → 几分钟）、文件并发数可调、每段独立断点续传',
          '**Forge / NeoForge 境内安装修复**：映射文件镜像预下载 + 安装器跳过补丁，不再卡在「退出码 1」',
          '**游戏设置「资源包 / 光影包」页**：扫描、更新检测、批量管理一应俱全',
          '**反馈入口**：侧边栏常驻「反馈」按钮 + 主页提示条直达 GitHub Issues；提示条文案改为「测试版（快照 / 预发布 / 候选版）」'
        ]
      },
      {
        icon: 'i-download',
        title: '改动 · 更新源升级',
        items: [
          '更新检测**优先走 GitHub Releases**：发版即生效，不用等网盘同步；连不上（被墙 / 限流）时自动回退官方下载页，用户无感',
          '更新结果里会标出来源（GitHub / 官网下载页）；更新包下载域白名单同步放开 GitHub 官方附件域 —— 第三方地址依旧拒绝，安全锁定不变',
          '设置页不再显示「更新检测地址」那一行：地址内置并锁定，没必要让用户看；「打开下载页」在 GitHub 通道下会直接落到 Release 页面'
        ]
      },
      {
        icon: 'i-search',
        title: '改动 · 中文搜索更靠谱',
        items: [
          '**词库没收录的中文词也能搜**：先查内置词库（「小地图」→ minimap），再没见过就自动翻成英文关键词（「钠」→ sodium）',
          '**不再拿「全站热门」冒充结果**：CurseForge 会把不认识的中文字当空条件、直接返回下载量前 100 名（屏幕上看就像根本没搜索），现在中文解析不出英文词就跳过该源',
          '搜不到时给的是人话建议（换更完整的说法 / 输入英文名），并在结果上方标出这次实际用的英文关键词',
          '输入法（拼音 / 五笔）组合期间不再拿半成品去搜，选字提交后一定会重新搜一次；回车可直接搜索'
        ]
      }
    ]
  },
  {
    version: '1.2-rc4',
    date: '2026-10-25',
    tag: '1.2 候选版',
    notice: '1.2 候选版第四弹（rc4）：游戏诊断全面重做 —— 崩溃报告可选可析、识别规则翻倍、不再有「日志太旧就不看」的限制。候选版以稳定为主，若一切顺利将作为 1.2 正式版发布。',
    groups: [
      {
        icon: 'i-pulse',
        title: '重做 · 游戏崩溃诊断',
        items: [
          '**不再有 30 分钟限制**：以前日志一旧就直接说「最近没有新的崩溃报告」，现在选哪份分析哪份，历史崩溃照常诊断（只标注发生时间）',
          '**崩溃报告可选**：诊断页新增报告下拉，列出该实例所有崩溃报告（〔最新〕标记 + 时间 + 异常标题），支持「只分析游戏日志」与一键刷新',
          '**解析崩溃报告结构**：提取 Description 崩溃标题、Caused by 异常链、Suspected Mods 涉案 MOD，结果里可直接展开「关键日志行」看证据',
          '**识别规则 13 → 25 条**：新增 Java 过新（模块系统拦截）、32 位内存参数超限、启动主类缺失、依赖库缺失、栈溢出、类文件损坏、MOD 配置文件损坏、JVM 原生崩溃（hs_err）、网络连接失败、会话验证、光影着色器失败、存档/区块损坏',
          '**原因分级**：崩溃报告里命中的标「确定原因」，只在日志里命中的标「疑似原因」，不再一锅端',
          '**没崩溃也有结论**：无报告时分析日志里的 ERROR 行；干净日志直接显示「日志干净」'
        ]
      }
    ]
  },
  {
    version: '1.2-rc3',
    date: '2026-10-25',
    tag: '1.2 候选版',
    notice: '1.2 候选版第三弹（rc3）：侧边栏新增「反馈」入口，遇到问题点一下直达 GitHub Issues。候选版以稳定为主，若一切顺利将作为 1.2 正式版发布。',
    groups: [
      {
        icon: 'i-feedback',
        title: '新增 · 侧边栏「反馈」入口',
        items: [
          '侧边栏（「设置」下方）新增 **反馈** 按钮：点击用系统默认浏览器打开 GitHub Issues（github.com/byzgdneo2/XLC-Launcher/issues）',
          '遇到 bug、想提建议都能去：发 Issue 时如果涉及安装失败，可以把 `XLC数据/diagnostics` 里的日志一起附上，定位会快很多'
        ]
      },
      {
        icon: 'i-warn',
        title: '改动 · 主页顶部提示条文案',
        items: [
          '主页顶部那条琥珀色提示（快照 / 预发布 / 候选版运行时才会出现）文案从「当前是**快照版**」改为「当前是**测试版**（快照 / 预发布 / 候选版）」—— 之前候选版（rc）用户也会看到「快照版」的说法，属于文案错位',
          '反馈入口升级：提示条改为「遇到问题请前往**我的仓库**交 **Issue**」，点一下直接在浏览器打开 GitHub Issues（github.com/byzgdneo2/XLC-Launcher/issues）；侧边栏也新增了常驻的**「反馈」按钮**，两个入口同一个地方',
        ]
      }
    ]
  },
  {
    version: '1.2-rc2',
    date: '2026-10-24',
    tag: '1.2 候选版',
    notice: '1.2 候选版第二弹（rc2）：游戏设置新增「资源包 / 光影包」页，扫描、信息、批量管理一应俱全；游戏与资源下载全面提速（大文件多线程 + 并发可调）；并修复了 Forge / NeoForge 在境内安装总失败的老毛病。候选版以稳定为主，若一切顺利将作为 1.2 正式版发布。',
    groups: [
      {
        icon: 'i-tools',
        title: '新增 · 游戏设置「资源包 / 光影包」页',
        items: [
          '游戏设置的页签多了两个：**资源包** 和 **光影包**，不用再进游戏翻文件夹 —— 自动扫描实例的 resourcepacks / shaderpacks 目录（开了版本隔离的实例也能认对地方）',
          '每个包显示**图标、名称、描述、文件大小和修改时间**（读包内的 pack.mcmeta 和 pack.png，识别不了的坏包会标「错误」，光影包目录结构不对也会标出来）',
          '支持按 **可更新 / 错误 / 重复** 筛选（没有就不显示），按名称 / 文件名 / 大小 / 时间排序，文件夹排最前',
          '按钮一应俱全：**打开文件夹 / 从文件安装 / 下载新资源包 / 全选 / 导出信息**（CSV）',
          '选中后可**批量删除**（进回收站可找回）和**批量更新**（走 Modrinth 源）；同一文件重复导入会先提醒。启用 / 禁用照旧在游戏内「选项」里选，与 PCL 一致'
        ]
      },
      {
        icon: 'i-download',
        title: '提速 · 游戏与资源下载全面加速',
        items: [
          '**大文件多线程分段下载**：游戏本体、客户端 jar 这类大文件不再单线程慢慢磨，自动切成多段并行下载，速度能跑满你的带宽（之前实测 30 分钟下不完一个游戏，现在几分钟）',
          '设置 → 下载行为新增「**文件并发数**」（默认 32，建议 16~48）：下载依赖库、材质音频这些小文件时同时开多少路，网速好可以调大',
          '分段下载每段独立断点续传，中途断网重试不用从头再来；服务器不支持分段时自动退回单线程',
          'MOD / 资源包的在线更新同样吃到提速'
        ]
      },
      {
        icon: 'i-tools',
        title: '修复 · Forge / NeoForge 安装在境内总失败',
        items: [
          '**根因找到并修复**：安装器的最后一步要从 Mojang 官方源直连下载「反混淆映射文件」，境内网络必超时，表现就是「Forge 装到一半报退出码 1」——之前装 Forge 失败基本都是这个原因',
          '现在安装前会把映射文件**从镜像源预下载**到位，并给安装器打上跳过补丁，安装器全程不再依赖官方源',
          '顺带解决了同类问题：安装器内部工具链的依赖库也已提前从镜像预热，Forge / NeoForge 安装成功率和速度都明显改善',
          '安装器的完整输出日志会落盘到诊断目录，再遇到失败可以一键把日志发给我们定位'
        ]
      }
    ]
  },
  {
    version: '1.2-rc1',
    date: '2026-10-23',
    tag: '1.2 候选版',
    notice: '1.2 进入候选阶段（rc1）：本版把「下载游戏」与「整合包」（下载与导入）暂时下架，联机、MOD、资源包、光影、数据包与已装实例均不受影响。候选版以稳定为主，若一切顺利将作为 1.2 正式版发布。',
    groups: [
      {
        icon: 'i-package',
        title: '调整 · 部分下载功能暂时下架',
        items: [
          '「**下载游戏**」（正式版 / 快照版 / 远古版本 / 全部）暂时下架：下载页现在默认进入 MOD 分类，其余资源分类照常可用',
          '「**整合包**」下载与「**导入整合包**」暂时下架：下载页的整合包分类与「导入 / 整合包」页的导入按钮已置灰',
          '不受影响：**联机**、MOD / 资源包 / 光影 / 数据包下载、导入目录、导入插件、导出整合包，以及**已安装的实例与存档**',
          '已装好的游戏照常启动；功能代码只是停用并未删除，后续恢复不需要重新下载或迁移任何数据'
        ]
      }
    ]
  },
  {
    version: '1.2-pre1',
    date: '2026-10-20',
    tag: '1.2 预发布版',
    notice: '1.2 进入预发布阶段（pre1）：游戏设置里新增「修改」页和 MOD 一键更新 —— 修改页照 PCL 的做法把 Forge / NeoForge / Fabric / Fabric API / OptiFine 一行行列出来，换版本、卸载、依赖联动都在那一行里；MOD 管理页现在能按文件指纹检查更新，有新版的直接点「更新」，旧文件进回收站。这是预发布版，可能带着未稳定的改动，遇到问题欢迎反馈。',
    groups: [
      {
        icon: 'i-sync',
        title: '新增 · MOD 管理页支持一键更新',
        items: [
          'MOD 管理页新增「**检查更新**」：按文件指纹（sha1 + CurseForge 指纹）比对 Modrinth / CurseForge，能认出这个 jar 的当前版本、以及它在你这个 MC 版本 + 加载器下的最新版',
          '有新版的 MOD 行上会出现绿色「**更新**」按钮，悬停能看到「当前版本 → 最新版本」；顶部提示「有 N 个 MOD 可以更新」，可以一个一个更，也可以点「**全部更新**」',
          '更新前会确认一次（列出新旧版本 + 兼容性警告）；新文件下载校验成功后才动手，**旧文件移入系统回收站**，出问题可以找回',
          '更新完自动复查一遍；检查结果缓存 15 分钟，切页不会反复联网，「检查更新」按钮随时强制刷新',
          '没收录到在线源的 MOD 不受影响，照常显示和使用；只对启用的 MOD 检查更新'
        ]
      },
      {
        icon: 'i-tools',
        title: '新增 · 游戏设置「修改」页（照 PCL 的组件行）',
        items: [
          '游戏设置顶部的页签从三个变四个：基础设置 / MOD 管理 / **修改** / 导出整合包，位置和顺序都保持原样',
          '「修改」页把加载器与常用前置一行行列出来：**Forge、NeoForge、Fabric、Quilt、Fabric API、OptiFine**，每行右侧直接显示「已安装 · 版本号 / 可以添加 / 不兼容的原因」',
          '想换版本点那一行就能挑版本；想卸掉点行尾的按钮；改动**先挂着不执行** —— 行会变成「当前版本 » 新状态」的对比视图，点 ↻ 随时撤销，底部「开始修改」确认后一次性按顺序做完',
          '**Fabric API 也跟着实例走**：Fabric / Quilt 实例上能直接装、换、删 mods 里的 fabric-api jar；移除 Fabric / Quilt 时它会跟着挂起移除并注明原因；OptiFine 与 Fabric / Quilt 不兼容时会直接写明，不让你白点',
          '装 Forge / NeoForge 到原版实例时，会顺手把前置一起装好，不用再去下载页走一遍'
        ]
      }
    ]
  },
  {
    version: '1.2-snapshot3',
    date: '2026-10-18',
    tag: '1.2 快照版',
    notice: '这一版把加载器版本选择里的「推荐」标记全部撤掉了：不管是置顶那一条「最新（推荐 xxx）」，还是版本列表里的「· 推荐」角标，都不再显示 —— 选哪个版本由你自己决定，启动器只保留「最新」角标帮你认出列表第一项。另外新增内置插件「模组翻译器」：上传一个模组 JAR，它会把里面的英文文本翻成中文，生成一个汉化资源包（原 JAR 不动、翻过的文本会缓存，下次几乎秒出）。这是快照版，可能带着未稳定的改动，遇到问题欢迎反馈。',
    groups: [
      {
        icon: 'i-globe',
        title: '新增 · 模组翻译器（内置插件）',
        items: [
          '插件页点「打开」→ 选一个模组 JAR（或直接拖进去），它会读出这个模组的语言文件，告诉你有多少条英文文本等着翻',
          '点「开始翻译」后生成一个**汉化资源包**放进 .minecraft/resourcepacks，进游戏在「选项 → 资源包」里启用即可 —— 原 JAR 一个字节都不动，不想要了删掉资源包就行',
          '支持 Forge / NeoForge / Fabric / Quilt，JSON 语言文件与 1.12 的老 .lang 格式都能翻',
          '**模组自带的汉化不会被覆盖**：已有中文的条目原样保留，只补缺的部分',
          '**占位符不会翻坏**：%s、%1$d、{0}、§7 这些会在翻译前保护起来，翻完原样还回去；对不上的那一条宁可留英文也不写坏',
          '**很省内存**：一次只读一个 JAR、只翻没翻过的文本，译文缓存在 XLC数据/translator-cache.json，第二次翻同一个模组几乎不联网；批量发送把请求数压到 1/10',
          '翻译需要联网，默认走 **MyMemory 官方免费接口**（有公开文档、免密钥，带联系方式时每天约 5 万字符）；额度用完后可在面板里勾选「备用通道」继续，那是 Bing 网页端自用的接口、不是开放 API，可能随时失效，只建议个人使用',
          '**翻不完也不会白干**：额度用完或网络中断时，已经翻好的条目照样写进资源包，剩下的下次接着翻（译文都缓存着）'
        ]
      },
      {
        icon: 'i-download',
        title: '改动 · 加载器版本选择不再标「推荐」',
        items: [
          '下载 / 更改 Fabric、Forge、NeoForge、Quilt 时，选版本下拉的置顶项从「最新（推荐 xxx）」改回「最新（版本号）」，不再替你标注官方推荐哪个',
          '版本列表里每项后面的「· 推荐」角标也全部删掉了，只保留第一项的「最新」角标',
          '选哪个版本完全由你决定；版本列表本身不变，还是按新到旧排好、可以搜索过滤'
        ]
      }
    ]
  },
  {
    version: '1.2-snapshot2',
    date: '2026-10-18',
    tag: '1.2 快照版',
    notice: '1.2 的第二个快照：插件可以给启动器添加自己的页面了 —— 插件包里放一个 page.html，侧栏就会多出一项，点开直接切过去，像启动器自带的页面一样。另外新增极速模式：按住左下角的小圆圈满 10 秒切换（按住时圆圈有进度环），字母从 L 变成 S、圆圈变琥珀色；想切回正常模式，再长按 10 秒就行。极速模式会把动画特效压到最低、收缩缓存，启动器更省内存，默认关闭。这是快照版，可能带着未稳定的改动，遇到问题欢迎反馈。',
    groups: [
      {
        icon: 'i-puzzle',
        title: '新增 · 插件可以给启动器添加页面',
        items: [
          '插件包根目录放一个 **page.html**，侧栏就会多出一项；点开在主窗口里直接切换过去，不开新窗口',
          '侧栏名字用插件清单里的 pageTitle（没写就显示插件名）；入口图标用插件 Images 文件夹里的 **Logo.png**（文件名必须是这个），没有就用默认图标',
          '页面里的接口和插件的设置面板完全一致：同一把钥匙、同一套权限 —— 照样上不了网、碰不到启动器界面',
          '图片等静态资源放插件自己的 Images 文件夹里，页面中相对路径引用即可',
          '不带 page.html 的插件一切照旧；停用或删除插件，侧栏那一项和页面一起消失'
        ]
      },
      {
        icon: 'i-pulse',
        title: '极速模式',
        items: [
          '左下角的小圆圈新增隐藏开关：**按住满 10 秒**切换极速模式，按住时圆圈出现进度环，中途松手不算数',
          '开启后圆圈字母从 **L** 变成 **S** 并换成琥珀色；想切回正常模式，在极速模式下再长按 10 秒即可（变回 L）',
          '极速模式把界面动画、过渡、阴影发光特效全部压到瞬间完成，弹窗开关也不再等退场动画',
          '同时收缩 Mod 搜索缓存（缓存条目 24→8、保存 5 分钟→2 分钟），降低启动器的常驻内存',
          '**默认关闭**，重启后保持上次的选择'
        ]
      }
    ]
  },
  {
    version: '1.1',
    date: '2026-10-11',
    tag: '1.1 正式版',
    notice: '1.1 正式版：设置页照 PCL 分类归组并补齐设置项，离线皮肤换了新的实现原理，版本列表加上了方块图标，种子地图的平台版本清单更新到 26.3，还补上了开源许可说明，并修掉了「点启动后启动器窗口凭空消失」这个烦人的 bug。页签与按钮的位置一律没动。',
    groups: [
      {
        icon: 'i-settings',
        title: '新增 · 设置页照 PCL 分类归组，设置项补齐',
        items: [
          '「设置」页现在按 PCL 的分类组织：**下载 / 启动 / 个性化 / 启动器** 四个分组标题，卡片按类归位 —— 原来散着的一长串，现在按用途一眼能找到',
          '**下载**组补齐「下载行为」：最大线程数之外，新增**速度限制**（KB/s，0 = 不限速）—— 全局对版本 / 资源 / Java / 组件下载生效，避免下载占满带宽影响看视频',
          '**启动**组补齐「启动选项」（全局默认，单个实例可在「游戏设置 → 基础设置」覆盖）：游戏窗口标题、窗口大小（含启动即最大化）、游戏进程优先级、启动器可见性（启动游戏后隐藏 / 最小化 / 保留）、启动前把游戏语言设为简体中文、请求使用高性能显卡',
          '「高级选项」新增**启动前执行命令**（支持 ${gameDir} / ${version} 占位）与全局**游戏参数**，跟随全局 JVM 参数归入同一张卡',
          '**启动器**组补齐「配置迁移与缓存」：**导出设置 / 导入设置**（把下载源、Java、内存、实例设置、个性化等偏好存成一个文件，换机导入即可；账户令牌、好友、皮肤不会进文件）与**清理缓存**（只删图标缓存与下载缓存，不动你的游戏和账户）'
        ]
      },
      {
        icon: 'i-user',
        title: '改进 · 离线皮肤换新实现原理',
        items: [
          '离线皮肤的皮肤服务器改成**标准的 Yggdrasil 兼容服务**（authlib-injector 规范）：本地随机端口起一个只监听 127.0.0.1 的临时服务，游戏内的其他玩家能正常看到你的自定义皮肤',
          '皮肤纹理现在带**正规签名**（RSA-SHA1），并随启动参数下发公钥 —— 修掉了老做法「皮肤下发没有签名，部分模组 / 服务端校验不认」的问题',
          '服务只应答标准路径（元数据 / 按名批量查询 / 单个档案 / 纹理下载），纹理上限 4MB，非皮肤图片会被拒绝；关掉启动器时服务随之关停',
          '用法没变：还是在「设置 → 离线皮肤」挑当前账户、选模型（经典 4px / 纤细 3px）、上传或移除皮肤'
        ]
      },
      {
        icon: 'i-download',
        title: '新增 · 版本列表的方块图标',
        items: [
          '**下载页的版本列表**每行前面有了方块图标：正式版是**草方块**、快照是**命令方块**、Beta / Alpha 远古版是**圆石**（跟 PCL、HMCL 一个路数，一眼分清版本类型）',
          '**首页的版本下拉**和**实例管理页**的每一行也带上了对应的方块图标 —— 改过名的实例也能按它对应的游戏版本正确显示',
          '图标用的就是游戏本体里的**原版方块贴图**（从客户端 jar 里提取，与 PCL、HMCL 同源），按像素方式缩放，小尺寸下边缘也不糊'
        ]
      },
      {
        icon: 'i-warn',
        title: '修复 · 点「启动游戏」后启动器窗口凭空消失',
        items: [
          '修掉一个让人以为「启动器自己关掉了」的 bug：**点了启动，启动器窗口却直接消失，而游戏其实没起来**。原因是「启动器可见性」把窗口藏起来之前，没确认游戏进程是不是真的还活着 —— 碰上版本损坏、Java 报错这类「进程秒退」的情况，窗口就会被藏进一个没有游戏的世界，再也回不来',
          '现在**隐藏前会先确认游戏进程仍在运行**，「进程退出 / 启动失败 / 关闭游戏」三条路都会把窗口收回来；另外加了一道**看门狗**：万一窗口还是被藏了而游戏没在跑，每 3 秒检查一次并自动恢复',
          '再做一层保险：**重复双击启动器图标也能把被隐藏的窗口叫回来**（以前只有「最小化」的窗口能这样找回）'
        ]
      },
      {
        icon: 'i-list',
        title: '新增 · 开源许可与致谢',
        items: [
          '「设置 → 启动器」新增**开源许可与致谢**卡：列明本程序的许可与用到的第三方组件（联机后端 Terracotta、离线皮肤用的 authlib-injector 等），点「查看完整许可声明」可以直接在启动器里读到全文',
          '随安装包补上了 **LICENSE**（本程序自身代码为 MIT 许可）与 **THIRD-PARTY.md**（第三方组件清单与致谢）两份文本',
          '「联机」页底部标出了联机后端的版权信息 —— 这是它许可条款里明确要求的署名'
        ]
      },
      {
        icon: 'i-map',
        title: '调整 · 种子地图的版本清单更新到 26.3',
        items: [
          '内置插件「种子地图」的平台 / 版本下拉以前只到 **1.21**，世界版本选不对，推算出来的地形和结构就全偏了 —— 现在换成完整清单：**Java 版 1.7 ~ 26.3、基岩版 1.14 ~ 26.50**',
          '下拉按 **Java 版 / 基岩版** 分成两组，默认选中最新正式版 **26.3**；26.x 这一段是 Minecraft 从 2026 年起改用的年份版本号（26.1 / 26.2 / 26.3），不是笔误',
          '顺带把平台参数改成白名单校验：只接受清单里的编码，别的一律拒绝（这类参数以前是直接拼进网址的）'
        ]
      },
      {
        icon: 'i-home',
        title: '调整 · 主页顶部的「快照版」提示条已移除',
        items: [
          '主页顶部原来那条「当前是快照版：可能包含未稳定的改动…」的提示条**已移除**，主页更清爽'
        ]
      }
    ]
  },
  {
    version: '1.1-pre1',
    date: '2026-10-09',
    tag: '1.1 预览版',
    notice: '这是 1.1 正式版发布前的预览版：这一轮把「游戏设置 → 基础设置」照着 PCL 的版本设置重排、设置项补齐，导出整合包独立成一页也不用再挑实例。页签与按钮的位置一律没动。',
    groups: [
      {
        icon: 'i-package',
        title: '新增 · 导出整合包的选项照 PCL 补齐',
        items: [
          '「导出整合包」的勾选清单从 6 项扩到 **PCL 导出页的全套**：游戏本体设置 / 游戏本体个人信息 / OptiFine 设置 / Mod（含「已禁用的 Mod」「整合包重要数据」「Mod 设置」「TaCZ 枪包」「沉浸画」「已绘制的地图」「JEI / EMI / 帕秋莉个人信息」等子项）/ 资源包 / 光影包（含光影包设置）/ 截图 / 导出的结构 / 录像回放 / 存档 / 协议 / 服务器列表',
          '判定规则与 PCL 同一套：**靠后的勾选项能覆盖靠前的** —— 比如「Mod」默认不收被禁用的模组，勾上「已禁用的 Mod」就单独捞回来；「Mod 设置」排除了 JEI 的个人信息，再勾「JEI 个人信息」又能加回来',
          '资源包、光影包、存档会**逐个列出**让你挑（存档还按修改时间排序），不必整个目录一起打包；命中不了任何文件的项自动不出现',
          '顶部可以填**整合包名称与版本号**（文件名会带上），每项还标着会打包多少个文件、多大体积；导入端也升级了 —— 包里的文件按原路径原样还原，且**不会覆盖你本机已有的文件**'
        ]
      },
      {
        icon: 'i-cpu',
        title: '优化 · 启动游戏快多了',
        items: [
          '点「启动游戏」后的准备阶段实测从 **9.8 秒压到 0.2 秒以内**。以前每次启动都要全盘扫一遍找出本机的 Java（有些机器上要 9 秒多），现在这份结果会记下来 —— 下次只做一次「文件没被换过」的校验，启动前不再干等',
          '认 Java 的方式也换了：先读 Java 安装目录里的 `release` 文件（一个几十字节的小文件就知道版本），读不到才去启动 java 进程问；几个候选 Java 也不再排着队一个个问，改成并行',
          '启动器打开后会在后台悄悄把这份清单刷新一遍（6 小时内有效就不重复扫），所以「刚打开启动器就点启动」和「玩完一轮再启动」一样快',
          '启动日志里新增一行**分段耗时**（版本链 / 账户 / Java / 内存 / classpath / natives / 启动参数 / 皮肤注入）—— 哪一段慢，一眼就能看出来'
        ]
      },
      {
        icon: 'i-settings',
        title: '修复 · 点了谁的设置就切到谁',
        items: [
          '实例卡片旁边的齿轮点下去，**整页的设置对象就跟着切到那个实例** —— 版本信息、模组加载器、导出整合包的目标全部一起换过去。以前齿轮只切了主页的选中项，进「基础设置」还得自己再选一遍版本才给设置',
          '从侧栏直接进「游戏设置」时，如果没设过「默认启动实例」，会**自动用你主页当前选中的那个实例**，不再一律要求先挑一个',
          '修掉一个真 bug：**实例重命名以前必定失败**（报 no such file or directory）。原因是目录改名之后还在按新名字去找版本 json，而文件名还是旧的 —— 现在改完名，版本名称、文件夹和各个下拉会立刻跟着更新'
        ]
      },
      {
        icon: 'i-box',
        title: '新增 · 「基础设置」照 PCL 的版本设置重排并补齐',
        items: [
          '「游戏设置 → 基础设置」现在按 PCL 的「版本设置 → 设置」组织：顶部先说明**这些设置只对当前实例生效**，下面按「版本信息 / 启动选项 / 内存分配 / 高级选项」分组 —— 页签与按钮位置没动',
          '**版本信息**：版本名称可以直接改（改名后 MOD / 存档 / 设置全保留，被其他实例继承的版本不能改）；版本文件夹一键打开，不用再一层层去找',
          '**版本隔离**：新增「自动 / 开启 / 关闭」三档 —— 开启后这个实例的 MOD / 存档只属于它自己，关闭则与其它版本共用。只切换游戏的运行目录、不搬文件，切完「存档看不见了」是预期现象、不是丢档，切回来就都在',
          '**游戏窗口标题**：给这个实例填一个标题，启动时以参数传给游戏（跟 PCL 同款做法）。原版客户端在较新版本上已经不认这个参数（装了「自定义窗口标题」这类 Mod 才一定生效），填了不会影响启动',
          '**Java 四种接法**（跟 PCL 一致）：自动选择；自动选择指定版本的 Java（填 [17.0, 25.0) 这样的区间，自动从本机挑符合的，没有就自动下载）；使用版本文件夹中的 Java（整合包自带 Java 的场景）；使用指定的 Java（浏览挑一个 javaw.exe）。指定的大版本不合适只提醒、不拦',
          '**内存分配**：从「一个开关」升级成 PCL 式三选一 —— 跟随全局设置 / 自动配置（按该实例的模组数与当时可用内存算）/ 自定义（给这个实例单独定一个值），每个实例各存各的，互不影响',
          '**高级选项**（默认折叠）：「Java 虚拟机参数」与新增的**游戏参数**都收在这里，按实例存、留空跟随全局；全局默认的 JVM 参数挪到了「设置 → 性能与目录」',
          '**游戏参数**会原样拼在启动命令末尾（例如填 --demo 就以试玩模式启动），支持用引号包住带空格的参数；填坏了清空即可恢复'
        ]
      },
      {
        icon: 'i-package',
        title: '调整 · 「导出整合包」独立成一页，也不用再挑实例',
        items: [
          '游戏设置里原来那个「版本管理」页改名成**「导出整合包」** —— 点进去就是这一件事，不用再找',
          '导出**不再让你选实例**（跟 PCL 一样）：要导的就是「基础设置 → 默认启动实例」那个游戏，卡片上直接写清当前是哪一个；想导别的实例，先去基础设置把默认启动实例切过去',
          '导出整合包以前有两个入口（「导入」页一张卡片、设置页一张卡片）；现在只保留这一个，「导入」页回归**纯粹的导入**，顶部写明导出在「游戏设置 → 导出整合包」',
          '点「导出此实例…」后照样能勾选打包内容（MOD / 配置 / 资源包 / 光影 / 存档 / 选项设置），只想备份配置、不想把几十 GB 存档塞进包里的时候尤其有用'
        ]
      },
      {
        icon: 'i-puzzle',
        title: '调整 · 「模组加载器」搬进基础设置',
        items: [
          '更改 / 卸载加载器从「游戏设置 → 版本管理」挪到「游戏设置 → 基础设置」，紧跟在「默认启动实例」下面 —— 它操作的正是那个实例；改完**即时生效**，不用点「保存游戏设置」',
          '加载器与导出现在写的是**同一个**作用对象（默认启动实例），免得手一滑改错版本 —— 更改加载器要重建实例，改错对象代价不小'
        ]
      },
      {
        icon: 'i-puzzle',
        title: '新增 · 社区插件卡片下方可以直接「删除插件」',
        items: [
          '每张社区插件卡片下方都有一个**删除插件**按钮，点下去会先弹框问一遍，确认后才动手 —— 插件连同它自己存的数据一起删掉，启动器的游戏目录、存档与设置都不受影响',
          '卡片顺便改成上下两段：上面是插件信息、下面是操作（打开目录 / 删除插件），不会再把按钮挤到标题行里去'
        ]
      },
      {
        icon: 'i-check',
        title: '修复 · 三处细节',
        items: [
          '**更新检测**不再只看下载页里第一条直链：以前页面里旧版本文件排在前面时会读成旧版本、明明有新版本却说「已是最新」；现在会扫完整页、取版本最高的那个（下载页里新版本文件排第一这条部署纪律仍然要守，老客户端改不了）',
          '**更新公告**里用两个星号括起来的加粗标记现在真的显示为粗体（此前会原样显示星号）；转义顺序也做对了：先转义再替换，免得公告文本被当成 HTML 拼进页面',
          '从「导出整合包」页点实例的齿轮进入实例设置时，不会再出现「导出整合包」和「MOD 管理」两页叠着显示'
        ]
      }
    ]
  },
  {
    version: '1.1-snapshot2',
    date: '2026-10-06',
    tag: '1.1 第二个快照',
    notice: '本次是 1.1 的第二个快照，改动还在开发中：现在做完的会先写进下面的分组，其余随开发逐条补上。',
    groups: [
      {
        icon: 'i-puzzle',
        title: '新增 · 拓展插件（社区插件）：网友可以给启动器做插件了',
        items: [
          '插件页现在多了一类「社区插件」：由网友制作、打包成一个 ZIP，在「导入 → 导入插件」里装进来，装完就和其他插件一样出现在列表里，可以启用 / 停用 / 打开面板 / 移除',
          '插件和启动器之间只隔着一份公开的「清单 + 接口表」：作者写一个 plugin.json（插件名、版本、要用到哪些能力）加一个面板网页就够了 —— 看不到、也拿不到启动器的源码，这是特意这样设计的',
          '打开社区插件时，它的面板在一个**独立窗口**里运行：拿不到启动器的界面与内部接口，也读不到你的游戏目录、存档和设置；想存东西只能存进插件自己的目录，想联网必须先声明网站域名',
          '导入前会把插件申请的能力逐条列给你看（弹提示 / 存数据 / 读启动器信息 / 读已装版本 / 打开网站 / 联网取数据），不想给的一律可以取消勾选；没勾的能力它运行时用不了，会被直接拒绝并说明原因',
          '插件偷偷联网是走不通的：面板所在的环境把网络请求整个切断了（面板里自己写的 fetch 一律失败），要取数据只能走启动器代劳的那条路，而那条路又必须提前声明访问哪个域名',
          '装插件不会动你的启动器：它不往启动器程序目录里写任何东西，文件全部放在数据目录的 plugins 文件夹下（插件卡片下方的「打开目录」可直接打开）；停用或删除时面板窗口立刻关掉，文件一并清理',
          '不想要的社区插件不用留着：每张社区插件卡片下方都有一个**删除插件**按钮，点下去会先弹框问一遍，确认后才动手 —— 插件连同它自己存的数据一起删掉，启动器的游戏目录、存档与设置都不受影响；以后想用再重新导入插件包就行',
          '自己想做插件、或者想拉朋友一起做的：插件开发文档与一份可直接运行的最小示例已经备好，缺的只是「一个人照着改」'
        ]
      },
      {
        icon: 'i-download',
        title: '新增 · 模组加载器可以选版本了',
        items: [
          '装 Fabric / Forge / NeoForge / Quilt 时不再只能装「最新版」：选好加载器后下面多了一行「加载器版本」，点开就是该 MC 版本能装的全部版本（第一项是「最新」，官方推荐的稳定版会标出「推荐」）',
          '版本多的时候（Forge 常有几百个构建）旁边会自动出现一个过滤框，打几个字就能筛出想要的那一版，不用在长长的列表里翻',
          '「模组加载器 → 更改加载器」里原来的手输「构建号」输入框换成了同样的版本下拉 —— 不必先去别处查版本号长什么样，直接挑；同一个实例想换加载器版本也走这里（这个入口这次挪到了「游戏设置 → 基础设置」，见下面那条调整）',
          '不选就是最新版，和以前完全一样；选了就装你挑的那一版 —— 挑不到会明确报错告诉你能装哪些，不会悄悄装成别的版本',
          '顺带修正了 Forge 老版本（1.7.10 那种）选版本会被忽略的问题：以前只有纯数字构建号能被识别，现在带 MC 前缀的完整版本号也能精确匹配'
        ]
      },
      {
        icon: 'i-package',
        title: '调整 · 导出整合包独立成一页，也不用再挑实例了',
        items: [
          '游戏设置里原来那个「版本管理」页现在改名成**「导出整合包」** —— 点进去就是这一件事，不用再找',
          '导出**不再让你选实例**（跟 PCL 一样）：要导的就是「基础设置 → 默认启动实例」那个游戏，卡片上直接写清当前是哪一个；想导别的实例，先去基础设置把默认启动实例切过去',
          '导出整合包以前有两个入口（「导入」页一张卡片、设置页一张卡片），两处做的事其实一样；现在只保留这一个，「导入」页回归**纯粹的导入**，不再重复放导出按钮',
          '点「导出此实例…」后照样能勾选打包内容（MOD / 配置 / 资源包 / 光影 / 存档 / 选项设置），只想备份配置、不想把几十 GB 存档塞进包里的时候尤其有用',
          '找不到了也不用翻：「导入」页顶部现在写明导出在「游戏设置 → 导出整合包」'
        ]
      },
      {
        icon: 'i-puzzle',
        title: '调整 · 「模组加载器」搬进基础设置，导出页更清爽',
        items: [
          '更改 / 卸载加载器从「游戏设置 → 版本管理」挪到了「游戏设置 → 基础设置」，紧跟在「默认启动实例」下面 —— 它操作的正是那个实例；改完**即时生效**，不用点「保存游戏设置」',
          '导出页最上面那行「选择实例 + 刷新」整行删掉，原本收进卡片里的实例下拉也一并去掉：导出跟随默认启动实例，页面上不再有第二个实例下拉',
          '加载器与导出现在写的是**同一个**作用对象（默认启动实例），免得手一滑改错版本 —— 更改加载器是要重建实例的，改错对象代价不小'
        ]
      },
      {
        icon: 'i-box',
        title: '新增 · 基础设置照 PCL 的版本设置补齐',
        items: [
          '「游戏设置 → 基础设置」照着 PCL 的「版本设置 → 设置」重排：顶部先说明**这些设置只对当前实例生效**，下面按「版本信息 / 启动选项 / 内存分配 / 高级选项」分组 —— 页签与按钮的位置没动',
          '**版本信息**：版本名称可以直接改（改名后 MOD / 存档 / 设置全保留，被其他实例继承的版本不能改）；版本文件夹一键打开，不用再一层层找',
          '**版本隔离**：新增「自动 / 开启 / 关闭」开关 —— 开启后这个实例的 MOD / 存档只属于它自己，关闭则与其它版本共用。只切换游戏的运行目录、不搬文件，切完「存档看不见了」是预期现象不是丢档，切回来就都在',
          '**游戏窗口标题**：给这个实例填一个标题，启动时以参数传给游戏（跟 PCL 同款做法）。原版客户端在较新版本上已经不认这个参数（装了「自定义窗口标题」这类 Mod 才一定生效），填了不会影响启动',
          '**Java 四种接法**（跟 PCL 一致）：自动选择；自动选择指定版本的 Java（填 [17.0, 25.0) 这样的区间，自动从本机挑符合的，没有就自动下载）；使用版本文件夹中的 Java（整合包自带 Java 的场景）；使用指定的 Java（浏览挑一个 javaw.exe）。指定的大版本不合适只提醒不拦',
          '**内存分配**：从「一个开关」升级成 PCL 式三选一 —— 跟随全局设置 / 自动配置（按该实例的模组数与当时可用内存算）/ 自定义（给这个实例单独定一个值），每个实例各存各的，互不影响',
          '**高级选项**（默认折叠）：「Java 虚拟机参数」与新增的「游戏参数」都收在这里，按实例存、留空跟随全局；全局默认的 JVM 参数挪到了「设置 → 性能与目录」',
          '**游戏参数**会原样拼在启动命令末尾（例如填 --demo 就以试玩模式启动），支持用引号包住带空格的参数；填坏了清空即可恢复'
        ]
      },
      {
        icon: 'i-check',
        title: '修复 · 更新公告：加粗标记现在真的显示为粗体',
        items: [
          '公告正文里用两个星号括起来的加粗标记，此前会被原样显示成星号（弹窗里看到的是带星号的原文），现在会正常渲染成粗体',
          '顺带把转义的顺序做对：先转义、再替换标记 —— 反过来等于把公告文本当 HTML 拼进页面，等公告有一天改成从网络拉取就是注入漏洞'
        ]
      }
    ]
  },
  {
    version: '1.1-snapshot1',
    date: '2026-10-06',
    tag: '1.1 首个快照',
    notice: '本次是 1.1 的第一个快照：新增「手柄控制」插件，接上手柄就能操作启动器 —— 摇杆移动焦点或推动屏幕上的虚拟光标、A 确认 / 点击、B 返回、LB / RB 翻页、Start 直接启动游戏，全程不需要键鼠，也不影响原来的鼠标键盘操作（鼠标一动自动撤掉手柄焦点与光标，并把被手柄藏起来的鼠标指针立刻还回来）。默认的「光标模式」把右摇杆当鼠标用：界面上有一个看得见的圆形光标（外环 + 中心点，就是电视遥控 / 游戏主机那套指针形态），指哪点哪，指到能点的东西上圆环会自动放大、中心点变成主题色；长按 A 时外圈涨出蓄力环，涨满即可拖动滑块 —— 焦点一格一格跳够不着的地方也能点到；按 R3 可随时切回「焦点模式」。焦点按屏幕上控件的实际位置移动，「往上按就往上走」，弹窗打开时焦点自动限制在弹窗内、B 键即返回；插件面板里有「连接状态」与「实时输入」，能直接看到手柄是否被识别、哪个键按下、摇杆推到哪，排查问题不用猜。摇杆死区、移动速度、光标速度、震动反馈、按键提示浮层都可调并保存在本机。此外还修了两处细节：正在下载时按 B 不会误关弹窗（会提示用「转入后台」或「停止安装」）；手柄刚接上时先记录按键基线，不会因为「按一下唤醒手柄」而误触发一次点击。顺带修了 NeoForge 的几处判定问题：1.20.1 明明有构建却显示「不兼容」、新版本号（26.x）检测说兼容却装不上、上游响应慢时被误报成不兼容；现在检测与安装结论一致，源慢时也会明确提示「未能确认 · 重新检测」而不是谎报不支持。另外主页那个大圆按钮现在有两副面孔：游戏跑起来后它会变成「关闭游戏」（▶ 变 ■，跟视频播放器一样），点一下就能关掉游戏，不用再去任务管理器里找 java.exe。另外「下载」页新增了一个「光影」标签：从 Modrinth 与 CurseForge 搜索光影包，一键装进 shaderpacks —— 可以指定装给哪个实例（版本隔离实例会装进实例自己的光影目录），页面顶部会写清落点，并提醒光影需要 Iris 或 OptiFine 才能在游戏内选中生效；详情页还能挑具体版本，装的就是你点的那一条。另外「设置 → 版本更新」里多了一个「跳过快照版更新」开关（开着就只收正式版更新，检测结果会写明跳过了哪一版），主页顶部也会在当前跑的是快照版时写明「可能有严重 BUG、请前往抖音主页反馈群反馈」（那行提示里的反馈入口可直接点，点一下就在浏览器里打开抖音主页）。另外「设置 → 版本更新」里新增了「版本回退」：官方下载页上还挂着的历史版本（1.0、RC 1、Pre 1、Beta 1.0）会逐个列出来，想回哪一版点哪一版 —— 回退下的是**免安装的便携版 exe**，点「替换并重启」用它覆盖当前的启动器程序即可，不用跑安装向导，也不会动游戏目录、存档与设置；当前跑的是快照版时还会给出一键回到最新正式版的入口，配合「跳过快照版更新」就能稳稳待在正式版上。另外本快照还做完了一轮全面自检的整改（50 项机械审计 + 多轮人工审查）：内存参数钳制（填多大都不会再让游戏起不来）、classpath 分隔符按平台自动选择、下载写入失败不再「进度条永久卡住」、联机组件反复下载的监听器泄漏、ZIP 解压路径校验、版本名与「打开文件夹」的范围校验等一并对齐，细节见下面的分组。另外智能内存分配换成了 PCL 式的算法：先看这个实例装了多少模组需要多大内存（原版给得少、几百个模组的整合包给得多），再看此刻系统真正剩多少可用内存分档发放；用 32 位 Java 时压到 1 GB，手动滑块的上下限也跟着物理内存走，「游戏设置 → 内存」里会写清推荐值是怎么算出来的。本快照为 1.1 的第一个内部版本，后续继续迭代。' ,
    groups: [
      {
        icon: 'i-gamepad',
        title: '新增 · 手柄控制：不碰键鼠也能从选版本走到进游戏',
        items: [
          '插件页多了一个「手柄控制」插件：接上手柄就能用它操作启动器 —— 左摇杆或十字键移动焦点、A 确认、B 返回、LB / RB 翻页、Start 直接启动游戏，全程不需要键鼠',
          '带一个「圆形光标」：右摇杆直接当鼠标用，界面上会出现一个外环 + 中心点的准星（跟电视遥控、游戏主机的指针一个路子），推摇杆挪光标、A 点击、长按 A 还能拖动滑块 —— 按住时会涨出一圈蓄力环，告诉你「再按一会儿就能拖」。指到能点的东西上，圆环会自动放大、中心点变成主题色；焦点跳转够不着的地方（滑块、滚动条、卡片上的空白处）这下都能点到；按 R3 可以随时在「光标 / 焦点」两种模式间切换，鼠标一动就让位给真鼠标',
          '焦点不是按顺序一个个挪，而是按屏幕上控件的实际位置走：往上按就往上走、往右按就往右走，和用鼠标指哪打哪一样自然；打开弹窗时焦点会自动限制在弹窗里，B 键就是「返回」',
          '插件面板里有「连接状态」和「实时输入」两块：能直接看到手柄有没有被识别、按下的键和摇杆位置实时亮起，排查手柄问题不用猜',
          '摇杆死区、移动速度（慢 / 标准 / 快）、光标速度、震动反馈、按键提示浮层都能自己调；设置存在本机，重启启动器依然生效',
          '右摇杆上下 = 鼠标滚轮：轻推慢慢滚、推到底快速翻长列表，滚的是指针底下那个容器，指哪滚哪（轻推能停在想看的位置）',
          '手柄也能选中「自定义行」了 —— 版本下拉里的版本、下载页的版本行、存档卡片、资源标题、下载浮窗这些原来是「div + 点击」，手柄跳不过去也点不到，现在焦点与光标两种模式都能选中；下载页的版本行也整行可点了（以前只有右侧那个小按钮能点，点行体没反应）',
          '鼠标键盘完全不受影响：鼠标一动就会撤掉手柄焦点，两套输入互不打架；不插手柄时后台什么都不做，没有任何额外开销',
          '手柄一动就把系统鼠标指针收起来 —— 此时屏幕上有焦点环 / 圆形光标指路，那个白色箭头是多余的；鼠标一动、点击或滚轮立刻显示回来，不用再去别处找指针。面板里可以关掉这一项（默认开启）',
          '下载中按 B 不会误关弹窗，而是提示用「转入后台」或「停止安装」，避免手滑中断下载'
        ]
      },
      {
        icon: 'i-play',
        title: '新增 · 主页按钮两副面孔：游戏跑起来就变「关闭游戏」（▶ → ■）',
        items: [
          '主页那个大圆按钮现在有两副面孔：待机时是 ▶「启动游戏」，游戏真的跑起来后同一位置换成 ■「关闭游戏」—— 跟视频播放器的开始 / 停止一样，点一下就关掉游戏，不用再去任务管理器里找 java.exe',
          '「运行中」的判定来自主进程（游戏进程真的拉起来了才算），不是界面自己猜的；启动准备阶段（下 Java / 校验文件）按钮保持禁用，避免连点双开',
          '「关闭游戏」收的是整棵进程树：游戏本体是 java.exe，模组 / 启动参数可能再分出子进程，只杀父进程会留下一堆孤儿进程继续吃内存',
          '自己点的关闭按正常收尾处理：不报「异常退出」、也不跑崩溃诊断（否则每次关游戏都要白等一次诊断并弹「诊断」页）；底部状态与副标题跟着走「运行中 → 就绪」',
          '存档「用该版本启动」、最近游玩「快速启动」、实例页的「启动」共用同一条启动路径：游戏已在运行时会被拦下并提示，不会双开'
        ]
      },
      {
        icon: 'i-refresh',
        title: '修复 · NeoForge：检测与安装不再自相矛盾',
        items: [
          '修掉「NeoForge 明明有构建却报不兼容」：NeoForge 官方源在国内时常连不上、回 502，而它的镜像（BMCLAPI）现在要先跳一次对象存储，实测同一台机器上 1 秒到 15 秒都可能；原来给镜像只留了 10 秒，两边一起慢的时候就会误报「构建信息获取失败」，界面上直接显示成「✗ NeoForge 与 xxx 不兼容」，把人吓退。现在镜像留足 20 秒，而且真查不到的时候改成「⚠ 未能确认 + 重新检测」（与 Quilt 那套一致），不再把网络问题说成不支持',
          '修掉 1.20.1 上 NeoForge 的错判：1.20.1 的 NeoForge 用的是旧坐标（版本号形如 1.20.1-47.1.106），而原来的前缀推导算出的是「20.1.」，跟任何一条版本都对不上 —— 结果 1.20.1 明明有 62 个构建，界面上却是「✗ 不兼容」、装不了。现在 1.20.1 能正常检测并安装 NeoForge（最热门的模组版本，这个修复很关键）',
          '修掉新版本号（26.x）装不上 NeoForge：安装器原来按「1.x.y」的格式解析版本号，遇到 26.3 这种没有「1.」前缀的新编号会直接报「无法解析版本号」—— 检测说兼容、安装却失败。现在安装与检测统一走同一套前缀规则',
          'NeoForge 只发布了预发布版时，不再出现「检测说兼容、安装说没有正式构建」：优先装正式版，确实一个正式版都没有（例如 26.3 目前只有 -beta）就装最新的预发布版，与 OptiFine「正式版优先、没有则用预览版」保持同一策略',
          'Forge / OptiFine 的构建查询也一并区分「查不到」与「确实没有」：网络慢不再被当成不兼容'
        ]
      },
      {
        icon: 'i-download',
        title: '改进 · 下载页：最新正式版与预览版置顶',
        items: [
          '「下载游戏」的版本列表最上面现在固定一个「置顶」区，同时给出当前最新正式版与当前最新预览版（快照 / 预发布 / 候选版）—— 不用在「正式版 / 快照版」几个标签间来回切，一眼就知道现在最新的是什么',
          '置顶的两条取自版本清单自带的官方标注（Mojang 的 latest.release 与 latest.snapshot），不是按发布日期自己猜，所以不会出现「预发布版被当成正式版」这类错位',
          '置顶区里的版本不会在下面再重复出现一次；搜索时会自动收起置顶区 —— 否则「明明没匹配到，顶上却还挂着两条」会让人误以为搜索没生效',
          '「远古版本」标签下不置顶：那个页面本来就是专门翻 b1.7.3 这类老版本的，顶上塞个 26.3 只会添乱',
          '下载页默认选中的分类改成「全部」：以前默认停在「正式版」，想装个快照 / 预览版还得先手动切标签；现在一进来就是全部版本，置顶区仍然把最新正式版与最新预览版单独拎在最上面'
        ]
      },
      {
        icon: 'i-shader',
        title: '新增 · 光影下载：Modrinth / CurseForge 两源搜索，一键装进 shaderpacks',
        items: [
          '「下载」页多了一个「光影」标签：从 Modrinth 与 CurseForge 两个源搜索光影包（可切单源，或「综合」两源合并按下载量排序），点「安装光影」直接装进游戏目录的 shaderpacks，不用再自己去论坛和网盘里翻压缩包',
          '可以指定装给哪个实例：选具体实例就装进那个实例的光影目录（版本隔离实例读的是实例目录里的 shaderpacks，装对位置游戏里才看得到）；选「全部」则放进游戏根目录，所有实例共用',
          '面板顶部会写清这次到底装到哪个目录，并提醒光影需要 Iris 或 OptiFine 才能在游戏内选中生效；若选中的实例是原版（没有模组加载器），会明确告诉你「只装光影不会生效，还得先装 Iris / OptiFine」，省得装完一脸问号',
          '详情页里能挑具体版本：列出该光影适配的各版本文件（带 MC 版本与体积），装的就是你点的那一条，不是「悄悄给你最新版」',
          '光影按 MC 版本筛适配，但**不按模组加载器筛** —— 光影在 Modrinth 上是 iris / optifine 分类，拿 fabric / forge 去筛必然 0 结果（这是光影和 MOD 最不一样的地方）；当前版本确实没适配时自动回退展示热门光影并明确提示',
          '搜索支持中文：输入「光影」「着色器」就能搜到，不用先想英文名'
        ]
      },
      {
        icon: 'i-refresh',
        title: '修复 · 版本号判定：装了新快照，不会再被劝「更新」到旧正式版',
        items: [
          '修掉「明明是更新的版本却说旧版才是最新」：版本号比较原来把所有预发布 / 快照一律归进「0 系列」，于是任何正式版都排在它们前面 —— 装了 1.1-snapshot1 的用户会被劝去「更新」到更旧的 1.0。现在改成按「目标版本 + 阶段」两段比：1.1-snapshot1 比 1.0 新，但仍比正式版 1.1 旧（同为 1.1，正式版盖过快照）',
          '早期那种「关键字写在最前」的老写法（Beta1.0 / Pre1 / RC1）仍按 0 系列处理，正式版照样能盖过它们 —— 老预发布用户不会因此收不到正式版更新',
          '版本号比较补了离线自测（含 1.1-snapshot1 与 1.0 / 1.1 的对照用例），以后调版本规则不会再悄悄改坏更新判定'
        ]
      },
      {
        icon: 'i-refresh',
        title: '新增 · 版本更新：可以「跳过快照版更新」，主页提示快照版风险',
        items: [
          '「设置 → 版本更新」里多了一个开关「**跳过快照版更新**（只接受正式版更新）」：开启后，更新源上出现的是快照 / 预发布 / 候选版时不提示更新，只有正式版才会提示。默认关闭 = 照旧都提示',
          '开着的时候检测结果不会含糊地写成「已是最新版本」，而是明确告诉你「更新源上的 1.1-snapshot2 是快照版，已按设置跳过」—— 开关一改会**自动重新检测**一次，想装随时关掉开关即可',
          '主页顶部新增一行**快照版提示**：当前跑的版本是快照 / 预发布版时，顶部会写明「快照版可能包含未稳定的改动、可能出现严重 BUG」，并提示前往抖音主页反馈群反馈 —— 那行字里的**反馈入口可以直接点**，点一下就在浏览器里打开抖音主页；附上诊断日志能更快定位。正式版不会有这一行，省得让人误会',
          '判定用的是与更新检测同一套版本阶段规则，不存在「更新里跳过了、主页却还提示快照」这种前后打架的情况'
        ]
      },
      {
        icon: 'i-download',
        title: '新增 · 版本回退：可以回到任意历史版本',
        items: [
          '「设置 → 版本更新」里新增「**版本回退**」区：把官方下载页上还挂着的历史版本（1.0、RC 1、Pre 1、Beta 1.0 这些）逐个列出来，每个都标明是**正式版**还是**快照 / 预发布**，想回哪一版就点哪一版（下的是**免安装的便携版 exe**，不需要跑安装向导）',
          '回退走的是「覆盖」而不是「安装」：启动器内下载那一版的便携版 exe → 点「替换并重启」，它会把当前的启动器程序文件换成这一版再自动打开，就算回到那一版了。**游戏目录、存档、设置与账户都不会动**；回退以后想再更新回来，点一下「检测更新」就行',
          '当前跑的正是快照版时，回退区会额外给出「**回到稳定版**」的提示卡，一键回退到最新正式版 —— 配合「跳过快照版更新」，就能稳稳待在正式版上',
          '回退区只列比当前旧的版本（正在用的这一版会标出来，但不给回退按钮）；已经是最老的版本时，这一区自动隐藏'
        ]
      },
      {
        icon: 'i-cpu',
        title: '改进 · 智能内存分配：改成 PCL 式算法，按「实例需要多少 + 系统还剩多少」来发',
        items: [
          '**智能内存分配换了算法**：以前是「看物理内存总量查表」—— 8 GB 给 4 GB、16 GB 给 6 GB 这样一刀切，**完全不看你要启动的实例装了多少模组**，几十个模组的整合包和空的原版给得一样多。现在分两段算：**先看这个实例需要多少**（按启用的模组数量推出「起步 / 舒适 / 充裕」三个目标值，原版与装了 OptiFine 的另有基准），**再看此刻系统真正剩多少可用内存**分四档发 —— 需求在「起步」以内全给，往上是 70%、40%，再多只给 15%，既够用又不会把系统挤爆',
          '模组数量按**这个实例自己的 mods 目录**数（版本隔离的实例只算它自己的，再并上全局 mods 目录，同名只算一次）；只数启用的 `.jar / .zip / .litemod`，被改名成 `.jar.disabled` 的停用模组不计入，模组形态安装的 OptiFine 也认得（装了它基准值抬高一档）；因此原版给得少、几百个模组的整合包给得多',
          '用 **32 位 Java** 启动时一律压到 1 GB —— 32 位 JVM 本来就寻址不到更大的堆，给再多也起不来（会直接报「Could not reserve enough space」）',
          '兜底规则：无论如何不低于 1 GB，上限取「物理内存 - 1 GB」（给系统留余量）且不超过 64 GB，再向下取整 —— `-Xmx` 只认整数',
          '「游戏设置 → 内存」的提示改了：不再只写「物理内存 N GB」，而是写清**这台机器有多少、此刻还剩多少、这个实例有多少个模组、据此推荐多少**，鼠标悬停能看到四个目标值与分档规则，推荐值是怎么算出来的一目了然',
          '手动滑块的上下限跟着物理内存走：以前写死 2~16 GB，32 GB 的机器想把内存拖到 16 以上都拖不动；现在上限按物理内存算，机器够大就能给到位。换「默认实例」时会立刻按新实例重算一遍推荐值'
        ]
      },
      {
        icon: 'i-check',
        title: '修复 · 一轮全面自检后的整改：内存 / 跨平台 / 下载稳定性',
        items: [
          '修掉「内存填大数游戏反而起不来、还看不出原因」：此前内存只有下限、没有上限，设置里填 999（GB）会被原样写进 Java 参数（-Xmx999G），游戏启动即失败、报错却和「内存设置」毫无关系，很难自查。现在内存值统一钳制 —— 下限 1 GB、上限取「64 GB 与物理内存中较小者」，填多大都只会落到这台机器扛得住的范围里',
          '修掉 classpath 分隔符被写死成分号：Java 的类路径在 Windows 上用「;」分隔，Linux / macOS 上是「:」。写死分号会让整条类路径在非 Windows 系统上被当成**一个**路径 —— 一个库都找不到、游戏直接起不来。现在按运行平台自动选择分隔符（这项也正是那轮 50 项机械审计里**唯一**没通过的一项，现已修复）',
          '修掉「下载写到一半卡死」：磁盘写满、没有写入权限、目标文件被别的程序占用这类情况，此前下载的写入流没有任何错误兜底 —— 界面表现为进度条永久卡住，既不出错也不结束（看着就是「卡死」）。现在写入一旦失败会立刻结束这次下载、把原因报出来，并照常清理没写完的临时文件，重试即可',
          '修掉「联机」页反复点「下载组件」会持续堆积监听（内存泄漏）：此前每点一次「下载」就多挂一个永不解绑的进度监听，点得越多堆得越多；现在下载一结束立刻解绑，与「一键开服」里同一段逻辑保持一致',
          '加固 ZIP 解压：包内条目名带「../」时可能被写到目标目录之外（zip-slip）。现在解压前先把条目路径规范化，越界条目直接跳过 —— 解压 natives 与整合包导入/导出工具里的同类解压都用上了这同一道校验',
          '加固版本目录名校验：启动游戏、查看版本信息时传入的版本名必须是纯名字，带「../」这类路径形态的会被直接拒绝，杜绝越过游戏目录去读别的文件（与删除 / 重命名实例的校验保持一致）',
          '收紧「打开所在文件夹」的范围：只允许打开游戏目录与启动器数据目录里的路径，其他位置即使被传入也不会交给系统打开 —— 与外部链接的协议白名单是同一个思路',
          '以上整改来自一轮全面自检（50 项机械审计 + 多轮人工代码审查）：50 项审计 49 项通过（唯一没通过的正是上面的跨平台分隔符，已修），审查未发现高危问题；同时复核确认了一批本就扎实的地方（命令调用全部走参数数组、界面输出统一转义、下载原子写入与完整性校验、取消检查点、启动防重入锁等）。这一轮主要是把这些边角补齐'
        ]
      }
    ]
  },
  {
    version: '1.0',
    date: '2026-10-05',
    tag: '正式版',
    groups: [
      {
        icon: 'i-zap',
        title: '优化 · 加载器检测：快了一个数量级，也不再误判',
        items: [
          '打开安装弹窗、或在弹窗里切换加载器时，启动器只先查你选中的那一个，结果一回来就立刻显示；其余加载器在后台并行补齐 —— 不用再等「最慢的那个」才出结果（以前要同时等 5 个请求，其中 NeoForge 官方源在国内经常连不上，动辄干等十几秒）',
          '实测：选中加载器的检测结论约 0.1 秒就能显示出来（以前是几秒到十几秒），选好加载器马上就能点「开始安装」',
          '修掉一个会误导人的判定：Quilt 官方源在国内很慢（常常 20 秒以上才回），以前查询超时会被当成「没有构建」，界面上显示「✗ 不兼容」，让人误以为 Quilt 根本不支持该版本；现在把「查询超时」和「确实没有构建」分开处理 —— 超时会明确显示「? 查询超时」并给一个「重新检测」按钮，不再谎报不兼容',
          '所有联网查询都加上了超时，多个来源并行竞速（Fabric 官方源与 BMCLAPI 镜像谁快用谁、NeoForge 的官方源与镜像同时发起），慢源不会再拖死整个检测',
          '同一个「加载器 + 版本」正在查询中的请求会自动合并：来回点切换单选项不会重复发请求，也不会看到结论反复闪烁',
          '仍然保持你要求的行为：不缓存旧结论，每次打开安装弹窗都会重新向官方源查一遍，加载器发布新构建后不用等启动器更新就能立刻装上'
        ]
      },
      {
        icon: 'i-package',
        title: '新增 · OptiFine 支持：自动以「模组」形式安装',
        items: [
          '安装界面里的 OptiFine 现在是真的能装了：选中后会先确保该版本装有 NeoForge 或 Forge（没有就自动帮你装一个），然后把 OptiFine 放进该实例的 mods/ 目录，装完选中该实例即可启动',
          '为什么要这样做：新版 OptiFine 的安装包本身就是一个 Forge / NeoForge 模组（内部带 mods.toml 声明）；它的官方「安装器」是一个图形界面程序，在启动器里无人值守运行时必然卡死，所以启动器改用「直接放进 mods/」的方式 —— 与玩家手动安装的效果完全一致，且全程不需要任何点击',
          '界面上写明了这个行为（会提示「以模组形式安装：会先确保有 NeoForge 或 Forge，再放进 mods/」），不会让你以为装错了地方',
          '如果该版本已经有 Forge / NeoForge 实例，会直接复用最近使用的那个，不会重复安装前置'
        ]
      }
    ],
    notice: '本次是 XLC 启动器的正式版（1.0）。这一版主要把「安装模组加载器」这条链路做扎实：加载器兼容性检测大幅提速 —— 只先查你选中的那个加载器、约 0.1 秒就出结论（以前要等 5 个请求里最慢的一个，NeoForge 官方源被墙时常要干等十几秒），其余加载器在后台补齐；同时修掉一个会误导人的判定 —— Quilt 官方源在国内很慢（20 秒以上），以前超时会被当成「不支持」，现在会明确显示「查询超时」并可以重新检测，而不是谎报不兼容。另外，安装界面里的 OptiFine 现在真的能装了：启动器会自动准备 NeoForge / Forge 前置，再把 OptiFine 以模组形式放进实例的 mods/ 目录（新版 OptiFine 本身就是一个 Forge / NeoForge 模组，官方图形安装器在无人值守环境必挂，所以改用与手动安装等效的方式）。所有联网查询都加了超时并支持多源并行竞速，慢源不会再拖死检测。'
  },
  {
    version: 'RC1',
    date: '2026-10-03',
    tag: '发布候选',
    groups: [
      {
        icon: 'i-server',
        title: '优化 · 一键开服：开完服直接给地址、一键同步 mod、外网联机',
        items: [
          '服务器创建完成后，控制台正上方直接弹出「连接地址」面板：本机地址与局域网地址并排显示，点右侧「复制」就能发给好友，不用再去翻配置文件或自己拼 IP 和端口',
          '面板里写清了进服步骤：打开游戏 → 多人游戏 → 添加服务器 → 服务器地址粘贴这串地址 → 完成；同一台电脑自己玩用「本机」地址，同一 WiFi 下的好友用「局域网」地址',
          '「我的服务器」列表里每台服务器也会显示进服地址（形如 127.0.0.1:25565 · 局域网 192.168.x.x:25565），点一下地址行即可复制，不用先点开控制台',
          '附带常见连不上的原因提示：首次开服若弹出 Windows 防火墙询问，必须勾选「专用网络」并允许访问，否则好友连不上；不在同一网络（外网联机）需要内网穿透或公网 IP 端口映射，本机地址对外无效',
          '离线模式（关闭正版验证）的服务器会额外标注「好友需在启动器里关闭正版验证才能进服」；服务器加载完成（日志出现 Done）时还会再提示一次「已就绪，可以进服了 + 地址」',
          '面板上的状态标签会跟着服务器走：没启动时显示「启动后才可连入」，进程起来后变成绿色的「已就绪」，一眼就知道现在能不能进',
          'Fabric 服务器新增「同步 mod」按钮（卡片右侧的循环箭头）：一键把客户端实例里「服务端也要装」的 mod 拷进这台服务器，纯客户端 mod（光影、优化、界面类）自动跳过，重复点不会重复拷贝，已存在的同名 mod 会自动跳过',
          '同步来源自动识别：优先使用你最近启动的实例，认不出来就扫描游戏目录里所有实例的 mods 文件夹、选最近改动过的那个，不需要手动挑实例',
          '未装 mod 的 Fabric 服务器，卡片上会显示黄色「未装 mod」标记与一行说明；同步完成后标记自动消失，卡片上改为显示已装的 mod 数量',
          '进服被踢会自动诊断：有人在进服后 30 秒内掉线、而这台 Fabric 服务端又没装 mod 时，启动器会主动提示「点同步 mod 再重启服务端」，不用再去翻日志找原因',
          '为什么必须同步：Fabric 服务端少了客户端已装的 mod 时，玩家会在进服配置阶段被服务端注册表校验拦下，客户端提示「网络协议错误」，而服务端日志只有一句 Disconnected —— 看起来像网络问题，实际是缺 mod；本次已按此规则实测（客户端 58 个 mod 中 39 个需要同步、19 个纯客户端自动跳过，全部装入后服务端 118 个 mod 正常加载）',
          '只有 Fabric 核心的服务器需要装 mod（Paper / Purpur / 原版不受影响），对非 Fabric 服务器点同步会直接提示不支持，不会误拷文件',
          '控制台右上角新增「外网联机」按钮：点一下自动准备并启动陶瓦联机组件（首次下载约 8 MB，走国内镜像），为当前服务器创建联机房间 —— 外地好友不用公网 IP、不用端口映射也能进服',
          '房间就绪后房间码直接显示在服务器面板里（大号字体，点一下即复制），旁边是「复制房间码 / 中断联机」；朋友在「联机」页加入房间后，用面板里标注为「虚拟局域网（外网联机用）」的地址在游戏里「直接连接」即可',
          '房间建立后虚拟网卡地址会自动刷新进「连接地址」面板；若服务器还没启动会黄字提示先点「启动」，离线模式服务器会提示先执行 whitelist on 开白名单，避免房间码传开后陌生人进服',
          '联机组件未安装、服务启动失败或 P2P 打洞失败（错误码）都会在面板内显示原因并给出一键重试，同时提示备用方案：装 ZeroTier / Radmin VPN 后双方互加网络，用「连接地址」面板里的地址直连'
        ]
      },
      {
        icon: 'i-user',
        title: '新增 · 主页头像：一眼看到自己的离线皮肤',
        items: [
          '主页问候语左侧新增当前玩家的像素头像：直接读取你在「账户」页上传的离线皮肤 PNG，裁出头部（含帽子 / 头发层）按像素风放大显示，不用进游戏就能确认现在用的是哪个皮肤',
          '没有上传自定义皮肤时显示的是标准史蒂夫头像 —— 头发、肤色、蓝眼睛、胡茬逐像素还原，不是灰色空白占位；「账户」页的皮肤预览同样是史蒂夫全身像，方便你对照自定义皮肤的效果',
          '在主页改玩家名、或在「账户」页切换账户时，头像会跟着换成对应账户的皮肤（该账户没皮肤则回到史蒂夫头像），不会出现名字和皮肤对不上的情况'
        ]
      },
      {
        icon: 'i-puzzle',
        title: '优化 · 模组下载中文化：中文搜索 + 模组中文名，页面和译名都跟 PCL 一样',
        items: [
          '下载页的「目标版本」下拉新增「全部」选项并设为默认：下 MOD / 整合包 / 资源包不再强制先装一个版本、也不再强制挑实例，直接搜、直接装就行；想只按某个版本的适配内容筛选，再手动在同一个下拉里选具体实例即可',
          '选「全部」时安装会自动挑实例：优先你设的默认实例，其次是最近启动过的带加载器实例；一个带模组加载器的实例都没有时，会明确提示先去安装 Fabric / Forge / NeoForge，而不是默默失败',
          'MOD / 整合包 / 资源包搜索框现在支持中文：直接输入「小地图」「光影」「物品管理器」「暮色森林」「机械动力」等中文词就能搜到对应模组，不用先想英文名怎么拼',
          '译名用的是 PCL 同款数据库：把 PCL2 内置的 MC 百科中文库转换成启动器可读的格式，收录 1 万+ 模组的中文译名（钠、锂、机械动力、暮色森林、Alex 的生物、农夫乐事、指路石、精致存储、旅行地图……），离线可用，不再依赖 AI 接口；冷门模组仍保留 AI 翻译兜底',
          '中文搜索同样照 PCL 的做法：把中文词翻译成社区通用的英文关键词后分头查询、再合并去重 —— 只用一个词查会漏掉同类模组，拼成一整句查在 Modrinth 上又会一条都搜不到，两条路都试过才定下现在的方式',
          '搜索结果的排版也改成了 PCL 的样子：一行里「中文译名（大号加粗）」+「英文原名 / 加载器版次（小号灰字）」并排显示，底下一行是来源、下载量与作者，简介单独一行 —— 一眼就能看出这是什么模组，不用去认英文',
          '标题拆分用的是 PCL 的算法：中文名里带「(English Name)」「- 后缀」「[缩写]」的会被拆成主标题与副标题，纯版本标记（如 Fabric）会规整成「Fabric 版」，同时名字里既含 fabric 又含 forge 的无意义噪声段会被过滤掉',
          '匹配做了容错归一化：modid 的大小写、下划线 / 中划线差异、`_fabric` `_forge` `neoforge` 等加载器后缀、结尾复数（xaeros_minimap 与 xaero_minimap）都能正确对上，整合包里中英混装的模组也能显示中文名',
          '本地已装模组列表同样受益：没有匹配到在线项目信息的模组会按 jar 内置的 modid 查内置中文表，中英混装的整合包里也能显示中文名',
          'AI 翻译保留为兜底：内置库没收录的冷门模组，仍会在你配置了 AI Key 时自动翻译成中文名并缓存，搜索过一次之后下次直接读缓存'
        ]
      },
      {
        icon: 'i-lock',
        title: '安全 · 更新源锁定：防止启动器被指向第三方下载地址',
        items: [
          '设置 → 版本更新的「更新检测地址」改为只读（带「已锁定」标记）：启动器只从官方下载页检测更新，在界面里无法改成别的地址',
          '主进程侧同样强制：早期版本的自定义更新源字段已废弃 —— 老版本留下的自定义地址会在启动时自动清除；即使有人直接改配置文件、或绕过界面写入第三方地址，请求也会被拒绝并留痕',
          '更新包下载同样限定来源：只允许从官方更新源所在站点下载安装包，指向其他主机的下载请求会被直接拒绝，避免出现「版本检测正常、但装到的包被别人换过」',
          '为什么必须锁：更新源可控就等于能向所有用户投递任意程序。地址一旦可改，别人只要骗你换一个地址（或顺手改一下你的配置文件），启动器就会把对方的 exe 当成新版下载并运行'
        ]
      },
      {
        icon: 'i-refresh',
        title: '优化 · 启动体验：双击后立刻有反馈，不用再猜「到底启动了没」',
        items: [
          '主窗口改为界面骨架一就绪就显示（不再等全部数据加载完才出现）：双击启动器后立刻能看到窗口和任务栏图标，加载进度直接写在窗口里，不会出现「点了没反应、桌面一片安静」的空档',
          '再次压缩了「双击到看到画面」的等待：启动画面改为创建后立即显示、不再等页面绘制完成才亮出窗口；窗口自带深色底，出现瞬间就是完整的深色界面，不会再先闪一下空白',
          '启动加载页的样式改为独立的小文件并排在所有样式表最前面加载：不再等体积大的主样式表解析完才画遮罩，双击后第一帧就能看到软件图标与进度条',
          '窗口里的启动加载页：软件图标 + 名称 + 进度条 + 当前步骤文案（正在读取背景 / 载入设置 / 扫描游戏目录 / 检测 Java 环境），一眼就能看出启动到哪一步了',
          '加载完成自动淡出并撤掉遮罩，直接进主界面；遮罩消失后不残留、不拦截鼠标点击',
          '任务栏上不再「隐身」：此前启动闪屏被设置为不出现在任务栏，若被其他窗口盖住就会显得像是没启动，现已改为正常显示（改为常驻最前，不会被别的窗口压下去）',
          '10 秒兜底逻辑保留：万一某个环节卡住，也会强制关掉闪屏并亮出主窗口，不会一直停在图标上'
        ]
      },
      {
        icon: 'i-refresh',
        title: '修复 · 加载器兼容性判断：所有加载器都改为查官方数据，不再猜',
        items: [
          '修复：26.4 快照 2 明明支持 Fabric，安装弹窗里却显示「不兼容」、按钮是灰的 —— 实际 Fabric 对快照版同样提供构建（26.4-snapshot-2 有 253 个），完全装得上',
          '修复：OptiFine 有 26.2 的版本了，启动器却一直显示不兼容 —— 此前这一项被写死成「暂不支持自动安装」，从没查过实际有没有发布。现在改为联网查 OptiFine 官方清单，26.2 的预览版、1.21.11 的正式版都能识别并安装',
          '根本改法：不再用「是不是正式版」这类猜测去推断兼容性，而是逐一向各加载器官方源确认该版本的真实构建。Fabric / Quilt 查各自元数据接口，Forge 查构建清单，NeoForge 查 maven 版本列表，OptiFine 查官方发布清单',
          '这样修的好处是不会误放开：Quilt 对 26.4 快照 2 确实没有构建（仍正确显示不兼容）、Forge 与 NeoForge 不为快照版提供构建、OptiFine 对没有发布的版本（如 26.3）也仍然是不兼容',
          '每次打开安装弹窗、切换加载器、进入更改加载器界面，都会重新向官方源查一遍，保证结论与你当前打开启动器的时刻同步。加载器发布新构建后，不用等启动器更新就能立刻装上',
          'OptiFine 现在可以真的装了：选好版本点安装，会自动下载对应安装器并静默安装，装完的实例能在版本列表里看到并直接启动（此前只能手动去官网下载再自己叠加）',
          'NeoForge 的版本号推导也一并修正：它按 MC 版本的次版本号编号（26.2 → NeoForge 26.2.x；老式 1.21.4 → 21.4.x），此前只认老式编号，导致新编号版本被判「无构建」'
        ]
      },
      {
        icon: 'i-warn',
        title: '修复 · 删除操作后启动器「点不动、打不了字」',
        items: [
          '修复：在服务器 / 实例 / 存档 / MOD / 账户 / 好友上点击删除后，启动器界面可能出现「点什么都没反应、光标不出现、打字无反应」（窗口还在正常绘制，看起来像卡死）—— 原因是删除确认用的是系统阻塞式弹窗，弹出期间界面线程被完全卡住',
          '现已换成挂在启动器窗口上的确认框：弹出期间界面照常响应，点其他地方不会被吞掉；危险操作默认停在「取消」，防止手快误删',
          '确认框现在始终位于启动器窗口最前面（此前在无边框窗口下可能跑到窗口后面，让人以为程序已经卡死）',
          '万一确认框无法弹出，会给出明确提示，而不是让你以为点了没反应'
        ]
      }
    ],
    notice: '本次为发布候选版（RC）：启动体验优化 —— 双击后立刻出现启动画面（深色界面 + 软件图标 + 进度条 + 当前步骤），不再有「点了没反应」的等待空档，任务栏图标也正常显示。主页新增当前账户的皮肤头像，直接读取你上传的离线皮肤，一眼看到用的是哪个皮肤；没有自定义皮肤时显示的是标准史蒂夫头像（账户页的皮肤预览也是史蒂夫全身像）。模组下载全面中文化，译名与页面都对齐 PCL，同时下载不再强制先挑版本 —— 「目标版本」下拉新增「全部」并设为默认，直接搜、直接装，安装时自动挑选合适的实例；MOD / 整合包 / 资源包搜索支持中文关键词（输入「小地图」「光影」「物品管理器」即可），模组中文名改用 PCL 同款的内置 MC 百科中文库（1 万+ 条译名，离线可用、不再依赖 AI 接口），搜索结果的排版也改成 PCL 的样子：一行里「中文译名（大）+ 英文原名 / 加载器版次（小灰字）」并排显示，标题拆分沿用 PCL 的算法，中英混装的整合包同样有效。更新源地址已锁定为官方下载页（设置里只读、配置文件里的自定义地址会被清除、安装包也限定只能从官方站点下载），避免被别人指到第三方地址投递伪造程序；一键开服补齐了「怎么进服」的完整链路 —— 服务器创建完成后直接给出本机与局域网连接地址、一键复制，新增「外网联机」按钮可为服务器建联机房间，让外地好友不需要公网 IP 也能进服；Fabric 服务器新增「同步 mod」，解决客户端装 mod 后进服提示「网络协议错误」的问题；同时修复了一个通用问题：加载器兼容性过去靠猜（快照版一律判不支持、OptiFine 一律判不支持），现已改为逐个向官方源确认真实构建（每次打开都要重新查一遍、实时同步，不缓存旧结论）—— 26.4 快照 2 的 Fabric、26.2 的 OptiFine 都能正确识别并安装，而没有发布的版本（如 26.3 的 OptiFine）仍正确显示不兼容；以及删除操作后界面「点不动、打不了字」。'
  },
  {
    version: 'Pre1',
    date: '2026-10-03',
    tag: '预发布',
    groups: [
      {
        icon: 'i-refresh',
        title: '新增 · 版本更新功能',
        items: [
          '设置 → 版本更新：一键检测最新版本，自动与当前版本比对，直接给出结论 —— 「已是最新版本」或「发现新版本 x.x」，不用再自己去群里翻链接',
          '发现新版本时列出安装版 / 便携版两个文件的名称与大小，可任选「浏览器下载」或「启动器内下载」；启动器内下载走多线程分块，带实时进度、速度与失败重试',
          '便携版支持「一键更新并重启」：自动写入替换脚本，退出后覆盖旧程序并重新打开，全程不用手动找文件；安装版下载完成后可直接「运行安装包」或「打开所在文件夹」',
          '启动后自动静默检测一次，只有发现新版本才提示，不打扰你；也可以在设置里关闭自动检测，改为手动点「检测更新」',
          '不想升级可以点「跳过此版本」，这个版本不再自动提示（手动检测时仍会显示出来）；更新源地址也能在设置里自定义，方便切换自建或镜像站点',
          '新增「更新公告」窗口（本次这个就是）：每次更新后会告诉你这次改了什么，新版本第一次启动时自动弹出一次，之后可在设置 → 版本更新里随时回看'
        ]
      },
      {
        icon: 'i-puzzle',
        title: '新增 · 插件功能',
        items: [
          '侧栏新增「插件」页（拼图图标）：目前内置「种子地图」与「一键开服」两个插件，每个插件都能单独启用 / 停用，开关状态保存在本机配置里，停用后不会出现在启动器里',
          '「种子地图」插件：手动输入种子（支持中文、负数）或一键随机生成，也可以直接从已有存档里读出种子，不用再进游戏抄',
          '种子地图支持选择平台版本（Java / 基岩 × 1.13 到 1.21）与维度（主世界 / 下界 / 末地），直接在启动器的新窗口里打开地图，查看生物群系、村庄、要塞、遗迹等结构分布',
          '「一键开服」插件：支持 Paper（推荐）/ Purpur / 原版 / Fabric 四种服务端核心，自动拉取该核心的可用版本列表，选好核心与版本即可',
          '填好服务器名称、内存、端口、MOTD、难度、游戏模式、正版验证后点「创建服务器」：自动下载服务端（带进度条与完整性校验），并生成 eula.txt、server.properties、start.bat 与服务器信息文件，参数都按你的设置写好',
          '开服后内置控制台：实时显示服务器日志，可以直接在输入框里执行服务器命令（say、op、stop 等）；一键停止会先让服务器保存世界再退出，不会丢档；还支持打开服务器目录、删除服务器（移入回收站）',
          '自动匹配 Java 版本：按所选服务端版本挑选满足要求的最低 Java 运行时（如 1.17 需 Java 16、1.18-1.20.4 需 17、1.20.5 以上需 21），找不到会提示，不用手动改参数'
        ]
      },
      {
        icon: 'i-tools',
        title: '新增 · 工具箱功能',
        items: [
          '侧栏新增「工具箱」页：汇集 38 个 MC 实用网站，按 9 大类整理，点击卡片用系统浏览器直接打开，不用再一个个加书签',
          '百科攻略：Minecraft Wiki（最权威的中文百科）、MC 百科、DigMinecraft 教程站',
          '模组与整合包：CurseForge、Modrinth、Planet Minecraft、MCPEDL（基岩版资源）',
          '玩家社区：MineBBS、苦力怕论坛、Bilibili MC 区',
          '材质与光影：ResourcePack、ShadersMods、Vanilla Tweaks 原版增强',
          '地图与建筑：投影工坊、Plotz 圆形建筑生成、Block Palettes 配色、Minecraft Maps',
          '在线工具：Chunkbase 种子地图、MCStacker 命令生成器、MC Tools、Misode 数据包生成、mclo.gs 日志分析、Minecraft Heads 头颅库、Colorize FUN 彩色文本、Textcraft Logo 生成',
          '皮肤资源：NameMC、LittleSkin、Nova Skin、The Skindex、SkinMC',
          '服务器与插件：FindMCServer、MC Servers 排行、SpigotMC、PaperMC；资源导航：MC Versions、Fabric / Forge / NeoForge 官网'
        ]
      }
    ],
    notice: '本次 Pre1 带来三项新内容：版本更新（设置 → 版本更新）、插件系统（种子地图 / 一键开服）与工具箱（38 个 MC 实用网站）。从本版本起进入预发布阶段，后续以修复问题为主，新功能会放到下一个正式版。'
  }
];
/* 公告对外输出：groups 是唯一数据源，同时拍平出 items 供旧版界面 / 测试使用 */
function changelogOut(e) {
  if (!e) return null;
  const out = Object.assign({}, e);
  if (!out.items) {
    out.items = (e.groups || []).reduce((a, g) => a.concat(g.items || []), []);
  }
  return out;
}
/* 当前版本的公告条目（CHANGELOG 里 version 与 APP_VERSION 相同的那条） */
function currentChangelog() {
  const me = normVer(APP_VERSION);
  return CHANGELOG.find(x => normVer(x.version) === me) || null;
}
/* unseen=true 表示「这个版本是第一次运行」，界面据此自动弹一次公告 */
ipcMain.handle('update:changelog', () => ({
  ok: true,
  current: APP_VERSION,
  entry: changelogOut(currentChangelog()),
  list: CHANGELOG.map(changelogOut),
  unseen: normVer(config.seenVersion) !== normVer(APP_VERSION)
}));
/* 界面关掉公告后调用：记下「这个版本已经看过」 */
ipcMain.handle('update:seen', () => {
  config.seenVersion = APP_VERSION;
  saveConfigNow();
  return { ok: true, version: APP_VERSION };
});

let UPDATE_CACHE = null; /* 最近一次检测结果（自动检测后进设置页可直接展示，无需重查） */
/* 把解析出的更新档案组装成统一的结果形状（GitHub / 官网两条通道共用）
   histDl：版本回退列表用的直链集合（默认同本次下载；GitHub 通道会额外抓官网下载页传进来） */
function updateInfoFrom(parsed, pageUrl, via, histDl) {
  const cmp = compareVer(parsed.version, APP_VERSION);
  /* 「跳过快照版更新」（设置 → 版本更新）：更新源上是快照 / 预发布时按「不提示更新」处理，
     但把 skippedPre 一并带出去 —— 界面据此说明「为什么没提示」，而不是含糊地装作已是最新。 */
  const dec = preUpdateDecision(parsed.version, config.skipPreviewUpdate);
  const skippedPre = cmp > 0 && dec.skipped;
  return {
    ok: true,
    current: APP_VERSION,
    latest: parsed.version.replace(/^v/i, ''),
    hasUpdate: cmp > 0 && !skippedPre,
    newerThanRemote: cmp < 0,
    preRelease: dec.pre,
    skippedPre,
    skipPreEnabled: !!config.skipPreviewUpdate,
    downloads: parsed.downloads,
    history: buildUpdateHistory(
      Array.isArray(histDl) && histDl.length ? histDl : parsed.downloads, APP_VERSION),
    notes: parsed.notes,
    pageUrl,
    via,
    checkedAt: Date.now(),
    ignored: !!config.ignoredVersion && normVer(config.ignoredVersion) === normVer(parsed.version)
  };
}
/* 通道一：官方下载页（HTML / JSON）——兜底 */
async function doUpdateCheckPage(persist) {
  const raw = updateSourceUrl();
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, error: '更新源地址无效（需以 http:// 或 https:// 开头）', current: APP_VERSION, pageUrl: raw };
  }
  const buf = await fetchBufT(raw, UPDATE_TIMEOUT);
  const parsed = parseUpdatePage(buf.toString('utf8'), raw);
  if (!parsed.version) throw new Error('未能从更新源解析出版本号（地址可能不是下载页，或页面结构已变更）');
  const info = updateInfoFrom(parsed, raw, '官网下载页');
  UPDATE_CACHE = info;
  if (persist) { config.lastUpdateCheck = info.checkedAt; saveConfigNow(); }
  return info;
}
/* 抓官网下载页的直链，只用于「版本回退」列表：GitHub 一次只给一个 Release 的附件，
   凑不出可回退的历史版本，而官网下载页列着全部历史版本（直链也在官方网盘上）。
   短超时 + 缓存 5 分钟 + 失败静默 —— 它挂了绝不能连累本次更新检测。 */
const OFFICIAL_HIST_TIMEOUT = 8000;
const OFFICIAL_HIST_TTL = 5 * 60 * 1000;
let OFFICIAL_HIST_CACHE = { at: 0, downloads: [] };
async function fetchOfficialHistoryDl() {
  const now = Date.now();
  if (OFFICIAL_HIST_CACHE.downloads.length && now - OFFICIAL_HIST_CACHE.at < OFFICIAL_HIST_TTL) {
    return OFFICIAL_HIST_CACHE.downloads;
  }
  try {
    const buf = await fetchBufT(UPDATE_DEFAULT_URL, OFFICIAL_HIST_TIMEOUT);
    const p = parseUpdatePage(buf.toString('utf8'), UPDATE_DEFAULT_URL);
    if (p.downloads.length) OFFICIAL_HIST_CACHE = { at: now, downloads: p.downloads };
    return p.downloads;
  } catch (e) {
    try { logLine('[update] 官网下载页抓取失败（版本回退列表先用旧缓存）：' + (e.message || e)); } catch (_) {}
    return OFFICIAL_HIST_CACHE.downloads;
  }
}
/* 通道二：GitHub Releases —— 优先。任何失败都抛错，由上层回退到官网下载页。 */
async function doUpdateCheckGitHub(persist) {
  const buf = await fetchBufT(GH_RELEASE_API, GH_UPDATE_TIMEOUT);
  const parsed = parseGitHubRelease(JSON.parse(buf.toString('utf8')));
  if (!parsed.version) throw new Error('GitHub Release 响应里没有可识别的版本号');
  const histDl = await fetchOfficialHistoryDl();   /* 只影响版本回退列表，失败留空不阻断 */
  const info = updateInfoFrom(parsed, parsed.pageUrl || GH_RELEASE_PAGE, 'GitHub', histDl);
  UPDATE_CACHE = info;
  if (persist) { config.lastUpdateCheck = info.checkedAt; saveConfigNow(); }
  return info;
}
async function doUpdateCheck(persist) {
  /* 开发态调试页（XLC_UPDATE_URL）：跳过 GitHub 直接走页面源，保证测试封闭性 */
  if (!app.isPackaged && String(process.env.XLC_UPDATE_URL || '').trim()) {
    return doUpdateCheckPage(persist);
  }
  try {
    return await doUpdateCheckGitHub(persist);
  } catch (e1) {
    try { logLine('[update] GitHub 更新源不可用（' + (e1.message || e1) + '），回退官方下载页'); } catch (_) {}
    return doUpdateCheckPage(persist);
  }
}
ipcMain.handle('update:check', async (_e, p) => {
  const o = p || {};
  /* 更新源锁定：渲染层传第三方地址一律拒绝（配置里残留的 updateUrl 也不会被采用） */
  if (!isOfficialSource(o.url)) {
    logLine('[update] 已拒绝非官方更新源：' + o.url);
    return {
      ok: false, locked: true, current: APP_VERSION, pageUrl: updateSourceUrl(),
      error: '更新源已锁定：启动器只从官方下载页检测更新（' + UPDATE_DEFAULT_URL + '），该地址不可修改'
    };
  }
  try { return await doUpdateCheck(true); }
  catch (e) {
    return { ok: false, error: e.message || String(e), current: APP_VERSION, pageUrl: updateSourceUrl() };
  }
});
ipcMain.handle('update:cached', () => UPDATE_CACHE || null);
ipcMain.handle('update:ignore', (_e, p) => {
  /* 跳过指定版本：之后不再提示（手动检测仍可看到） */
  config.ignoredVersion = String((p && p.version) || '');
  saveConfigNow();
  return { ok: true, config: configPublic() };
});

/* 更新包下载目录：便携版 → 与真正 exe 同目录（方便一键替换）；安装版 / 开发运行 → 系统下载目录 */
let UPDATE_JOB = null;
function updatePreferredDir() {
  const pe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (pe) {
    const dir = path.dirname(pe);
    try { fs.accessSync(dir, fs.constants.W_OK); return dir; } catch (_) {}
  }
  try { return app.getPath('downloads'); } catch (_) { return DATA_DIR; }
}
ipcMain.handle('update:download', async (e, p) => {
  netReset();
  const o = p || {};
  const url = String(o.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '下载地址无效' };
  /* 只允许从官方更新源所在主机下载更新包（防「改地址 → 下恶意包」） */
  if (!updateHostAllowed(url)) {
    logLine('[update] 已拒绝非官方下载地址：' + url);
    let host = '';
    try { host = new URL(updateSourceUrl()).host; } catch (_) {}
    return { ok: false, error: '更新包只允许从官方更新源下载（' + host + '），该地址已被拒绝' };
  }
  if (UPDATE_JOB) return { ok: false, error: '已有一个更新下载任务在进行中' };
  const name = path.basename(String(o.name || url.split('/').pop() || 'XLC-Launcher-update.exe').split('?')[0]) || 'XLC-Launcher-update.exe';
  const ctrl = new AbortController();
  const push = (d) => { try { e.sender.send('update:progress', d); } catch (_) {} };
  const run = async (dest) => {
    UPDATE_JOB = { ctrl, dest, name };
    push({ phase: 'start', name, dest, pct: 0 });
    await downloadBig(url, dest, (pct, got, total) => push({ phase: 'downloading', name, dest, pct, got, total }), ctrl.signal);
    const size = (await fsp.stat(dest)).size;
    /* 下完立刻算 sha256：① 清单里带了就当场比对（镜像投毒/内容被换），不匹配直接删包；
       ② 没带就回给渲染层，替换前还能用它确认「用的就是刚下的这个文件」 */
    const sha = await sha256OfFile(dest);
    const want = String(o.sha256 || '').trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(want) && sha !== want) {
      try { await fsp.unlink(dest); } catch (_) {}
      logLine('[update] 更新包哈希不匹配，已删除: 期望 ' + want + ' 实际 ' + sha);
      throw new Error('更新包校验失败（sha256 不匹配），已删除损坏文件，请重试或稍后再试');
    }
    if (/^[a-f0-9]{64}$/.test(want)) logLine('[update] 更新包 sha256 校验通过: ' + sha);
    return { ok: true, path: dest, name, size, dir: path.dirname(dest), sha256: sha };
  };
  try {
    let r;
    try {
      r = await run(path.join(updatePreferredDir(), name));
    } catch (err) {
      if (ctrl.signal.aborted) throw err;
      /* 首选目录不可写（如装在 Program Files）→ 回退系统下载目录重试一次 */
      const fb = (() => { try { return app.getPath('downloads'); } catch (_) { return DATA_DIR; } })();
      if (path.resolve(fb) === path.resolve(updatePreferredDir())) throw err;
      logLine('[update] 首选目录写入失败，回退下载目录: ' + err.message);
      r = await run(path.join(fb, name));
    }
    push({ phase: 'done', name, dest: r.path, pct: 100, size: r.size });
    logLine('[update] 更新包已下载: ' + r.path);
    return r;
  } catch (err) {
    const cancelled = ctrl.signal.aborted;
    push({ phase: cancelled ? 'cancelled' : 'error', name, message: err.message });
    return { ok: false, error: cancelled ? '已取消下载' : (err.message || String(err)), cancelled };
  } finally { UPDATE_JOB = null; }
});
ipcMain.handle('update:cancel', () => {
  if (!UPDATE_JOB) return { ok: false, error: '没有正在进行的下载任务' };
  try { UPDATE_JOB.ctrl.abort(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
/* 在文件管理器中定位下载好的更新包 */
ipcMain.handle('update:reveal', (_e, p) => {
  const f = String((p && p.path) || '');
  if (!f || !fs.existsSync(f)) return { ok: false, error: '文件不存在（可能已被移动或删除）' };
  shell.showItemInFolder(f);
  return { ok: true };
});
/* 运行下载好的安装包（安装版会走安装向导，便携版直接启动新版本） */
ipcMain.handle('update:run', async (_e, p) => {
  const f = String((p && p.path) || '');
  if (!f || !fs.existsSync(f)) return { ok: false, error: '安装包不存在（可能已被移动或删除）' };
  const err = await shell.openPath(f);
  if (err) return { ok: false, error: err };
  return { ok: true };
});
/* 一键更新 / 回退（用 exe 直接覆盖程序文件）：批处理等本进程退出 → 覆盖 → 启动新版本。
   目标优先取「当前运行的便携版文件」（PORTABLE_EXECUTABLE_FILE 由便携版启动器注入），
   没有（安装版 / 开发态直接跑 exe）就退回当前进程的 exe —— 回退流程下的是免安装便携版 exe，
   覆盖当前程序文件即可完成回退，不需要跑安装向导 */
/* cmd 批处理里会被解释或破坏结构的字符：% 变量展开、引号破引号、控制字符断行。
   & | < > ^ 在引号内其实安全，但合法路径里几乎不会出现，一并拒绝更省心。 */
const UNSAFE_CMD_PATH = /[\x00-\x1f\x7f"%&|<>^]/;
function unsafeCmdPath(s) { return UNSAFE_CMD_PATH.test(String(s || '')); }
function sha256OfFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(p);
    rs.on('data', d => h.update(d));
    rs.once('error', reject);
    rs.once('end', () => resolve(h.digest('hex')));
  });
}
/* 没有哈希可比时的最低门槛：必须是完整 PE 文件（MZ 头 + 体积下限），挡住截断包 / 改名文件 */
function looksLikeExe(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 1024 * 1024) return false;
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(2);
    try { fs.readSync(fd, b, 0, 2, 0); } finally { fs.closeSync(fd); }
    return b[0] === 0x4d && b[1] === 0x5a; /* 'MZ' */
  } catch (_) { return false; }
}
ipcMain.handle('update:self-replace', async (_e, p) => {
  const f = String((p && p.path) || '');
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath || '';
  if (!f || !fs.existsSync(f)) return { ok: false, error: '更新包不存在，请先下载' };
  if (!/\.exe$/i.test(f)) return { ok: false, error: '只支持用 exe 文件替换启动器程序' };
  if (!target) return { ok: false, error: '无法定位当前启动器文件，请手动把下载的 exe 放到程序目录' };
  /* ① 路径字符校验：这两条路径一条来自下载结果、一条来自进程自身，正常不含这些字符 */
  if (unsafeCmdPath(f) || unsafeCmdPath(target)) {
    logLine('[update] 拒绝替换：路径含批处理危险字符 ' + JSON.stringify({ f, target }));
    return { ok: false, error: '路径里含有批处理无法安全处理的字符（% " 或控制字符），请手动把下载的 exe 覆盖过去' };
  }
  /* ② 完整性校验：优先核对更新清单/下载时给出的 sha256；
     清单没带哈希时至少确认是完整 PE（MZ 头 + 体积下限），并留下明文日志便于事后追查 */
  const want = String((p && p.sha256) || '').trim().toLowerCase();
  let actual = '';
  try { actual = await sha256OfFile(f); }
  catch (e) { return { ok: false, error: '校验更新包失败: ' + e.message }; }
  if (/^[a-f0-9]{64}$/.test(want)) {
    if (actual !== want) {
      logLine('[update] 更新包哈希不匹配，已拒绝替换（期望 ' + want + ' 实际 ' + actual + '）');
      return { ok: false, error: '更新包校验失败（sha256 不匹配），为安全已取消替换，请重新下载' };
    }
    logLine('[update] 更新包 sha256 校验通过: ' + actual);
  } else {
    if (!looksLikeExe(f)) {
      logLine('[update] 更新包不是完整的 exe（PE 头/体积异常），已拒绝替换: ' + f);
      return { ok: false, error: '更新包不是完整的 exe（可能下载被截断），请重新下载' };
    }
    logLine('[update] ⚠ 更新清单未提供 sha256，仅校验了 PE 头与体积（sha256=' + actual + '）');
  }
  const bat = path.join(os.tmpdir(), 'xlc-update-' + Date.now() + '.bat');
  /* 脚本文本固定，路径全部通过环境变量传入：cmd 只展开一次 %XLC_UPD_SRC%，
     不会再对展开结果里的 % 做二次展开，等于从根上断掉「文件名插值 → 目标错乱」 */
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'title XLC 启动器更新',
    ':wait',
    'tasklist /fi "PID eq ' + process.pid + '" 2>nul | find "' + process.pid + '" >nul',
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto wait',
    ')',
    'copy /y "%XLC_UPD_SRC%" "%XLC_UPD_DST%" >nul',
    'if errorlevel 1 (',
    '  echo.',
    '  echo 覆盖失败，请手动把新版本复制到：',
    '  echo   "%XLC_UPD_DST%"',
    '  pause',
    '  exit /b 1',
    ')',
    'del "%XLC_UPD_SRC%" >nul 2>nul',
    'start "" "%XLC_UPD_DST%"',
    'del "%~f0"'
  ];
  try {
    fs.writeFileSync(bat, lines.join('\r\n'), 'utf8');
    spawn('cmd.exe', ['/c', 'start', '', '/min', bat], {
      detached: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { XLC_UPD_SRC: f, XLC_UPD_DST: target })
    }).unref();
    logLine('[update] 已安排自动更新：退出后覆盖 ' + target);
    return { ok: true, target, bat, sha256: actual };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 更新完成后立即重启（关闭主窗口即退出进程，交给批处理替换并拉起新版本） */
ipcMain.on('update:quit-for-update', () => { setTimeout(() => app.quit(), 400); });

/* 启动后静默检测更新：发现新版推送 update:available，由界面提示（可在设置里关闭） */
function scheduleAutoUpdateCheck() {
  if (config.autoCheckUpdate === false) return;
  setTimeout(async () => {
    try {
      const info = await doUpdateCheck(false);
      if (info.ok && info.hasUpdate && !info.ignored) {
        send('update:available', info);
        logLine('[update] 发现新版本 ' + info.latest + '（当前 ' + info.current + '）');
      } else if (info.ok && info.skippedPre) {
        logLine('[update] 已跳过快照版 ' + info.latest + '（设置里开启了「跳过快照版更新」，只收正式版）');
      } else if (info.ok) {
        logLine('[update] 已是最新版本 ' + APP_VERSION + '（更新源 ' + info.latest + '）');
      }
    } catch (e) { logLine('[update] 自动检测更新失败: ' + (e && e.message)); }
  }, 5000);
}

/* ---------------- 配置 / 窗口 IPC ---------------- */
/* config:get 脱敏输出：账户令牌（accountsOut 已剥离）与 AI Key 不进渲染进程。
 * aiApi.key 用掩码占位回显；config:save 收到掩码值时保留原 key（见下方保存逻辑） */
const SECRET_MASK_PREFIX = '••••';
function maskSecret(k) {
  const s = String(k || '');
  return s ? SECRET_MASK_PREFIX + s.slice(-4) : '';
}
function configPublic() {
  const c = Object.assign({}, config);
  c.accounts = accountsOut();
  if (c.aiApi && c.aiApi.key) c.aiApi = Object.assign({}, c.aiApi, { key: maskSecret(c.aiApi.key) });
  /* 只读字段：版本号 / 官方更新源 / 是否便携版运行（供设置页展示，不允许被 config:save 覆盖） */
  c.appVersion = APP_VERSION;
  /* 当前跑的是不是快照 / 预发布版（只读）。1.1 正式版起界面上的两处快照专用 UI
     （主页提示条、更新页「回到稳定版」卡）都已移除，所以现在没有界面在用它 ——
     但字段保留：1.2 出快照版时按 qa/archived/*-1.2-restore.md 恢复那两处，直接拿来用即可。
     判定与「跳过快照版更新」是同一套阶段规则（isPreVer）。 */
  c.appVersionPre = isPreVer(APP_VERSION);
  c.updateDefaultUrl = UPDATE_DEFAULT_URL;
  c.updateLocked = true;     /* 更新源已锁定，设置页据此显示为只读 */
  c.portableMode = !!process.env.PORTABLE_EXECUTABLE_FILE;
  /* 数据目录（只读展示用）：配置 / 皮肤 / 日志 / 缓存都在这里 */
  c.dataDir = DATA_DIR;
  /* 游戏是否正在跑（只读）：启动器重启 / Ctrl+R 后界面据此把按钮恢复成「关闭游戏」。
     进程活着 = exitCode 为 null（Node 的 ChildProcess 约定），退过就不再是 null */
  c.gameRunning = !!(GAME_PROC && GAME_PROC.pid && GAME_PROC.exitCode === null);
  return c;
}
ipcMain.handle('config:get', () => configPublic());

/* ---------------- 设置迁移与缓存清理（照 PCL「其他 → 启动器 / 调试」） ----------------
 * 导出的是「偏好」而不是整份配置：账户令牌、好友、皮肤文件一律不进导出文件，
 * 免得把别人的登录凭据顺手拷到另一台机器上。导入只覆盖白名单里的字段。 */
/* 导出 / 导入只认这份白名单的快照（声明在下方 CONFIG_SAVE_WHITELIST 处，勿提前求值 —— const 有暂时性死区） */
ipcMain.handle('config:export', async () => {
  try {
    const r = await dialog.showSaveDialog({
      title: '导出设置', defaultPath: 'XLC-设置备份.json',
      filters: [{ name: 'XLC 设置备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const out = { format: 'xlc-settings', version: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString() };
    for (const k of CONFIG_IO_KEYS) if (config[k] !== undefined) out[k] = config[k];
    await fsp.writeFile(r.filePath, JSON.stringify(out, null, 2), 'utf8');
    setStatus('就绪');
    logLine('[XLC] 设置已导出: ' + r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('config:import', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: '导入设置', properties: ['openFile'],
      filters: [{ name: 'XLC 设置备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const raw = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
    if (!raw || raw.format !== 'xlc-settings') return { ok: false, error: '不是 XLC 设置备份文件' };
    const patch = {};
    for (const k of CONFIG_IO_KEYS) if (raw[k] !== undefined) patch[k] = raw[k];
    if (!Object.keys(patch).length) return { ok: false, error: '备份文件里没有任何可导入的设置' };
    config = Object.assign({}, config, patch);
    saveConfigNow();
    logLine('[XLC] 设置已导入: ' + r.filePaths[0] + '（' + Object.keys(patch).length + ' 项）');
    return { ok: true, count: Object.keys(patch).length };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('cache:clear', async () => {
  try {
    setStatus('清理缓存…', true);
    let freed = 0, bytes = 0;
    const sizeOf = (p) => {
      let n = 0;
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
        for (const f of fs.readdirSync(p)) n += sizeOf(path.join(p, f));
      } catch (_) {}
      return n;
    };
    /* 只删缓存目录：图标缓存 + 下载缓存（modpack / 资源临时文件），不碰存档 / 模组 / 账户 / 皮肤 */
    const targets = [ICON_CACHE, path.join(DATA_DIR, 'cache'), path.join(DATA_DIR, 'dl-cache')];
    for (const t of targets) {
      if (!fs.existsSync(t)) continue;
      bytes += sizeOf(t);
      try { fs.rmSync(t, { recursive: true, force: true }); freed++; } catch (_) {}
    }
    setStatus('就绪');
    logLine('[XLC] 缓存已清理: ' + freed + ' 个目录 · ' + Math.round(bytes / 1048576) + ' MB');
    return { ok: true, freed, bytes };
  } catch (e) { setStatus('就绪'); return { ok: false, error: e.message }; }
});
/* 开源许可与第三方声明：文件随包打进 asar，用户点不到实体路径 —— 由主进程读出来给界面显示。
   fs 读 asar 内文件是 Electron 原生支持的，不需要解包。 */
ipcMain.handle('licenses:get', async () => {
  const read = (f) => { try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (_) { return ''; } };
  return {
    ok: true,
    name: 'Xero Lite Craft Launcher',
    version: APP_VERSION,
    license: read('LICENSE'),
    thirdParty: read('THIRD-PARTY.md'),
    /* 随包分发的 Terracotta（AGPL-3.0+例外）许可正文副本 —— 放到界面里，
       让用户不装解包工具也能看到条款（AGPL 要求随分发给出许可副本）。 */
    terracottaLicense: read(path.join('terracotta', 'LICENSE.txt'))
  };
});

/* ---------------- 诊断 IPC ---------------- */
ipcMain.handle('diag:launcher', () => {
  try {
    const files = fs.readdirSync(DIAG_DIR)
      .filter(f => /^launcher-\d+\.log$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(DIAG_DIR, f));
        let head = '';
        try { head = fs.readFileSync(path.join(DIAG_DIR, f), 'utf8').split('\n').slice(0, 2).join(' · '); } catch (_) {}
        return { name: f, path: path.join(DIAG_DIR, f), time: st.mtimeMs, head: head.slice(0, 120) };
      })
      .sort((a, b) => b.time - a.time);
    /* 只列出本次启动之前的崩溃（当前会话的实时异常下次启动再看） */
    let bootAt = 0;
    try { bootAt = JSON.parse(fs.readFileSync(BOOT_MARKER, 'utf8')).bootAt || 0; } catch (_) {}
    return { ok: true, crashes: files.filter(f => f.time < bootAt).slice(0, 10), diagDir: DIAG_DIR };
  } catch (e) { return { ok: false, error: e.message, crashes: [] }; }
});
ipcMain.handle('diag:reports', (_e, p) => {
  try {
    return { ok: true, reports: listCrashReports(config.gameDir, p && p.instance) };
  } catch (e) { return { ok: false, error: e.message, reports: [] }; }
});
ipcMain.handle('diag:game', async (_e, p) => {
  try {
    return { ok: true, diag: await diagnoseGameCrash(config.gameDir, p && p.instance, p && p.report, !!(p && p.logOnly)) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('diag:ai', async (_e, p) => {
  try {
    const text = await aiDiagnose(String(p.excerpt || ''), p.rules || []);
    return { ok: true, text };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ================= 反馈页：把仓库 Issue 按处理状态分组 =================
 * 界面（侧边栏「反馈」）不再直接甩浏览器，而是先给一页「正在处理 / 等待处理 / 等待 /
 * 已完成 / 已忽略 / 重复」的汇总，和 PCL CE 的反馈页一个路数；要看全部或提交新反馈
 * 再点按钮去 GitHub。
 * GitHub 未登录接口限流 60 次/小时，所以结果在内存里缓存 10 分钟（点「刷新」可强制重取）。 */
const FB_CORE = require('./src/feedback-core');
const GH_ISSUES_API = 'https://api.github.com/repos/byzgdneo2/XLC-Launcher/issues?state=all&per_page=100&sort=updated&direction=desc';
/* 未登录 60 次/小时的限流下，最多翻 5 页（500 条）——再多既慢又容易把配额用光。
   翻页走 GitHub 返回的 Link: rel="next"，不自己拼 page 参数。 */
const FB_MAX_PAGES = 5;
const FB_CACHE_MS = 10 * 60 * 1000;
let feedbackCache = { at: 0, data: null };
ipcMain.handle('feedback:list', async (_e, p) => {
  const force = !!(p && p.force);
  if (!force && feedbackCache.data && Date.now() - feedbackCache.at < FB_CACHE_MS) {
    return Object.assign({}, feedbackCache.data, { cached: true });
  }
  try {
    /* 原来只取第一页 100 条：Issue 超过 100 之后更早的条目静默消失，「共 N 条」也只是本页条数（审计 F7）。
       现在顺着 Link: rel="next" 翻页，最多 5 页；返回 truncated 表示「还有更多没取」，
       界面据此显示「已加载最近 N 条」而不是谎报总数。 */
    let url = GH_ISSUES_API;
    const all = [];
    let pages = 0, more = false;
    while (url && pages < FB_MAX_PAGES) {
      const r = await netFetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'XLC-Launcher/' + APP_VERSION
        }
      }, 12000);
      if (!r.ok) {
        if (pages === 0) {
          const why = (r.status === 403 || r.status === 429)
            ? 'GitHub 接口限流了（未登录每小时 60 次），过一会儿再试'
            : 'GitHub 返回 HTTP ' + r.status;
          return { ok: false, error: why + '。也可以点「在 GitHub 查看全部」直接看网页。' };
        }
        logLine('[feedback] 第 ' + (pages + 1) + ' 页取回失败（HTTP ' + r.status + '），只展示已拿到的 ' + all.length + ' 条');
        break;
      }
      const part = await r.json();
      if (!Array.isArray(part)) break;
      all.push(...part);
      pages++;
      const link = (r.headers && (r.headers.get('link') || r.headers.get('Link'))) || '';
      const m = link.match(/<([^>]+)>\s*;\s*rel="next"/i);
      url = (m && part.length) ? m[1] : '';
      more = !!url;
      if (part.length < 100) { url = ''; more = false; }
    }
    const sum = FB_CORE.feedbackSummarize(all);
    const data = {
      ok: true, fetchedAt: Date.now(), total: sum.total, groups: sum.groups,
      pages, truncated: more, repo: 'byzgdneo2/XLC-Launcher'
    };
    feedbackCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return {
      ok: false,
      error: '取不到反馈列表：' + ((e && e.message) ? e.message : String(e)) +
        '。可以点「在 GitHub 查看全部」直接看网页。'
    };
  }
});

/* 渲染层允许通过 config:save 覆盖的字段白名单；
   friends/friendCode/accounts/activeAccount/recent 等只能由主进程对应 handler 维护；
   updateUrl 已从白名单移除 —— 更新源锁定为官方地址，不再接受自定义。 */
const CONFIG_SAVE_WHITELIST = new Set([
  'source', 'customSource', 'gameDir', 'javaPath', 'mem', 'memAuto', 'jvmArgs',
  'forceChinese', 'defaultVersion', 'lastVersion', 'username', 'dlThreads', 'dlConcurrency',
  'bgMode', 'bgColor', 'accentColor', 'bgImage', 'aiApi',
  'autoCheckUpdate', 'skipPreviewUpdate', 'seenVersion', 'gamepad',
  /* 照 PCL 补齐的设置项（在「设置 → 启动 / 下载」里改）：
     全局启动选项 + 游戏参数 + 启动前命令 + 限速 + 启动器可见性 + 显卡偏好 */
  'gameArgs', 'preLaunchCmd', 'winTitle', 'winSize', 'forceIsolate',
  'procPriority', 'launcherVisibility', 'gpuPref', 'speedLimit', 'turboMode',
  'translatorBing',
  /* 内置插件「存档备份」的设置（自动开关 / 时机 / 目录 / 保留份数） */
  'backup'
]);
/* 白名单声明后再取快照（CONFIG_IO_KEYS 曾放在声明前，TDZ 崩掉整个主进程） */
const CONFIG_IO_KEYS = [...CONFIG_SAVE_WHITELIST];
ipcMain.handle('config:save', (_e, patch) => {
  const p = patch || {};
  const filtered = {};
  for (const k of Object.keys(p)) if (CONFIG_SAVE_WHITELIST.has(k)) filtered[k] = p[k];
  /* aiApi.key 掩码哨兵：渲染层未改动 key 时提交的是掩码值，保留原 key 防止被覆盖成掩码 */
  if (filtered.aiApi && typeof filtered.aiApi.key === 'string' && filtered.aiApi.key.startsWith(SECRET_MASK_PREFIX)) {
    filtered.aiApi = Object.assign({}, filtered.aiApi, { key: (config.aiApi && config.aiApi.key) || '' });
  }
  config = Object.assign({}, config, filtered);
  if (filtered.backup) config.backup = SB_CORE.normalizeBackupCfg(config.backup);
  saveConfigNow();
  return configPublic();
});

/* ---------------- 好友系统（专属好友码） ----------------
 * 每台启动器生成一个专属好友码（去混淆字符集，仅生成一次终身不变），
 * 通过好友码添加好友；码与码互不相同，不能添加自己的码或重复好友 */
const FRIEND_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
function genFriendCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I O 0 1
  const seg = n => Array.from(crypto.randomBytes(n), b => chars[b % chars.length]).join('');
  return seg(4) + '-' + seg(4) + '-' + seg(4);
}
function ensureFriendCode() {
  if (config.friendCode && FRIEND_CODE_RE.test(config.friendCode)) return config.friendCode;
  let code = genFriendCode();
  const taken = new Set((config.friends || []).map(f => f.code));
  while (taken.has(code)) code = genFriendCode();
  config.friendCode = code;
  saveConfigNow();
  logLine('[friends] 已生成本机专属好友码: ' + code);
  return code;
}
ipcMain.handle('friends:get', () => { presenceStart(); return { ok: true, code: ensureFriendCode(), friends: config.friends || [] }; });
ipcMain.on('app:renderer-error', (_e, m) => {
  captureLauncherCrash('renderer-error', new Error(String(m).slice(0, 5000)));
});
/* 界面面包屑（页面 / 设置子页 / 关键弹窗各留一行日志）。
   为什么需要：崩溃捕获只记「异常」，不记「当时停在哪」——
   用户报「用着用着就崩了」时，日志最后一行若还停在上次启动的 Java 检测，
   根本看不出他后来点了什么。有了这一行，至少能定位到页面。
   只记页面级，别记每次点击（否则日志会被淹没）。 */
ipcMain.on('ui:trace', (_e, m) => {
  const s = String(m || '').replace(/\s+/g, ' ').slice(0, 160);
  if (s) logLine('[ui] ' + s);
});
ipcMain.handle('friends:add', (_e, p) => {
  ensureFriendCode();
  const code = String((p && p.code) || '').toUpperCase().replace(/\s/g, '');
  if (!FRIEND_CODE_RE.test(code)) return { ok: false, error: '好友码格式不对，应为 XXXX-XXXX-XXXX' };
  if (code === config.friendCode) return { ok: false, error: '这是你自己的好友码，不能添加自己' };
  config.friends = config.friends || [];
  if (config.friends.some(f => f.code === code)) return { ok: false, error: '该好友已经在列表里了' };
  const name = String((p && p.name) || '').trim().slice(0, 16) || '好友 ' + code.slice(0, 4);
  config.friends.push({ code, name, addedAt: Date.now() });
  saveConfigNow();
  logLine('[friends] 添加好友 ' + name + ' (' + code + ')');
  return { ok: true, friends: config.friends };
});
ipcMain.handle('friends:remove', (_e, p) => {
  const code = String((p && p.code) || '');
  const name = ((config.friends || []).find(f => f.code === code) || {}).name || code;
  config.friends = (config.friends || []).filter(f => f.code !== code);
  saveConfigNow();
  logLine('[friends] 删除好友 ' + name + ' (' + code + ')');
  return { ok: true, friends: config.friends };
});

/* ---------------- 好友在线状态（无后端方案：公共 MQTT 心跳） ----------------
 * 每台启动器以自己的专属好友码为身份，向公共 MQTT 服务器的心跳频道每 30 秒发一次心跳，
 * 并订阅自己与所有好友的频道；90 秒内收到过对方心跳 = 在线。
 * 已知风险：公共 broker 任何人都能订阅/发布任意频道。缓解措施：
 *   1) 频道名 = 固定盐 + 好友码的 SHA-256 派生值，好友码不落明文、无法从 topic 反推；
 *   2) 信令只接受好友列表内的来源。
 * 频道只广播派生 ID 和时间戳，不含玩家名等任何隐私；服务器不可达时一律显示离线 */
const net = require('net');
const PRESENCE_PREFIX = 'xlc-alpha11-friend/';
const PRESENCE_SIG_PREFIX = 'xlc-alpha11-signal/';
const PRESENCE_TOPIC_SALT = 'xlc-presence-v1#'; /* 换盐 = 全员频道更换，升级用 */
function presenceTopicOf(code, kind) { /* kind: 'hb' 心跳 | 'sig' 联机信令 */
  const h = crypto.createHash('sha256').update(PRESENCE_TOPIC_SALT + kind + ':' + String(code).toUpperCase()).digest('hex').slice(0, 40);
  return (kind === 'sig' ? PRESENCE_SIG_PREFIX : PRESENCE_PREFIX) + h;
}
const PRESENCE_ONLINE_MS = 90 * 1000;
const PRESENCE_BROKERS = [
  { host: 'broker.emqx.io', port: 1883 },
  { host: 'broker.hivemq.com', port: 1883 },
  { host: 'test.mosquitto.org', port: 1883 }
];
const PRESENCE = {
  sock: null, connected: false, buf: Buffer.alloc(0), brokerIdx: 0,
  topics: new Set(), topicCode: new Map(), pid: 1, lastSeen: new Map(), hbTimer: null, retryTimer: null,
  signals: []
};
function mqttStr(s) { const b = Buffer.from(String(s), 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); }
function mqttRemLen(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
function mqttConnect(clientId) {
  const vh = Buffer.concat([mqttStr('MQTT'), Buffer.from([4, 0x02, 0, 60])]); /* 协议级 4 · clean session · keepalive 60s */
  const pl = mqttStr(clientId);
  return Buffer.concat([Buffer.from([0x10]), mqttRemLen(vh.length + pl.length), vh, pl]);
}
function mqttPublish(topic, payload) {
  const body = Buffer.concat([mqttStr(topic), Buffer.from(payload)]);
  return Buffer.concat([Buffer.from([0x30]), mqttRemLen(body.length), body]);
}
function mqttSubscribe(topics) {
  const pid = Buffer.alloc(2);
  PRESENCE.pid = (PRESENCE.pid % 0xffff) || 1;
  pid.writeUInt16BE(PRESENCE.pid++);
  const parts = [pid];
  for (const t of topics) parts.push(mqttStr(t), Buffer.from([0]));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x82]), mqttRemLen(body.length), body]);
}
function presenceSend(buf) { try { if (PRESENCE.sock && PRESENCE.connected) PRESENCE.sock.write(buf); } catch (_) {} }
function presenceHeartbeat() {
  if (!config.friendCode) return;
  presenceSend(mqttPublish(presenceTopicOf(config.friendCode, 'hb'), JSON.stringify({ t: Date.now(), v: 1 })));
}
function presenceTopics() {
  const set = new Set();
  if (config.friendCode) {
    set.add(presenceTopicOf(config.friendCode, 'hb'));
    set.add(presenceTopicOf(config.friendCode, 'sig')); /* 好友联机信令频道（邀请/同意/拒绝/房间码） */
  }
  for (const f of (config.friends || [])) set.add(presenceTopicOf(f.code, 'hb'));
  return set;
}
function presenceSyncSubs() {
  const want = presenceTopics();
  /* topic → 好友码 反查表（收心跳时从 topic 还原是哪位好友） */
  PRESENCE.topicCode.clear();
  for (const f of (config.friends || [])) PRESENCE.topicCode.set(presenceTopicOf(f.code, 'hb'), f.code);
  const fresh = [...want].filter(t => !PRESENCE.topics.has(t));
  if (!fresh.length) return;
  fresh.forEach(t => PRESENCE.topics.add(t)); /* 只有真正发出 SUBSCRIBE 才算已订阅 */
  if (PRESENCE.connected) presenceSend(mqttSubscribe(fresh));
}
function presenceHandleData(chunk) {
  PRESENCE.buf = Buffer.concat([PRESENCE.buf, chunk]);
  for (;;) {
    if (PRESENCE.buf.length < 2) break;
    /* remaining length 变长编码（MQTT 规范） */
    let len = 0, mul = 1, i = 1, complete = false;
    for (; i < PRESENCE.buf.length; i++) {
      const b = PRESENCE.buf[i];
      len += (b & 0x7f) * mul; mul *= 128;
      if (!(b & 0x80)) { complete = true; break; }
    }
    if (!complete || PRESENCE.buf.length < i + 1 + len) break;
    const type = PRESENCE.buf[0] >> 4;
    const body = PRESENCE.buf.slice(i + 1, i + 1 + len);
    PRESENCE.buf = PRESENCE.buf.slice(i + 1 + len);
    if (type === 2) { /* CONNACK */
      PRESENCE.connected = true;
      PRESENCE.topics.clear(); /* 每次连上都要重新订阅全部频道（断线重连/首连一致） */
      logLine('[presence] 在线状态服务已连接');
      presenceSyncSubs();
      presenceHeartbeat();
    } else if (type === 3) { /* PUBLISH (QoS0) */
      try {
        const tl = body.readUInt16BE(0);
        const topic = body.slice(2, 2 + tl).toString('utf8');
        const payload = JSON.parse(body.slice(2 + tl).toString('utf8'));
        if (topic.startsWith(PRESENCE_SIG_PREFIX) && payload && payload.type) {
          /* 时效校验：过期信令（>120s）或时间戳超前过多（>60s）视为重放/伪造，直接丢弃 */
          const now0 = Date.now();
          if (typeof payload.t !== 'number' || now0 - payload.t > 120000 || payload.t - now0 > 60000) {
            logLine('[presence] 忽略过期/异常时间戳信令: ' + payload.type);
            continue;
          }
          /* 好友联机信令：只接受好友列表内或本人发来的来源（公共频道任何人可伪造 from） */
          const from = String(payload.from || '');
          if (from === config.friendCode || (config.friends || []).some(f => f.code === from)) {
            PRESENCE.signals.push(payload);
            if (PRESENCE.signals.length > 20) PRESENCE.signals.shift();
            logLine('[presence] 收到联机信令: ' + payload.type + ' from ' + from);
          } else {
            logLine('[presence] 忽略非好友信令: ' + payload.type + ' from ' + (from || '?'));
          }
        } else if (topic.startsWith(PRESENCE_PREFIX)) {
          const code = PRESENCE.topicCode.get(topic); /* 从 topic 反查好友码（payload 不再携带明文码） */
          if (code && payload && typeof payload.t === 'number') PRESENCE.lastSeen.set(code, payload.t);
        }
      } catch (_) {}
    }
  }
}
function presenceDrop(sock) {
  PRESENCE.connected = false;
  try { sock.destroy(); } catch (_) {}
  if (PRESENCE.sock === sock) {
    PRESENCE.sock = null;
    if (!PRESENCE.retryTimer) {
      PRESENCE.brokerIdx++;
      PRESENCE.retryTimer = setTimeout(() => { PRESENCE.retryTimer = null; presenceStart(); }, 8000);
    }
  }
}
function presenceConnect() {
  if (PRESENCE.sock) return;
  const b = PRESENCE_BROKERS[PRESENCE.brokerIdx % PRESENCE_BROKERS.length];
  const sock = net.connect({ host: b.host, port: b.port });
  PRESENCE.sock = sock;
  sock.setTimeout(10000);
  sock.on('connect', () => { sock.setTimeout(0); sock.write(mqttConnect('xlc-' + crypto.randomBytes(6).toString('hex'))); });
  sock.on('data', presenceHandleData);
  sock.on('close', () => presenceDrop(sock));
  sock.on('error', () => presenceDrop(sock));
  sock.on('timeout', () => presenceDrop(sock));
}
function presenceStart() {
  ensureFriendCode();
  presenceSyncSubs();
  if (!PRESENCE.sock) presenceConnect();
  if (!PRESENCE.hbTimer) PRESENCE.hbTimer = setInterval(presenceHeartbeat, 30 * 1000);
}
/* 停止在线状态：清心跳/重连定时器并断开连接。
   以前只起不停 —— 断开或退出后 30 秒一次的心跳会一直挂着（内部虽会提前 return，
   但定时器本身永不清除）。退出流程与「主动停用联机」都走这里（审计 B5）。 */
function presenceStop() {
  if (PRESENCE.hbTimer) { clearInterval(PRESENCE.hbTimer); PRESENCE.hbTimer = null; }
  if (PRESENCE.retryTimer) { clearTimeout(PRESENCE.retryTimer); PRESENCE.retryTimer = null; }
  const s = PRESENCE.sock;
  PRESENCE.sock = null;
  PRESENCE.connected = false;
  PRESENCE.topics.clear();
  /* 先摘掉 sock 再 destroy：presenceDrop 的 close 回调看到 sock 已不是自己，就不会再排重连 */
  try { if (s) s.destroy(); } catch (_) {}
}
ipcMain.handle('friends:presence', () => {
  presenceStart();
  const now = Date.now();
  const status = {};
  for (const f of (config.friends || [])) {
    const ls = PRESENCE.lastSeen.get(f.code) || 0;
    status[f.code] = { online: ls > 0 && now - ls < PRESENCE_ONLINE_MS, lastSeen: ls };
  }
  return { ok: true, connected: PRESENCE.connected, status };
});

/* ---------------- 好友联机信令（复用 MQTT 通道） ----------------
 * 消息类型：invite（邀请联机）/ accept（同意）/ reject（拒绝）/ room（房间码交付）
 * 每条信令自动附带 from=我的好友码、name=我的玩家名、t=时间戳 */
ipcMain.handle('friends:signal-poll', () => {
  presenceStart();
  const now = Date.now();
  const out = PRESENCE.signals.filter(s => now - (s.t || 0) < 90000);
  PRESENCE.signals = [];
  /* 内置插件「模组清单对齐」：清单信令不跟界面轮询绑定 —— 就算当时人不在联机页
     （甚至不在启动器前），也先存进收件箱，回来还能看到「谁发过清单」。 */
  for (const s of out) {
    if (s && s.type === 'modlist' && s.text) {
      MODALIGN_INBOX.unshift({ from: s.from || '', name: s.name || '', text: String(s.text).slice(0, 200000), at: s.t || now });
      if (MODALIGN_INBOX.length > 5) MODALIGN_INBOX.length = 5;
      /* 推一条到界面：人正停在联机页时不用等下一次进页就能看到「谁发来清单」 */
      try { send('modlist:received', { from: s.from || '', name: s.name || '', at: s.t || now }); } catch (_) {}
    }
  }
  return { ok: true, myCode: config.friendCode, signals: out };
});
ipcMain.handle('friends:signal-send', (_e, p) => {
  presenceStart();
  const to = String((p && p.to) || '');
  if (!FRIEND_CODE_RE.test(to)) return { ok: false, error: '无效好友码' };
  const payload = Object.assign({}, (p && p.payload) || {}, {
    from: config.friendCode,
    name: String(config.username || 'Steve').slice(0, 16),
    t: Date.now()
  });
  presenceSend(mqttPublish(presenceTopicOf(to, 'sig'), JSON.stringify(payload)));
  logLine('[presence] 发送联机信令: ' + payload.type + ' → ' + to);
  return { ok: true };
});

/* ---------------- 多账户（离线） ---------------- */
const SKINS_DIR = path.join(DATA_DIR, 'skins');
const NAME_RE = /^[A-Za-z0-9_]{2,16}$/;
function accountList() { return Array.isArray(config.accounts) ? config.accounts : (config.accounts = []); }
function activeName() { return config.activeAccount || config.username || 'Steve'; }
/* 皮肤 PNG 校验：Minecraft 皮肤必须是 64x64 或 64x32 的 PNG */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function skinDataURL(file) {
  try {
    const buf = fs.readFileSync(path.join(SKINS_DIR, file));
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (_) { return null; }
}
/* 账户列表输出：令牌/密码/刷新令牌一律剥离，绝不进渲染进程（含皮肤 dataURL） */
function accountsOut() {
  return accountList().map(a => {
    const { msRefresh, mcToken, accessToken, clientToken, password, msClientId, ...rest } = a;
    return { ...rest, skinUrl: a.skin ? skinDataURL(a.skin) : null };
  });
}
ipcMain.handle('account:list', () => ({ ok: true, accounts: accountsOut(), active: activeName() }));
ipcMain.handle('account:add', (_e, p) => {
  const name = String(p && p.name || '').trim();
  if (!NAME_RE.test(name)) return { ok: false, error: '玩家名限 2-16 个字母/数字/下划线' };
  const list = accountList();
  if (list.some(a => a.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: '该玩家名已存在' };
  const acc = { name, skin: null, model: 'classic' };
  list.push(acc);
  if (!config.activeAccount) { config.activeAccount = name; config.username = name; }
  saveConfigNow();
  return { ok: true, accounts: accountsOut(), active: activeName() };
});
ipcMain.handle('account:switch', (_e, p) => {
  const name = String(p && p.name || '');
  const acc = accountList().find(a => a.name === name);
  if (!acc) return { ok: false, error: '账户不存在' };
  config.activeAccount = name;
  config.username = name; /* 玩家名跟随当前账户，所有页面/启动统一 */
  saveConfigNow();
  return { ok: true, accounts: accountsOut(), active: activeName() };
});
/* 离线账户改名：只改启动器里这个账户的名字。
   在线账户（微软 / 外置登录）的玩家名是认证服务器给的，改了下次刷新就被覆盖 —— 直接拒绝。
   皮肤文件名带账户名（skin_<名字>_<时间戳>.png），改名时一并重写，免得皮肤目录里留一堆对不上的旧文件。 */
ipcMain.handle('account:rename', (_e, p) => {
  const name = String(p && p.name || '');
  const to = String(p && p.to || '').trim();
  const acc = accountList().find(a => a.name === name);
  if (!acc) return { ok: false, error: '账户不存在' };
  if (acc.type && acc.type !== 'offline') return { ok: false, error: '在线账户的玩家名由认证服务器决定，不能在这里修改' };
  if (!NAME_RE.test(to)) return { ok: false, error: '玩家名限 2-16 个字母/数字/下划线' };
  if (to === name) return { ok: true, accounts: accountsOut(), active: activeName() };
  if (accountList().some(a => a !== acc && a.name.toLowerCase() === to.toLowerCase())) return { ok: false, error: '该玩家名已存在' };
  if (acc.skin) {
    try {
      const nf = 'skin_' + to.replace(/[^\w]/g, '_') + '_' + Date.now() + '.png';
      fs.renameSync(path.join(SKINS_DIR, acc.skin), path.join(SKINS_DIR, nf));
      acc.skin = nf;
    } catch (_) { /* 重命名失败就沿用旧文件名：皮肤内容不受影响，只是文件名不再跟着账户名 */ }
  }
  acc.name = to;
  if (config.activeAccount === name) { config.activeAccount = to; config.username = to; }
  saveConfigNow();
  return { ok: true, accounts: accountsOut(), active: activeName() };
});
ipcMain.handle('account:delete', (_e, p) => {
  const name = String(p && p.name || '');
  const list = accountList();
  const i = list.findIndex(a => a.name === name);
  if (i < 0) return { ok: false, error: '账户不存在' };
  const acc = list[i];
  list.splice(i, 1);
  if (acc.skin) { try { fs.unlinkSync(path.join(SKINS_DIR, acc.skin)); } catch (_) {} }
  if (config.activeAccount === name) {
    config.activeAccount = list.length ? list[0].name : '';
    config.username = config.activeAccount || 'Steve';
  }
  saveConfigNow();
  return { ok: true, accounts: accountsOut(), active: activeName() };
});
ipcMain.handle('account:skin', async (_e, p) => {
  const name = String(p && p.name || '');
  const acc = accountList().find(a => a.name === name);
  if (!acc) return { ok: false, error: '账户不存在' };
  const r = await dialog.showOpenDialog(win, {
    title: '选择皮肤文件（64x64 或 64x32 PNG）',
    filters: [{ name: '皮肤 PNG', extensions: ['png'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const buf = await fsp.readFile(r.filePaths[0]);
    const dim = pngSize(buf);
    if (!dim) return { ok: false, error: '不是有效的 PNG 文件' };
    if (!((dim.w === 64 && (dim.h === 64 || dim.h === 32)))) return { ok: false, error: '皮肤必须是 64x64（新版）或 64x32（旧版）的 PNG，当前 ' + dim.w + 'x' + dim.h };
    fs.mkdirSync(SKINS_DIR, { recursive: true });
    const file = 'skin_' + name.replace(/[^\w]/g, '_') + '_' + Date.now() + '.png';
    fs.writeFileSync(path.join(SKINS_DIR, file), buf);
    /* 换新文件后删旧文件 */
    if (acc.skin && acc.skin !== file) { try { fs.unlinkSync(path.join(SKINS_DIR, acc.skin)); } catch (_) {} }
    acc.skin = file;
    acc.model = (p.model === 'slim') ? 'slim' : 'classic';
    saveConfigNow();
    return { ok: true, accounts: accountsOut(), active: activeName() };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('account:model', (_e, p) => {
  const name = String(p && p.name || '');
  const acc = accountList().find(a => a.name === name);
  if (!acc) return { ok: false, error: '账户不存在' };
  acc.model = (p.model === 'slim') ? 'slim' : 'classic';
  saveConfigNow();
  return { ok: true, accounts: accountsOut(), active: activeName() };
});
ipcMain.handle('account:skin-remove', (_e, p) => {
  const name = String(p && p.name || '');
  const acc = accountList().find(a => a.name === name);
  if (!acc) return { ok: false, error: '账户不存在' };
  if (acc.skin) { try { fs.unlinkSync(path.join(SKINS_DIR, acc.skin)); } catch (_) {} }
  acc.skin = null;
  saveConfigNow();
  return { ok: true, accounts: accountsOut(), active: activeName() };
});
/* 冒烟测试专用（仅设置 LMC_SMOKE_SKIN=1 时注册）：直接启动皮肤服务器 / 取注入参数 /
   直接查询注册表与本地服务应答（本地签名服务的回归靠这几个口子） */
if (process.env.LMC_SMOKE_SKIN) {
  ipcMain.handle('skin:smoke-start', async () => ({ port: await startSkinServer() }));
  ipcMain.handle('skin:smoke-args', async () => ensureSkinLaunch(() => {}));
  ipcMain.handle('skin:smoke-register', (_e, name) => {
    const acc = accountList().find(a => a.name === name);
    const uuid = skinRegisterAccount(acc);
    return { ok: !!uuid, uuid, port: skinSrvState.port, hasKey: !!skinSrvState.key,
             textures: skinSrvState.textures.size, profiles: skinSrvState.profilesByUuid.size };
  });
  ipcMain.handle('skin:smoke-stop', () => { stopSkinServer(); return { ok: true }; });
  /* 直接向本地服务发一次真实请求，返回状态码与响应体（验证签名/路径/缓存头） */
  ipcMain.handle('skin:smoke-fetch', async (_e, pathAndQuery) => {
    if (!skinSrvState.srv) return { ok: false, error: '服务未启动' };
    try {
      const r = await fetch('http://127.0.0.1:' + skinSrvState.port + pathAndQuery);
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, status: r.status, type: r.headers.get('content-type'),
               cache: r.headers.get('cache-control'), body: buf.toString('utf8').slice(0, 4000),
               bytes: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

/* ---------------- 微软正版登录（浏览器回调 OAuth 2.0 + PKCE） + 第三方外置登录（authlib-injector 协议） ----------------
 * 微软：点「微软登录」→ 拉起系统默认浏览器到**微软官方**授权页 → 登录并同意 →
 * 浏览器被重定向回本机 127.0.0.1 的一次性回调地址 → 取授权码 → 换令牌 →
 * XBL → XSTS → Minecraft 服务 → 角色档案 → 写入账户。全程不回传密码、也不需要用户抄代码。
 *
 * 为什么绕不开「授权给一个应用」：启动器要的不是「你登录过微软」这件事，而是能代表玩家
 * 去连 Mojang 服务器的令牌；OAuth 协议本身就要求由「一个已注册的应用」来申请令牌。
 * 但「公共客户端」的应用 ID 不是密钥（没有 client_secret），可以随启动器公开分发 ——
 * 所以普通玩家不需要自己注册应用，也不用填任何东西。 */
const MS_OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MS_SCOPE = 'XboxLive.signin offline_access';

/* ---------- 默认流程：内置窗口登录（零配置，和 PCL2 一样的做法） ----------
 * 用的客户端 ID 是微软**给 Minecraft 官方启动器注册的那个公共客户端**，它是公开值
 * （没有 client_secret，官方启动器自己也是明文放在安装目录里的），第三方启动器普遍直接沿用。
 * 走的是 login.live.com 的老端点，重定向固定到 oauth20_desktop.srf —— 这是个微软自己的
 * 页面，授权码就挂在它的查询串上，所以只要能读到这次跳转的 URL 就能拿到码。
 * 「读到 URL」这件事由**启动器内置的浏览器窗口**完成：用户看到的是微软官方登录页，
 * 登录完我们直接截获那次跳转，不用跳系统浏览器、不用抄代码、更不用注册任何应用。 */
const MS_OFFICIAL_CLIENT_ID = '00000000402b5328';
const MS_LIVE_BASE = 'https://login.live.com';
const MS_LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const MS_LIVE_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';

/* ============ 网络出口（主进程统一请求函数）============
 * 为什么不用 Node 自带的 fetch：Node 的 fetch（undici）**不读系统代理**，而启动器内置的登录窗口
 * 跑在 Chromium 上、是读的。于是开了代理 / VPN 的玩家会撞上最迷惑的一幕 —— 登录页能打开、
 * 账号密码也能正常登进去，可接下来「授权码换令牌 → Xbox → Minecraft」这几步是主进程直连出去的，
 * 直接失败或一直卡到超时，表现出来就是「微软登录不了」。
 * netFetch 走 Electron 的 net.fetch（Chromium 网络栈）：系统代理、PAC、证书都和登录窗口完全一致，
 * 登录窗口能通的地方它就能通。超时用 Promise.race 兜底（net.fetch 不认 AbortSignal）。 */
async function netFetch(url, init, timeoutMs) {
  const ms = Math.max(3000, Number(timeoutMs) || 20000);
  const opt = Object.assign({}, init || {});
  delete opt.signal;                      /* net.fetch 会忽略它，交给下面的竞速兜底 */
  let mod = null;
  try { mod = require('electron').net; } catch (_) {}
  const useChromium = !!(mod && typeof mod.fetch === 'function');
  const req = useChromium
    ? mod.fetch(url, opt)
    : fetch(url, Object.assign({}, opt, { signal: AbortSignal.timeout(ms) }));
  req.catch(() => {});                    /* 标记已处理：竞速落败后它再拒绝也不该炸进程 */
  let timer = null;
  try {
    return await Promise.race([
      req,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('网络请求超时（' + Math.round(ms / 1000) + ' 秒未响应）：' +
          String(url).replace(/^https?:\/\//, '').split('/')[0])), ms);
      })
    ]);
  } finally { try { clearTimeout(timer); } catch (_) {} }
}
/* 判断一个错误是不是「网络层没通」（用于决定要不要顺带跑一次连通性自检） */
function netErrLike(msg) {
  return /fetch failed|timeout|超时|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|net::|ERR_/i.test(String(msg || ''));
}
/* 微软登录链路要用到的服务（连通性自检的目标） */
const MS_NET_TARGETS = [
  { key: 'live', name: '微软登录页', url: 'https://login.live.com/oauth20_authorize.srf' },
  { key: 'xbl', name: 'Xbox 账户服务', url: 'https://user.auth.xboxlive.com/' },
  { key: 'xsts', name: 'Xbox 授权服务', url: 'https://xsts.auth.xboxlive.com/' },
  { key: 'mc', name: 'Minecraft 服务', url: 'https://api.minecraftservices.com/' },
  { key: 'profile', name: 'Xbox 档案服务', url: 'https://profile.xboxlive.com/' }
];
/* 把自检结果翻成人能看懂的一句话（纯函数，便于自测）。传入 [{ok, name}]。 */
function msNetAdviceFrom(results, via) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return '';
  const bad = list.filter(r => r && !r.ok);
  if (!bad.length) return '';
  const proxyNote = /PROXY|SOCKS/i.test(String(via || '')) ? '当前走代理（' + String(via).slice(0, 40) + '）' : '当前是直连（没走系统代理）';
  const names = bad.map(r => r.name).join('、');
  if (bad.length === list.length) {
    return '自检：' + names + ' 全部连不上（' + proxyNote + '）。请检查网络是否正常、代理/VPN 是否只对浏览器生效，可换线路或关闭代理后重试';
  }
  return '自检：' + names + ' 连不上，但其余服务正常（' + proxyNote + '）。多半是代理/VPN 只代理了部分流量，试试全局模式或换条线路';
}
/* 逐个探一遍（并行，最多等 6 秒），返回每个服务是否可达 */
async function msNetProbeAll(timeoutMs) {
  const ms = Math.max(3000, Number(timeoutMs) || 6000);
  return Promise.all(MS_NET_TARGETS.map(async (t) => {
    const t0 = Date.now();
    try {
      const r = await netFetch(t.url, { method: 'GET' }, ms);
      return { key: t.key, name: t.name, url: t.url, ok: true, status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      return { key: t.key, name: t.name, url: t.url, ok: false, ms: Date.now() - t0, error: (e && e.message) || String(e) };
    }
  }));
}
/* 当前生效的代理路径（Chromium 的判定结果，含系统代理 / PAC / 启动参数） */
async function netProxyVia() {
  try { return String(await session.defaultSession.resolveProxy('https://login.live.com')); }
  catch (_) { return ''; }
}

/* 自定义流程用的应用 ID（可选）。自己注册的话（Azure / Entra 门户 → 应用注册，一次性、免费）：
 *   受支持的账户类型 = 任何组织目录中的账户和个人 Microsoft 账户（个人账户必须支持）
 *   平台           = 「移动和桌面应用程序」，重定向 URI 填 http://localhost（环回地址端口由微软忽略）
 *   权限           = XboxLive.signin + offline_access（微软 Graph 之外，无需管理员同意）
 *   客户端密码     = 不需要（公共客户端）
 * 留空时只有内置流程可用（对普通用户足够了）。 */
const MS_CLIENT_ID = '';
const MS_MSA_TENANT = 'consumers';   /* 只放行个人微软账户，避开组织账户的各种限制 */
function msIdOk(id) { return /^[0-9a-fA-F-]{8,40}$/.test(String(id || '').trim()); }
/* 应用 ID 取值优先级：界面手填 > 内置 > 历史配置里存过的。
   注意顺序 —— 历史值可能是旧版本留下的、已失效的自建应用，
   不能让它顶掉内置 ID（新用户升级后应该直接能用）。 */
function msResolveClientId(p) {
  const typed = String((p && p.clientId) || '').trim();
  if (msIdOk(typed)) return { id: typed, custom: true };
  const builtin = String(MS_CLIENT_ID || '').trim();
  if (msIdOk(builtin)) return { id: builtin, custom: false };
  const saved = String(config.msClientId || '').trim();
  if (msIdOk(saved)) return { id: saved, custom: true };
  return { id: '', custom: false };
}
/* 静默续期必须用「当初登录这个账户时用的那个应用 ID」——刷新令牌是与应用绑定的。
   顺序：账户上记的 > 历史配置 > 内置。 */
function msClientIdForRefresh(acc) {
  const a = String((acc && acc.msClientId) || '').trim();
  if (msIdOk(a)) return a;
  const saved = String(config.msClientId || '').trim();
  if (msIdOk(saved)) return saved;
  const builtin = String(MS_CLIENT_ID || '').trim();
  return msIdOk(builtin) ? builtin : '';
}
function msB64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function msEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 回调后在浏览器里展示的结果页（只在 127.0.0.1 上，看完即可关闭） */
function msResultHtml(ok, msg) {
  const color = ok ? '#3ecf8e' : '#ff6b6b';
  const line = ok ? '已成功登录，可以关闭此页面回到启动器了。' : (msg || '授权未完成，请回到启动器重试。');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>XLC 启动器 · ' + (ok ? '登录成功' : '登录未完成') + '</title>'
    + '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;'
    + 'background:#12141a;color:#e7eaf2;font:15px/1.75 "Microsoft YaHei",system-ui,-apple-system,sans-serif}'
    + '.c{max-width:460px;padding:36px 42px;border-radius:18px;background:#1b1e26;border:1px solid #2b3040;text-align:center}'
    + 'h1{margin:0 0 12px;font-size:21px;color:' + color + '}p{margin:0;color:#98a1b3;word-break:break-word}</style></head>'
    + '<body><div class="c"><h1>' + (ok ? '&#10003; 登录成功' : '&#10007; 登录未完成') + '</h1><p>' + msEsc(line) + '</p></div></body></html>';
}
function msListen(server, port, host) {
  return new Promise((res, rej) => {
    const onErr = (e) => { server.removeListener('listening', onOk); rej(e); };
    const onOk = () => { server.removeListener('error', onErr); res(server); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, host);
  });
}
/* 授权页 URL（纯拼装，便于自测） */
function msAuthUrl(clientId, L) {
  return MS_OAUTH + '/authorize?' + new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: L.redirectUri,
    scope: MS_SCOPE,
    code_challenge: L.challenge,
    code_challenge_method: 'S256',
    state: L.state,
    prompt: 'select_account'
  }).toString();
}
/* 起一个只监听环回地址的一次性回调服务器（端口由系统随机分配），返回授权所需的全部材料。
 * 同时尝试绑定 IPv6 ::1 同端口 —— 某些浏览器把 localhost 解析成 ::1，
 * 只绑 127.0.0.1 会让回调打不通（用户看到「无法访问此网站」）。绑不上就忽略。 */
async function msStartLoopback(clientId, timeoutMs) {
  const verifier = msB64u(crypto.randomBytes(32));
  const challenge = msB64u(crypto.createHash('sha256').update(verifier, 'utf8').digest());
  const state = msB64u(crypto.randomBytes(16));
  let resolveOuter = null, rejectOuter = null;
  const onReq = (req, res) => {
    let q = new URLSearchParams();
    try { q = new URL(req.url, 'http://localhost/').searchParams; } catch (_) {}
    const code = q.get('code'), err = q.get('error'), st = q.get('state');
    const reply = (ok, msg) => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(msResultHtml(ok, msg));
      } catch (_) {}
    };
    /* 浏览器会顺手请求 favicon.ico 之类：回提示页，但绝不能让它把登录流程判成功或判失败 */
    if (!code && !err) { reply(false, '这是启动器的一次性登录回调地址，请回到启动器继续操作。'); return; }
    if (err) {
      reply(false, q.get('error_description') || err);
      if (rejectOuter) rejectOuter(new Error(q.get('error_description') || ('微软返回错误: ' + err)));
      return;
    }
    if (st !== state) { reply(false, '状态校验失败：这次回调不属于本次登录请求。'); if (rejectOuter) rejectOuter(new Error('state 校验失败')); return; }
    reply(true, '');
    resolveOuter(code);
  };
  const server = http.createServer(onReq);
  await msListen(server, 0, '127.0.0.1');
  const port = server.address().port;
  let server6 = null;
  try { server6 = http.createServer(onReq); await msListen(server6, port, '::1'); }
  catch (_) { try { if (server6) server6.close(); } catch (__) {} server6 = null; }
  const redirectUri = 'http://localhost:' + port + '/';
  const codePromise = new Promise((resolve, reject) => { resolveOuter = resolve; rejectOuter = reject; });
  codePromise.catch(() => {});   /* 标记已处理，避免未捕获拒绝告警（等待方仍能拿到 reject） */
  const mins = Math.max(1, Math.round((timeoutMs || 300000) / 60000));
  const timer = setTimeout(() => {
    try { server.close(); } catch (_) {}
    try { if (server6) server6.close(); } catch (_) {}
    if (rejectOuter) rejectOuter(new Error('登录等待超时（' + mins + ' 分钟内未在浏览器完成授权），请重试'));
  }, timeoutMs || 300000);
  /* cancel：用户主动放弃 / 又要发起新的一次登录 → 关端口并让等待方立刻失败（不能干等超时） */
  const cancel = () => {
    try { clearTimeout(timer); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { if (server6) server6.close(); } catch (_) {}
    if (rejectOuter) rejectOuter(new Error('已取消登录'));
  };
  return { server, server6, port, redirectUri, verifier, challenge, state, codePromise, timer, cancel };
}
let msPending = null;
function msClosePending() {
  const p = msPending;
  msPending = null;
  if (!p) return;
  if (typeof p.cancel === 'function') { try { p.cancel(); return; } catch (_) {} }
  try { clearTimeout(p.timer); } catch (_) {}
  try { p.server.close(); } catch (_) {}
  try { if (p.server6) p.server6.close(); } catch (_) {}
}
/* 授权码换令牌（公共客户端 + PKCE，不带 client_secret） */
async function msExchangeCode(clientId, code, redirectUri, verifier) {
  const res = await netFetch(MS_OAUTH + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'authorization_code', code: code,
      redirect_uri: redirectUri, code_verifier: verifier, scope: MS_SCOPE
    })
  }, 20000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(String(j.error_description || j.error || ('HTTP ' + res.status)));
  }
  return j;
}
/* ---------- 内置登录窗口 ----------
 * 用启动器自己的窗口承载微软官方授权页。用户看到的就是 login.live.com 的官方页面，
 * 我们在导航事件里截获 oauth20_desktop.srf 这次跳转，把 code 取出来。 */
let msWin = null;
let msWinCancel = null;   /* 自测模式下代替真实窗口的取消钩子 */
function msCloseWebWin() {
  const w = msWin;
  msWin = null;
  if (w && !w.isDestroyed()) { try { w.destroy(); } catch (_) {} }
  const c = msWinCancel;
  msWinCancel = null;
  if (typeof c === 'function') { try { c(); } catch (_) {} }
}
/* 内置浏览器要伪装成普通浏览器：Electron / 应用名出现在 UA 里时，
   微软会判定「不安全的嵌入式浏览器」而拒绝登录（而真实浏览器是允许的）。
   这里只保留标准 Chromium 标识 —— 我们本来就跑在 Chromium 上，并非伪造其他浏览器。 */
function msCleanUA() {
  const ua = String(app.userAgentFallback || '');
  const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '126.0.0.0';
  const plat = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
  return 'Mozilla/5.0 (' + plat + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
}
function msLiveAuthUrl(state) {
  return MS_LIVE_BASE + '/oauth20_authorize.srf?' + new URLSearchParams({
    client_id: MS_OFFICIAL_CLIENT_ID, response_type: 'code', redirect_uri: MS_LIVE_REDIRECT,
    scope: MS_LIVE_SCOPE, state: state, prompt: 'select_account'
  }).toString();
}
/* 判断一次导航是不是「登录完成」的回调，是的话给出结论（纯函数，便于自测）：
 *   返回 null                         → 不是回调，继续等
 *   返回 { error: '...' }             → 微软明确拒绝（error / state 不符）
 *   返回 { code: '...' }              → 拿到授权码 */
function msGrabAuthCode(url, state) {
  let p = null;
  try { p = new URL(String(url || '')); } catch (_) { return null; }
  if (!/login\.live\.com$/i.test(p.hostname)) return null;
  if (p.pathname.indexOf('oauth20_desktop') < 0) return null;
  const err = p.searchParams.get('error');
  if (err) return { error: p.searchParams.get('error_description') || ('微软返回错误: ' + err) };
  const code = p.searchParams.get('code');
  if (!code) return null;
  const st = p.searchParams.get('state');
  if (st && st !== state) return { error: 'state 校验失败：这次回调不属于本次登录请求' };
  return { code: code };
}
/* 打开内置登录窗口，resolve 出授权码。用户关窗 / 超时 → reject。 */
function msWebLogin(timeoutMs) {
  return new Promise((resolve, reject) => {
    msCloseWebWin();
    const state = msB64u(crypto.randomBytes(16));
    const authUrl = msLiveAuthUrl(state);
    let done = false;
    let timer = null;
    const finish = (err, code) => {
      if (done) return;
      done = true;
      try { if (timer) clearTimeout(timer); } catch (_) {}
      msCloseWebWin();
      if (err) reject(err); else resolve(code);
    };
    /* 只认「host 是 login.live.com 且路径是 oauth20_desktop」的那次跳转，
       其它任何导航（登录页内部的跳转、错误页、第三方链接）都不算结果。 */
    const grab = (u) => {
      const r = msGrabAuthCode(u, state);
      if (!r) return;
      finish(r.error ? new Error(r.error) : null, r.code);
    };
    let w = null;
    /* 自测进程绝不真的开窗口（会占住跑测试的人的桌面、还会真的连微软）：
       挂一个「永不完成但可取消」的等待 —— 对界面来说行为和真实等待完全一致。 */
    if (SMOKE_EARLY && !process.env.LMC_SMOKE_MS_WEB_REAL) {
      msWinCancel = () => finish(new Error('已取消登录'));
      timer = setTimeout(() => finish(new Error('登录等待超时，请重试')), timeoutMs || 300000);
      logLine('[msauth] 自测模式：不打开真实登录窗口 · ' + authUrl.slice(0, 72) + '…');
      return;
    }
    /* 自测用：把授权页换成本地页面，真跑一遍「窗口 → 跳转 → 截获授权码」（离线、不开可见窗口） */
    const testPage = (SMOKE_EARLY && process.env.LMC_SMOKE_MS_TEST_PAGE)
      ? String(process.env.LMC_SMOKE_MS_TEST_PAGE) : '';
    try {
      w = new BrowserWindow({
        width: 520, height: 760, minWidth: 420, minHeight: 560,
        parent: (win && !win.isDestroyed()) ? win : undefined,
        show: false, autoHideMenuBar: true, backgroundColor: '#ffffff',
        title: '登录 Microsoft 账户 · XLC 启动器',
        icon: path.join(ROOT, 'assets', 'icon.png'),
        webPreferences: {
          nodeIntegration: false, contextIsolation: true, sandbox: false,
          backgroundThrottling: false,        /* 窗口被挡在后面时也照常渲染/响应 */
          partition: 'persist:xlc-mslogin'   /* 单独会话：登录状态留在自己这里，不碰主界面的缓存 */
        }
      });
    } catch (e) { finish(new Error('无法打开登录窗口：' + ((e && e.message) || e))); return; }
    msWin = w;
    try { w.setMenuBarVisibility(false); } catch (_) {}
    try { w.webContents.setUserAgent(msCleanUA()); } catch (_) {}
    /* 自测（testPage）下窗口保持隐藏：沙箱环境里弹可见窗口会被系统直接掐掉 */
    w.once('ready-to-show', () => { if (!w.isDestroyed() && !testPage) w.show(); });
    /* 用户关窗 = 取消登录（不是失败，但要让等待方醒过来） */
    w.on('closed', () => { if (msWin === w) msWin = null; finish(new Error('已取消登录')); });
    const wc = w.webContents;
    wc.on('will-redirect', (_e, u) => grab(u));
    wc.on('will-navigate', (_e, u) => grab(u));
    wc.on('did-navigate', (_e, u) => grab(u));
    wc.on('did-redirect-navigation', (_e, u) => grab(u));
    /* 页面里的第三方链接（隐私政策、购买页等）交给系统浏览器，别在登录窗口里乱跑 */
    wc.setWindowOpenHandler(({ url }) => { try { shell.openExternal(url); } catch (_) {} return { action: 'deny' }; });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain) return;
      if (code === -3) return;   /* 主动中止（我们截获跳转后自己关的）不算失败 */
      finish(new Error('登录页加载失败（' + desc + '），请检查网络后重试'));
    });
    const mins = Math.max(1, Math.round((timeoutMs || 300000) / 60000));
    timer = setTimeout(() => finish(new Error('登录等待超时（' + mins + ' 分钟内未完成），请重试')), timeoutMs || 300000);
    w.loadURL(testPage || authUrl).catch((e) => finish(new Error('登录页加载失败：' + ((e && e.message) || e))));
  });
}
/* 老端点：授权码换令牌（公共客户端，无 client_secret） */
async function msLiveExchange(clientId, code) {
  const res = await netFetch(MS_LIVE_BASE + '/oauth20_token.srf', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'authorization_code', code: code,
      redirect_uri: MS_LIVE_REDIRECT, scope: MS_LIVE_SCOPE
    })
  }, 20000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(String(j.error_description || j.error || ('授权码换令牌失败 (HTTP ' + res.status + ')')));
  }
  return j;
}
/* 登录进度上报：主进程 → 渲染层，界面按步骤打勾（1 打开登录页 2 账户信息 3 购买检查 4 角色档案） */
function msStep(step, text) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('account:ms-progress', { step: step | 0, text: String(text || '') });
    }
  } catch (_) {}
}
function msXErrText(xerr) {
  const x = Number(xerr);
  if (x === 2148916227) return '该微软账户已被 Xbox Live 封禁，无法登录';
  if (x === 2148916233) return '该微软账户还没有 Xbox 档案：请先用这个账号登录一次 xbox.com 创建档案，再回来登录';
  if (x === 2148916234) return '该账户需要先同意 Xbox 服务条款：请到 xbox.com 登录一次并接受条款';
  if (x === 2148916235) return '该账户所在国家/地区不支持 Xbox Live，无法登录';
  if (x === 2148916236 || x === 2148916237) return '该账户需要成年验证（韩国地区要求），请到 xbox.com 完成验证';
  if (x === 2148916238) return '该账户是儿童账户：需要家长在 Microsoft 家庭组里允许它加入 Xbox 网络';
  if (x === 2148910053) return '该微软账户没有 Minecraft 正版（未购买或未关联）';
  if (x === 2148910067) return '该账户所在地区受限制，无法玩 Minecraft';
  if (x === 2148910065 || x === 2148910066) return 'Xbox 账户未创建或受限，请先在 Xbox 上创建档案';
  if (x === 2148910069) return '该账户是儿童账户，需在家长设置中允许加入 Xbox 网络';
  return 'Xbox 服务返回错误 (XErr=' + xerr + ')';
}
/* 购买检查：问 Mojang「这个账户名下有没有 Minecraft 许可」。
 * items 非空 = 确实买了（product_minecraft / game_minecraft 各一条）；
 * items 空但角色档案存在 = 也能玩（典型是 Xbox Game Pass 用户 —— 他们并不"拥有"游戏）。
 * 查询本身失败不算"没买"：只标记 known=false，别冤枉用户。 */
async function msCheckEntitlements(mcToken) {
  try {
    const res = await netFetch('https://api.minecraftservices.com/entitlements/mcstore', {
      headers: { Authorization: 'Bearer ' + mcToken }
    }, 12000);
    if (!res.ok) return { known: false, owned: false, items: [], why: 'HTTP ' + res.status };
    const j = await res.json().catch(() => ({}));
    const items = Array.isArray(j.items) ? j.items.map(x => String((x && x.name) || '')).filter(Boolean) : [];
    return { known: true, owned: items.length > 0, items: items };
  } catch (e) {
    return { known: false, owned: false, items: [], why: (e && e.message) || String(e) };
  }
}
/* 购买状态判定（纯函数，便于自测）：
 *   known=false            → unknown ：许可接口没查成功，不下结论（别冤枉人）
 *   owned=true             → owned   ：名下确实有 Minecraft 许可
 *   owned=false + 有档案    → gamepass：没查到购买记录，但角色档案在 → 靠 Game Pass 等权益在玩
 *   owned=false + 无档案    → none    ：确实没买（连角色都建不了） */
function msOwnershipOf(known, owned, hasProfile) {
  if (!known) return 'unknown';
  if (owned) return 'owned';
  return hasProfile ? 'gamepass' : 'none';
}
/* 静默续期的目标端点：两条流程的刷新令牌互不通用（纯函数，便于自测） */
function msRefreshTarget(acc) {
  const live = (((acc && acc.msFlow) || 'live') === 'live');
  return {
    live: live,
    url: live ? (MS_LIVE_BASE + '/oauth20_token.srf') : (MS_OAUTH + '/token'),
    scope: live ? MS_LIVE_SCOPE : MS_SCOPE
  };
}
/* 读 JWT 载荷（只解码展示用，不验签 —— 令牌是刚由微软直接下发给本机的） */
function msJwtPayload(tok) {
  try {
    const p = String(tok || '').split('.')[1];
    if (!p) return {};
    const b = p.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  } catch (_) { return {}; }
}
/* Xbox 玩家代号（拿不到就算了，纯展示；不影响登录） */
async function msXboxGamertag(xstsToken, uhs) {
  try {
    const r = await netFetch('https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag', {
      headers: { 'Authorization': 'XBL3.0 x=' + uhs + ';' + xstsToken, 'x-xbl-contract-version': '2', 'Accept': 'application/json' }
    }, 12000);
    if (!r.ok) return '';
    const j = await r.json().catch(() => ({}));
    const s = (((j.profileUsers || [])[0] || {}).settings) || [];
    const hit = s.find(x => x && x.id === 'Gamertag');
    return (hit && hit.value) ? String(hit.value) : '';
  } catch (_) { return ''; }
}
async function msJson(url, body, timeout) {
  const res = await netFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  }, timeout || 20000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const xe = j.XErr;
    throw new Error(xe ? msXErrText(xe) : (j.error_description || j.error || ('HTTP ' + res.status)));
  }
  return j;
}
/* msAccessToken → XBL → XSTS → MC 令牌 → **购买检查** → 角色档案，返回完整在线凭据。
 * 顺序和 PCL2 一致：先把账户信息拿到手，再确认这个账号到底买没买游戏，最后取角色档案。
 * opts.onStep(步骤号, 文案) 用于把进度推给界面。 */
async function msChainFromToken(msToken, refresh, opts) {
  const o = opts || {};
  const say = (n, t) => { if (typeof o.onStep === 'function') { try { o.onStep(n, t); } catch (_) {} } };

  say(2, '正在获取 Xbox 账户信息…');
  const xbl = await msJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msToken },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
  });
  const uhs = xbl.DisplayClaims.xui[0].uhs;
  const xsts = await msJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
  });
  const xuid = String((msJwtPayload(xsts.Token).xui || [{}])[0].xid || '');
  const gamertag = o.skipGamertag ? '' : await msXboxGamertag(xsts.Token, uhs);

  const mc = await netFetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ identityToken: 'XBL3.0 x=' + xsts.DisplayClaims.xui[0].uhs + ';' + xsts.Token })
  }, 20000).then(r => r.json());
  if (!mc.access_token) throw new Error('Minecraft 服务登录失败: ' + JSON.stringify(mc).slice(0, 120));

  /* 购买检查（用户要求：先获取信息，再检查购没购买） */
  say(3, '正在检查是否已购买 Minecraft…');
  const ent = o.skipEntitlements ? { known: false, owned: false, items: [] } : await msCheckEntitlements(mc.access_token);

  say(4, '正在获取角色档案…');
  const profRes = await netFetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: 'Bearer ' + mc.access_token }
  }, 20000);
  if (profRes.status === 404) {
    if (msOwnershipOf(ent.known, ent.owned, false) === 'none') {
      throw new Error('该微软账户没有 Minecraft 正版：查不到任何购买记录，名下也没有角色档案。请换用已购买过 Java 版的账户登录，或先到 minecraft.net 购买后再试');
    }
    throw new Error('该账户还没有 Minecraft 角色：Java 版首次使用需要先在 minecraft.net 上设置玩家名');
  }
  if (!profRes.ok) throw new Error('获取角色档案失败 (HTTP ' + profRes.status + ')');
  const prof = await profRes.json();
  return {
    name: prof.name, uuid: prof.id,
    mcToken: mc.access_token, expiresAt: Date.now() + ((mc.expires_in || 86400) - 600) * 1000,
    msRefresh: refresh,
    xuid: xuid, gamertag: gamertag,
    ownership: msOwnershipOf(ent.known, ent.owned, true), entitlements: ent.items
  };
}
/* 用刷新令牌静默续期（启动时自动调用），成功后更新账户并写配置。
 * 注意两条流程的令牌是**分开的**：内置流程（login.live.com）的刷新令牌只能在 live.com 上换，
 * 拿去 login.microsoftonline.com 会直接报错，所以按账户上记的 msFlow 选端点。 */
async function msRefreshChain(acc) {
  const cid = msClientIdForRefresh(acc);
  if (!cid) return { ok: false, error: '未配置应用 ID，无法静默续期' };
  const T = msRefreshTarget(acc);
  try {
    const res = await netFetch(T.url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, grant_type: 'refresh_token', refresh_token: acc.msRefresh, scope: T.scope })
    }, 20000);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) return { ok: false, error: j.error_description || j.error || 'HTTP ' + res.status };
    const chain = await msChainFromToken(j.access_token, j.refresh_token || acc.msRefresh, { skipGamertag: true });
    /* 续期时许可接口没查成功（网络抖动）不该把已知结论降级成「未知」 */
    if (chain.ownership === 'unknown') {
      const prev = String(acc.ownership || '');
      if (prev === 'owned' || prev === 'gamepass') chain.ownership = prev;
    }
    if (!chain.gamertag) chain.gamertag = String(acc.gamertag || '');
    Object.assign(acc, chain);
    saveConfigNow();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
function upsertOnline(acc) {
  const list = accountList();
  const i = list.findIndex(a => a.type === acc.type && a.uuid === acc.uuid);
  if (i >= 0) list[i] = Object.assign(list[i], acc); else list.push(acc);
  config.activeAccount = acc.name;
  config.username = acc.name;
  saveConfigNow();
}
/* 在线账户列表脱敏输出（令牌/密码不进渲染进程） */
function accountsPublic() {
  return accountsOut().map(a => {
    const { msRefresh, mcToken, accessToken, clientToken, password, msClientId, ...rest } = a;
    return rest;
  });
}
/* ---------- 默认主流程：内置窗口登录（零配置，和 PCL2 一样的做法）----------
 * 一步到位：开内置窗口 → 截获授权码 → 换令牌 → XBL/XSTS → **购买检查** → 角色档案 → 落账户。
 * 界面 await 这个 invoke 拿最终结果，中间每一步通过 account:ms-progress 事件推给界面打勾。 */
ipcMain.handle('account:ms-web-login', async (_e, p) => {
  msClosePending(); msCloseWebWin();
  const timeout = Math.max(60000, Math.min(900000, Number((p && p.timeoutMs) || 300000)));
  const started = Date.now();
  try {
    msStep(1, '正在打开微软官方登录页…');
    const code = await msWebLogin(timeout);
    msStep(1, '登录完成，正在处理…');
    const tok = await msLiveExchange(MS_OFFICIAL_CLIENT_ID, code);
    const chain = await msChainFromToken(tok.access_token, tok.refresh_token, { onStep: msStep });
    upsertOnline(Object.assign({ type: 'ms', skin: null, model: 'classic', msClientId: MS_OFFICIAL_CLIENT_ID, msFlow: 'live' }, chain));
    msStep(0, '');
    logLine('[msauth] 登录成功：' + chain.name + '（' + chain.ownership +
      (chain.gamertag ? ' · ' + chain.gamertag : '') + ' · ' + (Date.now() - started) + 'ms）');
    return {
      ok: true, accounts: accountsPublic(), active: activeName(),
      name: chain.name, ownership: chain.ownership, gamertag: chain.gamertag
    };
  } catch (e) {
    msStep(0, '');
    const msg = (e && e.message) || String(e);
    const canceled = /取消/.test(msg);
    /* 网络类失败：顺手跑一次连通性自检，把「网络不通 / 只代理了一部分」当场说清楚 ——
       否则玩家只看到一句 “fetch failed”，既不知道该找谁，我们也拿不到有用信息。
       用户自己没登完（等待超时）不算，不必再等 6 秒探测。 */
    let netAdvice = '', netResults = null, netVia = '';
    if (!canceled && netErrLike(msg) && !/等待超时|已取消/.test(msg)) {
      try {
        msStep(0, '登录没成功，正在检查网络…');
        const pair = await Promise.all([netProxyVia(), msNetProbeAll(6000)]);
        netVia = pair[0]; netResults = pair[1];
        netAdvice = msNetAdviceFrom(netResults, netVia);
      } catch (_) {}
      msStep(0, '');
    }
    logLine('[msauth] 登录未完成：' + msg + (netAdvice ? ' · ' + netAdvice : ''));
    return { ok: false, error: msg, netAdvice: netAdvice, netResults: netResults, netVia: netVia, canceled: canceled };
  } finally { msCloseWebWin(); }
});
ipcMain.handle('account:ms-web-cancel', () => { msCloseWebWin(); msClosePending(); return { ok: true }; });

/* 微软登录连通性自检：并行探一遍这条链路上要用到的服务，回「哪个通 / 哪个不通 / 走没走系统代理」。
   玩家报「登录不了」时先点这个，能当场把「网络/代理问题」和「账号问题」分开。 */
ipcMain.handle('account:ms-net-check', async () => {
  const t0 = Date.now();
  const pair = await Promise.all([netProxyVia(), msNetProbeAll(6000)]);
  const via = pair[0], results = pair[1];
  const advice = msNetAdviceFrom(results, via) ||
    '这条链路上的服务都连得上 —— 网络没问题，问题多半在账号本身（未购买 Java 版 / 儿童账户 / 地区限制等），下面那行错误信息就是微软的原话。';
  try {
    logLine('[msauth] 网络自检：' + results.map(r => r.name + (r.ok ? '✓' : '✗')).join(' ') +
      ' · via=' + via + ' · ' + (Date.now() - t0) + 'ms');
  } catch (_) {}
  return { ok: results.every(r => r.ok), via: via, tookMs: Date.now() - t0, results: results, advice: advice };
});

/* ---------- 备用流程：系统浏览器回调（自建 Azure 应用）---------- */
/* 第一步：起一次性回调服务器 + 拉起系统浏览器。界面拿到返回后显示「已打开浏览器，请完成登录」。 */
ipcMain.handle('account:ms-login-start', async (_e, p) => {
  const r = msResolveClientId(p);
  if (!r.id) return { ok: false, needId: true, error: '尚未配置应用 ID：请在下面「高级」里填入你自己的 Azure 应用 ID' };
  msClosePending();
  try {
    const L = await msStartLoopback(r.id);
    msPending = L;
    const authUrl = msAuthUrl(r.id, L);
    /* 自测进程绝不真的弹浏览器（会打断跑测试的人，也会污染他的桌面） */
    if (!SMOKE_EARLY) shell.openExternal(authUrl).catch(() => {});
    logLine('[msauth] 授权页已' + (SMOKE_EARLY ? '（自测：未真正打开）' : '在浏览器打开') +
      ' · 回调 127.0.0.1:' + L.port + ' · ' + (r.custom ? '自定义' : '内置') + '应用 ID');
    return { ok: true, authUrl: authUrl, port: L.port, redirectUri: L.redirectUri, builtin: !r.custom };
  } catch (e) {
    msClosePending();
    return { ok: false, error: '无法开始登录：' + ((e && e.message) || e) };
  }
});
/* 第二步：等浏览器回调 → 授权码换令牌 → XBL/XSTS/Minecraft → 写入账户 */
ipcMain.handle('account:ms-login-wait', async (_e, p) => {
  const r = msResolveClientId(p);
  if (!msPending || !r.id) { msClosePending(); return { ok: false, error: '登录流程已失效，请重新点「微软登录」' }; }
  const L = msPending;
  try {
    const code = await L.codePromise;
    const tok = await msExchangeCode(r.id, code, L.redirectUri, L.verifier);
    const chain = await msChainFromToken(tok.access_token, tok.refresh_token);
    upsertOnline(Object.assign({ type: 'ms', skin: null, model: 'classic', msClientId: r.id }, chain));
    logLine('[msauth] 登录成功：' + chain.name);
    return { ok: true, accounts: accountsPublic(), active: activeName() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally { msClosePending(); }
});
ipcMain.handle('account:ms-login-cancel', () => { msClosePending(); return { ok: true }; });
/* 界面用它判断高级流程是否可用（默认流程永远可用，不依赖任何配置） */
ipcMain.handle('account:ms-app-info', () => {
  const builtin = msIdOk(MS_CLIENT_ID), custom = msIdOk(config.msClientId);
  return {
    ok: true, builtin: builtin, custom: custom, ready: true,
    aadReady: builtin || custom,             /* 系统浏览器回调 / 设备码流程需要自建应用 ID */
    defaultFlow: 'live', officialClientId: MS_OFFICIAL_CLIENT_ID
  };
});

/* ---------- 备用流程：设备码（浏览器打不开 / 需要把代码给别人代登录时用） ---------- */
ipcMain.handle('account:ms-start', async (_e, p) => {
  const r = msResolveClientId(p);
  if (!r.id) return { ok: false, needId: true, error: '尚未配置应用 ID' };
  if (r.custom) { config.msClientId = r.id; saveConfigNow(); }
  try {
    const res = await netFetch(MS_OAUTH + '/devicecode', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: r.id, scope: MS_SCOPE })
    }, 20000);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.device_code) return { ok: false, error: j.error_description || '获取设备码失败 (HTTP ' + res.status + ')' };
    return { ok: true, deviceCode: j.device_code, userCode: j.user_code, verifyUrl: j.verification_uri, interval: j.interval || 5, expires: j.expires_in || 900 };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('account:ms-poll', async (_e, p) => {
  const r = msResolveClientId(p);
  if (!r.id) return { ok: false, error: '应用 ID 无效' };
  try {
    const res = await netFetch(MS_OAUTH + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: r.id, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: String(p.deviceCode || '') })
    }, 20000);
    const j = await res.json().catch(() => ({}));
    if (j.error === 'authorization_pending') return { ok: true, pending: true };
    if (j.error === 'slow_down') return { ok: true, pending: true, slow: true };
    if (j.error) return { ok: false, error: j.error_description || j.error };
    const chain = await msChainFromToken(j.access_token, j.refresh_token);
    upsertOnline(Object.assign({ type: 'ms', skin: null, model: 'classic', msClientId: r.id }, chain));
    return { ok: true, accounts: accountsPublic(), active: activeName() };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* 微软登录（浏览器回调 OAuth）离线自测 —— LMC_SMOKE_MS=1 触发。
   全程不联网、不弹浏览器；用一个真实的本地 HTTP 请求模拟「浏览器回调」，
   把整条回调路径（合法码 / state 不符 / 用户取消 / 超时 / 无关请求）都真的走一遍。 */
async function msOauthSelfTest() {
  const lines = []; let fail = 0;
  const ok = (c, name, detail) => { lines.push((c ? 'PASS ' : 'FAIL ') + name + (detail ? '  · ' + detail : '')); if (!c) fail++; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const closeL = (L) => {
    try { clearTimeout(L.timer); } catch (_) {}
    try { L.server.close(); } catch (_) {}
    try { if (L.server6) L.server6.close(); } catch (_) {}
  };
  const CID = '11111111-2222-3333-4444-555555555555';
  try {
    /* ① PKCE：校验值必须是 sha256(verifier) 的 base64url 无填充形式 */
    const verifier = msB64u(crypto.randomBytes(32));
    const challenge = msB64u(crypto.createHash('sha256').update(verifier, 'utf8').digest());
    ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), 'MS1 PKCE code_verifier 合规（43 字符 base64url）', verifier.length + ' 字符');
    ok(/^[A-Za-z0-9_-]{43}$/.test(challenge), 'MS2 code_challenge 为 base64url 无填充', challenge.length + ' 字符');
    const indep = crypto.createHash('sha256').update(verifier, 'utf8').digest()
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ok(indep === challenge, 'MS3 code_challenge 独立复算一致（确认是 S256 而非 plain）');

    /* ② 回调服务器：只监听环回、端口随机、redirect_uri 形状正确 */
    const L1 = await msStartLoopback(CID, 60000);
    const addr = L1.server.address();
    ok(addr.address === '127.0.0.1', 'MS4 回调服务器只绑定 127.0.0.1（不对局域网暴露）', addr.address);
    ok(addr.port > 0 && addr.port < 65536, 'MS5 端口由系统随机分配', 'port=' + addr.port);
    ok(L1.redirectUri === 'http://localhost:' + addr.port + '/', 'MS6 redirect_uri 形状正确', L1.redirectUri);
    ok(L1.server6 === null || L1.server6.address().address === '::1', 'MS7 IPv6 环回为可选增强（只绑 ::1，绑不上不影响登录）',
      L1.server6 ? '已同时监听 [::1]' : '本机未启用 IPv6 环回，仅 IPv4');
    ok(/^[A-Za-z0-9_-]{22}$/.test(L1.state), 'MS8 state 随机生成（防跨站回调注入）', L1.state.length + ' 字符');

    /* ③ 授权 URL：必须是微软官方、走授权码 + PKCE */
    const u = new URL(msAuthUrl(CID, L1));
    ok(u.host === 'login.microsoftonline.com' && u.pathname.indexOf('/consumers/oauth2/v2.0/authorize') === 0,
      'MS9 授权页为微软官方域名（不是第三方页面）', u.host + u.pathname);
    ok(u.searchParams.get('client_id') === CID, 'MS10 授权 URL 带上应用 ID');
    ok(u.searchParams.get('response_type') === 'code', 'MS11 使用授权码流程（浏览器回调）');
    ok(u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('code_challenge') === L1.challenge,
      'MS12 授权 URL 携带 PKCE 挑战值');
    ok(u.searchParams.get('redirect_uri') === L1.redirectUri, 'MS13 redirect_uri 指向本机一次性回调');
    const sc = u.searchParams.get('scope') || '';
    ok(/XboxLive\.signin/.test(sc) && /offline_access/.test(sc), 'MS14 权限含 XboxLive.signin + offline_access', sc);
    ok(u.searchParams.get('state') === L1.state && u.searchParams.get('prompt') === 'select_account',
      'MS15 带 state，且每次都让用户自己选账户');
    ok(!/client_secret/.test(u.search) && !u.searchParams.get('client_secret'),
      'MS16 公共客户端不携带任何密钥（可安全公开分发）');

    /* ④ 无关请求（浏览器会自动请求 favicon.ico）：回提示页，绝不判定登录结果 */
    let settled1 = '';
    L1.codePromise.then(() => { settled1 = 'ok'; }, () => { settled1 = 'err'; });
    const r0 = await fetch('http://127.0.0.1:' + addr.port + '/favicon.ico');
    ok(r0.status === 200 && /回调地址/.test(await r0.text()), 'MS17 无关请求返回提示页而非登录结果');
    await sleep(80);
    ok(settled1 === '', 'MS18 无关请求不会让登录流程提前结束（仍在等真实回调）');

    /* ⑤ state 不匹配 → 必须拒绝（防把别处的授权码灌进来） */
    const r1 = await fetch('http://127.0.0.1:' + addr.port + '/?code=STOLEN&state=not-the-one');
    ok(/校验失败/.test(await r1.text()), 'MS19 state 不匹配时页面明确提示');
    const e1 = await L1.codePromise.then(() => '', (e) => String((e && e.message) || e));
    ok(/state/.test(e1), 'MS20 state 不匹配时拒绝登录', e1);
    closeL(L1);

    /* ⑥ 合法回调 → 解出授权码 */
    const L2 = await msStartLoopback(CID, 60000);
    const p2 = L2.codePromise;
    const r2 = await fetch('http://127.0.0.1:' + L2.port + '/?code=THE-CODE&state=' + encodeURIComponent(L2.state));
    ok(r2.status === 200 && /登录成功/.test(await r2.text()), 'MS21 合法回调返回「登录成功」页');
    ok((await p2) === 'THE-CODE', 'MS22 授权码被正确取出，交给后续换令牌');
    closeL(L2);

    /* ⑦ 用户在授权页取消 / 微软报错 → 把真实原因带回来 */
    const L3 = await msStartLoopback(CID, 60000);
    const p3 = L3.codePromise;
    await fetch('http://127.0.0.1:' + L3.port + '/?error=access_denied&error_description=' + encodeURIComponent('用户取消了授权'));
    const e3 = await p3.then(() => '', (e) => String((e && e.message) || e));
    ok(e3 === '用户取消了授权', 'MS23 授权失败时回传微软的原始原因', e3);
    closeL(L3);

    /* ⑧ 超时兜底：用户一直不完成授权 → 自己收摊，不能一直挂着 */
    const L4 = await msStartLoopback(CID, 400);
    const e4 = await L4.codePromise.then(() => '', (e) => String((e && e.message) || e));
    ok(/超时/.test(e4), 'MS24 等待超时后自动失败（不无限挂着）', e4);
    closeL(L4);

    /* ⑨ 结果页不能把微软返回的文本当 HTML 渲染（防注入） */
    const hz = msResultHtml(false, '<script>alert(1)</script>');
    ok(hz.indexOf('<script>') < 0 && /&lt;script&gt;/.test(hz), 'MS25 结果页对错误文本做 HTML 转义');

    /* ⑩ 应用 ID 取值优先级：手填 > 内置 > 历史保存值；续期则必须用「登录时那个」 */
    const savedId = config.msClientId;
    const SAVED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const TYPED = '12345678-1234-1234-1234-123456789012';
    config.msClientId = SAVED;
    ok(msResolveClientId({ clientId: TYPED }).id === TYPED, 'MS26 界面手填的应用 ID 优先使用（压过内置与历史值）');
    const badTyped = msResolveClientId({ clientId: '乱填的' });
    ok(msIdOk(badTyped.id) && badTyped.id !== '乱填的', 'MS27 手填内容非法时不会被拿去用，回退到合法 ID', badTyped.id);
    const noTyped = msResolveClientId({});
    ok(msIdOk(noTyped.id), 'MS28 未手填时仍能给出合法 ID（内置或历史值）', noTyped.id);
    ok(msClientIdForRefresh({ msClientId: TYPED }) === TYPED,
      'MS29 静默续期优先用账户上记的应用 ID（刷新令牌与应用绑定）');
    ok(msClientIdForRefresh(null) === SAVED, 'MS30 账户上没记时才回退到历史配置');
    config.msClientId = savedId;
    ok(msIdOk(MS_CLIENT_ID) || String(MS_CLIENT_ID).trim() === '',
      'MS31 可选的自定义应用 ID 状态合法（留空 = 只用内置默认流程）',
      MS_CLIENT_ID ? '已配置 ' + MS_CLIENT_ID : '留空（默认流程不需要它）');

    /* ⑪ 取消 / 结束时：让等待方立刻失败 + 真的关掉监听端口 */
    const L5 = await msStartLoopback(CID, 60000);
    msPending = L5;
    const cancelled = L5.codePromise.then(() => '', (e) => String((e && e.message) || e));
    msClosePending();
    ok(/已取消/.test(await cancelled), 'MS32 取消登录会让等待方立刻失败（不必干等超时）');
    let closed = false;
    try { await fetch('http://127.0.0.1:' + L5.port + '/?code=x&state=y', { signal: AbortSignal.timeout(1500) }); }
    catch (_) { closed = true; }
    ok(closed, 'MS33 取消登录会关闭回调服务器（不留监听端口）');

    /* ⑫ 默认流程（内置窗口登录）：零配置，用官方公共客户端 ID 走 login.live.com */
    ok(msIdOk(MS_OFFICIAL_CLIENT_ID) && MS_OFFICIAL_CLIENT_ID === '00000000402b5328',
      'MS34 默认流程自带官方公共客户端 ID（用户零配置，不用注册任何应用）', MS_OFFICIAL_CLIENT_ID);
    const liveUrl = msLiveAuthUrl('STATE123');
    const q = new URL(liveUrl);
    ok(q.hostname === 'login.live.com', 'MS35 默认流程的授权页是微软官方域名', q.hostname);
    ok(q.searchParams.get('client_id') === MS_OFFICIAL_CLIENT_ID, 'MS36 授权页带上内置客户端 ID');
    ok(q.searchParams.get('redirect_uri') === MS_LIVE_REDIRECT && q.searchParams.get('scope') === MS_LIVE_SCOPE,
      'MS37 回调地址与权限范围符合官方启动器流程', q.searchParams.get('redirect_uri'));
    ok(q.searchParams.get('state') === 'STATE123', 'MS38 授权页带 state（防跨站串单）');

    /* ⑬ 购买检查判定：先拿账户信息，再看买没买 */
    ok(msOwnershipOf(true, true, true) === 'owned', 'MS39 查到购买许可 → owned（已购买）');
    ok(msOwnershipOf(true, false, true) === 'gamepass',
      'MS40 没查到购买记录但角色档案在 → gamepass（Game Pass 等权益，能玩）');
    ok(msOwnershipOf(true, false, false) === 'none', 'MS41 没记录又没角色 → none（确实没买）');
    ok(msOwnershipOf(false, false, false) === 'unknown',
      'MS42 许可接口没查成功 → unknown（不误判成「没买」）');
    const entProbe = { known: true, owned: false, items: [] };
    ok(msOwnershipOf(entProbe.known, entProbe.owned, true) === 'gamepass',
      'MS43 entitlements 的 items 为空时不会被当成「有正版」', 'items=' + JSON.stringify(entProbe.items));

    /* ⑭ XSTS 常见错误码要给中文人话，不能甩原始码 */
    for (const [code, kw] of [[2148916233, 'Xbox'], [2148916238, '儿童'], [2148916227, '封禁'], [2148916235, '地区']]) {
      const txt = msXErrText(code);
      ok(txt.indexOf(String(code)) < 0 && txt.indexOf(kw) >= 0,
        'MS44 XErr ' + code + ' 映射为中文提示（含「' + kw + '」）', txt);
    }

    /* ⑮ JWT 载荷解析（用来展示 XUID） */
    const fakePayload = msB64u(Buffer.from(JSON.stringify({ xui: [{ uhs: 'u', xid: '2535416586892404', agg: 'Adult' }] }), 'utf8'));
    ok(String((msJwtPayload('aaa.' + fakePayload + '.ccc').xui || [{}])[0].xid) === '2535416586892404',
      'MS45 能从 XSTS 令牌里解出 XUID（展示用）');
    ok(JSON.stringify(msJwtPayload('不是令牌')) === '{}', 'MS46 令牌格式异常时安全返回空对象（不抛错）');

    /* ⑯ 静默续期端点选择：两条流程的刷新令牌不通用 */
    ok(msRefreshTarget({ msFlow: 'live' }).url.indexOf('login.live.com') > 0 &&
      msRefreshTarget({ msFlow: 'live' }).scope === MS_LIVE_SCOPE,
      'MS47 内置流程的刷新走 login.live.com（不能拿去 AAD 端点换）');
    ok(msRefreshTarget({ msFlow: 'aad' }).url.indexOf('login.microsoftonline.com') > 0,
      'MS48 自建应用流程的刷新走 login.microsoftonline.com');
    ok(msRefreshTarget(null).live === true, 'MS49 老账户没记流程时默认按内置流程续期（向后兼容）');

    /* ⑰ 内置登录窗口：自测下不开真窗口，但取消语义与真实一致 */
    const winP = msWebLogin(5000).then(() => 'ok', (e) => String((e && e.message) || e));
    await sleep(80);
    ok(msWin === null, 'MS50 自测模式不会真的弹出登录窗口');
    msCloseWebWin();
    ok(/已取消/.test(await winP), 'MS51 取消内置登录窗口会让等待方立刻失败');
    ok(msWinCancel === null, 'MS52 取消后清理掉挂起的取消钩子（不留状态）');

    /* ⑱ 回调 URL 识别（纯函数）：只认官方回调地址，别被登录页/其它域名带偏 */
    ok((msGrabAuthCode(MS_LIVE_REDIRECT + '?code=ABC123', 'S') || {}).code === 'ABC123',
      'MS53 识别出回调地址里的授权码');
    ok((msGrabAuthCode(MS_LIVE_REDIRECT + '?code=ABC&state=OTHER', 'S') || {}).error !== undefined,
      'MS54 state 不符时拒绝（防跨站串单）');
    const denied = msGrabAuthCode(MS_LIVE_REDIRECT + '?error=access_denied&error_description=' + encodeURIComponent('用户取消授权'), 'S');
    ok(!!denied && denied.error === '用户取消授权',
      'MS55 微软返回 error 时如实转达原因（用户取消授权）', (denied && denied.error) || '(未识别)');
    ok(msGrabAuthCode(MS_LIVE_BASE + '/oauth20_authorize.srf?client_id=x', 'S') === null,
      'MS56 授权页本身不算回调（不会误判成登录成功）');
    ok(msGrabAuthCode('https://login.live.com/favicon.ico', 'S') === null,
      'MS57 其它路径（favicon 等）不算回调');
    ok(msGrabAuthCode('https://example.com/oauth20_desktop.srf?code=X', 'S') === null,
      'MS58 非官方域名的同路径地址不算回调（防钓鱼）');
    ok(msGrabAuthCode('这不是一个网址', 'S') === null, 'MS59 非法 URL 安全返回 null（不抛错）');
    ok(msGrabAuthCode(MS_LIVE_REDIRECT, 'S') === null, 'MS60 回调页但没带 code 时继续等待');

    /* ⑲ 网络层：登录「连不上」时能不能说人话，全靠这几条（纯函数，离线可测） */
    ok(typeof netFetch === 'function', 'MS61 主进程有统一的网络出口 netFetch（走 Chromium 栈，跟随系统代理）');
    ok(MS_NET_TARGETS.length === 5 &&
       MS_NET_TARGETS.some(t => t.url.indexOf('login.live.com') > 0) &&
       MS_NET_TARGETS.some(t => t.url.indexOf('xsts.auth.xboxlive.com') > 0) &&
       MS_NET_TARGETS.some(t => t.url.indexOf('api.minecraftservices.com') > 0),
      'MS62 自检覆盖登录链路的 5 个服务（登录页 / Xbox / XSTS / Minecraft）', 'n=' + MS_NET_TARGETS.length);
    ok(msNetAdviceFrom([{ ok: true, name: 'A' }, { ok: true, name: 'B' }], 'DIRECT') === '',
      'MS63 服务全通时自检不给出多余提示');
    const allFail = msNetAdviceFrom([{ ok: false, name: '微软登录页' }, { ok: false, name: 'Minecraft 服务' }], 'DIRECT');
    ok(/全部连不上/.test(allFail) && /直连/.test(allFail),
      'MS64 全部不通 → 指出「全部连不上」并说明当前是直连（没走系统代理）', allFail.slice(0, 46));
    const partFail = msNetAdviceFrom([{ ok: true, name: '微软登录页' }, { ok: false, name: 'Minecraft 服务' }], 'PROXY 127.0.0.1:7890');
    ok(/只代理了部分流量/.test(partFail) && /走代理/.test(partFail),
      'MS65 只有部分不通 + 走了代理 → 提示「代理只代理了一部分流量」', partFail.slice(0, 46));
    ok(netErrLike('fetch failed') && netErrLike('网络请求超时（20 秒未响应）') &&
       !netErrLike('该微软账户没有 Minecraft 正版'),
      'MS66 只有网络类错误才触发自动自检（「没买游戏」这类账号错误不误判）');

    /* 护栏：登录链路必须**全部**走 netFetch —— 裸 fetch 不读系统代理，开了代理/VPN 的用户会
       「登录页能打开、换令牌却失败」，这正是玩家报「微软登录不了」最常见的原因。 */
    let selfSrc = '';
    try { selfSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'); } catch (_) {}
    if (selfSrc) {
      const a = selfSrc.indexOf('const MS_OFFICIAL_CLIENT_ID');
      const b = selfSrc.indexOf("ipcMain.handle('account:ms-net-check'");
      const region = (a >= 0 && b > a) ? selfSrc.slice(a, b) : '';
      const bare = (region.match(/await fetch\(/g) || []).length;
      ok(region.length > 1000 && bare === 0,
        'MS67 微软登录链路全部走 netFetch（裸 fetch 会在代理环境下登录失败）', '裸 fetch ' + bare + ' 处');
    }
  } catch (e) {
    lines.push('FAIL MS0 自测异常: ' + ((e && e.stack) || e)); fail++;
  }
  try { msClosePending(); } catch (_) {}
  return { lines: lines, fail: fail };
}

/* 微软登录「内置窗口」的离线集成自测 —— LMC_SMOKE_MS_WEB=1 触发。
 * 真的创建一个 BrowserWindow，但把授权页换成本地页面（它自己跳到 oauth20_desktop.srf），
 * 全程不联网、窗口不显示 —— 用来验证「窗口能开 → 跳转能被截获 → 授权码取得出 → 窗口自动关」
 * 这条只有在真窗口里才会暴露问题的链路（纯函数测试覆盖不到）。 */
async function msWindowSelfTest() {
  const lines = []; let fail = 0;
  const ok = (c, name, detail) => { lines.push((c ? 'PASS ' : 'FAIL ') + name + (detail ? '  · ' + detail : '')); if (!c) fail++; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pageFor = (target) => 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + target + '"><p>redirect</p>');
  const savedPage = process.env.LMC_SMOKE_MS_TEST_PAGE;
  const savedReal = process.env.LMC_SMOKE_MS_WEB_REAL;
  process.env.LMC_SMOKE_MS_WEB_REAL = '1';   /* 允许真开窗口（但用本地页面，且保持隐藏） */
  try {
    /* ① 正常路径：本地页面跳转到官方回调地址 → 应立刻拿到授权码 */
    process.env.LMC_SMOKE_MS_TEST_PAGE = pageFor(MS_LIVE_REDIRECT + '?code=TESTCODE123');
    let got = '', err = '';
    const t0 = Date.now();
    try { got = await msWebLogin(15000); } catch (e) { err = String((e && e.message) || e); }
    const cost = Date.now() - t0;
    ok(got === 'TESTCODE123', 'MW1 内置登录窗口能真的截获回调里的授权码',
      got ? ('code=' + got) : ('错误=' + err));
    ok(!msWin, 'MW2 拿到授权码后登录窗口自动关闭（不留悬浮窗）');
    ok(cost < 12000, 'MW3 截获是即时的（不是一直等到超时）', cost + 'ms');

    /* ② 微软拒绝授权（用户点了取消）→ 应立刻以错误结束，而不是继续等 */
    process.env.LMC_SMOKE_MS_TEST_PAGE = pageFor(MS_LIVE_REDIRECT + '?error=access_denied&error_description=cancelled');
    let err2 = '';
    const t1 = Date.now();
    try { await msWebLogin(15000); } catch (e) { err2 = String((e && e.message) || e); }
    ok(/cancelled/.test(err2), 'MW4 用户取消授权时窗口立刻收摊并转达原因', err2);
    ok(Date.now() - t1 < 12000, 'MW5 失败同样不会干等到超时', (Date.now() - t1) + 'ms');

    /* ③ 用户手动关掉登录窗口 = 取消登录 */
    process.env.LMC_SMOKE_MS_TEST_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent('<p>停留在这里，等用户自己关窗</p>');
    const pending = msWebLogin(15000).then(() => 'ok', (e) => String((e && e.message) || e));
    await sleep(600);
    ok(!!msWin, 'MW6 登录窗口确实被创建（等待用户操作）');
    msCloseWebWin();
    ok(/已取消/.test(await pending), 'MW7 关掉登录窗口会让等待方立刻失败（不卡住界面）');
  } catch (e) {
    lines.push('FAIL MW0 自测异常: ' + ((e && e.stack) || e)); fail++;
  } finally {
    if (savedPage === undefined) delete process.env.LMC_SMOKE_MS_TEST_PAGE; else process.env.LMC_SMOKE_MS_TEST_PAGE = savedPage;
    if (savedReal === undefined) delete process.env.LMC_SMOKE_MS_WEB_REAL; else process.env.LMC_SMOKE_MS_WEB_REAL = savedReal;
    try { msCloseWebWin(); } catch (_) {}
  }
  return { lines: lines, fail: fail };
}

/* 第三方外置登录：authlib-injector 协议（LittleSkin 等 Blessing Skin 服务器） */
const AUTHLIB_PRESETS = { littleskin: 'https://littleskin.cn/api/yggdrasil' };
function authlibRoot(url) { return String(url || '').trim().replace(/\/+$/, ''); }
/* 拉取 Yggdrasil 元数据；用户粘了站点首页时自动尝试 /api/yggdrasil 回落 */
async function authlibFetchMeta(root) {
  const try1 = await fetch(root + '/', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }).then(r => r.json()).catch(() => null);
  if (try1 && try1.meta) return { meta: try1, root };
  const root2 = root + '/api/yggdrasil';
  const try2 = await fetch(root2 + '/', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }).then(r => r.json()).catch(() => null);
  if (try2 && try2.meta) return { meta: try2, root: root2 };
  throw new Error('该地址不是有效的 authlib-injector 认证服务器（需 Yggdrasil API 根地址，如 https://littleskin.cn/api/yggdrasil）');
}
ipcMain.handle('account:authlib-detect', async (_e, p) => {
  const root = authlibRoot(p && (p.serverUrl || AUTHLIB_PRESETS[p.server]));
  if (!/^https?:\/\//.test(root)) return { ok: false, error: '服务器地址需以 http(s):// 开头' };
  try {
    const m = await authlibFetchMeta(root);
    return { ok: true, serverName: (m.meta.meta.serverName || m.root) + '', root: m.root };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('account:authlib-login', async (_e, p) => {
  const root = authlibRoot(p && (p.serverUrl || AUTHLIB_PRESETS[p.server]));
  if (!/^https?:\/\//.test(root)) return { ok: false, error: '服务器地址无效' };
  const user = String(p && p.username || '').trim(), pass = String(p && p.password || '');
  if (!user || !pass) return { ok: false, error: '请输入账号（邮箱或角色名）和密码' };
  try {
    const m = await authlibFetchMeta(root);
    const api = m.root;
    const res = await fetch(api + '/authserver/authenticate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: user, password: pass, agent: { name: 'Minecraft', version: 1 } }),
      signal: AbortSignal.timeout(20000)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.accessToken) return { ok: false, error: (j.errorMessage || '登录失败 (HTTP ' + res.status + ')') };
    if (!j.selectedProfile) {
      const first = j.availableProfiles && j.availableProfiles[0];
      if (!first) return { ok: false, error: '该账号下没有 Minecraft 角色，请先在服务器官网创建' };
      /* 多角色时默认选第一个 */
      j.selectedProfile = first;
    }
    upsertOnline({
      type: 'authlib', name: j.selectedProfile.name, uuid: j.selectedProfile.id,
      serverUrl: api, serverMeta: m.meta, skin: null, model: 'classic',
      accessToken: j.accessToken, clientToken: j.clientToken || ''
    });
    return { ok: true, accounts: accountsPublic(), active: activeName() };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 外置账户令牌静默续期（启动时调用；失败不阻断，旧令牌可能仍有效） */
async function authlibRefreshAcc(acc) {
  const root = authlibRoot(acc.serverUrl);
  const res = await fetch(root + '/authserver/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: acc.accessToken, selectedProfile: { id: acc.uuid, name: acc.name } }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await res.json().catch(() => null);
  if (res.ok && j && j.accessToken) { acc.accessToken = j.accessToken; acc.clientToken = j.clientToken || acc.clientToken; saveConfigNow(); }
}

/* ---------------- 离线皮肤注入：本地 Yggdrasil 兼容服务 + authlib-injector ----------------
 * 依据 authlib-injector 的公开接口规范（Yggdrasil 兼容服务端）独立实现，JavaScript/Node 编写，
 * 未复制任何第三方源代码；设计思路上参考了同类启动器普遍采用的「本地皮肤服务」做法。
 *
 * 做法：启动前把当前离线账户的皮肤「注册」进一个本地内存注册表（不改磁盘、不留状态），
 *   然后给 JVM 挂 -javaagent:authlib-injector.jar=<本地服务器地址>，
 *   游戏原来的皮肤查询（会话服务 / 批量资料 / 纹理）全部被重定向到这里。
 *
 * 按规范要满足的三件事：
 *   ① RSA 2048 密钥对：元数据里给出 signaturePublickey，textures 属性额外带 RSA-SHA1 签名
 *      ——部分客户端/服务端会校验签名，没有签名时皮肤可能被丢弃（这是早期做法的隐患）。
 *   ② 应答官方 Yggdrasil 路径（authlib-injector 规范定义的接口）：
 *        GET  /sessionserver/session/minecraft/profile/<无横线uuid>  → 单个资料（带皮肤）
 *        POST /api/profiles/minecraft                               → 批量按名字查资料
 *        GET  /textures/<sha256>                                    → 纹理本体
 *   ③ 纹理按内容 sha256 命名 + 强缓存（immutable），天然去重、且不会被当成「动态资源」反复拉。
 *
 * 服务只监听 127.0.0.1 随机端口、只应答上面这几条路径；所有内容都在内存里，
 * 启动器一退出服务就没了，不往用户目录写任何皮肤缓存。 */
const AUTHLIB_JAR = path.join(DATA_DIR, 'authlib-injector.jar');
/* 官方 artifact 源优先，GitHub 直连兜底（下载时再套 gh-proxy 镜像） */
const AUTHLIB_META = 'https://authlib-injector.yushi.moe/artifact/latest.json';

/* 请求头 / 请求体 / 纹理体积上限：服务开在本机回环地址上，加这些闸门是防止
   本机其他程序拿这个随机端口灌数据把启动器内存打满。 */
const SKIN_MAX_TEXTURE_BYTES = 4 * 1024 * 1024;
const SKIN_MAX_BATCH_NAMES = 16;

/* 本地皮肤服务的全部运行态。注册表按 uuid / 名字索引，纹理按 sha256 索引 —— 纯内存。 */
const skinSrvState = {
  srv: null,          // http.Server（未启动为 null）
  port: 0,
  key: null,          // RSA 2048 密钥对（进程内生成一次，退出即弃）
  publicKeyPem: '',   // 元数据里下发的公钥（SubjectPublicKeyInfo PEM）
  profilesByUuid: new Map(),   // 无横线 uuid → { uuid, name, textureValue, textureSignature }
  uuidByName: new Map(),       // 玩家名 → 无横线 uuid
  textures: new Map()          // sha256 → Buffer(PNG)
};
function skinNormalizeUuid(v) {
  const c = String(v || '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(c) ? c : '';
}
/* 生成/复用本次会话的 RSA 密钥对：只在第一次用到皮肤时算一次（RSA 2048 生成约几十毫秒） */
function skinEnsureKey() {
  if (!skinSrvState.key) {
    skinSrvState.key = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    skinSrvState.publicKeyPem = skinSrvState.key.publicKey;
  }
  return skinSrvState.key;
}
/* textures 属性的明文（按规范要求按需带 model 字段）。
   返回的是 **base64**：Yggdrasil 协议里 properties[].value 必须 base64 编码，
   且签名正是对「这个 base64 字符串」做的 —— 两者必须同一份字节，否则验签必失败。 */
function skinTextureValue(uuid, name, textureUrl, model) {
  const skin = model === 'slim' ? { url: textureUrl, metadata: { model: 'slim' } } : { url: textureUrl };
  const plain = JSON.stringify({
    timestamp: Date.now(), profileId: uuid, profileName: name,
    textures: { SKIN: skin }
  });
  return Buffer.from(plain, 'utf8').toString('base64');
}
/* 把当前账户的皮肤注册进内存表，返回可用的 apiRoot（无皮肤时返回 null）
   顺序：校验皮肤是不是合法 PNG → 算 sha256 作为纹理地址 → 建 RSA-SHA1 签名 → 入表。 */
function skinRegisterAccount(acc) {
  if (!acc || !acc.skin) return null;
  const file = path.join(SKINS_DIR, acc.skin);
  let buf = null;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  if (!buf || !buf.length || buf.length > SKIN_MAX_TEXTURE_BYTES) return null;
  /* PNG 签名校验（文件头 89 50 4E 47 …）：只放真正是 PNG 的文件进来 */
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;

  const uuid = offlineUUID(acc.name).replace(/-/g, '').toLowerCase();
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const textureUrl = 'http://127.0.0.1:' + skinSrvState.port + '/textures/' + hash;
  const value = skinTextureValue(uuid, acc.name, textureUrl, acc.model === 'slim' ? 'slim' : 'classic');
  /* RSA-SHA1 签名（Yggdrasil 规范用的就是 SHA1），部分客户端会校验，缺了会被丢弃 */
  const signature = crypto.sign('sha1', Buffer.from(value, 'utf8'), {
    key: skinEnsureKey().privateKey, padding: crypto.constants.RSA_PKCS1_PADDING
  }).toString('base64');

  skinSrvState.profilesByUuid.set(uuid, { uuid, name: acc.name, textureValue: value, textureSignature: signature });
  skinSrvState.uuidByName.set(acc.name.toLowerCase(), uuid);
  skinSrvState.textures.set(hash, buf);
  return uuid;
}
function skinMetadataResponse() {
  return {
    meta: {
      implementationName: 'XLC Offline Skin Service',
      implementationVersion: '1',
      serverName: 'XLC Offline Skin Service',
      'feature.non_email_login': true
    },
    skinDomains: ['127.0.0.1', 'localhost'],
    signaturePublickey: skinSrvState.publicKeyPem
  };
}
function skinProfilePayload(profile, includeSignature) {
  const property = { name: 'textures', value: profile.textureValue };
  if (includeSignature) property.signature = profile.textureSignature;
  return { id: profile.uuid, name: profile.name, properties: [property] };
}
function skinSend(res, code, type, body, cache) {
  const h = { 'Content-Length': Buffer.byteLength(body || '') };
  if (type) h['Content-Type'] = type;
  if (cache) h['Cache-Control'] = cache;
  res.writeHead(code, h);
  res.end(body || '');
}
function skinSendJson(res, code, obj) { skinSend(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
/* 请求分发：只应答规范约定的这几条路径，其余一律 404 */
function skinServe(req, res) {
  let url;
  try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch (_) { return skinSendJson(res, 400, { error: 'xlc-invalid-request' }); }
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '')) return skinSendJson(res, 200, skinMetadataResponse());

    /* 批量按名字查资料（POST JSON 数组，最多 16 个名字） */
    if (req.method === 'POST' && p === '/api/profiles/minecraft') {
      let body = '';
      let tooBig = false;
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const names = JSON.parse(body || '[]');
          if (!Array.isArray(names) || names.length > SKIN_MAX_BATCH_NAMES) return skinSendJson(res, 400, { error: 'xlc-invalid-query' });
          const out = [];
          for (const n of [...new Set(names.map(x => String(x)))]) {
            const u = skinSrvState.uuidByName.get(n.toLowerCase());
            const prof = u && skinSrvState.profilesByUuid.get(u);
            if (prof) out.push({ id: prof.uuid, name: prof.name });
          }
          return skinSendJson(res, 200, out);
        } catch (_) { return skinSendJson(res, 400, { error: 'xlc-invalid-json' }); }
      });
      req.on('error', () => {});
      return;
    }

    /* 单个资料（游戏内皮肤加载走这里）。
       签名默认就给：官方 Yggdrasil 的行为也是「默认带 signature」，
       只有显式 unsigned=true 才是「我要不带签名的那份」——搞反了的话
       会校验签名的客户端会拿不到签名而丢掉皮肤。 */
    const PFX = '/sessionserver/session/minecraft/profile/';
    if (req.method === 'GET' && p.startsWith(PFX)) {
      const uuid = skinNormalizeUuid(p.slice(PFX.length));
      const prof = uuid && skinSrvState.profilesByUuid.get(uuid);
      if (!prof) return skinSend(res, 204, null, '');
      const unsigned = String(url.searchParams.get('unsigned') || '').toLowerCase() === 'true';
      return skinSendJson(res, 200, skinProfilePayload(prof, !unsigned));
    }

    /* 纹理本体：按 sha256 取，一年强缓存（内容寻址，永不变） */
    const TPX = '/textures/';
    if (req.method === 'GET' && p.startsWith(TPX)) {
      const buf = skinSrvState.textures.get(p.slice(TPX.length));
      if (!buf) return skinSend(res, 404, null, '');
      return skinSend(res, 200, 'image/png', buf, 'public, max-age=31536000, immutable');
    }

    return skinSend(res, 404, null, '');
  } catch (_) { try { skinSend(res, 500, null, ''); } catch (_) {} }
}
/* 启动本地皮肤服务（幂等）；已有实例直接复用端口。返回端口号。 */
function startSkinServer() {
  if (skinSrvState.srv) return Promise.resolve(skinSrvState.port);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(skinServe);
    srv.on('error', (e) => { skinSrvState.srv = null; skinSrvState.port = 0; reject(e); });
    srv.listen(0, '127.0.0.1', () => {
      skinSrvState.port = srv.address().port;
      skinSrvState.srv = srv;
      resolve(skinSrvState.port);
    });
  });
}
/* 关停（启动器退出/重启用；测试也靠它复位） */
function stopSkinServer() {
  try { if (skinSrvState.srv) skinSrvState.srv.close(); } catch (_) {}
  skinSrvState.srv = null; skinSrvState.port = 0;
  skinSrvState.profilesByUuid.clear(); skinSrvState.uuidByName.clear(); skinSrvState.textures.clear();
}
async function downloadAuthlibJar() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = AUTHLIB_JAR + '.tmp';
  /* ① 解析具体版本：官方 artifact 源 → GitHub API（镜像） */
  let target = null, sha256 = '';
  try {
    const meta = await (await fetch(AUTHLIB_META, { signal: AbortSignal.timeout(8000) })).json();
    if (meta && meta.artifacts && meta.artifacts.length) {
      const art = meta.artifacts[0];
      target = art.download_url || art.url;          /* 官方源直链 */
      if (meta.checksums && meta.checksums.sha256) sha256 = String(meta.checksums.sha256);
    }
  } catch (_) {}
  if (!target) {
    try {
      const rel = await tcFetchJson('https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest', 8000);
      const asset = (rel && rel.assets || []).find(a => /^authlib-injector-[\d.]+\.jar$/.test(a.name || ''));
      if (asset) target = asset.browser_download_url;
    } catch (_) {}
  }
  if (!target) throw new Error('无法获取组件版本信息');
  /* 若拿的是官方源直链，换算出对应的 GitHub 发布直链（供镜像套用） */
  let ghAsset = target;
  const vm = String(target).match(/authlib-injector-([\d.]+)\.jar$/);
  if (vm && target.includes('yushi.moe')) {
    ghAsset = 'https://github.com/yushijinhun/authlib-injector/releases/download/v' + vm[1] + '/authlib-injector-' + vm[1] + '.jar';
  }
  /* ② 下载：官方源 → GitHub 镜像 → GitHub 直连，两轮 */
  const urls = [target, ...TC_GH_MIRRORS.map(m => m + ghAsset), ghAsset];
  let lastErr = null;
  for (let round = 0; round < 2 && !(fs.existsSync(tmp) && fs.statSync(tmp).size > 100000); round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 1500));
    for (const u of urls) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100000) throw new Error('下载内容不完整');
        if (sha256) {
          const got = crypto.createHash('sha256').update(buf).digest('hex');
          if (got !== sha256) throw new Error('校验和不匹配');
        }
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, AUTHLIB_JAR);
        return;
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('所有源均不可达');
}
/* 启动前准备：当前账户有皮肤才注入，返回 javaagent 参数或 null */
async function ensureSkinLaunch(logLine) {
  const acc = accountList().find(a => a.name === activeName());
  /* 外置登录账户：javaagent 指向认证服务器，皮肤/披风由服务器提供，用真实令牌验证 */
  if (acc && acc.type === 'authlib') {
    let ok = fs.existsSync(AUTHLIB_JAR) && fs.statSync(AUTHLIB_JAR).size > 100000;
    if (!ok) {
      logLine('[XLC] 外置登录组件（authlib-injector）未就绪，正在下载…');
      try { await downloadAuthlibJar(); ok = true; }
      catch (e) { logLine('[XLC] 组件下载失败（' + e.message + '），本次可能无法通过外置验证'); return []; }
    }
    /* 预取服务器元数据（缓存优先，缺失时现拉） */
    let meta = acc.serverMeta;
    if (!meta) {
      try { meta = await fetch(authlibRoot(acc.serverUrl) + '/', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }).then(r => r.json()); acc.serverMeta = meta; saveConfigNow(); }
      catch (_) { meta = null; }
    }
    const args = ['-javaagent:' + AUTHLIB_JAR + '=' + authlibRoot(acc.serverUrl)];
    if (meta) args.push('-Dauthlibinjector.yggdrasil.prefetched=' + Buffer.from(JSON.stringify(meta), 'utf8').toString('base64'));
    logLine('[XLC] 外置登录：' + acc.name + ' @ ' + acc.serverUrl.replace(/^https?:\/\//, ''));
    return args;
  }
  /* 离线账户 + 自定义皮肤：注入本地皮肤服务器（微软正版皮肤由官方服务器提供，无需注入） */
  const cur = activeName();
  const oa = accountList().find(a => a.name === cur && a.type !== 'authlib' && a.skin);
  if (!oa) {
    if (accountList().some(a => a.name === cur && a.type !== 'authlib')) logLine('[XLC] 当前账户「' + cur + '」未设置自定义皮肤，使用默认皮肤');
    return [];
  }
  let ok = fs.existsSync(AUTHLIB_JAR) && fs.statSync(AUTHLIB_JAR).size > 100000;
  if (!ok) {
    logLine('[XLC] 首次使用自定义皮肤：正在下载皮肤组件（约 300KB）…');
    try { await downloadAuthlibJar(); ok = true; }
    catch (e) { logLine('[XLC] 皮肤组件下载失败（' + e.message + '），本次以默认皮肤启动'); return []; }
  }
  const port = await startSkinServer();
  /* 注册进内存表（必须在上面的 port 拿到之后再注册，纹理 URL 里要用端口号） */
  const uuid = skinRegisterAccount(oa);
  if (!uuid) {
    logLine('[XLC] 账户「' + oa.name + '」的皮肤文件不可用（缺失 / 非 PNG / 超限），本次以默认皮肤启动');
    return [];
  }
  /* 预取元数据给 agent，避免游戏启动时再拉一次 —— 元数据里带 signaturePublickey，
     客户端拿它校验 textures 的 RSA-SHA1 签名（authlib-injector 规范要求） */
  const localMeta = Buffer.from(JSON.stringify(skinMetadataResponse()), 'utf8').toString('base64');
  logLine('[XLC] 离线皮肤已注入（本地签名服务）：账户 ' + oa.name +
          '（' + (oa.model === 'slim' ? '苗条' : '经典') + '模型 · uuid ' + uuid.slice(0, 8) + '… · 端口 ' + port + '）');
  return ['-javaagent:' + AUTHLIB_JAR + '=http://127.0.0.1:' + port,
          '-Dauthlibinjector.yggdrasil.prefetched=' + localMeta];
}
/* 启动前解析当前账户在线凭据：ms 令牌过期自动续期；authlib 静默刷新；offline 返回 null */
async function resolveLaunchAccount(logLine) {
  const acc = accountList().find(a => a.name === activeName());
  if (!acc || !acc.type || acc.type === 'offline') return null;
  if (acc.type === 'ms') {
    if (acc.mcToken && Date.now() < (acc.expiresAt || 0) - 120000) return acc;
    if (!acc.msRefresh) throw new Error('微软账户缺少刷新令牌，请在「账户」页重新登录');
    logLine('[XLC] 微软账户令牌已过期，正在自动续期…');
    const r = await msRefreshChain(acc);
    if (!r.ok) throw new Error('微软账户令牌续期失败（' + r.error + '）· 请到「账户」页重新登录');
    logLine('[XLC] 微软账户令牌续期成功');
    return acc;
  }
  if (acc.type === 'authlib') {
    try { await authlibRefreshAcc(acc); } catch (_) {}
    return acc;
  }
  return null;
}
ipcMain.handle('manifest:get', async () => {
  setStatus('获取版本清单…', true);
  try {
    const j = await getManifestInner();
    setStatus('就绪');
    return { ok: true, manifest: j, via: config.source };
  } catch (e) {
    setStatus('就绪');
    return { ok: false, error: e.message };
  }
});
/* 允许通过 loader:probe 查询的加载器白名单（防止渲染层传任意字符串拼进上游 URL） */
const LOADER_PROBE_KEYS = ['Forge', 'Fabric', 'Quilt', 'NeoForge', 'OptiFine'];
/* 查询各模组加载器对某个 MC 版本（含快照 / 预发布版）是否真的提供构建。
   为什么不能让渲染层按 type==='release' 硬判：各加载器规则完全不同，且同一加载器
   对不同版本也不一样（实测 2026-10-04）：
     Fabric   快照也支持（26.4-snapshot-2 → 253 个构建）
     Quilt    26.3-snapshot-1 有 307 个、26.4-snapshot-2 却是 404 —— 只能逐版本问
     Forge    只做正式版，快照返回空数组
     NeoForge 版本号走次版本号（26.1.x/26.2.x/26.3.x），不为快照提供
     OptiFine 只在该版本有发布时才有（26.2 有 1 个预览、26.3 没有）
   注意版本 id 必须原样传给上游（Fabric：26.4-snapshot-2 可用，26.4 是 400）。 */
/* 主进程侧不做任何兼容性结果缓存：每次调用都真实访问上游。
   force 参数由渲染层传入（每次打开安装弹窗 / 切换加载器都会带 true），
   这里显式接收并写入日志，保证「实时同步」这条语义在链路两端都成立，
   也便于排查时从日志确认某次结论到底是不是刚查的。 */
ipcMain.handle('loader:probe', async (_e, kind, gameVer, force) => {
  const k = String(kind || '').trim();
  const v = String(gameVer || '').trim();
  if (!LOADER_PROBE_KEYS.includes(k)) return { ok: false, why: '不支持的加载器: ' + kind };
  if (!v) return { ok: false, why: '缺少游戏版本号' };
  const t0 = Date.now();
  logLine('[loader] 实时查询 ' + k + ' @ ' + v + (force ? '（强制刷新）' : ''));
  try {
    const r = await probeLoaderBuilds(k, v);
    logLine('[loader] ' + k + ' @ ' + v + ' → ' + (r && r.ok ? ('有构建' + (r.builds ? ' ×' + r.builds : '') + (r.loaderVer ? ' · ' + r.loaderVer : '')) : ('无构建 · ' + ((r && r.why) || ''))) + '（' + (Date.now() - t0) + 'ms）');
    return r;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    /* 上游对不存在的版本返回 400/404 —— 这是「确实没有构建」，不是网络故障 */
    const missing = /HTTP\s*(400|404)/.test(msg);
    return { ok: false, why: missing ? (k + ' 尚未提供 ' + v + ' 的构建') : ('构建信息获取失败：' + msg) };
  }
});
/* 加载器「可选版本」列表（界面「选择版本」下拉用）。
   与 loader:probe 的分工：probe 回答「这个加载器在这个 MC 版本上能不能用」，
   本接口回答「能用的话，具体能装哪些版本」，两者数据源一致但用途不同。 */
ipcMain.handle('loader:builds', async (_e, kind, gameVer) => {
  const k = String(kind || '').trim();
  const v = String(gameVer || '').trim();
  if (!LOADER_PROBE_KEYS.includes(k)) return { ok: false, why: '不支持的加载器: ' + kind };
  if (!v) return { ok: false, why: '缺少游戏版本号' };
  const t0 = Date.now();
  try {
    const r = await loaderBuildsOf(k, v);
    logLine('[loader] 版本列表 ' + k + ' @ ' + v + ' → ' + (r && r.ok ? (r.list.length + ' 个可选 · 最新 ' + r.latest) : ('失败 · ' + ((r && r.why) || (r && r.error) || ''))) + '（' + (Date.now() - t0) + 'ms）');
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
/* 把 OptiFine 以 mod 形式装进指定实例（供界面 / 测试调用）。
   instName 省略时自动找 Forge/NeoForge 实例，找不到则自动装 NeoForge。 */
ipcMain.handle('optifine:asMod', async (_e, mcVer, instName) => {
  const v = String(mcVer || '').trim();
  if (!v) return { ok: false, error: '缺少游戏版本号' };
  try {
    let carrier = await findForgeLikeInstance(String(instName || '').trim() || null);
    if (!carrier) {
      const name = sanitizeVersionId(String(instName || '') || (v + '-neoforge-OptiFine'));
      setStatus('OptiFine 需要先装 NeoForge，正在自动安装…', true);
      await installNeoForge(v, name);
      carrier = { name, loader: 'NeoForge' };
    }
    const r = await optifineDropAsMod(v, carrier.name);
    return Object.assign({ ok: true, instance: carrier.name, loader: carrier.loader }, r);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
/* 带网络重试的取数：上游偶发失败时如果不重试，界面会把「确实没有构建」误报成
   「网络不可达」，用户看到的结论就错了。只对网络错误重试，HTTP 400/404 直接返回。 */
/* 带超时的 JSON 重试。
   必须带超时：fetchBuf 本身不设超时，遇到被墙/黑洞的源（NeoForge 官方源在国内常见）
   会一直挂到浏览器默认超时（可长达 1~2 分钟），把「加载器检测」整体拖死。
   默认 6s 一档，最多 2 次尝试，两次之间只等 250ms（要快，宁可报网络不可达再让用户重试）。 */
async function fetchJsonRetry(url, attempts, timeoutMs) {
  const n = attempts || 2;
  const ms = timeoutMs || 6000;
  let lastErr = null;
  for (let i = 0; i < n; i++) {
    try { return await fetchJsonT(url, ms); } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || String(e);
      /* 400/404 = 上游明确「没有这个版本」，不是网络问题，立刻返回别浪费时间重试 */
      if (/HTTP\s*(400|404)/.test(msg)) break;
      if (i < n - 1) await new Promise(r => setTimeout(r, 250));
    }
  }
  throw lastErr;
}
/* 多个候选源竞速：谁先成功用谁，全失败抛最后一个错误。
   用于「主源 + 镜像」并行的场景 —— 并行比「主源超时后再试镜像」快一整个超时周期。 */
async function fetchJsonRace(urls, timeoutMs) {
  const ms = timeoutMs || 6000;
  const tries = urls.map(u => fetchJsonT(u, ms));
  try {
    return await Promise.any(tries);
  } catch (e) {
    /* Promise.any 的 AggregateError：优先抛出「非网络类」错误（HTTP 404 等更接近真相） */
    const errs = (e && e.errors) || [];
    const http = errs.find(x => /HTTP\s*(400|404)/.test((x && x.message) || ''));
    throw http || errs[0] || e;
  }
}
/* 各加载器的真实构建查询。返回 { ok, builds, loaderVer, preview?, why } */
async function probeLoaderBuilds(kind, v) {
  if (kind === 'Fabric' || kind === 'Quilt') {
    /* Fabric：官方源 + BMCLAPI 镜像并行竞速（镜像更快，谁先回用谁）。
       Quilt：没有可用镜像（BMCLAPI 不提供 quilt-meta），且官方源 meta.quiltmc.org
       实测极慢/常超时 —— 单独给短超时，超时即判「查询失败」（不谎报「无构建」）。 */
    if (kind === 'Fabric') {
      const urls = [
        'https://meta.fabricmc.net/v2/versions/loader/' + encodeURIComponent(v),
        'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/' + encodeURIComponent(v)
      ];
      let list = null;
      try { list = await fetchJsonRace(urls, 8000); }
      catch (e) {
        const msg = (e && e.message) || String(e);
        if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'Fabric 尚未提供 ' + v + ' 的构建' };
        throw e;
      }
      if (!Array.isArray(list) || !list.length) return { ok: false, why: 'Fabric 尚未提供 ' + v + ' 的构建' };
      return { ok: true, builds: list.length, loaderVer: (list[0] && list[0].loader && list[0].loader.version) || '' };
    }
    /* Quilt 没有可用镜像（BMCLAPI 的 quilt-meta/quilt 都是 404，maven 也只 404）。
       官方 meta.quiltmc.org 实测 22~25s 才回（有时更久），是全链路最慢的一环。
       所以：给足 25s 超时（够它回），并且**把「超时」和「确实没有构建」区分开** ——
       以前超时被当成 ok:false，界面上就变成「✗ 不兼容」，这是错的（用户会以为 Quilt 不支持）。 */
    let list = null;
    try {
      list = await fetchJsonRetry('https://meta.quiltmc.org/v3/versions/loader/' + encodeURIComponent(v), 1, 25000);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'Quilt 尚未提供 ' + v + ' 的构建' };
      /* 超时/网络错误：不是「不支持」，而是「查不到」—— 交给界面显示为「查询超时」而不是「不兼容」 */
      return { ok: false, unknown: true, why: 'Quilt 官方源响应超时（该源在国内很慢），请点「刷新」重试', slow: true };
    }
    if (!Array.isArray(list) || !list.length) return { ok: false, why: 'Quilt 尚未提供 ' + v + ' 的构建' };
    return { ok: true, builds: list.length, loaderVer: (list[0] && list[0].loader && list[0].loader.version) || '' };
  }
  if (kind === 'Forge') {
    /* BMCLAPI：返回数组（无构建时是空数组）。官方 promotions 只有「推荐/最新」两个版本，
       不全，所以用 BMCLAPI 的按 MC 版本查询接口。 */
    let list = null;
    try {
      list = await fetchJsonRetry('https://bmclapi2.bangbang93.com/forge/minecraft/' + encodeURIComponent(v));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      /* 400/404 = 上游明确「没有这个版本」，照旧报「尚未提供」 */
      if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'Forge 尚未提供 ' + v + ' 的构建' };
      return { ok: false, unknown: true, slow: true,
        why: 'Forge 构建列表获取超时（BMCLAPI 未在超时内响应），请重新检测' };
    }
    const arr = Array.isArray(list) ? list : [];
    /* forge 条目的 version 有时不带 MC 前缀（26.2 → "65.0.0"），有时带（1.7.10 → "1.7.10-10.13..."） */
    const pick = arr.find(x => x && x.version) || null;
    if (!arr.length) return { ok: false, why: 'Forge 尚未提供 ' + v + ' 的构建' };
    return { ok: true, builds: arr.length, loaderVer: pick ? String(pick.version) : '' };
  }
  if (kind === 'NeoForge') {
    /* NeoForge 的版本号是「MC 次版本号.发布号」：MC 26.2 → 26.2.x。
       1.20.1 是特例（首个 NeoForge 版本，走 net.neoforged:forge 旧坐标）。 */
    const artifact = v.startsWith('1.20.1') ? 'forge' : 'neoforge';
    let nf = null;
    try {
      nf = await neoforgeVersionList(artifact);
    } catch (e) {
      /* 两个源都没在超时内回答 —— 这是「查不到」，不是「确实没有构建」。
         必须标 unknown，否则界面会显示「✗ NeoForge 与 x 不兼容」，把网络问题说成不支持。 */
      return { ok: false, unknown: true, slow: true,
        why: 'NeoForge 版本列表获取超时（官方源与 BMCLAPI 镜像均未在超时内响应）' };
    }
    return neoforgeBuildsOf(nf, v, artifact);
  }
  if (kind === 'OptiFine') {
    /* BMCLAPI 的 OptiFine 清单：条目是 {mcversion, patch, type, filename, forge}
       - 普通构建 filename 形如 OptiFine_1.21.11_HD_U_J8.jar
       - 预览构建形如 preview_OptiFine_26.2_HD_U_K2_pre1.jar → 只有预览也算「有」 */
    let list = null;
    try {
      list = await fetchJsonRetry('https://bmclapi2.bangbang93.com/optifine/versionList');
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'OptiFine 尚未提供 ' + v + ' 的构建' };
      return { ok: false, unknown: true, slow: true,
        why: 'OptiFine 构建列表获取超时（BMCLAPI 未在超时内响应），请重新检测' };
    }
    const arr = Array.isArray(list) ? list : [];
    const hit = arr.filter(x => x && String(x.mcversion) === v);
    if (!hit.length) return { ok: false, why: 'OptiFine 尚未提供 ' + v + ' 的构建' };
    /* 优先正式版（非 preview），没有就退回预览版 */
    const stable = hit.filter(x => !/^preview_/i.test(String(x.filename || '')));
    const pick = stable.length ? stable[0] : hit[0];
    const isPreview = !stable.length;
    return {
      ok: true, builds: hit.length, preview: isPreview,
      loaderVer: (pick && pick.type ? pick.type : '') + (pick && pick.patch ? '_' + pick.patch : '')
    };
  }
  return { ok: false, why: '不支持的加载器: ' + kind };
}
/* 版本号降序比较（只给「版本号就是纯 semver」的加载器用：Quilt）。
 * 规则：① 正式版一律排在预发布版前面 ② 数字段大的在前 ③ 同为预发布时后缀序号大的在前。
 * 为什么必须有它：**Quilt 的 meta 接口返回顺序不是「新 → 旧」**。实测 1.21.4 的前 8 项是
 *   0.20.0-beta.9, 0.20.0-beta.7, 0.20.0-beta.8, 0.20.0-beta.1, 0.20.0-beta.2, **0.24.0**, …
 *   —— 直接拿数组第一项当「最新」得到的是 0.20.0-beta.9，而真正最新的是 0.24.0。
 * 注意别用在 Forge 上：它的版本号形如 1.7.10-10.13.4.1564，`-` 是 MC 前缀分隔符而非
 *   预发布标记，套这个规则会把所有老版本误判成预发布。Forge 按 build 数字排序。 */
function cmpVerDesc(a, b) {
  const P = (s) => {
    const t = String(s);
    const seg = t.split('-');
    return {
      pre: seg.length > 1,
      nums: (seg[0].match(/\d+/g) || []).map(Number),
      preNums: seg.length > 1 ? (seg.slice(1).join('-').match(/\d+/g) || []).map(Number) : [],
      raw: t
    };
  };
  const A = P(a), B = P(b);
  if (A.pre !== B.pre) return A.pre ? 1 : -1;       /* 正式版在前 */
  const n = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < n; i++) {
    const x = A.nums[i] || 0, y = B.nums[i] || 0;
    if (x !== y) return y - x;
  }
  const m = Math.max(A.preNums.length, B.preNums.length);
  for (let i = 0; i < m; i++) {
    const x = A.preNums[i] || 0, y = B.preNums[i] || 0;
    if (x !== y) return y - x;
  }
  return String(B.raw).localeCompare(String(A.raw), undefined, { numeric: true });
}
/* ---------------- 加载器「可选版本」列表（界面「选择版本」下拉的数据源） ----------------
 * 与 probeLoaderBuilds 的分工：探针只回答「有没有 / 有几个」，这里要给出**具体能装哪些版本**。
 * 返回 { ok, kind, mcVer, latest, recommended, list:[{ v, tag }] }：
 *   - list 按「新 → 旧」排好（界面顺序渲染即可，第一项就是默认的最新版）
 *   - tag 只给界面做角标：'最新'，普通版本是空串（「推荐」角标已按用户要求全部移除，2026-10-18）
 *   - v 直接就是安装器要的 build 串，规则与 installXxx 的匹配**完全一致**（能选到就一定装得上）
 * 数据源与探针 / 安装器同一套，不引入新源；上游报 400/404 = 「确实没有构建」，
 * 超时 = 「查不到」（unknown），两者不能混（否则界面会把网络问题说成「不支持」）。 */
async function loaderBuildsOf(kind, mcVer) {
  const v = String(mcVer || '').trim();
  const K = String(kind || '').trim();
  if (!v) return { ok: false, why: '缺少游戏版本号' };
  try {
    /* ---- Fabric / Quilt：meta 的 loader 列表本身就是「某 MC 版本可用的加载器版本」 ---- */
    if (K === 'Fabric' || K === 'Quilt') {
      const isF = K === 'Fabric';
      let raw = null;
      if (isF) {
        /* 官方源 + BMCLAPI 镜像竞速（与探针同一套） */
        try {
          raw = await fetchJsonRace([
            'https://meta.fabricmc.net/v2/versions/loader/' + encodeURIComponent(v),
            'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/' + encodeURIComponent(v)
          ], 8000);
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'Fabric 尚未提供 ' + v + ' 的构建' };
          return { ok: false, unknown: true, slow: true, why: 'Fabric 加载器版本列表获取失败：' + msg };
        }
      } else {
        /* Quilt 没有镜像，官方源国内 20s+ —— 给足 25s，超时判「查不到」而不是「没有」 */
        try {
          raw = await fetchJsonRetry('https://meta.quiltmc.org/v3/versions/loader/' + encodeURIComponent(v), 1, 25000);
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'Quilt 尚未提供 ' + v + ' 的构建' };
          return { ok: false, unknown: true, slow: true, why: 'Quilt 官方源响应超时（该源在国内很慢），请重试' };
        }
      }
      const entries = (Array.isArray(raw) ? raw : []).filter(x => x && x.loader && x.loader.version);
      if (!entries.length) return { ok: false, why: K + ' 尚未提供 ' + v + ' 的构建' };
      /* Quilt 的接口顺序不可靠（见 cmpVerDesc 注释），必须自己按 semver 降序排；
         Fabric 的上游顺序是可靠的新→旧（0.19.5 → 0.19.4 → …），原样保留，
         免得我们自己排反而把上游认的「最新」改掉。 */
      let items = entries.map(x => ({ v: String(x.loader.version), stable: x.loader.stable === true }));
      if (K === 'Quilt') items = items.slice().sort((a, b) => cmpVerDesc(a.v, b.v));
      /* 推荐版本：Fabric 带 stable 标记的那一条；Quilt 没有这个字段 → 取最新的正式版
         （recommended 字段继续返回给数据层，但界面不再标「推荐」角标） */
      const rec = items.find(x => x.stable) || items.find(x => !/-/.test(x.v)) || null;
      const list = items.map((x, i) => ({
        v: x.v,
        tag: i === 0 ? '最新' : ''
      }));
      return { ok: true, kind: K, mcVer: v, latest: list[0].v,
        recommended: rec ? rec.v : '', list };
    }

    /* ---- Forge：BMCLAPI 按 MC 版本查构建 + 官方 promotions 标「推荐 / 最新」 ---- */
    if (K === 'Forge') {
      let raw = null;
      try { raw = await fetchJsonRetry('https://bmclapi2.bangbang93.com/forge/minecraft/' + encodeURIComponent(v)); }
      catch (e) {
        const msg = (e && e.message) || String(e);
        if (/HTTP\s*(400|404)/.test(msg)) return { ok: false, why: 'Forge 尚未提供 ' + v + ' 的构建' };
        return { ok: false, unknown: true, slow: true, why: 'Forge 构建列表获取超时（BMCLAPI 未在超时内响应），请重试' };
      }
      const arr = (Array.isArray(raw) ? raw : []).filter(x => x && x.version);
      if (!arr.length) return { ok: false, why: 'Forge 尚未提供 ' + v + ' 的构建' };
      /* bmclapi 是「旧 → 新」，按 build 号倒序成「新 → 旧」
         （version 有带 MC 前缀的 1.7.10-10.13.4.1564，也有不带的 47.4.23，原样往下传） */
      const sorted = [...arr].sort((a, b) => (b.build || 0) - (a.build || 0));
      /* promotions_slim.json 权威标出「推荐 / 最新」两档（键是 "<mc>-recommended"）；
         recommended 字段继续返回给数据层，但界面不再标「推荐」角标（用户 2026-10-18 定） */
      let recommended = '', newest = '';
      try {
        const pr = await fetchJsonT('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', 8000);
        const p = (pr && pr.promos) || {};
        const hitOf = (suffix) => {
          const b = p[v + '-' + suffix];
          if (!b) return '';
          const x = sorted.find(y => String(y.version).endsWith(String(b)));
          return x ? String(x.version) : '';
        };
        recommended = hitOf('recommended');
        newest = hitOf('latest');
      } catch (_) { /* promotions 拿不到不影响主流程，只是少一枚「最新」角标 */
      }
      const list = sorted.map((x, i) => {
        const s = String(x.version);
        let tag = '';
        if (newest && s === newest) tag = '最新';
        else if (i === 0) tag = '最新';
        return { v: s, tag };
      });
      return { ok: true, kind: K, mcVer: v, latest: String(sorted[0].version), recommended, list };
    }

    /* ---- NeoForge：maven 版本总表里筛出该 MC 版本这一支 ---- */
    if (K === 'NeoForge') {
      const artifact = v.startsWith('1.20.1') ? 'forge' : 'neoforge';
      let all = null;
      try { all = await neoforgeVersionList(artifact); }
      catch (_) {
        return { ok: false, unknown: true, slow: true,
          why: 'NeoForge 版本列表获取超时（官方源与 BMCLAPI 镜像均未在超时内响应）' };
      }
      const prefix = neoforgeBuildPrefix(v, artifact);
      if (!prefix) return { ok: false, why: 'NeoForge 不支持 ' + v + '（无法解析版本号）' };
      const hit = (Array.isArray(all) ? all : []).filter(x => String(x).startsWith(prefix));
      if (!hit.length) return { ok: false, why: 'NeoForge 尚未提供 ' + v + ' 的构建' };
      /* maven 版本表是「旧 → 新」，倒序成「新 → 旧」；
         带 -beta / -rc 的算预发布，只在没有正式版时才可能被选（与安装器候选策略一致）。
         角标只打一枚：最新 = 第一项（「推荐」角标已删，避免把预发布版顶到眼前）。 */
      const rev = hit.map(String).reverse();
      const rec = rev.find(x => !/-/.test(x)) || '';
      const list = rev.map((s, i) => ({
        v: s,
        tag: i === 0 ? '最新' : ''
      }));
      return { ok: true, kind: K, mcVer: v, latest: list[0].v, recommended: rec, list };
    }

    return { ok: false, why: '该加载器暂不支持选择版本: ' + K };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
/* NeoForge 版本号前缀推导。
 * NeoForge 的版本号 = MC 版本去掉「老式主版本 1」之后的部分，作为前缀：
 *   MC 1.21.4  → NeoForge 21.4.x    （丢掉 "1." → "21.4."）
 *   MC 1.21.1  → NeoForge 21.1.x    （"21.1."）
 *   MC 1.20.4  → NeoForge 20.4.x    （"20.4."）
 *   MC 26.1    → NeoForge 26.1.x    （新版编号没有 "1." 前缀，直接取前两段 → "26.1."）
 *   MC 26.2    → NeoForge 26.2.x    （"26.2."）
 *   MC 1.20.1  → 特例：走旧坐标 net.neoforged:forge（版本形如 1.20.1-47.1.x），
 *                它的前缀是 "1.20.1-" 而不是本函数算出的 "20.1." ——
 *                所以调用方要用 neoforgeBuildPrefix(mcVer, artifact) 而不是直接调本函数。
 * 判据：版本号以 "1." 开头且后面还有两段以上（1.x.y）→ 丢掉首段；否则取前两段。 */
function neoforgePrefixOf(mcVer) {
  const s = String(mcVer).trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);          /* 三段式，如 1.21.4 / 26.1.2 */
  if (m) return m[1] === '1' ? (m[2] + '.' + m[3] + '.') : (m[1] + '.' + m[2] + '.');
  const m2 = s.match(/^(\d+)\.(\d+)/);                 /* 两段式，如 26.1 / 1.21 */
  if (m2) return m2[1] === '1' ? (m2[2] + '.0.') : (m2[1] + '.' + m2[2] + '.');
  return '';
}
/* 某 MC 版本在 NeoForge 版本总表里的前缀。
 *   - 老坐标（MC 1.20.1，artifact='forge'）：条目形如 1.20.1-47.1.106 → 前缀 "1.20.1-"
 *     这里**不能**用 neoforgePrefixOf：它会得出 "20.1."，与条目根本对不上，
 *     结果 1.20.1 明明有 62 个构建（实测）却被报成「尚未提供」→ 界面显示「✗ 不兼容」。
 *   - 新坐标（artifact='neoforge'）：条目形如 21.1.77 / 26.2.0.88 → 交给 neoforgePrefixOf
 *     （26.x 取前两段、1.x.y 丢首段）。 */
function neoforgeBuildPrefix(mcVer, artifact) {
  const s = String(mcVer).trim();
  return artifact === 'forge' ? (s + '-') : neoforgePrefixOf(s);
}
/* 从 NeoForge 版本总表里挑出某个 MC 版本对应的构建（纯函数：不联网，可离线单测）。
 * artifact 决定前缀规则，见 neoforgeBuildPrefix。
 * 返回 { ok, builds, loaderVer, why }：
 *   - builds  = 命中的构建总数（含 beta/rc）—— 界面只关心「有没有」
 *   - loaderVer = 优先取最后一个正式版；全是 beta/rc（或老坐标全是 "MC版本-" 前缀）时退回最后一个
 *     （26.3 目前上游就只发布了 -beta，命中数 50 但正式版 0，不能因此判「不支持」）
 * 命中数为 0 才是「真的没有构建」；「查询失败」由调用方标 unknown，两者不能混为一谈。 */
function neoforgeBuildsOf(list, mcVer, artifact) {
  const prefix = neoforgeBuildPrefix(mcVer, artifact);
  if (!prefix) return { ok: false, why: 'NeoForge 不支持 ' + mcVer + '（无法解析版本号）' };
  const hit = (Array.isArray(list) ? list : []).filter(x => String(x).startsWith(prefix));
  if (!hit.length) return { ok: false, why: 'NeoForge 尚未提供 ' + mcVer + ' 的构建' };
  const stable = hit.filter(x => !/-/.test(x));
  return { ok: true, builds: hit.length, loaderVer: stable.length ? stable[stable.length - 1] : hit[hit.length - 1] };
}
/* 安装用的候选构建（有序，调用方取最后一个 = 最新）。
 * 与 neoforgeBuildsOf 的分工：探针只回答「有没有」（含预发布都算有），
 * 安装必须挑出一个具体版本来装，所以要定优先级：
 *   正式版优先；一个正式版都没有时退回预发布版。
 * 为什么不能一律排除预发布：新版 26.x 的发布号本身就带后缀（26.3 目前上游只发了
 * 26.3.0.x-beta），一律排除会出现「界面 ✓ 兼容 → 点安装 → 报尚未提供正式构建」的自相矛盾。
 * 与 OptiFine 的「正式版优先、没有则退回预览版」是同一套策略。 */
function neoforgeInstallCandidates(list, mcVer, artifact) {
  const prefix = neoforgeBuildPrefix(mcVer, artifact);
  if (!prefix) return [];
  const hit = (Array.isArray(list) ? list : []).filter(x => String(x).startsWith(prefix));
  const stable = hit.filter(x => !/-/.test(x));
  return stable.length ? stable : hit;
}
ipcMain.on('win:minimize', () => { if (win) win.minimize(); });
ipcMain.on('win:close', () => { if (win) win.close(); });
ipcMain.on('win:maximize-toggle', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});

/* ---------------- 启动图标（PCL 式 splash：加载完成前只显示软件图标，加载完关闭图标亮出主窗口） ---------------- */
function splashHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;height:100%;background:#0b0d11;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:"Segoe UI",system-ui,sans-serif;overflow:hidden;user-select:none}' +
    '.logo{width:96px;height:96px;filter:drop-shadow(0 0 26px rgba(16,185,129,.4));animation:pop .5s ease-out}' +
    '@keyframes pop{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}' +
    '.name{color:#e5e7eb;font-size:16px;font-weight:600;letter-spacing:.5px}' +
    '.name b{color:#34d399}' +
    '.sub{color:#6b7280;font-size:11.5px;letter-spacing:2px;margin-top:-14px}' +
    '.dots{display:flex;gap:7px;margin-top:4px}' +
    '.dots i{width:8px;height:8px;border-radius:50%;background:#34d399;opacity:.25;animation:blink 1.2s infinite}' +
    '.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}' +
    '@keyframes blink{0%,100%{opacity:.25}50%{opacity:1}}' +
    '</style></head><body>' +
    '<svg class="logo" viewBox="0 0 512 512">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>' +
    '<rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>' +
    '<rect x="136" y="160" width="84" height="220" rx="24" fill="#fff"/>' +
    '<rect x="136" y="296" width="205" height="84" rx="24" fill="#fff"/>' +
    '<rect x="328" y="128" width="42" height="42" rx="10" fill="#a7f3d0"/>' +
    '<rect x="392" y="66" width="30" height="30" rx="8" fill="#a7f3d0"/>' +
    '<rect x="306" y="46" width="21" height="21" rx="6" fill="#a7f3d0"/>' +
    '</svg>' +
    '<div class="name">XLC <b>Launcher</b></div>' +
    '<div class="sub">XERO LITE CRAFT LAUNCHER</div>' +
    '<div class="dots"><i></i><i></i><i></i></div>' +
    '</body></html>';
}
let splash = null, splashSafety = null;
function createSplash() {
  if (HEADLESS) return; /* 自测进程不弹启动闪屏 */
  try {
    splash = new BrowserWindow({
      width: 430, height: 340, frame: false, resizable: false, minimizable: false, maximizable: false,
      center: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
      /* 关键：让闪屏秒开
         - backgroundColor 让窗口一 show() 就有底色，不必等 data: URL 解析完
         - paintWhenInitiallyHidden 让隐藏状态下也先把首帧画好，show() 时直接出图（否则 show 后还要等一轮合成，白闪一下） */
      backgroundColor: '#0b0d11', paintWhenInitiallyHidden: true,
      icon: path.join(ROOT, 'assets', 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    splash.setMenuBarVisibility(false);
    /* 立刻显示：不要等 ready-to-show（那要等 data: URL 解析+首次绘制，白白多等几百毫秒）。
       窗口已有深色底色，先 show 再加载内容是安全的 —— 用户看到的是「立刻出现的深色卡片」，
       随后图标/文字/跳动点才淡入，观感上比「先等再出现」快得多。 */
    splash.show();
    splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml()));
    splash.once('ready-to-show', () => { if (splash && !splash.isDestroyed() && !splash.isVisible()) splash.show(); });
    splash.on('closed', () => { splash = null; });
  } catch (e) {
    logLine('[splash] 启动图标创建失败（忽略，直接进主窗口）: ' + e.message);
    splash = null;
  }
  /* 兜底：主窗口 10 秒还没就绪也强制关闭图标，避免卡在图标上 */
  splashSafety = setTimeout(() => {
    if (splash) {
      logLine('[splash] 10s 兜底关闭');
      closeSplash();
      if (win && !win.isDestroyed() && !win.isVisible()) win.show();
    }
  }, 10000);
}
function closeSplash() {
  if (splashSafety) { clearTimeout(splashSafety); splashSafety = null; }
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  createSplash(); /* 先亮图标，主窗口就绪后再切换（PCL 式） */
  win = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 1000,
    minHeight: 660,
    frame: false,
    show: false, /* ready-to-show 前不显示，避免白屏闪现 */
    backgroundColor: '#0b0d11',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* 插件自定义页面用 <webview> 承载（嵌在主窗口内容区里，像自带页面一样切换）；
         guest 与主文档进程隔离，宿主侧还有 will-navigate / 分区断网 / CSP 三道护栏（见 pluginPageHostHooks） */
      webviewTag: true,
      /* 自测进程窗口不显示：关掉后台节流，保证隐藏状态下渲染 / 定时器 / capturePage 照常工作 */
      backgroundThrottling: !HEADLESS
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('did-frame-navigate', (_e, url) => { try { console.error('[nav] ' + url); } catch (_) {} });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { try { console.error('[navfail] ' + code + ' ' + desc + ' ' + String(url).slice(0, 80) + ' main=' + isMain); } catch (_) {} });
  win.webContents.session.on('will-download', (_e, it) => { try { console.error('[dl] ' + it.getURL()); } catch (_) {} });
  /* 渲染进程崩溃：留档 + 自动恢复窗口（一分钟内最多恢复 3 次，防止崩溃循环） */
  const renderRestarts = [];
  win.webContents.on('render-process-gone', (_e, d) => {
    captureLauncherCrash('render-process-gone', new Error('reason=' + (d && d.reason) + ' exitCode=' + (d && d.exitCode)));
    /* 自测进程收尾时是整棵进程树被强杀（hardExit），这里的 "killed" 不是真崩溃：
       既不要留崩溃记录，也不要重建窗口（重建会把本该退出的测试进程又拉活）。 */
    if (HEADLESS) return;
    if (!d || d.reason === 'clean-exit') return;
    logLine('[app] 渲染进程崩溃 reason=' + d.reason + ' exitCode=' + d.exitCode + '，尝试自动恢复窗口');
    try { win.destroy(); } catch (_) {}
    win = null;
    const now = Date.now();
    while (renderRestarts.length && now - renderRestarts[0] > 60000) renderRestarts.shift();
    if (renderRestarts.length < 3) { renderRestarts.push(now); setTimeout(createWindow, 600); }
  });
  /* 渲染进程 console 报错留档（JS 异常不会崩进程，但往往是崩溃前兆） */
  win.webContents.on('console-message', (...args) => {
    const ev = args[0] || {};
    const d = ev.details || { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const lvl = Number(d.level) || 0;
    if (lvl < 2) return; /* 2=warn 3=error */
    try {
      fs.appendFileSync(path.join(DIAG_DIR, 'renderer-console.log'),
        new Date().toISOString() + ' [' + lvl + '] ' + (d.sourceId || '') + ':' + (d.lineNumber || '?') + ' ' + String(d.message || '').slice(0, 500) + '\n');
    } catch (_) {}
  });
  win.once('ready-to-show', () => {
    closeSplash();
    /* 自测进程不显示窗口（见 HEADLESS 注释）：桌面不弹窗，测试照样跑 */
    if (!HEADLESS && win && !win.isDestroyed()) {
      if (!win.isVisible()) logLine('[win] ready-to-show 兜底显示');
      win.show();
    }
  });
  win.webContents.once('did-finish-load', () => {
    /* 配置损坏的提示要等界面就绪再说（loadConfig 时 toast/日志都还没准备好） */
    if (CONFIG_LOAD_WARN) {
      const msg = CONFIG_LOAD_WARN;
      CONFIG_LOAD_WARN = '';
      logLine('[config] ' + msg);
      toast(msg, 'warn');
    }
  });
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  /* 主窗口「开始加载」就先把窗口壳亮出来 —— 此时页面还来不及画任何东西，
     但窗口自带 backgroundColor(#0b0d11) 深色底，配合 boot.css 里 html/body 的同色底，
     用户看到的就是「双击后立刻出现一个深色窗口」，而不是对着空桌面等。
     页面里的 #bootMask 会在首屏 CSS 解析完后立刻覆盖上来（boot.css 放在 <link> 第一位）。
     dom-ready 这次 show() 保留（幂等）：万一 did-start-loading 那次因为别的原因没显示，这里兜底。 */
  if (!HEADLESS) {
    win.webContents.once('did-start-loading', () => {
      if (win && !win.isDestroyed() && !win.isVisible()) {
        logLine('[win] did-start-loading 立刻显示主窗口');
        closeSplash();
        win.show();
      }
    });
    win.webContents.once('dom-ready', () => {
      if (win && !win.isDestroyed() && !win.isVisible()) {
        logLine('[win] dom-ready 显示主窗口（带启动遮罩）');
        closeSplash();
        win.show();
      }
    });
  }
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('close', () => { logLine('[win] 主窗口收到关闭请求'); });
  win.on('closed', () => { logLine('[win] 主窗口已销毁'); win = null; });
}
/* 冒烟 / 自测模式（LMC_SMOKE_*，见文件顶部 SMOKE_EARLY）跳过单实例锁：用户开着启动器时，
   测试进程原本会被锁挡下并静默退出（零输出 + 退出码 0），看起来像「测试通过」实际什么都没跑。
   测试进程与用户实例本就该并存。 */
const SMOKE_ANY = SMOKE_EARLY;
const gotLock = SMOKE_ANY ? true : app.requestSingleInstanceLock();
if (SMOKE) console.log('[SMOKE] boot · lock=' + gotLock + ' · smokeAny=' + SMOKE_ANY + ' · argv=' + process.argv.slice(1).join(' '));
if (!gotLock) {
  app.quit();
} else {
  // 虚拟机 / 远程桌面环境下 GPU 进程可能崩溃，强制软件渲染
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
  app.disableHardwareAcceleration();
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    /* 再次双击启动器 = 「把我的窗口还给我」：最小化的要 restore，被「启动器可见性」隐藏的要 show
       —— hide() 过的窗口 isMinimized() 为 false，光 focus 根本拉不回来（用户会以为启动器卡死/丢了） */
    if (LAUNCHER_HIDDEN_FOR_GAME) { restoreLauncherWindow(); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
  /* 冒烟测试：无窗口运行真实启动链路（node electron . --lmc-smoke） */
  async function smokeTest() {
    console.log('[SMOKE] T1 规则引擎断言 …');
    const a1 = rulePass([{ action: 'allow', features: { is_demo_user: true } }]) === false;
    const a2 = rulePass([{ action: 'allow', features: { is_demo_user: true } }], { is_demo_user: true }) === true;
    const a3 = rulePass([{ action: 'allow', os: { name: 'linux' } }]) === false;
    const a4 = rulePass([{ action: 'allow', os: { name: 'windows' } }]) === true;
    const a5 = JSON.stringify(expandArgs([
      { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] },
      '-Xmx${mem_max}'
    ], {})) === JSON.stringify(['-Xmx${mem_max}']);
    const a6 = JSON.stringify(expandArgs([
      { rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }], value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'] }
    ], { quickPlaySingleplayer: 'World1' }, { is_quick_play_singleplayer: true })) === JSON.stringify(['--quickPlaySingleplayer', 'World1']);
    if (!(a1 && a2 && a3 && a4 && a5 && a6)) throw new Error('规则断言失败: ' + JSON.stringify([a1, a2, a3, a4, a5, a6]));
    console.log('[SMOKE] T1 PASS（features/os 规则正确）');
    console.log('[SMOKE] T2 版本链解析 26.3 …');
    const chain = await loadVersionChain('26.3', config.gameDir, 0);
    if (!fs.existsSync(chain.jarPath)) throw new Error('26.3.jar 缺失');
    const req = javaRequirementOf(chain.json, chain.rootId);
    console.log('[SMOKE] T2 PASS rootId=' + chain.rootId + ' · 需求 Java ' + req.major + ' (' + req.component + ')');
    console.log('[SMOKE] T3 实际拉起游戏进程 …');
    const smokeVer = process.env.LMC_SMOKE_VER || '26.3';
    const child = await runLaunch({ versionId: smokeVer, username: 'SmokeTest', mem: 2 });
    if (!child || !child.pid) throw new Error('游戏进程未启动');
    console.log('[SMOKE] 游戏进程 pid=' + child.pid);
    const out = [];
    const collect = d => out.push(d.toString());
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const okFlag = await new Promise(resolve => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (/LWJGL|Backend library|Setting user|OpenAL|Render|ModLauncher|FML|Transform/i.test(out.join(''))) { clearInterval(timer); return resolve(true); }
        if (Date.now() - t0 > 30000) { clearInterval(timer); return resolve(false); }
      }, 500);
    });
    console.log('---- 游戏输出（前 50 行）----');
    console.log(out.join('').split(/\r?\n/).slice(0, 50).join('\n'));
    try { child.kill(); } catch (_) {}
    if (!okFlag) throw new Error('游戏进程 30 秒内未出现 Minecraft 初始化标志（JVM 参数或库有问题）');
    console.log('[SMOKE] T3 PASS — 游戏 JVM 正常初始化');
  if (process.env.LMC_SMOKE_T4) {
    console.log('[SMOKE] T4 整合包导出→导入 端到端 …');
    const pk = await buildModpackBuffer('26.3');
    const man = JSON.parse(zipReadEntry(pk.buf, 'lmc-manifest.json').toString('utf8'));
    if (man.mcVersion !== '26.3') throw new Error('导出 manifest.mcVersion 错误: ' + man.mcVersion);
    man.name = 'lmc-smoke-pack';
    const buf2 = buildZip([{ name: 'lmc-manifest.json', data: Buffer.from(JSON.stringify(man)) },
      { name: 'mods/smoke-test.jar', data: Buffer.from('fake mod jar') }]);
    const ir = await importLmcPack(buf2);
    const vd = path.join(config.gameDir, 'versions', 'lmc-smoke-pack');
    const jf = path.join(vd, 'lmc-smoke-pack.json');
    if (!fs.existsSync(jf)) throw new Error('导入后版本 json 缺失');
    const ij = JSON.parse(await fsp.readFile(jf, 'utf8'));
    if (ij.id !== 'lmc-smoke-pack') throw new Error('导入版本 json 异常: ' + JSON.stringify({ id: ij.id }));
    if (!fs.existsSync(path.join(config.gameDir, 'mods', 'smoke-test.jar'))) throw new Error('导入 MOD 文件缺失');
    await fsp.rm(vd, { recursive: true, force: true });
    await fsp.unlink(path.join(config.gameDir, 'mods', 'smoke-test.jar')).catch(() => {});
    console.log('[SMOKE] T4 PASS — 导出/导入链路正常（' + pk.manifest.loader + ' · 测试版本已清理）');
  }
  hardExit(0);
  }
  /* UI 冒烟：真实窗口里模拟“长按回车”狂点添加好友（输入自己的好友码），
   * LMC_SMOKE_UI=<点击次数> electron . —— 结束后渲染进程仍存活则 PASS，崩溃则 FAIL 并留崩溃日志 */
  function uiSmokeFriendSpam(n) {
    const wc = win.webContents;
    const start = () => {
      const js = `(async () => {
        gotoPage('friends');
        await new Promise(r => setTimeout(r, 600));
        const fr = await window.lmc.friendsGet();
        const inp = document.querySelector('#frInputCode');
        inp.value = fr.code; /* 自己的好友码：每次都应被拒绝并弹 toast */
        const btn = document.querySelector('#frBtnAdd');
        const t0 = Date.now();
        for (let i = 0; i < ${n}; i++) { btn.click(); if ((i & 7) === 0) await new Promise(r => setTimeout(r, 0)); }
        await new Promise(r => setTimeout(r, 8000));
        return { clicks: ${n}, ms: Date.now() - t0, toasts: document.querySelectorAll('#toasts .toast').length, friends: (await window.lmc.friendsGet()).friends.length };
      })()`;
      wc.executeJavaScript(js, true).then((r) => {
        console.log('[UI-SMOKE] PASS 渲染进程存活 · ' + JSON.stringify(r));
        setTimeout(() => hardExit(0), 500);
      }).catch((e) => {
        console.error('[UI-SMOKE] FAIL 渲染进程在连点中异常/崩溃: ' + ((e && e.message) || e));
        setTimeout(() => hardExit(2), 500);
      });
    };
    if (wc.isLoading()) wc.once('did-finish-load', start); else start();
  }
  /* UI 脚本冒烟：LMC_SMOKE_UI_JS=<js 文件> electron . —— 在真实窗口里执行该脚本，
   * 脚本以 `return { ok, lines: [...] }` 返回结果；ok=false 时进程退出码为 1 */
  function uiSmokeRunJsFile(file) {
    const wc = win.webContents;
    const start = async () => {
      /* 启动遮罩（#bootMask）覆盖全屏且会拦截点击：等它淡出 / 移除后再跑测试脚本，
         否则测试点不到下面的元素（曾经 executeJavaScript 在 dom-ready 就触发，遮罩还在） */
      try {
        for (let i = 0; i < 60; i++) {
          const gone = await wc.executeJavaScript(
            '(() => { const m = document.getElementById("bootMask"); return !m || m.classList.contains("hide"); })()', true);
          if (gone) break;
          await new Promise(r => setTimeout(r, 250));
        }
      } catch (_) {}
      /* Windows 下 Electron 主进程的 stdout 经常拿不到（只剩 GPU 警告），
         导致测试"失败但看不到原因"→ 结果一律同时落盘；
         文件名带进程号，避免同时跑多个测试时互相覆盖 */
      const dump = (text) => {
        const body = text + '\nfile: ' + file + '\npid: ' + process.pid + '\ntime: ' + new Date().toISOString() + '\n';
        try { fs.mkdirSync(path.join(__dirname, 'qa', 'out'), { recursive: true }); } catch (_) {}
        for (const f of [
          path.join(__dirname, 'qa', 'out', 'ui-js-result-' + process.pid + '.log'),
          path.join(__dirname, 'qa', 'out', 'ui-js-result.log'),
          path.join(os.tmpdir(), 'xlc-ui-js-result-' + process.pid + '.log')
        ]) {
          try { fs.writeFileSync(f, body, 'utf8'); } catch (_) {}
        }
      };
      try {
        /* 关键诊断：确认自测进程窗口确实没显示（曾经这里会真的弹窗，测试中断后窗口留在桌面上） */
        console.log('[UI-JS] headless=' + HEADLESS + ' · winVisible=' +
          ((win && !win.isDestroyed()) ? win.isVisible() : 'n/a'));
        /* 渲染进程 console 实时转发：UI 脚本是「整段 await 完才 return」，一旦中途挂起
           （网络卡住 / 等待事件不来）主进程这边一行输出都没有，完全看不出卡在哪一步。
           把渲染进程的日志即时打到 stdout，挂起时能直接看到最后一条进度。
           Electron 30+ 的回调签名改成 (event)，event.message 才是文本，这里两种都兼容。 */
        wc.on('console-message', (a, b, c) => {
          try {
            /* 旧签名 (event, level, message, line, source) → 取第 3 参；
               新签名（Electron 35+）(event) → 取 event.message。两种都兼容。 */
            const msg = (typeof c === 'string' && c) ? c : ((a && a.message) || '');
            if (msg) console.log('[UI-CONSOLE] ' + msg);
          } catch (_) {}
        });
        const src = fs.readFileSync(file, 'utf8');
        const r = await wc.executeJavaScript('(async () => {\n' + src + '\n})()', true);
        const lines = (r && r.lines) || [];
        for (const l of lines) console.log(l);
        const pass = !!(r && r.ok);
        const summary = '[UI-JS] ' + (pass ? 'PASS' : 'FAIL') + ' · ' + ((r && r.summary) || '');
        console.log(summary);
        dump(lines.join('\n') + '\n' + summary);
        setTimeout(() => hardExit(pass ? 0 : 1), 400);
      } catch (e) {
        const msg = '[UI-JS] FAIL 渲染进程异常: ' + ((e && e.stack) || e);
        console.error(msg);
        dump(msg);
        setTimeout(() => hardExit(2), 400);
      }
    };
    if (wc.isLoading()) wc.once('did-finish-load', start); else start();
  }
  app.whenReady().then(async () => {
    /* 下载速度采样常驻：每 500ms 算一次瞬时速率推给界面（没流量时自己安静，不发事件） */
    netTimer = setInterval(netTick, 500);
    /* 自测看门狗：无论测试脚本卡在哪一步（网络挂起 / 等待日志），到点强制退出。
       否则用户会看到测试进程一直留在后台（旧版本还会留一屏窗口）。默认 15 分钟（对齐开服测试的耗时上限），可覆盖。 */
    if (SMOKE_EARLY) {
      const cap = (parseInt(process.env.LMC_SMOKE_TIMEOUT, 10) || 900) * 1000;
      setTimeout(() => {
        try { console.error('[SMOKE] 超时 ' + (cap / 1000) + 's 未结束，强制退出（防止残留进程 / 窗口）'); } catch (_) {}
        hardExit(4);
      }, cap);
    }
    if (process.env.LMC_SMOKE_UPDATE) {
      try {
        const r = updateParserSelfTest();
        const summary = r.lines.join('\n') + '\n[UPDATE-TEST] ' +
          (r.fail ? 'FAIL ' + r.fail : 'PASS') + ' / ' + r.lines.filter(l => l.startsWith('PASS')).length + ' 项';
        /* Windows 下 Electron 主进程的 stdout 常拿不到 → 同时落盘，便于在终端 / CI 里查看结果 */
        try {
          fs.writeFileSync(path.join(os.tmpdir(), 'xlc-update-selftest.log'), summary, 'utf8');
          fs.writeFileSync(path.join(__dirname, 'qa', 'out', 'update-selftest.log'), summary, 'utf8');
        } catch (e) { console.error('[UPDATE-TEST] 写日志失败: ' + ((e && e.message) || e)); }
        console.log(summary);
        hardExit(r.fail ? 1 : 0);
      } catch (e) {
        console.error('[UPDATE-TEST] FAIL 异常: ' + ((e && e.stack) || e));
        hardExit(2);
      }
      return;
    }
    if (process.env.LMC_SMOKE_PLUGIN) {
      try {
        /* 自测里会反复开关面板窗口，而这个进程**没有启动器窗口** —— 不摘掉这个监听的话，
           面板一关就触发「所有窗口关闭」→ app.quit() 开始退出，测试在半路被带走（看起来像卡死）。 */
        app.removeAllListeners('window-all-closed');
        const r = await pluginSelfTest();
        const summary = r.lines.join('\n') + '\n[PLUGIN-TEST] ' +
          (r.fail ? 'FAIL ' + r.fail : 'PASS') + ' / ' + r.lines.filter(l => l.startsWith('PASS')).length + ' 项';
        try { fs.writeFileSync(path.join(__dirname, 'qa', 'out', 'plugin-selftest.log'), summary, 'utf8'); } catch (_) {}
        console.log(summary);
        hardExit(r.fail ? 1 : 0);
      } catch (e) {
        console.error('[PLUGIN-TEST] FAIL 异常: ' + ((e && e.stack) || e));
        hardExit(2);
      }
      return;
    }
    if (process.env.LMC_SMOKE_MS) {
      try {
        const r = await msOauthSelfTest();        /* LMC_SMOKE_MS_WEB=1 时再跑一遍「内置登录窗口」集成自测（真窗口，本地页面，不联网） */
        if (process.env.LMC_SMOKE_MS_WEB) {
          const w = await msWindowSelfTest();
          r.lines = r.lines.concat(w.lines);
          r.fail += w.fail;
        }
        const summary = r.lines.join('\n') + '\n[MS-TEST] ' +
          (r.fail ? 'FAIL ' + r.fail : 'PASS') + ' / ' + r.lines.filter(l => l.startsWith('PASS')).length + ' 项';
        try {
          fs.writeFileSync(path.join(os.tmpdir(), 'xlc-ms-selftest.log'), summary, 'utf8');
          fs.writeFileSync(path.join(__dirname, 'qa', 'out', 'ms-selftest.log'), summary, 'utf8');
        } catch (e) { console.error('[MS-TEST] 写日志失败: ' + ((e && e.message) || e)); }
        console.log(summary);
        hardExit(r.fail ? 1 : 0);
      } catch (e) {
        console.error('[MS-TEST] FAIL 异常: ' + ((e && e.stack) || e));
        hardExit(2);
      }
      return;
    }
    if (process.env.LMC_SMOKE_LAUNCH) {
      try {
        /* 跑几遍：第 1 遍 = 冷启动（Java 探测缓存为空，最接近「打开启动器就点启动」），
           第 2 遍起 = 热（缓存已就绪，反映「游戏关掉再开一次」）。默认 1 遍。 */
        const n = Math.max(1, Math.min(5, parseInt(process.env.LMC_SMOKE_LAUNCH_N, 10) || 1));
        for (let i = 0; i < n; i++) {
          console.log('[LAUNCH-TIME] --- 第 ' + (i + 1) + ' 遍 ---');
          await launchTimingProbe(process.env.LMC_SMOKE_LAUNCH);
        }
        hardExit(0);
      } catch (e) {
        console.error('[LAUNCH-TIME] FAIL ' + ((e && e.stack) || e));
        hardExit(2);
      }
      return;
    }
    if (process.env.LMC_SMOKE_UI_JS) {
      createWindow();
      uiSmokeRunJsFile(process.env.LMC_SMOKE_UI_JS);
      return;
    }
    if (process.env.LMC_SMOKE_UI) {
      createWindow();
      uiSmokeFriendSpam(parseInt(process.env.LMC_SMOKE_UI, 10) || 600);
      return;
    }
    if (process.argv.includes('--lmc-smoke-net')) {
      try {
        const r = await modrinthSearchInner('sodium', 'mod', '', '');
        const withIcon = r.hits.filter(h => h.icon.startsWith('data:')).length;
        console.log('[NET] hits=' + r.hits.length + ' · total=' + r.total + ' · icons(base64)=' + withIcon);
        if (!r.hits.length) throw new Error('搜索无结果');
        if (!withIcon) throw new Error('图标未能转 base64');
        console.log('[NET] PASS');
        hardExit(0);
      } catch (e) { console.error('[NET] FAIL: ' + e.message); hardExit(1); }
      return;
    }
    if (SMOKE) {
      try { await smokeTest(); }
      catch (e) { console.error('[SMOKE] FAIL: ' + (e && e.stack || e)); hardExit(1); }
      return;
    }
    logLine('[app] XLC Launcher ' + APP_VERSION + ' 启动 · electron=' + process.versions.electron + ' · gameDir=' + config.gameDir + ' · source=' + config.source);
    createWindow();
    scheduleAutoUpdateCheck();
    warmJavaCacheLater();
  });
  app.on('window-all-closed', () => app.quit());
}

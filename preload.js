'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lmc', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  pickFolder: () => ipcRenderer.invoke('dir:pick'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  copyText: (t) => ipcRenderer.invoke('clipboard:write', t),
  /* 统一确认框：替代 window.confirm（后者会阻塞渲染进程，导致界面「点不动、打不了字」） */
  confirmBox: (p) => ipcRenderer.invoke('ui:confirm', p),
  scan: () => ipcRenderer.invoke('dir:scan'),
  savesList: () => ipcRenderer.invoke('saves:list'),
  savesPreview: (p) => ipcRenderer.invoke('saves:preview', p),
  savesDelete: (p) => ipcRenderer.invoke('saves:delete', p),
  /* 内置插件「存档备份」：备份 / 列表 / 恢复 / 打开备份目录 / 全部备份 */
  savesBackup: (p) => ipcRenderer.invoke('saves:backup', p),
  savesBackups: () => ipcRenderer.invoke('saves:backups'),
  savesRestore: (p) => ipcRenderer.invoke('saves:restore', p),
  savesBackupReveal: () => ipcRenderer.invoke('saves:backup-dir'),
  savesBackupAll: () => ipcRenderer.invoke('saves:backup-all'),
  savesBackupDelete: (p) => ipcRenderer.invoke('saves:backup-delete', p),
  /* 内置插件「模组清单对齐」：扫本地清单 / 算差异 / 收件箱（好友通道发来的清单） */
  modsManifest: (p) => ipcRenderer.invoke('mods:manifest', p),
  modsDiff: (p) => ipcRenderer.invoke('mods:diff', p),
  modlistInbox: () => ipcRenderer.invoke('modlist:inbox'),
  modlistClear: () => ipcRenderer.invoke('modlist:clear'),
  getManifest: () => ipcRenderer.invoke('manifest:get'),
  /* force=true 表示本次调用要求「实时查询」：主进程侧无任何兼容性缓存，每次都会真实访问上游 */
  loaderProbe: (kind, gameVer, force) => ipcRenderer.invoke('loader:probe', kind, gameVer, !!force),
  /* 加载器可选版本列表（界面「选择版本」下拉）：{ ok, latest, recommended, list:[{v,tag}] } */
  loaderBuilds: (kind, gameVer) => ipcRenderer.invoke('loader:builds', kind, gameVer),
  /* OptiFine 以 mod 形式安装（新版 OptiFine 本质是 Forge/NeoForge 模组） */
  optifineAsMod: (mcVer, instName) => ipcRenderer.invoke('optifine:asMod', mcVer, instName || ''),
  install: (payload) => ipcRenderer.invoke('install:start', payload),
  installCancel: (payload) => ipcRenderer.invoke('install:cancel', payload),
  detectJava: () => ipcRenderer.invoke('java:detect'),
  /* 已检测到的 Java 列表（走缓存，不弹提示）——「游戏设置 → Java 选择」下拉用 */
  javaList: () => ipcRenderer.invoke('java:list'),
  rendererError: (m) => ipcRenderer.send('app:renderer-error', String(m)),
  /* 界面面包屑：切页面 / 设置子页时给主进程日志留一行（排查「用着用着就崩」时能定位到页） */
  uiTrace: (m) => ipcRenderer.send('ui:trace', String(m)),
  javaDownload: (major) => ipcRenderer.invoke('java:download', major),
  pingSource: (url) => ipcRenderer.invoke('net:ping', url),
  launch: (opts) => ipcRenderer.invoke('launch:start', opts),
  stopGame: () => ipcRenderer.invoke('launch:stop'),
  exportModpack: (versionId, opts) => ipcRenderer.invoke('modpack:export', versionId, opts),
  exportOptions: (versionId) => ipcRenderer.invoke('modpack:export-options', versionId),
  importModpack: () => ipcRenderer.invoke('modpack:import'),
  versionInfo: (p) => ipcRenderer.invoke('version:info', p),
  /* 实例级设置（PCL 式「版本设置」）：窗口标题 / 手动指定的 Java */
  versionSettingsSave: (p) => ipcRenderer.invoke('version:settings-save', p),
  versionPickJava: () => ipcRenderer.invoke('version:pick-java'),
  loaderChange: (p) => ipcRenderer.invoke('version:loader-change', p),
  loaderUninstall: (p) => ipcRenderer.invoke('version:loader-uninstall', p),
  customDownload: (p) => ipcRenderer.invoke('custom:download', p),
  modrinthSearch: (p) => ipcRenderer.invoke('modrinth:search', p),
  modrinthDetail: (p) => ipcRenderer.invoke('modrinth:detail', p),
  modrinthCfDesc: (p) => ipcRenderer.invoke('modrinth:cf-desc', p),
  modrinthTranslate: (p) => ipcRenderer.invoke('modrinth:translate', p),
  modrinthInstallMod: (p) => ipcRenderer.invoke('modrinth:install-mod', p),
  /* 模组版本列表（安装前先选模组版本用） */
  modrinthModVersions: (p) => ipcRenderer.invoke('modrinth:mod-versions', p),
  modrinthInstallModpack: (p) => ipcRenderer.invoke('modrinth:install-modpack', p),
  modrinthInstallPack: (p) => ipcRenderer.invoke('modrinth:install-pack', p),
  /* 内容下载（MOD/整合包/资源包/光影/数据包）的「停止」：凭渲染层生成的 jobKey 打断任务 */
  downloadCancel: (jobKey) => ipcRenderer.invoke('download:cancel', jobKey),
  /* 冒烟专用：主进程只在 LMC_SMOKE_DL=1 时注册，平时调会报无处理器 */
  smokeDownload: (p) => ipcRenderer.invoke('smoke:download', p),
  pickBg: () => ipcRenderer.invoke('personalize:pick-bg'),
  getBg: () => ipcRenderer.invoke('personalize:get-bg'),
  sysMem: (p) => ipcRenderer.invoke('sys:meminfo', p),
  instanceRename: (p) => ipcRenderer.invoke('instance:rename', p),
  instanceDelete: (p) => ipcRenderer.invoke('instance:delete', p),
  modsList: (p) => ipcRenderer.invoke('mods:list', p),
  modsEnrich: (p) => ipcRenderer.invoke('mods:enrich', p),
  openUrl: (u) => ipcRenderer.invoke('shell:open-external', u),
  mpStatus: () => ipcRenderer.invoke('mp:status'),
  mpDownload: () => ipcRenderer.invoke('mp:download'),
  mpStart: () => ipcRenderer.invoke('mp:start'),
  mpState: () => ipcRenderer.invoke('mp:state'),
  mpAct: (p) => ipcRenderer.invoke('mp:act', p),
  mpStop: () => ipcRenderer.invoke('mp:stop'),
  modsToggle: (p) => ipcRenderer.invoke('mods:toggle', p),
  modsDelete: (p) => ipcRenderer.invoke('mods:delete', p),
  modsCheckUpdates: (p) => ipcRenderer.invoke('mods:check-updates', p),
  modsUpdate: (p) => ipcRenderer.invoke('mods:update', p),
  /* 资源包 / 光影包（游戏设置页，照 PCL CE 的实例页）：列表 / 更新检查 / 更新 / 安装 / 删除 / 导出 */
  resList: (p) => ipcRenderer.invoke('res:list', p),
  resCheckUpdates: (p) => ipcRenderer.invoke('res:check-updates', p),
  resUpdate: (p) => ipcRenderer.invoke('res:update', p),
  resOpenFolder: (p) => ipcRenderer.invoke('res:open-folder', p),
  resPickFiles: () => ipcRenderer.invoke('res:pick-files'),
  resInstall: (p) => ipcRenderer.invoke('res:install', p),
  resDelete: (p) => ipcRenderer.invoke('res:delete', p),
  resExportCsv: (p) => ipcRenderer.invoke('res:export-csv', p),
  diagLauncher: () => ipcRenderer.invoke('diag:launcher'),
  diagReports: (p) => ipcRenderer.invoke('diag:reports', p),
  diagGame: (p) => ipcRenderer.invoke('diag:game', p),
  diagAi: (p) => ipcRenderer.invoke('diag:ai', p),
  /* 反馈页：仓库 Issue 按处理状态分组（force=true 表示忽略 10 分钟缓存，强制重取） */
  feedbackList: (p) => ipcRenderer.invoke('feedback:list', p),
  /* 新功能投票页：GitHub Discussions 列表（force=true 强制重取，缓存同样 10 分钟） */
  voteList: (p) => ipcRenderer.invoke('vote:list', p),
  accountList: () => ipcRenderer.invoke('account:list'),
  accountAdd: (p) => ipcRenderer.invoke('account:add', p),
  accountSwitch: (p) => ipcRenderer.invoke('account:switch', p),
  accountDelete: (p) => ipcRenderer.invoke('account:delete', p),
  accountRename: (p) => ipcRenderer.invoke('account:rename', p),
  accountSkin: (p) => ipcRenderer.invoke('account:skin', p),
  accountSkinRemove: (p) => ipcRenderer.invoke('account:skin-remove', p),
  /* 设置页「配置迁移与缓存」：把偏好导出成文件 / 从文件导入 / 清理下载与图标缓存 */
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  getLicenses: () => ipcRenderer.invoke('licenses:get'),
  accountMsLoginStart: (p) => ipcRenderer.invoke('account:ms-login-start', p),  accountMsLoginWait: (p) => ipcRenderer.invoke('account:ms-login-wait', p),
  accountMsLoginCancel: () => ipcRenderer.invoke('account:ms-login-cancel'),
  /* 默认流程：内置窗口登录（零配置）；进度通过 'account:ms-progress' 推送 */
  accountMsWebLogin: (p) => ipcRenderer.invoke('account:ms-web-login', p),
  accountMsWebCancel: () => ipcRenderer.invoke('account:ms-web-cancel'),
  accountMsAppInfo: () => ipcRenderer.invoke('account:ms-app-info'),
  accountMsNetCheck: () => ipcRenderer.invoke('account:ms-net-check'),
  accountMsStart: (p) => ipcRenderer.invoke('account:ms-start', p),
  accountMsPoll: (p) => ipcRenderer.invoke('account:ms-poll', p),
  accountAuthlibDetect: (p) => ipcRenderer.invoke('account:authlib-detect', p),
  accountAuthlibLogin: (p) => ipcRenderer.invoke('account:authlib-login', p),
  accountModel: (p) => ipcRenderer.invoke('account:model', p),
  friendsGet: () => ipcRenderer.invoke('friends:get'),
  friendsAdd: (p) => ipcRenderer.invoke('friends:add', p),
  friendsRemove: (p) => ipcRenderer.invoke('friends:remove', p),
  friendsPresence: () => ipcRenderer.invoke('friends:presence'),
  friendsSignalPoll: () => ipcRenderer.invoke('friends:signal-poll'),
  friendsSignalSend: (p) => ipcRenderer.invoke('friends:signal-send', p),
  /* 插件 */
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  pluginToggle: (p) => ipcRenderer.invoke('plugin:toggle', p),
  /* 模组翻译器（内置插件）：选 JAR → 解析 → 翻译 → 生成汉化资源包 */
  translatorPick: () => ipcRenderer.invoke('translator:pick'),
  translatorInspect: (p) => ipcRenderer.invoke('translator:inspect', p),
  translatorRun: (p) => ipcRenderer.invoke('translator:run', p),
  translatorCancel: () => ipcRenderer.invoke('translator:cancel'),
  translatorOpenDir: (p) => ipcRenderer.invoke('translator:open-dir', p),
  /* 拓展插件（社区插件）：ZIP 导入 / 卸载 / 开面板
     —— 导入分两步：先 pick 校验（不落盘）拿权限清单给用户确认，再 install 真正安装。
     —— 面板不是这里的 iframe，而是主进程开的独立窗口（只有那个窗口挂 plugin-preload.js）；
        所以启动器页面这边只有一个「把窗口开起来」的入口，插件接口调用不经过本文件。 */
  pluginImportPick: () => ipcRenderer.invoke('plugin:import-pick'),
  pluginImportInstall: (p) => ipcRenderer.invoke('plugin:import-install', p),
  pluginRemove: (p) => ipcRenderer.invoke('plugin:remove', p),
  pluginOpenDir: (p) => ipcRenderer.invoke('plugin:open-dir', p),
  pluginPanelOpen: (p) => ipcRenderer.invoke('plugin:panel-open', p),
  /* 插件页面（page.html）：把启动器当前明暗主题同步给主进程（页面常驻，主题变了要跟进） */
  pluginPageTheme: (p) => ipcRenderer.invoke('plugin:page-theme', p),
  seedmapPlatforms: () => ipcRenderer.invoke('plugin:seedmap-platforms'),
  seedmapOpen: (p) => ipcRenderer.invoke('plugin:seedmap-open', p),
  /* 插件：一键开服 */
  serverCores: () => ipcRenderer.invoke('server:cores'),
  serverVersions: (p) => ipcRenderer.invoke('server:versions', p),
  serverList: () => ipcRenderer.invoke('server:list'),
  serverCreate: (p) => ipcRenderer.invoke('server:create', p),
  serverStart: (p) => ipcRenderer.invoke('server:start', p),
  serverStop: (p) => ipcRenderer.invoke('server:stop', p),
  serverKill: (p) => ipcRenderer.invoke('server:kill', p),
  serverCmd: (p) => ipcRenderer.invoke('server:cmd', p),
  serverDelete: (p) => ipcRenderer.invoke('server:delete', p),
  serverOpenDir: (p) => ipcRenderer.invoke('server:open-dir', p),
  serverSyncMods: (p) => ipcRenderer.invoke('server:sync-mods', p),
  serverJavas: () => ipcRenderer.invoke('server:javas'),
  /* 启动器版本更新 */
  updateCheck: (p) => ipcRenderer.invoke('update:check', p),
  updateChangelog: () => ipcRenderer.invoke('update:changelog'),
  updateSeen: () => ipcRenderer.invoke('update:seen'),
  updateCached: () => ipcRenderer.invoke('update:cached'),
  updateIgnore: (p) => ipcRenderer.invoke('update:ignore', p),
  updateDownload: (p) => ipcRenderer.invoke('update:download', p),
  updateCancel: () => ipcRenderer.invoke('update:cancel'),
  updateRun: (p) => ipcRenderer.invoke('update:run', p),
  updateReveal: (p) => ipcRenderer.invoke('update:reveal', p),
  updateSelfReplace: (p) => ipcRenderer.invoke('update:self-replace', p),
  updateQuit: () => ipcRenderer.send('update:quit-for-update'),
  /* 只允许订阅主进程主动推送的已知通道；返回取消订阅函数 */
  on: (channel, cb) => {
    const ON_CHANNELS = [
      'app:status', 'app:toast', 'install:progress', 'install:speed', 'install:done',
      'launch:log', 'launch:exit', 'launch:stage', 'mp:progress', 'win:maximized',
      'server:log', 'server:progress', 'server:state',
      'update:progress', 'update:available', 'account:ms-progress', 'plugin:cfg-changed',
      'translator:progress', 'translator:drop',
      /* 内置插件「存档备份 / 模组清单对齐」的推送（自动备份完成 / 收到好友清单） */
      'backup:auto-done', 'modlist:received'
    ];
    if (!ON_CHANNELS.includes(channel)) throw new Error('不允许订阅 IPC 通道: ' + channel);
    if (typeof cb !== 'function') throw new Error('on() 需要一个回调函数');
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximizeToggle: () => ipcRenderer.send('win:maximize-toggle'),
    close: () => ipcRenderer.send('win:close')
  }
});

/* 拖拽 JAR 到「模组翻译器」面板：File 对象过不了 contextBridge，
 * 所以在 preload 这一层直接用 webUtils 取真实路径，再把路径发给主进程转回界面。
 * 只拦落在翻译器面板里的拖放 —— 别的地方拖文件还是交给系统默认行为（避免误拦整页）。 */
try {
  const inTranslator = (el) => {
    try { return !!(el && el.closest && el.closest('#plgTranslator')); } catch (_) { return false; }
  };
  window.addEventListener('dragover', (e) => {
    if (inTranslator(e.target) && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, true);
  window.addEventListener('drop', (e) => {
    if (!inTranslator(e.target)) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    try {
      const p = webUtils.getPathForFile(f);
      if (p) ipcRenderer.send('translator:drop', p);
    } catch (_) {}
  }, true);
} catch (_) { /* 老版本 Electron 没有 webUtils：拖拽不可用，按钮选文件照旧能用 */ }

'use strict';
/* ============================================================
 * 社区插件**面板窗口**的 preload —— 面板与启动器之间唯一的桥
 * ============================================================
 * 这个文件只跑在插件面板窗口里（主进程 openPluginPanel 指定的 preload），
 * 面板页面的任何代码都读不到它（contextIsolation，它住在隔离世界）。
 * 对外开放的只有这两件事（多一个都是多一份要维护的承诺）：
 *   info()               → { ok, id, name, version, author, theme, granted, grantedLabels }
 *   call(method, params) → { ok, data } / { ok:false, error }   ← 主进程按权限白名单放行
 *
 * 「是哪个插件在说话」由主进程按「消息从哪个窗口来」判定，面板自报家门不算数 ——
 * 所以面板即使想冒充别的插件也没有着力点。
 * ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xlcPlugin', {
  /* 面板身份 / 主题 / 已授权的权限（作者可用来提示「本功能需要 xx 权限」） */
  info: () => ipcRenderer.invoke('plugin:win-info'),
  /* 调托管接口：只有导入时用户勾选过的权限才能用，没授权的会被拒并带上原因 */
  call: (method, params) => ipcRenderer.invoke('plugin:win-call', { method: String(method || ''), params: params || {} })
});

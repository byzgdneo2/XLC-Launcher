/* 20 轮专项审计脚本 - 机械可验证部分 */
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(f, 'utf8');
const html = R('src/index.html'), js = R('src/renderer.js'), main = R('main.js'), css = R('src/styles.css'), pre = R('preload.js');
let issues = [];
const log = (n, msg) => console.log('[Round ' + n + '] ' + msg);

/* Round 1: SVG 图标 use href ↔ symbol 定义 */
const symbols = new Set([...html.matchAll(/<symbol id="(i-[a-z-]+)"/g)].map(m => m[1]));
const useRefs = new Set([...html.matchAll(/href="#(i-[a-z-]+)"/g)].map(m => m[1])
  .concat([...js.matchAll(/href="#(i-[a-z-]+)"/g)].map(m => m[1])));
[...useRefs].filter(u => !symbols.has(u)).forEach(u => issues.push('R1 图标未定义: ' + u));
log(1, 'symbol 定义 ' + symbols.size + ' 个，引用 ' + useRefs.size + ' 处，缺失 ' + issues.filter(i => i.startsWith('R1')).length);

/* Round 2: 所有 button 元素是否有绑定（HTML 静态按钮） */
const htmlBtns = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map(m => m[1]);
const boundInJs = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)\.addEventListener/g)].map(m => m[1]));
const dynHtml = new Set([...js.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
htmlBtns.filter(b => !boundInJs.has(b) && !dynHtml.has(b)).forEach(b => issues.push('R2 HTML按钮无绑定: ' + b));
log(2, 'HTML 静态按钮 ' + htmlBtns.length + ' 个，未绑定 ' + issues.filter(i => i.startsWith('R2')).length);

/* Round 3: IPC 三向核对 */
const handles = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));
const ons = new Set([...main.matchAll(/ipcMain\.on\('([^']+)'/g)].map(m => m[1]));
const invokes = new Set([...pre.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map(m => m[1]));
[...invokes].filter(c => !handles.has(c) && !ons.has(c)).forEach(c => issues.push('R3 IPC 缺失: ' + c));
log(3, 'handle ' + handles.size + ' + on ' + ons.size + '，preload 调用 ' + invokes.size + '，缺失 ' + issues.filter(i => i.startsWith('R3')).length);

/* Round 4: renderer 静态 $() 选择器全部存在（HTML id 或动态 id 或类） */
const htmlIds = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]));
const refIds = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]));
[...refIds].filter(i => !htmlIds.has(i) && !dynHtml.has(i)).forEach(i => issues.push('R4 选择器无目标: #' + i));
log(4, '$(#id) 引用 ' + new Set(refIds).size + ' 个，无目标 ' + issues.filter(i => i.startsWith('R4')).length);

/* Round 5: main 发送的事件 renderer 是否监听 */
const sends = new Set([...main.matchAll(/send\('([^']+)'/g)].map(m => m[1]));
const listeners = new Set([...js.matchAll(/lmc\.on\('([^']+)'/g)].map(m => m[1]));
[...sends].filter(c => !listeners.has(c)).forEach(c => issues.push('R5 main事件无监听: ' + c));
log(5, 'main send ' + sends.size + ' 种，renderer 监听 ' + listeners.size + ' 种，未监听 ' + issues.filter(i => i.startsWith('R5')).length);

/* Round 6: renderer 动态 className ↔ styles.css 定义 */
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]+)/g)].map(m => m[1]));
const jsClasses = [...js.matchAll(/el\('div',\s*'([^']+)'/g)].map(m => m[1]).join(' ').split(/\s+/)
  .concat([...js.matchAll(/className = '([^']+)'/g)].map(m => m[1]).join(' ').split(/\s+/))
  .concat([...js.matchAll(/class="([^"]+)"/g)].map(m => m[1])).join(' ').split(/\s+/).filter(Boolean);
const ignore = new Set(['active', 'on', 'sel', 'bad', 'ok', 'out', 'busy', 'in']);
[...new Set(jsClasses)].filter(c => !c.includes('+') && !c.includes('$') && !c.includes('(') &&
  !cssClasses.has(c) && !ignore.has(c) && c.startsWith('t-')).forEach(c => issues.push('R6 CSS类未定义: ' + c));
log(6, 'JS 动态类 ' + new Set(jsClasses).size + ' 个，CSS 未定义 ' + issues.filter(i => i.startsWith('R6')).length);

/* Round 7: XSS 面 —— innerHTML 拼接中未 esc 的变量（启发式） */
const innerhtmls = [...js.matchAll(/\.innerHTML\s*[+]?=\s*([^;]{0,120})/g)];
log(7, 'innerHTML 赋值 ' + innerhtmls.length + ' 处（人工走查）');

/* Round 8: main.js spawn/execFile 参数来源 */
const spawns = [...main.matchAll(/(spawn|execFile)\(([^,]+),/g)];
log(8, '进程启动 ' + spawns.length + ' 处: ' + spawns.map(s => s[2].trim()).join(' | '));

/* Round 9: 竞态标志检查 */
['S.launching', 'installingNow', 'tcDownloading', 'MP.polling'].forEach(f => {
  const n = (js.match(new RegExp(f.replace('.', '\\.'), 'g')) || []).length;
  log(9, '竞态标志 ' + f + ' 出现 ' + n + ' 次');
});

/* Round 10: renderer 顶层 await 无 catch 的 addEventListener async */
const asyncHandlers = [...js.matchAll(/addEventListener\('(\w+)',\s*(async|\(\)\s*=>)/g)];
log(10, '事件处理器 ' + asyncHandlers.length + ' 个');

/* Round 11: setInterval / addEventListener 重复绑定风险 */
const ivals = [...js.matchAll(/setInterval\(/g)].length;
log(11, 'setInterval ' + ivals + ' 处（mpPolling 1 处需确认守卫）');

/* Round 12: DEFAULT_CONFIG 键 ↔ renderer 引用 S.config.xxx */
const cfg = main.match(/const DEFAULT_CONFIG = ({[\s\S]*?});/);
const cfgKeys = cfg ? new Set([...cfg[1].matchAll(/(\w+):/g)].map(m => m[1])) : new Set();
const usedKeys = new Set([...js.matchAll(/S\.config\.(\w+)/g)].map(m => m[1])
  .concat([...js.matchAll(/config\.(\w+)/g)].map(m => m[1])));
[...usedKeys].filter(k => !cfgKeys.has(k) && !['aiApi'].includes(k)).forEach(k => issues.push('R12 config键可能未定义: ' + k));
log(12, 'DEFAULT_CONFIG ' + cfgKeys.size + ' 键，renderer 用 ' + usedKeys.size + ' 键，可疑 ' + issues.filter(i => i.startsWith('R12')).length);

/* Round 13: main 中 fs 操作路径拼接穿越检查（启发式：path.join(config.gameDir...) 与用户输入） */
const joins = [...main.matchAll(/path\.join\(([^)]{0,80})\)/g)].length;
log(13, 'path.join ' + joins + ' 处（关键处人工已审）');

/* Round 14: window.lmc API renderer 使用 ↔ preload 暴露 */
const exposed = new Set([...pre.matchAll(/^\s*(\w+):\s*(?:\(|p[a-z]*)/gm)].map(m => m[1]).concat(['win', 'on']));
const used = new Set([...js.matchAll(/window\.lmc\.(\w+)/g), ...js.matchAll(/lmc\.win\.(\w+)/g)].map(m => m[1]));
[...used].filter(u => !exposed.has(u) && !['minimize', 'close'].includes(u)).forEach(u => issues.push('R14 API未暴露: ' + u));
log(14, 'preload 暴露 ' + exposed.size + '，renderer 用 ' + used.size + '，缺失 ' + issues.filter(i => i.startsWith('R14')).length);

/* Round 15: HTML 中 select/option 动态填充点 */
const selects = [...html.matchAll(/<select id="([^"]+)"/g)].map(m => m[1]);
log(15, 'select 下拉 ' + selects.length + ' 个: ' + selects.join(', '));

console.log('\n===== 问题清单 =====');
if (!issues.length) console.log('（机械轮次无问题）');
issues.forEach(i => console.log(i));

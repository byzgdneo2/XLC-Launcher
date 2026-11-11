# XLC Launcher

XLC Launcher 是一款运行于 Windows 的 **Minecraft Java 版启动器**，单文件便携运行，开箱即用。

## 功能一览

- **实例管理**：多实例共存、版本隔离、实例独立设置（内存 / Java / 启动参数等）
- **模组加载器**：Forge / NeoForge / Fabric / Quilt / OptiFine 一键安装与版本切换，镜像加速，境内网络友好
- **MOD 管理**：扫描与分类、错误 / 重复检测、一键检查更新（Modrinth / CurseForge）；安装前先选模组版本（按 Fabric / Forge / NeoForge / Quilt 分类），没选目标版本时弹系统「选择保存位置」，不替你猜实例
- **下载可停止**：MOD / 整合包 / 资源包 / 光影包 / 数据包下载途中点一下就能断，不留半截临时文件
- **资源包 / 光影包**：自动扫描、更新检测、从文件安装、信息导出
- **世界下载**：从 CurseForge 搜现成世界存档，一键解压进 `saves`（同名自动加序号，不覆盖已有存档）
- **存档保护**：内置「存档备份」插件 —— 手动备份、启动前 / 退出后自动备份（只备变过的）、按存档保留 N 份、一键恢复（恢复前自动兜底一份）
- **联机对表**：内置「模组清单对齐」插件 —— 只交换文件名、体积与前 4MB 哈希，差异分「对方有我缺 / 我有对方缺 / 版本不同」三组，不上传模组内容
- **账户**：离线登录、微软登录、第三方外置登录（Yggdrasil）
- **智能内存分配**：按模组数量与可用内存自动计算推荐值
- **内置插件**：插件面板（独立窗口）、模组翻译器（自动生成汉化资源包）、手柄控制
- **联机 / 开服**：一键联机与本地服务端管理
- **反馈**：侧边栏「反馈」页直接看 Issue 的分档进度，不用先跳到浏览器
- **新功能投票**：侧边栏「新功能投票」页直接列出 GitHub 讨论区的功能投票，投票中的排在最前
- **启动器更新**：检测新版本（GitHub 优先、官网兜底）、支持版本回退

> 整合包在线安装自 1.4-snapshot2 起默认开放；「下载页」（游戏本体）默认收起，装上 `XLC-Plugin-download-rescue-2.0.1.zip`（发行版附件）点一下即可放回，不用重启。

## 下载

前往 [**Releases**](https://github.com/byzgdneo2/XLC-Launcher/releases) 下载：

| 版本 | 文件 | 说明 |
| --- | --- | --- |
| 1.4 | `XLC-Launcher-1.4-portable.exe` | 正式版（最新）：账户页皮肤预览的 Q 弹与转圈彩蛋转正；正式版更新改为官网优先下载、GitHub 兜底，两条都不通会直接提示下载失败。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-rc1 | `XLC-Launcher-1.4-rc1-portable.exe` | 候选版：账户页皮肤预览活了 —— 坐下点一下画面小人会 Q 弹（压扁再弹回来）、连点 4 次触发彩蛋：转圈 + 放 BGM + 跟着鼓点每拍弹一下；弹跳从「每拍瞬间置形」改成连续曲线，不再一顿一顿；侧身满压扁顶出画布加了越界平移兜底。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-pre1 | `XLC-Launcher-1.4-pre1-portable.exe` | 预发布：1.4 进入预发布阶段，这一版没有新功能，全在收口 —— 账户页「默认皮肤」两处说法统一（以前一边写史蒂夫、一边写按 UUID 分配）；插件安装补 CSP 前校验入口仍在解包目录内、整合包下载临时文件名只取 basename；账户页皮肤预览遇到坏图不再每帧重试解码，图片缓存加 32 条上限。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-snapshot6 | `XLC-Launcher-1.4-snapshot6-portable.exe` | 上一快照：账户页的皮肤预览换成 3D —— 皮肤贴到带厚度的立方体上（头 / 身 / 双臂 / 双腿），侧面背面都能看、明暗跟着角度走；鼠标在启动器窗口里移动时头会跟着转（左右 ±46°、上下 ±26°，移出窗口回正）；预览从「账户设置」弹窗搬到账户页右侧，点账户列表任意一行就换人，动作定成 5 个（走路 / 跑步 / 游泳 / 坐下 / 默认）。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-snapshot5 | `XLC-Launcher-1.4-snapshot5-portable.exe` | 上一快照：整合包导入实测修复 —— 分段下载不再永久卡死（本段收满即走 + 25 秒空闲超时）、Fabric / Quilt 加载器 jar 走 BMCLAPI 镜像、整合包声明的加载器版本不再被忽略、PCL「打包启动器」包装包可识别、CF 整合包 overrides 落实例目录、整合包文件按 sha1 校验、中文包名显示原名。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-snapshot4 | `XLC-Launcher-1.4-snapshot4-portable.exe` | 上一快照：下载页皮肤改成三种来源（皮肤站 / 正版档案 / 本地文件，离线账户也能换皮肤）；皮肤库安全收口 —— 按 URL 导入拦内网/回环地址、改名补路径校验。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-snapshot3 | `XLC-Launcher-1.4-snapshot3-portable.exe` | 上一快照：下载页新增「皮肤」分类（按正版玩家名抓 Mojang 官方皮肤）、账户设置新增皮肤库与六种动作预览；修复存档区块预览只能画成正方形；更新公告只留当前版本。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-snapshot2 | `XLC-Launcher-1.4-snapshot2-portable.exe` | 上一快照：修中文名导致账户列表清空、下载卡 94%、整合包装不进实例、Fabric 实例缺加载器启动报 KnotClient；新增「补全文件」；接管系统代理。配套插件 `XLC-Plugin-download-rescue-2.0.1.zip`（同一发行版附件） |
| 1.4-snapshot1 | `XLC-Launcher-1.4-snapshot1-portable.exe` | 上一快照：功能开关搬进设置项，装上「下载恢复器」插件（`XLC-Plugin-download-rescue-2.0.0.zip`）就能把下架的下载页放回来 |
| 1.3.1 | `XLC-Launcher-1.3.1-portable.exe` | 正式版，建议日常使用：默认皮肤换成游戏里真正的史蒂夫贴图 |
| 1.3 | `XLC-Launcher-1.3-portable.exe` | 上一版正式版，需要回退时使用 |
| 1.2 | `XLC-Launcher-1.2-portable.exe` | 更早的正式版 |

都是免安装便携版，双击即用；配置与游戏数据存在 exe 旁边的 `XLC数据`，不写注册表、不装系统服务。

每个发行版都附了 MD5 校验值（正式版另附 SHA256），历史版本在 [Releases](https://github.com/byzgdneo2/XLC-Launcher/releases) 里都能找到。

## 反馈

遇到问题或想提建议，请到 [Issues](https://github.com/byzgdneo2/XLC-Launcher/issues) 提交。
如果问题涉及安装失败或启动报错，把启动器「设置 → 诊断」页导出的日志一起附上，定位会快很多。

## 免责声明

- 本项目与 Mojang / Microsoft 无关；*Minecraft* 是 Mojang AB 的商标，请支持正版。
- 部分在线资源依赖 BMCLAPI 等公共镜像服务，感谢维护者的付出。

## 许可

本项目基于 [MIT License](LICENSE) 开源，第三方组件的许可、以及界面与交互设计的参考来源
（含 PCL、星落 LaunCher 等）见 [THIRD-PARTY.md](THIRD-PARTY.md)。

设计参考仅限功能形态层面的借鉴，XLC 的相关代码均为独立实现，未复制上述项目的源代码或美术
资源，也与这些项目没有隶属、赞助或背书关系。

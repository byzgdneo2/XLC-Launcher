# 第三方组件与致谢 / Third-Party Components & Credits

Xero Lite Craft Launcher（XLC）自身代码以 [MIT 许可](LICENSE) 发布。
程序中使用或随程序分发的第三方组件适用其各自的许可条款，列明如下。

XLC 是独立开发的第三方启动器，**并非** Minecraft 官方产品，与 Microsoft、Mojang
Studios 或下列任何项目均无隶属、赞助或背书关系。

---

## 1. Terracotta（陶瓦联机）

- **用途**：联机页 / 控制台「外网联机」的 P2P 联机后端（基于 EasyTier）。
- **作者与来源**：burningtnt 及贡献者 · <https://github.com/burningtnt/Terracotta>
- **许可**：GNU Affero General Public License v3.0 or later，并附 **Terracotta 例外条款**。
- **在 XLC 中的使用方式**：
  - **不再随安装包分发二进制**。程序首次打开时不会自带联机核心；用户第一次使用联机功能
    （联机页 / 控制台「外网联机」）时，点「下载陶瓦联机组件」由程序从上游 GitHub Releases
    （带国内镜像加速）下载**未经修改**的官方二进制，存放在数据目录 `XLC数据/terracotta/`。
    XLC 不对其二进制做任何修改。
  - 安装包内只保留许可正文（`terracotta/LICENSE.txt`），不再打包 exe。
  - 通过与它提供的**本地 HTTP 接口**交互（启动房间、查询状态等），未静态或动态链接。
- **许可合规**：上述用法分别落在其例外条款的两项豁免范围内 ——「打包未修改的二进制且
  不链接」以及「通过进程间通信接口交互」。按例外要求，XLC 已在**联机页**及**设置 →
  开源许可与致谢**处标识本作品的版权信息。例外条款原文（引自上游 README「许可」一节）：

  > **AGPL 的例外情况:**
  >
  > 作为特例，如果您的程序通过以下方式利用本作品，则相应的行为不会导致您的作品被 AGPL 协议涵盖。
  > 1. 您的程序通过打包的方式包含本作品未经修改的二进制形式，而没有静态或动态地链接到本作品；或
  > 2. 您的程序通过本作品提供的进程间通信接口（如 HTTP API）与未经修改的本作品应用程序进行交互，且在您的程序用户界面明显处标识了本作品的版权信息。

- **许可正文**：AGPL-3.0 的完整正文随程序分发，位于 `terracotta/LICENSE.txt`（与上游
  仓库 LICENSE 文件逐字一致）；打包版首次运行时会被释放到数据目录
  `XLC数据/terracotta/LICENSE.txt`。也可在程序内**设置 → 开源许可与致谢**中阅读。

## 2. authlib-injector

- **用途**：离线账户自定义皮肤。作为 Java Agent 注入游戏 JVM，把皮肤查询重定向到
  XLC 本地启动的、只监听 `127.0.0.1` 的临时 Yggdrasil 兼容服务。
- **作者与来源**：yushijinhun 及贡献者 · <https://github.com/yushijinhun/authlib-injector>
- **许可**：GNU Affero General Public License v3.0 or later，并附 **"AUTHLIB-INJECTOR" 例外条款**。
- **在 XLC 中的使用方式**：
  - **不随安装包分发**，首次使用时下载到数据目录（`XLC数据/authlib-injector.jar`）。
  - 以 `-javaagent:` 方式加载进 JVM；并通过其 HTTP API 与被注入方交互。
- **许可合规**：其例外条款**明确列出**这两种用法（作为 Java Agent 加载、通过进程间
  接口交互）不会导致使用方程序被 AGPL 涵盖。XLC 的用法完全落在例外范围内。

## 3. Mod 中文名数据库（`data/mod-zh-db.json`）

- **用途**：离线显示模组中文名、以及中文关键词搜索。
- **来源**：由 PCL2 内置 MC 百科数据库（`PCLCS/Resource/WikiEntries.txt`）转换而来
  · <https://github.com/Meloong-Git/PCL>
- **上游许可**：PCL2 采用**《PCL 分发有限许可》与《PCL 存储库合理使用指南》**
  （见其仓库 LICENCE 文件；**不是**标准的 LGPL-3.0 / MIT）。按该指南的**轻度使用**条款
  处理：给出署名（本文件与数据文件内的 `_note` 字段）、不与 PCL 混淆或暗示关联。
- **说明**：数据内容以模组名称、数字 ID 与中文译名等**事实性条目**为主；XLC 对其做了
  格式转换（key = Modrinth/CurseForge slug 或 modid），并另行补充了部分国内常用别名。

## 4. Minecraft 游戏内贴图（版本列表的方块图标）

- **用途**：版本列表中标识版本类型的方块图标 —— 正式版 = 草方块侧面
  （`grass_block_side.png`）、快照 = 命令方块正面（`command_block_front.png`）、
  远古版 = 圆石（`cobblestone.png`）。
- **来源**：直接提取自 **Minecraft 客户端 jar** 内的
  `assets/minecraft/textures/block/` 原版贴图（与 PCL、HMCL 等同类启动器的做法一致）。
- **版权**：© Mojang Studios / Microsoft。这些图像是 Minecraft 游戏资产，按
  [Minecraft 使用指南](https://www.minecraft.net/usage-guidelines)仅作为
  **非商业粉丝工具**的一部分随程序分发使用，未做修改（仅整体缩放显示）。
  不得将提取结果单独用于商业用途。
- **提取方式**：见 `tools/extract-block-icons.js`（从本机安装的游戏客户端 jar 提取，
  命令方块取动画第 0 帧，最近邻放大 4 倍）。

## 5. 在线翻译服务（模组翻译器 / 资源简介翻译）

XLC 的「模组翻译器」（内置插件）与资源详情页的简介翻译，会把待翻文本发送给下列**在线服务**
换取译文。XLC 不随包分发这些服务的任何代码或数据；译文只用于本机显示或生成本地资源包。

- **MyMemory**（默认通道）· <https://mymemory.translated.net/>
  - **用途**：模组语言文件英→中翻译（默认通道）、资源简介英→中翻译。
  - **接口**：官方公开文档的 REST API（`/get`，见 <https://mymemory.translated.net/doc/spec.php>），
    免密钥；请求带 `de` 联系方式，便于对方在异常流量时联系我们。
  - **额度**：官方说明为「匿名 5,000 字符/天；提供有效邮箱 50,000 字符/天」
    （<https://mymemory.translated.net/doc/usagelimits.php>）。XLC **不做任何绕过额度的处理**：
    额度用完即停止本轮翻译并如实告知，已翻内容仍会写进资源包。
  - **署名**：翻译面板底部标注「翻译由 MyMemory 提供」；本条即为其署名说明。
  - **条款**：<https://mymemory.translated.net/terms-and-conditions>
- **Bing 网页翻译接口**（备用通道，**默认关闭**，须用户在面板里手动勾选）
  - **用途**：仅在用户主动启用后，作为 MyMemory 额度用完时的备用翻译来源。
  - **性质**：这是 Bing 翻译网页自用的接口，**不是微软对外提供的开放 API**，没有可用性承诺，
    也不在微软公开 API 的许可范围内；调用时使用该网页自身向浏览器下发的短时令牌（令牌由页面
    公开给出），XLC 不对其做解密或签名伪造。
  - **由用户自行决定是否启用**，可能随时失效；XLC 对其可用性与译文准确性不作担保。
    不希望使用该通道的用户保持默认关闭即可。

## 6. 其他依赖

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [https-proxy-agent](https://github.com/TooTallNate/proxy-agents) | MIT | 开发期依赖，**运行时不加载**（代码里没有 require；保留在 dependencies 里属于历史遗留，许可宽松，随包存在也不执行） |
| [Electron](https://github.com/electron/electron) | MIT | 应用运行时（由 electron-builder 打包）；**系统代理跟随由它自带的 Chromium 网络栈提供** |
| [Chromium](https://www.chromium.org/) | BSD-3-Clause 等 | Electron 内含 |
| [Node.js](https://nodejs.org/) | MIT | Electron 内含 |

---

## 功能与交互设计参考 / Design References

XLC 在若干界面与交互上参考了同类启动器的公开设计与通用做法。以下项目仅作为**功能与
交互设计的参考来源**致谢；XLC 为独立实现，**未复制其源代码**，亦不代表与这些项目存在
任何关联或获得其背书：

- **PCL / Plain Craft Launcher 2**（<https://github.com/Meloong-Git/PCL>）—— 设置项分类
  组织、实例（版本）设置的分组与选项、导出整合包的选项清单与规则语义、社区资源列表的
  标题/副标题拆分规则等。
- **authlib-injector 项目文档**（<https://github.com/yushijinhun/authlib-injector/wiki>）——
  本地 Yggdrasil 兼容服务的接口规范（元数据、批量资料查询、会话资料、纹理下载、
  `signaturePublickey` 与 RSA-SHA1 签名）依据其公开文档实现。
- **Minecraft 社区长期通行的做法** —— 本地回环地址上的临时皮肤服务、按内容 sha256
  寻址的纹理缓存等。

---

如你是上述某个项目的权利人，认为本文件的标注有误或希望调整署名方式，请通过项目发布
渠道与我们联系，我们会尽快处理。

# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效的规则/红线/决策/凭据；事件经过留 `YYYY-MM-DD.md`。

## 项目身份
「青春幻想引擎」小说创作应用。Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储后端(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。managed node `C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`。当前 1.9.9。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。

## 最高红线
1. 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。
2. 提交信息含 `!` 用 `git commit -F <文件>`（-m 被 bash 历史吃 `!XXX`）。main 无远程。
3. 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
4. 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
5. 服务器属主：`/var/lib/yfe` 须 www-data；sudo 写后必 `chown www-data:www-data` + `sudo -u www-data test -w` 实测，否则 push 静默失败。

## 封装流程
- 前置：tsc0错+build0错+改动落盘 → 升 version → 封装。G盘 safe-delete 拦 rmSync/emptyOutDir → build 前 Node `renameSync` 移开 `dist`/`dist-web`。
- 顺序：便携 `build:portable` → 网页 `build:web` → 桌面 `build:desktop`（脚本自带 dist 移开+唯一输出目录，eb-cache 命中约 30 秒）。
- 产物验证（三处一致才真上线）：便携查单文件 HTML；桌面查 `release/desktop-out-<ver>-<ts>/win-unpacked/resources/app.asar`（须含 IPC 桥 `chooseSyncDir`/`sync:read`/`sync:write`/`contextBridge`）；线上 grep `/var/www/yfe/assets/*.js`。exe 元数据用 node 读 buffer 搜 utf16le `青春幻想引擎开发组`/`Copyright © 2026`（electron-builder 报 `rcedit Unable to commit changes` 非真失败）。
- ⚠️ **scp 套娃坑（2026-09-01 真事故）**：`scp -r dist-web → /tmp/yfe-web-<日期>` 在目标已存在时会塞成子目录 `.../dist-web/`，外层仍是旧货——只查字符串发现不了。预防：上传前先 `ssh rm -rf /tmp/<目标>`。**判定上线的硬标准＝外部 `curl -sk https://154.8.178.240/` 取 index.html 比对 chunk 名**。
- 网页版部署：`scp`→`/tmp/yfe-web-<日期>` → `sudo mv /var/www/yfe /var/www/yfe.bak-<ts>` → `cp -r <真目录> /var/www/yfe` → `chown -R www-data:www-data`+`chmod 755` → 线上 grep → 外部 curl 验 chunk → 清 `/tmp/yfe-web-*`。
- **验证构建别污染交付产物**：`npx vite build --config vite.config.<web|portable>.ts --outDir dist-<名字>-check --emptyOutDir`，验完移入 `G:\AI软件\.cleanup-quarantine\<日期>-<名字>`。
- ⚠️ **dev 看不到桌面端 UI**：vite.config.ts 的 `__PORTABLE__/__WEB__` 皆 false，`DESKTOP` 靠运行时探测 `window.electronStore`，浏览器恒 false → `CLOUD_FILE_SYNC=false`。验收须封装，或用便携版 HTML。
- ⚠️ **安装弹「XX无法关闭，请手动关闭它然后点击重试」= NSIS 万能误导文案**，与"程序没关"无关。3 个真实触发点（`app-builder-lib/templates/nsis/`）：`allowOnlyOneInstallerInstance.nsh:110`/`extractAppPackage.nsh:116`/`installUtil.nsh:219`。**首解＝右键管理员身份运行**（实测一次通过）。
- dev 报 `[safe-delete] node_modules/.vite/deps`：移开 `node_modules/.vite` 重启。Edit 偶发静默失败→改完必 tsc+抽查。

## 工作区清理
- 先只扫报告(路径+体积)，老大圈定才动手。垃圾源：`dist*` 临时构建、`release/desktop-out-*`（单次 350MB 级，时间戳目录越攒越多）。
- 🔴 **只用 Move-Item，别用 Remove-Item**：删除受 safe-delete 钩保护（走 trash，被锁时报 `[safe-delete][SAFE_DELETE_FAIL_CLOSED]` 直接失败）。隔离区 `G:\AI软件\.cleanup-quarantine\<日期时间戳>\`。老大明说「删除」才真删。
- ⚠️ `desktop-out-*/win-unpacked/resources/app.asar` 常被 `QQPCRTP.exe`(管家) 锁句柄：`attrib -R -S -H`/`Remove-Item`/`[IO.File]::Delete`/`robocopy /MIR`/`Rename-Item` **五法全败**，重启后才删得掉（不影响新构建）。2026-09-01 晚管家自己出手清掉了。已备 `npm run cleanup`（`scripts/cleanup-residual.mjs`，白名单只删 `desktop-out-*`，被占用如实报错+退出码1；**须在系统终端跑**，老巴迪环境内会被 safe-delete 拦）。
- Windows 终端工具本环境**不回显 stdout** → 要输出就写文件再 Read；从 bash 反向调终端宿主会被安全策略拦截。
- 清理后 `release/` 正常水位 ≈ 195MB（`eb-cache` 106M + 桌面交付 81M + 便携 8.5M）。保留红线：`eb-cache`、`你需要的文件在这里/`、`桌面安装版/`、`novel-studio-<ver>/`。清完必 `git status` 确认无 D 项。

## 架构红线
- **无 i18n 基建**（全中文硬编码）。三大前置坑：①schema 列名即存储键（卡片键=`模块名::字段名`）→ 翻译毁存量数据；②约 380 处中文参与逻辑判断（`=== '大纲规划'`、`!== '已退场'`）；③用户自定义选项不可译。可直译 1922 条（UI 1452+逻辑 470），内容数据 5535 条不该译。全量 20-30 人日、仅 UI 12-18 人日。
- 按卷建表 `chapter-vol-<vid>`；聚合 `db.getAllChapterLedgerRows()`；章节号全局连续 `migrateChapterNumbering`。顺序以 `chapterSeq.ts` 唯一权威（派生不落库）。
- 下拉选项用 `resolveOptions(col.options, getCustomOptions())`，禁直接 `col.options`。`!tabVisible` 只守卫 return/隐页签。
- `WEB` 由 `__WEB__` 决定（仅 vite.config.web.ts 为 true），禁写 `!PORTABLE && !DESKTOP`。顶层副作用双守卫：①平台 `if(WEB&&...)`；②功能 `if(!code)return`（#023 c0275f3）。
- ⚠️ **tree-shake 陷阱**：组件若只在某平台门控分支（如 `{WEB && <X/>}`）被引用，其余平台会把整模块连内部所有 UI 一起摇掉。渲染门控必须是「需要该模块的平台之并集」（如 `WEB || CLOUD_FILE_SYNC`）。曾致桌面/便携版云盘同步整段消失（已修）。
- **左下角只准有一个浮层**（#032）：历史 `DesktopBadge`(bottom-3 z-50) 与 WebTools(bottom-4 z-40) 差 1px/差 10 层互相盖。现统一 `DataDock`（项目管理页，等宽 15rem、控件 h-8、分隔线分区、单一 z-40）；**项目内禁用全局 fixed 浮层**（会压住侧栏「界面缩放/主题」），一律内嵌 `Sidebar Footer`。

## 桌面版数据存储（2026-09-01 实测）
- 路径 `C:\Users\<用户>\AppData\Roaming\novel-studio\novel-studio-data.json`（目录名取 package.json `name`，**非** electron-builder 的 `productName`）。**整库一个 JSON**，防抖 800ms，每次 put/del/bulk 全量重写，main.cjs 用 `fsp.writeFile` **直接覆盖非原子**（云盘同步的 `sync:writeFile` 反倒是 tmp+.bak+rename 原子写）。
- 该目录**混装 Electron 运行时文件**：`Cache` 13M+`GPUCache` 1.6M+各种缓存共约 15M，以及 `Local Storage/leveldb`（含 `LOCK`/`CURRENT`/`MANIFEST-000001`，Chromium 独占锁）。真数据仅约 756K。
- ⚠️ **「让 WPS 云盘直接同步整个目录」不可取**：①leveldb 独占锁跨设备覆盖会损坏（Electron 重建 localStorage，丢主题/缩放/同步设置）；②15M 缓存白同步；③数据文件非原子写，云盘抓到半截 JSON → 另一台解析失败→**空库启动**（desktop.ts 容错即「损坏则以空库启动」，用户会以为数据没了）；④文件级覆盖无合并，双机同时改＝**整库级**丢失。
- 可行折中（待拍板）：给桌面版加「自定义数据文件位置」，把**单个 JSON** 指到 WPS 同步目录下的干净子目录（只同步 756K、避开运行时雷区），同时写盘改原子写。仍无法解决④（WPS 是文件级同步，我们介入不了它的合并）。

## 同步方案与同步码规则（#032 定案）
- **一句话判据：过我们的服务器→要码；走用户自己的网盘→不要码。** 服务器方式码身兼两职（HTTP 鉴权换槽位 + AES 密钥）；云盘方式不过服务器，改用内置常量 `DEFAULT_CLOUD_KEY='YFE-CLOUD-FILE-SYNC-V1'`（在 `syncTransport.ts`）。固定同步文件名 `CLOUD_FILE_NAME='青春幻想引擎-同步数据.yfe'`。
- 三端：桌面/便携=只有云盘模式、选目录即开启、无码；网页版 `WebTools` 可切「服务器(要码 `yfe-sync-code`) / 云盘文件(不要码 `yfe-web-file-sync-on`+目录句柄)」。
- 无码代价必须写进 UI：密钥是公开源码常量，强度等同「混淆」，防明文扫描与误看、不抗蓄意破解，勿放公开共享目录。
- 桌面端 IPC 约束：`contextIsolation:true`+`nodeIntegration:false`，渲染进程不能 `require('fs')`，所有文件 IO 走 `window.electronStore`（`sync:readFile`/`sync:writeFile`/`sync:chooseDir`）。桌面端是**真·零服务器方案**；网页版进门（`/api/invite/check`）仍依赖我们的服务器，云盘中转只去中心化「数据同步」没去中心化「进门」。
- WPS 云盘：支持任意文件夹实时双向同步（免费档限 1 文件夹/1GB/单文件≤10MB，路径须用户自选不可硬编码）。沿用 #030「空推拒绝 + 原子写 .bak」防护。老大判断：其他云盘功能不明，**内置云盘同步继续保留开发**。

## 种子数据
- 卡片 data 键=`模块名::字段名`、表格行键=schema 列名，写错不报错整组静默空白。改种子必跑 `node tests/seed-schema-check.mjs`。
- 统计条数先确认字面量还是循环生成（`grep -c` 会漏）。进度/热力图日期用 `todayKey()` 动态「距今N天前」。

## 按钮体系(Button.tsx)
套尺寸：primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；不套：bare/toggle-text。档位 xs(h-6)→sm(h-8)→md(h-9默认)→lg(h-10)。裸图标传 `iconOnly`。审计 JSX 不用 indexOf('>')（箭头 `=>` 误截断），判据「>前字符≠=」。

## 主题系统
换肤 `<html data-theme>`+index.css 变量，组件零改。8套(深浅各4)：暗夜/护眼/午夜蓝/羊皮卷/暮山紫/青花/松烟墨/桃笺；浅色4=护眼/羊皮卷/青花/桃笺。
浅色 ink 刻度反向(950最浅/50最深)；850分隔线比800深一档。CSS 压缩去引号 `[data-theme=x]`。
⚠️ 浅色禁低透明度 amber 表数据(护眼1.57/羊皮卷1.48 远低于3:1会隐形)；靠色传达数据用实色 `bg-amber`，最低 `/40`。排查用 agent-browser eval 取 getComputedStyle 算 WCAG。

## AI 接入
颉文姬5模式 clinic/edit/review/brief/ledger；模型硅基流动 deepseek-ai/DeepSeek-V3.2。明文本地记忆勿公开。

## 网页版与服务器
网页版零后端可跑(idbOps)、邀请制。服务器 `154.8.178.240`(腾讯云轻量 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口 **22**)；ubuntu+免密sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`(www-data:3000，数据 `/var/lib/yfe`)。改服务端：`scp`→`/tmp`→`sudo cp`→`chown www-data:www-data`→`systemctl restart yfe-feedback`；nginx 改后 `nginx -s reload`。HTTPS 自签 `/etc/ssl/yfe`；安全上下文 AES-GCM(`a1:`) / HTTP 降级 XOR(`x1:`)。2.0 测试期自签 HTTPS+IP 访问，绑域名 qchxengine.cn+备案等测试后。
serverStore 走 StoreOps `fetch /api/sync`，800ms 防抖，rev 守卫，排除 meta 的 AI 配置；同步码独立槽位 `sync-<sha256>.json`。入门码 `YFE-D49E-6MPG`、已分发 `YFE-SYNC-N6SV-2YZJ`(田馨)、老大 `YFE-SYNC-7Q3K-2X9M`(ADMIN)。

## 服务器巡检
日志 `/var/lib/yfe/access.jsonl`(act: enter/reject/pull/push/authfail/conflict/rate-limited)、`feedback.jsonl`(附件 fb-<id>.bin)。每日 automation `automation-1787973377664` → `docs/服务器访问记录.md`/`docs/服务器反馈记录.md`。
实操：ts=UTC 按本地+8h 分组；概览表全量重算(独立IP重叠不可累加/Math.max)；追加非重建；先枚举 act 值防「未知动作」；脚本结论人工复核。要点段手写，时间同样 +8h(极易抄成 UTC)；08-29 基准行 21/1/8/21/20 可作全量重算自校验。
`bad` 字段判官：`bad=null`⇒请求无 Authorization(非输错码)；`bad` 有值可反算身份——本地 sha256(候选码) 取前12位比对(已据此认出「入门码当同步码」)。排障：日志 `push ok`≠落盘，须核槽位 rev/mtime。
已部署：#027 门禁码归一化（服务端 `normCode()`+前端 `WebGate`/`WebTools` 同款，槽位=sha256(码) 幂等，commit `bf4f704`/`3f1c082`）；#026 同步瘦身+按码配额(普通 50MB/ADMIN 450MB，超限 413)+每日滚动备份 `__cloudBackup`+「从云端备份恢复」。

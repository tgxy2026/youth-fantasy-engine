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

## 封装与部署
- 前置：tsc0错+build0错+改动落盘 → 封装。G盘 safe-delete 拦 rmSync/emptyOutDir → build 前 Node `renameSync` 移开 `dist`/`dist-web`。
- 顺序：便携 `build:portable` → 网页 `build:web` → 桌面 `build:desktop`（脚本自带 dist 移开+唯一输出目录，eb-cache 命中约 30 秒）。
- 验证三处一致：便携查单文件 HTML；桌面查 `release/desktop-out-<ver>-<ts>/win-unpacked/resources/app.asar`（须含 IPC 桥 `chooseSyncDir`/`sync:read`/`sync:write`/`contextBridge`）；线上 grep `/var/www/yfe/assets/*.js`。exe 元数据用 node 读 buffer 搜 utf16le `青春幻想引擎开发组`/`Copyright © 2026`（`rcedit Unable to commit changes` 非真失败）。
- ⚠️ **scp 套娃坑**：`scp -r dist-web → /tmp/yfe-web-<日期>` 目标已存在时会塞成子目录，外层仍是旧货。预防：上传前 `ssh rm -rf /tmp/<目标>`。**判定上线硬标准＝外部 `curl -sk https://154.8.178.240/` 取 index.html 比对 chunk 名**。
- 网页部署：`scp`→`/tmp/yfe-web-<日期>` → `sudo mv /var/www/yfe /var/www/yfe.bak-<ts>` → `cp -r <真目录> /var/www/yfe` → `chown -R www-data:www-data`+`chmod 755` → 验 chunk → 清 `/tmp/yfe-web-*`。
- 验证构建别污染交付：`npx vite build --config vite.config.<web|portable>.ts --outDir dist-<名字>-check --emptyOutDir`，验完移入 `G:\AI软件\.cleanup-quarantine\<日期>-<名字>`。
- ⚠️ dev 看不到桌面端 UI：vite.config.ts 的 `__PORTABLE__/__WEB__` 皆 false，`DESKTOP` 靠运行时探测 `window.electronStore`，浏览器恒 false → `CLOUD_FILE_SYNC=false`。验收须封装或用便携版 HTML。
- ⚠️ 安装弹「XX无法关闭，请手动关闭它然后点击重试」= NSIS 万能误导文案，与"程序没关"无关。**首解＝右键管理员身份运行**。
- dev 报 `[safe-delete] node_modules/.vite/deps`：移开 `node_modules/.vite` 重启。Edit 偶发静默失败→改完必 tsc+抽查。

## 工作区清理
- 先只扫报告(路径+体积)，老大圈定才动手。垃圾源：`dist*` 临时构建、`release/desktop-out-*`（单次 350MB 级）。
- 🔴 **只用 Move-Item，别用 Remove-Item**：删除受 safe-delete 钩保护（走 trash，被锁报 `[SAFE_DELETE_FAIL_CLOSED]` 直接失败）。隔离区 `G:\AI软件\.cleanup-quarantine\<日期时间戳>\`。老大明说「删除」才真删。
- ⚠️ `desktop-out-*/.../app.asar` 常被 `QQPCRTP.exe`(管家) 锁句柄，五法全败（attrib/Remove-Item/IO.File.Delete/robocopy/Rename-Item），重启或等管家自清。已备 `npm run cleanup`（`scripts/cleanup-residual.mjs`，白名单只删 `desktop-out-*`，**须在系统终端跑**）。
- Windows 终端工具本环境**不回显 stdout** → 要输出就写文件再 Read；从 bash 反向调终端宿主被安全策略拦。
- 清理后 `release/` 水位 ≈ 195MB（eb-cache 106M+桌面 81M+便携 8.5M）。保留：`eb-cache`、`你需要的文件在这里/`、`桌面安装版/`、`novel-studio-<ver>/`。清完必 `git status` 确认无 D 项。

## 架构红线
- **无 i18n 基建**（全中文硬编码）。三大坑：①schema 列名即存储键（卡片键=`模块名::字段名`）②约 380 处中文参与逻辑判断③用户自定义选项不可译。全量 20-30 人日、仅 UI 12-18 人日。
- 按卷建表 `chapter-vol-<vid>`；聚合 `db.getAllChapterLedgerRows()`；章节号全局连续 `migrateChapterNumbering`。顺序以 `chapterSeq.ts` 唯一权威（派生不落库）。
- 下拉选项用 `resolveOptions(col.options, getCustomOptions())`，禁直接 `col.options`。`!tabVisible` 只守卫 return/隐页签。
- `WEB` 由 `__WEB__` 决定（仅 vite.config.web.ts 为 true），禁写 `!PORTABLE && !DESKTOP`。顶层副作用双守卫：①平台 `if(WEB&&...)` ②功能 `if(!code)return`（#023 c0275f3）。
- ⚠️ **tree-shake 陷阱**：组件若只在某平台门控分支（如 `{WEB && <X/>}`）被引用，其余平台会把整模块连内部 UI 一起摇掉。渲染门控必须是「需要该模块的平台之并集」（如 `WEB || CLOUD_FILE_SYNC`）。曾致桌面/便携云同步整段消失（已修 077d097）。
- **左下角只准一个浮层**（#032）：现统一 `DataDock`（项目管理页，等宽 15rem、控件 h-8、分隔线分区、单一 z-40）；**项目内禁用全局 fixed 浮层**（会压住侧栏「界面缩放/主题」），一律内嵌 `Sidebar Footer`。

## 桌面版数据存储
- 路径 `C:\Users\<用户>\AppData\Roaming\novel-studio\novel-studio-data.json`（目录名取 package.json `name`，**非** productName）。**整库一个 JSON**，防抖 800ms，每次 put/del/bulk 全量重写。
- 该目录**混装 Electron 运行时文件**：Cache/GPUCache 等约 15M，以及 `Local Storage/leveldb`（含 LOCK/CURRENT/MANIFEST，Chromium 独占锁）。真数据仅约 756K。
- ⚠️ **「让 WPS 云盘直接同步整个目录」不可取**：①leveldb 锁跨设备覆盖会损坏（丢主题/缩放/同步设置）②15M 缓存白同步③数据非原子写，云盘抓半截 JSON → 另一台解析失败→**空库启动**④文件级覆盖无合并，双机同时改＝**整库级**丢失。
- #033 已实施（da27a18）：`electron/main.cjs` 的 `dataFile()` 读 `data-location.json`（存 userData）支持自定义路径；写盘改 `writeAtomicSync`/`writeAtomic` 原子写（刻意不留 .bak，避免云盘流量翻倍）；IPC 新增 `store:chooseDataDir`/`setDataPath`（目标存在则「改用那份」，供第二台接管）/`resetDataPath`/`isCustomPath`。`src/lib/desktop.ts` 扩展 `chooseDesktopDataDir`/`relocateDesktopDataFile`/`resetDesktopDataPath`。

## 便携版写盘（FSA）— ⚠️ 别再误判原子性
- `src/lib/portable.ts` 的 `flush()` 用 FSA `createWritable()` → `write()` → `close()`。**这本身就是 swap file 语义**（MDN：写入期间目标文件不动，仅 `close()` 时用临时文件整体替换；Chrome/Edge 落地为 `.crswap`）。写到一半拔 U 盘，最坏＝留一个 `.crswap` + 数据退回上一次成功写入的版本，**不会**产生半截 JSON 导致「数据文件已损坏」。
- 🔴 **不要在便携版重复实现 tmp+rename 原子写**——那是桌面版 IPC `writeAtomic` 的做法，便携版不需要。2026-09-02 关服前审计曾据此误判为 P0「会损坏数据文件」，查 MDN 后推翻；结论已写进 `flush()` 上方注释。
- 真正薄弱点＝**最后一批编辑来不及落盘**：FSA 只有异步 API，页面真卸载后未完成的 `await` 被直接中断（桌面版有 `flushDesktopSync()` 同步阻塞写，便携版做不到）。已修（#034 / 提交 315d472）：新增 `flushNow()`（先清防抖定时器再立即写）+ `App.tsx` 增 `visibilitychange(hidden)` / `pagehide` 监听（二者在关闭·刷新·切标签前触发且页面仍存活）。**属尽力而为、非保证**——`saving=true` 时关页面仍会丢该批，UI 显示「保存出错，点击重试」+ toast，不静默失败。

## 关服与 2.0 只发桌面/便携版（2026-09-02 老大决策）
- 方向：**2.0 正式版只对外发布桌面版 + 便携版，网页版后续关闭**。桌面/便携**零联网**（三个 API 全被 `WEB &&` 门控，tree-shake 掉；Electron 主进程无 electron-updater/无遥测），关服对两版功能零影响。
- 混淆是最后一道不是唯一一道。老大裁定结果：P0-1 便携版写盘→**已修**（见上）；P0-2 网页版存量用户导出公告→**待办 #031**；P0-3 `AboutPage` 的 `LATEST_VERSION_URL` 填网盘链接→**待办 #032**（现在为空字符串、区块不渲染，是关服后唯一的新版入口）；P0-4 代码签名证书→**忽略**（成本太高）；P1-5 打赏致谢名单→**继续占位**（无人打赏）；P1-6 桌面/便携反馈入口→**忽略**（走关于页联系方式）；P1-7 docs 清理→**忽略**（发视频时服务器还在）；P1-8 服务器资产处置→**待办 #033**（等服务器到期再处理，须在 #031 宽限期之后）。
- ⏰ **提醒义务**：老大做功能介绍视频时，老巴迪要主动提醒一次「网页版关服前得上导出公告弹窗」（#031 的触发条件）。

## 同步方案与同步码（#032 定案）
- **判据：过我们的服务器→要码；走用户自己的网盘→不要码。** 服务器码身兼两职（HTTP 鉴权换槽位 + AES 密钥）；云盘方式不过服务器，改用内置常量 `DEFAULT_CLOUD_KEY='YFE-CLOUD-FILE-SYNC-V1'`（`syncTransport.ts`）。固定文件名 `CLOUD_FILE_NAME='青春幻想引擎-同步数据.yfe'`。
- 三端：桌面/便携=只有云盘模式、选目录即开启、无码；网页版 `WebTools` 可切「服务器(要码 `yfe-sync-code`) / 云盘文件(不要码 `yfe-web-file-sync-on`+目录句柄)」。
- 无码代价必须写进 UI：密钥是公开源码常量，等同「混淆」，防明文扫描与误看、不抗蓄意破解，勿放公开共享目录。
- 桌面端 IPC：`contextIsolation:true`+`nodeIntegration:false`，渲染进程不能 `require('fs')`，文件 IO 全走 `window.electronStore`（`sync:readFile`/`sync:writeFile`/`sync:chooseDir`）。桌面端是**真·零服务器方案**；网页版进门（`/api/invite/check`）仍依赖我们的服务器。
- WPS 云盘：支持任意文件夹实时双向同步（免费档限 1 文件夹/1GB/单文件≤10MB，路径须用户自选）。沿用 #030「空推拒绝 + 原子写 .bak」防护。老大判断：其他云盘功能不明，**内置云盘同步继续保留开发**。

## 🔴 跨设备同步两条路径 + 「架空」陷阱（必读）
- **两条路径二选一，绝对不要同时指向同一目录**（`.yfe` 与 `novel-studio-data.json` 两套机制会打架）：
  1. **内置云盘同步**（推荐，多设备/有并发）：数据坞→云盘文件同步→选目录。加密 + rev 合并 + 原子写，8 秒轮询三路合并（本地优先）。
  2. **#033 更改数据文件位置**（单机轮流/图省事）：数据坞→本机存储→更改位置，把单个 JSON 挪进网盘目录，由网盘做**文件级整库覆盖、无合并**。
- ⚠️ **「架空」陷阱（最易被误判为丢数据）**：`db.ts` 的 `enableDesktopCloudSync` 只在 `rev===0 && stores 空` 时才 `seedDesktopFromLocal` 播种本地数据。云盘已有数据则第二台本地原稿**不被播种**，UI 读云盘那份 → 用户以为稿子没了。但**本地 JSON 仍在磁盘没被删**——**救法＝关闭云盘同步即切回本机存储**。任何面向用户的说明都必须写这句。
- ⚠️ **轮询盲区＝真 kill scenario**：A 写完关机但云盘未传完 → B 读到**旧 rev** → B 编辑后 `cur.rev === baseRev` 不触 409 → **直接覆盖 A 的改动且不报冲突**。故「换设备前先关软件 + 等网盘显示同步完成」是硬纪律。接入第二台前**必须先导出本地备份**。
- 状态灯 `syncStatusMeta.ts`：ok(绿)/syncing(黄闪)/offline(灰，编辑留本机、恢复后自动接管)/error(红)/too-large(过大)。
- 三忌：多设备同时编辑；同步目录放公开共享；网盘套娃。便携版每次打开需重新授权目录（灰色离线点一下）。

## 种子/按钮/主题
- 卡片 data 键=`模块名::字段名`、表格行键=schema 列名，写错不报错整组静默空白。改种子必跑 `node tests/seed-schema-check.mjs`。统计条数先确认字面量还是循环生成。进度/热力图日期用 `todayKey()` 动态「距今N天前」。
- Button.tsx 套尺寸：primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；不套：bare/toggle-text。档位 xs(h-6)→sm(h-8)→md(h-9默认)→lg(h-10)。裸图标传 `iconOnly`。审计 JSX 不用 indexOf('>')（箭头 `=>` 误截断），判据「>前字符≠=」。
- 换肤 `<html data-theme>`+index.css 变量。8套：暗夜/护眼/午夜蓝/羊皮卷/暮山紫/青花/松烟墨/桃笺；浅色4=护眼/羊皮卷/青花/桃笺。浅色 ink 刻度反向(950最浅/50最深)；850分隔线比800深一档。⚠️ 浅色禁低透明度 amber 表数据（护眼1.57/羊皮卷1.48 远低于3:1会隐形），用实色 `bg-amber`，最低 `/40`。排查用 agent-browser eval 取 getComputedStyle 算 WCAG。

## AI / 网页版 / 服务器
- AI：颉文姬5模式 clinic/edit/review/brief/ledger；模型硅基流动 deepseek-ai/DeepSeek-V3.2。明文本地记忆勿公开。
- 网页版零后端可跑(idbOps)、邀请制。服务器 `154.8.178.240`(腾讯云轻量 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口 **22**)；ubuntu+免密sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`(www-data:3000，数据 `/var/lib/yfe`)。改服务端：`scp`→`/tmp`→`sudo cp`→`chown www-data:www-data`→`systemctl restart yfe-feedback`；nginx 改后 `nginx -s reload`。HTTPS 自签 `/etc/ssl/yfe`；安全上下文 AES-GCM(`a1:`) / HTTP 降级 XOR(`x1:`)。2.0 测试期自签 HTTPS+IP 访问，绑域名 qchxengine.cn+备案等测试后。
- serverStore 走 StoreOps `fetch /api/sync`，800ms 防抖，rev 守卫，排除 meta 的 AI 配置；同步码独立槽位 `sync-<sha256>.json`。入门码 `YFE-D49E-6MPG`、田馨 `YFE-SYNC-N6SV-2YZJ`、老大 `YFE-SYNC-7Q3K-2X9M`(ADMIN)。

## 服务器巡检
- 日志 `/var/lib/yfe/access.jsonl`(act: enter/reject/pull/push/authfail/conflict/rate-limited)、`feedback.jsonl`(附件 fb-<id>.bin)。每日 automation `automation-1787973377664` → `docs/服务器访问记录.md`/`docs/服务器反馈记录.md`。
- 实操：ts=UTC 按本地+8h 分组；概览表全量重算(独立IP重叠不可累加/Math.max)；追加非重建；先枚举 act 值防「未知动作」；脚本结论人工复核。要点段手写，时间同样 +8h(极易抄成 UTC)；08-29 基准行 21/1/8/21/20 可自校验。
- `bad` 字段判官：`bad=null`⇒请求无 Authorization(非输错码)；`bad` 有值可反算身份——本地 sha256(候选码) 取前12位比对。排障：日志 `push ok`≠落盘，须核槽位 rev/mtime。
- 已部署：#027 门禁码归一化（服务端 `normCode()`+前端 `WebGate`/`WebTools` 同款，槽位=sha256(码) 幂等，commit `bf4f704`/`3f1c082`）；#026 同步瘦身+按码配额(普通 50MB/ADMIN 450MB，超限 413)+每日滚动备份 `__cloudBackup`+「从云端备份恢复」。

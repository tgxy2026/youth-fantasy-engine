# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效的规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。

## 项目身份与最高红线
「青春幻想引擎」小说创作应用。Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储后端(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。managed node `C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2-2/node.exe`。**当前 2.0.0**（2026-09-02 由 1.9.9 升起）。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。
1. 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。**2026-09-02：不封装，版本号先停在 2.0.0，后续还有小修小补。**
2. 提交信息含 `!` 用 `git commit -F <文件>`（-m 被 bash 历史吃 `!XXX`）。main 无远程。
3. 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
4. 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
5. 服务器属主 `/var/lib/yfe` 须 www-data；sudo 写后必 `chown` + `sudo -u www-data test -w` 实测。

## 版本号机制
- 唯一版本源＝`package.json` 的 `version`。三份 vite config + electron-builder 均从它读（便携输出目录 `release/novel-studio-<ver>` 亦随之）。
- 🔴 **vite dev 下 `define` 不替换 `__APP_VERSION__`**（`__PORTABLE__` 同样）→ 恒走兜底显示「开发版」，对外文案在 dev 下核对不了。已加 `vite.config.ts` 插件 `injectAppVersion()` 补 dev 替换；build 正常替换并折叠兜底。原 `mode==='development'?'开发版':appVersion` 形同白写。
- 版本展示一律用 `APP_VERSION_LABEL`（正式版 `v2.0.0`／兜底「开发版」不带 v），四处 UI 已收口，`env.ts` 转出。
- 📌 老大口径：**不加 dev 角标**；「开发版」＝跑在开发服务器上的这一版。

## 封装与部署
- 前置：tsc0错+build0错 → 升 version → 封装。G盘 safe-delete 拦 rmSync/emptyOutDir → build 前 Node `renameSync` 移开 `dist`/`dist-web`。顺序：便携 → 网页 → 桌面（eb-cache 命中约 30 秒）。
- 验证三处一致：便携查单文件 HTML；桌面查 `release/desktop-out-<ver>-<ts>/win-unpacked/resources/app.asar`（须含 IPC 桥 `chooseSyncDir`/`sync:read`/`sync:write`/`contextBridge`）；线上 grep `/var/www/yfe/assets/*.js`。exe 元数据用 node 读 buffer 搜 utf16le `青春幻想引擎开发组`（`rcedit Unable to commit changes` 非真失败）。
- 网页部署：`scp`→`/tmp/yfe-web-<日期>` → `sudo mv /var/www/yfe /var/www/yfe.bak-<ts>` → `cp -r <真目录> /var/www/yfe` → `chown -R www-data:www-data`+`chmod 755` → 验 chunk → 清 `/tmp/yfe-web-*`。⚠️ **scp 套娃**：目标已存在会塞成子目录、外层仍是旧货，上传前先 `ssh rm -rf /tmp/<目标>`。**判定上线硬标准＝外部 `curl -sk https://154.8.178.240/` 比对 chunk 名**。
- ⚠️ dev 看不到桌面端 UI：`__PORTABLE__/__WEB__` 皆 false，`DESKTOP` 靠运行时探测 `window.electronStore` 恒 false。**验收须封装或用便携版 HTML**。
- 验证构建别污染交付：`npx vite build --config vite.config.<web|portable>.ts --outDir dist-<名字>-check --emptyOutDir`，验完移入 `G:\AI软件\.cleanup-quarantine\<日期>-<名字>`。
- ⚠️ 安装弹「XX无法关闭…」= NSIS 万能误导文案，**首解＝右键管理员身份运行**。dev 报 `[safe-delete] node_modules/.vite/deps`：移开 `node_modules/.vite` 重启。Edit 偶发静默失败→改完必 tsc+抽查。

## 工作区清理
- 先只扫报告(路径+体积)，老大圈定才动手。垃圾源：`dist*` 临时构建、`release/desktop-out-*`（单次 350MB 级）。
- 🔴 **只用 Move-Item，别用 Remove-Item**（走 trash，被锁报 `[SAFE_DELETE_FAIL_CLOSED]`）。隔离区 `G:\AI软件\.cleanup-quarantine\<日期>\`。老大明说「删除」才真删。⚠️ `mv` 整个目录常被拒：**逐个移动文件再 rmdir 空目录**即可。
- ⚠️ `desktop-out-*/.../app.asar` 常被 `QQPCRTP.exe`(管家) 锁句柄，五法全败，重启或等管家自清。已备 `npm run cleanup`（`scripts/cleanup-residual.mjs`，**须在系统终端跑**）。
- Windows 终端**不回显 stdout** → 要输出就写文件再 Read；从 bash 反向调终端宿主被安全策略拦。
- 清理后 `release/` 水位 ≈ 195MB。保留：`eb-cache`、`你需要的文件在这里/`、`桌面安装版/`、`novel-studio-<ver>/`。清完必 `git status` 确认无 D 项。

## 架构红线
- **无 i18n 基建**（全中文硬编码）。三大坑：①schema 列名即存储键（卡片键=`模块名::字段名`）②约 380 处中文参与逻辑判断③用户自定义选项不可译。全量 20-30 人日、仅 UI 12-18 人日。
- 按卷建表 `chapter-vol-<vid>`；聚合 `db.getAllChapterLedgerRows()`；章节号全局连续。顺序以 `chapterSeq.ts` 唯一权威（派生不落库）。
- 下拉选项用 `resolveOptions(col.options, getCustomOptions())`，禁直接 `col.options`。`!tabVisible` 只守卫 return/隐页签。
- `WEB` 由 `__WEB__` 决定，**禁写 `!PORTABLE && !DESKTOP`**。顶层副作用双守卫：①平台 `if(WEB&&...)` ②功能 `if(!code)return`。
- ⚠️ **tree-shake 陷阱**：组件若只在某平台门控分支（如 `{WEB && <X/>}`）被引用，其余平台会把整模块连内部 UI 一起摇掉。渲染门控必须是「需要该模块的平台之并集」。
- **左下角只准一个浮层**：统一 `DataDock`（项目管理页，等宽 15rem、单一 z-40）；**项目内禁用全局 fixed 浮层**（压住侧栏「界面缩放/主题」），一律内嵌 `Sidebar Footer`。
- 种子：卡片 data 键=`模块名::字段名`、表格行键=schema 列名，写错不报错整组静默空白。改种子必跑 `node tests/seed-schema-check.mjs`。

## 三端存储（写盘与丢失风险）
- 桌面：`C:\Users\<用户>\AppData\Roaming\novel-studio\novel-studio-data.json`（目录名取 package.json `name` 非 productName）。**整库一个 JSON**，防抖 800ms 全量重写。该目录混装 Electron 运行时约 15M + `Local Storage/leveldb`(独占锁)，真数据仅约 756K。⚠️ **让 WPS 云盘同步整个目录不可取**：leveldb 锁跨设备覆盖损坏、非原子写抓半截 JSON → 空库启动、文件级覆盖无合并＝整库级丢失。
- #033 已实施（da27a18）：`electron/main.cjs` 的 `dataFile()` 读 `data-location.json` 支持自定义路径；写盘改 `writeAtomicSync`/`writeAtomic`（**刻意不留 .bak**，避免云盘流量翻倍）；IPC `store:chooseDataDir`/`setDataPath`/`resetDataPath`/`isCustomPath`。`src/lib/desktop.ts` 扩展 `chooseDesktopDataDir`/`relocateDesktopDataFile`/`resetDesktopDataPath`。
- 便携（FSA）⚠️ 别再误判原子性：`flush()` 用 `createWritable()→write()→close()`，**本身就是 swap file 语义**（落地 `.crswap`），**不要重复实现 tmp+rename**。真正薄弱点＝最后一批编辑来不及落盘（FSA 只有异步 API）：已修（#034/315d472）`flushNow()` + `App.tsx` 监听 `visibilitychange(hidden)`/`pagehide`，**属尽力而为非保证**。

## 同步方案
- **判据：过我们的服务器→要码；走用户自己的网盘→不要码。** 服务器码身兼两职（鉴权换槽位 + AES 密钥）；云盘方式用内置常量 `DEFAULT_CLOUD_KEY`（`syncTransport.ts`），文件名 `青春幻想引擎-同步数据.yfe`。无码代价必须写进 UI：等同「混淆」，不抗蓄意破解。
- 桌面/便携=只有云盘模式、选目录即开启、无码；网页版 `WebTools` 可切「服务器(码 `yfe-sync-code`) / 云盘文件(`yfe-web-file-sync-on`+目录句柄)」。桌面 IPC 全走 `window.electronStore`。网页版进门 `/api/invite/check` 仍依赖我们服务器。WPS 免费档 1 文件夹/1GB/单文件≤10MB。老大：**内置云盘同步继续保留开发**。
- 🔴 **两条路径二选一，绝不同时指向同一目录**（`.yfe` 与 `novel-studio-data.json` 会打架）：①内置云盘同步（推荐，加密+rev 合并+8 秒轮询三路合并）②#033 更改数据文件位置（文件级整库覆盖、**无合并**）。
- ⚠️ **「架空」陷阱（最易被误判为丢数据）**：`enableDesktopCloudSync` 只在 `rev===0 && stores 空` 时播种本地数据。云盘已有数据则第二台原稿不被播种 → 用户以为稿子没了，但**本地 JSON 仍在磁盘**——**救法＝关闭云盘同步即切回本机存储**。面向用户的说明必须写这句。
- ⚠️ **轮询盲区＝真 kill scenario**：A 写完关机但云盘未传完 → B 读旧 rev → 编辑后不触 409 → **直接覆盖 A 且不报冲突**。「换设备前先关软件 + 等网盘同步完成」是硬纪律。
- 状态灯 `syncStatusMeta.ts`：ok/syncing/offline/error/too-large。三忌：多设备同时编辑；同步目录放公开共享；网盘套娃。

## 关服与 2.0 只发桌面/便携版（2026-09-02 决策）
- **2.0 只发桌面版 + 便携版，网页版后续关闭**。桌面/便携**零联网**（三个 API 全被 `WEB &&` 门控 tree-shake 掉），关服对两版零影响。
- 裁定：P0-1 便携写盘→已修；P0-2 导出公告→**#031 已实施**(4b38bd8)；P0-3 网盘链接→**#032 已完成**(7a25438)；P0-4 代码签名→忽略；P1-5 致谢名单→占位；P1-6 反馈入口→忽略（走关于页联系方式）；P1-7 docs 清理→忽略；P1-8 资产处置→**#033**（须在 #031 宽限期后）。
- 🔗 **三件套顺序不可颠倒：#032 网盘链接 ✅ → #031 导出公告 ✅（部分） → #033 资产处置**。
- 🔴 **#031 关键认知（写数据保全文案前必读）**：自动备份（每 5 分钟 `auto5min`、每日 `daily`，各 30 份）经 `ops.put('backups',...)` 写在**同一个存储**里（网页版同一 IndexedDB、桌面/便携同一 JSON）。**容器没了，30 份备份跟着一起消失**——只防「改坏了想回退」，防不了「整个容器没了」，后者只能靠**导出到外部文件**。
- **#031 落地**（老大「具体内容你自己写」）：`BackupReminder.tsx`+`lib/backupReminder.ts`，**三端通用**而非仅网页版关服公告。触发＝距上次导出 >7 天 且 「稍后再说」静默期（**同为 7 天，每周最多打扰一次，勿调成 3 天会变骚扰**）已过 且 确有数据（已开项目或 `db.getAllProjects()` 非空）。三处导出成功处（`App.exportCurrent`/`ProjectHub.exportProject`/`BackupManager` 迁移包）调 `markExported()` 重新计时。网页版未开云端同步时**让位**给 `LocalDataNotice`，判据统一走其导出的 `isLocalDataNoticeActive()`。
  - ⚠️ **关服公告文本仍未写**：预留 `SHUTDOWN_NOTICE` 空常量，确定关服时间后填入文案即自动置顶高亮——**那时 #031 才算全部完成、#033 才可执行**。
- 📦 **分发网盘（长期有效）**：夸克 https://pan.quark.cn/s/8ae0eb718cf5?pwd=QfAm ｜提取码 `QfAm`｜口令 `/~bb863abBGY~:/`。写在 `AboutPage.tsx` 三常量。换版本只要仍同一文件夹分享，只传新安装包即可。
- 复制交互统一用 `copyText()`：`navigator.clipboard`→`execCommand`→toast 报错，**绝不静默失败**。桌面版外链走 `main.cjs:250` `setWindowOpenHandler`+`shell.openExternal`（**在 electron/ 不在 src/**），该分支未实点。
- ⚠️ **清单统计区维护坑**：新增条目只改「总数」必漏——须同步改对应状态计数与编号列表；**括号内勿写其他条目编号**（校验脚本会把 `#0XX` 全抓成条目）。校验用 python 按 `(?<!\\)\|` 切列，**不可用 awk/shell 裸切**（#027 描述含 `\|\|` 转义竖线会列错位）。

## UI 规范
- Button.tsx 套尺寸：primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；不套：bare/toggle-text。档位 xs(h-6)→sm(h-8)→md(h-9默认)→lg(h-10)。裸图标传 `iconOnly`。审计 JSX 不用 indexOf('>')（箭头 `=>` 误截断），判据「>前字符≠=」。
- 换肤 `<html data-theme>`+index.css 变量。8 套：暗夜/护眼/午夜蓝/羊皮卷/暮山紫/青花/松烟墨/桃笺；浅色4=护眼/羊皮卷/青花/桃笺。浅色 ink 刻度反向(950最浅/50最深)。⚠️ 浅色禁低透明度 amber 表数据（护眼1.57/羊皮卷1.48 远低于3:1），用实色 `bg-amber`，最低 `/40`。

## AI / 网页版 / 服务器
- AI：颉文姬5模式 clinic/edit/review/brief/ledger；模型硅基流动 deepseek-ai/DeepSeek-V3.2。明文本地记忆勿公开。
- 服务器 `154.8.178.240`(腾讯云轻量 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口 **22**)，ubuntu+免密sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`(www-data:3000，数据 `/var/lib/yfe`)。改服务端：`scp`→`/tmp`→`sudo cp`→`chown`→`systemctl restart yfe-feedback`；nginx 改后 `nginx -s reload`。HTTPS 自签；安全上下文 AES-GCM(`a1:`) / HTTP 降级 XOR(`x1:`)。绑域名 qchxengine.cn+备案等测试后。
- serverStore 走 StoreOps `fetch /api/sync`，800ms 防抖，rev 守卫，排除 meta 的 AI 配置；槽位 `sync-<sha256>.json`。入门码 `YFE-D49E-6MPG`、田馨 `YFE-SYNC-N6SV-2YZJ`、老大 `YFE-SYNC-7Q3K-2X9M`(ADMIN)。
- 巡检：日志 `/var/lib/yfe/access.jsonl`(act: enter/reject/pull/push/authfail/conflict/rate-limited)、`feedback.jsonl`。每日 automation → `docs/服务器访问记录.md`/`docs/服务器反馈记录.md`。ts=UTC 按本地+8h 分组；概览表全量重算（独立IP不可累加）；追加非重建。`bad=null`⇒请求无 Authorization。日志 `push ok`≠落盘，须核槽位 rev/mtime。已部署 #027 门禁码归一化、#026 同步瘦身+按码配额(普通50MB/ADMIN 450MB)+每日滚动备份。

# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效的规则/红线/决策/凭据；事件经过留 `YYYY-MM-DD.md`。

## 项目身份
「青春幻想引擎」小说创作应用。Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储后端(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。managed node：`C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`

## 最高红线
1. 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。
2. 提交信息含 `!` 用 `git commit -F <文件>`（-m 被 bash 历史吃 `!XXX`）。main 无远程。
3. 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
4. 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
5. 服务器属主红线：`/var/lib/yfe` 须 www-data；sudo 写后必 `chown www-data:www-data` + `sudo -u www-data test -w` 实测，否则 push 静默失败。

## 封装流程
- 必备：tsc0错+vite build0错+改动落盘 → 升 version → 封装。
- G盘 safe-delete 拦截 rmSync/emptyOutDir：build 前 Node `renameSync` 移开 `dist`/`dist-web`。
- 同版本重打包：①先移开 `release/novel-studio-<ver>` 与 `dist-web`；②`dist-web` 句柄占用 rename EPERM → 改用 `--outDir dist-web-<后缀>`；③ electron-builder `rcedit Unable to commit changes` 非失败（重试第3次成功不打日志），node 读 exe buffer 搜 utf16le `青春幻想引擎开发组`/`Copyright © 2026` 判定。
- 产物验证：node 读 buffer 双向校验新/旧字符串；便携查单文件HTML、桌面查 `dist/assets/<chunk>.js`、线上 grep `/var/www/yfe/assets/*.js`，三处一致才真上线。
- dev 报 `[safe-delete] node_modules/.vite/deps`：移开 `node_modules/.vite` 重启。Edit 偶发静默失败→改完必 tsc+抽查。
- ⚠️ **安装弹「XX无法关闭，请手动关闭它然后点击重试」= 万能误导文案**，与"程序没关"基本无关。真实触发点 3 处（`node_modules/app-builder-lib/templates/nsis/`）：`allowOnlyOneInstallerInstance.nsh:110`(杀不掉进程) / `extractAppPackage.nsh:116`(`CopyFiles` 写不进 `$INSTDIR` 重试5次) / `installUtil.nsh:219`(旧卸载器退出码非0重试5次)。**首解＝右键「以管理员身份运行」**（老大实测一次通过）；`perMachine:false` 时进程检测走 `tasklist /FI "IMAGENAME eq <中文名>.exe" /FO csv | find.exe <中文名>` 取退出码，已实测中文不误判。

## 工作区清理
- 先只扫报告(路径+体积)，老大圈定才动手。垃圾源：`dist.bak-*`/`dist_bak_*`/`dist-web*.bak*`/`web-build-*`，以及**最大的 `release/desktop-out-*`（单次构建 350MB 级，`build-desktop.mjs` 用时间戳目录，越攒越多）**。
- 本环境无真回收站 → 移到 `G:\AI软件\.cleanup-quarantine\<日期时间戳>\`（可逆不删）；bash mv EPERM 换 PowerShell `Move-Item`。
- 🔴 **只用 Move-Item，别用 Remove-Item 删**：删除受 safe-delete 钩保护（走 trash，文件被锁时报 `[safe-delete][SAFE_DELETE_FAIL_CLOSED]` 直接失败）。被锁文件可用 `robocopy /MOVE /E /R:2 /W:1` 先复制内容再留壳。
- 退避重试循环**别每次换目标名**（会堆一堆 `_1`~`_6` 空目录）。`desktop-out-*/win-unpacked/resources/app.asar` 常被 `QQPCRTP.exe`(管家) 持续锁句柄，重启后才删得掉；不影响下次构建（时间戳目录自动绕过）。
- 保留红线：`release/eb-cache`(~106M)、`你需要的文件在这里/`、`release/桌面安装版/`、`release/novel-studio-<ver>/`（真交付物）。清完必跑 `git status` 确认无 D 项 + 核对源码目录文件数。

## 架构红线
- **无 i18n 基建**（package.json 零 i18n 依赖，全中文硬编码）。若做本地化，三大前置坑：①**schema 列名即数据存储键**（`c('章节号')` 兼显示标签与表格行键，卡片键=`模块名::字段名`）→ 翻译会毁存量数据，必须先 key/label 分离+迁移；②约 **380 处中文参与逻辑判断**（`=== '大纲规划'` 导航组 id、`!== '已退场'`、`=== '严重'` 等）；③用户自定义选项(`resolveOptions`/`getCustomOptions`)不可译。中文文案基线：9108 条/13 万字，其中 UI 组件 1452 + 逻辑层 470 = 1922 条为可直译；内容数据(seedData/nameGen/typoWords) 5535 条不该译。评估全量 20-30 人日、仅 UI 外壳 12-18 人日。
- 按卷建表 `chapter-vol-<vid>`；聚合 `db.getAllChapterLedgerRows()`；章节号全局连续 `migrateChapterNumbering`。顺序以 `chapterSeq.ts` 为唯一权威（派生不落库）。
- 下拉选项用 `resolveOptions(col.options, getCustomOptions())`，禁直接 `col.options`。`!tabVisible` 只守卫 return/隐页签，赋 `showXxx` 即 bug。
- `WEB` 由 `__WEB__` define 决定（仅 vite.config.web.ts 为 true），禁写 `!PORTABLE && !DESKTOP`。
- 顶层副作用双守卫：①平台 `if(WEB&&...)`；②功能 `if(!code)return`（#023 已修 c0275f3：armUnloadFlush 延迟注册 + flushNow/schedulePush 加 `if(!code)return`）。
- 「从源数据重建草稿」effect 防脏覆盖：重建前 `草稿id===当前id && dirty` 才 return。
- ⚠️ **UI 模块渲染门控会误杀整模块（tree-shake 陷阱）**：若某组件（如 WebTools）只在某个平台门控分支（如 `{WEB && <X/>}`）里被引用，其余平台构建（WEB=false）会因为「整模块只有一个死代码引用」而**把该组件连同其内部所有 UI（含门控外的字符串）一起 tree-shake 掉**——与组件内部的 `&&` 门控无关。正确做法：渲染门控必须是「所有需要该模块的平台之并集」（如 `{WEB || CLOUD_FILE_SYNC && ...}`）。曾因此导致桌面/便携版「云盘文件同步」整段消失（2026-09-01 已修 App.tsx）。
- **左下角只准有一个浮层**（#032 起的布局红线）：历史上 `DesktopBadge`(bottom-3 left-3 z-50) 与 WebTools 容器(bottom-4 left-4 z-40) 各画各的，定位差 1px/层级差 10，桌面版 z-50 直接盖住同步 UI。现统一由 `DataDock`（项目管理页，等宽 15rem、控件 h-8、分隔线分区、单一 z-40）承载；**项目内禁用全局 fixed 浮层**——会压住侧栏「界面缩放/主题」，一律内嵌进 `Sidebar Footer`。新增任何角标/状态条，先问它该进 DataDock 还是 Sidebar，不许自己 `fixed`。

## 种子数据
- 卡片 data 键=`模块名::字段名`、表格行键=schema 列名，写错不报错整组静默空白。
- 改种子必跑 `node tests/seed-schema-check.mjs`（esbuild 打包 schema+db 打桩，逐键对账）。
- 统计条数先确认字面量还是循环生成（`grep -c` 会漏循环/助手创建）。进度/热力图日期用 `todayKey()` 动态「距今N天前」。

## 按钮体系(Button.tsx)
套尺寸：primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；不套：bare/toggle-text。档位 xs(h-6)→sm(h-8)→md(h-9默认)→lg(h-10)。裸图标传 `iconOnly`。改尺寸后查容器溢出(加 overflow-x-auto)。审计 JSX 不用 indexOf('>')（箭头 `=>` 误截断），判据「>前字符≠=」。

## 主题系统
换肤 `<html data-theme>`+index.css 变量，组件零改。8套(深浅各4)：暗夜/护眼/午夜蓝/羊皮卷/暮山紫/青花/松烟墨/桃笺；浅色4=护眼/羊皮卷/青花/桃笺。
浅色 ink 刻度反向(950最浅/50最深)；850分隔线比800深一档。CSS 压缩去引号 `[data-theme=x]`。
⚠️ 浅色禁低透明度 amber 表数据(护眼1.57/羊皮卷1.48 远低于3:1会隐形)；靠色传达数据用实色 `bg-amber`，最低 `/40`。排查用 agent-browser eval 取 getComputedStyle 算 WCAG。

## AI 接入
颉文姬5模式 clinic/edit/review/brief/ledger；模型硅基流动 deepseek-ai/DeepSeek-V3.2。明文本地记忆勿公开。

## 版本与方向
当前 1.9.9(便携8.40MB/桌面84.6MB/网页版上线)。跨设备同步新方向(2026-09-01 晚)：因服务器不永久维护，确定走「云盘中转同步(方案1)」——复用 serverStore 加密载荷(`a1:`AES-GCM)+rev合并，传输层由 HTTP 换成云盘同步目录里的 `.yfe` 文件；手动导入导出老大确认已完成(不再列入方案)。WPS 云盘经核实支持任意文件夹实时双向同步可接入(免费档限1文件夹/1GB/单文件≤10MB、路径不固定须用户自选目录，不可硬编码)。复用时须沿用 #030 的「空推拒绝 + 原子写.bak」防护。
桌面端接入约束(2026-09-01 晚确认)：Electron `main.cjs` 为 `contextIsolation:true`+`nodeIntegration:false`，渲染进程**不能** `require('fs')`；`FileTransport` 的 node 分支(`globalThis.require('fs')`)在桌面端会静默失效。桌面端要做云盘中转，必须：①`preload.cjs`+`main.cjs` 加 `sync:read`/`sync:write` IPC 桥(主进程已有 fs/fsp/dialog 现成可用)；②`FileTransport` 检测 Electron 走 `window.electronStore` IPC 而非 require；③解除 serverStore 的 WEB 门控让桌面启用；④桌面 UI 加同步设置入口(同步码+选目录，无进门邀请码)。即**桌面端才是真·零服务器方案**(无需托管/无进门码/FSA沙箱限制全无)，但需改 Electron 主/preload + 重新封装。网页版进门(托管+`/api/invite/check`)仍依赖我们的服务器，所以纯网页版做不到完全不养服务器——云盘中转只去中心化了「数据同步」，没去中心化「进门」。
#032 云盘同步砍码（2026-09-01 已提交 e1d970b）：桌面/便携版**不再有同步码**，选目录即开启。原理——码原本身兼两职（HTTP 鉴权换槽位 + AES 密钥），云盘中转不走服务器，鉴权一环本不存在，加密只需两端一致 → 改用内置常量 `DEFAULT_CLOUD_KEY`。代价：加密降为「混淆」级（密钥是公开源码常量，防明文扫描不抗破解），帮助文案已如实写明勿放共享目录。同步文件固定名 `青春幻想引擎-同步数据.yfe`（`createFileTransport(handle, fixedName?)`）。网页版仍保留同步码（服务器鉴权 + 槽位）。
⚠️ **dev 看不到桌面端新 UI**：`vite --port 5199` 用 vite.config.ts（`__PORTABLE__/__WEB__` 皆 false），`DESKTOP` 靠运行时探测 `window.electronStore`，浏览器里恒 false → `CLOUD_FILE_SYNC=false`。验收桌面布局必须封装，或改用便携版 `release/novel-studio-1.9.9/novel-studio.html`。
2.0 测试期 `https://154.8.178.240` 自签HTTPS+IP访问；绑域名 qchxengine.cn+备案 等测试后。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。

## 网页版与服务器
网页版零后端可跑(idbOps)。邀请制。服务器 `154.8.178.240`(腾讯云轻量Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(**22**；2026-09-01 实测 600 超时，改 22 通)。ubuntu+免密sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`(www-data:3000，数据 `/var/lib/yfe`)。
改 feedback-server.mjs：本地构建后 `scp` 到服务器 `/tmp/yfe-feedback.mjs` → `sudo cp /tmp/yfe-feedback.mjs /opt/yfe-server/` + `sudo chown www-data:www-data` + `systemctl restart yfe-feedback`；网页静态文件 `scp` 到 `/tmp/yfe-web-<日期>` → `sudo cp -r` 到 `/var/www/yfe` + `chown -R www-data:www-data`。nginx 改后 `nginx -s reload`。
serverStore走StoreOps `fetch /api/sync`，800ms防抖，rev守卫，排除meta的AI配置；20同步码独立槽位 `sync-<sha256>.json`。入门码 `YFE-D49E-6MPG`、已分发 `YFE-SYNC-N6SV-2YZJ`(田馨)。
HTTPS 自签 `/etc/ssl/yfe`；安全上下文 AES-GCM(`a1:`) / HTTP降级 XOR(`x1:`)。

## 服务器巡检
日志 `/var/lib/yfe/access.jsonl`(act: enter/reject/pull/push/authfail/conflict/rate-limited)、`feedback.jsonl`(附件 fb-<id>.bin)。每日 automation `automation-1787973377664` → `docs/服务器访问记录.md`/`docs/服务器反馈记录.md`。
实操：ts=UTC按本地+8h分组；概览表全量重算(独立IP重叠不可累加/Math.max)；追加非重建；先枚举 act 值防「未知动作」；脚本结论人工复核。
`bad` 字段判官：`bad=null`⇒请求无 Authorization(非输错码)；`bad` **有值可反算身份**——本地 sha256(候选码) 取前12位比对即知填了啥(已据此认出「入门码当同步码」)。排障：日志 `push ok`≠落盘，须核槽位 rev/mtime。
要点段是手写的，时间同样须 +8h(极易抄成 UTC)；概览 08-29 基准行 21/1/8/21/20 可作全量重算的自校验。
门禁码校验(#027 已处理·2026-09-01 部署上线)：服务端 `feedback-server.mjs` 新增 `normCode()`(`replace(/\s+/g,'').toUpperCase()`)，`parseList` 建集合与 `syncAuth`/邀请校验取码后均归一化再比对；前端 `WebGate`/`WebTools`(doSync+`PromptModal.transformUppercase`+`YFE-D` 误填识别)同款归一化。⚠️ 槽位名＝`sha256(码)` 幂等(全大写码不变)，线上 pull 验证小写/空格变体命中同一 `4edd6fb4…` 槽位。commit `bf4f704`+`3f1c082`。
#026 同步瘦身+按码配额+每日滚动备份(已处理·2026-09-01 部署上线)：①`serverStore.ts` push 前 `liveStores(cache)` 剔除 `backups`(云端只存活数据，砍约50%)，`mergeCaches`/`ensureInit`/冲突重试解密后均剥离 `__cloudBackup` 存入独立变量(不混入 cache)；②**A+ 每日滚动备份**：push 载荷附带 `__cloudBackup`(仅含活数据副本、按自然日滚动、当天仅首推写入，避免同日坏数据覆盖当日检查点)，本地 `backups` 仍永不进云；`WebTools` 新增「从云端备份恢复(日期)」按钮(confirmDialog 确认后回滚并重新同步)；③单文件闸按码配额：`feedback-server.mjs` `limitFor()`，普通码 `SYNC_LIMIT_MB=50`、老大 `YFE-SYNC-7Q3K-2X9M` 在 `ADMIN_SYNC_CODES` 走 `ADMIN_SYNC_LIMIT_MB=450`，超限返 413+`{error:'too_large',limit}`；④载荷翻倍→放宽：`yfe.conf` `/api/sync` `client_max_body_size`=1500m、`readRaw` 1500MB、413 判定放宽到名义配额×2(encBytes)与×3(cl)，**名义配额 50/450MB 不变**。线上：含`__cloudBackup`载荷推→拉成功+剥离验证；1MB→200、200MB→413(limit:50)、错码→401；老大槽位 pull 完好；tsc0错/服务端node --check通过/部署文件sha256逐字节一致。

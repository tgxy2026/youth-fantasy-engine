# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。

## 项目身份与红线
「青春幻想引擎」Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。**当前 2.0.0（2026-09-04 收官发布：桌面84.6MB+便携8.85MB，仅发桌面/便携，网页版已关服待处置）**。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。
- 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。**2.0.0 已收官（2026-09-04）**；后续版本节奏＝约每月更新一次（老大同日定），重大改动再单独封装，平时以内容创作与小幅优化为主。
- 提交含 `!` 用 `git commit -F <文件>`。main 无远程。
- 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
- 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
- 服务器属主 `/var/lib/yfe` 须 www-data；sudo 写后必 `chown`+`sudo -u www-data test -w`。

## 版本号
- 唯一源＝`package.json` version。展示用 `APP_VERSION_LABEL`（v2.0.0／兜底「开发版」），`env.ts` 转出。
- 🔴 dev 下 `define` 不替换 `__APP_VERSION__`；`vite.config.ts` 已加 `injectAppVersion()` 补 dev 替换。
- 老大口径：不加 dev 角标；「开发版」＝跑在开发服务器上。

## 封装/构建坑
- 🔴 桌面 `build-desktop.mjs` 的 `ELECTRON_CACHE` 须指向系统默认缓存 `C:/Users/<用户>/AppData/Local/electron/Cache`，**切勿**指向 `release/eb-cache/electron-zip`（仅扁平 zip、缺 @electron/get hash 结构）→ 离线打不出 electron 运行时，只产 ~500KB NSIS 空壳、双击无法运行（b3e5c4f 曾误判成功，2026-09-04 修正 f085dc9）。
- 桌面/便携正常产物体积：桌面安装包 **80.68 MiB**（Windows 资源管理器显示「80.6M」；十进制记作 84.6MB——三者是同一个文件，别误判成两个包）、便携单文件 **8.44 MiB**。🔴 两个构建脚本已内置体积闸门（`MIN_SETUP_BYTES=50MB` / `MIN_PORTABLE_MB=5MB`），**无论 builder 退出码是否为 0，体积不达标即 abort**——别再退化回「exe 存在即成功」的兜底（2.0.0 曾因此放行 513KB 空壳）。
- ⚠️ Edit 工具会「假成功」：2.0.1 给 build-desktop.mjs 补 `statSync` 导入时回执 Success 但文件未落盘，首跑直接崩在 `statSync is not defined`。**改完必须 sed/grep 复查真实文件内容。**
- 🔴 **（2026-09-14 强化）dev server 运行时假成功概率明显更高**：一次连续改 6 个组件时 3 次回执 Success 但文件未变（1 次报 `EBUSY`、2 次无声无息），造成「用了 `<LoadingState/>` 却没 import」的中间态。**对策：① 每笔 Edit 后立即 grep 复查；② 批量/多处替换改用 node 脚本（`split/join` 精确替换，未命中即抛错），一次成功率明显更高。**
- rcedit `Unable to commit changes` 是 cosmetic 报错，非真失败（exe 已含 metadata）。
- 🔴 NSIS 安装权限（2026-09-04 决策 ae08e7d）：`nsis.perMachine:false` + `allowToChangeInstallationDirectory:false` → 强制按**当前用户**装到 `%LOCALAPPDATA%\Programs`，重装永不需管理员。`perMachine:true`（装 Program Files）或用户自选 Program Files 会在重装时被旧 per-machine 卸载拦住、必须管理员——这是系统级限制改不了。**升级提示已写进 AboutPage**：旧版在 Program Files 的用户需「右键→以管理员身份运行」一次新版安装包完成迁移，之后即可免管理员重装。切勿为"免提权"把 `allowElevation` 设 false（遇 per-machine 旧版会直接升级失败而非弹管理员）。

## 架构红线
- 无 i18n 基建（全中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake 陷阱：组件只在某平台门控分支被引用→其余平台摇掉整模块。渲染门控须「需该模块平台之并集」。
- 左下角只准一个浮层 `DataDock`（项目管理页）；项目内禁用全局 fixed 浮层，一律内嵌 Sidebar Footer。
- 种子：卡片 data 键=`模块名::字段名`、表格行键=schema 列名；改种子必跑 `node tests/seed-schema-check.mjs`。
- `WEB` 由 `__WEB__` 决定，禁写 `!PORTABLE && !DESKTOP`；顶层副作用双守卫（平台 `if(WEB&&...)`+功能 `if(!code)return`）。
- 🔴 编辑器双图层（NovelEditor.tsx）：`highlightOn` 开启时 textarea 设 `color:transparent`，**肉眼所见文字全来自同级 `highlightRef` 叠层**（dangerouslySetInnerHTML）。改编辑器必守三条——① 叠层与 textarea 盒模型**逐项一致**（同为 `inset-0` + `px-6/8` + `pt-6` + `pb-[40vh]`，任一侧改 padding 必须同步改另一侧）；② 叠层重建会把 scrollTop 归零，凡 highlightHTML/切章/字号/页宽/专注/检索栏变化**必须**用 `useLayoutEffect` 回填同步（2.0.1 修的"滑动不显示文本"即漏此条）；③ 高亮扫描只走 `scanRefHighlight` 单次正则，**禁止再写 `filter(x=>text.includes)` 双扫**（长章卡顿根因），超 `HIGHLIGHT_MAX_LEN` 自动降级。切章需同步 `setDeferredContent`，勿等防抖。

## 三端存储（数据丢失风险）
- 桌面：`AppData\Roaming\novel-studio\novel-studio-data.json`（目录名取 package.json `name`），整库一 JSON，防抖 800ms 重写。⚠️ 勿让 WPS 云盘同步整个目录（leveldb 锁+非原子写→空库/整库丢失）。
- #033：桌面数据文件可自定义路径（`data-location.json`），`writeAtomicSync/Atomic`（刻意不留 .bak）；IPC `store:chooseDataDir/setDataPath/resetDataPath/isCustomPath`。
- 便携(FSA)：`flush()` 用 `createWritable()→write()→close()` 即 swap 语义，勿重复 tmp+rename。薄弱点＝末批编辑来不及落盘，已加 `flushNow()`+`visibilitychange/pagehide` 尽力而为。

## 同步方案
- 判据：过服务器→要码（鉴权+密钥）；云盘→不要码（`DEFAULT_CLOUD_KEY`，文件 `青春幻想引擎-同步数据.yfe`）。
- 🔴 两路径二选一，绝不同时指向同目录（`.yfe` 与 `novel-studio-data.json` 打架）。
- ⚠️ 架空陷阱：`enableDesktopCloudSync` 仅 `rev===0 && 空` 播种；云盘有数据则第二台原稿不播种但本地 JSON 仍在→救法＝关云盘同步切回本机。
- ⚠️ 轮询盲区：A 写完关机云盘未传完→B 读旧 rev→直接覆盖 A 不报冲突。「换设备前先关软件+等同步完成」硬纪律。
- 🔴 `backups` 是**本地专属**（2026-09-14 修正一处真 bug）：云端载荷不含它（`liveStores` 上传前剔除，#026），
  故 `db.ts` 的 `makeCloudStoreWrapper` 必须把它的**读写短路到 local**（已加 `if (args[0] === 'backups') return local[op](...)`）。
  否则「云端不要、本地不写」→ 备份只活在云端实例的内存 cache 里，刷新即丢、列表还显示为空。
  **影响三端**：`desktopCloudSync.ts` 与 `serverStore.ts` 共用同一个 `createCloudStore`，桌面/便携启用云盘同步同样中招。
  ⚠️ 推论：`seedFromLocal` 里那次 backups 读取因此成了无用功（已跳过）；**但它曾差点被我误删**——
  `store.getAll` 是从 cache 读的，而 seedFromLocal 恰是唯一把本地备份载入 cache 的地方。
  **纪律：「死配置」结论必须先验消费方（谁读、谁写、以及读的源头）再动手。**

## 2.0 只发桌面/便携（网页版后续关闭）
- 桌面/便携零联网（API 全被 `WEB &&` tree-shake）。2.0 只发这两版。
- 🔴 #031：自动备份写在**同一存储**（容器没了备份跟着消失），只防改坏、防不了容器丢，须**导出外部文件**。`BackupReminder.tsx`+`lib/backupReminder.ts` 三端通用，>7 天未导出且静默期(7天)过且有数据才提示；三处导出成功调 `markExported()`。关服公告 `SHUTDOWN_NOTICE` 已在 2.0.0 填入「网页版 2026-09-29 08:49:53 停止服务」(非空即置顶高亮)，#031 已闭环。
- 分发网盘（夸克，长期有效）：链/码/口令见 `AboutPage.tsx` 三常量。换版只传新安装包。
- 复制交互统一 `copyText()`（clipboard→execCommand→toast 报错，绝不静默失败）。

## UI 规范
- Button.tsx 套尺寸 primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；裸图标传 `iconOnly`。
- 8 套主题 `<html data-theme>`；浅色 4=护眼/羊皮卷/青花/桃笺，禁低透明度 amber 表数据（用实色 `bg-amber` 最低 `/40`）。
- 🔴 **SVG 里用 CSS 变量必须走 `style`，不能写表现属性**：`fill="rgb(var(--x))"` / `stroke="rgb(var(--x))"`
  **一律无效**（表现属性不做自定义属性替换）→ 回退为黑，而且**静默不报错**。
  必须写 `style={{ fill: 'rgb(var(--x))' }}`；含 var() 的动态色（如 `const col = 'rgb(var(--a))'` 再传下去）同理。
  2026-09-14 全项目扫出 3 处受害者（RelationGraph 边标签底板、WritingGoals 燃尽图网格线与轴标签、
  琥珀目标线），均长期与主题无关地渲染成黑。**新增/修改任何 SVG 绘制前先看这条。**
- 图谱/画布界面色（网格点、节点填充与文字、常态描边、连线标签、文字光晕、高亮/选中/高亮文字）
  统一走 `--graph-*` 变量（`src/index.css`）：暗色系取原暖褐值（观感不变），浅色主题引用各自 ink 刻度自动翻转。
  ⚠️ 分类色盘（关系类型色、势力关系色、节点调色板、画布类别色）是**数据分类色**，靠色相区分，**不要主题化**。

## AI / 服务器
- AI：颉文姬5模式 clinic/edit/review/brief/ledger；硅基流动 DeepSeek-V3.2。明文本地记忆勿公开。
- AI 返回解析：**统一走 `src/lib/aiParse.ts`**（2026-09-14 收敛，此前有 3 份重复实现）。
  导出 `parseObjectArray`（数组 / 单对象 / `{list:[…]}` 三形态归一化）/ `parsePlainObject` / `hasSubstance` / `asText` / `humanText`。
  🔴 勿退回"先按 `[` 切片"的老写法——单对象会被解析成非数组对象后在 `Array.isArray` 处判失败返回空，
  导致内容全丢、退 `humanText` 兜底（2.0.1 修的"改稿只剩标点"）。**也禁止再手写裸 `JSON.parse` 解析模型输出**
  （模型一裹解释或加 ```json 围栏就整条丢弃）。失败时用 `hasSubstance` 拦垃圾。
  ⚠️ `hasSubstance` 目前**只在 aiRewritePassage 一处**生效，其余约 10 处兜底仍直接回 `humanText` 残骸（现状已注明，未擅自推广）。
- 🔴 **迁移只走 `db.runMigrations()`**（types → ledger → numbering，幂等）：boot 恢复上次项目与手动 openProject
  必须共用它。历史坑：boot 路径曾漏跑 ledger/numbering 导致自动回到项目时读到旧结构。**顺序不可调换**
  （numbering 依赖 ledger 拆表后的 `chapter-vol-<卷id>` 行）。db 层不引用 schema（避免循环依赖），
  刷卷页签由调用方另行 `refreshVolumeTabs()`。
  📌 `getDB` 的 upgrade 回调已拆为 9 个独立函数（`migrateFreshInstall` / `migrateV1toV2` … `migrateV8toV9`，2026-09-14）。
  **upgrade 处是「何时跑哪一段」的唯一判断点**，函数内不再重复 `oldVersion` 条件（避免同一判断散两处）。
  ⚠️ 全新安装走 `migrateFreshInstall` 后**不 return**，会继续跑 v3 及之后的段（对空库无副作用的空转）——刻意保留。
- 🔴 prompt 注入防护（2026-09-14）：作者原文进 prompt 前统一走 `src/lib/promptGuard.ts` 的 `authorBlock(id, text)`
  （调用级随机 nonce 定界 `<<<A-<id>>>`…`<<<E-<id>>>` + 段前声明）。**两条硬约束**：
  ① 用随机 nonce 而非固定符号——固定符号一旦被猜中，正文写上它即可「闭合」边界；
  ② **绝不清洗正文内容本身**——`aiProofread` 依赖 `text.indexOf(chunk)` 精确定位分块，改一个字符整块作废。
  新增「作者文本进 prompt」的入口时套 `authorBlock` 即可。
- **跨文件共用的 localStorage 键 / 防抖常量**收在 `src/lib/constants.ts`（`LS_*` / `SAVE_DEBOUNCE_MS` / `SYNC_POLL_MS`）。
  新增键改这里一处，别在调用点写字面量——改错键名会让用户偏好静默重置且无报错。
- 🔴 温度（2026-09-14 起机制变更）：**不要在任务层手填温度**。结构化 JSON 任务传 `chat(..., { json: true })`，
  由 `ai.ts` 的 `chat()` **统一解析**为 `JSON_TASK_TEMPERATURE`(0.3)；创意类不传即 `DEFAULT_TEMPERATURE`(0.85)。
  历史坑：20 处调用里 19 处漏传温度、静默跑在 0.85，而注释却写着"必须传低值"——**靠自觉的"可选参数"必然漏**，
  故改为语义开关 + 上游唯一真源（`CallOpts.temperature` 已改必填，下游无第二个兜底点）。新增 AI 任务时务必带 `json: true`。
- 服务器 `154.8.178.240`(腾讯云 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口22) ubuntu+免密sudo。站点 `/var/www/yfe`；反馈 `/opt/yfe-server/feedback-server.mjs`。码/详情见 `docs/服务器访问记录.md`。
- 网页部署流程：本地 `vite build --config vite.config.web.ts`(→`dist-web`) → tar 打成单包 → scp 到服务器 `/tmp`（**走 /tmp 中转，避免 scp 套娃）→ `sudo cp -a` 备份旧版 → 清旧 assets/index.html → 解包 → `chown -R www-data:www-data` → `sudo -u www-data test -w` 验收。
- 🔴 部署校验陷阱：Nginx 配了 SPA 回退，**任意不存在的路径都返回 200 + index.html**——旧 chunk 名照样 200，**绝不能用 HTTP 200 判断资源是否上线**。必须核对 `Content-Length` / `Content-Type` / `Last-Modified` 与首字节内容（新 chunk 首字节应含 `__vite__mapDeps` 及新依赖名）。

## 工程质量与验证（2026-09-14 起）
- **命令**：`npm run verify`（= typecheck + lint + test，退出码 0 即全绿）/ `npm test` / `npm run lint`。
- **测试 runner**：`tests/run-all.mjs` 自动发现 `tests/*.test.ts` + `seed-schema-check.mjs`。
  🔴 **每个入口必须单开子进程**——`roundtrip.test.ts` / `adversarial.test.ts` 结尾是 `process.exit()`，同进程串跑会被直接掐死。
- **ESLint**：`eslint.config.js` 扁平配置（ESLint 9 + typescript-eslint 8），**只开 3 条**：
  `rules-of-hooks`(error) / `exhaustive-deps`(warn) / `no-empty`(warn)。`no-explicit-any` **显式关闭**
  （存量 100 处会淹没 12 条真信号）。当前 **12 warnings / 0 errors**，即 C/D 批的工作面。
- ✅ **`package-lock.json` 已于 2026-09-14 同步**（补齐 eslint 四依赖）。
  🔴 **同步 lock 的正确命令：`npm install --package-lock-only --offline`**——只重算依赖树并写 lock、
  不碰 node_modules，**2 秒**完成；而 `--prefer-offline` 完整装包会联网核对元数据、跑到 9 分钟仍未收尾。
  验证自洽性看**幂等**：二次运行应输出 `up to date` 且 diff 无新增。
  ⚠️ 重算后若出现「删除行」先别慌：逐条判断是**原位元数据重写**还是**真移除**，并核实是否真有代码依赖
  （2026-09-14 即据此确认裁掉的 `playwright-core` 是历史悬空依赖、全仓库无人引用）。
- 🔴 **`exhaustive-deps` 那 11 条警告不能盲改**（2026-09-14 逐条核实）：缺失的依赖**全是组件体内未包
  `useCallback` 的普通箭头函数**（`load` / `calValueOf` / `validateCodes` / `cellVal` 等），身份每次渲染都变。
  直接补进依赖数组会让 `useMemo` 每次重算、`useEffect` 可能死循环。**正确解法是先包 `useCallback` 再加依赖**，
  属逐例判断 + 需跑起来验证，别当成"顺手改改"。

## 单一口径模块（2026-09-14 收敛，新增代码请走这些入口）
- `src/lib/aiParse.ts` —— AI 输出解析唯一入口（详见上文 AI 段）
- `src/lib/constants.ts` —— 跨文件共用的 localStorage 键（`LS_*`）与防抖/轮询常量
- `src/lib/zLayer.ts` —— **z 轴分层真源 `Z`**。🔴 浮层必须高于 modal/prompt（下拉会出现在弹窗内部，
  且全部 Portal 到 body，降下去会导致弹窗内下拉不可用）；Modal.tsx 处保留 `export { Z }` 兼容旧 import
- `src/lib/useSvgPanZoom.ts` —— SVG 画布平移/缩放/节点拖拽（RelationGraph、FactionGraph 已接入；
  GeoMapEditor 走 getScreenCTM 逆矩阵、PlotCanvas 是 DOM 卡片，**不是同一套模型，未接入**）
- `src/lib/seedContent.ts` / `src/lib/materialData.ts` —— 从巨型文件拆出的**纯数据**（原文件保留出口，调用点零改动）
- `src/lib/promptGuard.ts` —— 作者原文进 prompt 的边界守卫（`authorBlock`），详见上文 AI 段
- `src/components/LoadingState.tsx` —— 6 处同款加载态的唯一出口（**空态不在此列**：各处形状差异大，不强抽）

## 三条可复用技法（2026-09-14 实战验证）
- 🔴 **搬迁大块数据必须做到「可证明零改动」**：① 逐行 splice，**绝不重新序列化/转义**
  （模板字符串被二次解析就会破坏）；② 脚本内先做**边界断言**（特征行位置不符即抛错，不产半成品）；
  ③ 搬完做**内容哈希终审**（归一化后 sha256 必须完全一致）。搬 seedData 时长度差恰为
  `15 × len('export ')` = 105，与预期吻合才敢提交。
- 🔴 **抽象泄漏判据：形状不一致就不要抽**。审计曾称 AI 状态「五件套复制 4 份」，实测四个消费方形状各异
  （标准请求结果 / 流式累积 / 带阶段日志的流水线 / 压根没有），强行合一会比重复更糟 —— 已判定不做。
  「重复」只有在形状真的一致时才值得抽。
- 🔴 **功能性测试要「串起来跑」，且用真实数据**：不要只测单函数边界。做法 ——
  ① 先写**临时探针测试** dump 目标数据的真实条目与 id（探针用完立刻删，否则会被 run-all 自动纳入）；
  ② 正式测试全程复用这些真实 id/值，绝不自造；
  ③ 给外层依赖留**注入点**（如 tavern 的 `chatFn`）而非去 mock 模块，生产调用不传即零变化；
  ④ 跑完对关键断言做**负向对照**（关掉修复看是否翻脸）。本轮靠这套抓出两个真 bug。

## JSX 语法速记（我在这上面栽过两次）
- `{/* 注释 */}` **不能**写在 JSX 属性位置（会报 TS1005）。
- `// 注释` **可以**写在 JSX 属性位置（属性行之间），已实测通过 tsc。

## 本机环境坑（Windows + Git Bash，务必绕行）
- `git` **不在 PATH** → 用 `C:/Users/18223/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe`。
- `npm` shim 坏（输出乱码 + 触发 WSL 黑名单）→ 绕行 `"<托管node>/node.exe" "<托管node>/node_modules/npm/bin/npm-cli.js" <命令>`。
  🔴 路径必须写 **`C:/...` 正斜杠**；写 `/c/...` 会被 Git Bash 转成 `G:\c\Users\...` 而报 MODULE_NOT_FOUND。
- Windows 自带同名程序会抢掉 Unix 工具：**`sort.exe`**（`sort -rn` 报「找不到文件」）、**`timeout.exe`**；
  `find ... -o ...` 在 Git Bash 报「参数格式不正确」→ 改用 `wc -l src/lib/*.ts`（**不接 sort**）/ `ls` / Glob 工具。
- 本会话 PowerShell 工具**无输出返回**，别依赖它。
- 🔴 审计纪律：**「数据丢失」级结论禁止直接转述子代理**，必须回源码逐行验尸；
  且要先对照 `docs/1.9.6-2.0.0_Bug与待优化清单.md`——已有 4 条被当成「新发现」，实为 #034 等已登记的已知取舍。

## 酒馆模式（P1 剧情模式已可用；规格书 + 手册见 WorkBuddy 目录）
- 两个来源：`酒馆模式_完整落地方案.md`（规格书）+ `本地模型角色扮演完全手册.html`（**协议全文与既有实践在这里**）。
  🔴 **两者不一致时以方案为准**（2026-09-14 老大定）：角色卡保持**四章**，不并入手册的「不可协商项」「情绪锚点」。
- 四页签：`tavern-plot`（剧情推演）/ `tavern-report`（推演报告）/ `tavern-free`（自由对话）/ `tavern-card`（角色卡片）。
  分组在 `schema.ts` GROUPS：「灵感工具」之下、「开书定位」之上；`FEATURE_TIER` 取 `default`（可选玩法）。
- 🔴 **两条线的数据归属完全不同**：剧情模式 → 项目级 settingsKV（随项目走、导出自动覆盖）；
  自由模式 → **全局 meta**（不绑项目、删项目不跟着没）。改动前先读 `src/lib/tavern/store.ts` 文件头。
- 🔴 **索引与分条必须成对读写**（`tavern.sessionIndex` ↔ `tavern.session.<id>`），否则出现「列表有、点开空」的
  幽灵条目；store 内已有 `auditXxx` / `pruneGhostXxx` 自检可查可清。
- `tavernReports` 是独立表（DB_VERSION 10）。四处登记外另有**两处易漏**：`deleteProject` 清理、
  `applyBundleToProject` 需先清后写（备份恢复路径）。
- 模块地图：`src/lib/tavern/` → types / store / protocol（**从手册逐行搬入，勿手改**）/ prompt / budget / params / engine / report。
- 🔴 **提示词层序不可乱**：设定 → 记忆 → 身份边界 → 档位 → 未带入声明 → **协议（钉绝对末尾）**。
  协议自带「最后提醒」，放末尾才紧贴生成点。

### 🔴🔴 防剧透是两层，只做一层等于没做（2026-09-14 端到端测试实测）
① **段落级**：`viewMode:"character-view"` 排除 10 个作者侧页签（总纲/大纲/细纲/章节总表/伏笔/爽点/支线/灵感/写作规范/设定变更）；
② **字段级**：`AUTHOR_SIDE_FIELDS`（aiContext.ts，30 个字段名）隐藏常识表内的**未来向列**。
⚠️ 只做①不够 —— 常识表（char-*/relations/nations/history…）里混着「结局归宿」「隐藏设定」「演变轨迹（按卷）」
「剧情作用」这类列，会照原样喂给模型，演员照样提前知道结局。**新增带未来向字段的页签时，务必同步登记到②**。
口径：只列明确指向「尚未发生之事/作者底牌」的字段；中性字段（备注/知情度/关系现状）保留，避免误伤角色常识。
改动这两块前后必须跑 `tests/tavernContext.test.ts` + `tests/tavernFlow.test.ts`。

- 🔴 酒馆全程 `think: false`（角色扮演要「像人说话」不要「想得深」），是对 ai.ts 全局政策的**有意例外**。
- 报告 findings **必须能指回具体条目**：指不回去的一律降级「存疑」并留空 id（不硬编假 id）；
  UI 的「定位」按钮走 `yfe:navigate` 事件（detail = { tabId, rowId }）。
- 参数坑：界面叫「重复惩罚」，内部 `repeatPenalty`，Ollama 是 `repeat_penalty`；`num_ctx` 必须显式传。
- 可测性：`runPlotTurn(session, text, cb, { chatFn })` 与 `generateReport(session, { chatFn })` 都留了注入点 ——
  整条链路可在**不起真实模型**的前提下跑通（`tests/tavernFlow.test.ts`，用示范项目真实数据）。
- ⚠️ 未做：扮演设定（CastSetting）编辑表单；P2 自由模式核心逻辑（记忆引擎 `auto_interval=600s` / `auto_lock_ttl=1800s`）。

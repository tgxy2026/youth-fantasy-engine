# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。

## 项目身份与红线
「青春幻想引擎」Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。**当前 2.1.0**（2026-09-14 由 2.0.1 升，酒馆模式这轮的版本号；按老大要求只改号不封装）。2.0.0 于 2026-09-04 收官发布（桌面 84.6MB / 便携 8.85MB，仅发桌面/便携，网页版已关服待处置）；后续约每月一版，重大改动再单独封装。
- 清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。
- 🔴 **封装/重打包须老大明说「封装」**；改完最多 tsc+build+commit。
- 提交含 `!` 用 `git commit -F <文件>`。main 无远程。
- 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
- 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
- 服务器属主 `/var/lib/yfe` 须 www-data；sudo 写后必 `chown`+`sudo -u www-data test -w`。

## 版本号
- 唯一源＝`package.json` version（当前 **2.1.0**）。展示用 `APP_VERSION_LABEL`（`v2.1.0`／兜底「开发版」），`env.ts` 转出。改号时顺手同步 `portable.ts` 里「正式版为 vX」那句注释。
- 🔴 dev 下 `define` 不替换 `__APP_VERSION__`；`vite.config.ts` 已加 `injectAppVersion()` 补 dev 替换。
- 老大口径：不加 dev 角标；「开发版」＝跑在开发服务器上。

## 封装/构建坑
- 🔴 桌面 `build-desktop.mjs` 的 `ELECTRON_CACHE` 须指向系统默认缓存 `AppData/Local/electron/Cache`，**切勿**指向 `release/eb-cache/electron-zip`（仅扁平 zip、缺 @electron/get hash 结构）→ 离线打不出运行时，只产 ~500KB NSIS 空壳。
- 正常产物体积：桌面安装包 **80.68 MiB**（＝资源管理器「80.6M」＝十进制 84.6MB，同一个文件）、便携单文件 **8.44 MiB**。🔴 两个构建脚本已内置体积闸门（`MIN_SETUP_BYTES=50MB` / `MIN_PORTABLE_MB=5MB`），**无论退出码是否为 0，体积不达标即 abort**——别退化成「exe 存在即成功」。
- ⚠️ **Edit 工具会「假成功」**，dev server 运行时概率明显更高（一次连改 6 组件有 3 次回执 Success 但文件未变）。**对策：① 每笔 Edit 后立即 grep 复查；② 批量/多处替换改用 node 脚本（`split/join` 精确替换，未命中即抛错），成功率高得多。**
- ⚠️ 脚本替换的**空串陷阱**：`to` 为空串时 `includes('')` 恒真 → 「已存在」会误判为跳过。删除类操作改用**按行号**处理。
- ⚠️ **CRLF 锚点陷阱**：仓库多为 CRLF，含换行的多行锚点若用 LF 拼会被整体判「未找到」。脚本里统一 `const eol = s.includes('\r\n') ? '\r\n' : '\n'` 再拼锚点。
- rcedit `Unable to commit changes` 是 cosmetic 报错，非真失败。
- 🔴 NSIS 安装权限：`nsis.perMachine:false` + `allowToChangeInstallationDirectory:false` → 强制按当前用户装到 `%LOCALAPPDATA%\Programs`，重装永不需管理员。旧版在 Program Files 的用户需「右键→以管理员身份运行」一次新版完成迁移（提示已写进 AboutPage）。切勿把 `allowElevation` 设 false。

## 架构红线
- 无 i18n 基建（全中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake 陷阱：组件只在某平台门控分支被引用→其余平台摇掉整模块。渲染门控须「需该模块平台之并集」。
- 左下角只准一个浮层 `DataDock`（项目管理页）；项目内禁用全局 fixed 浮层，一律内嵌 Sidebar Footer。
- 种子：卡片 data 键=`模块名::字段名`、表格行键=schema 列名；改种子必跑 `node tests/seed-schema-check.mjs`。
- `WEB` 由 `__WEB__` 决定，禁写 `!PORTABLE && !DESKTOP`；顶层副作用双守卫。
- 🔴 编辑器双图层（NovelEditor.tsx）：`highlightOn` 开启时 textarea `color:transparent`，所见文字全来自 `highlightRef` 叠层。改编辑器必守——① 叠层与 textarea 盒模型逐项一致（`inset-0`+`px-6/8`+`pt-6`+`pb-[40vh]`，改一侧必同步另一侧）；② 叠层重建会归零 scrollTop，凡 highlightHTML/切章/字号/页宽/专注/检索栏变化必须用 `useLayoutEffect` 回填；③ 高亮扫描只走 `scanRefHighlight` 单次正则，禁止 `filter(x=>text.includes)` 双扫，超 `HIGHLIGHT_MAX_LEN` 降级。切章需同步 `setDeferredContent`。

## 三端存储（数据丢失风险）
- 桌面：`AppData\Roaming\novel-studio\novel-studio-data.json`，整库一 JSON，防抖 800ms 重写。⚠️ 勿让 WPS 云盘同步整个目录（leveldb 锁+非原子写→空库）。
- #033：桌面数据文件可自定义路径（`data-location.json`），`writeAtomicSync/Atomic`（刻意不留 .bak）；IPC `store:chooseDataDir/setDataPath/resetDataPath/isCustomPath`。
- 便携(FSA)：`flush()` 用 `createWritable()→write()→close()` 即 swap 语义，勿重复 tmp+rename。薄弱点＝末批编辑来不及落盘，已加 `flushNow()`+`visibilitychange/pagehide` 尽力而为。

## 同步方案
- 判据：过服务器→要码；云盘→不要码（`DEFAULT_CLOUD_KEY`，文件 `青春幻想引擎-同步数据.yfe`）。
- 🔴 两路径二选一，绝不同时指向同目录。
- ⚠️ 架空陷阱：`enableDesktopCloudSync` 仅 `rev===0 && 空` 播种；云盘有数据则第二台原稿不播种但本地 JSON 仍在→救法＝关云盘同步切回本机。
- ⚠️ 轮询盲区：「换设备前先关软件+等同步完成」硬纪律。
- 🔴 `backups` 是**本地专属**（2026-09-14 修正真 bug）：云端载荷不含它（`liveStores` 上传前剔除），故 `makeCloudStoreWrapper` 必须把其读写**短路到 local**。否则备份只活在内存 cache、刷新即丢。影响三端（`desktopCloudSync` 与 `serverStore` 共用 `createCloudStore`）。
  ⚠️ 推论：`seedFromLocal` 那次 backups 读取因此成无用功（已跳过）；**但它差点被误删**——`store.getAll` 从 cache 读，而 seedFromLocal 恰是唯一把本地备份载入 cache 的地方。**纪律：「死配置」结论必须先验消费方再动手。**

## 网页版与备份（2.0 只发桌面/便携）
- 桌面/便携零联网（API 全被 `WEB &&` tree-shake）。
- 🔴 #031：自动备份写在**同一存储**，须**导出外部文件**才发现得了容器丢失。`BackupReminder.tsx`+`lib/backupReminder.ts` 三端通用，>7 天未导出且静默期过且**有数据**才提示；三处导出成功调 `markExported()`。关服公告 `SHUTDOWN_NOTICE` 已填「网页版 2026-09-29 08:49:53 停止服务」。
- 分发网盘（夸克）：链/码/口令见 `AboutPage.tsx` 三常量。换版只传新安装包。
- 复制交互统一 `copyText()`。

## UI 规范
- Button.tsx 套尺寸 primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；裸图标传 `iconOnly`。
- 8 套主题 `<html data-theme>`；浅色 4=护眼/羊皮卷/青花/桃笺，禁低透明度 amber 表数据（实色 `bg-amber` 最低 `/40`）。
- 🔴 **SVG 里用 CSS 变量必须走 `style`，不能写表现属性**：`fill="rgb(var(--x))"` 一律无效（表现属性不做自定义属性替换）→ 回退为黑且**静默不报错**。必须 `style={{ fill: 'rgb(var(--x))' }}`；含 var() 的动态色同理。2026-09-14 全项目扫出 3 处受害者（RelationGraph 边标签底板、WritingGoals 燃尽图网格线与轴标签、琥珀目标线）。**新增/改 SVG 前先看这条。**
- 图谱/画布界面色统一走 `--graph-*`（`src/index.css`）；⚠️ 分类色盘（关系类型色等）是数据分类色，靠色相区分，**不要主题化**。

## AI / 服务器
- AI：颉文姬5模式 clinic/edit/review/brief/ledger；硅基流动 DeepSeek-V3.2。明文本地记忆勿公开。
- 🔴 AI 返回解析统一走 `src/lib/aiParse.ts`（`parseObjectArray` / `parsePlainObject` / `hasSubstance` / `asText` / `humanText`）。勿退回"先按 `[` 切片"老写法（单对象会判失败返回空 → 内容全丢，2.0.1「改稿只剩标点」）。**禁止手写裸 `JSON.parse` 解析模型输出**。
  ⚠️ `hasSubstance` 目前只在 aiRewritePassage 一处生效，其余约 10 处兜底仍直接回 `humanText` 残骸。
- 🔴 **迁移只走 `db.runMigrations()`**（types → ledger → numbering，幂等）：boot 恢复与手动 openProject 必须共用。**顺序不可调换**。db 层不引用 schema，刷卷页签由调用方 `refreshVolumeTabs()`。
  📌 `getDB` 的 upgrade 已拆为 9 个独立函数（`migrateFreshInstall` / `migrateV1toV2` … `migrateV8toV9`）。**upgrade 处是「何时跑哪一段」的唯一判断点**，函数内不再重复 `oldVersion` 条件。全新安装走 `migrateFreshInstall` 后不 return（空库空转，刻意保留）。
- 🔴 prompt 注入防护：作者原文进 prompt 前走 `src/lib/promptGuard.ts` 的 `authorBlock(id, text)`（随机 nonce 定界 + 段前声明）。两条硬约束：① 随机 nonce 而非固定符号；② **绝不清洗正文内容本身**（`aiProofread` 依赖 `text.indexOf(chunk)` 定位分块）。
- 🔴 温度：**不要在任务层手填温度**。结构化 JSON 传 `chat(..., { json: true })` → `JSON_TASK_TEMPERATURE`(0.3)；创意类不传即 `DEFAULT_TEMPERATURE`(0.85)。`CallOpts.temperature` 已必填、下游无第二个兜底点。新增 AI 任务务必带 `json: true`。
- 服务器 `154.8.178.240`(腾讯云 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`。站点 `/var/www/yfe`；反馈 `/opt/yfe-server/feedback-server.mjs`。详情见 `docs/服务器访问记录.md`。
- 网页部署：`vite build --config vite.config.web.ts`→`dist-web` → tar 单包 → scp 到 `/tmp` 中转 → `sudo cp -a` 备份 → 清旧 assets/index.html → 解包 → `chown` → `sudo -u www-data test -w` 验收。
- 🔴 部署校验陷阱：Nginx SPA 回退使**任意不存在路径都返回 200 + index.html**——**绝不能用 HTTP 200 判断资源是否上线**。须核对 `Content-Length`/`Last-Modified` 与首字节内容。

## 工程质量与验证
- **命令**：`npm run verify`（= typecheck + lint + test）/ `npm test` / `npm run lint`。
- **测试 runner**：`tests/run-all.mjs` 自动发现 `tests/*.test.ts` + `seed-schema-check.mjs`。🔴 **每个入口单开子进程**——`roundtrip` / `adversarial` 结尾是 `process.exit()`，同进程串跑会被掐死。
- **ESLint**：`eslint.config.js`（ESLint 9 + typescript-eslint 8），**只开 3 条**：`rules-of-hooks`(error) / `exhaustive-deps`(warn) / `no-empty`(warn)；`no-explicit-any` 显式关闭（存量 100 处会淹没真信号）。当前 **11 warnings / 0 errors**。
- 🔴 **`exhaustive-deps` 那 11 条不能盲改**：缺失依赖全是组件体内未包 `useCallback` 的普通箭头函数，身份每次渲染都变；直接补会让 `useMemo` 每次重算、`useEffect` 可能死循环。**正确解法是先包 `useCallback` 再加依赖**。
- `package-lock.json` 已同步（补齐 eslint 四依赖）。🔴 **同步 lock 的正确命令：`npm install --package-lock-only --offline`**（只重算依赖树、不碰 node_modules，2 秒）；`--prefer-offline` 完整装包会联网核对元数据、跑 9 分钟不收尾。验证自洽看**幂等**（二次运行应 `up to date` 且 diff 无新增）。出现「删除行」先判断是原位重写还是真移除（曾据此确认裁掉的 `playwright-core` 是历史悬空依赖）。

## 单一口径模块（新增代码请走这些入口）
- `aiParse.ts` AI 输出解析 / `constants.ts` 跨文件 localStorage 键与防抖常量 / `promptGuard.ts` 作者原文边界守卫
- `zLayer.ts` **z 轴真源 `Z`** —— 🔴 浮层必须高于 modal/prompt（下拉全部 Portal 到 body 且会出现在弹窗内部）；Modal.tsx 保留 `export { Z }`
- `useSvgPanZoom.ts` SVG 画布平移/缩放/节点拖拽（RelationGraph、FactionGraph 已接入；GeoMapEditor 走 getScreenCTM、PlotCanvas 是 DOM 卡片，**未接入**）
- `seedContent.ts` / `materialData.ts` 从巨型文件拆出的纯数据（原文件保留出口）
- `LoadingState.tsx` 6 处同款加载态的唯一出口（**空态不在此列**，形状差异大不强抽）
- `AutoTextarea.tsx` —— **所有多行输入框的唯一出口**。默认最小高度 32px（历史行为），
  要「至少 N 行」传 `minRows`（按**计算行高**换算，换字号无需改）；**字号从 `textClass` 传，
  别塞 className**（Tailwind 同类工具类谁生效取决于生成顺序）。酒馆各页已全部接入。

## 可复用技法（2026-09-14 实战验证）
- 🔴 **搬迁大块数据必须「可证明零改动」**：① 逐行 splice，**绝不重新序列化/转义**；② 脚本内先做**边界断言**（位置不符即抛错）；③ 搬完做**内容哈希终审**（归一化后 sha256 完全一致）。
- 🔴 **抽象泄漏判据：形状不一致就不要抽**。「重复」只有在形状真的一致时才值得抽。
- 🔴 **功能性测试要「串起来跑」且用真实数据**：① 先写**临时探针测试** dump 真实条目与 id（用完立刻删，否则会被 run-all 纳入）；② 正式测试复用真实 id/值；③ 给外层依赖留**注入点**（如 `chatFn`）而非 mock 模块；④ 对关键断言做**负向对照**。

## JSX 语法速记（栽过两次）
- `{/* 注释 */}` **不能**写在 JSX 属性位置（TS1005）；`// 注释` **可以**。

## 本机环境坑（Windows + Git Bash）
- `git` 不在 PATH → `C:/Users/18223/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe`。
- `npm` shim 坏 → 绕行 `"<托管node>/node.exe" "<托管node>/node_modules/npm/bin/npm-cli.js" <命令>`。🔴 路径必须 `C:/...` 正斜杠；`/c/...` 会被 Git Bash 转成 `G:\c\Users\...` 报 MODULE_NOT_FOUND。
- Windows 同名程序抢 Unix 工具：`sort.exe`、`timeout.exe`；`find -o` 报错 → 改用 `wc -l`（不接 sort）/ `ls` / Glob。
- 本会话 PowerShell 工具无输出返回。
- 🔴 审计纪律：**「数据丢失」级结论禁止直接转述子代理**，必须回源码验尸；先对照 `docs/1.9.6-2.0.0_Bug与待优化清单.md`（已有 4 条被当成新发现，实为 #034 等已登记取舍）。
- 🔴 **实弹测试会读到真实 apiKey 并进上下文**（从桌面版数据文件读 provider 配置）。用前先告知老大，建议事后轮换 key。绝不写文件/打印/提交。

## 酒馆模式（P0–P3 全部落地；规格书 + 手册见 WorkBuddy 目录）
- 两个来源：`酒馆模式_完整落地方案.md`（规格书）+ `本地模型角色扮演完全手册.html`（**协议全文在这里**）。🔴 **不一致时以方案为准**：角色卡保持**四章**，不并入手册的「不可协商项」「情绪锚点」。
- 四页签 `tavern-plot` / `tavern-report` / `tavern-free` / `tavern-card`；分组在 `schema.ts` GROUPS「灵感工具」之下、「开书定位」之上；`FEATURE_TIER` 取 `default`。
- 🔴 **两条线数据归属不同**：剧情 → 项目级 settingsKV（随项目走、导出自动覆盖）；自由 → **全局 meta**（删项目不跟着没）。改前先读 `src/lib/tavern/store.ts` 文件头。
- 🔴 **索引与分条必须成对读写**（`tavern.sessionIndex` ↔ `tavern.session.<id>`），否则出现幽灵条目；store 内有 `auditXxx`/`pruneGhostXxx`。
- `tavernReports` 是独立表（DB_VERSION 10）。登记外**两处易漏**：`deleteProject` 清理、`applyBundleToProject`（先清后写）。
- 模块地图：`src/lib/tavern/` → types / store / protocol（**从手册逐行搬入，勿手改**）/ prompt / budget / params /
  engine / report / memory / summarize / daily / cardFile / import / **settings（控制面板设置）** / seedCards。
- 🎛️ **控制面板（`tavern-control` 页签，2026-09-14）**：三段（通用 / 剧情推演 / 自由对话）+ 协议只读展示。
  设置存**全局 meta `tavern.settings`**，**一律走 `getTavernSettings()`**（与默认值深合并）——
  直接读 meta 会在新增字段后读出 undefined 并一路传下去。默认值＝原硬编码值，改动它必须是有意识的。
  参数优先级链不变：会话参数 → 角色参数 → **控制面板** → `TAVERN_DEFAULTS` 兜底。
  阈值类函数都收成**可选参数注入**（trimMemory / parseMemoryText / throttleOk / shouldRunAutoSummary /
  shouldAdvanceDaily / buildSummarySystem），不传即原行为 —— 新增调用方别硬写常量。
  📌 **面板现已覆盖**：默认模型、上下文预算、固定开销预留、请求超时、上下文窗口、关闭思考链、通用补充要求、
  两模式各自的采样参数与风格/补充要求、整理模型、记忆六项阈值、日常两项、以及**扮演协议全文**（可编辑）。
  📌 **再加参数前先搜一遍**：在 `src/lib/tavern/` 里搜写死的数字/常量，逐个判断是否属「AI 行为参数」；
  但**别把设置项挪进新模块** —— settings 若引用反向依赖 engine 的模块（如 daily.ts）会成环，
  常量该上移到 `types.ts` 就别留在原处（`DAILY_LOG_KEEP` 即此例）。
  📌 **协议默认 = `PROTOCOL_CORE`，可被 `settings.protocol` 覆盖**（`PromptLayers.protocol`）；
  清空时 `buildSystemPrompt` 回退内置常量，避免 system 尾部空掉。面板进编辑前**必须弹窗警示**。
  📌 **采样参数下发链已通**（见上一段）；面板上任何新增旋钮都要先确认「它真的到模型了吗」。
- 🔴 **提示词层序不可乱**：设定 → 记忆 → 身份边界 → 档位 →（通用补充要求 → 模式补充要求）→ 未带入声明 →
  **协议（钉绝对末尾）**。两段「补充要求」来自控制面板，**放在协议之前**，免得打断协议末尾那条
  「最后提醒」的近因效果（`buildSystemPrompt` 的 styleHint / commonExtra / modeExtra 三个可选层）。
- 🔴 **采样参数下发链**（2026-09-14 接通，此前是断的）：`params.ts` 的 `toOllamaOptions` 曾**全项目无人调用**，
  除 temperature 外一个参数都没到过模型 —— 做界面之前先确认这一点，否则面板上的旋钮全是死的。
  现走 `ai.ts` 的 `ChatOptions.extraOptions`：Ollama 原样并入 `options`；OpenAI 兼容路径只转发
  `OPENAI_SAFE_SAMPLING` 白名单（top_p / presence_penalty / frequency_penalty），
  **top_k / repeat_penalty / num_ctx 是 Ollama 专有字段，绝不能发给 OpenAI 兼容端点**。

### 🔴🔴 防剧透是两层，只做一层等于没做
① **段落级**：`viewMode:"character-view"` 排除 10 个作者侧页签；
② **字段级**：`AUTHOR_SIDE_FIELDS`（aiContext.ts，约 30 个字段名）隐藏常识表内的**未来向列**（结局归宿/隐藏设定/演变轨迹/剧情作用…）。
⚠️ 只做①不够——常识表里混着这些列会照原样喂给模型，演员提前知道结局。**新增带未来向字段的页签时务必同步登记到②。** 中性字段（备注/知情度/关系现状）保留。改这两块前后必跑 `tests/tavernContext.test.ts` + `tests/tavernFlow.test.ts`。

### 🔴 四条「提示词与解析器必须对齐」的教训（都踩过）
1. **解析器要按提示词的写法写**，不是按你以为的写法（行内键值「视角与人称：第一人称…」、标题接内容同行「【她的心情】有点烦」都曾整章丢失）。
2. **段落标题判定必须整行匹配**，不能用 `includes`（日志行「09-15：心情不错」会被当标题）。
3. **序号裸化与标题正则必须一致**：裸化去一切序号变体、正则只匹配纯名字，抽单一 `normalizeTitle`。
4. **校验要查全部字段**，不能抽查几项（没提示会被理解成「都填好了」）。

### 🔴 酒馆模式其余要害
- 全程 `think: false`（角色扮演要「像人说话」），是对 ai.ts 全局政策的**有意例外**。⚠️ **`think` 是 Ollama 专有参数** —— 走 openai 兼容接口（硅基流动等）不被识别，推理模型照样思考（`Qwen3.5-35B` 首字 28–51 秒、报告 180 秒超时）。**选型：用非推理模型或本地 27B。**
- 报告 findings **必须能指回具体条目**；指不回去的一律降级「存疑」并留空 id。UI「定位」走 `yfe:navigate` 事件（detail = `{ tabId, rowId }`）。
- 参数坑：界面「重复惩罚」→ 内部 `repeatPenalty` → Ollama `repeat_penalty`；`num_ctx` 必须显式传。
- 可测性：`runPlotTurn(..., { chatFn })` 与 `generateReport(session, { chatFn })` 留了注入点，整链可在不起真实模型下跑通。
- 🔴 **实弹脚本（手动，刻意不进回归）**：`node tests/build-test.mjs live-tavern` / `live-free`；加 `YFE_LIVE_SKIP=1` 只做离线检查。命名为 `tests/live-*.ts` 而非 `*.test.ts`；`build-test.mjs` 已支持「优先 `<entry>.test.ts`，找不到再找 `<entry>.ts`」。
  ⚠️ avatar 里配的 Ollama 模型 `huihui_ai/qwen3-abliterated:32b` 本地**不存在**（404）；实际有 `qwen3:4b-instruct` 与 `orcarouter/Qwen3.8-27B-Uncensored:q6_K`。
- 扮演设定（CastSetting）已落：表单 `TavernCastSetting.tsx`，入口在剧情推演页左栏「角色分配」每个角色旁；六字段经 `prompt.ts → renderCastSetting` 进 `cast` 层（**身份层之后、协议之前**）。⚠️ 原先 `buildSystemPrompt` 根本没接收扮演设定——只做表单等于填了静默无效。**AI 角色的块写「你要演成这样的人」；作者角色的块明确「不要代写他的言行」。**
- **P0–P3 全部落地**（2026-09-14）：剧情模式（建会话/扮演设定/推演/报告定位）、自由模式（六栏记忆 `memory.ts` / 总结 `summarize.ts` / 角色卡 `TavernCard.tsx` / 自由对话 `TavernFree.tsx`）、P3（日常推进+主动留言 `daily.ts` / 导入导出 `cardFile.ts` / 单向桥 `import.ts` / 多角色同场）。**只剩「角色头像上传」未做（字段已留）。**
- 🔴 **总结必须带角色背景**（`summarizeMemory({ charContext })`）：只给「旧档案+对话」时模型会把角色卡的「便利店」总结成「咖啡店」，记忆从第一次总结就漂移。补背景 + 「以角色背景为事实基准」后修正。
- 六栏行为差异是硬约束（会缩/只增/重写/滚动）；「关键事实」「未爆的雷」被写空时**沿用旧值**（失忆比重复糟）。总结锁：`SUMMARY_MIN_INTERVAL_MS=600s` / `SUMMARY_LOCK_TTL_MS=1800s`。
- 🔴 **实弹闭环验证法**：聊出事实 → 总结 → **新建一个没有任何原文的新会话**再问同一件事（「记忆能被用上」不能靠原文还在上下文里冒充）。

# novel-studio 长期记忆
> 规则/红线/决策；事件留 `YYYY-MM-DD.md`。⚠️ 上限 ~6100 —— 新增前先查同类、合并改写。

## 红线
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴 禁 `git stash`（2026-09-14 中断 → `.git/refs`、pack、松散对象永久丢失）；遇 `bad object HEAD` 先 `ls .git`。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md` 只记录，明说「处理」才动。提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199。
- 现 **2.1.1**。版本唯一源 `package.json`（dev 由 `injectAppVersion()` 注入 `APP_VERSION_LABEL`）。⚠️ `package-lock.json` 根版本常落后、且含依赖自己的同号版本 → 只改 `j.version`＋`j.packages['']`。
- 🔴🔴 封装**全程无沙箱跑**（沙箱拦 dist rename／写 release／删目录）。rcedit 间歇失败（**退出码仍 0**，只认 stderr `Fatal error`）已由 `scripts/after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`；`ELECTRON_CACHE`→`AppData/Local/electron/Cache`（skill §7）。
- 🔴🔴 **只做桌面版**（无 WEB/PORTABLE）。`StoreOps`/`PortableData` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径。

## 架构红线
- 无 i18n；schema 列名即存储键（功能改完回搜 `schema.ts` 的 `description`）。
- ⚠️ 运行时/打包陷阱：①tree-shake —— 组件只在平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台并集」，删门控必跑 `vite build` 验产物；②`DESKTOP` 是运行时探测（`window.electronStore`）→ dev 浏览器恒 false（`DataDock` 有 DEV 兜底）。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑 `seed-schema-check.mjs`。
- 🔗 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（连带须**双向**）＋`ANY_DEPS`；闸 `feature-deps-check.mjs`。
- 🔴 编辑器双图层（高亮时文字全来自叠层）：盒模型逐项一致；叠层重建归零 scrollTop → 触发点须 `useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🗺 多地图（方案 B）：新表 `geomaps`＋geography 的 `所属地图`；格档**按图**存；`migrateGeoMaps` 建默认图＋回填；🔴 删图不删地点、改图名连带改归属。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录；🔴 图片字段先压缩再入库；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属 → `makeCloudStoreWrapper` 必须短路到 local。🔴🔴 桌面读数据文件失败必须**锁写盘**（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔄 **两同步入口别混**：①改数据文件位置＝明文 JSON 进云盘（文件级覆盖、apiKey 明文上云）；②云盘文件同步＝加密 `.yfe`＋记录级合并＋每日备份＋兜底。**用 ②**。
- 🔴 2026-09-15 修掉一批（详见 `docs/2.1.1-审计修复记录.md` §四）：换目录前先抓旧数据再 `configure()`；空推按**记录总数**判；关同步前先 flush；409 解密失败直接抛；IPC 写失败要抛；启动拉不到快照清 ENABLED 标记。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，分类色盘不主题化。🔴 SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 回退黑）；设置项排版＝标题→输入→说明；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：①量尺寸算回 CSS 值一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；②**zoom 不缩放 vh** → CSS 类由 index.css 折（`.h-screen`/`.min-h-screen`），**内联长度一律走 `foldVh()`**（`theme.ts`，否则弹窗高过视口、页脚按钮点不到）；③SVG 滚轮锚点与拖拽都要除 zoom。
- 🔴 按对侧高度定高：flex item `min-height:auto` 会顶回定高 → 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框别用 `ghost`（→`secondary`）；分段开关 `toggle`+`selected`；行内小操作 `size="xs"`；`danger` 破坏性；列表选择项不算按钮。
- 🔴 每页签页头要 `HelpPopover` 问号。头像兜底＝**名字**（`avatarLabel` 封顶 2 字），自定义图优先；剧情推演头像取自项目卡（无则首字圆标）。输入：Enter 发送／Shift+Enter 换行，**必挡 `nativeEvent.isComposing`**；快捷指令只预填不发送；两侧消息均无气泡框。
- 界面文案禁 markdown 星号 → 用「」/（）；同一事别写成互斥分支。

## AI 层
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）。温度不手填：结构化 `{json:true}`→0.3、创意类→0.85；一轮 JSON 走 `aiChatJson`（自带 json＋`think:false`）。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）；upgrade 是「何时跑哪段」的唯一判断点。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`），站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务 → 删库 ≠ 下线；⚠️ Nginx SPA 回退：不存在路径也返 200 → 不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；runner 每入口单开子进程；ESLint 11 warnings 别盲改。🔴 实机验证走 skill `novel-studio-ui-livecheck`；实弹断言会静默过时 → 日志必 grep ✗；子代理结论必回源码验尸（误报约 15%）。

## 酒馆模式
- 源《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 调研稿（冲突以方案为准）。**实现细则一律看 `docs/酒馆模式-工程红线.md`**（17 节：导出/头像/额度/示范卡/本场变量/剧本/背景设定/联网检索/对话引导/配平/按钮）—— 动对应功能前先读那一节。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景**随项目**；自由会话+角色卡+记忆日常+面板设置+剧本库**跨项目**（索引与分条须成对，tavernReports 别漏 deleteProject）。
- 🗺 **故事层（09-16 新增，自由对话专用）**：`tavern.storyIndex`／`tavern.story.<id>`（跨项目）。故事（这个世界什么样）→ 剧本（这一场发生什么）**父子结构**；页签「**故事剧本**」在角色卡片**之前**。剧本 `storyId` 必填；角色卡 `storyId` 空＝**自由状态**（落左栏「未归属」抽屉）；会话 `storyId?`。🔴🔴 **删故事＝删其下剧本、角色卡一张不删**（只解绑，卡连着记忆与日记）。🔴 归属取值一律走 `cardStoryId()` / `sessionStoryId()`（**自己存的优先，旧会话才按角色反推**——反推会随卡改归属而搬家）。🔴 `saveStory` 统一收口名字长度（界面 maxLength 只是辅助）。
- 🎛 控制面板＝`tavern.settings`（**八段**）；优先级 会话→角色→面板→模式默认；数值真源 `paramGuide.ts`；⚠️ 废弃字段须在 `upgradeLegacyDefaults` 删（mergeDeep 会回填）；🔴 左列以协议**收尾**、右列放两模式手感，段号一动「N 段设置」文案一起改。
- 🔴 层序：设定→背景设定→这一场(剧本)→记忆→身份→档位→（通用→本场补充）→未带入→协议→**数值块**（协议之后；放前面会被那 3.5KB 格式规范盖过去）。
- 🔴🔴 上下文预算：`historyBudget`＝预算−400−整条 system（**别传记忆**）；contextBudget **24000**（三处一致）。源 both/digest/raw；空层不占额度。
- ⚙️ 出厂参数 2026-09-15 放宽一档（数值表见 `types.ts`／`paramGuide.ts`；**numCtx 仍 32768，别动**）。🔴 值须落在 paramGuide **推荐段**内（有测试闸）；改默认值**必须同加 `upgradeLegacyDefaults` 的「全等旧值才升」规则**。
- 🔴 记忆 vs 设定：记忆＝发生过什么＋此刻温度（`summarize.ts`）；设定＝这让 Ta 变成谁（`revise.ts`）。📚 背景设定：关键词空＝总是注入、上限 2400 字；键只剩 `tavern.world`。
- 🧠 **整理时机（2026-09-16 定死：全项目没有「自动整理」）**：只有两个**手动**入口 —— 自由对话「结束本轮对话」（`roundEnd.ts`：记忆+日记+数值+设定审查，然后归档只读）、剧情推演「整理本场记忆」（`TavernPlot` 那个按钮，不归档）。原「条数阈值自动整理」整层已删：`triggerMessages`/`summaryMinIntervalMin`/`countUnsummarized`/`shouldSummarize`/`throttleOk`/`shouldRunAutoSummary` 全部不存在了（**别再照旧记忆去找**）；🔴 **只保留跨实例锁 + TTL**（`summaryLockTtlMin`）。老库残留的两个死键由 `upgradeLegacyDefaults` 主动删。🔴 **`vars`（好感/心情）也随之只在收尾刷新**。🔴 `summarizeRound` 一次调用同时吐六栏档案＋本场日记，解析前必须 `splitJournalSection` **先切日记再解析**（否则那一段会并进「最近日记」，而那份记忆每轮进上下文＝白烧额度）。📔 **日记 `tavern.free.journal.<charId>`（`JOURNAL_KEEP=50`）＝ Ta 的第一人称回顾**：`JOURNAL_HEAD='〖本场日记〗'`（**刻意不带序号**，带「七、」会被当成第七栏记忆，`tests/tavernRoundEnd.test.ts` 有 6 条断言钉着形态：第一人称／写经过＋写感受／不进记忆不进任何提示词／界面只读、可删且**删除必须弹窗**）。删卡时连它一起清。字数 **200–600**（写得细不占额度）。🔴 会话归档后（`endedAt`）**输入区换只读提示＋新开一场**，且 `reroll`／消息工具条（`MessageOps.locked` 整条不渲染）／在场调度／数值输入全部锁死 —— 只有 `send()` 守卫是不够的（作者会以为软件坏了）。
- 📊 **本场数值唯一入口**＝自由对话**右栏「本场状态」**（`TavernVarsPanel.tsx`，栏内直接编辑）；中间那条 `TavernStatusBar` 只剩「场景 + 角色状态（只读）」，**别再往它里面加数值**（2026-09-16 去重，方案 B）。
- 🗂 **第 1 章标题统一「角色与设定的关系」**（不再是「世界」）：界面/渲染/导出/起草/导入提示词全一致；🔴 导入器解析锚点**同时认旧名**（世界/世界观/背景…），老卡与老模型输出不能丢。
- ✅ **反馈 #1 已修（2026-09-16）**：明细总额度不跟面板变 = **显示 bug**（引擎那条路本来就对）。根因是「同一个数两处各算一遍」——明细直接读 `session.params.contextBudget` 再回落硬编码常量，绕过了控制面板。已抽 `settings.ts` 的 `resolveParamsOf()` / `effectiveContextBudget()`，**engine 的 3 处内联 resolveParams 与 TavernUsageDialog 都改走它**，结构性杜绝再分叉。
- ⏳ **待老大拍板的三件（方案文档 §10.2 有选项）**：① `summaryMinIntervalMin` 已成全应用死键（建议删，连带 `shouldRunAutoSummary`/`throttleOk` 与断言）；② `triggerMessages` 实际只被 `TavernPlot` 用，却挂在「七、自由对话控制」；③ 本场数值同时在**中间状态栏（可改）**与**右栏本场状态（只读）**显示两次。
- 🎭 剧本 `script.ts` 六栏：🔴🔴 会话存**快照**不是引用；开场白不进 system（＝第一条消息）。🔴 `engine`↔world/script/draft 环已上移 `provider.ts`；设定更新＝12 字段白名单（不含 name）＋二次把关。
- 🔴 分支/回滚：`branchSession` 截到该条、分叉点后**连记忆一起清**；回滚连记忆还原＋`undoSnapshot`；重说＝`run*Turn(session,null)`；剧情记忆 `runPlotSummary`→`memoryToText` 写回 `session.memory`＋推水位线（**全成功才推进**）。
- 🔴 多角色：`buildMultiCharRule` 必传 `{hasUser:false}`；`userCharId` 的卡/记忆/轮转排除；在场调度 `muted`+`talkativity` 会话级、两模式共用（静音＝在场不发言、卡与记忆不进上下文；最后一位不能静音）。
- 🔴🔴 防剧透两层：段落级 `viewMode:"character-view"` 排作者侧页签＋字段级 `AUTHOR_SIDE_FIELDS`（新字段须登记）。🔴 提示词与解析器对齐：标题整行匹配（禁 `includes`）；**面板调的记忆上限必须一路传进解析**（`parseMemoryText(…, limits)`）。
- 🔴 输出规范（**协议 v1.8**）：对白＝纯文本（不含名字）；**非对白一律（ ）**、一件事一个括号；状态＝〔〕；输入 〖〗/〈〉；**【】彻底废止**。M2 状态块**不含「关系温度」**，且明说「好感/进度/心情/地点由系统单独维护、不许在正文里报数值」。🔴 改协议须同步三处（正文版号＋旧全文追加 `LEGACY_PROTOCOLS`＋`PROTOCOL_VERSION`＋两处断言）；⚠️ **版本断言不要写死版本号**（改「与正文标题一致」即可，以后 bump 不用改测试）。🔴 指代一律「Ta」；协议靠等值锚点升级（**多版本数组**、幂等）。
- 🔴 R4 元指令（**用户输入侧**）：`//`或`#`＝讨论剧情；`「…」`＝**导演指令**（照做后继续演）；`[OOC: …]`＝同上；`TavernDirectorNote` 自动包「」。🗣 说明块要看得见：`TavernEchoHints.tsx` 挂在**剧情推演＋自由对话**、须在 header **外**（放输入区则没会话时不渲染）。
- 📦 导入导出：单卡 `.taverncard.json`／整批 `.taverncards.json`；批量逐张独立校验且**不调 AI**（`draftMemoryFromCard` 离线摘录）。🔴 剧情推演**没有会话级模型选择**。

## 出厂数据（角色卡不进原生）✅ 2026-09-15 已执行
- 🧪 **dev 测试数据一律放仓库之外**：`G:\AI软件\角色卡录入\04-开发测试数据（dev专用·不进打包）\`（README + 可粘贴 Console 脚本）。🔴 老大明确要求这类数据**打包不携带** → **绝不写进 `seedData.ts`**（会进产物 + 踩 tree-shake）。写法：走应用自己的 `story.ts`/`store.ts`（索引与分条成对），脚本要**幂等**（同名更新不新建）。当前内有「奉阳大学」故事 + 楚楠/苏念两张卡（新细字段格式）。
- 🚫 原生**不再预填角色卡** —— 特指**自由对话的 6 张示范自由卡**；项目内 `char-*` 卡（23 张）、细纲卡「→角色卡」文本、推演会话 `cast` **照旧保留**。理由：这批卡每次改版都要同步旧指纹/旧示例/断言，纯负担。🔴 **老库已有的卡只保留、不删**。
- 已删三个文件：`seedCardData.ts`／`seedCards.ts`／`tests/tavernSeedCards.test.ts`；已删四处调用：`seedData.ts` §8 播种、`App.tsx` 的 `upgradeSeedCards`、卡页「恢复内置版本」按钮与 import。
- ⚠️ 幽灵引用：全项目 33 处**提示词/文案拿卡名当例子**（含 `revise.ts`/`summarize.ts` 的 few-shot）已换成中性名（阿岩/小满/阿禾）—— 卡都没了还叫着名字，既不准确也会误导。
- `seededFrom` 字段**已无读取方**，仅为老库数据留在类型里；🔴 别再基于它「认内置卡」（种子表已无）。
- 🛡 策略闸 `tests/tavernSeedPolicy.test.ts`：新库不播卡 + 老库卡一张不少且不被覆盖。
- 📥 卡走导入：`G:\AI软件\角色卡录入\`＋skill `tavern-cards-batch` → `.taverncards.json` → 界面导入。

## 示范项目（吞天神脉）
- 两卷各十章：**1-10 风起云州 / 11-20 剑鸣中州**（约 9.2 万字）。改/加正文必同步（`seedContent.ts`→`seedData.ts`，落点链：`mkChapter`→`masterRows`→卷/章卡→`rows` 台账 13 类→酒馆 `world`＋示范推演会话）。
- 🔴 三道闸必跑：`seed-schema-check.mjs`＋`tests/seedRef.test.ts`＋细纲卡「新增设定登记」逐项落表核对；卷名/章数/终章位置三处口径必须一致。🔴 推演会话 cast 引用**角色卡 id** → 相关卡须留 `card()` 返回值再 `saveCardRecord`；酒馆两步用**动态 import**；播种失败只 warn → **验收必须捕获 console.warn**。

## 环境（Windows + Git Bash）
- git/npm 都用绝对路径（PortableGit 1.2.0 `cmd/git.exe`；托管 node＋`npm/bin/npm-cli.js`），路径写 `C:/` 正斜杠；⚠️ `sort -n/-r` 会解析到 Windows `sort.exe` → 用 node 脚本。
- ⚠️ Edit 会「假成功」：改完立即 grep；多处替换用脚本（**全命中才落盘**；`patch-multi.mjs` 在 skill assets，用时拷进 `.workbuddy/tmp/`）；`node -e` 引号/反引号会被吞 → Write 落脚本（**纯 JS，别写 TS 类型**）；`replace_all` 前确认每处前提一致；同文件并发 Edit 会互相覆盖 → 串行。
- ⚠️ CRLF/LF 并存 → 跨行锚点先探 EOL；`git checkout -- <file>` 会把 LF 变 CRLF（autocrlf=true）→ 回滚后先归一。
- ⚠️ 验「随项目」用换项目（`db.setCurrentProject`），别直查物理表（API 名写错会静默跳过→假绿）。实弹会读真实 apiKey（先告知，绝不提交）。⚠️ 改提示词/示范卡内容后 `tests/` 里写死旧文案的断言会挂 —— 断言与文案同一次提交改。

- 🧪 **dev 测试数据：仓库内 `dev-seed/`，一行导入** —— `await import('/dev-seed/fengyang.js?' + Date.now())`；诊断用 `diagnose.js`。🔴 **必须带 `?'+Date.now()`**（ESM 缓存 → 第二次同名 import 不执行，现象=什么都不打印）。🔴 数据在**浏览器 IndexedDB**，**重启 dev server 无效**；`localhost` 与 `127.0.0.1` 是**不同源=两份库**。这两文件不在 `index.html` 依赖图里 → 打包不携带；ESLint 只扫 `src/`+`tests/` 也扫不到。
- 🔍 **酒馆模式审计报告 `docs/酒馆模式-审计报告-2026-09-16.md`：75 条（5 P0/34 P1/36 P2）已于同日全部修完**（5 批提交 `09daad7`→`3a9afe8`，见报告顶部「修复状态」节）。教训固化：①记忆占位（「暂无」/「-」/「（还没有发生过任何事）」）必须清洗，否则每轮进上下文白占额度、状态栏还会虚计数；②导入解析要给**容器标题**留锚点（否则整行被塞进上一栏）；③收尾一律「**先全算完再统一落库**」（要么全成要么全不成），日记按 `sessionId` 幂等；④作者**手改过的数值只收增量**（`manualPinnedKeys`＋`applyVarOps` 的 `pinned`）；⑤`structFieldLines()` 在 `cardFields.ts`，起草与小说转换共用同一份小项清单。

# novel-studio 长期记忆
> 规则/红线/决策；事件留 `YYYY-MM-DD.md`。⚠️ 上限 ~6100 —— 新增前先查同类、合并改写。

## 红线
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴 禁 `git stash`（2026-09-14 中断丢对象）；遇 `bad object HEAD` 先 `ls .git`。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md` 只记录，明说「处理」才动。提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199。
- 现 **2.1.1**。版本唯一源 `package.json`（dev 由 `injectAppVersion()` 注入 `APP_VERSION_LABEL`）。⚠️ `package-lock.json` 根版本常落后 → 只改 `j.version`＋`j.packages['']`。
- 🔴🔴 封装**全程无沙箱跑**。rcedit 间歇失败（退出码仍 0，只认 stderr `Fatal error`）已由 `scripts/after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`；`ELECTRON_CACHE`→`AppData/Local/electron/Cache`。
- 🔴🔴 **只做桌面版**（无 WEB/PORTABLE）。`StoreOps`/`PortableData` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径。

## 架构红线
- 无 i18n；schema 列名即存储键（功能改完回搜 `schema.ts` 的 `description`）。
- ⚠️ 运行/打包陷阱：①tree-shake——组件只在平台门控分支被引会被摇掉整模块→门控用「需该模块平台并集」，删门控必跑 `vite build`；②`DESKTOP` 运行时探测（`window.electronStore`）→dev 浏览器恒 false（`DataDock` 有 DEV 兜底）。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑 `seed-schema-check.mjs`。
- 🔗 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；闸 `feature-deps-check.mjs`。
- 🔴 编辑器双图层：盒模型逐项一致；叠层重建归零 scrollTop→`useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🗺 多地图方案 B：新表 `geomaps`＋geography 的 `所属地图`；格档按图存；`migrateGeoMaps` 建默认图回填；🔴 删图不删地点、改图名连带改归属。

## 存储 / 同步
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录；🔴 图片字段先压缩再入库；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属→`makeCloudStoreWrapper` 短路到 local。🔴🔴 桌面读数据失败必须锁写盘（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔄 两同步入口别混：①改数据位置＝明文 JSON 进云盘；②云盘同步＝加密 `.yfe`＋记录级合并＋每日备份。**用 ②**。
- 🔴 2026-09-15 修一批（详见 `docs/2.1.1-审计修复记录.md` §四）：换目录先抓旧数据再 `configure()`；空推按记录总数判；关同步前先 flush；409 解密失败直接抛；IPC 写失败要抛；启动拉不到快照清 ENABLED 标记。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`；SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 回退黑）。设置项排版＝标题→输入→说明；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：①量尺寸一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；②zoom 不缩放 vh→内联长度走 `foldVh()`（`theme.ts`）；③SVG 滚轮锚点/拖拽都除 zoom。
- 🔴 按对侧高度定高：flex item `min-height:auto` 顶回定高→加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框用 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；行内小操作 `size="xs"`；`danger` 破坏性。
- 🔴 每页签页头 `HelpPopover` 问号。头像兜底＝名字（`avatarLabel` 封顶 2 字）；输入 Enter 发送／Shift+Enter 换行，必挡 `isComposing`；快捷指令只预填不发送；两侧消息无气泡框。界面文案禁 markdown 星号→用「」/（）。

## AI 层
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）。温度不手填：结构化→0.3、创意→0.85；一轮 JSON 走 `aiChatJson`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。
- 🔴 重复惩罚**射程**（非强度）：`repeat_penalty`/`frequency_penalty`/`presence_penalty` 在 llama.cpp **共用 `penalty_last_n` 窗口**（Ollama 默认 **64 token≈50 汉字**）→ 跨轮复读在射程外，**调高无用且伤虚词**；`repeat_last_n`/`frequency_penalty` 项目**均未下发**。治「语义/句式复读」只能靠提示词（#12 诊断：主因＝协议「用动作·停顿·身体反应代替情绪标签」逼每轮写身体反应却无多样性约束）。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`），站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务→删库≠下线；Nginx SPA 回退：不存在路径也返 200→不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；ESLint 11 warnings 别盲改。🔴 实机验证走 `novel-studio-ui-livecheck`；实弹断言会静默过时→日志必 grep ✗；子代理结论必回源码验尸。

## 酒馆模式
- 源《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 调研稿（冲突以方案为准）。**细则看 `docs/酒馆模式-工程红线.md`**（17 节）——动对应功能前先读那一节。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景**随项目**；自由会话+角色卡+记忆日常+面板设置+剧本库**跨项目**（索引与分条成对，tavernReports 别漏 deleteProject）。
- 🗺 故事层（09-16 新增，自由专用）：`tavern.storyIndex`/`tavern.story.<id>`（跨项目）。故事→剧本父子结构；页签「故事剧本」在角色卡片之前。剧本 `storyId` 必填；角色卡 `storyId` 空＝自由状态（落「未归属」抽屉）；🔴🔴 删故事＝删其下剧本、角色卡只解绑不删；归属取值走 `cardStoryId()`/`sessionStoryId()`（自己存的优先）。`saveStory` 统一收口名字长度。
- 🎛 控制面板 `tavern.settings`（八段）；优先级 会话→角色→面板→模式默认；数值真源 `paramGuide.ts`；🔴 左列以协议收尾、右列两模式手感，段号一动「N 段设置」文案一起改；废弃字段在 `upgradeLegacyDefaults` 删。🔴 新开关「结束本轮对话后卸载本地模型」挂在**「七」之下的「收尾与释放」子块**（09-16 定）—— 刻意不加段号，免得连动段数文案。
- 🔴 层序：设定→背景设定→这一场→记忆→身份→档位→（通用→本场补充）→未带入→协议→数值块（协议之后）。⚠️ 09-16 起自由模式复用「背景设定」这一槽装**故事的世界设定**（标题走 `prompt.ts` 的 `worldTitle`，剧情模式仍是「本场背景设定」）。
- 🔴🔴 上下文预算：`historyBudget`＝预算−400−整条 system（别传记忆）；contextBudget **24000**（三处一致）。⚙️ 出厂参数 2026-09-15 放宽一档（numCtx 仍 32768 别动）；值须落 paramGuide 推荐段（有测试闸）；改默认同加 `upgradeLegacyDefaults`「全等旧值才升」规则。
- 🔴 记忆 vs 设定：记忆＝发生过什么＋温度（`summarize.ts`）；设定＝让 Ta 变成谁（`revise.ts`）。背景设定：关键词空＝总注入、上限 2400 字；键只剩 `tavern.world`。
- 🧠 整理时机（2026-09-16 定死：全项目无「自动整理」）：仅两手动入口——自由「结束本轮对话」（`roundEnd.ts`：记忆+日记+数值+设定审查后归档只读）、剧情「整理本场记忆」（不归档）。原阈值自动整理整层已删（只留跨实例锁+TTL `summaryLockTtlMin`）；🔴 `vars` **每轮回复后刷新**（09-16 改：`varsRefresh.ts` 的 `refreshSessionVars`，收尾时兜底再算一次；刷新与正文同一笔落库）；`summarizeRound` 先 `splitJournalSection` 切日记再解析；🔴 归档后输入区只读＋`reroll`/消息工具条/在场调度/数值输入全锁死。
- 📔 日记 `tavern.free.journal.<charId>`（`JOURNAL_KEEP=50`，200–600 字，第一人称回顾）：`JOURNAL_HEAD='〖本场日记〗'`（不带序号，否则被当第七栏记忆）；界面只读、可删且删除必须弹窗；删卡连清。
- 📊 本场数值（09-16 改版）：刻度 **−100~+100、默认 0**（旧 0–100/默认 50）；三项数值划档 `VAR_BANDS`+`bandOf`（档位进抽取提示词）；旧会话迁移 `VAR_SCALE=2`+`migrateVarScale`（幂等，`openSession` 里落库一次，只归零数值项、保留心情/地点/日志）。界面唯一入口＝右栏「本场状态」标签页（`TavernVarsPanel`）；`TavernStatusBar` 已改成右栏「角色状态」标签页里的**块**，聊天区上方不再有状态栏。
- 🧾 用量明细（自由页签）＝**五行**：角色卡 / 故事的世界设定 / 本场剧本 / 角色扮演协议 / 长期记忆（+差额兜底行）；字数一律来自 `buildFreeSystem` 的 `settingChars/storyChars/scriptChars/protocolChars/memoryChars`，界面不许自己重算。
- 💤 卸载本地模型（09-16 新增，默认**关**）：`ai.ts#unloadOllamaModel` 走 `/api/generate` + `keep_alive:0`，**只认本机 Ollama**、失败不抛；调用点严格排在 `runRoundEnd` 三步 + 落库 + `refreshSessions` **之后**。
- 🗂 第 1 章标题统一「角色与设定的关系」（非「世界」），导入器解析锚点认旧名（世界/世界观/背景…）。
- 🎭 剧本 `script.ts` 六栏：🔴🔴 会话存快照非引用；开场白不进 system（＝第一条消息）；设定更新＝12 字段白名单（不含 name）＋二次把关。故事同规矩：`FreeSession.storySetting`（`snapshotStorySetting` 在新建会话时拍）；老会话回退 `resolveSessionStorySetting` 实时读 —— **engine 必须用动态 import 调它**（`story.ts` 静态 import engine，直接互引成环）。
- 🔴 分支/回滚：`branchSession` 分叉点后连记忆清；回滚连记忆还原＋`undoSnapshot`；重说＝`run*Turn(session,null)`；剧情记忆 `runPlotSummary`→`memoryToText` 写回全成功才推进。
- 🔴 多角色：`buildMultiCharRule` 必传 `{hasUser:false}`；`userCharId` 排除；在场调度 `muted`+`talkativity` 会话级、两模式共用（最后一位不能静音）。
- 🔴🔴 防剧透两层：段落级 `viewMode:"character-view"`＋字段级 `AUTHOR_SIDE_FIELDS`（新字段须登记）。提示词与解析器对齐：标题整行匹配（禁 `includes`）；面板记忆上限必须传进 `parseMemoryText(…, limits)`。
- 🔴 输出规范（协议 **v1.9**，09-16 升）：对白纯文本（不含名字）；非对白（ ）一件事一括号；状态〔〕；输入 〖〗/〈〉；【】废止。**描写一律第三人称**（括号里不写「我」「你」，写名字/他·她/省主语；对白不在此限）——规则落在 O1+B1+O4+最后提醒四处，`draft.ts#CARD_OUTPUT_RULES` 与 dev 测试卡「人称」同步对齐。M2 状态块不含「关系温度」且明说数值由系统维护。🔴 改协议同步三处（正文版号＋`LEGACY_PROTOCOLS`＋`PROTOCOL_VERSION`＋两断言）；⚠️ 版本断言改「与正文标题一致」；指代一律「Ta」；等值锚点升级（多版本数组、幂等）。
- 🔴 R4 元指令（用户输入侧）：`//`或`#`＝讨论剧情；`「…」`＝导演指令；`[OOC: …]`＝同上；`TavernEchoHints.tsx` 挂剧情推演＋自由对话、须在 header 外。
- 📦 导入导出：单卡 `.taverncard.json`／整批 `.taverncards.json`；批量逐张校验不调 AI（`draftMemoryFromCard` 离线摘录）。🔴 剧情推演无会话级模型选择。
- ⏳ 待拍板（方案 §10.2）：① `summaryMinIntervalMin` 成死键建议删（连带 `shouldRunAutoSummary`/`throttleOk`+断言）；② `triggerMessages` 仅 `TavernPlot` 用却挂「自由对话控制」。
- 🔍 审计报告 `docs/酒馆模式-审计报告-2026-09-16.md`：75 条（5P0/34P1/36P2）已于 09-16 全修完（5 批提交 `09daad7`→`3a9afe8`）。
- ✅ 09-16 验收反馈 13 条**已全实施**（12 条落地；#12 描写重复**已补做静态根因诊断**、调优待拍板）：清单 `docs/酒馆模式-优化清单-2026-09-16.md`（状态列已更）、方案＋执行记录 `docs/酒馆模式-优化实施方案-2026-09-16.md` §六、诊断报告 `docs/酒馆模式-12-描写重复诊断报告-2026-09-16.md`、**实机验收走 `docs/酒馆模式-本轮改动实机验收清单-2026-09-16.md`**。

## 出厂数据（角色卡不进原生）✅ 09-15 已执行
- 🧪 dev 测试数据放仓库外 `G:\AI软件\角色卡录入\04-开发测试数据（dev专用·不进打包）\`，走 `story.ts`/`store.ts`（索引分条成对、幂等）；🔴 绝不写进 `seedData.ts`。内有「奉阳大学」故事 + 楚楠/苏念两张卡。
- 🚫 原生不再预填角色卡（特指自由 6 张示范自由卡）；项目内 `char-*` 卡（23 张）、细纲卡、推演会话 cast 照旧；🔴 老库卡只保留不删。
- 已删 `seedCardData.ts`/`seedCards.ts`/`tests/tavernSeedCards.test.ts` 及四处调用；33 处提示词卡名例子换中性名（阿岩/小满/阿禾）；`seededFrom` 无读取方；策略闸 `tests/tavernSeedPolicy.test.ts`。
- 📥 卡走导入：`G:\AI软件\角色卡录入\`＋skill `tavern-cards-batch`→`.taverncards.json`→界面导入。

## 示范项目（吞天神脉）
- 两卷各十章：1-10 风起云州 / 11-20 剑鸣中州（约 9.2 万字）。改/加正文同步 `seedContent.ts`→`seedData.ts`（落点链 mkChapter→masterRows→卷/章卡→rows 台账→酒馆 world＋示范会话）。
- 🔴 三道闸：`seed-schema-check.mjs`＋`tests/seedRef.test.ts`＋细纲卡登记核对；卷名/章数/终章口径一致。推演 cast 引用角色卡 id→相关卡留 `card()` 返回值；酒馆两步动态 import；播种失败只 warn→验收捕获 console.warn。

## 环境（Windows + Git Bash）
- git/npm 用绝对路径（PortableGit 1.2.0 `cmd/git.exe`；托管 node＋`npm/bin/npm-cli.js`）；⚠️ `sort -n/-r` 解析到 Windows `sort.exe`→用 node 脚本。
- ⚠️ Edit 假成功：改完立即 grep；多处替换用脚本（全命中才落盘）；`node -e` 引号/反引号被吞→Write 落纯 JS 脚本；同文件并发 Edit 互覆盖→串行。
- 🔴 改 `src/lib/tavern/protocol.ts` 正文**别用 Edit**：同文件躺着 8 份历史协议全文，正条款大量重复 → 锚点必不唯一。走「临时脚本：只在 `PROTOCOL_CORE` 那段文本内替换 + 每锚点断言恰好命中 1 次 + 已存版本追加进 `LEGACY_PROTOCOLS` 末尾」，落盘即删脚本。
- ⚠️ CRLF/LF 并存→跨行锚点先探 EOL；`git checkout -- <file>` 把 LF 变 CRLF→回滚先归一。
- 🔴 dev 仅 `http://localhost:5199`（127.0.0.1 302 到 localhost，否则两份 IndexedDB）；文档/探活一律 localhost。桌面走文件存储与 dev 两套（设计如此）。
- ⚠️ 验「随项目」用 `db.setCurrentProject` 别直查物理表；实弹读真实 apiKey 先告知不提交；改提示词/示范卡文案后同步改 `tests/` 写死旧文案的断言。
- 🧪 dev 测试数据：仓库内 `dev-seed/`，`await import('/dev-seed/fengyang.js?' + Date.now())`；🔴 必须带 `?'+Date.now()`（ESM 缓存）；数据在浏览器 IndexedDB，重启 dev server 无效。

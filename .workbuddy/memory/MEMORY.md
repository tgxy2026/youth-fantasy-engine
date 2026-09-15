# novel-studio 长期记忆
> 规则/红线/决策；事件留 `YYYY-MM-DD.md`。⚠️ 上限 ~6100 —— 新增前先查同类、合并改写。

## 红线
- 🔴 封装须老大明说「封装」；改完最多 tsc+build+commit。
- 🔴 禁 `git stash`（2026-09-14 中断 → `refs/`、pack、松散对象被永久删除）。遇 `bad object HEAD` 先 `ls .git`。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md`：只记录，明说「处理」才动。提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199。
- 现 2.1.0。版本唯一源 `package.json`；dev 靠 `injectAppVersion()` 注入 `APP_VERSION_LABEL`。
- 🔴🔴 封装**全程无沙箱跑**（沙箱会拦 dist rename / 写 release / 删目录）。rcedit 间歇失败已由 `scripts/after-pack.cjs`（afterPack）根治 —— 它失败时**退出码仍 0**，只认 stderr `Fatal error`；验收查 exe 含 `青春幻想引擎开发组`。`ELECTRON_CACHE` 指 `AppData/Local/electron/Cache`。详见 skill §7。
- 🔴🔴 **只做桌面版**：无 WEB/PORTABLE；`StoreOps`+`PortableData` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径。

## 架构红线
- 无 i18n；schema 列名即存储键。⚠️ 功能改完回搜 `schema.ts` 的 `description`。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台并集」；删门控必跑 `vite build` 验产物。
- ⚠️ `DESKTOP` 是**运行时探测**（`window.electronStore`）→ dev 浏览器恒 false；`DataDock` 已加 DEV 兜底。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格=列名；改种子必跑 `seed-schema-check.mjs`。
- 🔗 功能门：`FEATURE_TIER` + `STRONG_DEPS`（勾 B 连带 A，**互绑须双向**）+ `ANY_DEPS`（至少一个）；闸 `feature-deps-check.mjs`。
- 🔴 编辑器双图层（高亮时文字全来自叠层）：① 盒模型逐项一致；② 叠层重建归零 scrollTop → 触发点必 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight`。
- 🗺 **多地图（方案 B）**：新表 `geomaps`＋geography 的 `所属地图` 列；格档**按图**存；`migrateGeoMaps` 建「默认地图」+回填；🔴 删图不删地点、改图名连带改归属。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录。🔴 图片字段先压缩再入库。换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属 → `makeCloudStoreWrapper` 必须短路到 local。🔴🔴 桌面读数据文件失败必须**锁写盘**（`main.cjs` 三态 + `DesktopWriteLockBanner`）。
- 🔄 **两同步入口别混**：①改数据文件位置＝明文 JSON 进云盘（文件级覆盖、apiKey 明文上云）；②云盘文件同步＝加密 `.yfe`＋记录级合并＋每日备份＋兜底。🔴 用 ②。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，分类色盘不要主题化。
- 🔴 SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 回退黑）。设置项排版＝标题→输入→说明最后；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：① 量尺寸算回 CSS 值一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；② 🔴 **zoom 不缩放 vh** → `.h-screen`/`.min-h-screen` 已在 index.css 折回 `calc(100vh / var(--ui-zoom,1))`（`applyZoom()` 写 `--ui-zoom`），新增 vh 照此办。未修：拖拽未除 zoom（3 处）。
- 🔴 按对侧高度定高：flex item `min-height:auto` 会顶回定高 → 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框别用 `ghost`（→`secondary`）；分段开关 `toggle`+`selected`；行内小操作 `size="xs"`（`danger` 破坏性）。列表选择项不算按钮。
- 🔴 每页签页头要 `HelpPopover` 问号。头像兜底＝**名字**（`avatarLabel` 封顶 2 字，同姓也分得清），不是姓氏；有自定义图优先用图。输入：Enter 发送／Shift+Enter 换行，**必挡 `nativeEvent.isComposing`**（中文输入法 Enter 是选字确认）。快捷指令＝**点击只预填不发送**（`TavernQuickBar` 的 `text`/`slot`，预填后聚焦并选中可改段）；用户与 AI 消息**两侧都无气泡框**。剧情推演头像来自项目卡（无头像字段 → 只出首字圆标）。
- 界面文案禁 markdown 星号 → 用「」/（）（演示占位符例外）。同一事别写成互斥分支。

## AI 层
- 🔴 解析统一 `aiParse.ts`；禁裸 `JSON.parse`。温度不手填：结构化 `{json:true}`→0.3；创意类→0.85。
- 🔴 一轮 JSON 用 `aiChatJson`（自动取活动模型＋`json`＋`think:false`）。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）；upgrade 是「何时跑哪段」的唯一判断点。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`）；站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务 → 删库 ≠ 下线服务器。
- 🔴 Nginx SPA 回退：不存在路径也返 200 → 不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；runner 每入口单开子进程；ESLint 11 warnings 别盲改。
- 🔴 实机验证走 skill `novel-studio-ui-livecheck`。⚠️ 实弹断言会静默过时→读日志必 grep ✗；子代理结论必回源码验尸。

## 酒馆模式
- 源自《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 调研稿（冲突以方案为准）。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景随项目；自由会话+角色卡+记忆日常+面板设置+剧本库跨项目。索引与分条须成对（tavernReports 别漏 deleteProject）。
- 🎛️ 控制面板（八段）：tavern.settings；优先级 会话→角色→面板→模式默认。数值真源 paramGuide.ts。⚠️ mergeDeep 会回填已删默认键 → 废弃字段须在 upgradeLegacyDefaults 删。
- 🔴🔴 控制面板分列按实测高度：左＝不分局部的设置＋协议（协议须**最后一项**），右＝两种模式手感。段号一动，「N 段设置」文案一起改。
- 🔴 层序：设定→背景设定→这一场(剧本)→记忆→身份→档位→（通用→本场补充）→未带入→协议→（自由模式）**数值块**（协议之后；放它前面的内容容易被那 3.5KB 格式规范盖过去）。
- 🔴🔴 上下文预算：historyBudget＝预算−400−整条 system（别传记忆）；**contextBudget 24000（三处一致：TAVERN_DEFAULTS 两条 + engine.totalBudget 兜底）**。源 both/digest/raw。空层不占额度。
- ⚙️ 出厂参数（2026-09-15 整体放宽一档，按 5090+本地 27B）：预算 24000 / 超时 300s / 温度 plot 0.9·free 0.95 / topP 0.92 / topK 60 / 记忆软 2000·硬 3000·长期 500 / 背景设定 2400 / 剧本 2000。**numCtx 32768 不动**（27B q6_K≈22GB + 32K KV≈8GB 已贴 32GB 上限）。🔴 每个新值都必须在 paramGuide 的**推荐段**内（`paramGuide.test` 会闸）。改默认值**必须同时在 `upgradeLegacyDefaults` 加「全等旧值才升」的规则**，否则老库永远看不到变化。
- 🔴 记忆 vs 设定：记忆＝发生过什么＋此刻温度（summarize.ts）；设定＝这让 Ta 变成了谁（revise.ts）。
- 📚 🔴 背景设定（`world.ts`）：关键词空＝总是注入，上限 2400 字。键只剩 `tavern.world`。
- 🧩 模型配置＝灵感启发顶部独立面板（`AIConfigPanel.tsx`）；全局共用一个活动模型，改配置靠 `reloadKey` 通知下游。
- 🌐 联网检索：全局键 `app.search`。三档 off/model/api；地址含 {query}⇒GET；主进程代发。🔴 起草须如实回告。
- ✍️ 起草：draft.ts（角色卡 13 栏）。🔴 提纲 fields 须覆盖全部栏；**示例对话必须合协议**（样例不合规会带偏格式）。
- 🔴 对话引导：`lib/interview.ts`（只认 InterviewSpec）＋`InterviewChat.tsx`，别无第二份。
- 🛠 后处理 `postRules.ts`：按序跑正则再落库；行首说话人标签默认关。⚠️ `*单星*`＝动作（→（））、`**双星**`＝markdown（只剥星号）；一律当动作会吃掉加粗对白（测试拦下过）。
- 🎚 本场数值：`vars.ts`＋`VAR_DEFS`（可逐项关）。🔴 **不再每轮让模型记账** → 整理记忆时 `extractSessionVars` 单开一次只输出一行的调用（旧法仅 0～1/6）；当前值仍每轮挂 tail（`buildVarStateBlock`），`place` 不在上下文就瞬移。手改与抽取同一关口；`prev` 已删。
- 🎭 剧本：`script.ts` 六栏。🔴🔴 会话存快照不是引用；开场白不进 system（＝第一条消息）。
- 🔴 engine↔world/script/draft 环已上移 `provider.ts`。设定更新：12 字段白名单（不含 name）＋二次把关。
- 🔴 分支/回滚：branchSession 截到该条，分叉点后连记忆一起清；回滚连记忆还原＋undoSnapshot。重说＝run*Turn(session,null)。
- 🔴 剧情记忆：`runPlotSummary`→`memoryToText` 写回 `session.memory`+推水位线。
- 🔴 `buildMultiCharRule` 必传 `{hasUser:false}`；`userCharId` 的卡/记忆/轮转排除；水位线全成功才推进。
- 🔴 在场调度：`muted`+`talkativity` 会话级、两模式共用。静音＝在场不发言、卡与记忆不进上下文；最后一位不能静音。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（新字段须登记）。
- 🔴 提示词与解析器对齐：标题整行匹配（禁 `includes`）；总结必带角色背景；复制为新卡不复制记忆/日常。
- 🔴 输出规范（协议常量 v1.7）：对白＝纯文本（不含名字）；**非对白一律（ ）**、一件事一个括号、一句一行；状态＝〔〕；输入 〖〗/〈〉。🔴**【】彻底废止**（按对白渲染）。
- 🔴 改协议须同步：`PROTOCOL_CORE` 版本号＋旧全文追加 `LEGACY_PROTOCOLS`（现 v1.1–1.6）＋`PROTOCOL_VERSION`；两处版本断言。v1.4＝换场纪律；v1.5＝格式自查；v1.6＝单括号方案；v1.7＝【】彻底废止＋去掉数值行许可。
- 🔴 指代一律「Ta」。协议/示范卡靠全等锚点升级（`upgradeSeedCards()`/`LEGACY_SEED_EXAMPLES` 与协议锚点都是**多版本数组**、幂等；只留上一代则老库升不上来）。示范卡三张洛汐/苏念/楚楠（都知道对方是谁、不知彼此分量）。
- 🔴 R4 元指令通道（**用户输入侧**，内容不限、可自由发挥）：`//`或`#` 开头＝讨论剧情、`「…」`＝**导演指令**（照做后继续演）、`[OOC: …]`＝同上。`TavernDirectorNote` 注入时自动包「」。别把它与输出侧（ ）/〔〕混为一谈。
- 🗣 元指令说明要**放在页面上看得见**（`TavernEchoHints.tsx`，两处共用）：剧情推演放 **header 外**（放进输入区的话，没会话时那块不渲染 → 新用户永远看不到），角色卡片放页头说明下；三条示例各带复制按钮。
- 🔴 剧情推演**没有会话级模型选择**：模型统一在「控制面板 → 通用设置 → 默认模型」，`session.model.providerId` 留空即跟随面板默认（再兜底全局活动模型）。

## 示范项目（吞天神脉）
- 两卷各十章：**1-10 风起云州 / 11-20 剑鸣中州**，20 章约 9.2 万字。改/加正文后必同步的**落点清单**（`seedContent.ts` → `seedData.ts`）：①import ②`mkChapter` ③`masterRows` ④卷大纲卡 ⑤章节细纲卡 ⑥`rows` 台账（timeline/hookpoints/foreshadow/terms/geography/items/nations/history/relations/subplots/secrets/changelog/feedback）⑦角色卡 ⑧酒馆 `world` 背景设定＋示范推演会话。
- 🔴 **三道闸必跑**：`seed-schema-check.mjs`（键名对不对）＋`tests/seedRef.test.ts`（跨表引用的值在不在、有无空表）＋细纲卡「新增设定登记」逐项落表核对。卷名/章数/终章位置这三处口径在正文、章节概要、细纲卡、台账里必须一致。
- 🔴 示范推演会话的 cast 要引用**角色卡 id** → 那几张卡必须保留 `card()` 返回值再 `saveCardRecord`。酒馆两步用**动态 import**（别让引擎进主包）；播种失败只 warn 不连累项目创建，所以**验收时必须同时捕获 console.warn**，否则静默失败。

## 环境（Windows + Git Bash）
- git / npm 都用绝对路径（PortableGit 1.2.0 `cmd/git.exe`；托管 node + `npm/bin/npm-cli.js`），路径写 `C:/` 正斜杠。
- ⚠️ Edit 会「假成功」：改完立即 grep；多处替换用脚本（**全命中才落盘**）；`node -e` 反引号被吞 → Write 落脚本。⚠️⚠️ **同一条消息并发多个 Edit 改同一文件会互相覆盖**（只生效一个，工具仍报 success）→ 同文件多次改必须串行；⚠️ CRLF/LF 并存 → 跨行锚点先探 EOL；`replace_all` 前确认每处前提一致。
- ⚠️ `sort -n/-r` 会解析到 Windows `sort.exe` → 用 node 脚本。
- ⚠️ 验「随项目」用换项目（`db.setCurrentProject`），别直查物理表（API 名写错会静默跳过→假绿）。实弹会读真实 apiKey（先告知，绝不提交）。

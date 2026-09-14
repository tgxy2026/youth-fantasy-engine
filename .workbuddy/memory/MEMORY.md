# novel-studio 长期记忆
> 规则/红线/决策；事件留 `YYYY-MM-DD.md`。新增前先查同类条目，合并改写别追加第二份。⚠️ 注入上限 ~6100 字符。

## 红线
- 🔴 封装须老大明说「封装」；改完最多 tsc+build+commit。
- 🔴 禁 `git stash`（2026-09-14 stash 中断 → `refs/`、pack、松散对象被永久删除）。恢复与备份见 §8；遇 `bad object HEAD` 先 `ls .git`。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md`：只记录，明说「处理」才动。提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；三存储(IDB/便携/桌面)经 StoreOps；dev 5199。
- 现 2.1.0（只改号不封装，约每月一版）。版本唯一源 `package.json`；展示 `APP_VERSION_LABEL`；dev 靠 `injectAppVersion()`。
- 🔴 封装：`ELECTRON_CACHE` 指 `AppData/Local/electron/Cache`（勿指 `release/eb-cache/electron-zip`）；两脚本有体积闸门。NSIS `perMachine:false`＋`allowToChangeInstallationDirectory:false`。

## 架构红线
- 无 i18n；schema 列名即存储键。⚠️ 功能改完回搜 `schema.ts` 的 `description`。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台并集」。`WEB` 由 `__WEB__` 定，禁写 `!PORTABLE && !DESKTOP`。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格=列名；改种子必跑 `seed-schema-check.mjs`。
- 🔴 编辑器双图层（NovelEditor）：高亮开时文字全来自叠层。① 盒模型逐项一致；② 叠层重建会归零 scrollTop → 高亮/切章/字号/页宽/专注/检索必 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight` 单次正则。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录。便携(FSA) `flush()` 是 swap 语义。🔴 图片字段先压缩再入库。
- 判据：过服务器→要码；云盘→不要码。🔴 两路径二选一；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属 → `makeCloudStoreWrapper` 必须短路到 local。「死配置」先验消费方。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，分类色盘不要主题化。
- 🔴 SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 无效且静默回退黑）。设置项排版＝标题→输入区→说明最后；复制统一 `copyText()`。
- 🔴🔴 `<html>` 有界面缩放（默认 108%）：凡「量尺寸再算回 CSS 值」一律 `offsetHeight`，绝不 `getBoundingClientRect()`。
- 🔴 按对侧高度定高：flex item 的 `min-height:auto` 会把定高顶回去 → 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：酒馆各页签不用 `variant="ghost"`（静止无边框）→ 用 `secondary`；分段开关 `toggle`+`selected`；行内小操作用 `size="xs"`（破坏性 `danger`）。列表选择项（`w-full text-left`＋选中态）不算按钮，别动。
- 🔴 每个页签页头都要 `HelpPopover` 问号指引（全项目 40+ 处，酒馆曾一个都没有）；页头长说明据此收紧。
- 界面文案禁 markdown 星号 → 用「」/（）（例外：演示 markdown 的占位符）。同一件事的多个信息别写成互斥分支。

## AI 层
- 🔴 解析统一 `aiParse.ts`；禁裸 `JSON.parse`。温度不手填：结构化传 `{json:true}`→0.3；创意类不传→0.85。
- 🔴 一轮 JSON 用 `aiChatJson(msgs,opts)`（自动取活动模型＋`json`＋`think:false`）。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering 顺序不可换）；upgrade 处是「何时跑哪段」的唯一判断点。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。`think:false` 是 Ollama 专有。

## 服务器 / 工程质量
- `154.8.178.240`（ubuntu+免密 sudo，SSH `yfe_test_server`）；站点 `/var/www/yfe`；见 `docs/服务器访问记录.md`。
- 🔴 Nginx SPA 回退：不存在的路径也返 200 + index.html → 不能靠 200 判断上线。
- `npm run verify`（tsc+lint+test）；runner 每入口单开子进程；ESLint 11 条 warnings 不能盲改。
- 🔴 界面实机走 skill `novel-studio-ui-livecheck`；模型链路 `build-test.mjs live-free|live-tavern`。⚠️ 实弹断言会静默过时 → 读日志必须 grep ✗。

## 酒馆模式
- 源自《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 的调研讨论稿（冲突以方案为准）。侧栏序＝`TABS` 序。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景随项目；自由会话+角色卡+记忆日常+面板设置+剧本库 跨项目。索引与分条须成对；tavernReports 别漏 deleteProject。
- 🎛️ 控制面板（九段两列）：tavern.settings；优先级 会话→角色→面板→模式默认。加参数前先搜 tavern 里写死的数；数值真源 paramGuide.ts。预设/档案＝全局 tavern.presets/profile。⚠️ mergeDeep 把已删默认键照抄回来 → 废弃字段须在 upgradeLegacyDefaults 删。
- 🔴🔴 控制面板分列按实测高度（§12）：左＝不分局部的设置＋协议（协议必须左列最后一项，列高同步靠 `slice(0,-1)`），右＝两种模式的手感。段号一动，面板内「N 段设置」文案与 `.workbuddy` 一起改。
- 🔴 层序：设定→背景设定→这一场(剧本)→记忆→身份→档位→（通用→本场补充）→未带入→协议（钉末尾）。
- 🔴🔴 上下文预算：historyBudget = 预算 − 余量 − 整条 system（别传记忆）。余量 400、contextBudget 16000（plot/free/totalBudget 三处一致）。contextSource＝both/digest/raw。空层不占额度。digest＋设定空→作者侧全空（只警告）。
- 📊 状态一览/用量明细：`status.ts` 只提取不读库；开关在工具条「角色状态」。不做数值化「关系温度」；`agoText` 唯一真源。
- 🔴 记忆 vs 设定：记忆＝发生过什么＋此刻温度（summarize.ts）；设定＝这让 Ta 变成了谁（revise.ts）。拦不住 → findNarrativeOverlap（≥6 字）标 ⚠️，只提示。
- 📚 🔴 背景设定（`world.ts`）：关键词空＝总是注入；上限 1800 字。只服务剧情推演（2026-09-15 收口）；键只剩 `tavern.world`，旧 `tavern.world.free` 保留但到不了（哨兵测）。
- 🌐 联网检索（面板三）：webSearch 三档 off/model/api；引擎 bocha/searxng/custom。🔴 地址含 {query} ⇒ GET，否则 POST。桌面版走主进程代发（main.cjs net:fetch：仅 http(s)、剔 cookie、30s、2MB）→ 不受 CORS 限、任何 JSON 接口可接；便携版单文件 HTML 无主进程 → 只能带 ACAO（博查）。回告哪档、失败不静默。§15
- ✍️ 起草：draft.ts（角色卡 13 栏模板）。🔴 提纲 fields 必须覆盖模板全部栏；角色卡草稿的示例对话要守协议格式。
- 🔴 对话引导已泛化到全局补全入口（§13）：机制＝项目级 `lib/interview.ts`（只认 `InterviewSpec`、不管模型配置，由调用方给 `callChat`），界面＝`InterviewChat.tsx`，`AITemplateFill` 两模式＝一句话补全／对话引导。别在业务侧再写一份。
- 🎬 临时导演指令：`directorNote{text,depth,turnsLeft}` 会话级，按深度插进历史；成功产出才倒计时。
- 🛠 输出后处理：`postRules.ts` 按序跑正则再落库；🔴 去 markdown 必须排在星号动作前。行首说话人标签默认关。
- 🎚 本场数值：`vars.ts`＋`VAR_DEFS`（5 项，可逐项关），规则挂 `modeExtra`（不进协议常量）。🔴 解析认不出连那行都不剥；手改清 `prev` → 重说不翻回模型的错值；先解变量再跑后处理。
- 🎭 剧本：`script.ts` 六栏。🔴 库在全局 meta；🔴🔴 会话存快照不是引用；名称与开场白不进 system（开场白＝对话第一条消息）。
- 📤 实现细则全在 `docs/酒馆模式-工程红线.md`（§1–§14）—— 改酒馆前必读。
- 🔴 engine ↔ world/script/draft 成环 → `resolveTavernProvider`/`ChatFn` 上移 `provider.ts`。设定更新：12 字段白名单（不含 name）＋二次把关；采纳＝整段替换；只建议。
- 🔴 分支/回滚：branchSession 截到该条，分叉点之后连记忆一起清；回滚连记忆还原＋undoSnapshot。hidden 唯一出口＝toChatMessages＋messagesAfterWatermark；重说＝runPlotTurn/runFreeTurn(session,null)。
- 🔴 `buildMultiCharRule`：整场 AI 必传 `{hasUser:false}`；`userCharId` 这一位的卡/记忆/轮转三处都排除。记忆按角色分开整理；水位线全成功才推进。
- 🔴 在场调度：`muted`+`talkativity` 会话级、两模式共用。静音＝在场不发言、卡与记忆都不进上下文；UI 拦「最后一位不能静音」。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（新字段须登记）。
- 🔴 提示词与解析器对齐：标题整行匹配（禁 `includes`）；总结必带角色背景；复制为新卡不复制记忆/日常；导入/新建卡自动生成初版记忆；卡片块带名仅同场同名挂短码。
- 🔴 输出规范 v1.3（改提示词先读）：输出 对白＝纯文本（不含名字）、动作神态心理＝（）、环境·外在＝【】、状态＝〔〕；输入一律 〖〗/〈〉。
- 🔴 指代角色一律「Ta」。协议/示范卡改过 → 升级靠全等锚点（`LEGACY_PROTOCOLS`/`upgradeSeedCards()`，幂等）；卡内容走卡页「恢复内置版本」。别写逐句锚点补丁。
- 示范卡三张：洛汐/苏念/楚楠；关系网＝都知道对方是谁、都不知道彼此的分量。`createDemoProject` single-flight。
- 路线图：开发需求全部完成（第 1–10 批）；C1 向量记忆/C3 立绘/ST 卡导入/TTS 放弃。方案见 `docs/剧本与变量-设计方案-讨论稿.md`。下一步＝代码审查与优化。

## 环境（Windows + Git Bash）
- git / npm 都用绝对路径（PortableGit 1.2.0 `cmd/git.exe`；托管 node + `npm/bin/npm-cli.js`），路径写 `C:/` 正斜杠。
- ⚠️ Edit 会「假成功」（dev server 下更甚）：改完立即 grep 复查；多处替换用脚本（幂等、未命中即抛错）；`node -e` 反引号被 shell 替换 → 一律用 Write 落脚本（长文本/记忆同理，别塞 heredoc）。同一文件别同轮既改又追加。搬 JSX 前先看换行符：CRLF 归一成 LF 再锚点。
- ⚠️ `sort -n/-r` 有时解析到 Windows `sort.exe` → 用 node 脚本代替；`git bundle create` 遇中文路径建不了 `.lock` → 先在英文路径建再 `cp` 回。
- ⚠️ 验「随项目」用换项目（`db.setCurrentProject`），别直查物理表（写错 API 名会静默跳过→假绿）。「数据丢失」级结论回源码验尸；实弹会读真实 apiKey（先告知，绝不提交）。

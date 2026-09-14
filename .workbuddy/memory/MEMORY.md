# novel-studio 长期记忆
> 规则/红线/决策；事件留 `YYYY-MM-DD.md`。**新增前先查同类条目 —— 合并改写，别追加第二份。**
> ⚠️ 注入上限约 6100 字符，超了会被腰斩；**这份文件必须精简**。

## 红线
- 🔴 **封装须老大明说「封装」**；改完最多 tsc+build+commit。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md`：只记录，明说「处理」才动。提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；三存储(IDB/便携/桌面)经 StoreOps；dev **5199**。
- 现 **2.1.0**（只改号不封装，约每月一版）。版本唯一源 `package.json`；展示 `APP_VERSION_LABEL`；`injectAppVersion()` 补 dev；不加 dev 角标。
- 🔴 封装：`ELECTRON_CACHE` 须指 `AppData/Local/electron/Cache`，**切勿**指 `release/eb-cache/electron-zip`。正常体积 桌面 80.68MiB / 便携 8.44MiB；两脚本有体积闸门（**退出码 0 也可能没达标**）。NSIS `perMachine:false`+`allowToChangeInstallationDirectory:false`（免管理员；旧 per-machine 版需管理员迁移一次），勿设 `allowElevation:false`。

## 架构红线
- 无 i18n（中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台并集」。`WEB` 由 `__WEB__` 定，禁写 `!PORTABLE && !DESKTOP`
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格=列名；改种子必跑 `seed-schema-check.mjs`。
- 🔴 编辑器双图层（NovelEditor）：高亮开时 textarea 透明、文字来自叠层。① 盒模型逐项一致；② 叠层重建归零 scrollTop → 高亮/切章/字号/页宽/专注/检索必 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight` 单次正则。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录。便携(FSA) `flush()` 是 swap 语义。
- 判据：过服务器→要码；云盘→不要码。🔴 两路径**二选一**；**换设备前先关软件＋等同步完**。
- 🔴 `backups` 本地专属 → `makeCloudStoreWrapper` 必须短路到 local。**「死配置」先验消费方**

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，**分类色盘不要主题化**。
- 🔴 SVG 用 CSS 变量**必须走 `style`**：`fill="rgb(var(--x))"` 无效且**静默回退黑色**。设置项排版＝标题→输入区→说明放最后；复制走 `copyText()`。
- 🔴🔴 **`<html>` 有界面缩放（`yfe-ui-zoom`，默认 108%）**：凡「量尺寸再算回 CSS 值」**一律 `offsetHeight`，绝不能 `getBoundingClientRect()`**。
- 🔴 按对侧高度定高：flex item 的 `min-height:auto`（=内容高）**会把定高顶回去 → 加 `overflow-hidden`；别同写 `flex-1` 和 `height`**。

## AI 层
- 🔴 解析统一 `aiParse.ts`；**禁裸 `JSON.parse`**。温度不手填：结构化传 `{json:true}`→0.3；创意类不传→0.85。采样链走 `extraOptions`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering **顺序不可换**）；upgrade 拆 9 函数，**upgrade 处是「何时跑哪段」的唯一判断点**。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；**绝不清洗正文**。`think:false` 是 **Ollama 专有**。

## 服务器
- `154.8.178.240`（ubuntu+免密 sudo，SSH `yfe_test_server`）；站点 `/var/www/yfe`；见 `docs/服务器访问记录.md`。
- 🔴 Nginx SPA 回退：**不存在的路径也返 200 + index.html** → 不能靠 200 判断上线。

## 工程质量
- `npm run verify`（tsc+lint+test）；runner **每入口单开子进程**；ESLint 那 11 条 warnings 不能盲改。
- 🔴 界面实机走 skill **`novel-studio-ui-livecheck`**；模型链路 `build-test.mjs live-free|live-tavern`（手动）。⚠️ 手动实弹断言会**静默过时** → 读日志必须 grep ✗。

## 酒馆模式
- 源自 `酒馆模式_完整落地方案`（**冲突以方案为准**）。侧栏序＝`TABS` 数组序：控制面板→背景设定→剧情推演→推演报告→自由对话→角色卡片→剧本编辑(占位)。
- 🔴 **数据归属（测试已锁）**：剧情会话+扮演设定+报告+剧情背景设定**随项目**（settingsKV `${pid}::tavern.*`）；自由会话+角色卡+记忆日常+面板设置+自由背景设定**跨项目**（meta）。索引与分条成对读写；`tavernReports` 独立表，别漏 `deleteProject`。
- 🎛️ 控制面板（**七段两列**）：`tavern.settings`；优先级 会话→角色→**面板**→`TAVERN_DEFAULTS`。**加参数前先搜 tavern 里写死的数**；数值项 min/max/step 真源 `paramGuide.ts`。🔴 协议段须是左列最后一项（等高按「除末项外全部子项」算）。预设＝全局 `tavern.presets`（快照**含协议**）；「我的档案」＝全局 `profile`。⚠️ `mergeDeep` 把已删的默认键**照抄回来** → 废弃字段须在 `upgradeLegacyDefaults` delete。
- 🔴 层序：设定→**背景设定**→记忆→身份→档位→（通用→本场补充）→未带入→**协议（钉末尾）**。
- 🔴🔴 **上下文预算（2026-09-14 A+C 已整改）**：`historyBudget = 预算 − 余量 − 整条 system`（**别单独传记忆**，system 已含它，旧公式扣两遍）。
  余量 2600 → **400**（改成纯余量）；`contextBudget` 8000 → **16000**（plot/free＋`totalBudget` 兜底**三处必须一致**）。
  新开关 `plot.contextSource`＝`both`（默认＝旧行为）/ `digest`（设定层只留作品概览＋章节清单＝`aiContext.skeletonOnly`，世界交给背景设定）/ `raw`。
  实测：旧配置历史额度 **0** → both 2391 / **digest 9734** / 自由 11729。⚠️ 只提预算会被资料吃掉（4662→9521）—— 省给历史主要靠 digest。
- 🔴 **记忆 vs 设定边界**：**记忆＝发生过什么＋此刻温度**（`summarize.ts`）；**设定＝这让 Ta 变成了谁**（`revise.ts`，定称：身份·职业·性格·关系）。记忆**禁写定称/复述稳定属性**；设定**禁写经过/抄原句**。身份·职业落点 `world`。⚠️ 提示词拦不住 → 加 `findNarrativeOverlap`（≥6 字重合）标 ⚠️，**只提示不自动改**。
- 📚 背景设定（`world.ts`）：`brief+sections+keywords`；**关键词空＝总是注入**，否则命中才注入（取材＝标题+场景+最近 6 条）；上限 **1800 字**。录入：剧情喂 `buildProjectContext`、自由喂基础信息。
- 🎬 **临时导演指令（B2）**：`directorNote{text,depth,turnsLeft}` 会话级，按**深度插进历史**（默认倒数第 4 条前，`injectDirectorNote`；贴近生成点才管用），走协议 R4「」通道。**成功产出才倒计时**。UI 共用 `TavernDirectorNoteBar`。
- 🛠 **输出后处理（B3）**：`postRules.ts`，生成后按顺序跑正则再落库；`postRulesEnabled` / `postRuleNotice`（关掉＝静默，但**正则错误仍回传**）。🔴 **顺序硬约束**：去 markdown 必须排在星号动作前，否则 `**动作**` 被拆成 `*（动作）*`。**行首说话人标签默认关**（唯一会删字的规则，会误伤「注意：」；`note` 写理由）。
- 🔴 engine ↔ world 成环 → `resolveTavernProvider`/`ChatFn` 上移 **`provider.ts`**（engine re-export）。设定更新：12 字段白名单（**不含 name**）＋二次把关；采纳＝**整段替换**；`applyCardRevisions` 必须**按角色分组一次读写**。设定**只手动、只列建议**。
- 🔴 分支/回滚：`branchSession` 截到该条 —— **水位线在分叉点之后必须连记忆一起清空**；回滚连记忆还原＋`undoSnapshot`（一层）。`hidden` 唯一出口＝`toChatMessages`＋`messagesAfterWatermark`；重说＝`runPlotTurn/runFreeTurn(session, null)`（**只末条 AI**）。
- 🔴 `buildMultiCharRule`：整场 AI（无「你演」）必传 `{hasUser:false}`；`userCharId` 这一位的**卡/记忆/轮转三处都要排除**。记忆**按角色分别整理**；水位线**全成功才推进**；卡页可手改记忆。自由页无角色列表，左栏＝全局会话列表。
- 🔴 在场调度（A6）：`muted`+`talkativity` 会话级、两模式共用（回默认即删键）。静音＝在场但不发言，**卡与记忆都不进上下文**；UI 拦「最后一位不能静音」。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排 10 个作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（新增未来向字段须登记）。
- 🔴 提示词与解析器对齐：标题**整行匹配**（禁 `includes`）；容忍新旧符号；总结**必带角色背景**。角色卡块带名**仅同场同名挂短码**；复制为新卡**不复制记忆/日常**；导入/新建卡**自动生成初版记忆**。
- 🔴 **输出规范 v1.3**（改提示词先读）：**输出** 对白＝纯文本（无引号/括号/名字，名字也不许单独成行）、动作神态心理＝（）、**环境·外在＝【】**、状态＝〔〕；**输入**一律 〖〗/〈〉。自由「客观描写」＝`free.sceneDescription`（默认 standard，算在 60–160 字内）。
- 🔴 指代角色一律「Ta」。协议/示范卡改过 → **升级靠全等锚点**（`LEGACY_PROTOCOLS`、`upgradeSeedCards()`，幂等、作者改过的不动）；卡内容走卡页**「恢复内置版本」**。**别写逐句锚点补丁**。
- 示范卡三张：洛汐/苏念/楚楠；关系网＝**都知道对方是谁、都不知道彼此的分量**。`createDemoProject` 有 **single-flight**。待办：角色头像（第 8 批）。
- 路线图：**第 1–6 批完成**；余 B5 导出文档、C 档状态栏面板（只读）；**ST 卡导入不做、剧本编辑＝占位**。控制面板已 **七段两列**（七、输出后处理）。

## 环境（Windows + Git Bash）
- git `…/PortableGit/versions/1.2.0/cmd/git.exe`；npm 走 `"<托管node>/node.exe" "<…>/npm/bin/npm-cli.js"`，路径用 `C:/` 正斜杠。
- ⚠️ **Edit 会「假成功」**（dev server 下更甚）：改完立即 grep 复查；多处替换用脚本（**锚点自适应 LF/CRLF**、**幂等**）；`node -e` 反引号会被 shell 替换（症状：语法报错 + **被包住的内容静默丢失**）→ 用脚本文件。
- ⚠️ **验「随项目」用换项目**（`db.setCurrentProject`），别直查物理表（写错 API 名会被 `if` 静默跳过 → **假绿**）。审计：「数据丢失」级结论**必须回源码验尸**；实弹会读真实 apiKey（先告知，绝不提交）。

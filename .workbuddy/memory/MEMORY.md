# novel-studio 长期记忆
> 规则/红线/决策；事件留 `YYYY-MM-DD.md`。⚠️ 上限 ~6100 —— 新增前先查同类、合并改写。

## 红线
- 🔴 封装须老大明说「封装」；改完最多 tsc+build+commit。
- 🔴 禁 `git stash`（2026-09-14 stash 中断 → `refs/`、pack、松散对象被永久删除）。遇 `bad object HEAD` 先 `ls .git`。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md`：只记录，明说「处理」才动。提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；三存储经 StoreOps；dev 5199。
- 现 2.1.0（约每月一版，只改号）。版本唯一源 `package.json`；dev 靠 `injectAppVersion()` 注入 `APP_VERSION_LABEL`。
- 🔴🔴 封装**全程无沙箱跑**（沙箱会拦 dist rename / 写 release / 删目录）。rcedit 间歇失败已由 `scripts/after-pack.cjs`（afterPack 钩子，pack 后 NSIS 前，重试+校验）根治 —— 它失败时**退出码仍 0**，只认 stderr `Fatal error`；验收查 exe 含 `青春幻想引擎开发组`。`ELECTRON_CACHE` 指 `AppData/Local/electron/Cache`；NSIS perMachine:false＋不可改安装目录。详见 skill §7。
- 🔴🔴 **只做桌面版**（清理已完成）：无 WEB/PORTABLE；`StoreOps`+`PortableData` 已独立到 `storeOps.ts`（原在 portable.ts），版本号在 `env.ts`。云盘同步＝唯一跨设备途径（`syncCore` 保留）。

## 架构红线
- 无 i18n；schema 列名即存储键。⚠️ 功能改完回搜 `schema.ts` 的 `description`。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台并集」；删门控必跑 `vite build` 验产物。
- ⚠️ `DESKTOP` 是**运行时探测**（读 `window.electronStore`）→ **dev 浏览器恒 false**：`DataDock` 门控全假时不渲染，dev 看不到同步入口属正常。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格=列名；改种子必跑 `seed-schema-check.mjs`。
- 🔴 编辑器双图层：高亮开时文字全来自叠层。① 盒模型逐项一致；② 叠层重建归零 scrollTop → 触发点必 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight`。
- 🗺 **多地图已落地（方案 B）**：新表 `geomaps`（前缀 MAP）＋ geography 的 `所属地图` 列；格档**按图**存；`migrateGeoMaps` 建「默认地图」+回填；🔴 删图不删地点、改图名须连带改归属。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录。🔴 图片字段先压缩再入库。换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属 → `makeCloudStoreWrapper` 必须短路到 local。🔴🔴 桌面读数据文件失败必须**锁写盘**（已修：`main.cjs` 三态 + writeLocked + `DesktopWriteLockBanner`）。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，分类色盘不要主题化。
- 🔴 SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 静默回退黑）。设置项排版＝标题→输入区→说明最后；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认 108%）：凡「量尺寸算回 CSS 值」一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`。未修：GeoMapEditor:216、拖拽未除 zoom（3 处）。
- 🔴 按对侧高度定高：flex item `min-height:auto` 会顶回定高 → 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框别用 `ghost`（酒馆页签→`secondary`）；分段开关 `toggle`+`selected`；行内小操作 `size="xs"`（`danger` 破坏性）。列表选择项不算按钮。
- 🔴 每个页签页头都要 `HelpPopover` 问号指引。
- 界面文案禁 markdown 星号 → 用「」/（）（例外：演示占位符）。同一事别写成互斥分支。

## AI 层
- 🔴 解析统一 `aiParse.ts`；禁裸 `JSON.parse`。温度不手填：结构化传 `{json:true}`→0.3；创意类不传→0.85。
- 🔴 一轮 JSON 用 `aiChatJson(msgs,opts)`（自动取活动模型＋`json`＋`think:false`）。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering 顺序不可换）；upgrade 处是「何时跑哪段」的唯一判断点。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。`think:false` 是 Ollama 专有。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（ubuntu+免密 sudo，SSH `yfe_test_server`）；站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务 → 删库 ≠ 下线服务器。
- 🔴 Nginx SPA 回退：不存在的路径也返 200 + index.html → 不能靠 200 判断上线。
- `npm run verify`（tsc+lint+test）；runner 每入口单开子进程；ESLint 11 warnings 不能盲改。
- 🔴 实机验证走 skill `novel-studio-ui-livecheck`；模型链路 `build-test.mjs live-free|live-tavern`。⚠️ 实弹断言会静默过时→读日志必 grep ✗；子代理结论必回源码验尸。

## 酒馆模式
- 源自《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 调研稿（冲突以方案为准）。侧栏序＝`TABS` 序。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景随项目；自由会话+角色卡+记忆日常+面板设置+剧本库跨项目。索引与分条须成对；tavernReports 别漏 deleteProject。
- 🎛️ 控制面板（八段两列）：tavern.settings；优先级 会话→角色→面板→模式默认。数值真源 paramGuide.ts；预设/档案＝全局 presets/profile。⚠️ mergeDeep 会照抄回已删默认键 → 废弃字段须在 upgradeLegacyDefaults 删。
- 🔴🔴 控制面板分列按实测高度（§12）：左＝不分局部的设置＋协议（协议须**最后一项**，列高同步靠 slice(0,-1)），右＝两种模式手感。段号一动，「N 段设置」文案一起改。
- 🔴 层序：设定→背景设定→这一场(剧本)→记忆→身份→档位→（通用→本场补充）→未带入→协议（钉末尾）。
- 🔴🔴 上下文预算：historyBudget＝预算−400−整条 system（别传记忆）；contextBudget 16000（三处一致）→ 默认档历史仅约 2600 字。contextSource＝both/digest/raw。空层不占额度。
- 🔴 记忆 vs 设定：记忆＝发生过什么＋此刻温度（summarize.ts）；设定＝这让 Ta 变成了谁（revise.ts）。拦不住 → findNarrativeOverlap 标 ⚠️。
- 📚 🔴 背景设定（`world.ts`）：关键词空＝总是注入，上限 1800 字。只服务剧情推演；键只剩 `tavern.world`。
- 🧩 模型配置＝灵感启发最上方独立面板（`AIConfigPanel.tsx`）；全应用共用一个活动模型，改配置靠 `reloadKey` 通知下游重读。指路统一「灵感启发 → 模型配置」。
- 🌐 联网检索：全局键 `app.search`（入口 `searchSettings.ts`）。三档 off/model/api，引擎 bocha/searxng/custom；地址含 {query}⇒GET；桌面主进程代发。🔴 起草须如实回告，没联上就明说。SearXNG :8888。
- ✍️ 起草：draft.ts（角色卡 13 栏）。🔴 提纲 fields 必须覆盖全部栏；草稿示例对话要守协议格式。
- 🔴 对话引导已泛化：机制＝`lib/interview.ts`（只认 `InterviewSpec`），界面＝`InterviewChat.tsx`，别无第二份。
- 🛠 后处理：`postRules.ts` 按序跑正则再落库；🔴 去 markdown 排在星号动作前。行首说话人标签默认关。
- 🎚 本场数值：`vars.ts`＋`VAR_DEFS`（可逐项关），规则挂 `modeExtra`。🔴 认不出的行不剥；手改清 `prev`；先解变量再后处理。
- 🎭 剧本：`script.ts` 六栏。🔴 库在全局 meta；🔴🔴 会话存快照不是引用；开场白不进 system（＝对话第一条）。
- 🔴 engine↔world/script/draft 环已上移 `provider.ts`（engine 处 re-export）。设定更新：12 字段白名单（不含 name）＋二次把关；采纳＝整段替换。
- 🔴 分支/回滚：branchSession 截到该条，分叉点后连记忆一起清；回滚连记忆还原＋undoSnapshot。hidden 出口＝toChatMessages＋messagesAfterWatermark；重说＝runPlotTurn/runFreeTurn(session,null)。
- 🔴 剧情记忆**已实现**：`runPlotSummary`→`memoryToText` 写回 `session.memory`+推水位线。
- 🔴 `buildMultiCharRule`：整场 AI 必传 `{hasUser:false}`；`userCharId` 的卡/记忆/轮转都排除。水位线全成功才推进。
- 🔴 在场调度：`muted`+`talkativity` 会话级、两模式共用。静音＝在场不发言、卡与记忆不进上下文；UI 拦「最后一位不能静音」。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（新字段须登记）。
- 🔴 提示词与解析器对齐：标题整行匹配（禁 `includes`）；总结必带角色背景；复制为新卡不复制记忆/日常；新建/导入卡自动生成初版记忆；卡片块带名仅同场同名挂短码。
- 🔴 输出规范 v1.3：对白＝纯文本（不含名字）、动作神态＝（）、环境＝【】、状态＝〔〕；输入一律 〖〗/〈〉。
- ⚠️ `LEGACY_SEED_EXAMPLES` 是**多版本数组**：改 examples 时把被替换的每一版都追加，只留上一代则老库升不上来。
- 🔴 指代角色一律「Ta」。协议/示范卡改动靠全等锚点升级（`LEGACY_PROTOCOLS`/`upgradeSeedCards()`，幂等），别写逐句补丁。示范卡三张洛汐/苏念/楚楠（都知道对方是谁、不知彼此分量）；`createDemoProject` single-flight。
- 路线图：需求全完成；C1 向量记忆/C3 立绘/ST 卡导入/TTS 放弃。方案 `docs/剧本与变量-设计方案-讨论稿.md`；报告 `docs/2.1.0-*`。

## 环境（Windows + Git Bash）
- git / npm 都用绝对路径（PortableGit 1.2.0 `cmd/git.exe`；托管 node + `npm/bin/npm-cli.js`），路径写 `C:/` 正斜杠。
- ⚠️ Edit 会「假成功」：改完立即 grep 复查；多处替换用脚本（**全命中才落盘**）；`node -e` 反引号被 shell 吞 → Write 落脚本。⚠️ CRLF/LF 混用（App.tsx CRLF、db.ts LF）→ 跨行锚点先探测 EOL；`replace_all` 前确认每处前提一致。
- ⚠️ `sort -n/-r` 会解析到 Windows `sort.exe` → 用 node 脚本；`git bundle create` 中文路径建不了 `.lock` → 英文路径建再 `cp` 回。
- ⚠️ 验「随项目」用换项目（`db.setCurrentProject`），别直查物理表（写错 API 名会静默跳过→假绿）。实弹会读真实 apiKey（先告知，绝不提交）。

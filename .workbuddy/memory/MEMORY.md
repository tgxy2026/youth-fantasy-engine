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
- 🔴🔴 封装**全程无沙箱跑**（沙箱会拦 dist rename / 写 release / 删目录）。rcedit 间歇失败已由 `scripts/after-pack.cjs`（afterPack 钩子）根治 —— 它失败时**退出码仍 0**，只认 stderr `Fatal error`；验收查 exe 含 `青春幻想引擎开发组`。`ELECTRON_CACHE` 指 `AppData/Local/electron/Cache`。详见 skill §7。
- 🔴🔴 **只做桌面版**：无 WEB/PORTABLE；`StoreOps`+`PortableData` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径（`syncCore` 保留）。

## 架构红线
- 无 i18n；schema 列名即存储键。⚠️ 功能改完回搜 `schema.ts` 的 `description`。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台并集」；删门控必跑 `vite build` 验产物。
- ⚠️ `DESKTOP` 是**运行时探测**（`window.electronStore`）→ dev 浏览器恒 false；`DataDock` 已加 DEV 兜底。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格=列名；改种子必跑 `seed-schema-check.mjs`。
- 🔗 功能门：`FEATURE_TIER` + `STRONG_DEPS`（勾 B 连带 A，**互绑须双向**）+ `ANY_DEPS`（至少一个）；闸 `feature-deps-check.mjs`。
- 🔴 编辑器双图层（高亮时文字全来自叠层）：① 盒模型逐项一致；② 叠层重建归零 scrollTop → 触发点必 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight`。
- 🗺 **多地图（方案 B）**：新表 `geomaps`＋ geography 的 `所属地图` 列；格档**按图**存；`migrateGeoMaps` 建「默认地图」+回填；🔴 删图不删地点、改图名连带改归属。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录。🔴 图片字段先压缩再入库。换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属 → `makeCloudStoreWrapper` 必须短路到 local。🔴🔴 桌面读数据文件失败必须**锁写盘**（`main.cjs` 三态 + `DesktopWriteLockBanner`）。
- 🔄 **两同步入口别混**：①改数据文件位置＝明文 JSON 进云盘（文件级覆盖、apiKey 明文上云）；②云盘文件同步＝加密 `.yfe`＋记录级合并＋每日备份＋兜底。🔴 用 ②。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，分类色盘不要主题化。
- 🔴 SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 回退黑）。设置项排版＝标题→输入→说明最后；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：① 量尺寸算回 CSS 值一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；② 🔴 **zoom 不缩放 vh** → `.h-screen`/`.min-h-screen` 已在 index.css 折回 `calc(100vh / var(--ui-zoom,1))`（`applyZoom()` 写 `--ui-zoom`），新增 vh 用法照此办。未修：拖拽未除 zoom（3 处）。
- 🔴 按对侧高度定高：flex item `min-height:auto` 会顶回定高 → 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框别用 `ghost`（→`secondary`）；分段开关 `toggle`+`selected`；行内小操作 `size="xs"`（`danger` 破坏性）。列表选择项不算按钮。
- 🔴 每页签页头要 `HelpPopover` 问号。气泡输入：Enter 发送／Shift+Enter 换行，**必挡 `nativeEvent.isComposing`**（中文输入法 Enter 是选字确认）。剧情推演多角色同场已有头像（角色来自项目卡、无头像字段 → 只出首字圆标）。
- 界面文案禁 markdown 星号 → 用「」/（）（演示占位符例外）。同一事别写成互斥分支。

## AI 层
- 🔴 解析统一 `aiParse.ts`；禁裸 `JSON.parse`。温度不手填：结构化 `{json:true}`→0.3；创意类→0.85。
- 🔴 一轮 JSON 用 `aiChatJson`（自动取活动模型＋`json`＋`think:false`）。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）；upgrade 是「何时跑哪段」的唯一判断点。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`）；站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务 → 删库 ≠ 下线服务器。
- 🔴 Nginx SPA 回退：不存在路径也返 200 + index.html → 不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；runner 每入口单开子进程；ESLint 11 warnings 别盲改。
- 🔴 实机验证走 skill `novel-studio-ui-livecheck`。⚠️ 实弹断言会静默过时→读日志必 grep ✗；子代理结论必回源码验尸。

## 酒馆模式
- 源自《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 调研稿（冲突以方案为准）。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景随项目；自由会话+角色卡+记忆日常+面板设置+剧本库跨项目。索引与分条须成对（tavernReports 别漏 deleteProject）。
- 🎛️ 控制面板（八段）：tavern.settings；优先级 会话→角色→面板→模式默认。数值真源 paramGuide.ts；预设/档案＝全局 presets/profile。⚠️ mergeDeep 照抄回已删默认键 → 废弃字段须在 upgradeLegacyDefaults 删。
- 🔴🔴 控制面板分列按实测高度：左＝不分局部的设置＋协议（协议须**最后一项**、靠 slice(0,-1) 同步列高），右＝两种模式手感。段号一动，「N 段设置」文案一起改。
- 🔴 层序：设定→背景设定→这一场(剧本)→记忆→身份→档位→（通用→本场补充）→未带入→协议（末尾）。
- 🔴🔴 上下文预算：historyBudget＝预算−400−整条 system（别传记忆）；contextBudget 16000（三处一致）→ 默认档历史仅约 2600 字。源 both/digest/raw。空层不占额度。
- 🔴 记忆 vs 设定：记忆＝发生过什么＋此刻温度（summarize.ts）；设定＝这让 Ta 变成了谁（revise.ts）。越界由 findNarrativeOverlap 标 ⚠️。
- 📚 🔴 背景设定（`world.ts`）：关键词空＝总是注入，上限 1800 字。仅服务剧情推演；键只剩 `tavern.world`。
- 🧩 模型配置＝灵感启发最上方独立面板（`AIConfigPanel.tsx`）；全局共用一个活动模型，改配置靠 `reloadKey` 通知下游。
- 🌐 联网检索：全局键 `app.search`。三档 off/model/api（bocha/searxng/custom）；地址含 {query}⇒GET；主进程代发。🔴 起草须如实回告。
- ✍️ 起草：draft.ts（角色卡 13 栏）。🔴 提纲 fields 须覆盖全部栏；示例对话守协议格式。
- 🔴 对话引导：机制 `lib/interview.ts`（只认 InterviewSpec），界面 `InterviewChat.tsx`，别无第二份。
- 🛠 后处理 `postRules.ts`：按序跑正则再落库；行首说话人标签默认关。⚠️ `*单星*`＝动作标记（→（））、`**双星**`＝markdown（只剥星号）—— 一律当动作会吃掉加粗对白（测试拦下过）。
- 🎚 本场数值：`vars.ts`＋`VAR_DEFS`（可逐项关），规则挂 `modeExtra`。🔴 认不出的行不剥；手改清 `prev`；先解变量再后处理。🔴 `place` 是唯一不跟 `everyTurns` 走的（场景锚：`!ask` 时单给一句，空值首轮要求落值）。
- 🎭 剧本：`script.ts` 六栏。🔴 库在全局 meta；🔴🔴 会话存快照不是引用；开场白不进 system（＝第一条消息）。
- 🔴 engine↔world/script/draft 环已上移 `provider.ts`。设定更新：12 字段白名单（不含 name）＋二次把关；采纳＝整段替换。
- 🔴 分支/回滚：branchSession 截到该条，分叉点后连记忆一起清；回滚连记忆还原＋undoSnapshot。hidden 出口＝toChatMessages＋messagesAfterWatermark；重说＝run*Turn(session,null)。
- 🔴 剧情记忆：`runPlotSummary`→`memoryToText` 写回 `session.memory`+推水位线。
- 🔴 `buildMultiCharRule` 必传 `{hasUser:false}`；`userCharId` 的卡/记忆/轮转排除；水位线全成功才推进。
- 🔴 在场调度：`muted`+`talkativity` 会话级、两模式共用。静音＝在场不发言、卡与记忆不进上下文；最后一位不能静音。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（新字段须登记）。
- 🔴 提示词与解析器对齐：标题整行匹配（禁 `includes`）；总结必带角色背景；复制为新卡不复制记忆/日常。
- 🔴 输出规范 v1.3（协议常量已 v1.5）：对白＝纯文本（不含名字）、动作＝（）、环境＝【】、状态＝〔〕；输入 〖〗/〈〉。
- 🔴 改协议须同步：`PROTOCOL_CORE` 版本号＋旧全文追加 `LEGACY_PROTOCOLS`（现 v1.1–1.4）＋`PROTOCOL_VERSION`；两处版本断言。v1.4＝B2 换场纪律（地点不归你搬／换场先写「怎么到的」）；v1.5＝格式自查（没有括号的行只能是说出口的话）。
- 🔴 指代一律「Ta」。协议/示范卡靠全等锚点升级（`LEGACY_PROTOCOLS`/`upgradeSeedCards()`/`LEGACY_SEED_EXAMPLES` 都是**多版本数组**、幂等；只留上一代则老库升不上来），别写逐句补丁。示范卡三张洛汐/苏念/楚楠（都知道对方是谁、不知彼此分量）。

## 环境（Windows + Git Bash）
- git / npm 都用绝对路径（PortableGit 1.2.0 `cmd/git.exe`；托管 node + `npm/bin/npm-cli.js`），路径写 `C:/` 正斜杠。
- ⚠️ Edit 会「假成功」：改完立即 grep 复查；多处替换用脚本（**全命中才落盘**）；`node -e` 反引号被 shell 吞 → Write 落脚本。⚠️ CRLF/LF 两套并存 → 跨行锚点先探测 EOL；`replace_all` 前确认每处前提一致。
- ⚠️ `sort -n/-r` 会解析到 Windows `sort.exe` → 用 node 脚本。
- ⚠️ 验「随项目」用换项目（`db.setCurrentProject`），别直查物理表（API 名写错会静默跳过→假绿）。实弹会读真实 apiKey（先告知，绝不提交）。

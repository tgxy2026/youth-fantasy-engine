# novel-studio 长期记忆（核心）
> 只留「必做／必禁」判据。**为什么、踩坑经过 → `docs/2.x.x-*` 与 skill**。事件流水 → `YYYY-MM-DD.md`。
> 📎 版本细节 / 任务中心 / 酒馆 / 出厂数据 → 同目录 `MEMORY-REF.md`（需要时 Read）。

## 红线
- 🔴 产品立场：AI 只辅助。**绝不写反检测/洗 AI 痕迹**，只做存证＋自检＋如实申报。
- 🔴 封装须主人哥哥明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 禁 `git stash`、手工 `git gc`/`reflog expire`（两次事故）。恢复靠 `git bundle`；`gc.auto=0` 别改回。
- 禁删 `release/eb-cache/`；禁原生 `prompt/confirm/alert`；`docs/优化清单.md` 只记录、明说「处理」才动；提交含 `!`/换行用 `git commit -F`；main 无远程。

## 身份·版本·封装
- Electron+React+TS+Vite+Tailwind；存储经 StoreOps；dev 5199 须 `localhost`；🔴 只做桌面版；版本源 `package.json`。
- 🔴 版本口径：**2.6.4 从未发布＝并入 2.7.0**。已发布 2.7.0（Release 1179327 / tag v2.7.0）、2.7.1、2.7.2（Release 1180321）。🔴 版本源＝`package.json`，当前 **2.7.3**（10-03 升号，内容已提交、**尚未封装**）。
- 🔴 近版细节 `docs/2.7.1-*`／`docs/2.7.2-*`；**会咬人的三条**：①**TABS 题材页签＝getter 读模块级 `activePack`**；②题材枚举复用废弃 `Project.genre`（值＝包名、发布后冻结、改名走 `PACK_ALIASES`、勿加 DB 列）；③关系表判重＝**有向对 + 关系类型**（真源 `aiScope.ORGANIZE_KEYS`+`isDirectedPairTab`）。
- 🔴🔴 封装**全程无沙箱跑**；`electron-builder.yml` 须 `win.signAndEditExecutable:false`。
- 🔴🔴 **封装只做三步：封装 + 同步 Gitee + 出更新说明。绝不主动清理 `release/desktop-out-*` / `dist`**（2026-10-02 明定）。
- 🔴🔴 **主 exe 元数据/图标**：packaging 必重写 exe ⇒ 钩子全无效。**唯一正解＝外层 rcedit 补写 + `electron-builder --win nsis --prepackaged <win-unpacked>`**。🔴 脚本内起子进程**恒 EBUSY** ⇒ 只能从外层跑。判据只信 **PE 内 UTF-16LE 串**＋体积。
- 🔴 启动默认停项目管理首页；删项目清 `lastProject`。

## 创作链路
- 🔴 **切章必清 ghost**；创意写作起点不手选；续排起点＝已有细纲最大章号+1；每卷章数＝硬指标；写前必 `previewCommit`、键取自 `fieldMap`。
- 🔴 整章改写五档（续写＝代码留原文、模型只吐增量）：显式快照、只动 content/wordCount/updatedAt、过 `enforceWordRange`（±300）；🔴🔴 历史章冻结、最新章仅改写档放开＋落库后跑设定同步。
- ✅ 伴写＝ghost 叠层＋「钢笔」弹窗（默认关）；🔴 Ctrl+Enter 采纳、Alt+/ 换一句，**Tab 恒归缩进**；折行 `foldGhostNewlines`。
- 🔴 表格批量导入三条：候选值口径＝`resolveColumnCandidates`（**`calendars`/`ctx` 必传**）；界面**算了就要显示**；中断＝已成功行先 `setRows` 再抛。导出＝屏幕视图 `sortedRows`。
- 🔴 酒馆：结算期停止＝照常落库不回滚（`shownReply`）。
- 🔴🔴 酒馆「结束本轮对话」三笔写入同一提交点：`saveMemory`（`tavern.free.mem.<charId>`，**全局键不带 sessionId**）＋ `appendJournalEntry` ＋ `saveFreeChar`；任一中止⇒**一条不落**（记忆**无幂等**）。

## 架构红线
- 无 i18n；schema 列名即存储键。⚠️ 打包陷阱：tree-shake（门控用平台并集，删门控必 `vite build`）；`DESKTOP` 探测 dev 恒 false。
- 🔴🔴 **schema 已三段拆开（10-03）**：`schema.ts` 只剩**门面**（拼 TABS ＋ 显式再导出 ＋ 其余工具，283 行）；字段构造器（`c/cr/ca/f`…）/SABC/卷台账/制度页签工厂在 **`schemaShared.ts`**；TABS 数组体按**原顺序**切到 **`schemaTabs/part1..3.ts`**。🔴 段文件**只许依赖 schemaShared 与 schemaTemplates，绝不许 import schema.ts**（循环依赖 ⇒ const 在 TDZ 里炸）。外部一律 `from './schema'`（门面**显式再导出，禁 `export *`**）。
- 🔴🔴 **文件一搬，扫描器就失明**：断言「某字段在 schema 里」的测试改读 `readSchema()`（门面＋三段合并视图）；结构闸 ③-b「纯数据文件」判据对「字面量＋构造器调用」失灵 ⇒ 三段已登记豁免并写明理由。**搬文件前先 grep 谁在 `read()` 它**；拆分后必跑全量单测，红的往往就是扫描器。
- 🔴 门面显式再导出（勿 `export *`）；`PROMPT_ORDER` 还原注册序（新提示词**追加末尾**）；`ops`/`currentProjectId` 须 `export let`。
- 🔴 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；拆书／创意写作＝optional。
- 🔴 **无「名称」列的表格草稿必须声明 `dedupKeys`**；左下角只准一个浮层 `DataDock`；种子键：卡片 `模块::字段`、表格＝列名。
- 🔴🔴 **表格列名＝存储键**（`cellVal(row,col.name)`／`setCellDraft(row.id,col.name,v)`／`<th key>`）⇒ 想让作者改名**只能做显示名**：`lib/fieldAlias.ts` 的 `sanitizeAliases()` 是唯一口径（表头／关系分组／检索共用），存储键写 `fieldAlias::<tabId>`（进同步）。🔴 **AI 链路一律仍用存储键**，别把显示名喂给模型。表单类页签（`模块::字段`）尚未支持（清单 #011）。
- 🔴🔴 **改数据结构必问「写入侧都改了吗」**：凡把某层改成「不读」，grep 全部写入入口。
- 🔴🔴 **换 id 搬数据必带映射**：`settingsKV` 存 id 数组的键（如 `worldSubActive::<tab>`）必须过 `remapSettingValue()`。新增此类键要同步扩。
- 🔴 **hook 返回对象 ≠ 布尔**：`useAIReady()` → `{ready,label}`；一律写 `const { ready: x } = useAIReady()`（已踩两次）。
- 🔴 **列表行内按钮必显式传 id**：`subs.map(s=>…delSub())` 捕获外层 `sel` ⇒ 点 A 删 B。新组件一律 `delSub(s.id)`。
- 🔴🔴 **切页签＝卸载旧组件**（App.tsx 条件渲染）⇒ 长任务状态放模块级 store；lib 层禁 import components。
- 🗺 多地图：`geomaps`＋geography 的 `所属地图`；删图不删地点、改图名连带改归属。
- 🔴 **历法设置单一入口**：页头「历法规则」弹窗（`CalendarRuleModal`）；表格里 `col.calendar` 只选不建。改名须连带更新 `history`/`timeline` 引用行；删除只移除选项、保留文本。
- 🔴 审计四条：语料净化／`KEEP` 白名单／死代码回查 `docs/` 判决／**工具的结构假设会静默失明**。
- 🔴🔴 **出厂大数据必须动态 import**：示范正文 `src/data/seedContent.ts`（7664 行）只在 `doCreateDemoProject()` 内 `await import` —— 改回静态 import 就把整部小说塞回主包（主包 +685 kB，翻 asar 时代码全被小说淹没）。素材库 `materialData` 本就走懒加载 chunk。

## 存储·同步
- 🔴🔴 云盘同步「删了会复活」是**家族**：墓碑 `syncTombstone.ts`＋`localHasContent` 闸；一次找齐四条路径（本地没有／云端没有／两端一致／desktop `bulkPut` 的 `clearDeleted()`）。
- 🔴 排除表 `EXCLUDED_META_KEYS`：`aiProviders` 三键 + `app.search`；老库第二载体 `tavern.settings.search`（`migrateLegacySearchKey`）。🔴🔴 清理**启动期也要跑**。
- 🔴🔴 **本地专属 store 单一判据**：`syncCore.LOCAL_ONLY_STORES`+`isLocalOnlyStore()`（含 `backups`、`backupPayloads`）；载荷在 `backupPayloads`（IDB v11），`migrateBackupPayloads` 须在 currentProjectId 守卫**之前**。
- 🔴🔴 桌面读数据失败**必须锁写盘**（`main.cjs` 三态＋`DesktopWriteLockBanner`）；启动期读 `getDesktopState()` 恒 false ⇒ 用 `desktopStoreReady()`。桌面整库一 JSON；图片先压缩。
- 🔴🔴 服务器已彻底清理 → 同步只剩云盘；`createIdleTransport`＝占位（🔴 绝不返回空库）。

## 保存快捷键（2.7.3）
- 🔴🔴 **Ctrl/Cmd+S 唯一实现＝`src/lib/useSaveHotkey.ts`**（回调走 ref、enabled 假时不挂监听）。新增任何带「保存」按钮的面板只需一行 `useSaveHotkey(save, dirty)` —— **别再自己写 keydown**（2026-10-03 社区反馈：抄写型实现漏挂了 6 个页签）。
- ① 挂在 `if (!m) return` **之前**（hooks 数量不稳会报错）；② 父子嵌套（如 TavernCard 与记忆面板）**只挂父级**，双挂会双写竞态；③ 闸 `tests/structureGates` 第 ⑦ 条钉死清单 `HOTKEY_PANELS`＋豁免表 `HOTKEY_EXEMPT`（豁免要写理由）。

## UI·布局尺寸
- 🔴🔴 `<html>` 界面缩放：量尺寸用 `offsetHeight`/`clientWidth`（禁 rect 绝对值）；vh/vw 不随 zoom→内联 `foldVh()`；SVG 滚轮/拖拽除 zoom。
- 🔴 有 `onChange` 就在里面同步光标/选区；判「琥珀开启态」按 class 词元比。
- 🔴 按对侧高度定高：flex item 加 `overflow-hidden`，别同写 `flex-1`+`height`；图表柱给 `max-w`。
- 🔴🔴 **插包裹层必回看子元素 `h-full`**；`App.tsx` 的 `main > div.h-full` 是撑满链关键层。
- 🔴 按钮：静止无框 `secondary`；分段 `toggle`+`selected`；**尺寸＝弹窗 md／主操作 sm／工具 xs；同排同 size**；🔴🔴 `SIZE` 已含字号 ⇒ 禁再叠 `h-*`/`px-*`/`text-*`。
- 🔴 页头 `HelpPopover` 问号**须与标题同行**；文案禁星号→用「」；Enter 发送挡 `isComposing`。
- 🔴 z 层走 `Z.*`；数值输入走 `NumberField`；偏好走 `lib/uiPrefs.ts`（存偏离默认的一侧）。
- 🔴 新增页签**四处**同步：`TabType`／`TABS`／`App.renderContent`／`FEATURE_TIER`；资料型另须 `aiContext.PRIORITY`。

## AI 层
- 🔴 **提示词给几层模型就按几层输出**（读端须兼容）；解析统一 `aiParse.ts`（禁裸 `JSON.parse`）；生成型走 `parseLooseObject`＋空结果重试。
- 🔴🔴 **D＝终结：任何情况都不进 AI**（`isPrunedForAI`），该列封闭枚举禁增删改。
- 🔴🔴 **S＝绝密：仅角色视角（`viewMode:'character-view'`）整行剔除**，作者/导演视角照带 —— 真源 `aiContext.isSecretRow`＋`hideSecretRows`，**四条通路**（renderCards/renderTable/sectionOf 表单/renderActiveSubSets）必须一致。
- 🔴🔴 **酒馆收尾＝事务**：`roundEnd.runRoundEnd` ①②③ 任一中止⇒一条不落；②b 回写主角色卡**只能算不能写**（`pendingCardWrite`），真落卡在 ③ 之后的提交点。
- 🔴 `isCancelled` 判据＝`e.name === 'AICancelled'`（不看 message）。
- 🔴 `historyBudget(total, system, overhead?)` **没有「记忆」形参**，别加回。
- 🔴 提示词可编辑：默认值就地声明；变量模块级 `let`＋setter；**注册顺序＝设置页顺序**。
- 🔴 温度：结构化固定 0.3；创意按 provider 存（缺省 0.85）；🔴🔴 结构化任务**必传 `json:true`**。
- 🔴🔴 markdown 星号政策：喂模型／纯文本渲染／导出 HTML 一律禁 `**`（用「」，嵌套『』）；**仅导出 `.md` 保留**；`tavern/**` 另有净化器。
- 🔴 逐字引用定位前**先剥强调**（`mdLite.stripEmphasis`）。
- 🔴 孤儿章须并入叙事序：`buildChapterDigest`/`idsUpToAnchor`/`findRelatedChapters` 三处一致。
- 🔴 采样： `repeat_last_n` 512＋`frequency_penalty` 0.1；🔴🔴 绝不调高 `repeat_penalty`。
- 🔴🔴 **思考模式默认口径（10-03 核实，旧记忆「思考模型须关思考」已作废）**：分三路 ——①**本地 Ollama**：`think` 默认 undefined ⇒ **不传该字段＝保持模型思考**（项目**刻意保留**，利于深度设定补全；`ai.ts` 注释明写）；②**云端 Qwen3/QwQ 混合**：`enable_thinking:false` **默认关**（开着就拿不到 content）；③**云端其它模型**：不下发任何开关＝服务端默认。**统一归中在 `chat()`：`opts.think ?? (opts.json ? false : undefined)`** —— JSON 任务一律关（32 处 `json:true` 此前只有十来处显式关，其余本地一直开着思考、会被截断成 271 字 ⇒ JSON 必残），长文任务保持思考，显式 `think:true` 是逃生口。⚠️ 已复核但**有意不动**：酒馆对话默认关（`disableThink:true`，面板可开回）、**创意生成也归关侧**（取舍备案在 `chat()` 注释里）。⚠️ 本地思考型模型走长文路径会保持思考，属设计（深度设定补全要它）。
- 🔴🔴 额度跟模型走：`adviseCapacity()`→`recommendTuning()`；新增额度档同步 `tests/writerBudget` 的 LEGACY 表（键数相等）。
- 🔴 长文必走流式（`aiTasks/stream.ts`）；失败原因经 `onLog` 转界面。
- 🔴 AI「读哪些数据」＝`lib/aiDataSources.ts` 单一源（新条目须被组件 `feature="id"` 引用）；🔴🔴 禁写「全程本地/不外发」——口径＝发给**当前选定的**模型。
- 🔴🔴 候选值注入只有一处：`organizeRows.resolveColumnCandidates()`；三条链路都**显式传 `calendars`/`ctx`**。
- 🔴🔴 **AI 上下文「可挑选」原则**（10-03）：`buildWorldContext(onlyKeys?)` 按 `WORLD_CONTEXT_GROUPS` 分组，**不传 = 全取**（保持旧调用方行为）；对话引导面板默认只勾 worldbase，**禁全量灌注**。🔴 **通用组件不自己读库**（`InterviewChat` 只收 `context` 字符串 ＋ 可选 `headerSlot`），读什么由调用方备好。兄弟条目摘要走 `interview.buildSiblingContext()`（**必须截断**：每条 ≤14 行 / 整体 ≤56 行）。⚠️ 该函数字段名是**硬编码白名单**，schema 改名会静默取空 —— 有测试钉住（注意 `positioning` 的字段写在 `schemaTabs/part1.ts`，**不在** `schemaTemplates/`）。
- 🔴 迁移只走 `db.runMigrations()`（不可换序）；作者原文进 prompt 走 `promptGuard.authorBlock()`；本地预算上限 32K。
- 🔴 **新增 AI 功能四处注册**：`aiTasks`／`aiDataSources`／`aiWriterBudget`／界面挂 `AIDataSourceNote`。

## 工程质量·实机
- 三步基线：`tsc --noEmit`／`eslint src tests`／单测（**tsc 与单测是两道独立的关**）。
- 🔴🔴 **`run-all.mjs` 在本机假绿**（子 spawn 被拦成 EBUSY，`status` 为 null）⇒ **真实基线用外层 shell 逐个跑** `node tests/build-test.mjs <名>` 并**判退出码**（别 grep「0 failed」）。基线 132/132。
- 🔴 闸 `tests/structureGates`（800 软/1200 硬、归属、禁裸 `JSON.parse`、原生弹窗、any 账本只准降）。
- 🔴 实机走 skill `novel-studio-ui-livecheck`；子代理结论必回源码验；断言落库须直读 IDB；复跑扫描器**一律不带参数**。
- 🔴 拆巨型组件四件套：`vite build`＋grep `tests/` 路径引用＋负面对照＋主文件头写明哪些 DOM 不能动。
- 🔴🔴 改启动路径/首启行为＝改了所有实机脚本前置条件。🔴 测试「构建失败」会藏真 bug（esbuild `No matching export` 先补桩再跑）。

## 环境（Win + Git Bash）
- git/npm/node 用**绝对路径**且每次现探；`sort`/`find`/`timeout` 解析到 Windows 同名 exe→改 node 脚本。
- 🔴 **G 盘元数据极慢** → 大批小文件单进程挂后台、**禁并行**；中文路径 `git ls-files -z` 按 `\0` 切。
- 🔴🔴 同消息对同文件多个 Edit 会互相覆盖 → 用 `.workbuddy/tmp/apply-many.mjs`（JSON+count 守门，先 `--dry`）。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**（返空→误判→覆盖），用 `Read`／`test -f`。
- 🔴 脚本内 `spawnSync`/`execFileSync` 恒 **EBUSY**（改「清单外层生成」）；`fs.rmSync` 走 safe-delete ⇒ 清产物用 `unlinkSync` 深搜。

## 对外推广
- 🔴 文末**禁裸链**（禁 `https://`／`pan.quark.cn` 连写／「提取码」→「口令」）；链接压最末＋后有缓冲。
- 🔴 **发帖顺序**：版本号须先在夸克盘＋Gitee 上架。本窗口只输出**版本更新说明**。
- 入口：Gitee `tgxy2026/youth-fantasy-engine`；夸克 `pan.quark.cn/s/8ae0eb718cf5` 口令 `QfAm`。
- 🔴 令牌 `G:/AI软件/.gitee-token.txt`；push 只需 `GIT_CONFIG_NOSYSTEM=1`；🔴🔴 **绝不加 `GIT_CONFIG_GLOBAL=NUL`**（屏蔽 GCM ⇒ 静默挂死）。
- 🔴 附件配额：滚动保留最新 3 个 Setup.exe（配额 1GB，每版 ~81MB）。
- 🔴 发布链＝skill `novel-studio-packaging`＋`gitee-publish`；快照 sync 后必 `git checkout -- .gitignore`。
- 🔴🔴 **同步 Gitee＝开发源码仓库直接 `git push gitee main`**（自带 remote，URL 内嵌令牌）。🔴 开源快照仓库 `G:/AI软件/novel-studio-开源版` **已废弃停更**（停在 v2.7.0，与远端真分叉）⇒ **别再跑 sync-open-source 镜像链路**。同版本重打包＝删旧附件 + 传新附件 + PATCH body。

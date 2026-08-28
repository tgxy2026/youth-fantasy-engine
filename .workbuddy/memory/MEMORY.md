# novel-studio 长期记忆（MEMORY.md）

## 项目身份
「青春幻想引擎」小说创作管理应用。Electron 31 + React 18.3 + TS 5.5 + Vite 5.3 + Tailwind（ink/amber 护眼主题）。三存储后端（IndexedDB/便携/桌面）经 `StoreOps`。dev http://localhost:5199/，managed node `C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`（勿用全局）。

## git 基线（2026-08-28 起）
- 本地仓库已 init（main，无远程），.gitignore 排除 node_modules/dist/release/build。基线提交 5e385dc。
- **每轮审计/封装完成后 `git add -A && git commit`**，提交信息写清本轮修复要点。

## 数据安全测试（tests/）
- `node tests/build-test.mjs adversarial|roundtrip`：esbuild 打包真 db.ts+seedData，内存 StoreOps 桩替换 portable/desktop。roundtrip 6 用例（导出/导入往返语义一致、迁移幂等×3、编号正确）；adversarial 24 用例（chapterSeq 边角、audit 纯函数、autoCode、AI 上下文截断/跨卷、章节清单截断与孤儿章、continuityCheck+dataHealth 喂畸形数据）。**改动 db.ts / audit.ts / chapterSeq / aiContext / 迁移逻辑后必跑两条。**
- 已修复的数据丢失级 bug：migrateChapterLedger 迁移后误删台账行（movedIds 修复）；importProject 未重映射卷台账 tabId（已修）。**凡新增导出/导入/迁移逻辑，先补 round-trip 用例再上线。**
- AI 输出渲染已审计安全：markdown 报告走 React 文本节点转义、高亮叠层 escapeHtml 全程覆盖。
- 坑：'chapter-vol-' 是 **12** 字符；slice(11) 是 off-by-one。

## 封装红线（无 git 仓库，最高优先级）
- 封装前必确认：① `tsc --noEmit` 0 错 ② `vite build` 0 错 ③ 改动落盘。**切勿直接打包未验证**。
- 封装标准流程（顺序不可乱）：① 全面代码审查（修 bug/剔除冗余）② 升 `package.json` 的 `version` ③ 启动封装。未审查完、未升版本，禁止封装。
- 封装时只改 `package.json` 的 `version`，build 脚本动态生成 exe 名/outDir/标题。
- 版本显示：dev 恒显「开发版」（`vite.config.ts` 注入），build 注入真实版本；`src/lib/portable.ts` 回退值 `'开发版'`。
- G 盘 safe-delete 拦截 `rmSync`/`unlink`：vite build 前先 `mv dist dist.oldbak`；永久删目录用 `command rm -rf`（仅项目内非源码）。⛔ 禁删 `release/eb-cache/`。
- 封装后清理源码目录临时文件（`dist.oldbak`/`dist_bak_*`）。

## 项目硬规则
- 📁 工作区根目录 `你需要的图片我放在这里/` 为用户放图专用，**禁止删除**。
- ⛔ 禁用浏览器原生 `window.prompt/confirm/alert`；输入走 `PromptModal.tsx`，确认/轻提示走 `dialogs.tsx` 的 `confirmDialog()` / `showToast()`。
- ⚠️ **本机 Edit 工具坑**：G 盘 safe-delete 拦截致「首编辑偶发失败、成功可能未落盘」——改完务必 `tsc --noEmit` + 抽查文件复核。
- 🔁 一轮活干完若 dev 没跑，顺手起后台；探活期望 `200`。

## 版本现状
- 1.8.0 手绘地图+地理联动；1.9.0 灵感工具拆分+检查工具+ErrorBoundary；1.9.1 表头筛选/按卷建表/补登模式/示范项目卷二。
- **1.9.2（进行中，2026-08-28）**：章节名与顺序解耦已落地——`src/lib/chapterSeq.ts` 为顺序唯一权威（flattenChapters/chapterSeqMap/chapterSeqOf/sortChapters，全派生不落库）；`Chapter.excludeFromNumbering` + 章节行 Hash 图标开关；continuityCheck 不再解析标题；aiContext.getChapterTexts 跨卷排序 bug 已修；`migrateChapterLedger`/`migrateChapterNumbering` 均已在 App.tsx openProject 接入。esbuild 11 用例验证通过。
- **1.9.2 日常审查轮（2026-08-28 晚）**：修复 doAddChapter stale state bug（新章序号恒 0 → 台账章节号留空，改现读库）；去重 4 处下载（→`zip.downloadBlob`）与 4 处日期 key（→`date.todayKey`）；aiContext 改调 `sortChapters`；删 `chapterNumberLabel`；移除零引用依赖 png-to-ico；删 dist.oldbak* 与空 generated-images。审查后 tsc/build 双 0 错。
- **表单联动专项审计（2026-08-28 晚）**：主链路列名/schema 全对齐、resolveOptions 红线无绕过；修复 seedData 6 处下拉口径/列名断裂（secrets S0006-S0008 整行错列重写、S0004 知情程度、subplots 状态/类别、第5章细纲状态、hookpoints 爽点类型/强度）。~~已登记未实现~~ **两条预警已于当日兑现**（爽点断档/存稿缓冲告急，见 9391987）。示范项目需重建才吃到修复。
- **AI 喂数据审计（2026-08-28 晚）**：修复 buildChapterDigest 跨卷排序（flattenChapters）、AI 深度审计改喂最近 6 章（新 `getRecentChapterTexts`）、**移除校对简略模式**（喂摘要会致 replaceOne 误替换真文本，数据破坏隐患）、诊断简略模式加 textKind 诚实标注、AIOrganize 章节列表改 flattenChapters + 卷页签排除 chapter-master 聚合段。优化：getChapterTexts 正文头带派生章号；buildProjectContext 文末声明 dropped 段落。教训：**凡新增「全局按 order 排」都是跨卷 bug 温床**。
- **规划 2.0**：源码加固（javascript-obfuscator 混淆/可选 asarIntegrity+bytenode）+ 功能讲稿。触发词「开工2.0」。

## 1.9.1 自定义项目架构
- 创建入口「完整项目/自定义项目」二选一；精简/极简仅保留旧项目打开。
- `Project.projectType:'custom'` + `features:string[]`。`schema.ts`：`VisCtx`、`FEATURE_TIER`、`LOCKED_IDS`、`DEFAULT_IDS`、`STRONG_DEPS`、`resolveFeatures`、`tabVisible(tabId,ctx)`（custom 查 features；full 全显）。
- 全局基础设施（备份/检索/设定检索）始终常开，不进勾选列表。示范项目 `createDemoProject` 必须 `projectType:'full'`。

## 架构速查（避坑）
- **按卷建表**：台账层卷表 Tab id `chapter-vol-<volumeId>`（`VOLUME_LEDGER_PREFIX`）；`refreshVolumeTabs()` 合成 TabDef；`db.getAllChapterLedgerRows()` 聚合各卷表（各检查/AI 调用点统一走它）；`purgeLedgerRowEverywhere`；`restoreFromTrash` 写 `chapter-vol-<vid>`；Sidebar `chapter-master` 可展开卷子项。
- **章节顺序**：`chapterSeq.ts` 按期望排序；台账行 `order` 经 `syncChapterMaster(,,narrativeIndex)` 恒等于真实叙事序；「不计入序号」章排除序号但台账章节号保留手填。
- 列助手 `c/cn/cH/cr`（text/number/hidden/crossRef）；`TableColumn.type`：text|select|date|number|textarea|calendar|character|characters|tableRef。
- ⚠️ **下拉选项「单一口径」红线**：列出下拉候选值禁止直接用 `col.options`，必须 `resolveOptions(col.options, await getCustomOptions(tabId, colName))`（`CustomSelect.tsx`）。已落地：表头筛选/AI 整理/行内下拉。改选项后 `CUSTOM_OPTIONS_EVENT` 广播。
- 🎨 图标语义：`Sparkles`=AI 专用；`Stethoscope`=诊室/数据体检；`Wand2`=AI 编辑改写；`Pencil`=手动编辑；`Lightbulb`=灵感素材。
- ⚠️ **`!tabVisible` 判定口诀**：只允许出现在「守卫 return」或「构造隐页签集合」；赋给 `showXxx` 或条件包含的一律是 bug（已三次踩坑）。
- 历法：项目级 `calendars[]` 默认 `[{灵历,0}]`；跨历法顺序 = `calValue*1e10 + storyTimeKey`。
- 关键组件：`CalendarPicker`(Portal z-[9999])、`CharacterSelect`(禁手输,多选)、`CalendarSelect`、`AutoTextarea`、`StoryDateInput`、`HelpPopover`。
- 地理联动（1.8）：foreshadow/timeline 有 `cr('地理位置','geography','名称')`；地图叠加层只精确匹配。
- 颉文姬建议段模式：`【颉文姬建议·开始/结束】` 标记块，续写/审读只给方向；摘要按 ~1/10 压缩。桌面精灵 `JieWenJiSprite.tsx`（App.tsx 仅打开项目后渲染）。
- 数据更新：TableSheet 切页签即重读库；跨表引用按名存字符串，无级联改名（数据体检兜底 `dataHealth.ts:runDataHealthCheck`）。
- 行跳转：`yfe:navigate {tabId,rowId}` 事件；`yfe:volumes-changed` 卷变更广播。
- 📌 **「AI 抽取 + 代码判重」分层铁律**：存在性判断一律确定性代码比对（`normName`/`rowFingerprint.norm` + `readAliases`），AI 只抽候选。参考 `settingLedger.ts`；表格自动编号唯一来源 `autoCode.ts`（`nextAutoCode`）。
- 角色卡三张字段结构不同（`char-main`/`char-secondary` vs `char-npc`），写卡用 `settingLedger.cardFieldPath()` 按优先名探测，勿硬编码。

## AI 接入（1.5.0+）
- **颉文姬 5 模式**：`clinic` 诊室 / `edit` 编辑(选区改稿→建议段) / `review` 审读 / `brief` 简报 / `ledger` 补登(抽实体→比对→三档→勾选写入)。
- 本地 Ollama + 联网 OpenAI 兼容（`src/lib/ai.ts` / `AIAssist.tsx`），统一 `testProvider()` + `chatRaw()`。**硅基流动**：`https://api.siliconflow.cn/v1`，模型 `deepseek-ai/DeepSeek-V3.2`。⚠️ 明文本地记忆，勿提交公开仓库。

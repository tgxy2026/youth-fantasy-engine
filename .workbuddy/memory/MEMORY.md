# novel-studio 长期记忆
> 红线/决策索引；事件留 `YYYY-MM-DD.md`。⚠️ **目标 ≤8500 字符**（压不动就把整节外链主题文档）。
> 主题细则外链：`docs/酒馆模式-工程红线.md`、`docs/2.1.1-审计修复记录.md`、`docs/AI上下文*.md`、`docs/2.2.0-*`、`docs/一键拆书-*`。

## 红线
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`，也禁手工 `git gc`/`reflog expire`**（两次真事故：丢对象 / .git 清空）。恢复靠 **`git bundle`**。已设 `gc.auto=0`，别改回来。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md` 只记录，明说「处理」才动。提交含 `!` 或换行用 `git commit -F`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199。
- 现 **2.2.0**（主题＝**完善 AI 写作**；旧红线「AI 只辅助不生成正文」09-17 删）。版本唯一源 `package.json`。⚠️ `package-lock.json` 根版本常落后 → 只改 `j.version`＋`j.packages['']`。
- 🔴🔴 封装**全程无沙箱跑**。rcedit 间歇失败（退出码仍 0，只认 stderr `Fatal error`）由 `scripts/after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`；`ELECTRON_CACHE`→AppData/Local。
- 🔴🔴 **只做桌面版**（无 WEB/PORTABLE）。`StoreOps` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径。

## 2.2.0 三功能（伴写 / 拆书 / 创意写作）
- ✅ **A 伴写（09-17）**：`aiInlineSuggest()`＋ghost 第三叠层＋「钢笔」弹窗（**默认关**）；文风三层锚定**不做枚举**、去 AI 味钉 system 末尾、长度三档。🔴 **切章必须清 ghost**（Tab 插错章＝数据事故）。
- ✅ **B1 拆书（09-18）**：通用件在 **`lib/flow/`**（域中立；🔴 别去 `bookbreak/` 找）：`pipeline`（状态机/中止/续跑/**skipRest**）／`fieldMap`（**声明式**，真键 `resolveSlot()` 查 schema）／`draft`（判重走 `settingLedger.classify`）／`commit`（默认 `keep-existing`；🔴 写前必 `previewCommit`）。
- ✅ **C 创意写作（09-18）**：`runCreativeWriting`（bible→**闸门①**→outline→**闸门②**→连写）。🔴 **闸门＝await Promise**、**落库只在闸门通过后**（放弃不留半成品）；连写复用 `runAutoContinue`＋`outlineFor`；额度 kind `outline-generate`。
- ✅ **C 的 P1 三项（09-18）**：① 闸门②三按钮「**只保存大纲**」靠 `pipeline.skipRest()`（🔴 **skipped 必计入进度分子**，否则进度条停 26%；别记 done，界面会谎称写了正文）。② 对话引导 `creativeSeed.ts`（复用 `interview.ts`＋`InterviewChat`，8 栏）。③ 体量推荐 `writingPace.ts`（🔴 口径＝**一章一次调用、不撞窗口，受限的是耗时**）。
- ✅ **B2 全字段（09-18）**：字段键**从 `fieldMap` 派生**（闸 `tests/extractFields`）→ 漂移不可能；解析 `parseExtractedEntities`；抽取**必走流式**。🔴 **冲突只在硬事实字段报**（类别/境界/品级/实力/危险/掌权者；「包含=详略」不算）—— 全字段报时 38% 草稿被标、真矛盾反被埋。细则 `docs/一键拆书-B2*.md`。
- 🔴 **去泛称走 D 不走 C（09-18 实测）**：C（二遍复核）精度~60%、误伤核心专名、微调即翻 → 不上自动剔除。✅ D＝`draft.foldNameVariants()`（零调用）：🔴 **只认后缀**（前缀位会把 `青岚宗` 并进 `青岚宗藏经阁`）、**多容器只标核心词**、数字量词不并。
- ✅ **P2（09-18）**：① 正文概要回填《章节细纲》卡（`chapterMaster.backfillOutlineEvent`；🔴 **只填空**、**绝不新建卡**；卡名约定 `lib/outlineCard.ts`）。② 拆书末尾 `worldview` 汇总**全书级设定** → 表单通道（`flow/formMap`＋`commit` 的 form 分支）。🔴 覆盖**全部 form 型页签**（老大：不止点名的三张，108 字段）；🔴 表单**无"同名条目"**，`keep-existing` 也得**填空**（否则静默失效）。未做：关系表 kind、跨块同指、断点续跑。
- 📌 需求/冲突/决策全在 **`docs/2.2.0-双功能需求解读与P0落地.md`**（动拆书/创意写作前先读）。

## 架构红线
- 无 i18n；schema 列名即存储键（改功能后回搜 `schema.ts` 的 `description`）。
- ⚠️ 打包陷阱：①tree-shake——组件只在平台门控分支被引会被摇掉整模块→门控用「需该模块平台并集」，删门控必跑 `vite build`；②`DESKTOP` 探测（`window.electronStore`）→dev 浏览器恒 false（`DataDock` 有兜底）。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑 seed 闸。
- 🔗 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；闸 `feature-deps-check.mjs`。
- 🔴 编辑器双图层：盒模型逐项一致；叠层重建归零 scrollTop→`useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🗺 多地图方案 B：新表 `geomaps`＋geography 的 `所属地图`；`migrateGeoMaps` 建默认图回填；🔴 删图不删地点、改图名连带改归属。

## 存储 / 同步
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录；🔴 图片先压缩再入库；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属→`makeCloudStoreWrapper` 短路到 local。🔴🔴 桌面读数据失败必须锁写盘（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔄 两同步入口别混：①位置＝明文 JSON；②云盘同步＝加密 `.yfe`＋记录级合并＋每日备份。**用 ②**。
- 🔴 09-15 修一批同步缺陷（见 `docs/2.1.1-审计修复记录.md` §四）。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`；SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 会回退黑）。设置项＝标题→输入→说明；复制走 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：①量尺寸一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；②zoom 不缩放 vh→内联长度走 `foldVh()`（`theme.ts`）；③SVG 滚轮锚点/拖拽除 zoom。
- 🔴 **光标/选区同步不能只靠 `onKeyUp`**（输入法上屏 / 粘贴 / 程序化插入都不产生 keyup）→ 有 `onChange` 就在里面同步一次。
- 🔴 判"琥珀开启态"按 class **词元**比（`c.split(/\s+/).includes('text-amber')`）：off 态写着 `hover:text-amber`，`includes` 恒真 → 假 PASS。
- 🔴 按对侧高度定高：flex item `min-height:auto` 顶回定高→加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框用 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；行内小操作 `size="xs"`；`danger` 破坏性。
- 🔴 每页签页头 `HelpPopover` 问号**必须在标题右侧同行**（`h1` 是块级，须同处 flex 行）。头像兜底＝名字；Enter 发送／Shift+Enter 换行必挡 `isComposing`；文案禁 markdown 星号→用「」/（）。

## AI 层
- 🔴 **提示词给几层，模型就按几层输出** —— 汇总表单时字段清单按「页签→模块→字段」给，模型照此嵌套；读取端只按两层取值会把**整表静默丢光**（09-18 实测 5 张表全丢，模型产出其实完全正确）。读模型产出必须兼容**自己给的**层级。
- 🔴 **「保密等级」＝档位＋行级预算排序**：单字段双输出**不并存**。`aiContext.ts` `rankOf`/`sortBySecrecy`→排序后 `slice(0,cap)`；🔴 同级稳定（护 prefix cache）。🔴🔴 **`rankOf` 必须同时认裸键与复合键**（表格＝`保密等级`、卡片＝`模块::保密等级`）——只认裸键让**角色卡排序静默失效**。详见 `docs/AI上下文-*.md`。
- 🔴 **本地预算上限＝32K**（KV cache 32K=8.7GB≈塞满；有效上下文仅标称 30~65%）。详见 `docs/AI上下文预算策略-….md`。
- 🔴 **防剧透＝四道闸（`aiContext`，调用方传参）**：① `viewMode:'character-view'` 排 10 张作者侧页签 ② `AUTHOR_SIDE_FIELDS`（**新字段须登记**）不渲染 ③ `anchorChapterId` 只到锚点 ④ `knowerName` 过滤 secrets 知情条目。**只覆盖剧情推演**；其余 AI 功能拿全量。
- 🔴 **新增资料型页签必须登记 `PRIORITY`**——兜底循环只保证"数据不丢"、不保证"进得了预算"（09-17：`faction-rels` 有数据却带不上；`style` 已前移）。
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）；**生成型入口（Bible / 大纲）走 `parseLooseObject`＋空结果重试**——小模型会在 JSON **结构位**塞杂字符，严格解析全丢后表现为"生成成功但 0 条"。温度：结构化 0.3、创意 0.85；一轮 JSON 走 `aiChatJson`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。
- 🔴 采样惩罚看**射程**不看强度（共用 `penalty_last_n` 窗口）。`repeat_last_n` 512＋`frequency_penalty` 0.1 → 手部率 28.9%→13.4%。🔴🔴 **绝不调高 `repeat_penalty`**（1.4 实测崩）；`presence_penalty` 无效；反重复提示词只钉 system 末尾。
- 🔴 **额度跟模型走**：`adviseCapacity()`→`recommendTuning()`（硬×12.5%、软×8.3%、长期＝硬÷6、日记＝`7×√(预算/24000)`）；`syncTuningWithModel()` 换模型即套用，🔴🔴 靠**模型指纹**（同模型手调值绝不覆盖）；本地**超窗口保护**（预算>`numCtx×0.732`）。🔴🔴 **记忆档跟「预算」走**；`TUNING_LIMITS` 与 `paramGuide` 同源（锁）。
- 🔴🔴 **思考模型必须关思考**：本地传 `think:false`；**云端 Qwen3 系由 `openaiChat` 自动下发 `enable_thinking:false`**（`HYBRID_THINKING_RE`；400 退掉重试）。实测：开 50~130s、content 271 字必残；关 35s ✅。
- 🔴 **长文生成必走流式**（`aiTasks.longStream`）：非流式要等整段生成完才回首字节 → 必撞 180s 墙。🔴 自驱 `runAutoContinue` 必传 **`onBodyToken`**（＝流式开关）；先 `ai.chat` 预热；别 `await page.evaluate(整流程)`（改点火＋轮询 `window.__gen`）。⚠️ 生成入口无 `max_tokens`。
- 🔴 **AI「会读哪些数据」＝ `lib/aiDataSources.ts` 单一源**＋`AIDataSourceNote` 进各功能气泡；改 prompt 来源**必须同步改它**（闸 `tests/aiDataSources.test.ts`）。🔴🔴 **禁写「全程本地模型／不外发」**——这些功能都能选云端模型，那是**误导性声明**；口径只能是「发给**当前选定的**那个模型：本地不出本机，云端会上传到该服务商」。
- 🔴 本地实弹探针：改口径走 `LR_ANALYZE=<json>` 离线重算（别重跑 GPU）；CUDA 固定 seed **不保证逐位复现**（±4pp）。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`），站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务→删库≠下线；Nginx SPA 回退：不存在路径也返 200→不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；ESLint 09-18 起 **0 warning**。⚠️ exhaustive-deps **别盲改**：真漏补依赖／函数身份改 `useCallback`／派生值误报内联。🔴 实机走 `novel-studio-ui-livecheck`（**先读其"五条必踩的坑"**）；实弹断言会过时；子代理结论必回源码验。

## 酒馆模式
- 🔴🔴 **动酒馆任何功能前必读 `docs/酒馆模式-工程红线.md`（18 节）**；此处只留「跨节最易错」几条。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景**随项目**；自由会话+角色卡+记忆日常+面板设置+剧本库**跨项目**（索引与分条成对，tavernReports 别漏 deleteProject）。
- 🔴🔴 预算三数（**出厂默认**；面板可按模型覆盖，见「AI 层」）：`historyBudget`＝预算−400−整条 system（别传记忆）；contextBudget **24000**；numCtx **32768** 别动（本地由显存决定，云端的 `num_ctx` 无效）。
- 🔴 酒馆最易踩：①会话存**快照非引用**（`snapshotStorySetting`）；②角色卡小项**只能「小项名：内容」同一行＋全角冒号**（半角/独占行 → 整栏掉进「其他」框）。
- 🔴 协议 **v1.11**（旧版冻进 `LEGACY_PROTOCOLS`；改协议同步三处＋两断言）。

## 出厂数据 / 示范项目
- 🧪 dev 测试数据放仓库外 `…\04-开发测试数据\`，走 `story.ts`/`store.ts`；🔴 绝不写进 `seedData.ts`。📥 卡走 skill `tavern-cards-batch` 导入。
- 🚫 原生不再预填自由示范卡（已删 `seedCard*` 与 33 处卡名）；闸 `tests/tavernSeedPolicy.test.ts`；🔴 老库卡只保留不删。
- 示范项目《吞天神脉》三卷 21 章（1-10 风起云州 / 11-20 剑鸣中州 / 21 起 **剑锁中州**）。改/加正文同步 `seedContent.ts`→`seedData.ts`。
- 🔴 三道闸：seed-schema-check＋`tests/seedRef.test.ts`＋细纲卡核对；推演 cast 引用卡 id→相关卡留 `card()` 返回值。🔴 闸 `tests/importCycles`：**循环依赖只在浏览器 TDZ 崩**。

## 环境（Windows + Git Bash）
- git/npm 用**绝对路径**（git＝`…/PortableGit/versions/1.2.0/cmd/git.exe`；托管 node）——PATH 每次不持久；⚠️ `sort`/`find`/`timeout` 会解析到 Windows 同名 exe→改用 node 脚本。
- 🔴🔴 **同一条消息里对同一文件发多个 Edit 会相互覆盖**（09-18 又踩：两处只落一处，靠 tsc 报"未使用"才发现）。**串行改、改完立即 grep**；`node -e` 引号会被吞→Write 落纯 JS；**跨行锚点先探 EOL**（CRLF/LF 并存；改 CRLF 必须写 `\r\n`）。
- 🔴 改 `protocol.ts` 正文别用 Edit（历史协议 10 份锚点不唯一）→ 临时脚本＋旧版进 `LEGACY_PROTOCOLS`，落盘即删。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**（返空→误判"不存在"→`Write` 覆盖；09-17 日志 215 行被覆成 37 行）。判存在用 `Read`／`test -f`；`memory/*.md` 只准 append，覆盖事故**先查 git**。
- 🔴 dev 仅 `localhost:5199`（127.0.0.1 会 302→两份 IndexedDB）；桌面走文件存储、两套。
- ⚠️ 验「随项目」用 `db.setCurrentProject`（别直查物理表）；**实弹读真实 apiKey 先告知不提交**；改提示词/示范卡文案后同步改 `tests/` 旧断言。
- 🧪 dev 测试数据：仓库内 `dev-seed/`，`import('/dev-seed/fengyang.js?'+Date.now())`（🔴 必带时间戳）；数据在 IndexedDB，重启无效。

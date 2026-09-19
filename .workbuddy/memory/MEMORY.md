# novel-studio 长期记忆
> 红线/决策索引；事件留 `YYYY-MM-DD.md`。⚠️ **限 8000 字符**，压不动就外链。
> 外链：`docs/酒馆模式-工程红线.md`、`docs/2.1.1-*`、`docs/AI上下文*`、`docs/2.3.0-*`。

## 红线
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`，禁手工 `git gc`/`reflog expire`**（两次事故）。恢复靠 `git bundle`；已设 `gc.auto=0` 别改回。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert`→PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md` 只记录，明说「处理」才动。提交含 `!` 或换行用 `git commit -F`。main 无远程。

## 身份·版本·封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199（须 `localhost`，127.0.0.1→302 两份 IndexedDB）；🔴 **只做桌面版**（无 WEB/PORTABLE），版本展示走 `env.ts` 的 `APP_VERSION_LABEL`。
- 现 **2.3.0**（结构优化·不加功能；重写评估→**不重写·走定向重构**，`docs/2.3.0-*`）。版本唯一源 `package.json`；⚠️ lock 只改 `j.version`＋`j.packages['']`。
- 🔴🔴 封装**全程无沙箱跑**；rcedit 间歇失败（退出码仍 0，只认 stderr）由 `after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`。
- 🔴 启动**默认停项目管理首页**；`lastProject` 只服务「首次使用播示范项目」，删项目时一并清掉（否则陈旧镜像会把已删项目拼回来）。

## 2.2.x 创作链路（伴写/拆书/创意写作/整章改写）
- ✅ **A 伴写**：`aiInlineSuggest()`＋ghost 第三叠层＋「钢笔」弹窗（默认关）；文风三层锚定**不做枚举**、去 AI 味钉 system 末尾。🔴 **切章必须清 ghost**（Tab 插错章＝数据事故）。
- ✅ **B 拆书**：通用件在 **`lib/flow/`**（非 `bookbreak/`）；六阶段见 `docs/2.2.1-*`（🔴 末阶段「整理关系」创意写作不加）。🔴 写前必 `previewCommit`；字段键从 `fieldMap` 派生（闸 `tests/extractFields`）、抽取走流式；**冲突只在硬事实字段报**；去泛称走 D。
- ✅ **C 创意写作**：起点 `scratch`／`continue`，**产出目标也在起点选**（只做大纲／大纲＋正文；🔴 闸门只管确认·放弃、**落库只在通过后**）。**「只做大纲规划」＝续排细纲**（🔴 起点＝**正文写到哪+1**）。
- ✅ **整章改写**：🔴 结果只在内存、写前**显式快照**、只动 content/wordCount/updatedAt；🔴🔴 **纪律＝「动作 × 章位置」矩阵**（详规 `docs/2.2.1-续排细纲*`）：历史章冻结**不只管改写**（扩写只加描写层；精简留设定句；润色只换字）；最新章**仅改写档**可放开＋落库后必跑设定同步；🔴 异常判据＝**期望字数**。
- ✅ **C 细节**：🔴 `skipRest()` skipped **必计入进度分子**；概要回填细纲卡**只填空不新建**；`worldview` 汇总→表单（🔴 覆盖全部 form 页签）；**续跑断点在阶段内**。

## 架构红线
- 无 i18n；schema 列名即存储键（改功能后回搜 `schema.ts` 的 `description`）。
- ⚠️ 打包陷阱：①tree-shake：组件只在门控分支被引→整模块被摇→门控用「需该模块平台并集」，删门控必跑 `vite build`；②`DESKTOP` 探测→dev 浏览器恒 false（`DataDock` 兜底）。
- 左下角只准一个浮层 `DataDock`；禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑闸。
- 📁 结构优化（09-19）：D3 纯数据→**`src/data/`**（`seedData.ts` 工厂码留 `lib`）；D2 `db.ts`→门面＋`db/` 10 域；D1 `aiTasks.ts`→门面＋`aiTasks/` 11 域。🔴 门面**显式再导出**（勿 `export *`）；提示词随域走、门面 `PROMPT_ORDER` 还原注册序；`ops`/`currentProjectId` 须 `export let` 供兄弟读。
- 🔗 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；闸 `feature-deps-check.mjs`（两闸在 `tests/` 非 `scripts/`）。
- 🔴 **无「名称」列的表格草稿必须声明 `dedupKeys`**（关系表＝人物A/人物B）：`commit` 按名称列判重→**恒判"不存在"**→ 点两次＝重复关系。
- 🔴 编辑器双图层：盒模型逐项一致；叠层重建归零 scrollTop→`useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🗺 多地图方案 B：新表 `geomaps`＋geography 的 `所属地图`；`migrateGeoMaps` 建默认图回填；🔴 删图不删地点、改图名连带改归属。
- 🔴 审计三条（详规在 skill）：①语料净化：再导出/`tests/.x.mjs`/`.workbuddy`/注释不算"引用"（否则掩盖死导出）；②**门面靠白名单认、不靠启发式**（「>40 行跳过」会漏报带编排逻辑的门面）；③graph 环**标边类型**（有 `import type`⇒运行时不成立）。
- 🔴 **长任务状态必须放模块级 store**（`lib/creativeSession.ts`，单例＋`useSyncExternalStore`）：切页签即卸载，`useState` 全丢；🔴 **任务跑在 store 里**；lib 层**禁 import components**；**断点只存里程**。
- 🔴 拆书／创意写作**档位＝optional**（不默认勾选）；两页顶部有 `NewProjectAdvice`（"先建空项目"＋选「完整项目」）。

## 存储·同步
- 🔴🔴 **云盘同步「删了会复活」**：`baseCache` 仅内存→ 合并把"云端有·本地无"判成"另一端新增"→ 删掉的记录回来并自锁。修＝墓碑（`syncTombstone.ts`）＋⚠️`localHasContent`闸（整库空即禁，否则丢云端）＋`ensureInit` 经 `onLocalSnapshot` 拿本地库当 local。
- 桌面整库一 JSON；🔴 图片先压缩再入库；⚠️ 别让云盘同步它；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属→`makeCloudStoreWrapper` 短路到 local。🔴🔴 桌面读数据失败必须锁写盘（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔄 同步只走云盘（加密 `.yfe`＋记录级合并＋每日备份）。
- 🔴🔴 **服务器已关（2026-09）**：站点/API 全下线；`server/` 保留不上线（⚠️ 别用 200 判在线）→ 跨设备同步**只剩云盘文件夹**（**无同步码/邀请码/HTTP**）。`createIdleTransport`＝未开启占位（一律报「不可用」，🔴 **绝不返回空库**，否则 push 覆盖云端）。

## UI·布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`；SVG 用 CSS 变量须走 `style`（`fill=rgb(var(--x))` 回退黑）。设置项＝标题→输入→说明；复制走 `copyText()`。
- 🔴🔴 `<html>` 界面缩放：①量尺寸一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；②zoom 不缩放 vh→内联长度走 `foldVh()`；③SVG 滚轮锚点/拖拽除 zoom。
- 🔴 光标/选区同步不能只靠 `onKeyUp`（上屏/粘贴/程序化插入无 keyup）→ 有 `onChange` 就在里面同步。
- 🔴 判"琥珀开启态"按 class **词元**比（off 态 `hover:text-amber`→`includes` 恒真＝假 PASS）。
- 🔴 按对侧高度定高：flex item 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框用 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；`danger` 破坏性。🔴 **尺寸三层＝弹窗 md／主操作 sm／工具 xs；同排同 size、禁手写尺寸**。
- 🔴 页头 `HelpPopover` 问号**必须在标题右侧同行**。头像兜底＝名字；Enter 发送／Shift+Enter 换行必挡 `isComposing`；文案禁 markdown 星号→用「」/（）。
- 🔴 **数值输入统一走 `NumberField`**：可自由输入（能清空、能打超范围值）＋超范围在**失焦/回车**钳到最近边界（toast）。

## AI 层
- 🔴 **提示词给几层，模型就按几层输出**——读端必须兼容**自己给的**层级，否则整表静默丢光。
- 🔴 「保密等级」＝档位＋行级预算排序（同级保序护 prefix cache）；🔴🔴 **`rankOf` 必须同时认裸键与复合键**（表格＝`保密等级`、卡片＝`模块::字段`）。
- 🔴 提示词可编辑：默认值**就地声明**禁集中搬；变量须模块级 `let`＋**setter 同模块**（跨模块＝TS2632）；🔴🔴 **注册顺序＝设置页顺序**（`listPrompts` 按 group 稳排；顺序表在门面 `PROMPT_ORDER`，漏登记 warn）。
- 🔴 本地预算上限＝32K。🔴 **防剧透四道闸**（只管剧情推演）：①`viewMode:'character-view'` ②`AUTHOR_SIDE_FIELDS`（新字段须登记）③`anchorChapterId` ④`knowerName`。
- 🔴 新增资料型页签必须登记 `PRIORITY`——兜底只保证不丢、未必进预算。
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）；**生成型入口走 `parseLooseObject`＋空结果重试**（小模型在 JSON 结构位塞杂字符→"成功但 0 条"）。温度：结构化 0.3、创意 0.85；一轮 JSON 走 `aiChatJson`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）。作者原文进 prompt 走 `promptGuard.authorBlock()`；绝不清洗正文。
- 🔴 采样惩罚看**射程**不看强度：`repeat_last_n` 512＋`frequency_penalty` 0.1→手部率 28.9%→13.4%。🔴🔴 **绝不调高 `repeat_penalty`**（1.4 实测崩）；反重复提示词只钉 system 末尾。
- 🔴🔴**额度跟模型走**：`adviseCapacity()`→`recommendTuning()`；`syncTuningWithModel()` 靠**模型指纹**（同模型手调值绝不覆盖）；本地超窗口保护（预算>`numCtx×0.732`）。
- 🔴🔴 **思考模型必须关思考**：本地 `think:false`；云端 Qwen3 系由 `openaiChat` 自动下发 `enable_thinking:false`（`HYBRID_THINKING_RE`）。开＝50~130s 且 content 必残。
- 🔴 **长文生成必走流式**（`aiTasks/stream.ts`）：非流式必撞 180s 墙。自驱 `runAutoContinue` 必传 **`onBodyToken`**；别 `await page.evaluate(整流程)`。⚠️ 生成入口无 `max_tokens`。
- 🔴 **AI「会读哪些数据」＝`lib/aiDataSources.ts` 单一源**（闸 `tests/aiDataSources`），改 prompt 来源须同步改它。🔴🔴 **禁写「全程本地模型／不外发」**——口径只能是「发给**当前选定的**模型：本地不出本机，云端上传到该服务商」。
- 🔴🔴 **保密等级 D＝终结：任何情况都不进 AI**：硬保证在 `aiContext.isPrunedForAI`（内容／姓名／判重三处；认裸键与复合键），`rankOf` 给 D 大数兜底；**作者侧也排除**。🔴 该列**封闭枚举**（`cFixed()`）：禁增/改/删，否则预算排序与可见性失效。
- 📌 关系整理材料上限**面板可调**；"真进材料"由 `tests/bookbreakRelations` ⑩ 锁。
- 🔴🔴 **AI「整理」类产出必须两道本地兜底**：① 候选值＝库里已有 ∪ 本次刚抽出未落库的实体名；② 产出后按名单**本地过滤**＋要求给**原文依据**并本地核对（`evidenceInMaterial`）。

## 服务器·工程质量
- 三步基线：`tsc --noEmit`／`eslint src`（**0 problem**）／`node tests/run-all.mjs`（别用 `npm run verify`，沙箱会拦）。⚠️ exhaustive-deps 别盲改。
- 🔴 实机走 skill `novel-studio-ui-livecheck`；**子代理结论必回源码验**。
- ✅ **巨型组件拆分**（`docs/2.2.1-*`·`2.3.0-D4-*`）：手法＝**量化依赖→ 状态搬进 `useXxxModel` → 子组件只收 `model` → 实机指纹＋负面对照**；清导入用 `prune-unused.mjs`。🔴 hook 含 JSX 须 `.tsx`；共享件落第三个文件。🔴 拆分把**本地 `useRef` 变 hook 入参**→`exhaustive-deps` 开始报缺依赖（规则靠 `useRef()` 初始化认稳定量）：稳定量（ref/setter）如实补进依赖、只读 ref 的函数改 `useCallback`，**禁 disable 压**。

## 酒馆模式
- 🔴🔴 动酒馆前必读 `docs/酒馆模式-工程红线.md`（18 节）。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景**随项目**；自由会话+角色卡+记忆日常+面板设置+剧本库**跨项目**（索引/分条成对，tavernReports 勿漏 deleteProject）。
- 🔴🔴 预算三数：`historyBudget`＝预算−400−整条 system；contextBudget **24000**；numCtx **32768** 别动。
- 🔴 最易踩：①会话存**快照非引用**（`snapshotStorySetting`）；②角色卡小项只能「小项名：内容」同一行＋**全角冒号**（半角→整栏掉「其他」框）。
- 🔴 协议 **v1.11**（旧版冻进 `LEGACY_PROTOCOLS`；改协议同步三处）。

## 出厂数据·示范项目
- 🧪 dev 数据放仓库外 `…\04-开发测试数据\` 或 `dev-seed/`（🔴 import 必带 `?时间戳`）。
- 📥 卡走 skill `tavern-cards-batch` 导入。🚫 原生不预填自由示范卡（闸 `tavernSeedPolicy`；🔴 老库卡只留不删）。
- 示范项目《吞天神脉》三卷 21 章（第三卷名 **剑锁中州**）。改/加正文同步 `seedContent.ts`→`seedData.ts`。
- 🔴 三道闸：seed-schema-check＋`tests/seedRef`（人物列须真角色）＋细纲卡核对；推演 cast 引用卡 id→相关卡留 `card()` 返回值。闸 `importCycles`：**循环只在浏览器 TDZ 崩**。
- ⚠️ 验「随项目」用 `db.setCurrentProject`；**读真实 apiKey 先告知不提交**；改提示词/示例卡文案须同步 `tests/` 断言。

## 环境（Win + Git Bash）
- git/npm/node 用**绝对路径**且每次现探；⚠️ `sort`/`find`/`timeout` 解析到 Windows 同名 exe→改用 node 脚本。
- 🔴🔴 **同一条消息里对同一文件发多个 Edit 会相互覆盖**→串行改、改完即 grep；**跨行锚点先探 EOL**（CRLF 与 LF 并存）；`node -e`/JSON 补丁转义易崩→批量改走**分隔符式纯文本补丁**（`@@@FILE/OLD/NEW`＋解析器）。
- 🔴 改 `protocol.ts` 正文别用 Edit（锚点不唯一）→ 脚本＋旧版进 `LEGACY_PROTOCOLS`。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**（返空→误判→覆盖）。判存在用 `Read`／`test -f`；`memory/*.md` 只准 append，覆盖事故**先查 git**。

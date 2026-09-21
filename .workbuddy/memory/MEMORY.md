# novel-studio 长期记忆
> 红线索引：只记「该做什么 / 禁什么」，**为什么与踩坑经过见 `docs/2.x.x-*` 与 skill**；事件留 `YYYY-MM-DD.md`。⚠️ 限 8000 字符。

## 红线
- 🔴 产品立场：AI 只做辅助。**绝不做反检测/洗 AI 痕迹**；只做「创作主权存证＋质量自检＋如实申报」。
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`、手工 `git gc`/`reflog expire`**（两次事故）。恢复靠 `git bundle`；`gc.auto=0` 别改回。
- 禁删 `release/eb-cache/`；禁原生 `prompt/confirm/alert`→PromptModal/confirmDialog/toast。
- 清单 `docs/2.3.1-Bug与待优化清单.md` 只记录，明说「处理」才动（旧清单已归档）。提交含 `!`/换行用 `git commit -F`。main 无远程。

## 身份·版本·封装
- Electron+React+TS+Vite+Tailwind；存储经 StoreOps；dev 5199 须 `localhost`（127.0.0.1→302＝两份库）；🔴 只做桌面版，版本走 `env.ts:APP_VERSION_LABEL`。
- 现 **2.3.1**（已封装上 Gitee Release；`package.json` 唯一源，lock 只改 `j.version`＋`j.packages['']`）。
- 🔴🔴 封装**全程无沙箱跑**；rcedit 间歇失败（退出码仍 0，只认 stderr）由 `after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`。
- 🔴 启动**默认停项目管理首页**（2.4 A1 起，首启先过「向导三选一」）；删项目时一并清掉 `lastProject`。

## 创作链路（2.2.x）
- 🔴 **切章必清 ghost**；创意写作起点不手选（看有无卷大纲/细纲）；🔴 续排起点＝**已有细纲最大章号+1**；每卷章数＝硬指标、缺口优先补齐；写前必 `previewCommit`、字段键取自 `fieldMap`（闸 `tests/extractFields`）。
- 🔴 整章改写五档（**续写**＝代码留原文、模型只吐增量）：结果只在内存、写前显式快照、只动 content/wordCount/updatedAt；过 `enforceWordRange`（±300 **汉字**）；🔴🔴 历史章冻结、最新章仅改写档可放开＋落库后跑设定同步。
- ✅ 伴写＝ghost 叠层＋「钢笔」弹窗（默认关；🔴 **Ctrl+Enter 采纳、Alt+/ 换一句** —— Tab 已无条件归缩进）；去 AI 味钉 system 末尾；通用件 `lib/flow/`。

## 架构红线
- 无 i18n；schema 列名即存储键（改功能后回搜 `schema.ts` 的 `description`）。
- ⚠️ 打包陷阱：①tree-shake：组件仅在门控分支被引→整模块被摇→门控用「需该模块平台并集」，删门控必跑 `vite build`；②`DESKTOP` 探测→dev 浏览器恒 false。
- 左下角只准一个浮层 `DataDock`；禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑闸。
- 📁 结构优化：纯数据→`src/data/`；`db.ts`/`aiTasks.ts`→门面＋域目录。🔴 门面显式再导出（勿 `export *`）；`PROMPT_ORDER` 还原注册序；`ops`/`currentProjectId` 须 `export let`。
- 🔴 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；闸 `feature-deps-check.mjs`；拆书／创意写作＝**optional**（两页顶部有 `NewProjectAdvice`）。
- 🔴 **无「名称」列的表格草稿必须声明 `dedupKeys`**（关系表＝人物A/人物B），否则点两次＝重复关系。
- 🔴 编辑器双图层：盒模型逐项一致；叠层重建归零 scrollTop→`useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🗺 多地图方案 B：新表 `geomaps`＋geography 的 `所属地图`；`migrateGeoMaps` 建默认图回填；🔴 删图不删地点、改图名连带改归属。
- 🔴 审计四条（详规在 skill `novel-studio-audit-fix`）：语料净化／`KEEP` 白名单认保留项／死代码须回查 `docs/` 判决／工具的结构假设会静默失明（A4 实测：禁绝对承诺只查 `description`，`tips` 漏）。
- 🔴 长任务状态必须放模块级 store（`lib/creativeSession.ts`）：切页签即卸载，`useState` 全丢；lib 层禁 import components；断点只存里程。

## 存储·同步
- 🔴🔴 云盘同步「删了会复活」：`baseCache` 仅内存→把「云端有·本地无」判成「另一端新增」。修＝墓碑 `syncTombstone.ts`＋`localHasContent` 闸。
- 桌面整库一 JSON；🔴 图片先压缩再入库；⚠️ 别让云盘同步它；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属→`makeCloudStoreWrapper` 短路到 local。🔴🔴 桌面读数据失败必须锁写盘（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔴🔴 服务器已**彻底清理**（09-21）→ 跨设备同步只剩云盘文件夹。`createIdleTransport`＝未开启占位（🔴 绝不返回空库，防 push 覆盖云端）。

## UI·布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`；SVG 用 CSS 变量须走 `style`。设置项＝标题→输入→说明。
- 🔴🔴 `<html>` 界面缩放：①量尺寸用 `offsetHeight`/`clientWidth`，禁 `getBoundingClientRect()`；②**vh/vw 都不随 zoom 缩**→内联长度一律走 `foldVh()`；③SVG 滚轮/拖拽除 zoom。
- 🔴 分辨率自适应：固定 px 断点只看逻辑像素宽 → 用 `foldVh(min(上限, N vw))`。
- 🔴 光标/选区同步不能只靠 `onKeyUp`（上屏/粘贴/程序化插入无 keyup）→ 有 `onChange` 就在里面同步。
- 🔴 判「琥珀开启态」按 class **词元**比（`includes` 会把 off 态 `hover:text-amber` 判成真）。
- 🔴 按对侧高度定高：flex item 加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框 `secondary`（非 `ghost`）；分段 `toggle`+`selected`。🔴 **尺寸＝弹窗 md／主操作 sm／工具 xs；同排同 size、禁手写**。
- 🔴 页头 `HelpPopover` 问号**须与标题同行**。头像兜底＝名字；Enter 发送／Shift+Enter 换行必挡 `isComposing`；文案禁 markdown 星号→用「」。
- 🔴 数值输入走 `NumberField`：可自由输入（能清空、能超范围）＋超范围在**失焦/回车**钳到最近边界（toast）。
- 🔴 界面偏好走 `lib/uiPrefs.ts`（`yfe-ui:` 命名空间，不进项目数据）：**存「偏离默认的那一侧」**（反存会让新分组被判成收起）；空集合＝合法；枚举偏好用 `usePersistedEnum`。
- 🔴 **提示词禁写 markdown 星号**（模型会模仿）。校对已拆 `aiProofreadText` / `aiProofreadLogic`（文字层/逻辑层），都在 `PROMPT_ORDER`。
- 🔴 新增页签**四处**必同步：`TabType`／`TABS`／`App.renderContent`／`FEATURE_TIER`；**资料型**（form/card/table）另须 `aiContext.PRIORITY`（否则进不了预算）；`SETTING_SUBTABS` 只管可检索表，侧栏/勾选弹窗/指南/dataHealth 由 `TABS` 派生。

## AI 层
- 🔴 **提示词给几层模型就按几层输出**——读端必须兼容**自己给的**层级，否则整表静默丢光。
- 🔴 「保密等级」＝档位＋行级预算排序；🔴🔴 **`rankOf` 须同认裸键与复合键**（表格＝`保密等级`、卡片＝`模块::字段`）。
- 🔴 提示词可编辑：默认值就地声明；变量须模块级 `let`＋setter；🔴🔴 **注册顺序＝设置页顺序**（`PROMPT_ORDER` 漏登记 warn）。
- 🔴 本地预算上限 32K。🔴 **防剧透四道闸**（只管推演）：`viewMode:'character-view'`／`AUTHOR_SIDE_FIELDS`／`anchorChapterId`／`knowerName`。资料型页签须登记 `PRIORITY`。
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）；**生成型走 `parseLooseObject`＋空结果重试**。温度：结构化 0.3、创意 0.85；一轮 JSON 走 `aiChatJson`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 不可换序）。作者原文进 prompt 走 `promptGuard.authorBlock()`；绝不清洗正文。
- 🔴 采样惩罚看**射程**不看强度：`repeat_last_n` 512＋`frequency_penalty` 0.1。🔴🔴 绝不调高 `repeat_penalty`（1.4 实测崩）；反重复提示词只钉 system 末尾。
- 🔴🔴 额度跟模型走：`adviseCapacity()`→`recommendTuning()`；`syncTuningWithModel()` 靠**模型指纹**；本地超窗口保护（预算 > `numCtx×0.732`）。
- 🔴🔴 思考模型必须关思考：本地 `think:false`；云端 Qwen3 系由 `openaiChat` 下发 `enable_thinking:false`。开＝50~130s 且 content 必残。
- 🔴 长文生成必走流式（`aiTasks/stream.ts`）：非流式必撞 180s 墙；`runAutoContinue` 必传 `onBodyToken`；失败原因必经 `onLog` 转界面。
- 🔴 AI「会读哪些数据」＝`lib/aiDataSources.ts` 单一源（闸 `tests/aiDataSources`）。🔴🔴 禁写「全程本地/不外发」——口径＝「发给**当前选定的**模型」。
- 🔴🔴 保密等级 D＝终结：任何情况都不进 AI（`aiContext.isPrunedForAI`）。🔴 该列**封闭枚举**（`cFixed()`）：禁增/改/删。
- 🔴🔴 **AI「整理」产出须两道本地兜底**：①候选值＝库里已有 ∪ 本次刚抽未落库实体名；②产出后按名单**本地过滤**＋给**原文依据**。📌 关系整理材料上限**面板可调**（闸 `tests/bookbreakRelations` ⑩）。

## 工程质量·实机
- 三步基线：`tsc --noEmit`／`eslint src`（**0 problem**）／`node tests/run-all.mjs`（别用 `npm run verify`，沙箱会拦）。
- 🔴 闸 `tests/structureGates`（行数/归属/禁裸 `JSON.parse`/原生弹窗/**any 账本只准降**）；类型等价性**可证**＝剥类型再 diff。
- 🔴 实机走 skill `novel-studio-ui-livecheck`；**子代理结论必回源码验**；断言「落库」须直读 IDB；脚本**还原须幂等**。
- 🔴🔴 实机三坑：①编辑器正文须 `textarea.novel-textarea`；②编辑器里 Esc＝伴写抑制（关 Modal 优先点遮罩）；③诊断 AI 先看 `/chat/completions` 请求数。
- ✅ 巨型组件拆分：状态搬进 `useXxxModel`、子组件只收 `model`→实机指纹＋负面对照。hook 含 JSX 须 `.tsx`；只读 ref 改 `useCallback`（禁 disable）。
- 🔴🔴 实机**播完种禁 reload**；指纹只哈希目标容器＋先折 `HH:MM(:SS)`→`T`、数字→`#`；造数据后**必须排序**；负面对照注入点须**无人复位**。

## 酒馆模式（动前必读 `docs/酒馆模式-工程红线.md`）
- 🔴 归属：剧情会话/扮演设定/报告/背景**随项目**；自由会话/角色卡/记忆/面板设置/剧本库**跨项目**（索引+分条成对，`tavernReports` 勿漏 `deleteProject`）。
- 🔴🔴 预算三数：`historyBudget`＝预算−400−整条 system；contextBudget **24000**；numCtx **32768** 别动。
- 🔴 最易踩：①会话存**快照非引用**（`snapshotStorySetting`）；②角色卡小项只能「名：内容」同行＋**全角冒号**。协议 **v1.11**。

## 出厂数据·示范项目
- 🧪 dev 数据放仓库外 `…04-开发测试数据\` 或 `dev-seed/`（🔴 import 必带 `?时间戳`）。📥 卡走 skill `tavern-cards-batch`。🚫 原生不预填自由示范卡（闸 `tavernSeedPolicy`；老库卡只留不删）。
- 示范项目《吞天神脉》三卷 21 章（卷三 **剑锁中州**）；改正文同步 `seedContent.ts`→`seedData.ts`。
- 🔴 闸：seed-schema-check＋`tests/seedRef`（人物列须真角色）＋细纲卡核对；`importCycles` 循环只在浏览器 TDZ 崩；验「随项目」用 `db.setCurrentProject`。

## 环境（Win + Git Bash）
- git/npm/node 用**绝对路径**且每次现探（`…/PortableGit/versions/1.2.0/cmd/git.exe`）；⚠️ `sort`/`find`/`timeout` 解析到 Windows 同名 exe→改 node 脚本。
- 🔴 **G 盘元数据极慢**：删 49ms／建 25ms 每文件（C 盘 1ms，差 37 倍）→ 大批小文件**单进程挂后台慢跑**，🔴 **禁并行**（4 并发实测 0/秒）；判「删除慢」先做**跨盘对照**，别怪杀软。
- 🔴 `git ls-files` 中文路径**加引号转义**→须 `-c core.quotepath=false ls-files -z` 按 `\0` 切。
- 🔴🔴 同消息对同一文件发多个 Edit 会相互覆盖→串行改、改完即 grep；跨行锚点先探 EOL。🔴 共享中介必须串行。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**（返空→误判→覆盖）。判存在用 `Read`／`test -f`；`memory/*.md` 只准 append。

## 2.4 开发（**已开工**；规划 `docs/2.4.0-版本规划.md`，记录 `docs/2.4.0-开发记录.md`）
- 三目标：**转化**（首启 5 分钟出第一段）／**长篇**（性能＋快照）／**可信**（轨迹存证＋自检＋占比申报）。
- **分批**：2.4.0（A1-A5）→2.4.1（B1-B3·B5）→2.4.2（C）；新页签「创作轨迹」归「创作管理」；C4 首批**晋江+起点**。
- ✅ **已完成 09-21**：**A1** 首启「向导三选一」（`meta.welcomeDone`）；**A3** 快照裁剪**优先丢最旧 auto**、AI 快照进备份而**自动备份不带**、时光机加来源＋行级对比（`textDiff`）；**A4** 创作轨迹页签（`trajectory` type＋四处注册＋`default`）＋证据包（HTML `pre` 块保缩进／JSON 全量／桌面 `printToPDF`）；**A5** 🔴 **Tab/Shift+Tab 恒为缩进**、程序化插入**必走 `execCommand`**（禁改 value）、一键排版默认**保留缩进**、导出禁行首 `trim()`。
- 🔴 中文 PDF 禁 jsPDF（字体无中文）→HTML+打印样式为真源，桌面 `printToPDF`、其余 `window.print()`。

## 对外推广（09-21 起）
- 🔴 小黑盒稿文末**禁裸链**（禁 `https://`／`pan.quark.cn` 连写／「提取码」→改「口令」）；链接压最末、**后须有缓冲文字**、两入口合并成一块（规范见 `docs/小黑盒推广帖/`）。
- 🔴 **发帖顺序**：稿里承诺的版本号须**先在夸克盘＋Gitee Release 上架**再发帖。第 0 篇已发布；第 1 篇待发布（对外 **2.3.1**，夸克盘待传）。入口：Gitee `tgxy2026/youth-fantasy-engine`；夸克 `pan.quark.cn/s/8ae0eb718cf5` 口令 `QfAm`。

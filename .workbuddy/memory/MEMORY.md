# novel-studio 长期记忆
> 只记「该做什么／禁什么」；**为什么与踩坑经过一律指向 `docs/2.x.x-*` 与 skill**（那边不限字数）。事件留 `YYYY-MM-DD.md`。⚠️ 限 8000 字符。

## 红线
- 🔴 产品立场：AI 只做辅助。**绝不做反检测/洗 AI 痕迹**；只做「创作主权存证＋质量自检＋如实申报」。
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`、手工 `git gc`/`reflog expire`**（两次事故）。恢复靠 `git bundle`；`gc.auto=0` 别改回。
- 禁删 `release/eb-cache/`；禁原生 `prompt/confirm/alert`。清单 `docs/2.3.1-Bug与待优化清单.md` 只记录、明说「处理」才动。提交含 `!`/换行用 `git commit -F`。main 无远程。

## 身份·版本·封装
- Electron+React+TS+Vite+Tailwind；存储经 StoreOps；dev 5199 须 `localhost`（127.0.0.1→302＝两份库）；🔴 只做桌面版，版本走 `env.ts:APP_VERSION_LABEL`。现 **2.3.1**（`package.json` 唯一源）。
- 🔴🔴 封装**全程无沙箱跑**；rcedit 间歇失败（退出码仍 0，只认 stderr）由 `after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`。
- 🔴 启动**默认停项目管理首页**（首启先过「向导三选一」）；删项目时一并清 `lastProject`。

## 创作链路
- 🔴 **切章必清 ghost**；创意写作起点不手选；🔴 续排起点＝**已有细纲最大章号+1**；每卷章数＝硬指标、缺口优先补齐；写前必 `previewCommit`、字段键取自 `fieldMap`。
- 🔴 整章改写五档（**续写**＝代码留原文、模型只吐增量）：写前显式快照、只动 content/wordCount/updatedAt、过 `enforceWordRange`（±300 汉字）；🔴🔴 历史章冻结、最新章仅改写档可放开＋落库后跑设定同步。
- ✅ 伴写＝ghost 叠层＋「钢笔」弹窗（默认关）；🔴 **Ctrl+Enter 采纳、Alt+/ 换一句 —— Tab 恒归缩进**。

## 架构红线
- 无 i18n；schema 列名即存储键。⚠️ 打包陷阱：①tree-shake（门控用「平台并集」，删门控必跑 `vite build`）；②`DESKTOP` 探测→dev 浏览器恒 false。
- 左下角只准一个浮层 `DataDock`。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑闸。
- 🔴 门面显式再导出（勿 `export *`）；`PROMPT_ORDER` 还原注册序；`ops`/`currentProjectId` 须 `export let`。
- 🔴 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；拆书／创意写作＝**optional**。
- 🔴 **无「名称」列的表格草稿必须声明 `dedupKeys`**（关系表＝人物A/人物B）。
- 🔴 编辑器双图层：盒模型逐项一致；叠层重建归零 scrollTop→`useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🔴 长任务状态放模块级 store（`lib/creativeSession.ts`）；lib 层禁 import components。
- 🗺 多地图：新表 `geomaps`＋geography 的 `所属地图`；🔴 删图不删地点、改图名连带改归属。
- 🔴 审计四条（详规见 skill `novel-studio-audit-fix`）：语料净化／`KEEP` 白名单／死代码回查 `docs/` 判决／**工具的结构假设会静默失明**（闸只查 `description`、`tips` 会漏）。

## 存储·同步
- 🔴🔴 云盘同步「删了会复活」：修＝墓碑 `syncTombstone.ts`＋`localHasContent` 闸。
- 桌面整库一 JSON；🔴 图片先压缩再入库；⚠️ 别让云盘同步它。
- 🔴 `backups` 本地专属→`makeCloudStoreWrapper` 短路。🔴🔴 桌面读数据失败**必须锁写盘**（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔴🔴 服务器已**彻底清理**（09-21）→ 跨设备同步只剩云盘文件夹。`createIdleTransport`＝未开启占位（🔴 绝不返回空库）。

## UI·布局尺寸
- 🔴🔴 `<html>` 界面缩放：①量尺寸用 `offsetHeight`/`clientWidth`，禁 `getBoundingClientRect()`；②vh/vw 不随 zoom→内联长度走 `foldVh()`；③SVG 滚轮/拖拽除 zoom。
- 🔴 光标/选区同步不能只靠 `onKeyUp`→有 `onChange` 就在里面同步。判「琥珀开启态」按 class **词元**比。
- 🔴 按对侧高度定高：flex item 加 `overflow-hidden`；别同写 `flex-1`+`height`。图表柱子给 `max-w`（纯 `flex-1` 会拉满整行）。
- 🔴 按钮：静止无框 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；🔴 **尺寸＝弹窗 md／主操作 sm／工具 xs；同排同 size**。
- 🔴 页头 `HelpPopover` 问号**须与标题同行**；文案禁 markdown 星号→用「」。Enter 发送必挡 `isComposing`。
- 🔴 数值输入走 `NumberField`（**它 `Math.round` 抹小数**——温度改用档位按钮）；界面偏好走 `lib/uiPrefs.ts`（`yfe-ui:`，**存「偏离默认的那一侧」**）；字数口径走 `lib/wordCountMode.ts`（面板与编辑器共用）。
- 🔴 新增页签**四处**必同步：`TabType`／`TABS`／`App.renderContent`／`FEATURE_TIER`；**资料型**另须 `aiContext.PRIORITY`。

## AI 层
- 🔴 **提示词给几层模型就按几层输出**（读端必须兼容自己给的层级，否则整表静默丢光）。
- 🔴 「保密等级」＝档位＋行级预算排序；🔴🔴 **`rankOf` 须同认裸键与复合键**；🔴🔴 **D＝终结：任何情况都不进 AI**（`aiContext.isPrunedForAI`），该列**封闭枚举**禁增/改/删。
- 🔴 提示词可编辑：默认值就地声明；变量须模块级 `let`＋setter；🔴🔴 **注册顺序＝设置页顺序**。
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）；生成型走 `parseLooseObject`＋空结果重试。
- 🔴 温度：结构化固定 **0.3**（不被偏好顶掉）；创意按 **provider 存**（档位 稳/标准/活；缺省 0.85）。
- 🔴 采样惩罚看**射程**：`repeat_last_n` 512＋`frequency_penalty` 0.1；🔴🔴 绝不调高 `repeat_penalty`；反重复提示词只钉 system 末尾。
- 🔴🔴 额度跟模型走：`adviseCapacity()`→`recommendTuning()`，`syncTuningWithModel()` 靠**模型指纹**。
- 🔴🔴 思考模型必须关思考：本地 `think:false`；云端 Qwen3 系下发 `enable_thinking:false`（开＝50~130s 且 content 必残）。
- 🔴 长文生成必走流式（`aiTasks/stream.ts`）；`runAutoContinue` 必传 `onBodyToken`；失败原因必经 `onLog` 转界面。
- 🔴 AI「会读哪些数据」＝`lib/aiDataSources.ts` 单一源。🔴🔴 禁写「全程本地/不外发」——口径＝「发给**当前选定的**模型」。
- 🔴🔴 **AI「整理」产出须两道本地兜底**：候选值＝库里已有 ∪ 本次刚抽实体名；产出后按名单**本地过滤**＋给**原文依据**。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 不可换序）；作者原文进 prompt 走 `promptGuard.authorBlock()`，绝不清洗正文。本地预算上限 32K。

## 工程质量·实机
- 三步基线：`tsc --noEmit`／`eslint src`（0 problem）／`node tests/run-all.mjs`（别用 `npm run verify`，沙箱会拦）。
- 🔴 闸 `tests/structureGates`（行数/归属/禁裸 `JSON.parse`/原生弹窗/**any 账本只准降**）。
- 🔴 实机走 skill `novel-studio-ui-livecheck`（脚本与全部踩坑都在里面）；**子代理结论必回源码验**；断言「落库」须直读 IDB。
- 🔴🔴 实机三条硬伤：①编辑器正文须 `textarea.novel-textarea`（页面上有 4 个同名 div）；②播完种禁 reload；③**退出码须与断言一致**（关浏览器会抛 `TargetClosedError`）。

## 酒馆模式（动前必读 `docs/酒馆模式-工程红线.md`）
- 🔴 归属：剧情会话/扮演设定/报告/背景**随项目**；自由会话/角色卡/记忆/面板设置/剧本库**跨项目**（`tavernReports` 勿漏 `deleteProject`）。
- 🔴🔴 预算三数：`historyBudget`＝预算−400−整条 system；contextBudget **24000**；numCtx **32768** 别动。
- 🔴 最易踩：①会话存**快照非引用**；②角色卡小项只能「名：内容」同行＋**全角冒号**。协议 **v1.11**。

## 出厂数据·示范项目
- 🧪 dev 数据放仓库外或 `dev-seed/`（🔴 import 必带 `?时间戳`）。📥 卡走 skill `tavern-cards-batch`。🚫 原生不预填自由示范卡（闸 `tavernSeedPolicy`；**老库卡只留不删**）。
- 示范项目《吞天神脉》三卷 21 章（卷三 **剑锁中州**）；改正文同步 `seedContent.ts`→`seedData.ts`。
- 🔴 闸：seed-schema-check＋`tests/seedRef`＋细纲卡核对。

## 环境（Win + Git Bash）
- git/npm/node 用**绝对路径**且每次现探；⚠️ `sort`/`find`/`timeout` 解析到 Windows 同名 exe→改 node 脚本。
- 🔴 **G 盘元数据极慢**（删 49ms／建 25ms 每文件）→ 大批小文件**单进程挂后台慢跑**，🔴 **禁并行**；判「删除慢」先做跨盘对照。
- 🔴 `git ls-files` 中文路径须 `-c core.quotepath=false ls-files -z` 按 `\0` 切。
- 🔴🔴 同消息对同一文件发多个 Edit 会相互覆盖→串行改、改完即 grep。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**（返空→误判→覆盖）；用 `Read`／`test -f`；`memory/*.md` 只准 append。

## 2.4 开发（规划 `docs/2.4.0-版本规划.md`，记录 `docs/2.4.0-开发记录.md`）
- 三目标：**转化**／**长篇**／**可信**。**分批**：2.4.0（A1-A5）→2.4.1（B1-B3·B5）→2.4.2（C1-C10）。
- ✅ **2.4.0 五项全齐（09-21/22，细节全在开发记录）**：**A1** 首启「向导三选一」＋「新手引导」入口＋**采样按 provider 存**；**A2** 性能基线（闸 `tests/perfBaseline.test.ts`＋实机 `ui-perf-longbook.mjs`）——321 章/101 万字**冷启动 1.5s、切章 146ms**；🔴 首次数字含 **Vite 冷编译噪音**须重复测、🔴 **未验项不许写数字**；**A3** 快照**优先丢最旧 auto**、AI 快照进备份而**自动备份不带**、时光机来源＋**任意两版对比**；**A4** 创作轨迹页签（`trajectory`）＋证据包（本章/整书、`pre` 保缩进、JSON 全量、桌面 `printToPDF`）；**A5** 🔴 **Tab/Shift+Tab 恒为缩进**、程序化插入**必走 `execCommand`**、一键排版默认**保留缩进**、导出禁行首 `trim()`。
- ✅ **遗留已清零（09-22）**：A2 大表格**已验**（**5344ms / 3008 行 × 17 列**，唯一偏慢项）；四个新增 UI 的实机断言补齐（`ui-editor-indent` **27 项**、`ui-trajectory` **44 项**、新 `ui-ai-config` **14 项**）。🔴 实机新硬规则：**重活（巨型 DOM）放最后**（否则后续交互假死）、**测「保存类」先确认前置校验满足**（否则误判成"存储坏了"）。仅剩 A3-②/A4-①（等 C2 / 封装）。
- 🔴 中文 PDF 禁 jsPDF→HTML+打印样式为真源，桌面 `printToPDF`、其余 `window.print()`。

## 对外推广
- 🔴 文末**禁裸链**（禁 `https://`／`pan.quark.cn` 连写／「提取码」→「口令」）；链接压最末＋**后须有缓冲文字**（规范见 `docs/小黑盒推广帖/`）。
- 🔴 **发帖顺序**：稿里承诺的版本号须**先在夸克盘＋Gitee Release 上架**再发帖。第 0/1/2 篇**均已发布**（对外 **2.3.1**）；入口：Gitee `tgxy2026/youth-fantasy-engine`；夸克 `pan.quark.cn/s/8ae0eb718cf5` 口令 `QfAm`。
- 系列进度：第 3 篇（人物三件套）**已完稿待发**（配图 5 张全齐）；第 4 篇＝**世界构建**，稿末已预告。截图库按**篇号前缀**分组，共用图用**注记对照**不复制副本。

# novel-studio 长期记忆
> 只记「该做什么／禁什么」；**为什么与踩坑经过一律指向 `docs/2.x.x-*` 与 skill**。事件留 `YYYY-MM-DD.md`。

## 红线
- 🔴 产品立场：AI 只做辅助。**绝不做反检测/洗 AI 痕迹**；只做「创作主权存证＋质量自检＋如实申报」。
- 🔴 封装须主人哥哥明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`、手工 `git gc`/`reflog expire`**（两次事故）。恢复靠 `git bundle`；`gc.auto=0` 别改回。
- 禁删 `release/eb-cache/`；禁原生 `prompt/confirm/alert`。清单 `docs/2.3.1-Bug与待优化清单.md` 只记录、明说「处理」才动。提交含 `!`/换行用 `git commit -F`。main 无远程。

## 身份·版本·封装
- Electron+React+TS+Vite+Tailwind；存储经 StoreOps；dev 5199 须 `localhost`（127.0.0.1→302＝两份库）；🔴 只做桌面版，版本源 `package.json`（现 **2.6.0**，09-27 已封装发布 Gitee：Release **1169453**）。
- 🔴🔴 封装**全程无沙箱跑**；rcedit 间歇失败（退出码仍 0，只认 stderr）由 `after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`。基线：主 exe 181,097,984B、包 80.96MB。
- 🔴 **环境两坑**：脚本内 `spawnSync`/`execFileSync` 起子进程被拦成 **EBUSY**（改用「清单外层生成」）；`fs.rmSync` 走 safe-delete（>10MB ETIMEDOUT）⇒ 清产物用 `unlinkSync` 深搜。
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
- 🔴 审计四条（详规见 skill `novel-studio-audit-fix`）：语料净化／`KEEP` 白名单／死代码回查 `docs/` 判决／**工具的结构假设会静默失明**（闸只查 `description`，`tips` 漏）。

## 存储·同步
- 🔴🔴 云盘同步「删了会复活」是**家族不是单条路径**：修＝墓碑 `syncTombstone.ts`＋`localHasContent` 闸。⚠️ **一次找齐同一个病的所有路径**（判据用墓碑；desktop `bulkPut` 会 `clearDeleted()`）。
- 🔴 同步排除表 `EXCLUDED_META_KEYS` 管「含密钥的全局 meta」：现含 `aiProviders` 三键 + **`app.search`**。⚠️ 老库还有**第二载体** `tavern.settings.search`（由 `migrateLegacySearchKey` 清）（搬过家的密钥要连旧位置排查）。
- 桌面整库一 JSON；🔴 图片先压缩再入库；⚠️ 别让云盘同步它。
- 🔴🔴 **本地专属 store 有单一判据**：`syncCore.LOCAL_ONLY_STORES` + `isLocalOnlyStore()`
  （现含 `backups`、`backupPayloads`）—— 原 6 处硬编码已全改用它，**新增只往数组加名字**。
  🔴 `backups` 只存元数据+`bytes`，载荷在 `backupPayloads`（IDB v11）；`migrateBackupPayloads`
  须在 `runMigrations` 的 currentProjectId **守卫之前**。🔴🔴 桌面读数据失败**必须锁写盘**（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔴🔴 服务器已**彻底清理**（09-21）→ 跨设备同步只剩云盘文件夹。`createIdleTransport`＝未开启占位（🔴 绝不返回空库）。

## UI·布局尺寸
- 🔴🔴 `<html>` 界面缩放：①量尺寸用 `offsetHeight`/`clientWidth`（禁 rect 绝对值）；②vh/vw 不随 zoom→内联走 `foldVh()`；③SVG 滚轮/拖拽除 zoom。
- 🔴 光标/选区同步不能只靠 `onKeyUp`→有 `onChange` 就在里面同步。判「琥珀开启态」按 class 词元比。
- 🔴 按对侧高度定高：flex item 加 `overflow-hidden`，别同写 `flex-1`+`height`；图表柱子给 `max-w`。
- 🔴🔴 往 DOM 里**插包裹层**必回看子元素 `h-full`（父高须**确定**；父 auto ⇒ 退化成 auto ⇒ 撑不满：短页留白／长页被裁）。`App.tsx` 的 `main > div.h-full` 是撑满链的关键一层。
- 🔴 按钮：静止无框 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；🔴 **尺寸＝弹窗 md／主操作 sm／工具 xs；同排同 size**。
- 🔴 页头 `HelpPopover` 问号**须与标题同行**；文案禁 markdown 星号→用「」。Enter 发送挡 `isComposing`。
- 🔴 z 层号：页内定位走 `Z.pageBackdrop/pageHandle/pageBase`；**判定不收三类见 zLayer 注释**。
- 🔴 数值输入走 `NumberField`（**抹小数**——温度改用档位按钮）；偏好走 `lib/uiPrefs.ts`（**存「偏离默认的那一侧」**）；字数口径走 `lib/wordCountMode.ts`。
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
- 三步基线：`tsc --noEmit`／`eslint src`／`node tests/run-all.mjs`（别用 `npm run verify`，沙箱拦）。
- 🔴 闸 `tests/structureGates`（行数/归属/禁裸 `JSON.parse`/原生弹窗/**any 账本只准降**）。
- 🔴 实机走 skill `novel-studio-ui-livecheck`（脚本与全部踩坑都在里面）；**子代理结论必回源码验**；断言「落库」须直读 IDB。
- 🔴 **拆巨型组件＝机械拆分器 + 实机指纹 + 负面对照**（脚本在 skill assets，坑写在文件头）；**拆完四件套**
  ＝`vite build`＋grep `tests/` 路径引用＋负面对照＋主文件头写明哪几层 DOM 不能动。
- 🔴🔴 实机三条硬伤：①正文须 `textarea.novel-textarea`；②播完种禁 reload；③**退出码须与断言一致**（关浏览器抛 `TargetClosedError`）。
- 🔴🔴 **改启动路径/首启行为＝改了所有实机脚本的前置条件** → 必须先跑全量脚本、区分「产品回归」与「资产落后」。⚠️ 旧脚本 `.catch(()=>{})` 会**静默伪装**成"功能坏了"；补丁插在 `goto()` 后第一个 sleep 之后。

## 酒馆模式（动前必读 `docs/酒馆模式-工程红线.md`）
- 🔴 归属：剧情会话/扮演设定/报告/背景**随项目**；自由会话/角色卡/记忆/面板设置/剧本库**跨项目**（`tavernReports` 勿漏 `deleteProject`）。
- 🔴🔴 预算三数：`historyBudget`＝预算−400−整条 system；contextBudget **24000**；numCtx **32768** 别动。
- 🔴 最易踩：①会话存**快照非引用**；②角色卡小项只能「名：内容」同行＋**全角冒号**。协议 **v1.11**。
- 🔴🔴 **就绪判据必须同源**：酒馆模型来源＝`resolveTavernProvider` 三层兜底（会话→面板→全局）⇒ 走 `checkTavernReady`／`useTavernReady`；🔴 **绝不给酒馆链路加全局 `useAIReady`**（`uiUxGuards` 禁，注释也不许出现）。
- 🔴 `TavernControl` 拆分后：左右列 div 必须留主组件 —— 协议窗高度同步量它们的**直接子节点**（左恒 5、右恒 3），子组件一律返回 Fragment。

## 出厂数据·示范项目
- 🧪 dev 数据放仓库外或 `dev-seed/`（🔴 import 必带 `?时间戳`）。📥 卡走 skill `tavern-cards-batch`。🚫 原生不预填自由示范卡（闸 `tavernSeedPolicy`；老库卡只留不删）。
- 示范项目《吞天神脉》三卷 21 章（卷三 **剑锁中州**）；改正文同步 `seedContent.ts`→`seedData.ts`。
- 🔴 闸：seed-schema-check＋`tests/seedRef`＋细纲卡核对。

## 环境（Win + Git Bash）
- git/npm/node 用**绝对路径**且每次现探；⚠️ `sort`/`find`/`timeout` 解析到 Windows 同名 exe→改 node 脚本。
- 🔴 **G 盘元数据极慢**（删 49ms／建 25ms 每文件）→ 大批小文件**单进程挂后台慢跑**、**禁并行**；判「删除慢」先跨盘对照。
- 🔴 `git ls-files` 中文路径须 `-c core.quotepath=false ls-files -z` 按 `\0` 切。
- 🔴🔴 同消息对同一文件发多个 Edit 会相互覆盖→串行改、改完即 grep。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**（返空→误判→覆盖）；用 `Read`／`test -f`。

## 2.4 开发（规划 `docs/2.4.0-版本规划.md`；记录 `docs/2.4.2-开发记录.md`）
- ✅ **2.4.3 已封装发布（09-23，补丁版：修撑满型页面塌掉）**，全项完成并实机验证：见 `docs/2.4.2-开发记录.md`＋`2.4.2-C1-*拆分记录.md`；**C8 本批跳过**。
- ✅ **六维审计完成（修 44 处/20 文件）**：`docs/2.4.2-六维审计修复记录-2026-09-23.md`。
  P1＝裸 clipboard／**记忆退化仍推水位线**（新 `memoryDegraded`）／老库 `tavern.settings.search` 密钥残留。
  🔴 同步层测试**必须用 `backgroundPull()`**（`pullSnapshot` 不触发三路合并 ⇒ 用例会「新旧都通过」）。
- 🔴 **新增 AI 功能要四处注册**（漏一处静默半残）：`aiTasks` 门面（import+export+`PROMPT_ORDER`+
  `PROMPT_SETS`）、`aiDataSources`、`aiWriterBudget`（加 budget kind 会让 `tests/writerBudget` 报错）。
- 🔴 `exportBookPlatformText` 已 **async**；exporter 仍动态 import。
- **C7 由另一个窗口负责**（不在本线推进）。
- ✅ **C10 已完成**：世界观/力量体系「**母子结构**」—— 母级不动（仍 form、永远喂 AI）；子级外挂 `cardRecords`
  （tabId `worldbase-sub`/`power-sub`，**不在 TABS**）+ 活跃态在 `settingsKV`；🔴 **只喂活跃子项**、
  **单世界零变化**、离开页签必落库草稿。
- 🔴 发布链＝skill `novel-studio-packaging`＋`gitee-publish`；🔴 快照 sync 后**必 `git checkout -- .gitignore`**（每轮被覆盖丢密钥防护）。
- 2.4.0/2.4.1 见 `docs/2.4.0-开发记录.md`。

## 2.5 开发（规划 `docs/2.5.0-版本规划.md`，含第十段封装验收）
- ✅ **2.5.0 已封装发布（09-25）**：A1 结构模板库（4 套，文案全自撰）＋A2 全书配比对照（章数位置轴归属＋字数 share 度量，防同义反复）＋B1 安装目录可选（三路径静默实测过，不回滚）＋C1 自定义主题（三参数派生＋WCAG 守卫；预览/生效分离、快照回滚）。
- 🔴 **配比归属看章数位置轴、度量用字数 share**（字数轴中点＝同义反复，量不出偏差）；舍入用最大余数法。
- 🔴 bump-version.mjs 假设三处同旧版本号——package.json 先行升级后再跑会断言失败，改内联替换 lock 前 2 处。
- 🔴 Gitee `POST /releases` 必须带 `target_commitish`（400 否则）；NSIS 默认装目录名＝package.json `name`（novel-studio）非 productName。
- 后续 2.5.1＝A3 灵感转化＋D1 导师预设。

## 2.5 开发第二批（2.5.1 第一批 ✅ 09-26：B2 + D1 + A3，112/112）
- ✅ **B2 F11 真·全屏**（9820ca9）：main.cjs 三 IPC + 状态推送；preload electronWindow 桥；desktop.ts helpers **运行时探测**（node 单测才能注入 mock）；F11 切换、ESC 仅全屏态退出；Sidebar 开关仅桌面渲染；启动行为不变。🔴 preload 接口命名随 Electron 官方大写 S（setFullScreen），单测抓到过不一致。
- ✅ **D1 写作导师预设**（582c0c1）：ReaderLens 加可选 questions?（缺省=读者三问**零变化**）；questionsOf 问题集单一源；四问 theme/conflict/arc/cost；🔴 换身份必清结果（旧 key 套新分组全变「没提」）。
- ✅ **A3 灵感夹+融合**（6e56e46）：🔴 侦察发现灵感页**本无灵感卡数据结构**（比「成本高」更上游），主人哥哥拍板新建灵感夹（settingsKV 随项目、200 条上限、逐字去重）；aiFuseInspiration 融合≠拼接+basedOn 溯源+空重试；PlotCanvas 加 'idea' 卡型（🔴 不进 HEADER_TO_TYPE）；四处注册齐全（aiWriterBudget 加 kind 必须同步 tests LEGACY）。
- 遗留（出包验收）：B2 实机 F11、A3「换汤不换药」对比测试、D1 无污染实机验。
- 提醒：showToast 类型只有 success/error/info。

## 对外推广
- 🔴 文末**禁裸链**（禁 `https://`／`pan.quark.cn` 连写／「提取码」→「口令」）；链接压最末＋后有缓冲。
- 🔴 **发帖顺序**：承诺的版本号须**先在夸克盘＋Gitee 上架**再发帖。系列稿第 0/1/2/3 篇**全部发布完毕**（09-24 收官）。
- 🔴 **本窗口职能（09-24 起）**：只输出**版本更新说明**，不再写项目介绍帖。介绍稿与截图已清理，仅留 `docs/小黑盒推广帖/截图/99-封面-青春幻想引擎.png`（2.4.0 封面）＋同目录 `封面源-青春幻想引擎.html`（改版本号只改 `.subtitle` 一行）；《小黑盒项目推广帖写法学习笔记.md》仍保留。
- 入口：Gitee `tgxy2026/youth-fantasy-engine`；夸克 `pan.quark.cn/s/8ae0eb718cf5` 口令 `QfAm`。对外：Gitee **2.6.0**／`1169453`（09-27）；夸克还停在 **2.4.3**（🔴 在「2.4.0版本」目录里——该盘习惯＝主版本目录放系列最新补丁，核版本看**文件名**别信目录名；2.5.0 夸克未传，等主人哥哥）。
- 🔴 令牌 `G:/AI软件/.gitee-token.txt`。🔴 push 只需 `GIT_CONFIG_NOSYSTEM=1`；🔴🔴 **绝不可再加 `GIT_CONFIG_GLOBAL=NUL`**（屏蔽 GCM ⇒ 静默挂死）。

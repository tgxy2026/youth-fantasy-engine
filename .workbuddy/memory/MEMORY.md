# novel-studio 长期记忆
> 红线/决策索引；事件留 `YYYY-MM-DD.md`。⚠️ **目标 ≤8500 字符**（压不动就把整节外链主题文档）。
> 主题细则外链：`docs/酒馆模式-工程红线.md`、`docs/2.1.1-审计修复记录.md`、`docs/AI上下文*.md`、`docs/2.2.0-*`、`docs/AI设定数据*.md`。

## 红线
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`，也禁手工 `git gc`/`reflog expire`**：09-14 stash 中断丢对象；09-16 `git gc --prune=now` 把 `.git` 清成空骨架。恢复靠 **`git bundle`**。已设 `gc.auto=0`，别改回来。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md` 只记录，明说「处理」才动。提交含 `!` 或换行用 `git commit -F`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199。
- 现 **2.2.0**（主题＝**完善 AI 写作**；旧红线「AI 只辅助不生成正文」09-17 删）。版本唯一源 `package.json`。⚠️ `package-lock.json` 根版本常落后 → 只改 `j.version`＋`j.packages['']`。
- 🔴🔴 封装**全程无沙箱跑**。rcedit 间歇失败（退出码仍 0，只认 stderr `Fatal error`）由 `scripts/after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`；`ELECTRON_CACHE`→`AppData/Local/electron/Cache`。
- 🔴🔴 **只做桌面版**（无 WEB/PORTABLE）。`StoreOps` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径。

## 2.2.0 三功能（伴写 / 拆书 / 工作流）
- 细则四份文档见 `docs/2.2.0-*` 与 `docs/一键拆书-*`。**排期 A→B1→C→B2**。
- ✅ **A 伴写（09-17）**：`aiInlineSuggest()`＋`NovelEditor` ghost 第三叠层＋「钢笔」弹窗（**默认关**）；文风三层锚定**不做枚举**、去 AI 味钉 system 末尾、长度三档。🔴 切章必须清 ghost（否则 Tab 把上章建议插进新章＝数据事故）。
- ✅ **B1 拆书（09-18）**：通用件在 **`src/lib/flow/`**（域中立；🔴 别去 `bookbreak/` 找）：`pipeline`（状态机/中止/续跑）、`fieldMap`（**只声明语义字段名**，真键由 `resolveSlot()` 查 schema——三张卡结构不同靠「候选取首个存在者」共用）、`draft`（判重走 `settingLedger.classify`；**同名异类标 conflict**，实机抓到的坑）、`commit`（默认 `keep-existing` 分毫不动；🔴 写前必 `previewCommit`）。页签在灵感工具组。🔴 `terms` 表无「别称」列。
- ✅ **C 创意写作（09-18）**：`aiGenerateBible`/`aiGenerateOutline`＋`lib/aiWorkflow.ts` 的 `runCreativeWriting`（bible→**闸门①**→outline→**闸门②**→连写）。🔴 **闸门＝await Promise**、**落库只在闸门通过后**（放弃不留半成品）；连写复用 `runAutoContinue`＋新 `outlineFor` 按细纲写。设定草稿与拆书**同形状**（`ExtractedEntity.fields`→`fieldMap.slots`）；额度 kind `outline-generate`。
- ⏳ **B2**＝两遍全字段抽取，只换 `bookbreak/run.ts` 的 extract 阶段（draft/commit/UI 不动）。

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
- 🔄 两同步入口别混：①改数据位置＝明文 JSON 进云盘；②云盘同步＝加密 `.yfe`＋记录级合并＋每日备份。**用 ②**。
- 🔴 09-15 修一批同步缺陷（细则见 `docs/2.1.1-审计修复记录.md` §四）。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`；SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 会回退黑）。设置项排版＝标题→输入→说明；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：①量尺寸一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；②zoom 不缩放 vh→内联长度走 `foldVh()`（`theme.ts`）；③SVG 滚轮锚点/拖拽除 zoom。
- 🔴 **光标/选区同步不能只靠 `onKeyUp`**：**输入法上屏、粘贴、程序化插入都不产生 keyup** → 依赖 keyup 的 UI 会拿到过期 `selectionStart`。有 `onChange` 的地方就在里面同步一次。
- 🔴 判"琥珀开启态"按 class **词元**比（`c.split(/\s+/).includes('text-amber')`）：off 态写着 `hover:text-amber`，`includes` 恒真 → 假 PASS。
- 🔴 按对侧高度定高：flex item `min-height:auto` 顶回定高→加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框用 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；行内小操作 `size="xs"`；`danger` 破坏性。
- 🔴 每页签页头 `HelpPopover` 问号**必须在标题右侧同行**（`h1` 是块级，须同处 flex 行内容器）。头像兜底＝名字（`avatarLabel` 封顶 2 字）；Enter 发送／Shift+Enter 换行必挡 `isComposing`；文案禁 markdown 星号→用「」/（）。

## AI 层
- 🔴 **「保密等级」＝信息档位＋行级预算排序（09-17）**：单字段双输出**不并存**（S＝角色视角排除＋P0；A/B/C＝P1/2/3）。`aiContext.ts` `rankOf`/`sortBySecrecy`；`renderCards/renderTable` 排序后 `slice(0,cap)`；🔴 同级必须稳定（护 prefix cache）。🔴🔴 **`rankOf` 必须同时认裸键与复合键**（表格＝`保密等级`、卡片＝`模块::保密等级`）——只认裸键让**角色卡排序静默失效**。详见 `docs/AI上下文-*.md`；⚠️ 未做：S 级行过滤、时序加权。
- 🔴 **预算为何 1~2 万而非标称 256K**：32GB 显存下 KV cache 32K=8.7GB（+模型≈塞满）、128K=34.9GB 溢出——上限就在 32K；叠加"有效上下文仅标称 30~65%""**3000 token 起有长度税**"。详见 `docs/AI上下文预算策略-…md`。
- 🔴 **防剧透＝四道闸（`aiContext`，调用方传参）**：① `viewMode:'character-view'` 排 10 张作者侧页签 ② `AUTHOR_SIDE_FIELDS`（~40 个未来向列名，**新字段须登记**）不渲染 ③ `anchorChapterId` 只到锚点 ④ `knowerName` 过滤 secrets 知情条目。**只覆盖剧情推演**；其余 AI 功能拿全量。
- 🔴 **新增资料型页签必须登记 `PRIORITY`**——兜底循环只保证"数据不丢"、不保证"进得了预算"（09-17：`faction-rels` 有数据却带不上；`style` 已前移）。
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）；**生成型入口（Bible / 大纲）走 `parseLooseObject`＋空结果重试**——小模型会在 JSON **结构位**塞杂字符，严格解析全丢后表现为"生成成功但 0 条"，极难排查。温度：结构化 0.3、创意 0.85；一轮 JSON 走 `aiChatJson`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。
- 🔴 采样惩罚看**射程**不看强度（三惩罚共用 `penalty_last_n` 窗口，Ollama 默认 64 词元≈50 汉字）。✅ 09-16：`repeat_last_n` 512＋`frequency_penalty` 0.1 → 手部率 28.9%→13.4%。🔴🔴 **绝不调高 `repeat_penalty`**（1.4 实测崩）；`presence_penalty` 归零**无效**；反重复提示词**只钉 system 末尾有效**。
- 🔴 **额度跟模型走（09-17/18）**：`adviseCapacity()`→`recommendTuning()`（出厂配比：硬＝预算×12.5%、软＝8.3%、长期＝硬÷6、日记＝`7×√(预算/24000)`）；`syncTuningWithModel()` **换模型即套用**，🔴🔴 靠**模型指纹**判定（同模型下手调值绝不覆盖、首次只登记）；本地**超窗口保护**（预算>`numCtx×0.732` 回落）。🔴🔴 **记忆档跟「预算」走、不跟本地/云端走**。`TUNING_LIMITS` 与 `paramGuide` 同源（有测试锁）。窗口可在模型配置页手填。
- 🔴 本地实弹探针：思考模型必带 `think:false`（否则全文进 `message.thinking`、`content` 空）；改口径走 `LR_ANALYZE=<json>` 离线重算（别重跑 GPU）；CUDA 固定 seed **不保证逐位复现**（±4pp）。
- 🔴 自己驱动 `runAutoContinue` 必须传 **`onBodyToken`**（"开流式"开关；不传走 180s 总超时，27B 必被掐死）；先 `ai.chat` 预热；别 `await page.evaluate(整流程)`（改点火＋轮询 `window.__gen`）。
- 🔴 **AI「会读哪些数据」＝ `lib/aiDataSources.ts` 单一源**＋`AIDataSourceNote` 进各功能气泡；改 prompt 来源**必须同步改它**，闸 `tests/aiDataSources.test.ts`。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`），站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务→删库≠下线；Nginx SPA 回退：不存在路径也返 200→不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；ESLint 09-18 起 **0 warning**。⚠️ exhaustive-deps **别盲改**，分三类：真漏依赖（改对依赖）／普通函数当依赖（改 `useCallback`）／派生值误报（内联）。🔴 实机验证走 `novel-studio-ui-livecheck`——**写脚本前先读它的"五条必踩的坑"**（09-18 漏读→重踩侧栏分组折叠、白跑 25 条假 FAIL）；实弹断言会静默过时；子代理结论必回源码验。

## 酒馆模式
- 🔴🔴 **动酒馆任何功能前必读 `docs/酒馆模式-工程红线.md`（18 节）**；此处只留「跨节最易错」几条。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景**随项目**；自由会话+角色卡+记忆日常+面板设置+剧本库**跨项目**（索引与分条成对，tavernReports 别漏 deleteProject）。
- 🔴🔴 预算三数（**出厂默认**；面板可按模型动态推荐覆盖，见「AI 层」）：`historyBudget`＝预算−400−整条 system（别传记忆）；contextBudget **24000**；numCtx **32768** 别动（本地由显存决定，云端的 `num_ctx` 无效）。
- 🔴🔴 防剧透两层：段落级 `viewMode:"character-view"`＋字段级 `AUTHOR_SIDE_FIELDS`（**新字段须登记**）；标题整行匹配（禁 `includes`）。
- 🔴 最易踩：①会话存**快照非引用**（`snapshotStorySetting`）；②`branchSession` 分支/回滚**连记忆一起**；③归档后输入区只读＋`reroll`/工具条/调度/数值全锁；④角色卡小项**只能「小项名：内容」同一行＋全角冒号**（半角 `:` 或独占行 → 整栏掉进界面「其他」框）。
- 🔴 协议 **v1.11**（旧版冻进 `LEGACY_PROTOCOLS`；改协议同步三处＋两断言）。📋 验收清单 `docs/酒馆模式-本轮改动实机验收清单-2026-09-16.md`。

## 出厂数据（角色卡不进原生）✅ 09-15
- 🧪 dev 测试数据放仓库外 `…\04-开发测试数据\`，走 `story.ts`/`store.ts`；🔴 绝不写进 `seedData.ts`。📥 卡走 skill `tavern-cards-batch` 导入。
- 🚫 原生不再预填自由示范卡（已删 `seedCard*` 与 33 处卡名）；闸 `tests/tavernSeedPolicy.test.ts`；🔴 老库卡只保留不删。

## 示范项目（吞天神脉）
- 三卷 21 章：1-10 风起云州 / 11-20 剑鸣中州 / 21 起 **剑锁中州**。改/加正文同步 `seedContent.ts`→`seedData.ts`。
- 🔴 三道闸：seed-schema-check＋`tests/seedRef.test.ts`＋细纲卡核对；推演 cast 引用卡 id→相关卡留 `card()` 返回值，播种失败只 warn。🔴 闸 `tests/importCycles`：**循环依赖只在浏览器 TDZ 崩**。

## 环境（Windows + Git Bash）
- git/npm 用**绝对路径**（git＝`…/binaries/PortableGit/versions/1.2.0/cmd/git.exe`；托管 node）——PATH 每次不持久；⚠️ `sort`/`find`/`timeout` 会解析到 Windows 同名 exe→改用 node 脚本。
- ⚠️ Edit 假成功：改完立即 grep；多处替换用脚本（全命中才落盘）；`node -e` 引号被吞→Write 落纯 JS；并发 Edit 互覆盖→串行。**跨行锚点先探 EOL**（CRLF/LF 同仓库并存；改 CRLF 文件必须写 `\r\n`）。
- 🔴 改 `protocol.ts` 正文**别用 Edit**（10 份历史协议，锚点必不唯一）→ 走临时脚本（只改 `PROTOCOL_CORE` 内＋每锚点断言命中 1 次＋旧版进 `LEGACY_PROTOCOLS`），落盘即删。
- 🔴🔴 **判文件是否存在禁用 Glob 塞绝对路径**——会返空→误判"不存在"→`Write` 覆盖！09-17 把当日日志 215 行覆盖成 37 行（靠 `git show HEAD:<path>` 恢复）。判存在用 `Read` 或 `test -f`。
- 🔴 `memory/*.md` 日志**只准 append**：先 Read 再 Edit，任何情况不用 `Write` 覆盖。覆盖类事故**先查 git**，提交过就能救。
- 🔴 dev 仅 `http://localhost:5199`（127.0.0.1 会 302→两份 IndexedDB）；桌面走文件存储、与 dev 两套（设计如此）。
- ⚠️ 验「随项目」用 `db.setCurrentProject` 别直查物理表；改提示词/示范卡文案后同步改 `tests/` 写死的旧断言。
- 🧪 dev 测试数据：仓库内 `dev-seed/`，`await import('/dev-seed/fengyang.js?'+Date.now())`（🔴 必须带时间戳）；数据在 IndexedDB，重启 dev server 无效。

## 拆书入口
- 📌 老大提「开发拆书」**必先读** `docs/一键拆书-方案规划.md`＋`docs/一键拆书-详细设计.md`（含 5 个开放问题，**B2 必读**）；路线＝schema-aligned 轻量抽取（**不**上 GraphRAG；借力「别称」＋`cr()` 引用）；🔴 导入文本**零外发**。

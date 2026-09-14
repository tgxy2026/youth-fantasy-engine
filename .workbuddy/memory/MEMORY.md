# novel-studio 长期记忆
> 长期规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。**新增前先查同类条目 —— 合并改写，不要追加第二份。**
> ⚠️ 注入上限约 6000 字符，超了会被腰斩；**这份文件必须保持精简**。

## 红线
- 🔴 **封装/重打包须老大明说「封装」**；改完最多 tsc + build + commit。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal / confirmDialog / showToast。
- 清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：只记录，明说「处理」才动手。
- 提交信息含 `!` 用 `git commit -F <文件>`。main 无远程。
- 服务器 `/var/lib/yfe` 须 www-data；sudo 写后必 chown + `sudo -u www-data test -w`。

## 身份 / 版本
- Electron31 + React18.3 + TS5.5 + Vite5.3 + Tailwind；三存储(IDB/便携/桌面)经 StoreOps；dev 5199。
- 2.0.0 已收官（2026-09-04，只发桌面/便携，网页版已关服）；现 **2.1.0**（只改号不封装）；约每月一版。
- 版本唯一源 `package.json`；展示 `APP_VERSION_LABEL`；`injectAppVersion()` 补 dev；不加 dev 角标。

## 封装 / 构建坑
- 🔴 `ELECTRON_CACHE` 须指系统默认 `AppData/Local/electron/Cache`，**切勿**指 `release/eb-cache/electron-zip`（只剩 ~500KB 空壳）。
- 正常体积：桌面 **80.68MiB**（＝「80.6M」＝十进制 84.6MB，同一文件）、便携 **8.44MiB**。两脚本已内置体积闸门 —— **退出码 0 也可能没达标，不达标即 abort**。
- NSIS：`perMachine:false` + `allowToChangeInstallationDirectory:false` → 按当前用户装、重装免管理员；旧 per-machine 版需管理员跑一次新版迁移；**勿把 `allowElevation` 设 false**。rcedit 报错是 cosmetic。

## 架构红线
- 无 i18n（中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台之并集」。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层，一律内嵌 Sidebar Footer。
- 种子：卡片键 `模块名::字段名`、表格键=schema 列名；改种子必跑 `tests/seed-schema-check.mjs`。
- `WEB` 由 `__WEB__` 定，禁写 `!PORTABLE && !DESKTOP`。
- 🔴 编辑器双图层（NovelEditor）：开 `highlightOn` 时 textarea 透明、文字全来自叠层。① 叠层与 textarea 盒模型逐项一致（`inset-0`+`px-6/8`+`pt-6`+`pb-[40vh]`）；② 叠层重建归零 scrollTop，凡高亮/切章/字号/页宽/专注/检索变化必用 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight` 单次正则，禁 `includes` 双扫。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON（`AppData\Roaming\novel-studio\novel-studio-data.json`）。⚠️ 勿让 WPS 云盘同步该目录（leveldb 锁 → 空库）。
- 便携(FSA) `flush()` 已具 swap 语义，勿再加 tmp+rename；薄弱点＝末批编辑来不及落盘。
- 判据：过服务器 → 要码；云盘 → 不要码（`DEFAULT_CLOUD_KEY`，`青春幻想引擎-同步数据.yfe`）。🔴 两路径**二选一**。
- ⚠️ 云盘播种仅 `rev===0 && 空`；**「换设备前先关软件 + 等同步完成」是硬纪律**。
- 🔴 `backups` 本地专属（云端载荷剔除）→ `makeCloudStoreWrapper` 必须把其读写短路到 local，否则备份刷新即丢。**「死配置」结论必须先验消费方再动手**。

## UI
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，但**分类色盘不要主题化**。
- 🔴 SVG 用 CSS 变量**必须走 `style`**：`fill="rgb(var(--x))"` 无效且**静默回退黑色**。
- 设置项排版：标题 →（可选）输入区 → **说明放下面**；复制统一 `copyText()`；#031 备份须**导出外部文件**（`markExported()`）。

## 布局与尺寸坑（2026-09-14 连踩两轮才揪出来）
- 🔴🔴 **`<html>` 上有界面缩放（`theme.ts` 的 `yfe-ui-zoom`，默认 108%）**：凡要「量尺寸再算回 CSS 值」的地方**一律用 `offsetHeight`/`clientHeight`，绝不能用 `getBoundingClientRect()`** —— rect 是缩放后的**视觉像素**，与 `style.height` 的 CSS 像素差 1.08 倍（协议窗对齐因此怎么调都差一截）。只做「两者对比」时 rect 无妨（同倍缩放）。`useResizable.ts` 早有同款换算，新增尺寸逻辑照抄。
- 🔴 按对侧高度定高（两列等高）：即便定高正确，**flex item 的 `min-height:auto`（=内容高）** 也会顶回去 → 记得 `overflow-hidden`；另外**别在同一元素上同时写 `flex-1` 和 `height`**（主轴是高度时 flex-basis 会压过 height）。成品：协议窗＝JS 按「右列内容高 − 通用设置高 − 间距」定高 + `shrink-0` + `overflow-hidden`，正文超出走 pre 自己的滚动条。

## AI 层
- 🔴 解析统一 `src/lib/aiParse.ts`；**禁裸 `JSON.parse`**。
- 🔴 温度不手填：结构化 JSON 传 `chat(..., { json: true })` → 0.3；创意类不传 → 0.85。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering 顺序不可换，boot 与 openProject 共用）；`getDB` upgrade 拆 9 函数，**upgrade 处是「何时跑哪段」的唯一判断点**。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce 定界）；**绝不清洗正文本身**。

## 服务器
- `154.8.178.240`；SSH `yfe_test_server`（ubuntu + 免密 sudo）；站点 `/var/www/yfe`。部署：web 构建 → tar → scp /tmp → 备份 → 解包 → chown www-data → 验收。
- 🔴 Nginx SPA 回退：**任意不存在路径都返 200 + index.html** → 不能用 200 判断资源上线。

## 工程质量
- `npm run verify`（typecheck+lint+test）；runner **每入口单开子进程**。ESLint 只开 rules-of-hooks / exhaustive-deps / no-empty（11 warnings / 0 errors）。🔴 那 11 条**不能盲改**：缺失依赖是没包 `useCallback` 的箭头函数 → **先包 useCallback 再加依赖**。
- 🔴 **界面实机验证**走 skill **`novel-studio-ui-livecheck`**（真浏览器驱动 dev server、量尺寸、出截图；含 5 条坑 + 模板）；模型链路用 `tests/build-test.mjs live-tavern|live-free`（手动、不进回归）。
- 单一口径入口：`aiParse`／`constants`(localStorage 键与防抖)／`promptGuard`／`zLayer`(Z 轴)／`useSvgPanZoom`／`LoadingState`／`AutoTextarea`(多行输入框唯一出口)。

## 可复用技法
- 🔴 **改默认值救不回老数据** → 留「旧默认文本锚点」比对升级，用户改过的不动。给人看的默认文本**一段话就是一整行**，别硬折行。

## 酒馆模式
- 来源：`酒馆模式_完整落地方案.md`（规格书，**冲突时以方案为准**）+ `本地模型角色扮演完全手册.html`。
- 侧栏顺序＝`TABS.filter` 保序：**控制面板 → 剧情推演 → 推演报告 → 自由对话 → 角色卡片**（控制面板是先决条件）。
- 🔴 **数据归属（老大明确要求，`tavernStore` 测试已锁）**：**剧情推演会话 + 扮演设定 + 推演报告随项目**；**自由对话会话 + 角色卡 + 记忆日常留言 + 控制面板设置跨项目**。索引与分条须成对读写（`tavern.sessionIndex` ↔ `tavern.session.<id>`）；`tavernReports` 独立表（DB v10），别漏 `deleteProject` 与 `applyBundleToProject`。
- 🎛️ 控制面板：设置存全局 meta `tavern.settings`，**一律走 `getTavernSettings()`**；优先级链 会话 → 角色 → **控制面板** → `TAVERN_DEFAULTS`。协议可编辑（进编辑前**必须弹窗警示**；清空回退内置常量）。**再加参数前先搜 tavern 目录里写死的数**；settings 引到反向依赖 engine 的模块会成环（常量上移 `types.ts`）。
- 🔴 层序：设定 → 记忆 → 身份边界 → 档位 →（通用补充要求 → 模式补充要求）→ 未带入声明 → **协议（钉绝对末尾）**。
- 🔴 `buildMultiCharRule`：整场 AI（无「你演」角色）必须传 `{hasUser:false}`，否则模型会等一个不存在的人；用户扮演具体角色时传 `userName`。
- 🔴 自由模式「用户扮演的角色」=`FreeSession.userCharId`（可选）。**AI 名单 / 发言轮转 / 记忆块三处都要排除他**，否则 AI 替他回答；他本人的记忆**不给 AI**（那是他自己的底牌）；身份层写「用户扮演：X，不要代写」。默认值在控制面板「默认我演的角色」。
- 🔴 记忆**按角色分别整理**（几个角色几份档案，右栏页签切换）；水位线**全部成功才推进**。角色卡片页可直接手改记忆。自由对话页**无角色列表**，左栏＝全局会话列表；`FreeSession.scene?` 渲染成第一条 user 消息。推演报告名＝`sessionTitle + ' · 报告'`。
- 🔴 采样链走 `ai.ts` 的 `extraOptions`：Ollama 原样并入 options；OpenAI 兼容只转发白名单（top_p / presence / frequency）——**top_k / repeat_penalty / num_ctx 绝不能发给 OpenAI 端点**。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排除 10 个作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（约 30 个）隐藏未来向列。**新增未来向字段必须同步登记②**。
- 🔴 提示词与解析器对齐四条：解析器按**提示词写法**写；标题判定**整行匹配**（禁 `includes`）；序号裸化与正则一致；校验查**全部**字段。
- `think:false` 是 **Ollama 专有**（选非推理模型或本地 27B）；报告 finding 指不回条目即降级「存疑」；定位走 `yfe:navigate`；总结**必须带角色背景**。
- 示范卡三张：洛汐 / 苏念 / 楚楠（楚楠按前两张的事实新写，用于「用户演苏念、AI 演楚楠」）；交付件在 `你需要的文件在这里/角色卡-楚楠.taverncard.json`。待办只剩「角色头像上传」。

## 环境（Windows + Git Bash）
- git 全路径 `…/PortableGit/versions/1.2.0/cmd/git.exe`；npm 走 `"<托管node>/node.exe" "<…>/npm/bin/npm-cli.js"`，路径必须 `C:/` 正斜杠。
- ⚠️ **Edit 会「假成功」**（dev server 运行时更甚）：每笔改完立即 grep 复查；多处替换改用脚本；大改直接 Write。
- ⚠️ 空串陷阱：`to` 为空时 `includes('')` 恒真 → 删除类按行号。CRLF 锚点须自适应行尾。`node -e` 转义易崩 → 用脚本文件。
- 审计纪律：「数据丢失」级结论**必须回源码验尸**，先对照 Bug 清单。🔴 实弹会读到真实 apiKey（先告知老大；绝不落盘/提交）。
- JSX：`{/* */}` 不能放属性位置，`//` 可以。

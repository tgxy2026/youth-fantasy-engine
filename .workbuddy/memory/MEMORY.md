# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。

## 项目身份与红线
「青春幻想引擎」Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。**当前 2.0.0（2026-09-04 收官发布：桌面84.6MB+便携8.85MB，仅发桌面/便携，网页版已关服待处置）**。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。
- 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。**2.0.0 已收官（2026-09-04）**；后续版本节奏＝约每月更新一次（老大同日定），重大改动再单独封装，平时以内容创作与小幅优化为主。
- 提交含 `!` 用 `git commit -F <文件>`。main 无远程。
- 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
- 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
- 服务器属主 `/var/lib/yfe` 须 www-data；sudo 写后必 `chown`+`sudo -u www-data test -w`。

## 版本号
- 唯一源＝`package.json` version。展示用 `APP_VERSION_LABEL`（v2.0.0／兜底「开发版」），`env.ts` 转出。
- 🔴 dev 下 `define` 不替换 `__APP_VERSION__`；`vite.config.ts` 已加 `injectAppVersion()` 补 dev 替换。
- 老大口径：不加 dev 角标；「开发版」＝跑在开发服务器上。

## 封装/构建坑
- 🔴 桌面 `build-desktop.mjs` 的 `ELECTRON_CACHE` 须指向系统默认缓存 `C:/Users/<用户>/AppData/Local/electron/Cache`，**切勿**指向 `release/eb-cache/electron-zip`（仅扁平 zip、缺 @electron/get hash 结构）→ 离线打不出 electron 运行时，只产 ~500KB NSIS 空壳、双击无法运行（b3e5c4f 曾误判成功，2026-09-04 修正 f085dc9）。
- 桌面/便携正常产物体积：桌面安装包 **80.68 MiB**（Windows 资源管理器显示「80.6M」；十进制记作 84.6MB——三者是同一个文件，别误判成两个包）、便携单文件 **8.44 MiB**。🔴 两个构建脚本已内置体积闸门（`MIN_SETUP_BYTES=50MB` / `MIN_PORTABLE_MB=5MB`），**无论 builder 退出码是否为 0，体积不达标即 abort**——别再退化回「exe 存在即成功」的兜底（2.0.0 曾因此放行 513KB 空壳）。
- ⚠️ Edit 工具会「假成功」：2.0.1 给 build-desktop.mjs 补 `statSync` 导入时回执 Success 但文件未落盘，首跑直接崩在 `statSync is not defined`。**改完必须 sed/grep 复查真实文件内容。**
- rcedit `Unable to commit changes` 是 cosmetic 报错，非真失败（exe 已含 metadata）。
- 🔴 NSIS 安装权限（2026-09-04 决策 ae08e7d）：`nsis.perMachine:false` + `allowToChangeInstallationDirectory:false` → 强制按**当前用户**装到 `%LOCALAPPDATA%\Programs`，重装永不需管理员。`perMachine:true`（装 Program Files）或用户自选 Program Files 会在重装时被旧 per-machine 卸载拦住、必须管理员——这是系统级限制改不了。**升级提示已写进 AboutPage**：旧版在 Program Files 的用户需「右键→以管理员身份运行」一次新版安装包完成迁移，之后即可免管理员重装。切勿为"免提权"把 `allowElevation` 设 false（遇 per-machine 旧版会直接升级失败而非弹管理员）。

## 架构红线
- 无 i18n 基建（全中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake 陷阱：组件只在某平台门控分支被引用→其余平台摇掉整模块。渲染门控须「需该模块平台之并集」。
- 左下角只准一个浮层 `DataDock`（项目管理页）；项目内禁用全局 fixed 浮层，一律内嵌 Sidebar Footer。
- 种子：卡片 data 键=`模块名::字段名`、表格行键=schema 列名；改种子必跑 `node tests/seed-schema-check.mjs`。
- `WEB` 由 `__WEB__` 决定，禁写 `!PORTABLE && !DESKTOP`；顶层副作用双守卫（平台 `if(WEB&&...)`+功能 `if(!code)return`）。
- 🔴 编辑器双图层（NovelEditor.tsx）：`highlightOn` 开启时 textarea 设 `color:transparent`，**肉眼所见文字全来自同级 `highlightRef` 叠层**（dangerouslySetInnerHTML）。改编辑器必守三条——① 叠层与 textarea 盒模型**逐项一致**（同为 `inset-0` + `px-6/8` + `pt-6` + `pb-[40vh]`，任一侧改 padding 必须同步改另一侧）；② 叠层重建会把 scrollTop 归零，凡 highlightHTML/切章/字号/页宽/专注/检索栏变化**必须**用 `useLayoutEffect` 回填同步（2.0.1 修的"滑动不显示文本"即漏此条）；③ 高亮扫描只走 `scanRefHighlight` 单次正则，**禁止再写 `filter(x=>text.includes)` 双扫**（长章卡顿根因），超 `HIGHLIGHT_MAX_LEN` 自动降级。切章需同步 `setDeferredContent`，勿等防抖。

## 三端存储（数据丢失风险）
- 桌面：`AppData\Roaming\novel-studio\novel-studio-data.json`（目录名取 package.json `name`），整库一 JSON，防抖 800ms 重写。⚠️ 勿让 WPS 云盘同步整个目录（leveldb 锁+非原子写→空库/整库丢失）。
- #033：桌面数据文件可自定义路径（`data-location.json`），`writeAtomicSync/Atomic`（刻意不留 .bak）；IPC `store:chooseDataDir/setDataPath/resetDataPath/isCustomPath`。
- 便携(FSA)：`flush()` 用 `createWritable()→write()→close()` 即 swap 语义，勿重复 tmp+rename。薄弱点＝末批编辑来不及落盘，已加 `flushNow()`+`visibilitychange/pagehide` 尽力而为。

## 同步方案
- 判据：过服务器→要码（鉴权+密钥）；云盘→不要码（`DEFAULT_CLOUD_KEY`，文件 `青春幻想引擎-同步数据.yfe`）。
- 🔴 两路径二选一，绝不同时指向同目录（`.yfe` 与 `novel-studio-data.json` 打架）。
- ⚠️ 架空陷阱：`enableDesktopCloudSync` 仅 `rev===0 && 空` 播种；云盘有数据则第二台原稿不播种但本地 JSON 仍在→救法＝关云盘同步切回本机。
- ⚠️ 轮询盲区：A 写完关机云盘未传完→B 读旧 rev→直接覆盖 A 不报冲突。「换设备前先关软件+等同步完成」硬纪律。

## 2.0 只发桌面/便携（网页版后续关闭）
- 桌面/便携零联网（API 全被 `WEB &&` tree-shake）。2.0 只发这两版。
- 🔴 #031：自动备份写在**同一存储**（容器没了备份跟着消失），只防改坏、防不了容器丢，须**导出外部文件**。`BackupReminder.tsx`+`lib/backupReminder.ts` 三端通用，>7 天未导出且静默期(7天)过且有数据才提示；三处导出成功调 `markExported()`。关服公告 `SHUTDOWN_NOTICE` 已在 2.0.0 填入「网页版 2026-09-29 08:49:53 停止服务」(非空即置顶高亮)，#031 已闭环。
- 分发网盘（夸克，长期有效）：链/码/口令见 `AboutPage.tsx` 三常量。换版只传新安装包。
- 复制交互统一 `copyText()`（clipboard→execCommand→toast 报错，绝不静默失败）。

## UI 规范
- Button.tsx 套尺寸 primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；裸图标传 `iconOnly`。
- 8 套主题 `<html data-theme>`；浅色 4=护眼/羊皮卷/青花/桃笺，禁低透明度 amber 表数据（用实色 `bg-amber` 最低 `/40`）。
- 🔴 **SVG 里用 CSS 变量必须走 `style`，不能写表现属性**：`fill="rgb(var(--x))"` / `stroke="rgb(var(--x))"`
  **一律无效**（表现属性不做自定义属性替换）→ 回退为黑，而且**静默不报错**。
  必须写 `style={{ fill: 'rgb(var(--x))' }}`；含 var() 的动态色（如 `const col = 'rgb(var(--a))'` 再传下去）同理。
  2026-09-14 全项目扫出 3 处受害者（RelationGraph 边标签底板、WritingGoals 燃尽图网格线与轴标签、
  琥珀目标线），均长期与主题无关地渲染成黑。**新增/修改任何 SVG 绘制前先看这条。**
- 图谱/画布界面色（网格点、节点填充与文字、常态描边、连线标签、文字光晕、高亮/选中/高亮文字）
  统一走 `--graph-*` 变量（`src/index.css`）：暗色系取原暖褐值（观感不变），浅色主题引用各自 ink 刻度自动翻转。
  ⚠️ 分类色盘（关系类型色、势力关系色、节点调色板、画布类别色）是**数据分类色**，靠色相区分，**不要主题化**。

## AI / 服务器
- AI：颉文姬5模式 clinic/edit/review/brief/ledger；硅基流动 DeepSeek-V3.2。明文本地记忆勿公开。
- AI 返回解析：**统一走 `src/lib/aiParse.ts`**（2026-09-14 收敛，此前有 3 份重复实现）。
  导出 `parseObjectArray`（数组 / 单对象 / `{list:[…]}` 三形态归一化）/ `parsePlainObject` / `hasSubstance` / `asText` / `humanText`。
  🔴 勿退回"先按 `[` 切片"的老写法——单对象会被解析成非数组对象后在 `Array.isArray` 处判失败返回空，
  导致内容全丢、退 `humanText` 兜底（2.0.1 修的"改稿只剩标点"）。**也禁止再手写裸 `JSON.parse` 解析模型输出**
  （模型一裹解释或加 ```json 围栏就整条丢弃）。失败时用 `hasSubstance` 拦垃圾。
  ⚠️ `hasSubstance` 目前**只在 aiRewritePassage 一处**生效，其余约 10 处兜底仍直接回 `humanText` 残骸（现状已注明，未擅自推广）。
- 🔴 **迁移只走 `db.runMigrations()`**（types → ledger → numbering，幂等）：boot 恢复上次项目与手动 openProject
  必须共用它。历史坑：boot 路径曾漏跑 ledger/numbering 导致自动回到项目时读到旧结构。**顺序不可调换**
  （numbering 依赖 ledger 拆表后的 `chapter-vol-<卷id>` 行）。db 层不引用 schema（避免循环依赖），
  刷卷页签由调用方另行 `refreshVolumeTabs()`。
- **跨文件共用的 localStorage 键 / 防抖常量**收在 `src/lib/constants.ts`（`LS_*` / `SAVE_DEBOUNCE_MS` / `SYNC_POLL_MS`）。
  新增键改这里一处，别在调用点写字面量——改错键名会让用户偏好静默重置且无报错。
- 🔴 温度（2026-09-14 起机制变更）：**不要在任务层手填温度**。结构化 JSON 任务传 `chat(..., { json: true })`，
  由 `ai.ts` 的 `chat()` **统一解析**为 `JSON_TASK_TEMPERATURE`(0.3)；创意类不传即 `DEFAULT_TEMPERATURE`(0.85)。
  历史坑：20 处调用里 19 处漏传温度、静默跑在 0.85，而注释却写着"必须传低值"——**靠自觉的"可选参数"必然漏**，
  故改为语义开关 + 上游唯一真源（`CallOpts.temperature` 已改必填，下游无第二个兜底点）。新增 AI 任务时务必带 `json: true`。
- 服务器 `154.8.178.240`(腾讯云 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口22) ubuntu+免密sudo。站点 `/var/www/yfe`；反馈 `/opt/yfe-server/feedback-server.mjs`。码/详情见 `docs/服务器访问记录.md`。
- 网页部署流程：本地 `vite build --config vite.config.web.ts`(→`dist-web`) → tar 打成单包 → scp 到服务器 `/tmp`（**走 /tmp 中转，避免 scp 套娃）→ `sudo cp -a` 备份旧版 → 清旧 assets/index.html → 解包 → `chown -R www-data:www-data` → `sudo -u www-data test -w` 验收。
- 🔴 部署校验陷阱：Nginx 配了 SPA 回退，**任意不存在的路径都返回 200 + index.html**——旧 chunk 名照样 200，**绝不能用 HTTP 200 判断资源是否上线**。必须核对 `Content-Length` / `Content-Type` / `Last-Modified` 与首字节内容（新 chunk 首字节应含 `__vite__mapDeps` 及新依赖名）。

## 工程质量与验证（2026-09-14 起）
- **命令**：`npm run verify`（= typecheck + lint + test，退出码 0 即全绿）/ `npm test` / `npm run lint`。
- **测试 runner**：`tests/run-all.mjs` 自动发现 `tests/*.test.ts` + `seed-schema-check.mjs`。
  🔴 **每个入口必须单开子进程**——`roundtrip.test.ts` / `adversarial.test.ts` 结尾是 `process.exit()`，同进程串跑会被直接掐死。
- **ESLint**：`eslint.config.js` 扁平配置（ESLint 9 + typescript-eslint 8），**只开 3 条**：
  `rules-of-hooks`(error) / `exhaustive-deps`(warn) / `no-empty`(warn)。`no-explicit-any` **显式关闭**
  （存量 100 处会淹没 12 条真信号）。当前 **12 warnings / 0 errors**，即 C/D 批的工作面。
- ✅ **`package-lock.json` 已于 2026-09-14 同步**（补齐 eslint 四依赖）。
  🔴 **同步 lock 的正确命令：`npm install --package-lock-only --offline`**——只重算依赖树并写 lock、
  不碰 node_modules，**2 秒**完成；而 `--prefer-offline` 完整装包会联网核对元数据、跑到 9 分钟仍未收尾。
  验证自洽性看**幂等**：二次运行应输出 `up to date` 且 diff 无新增。
  ⚠️ 重算后若出现「删除行」先别慌：逐条判断是**原位元数据重写**还是**真移除**，并核实是否真有代码依赖
  （2026-09-14 即据此确认裁掉的 `playwright-core` 是历史悬空依赖、全仓库无人引用）。
- 🔴 **`exhaustive-deps` 那 11 条警告不能盲改**（2026-09-14 逐条核实）：缺失的依赖**全是组件体内未包
  `useCallback` 的普通箭头函数**（`load` / `calValueOf` / `validateCodes` / `cellVal` 等），身份每次渲染都变。
  直接补进依赖数组会让 `useMemo` 每次重算、`useEffect` 可能死循环。**正确解法是先包 `useCallback` 再加依赖**，
  属逐例判断 + 需跑起来验证，别当成"顺手改改"。

## 本机环境坑（Windows + Git Bash，务必绕行）
- `git` **不在 PATH** → 用 `C:/Users/18223/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe`。
- `npm` shim 坏（输出乱码 + 触发 WSL 黑名单）→ 绕行 `"<托管node>/node.exe" "<托管node>/node_modules/npm/bin/npm-cli.js" <命令>`。
  🔴 路径必须写 **`C:/...` 正斜杠**；写 `/c/...` 会被 Git Bash 转成 `G:\c\Users\...` 而报 MODULE_NOT_FOUND。
- Windows 自带同名程序会抢掉 Unix 工具：**`sort.exe`**（`sort -rn` 报「找不到文件」）、**`timeout.exe`**；
  `find ... -o ...` 在 Git Bash 报「参数格式不正确」→ 改用 `wc -l src/lib/*.ts`（**不接 sort**）/ `ls` / Glob 工具。
- 本会话 PowerShell 工具**无输出返回**，别依赖它。
- 🔴 审计纪律：**「数据丢失」级结论禁止直接转述子代理**，必须回源码逐行验尸；
  且要先对照 `docs/1.9.6-2.0.0_Bug与待优化清单.md`——已有 4 条被当成「新发现」，实为 #034 等已登记的已知取舍。

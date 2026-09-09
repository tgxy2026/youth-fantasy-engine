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

## AI / 服务器
- AI：颉文姬5模式 clinic/edit/review/brief/ledger；硅基流动 DeepSeek-V3.2。明文本地记忆勿公开。
- AI 返回解析：统一走 `parseObjectArray`（已支持数组 / 单对象 / `{list:[…]}` 三形态归一化）。🔴 勿退回"先按 `[` 切片"的老写法——单对象会被解析成非数组对象后在 `Array.isArray` 处判失败返回空，导致内容全丢、退 `humanText` 兜底（2.0.1 修的"改稿只剩标点"）。JSON 类任务统一传 `JSON_TASK_TEMPERATURE`(0.3)，创意类维持 `DEFAULT_TEMPERATURE`(0.85)；失败时用 `hasSubstance` 拦垃圾，别把残骸塞给作者。
- 服务器 `154.8.178.240`(腾讯云 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口22) ubuntu+免密sudo。站点 `/var/www/yfe`；反馈 `/opt/yfe-server/feedback-server.mjs`。码/详情见 `docs/服务器访问记录.md`。
- 网页部署流程：本地 `vite build --config vite.config.web.ts`(→`dist-web`) → tar 打成单包 → scp 到服务器 `/tmp`（**走 /tmp 中转，避免 scp 套娃）→ `sudo cp -a` 备份旧版 → 清旧 assets/index.html → 解包 → `chown -R www-data:www-data` → `sudo -u www-data test -w` 验收。
- 🔴 部署校验陷阱：Nginx 配了 SPA 回退，**任意不存在的路径都返回 200 + index.html**——旧 chunk 名照样 200，**绝不能用 HTTP 200 判断资源是否上线**。必须核对 `Content-Length` / `Content-Type` / `Last-Modified` 与首字节内容（新 chunk 首字节应含 `__vite__mapDeps` 及新依赖名）。

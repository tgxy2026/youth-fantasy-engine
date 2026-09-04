# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。

## 项目身份与红线
「青春幻想引擎」Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。当前 **2.0.0**。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。
- 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。**不封装，版本号停在 2.0.0**。
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
- 桌面/便携正常产物体积：桌面安装包 ~84MB、便携单文件 ~8.4MB；发现 <1MB 即空壳失败，不能靠「exe 存在」兜底判成功。
- rcedit `Unable to commit changes` 是 cosmetic 报错，非真失败（exe 已含 metadata）。

## 架构红线
- 无 i18n 基建（全中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake 陷阱：组件只在某平台门控分支被引用→其余平台摇掉整模块。渲染门控须「需该模块平台之并集」。
- 左下角只准一个浮层 `DataDock`（项目管理页）；项目内禁用全局 fixed 浮层，一律内嵌 Sidebar Footer。
- 种子：卡片 data 键=`模块名::字段名`、表格行键=schema 列名；改种子必跑 `node tests/seed-schema-check.mjs`。
- `WEB` 由 `__WEB__` 决定，禁写 `!PORTABLE && !DESKTOP`；顶层副作用双守卫（平台 `if(WEB&&...)`+功能 `if(!code)return`）。

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
- 服务器 `154.8.178.240`(腾讯云 Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(端口22) ubuntu+免密sudo。站点 `/var/www/yfe`；反馈 `/opt/yfe-server/feedback-server.mjs`。码/详情见 `docs/服务器访问记录.md`。

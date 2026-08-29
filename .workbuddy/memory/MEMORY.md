# novel-studio 长期记忆（MEMORY.md）

## 项目身份
「青春幻想引擎」小说创作管理应用。Electron 31 + React 18.3 + TS 5.5 + Vite 5.3 + Tailwind（ink/amber 护眼主题）。三存储后端（IndexedDB/便携/桌面）经 `StoreOps`。dev http://localhost:5199/，managed node `C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`（勿用全局）。

## git 基线（2026-08-28 起）
- 本地仓库已 init（main，无远程），.gitignore 排除 node_modules/dist/release/build。基线提交 5e385dc。
- **每轮审计/封装完成后 `git add -A && git commit`**，提交信息写清本轮修复要点。

## 数据安全测试（tests/）
- `node tests/build-test.mjs adversarial|roundtrip`：esbuild 打包真 db.ts+seedData，内存 StoreOps 桩替换 portable/desktop。roundtrip 6 用例（导出/导入往返语义一致、迁移幂等×3、编号正确）；adversarial 24 用例（chapterSeq 边角、audit 纯函数、autoCode、AI 上下文截断/跨卷、章节清单截断与孤儿章、continuityCheck+dataHealth 喂畸形数据）。**改动 db.ts / audit.ts / chapterSeq / aiContext / 迁移逻辑后必跑两条。**
- 已修复的数据丢失级 bug：migrateChapterLedger 迁移后误删台账行（movedIds 修复）；importProject 未重映射卷台账 tabId（已修）。**凡新增导出/导入/迁移逻辑，先补 round-trip 用例再上线。**
- AI 输出渲染已审计安全：markdown 报告走 React 文本节点转义、高亮叠层 escapeHtml 全程覆盖。
- 坑：'chapter-vol-' 是 **12** 字符；slice(11) 是 off-by-one。

## 封装红线（无 git 仓库，最高优先级）
- 封装前必确认：① `tsc --noEmit` 0 错 ② `vite build` 0 错 ③ 改动落盘。**切勿直接打包未验证**。
- 封装标准流程（顺序不可乱）：① 全面代码审查（修 bug/剔除冗余）② 升 `package.json` 的 `version` ③ 启动封装。未审查完、未升版本，禁止封装。
- 封装时只改 `package.json` 的 `version`，build 脚本动态生成 exe 名/outDir/标题。
- 版本显示：dev 恒显「开发版」（`vite.config.ts` 注入），build 注入真实版本；`src/lib/portable.ts` 回退值 `'开发版'`。
- G 盘 safe-delete 拦截 `rmSync`/`unlink`：vite build 前先 `mv dist dist.oldbak`；永久删目录用 `command rm -rf`（仅项目内非源码）。⛔ 禁删 `release/eb-cache/`。
- 封装后清理源码目录临时文件（`dist.oldbak`/`dist_bak_*`）。

## 项目硬规则
- 📁 工作区根目录 `你需要的图片我放在这里/` 为用户放图专用，**禁止删除**。
- ⛔ 禁用浏览器原生 `window.prompt/confirm/alert`；输入走 `PromptModal.tsx`，确认/轻提示走 `dialogs.tsx` 的 `confirmDialog()` / `showToast()`。
- ⚠️ **本机 Edit 工具坑**：G 盘 safe-delete 拦截致「首编辑偶发失败、成功可能未落盘」——改完务必 `tsc --noEmit` + 抽查文件复核。
- 🔁 一轮活干完若 dev 没跑，顺手起后台；探活期望 `200`。

## 版本现状
- 1.8.0 手绘地图+地理联动；1.9.0 灵感工具拆分+检查工具+ErrorBoundary；1.9.1 表头筛选/按卷建表/补登模式/示范项目卷二。
- **1.9.2（2026-08-28）**：章节名与顺序解耦——`src/lib/chapterSeq.ts` 为顺序唯一权威（全派生不落库）；`Chapter.excludeFromNumbering` + Hash 开关；continuityCheck 不再解析标题；`migrateChapterLedger`/`migrateChapterNumbering` 已接入 openProject。同日四轮审计（日常/联动/AI喂数/数据安全）修复：doAddChapter stale state、migrateChapterLedger 迁移后误删台账行、importProject 未重映射卷台账 tabId 等。
- **1.9.5 / 1.9.6（已封装，2026-08-28）**：1.9.5 = 解耦 + 四轮审计修复 + 两条节奏预警 + 打赏页素材落地（f49c2b9/b448115）；1.9.6（206588b）= 打赏页终稿（简介勘误「加群」、码图去文字标注）。产物：`release/novel-studio-1.9.6/`（便携 8.22MB）+ `release/桌面安装版/青春幻想引擎-Setup-1.9.6.exe`（81MB）。⚠️ 同版本重打包前必须手动清空 `release/novel-studio-<ver>/`（vite emptyOutDir 撞 safe-delete）。
- **版本路线图（作者定档，2026-08-28）**：1.9.6 试用 1~2 周收集问题/bug → 2.0 发布前统一批量处理 → 启动 2.0 最终工程（源码加固 javascript-obfuscator/asarIntegrity/bytenode + 功能讲稿，触发词「开工2.0」）。**试用期内不动源码，等作者问题清单。**
- **1.9.6→2.0.0 问题清单约定（2026-08-29 起）**：专用文件 `docs/1.9.6-2.0.0_Bug与待优化清单.md`。老大反馈 Bug/待优化 → 老巴迪**仅做单独记录（编号/类型/模块/描述/严重度/状态）**，绝不擅自改源码；只有当老大明确说"处理/修一下/批量处理"时才动手，处理动作回填「处理结果」列并同步统计。状态：`待处理/已处理/已拒绝`；严重度：`P0 阻断/P1 高/P2 中/P3 低`。
- **#001 跨设备同步 已定方向（2026-08-29）**：方案A先上——桌面版数据文件路径改可配置（默认 AppData，可指向 OneDrive/坚果云同步目录），便携版直接指同步文件夹，零后端零账号；2.0 补方案B冲突备份（StoreOps 同步层+按记录增量+version/deviceId+双向冲突存 .conflict）。设计须兼顾图片外置纳管、settingsKV 明文 AI key 排除/加密、旧版开新版 JSON 向后兼容。

## 1.9.1 自定义项目架构
- 创建入口「完整项目/自定义项目」二选一；精简/极简仅保留旧项目打开。
- `Project.projectType:'custom'` + `features:string[]`。`schema.ts`：`VisCtx`、`FEATURE_TIER`、`LOCKED_IDS`、`DEFAULT_IDS`、`STRONG_DEPS`、`resolveFeatures`、`tabVisible(tabId,ctx)`（custom 查 features；full 全显）。
- 全局基础设施（备份/检索/设定检索）始终常开，不进勾选列表。示范项目 `createDemoProject` 必须 `projectType:'full'`。

## 架构速查（避坑）
- **按卷建表**：台账层卷表 Tab id `chapter-vol-<volumeId>`（`VOLUME_LEDGER_PREFIX`）；`refreshVolumeTabs()` 合成 TabDef；`db.getAllChapterLedgerRows()` 聚合各卷表（各检查/AI 调用点统一走它）；`purgeLedgerRowEverywhere`；`restoreFromTrash` 写 `chapter-vol-<vid>`；Sidebar `chapter-master` 可展开卷子项。
- **章节顺序**：`chapterSeq.ts` 按期望排序；台账行 `order` 经 `syncChapterMaster(,,narrativeIndex)` 恒等于真实叙事序；「不计入序号」章排除序号但台账章节号保留手填。
- 列助手 `c/cn/cH/cr`（text/number/hidden/crossRef）；`TableColumn.type`：text|select|date|number|textarea|calendar|character|characters|tableRef。
- ⚠️ **下拉选项「单一口径」红线**：列出下拉候选值禁止直接用 `col.options`，必须 `resolveOptions(col.options, await getCustomOptions(tabId, colName))`（`CustomSelect.tsx`）。已落地：表头筛选/AI 整理/行内下拉。改选项后 `CUSTOM_OPTIONS_EVENT` 广播。
- 🎨 图标语义：`Sparkles`=AI 专用；`Stethoscope`=诊室/数据体检；`Wand2`=AI 编辑改写；`Pencil`=手动编辑；`Lightbulb`=灵感素材。
- ⚠️ **`!tabVisible` 判定口诀**：只允许出现在「守卫 return」或「构造隐页签集合」；赋给 `showXxx` 或条件包含的一律是 bug（已三次踩坑）。
- 历法：项目级 `calendars[]` 默认 `[{灵历,0}]`；跨历法顺序 = `calValue*1e10 + storyTimeKey`。
- 关键组件：`CalendarPicker`(Portal z-[9999])、`CharacterSelect`(禁手输,多选)、`CalendarSelect`、`AutoTextarea`、`StoryDateInput`、`HelpPopover`。
- 地理联动（1.8）：foreshadow/timeline 有 `cr('地理位置','geography','名称')`；地图叠加层只精确匹配。
- 颉文姬建议段模式：`【颉文姬建议·开始/结束】` 标记块，续写/审读只给方向；摘要按 ~1/10 压缩。桌面精灵 `JieWenJiSprite.tsx`（App.tsx 仅打开项目后渲染）。
- 数据更新：TableSheet 切页签即重读库；跨表引用按名存字符串，无级联改名（数据体检兜底 `dataHealth.ts:runDataHealthCheck`）。
- 行跳转：`yfe:navigate {tabId,rowId}` 事件；`yfe:volumes-changed` 卷变更广播。
- 📌 **「AI 抽取 + 代码判重」分层铁律**：存在性判断一律确定性代码比对（`normName`/`rowFingerprint.norm` + `readAliases`），AI 只抽候选。参考 `settingLedger.ts`；表格自动编号唯一来源 `autoCode.ts`（`nextAutoCode`）。
- 角色卡三张字段结构不同（`char-main`/`char-secondary` vs `char-npc`），写卡用 `settingLedger.cardFieldPath()` 按优先名探测，勿硬编码。

## AI 接入（1.5.0+）
- **颉文姬 5 模式**：`clinic` 诊室 / `edit` 编辑(选区改稿→建议段) / `review` 审读 / `brief` 简报 / `ledger` 补登(抽实体→比对→三档→勾选写入)。
- 本地 Ollama + 联网 OpenAI 兼容（`src/lib/ai.ts` / `AIAssist.tsx`），统一 `testProvider()` + `chatRaw()`。**硅基流动**：`https://api.siliconflow.cn/v1`，模型 `deepseek-ai/DeepSeek-V3.2`。⚠️ 明文本地记忆，勿提交公开仓库。

## Web 部署 / 网页体验版（2026-08-29 定案）
- 已确认 `src/lib/db.ts` 存在纯浏览器 IndexedDB 后端 `idbOps`（路由：`PORTABLE?portableStore:DESKTOP?desktopStore:idbOps`），故**纯静态网页版零后端即可跑**，数据存各浏览器本地 IndexedDB（per-origin，不跨设备）。
- 真正"任意设备登录同数据"需加轻后端+账号：新增 `serverStore: StoreOps` 实现（所有 db.ts 函数已走 `ops` 抽象，切后端组件层零改动）；MVP 可每用户存一份 `PortableData` JSON（复用 `normalizePortableData`）全量 load/save，后期再优化增量。
- 与 #001 关系：Level2 服务端托管**涵盖** #001 跨设备同步诉求，且额外获得"不装软件、输网址即用"。**已定：邀请制静态网页体验版**（数据全留浏览器+反馈通道），非 Level2 服务端托管；跨设备同步仍由 #001 方案A 负责。
- 风险/待办（均已落地）：① AI CORS → ai.ts 改走同源 /api/ai 反代 + nginx yfe_proxy_params(access_log off 不落 key) ② 已验证 web 包无 electron 真调用（仅 window.electronStore 运行时探测死代码）③ 邀请码门禁 WebGate（码仅服务端比，server/feedback-server.mjs）④ 隐私告知 PrivacyNotice。
- **#002 已上线（2026-08-29 实战部署成功）**：腾讯云轻量应用服务器 `154.8.178.240`，**实际系统 Ubuntu 24.04(nobles，脚本兼容)**。部署包 commit `2ee65ec`/`fea07c2`/`78dae14`。关键事实与坑：
  - **登录**：默认用户 `ubuntu`（root 登录禁用），`ubuntu` 有**免密 sudo(NOPASSWD)**；部署用 `ubuntu`+`sudo -n` 一把梭。本机沙箱可直连公网(22端口+出网均 OPEN)，故老巴迪可直接代部署。
  - **部署路径**：`scp -r server dist-web ubuntu@IP:~/yfe-deploy/` → `sudo bash ~/yfe-deploy/server/deploy.sh`。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs` 以 **`www-data`** 跑、端口 **3000**、数据 `/var/lib/yfe`。
  - **⚠️ 必坑（已修，commit 78dae14）**：反馈服务以 www-data 运行，启动 `mkdir /var/lib/yfe` 因 /var/lib 属 root 而 **EACCES 失败** → 在 deploy.sh 加 `mkdir -p /var/lib/yfe && chown -R www-data:www-data /var/lib/yfe` 修复；并给 nginx 补 `location = /healthz` 反代 3000/healthz（原配置只有 SPA 兜底，/healthz 会回 HTML）。
  - **验证通过**：首页 200、/healthz=ok、邀请码错 403/对 `YFE-D49E-6MPG` 200、nginx+feedback 均 active。现状 `http://154.8.178.240` 已可访问（**HTTP 无 HTTPS**；防火墙 80/443 已开）。
  - **待办**：① HTTPS 需绑域名+`sudo certbot --nginx -d 域名`（yfe.conf server_name _ 已留位）② AI 反代待真实 key 实测 ③ 反馈 POST 未实测（路由正确、服务 active）。
  - **安全**：部署时老大把 SSH 私钥贴在对话里 → 建议腾讯云控制台**重新生成密钥对**作废该 key；HTTP 下 AI key 在"浏览器→服务器"段明文，邀请制内测可接受，上域名后补齐 HTTPS。
- **#003 云端同步特权 · 已上线（2026-08-29）**：serverStore:StoreOps(fetch→/api/sync) 已落地；上行加密(HTTPS走Web Crypto AES-GCM，HTTP降级XOR混淆，rev明文)；排除 AI 配置(meta::aiProviders/aiActiveProviderId/aiConfigMigratedToGlobal)不同步；冲突 409 last-write-wins。同步码 `SYNC_CODES`(20个)在 yfe-feedback.service，每个码独立云端槽位 `sync-<sha256>.json`，避免多人共用一码互相覆盖。入门码 `INVITE_CODES`(20个)列表校验；分发文档 `docs/邀请码分发记录.md`。

## 会话窗口分工约定（2026-08-29）
- 本会话窗口**专用于「网页体验版」的升级维护**（部署/配置/邀请码/HTTPS/反馈通道等）；**新功能开发或优化另开窗口**进行，互不混用，便于各自 git 提交与上下文隔离。

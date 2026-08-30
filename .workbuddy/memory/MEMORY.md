# novel-studio 长期记忆（MEMORY.md）

## 项目身份
「青春幻想引擎」小说创作管理应用。Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储后端(IndexedDB/便携/桌面)经 StoreOps。dev http://localhost:5199/。managed node：`C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`。

## git 基线
main 无远程；每轮审计/封装后 commit，信息写清要点。
⚠️ 提交信息里含 `!` 时**必须用 `git commit -F <文件>`**，不能用 `-m`：bash 历史展开会吃掉 `!XXX`（报 `!XXX: command not found` 并把信息写坏）。

## 封装红线（最高优先级）
封装前必：tsc 0错 + vite build 0错 + 改动落盘。流程：审查→升 package.json version→封装。G盘 safe-delete 拦截 rmSync：build 前先 `mv dist dist.oldbak`；**网页构建同理，`dist-web` 也要先移开**（vite.config.web.ts 有 emptyOutDir）；禁删 release/eb-cache/。
- ⚠️ **同版本号重打包（不升版本）额外三个坑（2026-08-30）**：① 便携 outDir `release/novel-studio-<ver>` 与 `dist-web` 此时**已存在上一轮产物**，`emptyOutDir:true` 会触发 safe-delete → 必须先用 Node `renameSync` 移开（shell `mv` 不可靠）。② `dist-web` 可能被进程持有句柄导致 rename 报 **EPERM**；别硬碰，改用 `vite build --config vite.config.web.ts --outDir dist-web-<后缀>` **另开全新目录**再推送，这是最稳的通用绕行。③ electron-builder 日志出现 `rcedit ... Unable to commit changes` **不代表失败**（防病毒锁新解包 exe，重试第 3 次成功且不打成功日志）——判定法：node 读 exe buffer 搜 utf16le 的 `青春幻想引擎开发组`/`Copyright © 2026`，命中即版本资源已写入，别盲目重跑。
- ✅ **产物内容验证法（封装后必做）**：别只看体积。用 node 读产物 buffer 双向校验「应存在的新字符串」+「应消失的旧字符串」；便携查单文件 HTML、桌面查 `dist/assets/<对应chunk>.js`、线上用 `grep -rlF` 查 `/var/www/yfe/assets/*.js`。三处一致才算真上线。**dev 启动同样会中招**：报 `[safe-delete] ... node_modules/.vite/deps` 时，先 `mv node_modules/.vite node_modules/.vite.bak-<时间戳>` 再重启即可（vite 会重建缓存）。Edit 工具偶发静默失败→改完必 tsc+抽查。

## 项目硬规则
根目录 `你需要的文件在这里/`（原 `你需要的图片我放在这里/`，2026-08-29 老大重命名）禁删。禁用 window.prompt/confirm/alert（用 PromptModal/confirmDialog/showToast）。
- **清理工作区的固定打法**：先只扫描出报告（路径+体积），由老大圈定范围后才动手；绝不自作主张删。构建备份目录（dist.bak-* / dist_bak_* / dist-web*.bak* / web-build-*）是主要垃圾源，均 git 未跟踪、可安全清理。`release/eb-cache`(106M) 为 electron-builder 缓存，红线禁删。
- ⚠️ **本环境无法走真回收站**：`Add-Type`（编译 .NET）与 `New-Object -ComObject Shell.Application`（COM 实例化）双双被安全策略拦截。清理一律改用 `Move-Item` 移出到 `%TEMP%` 隔离区，效果相同且完全可逆；确认无误后再由老大自行清空。

## 架构速查（红线）
- 按卷建表：卷表 tabId `chapter-vol-<vid>`；聚合走 db.getAllChapterLedgerRows()。
- 章节顺序：chapterSeq.ts 为唯一权威(全派生不落库)。
- 下拉选项单一口径：必须用 resolveOptions(col.options, getCustomOptions())，禁直接用 col.options。
- `!tabVisible` 只可用于守卫 return/构造隐页签集合，赋给 showXxx 即 bug。
- AI抽取+代码判重分层：存在性用 normName/rowFingerprint.norm 确定性比对，AI只抽候选。
- 角色卡 char-main/char-secondary vs char-npc 字段不同，用 settingLedger.cardFieldPath() 探测勿硬编码。
- ⚠️ **模块顶层副作用必须加 WEB 守卫**：serverStore 顶层的 pagehide/beforeunload 监听曾泄漏进桌面/便携版（db.ts 是静态 import），导致关窗口白跑 PBKDF2 + file:// 下注定失败的 fetch，且使整模块无法 tree-shake。加 `if (WEB && ...)` 后主包 675KB→658KB。新增任何"仅网页版"的顶层代码同理。
- ⚠️ **"从源数据重建本地草稿"的 effect 必须防脏覆盖**：依赖数组里含源数据（如 records）时，源数据因"其它项增删改"而变化、而当前项未切换，就会用库里的旧值静默覆盖未保存编辑。重建前先判断 `草稿id===当前id && dirty`，脏则直接 return。：`WEB` 由 `__WEB__` define 决定（仅 vite.config.web.ts 为 true），绝不可写 `!PORTABLE && !DESKTOP` —— dev 在纯浏览器跑时二者同为 false 会被误判成网页版（2026-08-30 血案：dev 被邀请码门禁拦住，且 AI 走 /api/ai 反代失效、云端同步误初始化）。新增任何"仅网页版"逻辑一律以 `WEB` 为准，别再造取反式。

## 主题系统（2026-08-30）
- 换肤机制：`<html data-theme>` + index.css 变量，组件零改动。每套主题 = 12 档 ink(950~50) + amber/amber-soft + color-scheme。
- ⚠️ **浅色主题 ink 刻度反向**：ink-950=页底(最浅)、ink-100=正文(深)、ink-50 最深；深色主题反之(950 最深→50 最亮)。新增主题极易搞反。
- ⚠️ 既有浅色刻度 850(分隔线) 比 800(输入框底) 略深一档，属既定设计语言非 bug；新增浅色主题须复刻该结构保持一致。
- 新增主题三件套：theme.ts(ThemeId 联合类型 + THEMES 表) + index.css(变量块) + Sidebar 色块行(须 flex-wrap，8 个 20px 色块约 202px 会挤爆 224px 侧栏)。
- ⚠️ CSS 压缩器会去掉属性选择器引号：产物里是 `[data-theme=x]` 而非 `[data-theme='x']`，grep 验证产物时注意。
- 当前 8 套：暗夜/护眼/午夜蓝/羊皮卷/暮山紫(深紫)/青花(浅青白)/松烟墨(深墨绿)/桃笺(浅暖粉)，深浅各 4 套。

## AI 接入
颉文姬5模式(clinic/edit/review/brief/ledger)。硅基流动 deepseek-ai/DeepSeek-V3.2；明文本地记忆勿公开。

## 版本与清单
- **1.9.8 已封装（2026-08-30）**：便携 8.65MB（release/novel-studio-1.9.8/）+ 桌面 84.5MB（release/桌面安装版/青春幻想引擎-Setup-1.9.8.exe），网页版已同步上线 154.8.178.240（线上确认 1.9.8）。含：AI 续写去 AI 味儿环节（内置提示词库+面板开关）、去味偏好永久保存（db.meta）、续写上下文补最近3章摘要、章节名自动延续编号、章节摘要升级 1/10（种子已烤入）、UI 长条按钮统一为短圆角、去味开关前置到策略下、代码审查加固。
  - **同版本号重封一次（2026-08-30 16:5x，三端已刷新）**：追加固化两处修复——去味模板改名（口语化/网文化/去套路）、使用指南「全部功能页签」名称竖排错乱根治（`GuidePage.tsx` 外层 `variant="bare"` 按钮改 `flex-col items-stretch w-full`；根因是 Button 基类 `inline-flex items-center justify-center` 把名称行与描述横排、CJK 被挤到逐字断行——**只改内层 span 的 `flex-1 min-w-0` 无效，必须改外层按钮排版方向**）。三端产物已 buffer 校验含新标签且旧标签为 0。
- **1.9.7 已封装（2026-08-30）**：便携 8.22MB（release/novel-studio-1.9.7/）+ 桌面 80.6MB（release/桌面安装版/青春幻想引擎-Setup-1.9.7.exe），网页版已同步上线 154.8.178.240。含：四套新主题、开发版邀请门禁误拦修复、1.9.7 终审三项修复。**1.9.7 是桌面/便携版首次把网页体验版代码（serverStore 等）编译进产物**。
- 1.9.6 已封装（2026-08-28）：便携 8.22MB + 桌面 80.6MB。
- **2.0 Web 部署计划（已定·A 方案，本轮测试期不做）**：网页体验版在 2.0 阶段绑定域名 `qchxengine.cn`（建议小写），走 Let's Encrypt 真证书替换当前自签 HTTPS；大陆节点需先 ICP 备案（非经营性，免费，1-15 工作日；前提服务器包月≥3月且剩余≥30天、域名境内注册商实名）。**本轮测试期维持 `https://154.8.178.240` 自签 HTTPS + IP 访问，不买域名、不备案、不动证书**，等测试问题/bug 修复完、2.0 启动再执行（届时老巴迪装 certbot、改 yfe.conf server_name、签发真证书）。
- 问题清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录不处理，明确说"处理"才动手(状态待处理/已处理/已拒绝；严重度P0~P3)。
- ~~#001 跨设备同步：方案A(云盘同步文件夹)先上，2.0补方案B冲突备份。待处理。~~ → **已拒绝（2026-08-30 老大决策）**
- **产品方向（2026-08-30 定，勿再反复）**：**桌面版/便携版 = 纯本地使用**，数据由用户自行备份管理，**不做跨设备自动同步**（不为云盘适配去啃文件锁/冲突/延迟）。**跨设备需求统一收敛到网页版云同步一条线做深做稳**。清单 #001 已标「已拒绝」；#005（冲突备份）随之待重新定位，建议转网页版专用（本地优先合并会静默丢云端改动，应存 `.conflict` 副本）。

## 网页体验版/Web部署（2026-08-29）
- 纯静态网页版零后端即可跑(idbOps,数据留浏览器)。邀请制，反馈通道走服务器。
- 服务器 `154.8.178.240`(腾讯云轻量,Ubuntu24.04)。SSH 私钥长期存 `C:\Users/18223\.ssh\yfe_test_server`(600,仓库外)；登录 ubuntu+免密sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`(www-data,端口3000,数据 `/var/lib/yfe`)。
- ⚠️ 装机必做：`feedback-server.mjs` 改后必须 `sudo cp ~/yfe-deploy/feedback-server.mjs /opt/yfe-server/` 再 `sudo systemctl restart yfe-feedback`（漏拷JS→路由404）。nginx 改后 `sudo nginx -s reload`。
- ⚠️ **属主红线（2026-08-30 血泪）**：`/var/lib/yfe` 目录属主 `www-data`，服务也以 www-data 跑。**任何对其中文件的 sudo 写操作（cp/mv/vi）都会把属主变成 root**，导致 www-data 只有读权限 → 云端 push 静默失败。用完 sudo 必须补 `sudo chown www-data:www-data /var/lib/yfe/<file>`，并用 `sudo -u www-data test -w <file>` 实测。老大槽位就是这么中招的（#009，推送"假成功"一整天）。
- **排障信条**：云端同步类故障**不能只看 access.jsonl**。日志记 `push ok` 不等于落盘——必须核对槽位文件的 `rev` 与 `mtime`。`feedback-server.mjs` 已加启动自检 `write-probe` + 写盘失败返回 500 并记 `pushfail`，不再静默吞异常；另有按槽位串行写锁 `withSlotLock` 防并发覆盖、tmp+rename 原子落盘。
- HTTPS：自签证书 `/etc/ssl/yfe/yfe.crt+key`(365天)；`https://154.8.178.240` 已200，浏览器警告→继续访问。安全上下文下 serverStore 走真AES-GCM(a1:)，HTTP降级XOR(x1:)，旧数据向后兼容。
- #003 云端同步特权已上线：serverStore(StoreOps, fetch /api/sync, 800ms防抖, rev守卫, 排除meta AI配置)。20个同步码各独立槽位 sync-<sha256>.json；20个入门码列表校验。分发文档 `docs/邀请码分发记录.md`。入门码 YFE-D49E-6MPG。

## 服务器反馈巡检约定（2026-08-29）
- 反馈落盘 `/var/lib/yfe/feedback.jsonl`(每行JSON: id/ts/ua/ip/text/hasFile)，原始附件 `fb-<id>.bin`。老巴迪可直接读，无需用户下载。
- **访问/登录流水**：`/var/lib/yfe/access.jsonl`(每行 id/ts/ip/ua/type/ok/act, act∈enter/reject/pull/push/authfail/conflict；sync 含 code=槽位hash 或 rev)。每次邀请校验/同步调用均落盘，IP 经 nginx X-Real-IP 取真实访客。查看渠道 `docs/服务器访问记录.md`（每日概览表+明细）。
- **老巴迪职责**：每日巡检 automation(automation-1787973377664) ssh 拉 feedback.jsonl+access.jsonl，分别归档到 `docs/服务器反馈记录.md` 与 `docs/服务器访问记录.md`，与老大共判如何处理/谁来了。
- **巡检实操（2026-08-30 首跑定型）**：日志上百行别肉眼数——`ssh > 临时jsonl` 后写 node 脚本重建整份 md（明细+概览表**累加**+last_id），用完删临时目录。ts 是 UTC，概览按本地日期分组必须 +8h。脚本产出的推测结论**必须人工复核后改写**再落盘。
- **同步码白名单**：服务端 `SYNC_CODES`(systemd yfe-feedback.service) 共 20 个，旧码 `YFE-SYNC-7Q3K-2X9M` 仍有效；每码独立槽位 `sync-<sha256>.json`。排查 401 前先 grep 确认白名单，别急着假设"换码致失效"。
- **访问日志判读指纹**：authfail 全 POST 无 GET ⇒ 前端 `ensureInit` 的 initPromise 未重置(#007)；conflict 呈 push→conflict→push 成功属正常守卫，呈 rev 死循环才是 bug。
- **#007/#008（2026-08-30 立案，P1 待处理）**：serverStore 同步码输错一次后再输对也开不起来 + 401 与网络异常混同致空白项目/编辑静默丢弃。详见清单。

## 会话窗口分工（2026-08-29）
本窗口专做网页体验版维护（部署/配置/邀请码/HTTPS/反馈通道）；新功能开发另开窗口，git 与上下文隔离。

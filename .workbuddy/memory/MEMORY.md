# novel-studio 长期记忆（MEMORY.md）

## 项目身份
「青春幻想引擎」小说创作管理应用。Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储后端(IndexedDB/便携/桌面)经 StoreOps。dev http://localhost:5199/。managed node：`C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`。

## git 基线
main 无远程；每轮审计/封装后 commit，信息写清要点。

## 封装红线（最高优先级）
封装前必：tsc 0错 + vite build 0错 + 改动落盘。流程：审查→升 package.json version→封装。G盘 safe-delete 拦截 rmSync：build 前先 `mv dist dist.oldbak`；禁删 release/eb-cache/。Edit 工具偶发静默失败→改完必 tsc+抽查。

## 项目硬规则
根目录 `你需要的文件在这里/`（原 `你需要的图片我放在这里/`，2026-08-29 老大重命名）禁删。禁用 window.prompt/confirm/alert（用 PromptModal/confirmDialog/showToast）。

## 架构速查（红线）
- 按卷建表：卷表 tabId `chapter-vol-<vid>`；聚合走 db.getAllChapterLedgerRows()。
- 章节顺序：chapterSeq.ts 为唯一权威(全派生不落库)。
- 下拉选项单一口径：必须用 resolveOptions(col.options, getCustomOptions())，禁直接用 col.options。
- `!tabVisible` 只可用于守卫 return/构造隐页签集合，赋给 showXxx 即 bug。
- AI抽取+代码判重分层：存在性用 normName/rowFingerprint.norm 确定性比对，AI只抽候选。
- 角色卡 char-main/char-secondary vs char-npc 字段不同，用 settingLedger.cardFieldPath() 探测勿硬编码。

## AI 接入
颉文姬5模式(clinic/edit/review/brief/ledger)。硅基流动 deepseek-ai/DeepSeek-V3.2；明文本地记忆勿公开。

## 版本与清单
- 1.9.6 已封装(便携8.22MB+桌面81MB)。路线图：1.9.6试用1~2周收集问题/bug→2.0批量处理。
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

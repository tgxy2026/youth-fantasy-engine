# novel-studio 长期记忆（MEMORY.md）

> 只留**长期有效的规则、红线、决策与凭据路径**；事件经过与逐条数据留在 `YYYY-MM-DD.md` 日志。

## 项目身份
「青春幻想引擎」小说创作管理应用。Electron31 + React18.3 + TS5.5 + Vite5.3 + Tailwind(ink/amber)。三存储后端（IndexedDB/便携/桌面）经 StoreOps。dev `http://localhost:5199/`。
managed node：`C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`

## 最高红线
1. **封装/重打包必须由老大明说「封装」「重打包」**；改完最多 tsc+build 验证 + commit。
2. **提交信息含 `!` 必须用 `git commit -F <文件>`**（-m 会被 bash 历史展开吃掉 `!XXX`）。main 无远程。
3. **禁删**：根目录 `你需要的文件在这里/`、`release/eb-cache/`（electron-builder 缓存 106M）。
4. **禁用** `window.prompt/confirm/alert` → 用 PromptModal / confirmDialog / showToast。
5. **服务器属主红线**：`/var/lib/yfe` 属主须为 `www-data`。任何 sudo 写操作都会把属主变 root → www-data 只读 → 云端 push 静默失败。sudo 后必补 `sudo chown www-data:www-data /var/lib/yfe/<file>` + `sudo -u www-data test -w <file>` 实测。

## 封装流程
封装前必：**tsc 0 错 + vite build 0 错 + 改动落盘**。顺序：审查 → 升 `package.json` version → 封装。
- **G 盘 safe-delete 拦截 rmSync / emptyOutDir**：build 前先用 Node `renameSync` 移开 `dist`、`dist-web`（shell `mv` 不可靠）。
- **同版本号重打包三坑**：① 便携 outDir `release/novel-studio-<ver>` 与 `dist-web` 已有上轮产物，必先移开。② `dist-web` 可能被句柄占用致 rename 报 EPERM —— 别硬碰，改用 `vite build --config vite.config.web.ts --outDir dist-web-<后缀>` 另开新目录再推送。③ electron-builder 日志 `rcedit ... Unable to commit changes` **不代表失败**（防病毒锁新解包 exe，重试第 3 次成功且不打成功日志）；判定：node 读 exe buffer 搜 utf16le 的 `青春幻想引擎开发组`/`Copyright © 2026`，命中即已写入。
- **产物验证（封装后必做）**：别只看体积。用 node 读 buffer **双向校验**「应存在的新字符串」+「应消失的旧字符串」；便携查单文件 HTML、桌面查 `dist/assets/<chunk>.js`、线上 `grep -rlF /var/www/yfe/assets/*.js`。三处一致才算真上线。
- dev 报 `[safe-delete] ... node_modules/.vite/deps` 时，先移开 `node_modules/.vite` 再重启（vite 会重建）。
- Edit 工具偶发静默失败 → 改完必 tsc + 抽查。

## 工作区清理
1. **先只扫描出报告（路径+体积），老大圈定后才动手**，绝不自作主张删。
2. 主要垃圾源：`dist.bak-*` / `dist_bak_*` / `dist-web*.bak*` / `web-build-*`（git 未跟踪）。
3. **本环境无法走真回收站**（`Add-Type` 与 COM 实例化均被安全策略拦截）。一律**移到同盘隔离区**（`G:\AI软件\.cleanup-quarantine\<日期>\`），可逆不删，确认后由老大清空。bash `mv` 报 EPERM 时换 PowerShell `Move-Item`。

## 架构红线
- **按卷建表**：tabId `chapter-vol-<vid>`；聚合走 `db.getAllChapterLedgerRows()`；章节号全局连续（`migrateChapterNumbering`）。
- 章节顺序以 `chapterSeq.ts` 为唯一权威（全派生不落库）。
- 下拉选项一律用 `resolveOptions(col.options, getCustomOptions())`，禁直接用 `col.options`。
- `!tabVisible` 只用于守卫 return / 构造隐页签集合，赋给 `showXxx` 即 bug。
- AI 抽取 + 代码判重分层：存在性用 `normName`/`rowFingerprint.norm` 确定性比对，AI 只抽候选。
- 角色卡 `char-main`/`char-secondary` vs `char-npc` 字段不同，用 `settingLedger.cardFieldPath()` 探测，勿硬编码。
- **`WEB` 由 `__WEB__` define 决定**（仅 vite.config.web.ts 为 true）。绝不可写 `!PORTABLE && !DESKTOP`（dev 纯浏览器跑时二者同为 false 会误判成网页版）。
- **顶层副作用须双重守卫**：① 平台守卫——`serverStore` 顶层监听曾泄漏进桌面/便携版（db.ts 静态 import），关窗口白跑 PBKDF2 + file:// 下注定失败的 fetch，且无法 tree-shake；加 `if (WEB && ...)` 后主包 675KB→658KB。② **只加平台守卫不够**（#023）：未开同步的访客 `code=''`，监听器照样 `flushNow()` → 空 `Bearer` POST → 401，耗尽自家 IP 限流额度，真输对码时反被 429 拦。**正解：延迟注册 `armUnloadFlush()`（由 `configureServerStore(c)` 在 c 非空时调用 + `unloadHooked` 防重复），且被调函数自身也加 `if (!code) return`。**
- **「从源数据重建草稿」的 effect 要防脏覆盖**：依赖数组含源数据时，源数据因"其它项增删改"变化就会用库里旧值静默覆盖未保存编辑。重建前判断 `草稿id===当前id && dirty`，脏则 return。

## 示范项目种子数据
- 🔴 **卡片 data 键名须严格等于 schema 的「模块名::字段名」，表格行键名须等于 schema 列名**。`OutlineSheet`/`TableSheet` 按 `${mod.name}::${f.name}` 取值——**写错不报错、能编译、却整组字段静默空白**。实例：第二卷分卷大纲误用「三、本卷主线/四、伏笔与回收」（schema 实为「三、事件链/四、伏笔管理」）。
- ✅ 常驻回归检查：**`node tests/seed-schema-check.mjs`**（esbuild 单独打包 schema.ts、./db 打桩，逐键对账，产物写 os.tmpdir 后清理）。改种子必跑。
- ⚠️ **统计条数两坑**：① `grep -c "row('progress'"` 只数到 1——该表在 `for (... of days)` 循环里生成（实为 20 条）。② `grep -c "tabId: 'volume-outline'"` 会漏掉用 `card()` 助手创建的记录。**先确认是字面量还是循环生成。**
- 写作进度/热力图日期已改为**「距今 N 天前」动态生成**（`todayKey()`），不会过期。

## 主题系统
换肤：`<html data-theme>` + index.css 变量，组件零改动。每套 = 12 档 ink(950~50) + amber/amber-soft + color-scheme。
- ⚠️ **浅色 ink 刻度反向**：ink-950=页底(最浅)、ink-100=正文(深)、ink-50 最深；深色反之。新增主题极易搞反。
- ⚠️ 浅色 850(分隔线) 比 800(输入框底) 深一档，属既定设计语言，新增浅色主题须复刻。
- 新增主题三件套：`theme.ts`(ThemeId + THEMES) + `index.css`(变量块) + Sidebar 色块行（须 flex-wrap，8 个 20px 色块约 202px 会挤爆 224px 侧栏）。
- ⚠️ CSS 压缩器会去掉属性选择器引号：产物是 `[data-theme=x]` 而非 `[data-theme='x']`，grep 时注意。
- 8 套：暗夜/护眼/午夜蓝/羊皮卷/暮山紫/青花/松烟墨/桃笺（深浅各 4）。

## AI 接入
颉文姬 5 模式：`clinic`诊断 / `edit`编辑 / `review`校对 / `brief`简报 / `ledger`补登。模型走硅基流动 `deepseek-ai/DeepSeek-V3.2`。明文本地记忆勿公开。

## 版本与产品方向
- 当前 **1.9.8**（便携 8.65MB / 桌面 84.5MB / 网页版已上线）。1.9.7、1.9.6 详见日志。
- **产品方向（勿再反复）**：**桌面/便携版 = 纯本地**，数据由用户自管，**不做跨设备自动同步**；跨设备需求**统一收敛到网页版云同步**做深做稳。#001 已拒绝；#005（冲突备份）建议转网页版专用（存 `.conflict` 副本，勿静默丢云端改动）。
- **2.0 部署（已定 A 方案，测试期不做）**：绑域名 `qchxengine.cn` + Let's Encrypt 真证书；大陆节点需 ICP 备案（非经营性免费 1-15 工作日；前提服务器包月≥3月且剩余≥30天、域名境内注册商实名）。**测试期维持 `https://154.8.178.240` 自签 HTTPS + IP 访问**。
- 清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：**老大反馈只记录不处理，明说「处理」才动手**（状态待处理/已处理/已拒绝；P0~P3）。

## 网页版与服务器
- 纯静态网页版零后端可跑（idbOps，数据留浏览器）。邀请制。
- 服务器 `154.8.178.240`（腾讯云轻量 Ubuntu 24.04）。SSH 私钥 `C:\Users/18223\.ssh\yfe_test_server`（600，仓库外），ubuntu + 免密 sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`（www-data，端口 3000，数据 `/var/lib/yfe`）。
- ⚠️ `feedback-server.mjs` 改后必须 `sudo cp ~/yfe-deploy/feedback-server.mjs /opt/yfe-server/` 再 `sudo systemctl restart yfe-feedback`（漏拷 JS → 路由 404）。nginx 改后 `sudo nginx -s reload`。
- HTTPS 自签 `/etc/ssl/yfe/yfe.crt+key`（365 天）。安全上下文下 serverStore 走真 AES-GCM(`a1:`)，HTTP 降级 XOR(`x1:`)，旧数据兼容。
- 云端同步：serverStore 走 StoreOps，`fetch /api/sync`，800ms 防抖，rev 守卫，排除 meta 的 AI 配置；20 个同步码各独立槽位 `sync-<sha256>.json`。入门码 `YFE-D49E-6MPG`。
- **排障信条**：日志记 `push ok` ≠ 落盘，必须核对槽位文件的 `rev` 与 `mtime`。

## 服务器巡检
- 日志：`/var/lib/yfe/feedback.jsonl`（附件 `fb-<id>.bin`）、`access.jsonl`（`act` ∈ enter/reject/pull/push/authfail/conflict/rate-limited）。
- 每日巡检 automation `automation-1787973377664` → 归档到 `docs/服务器反馈记录.md`、`docs/服务器访问记录.md`。
- **实操**：① `ssh > 临时jsonl` 后用 node 脚本重建 md，用完删临时目录。② ts 是 UTC，按本地日期分组须 +8h。③ **概览表必须全量重算**（独立 IP 跨批次有重叠，不能累加或 `Math.max`）。④ **第 2 次起脚本要「追加」而非「重建」**。⑤ 开跑前先枚举本期 act 值（`grep -o '"act":"[a-z-]*"' | sort -u`），漏映射会渲染成「未知动作」。⑥ 脚本推测结论**必须人工复核后改写**。
- 🔑 **`bad` 字段是鉴权故障判官**（服务端 `providedCodeHash`）：`bad=null` ⇒ 请求**根本没带 Authorization**，不是"用户输错码"。排查 authfail 先看 bad 分布。⚠️ 反例：「全 POST 无 GET」不能推断 initPromise 未重置——无码空请求同样是全 POST。
- **#023（P1 待处理）**：`flushNow()` 缺"是否启用同步"守卫，未开同步的访客每次切标签/关页面都发无码 POST 白收 401，耗尽限流额度后真输对码反被 429 拦（症状酷似 #007，易误诊）。修复：`if (!code) return;`。
- ~~#007/#008~~ 已于 08-30 修复（`7fbdb79` + `ce01b94`）。conflict 呈 push→conflict→push 成功属**正常守卫**，呈 rev 死循环才是 bug。

## 会话窗口分工
本窗口专做项目本体开发；服务器运维与巡检走 automation / 另开窗口，git 与上下文隔离。

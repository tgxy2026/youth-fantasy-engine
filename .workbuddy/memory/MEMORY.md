# novel-studio 长期记忆（MEMORY.md）
> 只留长期有效的规则/红线/决策/凭据；事件经过留 `YYYY-MM-DD.md`。

## 项目身份
「青春幻想引擎」小说创作应用。Electron31+React18.3+TS5.5+Vite5.3+Tailwind(ink/amber)。三存储后端(IDB/便携/桌面)经 StoreOps。dev `http://localhost:5199/`。managed node：`C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2/node.exe`

## 最高红线
1. 封装/重打包须老大明说「封装」；改完最多 tsc+build+commit。
2. 提交信息含 `!` 用 `git commit -F <文件>`（-m 被 bash 历史吃 `!XXX`）。main 无远程。
3. 禁删：`你需要的文件在这里/`、`release/eb-cache/`(106M)。
4. 禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
5. 服务器属主红线：`/var/lib/yfe` 须 www-data；sudo 写后必 `chown www-data:www-data` + `sudo -u www-data test -w` 实测，否则 push 静默失败。

## 封装流程
- 必备：tsc0错+vite build0错+改动落盘 → 升 version → 封装。
- G盘 safe-delete 拦截 rmSync/emptyOutDir：build 前 Node `renameSync` 移开 `dist`/`dist-web`。
- 同版本重打包：①先移开 `release/novel-studio-<ver>` 与 `dist-web`；②`dist-web` 句柄占用 rename EPERM → 改用 `--outDir dist-web-<后缀>`；③ electron-builder `rcedit Unable to commit changes` 非失败（重试第3次成功不打日志），node 读 exe buffer 搜 utf16le `青春幻想引擎开发组`/`Copyright © 2026` 判定。
- 产物验证：node 读 buffer 双向校验新/旧字符串；便携查单文件HTML、桌面查 `dist/assets/<chunk>.js`、线上 grep `/var/www/yfe/assets/*.js`，三处一致才真上线。
- dev 报 `[safe-delete] node_modules/.vite/deps`：移开 `node_modules/.vite` 重启。Edit 偶发静默失败→改完必 tsc+抽查。

## 工作区清理
- 先只扫报告(路径+体积)，老大圈定才动手。垃圾源：`dist.bak-*`/`dist_bak_*`/`dist-web*.bak*`/`web-build-*`。
- 本环境无真回收站 → 移到 `G:\AI软件\.cleanup-quarantine\<日期>\`（可逆不删）；bash mv EPERM 换 PowerShell Move-Item。

## 架构红线
- 按卷建表 `chapter-vol-<vid>`；聚合 `db.getAllChapterLedgerRows()`；章节号全局连续 `migrateChapterNumbering`。顺序以 `chapterSeq.ts` 为唯一权威（派生不落库）。
- 下拉选项用 `resolveOptions(col.options, getCustomOptions())`，禁直接 `col.options`。`!tabVisible` 只守卫 return/隐页签，赋 `showXxx` 即 bug。
- `WEB` 由 `__WEB__` define 决定（仅 vite.config.web.ts 为 true），禁写 `!PORTABLE && !DESKTOP`。
- 顶层副作用双守卫：①平台 `if(WEB&&...)`；②功能 `if(!code)return`（#023 已修 c0275f3：armUnloadFlush 延迟注册 + flushNow/schedulePush 加 `if(!code)return`）。
- 「从源数据重建草稿」effect 防脏覆盖：重建前 `草稿id===当前id && dirty` 才 return。

## 种子数据
- 卡片 data 键=`模块名::字段名`、表格行键=schema 列名，写错不报错整组静默空白。
- 改种子必跑 `node tests/seed-schema-check.mjs`（esbuild 打包 schema+db 打桩，逐键对账）。
- 统计条数先确认字面量还是循环生成（`grep -c` 会漏循环/助手创建）。进度/热力图日期用 `todayKey()` 动态「距今N天前」。

## 按钮体系(Button.tsx)
套尺寸：primary/secondary/ghost/danger/success/info/icon/icon-ghost/toggle/icon-*；不套：bare/toggle-text。档位 xs(h-6)→sm(h-8)→md(h-9默认)→lg(h-10)。裸图标传 `iconOnly`。改尺寸后查容器溢出(加 overflow-x-auto)。审计 JSX 不用 indexOf('>')（箭头 `=>` 误截断），判据「>前字符≠=」。

## 主题系统
换肤 `<html data-theme>`+index.css 变量，组件零改。8套(深浅各4)：暗夜/护眼/午夜蓝/羊皮卷/暮山紫/青花/松烟墨/桃笺；浅色4=护眼/羊皮卷/青花/桃笺。
浅色 ink 刻度反向(950最浅/50最深)；850分隔线比800深一档。CSS 压缩去引号 `[data-theme=x]`。
⚠️ 浅色禁低透明度 amber 表数据(护眼1.57/羊皮卷1.48 远低于3:1会隐形)；靠色传达数据用实色 `bg-amber`，最低 `/40`。排查用 agent-browser eval 取 getComputedStyle 算 WCAG。

## AI 接入
颉文姬5模式 clinic/edit/review/brief/ledger；模型硅基流动 deepseek-ai/DeepSeek-V3.2。明文本地记忆勿公开。

## 版本与方向
当前 1.9.8(便携8.65MB/桌面84.5MB/网页版上线)。桌面/便携=纯本地不做跨设备同步；跨设备收敛网页版云同步(#001已拒绝)。
2.0 测试期 `https://154.8.178.240` 自签HTTPS+IP访问；绑域名 qchxengine.cn+备案 等测试后。清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：老大反馈只记录，明说「处理」才动手。

## 网页版与服务器
网页版零后端可跑(idbOps)。邀请制。服务器 `154.8.178.240`(腾讯云轻量Ubuntu24.04)；SSH `C:\Users/18223\.ssh\yfe_test_server`(**22**；2026-09-01 实测 600 超时，改 22 通)。ubuntu+免密sudo。站点 `/var/www/yfe`；反馈服务 `/opt/yfe-server/feedback-server.mjs`(www-data:3000，数据 `/var/lib/yfe`)。
改 feedback-server.mjs：本地构建后 `scp` 到服务器 `/tmp/yfe-feedback.mjs` → `sudo cp /tmp/yfe-feedback.mjs /opt/yfe-server/` + `sudo chown www-data:www-data` + `systemctl restart yfe-feedback`；网页静态文件 `scp` 到 `/tmp/yfe-web-<日期>` → `sudo cp -r` 到 `/var/www/yfe` + `chown -R www-data:www-data`。nginx 改后 `nginx -s reload`。
serverStore走StoreOps `fetch /api/sync`，800ms防抖，rev守卫，排除meta的AI配置；20同步码独立槽位 `sync-<sha256>.json`。入门码 `YFE-D49E-6MPG`、已分发 `YFE-SYNC-N6SV-2YZJ`(田馨)。
HTTPS 自签 `/etc/ssl/yfe`；安全上下文 AES-GCM(`a1:`) / HTTP降级 XOR(`x1:`)。

## 服务器巡检
日志 `/var/lib/yfe/access.jsonl`(act: enter/reject/pull/push/authfail/conflict/rate-limited)、`feedback.jsonl`(附件 fb-<id>.bin)。每日 automation `automation-1787973377664` → `docs/服务器访问记录.md`/`docs/服务器反馈记录.md`。
实操：ts=UTC按本地+8h分组；概览表全量重算(独立IP重叠不可累加/Math.max)；追加非重建；先枚举 act 值防「未知动作」；脚本结论人工复核。
`bad` 字段判官：`bad=null`⇒请求无 Authorization(非输错码)；`bad` **有值可反算身份**——本地 sha256(候选码) 取前12位比对即知填了啥(已据此认出「入门码当同步码」)。排障：日志 `push ok`≠落盘，须核槽位 rev/mtime。
要点段是手写的，时间同样须 +8h(极易抄成 UTC)；概览 08-29 基准行 21/1/8/21/20 可作全量重算的自校验。
门禁码校验(#027 已处理·2026-09-01 部署上线)：服务端 `feedback-server.mjs` 新增 `normCode()`(`replace(/\s+/g,'').toUpperCase()`)，`parseList` 建集合与 `syncAuth`/邀请校验取码后均归一化再比对；前端 `WebGate`/`WebTools`(doSync+`PromptModal.transformUppercase`+`YFE-D` 误填识别)同款归一化。⚠️ 槽位名＝`sha256(码)` 幂等(全大写码不变)，线上 pull 验证小写/空格变体命中同一 `4edd6fb4…` 槽位。commit `bf4f704`+`3f1c082`。

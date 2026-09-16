# novel-studio 长期记忆
> 红线/决策索引；事件留 `YYYY-MM-DD.md`。⚠️ 上限 ~6100 字符——新增前先查同类、合并改写、超了就往主题文档迁。
> 主题细则外链：`docs/酒馆模式-工程红线.md`（**18 节**）、`docs/2.1.1-审计修复记录.md`。

## 红线
- 🔴 封装须老大明说「封装/重打包」；改完最多 tsc+lint+test+commit。
- 🔴🔴 **禁 `git stash`，也禁手工 `git gc`/`reflog expire`**：09-14 stash 中断丢对象；09-16 `git gc --prune=now`（git 2.55）把 `.git` 的 HEAD/config/refs/objects 全清空、只剩空骨架（报 `not a git repository`）。恢复靠 **`git bundle`**——动手前先 `bundle create` 并 `clone` 还原实测。已设 `gc.auto=0`，别改回来。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/toast。
- 清单 `docs/…Bug与待优化清单.md` 只记录，明说「处理」才动。提交含 `!` 或换行用 `git commit -F`。main 无远程。

## 身份 / 版本 / 封装
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；存储经 StoreOps；dev 5199。
- 现 **2.1.1**。版本唯一源 `package.json`（dev 由 `injectAppVersion()` 注入 `APP_VERSION_LABEL`）。⚠️ `package-lock.json` 根版本常落后 → 只改 `j.version`＋`j.packages['']`。
- 🔴🔴 封装**全程无沙箱跑**。rcedit 间歇失败（退出码仍 0，只认 stderr `Fatal error`）由 `scripts/after-pack.cjs` 重试根治；验收查 exe 含 `青春幻想引擎开发组`；`ELECTRON_CACHE`→`AppData/Local/electron/Cache`。
- 🔴🔴 **只做桌面版**（无 WEB/PORTABLE）。`StoreOps`/`PortableData` 在 `storeOps.ts`，版本号在 `env.ts`。云盘同步＝唯一跨设备途径。

## 架构红线
- 无 i18n；schema 列名即存储键（改功能后回搜 `schema.ts` 的 `description`）。
- ⚠️ 打包陷阱：①tree-shake——组件只在平台门控分支被引会被摇掉整模块→门控用「需该模块平台并集」，删门控必跑 `vite build`；②`DESKTOP` 运行时探测（`window.electronStore`）→dev 浏览器恒 false（`DataDock` 有 DEV 兜底）。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层。种子键：卡片 `模块::字段`、表格＝列名；改种子必跑 `seed-schema-check.mjs`。
- 🔗 功能门：`FEATURE_TIER`＋`STRONG_DEPS`（双向）＋`ANY_DEPS`；闸 `feature-deps-check.mjs`。
- 🔴 编辑器双图层：盒模型逐项一致；叠层重建归零 scrollTop→`useLayoutEffect` 回填；只走 `scanRefHighlight`。
- 🗺 多地图方案 B：新表 `geomaps`＋geography 的 `所属地图`；格档按图存；`migrateGeoMaps` 建默认图回填；🔴 删图不删地点、改图名连带改归属。

## 存储 / 同步
- 桌面整库一 JSON；⚠️ 别让云盘同步该目录；🔴 图片先压缩再入库；换设备前先关软件＋等同步完。
- 🔴 `backups` 本地专属→`makeCloudStoreWrapper` 短路到 local。🔴🔴 桌面读数据失败必须锁写盘（`main.cjs` 三态＋`DesktopWriteLockBanner`）。
- 🔄 两同步入口别混：①改数据位置＝明文 JSON 进云盘；②云盘同步＝加密 `.yfe`＋记录级合并＋每日备份。**用 ②**。
- 🔴 09-15 修一批（`docs/2.1.1-审计修复记录.md` §四）：换目录先抓旧数据再 `configure()`；空推按记录总数判；关同步前先 flush；409 解密失败直接抛；IPC 写失败要抛；启动拉不到快照清 ENABLED 标记。

## UI / 布局尺寸
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`；SVG 用 CSS 变量必须走 `style`（`fill="rgb(var(--x))"` 会回退黑）。设置项排版＝标题→输入→说明；复制统一 `copyText()`。
- 🔴🔴 `<html>` 界面缩放（默认跟随窗口）：①量尺寸一律 `offsetHeight`/`clientWidth`，绝不 `getBoundingClientRect()`；②zoom 不缩放 vh→内联长度走 `foldVh()`（`theme.ts`）；③SVG 滚轮锚点/拖拽除 zoom。
- 🔴 按对侧高度定高：flex item `min-height:auto` 顶回定高→加 `overflow-hidden`；别同写 `flex-1`+`height`。
- 🔴 按钮：静止无框用 `secondary`（非 `ghost`）；分段 `toggle`+`selected`；行内小操作 `size="xs"`；`danger` 破坏性。
- 🔴 每页签页头 `HelpPopover` 问号。头像兜底＝名字（`avatarLabel` 封顶 2 字）；Enter 发送／Shift+Enter 换行必挡 `isComposing`；快捷指令只预填不发送；两侧消息无气泡框。文案禁 markdown 星号→用「」/（）。

## AI 层
- 🔴 解析统一 `aiParse.ts`（禁裸 `JSON.parse`）。温度不手填：结构化→0.3、创意→0.85；一轮 JSON 走 `aiChatJson`。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering→geomaps 序不可换）。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；绝不清洗正文。
- 🔴 采样惩罚看**射程**不看强度：三种惩罚共用 `penalty_last_n` 窗口（Ollama 默认 64 词元≈50 汉字）。✅ 09-16 落地 **`repeat_last_n` 512 ＋ `frequency_penalty` 0.1**（两模式各一套，`paramGuide` 双段）→ 手部率 28.9%→13.4%。🔴🔴 **绝不调高 `repeat_penalty`**（1.4 实测动作行 2.08→0.43/轮且括号不闭合——`（`/`）` 就在窗口内，惩罚打在格式符本身）。`presence_penalty` 调低/归零**均无效**（已证伪）。反重复提示词**只有钉在 system 末尾才有效**，埋中段≈0。
- 🔴 本地实弹探针：思考模型必带 `think:false`（否则全文进 `message.thinking`、`content` 为空）；改指标口径别重跑 GPU，走 `LR_ANALYZE=<json>` 离线重算；CUDA 下固定 seed **不保证逐位复现**（噪声带 ±4pp），结论要标噪声带。

## 服务器 / 工程质量
- 服务器 `154.8.178.240`（SSH `yfe_test_server`），站点 `/var/www/yfe`。⚠️ `server/` 含线上反馈服务→删库≠下线；Nginx SPA 回退：不存在路径也返 200→不能靠 200 判上线。
- `npm run verify`（tsc+lint+test）；ESLint 11 warnings 别盲改。🔴 实机验证走 `novel-studio-ui-livecheck`；实弹断言会静默过时→日志必 grep ✗；子代理结论必回源码验尸。

## 酒馆模式
- 🔴🔴 **细则全在 `docs/酒馆模式-工程红线.md`（18 节）——动酒馆任何功能前必读对应节**。2026-09-16 起酒馆条目整块迁去该文档 §18（本文件体积所限），只在此留「跨节最易错」几条。
- 源《酒馆模式_完整落地方案》＋`你需要的文件在这里/` 调研稿（冲突以方案为准）。
- 🔴 数据归属：剧情会话+扮演设定+报告+剧情背景**随项目**；自由会话+角色卡+记忆日常+面板设置+剧本库**跨项目**（索引与分条成对，tavernReports 别漏 deleteProject）。
- 🔴🔴 预算：`historyBudget`＝预算−400−整条 system（别传记忆）；contextBudget **24000**（三处一致）；numCtx **32768** 别动。
- 🔴🔴 防剧透两层：段落级 `viewMode:"character-view"`＋字段级 `AUTHOR_SIDE_FIELDS`（**新字段须登记**）；标题整行匹配（禁 `includes`）。
- 🔴 三条最易踩：①剧本/故事**会话存快照非引用**（`snapshotStorySetting`）；②`branchSession` 分支与回滚**都连记忆一起**处理；③归档后输入区只读＋`reroll`/工具条/调度/数值全锁。
- 🔴 协议现 **v1.10**；改协议同步三处（正文版号＋`LEGACY_PROTOCOLS`＋`PROTOCOL_VERSION`＋两断言）。输出规范与 R4 元指令细则见 §18.10。
- 📋 实机验收走 `docs/酒馆模式-本轮改动实机验收清单-2026-09-16.md`；75 条审计＋13 条验收反馈均已落地（#12 靠 440 次对照实验定案）。

## 出厂数据（角色卡不进原生）✅ 09-15 已执行
- 🧪 dev 测试数据放仓库外 `G:\AI软件\角色卡录入\04-开发测试数据（dev专用·不进打包）\`，走 `story.ts`/`store.ts`（索引分条成对、幂等）；🔴 绝不写进 `seedData.ts`。内有「奉阳大学」故事＋楚楠/苏念两张卡。📥 卡走导入：skill `tavern-cards-batch`→`.taverncards.json`→界面导入。
- 🚫 原生不再预填自由示范卡；项目内 `char-*` 卡（23 张）、细纲卡、推演会话 cast 照旧；🔴 老库卡只保留不删。已删 `seedCardData.ts`/`seedCards.ts`/`tests/tavernSeedCards.test.ts` 及调用；33 处提示词卡名换中性名（阿岩/小满/阿禾）；策略闸 `tests/tavernSeedPolicy.test.ts`。

## 示范项目（吞天神脉）
- 两卷各十章：1-10 风起云州 / 11-20 剑鸣中州（约 9.2 万字）。改/加正文同步 `seedContent.ts`→`seedData.ts`（落点链 mkChapter→masterRows→卷/章卡→rows 台账→酒馆 world＋示范会话）。
- 🔴 三道闸：`seed-schema-check.mjs`＋`tests/seedRef.test.ts`＋细纲卡登记核对；卷名/章数/终章口径一致。推演 cast 引用角色卡 id→相关卡留 `card()` 返回值；播种失败只 warn→验收捕获 console.warn。

## 环境（Windows + Git Bash）
- git/npm 用**绝对路径**（PortableGit `cmd/git.exe`；托管 node＋`npm/bin/npm-cli.js`）——PATH 每次调用不持久；⚠️ `sort`/`find`/`timeout` 会解析到 Windows 同名 exe→改用 node 脚本。
- 🔴 改 `protocol.ts` 正文**别用 Edit**（同文件躺着 10 份历史协议，锚点必不唯一）→走「临时脚本：只在 `PROTOCOL_CORE` 内替换＋每锚点断言恰好命中 1 次＋旧版追加进 `LEGACY_PROTOCOLS`」，落盘即删。
- ⚠️ Edit 假成功：改完立即 grep；多处替换用脚本（全命中才落盘）；`node -e` 引号被吞→Write 落纯 JS；同文件并发 Edit 互覆盖→串行。跨行锚点先探 EOL（CRLF/LF 并存；`git checkout -- <file>` 会把 LF 变 CRLF）。
- 🔴 dev 仅 `http://localhost:5199`（127.0.0.1 302 到 localhost，否则两份 IndexedDB）；文档/探活一律 localhost。桌面走文件存储与 dev 两套（设计如此）。
- ⚠️ 验「随项目」用 `db.setCurrentProject` 别直查物理表；实弹读真实 apiKey 先告知不提交；改提示词/示范卡文案后同步改 `tests/` 写死旧文案的断言。
- 🧪 dev 测试数据：仓库内 `dev-seed/`，`await import('/dev-seed/fengyang.js?' + Date.now())`；🔴 必须带 `?'+Date.now()`；数据在浏览器 IndexedDB，重启 dev server 无效。

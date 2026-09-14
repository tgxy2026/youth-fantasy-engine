# novel-studio 长期记忆
> 规则/红线/决策；事件经过留 `YYYY-MM-DD.md`。**新增前先查同类条目 —— 合并改写，别追加第二份。**
> ⚠️ 注入上限约 6000 字符，超了会被腰斩；**这份文件必须保持精简**。

## 红线
- 🔴 **封装须老大明说「封装」**；改完最多 tsc+build+commit。
- 禁删 `你需要的文件在这里/`、`release/eb-cache/`。禁 `window.prompt/confirm/alert` → PromptModal/confirmDialog/showToast。
- 清单 `docs/1.9.6-2.0.0_Bug与待优化清单.md`：只记录，明说「处理」才动。
- 提交含 `!` 用 `git commit -F <文件>`。main 无远程。

## 身份 / 版本
- Electron31+React18.3+TS5.5+Vite5.3+Tailwind；三存储(IDB/便携/桌面)经 StoreOps；dev 5199。
- 现 **2.1.0**（只改号不封装，约每月一版）；2.0.0 已收官（只发桌面/便携，网页版已关服）。
- 版本唯一源 `package.json`；展示 `APP_VERSION_LABEL`；`injectAppVersion()` 补 dev；不加 dev 角标。

## 封装 / 构建坑
- 🔴 `ELECTRON_CACHE` 须指系统默认 `AppData/Local/electron/Cache`，**切勿**指 `release/eb-cache/electron-zip`（只剩空壳）。
- 正常体积：桌面 **80.68MiB**（≈84.6MB）、便携 **8.44MiB**。两脚本内置体积闸门：**退出码 0 也可能没达标，不达标即 abort**。
- NSIS：`perMachine:false`+`allowToChangeInstallationDirectory:false` → 按当前用户装、重装免管理员；旧 per-machine 版需管理员跑一次迁移；**勿设 `allowElevation:false`**。

## 架构红线
- 无 i18n（中文硬编码）；schema 列名即存储键；约 380 处中文参与判断。
- ⚠️ tree-shake：组件只在某平台门控分支被引用会被摇掉整模块 → 门控须用「需该模块平台之并集」。
- 左下角只准一个浮层 `DataDock`；项目内禁全局 fixed 浮层，内嵌 Sidebar Footer。
- 种子：卡片键 `模块名::字段名`、表格键=schema 列名；改种子必跑 `seed-schema-check.mjs`。
- `WEB` 由 `__WEB__` 定，禁写 `!PORTABLE && !DESKTOP`。
- 🔴 编辑器双图层（NovelEditor）：开高亮时 textarea 透明、文字全来自叠层。① 盒模型与 textarea**逐项一致**（改一侧必同步）；② 叠层重建归零 scrollTop → 高亮/切章/字号/页宽/专注/检索变化必用 `useLayoutEffect` 回填；③ 只走 `scanRefHighlight` 单次正则。

## 存储 / 同步（丢数据风险）
- 桌面整库一 JSON（`%APPDATA%\novel-studio\novel-studio-data.json`）；⚠️ 别让云盘同步该目录（leveldb 锁 → 空库）。
- 便携(FSA) `flush()` 已是 swap 语义，勿再加 tmp+rename。
- 判据：过服务器→要码；云盘→不要码（`DEFAULT_CLOUD_KEY`，`青春幻想引擎-同步数据.yfe`）。🔴 两路径**二选一**；云盘播种仅 `rev===0 && 空`，**换设备前先关软件+等同步完成**。
- 🔴 `backups` 本地专属→ `makeCloudStoreWrapper` 必须短路到 local，否则刷新即丢。**「死配置」结论先验消费方**。

## UI
- 浅色禁低透明 amber 表数据（实色最低 `/40`）；图谱色走 `--graph-*`，但**分类色盘不要主题化**。
- 🔴 SVG 用 CSS 变量**必须走 `style`**：`fill="rgb(var(--x))"` 无效且**静默回退黑色**。
- 设置项排版：标题 →（可选）输入区 → **说明放下面**；复制统一 `copyText()`；#031 备份须**导出外部文件**。

## 布局与尺寸坑
- 🔴🔴 **`<html>` 有界面缩放（`yfe-ui-zoom`，默认 108%）**：凡「量尺寸再算回 CSS 值」**一律用 `offsetHeight`，绝不能 `getBoundingClientRect()`**（rect 是视觉像素，差 1.08 倍）。
- 🔴 按对侧高度定高：flex item 的 `min-height:auto`（=内容高）**会把定高顶回去 → 加 `overflow-hidden`；**别同时写 `flex-1` 和 `height`**（主轴为高度时 flex-basis 压过 height）。

## AI 层
- 🔴 解析统一 `src/lib/aiParse.ts`；**禁裸 `JSON.parse`**。
- 🔴 温度不手填：结构化 JSON 传 `{json:true}`→0.3；创意类不传→0.85。
- 🔴 迁移只走 `db.runMigrations()`（types→ledger→numbering 顺序不可换）；upgrade 拆 9 函数，**upgrade 处是「何时跑哪段」的唯一判断点**。
- 🔴 作者原文进 prompt 走 `promptGuard.authorBlock()`（随机 nonce）；**绝不清洗正文**。

## 服务器
- `154.8.178.240`；SSH `yfe_test_server`（ubuntu+免密 sudo）；站点 `/var/www/yfe`。部署：web 构建→tar→scp /tmp→备份→解包→chown→验收。
- 🔴 Nginx SPA 回退：**任意不存在路径都返 200 + index.html** → 不能用 200 判断资源上线。

## 工程质量
- `npm run verify`（tsc+lint+test）；runner **每入口单开子进程**。ESLint 只开 rules-of-hooks/exhaustive-deps/no-empty；🔴 那 11 条不能盲改：缺失依赖＝未包 `useCallback`。
- 🔴 **界面实机**走 skill **`novel-studio-ui-livecheck`**（真浏览器驱动 dev server、量尺寸、出截图）；模型链路用 `build-test.mjs live-tavern|live-free`（手动、不进回归）。
- ⚠️ 手动实弹脚本的断言会**静默过时**（不进回归、不影响退出码）→ 读日志必须 grep ✗，别只看「实弹观察」行。
- 单一口径入口：`aiParse`/`constants`(键+防抖)/`promptGuard`/`zLayer`/`useSvgPanZoom`/`LoadingState`/`AutoTextarea`。

## 酒馆模式
- 源自 `酒馆模式_完整落地方案.md`（**冲突以方案为准**）+ `本地模型角色扮演完全手册.html`。
- 侧栏序＝`TABS` 数组序：**控制面板→剧情推演→推演报告→自由对话→角色卡片**（面板先决）。
- 🔴 **数据归属（测试已锁）**：剧情会话+扮演设定+报告**随项目**；自由会话+角色卡+记忆日常+面板设置**跨项目**。索引与分条成对读写；`tavernReports` 独立表（DB v10），别漏 `deleteProject`。
- 🎛️ 控制面板：设置存全局 meta `tavern.settings`，**一律走 `getTavernSettings()`**；优先级 会话→角色→**面板**→`TAVERN_DEFAULTS`。协议可编辑（改前必须弹窗警示；清空回退内置）。**加参数前先搜 tavern 目录写死的数**；settings 引反向依赖会成环（常量上移 `types.ts`）。
- 🔴 层序：设定→记忆→身份→档位→（通用→本场补充）→未带入声明→**协议（钉末尾）**。三处去冗：`memoryTitle:null`、补充要求加 〖〗标题、`inlineDropNote:false`。
- 🔴 `buildMultiCharRule`：整场 AI（无「你演」）必须传 `{hasUser:false}`，否则模型等一个不存在的人；有用户角色时传 `userName`。
- 🔴 自由模式「用户扮演的角色」=`FreeSession.userCharId`（可选）。**AI 名单/发言轮转/记忆块三处都要排除 Ta**，否则 AI 替 Ta 回答；Ta 的记忆**不给 AI**（用户的底牌）。
- 🔴 记忆**按角色分别整理**（右栏页签）；水位线**全部成功才推进**。角色卡页可手改记忆。自由对话页**无角色列表**，左栏＝全局会话列表；`scene?` 渲染成首条 user 消息。
- 🔴 采样链走 `ai.ts` 的 `extraOptions`：Ollama 原样并入；OpenAI 只转发白名单 —— **top_k/repeat_penalty/num_ctx 别发 OpenAI**。
- 🔴🔴 防剧透两层：① 段落级 `viewMode:"character-view"` 排除 10 个作者侧页签；② 字段级 `AUTHOR_SIDE_FIELDS`（约 30 个）。**新增未来向字段必须登记②**。
- 🔴 提示词与解析器对齐：解析器按提示词写法；标题**整行匹配**（禁 `includes`）；序号裸化；校验查全部字段；容忍新旧符号（〖〗/【】）。
- `think:false` 是 **Ollama 专有**；报告 finding 指不回条目即降「存疑」；定位走 `yfe:navigate`；总结**必须带角色背景**。
- 🔴 角色卡渲染块带名（`〖角色卡 · 名 #短码〗`）：**仅同场同名才挂短码**+`buildSameNameNote`（记忆按 id 存、同名各存各）。支持**复制为新卡**（照抄四章、**不复制记忆/日常**）+ 同名提示。
- 🔴 自由对话「客观描写」=`free.sceneDescription`（四档，默认 standard）：出场写穿着姿态、转场补环境、情绪落外在细节；**只写客观事实**，算在协议 60–160 字内；拼进 `modeExtra`。
- 🔴 **输出规范 v1.3（改提示词前先读）**：**输出** —— 对白＝纯文本（不加引号/括号/名字，**名字也不许单独起一行**）、动作·神态·心理＝（）、**客观环境·人物外在＝【】**、状态块＝〔状态〕；**输入**一律 〖〗（标题/说话人，例 〖对方〗）与〈〉。**两端符号必须分开**；（）写正在发生的动作心理、【】写可观察的状态外观，别写两遍。起因：旧条款只禁「名字：」前缀，名字**单独成行**不算前缀；示例对照标记改用输入侧 〖对方〗。
- 🔴 指代角色一律「Ta」。协议/示范卡改过 → **老数据升级靠全等锚点**：`LEGACY_PROTOCOLS`、`LEGACY_SEED_EXAMPLES`+`upgradeSeedCards()`（boot 每次跑、幂等、作者改过的不动）。**改内置文本必须补锚点**（改常量对老用户无效）。
- 三张卡关系网（2026-09-14 重写）：**都知道对方是谁、都不知道彼此的分量**（初版"互不知情"被指不合逻辑）。老库更新走角色卡页**「恢复内置版本」**（`resetCardToSeed`，只覆盖四章、不动记忆）—— **别再写逐句锚点补丁**。
- 初版记忆：导入/新建角色卡后**自动生成**（`coldStartMemory` AI 优先 → 失败回落 `draftMemoryFromCard` 确定性摘录）；记忆为空时角色卡页有手动按钮（非空不显示，防覆盖真实记忆）。
- 路线图（老大 2026-09-14 定，详见当日日志「第十批」/任务 56-63）：A 档全接受；B1→**「背景设定」页签**（面板下/剧情推演上，两模式各自一键 AI 录入+人工微调）；B2/B3/B5 做；**ST 卡导入不做**；C 档先不做，仅**状态栏面板**立项（先只读）。
- 示范卡三张：洛汐/苏念/楚楠；交付 `你需要的文件在这里/角色卡-楚楠.taverncard.json`。`createDemoProject` 有 **single-flight**（StrictMode 双跑会播两份）。待办只剩「角色头像」（第 8 批做）。

## 环境（Windows + Git Bash）
- git 全路径 `…/PortableGit/versions/1.2.0/cmd/git.exe`；npm 走 `"<托管node>/node.exe" "<…>/npm/bin/npm-cli.js"`，路径必须 `C:/` 正斜杠。
- ⚠️ **Edit 会「假成功」**（dev server 下更甚，一次连改 6 处挂了 3 处）：每笔改完立即 grep 复查；多处替换改用脚本。
- ⚠️ 脚本改文件：`to` 空时 `includes('')` 恒真 → 按行号删；**锚点自适应 LF/CRLF**；`node -e` 转义易崩 → 用脚本；**替换必须幂等**。
- 🔴 用脚本改源码文本时：**把新代码写成片段文件再拼接**，别塞进 JS 模板字面量（嵌套反引号/引号两次解析失败）；heredoc 会被 shell 展开 → 一律用 Write 落片段。
- 审计纪律：「数据丢失」级结论**必须回源码验尸**。🔴 实弹会读到真实 apiKey（先告知，绝不提交）。
- JSX：`{/* */}` 不能放属性位，`//` 可以。

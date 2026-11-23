# 工作区过时测试／脚本／临时文件清理流程

> 2026-11-14 首次执行并固化。目标：定期把「不适配当前版本、无法复用」的历史脚本隔离出来，
> **由人确认后再删除**，避免 `2026-11-03` 那次误删 `tests/` 又恢复的事故重演。

## 核心原则

| 原则 | 说明 |
|---|---|
| 只移动，不删除 | 工具只把候选移进隔离目录；删除动作永远由人执行 |
| 不做副本备份 | 移动本身可逆，`manifest.json` 提供一键还原索引 |
| 先扫描后隔离 | 默认 `scan` 只读；`--apply` 才动文件，且移动前做安全校验 |
| 判据要确定 | 用「明确的命名规则 + 保护名单」，不用「零引用」这类静态推断（动态拼接的入口会被误判） |
| 保留在役脚本 | `tests/*.test.ts` 是 `npm test` 与 `reliability source.tests` 的入口，**一律不动** |

## 三阶段

```bash
# ① 盘点（只读，可直接定时跑）
npm run cleanup:stale
npm run cleanup:stale -- --json        # 机器可读，供自动化解析

# ② 隔离（确认清单后）
npm run cleanup:stale:apply            # → _待清理确认-YYYYMMDD/

# ③ 人确认后删除隔离目录；或撤销
npm run cleanup:stale:restore          # 按 manifest 一键还原
```

隔离目录内保持原相对路径结构，附 `manifest.json`（完整路径映射 + 判定规则 + 保护跳过项）和
`.gitignore`（`*`，不污染 `git status`）。**确认删除时直接删掉整个隔离目录即可。**

## 三组判定规则

规则集中在 `collect-stale.mjs` 的 `CONFIG`，新增版本后缀或保护项改那里。

| 组 | 来源 | 规则 | 为什么算「不可复用」 |
|---|---|---|---|
| A | `tests/` 顶层隐藏 `.*.mjs` | 且必须能对应到同名 `*.test.ts/tsx` 源码 | esbuild 打包运行包，`.gitignore` 已标注「非源码」；由 `build-test.mjs` 每次重建，移走零损失 |
| B | `scripts/verify/` | 文件名带 `-331/-334/-335/-340` 等旧版本后缀，且不命中活跃入口关键词 | 3.3.x／3.4.0 时代一次性验收探针，只被 `docs/归档/` 历史文档提及，不属于任何当前门禁 |
| C | `.workbuddy/tools/` | 前缀为 `patch-`／`commit-msg-`／`verify-3.1`／`verify-3.2.0`／`verify-opt-`／`verify-web-` | 2026-10 月一次性补丁器与旧版验证脚本，本就被 gitignore 忽略 |

### 保护范围（绝不扫描／移动）

- 路径黑名单：`docs/`、`.workbuddy/memory/`、`.workbuddy/tmp/`（恢复证据）、`release/`（含 `eb-cache`）、
  `dist/`、`data/`（用户数据）、`src/`、`server/`、`electron/`、`tests/browser/`、`tests/fixtures/`
- `tests/` 全部受控测试与运行器、`*-332.*` 服务端自检（`npm run test:server` 动态扫描执行）
- 活跃入口：`reliability` / `audit` / `release-check` / `table-performance` / `check-doc-refs` /
  `render-readme-art` / `test-plan`
- `scripts/agent-host/*`（ACP 核心）、`scripts/audit/legacy/*`、`scripts/mcp/*`、构建钩子
- `.workbuddy/tools/` 里 `TESTING-GUIDE` 点名的 `verify-mono-charts.cjs`、`verify-custom-headers.cjs`、
  `audit-platform.mjs`，以及 `shots-tw*`（与本项目无关）与基准／代理类工具

### 未纳入、需人工判断的第二批

`scripts/verify/frontend-*.mjs`（历史前端探针）、`live-332-api.mjs`、`scripts/bench/`。
它们可能有手工复现价值，工具默认不碰；要纳入请先人工核对再改规则。

## 清理后的门禁

移动完成后按 `TESTING-GUIDE.md` 做最小验证，确认引用链没断：

```bash
npm run typecheck
npm run lint
node tests/build-test.mjs versionCheck      # 同时验证 A 组产物可自动重建
```

如需更强证据再跑 `npm test` 全量。注意 `npm test` 会重新生成 A 组隐藏产物，属正常现象，
不是「清理没生效」。B 组若含 git 受控文件，`git status` 会出现 `D`，**确认删除后再提交**，
不要把这些 `D` 当成既定删除提前 commit。

## .workbuddy/tmp 定期治理（防膨胀）

> 目标不是「一次删空」，而是让这个目录**稳定在一个上限内**：新证据持续写入，超期内容按周搬出。
> 2026-11-15 盘点：顶层 2827 个条目（1782 目录 + 1045 文件）、顶层文件 216.3 MB，
> 且 2826 项都是当月半个月内产生的 —— 靠「删旧文件」一次解决不了，必须有定期窗口。

```bash
npm run cleanup:tmp              # ① 只读盘点
npm run cleanup:tmp -- --json    #    机器可读，供定时任务
npm run cleanup:tmp -- --days 21 #    覆盖日志类保留期（正整数）
npm run cleanup:tmp:apply        # ② 隔离超期条目（只移动，不删除）
npm run cleanup:tmp:restore      # ③ 撤销：按 manifest 一键还原
```

隔离目录为 `_待清理确认-tmp-YYYYMMDD/`（与 `collect-stale.mjs` 的隔离目录分开，互不覆盖），
同样附 `manifest.json` 与 `.gitignore`。**确认后直接删掉整个隔离目录才真正释放空间。**

### 判定规则（`collect-tmp-stale.mjs` 的 `CONFIG`）

| 类别 | 保留期 | 例 |
|---|---|---|
| **永久保护** | ∞ | `repo-backup-*.bundle`（项目唯一 Git 恢复手段）、`gitee-releases-backup.json`、`pkg-backup/`、`audit/`（51 个审计报告，绑定当时源码指纹）、`*ledger*`、`*recovery*` / `*restore*` / `*backup*`、`*.patch` 基线、`*.bundle`、`edge-history-copy` 等故障现场 |
| 可再生产物 | **7 天** | `card-io-bundle-*.mjs`、带 6 位随机后缀的一次性探针目录（`frontend-xxx-A1b2C3`） |
| 日志／报告 | **30 天** | `*.log`、其它顶层条目 |

- 只处理 `.workbuddy/tmp` 的**顶层条目**，不递归挑子文件，避免误伤目录内的恢复证据。
- 保护名单命中即跳过并记录；`--apply` 前做校验，隔离目录已存在则中止，避免覆盖上一批。
- 报告里的体积只统计**顶层文件**，目录体积未递归（F 盘 SMR 上全量递归会卡顿）。

### 为什么不能「全删后重跑测试重建」

重跑测试只能产生**当前代码**的新结果，不能复现带历史时间戳、源码指纹、失败现场（「不得误记通过」的样本）的原始证据。历史事故：2026-10-12 `rm -rf .workbuddy/tmp` 删掉 5 个 `repo-backup-*.bundle`，2026-11-03 被外部清理后专门重建 47 MB 恢复包。另：清理证据会让历史日志／HANDOFF 的引用变死链（2026-11-15 清 45 项即新增 12 处）。

### 局限（如实说明）

- 工具**只移动不删除**：tmp 不再膨胀，但磁盘空间真正释放仍需主人定期清空隔离目录。
- 隔离目录会逐周累积，建议每月确认清空一次；若要「自动删除纯运行产物」须主人另行明确授权。
- 超期日志被移走后，历史文档里的路径会失效；按「日志 append-only、归档原文保留」规则不改历史记录，只在当日日志注明为有意失效。

## 隔离目录存量核查（每周）

`--apply` 只把候选搬进 `_待清理确认-*`，空间要真正释放必须人工删除隔离目录。为避免隔离目录悄悄累积成「第二个膨胀源」，
2026-11-21 起把存量核查并入每周自动任务。

```bash
npm run cleanup:quarantine            # 只读：列出全部 _待清理确认-*
npm run cleanup:quarantine -- --json  # 机器可读，供定时任务
node scripts/maintenance/list-quarantine.mjs --budget 120   # 单目录扫描秒数上限（默认 90）
```

输出每个隔离目录的：隔离日期 / 天数 / 顶层条目 / 递归文件数 / 体积 / 最大三个子项 / 保护命中 / 扫描是否完整 / 建议动作。

| 条件 | 建议 |
|---|---|
| 命中保护名单（`repo-backup-*.bundle`、`*.bundle`、`audit/`、`*ledger*`、`*recovery*`/`*restore*`、`*.patch`） | 需人工逐项确认，**不得整目录删** |
| 隔离 ≥30 天 | 建议清空 |
| 隔离 ≥7 天 | 可清空（复述清单后再删） |
| 本周新隔离 | 观察 |
| 扫描超时 | 体积未扫完，先补扫再定 |

- 脚本**只读**：不删除、不移动、不改名。删除动作永远由主人按清单逐项确认后执行。
- 体积为递归统计（与 `cleanup:tmp` 只算顶层文件不同），因此大目录可能扫得久，用 `--budget` 控制上限。
- 定期任务只做盘点与建议，删除仍需人工确认；如主人明确要求「自动删除 N 天前的隔离目录」，属另行授权，不在本工具默认行为内。

## 红线

- 不删 `.workbuddy/tmp` 恢复包与 `release/eb-cache`；不做 `git stash`、手工 `gc`、`git add -A`。
- 隔离目录在人工确认前不得删除；`--apply` 遇到同名隔离目录会直接中止，避免覆盖上一批。
- 提交／封装／推送／发布均须主人明确授权，本流程不触发其中任何一项。

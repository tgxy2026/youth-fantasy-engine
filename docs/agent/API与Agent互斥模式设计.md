# API 与 Agent 互斥模式设计

维护入口：本文为固定路径的当前文档，历史版本快照见 `docs/归档/`；维护方式见 [说明](README.md)。下列验证状态是标明日期的历史记录，不等同于后续版本验收。

状态：**核心互斥已实现并通过代码级验证（2026-11-09）**。用户要求引擎同一时刻只能处于 API 模式或 Agent 模式；早期「设置页只是视图切换」的问题已修复。当前桌面主进程与便携服务都通过同一个 `mode-service` 持有独占所有权、模式记录和 Agent 宿主，页面只能申请租约或请求切换。

> 边界（如实）：已通过 typecheck / lint、模式互斥隔离测试 53/53、便携服务真实进程测试 14/14、全量测试 432/432。**尚未**完成真实桌面安装包 UI 联调、多窗口/云同步并发验证、Windows 真实断电与文件共享语义实测，也未逐个真实 Agent 客户端复测。未封包、未安装、未发布。上述项目不能由本轮证据替代。

## 用户可见行为（已接线）
- **API 模式**：引擎内 AI 功能正常；Agent 宿主的工具调用在模式闸被拒绝（`MODE_BLOCKED`），不会进入页面、不会写账本。
- **Agent 模式**：外部 Agent 经授权的工具调用可用；引擎自身的模型请求（对话、连通性测试、酒馆、嵌入、模型清单/卸载、联网检索）在发送前被拒绝，并给出切换到 API 模式的明确提示。API 模型配置、密钥、项目授权与草稿保持不变。
- 两种模式的切换是真实事务：先写入 `switching` 记录并回读，拒绝两侧新任务，等待全部在途租约排空，确认目标就绪后才提交稳定状态。切换中可取消；取消或任何失败都保持 `blocked`，不报告成功。
- `blocked` 状态在「模型设置」显示原因、锁归属（PID / 进程是否存活）与「安全恢复」入口。恢复必须由用户勾选确认「没有其他引擎实例和未结束的任务」，且不会删除作品数据或 Agent 请求账本。

## 实现位置

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 模式记录 | `scripts/agent-host/mode-file.mjs` | 原子写 + `wx` 独占初始化；损坏、未知版本、切换中断一律失败关闭 |
| 单宿主协调 | `scripts/agent-host/mode-manager.mjs` | 稳定/切换/blocked 三态、租约归属、排空、切换回读、初始化与恢复原语 |
| 所有权锁 | `scripts/agent-host/mode-owner-lock.mjs` | `wx` 独占创建；读取归属；遗留锁移入 `*.stale-*` 证据文件，存活进程的锁拒绝重置 |
| 产品服务 | `scripts/agent-host/mode-service.mjs` | 组合锁、记录与 Agent 宿主；旧配置迁移；文件级安全恢复；模式状态与切换入口 |
| 桌面接线 | `electron/main.cjs` / `electron/preload.cjs` | 主进程持有唯一服务；IPC：状态、租约、切换、取消、恢复、配置 |
| 便携接线 | `scripts/portable-server.mjs` | 服务进程持有唯一服务；同源页面端点 `/api/mode/*` |
| 页面消费 | `src/lib/agentHost/modeBridge.ts` | 唯一状态/切换/恢复入口；`withApiModeLease` 包住整段模型任务 |
| 状态机 | `src/lib/agentHost/modeTransition.ts` + `modeClient.ts` | 页面侧纯状态定义与租约释放必须确认的包装 |

### 模型请求覆盖点（均在发送前申请 API 租约）
- `src/lib/aiCore/chat.ts` 的 `chatRaw`：覆盖 `chat()` 与 `testProvider()`，租约持续到 driver 读完流式响应体。
- `src/lib/aiCore/transport.ts`：`listOpenAIModels` / `listOllamaModels` / `unloadOllamaModel`。
- `src/lib/aiCore/protocols/anthropic.ts`、`gemini.ts`：各自模型清单。
- `src/lib/semantic/embed.ts`：每批请求连同响应体读取都在租约内。
- `src/lib/ai/webSearch.ts`：检索请求在租约内。
- 酒馆 15 处调用走 `chat()`，自动覆盖。

网页版没有本机宿主，不使用模式概念；`hasLocalModeHost()` 只在桌面 preload 提供 Agent 宿主对象或便携页面存在本机服务时为真。**桌面 preload 存在但没有模式方法**（旧版包）会失败关闭，不会静默放行。

## 迁移与恢复规则

1. 模式记录缺失：只有旧 `agent-host.json` 能严格读出 `enabled` 时才初始化；**一律初始化为 API 模式**（旧版「已开启连接」不等于同意停用引擎 API），原授权与项目范围保留，用户可显式切换。
2. 旧配置损坏、缺少 `enabled`、或存在 `.pending` 标记：`blocked`，且**不启动宿主**（宿主启动会回写配置、覆盖证据）。
3. 遗留锁 / 切换中断记录：不按 PID 或超时自动清理。恢复要求用户明确确认；锁与损坏记录移入证据文件后才写回稳定 API 状态。
4. 恢复不删除请求账本；账本损坏仍拒绝启动，交由人工排查。

## 验收

已执行：
- `npx tsc --noEmit`、`npx eslint src tests --max-warnings 0` 通过。
- `tests/agentModeExclusive.test.ts` 53/53：全新安装、旧配置两种状态、损坏配置、未确认标记、第二实例、切换排空/取消/恢复、遗留锁恢复、API 模式下 Agent HTTP 拒绝、Agent 模式下闸放行、租约释放未确认。
- `tests/portableAgentHost.test.ts` 14/14：真实便携服务进程中验证 API 模式拒绝、切换、Agent 模式启用与页面队列。
- 全量测试批次 432/432 通过（A 37 / B 159 / C 132 / D 104）。

未执行 / 未覆盖：
- 真实桌面安装包或免安装目录的 UI → IPC → 宿主闭环；需要重新构建测试版后逐项验证。
- 多窗口、多 profile、便携多标签、云同步与跨设备竞争；当前仍只保证单宿主所有权，不宣称跨设备原子 CAS。
- Windows 文件共享/删除语义、真实断电、磁盘满/只读等故障注入。
- 真实 Agent 客户端（Codex 以外）逐项复测与安装包流程。

任何一项未完成前，不应把本轮结果表述为整版发布验收。

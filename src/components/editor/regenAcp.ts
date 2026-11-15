/**
 * 批量重生成摘要 · ACP 发送器（3.5.6）。
 *
 * 抽成独立模块有两个原因：
 *   ① `useNovelEditorModel.ts` 已贴 1200 行红线，接线只该占一行；
 *   ② 「整批只确认一次」是这条链路的关键语义，放在这里才能被单测直接钉住。
 */
import { confirmDialog } from '@/components/dialogs/dialogs'
import { acpGateMessage, acpGatedText } from '@/lib/agentHost/acpGate'

export interface RegenAcpContext {
  generation: string
  name: string
}

/**
 * 构造本批的 ACP 发送器。
 *
 * 🔴 `askOnce: true`：一批可能有几十章，逐章弹确认等于毁掉这个功能；
 *    `signal` 用任务中心的取消信号，点「中止」后正在跑的那一次也会收到取消。
 */
export function createRegenAcpSend(acp: RegenAcpContext, signal: AbortSignal) {
  return acpGatedText({
    task: 'batch-summary',
    generation: acp.generation,
    title: '发送章节正文至 ACP Agent',
    message: acpGateMessage(acp.name, '本批各章正文（逐章发送）', '重生成章节摘要'),
    agentName: acp.name,
    ask: confirmDialog,
    askOnce: true,
    signal,
  })
}

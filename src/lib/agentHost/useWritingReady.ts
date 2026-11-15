/**
 * 3.5.6 · 「这个 AI 入口现在能不能用」的统一判据。
 *
 * = API 模型就绪 **或** ACP 通道就绪。
 *
 * 🔴 用错会出事：
 *   · 任务层已支持 ACP（显式 `acpText`，或经 `acpRegistry` 兜底）的入口 → 用它；
 *     否则零 API 配置的作者会看到按钮被禁用，而实际链路是通的。
 *   · 只能本地 API 的入口（投稿审核这类要求内容只在本机处理的功能）→ 仍必须用
 *     `useAIReady`，不能换成这里。
 *
 * 判据只做「合流」，不改变 ACP 自己的就绪条件（`useAcpWriting` 仍负责代次与连接状态）。
 */
import { useAIReady } from '@/lib/ai/useAIReady'
import { useAcpWriting } from '@/lib/agentHost/useAcpWriting'

export interface WritingReady {
  /** 任一通道就绪即可点 */
  ready: boolean
  /** 这次就绪是不是来自 ACP（用于文案：「由 Agent 回答」而不是「当前模型」） */
  viaAcp: boolean
  /** ACP 就绪时的 Agent 名称；否则 null */
  agentName: string | null
  /**
   * ACP 就绪时的代次；否则 null。
   * 🔴 闸门（`acpGatedText`）必须带真实代次 —— 传空串会在发送前被 `assertAcpWritingCurrent` 拒掉。
   */
  generation: string | null
}

export function useWritingReady(): WritingReady {
  const { ready: aiReady } = useAIReady()
  const acp = useAcpWriting()
  const viaAcp = !!acp?.ready
  return {
    ready: aiReady || viaAcp,
    viaAcp,
    agentName: viaAcp && acp ? acp.name : null,
    generation: viaAcp && acp ? acp.generation : null,
  }
}

/**
 * ACP 外发确认的「一次授权」账本（渲染进程内存级）。
 *
 * 🔴 2026-11-14 主人明确要求：每次调用都弹「把资料发给 Agent」太烦。
 *    改成**连接成功后提示一次**，之后同一进程内所有 AI 功能不再逐次弹；
 *    重启应用、停用连接、换 Agent 都视为新的一次连接，会重新提示。
 *
 * 为什么放在内存里而不是持久化：
 *   「重启后要重新确认」本身就是要求的一部分。写盘反而会让作者永久免确认，
 *   而他可能早就忘了自己授权过什么。
 *
 * 按 **Agent 名称** 记账而不是按代次：模型/推理档位切换也会刷新代次，
 * 但接收方没变，再弹一次只会让人觉得「又在问」。
 */
let consentedAgent: string | null = null

/** 连接成功后调用：把该 Agent 记为「已告知」。 */
export function grantAcpConsent(agentName: string): void {
  const name = (agentName ?? '').trim()
  consentedAgent = name || null
}

/** 该 Agent 是否已经告知过（同一进程内）。 */
export function hasAcpConsent(agentName: string | null | undefined): boolean {
  const name = (agentName ?? '').trim()
  return !!name && consentedAgent === name
}

/** 停用连接 / 换 Agent / 账号退出时调用：下次连接要重新告知。 */
export function revokeAcpConsent(): void {
  consentedAgent = null
}

/** 仅测试用：读当前记录，便于断言。 */
export function currentAcpConsentForTest(): string | null {
  return consentedAgent
}

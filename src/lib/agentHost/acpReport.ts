/**
 * 3.5.4 · ACP 纯文本报告发送闸门。
 *
 * 综合诊断 / 爽点毒点 / 黄金三章 / 写作简报 / 手动单章摘要共用这一条路径：
 *   ① 发送前展示接收方与**实际资料范围**（接收方名 + 本次会带出的内容）；
 *   ② 发送前核对 ACP 设置代次与项目/账号归属；
 *   ③ 结果落地前再核对一次，避免取消后迟到结果或切换项目后旧结果串入。
 *
 * 报告类任务只返回正文，不写作品；摘要由调用方回填现有摘要框。
 * 🔴 本文件属 lib 层：确认弹窗由调用方注入，不反向依赖 components/。
 */
import { acpWrite, assertAcpWritingCurrent, type AcpTask } from './acpBridge'

/** 3.5.4 纳入的纯文本报告任务（不含写正文的 continuation / rewrite）。 */
export type AcpReportTask = Extract<AcpTask, 'diagnosis' | 'pleasure' | 'opening' | 'briefing' | 'summary'>

/** 与界面确认弹窗同形的最小契约（由调用方传 confirmDialog）。 */
export interface AcpReportConfirmOptions {
  title: string
  message: string
  confirmText: string
}

const REPORT_SCOPE: Record<AcpReportTask, { title: string; full: string }> = {
  diagnosis: { title: '发送章节资料至 ACP Agent', full: '本章正文与设定资料' },
  pleasure: { title: '发送章节资料至 ACP Agent', full: '本章正文与设定资料' },
  opening: { title: '发送作品开头至 ACP Agent', full: '作品开头（前三章或已有章节）与设定资料' },
  briefing: { title: '发送章节资料至 ACP Agent', full: '当前章节正文与设定资料' },
  summary: { title: '发送本章正文至 ACP Agent', full: '本章正文' },
}

/**
 * 外发确认文案。综合诊断的简略模式只发压缩摘要，必须如实写明，
 * 否则作者会以为发出的是完整正文。
 */
export function acpReportMessage(task: AcpReportTask, agentName: string, brief = false): string {
  const scope = task === 'diagnosis' && brief ? '本章压缩摘要与设定资料' : REPORT_SCOPE[task].full
  return `接收方为 ${agentName}。本次发送${scope}，只用于生成文本报告。`
}

export interface AcpReportSendInput {
  task: AcpReportTask
  generation: string
  agentName: string
  /** 综合诊断简略模式：只发送压缩摘要 */
  brief?: boolean
  signal?: AbortSignal
  /** 项目 / 账号 / 章节归属校验（发送前与结果落地前各一次） */
  assertCurrent?: () => void
  /** 应用内确认弹窗（生产传 confirmDialog；测试可注入假确认） */
  ask: (options: AcpReportConfirmOptions) => Promise<boolean>
}

/** 生成传给 `ai*` 任务的 `acpText`：确认 → 代次/归属校验 → 发送 → 落地前再校验。 */
export function acpReportText(input: AcpReportSendInput): (prompt: string) => Promise<string> {
  return async prompt => {
    const ok = await input.ask({
      title: REPORT_SCOPE[input.task].title,
      message: acpReportMessage(input.task, input.agentName, input.brief === true),
      confirmText: '确认发送',
    })
    if (!ok) throw new Error('已取消发送。')
    await assertAcpWritingCurrent(input.generation)
    input.assertCurrent?.()
    const text = await acpWrite(input.task, input.generation, prompt, { signal: input.signal })
    input.assertCurrent?.()
    await assertAcpWritingCurrent(input.generation)
    return text
  }
}
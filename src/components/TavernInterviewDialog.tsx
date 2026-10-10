/**
 * 对话引导弹窗（访谈式创建角色卡 / 剧本 / 故事）
 *
 * 它只剩一层薄壳：把「酒馆这一侧的东西」（用会话指定的模型发请求、按 kind 选提纲、把结果翻成
 * 对应草稿）接上共用的访谈界面 `InterviewChat`。
 * 界面与访谈机制都在共用件里 —— 2026-09-15 起同一套引导要给全局所有 AI 补全入口复用。
 */
import { specOf, tavernCallChat, type InterviewKind } from '@/lib/tavern/interview'
import InterviewChat from '@/components/InterviewChat'

export default function TavernInterviewDialog({ open, kind, subject, existing, providerId, onClose, onApply }: {
  open: boolean
  kind: InterviewKind
  /** 「角色卡」/「剧本」—— 只用于文案 */
  subject: string
  /** 补完模式：把已有内容作为起点交进去（可空 = 从零创建） */
  existing?: string
  /** 这一场指定的模型（不传则用控制面板的默认模型） */
  providerId?: string
  onClose: () => void
  onApply: (filled: Record<string, string>) => void
}) {
  if (!open) return null
  return (
    <InterviewChat
      subject={subject}
      spec={specOf(kind)}
      existing={existing}
      callChat={tavernCallChat(providerId)}
      onClose={onClose}
      onApply={onApply}
    />
  )
}

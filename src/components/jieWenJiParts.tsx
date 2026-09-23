// ============ 颉文姬 · 共用常量 / 类型 / 小件（C1 · 2.4.2 自 JieWenJi.tsx 拆出）============
// 🔴 纯搬家：一行未改（只给顶层声明补了 export —— 原文里它们是本文件私有，现被子组件共用）。
import { ProofreadIssue } from '../lib/aiTasks'
import { SettingEntityType, MatchStatus } from '../lib/settingLedger'

/** 建议段标记（NovelEditor 的写入/清除共用） */
export const ADVICE_START = '【颉文姬建议·开始】'
export const ADVICE_END = '【颉文姬建议·结束】'

export interface Props {
  content: string
  /** 作品开头（前 3 章）正文，供「黄金三章检查」使用 */
  openingText?: string
  onClose: () => void
  /** 读取当前正文选区文本（由编辑器在选区变化时缓存，面板聚焦也不丢） */
  getSelectionText?: () => string | null
  /** 读取选区起止（供建议段定位） */
  getSelectionRange?: () => { start: number; end: number } | null
  /** 把 AI 改稿写入原文下方的新段落（建议段模式，带标记） */
  onApplyAdvice?: (rewritten: string, sel: { start: number; end: number } | null) => void
  /** 清除正文里全部建议段 */
  onClearAdvice?: () => void
  /** 用新文本整体替换正文（校对"替换此条"用） */
  onApplyContent?: (next: string) => void
  /** 本章「章节压缩摘要」（编辑器顶栏同步过来，约原文 1/10），供校对 / 综合诊断「简略模式」使用 */
  summary?: string
  /** 本章标题（补登写入时填进「首次出场 / 首次出现章节」） */
  chapterTitle?: string
  /** 补登完成后回调（用于提示数据已更新、需要刷新设定表） */
  onLedgerCommitted?: (created: number) => void
  /** #015：当前章节 id，用于 AI 上下文「相关章节召回」（取代从头截断） */
  focusChapterId?: string
}

export type Mode = 'clinic' | 'edit' | 'review' | 'brief' | 'ledger'

export const INSTRUCTIONS = ['润色', '扩写', '精简', '改语气', '换视角']

/**
 * 校对的**两块**（2026-09-20 拆分，老大要求）。
 * 拆开的实际收益：文字层不读设定资料 —— 块内注入少了几千字，出结果明显更快；
 * 逻辑层才读设定（判前后矛盾、与设定冲突必须有依据）。
 */
export type ProofScope = 'text' | 'logic'
export const PROOF_ORDER: ProofScope[] = ['text', 'logic']
export const PROOF_META: Record<ProofScope, { label: string; title: string }> = {
  text: { label: '查错别字与语病', title: '错别字 / 语病 / 标点 —— 逐字逐句读本章正文，不读设定资料（更快）' },
  logic: { label: '查逻辑与设定矛盾', title: '逻辑矛盾 / 时间空间错乱 / 与设定资料冲突 —— 会读项目设定资料' },
}
export interface ProofState {
  loading: boolean
  issues: ProofreadIssue[]
  scanned: number
  skipped: number
  progress: { done: number; total: number }
  done: boolean
  error: string
  cancelled: boolean
}
export const blankProof = (): ProofState => ({
  loading: false, issues: [], scanned: 0, skipped: 0,
  progress: { done: 0, total: 0 }, done: false, error: '', cancelled: false,
})

/** 轻量 markdown 渲染：支持 ## 小标题 / 数字与 - 列表 / **加粗**，其余按段落展示 */
export function renderInline(s: string) {
  const parts = s.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4
      ? <strong key={i} className="text-amber font-semibold">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>,
  )
}

export function renderReport(text: string) {
  if (!text) return null
  return (
    <div className="space-y-1">
      {text.split('\n').map((ln, i) => {
        const t = ln.trim()
        if (!t) return <div key={i} className="h-1" />
        if (t.startsWith('## ')) return <div key={i} className="text-12 font-semibold text-amber mt-2 mb-0.5">{renderInline(t.slice(3))}</div>
        if (/^\d+[.、)]/.test(t) || t.startsWith('- ') || t.startsWith('• ') || t.startsWith('* ')) {
          const num = t.match(/^\d+/)?.[0]
          return (
            <div key={i} className="flex gap-1.5 text-11 text-ink-100 leading-relaxed">
              <span className="text-amber/80 shrink-0">{num ?? '·'}</span>
              <span className="min-w-0">{renderInline(t.replace(/^\d+[.、)]\s*/, '').replace(/^[-•*]\s*/, ''))}</span>
            </div>
          )
        }
        return <div key={i} className="text-11 text-ink-100 leading-relaxed">{renderInline(t)}</div>
      })}
    </div>
  )
}

/** 补登：实体类型的展示顺序 */
export const LEDGER_TYPES: SettingEntityType[] = ['人物', '势力', '地点', '种族', '物品', '术语']

/** 补登：三档比对结果的徽标样式 */
export const STATUS_META: Record<MatchStatus, { label: string; cls: string }> = {
  registered: { label: '已登记', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  duplicate: { label: '疑似重复', cls: 'bg-amber/15 text-amber border-amber/30' },
  new: { label: '待补登', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
}

export const SEV_BADGE: Record<string, string> = {
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  warn: 'bg-amber/15 text-amber border-amber/30',
  info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  high: 'bg-red-500/15 text-red-300 border-red-500/30',
  medium: 'bg-amber/15 text-amber border-amber/30',
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  '严重': 'bg-red-500/15 text-red-300 border-red-500/30',
  '中等': 'bg-amber/15 text-amber border-amber/30',
  '提示': 'bg-sky-500/15 text-sky-300 border-sky-500/30',
}

export function SevBadge({ s }: { s: string }) {
  const cls = SEV_BADGE[s] ?? 'bg-ink-700 text-ink-300 border-ink-600'
  return <span className={`inline-block px-1.5 py-px rounded text-9 border ${cls}`}>{s}</span>
}


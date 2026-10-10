// ============ 颉文姬 · 共用常量 / 类型 / 小件（C1 · 2.4.2 自 JieWenJi.tsx 拆出）============
// 🔴 纯搬家：一行未改（只给顶层声明补了 export —— 原文里它们是本文件私有，现被子组件共用）。
import { ProofreadIssue } from '@/lib/aiTasks'
import { SettingEntityType, MatchStatus } from '@/lib/settingLedger'
import type { PostProcessKind, PostProcessStatus } from '@/lib/chapterPostProcess'

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

export type Mode = 'clinic' | 'edit' | 'review' | 'brief' | 'ledger' | 'post'

// 🔴 这两个值是**直接进提示词**的（`buildRewriteAsk` 的第一段），不是纯界面标签 ——
//    改名时必须同步 `aiTasks/jieWenJi.ts` 的 `P_rewrite_passage` 第 2 条定义，否则模型
//    拿到一个没有定义的词（2026-10-09 主人要求：改语气 → 语气、换视角 → 视角）。
export const INSTRUCTIONS = ['润色', '扩写', '精简', '语气', '视角']

/**
 * 续写（2.9.2 · ③）：作者可勾选的「给 AI 的资料」清单。
 *
 * `tabIds` 交给 `buildProjectContext` 的 `onlyTabIds`（设定类页签）；
 * 空数组表示本项不走页签 —— 「章节摘要 / 前文章节」由
 * `getContinuationSources()` 专门取数，「写作文风」走 `activeFingerprintNote()`。
 *
 * ⚠️ 这里只声明「勾什么」，**不声明「怎么取」** —— 取数实现一律在 lib 层，
 *    免得界面与取数各写一份口径（项目红线：AI 读哪些数据只能有一个源）。
 */
interface ContinuePickItem {
  key: string
  label: string
  /** 设定类：映射到 `buildProjectContext` 的页签 id；空数组表示另有专门取数 */
  tabIds: string[]
  /** 默认是否勾选 */
  def: boolean
  /** 悬停说明（作者据此判断要不要勾） */
  hint: string
}

export const CONTINUE_PICKS: ContinuePickItem[] = [
  { key: 'outline', label: '本章细纲', tabIds: ['chapter-outline'], def: true, hint: '续写要沿着本章既定目标走（最关键的一项）' },
  { key: 'chars', label: '主要角色', tabIds: ['char-main'], def: true, hint: '人物言行与口吻保持一致；本章出场人物由正文自动识别' },
  { key: 'summaries', label: '章节摘要', tabIds: [], def: true, hint: '本章及前几章的压缩摘要（章数可调）' },
  { key: 'style', label: '写作规范', tabIds: ['style'], def: true, hint: '人称 / 时态 / 标点等硬约束' },
  // 🔴 「前文章节」取每章的**末尾**，所以它同时是衔接参照 —— 原先独立的「上一章结尾」
  //    选项已并入本项（2026-10-09 主人拍板删除，避免两个勾项做同一件事）。
  { key: 'prev-texts', label: '前文章节', tabIds: [], def: true, hint: '往前带几章的正文（取每章末尾）；最占预算，章数越多越容易超上下文' },
  { key: 'world', label: '世界设定', tabIds: ['worldbase', 'power', 'terms'], def: false, hint: '世界设定 + 力量体系 + 名词术语' },
  { key: 'volume', label: '分卷大纲', tabIds: ['volume-outline'], def: false, hint: '本章在卷里的位置与下一步走向' },
  { key: 'master', label: '全书总纲', tabIds: ['master'], def: false, hint: '长线方向（很吃预算）' },
  { key: 'foreshadow', label: '伏笔追踪', tabIds: ['foreshadow'], def: false, hint: '避免与既有伏笔冲突，也可顺手埋收' },
  { key: 'fingerprint', label: '写作文风', tabIds: [], def: false, hint: '按你的文风指纹（#015 写作文风档）保持一致' },
  { key: 'hookpoints', label: '爽点节奏', tabIds: ['hookpoints'], def: false, hint: '续写的爽点安排参考' },
]

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
function renderInline(s: string) {
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
  registered: { label: '已登记', cls: 'bg-success/15 text-success border-success/30' },
  duplicate: { label: '疑似重复', cls: 'bg-amber/15 text-amber border-amber/30' },
  new: { label: '待补登', cls: 'bg-danger/15 text-danger border-danger/30' },
}

// ============ 章后整理（3.0 · W2-1）============
// 「每章写完后把本章带来的变化整理出来，作者确认后才落库」——四类变化的展示顺序与命名。
// 🔴 与「补登」的分工：「补登」只管设定实体（事实）；「整理」把四类收进一个入口，
//    多出的三类（伏笔 / 关系 / 人物状态）此前只有表、没有章后入口。

export const POST_KINDS: { kind: PostProcessKind; label: string; hint: string }[] = [
  { kind: 'entity', label: '事实 · 设定', hint: '本章新出现的人 / 势力 / 地点 / 种族 / 物品 / 术语' },
  { kind: 'foreshadow', label: '伏笔', hint: '本章埋设或回收的伏笔' },
  { kind: 'relation', label: '关系', hint: '本章人物关系发生的变化' },
  { kind: 'status', label: '人物状态', hint: '本章人物状态的变化' },
]

/** 章后整理：四档结果的徽标样式（`changed` = 有变化待采纳；`new` = 还没登记过） */
export const POST_STATUS_META: Record<PostProcessStatus, { label: string; cls: string }> = {
  registered: { label: '无变化', cls: 'bg-success/15 text-success border-success/30' },
  duplicate: { label: '疑似重复', cls: 'bg-amber/15 text-amber border-amber/30' },
  changed: { label: '有变化', cls: 'bg-info/15 text-info border-info/30' },
  new: { label: '未登记', cls: 'bg-danger/15 text-danger border-danger/30' },
}

const SEV_BADGE: Record<string, string> = {
  error: 'bg-danger/15 text-danger border-danger/30',
  warn: 'bg-amber/15 text-amber border-amber/30',
  info: 'bg-info/15 text-info border-info/30',
  high: 'bg-danger/15 text-danger border-danger/30',
  medium: 'bg-amber/15 text-amber border-amber/30',
  low: 'bg-success/15 text-success border-success/30',
  '严重': 'bg-danger/15 text-danger border-danger/30',
  '中等': 'bg-amber/15 text-amber border-amber/30',
  '提示': 'bg-info/15 text-info border-info/30',
}

export function SevBadge({ s }: { s: string }) {
  const cls = SEV_BADGE[s] ?? 'bg-ink-700 text-ink-300 border-ink-600'
  return <span className={`inline-block px-1.5 py-px rounded text-9 border ${cls}`}>{s}</span>
}


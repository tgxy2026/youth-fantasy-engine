// ============ AI 任务层 · 逐句校对 ============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #4 段）。
import { chat, requireActiveProvider, isCancelled, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import { authorBlock, newAuthorFence } from '../promptGuard'
import { longStream } from './stream'
import type { PromptDef } from '../promptSettings'

// ---------- AI 校对（错别字 / 语病 / 逻辑 / 设定矛盾） ----------

export interface ProofreadIssue {
  type: string
  /** 原文片段（逐字引用，前端据此定位） */
  quote: string
  /** 建议改成 */
  fix: string
  /** 简短原因 */
  why: string
  /** 前端定位到的正文下标；-1 表示未能精确定位；undefined 表示定位已失效（重叠替换后），下次替换走全文搜索兜底 */
  at?: number
}

let PROOFREAD_SYS = `你是资深中文网络小说校对编辑。请逐句检查作者给出的正文，只报**确定的问题**，不做文风润色、不提写作建议。

检查范围：
1. 错别字：同音别字、形近字、专有名词写错（含人名前后不一致）。
2. 语病：成分残缺、搭配不当、语序混乱、指代不明、明显重复啰嗦。
3. 逻辑：前后矛盾、时间/空间错乱、常识错误、人物行为动机断裂。
4. 设定矛盾：与【设定资料】冲突（如姓名、境界、称谓、势力归属对不上）。
5. 标点：中英标点混用、引号/书名号不成对、逗号连缀成句。

输出要求：
- 返回 JSON 数组，元素形如 {"type":"错别字","quote":"原文片段","fix":"改后的片段","why":"简短原因"}。
- quote 必须**逐字照抄原文**（含标点，长度 6~40 字，能唯一定位），不得改写、不得省略中间内容——前端要靠它在正文里定位。
- fix 只给 quote 对应位置改好后的完整片段，长度尽量与 quote 接近。
- type 只能是：错别字 / 语病 / 逻辑 / 设定矛盾 / 标点。
- 没有问题就返回 []。宁可少报，不可误报；不确定的不要报。
- 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

/**
 * 按段落切块，尽量贴近目标长度且不切断句子。
 * 关键：保留原文的每一个字符（含原始换行个数），使切出的块都是【原文的精确子串】，
 * 这样 aiProofread 里用 text.indexOf(chunk, offset) 定位才可靠——
 * 旧版把多空行压成单换行再重拼，导致 chunk 与原文对不上、at 定位漂移（隐患）。
 */
function chunkText(text: string, target = 2200): string[] {
  // 用捕获分组把「文本段 + 紧随其后的换行分隔段」交替切出，拼接即可无损还原原文
  const parts = text.split(/(\n+)/)
  // 每段 = 文本 + 其后的换行符（结尾段无换行则补空串）
  const paras: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    paras.push(parts[i] + (i + 1 < parts.length ? parts[i + 1] : ''))
  }
  const out: string[] = []
  let buf = ''
  for (const p of paras) {
    // 纯空行：直接并入当前块，不单独成块
    if (!p.trim()) { buf += p; continue }
    if (buf && buf.length + p.length > target) { out.push(buf); buf = '' }
    if (p.trim().length > target * 1.6) {
      // 超长段落再按句末标点切，避免把一句话拦腰斩断
      const sents = p.split(/(?<=[。！？…”])/)
      for (const s of sents) {
        if (buf && buf.length + s.length > target) { out.push(buf); buf = '' }
        buf += s
      }
    } else {
      buf += p
    }
  }
  if (buf.trim()) out.push(buf)
  return out
}

export interface ProofreadOptions {
  /** 设定资料上下文（用于查"设定矛盾"），可空 */
  context?: string
  /** 进度回调（已完成块 / 总块数） */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** 最多校对多少块，防止一章几万字把本地模型跑到天亮 */
  maxChunks?: number
  /** 流式回调：提供时逐块可见模型原始输出 */
  onToken?: (delta: string) => void
}

export interface ProofreadResult {
  issues: ProofreadIssue[]
  /** 实际校对的字符数 */
  scanned: number
  /** 因超出块数上限未校对的字符数 */
  skipped: number
}

/**
 * AI 深度校对。分块串行送模型（本地模型并发只会互相抢显存），
 * 每块结果就地在原文里定位，定位不到的条目直接丢弃——避免给作者一堆点不动的提示。
 */
export async function aiProofread(text: string, opts: ProofreadOptions = {}): Promise<ProofreadResult> {
  const cfg = await requireActiveProvider()
  const all = chunkText(text)
  const maxChunks = opts.maxChunks ?? 8
  const chunks = all.slice(0, maxChunks)
  const skipped = all.slice(maxChunks).reduce((s, c) => s + c.length, 0)

  const issues: ProofreadIssue[] = []
  const seen = new Set<string>()
  let scanned = 0
  let offset = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    // 本块在全文中的起点（分块只做了空白归并，用 indexOf 足够可靠）
    const base = text.indexOf(chunk, offset)
    const chunkStart = base >= 0 ? base : offset
    offset = chunkStart + chunk.length

    const user = `【设定资料】
${opts.context?.trim() || '（无，请只做文字与逻辑层面的校对）'}

【待校对正文】
${authorBlock(newAuthorFence(), chunk)}

请返回问题清单的 JSON 数组。`

    let reply = ''
    try {
      reply = await chat(
        cfg,
        [
          { role: 'system', content: composeSystemPrompt(PROOFREAD_SYS, cfg) },
          { role: 'user', content: user },
        ],
        { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal, onToken: longStream(opts.onToken), json: true },
      )
    } catch (e) {
      if (isCancelled(e)) break
      // 单块失败不整轮报废，继续下一块
      opts.onProgress?.(i + 1, chunks.length)
      continue
    }

    scanned += chunk.length
    for (const it of parseObjectArray(reply)) {
      const quote = asText(it.quote ?? it['原文'] ?? it.text)
      const fix = asText(it.fix ?? it['建议'] ?? it.suggestion)
      const type = asText(it.type ?? it['类型']) || '其他'
      const why = asText(it.why ?? it['原因'] ?? it.reason)
      if (!quote || quote.length < 2) continue
      // 必须能在原文里定位，否则作者点了也没法改
      const rel = chunk.indexOf(quote)
      if (rel < 0) continue
      const at = chunkStart + rel
      const dedup = `${at}::${quote}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      issues.push({ type, quote, fix, why, at })
    }
    opts.onProgress?.(i + 1, chunks.length)
  }

  issues.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return { issues, scanned, skipped }
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const PROOFREAD_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'proofread', group: '编辑与审校', name: '逐句校对', note: '只报确定的问题（错别字/语病/硬伤），不做文风润色。' },
    read: () => PROOFREAD_SYS,
    write: t => { PROOFREAD_SYS = t },
  },
]

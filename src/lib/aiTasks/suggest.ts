// ============ AI 任务层 · 灵感 / 审核类小工具（取名 · 敏感词复核）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #5 + #6 段）。
// 为什么合成一个文件：两段各 40~50 行，单独成文件太碎；同为「小工具型」调用，内聚且零新耦合。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import type { PromptDef } from '../promptSettings'

/** 「敏感词复核」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_sensitive_recheck = `你是网络文学平台的审核经验丰富的编辑。作者用本地词库扫出了一批"疑似敏感词"命中，其中很多是误报（词库只匹配字面，不看语境）。请逐条判断真实风险。

规则：
1. 返回 JSON 数组，元素形如 {"word":"命中词","risk":"误报|低|中|高","reason":"简短判断依据","suggestion":"若有风险，给出可直接替换的写法；误报则留空"}。
2. 结合上下文判断：同一个词在不同语境里风险完全不同（如"血"在打斗描写中通常无风险）。
3. suggestion 要保持原意与文风，不要改成不通顺的替代词。
4. reason 控制在 25 字内。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

/** 「随机取名」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_name_suggest = `你是网络小说取名顾问。按作者要求生成候选名字，每个名字附一句寓意/来源说明。
规则：
1. 返回 JSON 数组，元素形如 {"name":"名字","meaning":"一句话寓意或来源"}。
2. 名字要契合给定的世界观与风格，读音顺口、不拗口、不生僻到没人会念。
3. 彼此之间风格统一但不重复雷同；不要和【世界观上下文】里已出现的名字重复。
4. meaning 控制在 30 字内，说清取名依据即可。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

// ---------- AI 取名 ----------

export interface NameSuggestRequest {
  /** 取名对象：人物 / 门派 / 地名 / 招式 / 法宝… */
  target: string
  /** 风格要求（东方仙侠 / 现代都市 / 西幻…） */
  style: string
  /** 作者的补充要求 */
  extra: string
  /** 世界观上下文 */
  context: string
  count?: number
  signal?: AbortSignal
  /** 流式回调：提供时取名过程逐块可见 */
  onToken?: (delta: string) => void
}

export interface NameSuggestion {
  name: string
  /** 取名理由 / 寓意 */
  meaning: string
}

export async function aiSuggestNames(req: NameSuggestRequest): Promise<NameSuggestion[]> {
  // #014 用途路由：取名属「批量整理」（短输出、常反复试）
  const cfg = await requireProviderFor('utility')
  const n = req.count ?? 10
  const sys = P_name_suggest
  const user = `【取名对象】${req.target}
【风格要求】${req.style || '（未指定，按世界观自行判断）'}
【补充要求】${req.extra || '（无）'}

【世界观上下文】
${req.context.trim() || '（无）'}

请给出 ${n} 个候选。`
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }], {
    json: true,
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: req.signal,
    onToken: req.onToken,
  })
  const out: NameSuggestion[] = []
  const seen = new Set<string>()
  for (const it of parseObjectArray(text)) {
    const name = asText(it.name ?? it['名字'] ?? it['名称'])
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, meaning: asText(it.meaning ?? it['寓意'] ?? it['说明']) })
    if (out.length >= n) break
  }
  return out
}

// ---------- 敏感词语境复核 ----------

export interface SensitiveHitInput {
  word: string
  /** 命中处的上下文片段 */
  snippet: string
}

export interface SensitiveReview {
  word: string
  /** 误报 / 低 / 中 / 高 */
  risk: string
  reason: string
  /** 建议替换写法（误报时可为空） */
  suggestion: string
}

export async function aiReviewSensitive(hits: SensitiveHitInput[], opts?: { signal?: AbortSignal; onToken?: (delta: string) => void }): Promise<SensitiveReview[]> {
  // #014 用途路由：敏感词复核属「批量整理」（逐条判断、调用频繁）
  const cfg = await requireProviderFor('utility')
  const sys = P_sensitive_recheck
  const list = hits
    .slice(0, 40)
    .map((h, i) => `${i + 1}. 命中词「${h.word}」\n   上下文：${h.snippet.replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n')
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: `【命中清单】\n${list}\n\n请逐条给出判断。` }], {
    json: true,
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: opts?.signal,
    onToken: opts?.onToken,
  })
  const out: SensitiveReview[] = []
  for (const it of parseObjectArray(text)) {
    const word = asText(it.word ?? it['词'] ?? it['命中词'])
    if (!word) continue
    out.push({
      word,
      risk: asText(it.risk ?? it['风险']) || '低',
      reason: asText(it.reason ?? it['依据'] ?? it['原因']),
      suggestion: asText(it.suggestion ?? it['建议']),
    })
  }
  return out
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const SUGGEST_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'name-suggest', group: '灵感工具', name: '随机取名', note: '按类型 × 风格批量出名字，每个附一句寓意。' },
    read: () => P_name_suggest,
    write: t => { P_name_suggest = t },
  },
  {
    meta: { id: 'sensitive-recheck', group: '编辑与审校', name: '敏感词复核', note: '对本地词库扫出的疑似命中做复核，剔掉误报。' },
    read: () => P_sensitive_recheck,
    write: t => { P_sensitive_recheck = t },
  },
]

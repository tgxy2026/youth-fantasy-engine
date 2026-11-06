// ============ AI 任务层 · 灵感 / 审核类小工具（取名 · 敏感词复核）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #5 + #6 段）。
// 为什么合成一个文件：两段各 40~50 行，单独成文件太碎；同为「小工具型」调用，内聚且零新耦合。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { parseObjectArray, asText } from '@/lib/ai/aiParse'
import type { PromptDef } from '@/lib/ai/promptSettings'

/** 「敏感词复核」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_sensitive_recheck = `你是网络文学平台经验丰富的资深审读编辑。作者用本地词库初筛出一批「疑似敏感词」命中，但机械匹配极易产生大量语境误报（例如正常的成语典故、武侠修仙打斗、历史官制名词被误击）。请结合具体上下文逐条进行准确的真实风险复核。

规则：
1. 严格结合上下文语境甄别：
   - 误报：属于正常文学修辞（如「血流成河」「尸横遍野」在激烈战争场面中）或无违规意图的固有词汇，一律判定为「误报」；
   - 真实违规：涉及实质性违法违规、极端暴力血腥、低俗涉黄或涉政违禁倾向，按严重程度判定为「低|中|高」。
2. suggestion 处理建议：若判定为误报，suggestion 留空字符串 ""；若有真实风险，给出通顺自然、不破坏原意与文风的可替换表达。
3. reason 简明扼要，控制在 25 字以内，点透语境判断依据。
4. 返回 JSON 数组，元素形如 {"word":"命中词","risk":"误报|低|中|高","reason":"简短判断依据","suggestion":"若有风险，给出可直接替换的写法；误报则留空"}。
5. 只输出一个 JSON 数组，不要任何解释说明、不要 markdown 代码块标记。`

/** 「随机取名」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_name_suggest = `你是资深中文网络小说取名顾问。按作者要求生成高质量、有辨识度、好读好记的候选名字，每个名字附一句简短寓意/来源说明。

规则：
1. 严格契合对象与题材风格：
   - 人物名：姓与名声调平仄错落、顺口易读，契合人物阶层、道统、阵营或性格；避免生硬堆叠玛丽苏生僻字或大众网名感；
   - 势力/宗门：字面带门派气象、宗门底蕴或时代风貌，符合正道/魔宗/世家/王朝各自规制；
   - 功法/器物/地名：立足天地法则、神话典故或具体功能意象，避免廉价页游感。
2. 严禁套路雷同：不要生成知名网文主角的换字模仿（如萧炎/林动/叶凡的同音字），不要千篇一律滥用「轩、宇、寒、雪、瑶」等烂大街字眼。
3. 严禁与【世界观上下文】已出现的实体同名或极易混淆；候选彼此之间风格协调但字面绝不雷同。
4. meaning 控制在 30 字以内，说清字面由来、音韵意象或象征意义，不写空话。
5. 返回 JSON 数组，元素形如 {"name":"名字","meaning":"一句话寓意或来源"}。
6. 只输出一个 JSON 数组，不要任何解释说明、不要 markdown 代码块标记。`

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
  // #014 用途路由：取名属「整理」（短输出、常反复试）
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
    output: 'json-object', reasoning: 'off',
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
  // #014 用途路由：敏感词复核属「整理」（逐条判断、调用频繁）
  const cfg = await requireProviderFor('utility')
  const sys = P_sensitive_recheck
  const list = hits
    .slice(0, 40)
    .map((h, i) => `${i + 1}. 命中词「${h.word}」\n   上下文：${h.snippet.replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n')
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: `【命中清单】\n${list}\n\n请逐条给出判断。` }], {
    output: 'json-object', reasoning: 'off',
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

/**
 * 市场雷达（2.8.0 · 台账 #018）。
 *
 * 【要解决的问题】选题阶段的困惑：「这个题材现在还有没有市场？哪个平台合适？该蹭什么热点？」
 * 传统做法是打开搜索引擎自己翻——本功能把「检索 → 归纳 → 结构化成报告」串成一步。
 *
 * 【为什么能做得这么薄】联网检索**早就有了**：`lib/webSearch.ts`（博查 / SearXNG / 自定义三引擎，
 * 桌面版走主进程代发不受跨域限制，永不抛）＋ `lib/searchSettings.ts`（全局键 `app.search`）
 * ＋ `SearchSettingsPanel`。本模块只是把「多条检索词 → 合并去重 → 交给模型归纳」编排起来。
 *
 * 🔴 三条红线：
 *   ① **不静默失败**：未配置 / 断网 / 无结果一律返回带中文原因的 `{ok:false}`，由界面明确提示；
 *   ② **口径如实**：报告恒带 `disclaimer`（「联网检索汇总 + 模型归纳，仅供参考」），不呈现为确定结论；
 *   ③ **不引导跟风 / 洗稿 / 抄袭**：提示词里写死「只给趋势与机会点，不提供可复制的正文、大纲或情节」。
 *
 * 🔴 本模块**只读不写项目数据**（不碰 chapters / settings 表）——它是选题参考工具，
 *    与「拆书（一次性抽设定）」和「知识库挂载（长期资料）」是三条独立的路。
 */
import type { PromptDef } from './promptSettings'
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from './ai'
import { parseLooseObject, asText } from './aiParse'
import { getSearchSettings } from './searchSettings'
import {
  webSearch, searchBlockedReason,
  type SearchSettings, type SearchTransport,
} from './webSearch'

/** 「市场雷达」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_market_radar = `你是网文市场的趋势分析助手。作者会给出一个作品方向（题材 / 平台 / 标签 / 关键词），以及一批从公开网络检索到的资料片段。请只依据这些资料 + 你的常识，归纳出对选题有用的趋势参考。

硬性规则：
1. 返回 JSON 对象，形如 {"trend":[{"topic":"题材或方向","heat":"rising|stable|cooling","note":"一句话依据"}],"platformFit":[{"platform":"平台名","note":"一句话适配建议"}],"opportunities":["机会点"],"risks":["风险点"]}。
2. **只给趋势与机会点，不提供任何可复制的正文、大纲或情节** —— 你的输出是选题参考，不是内容代写。
3. 严禁引导跟风、洗稿、抄袭；不得出现「照搬某作品」「换个名字发」这类建议。
4. 资料里没提到的不要编；判断不确定时，在 note 里如实写明「资料不足，仅供参考」。
5. 只输出 JSON，不要解释、不要 markdown 代码块标记。`

export interface RadarInput {
  /** 题材（如「东方仙侠」「都市异能」） */
  genre: string
  /** 标签（如「升级流」「群像」「轻松向」） */
  tags: string[]
  /** 目标平台（如「起点」「番茄」「晋江」） */
  platform: string
  /** 作者自己关心的关键词 */
  keywords: string[]
}

export interface RadarTrendItem {
  topic: string
  heat: 'rising' | 'stable' | 'cooling'
  note: string
}

export interface RadarSource {
  title: string
  url: string
  snippet: string
}

export interface RadarReport {
  generatedAt: number
  /** 实际发出的检索词（让作者知道这份报告是基于什么查出来的） */
  queries: string[]
  sources: RadarSource[]
  trend: RadarTrendItem[]
  platformFit: { platform: string; note: string }[]
  opportunities: string[]
  risks: string[]
  /** 🔴 恒非空：口径说明，防止把模型归纳当成市场结论 */
  disclaimer: string
}

/** 报告固定尾注（口径红线，别删） */
export const RADAR_DISCLAIMER = '以上为「联网检索结果 + 模型归纳」，仅供参考 —— 不构成准确的市场结论，也不代表任何平台的官方口径。'

/** 一次雷达最多发多少条检索词（控制成本：每条检索 + 最后 1 次归纳） */
export const RADAR_MAX_QUERIES = 6
/** 报告里最多列多少条来源 */
export const RADAR_MAX_SOURCES = 30

/**
 * 由作品方向组合出检索词（纯函数，可脱离网络单测）。
 * 规则：题材 × 平台 的热门、题材趋势、每个标签一条、作者关键词照收 —— 去重后截断到上限。
 */
export function buildRadarQueries(input: RadarInput, opts?: { year?: number }): string[] {
  const genre = String(input?.genre ?? '').trim()
  const platform = String(input?.platform ?? '').trim()
  const year = opts?.year ?? new Date().getFullYear()
  const out: string[] = []
  const push = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim()
    if (t && !out.includes(t)) out.push(t)
  }

  if (genre) {
    if (platform) push(`${genre} ${platform} 热门 ${year}`)
    push(`${genre} 网文 趋势 ${year}`)
    push(`${genre} 小说 榜单 推荐`)
  } else if (platform) {
    push(`${platform} 网文 热门 ${year}`)
  }
  for (const t of input?.tags ?? []) {
    const tag = String(t ?? '').trim()
    if (tag) push(`${genre} ${tag} 题材趋势`.trim())
  }
  for (const k of input?.keywords ?? []) {
    const kw = String(k ?? '').trim()
    if (kw) push(kw)
  }
  return out.slice(0, RADAR_MAX_QUERIES)
}

function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asText).filter(Boolean)
  const s = asText(v)
  return s ? [s] : []
}

function normTrend(v: unknown): RadarTrendItem[] {
  if (!Array.isArray(v)) return []
  const out: RadarTrendItem[] = []
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const topic = asText(o.topic ?? o['题材'] ?? o['方向'])
    if (!topic) continue
    const h = asText(o.heat ?? o['热度'])
    const heat: RadarTrendItem['heat'] = (h === 'rising' || h === 'stable' || h === 'cooling') ? h : 'stable'
    out.push({ topic, heat, note: asText(o.note ?? o['说明'] ?? o['依据']) })
  }
  return out
}

function normPlatformFit(v: unknown): { platform: string; note: string }[] {
  if (!Array.isArray(v)) return []
  const out: { platform: string; note: string }[] = []
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const platform = asText(o.platform ?? o['平台'])
    if (!platform) continue
    out.push({ platform, note: asText(o.note ?? o['说明'] ?? o['建议']) })
  }
  return out
}

/** 拼给模型的用户消息：作品方向 + 检索到的资料片段 */
function buildRadarUserPrompt(input: RadarInput, sources: RadarSource[]): string {
  const lines = sources.map((r, i) => {
    const head = r.url ? `${i + 1}. ${r.title}（${r.url}）` : `${i + 1}. ${r.title}`
    return r.snippet ? `${head}\n   ${r.snippet.replace(/\s+/g, ' ')}` : head
  })
  return [
    '【作品方向】',
    `题材：${input.genre || '（未填）'}`,
    `平台：${input.platform || '（未填）'}`,
    `标签：${(input.tags ?? []).join('、') || '（无）'}`,
    `关键词：${(input.keywords ?? []).join('、') || '（无）'}`,
    '',
    '【联网检索到的公开信息】',
    ...lines,
    '',
    '请据此归纳趋势、平台适配与机会 / 风险，按约定输出 JSON 对象。',
  ].join('\n')
}

export interface RadarOptions {
  signal?: AbortSignal
  /** 测试注入：发送器桩（透传给 `webSearch`） */
  transport?: SearchTransport
  /** 测试注入：直接给定检索设置，跳过读设置 */
  settings?: SearchSettings
  /** 测试注入：替代真实模型调用（与 tavern 的 `ChatFn` 同一条思路，便于单测走通成功路径） */
  chatFn?: typeof chat
}

/**
 * 跑一次市场雷达。**永不抛** —— 失败返回 `{ok:false, error}` 让界面如实提示。
 * 报告成功时**必带** `disclaimer`（口径红线）。
 */
export async function runMarketRadar(
  input: RadarInput,
  opts: RadarOptions = {},
): Promise<{ ok: boolean; report?: RadarReport; error?: string }> {
  try {
    const settings = opts.settings ?? await getSearchSettings()
    // 市场雷达依赖「搜索接口」这一档（我们要把检索结果**交给**模型，模型自带联网那档拿不到来源）
    if (settings.mode !== 'api') {
      return { ok: false, error: '市场雷达需要把「联网检索」设为「搜索接口」这一档 —— 请到「模型设置 → 联网检索」配置后再试。' }
    }
    const blocked = searchBlockedReason(settings)
    if (blocked) return { ok: false, error: blocked }

    const queries = buildRadarQueries(input)
    if (queries.length === 0) return { ok: false, error: '先填写题材或关键词，雷达才有可查的方向。' }

    // 逐条检索 → 合并去重（按 url / 标题）。失败不中断：只要有一条查成就能继续。
    const sources: RadarSource[] = []
    const seen = new Set<string>()
    const errors: string[] = []
    for (const q of queries) {
      if (opts.signal?.aborted) return { ok: false, error: '已取消。' }
      const outcome = await webSearch(q, settings, opts.signal,
        opts.transport ? { transport: opts.transport } : {})
      if (!outcome.used) {
        if (outcome.error) errors.push(outcome.error)
        continue
      }
      for (const r of outcome.results) {
        const key = r.url || r.title
        if (!key || seen.has(key)) continue
        seen.add(key)
        sources.push({ title: r.title, url: r.url, snippet: r.snippet })
      }
      if (sources.length >= RADAR_MAX_SOURCES) break
    }
    if (sources.length === 0) {
      return { ok: false, error: errors[0] || '没查到可用的公开信息 —— 换一组检索词，或检查「联网检索」配置。' }
    }

    // AI 归纳（走「批量整理」用途路由：这是工具型分析，不必烧最好的模型）
    const cfg = await requireProviderFor('utility')
    const callChat = opts.chatFn ?? chat
    const text = await callChat(
      cfg,
      [
        { role: 'system', content: composeSystemPrompt(P_market_radar, cfg) },
        { role: 'user', content: buildRadarUserPrompt(input, sources) },
      ],
      { json: true, timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal },
    )
    const obj = parseLooseObject(text) ?? {}
    const report: RadarReport = {
      generatedAt: Date.now(),
      queries,
      sources: sources.slice(0, RADAR_MAX_SOURCES),
      trend: normTrend(obj.trend),
      platformFit: normPlatformFit(obj.platformFit),
      opportunities: strArr(obj.opportunities ?? obj['机会点']),
      risks: strArr(obj.risks ?? obj['风险点']),
      disclaimer: RADAR_DISCLAIMER,
    }
    return { ok: true, report }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `aiTasks.ts` 的 `PROMPT_ORDER` 决定 = 设置页显示顺序**。
 */
export const MARKET_RADAR_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'market-radar',
      group: '灵感工具',
      name: '市场雷达',
      note: '按题材 / 平台归纳公开信息的趋势与机会点（仅供参考，不代写内容）。',
    },
    read: () => P_market_radar,
    write: t => { P_market_radar = t },
  },
]

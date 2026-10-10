/**
 * 对话引导（访谈式补全）—— 通用核心
 *
 * 【它解决什么】
 * 「一句话起草 / 一句话补全」适合**作者已经想清楚**的情况（甚至是照着一个已有作品填）。
 * 但原创设定常常是「有点感觉，说不清」—— 这时需要的不是憋出一句完整描述，
 * 而是**按模板提纲被问着走**：先定名字与身份，再问外在，再问在乎什么……一边聊一边成形。
 *
 * 【两条硬规则（老大明确要求）】
 *   ① 一次只问 1–3 个相关联的问题 —— 一次抛一整张问卷等于把人劝退；
 *   ② 按模板提纲为纲领推进，一个话题聊透了再进下一个，别跳着问。
 *
 * 【怎么保证「聊着聊着能变成一份表单」】
 * 每轮都让模型顺带输出一句 `filled`：**到目前为止从对话里提炼出的字段**（增量合并）。
 * 这样「生成草稿」不是重新总结一遍对话（很容易丢细节），而是把一路攒下来的东西交出去。
 *
 * 【为什么每轮都过一次模型】
 * 本地做「下一个问什么」的编排看起来能省调用，但那样提问会变成死板的问卷顺序，接不住作者的回答。
 * 一次调用换一轮有上下文的追问，值得。
 *
 * 【为什么这层要做成「谁都能用」】
 * 2026-09-15 老大要求把对话引导从酒馆推广到**所有 AI 补全入口**（角色管理 / 表单 / 表格 / 酒馆三处）。
 * 本模块只认「一份字段清单 + 一份提纲」，不认角色卡、剧本或任何具体业务 ——
 * 各业务把自己的模板翻译成 `InterviewSpec` 即可。**别在业务侧再写一份访谈逻辑**：
 * 提问规则、字段白名单、增量合并这三件事一旦有两份实现，就一定会漂移。
 */
import type { ChatMessage } from '@/lib/ai'
import { parsePlainObject, asText } from '@/lib/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/promptGuard'

/** 提纲的一个话题：对应模板里的一组栏 */
export type InterviewTopic = {
  key: string
  /** 话题名（界面显示进度用） */
  label: string
  /** 这一话题要问出什么（写给模型看的） */
  ask: string
  /** 对应模板里的哪些栏（用于进度统计） */
  fields: string[]
}

export type InterviewTurn = { role: 'user' | 'ai'; text: string }

export type InterviewState = {
  /** 对话历史（含 AI 的提问） */
  turns: InterviewTurn[]
  /** 到目前为止从对话里提炼出的字段（增量合并） */
  filled: Record<string, string>
  /** 模型认为可以收尾了 */
  done: boolean
}

export type InterviewReply = {
  /** 这一轮结束后累积的字段（已与进来的合并） */
  filled: Record<string, string>
  /** 要问作者的下一句 */
  question: string
  done: boolean
}

/**
 * 一份「纲」：在塑形什么 + 提纲 + 允许的栏名。
 * `labels` 供界面把 key 摊成中文（进度面板用），没给就显示 key 本身。
 */
export type InterviewSpec = {
  /** 一句话说明在塑形什么（进提示词与标题，例：「一张角色卡」） */
  subject: string
  topics: InterviewTopic[]
  /** 允许的栏名（模型写了别的会被丢掉）；也是进度的分母 */
  allowedKeys: string[]
  /** key → 中文名（界面摊平用） */
  labels?: Record<string, string>
}

export function emptyInterview(): InterviewState {
  return { turns: [], filled: {}, done: false }
}

/** 已收集 / 总共 的栏数（界面进度用） */
export function interviewProgress(s: InterviewState, allowedKeys: string[]): { got: number; total: number } {
  const got = allowedKeys.filter(k => String(s.filled[k] ?? '').trim()).length
  return { got, total: allowedKeys.length }
}

/**
 * 通用提纲派生：把一份字段清单切成若干话题。
 *
 * 业务侧有精心排过的话题（角色卡 / 剧本）时应当**自己给 topics**；这个派生只服务于
 * 「字段清单是动态的」场合（表格的列、用户自定义的表单）。
 * 切法：每 2 栏一个话题（一栏时单独成题），保证一题问的东西互相关联。
 */
export function deriveTopics(fields: { key: string; label: string; desc?: string }[], perTopic = 2): InterviewTopic[] {
  const usable = fields.filter(f => f.key && f.label)
  if (usable.length === 0) return []
  const topics: InterviewTopic[] = []
  for (let i = 0; i < usable.length; i += perTopic) {
    const chunk = usable.slice(i, i + perTopic)
    topics.push({
      key: `t${topics.length + 1}`,
      label: chunk.map(f => f.label).join(' · '),
      // 把每一栏的说明与示例一并写进去 —— 模型据此才能问出**这一栏真正要的东西**
      ask: chunk.map(f => `${f.label}${f.desc ? `（${f.desc}）` : ''}`).join('；'),
      fields: chunk.map(f => f.key),
    })
  }
  return topics
}

export function buildInterviewSystem(spec: InterviewSpec): string {
  const outline = spec.topics.map(
    (t, i) => `${i + 1}. 【${t.label}】要问到的是：${t.ask}（对应字段：${t.fields.join('、')}）`,
  )
  const fieldList = spec.allowedKeys.join('、')
  return [
    `你在帮一位小说作者「从零塑形」一份${spec.subject}。你不是问卷，是会追问的编辑：`,
    '作者往往只说了个感觉，你要顺着他的话把模糊的地方问清楚。',
    '',
    '〖提纲（按这个顺序推进，一个话题聊得差不多再进下一个）〗',
    ...outline,
    '',
    '〖提问的硬规则〗',
    '- 一次只问 1–3 个「互相关联」的问题 —— 绝不能一口气把提纲全问完（那会把人劝退）；',
    '- 「先接住作者上一句」：他提到的细节值得展开就追问细节，别机械地念下一个话题；',
    '- 别重复已经答过的内容；作者说「随便你」「你定」时，你自己给一个具体的建议让他确认；',
    '- 语气自然、简短，别写小作文，也别滥用感叹号。',
    '',
    '〖每轮必须顺带输出「已提炼的字段」〗',
    `可用的字段名只有这些：${fieldList}。把你从「目前为止的全部对话」里能确定的字段累积写出来`,
    '（简洁即可，别扩写成长段；还不清楚的字段就别写、不要瞎填）。',
    '',
    '〖输出格式〗只输出一个 JSON 对象，不要代码块、不要围栏：',
    '{"filled":{"字段名":"内容"},"question":"你要问作者的下一句（1–3 个问题）","done":false}',
    '- 当提纲里的字段基本都有着落时，把 done 设为 true，question 换成一句收尾话',
    '（例如「信息差不多齐了，可以生成草稿了 —— 生成后你还能逐栏改」）。',
  ].join('\n')
}

/** 把当前状态摊成给模型的输入（含提纲进度、已收集字段、对话历史） */
export function buildInterviewUser(s: InterviewState, spec: InterviewSpec, existing?: string, context?: string): string {
  const fence = newAuthorFence()
  const progress = spec.topics.map(t => {
    const missing = t.fields.filter(f => !String(s.filled[f] ?? '').trim())
    return `- ${t.label}：${missing.length === 0 ? '已有信息' : '还缺 ' + missing.join('、')}`
  })
  const filledRows = Object.entries(s.filled)
    .filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `${k}：${v}`)
  const history = s.turns.map(t => `${t.role === 'ai' ? '你' : '作者'}：${t.text}`).join('\n')

  return [
    existing?.trim() ? `〖作者已有的内容（这是补完，不是从零开始）〗\n${authorBlock(fence, existing.trim())}\n` : '',
    context?.trim() ? `〖既有设定（回答要与它一致）〗\n${authorBlock(fence, context.trim())}\n` : '',
    '〖提纲进度〗',
    ...progress,
    '',
    filledRows.length ? `〖目前已提炼的字段〗\n${filledRows.join('\n')}\n` : '',
    '〖对话到这儿〗',
    history || '（还没开始，这是第一轮：请先问最开头的话题，1–3 个问题）',
    '',
    '请按格式输出 JSON。',
  ].filter(Boolean).join('\n')
}

/**
 * 解析一轮访谈的输出（导出便于单测）。
 * 🔴 字段名走**白名单**：模型自己发明的栏名直接丢掉 —— 否则那些值会一路带到草稿里，
 *    再被合并逻辑静默忽略，看起来就是「AI 说记下了，其实没记」。
 */
export function parseInterviewReply(
  raw: string,
  allowedKeys: string[],
  prev: Record<string, string> = {},
): InterviewReply | null {
  const o = parsePlainObject(raw)
  if (!o) return null
  const allowed = new Set(allowedKeys)
  const filled: Record<string, string> = { ...prev }
  const rawFilled = o.filled
  if (rawFilled && typeof rawFilled === 'object') {
    for (const [k, v] of Object.entries(rawFilled as Record<string, unknown>)) {
      if (!allowed.has(k)) continue
      const text = asText(v).trim()
      if (text) filled[k] = text
    }
  }
  const question = asText(o.question).trim()
  const done = o.done === true || o.done === 'true'
  if (!question && !done) return null
  return { filled, question, done }
}

/** 把已收集的字段摊平成文本（给「补完已有」模式当起点用，也用于界面的进度面板） */
export function filledToText(filled: Record<string, string>, labels?: Record<string, string>): string {
  return Object.entries(filled)
    .filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `【${labels?.[k] ?? k}】${v}`)
    .join('\n')
}

/**
 * 跑一轮访谈。`answer` 为空 = 开场（让 AI 先问）。
 *
 * 🔴 这里**不解析模型配置**：酒馆用会话指定的模型、全局补全用活动模型 —— 由调用方把
 *    发请求那一步包成 `callChat` 传进来。共用的是「说什么」与「怎么解析」，不是「发给谁」。
 */
export async function runInterviewTurn(
  spec: InterviewSpec,
  s: InterviewState,
  answer: string | null,
  deps: {
    callChat: (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>
    signal?: AbortSignal
    /** 补完模式：已有内容的摊平文本 */
    existing?: string
    /** 额外背景（如本项目世界观）—— 让追问与既有设定保持一致 */
    context?: string
  },
): Promise<{ state: InterviewState; reply: InterviewReply }> {
  const withAnswer: InterviewState = answer?.trim()
    ? { ...s, turns: [...s.turns, { role: 'user' as const, text: answer.trim() }] }
    : s

  const msgs: ChatMessage[] = [
    { role: 'system', content: buildInterviewSystem(spec) },
    { role: 'user', content: buildInterviewUser(withAnswer, spec, deps.existing, deps.context) },
  ]
  const raw = await deps.callChat(msgs, { signal: deps.signal })
  const reply = parseInterviewReply(raw, spec.allowedKeys, withAnswer.filled)
  if (!reply) throw new Error('引导模型没有按格式回应（没输出 JSON）—— 再发一次试试')
  const next: InterviewState = {
    ...withAnswer,
    filled: reply.filled,
    done: reply.done,
    turns: reply.question
      ? [...withAnswer.turns, { role: 'ai' as const, text: reply.question }]
      : withAnswer.turns,
  }
  return { state: next, reply }
}

/**
 * 把**同页签其它活跃条目**的已填内容压成一段可带进对话的摘要（2026-10-03）。
 *
 * 起因：多套并行的页签（世界设定的多个子世界 / 制度四页签的多条制度）之间最容易撞车 ——
 * 补全第 3 条时 AI 看不见第 1、2 条写了什么，作者明明都填过了。
 *
 * 🔴 **刻意截断**：这类摘要动辄几百行，全量带进对话既稀释注意力又白耗额度。
 *    每条只取前 `perEntryLines` 行、整体不超过 `totalLines` 行，截断处明写「其余 N 项略」。
 * @param entries 兄弟条目（**调用方须先滤掉当前正在编辑的那条**）
 * @param itemLabel 条目在正文里的称呼（例：`子世界` / `制度`），只影响标题措辞
 */
export function buildSiblingContext(
  entries: { name: string; data: Record<string, string> }[],
  opts?: { itemLabel?: string; perEntryLines?: number; totalLines?: number },
): string {
  const itemLabel = opts?.itemLabel ?? '条目'
  const perEntry = opts?.perEntryLines ?? 14
  const total = opts?.totalLines ?? 56
  const blocks: string[] = []
  let used = 0
  for (const e of entries) {
    const filled = Object.entries(e.data ?? {})
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => (k.includes('::') ? `${k.split('::').pop()}：${v.trim()}` : `${k}：${v.trim()}`))
    if (!filled.length) continue
    if (used >= total) {
      blocks.push(`（另有 ${entries.length - blocks.length} 个${itemLabel}未列入 —— 勾此项只带上面这些）`)
      break
    }
    const room = Math.max(0, Math.min(perEntry, total - used))
    const head = filled.slice(0, room)
    used += head.length
    const rest = filled.length - head.length
    blocks.push([
      `【${itemLabel}·${e.name}】`,
      ...head,
      rest > 0 ? `（本${itemLabel}其余 ${rest} 项略）` : '',
    ].filter(Boolean).join('\n'))
  }
  return blocks.join('\n')
}

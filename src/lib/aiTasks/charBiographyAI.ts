// ============ AI 任务层 · 人物小传整理与节点抽取（3.7.1 · W3）============
//
// 两条独立入口（均兼容 API / MCP / ACP 三模式）：
//   ① aiExtractBioNodes   —— 从选定章节正文中抽取该角色的「里程碑级重要节点」候选（带章号与原文依据）；
//   ② aiComposeBiography  —— 根据角色卡资料 + 已有小传正文 + 已确认节点 + 状态演变，生成初稿或续写建议。
//
// 🔴 铁律：
//   · 只抽对人物生平/立场/实力/关系有里程碑意义的重大转折，普通流水账一律不抽；
//   · 正文与用户已有内容统一走 newAuthorFence / authorBlock 围栏，不把正文当系统指令；
//   · 提示词正文就地声明为模块级 `let`，登记进 CHAR_BIO_PROMPTS（供模型设置页编辑/还原）。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt, isCancelled } from '@/lib/ai'
import { parseObjectArrayDetailed, asText } from '@/lib/ai/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import { longStream } from '@/lib/aiTasks/stream'
import type { PromptDef } from '@/lib/ai/promptSettings'
import { acpJsonInstruction } from '@/lib/agentHost/acpStructured'
import { isAcpCancelled } from '@/lib/agentHost/acpGate'
import type { TaskResult } from '@/lib/revision/revisionTypes'
import { BIO_NODE_TAGS, type BioNodeTag } from '@/lib/settings/charBiography'

let BIO_EXTRACT_SYS = `你是长篇小说「人物小传整理」助理。请从作者提供的章节正文中，为指定角色抽取**真正具有生平里程碑意义的重要节点事件**。

铁律（宁缺勿滥）：
1. 只抽重大转折：如出身变故、觉醒/破境、重大胜利或惨败、关系质变、身份转变、得到或失去决定性器物、立誓或关键抉择。
2. 普通日常对话、常规赶路、没有长期影响的琐事**一律不要抽**。
3. 只依据提供的新正文，不推测、不补充、不虚构未写出的剧情。
4. 每条必须给 evidence：从正文中**逐字照抄**一句能证明该事件的原句（不超过 80 字）。
5. tag 只能取以下之一：前传背景 / 成长突破 / 关系转折 / 高光时刻 / 重大失去 / 身份变化 / 其他。
6. 输出一个 JSON 数组（没有里程碑事件就返回 []），不要任何解释文字、不要代码块围栏：
[{"chapterNo":1,"title":"一句话节点标题","summary":"事件经过与心理/立场转折（30~120字）","tag":"成长突破","evidence":"正文原句"}]`

let BIO_COMPOSE_SYS = `你是长篇小说「人物小传执笔」助理。请依据角色卡设定、已确认的重要节点事件与状态演变，为该角色撰写或续写「人物生平小传正文」。

写作要求：
1. 忠实于给定资料与节点，不编造未发生的后续剧情或隐藏设定。
2. 语言凝练有叙事感，按阶段自然分段（如早年经历、各卷历程），像人物传记而不像流水账列表。
3. 若处于「续写」模式且已有小传正文，只输出**需要衔接在末尾的新增段落**（或补充完整后的清晰增量），不要机械复述已写过的开头。
4. 直接输出纯文本传记段落，不要加「好的」「以下是…」之类客套话，不要使用 Markdown 标题围栏。`

export interface ExtractedBioNode {
  /** 角色名（章后整理通用抽取时使用；单角色抽取可填空或角色名） */
  name: string
  chapterNo: number
  title: string
  summary: string
  tag: BioNodeTag
  evidence: string
}

const VALID_TAGS = new Set<string>(BIO_NODE_TAGS)

function normalizeTag(raw: string): BioNodeTag {
  const t = raw.trim()
  return VALID_TAGS.has(t) ? (t as BioNodeTag) : '其他'
}

/** 纯函数：解析模型输出的重要节点 JSON 数组（缺标题或原文依据一律丢弃） */
export function parseExtractedBioNodesDetailed(text: string, fallbackName = ''): TaskResult<ExtractedBioNode[]> {
  const parsed = parseObjectArrayDetailed(text)
  if (parsed.outcome === 'invalid') {
    return { outcome: 'invalid', data: [], diagnostics: parsed.diagnostics, truncated: parsed.truncated }
  }
  const out: ExtractedBioNode[] = []
  const seen = new Set<string>()
  for (const it of parsed.data) {
    const name = asText(it.name ?? it['姓名'] ?? it['人物']).trim() || fallbackName.trim()
    const title = asText(it.title ?? it['标题'] ?? it['事件']).trim()
    const evidence = asText(it.evidence ?? it['证据'] ?? it['原句']).trim()
    if (!title || !evidence) continue
    const summary = asText(it.summary ?? it['经过'] ?? it['内容'] ?? it['详情']).trim()
    const chRaw = Number(asText(it.chapterNo ?? it['章号']).trim())
    const chapterNo = Number.isFinite(chRaw) && chRaw > 0 ? Math.floor(chRaw) : 0
    const tag = normalizeTag(asText(it.tag ?? it['标签'] ?? it['类型']))
    const key = `${name}::${chapterNo}::${title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, chapterNo, title, summary, tag, evidence: evidence.slice(0, 120) })
  }
  return { outcome: parsed.outcome, data: out, diagnostics: parsed.diagnostics, truncated: parsed.truncated }
}

export interface ExtractBioNodesRequest {
  characterName: string
  aliases?: string[]
  chapters: { chapterNo: number; title: string; content: string }[]
  existingTitles?: string[]
}

export interface ExtractBioNodesResult {
  outcome: 'completed' | 'invalid' | 'cancelled' | 'failed'
  nodes: ExtractedBioNode[]
  error?: string
}

/** 从选定章节正文中抽取指定角色的重要节点候选 */
export async function aiExtractBioNodes(
  req: ExtractBioNodesRequest,
  opts?: {
    signal?: AbortSignal
    onToken?: (delta: string) => void
    acpText?: (prompt: string) => Promise<string>
  },
): Promise<ExtractBioNodesResult> {
  if (!req.characterName.trim() || req.chapters.length === 0) {
    return { outcome: 'completed', nodes: [] }
  }
  const fence = newAuthorFence()
  const aliasLine = req.aliases?.length ? `（别称：${req.aliases.join('、')}）` : ''
  const existingNote = req.existingTitles?.length
    ? `\n已登记节点标题（请勿重复抽取相同事件）：${req.existingTitles.slice(-20).join('；')}`
    : ''
  const chapterBlocks = req.chapters
    .map(ch => `--- 第 ${ch.chapterNo} 章 ${ch.title} ---\n${authorBlock(fence, ch.content)}`)
    .join('\n\n')
  const user = `【目标角色】${req.characterName.trim()}${aliasLine}${existingNote}

【待整理章节正文】
${chapterBlocks}

请为「${req.characterName.trim()}」抽取真正属于生平里程碑的重要节点事件。`

  try {
    let text = ''
    if (opts?.acpText) {
      const prompt = `${BIO_EXTRACT_SYS}\n\n${user}\n\n${acpJsonInstruction('人物小传节点抽取', '[{"chapterNo":1,"title":"节点标题","summary":"事件经过","tag":"成长突破","evidence":"正文原句"}]（没有重大转折就返回 []）')}`
      text = await opts.acpText(prompt)
    } else {
      const cfg = await requireProviderFor('utility')
      text = await chat(
        cfg,
        [{ role: 'system', content: composeSystemPrompt(BIO_EXTRACT_SYS, cfg) }, { role: 'user', content: user }],
        { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: longStream(opts?.onToken), output: 'json-object', reasoning: 'off' },
      )
    }
    const parsed = parseExtractedBioNodesDetailed(text, req.characterName)
    if (parsed.outcome === 'invalid') {
      return { outcome: 'invalid', nodes: [], error: '模型返回格式无法解析为节点清单' }
    }
    return { outcome: 'completed', nodes: parsed.data }
  } catch (e) {
    if (isCancelled(e) || isAcpCancelled(e)) return { outcome: 'cancelled', nodes: [] }
    return { outcome: 'failed', nodes: [], error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ComposeBiographyRequest {
  characterName: string
  tierLabel: string
  mode: 'draft' | 'continue'
  cardSummary: string
  existingProse: string
  nodes: { phase: 'prequel' | 'story'; chapterNo: number; storyTime?: string; title: string; summary: string; tag: string }[]
  stateLines: string[]
}

export interface ComposeBiographyResult {
  outcome: 'completed' | 'cancelled' | 'failed'
  text: string
  error?: string
}

/** 根据设定与重要节点生成人物小传初稿或续写段落 */
export async function aiComposeBiography(
  req: ComposeBiographyRequest,
  opts?: {
    signal?: AbortSignal
    onToken?: (delta: string) => void
    acpText?: (prompt: string) => Promise<string>
  },
): Promise<ComposeBiographyResult> {
  const fence = newAuthorFence()
  const nodeLines = req.nodes.length
    ? req.nodes.map(n => {
        const prefix = n.phase === 'prequel' ? '【开篇前】' : `【第${n.chapterNo}章】`
        const time = n.storyTime ? `(${n.storyTime})` : ''
        return `${prefix}${time} [${n.tag}] ${n.title}${n.summary ? `：${n.summary}` : ''}`
      }).join('\n')
    : '（暂无重要节点记录）'
  const stateBlock = req.stateLines.length ? req.stateLines.join('\n') : '（暂无状态演变记录）'
  const user = `【角色】${req.characterName}（${req.tierLabel}）
【整理模式】${req.mode === 'continue' ? '基于已有小传续写新增历程' : '从零起草人物生平小传'}

【角色卡基础资料】
${authorBlock(fence, req.cardSummary || '（暂无额外档案字段）')}

【已确认重要节点】
${authorBlock(fence, nodeLines)}

【按章状态演变参考】
${authorBlock(fence, stateBlock)}

【当前已有小传正文】
${authorBlock(fence, req.existingProse.trim() || '（空）')}

请按要求输出${req.mode === 'continue' ? '续写段落' : '完整人物生平小传'}。`

  try {
    let text = ''
    if (opts?.acpText) {
      text = await opts.acpText(`${BIO_COMPOSE_SYS}\n\n${user}`)
    } else {
      const cfg = await requireProviderFor('utility')
      text = await chat(
        cfg,
        [{ role: 'system', content: composeSystemPrompt(BIO_COMPOSE_SYS, cfg) }, { role: 'user', content: user }],
        { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: longStream(opts?.onToken), reasoning: 'off' },
      )
    }
    return { outcome: 'completed', text: text.trim() }
  } catch (e) {
    if (isCancelled(e) || isAcpCancelled(e)) return { outcome: 'cancelled', text: '' }
    return { outcome: 'failed', text: '', error: e instanceof Error ? e.message : String(e) }
  }
}

export const CHAR_BIO_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'char-bio-extract',
      group: '设定与资料',
      name: '人物小传节点抽取',
      note: '人物小传页：从选定章节抽取指定角色的里程碑转折节点（只出候选、带原文依据，不覆盖已有节点）。',
    },
    read: () => BIO_EXTRACT_SYS,
    write: t => { BIO_EXTRACT_SYS = t },
  },
  {
    meta: {
      id: 'char-bio-compose',
      group: '设定与资料',
      name: '人物小传正文整理',
      note: '人物小传页：结合角色卡设定与已确认重要节点生成小传初稿或续写建议（需作者确认后才采纳）。',
    },
    read: () => BIO_COMPOSE_SYS,
    write: t => { BIO_COMPOSE_SYS = t },
  },
]

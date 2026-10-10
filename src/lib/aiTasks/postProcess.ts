// ============ AI 任务层 · 章后整理抽取（W2-1 · §10.3 #3）============
//
// 职责边界（与 `extract.ts` 同一条铁律）：本函数**只负责从本章正文抽取「变化候选」**，
// 「是否已登记 / 是否真的变了」一律交给 `chapterPostProcess.ts` 做确定性比对 ——
// AI 不知道作者的登记现状，也容易把没变的说成变了（或反过来）。
//
// 🔴 为什么把「伏笔 / 关系 / 状态」三类合并成**一个** AI 任务：
//    · 三者读的都是同一份本章正文，分开调 = 同一份正文读三遍（费额度、费时间）；
//    · 合并后只有一条 prompt 要维护、一个解析器要测。
//    输出用**扁平数组 + kind 字段**，直接复用既有 `parseObjectArray`（不新写解析器）。
//
// 提示词 `POST_PROCESS_SYS` 就地声明在本文件（promptSettings 要求「提示词 ↔ 用法」同处）。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { longStream } from './stream'
import type { PromptDef } from '../promptSettings'

let POST_PROCESS_SYS = `你是长篇小说「章后整理」助理。作者刚写完本章，请从本章正文中抽取**本章带来的变化**，供作者核对登记。

只抽下面三类，输出一个 JSON 数组，每个元素必须带 kind 字段：

一、kind = "伏笔" —— 本章**埋设**或**回收**的伏笔
   - action：只能取 "埋设" 或 "回收"
   - content：伏笔内容的一句话概括（照正文，不改写）
   - code：若正文里明确出现伏笔编号（形如 F0001）就填，没有就填空字符串
   铁律：只抽「后文要用到的**隐蔽线索**」。普通情节推进、环境描写、对话内容**都不算伏笔**。
        拿不准的一律不抽——宁缺勿滥。

二、kind = "关系" —— 本章人物之间的关系**发生了变化**
   - a / b：两个人物名（照正文用名，不要改写）
   - type：关系类型（可选：亲属 / 师徒 / 盟友 / 敌对 / 竞争 / CP感情线 / 主仆 / 恩怨），判不准留空
   - change：关系怎么变的（一句话，如"从互不信任到结为同盟"）
   铁律：只抽**发生了质变**的；一直没变的关系不要抽。

三、kind = "状态" —— 本章人物的**状态变化**
   - name：人物名
   - state：当前状态（一句话，如"重伤昏迷""已晋升筑基期""沦为阶下囚"）
   - evidence：正文中体现该状态的原句（照抄、不改写、不超过 60 字）
   铁律：只抽**本章状态发生变化**的角色（登场 / 受伤 / 晋升 / 死亡 / 立场转变等）；
        一直维持原状的角色不要抽。

总铁律：
1. 只依据本章正文，不推测、不补充、不虚构——这是资料整理，不是创作。
2. 三类都可能为空；本章没有这类变化就返回空数组，**不要为了凑数硬抽**。
3. 只输出 JSON 数组，不要任何解释文字、不要代码块围栏。`

export interface ExtractedForeshadow {
  action: '埋设' | '回收'
  /** 伏笔编号（正文未提及时为空串） */
  code: string
  content: string
}

export interface ExtractedRelation {
  a: string
  b: string
  /** 关系类型（可为空） */
  type: string
  /** 关系怎么变的（一句话） */
  change: string
}

export interface ExtractedStatus {
  name: string
  /** 当前状态（一句话） */
  state: string
  /** 原文证据 */
  evidence: string
}

/** 一次章后整理抽出的三类变化（尚未与登记表现状比对） */
export interface ChapterChanges {
  foreshadows: ExtractedForeshadow[]
  relations: ExtractedRelation[]
  statuses: ExtractedStatus[]
}

const EMPTY_CHANGES: ChapterChanges = { foreshadows: [], relations: [], statuses: [] }

/**
 * 从本章正文抽「伏笔 / 关系 / 状态」三类变化候选。
 * 正文为空 ⇒ 直接返回空（不发请求）。
 */
export async function aiExtractChapterChanges(
  chapterText: string,
  chapterTitle: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ChapterChanges> {
  const body = (chapterText ?? '').trim()
  if (!body) return { ...EMPTY_CHANGES }
  // #014 用途路由：从正文抽取属「整理」
  const cfg = await requireProviderFor('utility')
  // 🔴 章题与正文都是**不可信文本**：包裹成边界块（内容一字不改，见 promptGuard 文件头）
  const fence = newAuthorFence()
  const user = `【章节】${chapterTitle.trim() ? authorBlock(fence, chapterTitle.trim()) : '（未命名章节）'}

【本章正文】
${authorBlock(fence, body)}

请抽取本章带来的伏笔 / 关系 / 状态变化。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(POST_PROCESS_SYS, cfg) }, { role: 'user', content: user }],
    // 走流式（与 extract 同理：非流式等整段生成完会撞总超时墙）
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: longStream(opts?.onToken), json: true },
  )
  return parseChapterChanges(text)
}

/**
 * 把模型返回的 JSON **扁平数组**解析成三类（**纯函数**，不碰网络/数据库，便于单测）。
 *
 * 容错：数组元素缺字段 / 字段类型错 / 多余字段一律忽略；`kind` 不认识就跳过该条。
 * 🔴 丢弃空名字 / 空内容的条目 —— 让「没抽到」表现为空数组，而不是一条没用的空条目。
 */
export function parseChapterChanges(text: string): ChapterChanges {
  const out: ChapterChanges = { foreshadows: [], relations: [], statuses: [] }
  const seenFore = new Set<string>()
  const seenRel = new Set<string>()
  const seenSt = new Set<string>()

  for (const it of parseObjectArray(text)) {
    const kind = asText(it.kind ?? it['类型'] ?? it['类别']).trim()
    if (kind === '伏笔') {
      const content = asText(it.content ?? it['伏笔内容'] ?? it['内容']).trim()
      if (!content) continue
      const actionRaw = asText(it.action ?? it['动作']).trim()
      const action: '埋设' | '回收' = actionRaw === '回收' ? '回收' : '埋设'
      const code = asText(it.code ?? it['编号']).trim()
      const key = `${action}::${code}::${content}`
      if (seenFore.has(key)) continue
      seenFore.add(key)
      out.foreshadows.push({ action, code, content })
    } else if (kind === '关系') {
      const a = asText(it.a ?? it['人物A'] ?? it['甲']).trim()
      const b = asText(it.b ?? it['人物B'] ?? it['乙']).trim()
      const change = asText(it.change ?? it['变化'] ?? it['演变']).trim()
      if (!a || !b) continue
      const type = asText(it.type ?? it['关系类型']).trim()
      const key = `${a}::${b}::${type}`
      if (seenRel.has(key)) continue
      seenRel.add(key)
      out.relations.push({ a, b, type, change })
    } else if (kind === '状态') {
      const name = asText(it.name ?? it['姓名'] ?? it['人物']).trim()
      const state = asText(it.state ?? it['状态']).trim()
      if (!name || !state) continue
      if (seenSt.has(name)) continue
      seenSt.add(name)
      out.statuses.push({ name, state, evidence: asText(it.evidence ?? it['证据'] ?? it['原句']).trim() })
    }
  }
  return out
}

/** 三类合计是否为空（调用方据此短路） */
export function isChangesEmpty(c: ChapterChanges): boolean {
  return !c.foreshadows.length && !c.relations.length && !c.statuses.length
}

export const POST_PROCESS_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'chapter-post-process',
      group: '设定与资料',
      name: '章后整理抽取',
      note: '从本章正文抽取「伏笔 / 关系 / 人物状态」三类变化候选（章后整理用，AI 只抽候选、不判是否已登记）。',
    },
    read: () => POST_PROCESS_SYS,
    write: t => { POST_PROCESS_SYS = t },
  },
]

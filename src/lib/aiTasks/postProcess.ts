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
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt, isCancelled } from '@/lib/ai'
import { parseObjectArrayDetailed, asText } from '@/lib/ai/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import { longStream } from '@/lib/aiTasks/stream'
import type { PromptDef } from '@/lib/ai/promptSettings'
import type { StepExecutionResult, StepResultState, TaskResult } from '@/lib/revision/revisionTypes'
import { AcpStructuredError, acpField, acpJsonInstruction, decodeAcpRows } from '@/lib/agentHost/acpStructured'
import { isAcpCancelled } from '@/lib/agentHost/acpGate'
import { parseExtractedBioNodesDetailed, type ExtractedBioNode } from '@/lib/aiTasks/charBiographyAI'

let POST_PROCESS_SYS = `你是长篇小说「章后整理」助理。作者刚写完本章，请从本章正文中抽取**本章带来的变化**，供作者核对登记。

只抽下面五类，输出一个 JSON 数组，每个元素必须带 kind 字段：

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

四、kind = "物品" —— 本章**物品持有关系的变化**（获得 / 失去 / 转移 / 消耗）
   - item：物品名（照正文用名，不要改写）
   - action：只能取 "获得" / "失去" / "转移" / "消耗"
   - from / to：转出方 / 接收方人名（没有就留空字符串）
   - quantity：数量（正整数；没说就留空）
   - evidence：正文中体现该变化的原句（照抄、不改写、不超过 60 字）
   铁律：只抽**持有关系真的变了**的物品（赠予 / 抢夺 / 购得 / 用掉 / 遗失）；
        仅被提及、被看见、被描述外形的不算，同一个人一直拿在手里的不算。

五、kind = "小传节点" —— 主要或次要角色在本章发生的**生平里程碑级转折**（入人物小传事件轴）
   - name：人物名（照正文用名）
   - title：一句话事件标题（如"外门大比夺魁""南荒初遇洛清欢"）
   - summary：事件经过与心理/立场转折（30~100 字）
   - tag：只能取 成长突破 / 关系转折 / 高光时刻 / 重大失去 / 身份变化 / 其他
   - evidence：正文中体现该事件的原句（照抄、不改写、不超过 80 字）
   铁律：只抽**真正能写进人物生平传记的重大节点**；日常对话、普通赶路、小打小闹**一律不抽**（宁缺勿滥）。

总铁律：
1. 只依据本章正文，不推测、不补充、不虚构——这是资料整理，不是创作。
2. 五类都可能为空；本章没有这类变化就返回空数组，**不要为了凑数硬抽**。
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

/** 3.7.0 · W3：物品持有变化（章后整理新增的第四类） */
export interface ExtractedResource {
  item: string
  action: '获得' | '失去' | '转移' | '消耗'
  /** 转出方（没有为空串） */
  from: string
  /** 接收方（没有为空串） */
  to: string
  quantity?: number
  /** 原文证据（强制） */
  evidence: string
}

/** 一次章后整理抽出的五类变化（尚未与登记表现状比对） */
export interface ChapterChanges {
  foreshadows: ExtractedForeshadow[]
  relations: ExtractedRelation[]
  statuses: ExtractedStatus[]
  /** 3.7.0 · W3：物品流转候选 */
  resources: ExtractedResource[]
  /** 3.7.1：人物小传重要节点候选 */
  biographies?: ExtractedBioNode[]
}

const EMPTY_CHANGES: ChapterChanges = { foreshadows: [], relations: [], statuses: [], resources: [], biographies: [] }

/** WQ1-4：带状态版本（判定口径同 aiExtractSettingEntitiesWithStatus） */
export async function aiExtractChapterChangesWithStatus(
  chapterText: string,
  chapterTitle: string,
  opts?: {
    signal?: AbortSignal
    onToken?: (delta: string) => void
    /** 3.5.5 · ACP 分支：给了就只走 Agent，不要求 API 模型配置 */
    acpText?: (prompt: string) => Promise<string>
  },
): Promise<StepExecutionResult<ChapterChanges>> {
  const one = (state: StepResultState, errorCode?: string): StepExecutionResult<ChapterChanges> =>
    ({ state, coverage: { requested: 1, completed: state === 'completed' ? 1 : 0, failed: state === 'failed' ? 1 : 0, skipped: 0 }, ...(errorCode ? { errorCode, retryable: state === 'failed' } : {}) })
  const body = (chapterText ?? '').trim()
  if (!body) return one('completed')
  try {
  // #014 用途路由：从正文抽取属「整理」
  // 🔴 章题与正文都是**不可信文本**：包裹成边界块（内容一字不改，见 promptGuard 文件头）
  const fence = newAuthorFence()
  const user = `【章节】${chapterTitle.trim() ? authorBlock(fence, chapterTitle.trim()) : '（未命名章节）'}

【本章正文】
${authorBlock(fence, body)}

请抽取本章带来的伏笔 / 关系 / 状态 / 物品流转 / 小传节点变化。`
  // 3.5.5 · ACP 分支：只出变化候选，是否真的变了仍由 chapterPostProcess 做确定性比对。
  if (opts?.acpText) {
    const prompt = `${POST_PROCESS_SYS}\n\n${user}\n\n${acpJsonInstruction('章后整理变化候选', '[{"kind":"伏笔","action":"埋设 或 回收","code":"F0001（没有就空串）","content":"一句话概括"},{"kind":"关系","a":"甲","b":"乙","type":"关系类型（可空）","change":"怎么变的"},{"kind":"状态","name":"人物","state":"当前状态","evidence":"原文原句"},{"kind":"物品","item":"物品名","action":"获得/失去/转移/消耗","from":"转出方（可空）","to":"接收方（可空）","quantity":1,"evidence":"原文原句"},{"kind":"小传节点","name":"主要或次要角色名","title":"一句话事件标题","summary":"事件经过","tag":"成长突破","evidence":"原文原句"}]（本章没有变化就返回 []）')}`
    const rows = decodeAcpRows(await opts.acpText(prompt), { shape: 'array', min: 0, max: 60 })
    rows.forEach((row, index) => {
      const kind = acpField(row, ['kind', '类型', '类别'], '类别', { max: 20 })
      const at = `第 ${index + 1} 条`
      if (kind === '伏笔') {
        const action = acpField(row, ['action', '动作'], '伏笔动作', { max: 10 })
        if (!['埋设', '回收'].includes(action)) throw new AcpStructuredError('bad-field', `${at}的伏笔动作不是「埋设/回收」：${action}`)
        acpField(row, ['content', '伏笔内容', '内容'], '伏笔内容', { max: 400 })
      } else if (kind === '关系') {
        acpField(row, ['a', '人物A', '甲'], '关系甲方', { max: 60 })
        acpField(row, ['b', '人物B', '乙'], '关系乙方', { max: 60 })
      } else if (kind === '状态') {
        acpField(row, ['name', '姓名', '人物'], '人物名', { max: 60 })
        acpField(row, ['state', '状态'], '当前状态', { max: 200 })
      } else if (kind === '物品') {
        acpField(row, ['item', '物品', '名称'], '物品名', { max: 80 })
        const action = acpField(row, ['action', '动作'], '物品动作', { max: 10 })
        if (!['获得', '失去', '转移', '消耗'].includes(action)) throw new AcpStructuredError('bad-field', `${at}的物品动作不认识：${action}`)
        acpField(row, ['evidence', '证据', '原句'], '原文证据', { max: 120 })
      } else if (kind === '小传节点') {
        acpField(row, ['name', '姓名', '人物'], '人物名', { max: 60 })
        acpField(row, ['title', '标题', '事件'], '节点标题', { max: 120 })
        acpField(row, ['evidence', '证据', '原句'], '原文证据', { max: 120 })
      } else {
        throw new AcpStructuredError('bad-field', `${at}的类别不认识：${kind}`)
      }
    })
    const r = parseChapterChangesDetailed(JSON.stringify(rows))
    if (r.outcome === 'invalid') return one('failed', 'acp-invalid')
    return {
      state: 'completed',
      result: r,
      coverage: { requested: 1, completed: 1, failed: 0, skipped: 0 },
      sourceId: 'chapter-changes',
    }
  }
  const cfg = await requireProviderFor('utility')
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(POST_PROCESS_SYS, cfg) }, { role: 'user', content: user }],
    // 走流式（与 extract 同理：非流式等整段生成完会撞总超时墙）
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: longStream(opts?.onToken), output: 'json-object', reasoning: 'off' },
  )
    const r = parseChapterChangesDetailed(text)
    if (r.outcome === 'invalid') return one('failed', 'parse-invalid')
    return {
      state: 'completed',
      result: r,
      coverage: { requested: 1, completed: 1, failed: 0, skipped: 0 },
      sourceId: 'chapter-changes',
    }
  } catch (e) {
    if (isCancelled(e) || isAcpCancelled(e)) return one('cancelled', 'cancelled')
    return one('failed', e instanceof Error ? e.message.slice(0, 80) : 'unknown')
  }
}

/**
 * 把模型返回的 JSON **扁平数组**解析成三类（**纯函数**，不碰网络/数据库，便于单测）。
 *
 * 容错：数组元素缺字段 / 字段类型错 / 多余字段一律忽略；`kind` 不认识就跳过该条。
 * 🔴 丢弃空名字 / 空内容的条目 —— 让「没抽到」表现为空数组，而不是一条没用的空条目。
 */
export function parseChapterChanges(text: string): ChapterChanges {
  return parseChapterChangesDetailed(text).data
}

/**
 * WQ1-4：三态版本。合法空（本章无伏笔/关系/状态变化）＝ completed；
 * JSON 坏了 ⇒ invalid —— 章后整理据此写 notes，不假装"本章没有可整理的条目"。
 */
export function parseChapterChangesDetailed(text: string): TaskResult<ChapterChanges> {
  const parsed = parseObjectArrayDetailed(text)
  if (parsed.outcome === 'invalid') {
    return { outcome: 'invalid', data: { ...EMPTY_CHANGES }, diagnostics: parsed.diagnostics, truncated: parsed.truncated }
  }
  const out: ChapterChanges = { foreshadows: [], relations: [], statuses: [], resources: [], biographies: [] }
  const seenFore = new Set<string>()
  const seenRel = new Set<string>()
  const seenSt = new Set<string>()
  const seenRes = new Set<string>()
  const bioRows: unknown[] = []

  for (const it of parsed.data) {
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
    } else if (kind === '物品') {
      const item = asText(it.item ?? it['物品'] ?? it['名称']).trim()
      const actionRaw = asText(it.action ?? it['动作']).trim()
      const evidence = asText(it.evidence ?? it['证据'] ?? it['原句']).trim()
      if (!item || !evidence) continue
      const action: ExtractedResource['action'] = (['获得', '失去', '转移', '消耗'] as const).includes(actionRaw as never)
        ? actionRaw as ExtractedResource['action'] : '转移'
      const from = asText(it.from ?? it['转出方'] ?? it['从']).trim()
      const to = asText(it.to ?? it['接收方'] ?? it['到']).trim()
      const qtyRaw = Number(asText(it.quantity ?? it['数量']).trim())
      const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : undefined
      const key = `${item}::${action}::${from}::${to}::${evidence.slice(0, 20)}`
      if (seenRes.has(key)) continue
      seenRes.add(key)
      out.resources.push({ item, action, from, to, ...(quantity ? { quantity } : {}), evidence })
    } else if (kind === '小传节点') {
      bioRows.push(it)
    }
  }
  if (bioRows.length) {
    out.biographies = parseExtractedBioNodesDetailed(JSON.stringify(bioRows)).data.filter(b => !!b.name)
  }
  return { outcome: parsed.outcome, data: out, diagnostics: parsed.diagnostics, truncated: parsed.truncated }
}


export const POST_PROCESS_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'chapter-post-process',
      group: '设定与资料',
      name: '章后整理抽取',
      note: '从本章正文抽取「伏笔 / 关系 / 人物状态 / 物品流转 / 小传节点」五类变化候选（章后整理用，AI 只抽候选、不判是否已登记）。',
    },
    read: () => POST_PROCESS_SYS,
    write: t => { POST_PROCESS_SYS = t },
  },
]

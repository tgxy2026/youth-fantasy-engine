/**
 * 酒馆模式 · 角色设定更新（2026-09-14，老大要求）
 *
 * 【与「整理记忆」的分工 —— 这是本模块存在的全部理由】
 *   · 整理记忆 = 记录**发生过什么**（六栏档案）。自动会跑，手动也能跑。
 *   · 更新设定 = 判断**人物档案本身要不要改**（关系、内核、进度锁…）。**只手动跑**。
 *
 * 一句话记法：**记忆 = 发生过什么；设定 = 这件事让 Ta 变成了谁**。
 *
 * 为什么必须分开：记忆是「Ta 记得什么」，设定是「Ta 是谁」。一次分手当然会同时改变两者，
 * 但改设定的后果重得多 —— 改错了，之后**每一轮**对话都从错的人设出发，而且很难察觉
 * （模型会一直照着错的卡演，看上去只是"最近有点怪"）。所以设定只能**列出来让作者逐条裁决**，
 * 绝不自动写卡。
 *
 * 用户举的例子正是这条：阿岩提分手 → 小满与阿岩的记忆里都多一条「分手」事件（整理记忆干这个），
 * 而两张角色卡的「2.4 关系」要从「男女朋友」改成「前男女朋友」（更新设定干这个，
 * 且因为关系是双向的，**两张卡都要列**）。
 *
 * 🔴 本模块**不落库、不改卡**：只产出建议。采纳由调用方执行（`store.applyCardRevision`）。
 */
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { resolveTavernProvider, type ChatFn } from './engine'
import { uid } from '../id'
import { CARD_FIELDS, isCardField, readCardField, fieldLabel } from './types'
import { structHintFor } from './cardFields'
import type { CardFieldPath, FreeCharacter, TavernMessage } from './types'

// 字段表与读写工具在 ./types（纯数据 + 纯函数，store 也要用；放这里会让 store→revise→engine→store 成环）
export {
  CARD_FIELDS, fieldLabel, isCardField, readCardField, writeCardField,
} from './types'
export type { CardFieldPath } from './types'
/** 一条待裁决的设定变更 */
export type CardRevision = {
  id: string
  /** 归属角色（关系是双向的：一次分手要同时出现在两张卡上） */
  charId: string
  charName: string
  field: CardFieldPath
  fieldLabel: string
  /** 现有值（采纳前的样子，供对照） */
  before: string
  /** 建议的新值（**完整文本**，采纳即整段替换） */
  after: string
  reason: string
  /** 来自对话里的哪一句（尽量原文） */
  quote: string
  /**
   * 检出「这条 after 里混进了对话原文」时，这里是那段原文（保留标点，便于作者一眼认出）。
   * 有它 = 模型把「经过」写进了设定 —— 那是记忆的活，写进来就是同一件事喂两遍。
   * **只提示、不自动删**：删改要落盘的文本属于代笔，交给作者自己裁决。
   */
  narrative?: string
}

export function buildReviseSystem(charName: string): string {
  return `你是小说角色设定的**审查员**。现在要读一段〖对话记录〗，对照〖现有设定〗，找出**因这段对话而必须修改**的设定项。

角色：${charName}

〖判断标准 —— 宁少勿多〗
- 只报**对话里已经明确发生**的事所导致的改动。没有发生的走向、可能的发展、作者的客套话，一律不提。
- 现有设定与对话并不冲突的，**不要报**（比如对话里聊到天气，不该去改「1 世界」）。
- 一次审查通常只有 0~2 条，**返回空数组是完全正常的结果**。为了显得勤快而列一堆小改动，
  会让作者每次都要逐条否掉，这是最坏的体验。
- **不要改名字**（名字不在可改字段里）。

〖与「记忆」的分界 —— 只写「定称」，不写「经过」〗
- 「记忆」那边记的是**发生了什么**：谁说了哪一句、对方当时什么反应、什么场面、什么情绪。
  这些**不要**写进设定。
- 你写的是**定义层面的结果**：Ta 现在是什么身份、关系现在算什么、Ta 新知道了什么。
- ✅ **允许写沿革**：关系的定称与关键节点（在一起多久、谁提的分手、现在算什么关系）——
  角色卡的关系栏本来就该有这些。
- ❌ **不要复述对话过程**：原话、语气、对方的反应、当时的场面与情绪。
  两边出现一模一样的文字 = 同一件事喂了两遍。
- 反例：「阿岩说『这样拖着对你不好』，Ta 只回了一个好，没有争吵，平静地收好东西」→ 这是经过，属记忆；
  （注意示例本身就用「Ta」指代角色 —— 项目定死了这个指代，你写的 after 里也不许出现「他/她」）
  正确写法：「阿岩（前男友）：在一起 4 个月，由他提出分手」。
- 🔴 after 里**不要出现对话里的原句**（哪怕只有半句）。我们会逐条比对并标出来 ——
  引用了原话，就等于把「经过」搬进了设定，而那是记忆的活。
- after 长度与原文相当即可：**只改必须改的部分**，其余照原样带上，别顺手扩写。
- 落哪个字段要想清楚：**身份 / 职业 / 生活状态的转变 → world**；关系定称变了 → profile.relations；
  Ta 新知道了什么 → profile.knowledge；心境或立场的根本转变 → profile.core。

〖可改字段（field 只能填左侧的英文路径）〗
${CARD_FIELDS.map(f => `- ${f.path} —— ${f.label}：${f.when}`).join('\n')}

〖🔴 after 必须保持原格式 —— 这条写得重是因为改坏了很难发现〗
这些字段在界面上是**分条的小项**（形如「外貌：短发」一行一项），after 是整段替换：
- 原文是分条格式的 → after **沿用同一套小项**，只改真正要改的那一行，其余行一字不改照抄；
- 被改那一栏在设计上有这些小项，别自造新标签：
${CARD_FIELDS.map(f => {
  const hint = structHintFor(f.path)
  return hint ? `  · ${f.path}：${hint}` : ''
}).filter(Boolean).join('\n')}
- 把分条改成一整段散文，会让作者那边所有小格塌成一坨 —— 这是必须避免的事故。

〖每条要写清〗
- field：上面清单里的路径，一字不差。
- after：**改完之后的完整文本**（不是"在原文后面加一句"）—— 采纳时是整段替换，所以你必须把整段重写一遍。
- reason：为什么必须改（一句话，说清是什么事件造成的）。
- quote：对话里的原句，尽量照抄。

〖输出格式〗只输出一个 JSON 对象，不要代码块、不要解释、不要前后缀：
{"changes":[{"field":"profile.relations","after":"（改完后的完整文本）","reason":"（为什么）","quote":"（对话原句）"}]}
不需要修改时输出：{"changes":[]}`
}

/** 归一化：去掉空白与所有标点 / 符号，只留文字与数字（比「是不是同一句」时才不会被标点差异骗过） */
function normChars(s: string): { n: string; idx: number[]; chars: string[] } {
  const chars = [...String(s ?? '')]
  const out: string[] = []
  const idx: number[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (!c.trim() || /\p{P}|\p{S}/u.test(c)) continue
    out.push(c)
    idx.push(i)
  }
  return { n: out.join(''), idx, chars }
}

/**
 * 找出 `after` 与〖对话记录〗**共有的最长片段**（≥ min 个字才算）。返回原文里那一段（保留标点）。
 * 阈值取 6：实测真被抄进去的片段是「以后别来找我了」（7 字）——
 * 定得太严会漏（这才是主要风险，因为它只是提示条、误报的代价很低）。
 *
 * 【为什么要做这个检查】提示词已经写明「只写定称、不写经过」，但实测本地模型仍会把对白抄进关系栏
 * （例：`分手时他说「这样拖着对你不好」`）—— 而**靠自觉的指令必然漏**。所以再加一道确定性检查，
 * 命中了就在裁决界面上标出来。它只负责「标」，不负责「改」：删作者要落盘的文本属于代笔。
 */
export function findNarrativeOverlap(after: string, transcript: string, min = 6): string {
  const a = normChars(after)
  const t = normChars(transcript).n
  if (a.n.length < min || t.length < min) return ''
  let bestAt = -1
  let bestLen = 0
  for (let i = 0; i + min <= a.n.length; i++) {
    if (!t.includes(a.n.slice(i, i + min))) continue
    let len = min
    while (i + len < a.n.length && t.includes(a.n.slice(i, i + len + 1))) len++
    if (len > bestLen) { bestLen = len; bestAt = i }
  }
  if (bestAt < 0) return ''
  // 归一化下标映射回原文：作者一眼能认出是哪句，也方便他手动删掉
  return a.chars.slice(a.idx[bestAt], a.idx[bestAt + bestLen - 1] + 1).join('')
}

/**
 * 只取最近的一部分对话做审查：设定变更多半出在近期，而且全文可能超出上下文。
 *
 * `speakerName` 用来把 AI 侧的发言标成**具体是谁说的** —— 多角色同场时这一点很关键：
 * 「谁对谁说了分手」和「谁对谁说了谢谢」是完全不同的两件事，只写「角色」模型分不出来。
 */
export function recentTranscript(
  messages: TavernMessage[],
  maxChars = 6000,
  speakerName?: (m: TavernMessage) => string,
): string {
  const lines = messages
    .filter(m => m.role !== 'system' && !m.hidden && m.content.trim())
    .map(m => `〖${m.role === 'user' ? '对方' : (speakerName?.(m) || '角色')}〗${m.content.trim()}`)
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (used + l.length > maxChars) break
    out.unshift(l)
    used += l.length
  }
  // 被截断时给一句说明，免得模型以为对话就这么短
  const head = out.length < lines.length ? `（下面是最近 ${out.length} 条，更早的已省略）\n` : ''
  return head + out.join('\n')
}

export type ReviseArgs = {
  char: FreeCharacter
  messages: TavernMessage[]
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  /** 送进提示词的对话字符上限 */
  maxChars?: number
  /** 把 AI 侧发言标成「谁说的」（多角色同场必需） */
  speakerName?: (m: TavernMessage) => string
}

/**
 * 跑一次设定审查，产出**建议列表**（不落库）。
 * 没有任何建议（或模型乱答）时返回空数组 —— 调用方据此显示「这一段没有需要改的设定」。
 */
export async function proposeCardRevisions(args: ReviseArgs): Promise<CardRevision[]> {
  const { char, messages, providerId, chatFn, signal, maxChars, speakerName } = args
  const transcript = recentTranscript(messages, maxChars, speakerName)
  if (!transcript.trim()) return []

  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  // 现有设定：**空字段也要列**（对话里新长出来的信息正是要补进去的）
  const current = CARD_FIELDS
    .map(f => `- ${f.path}（${f.label}）：${readCardField(char, f.path).trim() || '（现为空）'}`)
    .join('\n')

  const fence = newAuthorFence()
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildReviseSystem(char.name) },
    {
      role: 'user',
      content: [
        '〖现有设定〗',
        current,
        '',
        '〖对话记录〗',
        authorBlock(fence, transcript),
        '',
        '请按要求输出 JSON（不需要修改就输出 {"changes":[]}）。',
      ].join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    // 结构化任务：由 chat() 统一解析 json 开关 → 低温
    json: true,
    think: false,
  })

  return parseRevisions(reply, char, transcript)
}

/**
 * 解析 + **二次把关**。模型返回的字段名必须落在白名单里，否则丢掉
 * （不做这一步的话，一个拼错的字段名会让整条采纳动作写到一个不存在的键上）。
 * 同一字段出现多条时只留最后一条：采纳是整段替换，前几条必然被覆盖。
 *
 * `transcript` 给定时顺带做「after 混进对话原文」的检查：命中就把那一段挂在 `narrative` 上
 * （界面据此提示，但**不自动改** —— 删作者要落盘的文本属于代笔）。
 */
export function parseRevisions(raw: string, char: FreeCharacter, transcript = ''): CardRevision[] {
  const rows = parseObjectArray(raw)
  const byField = new Map<CardFieldPath, CardRevision>()
  for (const r of rows) {
    const field = asText(r.field).trim() as CardFieldPath
    if (!isCardField(field)) continue
    const after = asText(r.after).trim()
    if (!after) continue
    const before = readCardField(char, field).trim()
    // 与现状一模一样 → 不是改动，别浪费作者的一次裁决
    if (after === before) continue
    const narrative = transcript ? findNarrativeOverlap(after, transcript) : ''
    byField.set(field, {
      id: uid(),
      charId: char.id,
      charName: char.name,
      field,
      fieldLabel: fieldLabel(field),
      before,
      after,
      reason: asText(r.reason).trim() || '（模型未给出理由）',
      quote: asText(r.quote).trim(),
      ...(narrative ? { narrative } : {}),
    })
  }
  return [...byField.values()]
}

export { isCancelled }

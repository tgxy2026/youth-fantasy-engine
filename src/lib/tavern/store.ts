/**
 * 酒馆模式 · 存储封装（索引 + 分条）
 *
 * 设计依据：方案 §3.2 / §4.4。
 *
 * 【为什么索引与分条分开】
 * 会话与角色卡都可能很长（含 messages[]）。若把列表也塞进一个 key，
 * 每次列个清单都要把全部会话正文读进内存、云同步载荷也会失控。
 *
 * 【两条线的存储归属完全不同（方案 §3.1）】
 *   · 剧情模式 → 项目级 settingsKV（`db.getSetting/setSetting` 会自动拼 `${projectId}::` 前缀）
 *     —— 跟着小说项目走，导出项目时一并带走
 *   · 自由模式 → **全局 meta**（`db.getMeta/setMeta`，无前缀）
 *     —— 不绑任何项目，删项目也不会跟着没。这是刻意的：先例是 AI 模型配置从项目级迁到全局。
 *
 * 【铁律】索引与分条必须成对读写。只写一边就会出现「列表里有、点开是空的」幽灵条目，
 *        故本文件所有增删改都成对操作，并额外提供 audit/prune 自检（方案 §11.8）。
 *
 * 注意：本文件是纯逻辑，不含 React。
 */
import * as db from '../db'
import { uid } from '../id'
import { DESKTOP, getDesktopState } from '../desktop'
import { isDesktopCloudUnavailable } from '../desktopCloudSync'
import { EMPTY_CAST_SETTING, DEFAULT_TALKATIVITY, writeCardField, cardStoryId, JOURNAL_KEEP, MAX_AI_CAST } from './types'
import { structSpecOf, normalizeStructMarkup } from './cardFields'
import type {
  TavernSession, TavernSessionIndexItem, TavernCast, CastSetting,
  TavernReport, TavernReportIndexItem,
  FreeCharacter, FreeSession, FreeMemory, DailyState,
  CharJournal, CharJournalEntry,
  TavernCharIndexItem, FreeSessionIndexItem, TavernMessage, TavernCheckpoint,
  TavernDirectorNote, CardFieldPath, TavernWatermark, FreeCheckpoint,
} from './types'

// ==================== 存储键 ====================
// 剧情模式（会经 db.getSetting 自动加项目前缀）
const K = {
  sessionIndex: 'tavern.sessionIndex',
  session: (id: string) => `tavern.session.${id}`,
  cast: (cardId: string) => `tavern.cast.${cardId}`,
} as const

// 自由模式（全局，无前缀）
const G = {
  charIndex: 'tavern.charIndex',
  freeChar: (id: string) => `tavern.free.char.${id}`,
  freeSessionIndex: 'tavern.free.sessionIndex',
  freeSession: (id: string) => `tavern.free.session.${id}`,
  memory: (charId: string) => `tavern.free.mem.${charId}`,
  daily: (charId: string) => `tavern.free.daily.${charId}`,
  greeting: (charId: string) => `tavern.free.greeting.${charId}`,
  journal: (charId: string) => `tavern.free.journal.${charId}`,
} as const

// ==================== 工具 ====================
function now() { return Date.now() }

function castBrief(cast: TavernCast[]): string {
  return cast.map(c => c.name).filter(Boolean).join('、')
}

// ==================== 剧情模式 · 会话 ====================

export async function listSessions(): Promise<TavernSessionIndexItem[]> {
  const list = await db.getSetting<TavernSessionIndexItem[]>(K.sessionIndex, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSession(id: string): Promise<TavernSession | null> {
  return db.getSetting<TavernSession | null>(K.session(id), null)
}

/**
 * 保存会话（**索引与分条成对写**）。
 * 调用方传入完整会话对象；updatedAt 由本函数统一刷新，避免各处不一致。
 */
// ==================== 消息级操作（重说 / 编辑 / 隐藏 / 删除） ====================
//
// 这四件事都**只构造新会话、不落库** —— 由调用方决定何时保存（通常改完立刻存）。
// 之所以不在这里写库：编辑时「改一条消息」与「写回索引」应当是一个动作，
// 中间态落库只会让左栏的更新时间乱跳。
//
// 用泛型是因为剧情会话（TavernSession）与自由会话（FreeSession）都要用：
// 两者都有 messages 与 updatedAt，其余字段原样带过。

type MsgHost = { messages: TavernMessage[]; updatedAt: number }

/**
 * 设置 / 清除临时导演指令（B2）。传 null 即清除；正文为空白也按清除处理
 * （空白指令等于没写，留着会让界面显示一条点不动的空条目）。
 */
export function setDirectorNote<T extends MsgHost>(s: T, note: TavernDirectorNote | null): T {
  const next = { ...s, updatedAt: Date.now() } as T & { directorNote?: TavernDirectorNote }
  if (note && String(note.text ?? '').trim()) next.directorNote = note
  else delete next.directorNote
  return next
}

/** 改一条消息：正文（编辑）或只翻标记（hidden / edited） */
export function patchMessage<T extends MsgHost>(s: T, id: string, patch: Partial<TavernMessage>): T {
  return { ...s, messages: s.messages.map(m => (m.id === id ? { ...m, ...patch } : m)), updatedAt: Date.now() }
}

/** 删掉一条消息 */
export function dropMessage<T extends MsgHost>(s: T, id: string): T {
  return { ...s, messages: s.messages.filter(m => m.id !== id), updatedAt: Date.now() }
}

/**
 * 在场调度（A6）：静音 / 取消静音、设健谈度。
 *
 * 也写成泛型纯函数，因为剧情会话（cardId）与自由会话（charId）共用同一套字段语义 ——
 * 两处各写一份必然漂移（本项目反复踩过），而「静音」的语义一旦分叉就会变成两种行为。
 */
type DirectedHost = {
  muted?: string[]
  talkativity?: Record<string, number>
  updatedAt: number
}

/** 静音 = 在场但不发言（临时开关，随时可取消） */
export function setMuted<T extends DirectedHost>(s: T, id: string, muted: boolean): T {
  const cur = new Set(s.muted ?? [])
  if (muted) cur.add(id)
  else cur.delete(id)
  const list = [...cur]
  return { ...s, muted: list.length ? list : undefined, updatedAt: Date.now() }
}

/**
 * 设健谈度（0–100）。**回到默认值就删键** —— 否则会话记录里会攒一堆「50」，
 * 既看不出哪些是作者真调过的，也让「全默认 → 不注入这一层」的优化失效。
 */
export function setTalkativity<T extends DirectedHost>(s: T, id: string, value: number): T {
  const next = { ...(s.talkativity ?? {}) }
  if (value === DEFAULT_TALKATIVITY) delete next[id]
  else next[id] = value
  return { ...s, talkativity: Object.keys(next).length ? next : undefined, updatedAt: Date.now() }
}

/**
 * 隐藏 / 取消隐藏。
 * 隐藏 = **不进上下文**（组装时跳过，见 prompt.ts 的 toChatMessages 与 memory.ts 的水位线），
 * 但界面仍然留着、可以随时恢复 —— 长对话里"这段先别让 Ta 记得"最省事的做法。
 */
export function toggleMessageHidden<T extends MsgHost>(s: T, id: string): T {
  return {
    ...s,
    messages: s.messages.map(m => (m.id === id ? { ...m, hidden: !m.hidden } : m)),
    updatedAt: Date.now(),
  }
}

/** 末尾那条 AI 回复的 id（只有它可以被「重说」）；没有则返回空串 */
export function lastAssistantId(messages: TavernMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id
  }
  return ''
}

// ==================== 多候选（T3 swipe，2026-10-05） ====================
//
// 【为什么不改引擎】`runPlotTurn` / `runFreeTurn` 的 `userText === null` 契约就是「重说」——
//   先丢掉末尾 assistant、再生成一条替换它。引擎**一个字不改**，多候选只在**组件层**做：
//   拿到新文本后，把它**记进**消息的 `variants` 里。这样：
//     · 引擎的「重说」语义原样保留（不破坏既有调用与单测）；
//     · 关闭开关时 `variants` 恒为 undefined，行为与现在**逐字一致**；
//     · 剧情 / 自由两模式共用 store 与组件，一次改完两边都有。
//
// 🔴 与记忆水位线的交互（关键）：切换候选**不改消息 id**，所以 `rewindAfterReroll`（它按
//   「末尾消息 id 被替换」判断）在这里**不适用**。但候选换了确实意味着「这一轮的走向变了」——
//   必须把已总结进记忆的内容重判，否则模型会记得一条已经不存在的候选说的话
//   （症状与 branchSession 那条注释描述的一致：「Ta 记得还没发生的事」）。

/** 候选上限：超过就丢最早的那份（只保留最近 N 个版本，避免存储无限膨胀） */
export const MAX_VARIANTS = 5

/**
 * 把一份新生成的文本记成消息的候选（追加到末尾并选中）。
 *
 * 首次调用时 `variants` 为 undefined ⇒ 用**原来的 content** 作为第 0 个候选，
 * 于是「重说」第一次点下去就有 [原版, 新版] 两份，可以直接翻回原版对照 —— 这正是 swipe 的用法。
 * `content` 同步为新选中的那份（它是唯一被渲染 / 进上下文的值）。
 */
export function appendVariant<T extends MsgHost>(s: T, id: string, text: string): T {
  const t = text.trim()
  if (!t) return s   // 空回复不记（同引擎「空回复不落库」的口径）
  if (!s.messages.some(m => m.id === id)) return s   // 找不到目标 ⇒ 原样返回，不空刷 updatedAt
  return {
    ...s,
    messages: s.messages.map(m => {
      if (m.id !== id) return m
      const base = m.variants?.length ? m.variants : [m.content]
      const next = [...base, t].slice(-MAX_VARIANTS)
      return { ...m, content: t, variants: next, variantIdx: next.length - 1, edited: m.edited }
    }),
    updatedAt: Date.now(),
  }
}

/**
 * 选中某个候选（`content` 跟着切）。
 *
 * ⚠️ 下标越界 / 没有候选时原样返回 —— 调用方不必先判。
 * 🔴 调用方（组件）必须在切换后处理记忆水位线：见 `rewindForVariantSwitch`。
 */
export function selectVariant<T extends MsgHost>(s: T, id: string, idx: number): T {
  const m = s.messages.find(x => x.id === id)
  const vs = m?.variants ?? []
  if (!m || idx < 0 || idx >= vs.length || idx === (m.variantIdx ?? 0)) return s
  return {
    ...s,
    messages: s.messages.map(x => (x.id === id ? { ...x, content: vs[idx], variantIdx: idx } : x)),
    updatedAt: Date.now(),
  }
}

/**
 * 切换候选后回收记忆与水位线。
 *
 * 判据与 `branchSession` / `rewindAfterReroll` **同源**：只要「已总结进记忆的范围」
 * 覆盖到这条被改的消息，那份记忆里就含了一条已经不作数的候选 ⇒ 清记忆 + 水位线退到这条之前。
 *
 * 传 `undefined`（没有水位线 / 水位线在更早处）⇒ 什么都不动。
 *
 * 🔴 写成泛型：剧情模式传 `TavernSession`、自由模式传 `FreeSession` —— 两者都有
 *    `messages` / `watermark`（自由模式的会话级记忆没用到，但字段定义一致）。
 *    两模式各写一份必然漂移，「水位线该退到哪」这套判据在项目里已经有三处（branch / reroll / 这里），
 *    再加一处就会失控。
 */
export function rewindForVariantSwitch<T extends { messages: TavernMessage[]; watermark?: TavernWatermark; memory?: string; updatedAt: number }>(
  s: T, messageId: string,
): T {
  const wm = s.watermark
  if (!wm) return s
  const wmIdx = s.messages.findIndex(m => m.id === wm.messageId)
  const at = s.messages.findIndex(m => m.id === messageId)
  if (wmIdx < 0 || at < 0 || wmIdx < at) return s   // 水位线还没走到这条 ⇒ 记忆不含它，安全
  const prev = at > 0 ? s.messages[at - 1] : undefined
  return {
    ...s,
    watermark: prev ? { messageId: prev.id, at: Date.now() } : undefined,
    memory: undefined,
    updatedAt: Date.now(),
  }
}

// ==================== 分支 / 检查点 / 回滚（2026-09-14，路线图第 3 批） ====================
//
// 【三件事的语义，别搞混】
//   · **分支**：另开一场推演、只保留到第 N 条 —— **原推演原封不动**。用于「从这里换个走向试试」。
//   · **检查点**：场内的路标，连**记忆**一起存，随时可以回到那一刻。
//   · **回滚**：截回检查点。**回滚前自动留一份当前进度**（undoSnapshot），所以这一步是可逆的 ——
//     "不可逆的试验"没人敢下手，留一级撤销它才敢用。
//
// 与消息级操作同一个约定：这些函数**只构造新会话、不落库**，由调用方决定何时保存。

/**
 * 分支：复制一场推演并只保留到 `atMessageId`（含这一条）。找不到该条时返回 null。
 *
 * 🔴 **水位线必须重算，不能沿用** —— 三种情况要分开处理：
 *   · 水位线落在分支范围内 → 原样保留（记忆与它一致，边界正确）；
 *   · 水位线在分叉点**之后**（= 记忆里已经含了「分支里还没发生」的事）→ 把水位线退到分支末尾，
 *     **并把本场记忆一起清空**。只退水位线不清记忆的话，模型会引用一段被删掉的未来，
 *     表现是「它怎么知道还没发生的事」—— 这种 bug 很难从现象反推回来。
 *   · 没有水位线 / 水位线消息已被删 → 什么都不动（`messagesAfterWatermark` 会按"全都没总结"处理）。
 */
export function branchSession(
  s: TavernSession,
  atMessageId: string,
  existingTitles: string[] = [],
): TavernSession | null {
  const cut = s.messages.findIndex(m => m.id === atMessageId)
  if (cut < 0) return null
  const messages = s.messages.slice(0, cut + 1)
  const last = messages[messages.length - 1]

  let watermark = s.watermark
  let memory = s.memory
  // 先取出局部量：在闭包里用 s.watermark 会丢掉收窄（TS 只对能证明不变的引用负责）
  const wm = s.watermark
  const wmIdx = wm ? s.messages.findIndex(m => m.id === wm.messageId) : -1
  if (wm && wmIdx > cut) {
    watermark = last ? { messageId: last.id, at: now() } : undefined
    memory = undefined
  }

  return {
    ...s,
    id: uid(),
    title: branchTitle(s.title, existingTitles),
    messages,
    watermark,
    memory,
    // 检查点只带得过分支点之前的（后面那些属于"被截掉的那条时间线"）
    checkpoints: (s.checkpoints ?? []).filter(c => c.messageCount <= messages.length),
    undoSnapshot: undefined,
    createdAt: now(),
    updatedAt: now(),
  }
}

/**
 * 重说（reroll）后回收「本场记忆 + 水位线」。
 *
 * 重说会丢掉末尾那条 assistant、重新生成一条（**新 id**）。若水位线正好指着**被替换掉的那条**，
 * 说明「已总结进记忆的内容里含这次作废的回复」→ 必须**清记忆 + 水位线退到新末尾**；
 * 否则模型会引用一段被删掉的未来，症状是「Ta 记得还没发生的事」
 * （与 `branchSession` 同一套判据：别只退水位线、也别只清记忆）。
 *
 * ⚠️ 只处理**会话级** `memory`。自由模式的记忆是按角色分条存的、且只在「结束本轮对话」时整理，
 *    而归档后重说被挡 → 自由模式不存在「被总结过又被作废」的回复，故不涉及此函数。
 *
 * @param droppedId 被替换掉的那条消息 id；**传 undefined 表示本次没真替换**（取消 / 空回复），原样返回。
 */
export function rewindAfterReroll(s: TavernSession, droppedId?: string): TavernSession {
  if (!droppedId || s.watermark?.messageId !== droppedId) return s
  const last = s.messages[s.messages.length - 1]
  return {
    ...s,
    watermark: last ? { messageId: last.id, at: now() } : undefined,
    memory: undefined,
  }
}

/**
 * 分支后缀 —— 与 `branchTitle()` 写进去的命名约定**一字对应**。
 *
 * 🔴 **单一真源**：`branchTitle` 的「剥离」与 `groupSessionsByBranch` 的「父子反推」**共用这一个正则**。
 *    改命名约定只动这里。（若两处各写一份，改一处漏一处会**静默错位**：标题照旧生成、
 *    但左栏分组全部认不出来 —— 界面上看起来「就是没有分支」，不会报错。）
 */
const BRANCH_SUFFIX = / ·分支(\d+)$/

/** 取分支号（非分支返回 0）。同级排序用：`·分支2` 要排在 `·分支10` 前面。 */
export function branchNoOf(title: string): number {
  const m = BRANCH_SUFFIX.exec(title)
  return m ? Number(m[1]) : 0
}

/** 这个标题是不是分支（`·分支N` 结尾）。左栏据此决定「分支树」开关要不要出现。 */
export function isBranchTitle(title: string): boolean {
  return BRANCH_SUFFIX.test(title)
}

/**
 * 分支名避重：`原题 ·分支2`、`原题 ·分支3`…
 * 序号从 2 起（第 1 份就是原题本身），并**跳过已被占用的号** —— 删掉分支再建不会撞名。
 * 已有「·分支N」后缀的标题先剥掉，免得出现「… ·分支2 ·分支2」。
 */
export function branchTitle(title: string, existingTitles: string[] = []): string {
  const base = title.replace(BRANCH_SUFFIX, '')
  for (let i = 2; i < 1000; i++) {
    const t = `${base} ·分支${i}`
    if (!existingTitles.includes(t)) return t
  }
  return `${base} ·分支${existingTitles.length + 1}`
}

/** 左栏场次列表的一行（分支树视图用，2026-10-05 S1a） */
export type SessionTreeRow = {
  s: TavernSessionIndexItem
  /** 缩进层级：0 = 根场次；1 = 某个根场次的分支 */
  depth: 0 | 1
  /** 父场次不在此次传入的列表里（被筛选词滤掉 / 根已删）—— 界面据此给一句说明 */
  missingParent: boolean
}

/**
 * 把场次索引排成左栏要显示的顺序（S1a 分支树视图）。
 *
 * · `tree === false` ⇒ **原样平铺**（与加这个功能之前逐行一致 ⇒ 老行为零漂移）。
 * · `tree === true`  ⇒ 每个根场次后面**紧跟**它自己的分支（缩进一级）。
 *
 * 【父子从哪来】**不存 `parentId`**，完全由 `branchTitle()` 写的「 ·分支N」后缀反推 ——
 *   所以本函数与 `branchTitle` 是一对，改命名约定必须同时改两处（正则已共用 `BRANCH_SUFFIX`）。
 * 【为什么只有两层】`branchTitle` 会**先把标题里已有的 ` ·分支N` 剥掉再编号**
 *   （`'A ·分支2'` 的基名仍是 `'A'`）⇒「分支的分支」拿到的是同一个根，不可能出现三级。
 * 【孤儿分支】父不在此次列表里时**照样返回**（`missingParent: true`）——
 *   否则「加个筛选词，分支就凭空消失」，作者会以为数据丢了。
 */
export function groupSessionsByBranch(
  list: TavernSessionIndexItem[],
  tree: boolean,
): SessionTreeRow[] {
  if (!tree) return list.map(s => ({ s, depth: 0, missingParent: false }))

  const roots: TavernSessionIndexItem[] = []
  const kids = new Map<string, TavernSessionIndexItem[]>()
  for (const s of list) {
    const m = BRANCH_SUFFIX.exec(s.title)
    if (!m) { roots.push(s); continue }
    const base = s.title.slice(0, m.index)
    const arr = kids.get(base)
    if (arr) arr.push(s)
    else kids.set(base, [s])
  }

  const out: SessionTreeRow[] = []
  const shown = new Set<string>()
  for (const r of roots) {
    out.push({ s: r, depth: 0, missingParent: false })
    shown.add(r.id)
    const children = kids.get(r.title)
    if (!children) continue
    children.sort((a, b) => branchNoOf(a.title) - branchNoOf(b.title))
    for (const c of children) { out.push({ s: c, depth: 1, missingParent: false }); shown.add(c.id) }
  }
  // 剩下的都是「父不在此次列表里」的分支（根被筛掉 / 根已删）：仍要显示，别让它凭空消失
  for (const children of kids.values()) {
    children.sort((a, b) => branchNoOf(a.title) - branchNoOf(b.title))
    for (const c of children) if (!shown.has(c.id)) out.push({ s: c, depth: 1, missingParent: true })
  }
  return out
}

/** 在场内打个检查点（连记忆一起存 —— 回滚要还原的是「那一刻的完整状态」） */
export function addCheckpoint(s: TavernSession, label = ''): TavernSession {
  const cp: TavernCheckpoint = {
    id: uid(),
    label: label.trim(),
    messageCount: s.messages.length,
    watermark: s.watermark,
    memory: s.memory,
    at: now(),
  }
  return { ...s, checkpoints: [...(s.checkpoints ?? []), cp], updatedAt: now() }
}

export function dropCheckpoint(s: TavernSession, cpId: string): TavernSession {
  return { ...s, checkpoints: (s.checkpoints ?? []).filter(c => c.id !== cpId), updatedAt: now() }
}

/**
 * 回到某个检查点：消息截回那一刻，记忆与水位线一并还原。
 * **会把当前进度先存进 `undoSnapshot`** —— 于是「回滚」变成可撤销的动作（再点「撤销上次回滚」就回来）。
 */
export function rollbackToCheckpoint(s: TavernSession, cpId: string): TavernSession | null {
  const cp = (s.checkpoints ?? []).find(c => c.id === cpId)
  if (!cp) return null
  return {
    ...s,
    messages: s.messages.slice(0, cp.messageCount),
    watermark: cp.watermark,
    memory: cp.memory,
    // 只留一层：再回滚一次就覆盖它 —— 不做无限套娃（那会把「撤销」变成"往前翻历史"）
    undoSnapshot: { messages: s.messages, watermark: s.watermark, memory: s.memory, at: now() },
    updatedAt: now(),
  }
}

/** 撤销上一次回滚（没有快照时原样返回；调用方按 `undoSnapshot` 决定按钮显不显示） */
export function undoRollback(s: TavernSession): TavernSession {
  const u = s.undoSnapshot
  if (!u) return s
  return {
    ...s,
    messages: u.messages,
    watermark: u.watermark,
    memory: u.memory,
    undoSnapshot: undefined,
    updatedAt: now(),
  }
}

// ==================== 自由模式 · 检查点 / 回滚（F1，2026-10-05）====================
//
// 【与剧情模式那套的关系】下面四个函数与 `addCheckpoint` / `dropCheckpoint` /
//   `rollbackToCheckpoint` / `undoRollback` **一一对应**，但有一个本质差别：
//   · 剧情模式的记忆（`session.memory`）就在会话对象里 ⇒ 回滚是**纯改对象**的动作；
//   · 自由模式的记忆**按角色分条存在独立存储**（`G.memory(charId)`），不在会话里 ⇒
//     ① 存点要**一次快照 N 份**（由调用方读好传进来）；
//     ② 回滚要**把这 N 份写回存储**，所以回滚函数额外返回 `restore` 交给调用方落盘。
//   ⇒ 这四个仍是**纯函数**（不碰 db），落盘编排在 `useTavernFreeModel` 里。
//
// 🔴 为什么必须回滚记忆：不回滚的话「消息退回去了、Ta 却记得那些没发生的事」——
//   这正是自由模式独有的坑（剧情模式只有一份记忆，跟着会话一起回滚，不会分家）。

/** 存点（纯）：把「此刻的会话态 + N 份记忆」打包成一个检查点 */
function makeFreeCheckpoint(s: FreeSession, memories: FreeMemory[], label = ''): FreeCheckpoint {
  return {
    id: uid(),
    label: label.trim(),
    messageCount: s.messages.length,
    watermark: s.watermark,
    memories,
    vars: s.vars,
    at: now(),
  }
}

/** 把检查点挂到会话上（纯） */
export function addFreeCheckpoint(s: FreeSession, memories: FreeMemory[], label = ''): FreeSession {
  return {
    ...s,
    checkpoints: [...(s.checkpoints ?? []), makeFreeCheckpoint(s, memories, label)],
    updatedAt: now(),
  }
}

export function dropFreeCheckpoint(s: FreeSession, cpId: string): FreeSession {
  return { ...s, checkpoints: (s.checkpoints ?? []).filter(c => c.id !== cpId), updatedAt: now() }
}

/**
 * 回到某个检查点（纯）。返回新会话 + **要写回存储的记忆**。
 *
 * `currentMemories` = 此刻的 N 份记忆（调用方读好传进来）—— 它得进 `undoSnapshot`，
 * 否则「撤销上次回滚」无处可取（记忆不在会话对象里，这是与剧情模式最大的实现差异）。
 */
export function rollbackFreeToCheckpoint(
  s: FreeSession,
  cpId: string,
  currentMemories: FreeMemory[],
): { session: FreeSession; restore: FreeMemory[] } | null {
  const cp = (s.checkpoints ?? []).find(c => c.id === cpId)
  if (!cp) return null
  return {
    session: {
      ...s,
      messages: s.messages.slice(0, cp.messageCount),
      watermark: cp.watermark,
      vars: cp.vars,
      // 只留一层：再回滚一次就覆盖它 —— 与剧情模式同一条纪律（不做无限套娃）
      undoSnapshot: {
        messages: s.messages, watermark: s.watermark, memories: currentMemories, vars: s.vars, at: now(),
      },
      updatedAt: now(),
    },
    restore: cp.memories,
  }
}

/** 撤销上一次回滚（纯）。返回新会话 + 要写回存储的记忆；没有快照时返回 null（调用方按 `undoSnapshot` 显示按钮） */
export function undoFreeRollback(s: FreeSession): { session: FreeSession; restore: FreeMemory[] } | null {
  const u = s.undoSnapshot
  if (!u) return null
  return {
    session: {
      ...s,
      messages: u.messages,
      watermark: u.watermark,
      vars: u.vars,
      undoSnapshot: undefined,
      updatedAt: now(),
    },
    restore: u.memories,
  }
}

export async function saveSession(s: TavernSession): Promise<TavernSession> {
  const next: TavernSession = { ...s, updatedAt: now() }
  await db.setSetting(K.session(next.id), next)
  const idx = await db.getSetting<TavernSessionIndexItem[]>(K.sessionIndex, [])
  const item: TavernSessionIndexItem = {
    id: next.id,
    title: next.title,
    mode: next.mode,
    castBrief: castBrief(next.cast),
    anchorTitle: next.anchorChapterLabel,
    updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setSetting(K.sessionIndex, idx)
  return next
}

export async function createSession(init: Omit<TavernSession, 'id' | 'createdAt' | 'updatedAt' | 'messages'> & { messages?: TavernSession['messages'] }): Promise<TavernSession> {
  const s: TavernSession = {
    ...init,
    id: uid(),
    messages: init.messages ?? [],
    createdAt: now(),
    updatedAt: now(),
  }
  return saveSession(s)
}

/** 删除会话（索引与分条同时删，避免幽灵条目） */
/** 清掉某一场留下的推演报告 —— 见 deleteSession 的说明（孤儿报告清理） */
async function cleanReportsOfSession(projectId: string, sessionId: string): Promise<void> {
  const rows = await db.listProjectReports(projectId)
  for (const r of rows) {
    if (r.sessionId === sessionId) await db.deleteReport(r.id)
  }
}

export async function deleteSession(id: string): Promise<void> {
  const idx = await db.getSetting<TavernSessionIndexItem[]>(K.sessionIndex, [])
  await db.setSetting(K.sessionIndex, idx.filter(x => x.id !== id))
  // 分条直接覆盖为空对象（KV 无 delete 语义时的等价做法：置空后不再被读取）
  await db.setSetting(K.session(id), null)
  // 🔴 顺带清掉这一场的推演报告（2026-09-19 六维审计 P2-8）：报告以 projectId 为索引，
  //    删**项目**时有级联（db.deleteProject 会一并清 tavernReports），删**单场会话**却没有 ——
  //    于是「推演报告」页里留下一份孤儿，点开是一场空，作者也没有入口删它。
  try {
    await cleanReportsOfSession(db.getCurrentProjectId(), id)
  } catch (e) {
    // 🔴 别静默吞（2026-10-04 六维审计 A5）：静默吞掉后，「推演报告」页会留下一份点开一场空的
    //    孤儿报告，作者无从知道为什么 —— lib 层不能弹窗，至少留一行日志，下次排查有据可查。
    console.warn('[tavern] 删除会话时清理推演报告失败（报告页可能留有孤儿）：', e)
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  const s = await getSession(id)
  if (!s) return
  await saveSession({ ...s, title })
}

// ==================== 剧情模式 · 扮演设定 ====================

export async function getCastSetting(cardId: string): Promise<CastSetting> {
  // 空值兜底走 types 的单一真源（UI 表单初值也用同一个，避免两处写空对象而慢慢漂移）
  return db.getSetting<CastSetting>(K.cast(cardId), EMPTY_CAST_SETTING)
}

export async function saveCastSetting(cardId: string, cs: CastSetting): Promise<void> {
  await db.setSetting(K.cast(cardId), cs)
}

// ==================== 剧情模式 · 推演报告 ====================
// 报告归属 `tavernReports` 表（方案 §3.4 四处登记，P1 随表落地）。
// 在表就绪之前，本组函数会抛错——调用方（报告页）需据此显示空态。

export async function listReports(): Promise<TavernReportIndexItem[]> {
  const rows = await db.listProjectReports(db.getCurrentProjectId())
  return rows
    .map(r => ({
      id: r.id,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      anchorChapterLabel: r.anchorChapterLabel,
      counts: {
        矛盾: r.findings.filter(f => f.level === '矛盾').length,
        漏洞: r.findings.filter(f => f.level === '漏洞').length,
        存疑: r.findings.filter(f => f.level === '存疑').length,
      },
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getReport(id: string): Promise<TavernReport | null> {
  return (await db.getReport(id)) ?? null
}

export async function saveReport(r: TavernReport): Promise<void> {
  await db.saveReport(r)
}

export async function deleteReport(id: string): Promise<void> {
  await db.deleteReport(id)
}

// ==================== 自由模式 · 角色卡（全局） ====================

export async function listFreeChars(): Promise<TavernCharIndexItem[]> {
  const list = await db.getMeta<TavernCharIndexItem[]>(G.charIndex, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getFreeChar(id: string): Promise<FreeCharacter | null> {
  return db.getMeta<FreeCharacter | null>(G.freeChar(id), null)
}

// 默认值定义已上移到 ./types（与 EMPTY_CAST_SETTING 同理：纯默认值属类型层）。
// 这里 re-export 保持既有调用点（store.emptyFreeCharacter()）不变。
export { emptyFreeCharacter } from './types'

export async function createFreeChar(init: Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>): Promise<FreeCharacter> {
  const c: FreeCharacter = { ...init, id: uid(), createdAt: now(), updatedAt: now() }
  return saveFreeChar(c)
}

/**
 * 卡文本落库前的**写入侧规范化**（2026-09-19）：
 * 把「小项名: 内容」里的**半角冒号**归成全角；认不出标签的行一律不动。
 *
 * 🔴 为什么钉在这里 —— 这是角色卡的**唯一存储关口**：
 *    起草 / 小说角色转换（`createFreeChar`）/ 对话引导 / 设定更新，四条 AI 链路最后
 *    都落到 `saveFreeChar`。逐条去加＝四处里漏一处就前功尽弃；钉在这里一劳永逸。
 *    作者手打的全角文本是 no-op（幂等），界面上零感知；半角散文本（「他说: 我不去」）
 *    因标签不匹配也原样保留 —— 规范化的边界只在**认得出的标签**上。
 */
function normalizeCardMarkup(c: FreeCharacter): FreeCharacter {
  const fix = (path: string, v: string): string => {
    if (!v) return v
    const spec = structSpecOf(path)
    return spec ? normalizeStructMarkup(v, spec) : v
  }
  return {
    ...c,
    profile: {
      ...c.profile,
      externals: fix('profile.externals', c.profile?.externals ?? ''),
      core: fix('profile.core', c.profile?.core ?? ''),
      speech: fix('profile.speech', c.profile?.speech ?? ''),
      relations: fix('profile.relations', c.profile?.relations ?? ''),
      cannot: fix('profile.cannot', c.profile?.cannot ?? ''),
      knowledge: fix('profile.knowledge', c.profile?.knowledge ?? ''),
    },
    conduct: {
      ...c.conduct,
      perspective: fix('conduct.perspective', c.conduct?.perspective ?? ''),
      bottomLine: fix('conduct.bottomLine', c.conduct?.bottomLine ?? ''),
      paceLock: fix('conduct.paceLock', c.conduct?.paceLock ?? ''),
      rating: fix('conduct.rating', c.conduct?.rating ?? ''),
    },
  }
}

/** 保存角色卡（索引与分条成对写） */
export async function saveFreeChar(c: FreeCharacter): Promise<FreeCharacter> {
  const next: FreeCharacter = { ...normalizeCardMarkup(c), updatedAt: now() }
  await db.setMeta(G.freeChar(next.id), next)
  const idx = await db.getMeta<TavernCharIndexItem[]>(G.charIndex, [])
  const item: TavernCharIndexItem = {
    id: next.id,
    name: next.name,
    storyId: cardStoryId(next),
    avatar: next.avatar,
    updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.charIndex, idx)
  return next
}

// ---------------- 角色卡的「故事归属」 ----------------
// 老大 2026-09-16 定：角色卡必须挂在一个故事下（故事决定世界观）；
// 删故事不解绑不删卡 → 卡退成「自由状态」（storyId 为空），落在列表的「未归属」分组里等着被重新归类。

/** 某个故事下的全部角色卡 */
export async function listCharsByStory(storyId: string): Promise<TavernCharIndexItem[]> {
  const list = await listFreeChars()
  return list.filter(c => cardStoryId(c) === storyId)
}

/** 未归属（自由状态）的角色卡 —— 通常是故事被删之后留下的 */
export async function listUnboundChars(): Promise<TavernCharIndexItem[]> {
  const list = await listFreeChars()
  return list.filter(c => !cardStoryId(c))
}

/**
 * 改挂 / 解除某个故事下的全部角色卡（用于「删故事」）。
 *
 * 🔴 **只改归属，绝不删卡** —— 卡连着记忆与日记，删了就是不可逆丢数据。
 *    传入空串 = 解除归属（退回自由状态）。返回受影响张数。
 */
export async function rebindCharsStory(fromStoryId: string, toStoryId: string): Promise<number> {
  if (!fromStoryId) return 0
  const targets = await listCharsByStory(fromStoryId)
  for (const c of targets) {
    const full = await getFreeChar(c.id)
    if (full) await saveFreeChar({ ...full, storyId: toStoryId })
  }
  return targets.length
}

/**
 * 采纳若干条「设定更新」（2026-09-14）。返回实际改动的条数。
 *
 * 🔴 必须**按角色分组、在同一份卡上连续应用**：同一角色若有多条改动（例：关系 + 内核），
 *    逐条「读一次卡 → 写一次卡」的话，后一条会基于**旧的**卡去写 —— 前一条被静默覆盖。
 *    这类丢改动极难察觉（改动确实"成功"了，只是少了）。
 */
export async function applyCardRevisions(
  items: { charId: string; field: CardFieldPath; after: string }[],
): Promise<number> {
  const byChar = new Map<string, { field: CardFieldPath; after: string }[]>()
  for (const it of items) {
    const arr = byChar.get(it.charId) ?? []
    arr.push({ field: it.field, after: it.after })
    byChar.set(it.charId, arr)
  }
  let n = 0
  for (const [charId, list] of byChar) {
    const card = await getFreeChar(charId)
    if (!card) continue
    let next = card
    for (const it of list) next = writeCardField(next, it.field, it.after)
    await saveFreeChar(next)
    n += list.length
  }
  return n
}

/**
 * 删除角色卡：级联清掉它的记忆 / 日常 / 待发留言（这些都以 charId 为键），
 * 并把该角色从各会话的 charIds 里摘掉；会话因此变空则一并删除（避免出现无参演角色的空会话）。
 */
export async function deleteFreeChar(id: string): Promise<void> {
  const idx = await db.getMeta<TavernCharIndexItem[]>(G.charIndex, [])
  await db.setMeta(G.charIndex, idx.filter(x => x.id !== id))
  await db.setMeta(G.freeChar(id), null)
  await db.setMeta(G.memory(id), null)
  await db.setMeta(G.daily(id), null)
  await db.setMeta(G.greeting(id), null)
  await db.setMeta(G.journal(id), null)

  const sessions = await listFreeSessions()
  for (const s of sessions) {
    if (!s.charIds.includes(id)) continue
    const full = await getFreeSession(s.id)
    if (!full) { await deleteFreeSession(s.id); continue }
    const rest = full.charIds.filter(x => x !== id)
    if (rest.length === 0) await deleteFreeSession(s.id)
    else await saveFreeSession({ ...full, charIds: rest })
  }
}

// ==================== 自由模式 · 会话（全局） ====================

export async function listFreeSessions(): Promise<FreeSessionIndexItem[]> {
  const list = await db.getMeta<FreeSessionIndexItem[]>(G.freeSessionIndex, [])
  return [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export async function getFreeSession(id: string): Promise<FreeSession | null> {
  return db.getMeta<FreeSession | null>(G.freeSession(id), null)
}

export async function saveFreeSession(s: FreeSession): Promise<FreeSession> {
  const next: FreeSession = { ...s, updatedAt: now() }
  await db.setMeta(G.freeSession(next.id), next)
  const idx = await db.getMeta<FreeSessionIndexItem[]>(G.freeSessionIndex, [])
  const item: FreeSessionIndexItem = {
    id: next.id, title: next.title, charIds: next.charIds,
    storyId: next.storyId,
    lastActiveAt: next.lastActiveAt, updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.freeSessionIndex, idx)
  return next
}

/**
 * 由「新建会话弹窗里**最终选中**的角色」推出参演 ids 与默认标题。
 *
 * 🔴 标题必须**只**由最终选中的角色得出。曾经写成「单角色时用左栏当前选中的角色名」，
 * 于是「先全选、再取消一个」时，会话名挂的是被取消掉的那个角色（已修）。
 * 抽成纯函数是为了让这条规则能被单测钉住 —— 放在组件里就只能靠肉眼。
 */
export function planFreeSessionCast(
  pickedIds: string[],
  fallbackId: string,
  resolveName: (id: string) => string | undefined,
): { charIds: string[]; title: string } {
  // 🔴 截断用 `MAX_AI_CAST`（单一真源），**不再写死 3** —— 原先这里与界面各自写一个 3，
  //    改了界面上限而忘了这里 → 选了 5 个只存 3 个，界面还显示 5 个（静默丢角色）。
  const ids = (pickedIds.length ? pickedIds : [fallbackId].filter(Boolean)).slice(0, MAX_AI_CAST)
  if (ids.length === 0) return { charIds: [], title: '新对话' }
  const names = ids.map(id => (resolveName(id) || '').trim() || '?')
  const title = names.length > 1 ? `与${names.join('、')}的对话` : `和${names[0]}的对话`
  return { charIds: ids, title }
}

export async function createFreeSession(
  charIds: string[],
  title: string,
  model: FreeSession['model'],
  params: FreeSession['params'],
  /** 用户扮演的角色 id（可选）：不传 = 用户演他自己 */
  userCharId?: string,
  /** 归属故事 id（可选）：新建对话时必须先选故事，左栏据此树状分组 */
  storyId?: string,
): Promise<FreeSession> {
  const s: FreeSession = {
    id: uid(), charIds, userCharId: userCharId || undefined, title, messages: [], model, params,
    storyId: storyId || undefined,
    lastActiveAt: now(), createdAt: now(), updatedAt: now(),
  }
  return saveFreeSession(s)
}

export async function deleteFreeSession(id: string): Promise<void> {
  const idx = await db.getMeta<FreeSessionIndexItem[]>(G.freeSessionIndex, [])
  await db.setMeta(G.freeSessionIndex, idx.filter(x => x.id !== id))
  await db.setMeta(G.freeSession(id), null)
}

// ==================== 自由模式 · 记忆 / 日常 / 留言（均按 charId） ====================

export function emptyMemory(charId: string): FreeMemory {
  return {
    charId,
    longTerm: '', facts: '', relation: '', mines: '', anniversaries: '', diaries: '',
    updatedAt: now(),
  }
}

export async function getMemory(charId: string): Promise<FreeMemory> {
  return db.getMeta<FreeMemory>(G.memory(charId), emptyMemory(charId))
}

export async function saveMemory(m: FreeMemory): Promise<void> {
  await db.setMeta(G.memory(m.charId), { ...m, updatedAt: now() })
}

export function emptyDaily(charId: string): DailyState {
  return { charId, lastActiveAt: now(), log: [] }
}

export async function getDaily(charId: string): Promise<DailyState> {
  return db.getMeta<DailyState>(G.daily(charId), emptyDaily(charId))
}

export async function saveDaily(d: DailyState): Promise<void> {
  await db.setMeta(G.daily(d.charId), d)
}

/**
 * 日记（给作者回顾用的场记，**不进 AI 上下文**）
 *
 * 每场对话结束追加一条；超出 JOURNAL_KEEP 就丢最老的。
 * 为什么上限这么小：日记是给人读的摘要，第五十场之前的再留着也没人翻，
 * 而且它跟六栏记忆不一样 —— 那份每年都在重写，这本只会越来越长。
 */
export async function getJournal(charId: string): Promise<CharJournal> {
  return db.getMeta<CharJournal>(G.journal(charId), { charId, entries: [], updatedAt: 0 })
}

export async function appendJournalEntry(
  charId: string,
  entry: CharJournalEntry,
  keep = JOURNAL_KEEP,
): Promise<CharJournal> {
  const cur = await getJournal(charId)
  // 🔴 同一场对话只留一条（审计 P0-5）。
  //    收尾可能因为某位角色整理失败而被作者重跑；旧实现每次都新 `uid()` 追加，
  //    结果同一场沉淀出两条几乎一样的日记。按 sessionId 覆盖掉旧的更符合"一本日记"的直觉。
  const rest = entry.sessionId
    ? cur.entries.filter(e => e.sessionId !== entry.sessionId)
    : cur.entries
  const next: CharJournal = {
    charId,
    entries: [entry, ...rest].slice(0, keep),
    updatedAt: now(),
  }
  await db.setMeta(G.journal(charId), next)
  return next
}

export async function dropJournalEntry(charId: string, entryId: string): Promise<CharJournal> {
  const cur = await getJournal(charId)
  const next: CharJournal = { ...cur, entries: cur.entries.filter(e => e.id !== entryId), updatedAt: now() }
  await db.setMeta(G.journal(charId), next)
  return next
}

/** 清空某位角色的日记（角色卡页的「清空日记」用） */
export async function clearJournal(charId: string): Promise<void> {
  await db.setMeta(G.journal(charId), { charId, entries: [], updatedAt: now() })
}

export async function setGreeting(charId: string, text: string): Promise<void> {
  await db.setMeta(G.greeting(charId), text)
}

/** 取出待投递的主动留言并清除（展示一次即消费掉） */
export async function takeGreeting(charId: string): Promise<string | null> {
  const g = await db.getMeta<string | null>(G.greeting(charId), null)
  if (g) await db.setMeta(G.greeting(charId), null)
  return g
}

export async function hasGreeting(charId: string): Promise<boolean> {
  return !!(await db.getMeta<string | null>(G.greeting(charId), null))
}

// ==================== 自检（方案 §11.8） ====================
// 「索引里有、分条缺失」= 幽灵条目（列表能看见、点开是空的）→ 可清理。
// 反向（分条在、索引缺）只是占点存储，危害小，v1 只报告不清理。

export async function auditSessions(): Promise<{ ghosts: TavernSessionIndexItem[] }> {
  const idx = await listSessions()
  const ghosts: TavernSessionIndexItem[] = []
  for (const it of idx) if (!(await getSession(it.id))) ghosts.push(it)
  return { ghosts }
}

export async function auditFreeChars(): Promise<{ ghosts: TavernCharIndexItem[] }> {
  const idx = await listFreeChars()
  const ghosts: TavernCharIndexItem[] = []
  for (const it of idx) if (!(await getFreeChar(it.id))) ghosts.push(it)
  return { ghosts }
}

export async function auditFreeSessions(): Promise<{ ghosts: FreeSessionIndexItem[] }> {
  const idx = await listFreeSessions()
  const ghosts: FreeSessionIndexItem[] = []
  for (const it of idx) if (!(await getFreeSession(it.id))) ghosts.push(it)
  return { ghosts }
}

/**
 * 清掉幽灵会话索引项，返回清理条数。
 *
 * 传 `onlyIds` 则只清这些 id（安全路径 `pruneGhostsSafely` 走这条），不传 = 清掉本次 audit 出的全部。
 * 🔴 直接调本函数**没有安全前置** —— 界面入口一律走 `pruneGhostsSafely`，理由见那边的注释。
 */
export async function pruneGhostSessions(onlyIds?: readonly string[]): Promise<number> {
  const { ghosts } = await auditSessions()
  const targets = onlyIds ? ghosts.filter(g => onlyIds.includes(g.id)) : ghosts
  if (targets.length === 0) return 0
  const idx = await listSessions()
  await db.setSetting(K.sessionIndex, idx.filter(it => !targets.some(g => g.id === it.id)))
  return targets.length
}

export async function pruneGhostFreeChars(onlyIds?: readonly string[]): Promise<number> {
  const { ghosts } = await auditFreeChars()
  const targets = onlyIds ? ghosts.filter(g => onlyIds.includes(g.id)) : ghosts
  if (targets.length === 0) return 0
  const idx = await listFreeChars()
  await db.setMeta(G.charIndex, idx.filter(it => !targets.some(g => g.id === it.id)))
  return targets.length
}

export async function pruneGhostFreeSessions(onlyIds?: readonly string[]): Promise<number> {
  const { ghosts } = await auditFreeSessions()
  const targets = onlyIds ? ghosts.filter(g => onlyIds.includes(g.id)) : ghosts
  if (targets.length === 0) return 0
  const idx = await listFreeSessions()
  await db.setMeta(G.freeSessionIndex, idx.filter(it => !targets.some(g => g.id === it.id)))
  return targets.length
}

// ==================== 幽灵索引清理 · 安全前置（2026-09-20） ====================
//
// 上面那三个 `pruneGhost*` 是**裸清理**：检出即删、不问、不备份。数据体检的「清理」入口
// **不能**直接用它们 —— 幽灵的判据是「索引项在、分条**读不到**」，而「读不到」不等于「不存在」。
// 下面这层把「哪几种读不到的情况必须挡住」收在一处，界面只管调 `pruneGhostsSafely`。

/** 酒馆三类索引的标识（数据体检的清理入口按组调用） */
export type TavernGhostGroup = 'sessions' | 'freeChars' | 'freeSessions'

/** 幽灵索引备份的 meta 键前缀；值 = 被删掉的索引项数组（整条存，便于事后恢复） */
export const GHOST_BACKUP_PREFIX = 'tavern.ghostBackup.'

/** 复判的间隔：给存储层一点喘息，瞬时读失败多半熬不过这一下 */
const GHOST_RECHECK_DELAY_MS = 200

export interface PruneGhostReport {
  group: TavernGhostGroup
  /** 实际清掉的条数（被前置闸挡下时为 0） */
  pruned: number
  /** 被前置闸挡下的原因（人类可读，可直接给作者看）；为空 = 没被挡 */
  blocked?: string
  /** 备份落地的 meta 键；没有需要备份的项时为空 */
  backupKey?: string
}

interface GhostOps {
  /** 当前判定为幽灵的 id 列表 */
  audit: () => Promise<string[]>
  /** 取出指定 id 的索引项整条（备份用；三类索引项类型不同，故是 unknown[]） */
  snapshot: (ids: readonly string[]) => Promise<unknown[]>
  /** 按 ids 从索引里剔除 */
  prune: (onlyIds: readonly string[]) => Promise<number>
}

function ghostOpsOf(group: TavernGhostGroup): GhostOps {
  if (group === 'sessions') {
    return {
      audit: async () => (await auditSessions()).ghosts.map(g => g.id),
      snapshot: async ids => (await listSessions()).filter(it => ids.includes(it.id)),
      prune: pruneGhostSessions,
    }
  }
  if (group === 'freeChars') {
    return {
      audit: async () => (await auditFreeChars()).ghosts.map(g => g.id),
      snapshot: async ids => (await listFreeChars()).filter(it => ids.includes(it.id)),
      prune: pruneGhostFreeChars,
    }
  }
  return {
    audit: async () => (await auditFreeSessions()).ghosts.map(g => g.id),
    snapshot: async ids => (await listFreeSessions()).filter(it => ids.includes(it.id)),
    prune: pruneGhostFreeSessions,
  }
}

/**
 * 前置闸 ①：**写盘锁期间一律拒绝**。
 *
 * 桌面版数据文件读不出来时（`getDesktopState().writeLocked`，见 db/core.ts 的读失败三态），
 * **所有**分条都读不到 —— 此时清理会把「其实还在、只是读不出来」的索引整片删掉且不可逆。
 * 同构的先例：`enableDesktopCloudSync` 在 writeLocked 时也直接拒绝（那边是怕把空数据推上云端）。
 * 非桌面平台恒不锁，直接放行。
 */
export function ghostPruneBlockedReason(): string {
  if (!DESKTOP) return ''
  const st = getDesktopState()
  if (st.writeLocked) {
    return st.writeLockReason || '本地数据文件当前不可读，已阻止清理（此时读不到的内容可能只是暂时读不出来）'
  }
  // 🔴 云同步闩锁期（云端不可用）**同样要拒绝**：此时 `getSession` 等读到的是「开启同步那一刻
  //    冻结的本地库」，而分条其实在云端 ⇒ 一律读成 null ⇒ 被判成幽灵、索引被删掉 ⇒
  //    云端恢复后那场会话成孤儿（列表里永久消失）。属「读失败的默认值被当成事实」。
  if (isDesktopCloudUnavailable()) {
    return '云同步暂时不可用，已阻止清理（此时读不到的内容可能只是云端暂时读不出来）'
  }
  return ''
}

/**
 * **带安全前置**的幽灵索引清理 —— 数据体检的「清理」入口只走这里。
 *
 * 四道前置（界面侧还有第 ④ 条）：
 *   ① 写盘锁期间拒绝（见 `ghostPruneBlockedReason`）；
 *   ② **二次复判**：隔一小段时间各检一次，只清「两次都判定为幽灵」的 id —— 瞬时读失败会被这层滤掉；
 *      两次不一致时**不删**并如实回报，让作者先查存储状态而不是让工具赌一把；
 *   ③ **先备份**：把待删的索引项整条写进 `tavern.ghostBackup.<ts>`。值得备份是因为分条**有可能回来**
 *      （云盘同步会把「云端有、本地没有」的那条当另一端新增拉下来，这正是「删了会复活」的另一面），
 *      那时恢复索引才有意义；顺带也是一份「我清过什么」的审计痕迹；
 *   ④ 界面弹确认框明示影响（本函数不管界面）。
 *
 * 注意本函数**不碰分条**：幽灵的分条本来就不存在，清理只动索引项。
 */
export async function pruneGhostsSafely(group: TavernGhostGroup): Promise<PruneGhostReport> {
  const blocked = ghostPruneBlockedReason()
  if (blocked) return { group, pruned: 0, blocked }

  const ops = ghostOpsOf(group)
  const first = await ops.audit()
  if (first.length === 0) return { group, pruned: 0 }

  // ② 复判：隔一拍再检，取交集
  await new Promise(r => setTimeout(r, GHOST_RECHECK_DELAY_MS))
  const second = await ops.audit()
  const confirmed = first.filter(id => second.includes(id))
  if (confirmed.length === 0) {
    return { group, pruned: 0, blocked: '复判时这些条目又能读到了（多半是瞬时读取失败），已放弃清理；请稍后重新体检' }
  }

  // ③ 备份待删的索引项
  const snapshot = await ops.snapshot(confirmed)
  let backupKey: string | undefined
  if (snapshot.length > 0) {
    backupKey = GHOST_BACKUP_PREFIX + Date.now()
    await db.setMeta(backupKey, snapshot)
  }

  const pruned = await ops.prune(confirmed)
  return { group, pruned, ...(backupKey ? { backupKey } : {}) }
}

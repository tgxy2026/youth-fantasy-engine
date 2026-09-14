/**
 * 酒馆模式 · 剧本（自由对话专用）
 *
 * 【解决什么】
 * 角色卡只回答了「这个人是谁」；一场戏还需要「此刻在哪、为什么在这儿、这一场想干嘛」。
 * 于是把原来「新建对话」弹窗里那几格手填的「对话内容」**抽出来单独成一份**，
 * 起名、可复用、可跨会话引用 —— 就是剧本。
 *
 * 【六栏（老大 2026-09-14 定）】
 *   ① 名称（不进上下文，只用于列表）  ② 情境  ③ 开场白  ④ 你的位置  ⑤ 这一场的目标  ⑥ 不要发生
 *
 * 与成熟产品同构：SillyTavern 的 `scenario` + `first_mes`，另加「目标 / 边界」两栏。
 * 调研结论是「目标」与「边界」值得单独成栏 —— 一场戏得有意图与禁区，否则模型只会描述气氛、
 * 戏不往前走（详见 docs/剧本与变量-设计方案-讨论稿.md §1）。
 *
 * 【数据归属】
 * 🔴 **全局（`db.getMeta`，跨项目）** —— 与角色卡同性质：是「玩法模板」，不绑某一本书。
 *    换项目照样可用。
 *
 * 【为什么会话里存快照而不是只存 id】
 * 剧本是可编辑的。只存引用的话，作者改一次剧本，**所有引用它的历史会话都会被悄悄改写**——
 * 「上周那场戏的设定今天自己变了」是最难查的一类问题。所以加载时把六栏快照进会话
 * （`FreeSession.script`），`scriptId` 只作溯源用。
 *
 * 【为什么开场白不进 system】
 * 它是对话的**第一条消息**（`openingToMessage`），走消息通道。塞进 system 会让模型以为
 * 「用户已经说过这句了」而重复回应，也会白占每轮的常驻额度。
 */
import * as db from '../db'
import { uid } from '../id'
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parsePlainObject, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { resolveTavernProvider, type ChatFn } from './engine'
import type { TavernScript, TavernScriptIndexItem, ScriptSnapshot } from './types'

// 全局 meta 键（无项目前缀）
const G = {
  index: 'tavern.scriptIndex',
  one: (id: string) => `tavern.script.${id}`,
} as const

/**
 * 「六栏」这个形状本身（不含 id 与时间戳）。
 * 编辑表单、AI 起草结果都用它 —— 表单不认识 `TavernScript` 的时间戳，也不必认识。
 */
export type ScriptDraftFields = Pick<
  TavernScript, 'name' | 'situation' | 'opening' | 'playerRole' | 'goal' | 'taboo'
>

/** 六栏的字数上限（名字那一栏用 30） */
export const SCRIPT_FIELD_MAX: Record<'situation' | 'opening' | 'playerRole' | 'goal' | 'taboo', number> = {
  situation: 600, opening: 400, playerRole: 300, goal: 200, taboo: 200,
}

/** 注入时的总上限（字符）。超了截断并注明，绝不悄悄吞掉 */
export const SCRIPT_MAX_CHARS = 1400

export function emptyScript(): TavernScript {
  return { ...EMPTY_SCRIPT_FIELDS, id: '', draftedAt: 0, createdAt: 0, updatedAt: 0 }
}

/** 六栏全空（表单的初始值 / 「这份是不是空的」判定） */
export const EMPTY_SCRIPT_FIELDS: ScriptDraftFields = {
  name: '', situation: '', opening: '', playerRole: '', goal: '', taboo: '',
}

/** 名称缺省时给个占位（列表里空名字最难找） */
export function scriptDisplayName(s: Pick<TavernScript, 'name'>): string {
  return s.name.trim() || '（未命名剧本）'
}

// ==================== 读写（全局） ====================

export async function listScripts(): Promise<TavernScriptIndexItem[]> {
  const list = await db.getMeta<TavernScriptIndexItem[]>(G.index, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getScript(id: string): Promise<TavernScript | null> {
  return db.getMeta<TavernScript | null>(G.one(id), null)
}

export async function saveScript(s: TavernScript): Promise<TavernScript> {
  const now = Date.now()
  const next: TavernScript = {
    ...s,
    id: s.id || uid(),
    createdAt: s.createdAt || now,
    updatedAt: now,
  }
  await db.setMeta(G.one(next.id), next)
  const idx = await db.getMeta<TavernScriptIndexItem[]>(G.index, [])
  const item: TavernScriptIndexItem = {
    id: next.id,
    name: scriptDisplayName(next),
    goalBrief: firstLine(next.goal, 40),
    updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.index, idx)
  return next
}

export async function createScript(init: Partial<TavernScript> = {}): Promise<TavernScript> {
  return saveScript({ ...emptyScript(), ...init })
}

/** 删除剧本。**不动任何已有会话** —— 会话里存的是快照，删了剧本那一场照样能跑 */
export async function deleteScript(id: string): Promise<void> {
  const idx = await db.getMeta<TavernScriptIndexItem[]>(G.index, [])
  await db.setMeta(G.index, idx.filter(x => x.id !== id))
  await db.setMeta(G.one(id), null)
}

// ==================== 快照与渲染 ====================

/** 取一份快照（会话里存它，此后与剧本本身脱钩） */
export function snapshotOf(s: TavernScript): ScriptSnapshot {
  return {
    scriptId: s.id,
    name: scriptDisplayName(s),
    situation: s.situation.trim(),
    opening: s.opening.trim(),
    playerRole: s.playerRole.trim(),
    goal: s.goal.trim(),
    taboo: s.taboo.trim(),
    at: Date.now(),
  }
}

export function isEmptySnapshot(s: ScriptSnapshot | null | undefined): boolean {
  if (!s) return true
  return !s.situation && !s.opening && !s.playerRole && !s.goal && !s.taboo
}

/**
 * 渲染成注入用的一段（进 system 的「这一场」层）。
 * **不含名称与开场白**：名称是给人看的，开场白走消息通道（见文件头）。
 */
export function scriptToText(s: ScriptSnapshot | null | undefined): string {
  if (!s || isEmptySnapshot(s)) return ''
  const parts: string[] = []
  if (s.situation) parts.push(`情境：${s.situation}`)
  if (s.playerRole) parts.push(`你在这一场里的位置：${s.playerRole}`)
  if (s.goal) parts.push(`这一场的目标：${s.goal}`)
  if (s.taboo) parts.push(`不要发生：${s.taboo}`)
  let text = parts.join('\n')
  if (text.length > SCRIPT_MAX_CHARS) {
    text = text.slice(0, SCRIPT_MAX_CHARS) + '\n（剧本较长，此处已截断 —— 建议在「剧本编辑」页精简）'
  }
  return text
}

/**
 * 开场白 → 对话的第一条**消息**。
 * 走的是消息通道，所以用协议的输出规范（对白纯文本 / （）动作 / 【】环境），
 * 并明确标注「这是你说过的第一句」，免得模型把它当成用户说的话去回应。
 */
export function openingToMessage(s: ScriptSnapshot | null | undefined): string {
  if (!s?.opening) return ''
  return s.opening
}

/** 状态栏那一行「场景」的兜底文案：没有手填 scene 时用剧本的名字与情境首句 */
export function scriptSceneLine(s: ScriptSnapshot | null | undefined): string {
  if (!s || isEmptySnapshot(s)) return ''
  return [s.name, firstLine(s.situation, 40)].filter(Boolean).join(' · ')
}

/** 取首行（列表与摘要用），超长截断 */
export function firstLine(text: string, max = 50): string {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  const head = t.split(/[。！？\n]/)[0] || t
  return head.length > max ? head.slice(0, max) + '…' : head
}

// ==================== AI 起草 ====================

export function buildScriptDraftSystem(): string {
  return [
    '你在为一段角色扮演对话写一份**简单剧本**（一场戏的设定）。作者会给一句粗略的想法，你把它补成六栏。',
    '',
    '〖六栏各写什么〗',
    '- situation（情境）：**此刻**在哪、两个人为什么在这儿、刚发生了什么。只管「此刻」，不要写身世与历史 ——',
    '  背景归角色卡与背景设定，重复写会互相打架。两三句，越具体越好（时间、地点、正在做的事）。',
    '- opening（开场白）：对面那个人说的**第一句话**。必须遵守下面的输出格式，',
    '  一到三句即可 —— 它是整场戏的语气锚点，模型会照着它的篇幅与调子往下写，所以别写成一大段旁白。',
    '- playerRole（你在这一场里的位置）：作者在这一场演谁、与对面什么关系、此刻想做什么。一句话。',
    '- goal（这一场的目标）：**一个**主要目标。要有戏、可推进（"让 Ta 松口说出那件事"），',
    '  不要写"好好聊天"这种没有方向的。',
    '- taboo（不要发生）：这一场不该出现什么。写 2–4 条具体的禁区',
    '  （如"不要提分手""不要让 Ta 离开这个房间""不要引入新角色"），不要写空话。',
    '- name：给这场戏起个 4–10 字的短名（如"雨夜便利店"）。',
    '',
    '〖输出格式（开场白必须严格遵守）〗',
    '- 对白：纯文本，**不带说话人名字**，也不要把名字单独写成一行；',
    '- 动作 / 神态 / 心理：用（）包住；',
    '- 客观环境与人物外在：用【】包住。',
    '指代对面那个人时用「Ta」或直接称呼，别用「他/她」。',
    '',
    '〖不许做的事〗',
    '不要替作者定重大设定（身世、结局、秘密的答案）；不要写剧本以外的解释性文字。',
    '',
    '〖输出格式〗只输出一个 JSON 对象，不要代码块、不要围栏、不要任何解释：',
    '{"name":"…","situation":"…","opening":"…","playerRole":"…","goal":"…","taboo":"…"}',
  ].join('\n')
}

export type ScriptDraftArgs = {
  /** 作者的粗略想法（必填 —— 没有它就等于让模型凭空编） */
  seed: string
  /** 可选：这一场用到的角色名（让情境与目标贴着具体的人写） */
  charNames?: string[]
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
}

/**
 * 跑一次起草，产出六栏骨架（**不落库**；调用方过一遍再保存）。
 * 模型乱答时抛错，让调用方保留作者现有内容 —— 绝不写半截结果。
 */
export async function draftScript(args: ScriptDraftArgs): Promise<ScriptDraftFields> {
  const seed = String(args.seed ?? '').trim()
  if (!seed) throw new Error('请先写一句粗略的想法（这场戏大概是什么样）')

  const { provider } = await resolveTavernProvider(args.providerId ? { providerId: args.providerId } : undefined)
  const runChat = args.chatFn ?? chat

  const fence = newAuthorFence()
  const names = (args.charNames ?? []).map(n => n.trim()).filter(Boolean)
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildScriptDraftSystem() },
    {
      role: 'user',
      content: [
        names.length ? `〖这一场用到的角色〗\n${names.join('、')}\n` : '',
        '〖作者的想法〗',
        authorBlock(fence, seed),
        '',
        '请按格式输出 JSON。',
      ].filter(Boolean).join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: args.signal,
    json: true,
    think: false,
  })

  const parsed = parseScriptDraft(reply)
  if (!parsed) throw new Error('模型没有返回可用的剧本（没按 JSON 格式输出）')
  return parsed
}

/** 解析起草结果（导出便于单测）。形状不对就返回 null，绝不猜 */
export function parseScriptDraft(raw: string): ScriptDraftFields | null {
  const o = parsePlainObject(raw)
  if (!o) return null
  const name = asText(o.name).trim().slice(0, 30)
  const situation = asText(o.situation).trim()
  const opening = asText(o.opening).trim()
  const playerRole = asText(o.playerRole).trim()
  const goal = asText(o.goal).trim()
  const taboo = asText(o.taboo).trim()
  // 六栏全空 = 没解出来
  if (!situation && !opening && !playerRole && !goal && !taboo) return null
  return { name, situation, opening, playerRole, goal, taboo }
}

/** 把 AI 起草的结果并进现有六栏：**AI 空着的栏不覆盖作者已写的**（起草只是补，不是重写） */
export function mergeScriptDraft(cur: ScriptDraftFields, out: ScriptDraftFields): ScriptDraftFields {
  const next: ScriptDraftFields = { ...cur }
  for (const k of Object.keys(EMPTY_SCRIPT_FIELDS) as (keyof ScriptDraftFields)[]) {
    const v = out[k]
    if (typeof v === 'string' && v.trim()) next[k] = v.trim()
  }
  return next
}

/** 六栏是不是全空（空剧本不该进上下文，也不该占列表） */
export function isEmptyScriptFields(f: ScriptDraftFields): boolean {
  return !Object.values(f).some(v => String(v ?? '').trim())
}

export { isCancelled }

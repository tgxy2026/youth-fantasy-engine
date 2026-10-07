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
import { chat, isCancelled, type ChatMessage } from '../ai'
import { parsePlainObject, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
// 🔴 从 provider 取、**别从 engine 取**：engine 反向 import 本文件，绕 engine 会形成循环依赖
import { resolveTavernProvider, type ChatFn } from './provider'
import { getTavernSettings, timeoutMsOf } from './settings'
import { prepareDraftMaterial, type DraftSource } from './draft'
import { webSearch, type SearchSettings } from '../webSearch'
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

/** 注入时的总上限（字符）。超了截断并注明，绝不悄悄吞掉。
 *  2026-09-15 由 1400 提到 2000：剧本是「这一场是什么」的骨架，值得多给一点。 */
export const SCRIPT_MAX_CHARS = 2000

export function emptyScript(): TavernScript {
  return { ...EMPTY_SCRIPT_FIELDS, id: '', storyId: '', draftedAt: 0, createdAt: 0, updatedAt: 0 }
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

/** 某个故事下的剧本（树状列表的叶子层）。按更新时间倒序，最近改的在最上面 */
export async function listScriptsByStory(storyId: string): Promise<TavernScriptIndexItem[]> {
  const list = await db.getMeta<TavernScriptIndexItem[]>(G.index, [])
  return list
    .filter(x => x.storyId === storyId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
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
    storyId: next.storyId,
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
 * 开场白 → 对话的第一条**消息**（内容原样，不加任何标注 —— 加了会破坏协议的渲染格式）。
 * 走的是消息通道，所以它自己就该按协议写：对白纯文本 / 其余一律全角括号（ ）。
 *
 * 🔴 它以 **`role: 'user'`** 落库（见 TavernFree 新建会话处），这是刻意的：
 *    开场白的作用是「把这一场的起点处境摆出来」，模型读到它就知道戏从哪儿接，
 *    于是顺着往下演；若标成 `assistant`，模型会以为自己刚说完这句话，转而应答自己。
 *    代价是界面上它显示在**你那一侧** —— 这一点在「故事剧本」页的开场白说明里已向作者交代。
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

function buildScriptDraftSystem(): string {
  return [
    '你在为一段角色扮演对话写一份**简单剧本**（一场戏的设定）。作者会给一句粗略的想法，你把它补成六栏。',
    '',
    '〖六栏各写什么〗',
    '- situation（情境）：**此刻**在哪、两个人为什么在这儿、刚发生了什么。只管「此刻」，不要写身世与历史 ——',
    '  背景归角色卡第 1 章与「故事」层（世界观写在故事里），重复写会互相打架。两三句，越具体越好。',
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
    '- 动作、神态、心理与客观环境：全部用全角括号（ ）包住、一件事一个括号。',
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
  /** 作者粘贴的参考素材（可空） */
  refs?: string
  /** 补完模式：现有六栏的摊平文本（可空） */
  existing?: string
  /** 检索设置（不传 = 不联网） */
  searchSettings?: SearchSettings
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  /** 测试用：替换检索实现 */
  searchFn?: typeof webSearch
}

/**
 * 跑一次起草，产出六栏骨架（**不落库**；调用方过一遍再保存）。
 * 模型乱答时抛错，让调用方保留作者现有内容 —— 绝不写半截结果。
 */
export async function draftScript(args: ScriptDraftArgs): Promise<{ fields: ScriptDraftFields; source: DraftSource }> {
  const seed = String(args.seed ?? '').trim()
  if (!seed && !args.refs?.trim() && !args.existing?.trim()) {
    throw new Error('请先写一句粗略的想法（这场戏大概是什么样）')
  }

  // 素材（含可选的联网检索结果）由 draft.ts 统一裁决，这里只管剧本自己的模板
  const material = await prepareDraftMaterial({
    idea: seed,
    refs: args.refs,
    existing: args.existing,
    settings: args.searchSettings ?? { mode: 'off', engine: 'bocha', endpoint: '', apiKey: '', topK: 5 },
    signal: args.signal,
    searchFn: args.searchFn,
  })

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
        material.blocks,
        '请按格式输出 JSON。',
      ].filter(Boolean).join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: timeoutMsOf(await getTavernSettings()),
    signal: args.signal,
    json: true,
    think: false,
  })

  const parsed = parseScriptDraft(reply)
  if (!parsed) throw new Error('模型没有返回可用的剧本（没按 JSON 格式输出）')
  return { fields: parsed, source: material.source }
}

/** 把现有六栏摊平给「补完」模式用（只给非空的栏，省 token 也更聚焦） */
export function flattenScriptFields(f: ScriptDraftFields): string {
  return ([
    ['名称', f.name], ['情境', f.situation], ['开场白', f.opening],
    ['你的位置', f.playerRole], ['这一场的目标', f.goal], ['不要发生', f.taboo],
  ] as [string, string][])
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `〖${k}〗${v.trim()}`)
    .join('\n')
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

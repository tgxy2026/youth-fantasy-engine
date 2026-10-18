/**
 * 角色卡**跨页签移动**（3.1.3）—— 主要角色 / 次要角色 / NPC 三张卡之间搬运。
 *
 * 【为什么需要一张语义映射表，而不是只按字段名对齐】
 * 三张卡的字段并不是同一套名字：
 *   · 「身份定位」（主要 / 次要）在 NPC 卡里叫「身份」；
 *   · 「功法/技能」（主要）在次要卡里叫「实力与功法」；
 *   · 「核心性格 / 说话风格 / 首次出场」在 NPC 卡里是「一句话性格 / 口癖·记忆点 / 关键出场」。
 * 纯按同名字段匹配会把这类**同一个人物信息**丢在源页签里 —— 而作者的本意恰恰是
 * 「这张卡降级了，能带走的都带走」。所以这里给同义字段编了语义 id。
 *
 * 🔴 只做**安全**的近似，不猜语义：
 *   · 「核心动机」「与主角的关系」（次要）在主要卡里没有对应 ⇒ 算丢失，进警告清单，
 *     绝不塞进「人际关系」这种看起来差不多、实则另一件事的字段里。
 *   · NPC 的「年龄/性别/外貌特征」是一个**合并栏**：拆词会猜错（"16岁/男，瘦削" 哪部分是外貌？），
 *     故降级时原文整段写进「年龄/性别」，升级时把两栏用「，」拼回合并栏。
 *
 * 【字段路径】
 * 存储键是 `模块名::字段名`，模块名三张卡各不相同（「一、基础信息」/「NPC档案」），
 * 所以映射结果必须用**目标页签自己的模块名**重建路径，不能搬源路径。
 */
import { TABS } from '@/lib/schema'
import type { CardRecord, TabDef } from '@/lib/types'

/** 可互相移动的页签（唯一真源）。顺序即弹窗里的推荐顺序：先升后降。 */
export const CHARACTER_CARD_TAB_IDS = ['char-main', 'char-secondary', 'char-npc'] as const

export function isCharacterCardTab(tabId: string): boolean {
  return (CHARACTER_CARD_TAB_IDS as readonly string[]).includes(tabId)
}

/** 除 `fromTabId` 之外的其余角色卡页签（按主 → 次 → NPC 顺序）。 */
export function characterCardTargets(fromTabId: string): TabDef[] {
  return TABS.filter(t => isCharacterCardTab(t.id) && t.id !== fromTabId)
}

/** 扁平字段：`path` 是存储键，`name` 是纯字段名（语义映射按它走）。 */
export interface FlatCardField {
  path: string
  module: string
  name: string
}

export function flattenCardFields(tab: TabDef): FlatCardField[] {
  const out: FlatCardField[] = []
  for (const m of tab.modules ?? []) {
    for (const f of m.fields) out.push({ path: `${m.name}::${f.name}`, module: m.name, name: f.name })
  }
  return out
}

/** NPC 卡里的合并栏（年龄 / 性别 / 外貌写在同一格） */
const MERGED_FIELD = '年龄/性别/外貌特征'
const SEM_MERGED = '__merged_age_gender_appearance__'
const SEM_AGE_GENDER = 'ageGender'
const SEM_APPEARANCE = 'appearance'
/** 拆不动的两栏拼回合并栏时的分隔符（与作者手写习惯一致：中文逗号） */
const MERGE_SEP = '，'

/**
 * 同义字段 → 语义 id。**没登记的字段，语义 id 就是字段名本身**（同名即同义）。
 * 🔴 新增近似映射前先问一句：这两个栏装在同一个坑里会不会误导作者？
 *    答案为"会"就不要加，让它进丢失清单、由作者自己看着办。
 */
const SEMANTIC_OF: Record<string, string> = {
  '身份': 'identity',
  '身份定位': 'identity',
  '功法/技能': 'cultivation',
  '实力与功法': 'cultivation',
  '一句话性格': 'corePersonality',
  '核心性格': 'corePersonality',
  '口癖/记忆点': 'speechStyle',
  '说话风格': 'speechStyle',
  '关键出场': 'firstAppear',
  '首次出场': 'firstAppear',
  '功能定位': 'plotFunction',
  '剧情功能': 'plotFunction',
  [MERGED_FIELD]: SEM_MERGED,
  '年龄/性别': SEM_AGE_GENDER,
  '外貌特征': SEM_APPEARANCE,
}

export function semanticOfField(name: string): string {
  return SEMANTIC_OF[name] ?? name
}

export interface CardMoveCarry {
  /** 源字段名（展示用，不带模块前缀） */
  from: string
  /** 目标字段名 */
  to: string
}

export interface CardMoveLost {
  field: string
  value: string
}

export interface CardMovePlan {
  fromTabId: string
  toTabId: string
  /** 移动后要写进目标页签的 `data`（已按目标模块名重建路径） */
  data: Record<string, string>
  /** 带过去的字段（源 → 目标） */
  carried: CardMoveCarry[]
  /** 源里有内容、目标页签没有对应栏位 ⇒ 会直接消失 */
  lost: CardMoveLost[]
  /** 目标页签有、但这次搬不过去的字段（移动后为空白） */
  blank: string[]
  /** 需要额外告知作者的处理方式（合并栏 / 超集栏） */
  notes: string[]
  fromFieldCount: number
  toFieldCount: number
  /** 目标页签字段**不少于**源页签 ⇒ 视为「往信息更多的页签移动」 */
  richer: boolean
  /** 源卡已填写的项数 */
  filledCount: number
}

/**
 * 预演一次移动：算出能带走什么、会丢什么、目标哪些栏会空着。
 *
 * 🔴 纯函数、不碰库 —— 弹窗里的预览和真正落库前都必须调它，两边不能各算一套
 *    （否则作者看到的"会丢 3 项"与实际丢的项对不上）。
 */
export function planCardMove(from: TabDef, to: TabDef, rec: CardRecord): CardMovePlan {
  const srcFields = flattenCardFields(from)
  const dstFields = flattenCardFields(to)

  const byName = new Map<string, FlatCardField>()
  const bySemantic = new Map<string, FlatCardField>()
  for (const f of dstFields) {
    if (!byName.has(f.name)) byName.set(f.name, f)
    const sem = semanticOfField(f.name)
    // 合并栏不注册进语义表：它同时"代表"两栏，走下面显式的拼接分支
    if (sem !== SEM_MERGED && !bySemantic.has(sem)) bySemantic.set(sem, f)
  }
  const mergedTarget = byName.get(MERGED_FIELD)

  /** 目标 path → 值片段（合并栏可能吃到两个源字段） */
  const buckets = new Map<string, string[]>()
  const carried: CardMoveCarry[] = []
  const steps = new Set<string>()
  const lost: CardMoveLost[] = []
  const notes: string[] = []
  let filledCount = 0

  const push = (dst: FlatCardField, value: string, fromName: string) => {
    const arr = buckets.get(dst.path)
    if (arr) arr.push(value)
    else buckets.set(dst.path, [value])
    const sig = `${fromName}->${dst.path}`
    if (!steps.has(sig)) {
      steps.add(sig)
      carried.push({ from: fromName, to: dst.name })
    }
  }

  for (const sf of srcFields) {
    const value = (rec.data[sf.path] ?? '').trim()
    if (value) filledCount++
    const sem = semanticOfField(sf.name)

    // ① 源是 NPC 合并栏 → 目标拆成两栏：拆不了，整段进「年龄/性别」
    if (sem === SEM_MERGED) {
      if (!value) continue
      const ageField = bySemantic.get(SEM_AGE_GENDER)
      if (ageField) {
        push(ageField, value, sf.name)
        notes.push(
          `「${sf.name}」在「${to.name}」被拆成「年龄/性别」与「外貌特征」两栏 —— ` +
          `拆词会猜错，原文整段写进「年龄/性别」，「外貌特征」留空。`,
        )
      } else {
        lost.push({ field: sf.name, value })
      }
      continue
    }

    // ② 目标只有合并栏 → 「年龄/性别」与「外貌特征」拼回一格
    if (mergedTarget && (sem === SEM_AGE_GENDER || sem === SEM_APPEARANCE)) {
      if (value) push(mergedTarget, value, sf.name)
      continue
    }

    // ③ 常规：先按语义、再按同名
    const target = bySemantic.get(sem) ?? byName.get(sf.name)
    if (!target) {
      if (value) lost.push({ field: sf.name, value })
      continue
    }
    if (value) push(target, value, sf.name)
  }

  const data: Record<string, string> = {}
  for (const [path, arr] of buckets) data[path] = arr.join(MERGE_SEP)

  const blank = dstFields.filter(f => !buckets.has(f.path)).map(f => f.name)

  return {
    fromTabId: from.id,
    toTabId: to.id,
    data,
    carried,
    lost,
    blank,
    notes,
    fromFieldCount: srcFields.length,
    toFieldCount: dstFields.length,
    richer: dstFields.length >= srcFields.length,
    filledCount,
  }
}

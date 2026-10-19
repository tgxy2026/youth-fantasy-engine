/**
 * 3.2.0 · WT0-3：**原业务槽位目录**（语义适配层的词表）
 *
 * 这一层的职责只有一个：把「旧引擎/抽取器认识的那些语义键」列清楚 ——
 * `name` / `alias` / `identity` / `realm` / `trait` … —— 并指明每个语义键
 * 在**既有自定义结构**里对应哪些字段名候选。
 *
 * 🔴 不另造一套映射表：目录**直接从 `KIND_MAP` 派生**（`lib/flow/fieldMap.ts`，
 *    抽取 prompt、commit 落点、落点存在性断言三者共用的真源）。手工再抄一份 =
 *    将来 `KIND_MAP` 加了新槽位，这里静默不知道，AI 抽到的事实被当「无对应字段」丢掉。
 * 🔴 候选数组是「**按序取第一个存在的**」语义（`resolveFieldPath` 的口径），
 *    不是「全部都要有」；主要卡/次要卡/NPC 卡字段名不同就是靠它兜的。
 * 🔴 这里只有**语义键**，没有存储键。存储键由 `EffectiveTemplate.fields[].sourceKey`
 *    提供 —— 展示改名与存储键分离，是「改名仍填对字段」的前提。
 */
import { KIND_MAP } from '@/lib/flow/fieldMap'
import type { SettingEntityType } from '@/lib/ai/aiTasks'

/**
 * 一个语义槽位的声明。
 *
 * `read`：
 *   · `first`  —— 多个来源命中时取候选顺序里第一个有值的（旧引擎口径）；
 *   · `concat` —— 全部来源按顺序拼接（同一用途被拆成多栏时的兜底）。
 * `write`：
 *   · `single` —— 唯一目标才自动写；
 *   · `manual` —— 一律只产候选、由作者指定（语义上「多字段合成一个用途」的槽位）。
 */
export interface SemanticSlotDef {
  slot: string
  label: string
  targets: string[]
  read: 'first' | 'concat'
  write: 'single' | 'manual'
}

/** 记录级槽位（所有实体都有，来源是 `KIND_MAP` 的 nameField/aliasField/...） */
const RECORD_SLOTS = ['name', 'alias', 'desc', 'firstAppear'] as const

/**
 * 槽位默认写策略一律 `single`（唯一绑定才自动写）。
 *
 * 🔴 不要按「候选列表里有几个名字」来判「多字段合成用途」——
 *    `KIND_MAP` 的候选数组是**同一含义在不同卡上的叫法**（主要卡叫「身份定位」，
 *    NPC 卡叫「身份」），解析后只会落到**一个**字段，写它并不危险。
 *    真正的「多字段合成用途」只可能来自**作者显式声明**把一个槽位绑到多个字段，
 *    那种情况由 `mappingPlan.isAutoWritable` + `resolveSemanticWrite` 判为 `needs-manual-target`。
 */
const MANUAL_WRITE_SLOTS = new Set<string>([])

/** 槽位的中文说明（给作者与 AI 看，不进存储） */
const SLOT_LABELS: Record<string, string> = {
  name: '名称',
  alias: '别称',
  desc: '一句话描述',
  firstAppear: '首次出场',
  identity: '身份定位',
  age: '年龄/性别',
  appearance: '外貌特征',
  traits: '性格特征',
  innerStruggle: '内在矛盾/动机',
  realm: '实力境界',
  skills: '功法/技能',
  special: '特殊能力',
  gear: '装备法宝',
  background: '出身背景',
  faction: '所属势力',
  location: '地理位置',
  relations: '人际关系',
  category: '类别',
  parent: '上级/归属',
  power: '实力等级',
  geo: '地理描述',
  danger: '危险/威胁等级',
  ability: '能力特性',
  weakness: '弱点',
  grade: '品级',
  origin: '来源/出处',
  effect: '能力/效果',
  cost: '限制与代价',
  role: '剧情作用',
  leader: '掌权者',
  economy: '经济来源',
  relationToMain: '与主角关系',
  note: '命名备注',
}

/**
 * 取某类实体的槽位目录（**每次按 `KIND_MAP` 现算**，不缓存副本）。
 *
 * 未知类别 ⇒ 空目录（调用方据此判「没有语义映射可用」，而不是拿一份通用猜测去乱写）。
 */
export function slotsForKind(kind: string): SemanticSlotDef[] {
  const map = (KIND_MAP as Record<string, import('@/lib/flow/fieldMap').KindMap | undefined>)[kind]
  if (!map) return []
  const out: SemanticSlotDef[] = []
  const push = (slot: string, targets: (string | undefined)[]) => {
    const t = targets.filter((x): x is string => !!x && x.trim().length > 0)
    if (!t.length) return
    out.push({
      slot,
      label: SLOT_LABELS[slot] ?? slot,
      targets: t,
      read: 'first',
      write: MANUAL_WRITE_SLOTS.has(slot) ? 'manual' : 'single',
    })
  }
  push('name', [map.nameField])
  push('alias', [map.aliasField])
  push('desc', map.descFields ?? [])
  push('firstAppear', map.firstFields ?? [])
  for (const s of map.slots ?? []) push(s.from, s.to)
  return out
}

/** 判断某个槽位是否属于记录级（读取时先于扩展槽位） */
export function isRecordSlot(slot: string): boolean {
  return (RECORD_SLOTS as readonly string[]).includes(slot)
}

/** 全部已知槽位 ID（诊断/自检用；不含项目自建映射） */
export function knownSlotIds(): string[] {
  const set = new Set<string>()
  for (const kind of Object.keys(KIND_MAP)) for (const d of slotsForKind(kind)) set.add(d.slot)
  return [...set].sort()
}

export type { SettingEntityType }

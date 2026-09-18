/**
 * 声明式字段映射表 —— 「抽取结果 → 目标设定表」的**唯一真理源**。
 *
 * 为什么要有它：抽取侧（prompt 输出哪些键）与写入侧（值写进哪一列）必须严格对齐，
 * 而对齐不能靠"记得同步改两处"。这里一张表同时是：
 *   · 抽取 prompt 的字段清单依据
 *   · commit 的落点依据
 *   · 断言「落点真实存在」的测试依据（见 tests/flowFieldMap.test.ts）
 *
 * 🔴 两条硬规矩：
 *   1. 落点**不写死** `模块::字段`——三张角色卡结构不同（主要/次要卡是四个模块、NPC 卡只有一个
 *      「NPC档案」模块，字段名也不一样）。故这里只声明**语义字段名**，由 `resolveSlot()`
 *      去 schema 里查出真实存储键（表格=列名；卡片=`模块::字段`）。schema 微调字段归属模块时，
 *      只要字段名没变，映射自动跟着走。
 *   2. 每个目标页签的落点都用「候选数组 + 取第一个存在者」表达，让主要卡 / 次要卡 / NPC 卡
 *      能共用同一条声明（如「身份定位」在 NPC 卡上叫「身份」）。
 *
 * 本表当前覆盖 `aiExtractSettingEntities` 现有的 6 类实体（B1 阶段）。
 * B2 接入「两遍全字段抽取」时，在此**新增** relation / worldFact / powerFact 三类与更多 `slots`，
 * commit 侧无需改动（它按本表驱动）。
 */
import { TABS } from '../schema'
import type { SettingEntityType } from '../aiTasks'

/** 一个源字段 → 目标字段的落点声明 */
export interface SlotMap {
  /** 抽取 JSON 里的键（如 'identity' / 'realm'） */
  from: string
  /** 候选目标字段名，按顺序取第一个在目标表里存在的 */
  to: string[]
}

export interface KindMap {
  /** 界面分类标签（如「人物」「地理」） */
  label: string
  /** 写入通道：表格型走 saveTableRow，卡片型走 saveCardRecord */
  write: 'table' | 'card'
  /** 目标页签（卡片型是默认卡；实际去向见 tabByTier） */
  tabId: string
  /** 卡片型专用：人物 tier → 页签 */
  tabByTier?: Record<string, string>
  /** 主名落到的字段名（表格='名称'；卡片='姓名'） */
  nameField: string
  /** 别称落到的字段名。目标表没有别称字段时留空 —— 此时别称并入描述，不硬塞 */
  aliasField?: string
  /** 「一句话描述」的落点候选字段名（按序取第一个存在的） */
  descFields?: string[]
  /** 「首次出场 / 首现章」的落点候选字段名 */
  firstFields?: string[]
  /** 卡片型：新建时写入的人物状态值 */
  statusValue?: string
  /** 表格型：是否参与自动编号（凡有「编号」列的表都要） */
  autoCode?: boolean
  /**
   * 扩展字段映射。B1 的现成抽取只产出 name/desc/evidence，用不到；
   * B2 的全字段抽取（身份定位 / 外貌 / 境界 …）按此落库，commit 不必改。
   */
  slots?: SlotMap[]
}

/**
 * 六类实体 → 目标表。口径与 `settingLedger.TABLE_TARGET` 保持一致
 * （两边都指向同一张表，否则「补登」与「拆书」会把同一实体写进不同地方）。
 */
export const KIND_MAP: Record<SettingEntityType, KindMap> = {
  人物: {
    label: '人物',
    write: 'card',
    tabId: 'char-secondary',
    tabByTier: { 主要: 'char-main', 次要: 'char-secondary', NPC: 'char-npc' },
    nameField: '姓名',
    aliasField: '别称',
    descFields: ['身份定位', '身份'],
    firstFields: ['首次出场', '关键出场'],
    statusValue: '已登场',
    slots: [
      { from: 'identity', to: ['身份定位', '身份'] },
      // 「年龄/性别」是角色卡自己的列（B2 实测发现原来没有对应 slot → 永远抽不到）
      { from: 'age', to: ['年龄/性别', '年龄'] },
      { from: 'appearance', to: ['外貌特征', '年龄/性别/外貌特征'] },
      { from: 'firstAppear', to: ['首次出场', '关键出场'] },
      { from: 'traits', to: ['核心性格', '一句话性格'] },
      { from: 'innerStruggle', to: ['核心矛盾/内在挣扎', '核心动机', '一句话性格'] },
      { from: 'realm', to: ['实力境界'] },
      { from: 'skills', to: ['功法/技能', '实力与功法'] },
      { from: 'special', to: ['金手指/特殊能力'] },
      { from: 'gear', to: ['装备法宝'] },
      { from: 'background', to: ['出身背景', '关键过往经历'] },
      { from: 'faction', to: ['所属势力'] },
      { from: 'location', to: ['地理位置'] },
      { from: 'relations', to: ['人际关系', '与主角的关系'] },
    ],
  },
  势力: {
    label: '势力',
    write: 'table',
    tabId: 'nations',
    nameField: '名称',
    aliasField: '别称',
    descFields: ['备注'],
    autoCode: true,
    slots: [
      { from: 'category', to: ['类别'] },
      { from: 'parent', to: ['上级'] },
      { from: 'location', to: ['地理位置'] },
      { from: 'power', to: ['实力等级'] },
      { from: 'leader', to: ['掌权者'] },
      { from: 'economy', to: ['经济来源'] },
      { from: 'relationToMain', to: ['与主角关系'] },
      { from: 'role', to: ['剧情作用'] },
    ],
  },
  地点: {
    label: '地理',
    write: 'table',
    tabId: 'geography',
    nameField: '名称',
    aliasField: '别称',
    descFields: ['备注'],
    autoCode: true,
    slots: [
      { from: 'category', to: ['类别'] },
      { from: 'parent', to: ['层级归属'] },
      { from: 'geo', to: ['地理位置'] },
      { from: 'danger', to: ['危险等级'] },
      { from: 'role', to: ['剧情作用'] },
    ],
  },
  种族: {
    label: '种族',
    write: 'table',
    tabId: 'races',
    nameField: '名称',
    aliasField: '别称',
    descFields: ['备注'],
    autoCode: true,
    slots: [
      { from: 'category', to: ['类别'] },
      { from: 'parent', to: ['上级'] },
      { from: 'danger', to: ['威胁等级'] },
      { from: 'ability', to: ['能力特性'] },
      { from: 'weakness', to: ['弱点'] },
    ],
  },
  物品: {
    label: '物品',
    write: 'table',
    tabId: 'items',
    nameField: '名称',
    aliasField: '别称',
    descFields: ['备注'],
    autoCode: true,
    slots: [
      { from: 'category', to: ['类别'] },
      { from: 'parent', to: ['上级'] },
      { from: 'grade', to: ['品级'] },
      { from: 'origin', to: ['来源/出处'] },
      { from: 'effect', to: ['能力/效果'] },
      { from: 'cost', to: ['限制与代价'] },
      { from: 'role', to: ['剧情作用'] },
    ],
  },
  术语: {
    label: '术语',
    write: 'table',
    tabId: 'terms',
    nameField: '名称',
    // ⚠️ terms 表**没有「别称」列** —— 别称无处可写，故留空（commit 会把它并进描述，不硬塞）
    descFields: ['定义（一句话）'],
    firstFields: ['首次出现章节'],
    autoCode: true,
    slots: [
      { from: 'category', to: ['类别'] },
      { from: 'parent', to: ['上级'] },
      { from: 'note', to: ['命名备注'] },
    ],
  },
}

/**
 * 在某个页签里查「该字段名对应的真实存储键」。
 * - 卡片/表单型：返回 `模块::字段`（扫模块找到含该字段的那个）
 * - 表格型：列名即键，返回列名
 * - 不存在：返回 null（**调用方必须处理 null，不得硬写一个不存在的键** —— 那会写出一列幽灵数据）
 */
export function resolveSlot(tabId: string, fieldName: string): string | null {
  const tab = TABS.find(t => t.id === tabId)
  if (!tab) return null
  if (tab.modules) {
    for (const m of tab.modules) {
      if (m.fields.some(f => f.name === fieldName)) return `${m.name}::${fieldName}`
    }
    return null
  }
  if (tab.columns?.some(c => c.name === fieldName)) return fieldName
  return null
}

/** 按候选顺序取第一个在目标表里存在的落点；都不存在则返回 null */
export function resolveFieldPath(tabId: string, candidates: string[]): { field: string; key: string } | null {
  for (const field of candidates) {
    const key = resolveSlot(tabId, field)
    if (key) return { field, key }
  }
  return null
}

/** 取某类实体实际要写哪个页签（卡片型按 tier 分流） */
export function targetTabOf(kind: SettingEntityType, tier?: string): string {
  const m = KIND_MAP[kind]
  if (m.tabByTier) return m.tabByTier[tier ?? ''] ?? m.tabId
  return m.tabId
}

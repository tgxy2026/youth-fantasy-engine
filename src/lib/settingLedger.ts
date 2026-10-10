// ============ 本章设定补登（确定性比对 + 写入） ============
//
// 写完一章后，把本章新出现的人/势力/地点/物品等与已有设定做比对，提醒作者补登。
//
// 设计原则（重要）：**AI 只负责从正文抽取候选实体，「是否已在设定里登记过」一律由本文件
// 做确定性比对**。原因：模型不知道作者的别称机制，也容易把已登记的说成没有（或反过来）；
// 而比对是纯字符串运算，结果可预期、可复现，且绝不会凭空编造条目。
// 抽取侧见 aiTasks.ts 的 aiExtractSettingEntities。

import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import { readAliases } from '@/lib/aliases'
import { nextAutoCode } from '@/lib/autoCode'
import { uid } from '@/lib/id'
import type { CardRecord, TableRow } from '@/lib/types'
import type { ExtractedEntity, SettingEntityType } from '@/lib/aiTasks'

export type { SettingEntityType }

/** 表格型实体 → 目标设定表 */
const TABLE_TARGET: Partial<Record<SettingEntityType, string>> = {
  势力: 'nations',
  地点: 'geography',
  种族: 'races',
  物品: 'items',
  术语: 'terms',
}

/** 一句话描述写进表格的哪一列（各表列名不同；terms 没有「备注」列，用「定义（一句话）」） */
const DESC_COL: Partial<Record<SettingEntityType, string>> = {
  势力: '备注',
  地点: '备注',
  种族: '备注',
  物品: '备注',
  术语: '定义（一句话）',
}

/** 参与「人物」比对与写入的角色卡页签（按重要度从高到低） */
export const CARD_TABS = ['char-main', 'char-secondary', 'char-npc'] as const

/** 人物 tier → 角色卡页签（AI 建议的归属，作者可在界面上改） */
const TIER_TAB: Record<string, string> = {
  主要: 'char-main',
  次要: 'char-secondary',
  NPC: 'char-npc',
}

/** 名称归一化：去标点/空白/统一大小写，用于判重（与 aiTasks.rowFingerprint 的 norm 同口径） */
export function normName(s: string): string {
  return (s ?? '')
    .replace(/[\s,.;:!?，。、；：！？·"'"''()（）[\]【】《》<>—\-_/\\|]/g, '')
    .toLowerCase()
}

/** 一组名字归一化并去重（丢弃空串）—— 用于「本名 + 别称」参与判重 */
function uniqNames(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    const k = normName(n)
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

export interface RegistryEntry {
  /** 正式名 */
  name: string
  /** 别称（角色卡的「别称」/ 设定表的「别称」列） */
  aliases: string[]
  tabId: string
  /** 表格行 id 或角色卡 id，供界面跳转核对 */
  id: string
}

export type EntityRegistry = Record<SettingEntityType, RegistryEntry[]>

/** 装载全项目已登记实体，供比对使用 */
export async function loadRegistry(): Promise<EntityRegistry> {
  const reg: EntityRegistry = { 人物: [], 势力: [], 地点: [], 种族: [], 物品: [], 术语: [] }

  // 人物：三张角色卡（姓名 + 别称）
  const cardLists = await Promise.all(CARD_TABS.map(t => db.getCardRecords(t)))
  cardLists.forEach((list, i) => {
    const tabId = CARD_TABS[i]
    for (const rec of list) {
      if (!rec.name?.trim()) continue
      reg.人物.push({ name: rec.name.trim(), aliases: readAliases(tabId, rec.data), tabId, id: rec.id })
    }
  })

  // 人物关系里出现过的名字也算已登记（与 continuityCheck「人名未登记」同口径）
  for (const r of await db.getTableRows('relations')) {
    for (const k of ['人物A', '人物B'] as const) {
      const n = (r.data[k] ?? '').trim()
      if (n) reg.人物.push({ name: n, aliases: [], tabId: 'relations', id: r.id })
    }
  }

  // 其余类型：各设定表（名称 + 别称）
  for (const [type, tabId] of Object.entries(TABLE_TARGET) as [SettingEntityType, string][]) {
    for (const r of await db.getTableRows(tabId)) {
      const name = (r.data['名称'] ?? '').trim()
      if (!name) continue
      reg[type].push({ name, aliases: readAliases(tabId, r.data), tabId, id: r.id })
    }
  }
  return reg
}

export type MatchStatus = 'registered' | 'duplicate' | 'new'

export interface LedgerItem extends ExtractedEntity {
  /** 列表 key */
  key: string
  status: MatchStatus
  /** 命中 / 疑似命中的已有条目 */
  matchedName?: string
  matchedTabId?: string
  matchedId?: string
  /** 仅人物：待写入的角色卡页签（作者可改） */
  targetTabId?: string
}

/**
 * 把 AI 抽出的候选与已登记条目比对，分三档：
 * - registered 已登记：正式名或别称完全一致
 * - duplicate  疑似重复：归一化后互相包含（如「云州城」vs「云州」），需作者确认
 * - new        待补登：完全没匹配上
 */
export function classify(entities: ExtractedEntity[], reg: EntityRegistry): LedgerItem[] {
  return entities.map((e, i) => {
    const key = `${e.type}::${e.name}::${i}`
    const target = normName(e.name)
    const base: LedgerItem = {
      ...e,
      key,
      status: 'new',
      ...(e.type === '人物' ? { targetTabId: TIER_TAB[e.tier ?? 'NPC'] ?? 'char-npc' } : {}),
    }
    if (!target) return base

    const pool = reg[e.type] ?? []
    // 🔴 抽出的实体自带别称时，别称也要参与比对（2026-09-18）：
    //    正文里同一实体常以简称出现，模型把「铁柱」放进 aliases、本名给「王铁柱」。
    //    只比 name 的话，正文用简称的那些章就全都判成"未登记"，白落一堆重复条目。
    const incoming = uniqNames([e.name, ...(e.aliases ?? [])])

    for (const entry of pool) {
      if ([entry.name, ...entry.aliases].some(n => incoming.includes(normName(n)))) {
        return { ...base, status: 'registered', matchedName: entry.name, matchedTabId: entry.tabId, matchedId: entry.id }
      }
    }
    for (const entry of pool) {
      for (const n of [entry.name, ...entry.aliases]) {
        const nn = normName(n)
        if (nn.length < 2) continue
        // 任一侧的任一名字互相包含即视为疑似重复（如「云州城」vs「云州」）
        if (incoming.some(x => x.length >= 2 && (nn.includes(x) || x.includes(nn)))) {
          return { ...base, status: 'duplicate', matchedName: entry.name, matchedTabId: entry.tabId, matchedId: entry.id }
        }
      }
    }
    return base
  })
}

/** 在角色卡页签里按优先顺序找出字段的 `模块::字段` 路径；找不到返回 null */
export function cardFieldPath(tabId: string, preferred: string[]): string | null {
  const tab = TABS.find(t => t.id === tabId)
  if (!tab?.modules) return null
  for (const p of preferred) {
    for (const m of tab.modules) {
      if (m.fields.some(f => f.name === p)) return `${m.name}::${p}`
    }
  }
  return null
}

export interface CommitResult {
  created: number
  failed: string[]
}

/**
 * 把勾选的「待补登」项写入对应设定表 / 角色卡。
 * 只填名称、一句话描述、首次出场章节，其余字段一律留空交给作者补——
 * 宁可少填，也不让模型替作者脑补设定。
 */
export async function commitEntities(items: LedgerItem[], chapterTitle: string): Promise<CommitResult> {
  const failed: string[] = []
  let created = 0

  for (const item of items) {
    try {
      if (item.type === '人物') {
        const tabId = item.targetTabId ?? 'char-npc'
        const existing = await db.getCardRecords(tabId)
        const data: Record<string, string> = {}
        const namePath = cardFieldPath(tabId, ['姓名'])
        const descPath = cardFieldPath(tabId, ['身份定位', '身份'])
        const firstPath = cardFieldPath(tabId, ['首次出场', '关键出场'])
        const statusPath = cardFieldPath(tabId, ['人物状态'])
        if (namePath) data[namePath] = item.name
        if (descPath && item.desc) data[descPath] = item.desc
        if (firstPath && chapterTitle) data[firstPath] = chapterTitle
        if (statusPath) data[statusPath] = '已登场'
        const rec: CardRecord = {
          id: uid(),
          projectId: db.getCurrentProjectId(),
          tabId,
          name: item.name,
          data,
          order: existing.length,
        }
        await db.saveCardRecord(rec)
      } else {
        const tabId = TABLE_TARGET[item.type]
        if (!tabId) { failed.push(item.name); continue }
        const rows = await db.getTableRows(tabId)
        const tab = TABS.find(t => t.id === tabId)
        const data: Record<string, string> = {}
        for (const col of tab?.columns ?? []) data[col.name] = ''
        data['名称'] = item.name
        const descCol = DESC_COL[item.type]
        if (descCol && item.desc) data[descCol] = item.desc
        if (item.type === '术语' && chapterTitle) data['首次出现章节'] = chapterTitle
        data['编号'] = nextAutoCode(tabId, rows)
        const row: TableRow = {
          id: uid(),
          projectId: db.getCurrentProjectId(),
          tabId,
          data,
          order: rows.length,
          createdAt: Date.now(),
        }
        await db.saveTableRow(row)
      }
      created++
    } catch {
      failed.push(item.name)
    }
  }
  return { created, failed }
}

/**
 * 灵感夹（2.5.1 · A3）
 *
 * 灵感启发页的轻量条目库：作者随手记下的一句话灵感，攒够了几条勾选融合成情节卡。
 *
 * ## 存储选型
 * 走 `db.getSetting/setSetting`（与取名的 nameFavorites 同款）：
 * 条目就是「一句话 + 时间」，不值得开独立 store；且它天然随项目走（换项目看到的是那本书的灵感夹）。
 *
 * ## 上限
 * 200 条 —— 灵感夹是「攒着用」的草稿区，不是资料库；堆积太多说明该转化或清掉了。
 * 超限时**拒绝新增并如实返回失败**（调用方提示），绝不静默丢最老的数据。
 */
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'

export interface InspirationItem {
  id: string
  /** 一句话灵感（作者手记，不做结构化） */
  text: string
  createdAt: number
}

const INSPIRATION_BOX_KEY = 'inspirationBox'
export const INSPIRATION_MAX = 200

export async function loadBox(): Promise<InspirationItem[]> {
  return (await db.getSetting<InspirationItem[]>(INSPIRATION_BOX_KEY, [])) ?? []
}

async function saveBox(items: InspirationItem[]): Promise<void> {
  await db.setSetting(INSPIRATION_BOX_KEY, items)
}

/** 新增一条灵感：trim、去重（与现有条目逐字相同的不重复收）、超上限拒绝。返回 { items, added } */
export async function addItem(text: string, prev?: InspirationItem[]): Promise<{ items: InspirationItem[]; added: boolean; reason?: string }> {
  const t = text.trim()
  if (!t) return { items: prev ?? [], added: false, reason: 'empty' }
  const items = prev ?? (await loadBox())
  if (items.some(i => i.text === t)) return { items, added: false, reason: 'dup' }
  if (items.length >= INSPIRATION_MAX) return { items, added: false, reason: 'full' }
  const next = [...items, { id: uid(), text: t, createdAt: Date.now() }]
  await saveBox(next)
  return { items: next, added: true }
}

/** 删除一条；返回删后的列表（未命中原样返回，不报错） */
export async function removeItem(id: string, prev?: InspirationItem[]): Promise<InspirationItem[]> {
  const items = prev ?? (await loadBox())
  const next = items.filter(i => i.id !== id)
  if (next.length === items.length) return items
  await saveBox(next)
  return next
}

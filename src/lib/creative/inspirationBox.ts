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
import { captureOwnedOperation, type OwnedOperation } from '@/lib/storage/ownedOperation'
import { withProjectSettingsLock } from '@/lib/storage/projectSettingsLock'

export interface InspirationItem {
  id: string
  /** 一句话灵感（作者手记，不做结构化） */
  text: string
  createdAt: number
  /** 可选章节引用；缺失或删除时保留失效标识，不复制正文。 */
  chapterId?: string
}

export const INSPIRATION_BOX_KEY = 'inspirationBox'
export const INSPIRATION_MAX = 200
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => withProjectSettingsLock(projectId, INSPIRATION_BOX_KEY, operation))
  queues.set(projectId, next)
  void next.then(() => { if (queues.get(projectId) === next) queues.delete(projectId) }, () => { if (queues.get(projectId) === next) queues.delete(projectId) })
  return next
}

async function readOwned(owner: OwnedOperation): Promise<InspirationItem[]> {
  const record = await owner.store.get<{ value?: unknown }>('settingsKV', `${owner.projectId}::${INSPIRATION_BOX_KEY}`)
  const items = record ? record.value : []
  if (!Array.isArray(items) || items.some(item => !item || typeof item.id !== 'string' || typeof item.text !== 'string')) throw new Error('灵感夹数据格式无效')
  return items
}

export async function loadBox(): Promise<InspirationItem[]> {
  return (await db.getSetting<InspirationItem[]>(INSPIRATION_BOX_KEY, [])) ?? []
}

/** 新增一条灵感：trim、去重（与现有条目逐字相同的不重复收）、超上限拒绝。返回 { items, added } */
export async function addItem(text: string, prev?: InspirationItem[], projectId = db.getCurrentProjectId(), chapterId?: string): Promise<{ items: InspirationItem[]; added: boolean; reason?: string }> {
  const t = text.trim()
  if (!t) return { items: prev ?? [], added: false, reason: 'empty' }
  const owner = captureOwnedOperation(projectId)
  owner.assertCurrent()
  return enqueue(projectId, async () => {
    const items = await readOwned(owner)
    if (chapterId) {
      const chapter = await owner.store.get<{ projectId: string }>('chapters', chapterId)
      if (!chapter || chapter.projectId !== projectId) throw new Error('关联章节已不存在或不属于本作品')
    }
    if (items.some(i => i.text === t)) return { items, added: false, reason: 'dup' }
    if (items.length >= INSPIRATION_MAX) return { items, added: false, reason: 'full' }
    const next = [...items, { id: uid(), text: t, createdAt: Date.now(), ...(chapterId ? { chapterId } : {}) }]
    await db.setSettingFor(projectId, INSPIRATION_BOX_KEY, next, owner)
    return { items: next, added: true }
  })
}

/** 修改一条灵感：要求提供读取时的旧文本作为版本条件；trim、去重、保留 id 与时间。 */
export async function updateItem(id: string, text: string, expectedText: string, projectId = db.getCurrentProjectId()): Promise<{ items: InspirationItem[]; updated: boolean; reason?: string }> {
  const t = text.trim()
  if (!t) return { items: [], updated: false, reason: 'empty' }
  const owner = captureOwnedOperation(projectId)
  owner.assertCurrent()
  return enqueue(projectId, async () => {
    const items = await readOwned(owner)
    const current = items.find(item => item.id === id)
    if (!current) return { items, updated: false, reason: 'missing' }
    if (current.text !== expectedText) return { items, updated: false, reason: 'conflict' }
    if (items.some(item => item.id !== id && item.text === t)) return { items, updated: false, reason: 'dup' }
    const next = items.map(item => item.id === id ? { ...item, text: t } : item)
    await db.setSettingFor(projectId, INSPIRATION_BOX_KEY, next, owner)
    return { items: next, updated: true }
  })
}

/** 删除一条；返回删后的列表（未命中原样返回，不报错） */
export async function removeItem(id: string, _prev?: InspirationItem[]): Promise<InspirationItem[]> {
  const projectId = db.getCurrentProjectId()
  const owner = captureOwnedOperation(projectId)
  owner.assertCurrent()
  return enqueue(projectId, async () => {
    const items = await readOwned(owner)
    const next = items.filter(i => i.id !== id)
    if (next.length !== items.length) await db.setSettingFor(projectId, INSPIRATION_BOX_KEY, next, owner)
    return next
  })
}

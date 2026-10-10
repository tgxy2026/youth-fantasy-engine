/**
 * 世界引擎 · 引入（3.0 · W4-1c）
 *
 * 把世界引擎里某个世界的**某个版本**搬进**当前项目**的世界表。
 *
 * 🔴 方案 §10.3 #8 的边界（这就是「跨作品引用」的全部含义）：
 *   · 引入 = **快照复制**，不是活链接 —— 源项目后来改了世界，引用方**不会**跟着变；
 *     要更新必须**再显式引入一次**。
 *   · 引入是**覆盖式**的：先清掉本项目该表现有内容再写入 ⇒ 幂等（重复引入同一版结果一致）。
 *     正因如此，界面必须先确认（「这会替换当前项目的 N 张表」）。
 *   · 引入后可**自由编辑**（拍板 D3=A）—— 编辑只影响本地副本，与世界引擎里那份无关。
 *
 * 【溯源】引入后在 `settingsKV` 记一条 `worldImport`（per 项目，`getSetting/setSetting` 自动加 pid 前缀）：
 *   界面据它在页头常显「引自 …（v3）」，作者永远知道这份世界从哪来。
 */
import * as db from '@/lib/db'
import { uid } from '@/lib/id'
import type { WorldPackTable } from '@/lib/worldTypes'

/** `settingsKV` 里的键名（与项目绑定） */
const KEY = 'worldImport'

export interface WorldImportRecord {
  worldId: string
  worldName: string
  /** 引入的是第几版；**0 = 引入草稿**（该世界尚未封存的当前内容） */
  version: number
  fingerprint: string
  at: number
  /** 本次写入了哪些页签（界面显示「引入了 N 张表」） */
  tabIds: string[]
}

/** 本项目的引入溯源（没引入过返回 null） */
export async function getWorldImportRecord(): Promise<WorldImportRecord | null> {
  const v = await db.getSetting<WorldImportRecord | null>(KEY, null)
  return v && typeof v === 'object' && typeof v.worldId === 'string' ? v : null
}

/** 清掉溯源（作者删了世界、或想重新开始） */
export async function clearWorldImportRecord(): Promise<void> {
  await db.setSetting(KEY, null)
}

/**
 * 把某世界的某版本引入当前项目。
 * @param version 0 / 省略 = 引入**草稿**；>0 = 引入对应的**不可变版本**
 * @returns 引入记录；世界不存在 / 版本不存在返回 `null`（不抛）
 */
export async function importWorldIntoCurrent(worldId: string, version = 0): Promise<WorldImportRecord | null> {
  const rec = await db.getWorld(worldId)
  if (!rec) return null
  const versions = rec.versions ?? []
  const ver = version > 0 ? versions.find(x => x.v === version) : undefined
  if (version > 0 && !ver) return null

  const tables: WorldPackTable[] = ver ? ver.tables : rec.tables
  const activeSubs = (ver ? ver.activeSubs : rec.activeSubs) ?? {}
  const fingerprint = ver ? ver.fingerprint : rec.fingerprint

  for (const t of tables) {
    // ---- 表单型（世界设定 / 力量体系母级）----
    if (t.kind === 'form') {
      for (const row of t.rows) await db.saveFormData(t.tabId, { ...row.data })
      continue
    }
    // ---- 表格型 ----
    if (t.kind === 'table') {
      for (const old of await db.getTableRows(t.tabId)) await db.deleteTableRow(old.id)
      for (let i = 0; i < t.rows.length; i++) {
        await db.saveTableRow({ id: uid(), projectId: '', tabId: t.tabId, data: { ...t.rows[i].data }, order: i })
      }
      continue
    }
    // ---- 卡片型（其他设定）----
    if (t.kind === 'card') {
      for (const old of await db.getCardRecords(t.tabId)) await db.deleteCardRecord(old.id)
      for (let i = 0; i < t.rows.length; i++) {
        await db.saveCardRecord({
          id: uid(), projectId: '', tabId: t.tabId,
          name: t.rows[i].name ?? '', data: { ...t.rows[i].data }, order: i,
        })
      }
      continue
    }
    // ---- 子项（世界设定 / 力量体系 / 制度四页签的「多套」结构）----
    for (const old of await db.getSubSets(t.tabId)) await db.deleteSubSet(t.tabId, old.id)
    const newIds: string[] = []
    for (let i = 0; i < t.rows.length; i++) {
      const id = uid()
      await db.saveSubSet(t.tabId, {
        id, projectId: '', tabId: '',
        name: t.rows[i].name ?? '', data: { ...t.rows[i].data }, order: i,
      })
      newIds.push(id)
    }
    /**
     * 活跃状态按**源行 id** 对上再映射到新 id。
     * 🔴 引入会给每条重新发 id（避免与本地既有记录撞主键），所以不能直接搬活跃 id ——
     *    那样 AI 侧会「整场不带任何子世界」而界面看起来一切正常（静默失忆）。
     */
    const wantOldIds = new Set(activeSubs[t.tabId] ?? [])
    for (let i = 0; i < t.rows.length; i++) {
      await db.setSubActive(t.tabId, newIds[i], wantOldIds.has(t.rows[i].id))
    }
  }

  const record: WorldImportRecord = {
    worldId,
    worldName: rec.name,
    version,
    fingerprint,
    at: Date.now(),
    tabIds: tables.map(t => t.tabId),
  }
  await db.setSetting(KEY, record)
  return record
}

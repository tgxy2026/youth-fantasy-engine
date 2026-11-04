/**
 * 章节收藏集（3.4.0 · D）
 *
 * 【只做一件事：让作者把任意章节聚合成命名集合，便于跨卷跳转和整理】
 *
 * 🔴 四条边界（与规划 §D「数据与兼容约束」同口径）：
 *   ① 收藏集**不复制正文、不改叙事顺序**：只存 chapterId 引用；
 *   ② 删集不删章：只是移除这组引用；
 *   ③ 读失败状态下**不允许写**：防止用空数据覆盖真实收藏；
 *   ④ 存储走 settingsKV (`db.getSettingFor` / `db.setSettingFor`)，
 *      随项目包导出、随备份同步 —— 但明确告知：删章后历史版本不恢复收藏关系。
 *
 * 纯函数（`validateSetName` / `createChapterSet` / `addToSet` / ...）不依赖 React / db，
 * 可直接单测。存储层封装（`loadSets` / `saveSets`）依赖 db，分开放在文件末尾。
 */
import { uid } from '@/lib/app/id'
import * as db from '@/lib/db'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { withProjectSettingsLock } from '@/lib/storage/projectSettingsLock'

// ============ 常量 ============

/** 收藏集名称最大字符数（汉字/英文按1个字符计，合理上限防无限膨胀） */
export const CHAPTER_SET_MAX_NAME_LEN = 20

/** 单项目内收藏集数量上限（防无限扩展） */
export const CHAPTER_SET_MAX_COUNT = 50

/** settingsKV 里的键名（不含项目 id 前缀，前缀由 db.getSettingFor 负责拼） */
export const SETS_SETTING_KEY = 'chapterSets'

// ============ 类型 ============

export interface ChapterSet {
  id: string            // uid()
  name: string          // 1-20 字，不空
  chapterIds: string[]  // 章节 id 列表，按作者添加顺序（不改叙事顺序）
  createdAt: number
  updatedAt: number
}

// ============ 纯函数 ============

/**
 * 校验收藏集名称。
 * - 不空（trim 后不空）
 * - 不超过 CHAPTER_SET_MAX_NAME_LEN 字
 */
export function validateSetName(name: string): { ok: true } | { ok: false; reason: string } {
  if (typeof name !== 'string') return { ok: false, reason: '名称必须是字符串' }
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, reason: '名称不能为空' }
  if (trimmed.length > CHAPTER_SET_MAX_NAME_LEN) return { ok: false, reason: `名称不能超过 ${CHAPTER_SET_MAX_NAME_LEN} 个字符` }
  return { ok: true }
}

/** 创建新收藏集（名称已由调用方校验） */
export function createChapterSet(name: string): ChapterSet {
  const now = Date.now()
  return { id: uid(), name: name.trim(), chapterIds: [], createdAt: now, updatedAt: now }
}

/**
 * 向收藏集添加成员。
 * 已存在时不重复添加（返回 `added: false`）。
 */
export function addToSet(set: ChapterSet, chapterId: string): { set: ChapterSet; added: boolean } {
  if (set.chapterIds.includes(chapterId)) return { set, added: false }
  return {
    set: { ...set, chapterIds: [...set.chapterIds, chapterId], updatedAt: Date.now() },
    added: true,
  }
}

/** 从收藏集移除成员（不存在时幂等） */
export function removeFromSet(set: ChapterSet, chapterId: string): ChapterSet {
  const next = set.chapterIds.filter(id => id !== chapterId)
  if (next.length === set.chapterIds.length) return set // 没有变化，不更新 updatedAt
  return { ...set, chapterIds: next, updatedAt: Date.now() }
}

/**
 * 重命名收藏集（内部做名称校验）。
 * 校验失败时返回 `{ ok: false, reason }` 且 set 不变。
 */
export function renameSet(
  set: ChapterSet,
  name: string,
): { set: ChapterSet; ok: boolean; reason?: string } {
  const v = validateSetName(name)
  if (!v.ok) return { set, ok: false, reason: v.reason }
  return { set: { ...set, name: name.trim(), updatedAt: Date.now() }, ok: true }
}

/**
 * 判断收藏集成员的有效性。
 * - `'active'`：章节仍在项目中
 * - `'missing'`：章节已被删除（成员变为失效，但不自动移除）
 */
export function setMemberStatus(
  _set: ChapterSet,
  chapterId: string,
  allChapterIds: Set<string>,
): 'active' | 'missing' {
  return allChapterIds.has(chapterId) ? 'active' : 'missing'
}

// ============ 存储层封装（依赖 db） ============

/**
 * 读取项目的收藏集列表。
 * 读失败或格式异常时抛错，由调用方阻止写入，不能把错误当作空集合。
 */
export async function loadSets(projectId: string): Promise<ChapterSet[]> {
  try {
    const raw = await db.getSettingFor<ChapterSet[]>(projectId, SETS_SETTING_KEY, [])
    if (!Array.isArray(raw) || raw.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.chapterIds) || item.chapterIds.some(id => typeof id !== 'string'))) {
      throw new Error('收藏集数据格式无效')
    }
    return raw
  } catch (e) {
    console.warn('[chapterSets] loadSets 失败', e)
    throw e
  }
}

/**
 * 保存项目的收藏集列表。
 * 写失败时返回 `{ ok: false, error }`（不抛）。
 */
export async function saveSets(
  projectId: string,
  sets: ChapterSet[],
  expected: ChapterSet[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const owner = captureOwnedOperation(projectId)
    owner.assertCurrent()
    await withProjectSettingsLock(projectId, SETS_SETTING_KEY, async () => {
      const latest = await db.getSettingFor<unknown>(projectId, SETS_SETTING_KEY, [], owner)
      if (!Array.isArray(latest) || JSON.stringify(latest) !== JSON.stringify(expected)) throw new Error('收藏集已在其他窗口更改，请重新打开后重试')
      await db.setSettingFor(projectId, SETS_SETTING_KEY, sets, owner)
    })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

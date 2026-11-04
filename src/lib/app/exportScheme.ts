/**
 * 具名导出方案（3.4.0 · E）
 *
 * 规划 §三.E：「支持保存具名导出方案须按项目隔离章节 ID；
 * 跨项目通用的排版偏好继续沿用现有作用域，失效章节须明确列出并由用户处理。
 * 清楚说明稿件导出不是完整备份。」
 *
 * 🔴 边界约束：
 *   ① 方案按项目隔离（存在 settingsKV，键为 exportSchemes），不跨项目串章；
 *   ② 只存选定的 chapterIds 和格式意图，绝不存正文内容；
 *   ③ 导入/重排/删章后，失效章节通过 resolveSchemeChapters 明确拆分，不静默假装成功；
 *   ④ chapterIds 为 null 表示「全选 / 全书导出」（回归默认行为）。
 */

import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { withProjectSettingsLock } from '@/lib/storage/projectSettingsLock'

export interface ExportScheme {
  id: string
  name: string
  format: 'platform' | 'markdown' | 'docx'
  /** 选定章节 id 列表；null 表示全书导出（默认） */
  chapterIds: string[] | null
  /** 选用的排版或格式配置摘要（可选） */
  layoutHint?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export const SCHEME_MAX_NAME_LEN = 20
export const SCHEME_MAX_COUNT = 20
export const SCHEME_SETTING_KEY = 'exportSchemes'

/** 方案名称校验 */
export function validateSchemeName(name: string): { ok: true } | { ok: false; reason: string } {
  const t = name.trim()
  if (!t) return { ok: false, reason: '方案名称不能为空' }
  if (t.length > SCHEME_MAX_NAME_LEN) return { ok: false, reason: `方案名称不能超过 ${SCHEME_MAX_NAME_LEN} 个字符` }
  return { ok: true }
}

/** 创建导出方案对象 */
export function createScheme(
  name: string,
  format: ExportScheme['format'],
  chapterIds: string[] | null,
  layoutHint?: Record<string, unknown>,
): ExportScheme {
  const now = Date.now()
  return {
    id: uid(),
    name: name.trim(),
    format,
    chapterIds: chapterIds ? [...chapterIds] : null,
    ...(layoutHint ? { layoutHint } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

/** 分辨方案中的有效章节与失效章节（按项目内现有章节 id 集合） */
export function resolveSchemeChapters(
  scheme: ExportScheme,
  allChapterIds: Set<string>,
): { valid: string[]; invalid: string[] } {
  if (scheme.chapterIds === null) {
    return { valid: Array.from(allChapterIds), invalid: [] }
  }
  const valid: string[] = []
  const invalid: string[] = []
  for (const id of scheme.chapterIds) {
    if (allChapterIds.has(id)) {
      valid.push(id)
    } else {
      invalid.push(id)
    }
  }
  return { valid, invalid }
}

/** 更新导出方案 */
export function updateScheme(
  scheme: ExportScheme,
  patch: Partial<Pick<ExportScheme, 'name' | 'chapterIds' | 'layoutHint'>>,
): ExportScheme {
  return {
    ...scheme,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.chapterIds !== undefined ? { chapterIds: patch.chapterIds ? [...patch.chapterIds] : null } : {}),
    ...(patch.layoutHint !== undefined ? { layoutHint: patch.layoutHint } : {}),
    updatedAt: Date.now(),
  }
}

/** 加载项目导出方案 */
export async function loadSchemes(projectId: string): Promise<ExportScheme[]> {
  if (!projectId) return []
  try {
    const raw = await db.getSettingFor<ExportScheme[]>(projectId, SCHEME_SETTING_KEY, [])
    if (!Array.isArray(raw) || raw.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || !['platform', 'markdown', 'docx'].includes(item.format) || (item.chapterIds !== null && (!Array.isArray(item.chapterIds) || item.chapterIds.some(id => typeof id !== 'string'))))) throw new Error('导出方案数据格式无效')
    return raw
  } catch (err) {
    console.warn('[exportScheme] 读取导出方案失败：', err)
    throw err
  }
}

/** 保存项目导出方案 */
export async function saveSchemes(projectId: string, schemes: ExportScheme[], expected: ExportScheme[]): Promise<{ ok: boolean; error?: string }> {
  if (!projectId) return { ok: false, error: '缺少项目 ID' }
  try {
    if (schemes.length > SCHEME_MAX_COUNT) throw new Error(`导出方案最多 ${SCHEME_MAX_COUNT} 个`)
    const owner = captureOwnedOperation(projectId)
    owner.assertCurrent()
    await withProjectSettingsLock(projectId, SCHEME_SETTING_KEY, async () => {
      const latest = await db.getSettingFor<unknown>(projectId, SCHEME_SETTING_KEY, [], owner)
      if (!Array.isArray(latest) || JSON.stringify(latest) !== JSON.stringify(expected)) throw new Error('导出方案已在其他窗口更改，请重新打开后重试')
      await db.setSettingFor(projectId, SCHEME_SETTING_KEY, schemes, owner)
    })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[exportScheme] 保存导出方案失败：', err)
    return { ok: false, error: msg }
  }
}

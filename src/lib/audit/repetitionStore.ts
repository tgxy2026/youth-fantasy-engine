/**
 * 3.3.3 · A1：重复报告的**本机缓存与忽略记录**。
 *
 * 🔴 全部放 `meta` 且登记为本机专属前缀（`sensitiveMeta.LOCAL_ONLY_META_KEY_PREFIXES`）：
 *    · 重复报告是**派生结果** —— 跟着项目包/云同步跑到另一台设备，只会留下一份
 *      "指向另一台机器章节指纹"的旧定位（§14.1 明确要求失效后不能让旧定位指向新章）。
 *    · 忽略记录是**本机阅读偏好**（"这段我看过了/这是引用"），作者在不同设备上可以不同。
 *
 * 🔴 缓存键含：项目、参与比对章节的正文指纹、范围、算法版本（见
 *    `repetition.inputFingerprint`）。改一个字 → 指纹变 → 旧缓存不再命中，界面提示重扫。
 *    缓存只存**有上限的摘要**（每组最多 50 处、最多 200 组），不复制全文。
 */
import { ops } from '@/lib/db/core'
import type { StoreOps } from '@/lib/storage/storeOps'
import { ignoreKeyOf, type RepetitionGroup, type RepetitionReport } from '@/lib/audit/repetition'

export const REPETITION_CACHE_PREFIX = 'auditRepetition::'
export const REPETITION_IGNORE_PREFIX = 'auditIgnore::'

const MAX_CACHED_GROUPS = 200

const cacheKeyOf = (pid: string) => `${REPETITION_CACHE_PREFIX}${pid}`
const ignoreKeyOfProject = (pid: string) => `${REPETITION_IGNORE_PREFIX}${pid}`

async function readValue<T>(key: string, store: StoreOps): Promise<T | null> {
  try {
    const rec = await store.get<{ key: string; value?: T }>('meta', key)
    return rec?.value ?? null
  } catch {
    return null
  }
}

async function writeValue(key: string, value: unknown, store: StoreOps): Promise<void> {
  await store.put('meta', { key, value })
}

/** 读缓存；没有/读失败都返回 null（调用方重算即可，不阻塞） */
export async function loadRepetitionCache(projectId: string, store: StoreOps = ops): Promise<RepetitionReport | null> {
  if (!projectId) return null
  const r = await readValue<RepetitionReport>(cacheKeyOf(projectId), store)
  return r && typeof r.inputFingerprint === 'string' ? r : null
}

/** 写缓存（只留摘要上限；不复制正文） */
export async function saveRepetitionCache(projectId: string, report: RepetitionReport, store: StoreOps = ops): Promise<void> {
  if (!projectId) return
  const trimmed: RepetitionReport = {
    ...report,
    groups: report.groups.slice(0, MAX_CACHED_GROUPS),
  }
  await writeValue(cacheKeyOf(projectId), trimmed, store).catch(() => { /* 缓存失败不影响本次展示 */ })
}

export async function clearRepetitionCache(projectId: string, store: StoreOps = ops): Promise<void> {
  await store.del('meta', cacheKeyOf(projectId)).catch(() => {})
}

export interface IgnoreRecord {
  /** `ignoreKeyOf(group)`：组 id + 标准化文本指纹 */
  key: string
  groupId: string
  kind: RepetitionGroup['kind']
  /** 忽略时的原文短引用（仅供作者回看"我忽略的是哪一段"） */
  text: string
  note?: string
  at: number
}

export async function loadIgnoreRecords(projectId: string, store: StoreOps = ops): Promise<IgnoreRecord[]> {
  const list = await readValue<IgnoreRecord[]>(ignoreKeyOfProject(projectId), store)
  return Array.isArray(list) ? list : []
}

/** 忽略一组重复（有作用域：组 id + 文本指纹；正文一变，旧忽略自动不再命中） */
export async function ignoreRepetitionGroup(
  projectId: string,
  group: RepetitionGroup,
  note?: string,
  store: StoreOps = ops,
): Promise<IgnoreRecord[]> {
  const list = await loadIgnoreRecords(projectId, store)
  const key = ignoreKeyOf(group)
  const next = list.filter(x => x.key !== key)
  next.push({
    key, groupId: group.id, kind: group.kind,
    text: group.text.slice(0, 60), ...(note ? { note } : {}), at: Date.now(),
  })
  await writeValue(ignoreKeyOfProject(projectId), next, store)
  return next
}

/** 撤销忽略 */
export async function unignoreRepetitionGroup(projectId: string, key: string, store: StoreOps = ops): Promise<IgnoreRecord[]> {
  const list = await loadIgnoreRecords(projectId, store)
  const next = list.filter(x => x.key !== key)
  await writeValue(ignoreKeyOfProject(projectId), next, store)
  return next
}

/** 给 `analyzeRepetition` 用：只传当前仍有效的忽略 key */
export function activeIgnoreKeys(records: IgnoreRecord[]): string[] {
  return records.map(r => r.key)
}
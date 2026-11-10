// ============ 投稿广场 · 本地草稿（3.5.0）============
//
// 【为什么草稿只在本地】投稿正文动辄几千字，放在服务端要多一次「同步中」状态与冲突处理；
// 而草稿本来就是「还没决定要公开」的东西，留在本机更符合预期。
//
// 🔴 按**账号 + 设备**隔离：键里带账号标识，换账号看不到别人（同一台共享电脑）的草稿。
//    `accountKey` 由调用方传入（网页用云端账号 id，游客用 'guest'）。
// 🔴 只保存「用户写下的字」，不保存任何身份信息；清空走 `clearDraft`。
// 🔴 localStorage 在隐私模式/配额满时可能抛错：一律降级为「不保存」，绝不阻塞输入。

import type { DisplayMode } from '@/lib/community/types'

export interface PostDraft {
  title: string
  body: string
  tags: string[]
  display: DisplayMode
  updatedAt: number
}

const PREFIX = 'yfe.community.draft:'

export function draftKey(accountKey: string): string {
  return `${PREFIX}${accountKey || 'guest'}`
}

export function loadDraft(accountKey: string): PostDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(accountKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PostDraft>
    if (!parsed || typeof parsed.body !== 'string') return null
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: parsed.body,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
      display: parsed.display === 'nickname' ? 'nickname' : 'anonymous',
      updatedAt: Number(parsed.updatedAt) || 0,
    }
  } catch {
    return null
  }
}

export function saveDraft(accountKey: string, draft: Omit<PostDraft, 'updatedAt'>): boolean {
  try {
    const value: PostDraft = { ...draft, updatedAt: Date.now() }
    localStorage.setItem(draftKey(accountKey), JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function clearDraft(accountKey: string): void {
  try { localStorage.removeItem(draftKey(accountKey)) } catch { /* 忽略 */ }
}

/**
 * 当前账号标识（供草稿键使用）。
 * @param accountId 桌面版传入 `getSyncAccountId()`；网页版可不传（服务端注入了账号 id）
 *
 * 🔴 **不要猜 localStorage 里的账号字段**：桌面端的云端账号是运行时从服务端解析的
 *    （`syncBoot.getSyncAccountId`），此前没有任何本地键保存它。
 *    猜一个不存在的键 ⇒ 换账号后仍落到同一个草稿桶，等于把 A 的草稿给 B 看。
 */
export function accountKeyOf(accountId?: string): string {
  if (typeof window === 'undefined') return 'guest'
  const w = window as unknown as { __YFE_USER__?: { id?: string }; __YFE_GUEST__?: boolean }
  if (w.__YFE_USER__?.id) return String(w.__YFE_USER__.id)
  if (accountId) return `cloud:${accountId}`
  if (w.__YFE_GUEST__) return 'guest'
  return 'local'
}
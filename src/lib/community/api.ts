// ============ 投稿广场 · 客户端接口（3.5.0）============
//
// 【通道】复用云同步那一条：网页 = 同源 Cookie（`cookieFetch`），
// 桌面 = 主进程代发的 Bearer（`configureCloudTransport` 已配置的 fetch）。
// 这样「应用内」和「网页版」访问的是同一个服务，不需要第二套鉴权。
//
// 🔴 桌面版未登录云端账号时没有可用基址：必须明确报 `NO_ENDPOINT`，
//    而不是静默打本机 localhost（那会 404，用户以为广场坏了）。
// 🔴 网络失败与业务失败分开：前者可重试，后者要展示服务端给的 code/文案。
// 🔴 所有写操作带 `clientToken` 的路径由调用方生成，保证重复点击/断网重试幂等。

import { cloudBase, cloudFetch, hasConfiguredCloudTransport } from '@/lib/cloud/syncApi'
import { WEB, WEB_GUEST } from '@/lib/app/platform'
import type {
  AdminOverview, AdminPostItem, AdminQueueComment, AdminQueuePost, AdminQueueReport,
  CommunityComment, CommunityPostDetail, CommunityPostSummary, CommunityProfile,
  CommunitySquareState, MyComment, MyPost, RankBoard, RankPeriod,
} from '@/lib/community/types'

// 网页标签页的账号在启动时固定；同浏览器其他标签页更换 Cookie 后，
// 服务端必须拒绝旧页面的请求，不能把旧页面操作归到新账号。
const pageAccount = WEB && typeof window !== 'undefined'
  ? ((window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id || (WEB_GUEST ? 'guest' : ''))
  : ''

export class CommunityError extends Error {
  code: string
  status: number
  retryAfter: number
  constructor(message: string, code = 'UNKNOWN', status = 0, retryAfter = 0) {
    super(message)
    this.name = 'CommunityError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

/** 桌面版没登录云端账号时，广场不可用（本地写作完全不受影响） */
export function communityEndpointReady(): boolean {
  if (WEB) return true
  return hasConfiguredCloudTransport()
}

async function request<T>(path: string, init: RequestInit & { body?: string } = {}): Promise<T> {
  if (!communityEndpointReady()) {
    throw new CommunityError('社区服务不可用：请检查网络与账号连接。本地写作不受影响。', 'NO_ENDPOINT', 0)
  }
  const base = cloudBase()
  let res: Response
  try {
    res = await cloudFetch()(`${base}/api/community${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(pageAccount ? { 'X-YFE-Account-Context': pageAccount } : {}), ...(init.headers || {}) },
    })
  } catch {
    throw new CommunityError('网络不通，广场暂时无法访问。你的本地写作与草稿不受影响。', 'NETWORK', 0)
  }
  // 信封只描述我们**实际会读取**的字段：状态、码、文案、重试秒数。
  // 🔴 不用 `any`：多一个 any 就多一处绕过类型检查的入口（结构闸按文件记账，只减不增）。
  let payload: { ok?: boolean; code?: string; error?: string; retryAfter?: number } | null = null
  try { payload = await res.json() } catch { payload = null }
  if (!res.ok || !payload || payload.ok !== true) {
    const code = String(payload?.code || (res.status === 401 ? 'UNAUTHORIZED' : 'SERVER'))
    const msg = String(payload?.error || (res.status === 401 ? '登录已过期，请重新登录' : '广场服务暂时不可用'))
    throw new CommunityError(msg, code, res.status, Number(payload?.retryAfter) || 0)
  }
  return payload as T
}

const qsOf = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** Redeem a sync code using the same authenticated account as the community. */
export async function activateSyncCode(code: string): Promise<{ alreadyActive: boolean }> {
  if (!communityEndpointReady()) throw new CommunityError('社区服务不可用', 'NO_ENDPOINT')
  let res: Response
  try {
    res = await cloudFetch()(`${cloudBase()}/api/auth/activate`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(pageAccount ? { 'X-YFE-Account-Context': pageAccount } : {}) }, body: JSON.stringify({ code }),
    })
  } catch { throw new CommunityError('网络不通，请稍后重试。', 'NETWORK') }
  const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; alreadyActive?: boolean } | null
  if (!res.ok || !body?.ok) throw new CommunityError(body?.error || '激活失败，请稍后重试。', 'ACTIVATE_FAILED', res.status)
  return { alreadyActive: !!body.alreadyActive }
}

// ---------------- 公共读 ----------------

export function fetchSquare(): Promise<CommunitySquareState & { ok: true }> {
  return request('/square')
}

export async function listPosts(opts: { tag?: string; cursor?: string; limit?: number } = {}): Promise<{
  items: CommunityPostSummary[]; nextCursor: string; closed: boolean
}> {
  return request(`/posts${qsOf({ tag: opts.tag, cursor: opts.cursor, limit: opts.limit })}`)
}

export async function getPost(id: string): Promise<{ post?: CommunityPostDetail; unavailable?: boolean; status?: string; title?: string }> {
  return request(`/posts/${encodeURIComponent(id)}`)
}

/** `total` = 服务端确认的公开可见评论总数（3.5.2 新增；旧服务端可能没有该字段） */
export async function listComments(postId: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ items: CommunityComment[]; nextCursor: string; total?: number }> {
  return request(`/posts/${encodeURIComponent(postId)}/comments${qsOf(opts)}`)
}

export async function fetchRank(period: RankPeriod, date?: string): Promise<RankBoard & { closed?: boolean }> {
  return request(`/rank${qsOf({ period, date })}`)
}

// ---------------- 我的 ----------------

export function createPost(input: {
  title: string; body: string; tags: string[]; display: 'nickname' | 'anonymous'; draft?: boolean; clientToken: string
}): Promise<{ post: MyPost; duplicate?: boolean }> {
  return request('/posts', { method: 'POST', body: JSON.stringify(input) })
}

export function updatePost(id: string, input: {
  title: string; body: string; tags: string[]; display?: 'nickname' | 'anonymous'; draft?: boolean
}): Promise<{ post: MyPost }> {
  return request(`/posts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function submitPost(id: string): Promise<{ post: MyPost }> {
  return request(`/posts/${encodeURIComponent(id)}/submit`, { method: 'POST', body: '{}' })
}

export function withdrawPost(id: string): Promise<{ changed: boolean }> {
  return request(`/posts/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: '{}' })
}

/** 只改展示方式（已发布内容也能立即改，不需要重新审核；不改正文） */
export function setPostDisplay(id: string, display: 'nickname' | 'anonymous'): Promise<{ display: string; note: string }> {
  return request(`/posts/${encodeURIComponent(id)}/display`, { method: 'POST', body: JSON.stringify({ display }) })
}

export function deletePost(id: string): Promise<{ changed: boolean }> {
  return request(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function myPosts(): Promise<{ items: MyPost[] }> {
  return request('/my/posts')
}

export function myComments(): Promise<{ items: MyComment[] }> {
  return request('/my/comments')
}

export function myReports(): Promise<{ items: Array<{ id: string; targetType: string; targetId: string; status: string; createdAt: number; outcome: string }> }> {
  return request('/my/reports')
}

// ---------------- 互动 ----------------

export function votePost(id: string, value: 1 | -1 | 0): Promise<{ counts: { up: number; down: number; comments: number }; myVote: number }> {
  return request(`/posts/${encodeURIComponent(id)}/vote`, { method: 'POST', body: JSON.stringify({ value }) })
}

export function addComment(postId: string, input: {
  body: string; display: 'nickname' | 'anonymous'; clientToken: string
}): Promise<{ comment: CommunityComment & { status: string }; duplicate?: boolean; total?: number }> {
  return request(`/posts/${encodeURIComponent(postId)}/comments`, { method: 'POST', body: JSON.stringify(input) })
}

export function deleteComment(id: string): Promise<{ changed: boolean }> {
  return request(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function reportContent(input: { targetType: 'post' | 'comment'; targetId: string; reason: string; detail?: string }): Promise<{ id: string; status: string; duplicate?: boolean }> {
  return request('/reports', { method: 'POST', body: JSON.stringify(input) })
}

// 申诉：作者对审核结果申请复核（服务端绑定当时被审的版本）
export function submitAppeal(input: { postId: string; versionId?: string; reason: string }): Promise<{ id: string; status: string; duplicate?: boolean }> {
  return request('/appeals', { method: 'POST', body: JSON.stringify(input) })
}

export function myAppeals(): Promise<{ items: Array<{ id: string; postId: string; status: string; createdAt: number; outcome: string }> }> {
  return request('/my/appeals')
}

// ---------------- 档案 ----------------

export function fetchProfile(): Promise<{ profile: CommunityProfile }> {
  return request('/profile')
}

export function updateProfile(patch: Partial<CommunityProfile>): Promise<{ profile: CommunityProfile }> {
  return request('/profile', { method: 'PUT', body: JSON.stringify(patch) })
}

// ---------------- 排行 ----------------

export interface RankReportEntry {
  projectId: string
  date: string
  netDelta: number
  seq: number
  issuedAt: number
}

export function reportRank(input: { deviceId: string; issuedAt: number; entries: RankReportEntry[] }): Promise<{
  accepted: Array<{ projectId: string; date: string }>
  rejected: Array<{ projectId: string; date: string; code: string }>
  serverDate: string
}> {
  return request('/rank/report', { method: 'POST', body: JSON.stringify(input) })
}

// ---------------- 管理 ----------------

export function adminOverview(): Promise<AdminOverview & { ok: true }> {
  return request('/admin/overview')
}

export function adminQueue(type: 'post' | 'comment' | 'report' | 'appeal', opts: { cursor?: string; limit?: number } = {}): Promise<{
  items: Array<AdminQueuePost | AdminQueueComment | AdminQueueReport>
  nextCursor: string
}> {
  return request(`/admin/queue${qsOf({ type, ...opts })}`)
}

export function adminItem(type: 'post' | 'comment', id: string): Promise<{ item: AdminPostItem & { body?: string; postId?: string; bodyText?: string } }> {
  return request(`/admin/item${qsOf({ type, id })}`)
}

export function adminClaim(type: 'post' | 'comment' | 'report' | 'appeal', ids: string[]): Promise<{ claimed: string[] }> {
  return request('/admin/claim', { method: 'POST', body: JSON.stringify({ type, ids }) })
}

export function adminAdvice(input: {
  targetType: 'post' | 'comment'; id: string; versionId?: string
  suggestion: 'approve' | 'review' | 'reject'; reasons: string[]; model?: string
  endpoint?: string
  coverage?: { truncated: boolean; shown: number; total: number }
}): Promise<{ ok: true }> {
  return request('/admin/advice', { method: 'POST', body: JSON.stringify(input) })
}

export function adminDecision(input: {
  targetType: 'post' | 'comment'; id: string; versionId?: string
  action: 'approve' | 'reject' | 'request_changes' | 'remove' | 'restore'; reason?: string
}): Promise<{ status: string }> {
  return request('/admin/decision', { method: 'POST', body: JSON.stringify(input) })
}

export function adminCloseReport(input: { id: string; action: 'none' | 'takedown' | 'warn' | 'reopen'; outcome?: string }): Promise<{ changed: boolean }> {
  return request('/admin/report', { method: 'POST', body: JSON.stringify(input) })
}

export function adminSwitch(patch: { squareOpen?: boolean; postsOpen?: boolean; commentsOpen?: boolean }): Promise<{ state: AdminOverview['state'] }> {
  return request('/admin/switch', { method: 'POST', body: JSON.stringify(patch) })
}

export function adminAudit(limit = 50): Promise<{ items: Array<{ id: string; actorRole: string; action: string; targetType: string; targetId: string; versionId: string; note: string; at: number }> }> {
  return request(`/admin/audit${qsOf({ limit })}`)
}

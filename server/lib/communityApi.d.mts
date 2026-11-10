// 3.5.0 · 投稿广场接口层的最小类型声明（真源是 communityApi.mjs）

import type { CommunityStore } from './communityStore.mjs'

export interface CommunityUser {
  id: string
  name?: string
  role?: string
  cloudSync?: boolean
  [k: string]: unknown
}

export interface CommunityApiDeps {
  store: CommunityStore
  authCheck: (req: unknown) => { user: CommunityUser | null; reason: string } | Promise<{ user: CommunityUser | null; reason: string }>
  rateLimit: (key: string, limit: number, windowMs: number) => { ok: boolean; retryAfter?: number }
}

export interface CommunityApi {
  handle(ctx: {
    req: any
    res: any
    path: string
    qs: URLSearchParams
    user: CommunityUser | null
    authReason?: string
    ip?: string
  }): Promise<unknown>
}

export function createCommunityApi(deps: CommunityApiDeps): CommunityApi
export function postPubliclyVisible(post: { publishedVersionId?: string; status?: string } | null): boolean
export function versionOf(post: { versions?: Array<{ vid: string }> } | null, versionId: string): { vid: string; title: string; body: string; tags: string[]; createdAt: number } | null
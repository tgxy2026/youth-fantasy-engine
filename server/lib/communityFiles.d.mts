// 3.5.2 · 社区初始化标记的最小类型声明（真源是 communityFiles.mjs）

export const COMMUNITY_META_FILE: string

export interface CommunityMeta {
  version?: number
  commentsInitialized: boolean
  createdAt?: number
  updatedAt?: number
  adoptedAt?: number
}

export function communityMetaPath(root: string): string
export function readCommunityMeta(root: string, readText?: (path: string) => string): CommunityMeta | null
export function writeCommunityMeta(
  root: string,
  meta: { commentsInitialized: boolean; createdAt?: number; adoptedAt?: number },
  writeText: (path: string, text: string) => void,
): void
export function commentsFileVerdict(input: {
  present: string[]
  postsItems: Record<string, any>
  meta: CommunityMeta | null
}): { ok: true; reason: string } | { ok: false; code: string; message: string }
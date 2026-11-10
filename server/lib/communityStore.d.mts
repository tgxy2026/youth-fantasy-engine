// 3.5.0 · 投稿广场存储层的最小类型声明（真源是 communityStore.mjs）

export const COMMUNITY_CAPACITY: {
  maxPosts: number
  maxComments: number
  maxReports: number
  maxAudit: number
  maxVersions: number
}

export interface CommunityState {
  squareOpen: boolean
  postsOpen: boolean
  commentsOpen: boolean
  updatedAt: number
}

export interface PostVersion { vid: string; title: string; body: string; tags: string[]; createdAt: number }
export interface CommunityPost {
  id: string
  uid: string
  status: string
  display: 'nickname' | 'anonymous'
  createdAt: number
  updatedAt: number
  versions: PostVersion[]
  pendingVersionId: string
  publishedVersionId: string
  screening?: unknown
  clientToken?: string
  counts: { up: number; down: number; comments: number }
  claimedBy?: string
  claimedAt?: number
  lastDecision?: unknown
  advice?: unknown
  withdrawnAt?: number
}

export interface CommunityComment {
  id: string
  postId: string
  uid: string
  body: string
  display: 'nickname' | 'anonymous'
  status: string
  screening?: unknown
  clientToken?: string
  createdAt: number
  claimedBy?: string
  claimedAt?: number
  decisionReason?: string
  advice?: unknown
}

export interface CommunityStore {
  readonly root: string
  newId(prefix: string): string
  counts(): { posts: number; comments: number; reports: number }
  getState(): CommunityState
  setState(patch: Partial<CommunityState>): CommunityState
  getPost(id: string): CommunityPost | null
  putPost(post: CommunityPost): CommunityPost
  listPosts(): CommunityPost[]
  findPostByToken(uid: string, token: string): CommunityPost | null
  getComment(id: string): CommunityComment | null
  putComment(comment: CommunityComment): CommunityComment
  listCommentsOf(postId: string): CommunityComment[]
  listCommentsByUid(uid: string): CommunityComment[]
  getVote(postId: string, uid: string): { postId: string; uid: string; value: number; updatedAt: number } | null
  setVote(postId: string, uid: string, value: number, now?: number): unknown
  recountVotes(postId: string): { up: number; down: number }
  votesOfUser(uid: string): Array<{ postId: string; uid: string; value: number; updatedAt: number }>
  putReport(report: Record<string, unknown> & { id: string }): unknown
  getReport(id: string): Record<string, any> | null
  listReports(): Array<Record<string, any>>
  findOpenReport(uid: string, targetType: string, targetId: string): Record<string, any> | null
  getProfile(uid: string): Record<string, any> | null
  putProfile(uid: string, patch: Record<string, unknown>): Record<string, any>
  deleteProfileRank(uid: string): number
  getRankRow(uid: string, deviceId: string, projectId: string, date: string): Record<string, any> | null
  putRankRow(row: Record<string, any>): Record<string, any>
  listRankRows(uid: string): Array<Record<string, any>>
  listAllRankRows(): Array<Record<string, any>>
  appendAudit(entry: Record<string, unknown>): Record<string, unknown>
  listAudit(limit?: number): Array<Record<string, any>>
}

export function createCommunityStore(opts: { root: string }): CommunityStore
// 3.5.0 · 投稿广场存储层的最小类型声明（真源是 communityStore.mjs）

export const COMMUNITY_CAPACITY: {
  maxPosts: number
  maxComments: number
  maxReports: number
  /** 合集上限（3.6.2） */
  maxCollections: number
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
  removedAt?: number
  isExample?: boolean
  /** 浏览量（3.6.2）；老数据没有这个字段 */
  views?: number
  /** 所在合集（3.6.2） */
  collectionId?: string
  collectionOrder?: number
}

/** 合集（3.6.2） */
export interface CommunityCollection {
  id: string
  uid: string
  title: string
  intro: string
  orderMode: 'chronological' | 'manual'
  status: 'active' | 'hidden'
  createdAt: number
  updatedAt: number
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
  // ---- 合集（3.6.2）----
  getCollection(id: string): CommunityCollection | null
  putCollection(collection: CommunityCollection): CommunityCollection
  listCollectionsByUid(uid: string): CommunityCollection[]
  countCollections(): number
  countCollectionsOf(uid: string): number
  listPostsOfCollection(collectionId: string): CommunityPost[]
  setPostCollection(postId: string, collectionId: string, order?: number): CommunityPost | null
  clearCollectionPosts(collectionId: string): number
  deleteCollection(id: string): boolean
  reorderCollection(collectionId: string, postIds: string[]): number
  // ---- 浏览量（3.6.2）----
  recordView(postId: string, viewer?: { uid?: string; visitorKey?: string }): boolean
  flushViewsNow(): { flushed: number; posts: number; error?: string }
  getComment(id: string): CommunityComment | null
  putComment(comment: CommunityComment): CommunityComment
  listCommentsOf(postId: string): CommunityComment[]
  listCommentsByUid(uid: string): CommunityComment[]
  getVote(postId: string, uid: string): { postId: string; uid: string; value: number; updatedAt: number } | null
  setVote(postId: string, uid: string, value: number, now?: number): unknown
  recountComments(postId: string): number
  recountVotes(postId: string): { up: number; down: number }
  votesOfUser(uid: string): Array<{ postId: string; uid: string; value: number; updatedAt: number }>
  putReport(report: Record<string, unknown> & { id: string }): unknown
  getReport(id: string): Record<string, any> | null
  listReports(): Array<Record<string, any>>
  findOpenReport(uid: string, targetType: string, targetId: string, kind?: string): Record<string, any> | null
  getProfile(uid: string): Record<string, any> | null
  anonymousEnabled(): boolean
  getAnonymousHandle(uid: string, weekKey: string): string
  ensureAnonymousHandle(uid: string, weekKey: string): string
  assertAnonymousMappings(): void
  putProfile(uid: string, patch: Record<string, unknown>): Record<string, any>
  deleteProfileRank(uid: string): number
  getRankRow(uid: string, deviceId: string, projectId: string, date: string): Record<string, any> | null
  putRankRow(row: Record<string, any>): Record<string, any>
  listRankRows(uid: string): Array<Record<string, any>>
  listAllRankRows(): Array<Record<string, any>>
  appendAudit(entry: Record<string, unknown>): Record<string, unknown>
  listAudit(limit?: number): Array<Record<string, any>>
  isLocked(): boolean
}

export function createCommunityStore(opts: {
  root: string
  /** 故障注入用；生产默认使用原子写 */
  writeText?: (abs: string, text: string) => void
  /** 故障注入用；生产默认同步读取 */
  readText?: (abs: string) => string
  /** 匿名代号密钥（≥32 字节）；缺省时保持旧「匿名用户」模式 */
  anonSecret?: Buffer | null
}): CommunityStore

// ============ 投稿广场 · 数据契约（3.5.0）============
//
// 公开字段不包含 uid / 登录名 / 审核内部信息；启用后的匿名代号在所属周可关联，
// 跨周更换也不能保证无法关联，不能增加 authorId 暴露账号身份。

export type DisplayMode = 'nickname' | 'anonymous'
export type RankPeriod = 'day' | 'week' | 'month'

export interface CommunityLimitsDto {
  titleMax: number
  bodyMax: number
  commentMax: number
  tagMax: number
}

export interface CommunitySquareState {
  open: boolean
  postsOpen: boolean
  commentsOpen: boolean
  tags: string[]
  limits: CommunityLimitsDto
}

export interface CommunityPostSummary {
  id: string
  title: string
  excerpt: string
  tags: string[]
  createdAt: number
  updatedAt: number
  counts: { up: number; down: number; comments: number }
  /** 浏览量（去重后）。老帖没有这个字段，服务端兜底为 0 */
  views: number
  /** 所属合集；未归集时不出现 */
  collection?: {
    id: string
    title: string
    /** 在合集里的序号（1 起）；有篇目不可见时会跳号 */
    index: number
    /** 合集内当前可见的篇数 */
    total: number
  }
  displayName: string
  authorLabel?: string
  isExample?: boolean
  myVote?: number
  myPost?: boolean
}

export interface CommunityPostDetail extends Omit<CommunityPostSummary, 'excerpt'> {
  body: string
  /** 合集内上下篇；只在详情接口返回 */
  collectionNav?: { prevId: string | null; nextId: string | null }
}

/** 合集（我的合集列表项） */
export interface MyCollection {
  id: string
  title: string
  intro: string
  orderMode: 'chronological' | 'manual'
  createdAt: number
  updatedAt: number
  postCount: number
  /** 已挂进合集但尚不可见的（草稿 / 待审）—— 让作者知道"挂上了但读者看不到" */
  draftCount: number
  totalViews: number
}

/** 合集页（公开） */
export interface CommunityCollectionPage {
  id: string
  title: string
  intro: string
  orderMode: 'chronological' | 'manual'
  updatedAt: number
  postCount: number
  /** 各篇之和。🔴 是「篇次」不是「人数」，文案不能写成读者数 */
  totalViews: number
  isMine: boolean
  items: CommunityPostSummary[]
  /** 作者/管理员才有：全部篇目（含草稿/待审/已撤回），用于手动排序 */
  allItems?: Array<{ id: string; title: string; status: string; visible: boolean }>
}

export interface CommunityComment {
  id: string
  createdAt: number
  body: string
  displayName: string
  byAuthor: boolean
  myComment?: boolean
}

export interface MyPost {
  id: string
  status: string
  display: DisplayMode
  displayName?: string
  createdAt: number
  updatedAt: number
  title: string
  /** 所在合集 id（空串 = 未归集） */
  collectionId?: string
  /** 最新版本正文（仅作者本人可见，用于编辑；公开接口不返回） */
  body: string
  tags: string[]
  counts: { up: number; down: number; comments: number }
  pendingVersionId: string
  publishedVersionId: string
  lastDecision: { versionId: string; action: string; reason: string; at: number } | null
  withdrawnAt: number
  hasPublishedVersion: boolean
}

export interface MyComment {
  id: string
  postId: string
  body: string
  status: string
  createdAt: number
  screening: string[]
}

export interface CommunityProfile {
  nickname: string
  postDisplay: DisplayMode
  commentDisplay: DisplayMode
  rankDisplay: DisplayMode
  rankOptIn: boolean
  /** 开启时间：上报只从这一天起算（历史不自动上传） */
  rankOptInAt: number
  /** 撤回时间：早于它的迟到上报服务端一律拒绝 */
  rankRevokedAt: number
  serverNow?: number
  nicknameNextChangeAt?: number
  nicknameTimeInvalid?: boolean
  anonymousHandlesEnabled?: boolean
  updatedAt: number
}

export interface RankEntry {
  rank: number
  value: number
  displayName: string
}

export interface RankBoard {
  period: RankPeriod
  range: { start: string; end: string } | null
  entries: RankEntry[]
}

export interface ReviewAdvice {
  suggestion: string
  reasons: string[]
  versionId: string
  at: number
  model?: string
  /** 生成建议的端点主机名（确认没有外发到公网） */
  endpoint?: string
  /** 覆盖范围：截断时工作台必须显著提示 */
  coverage?: { truncated: boolean; shown: number; total: number }
}

export interface AdminQueuePost {
  id: string
  versionId: string
  title: string
  excerpt: string
  tags: string[]
  createdAt: number
  screening: { level: string; reasons: string[] } | null
  advice: ReviewAdvice | null
  claimedBy: string
  claimedAt: number
}

export interface AdminQueueComment {
  id: string
  postId: string
  body: string
  createdAt: number
  screening: { level: string; reasons: string[] } | null
  claimedBy: string
  claimedAt: number
}

export interface AdminQueueReport {
  id: string
  /** 'report' = 举报；'appeal' = 作者申诉（同一队列结构，语义与处理动作不同） */
  kind?: 'report' | 'appeal'
  targetType: 'post' | 'comment'
  targetId: string
  /** 申诉绑定的版本（举报为空） */
  versionId?: string
  reason: string
  detail: string
  createdAt: number
  status: string
  claimedBy: string
  claimedAt: number
}

export interface AdminOverview {
  counts: { posts: number; comments: number; reports: number }
  queue: { posts: number; comments: number; reports: number; appeals: number }
  state: { squareOpen: boolean; postsOpen: boolean; commentsOpen: boolean; updatedAt: number }
}

export interface AdminPostItem {
  id: string
  status: string
  versionId: string
  title: string
  body: string
  tags: string[]
  createdAt: number
  screening: { level: string; reasons: string[] } | null
  advice: ReviewAdvice | null
  versions: Array<{ vid: string; title: string; createdAt: number }>
}

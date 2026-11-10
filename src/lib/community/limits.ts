// ============ 投稿广场 · 双端共享口径（3.5.0）============
//
// 【为什么客户端要有一份】服务端（`server/lib/communityRules.mjs`）校验的是最终真相，
// 但输入框需要**实时计数**：每敲一个字都发请求是不现实的。两份实现必须逐字一致，
// 由 `tests/communityContract.test.ts` 对同一批样例做等价断言 + 常量比对来守住。
//
// 🔴 计数口径 = **Unicode 码点**（不是 `String.length`）：emoji 占 2 个 UTF-16 单元，
//    用 length 会出现「显示还剩 3 字，提交却说超长」。
// 🔴 服务端仍然是唯一裁判：这里的校验只用于禁用按钮与提前提示。

export const COMMUNITY_LIMITS = {
  titleMax: 100,
  bodyMax: 10000,
  commentMax: 1000,
  tagMax: 3,
  tagLenMax: 16,
  nicknameMin: 1,
  nicknameMax: 16,
  pageSize: 20,
  pageSizeMax: 50,
  postDailyMax: 5,
  commentDailyMax: 40,
  reportDailyMax: 20,
} as const

/** 预设标签：必须与服务端 `COMMUNITY_TAGS` 完全一致（契约测试会比对） */
export const COMMUNITY_TAGS = ['练笔', '短篇', '设定', '灵感', '求评'] as const

export type CommunityTag = (typeof COMMUNITY_TAGS)[number]

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g
const PUNCT_RE =
  /[\u3000-\u303f\u2014\u2018-\u201d\u2026\u00b7]|[\uff01-\uff0f]|[\uff1a-\uff20]|[\uff3b-\uff40]|[\uff5b-\uff65]/g

/**
 * 含标点字数（与 `countWords(text,'cjk-punct')` 同规则）。
 * 🔴 排行口径要求「含标点的净增量」，所以这里**必须**复用同一套正则；
 *    直接调 `countWords` 也行，但本模块在测试里要独立加载以验证两端一致。
 */
export function countWordsWithPunct(text: string): number {
  if (!text) return 0
  const cjk = (text.match(CJK_RE) || []).length
  const punct = (text.match(PUNCT_RE) || []).length
  const words = (text.replace(CJK_RE, ' ').match(/[a-zA-Z0-9]+/g) || []).length
  return cjk + punct + words
}

/** Unicode 码点计数（界面实时计数用） */
export function charCount(text: string): number {
  if (!text) return 0
  let n = 0
  for (const _ of text) n++
  return n
}

/** 只有空白（含全角空格 / 零宽 / BOM） */
export function isBlank(text: string): boolean {
  return text.replace(/[\s\u3000\u200b\ufeff]/g, '') === ''
}

export const POST_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  pending: '审核中',
  published: '已发布',
  changes_requested: '需修改',
  rejected: '未通过',
  withdrawn: '已撤回',
  removed: '已下架',
}

export const COMMENT_STATUS_LABELS: Record<string, string> = {
  pending: '审核中',
  visible: '已显示',
  rejected: '未通过',
  removed: '已下架',
}

export const SCREENING_REASON_LABELS: Record<string, string> = {
  BLANK: '内容为空',
  TOO_SHORT: '内容过短',
  LOW_INFO: '信息量过低',
  URL: '含网址',
  EMAIL: '含邮箱',
  PHONE: '含手机号',
  CONTACT_QQ: '含 QQ 号',
  CONTACT_WECHAT: '含微信号',
  SOLICIT: '疑似广告/招募',
  RISK_WORD: '命中风险词（需人工判断语境）',
  REPEAT: '重复刷屏',
}
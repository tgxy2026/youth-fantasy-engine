// ============ 帮助中心的跨页请求通道（3.3.1 · P3 缺口） ============
//
// 两件事只有在「跨页」时才成立，所以需要一条通道：
//   ① 引导卡片上的「查看完整手册」—— 从任意页签跳到「使用指南」并**直接打开那一篇**；
//   ② 手册文章底部的「重看本页引导」—— 从「使用指南」跳回功能页并**立刻启动引导**。
//
// 🔴 为什么不用 URL / 路由：本项目没有路由（页签是组件状态），硬造 query 会绕开离页保存屏障。
//    这里只投递一个「意图」，由 App 走**既有 navigate**（含保存屏障、可见性校验、历史栈），
//    UI 侧不直接改 activeTab —— 保存失败时人还留在原页，请求也还在，下次点仍有效。
//
// 🔴 请求是**一次性**的：读取即清空（take）。否则一次点击会在每次进入该页时反复触发。
export interface HelpArticleRequest {
  kind: 'article'
  /** 手册文章 id（`lib/help/articles` 里的稳定 id） */
  articleId: string
  /** 递增序号：同一条重复请求也能被区分（连续点两次不会因为值相同被 React 合并掉） */
  nonce: number
}

export interface HelpGuideRequest {
  kind: 'guide'
  /** 要重看引导的页签 id */
  tabId: string
  nonce: number
}

export type HelpRequest = HelpArticleRequest | HelpGuideRequest

let pending: HelpRequest | null = null
let sequence = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 待处理请求之外，还有一个「这次导航别自动弹引导」的一次性抑制标记 */
let suppressAutoGuide = 0

/**
 * 抑制下一次自动引导。
 *
 * 🔴 场景：作者在卡片上点「查看完整手册」，目的是**读文章**。如果目标页（使用指南）
 *    又自动弹一张引导卡片，正好把刚打开的正文挡住 —— 这是实机探针抓到的真实回归。
 *    投递文章请求时顺手置一次，目标页的 `usePageGuide` 启动前消费掉。
 */
export function suppressNextAutoGuide(): void {
  suppressAutoGuide += 1
}

/** 消费抑制标记（有就减一，返回是否被抑制） */
export function takeAutoGuideSuppression(): boolean {
  if (suppressAutoGuide <= 0) return false
  suppressAutoGuide -= 1
  return true
}

/** 请求 App 跳到「使用指南」并打开某篇手册文章 */
export function requestHelpArticle(articleId: string): void {
  suppressNextAutoGuide()
  pending = { kind: 'article', articleId, nonce: ++sequence }
  emit()
}

/** 请求 App 跳到某个页签并立刻启动该页引导（即使作者已经跳过过） */
export function requestPageGuide(tabId: string): void {
  pending = { kind: 'guide', tabId, nonce: ++sequence }
  emit()
}

/** 只读当前待处理请求（不消费）；`kind` 不匹配时返回 null */
export function peekHelpRequest(kind: HelpRequest['kind']): HelpRequest | null {
  return pending && pending.kind === kind ? pending : null
}

/** 取走并清空（消费一次）。同一条请求只会被处理一次 */
export function takeHelpRequest(kind: HelpRequest['kind']): HelpRequest | null {
  const request = peekHelpRequest(kind)
  if (request) { pending = null; emit() }
  return request
}

/** 订阅「有新的待处理请求」（App 用它触发导航） */
export function subscribeHelpRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 仅供测试：清空待处理请求与订阅 */
export function resetHelpRequests(): void {
  pending = null
  sequence = 0
  suppressAutoGuide = 0
  listeners.clear()
}

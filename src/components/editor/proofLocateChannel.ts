// ============ 校对「定位原文」的请求通道（模块级，跨组件） ============
//
// 3.3.1 · P7 为什么要一条通道，而不是层层传 props：
//   发起方在工具校对弹窗（`EditorModals.ProofreadCheck`）和颉文姬诊室（`JieWenJiClinic`），
//   执行方是正文 `textarea`（在 `NovelEditor` 里）。两者之间隔着弹层、抽屉和一堆中间组件，
//   为一颗「定位原文」按钮把回调穿五六层，容易在某个条件分支上悄悄断掉。
//
// 🔴 这里只做「谁在听、谁来处理」，不碰 DOM 也不弹提示：
//   · 订阅者返回 true = 我处理了（并负责失败反馈）；false = 我这儿不是目标页。
//   · 请求带单调递增 id：连点两次或旧请求迟到时，消费端只看最新那条。
//   · 请求带章节归属：结果属于第 3 章却在第 8 章点定位 ⇒ 消费端拒绝，绝不跨章乱跳。
export type ProofLocateSource = 'tool' | 'clinic'

/** 一次定位请求的载荷（`id` 由通道补，调用方不用管） */
export interface ProofLocateTarget {
  /** 结果所属章节 —— 与当前活动章不一致时消费端必须拒绝 */
  chapterId: string
  /** 发起入口：决定「返回校对结果」要重开哪个界面 */
  source: ProofLocateSource
  /** 第 N 条（1 起）与总数，只用于提示文案 */
  index: number
  total: number
  /** 发起时解析出的位置（消费端会拿引文再校验一次，不盲信） */
  start: number
  end: number
  quote: string
  /** 结果条目身份键（`proofIssueKey`），返回时用它把列表滚回那一条 */
  issueKey: number
  /** 'text' | 'logic' | 'typo' —— 返回时用于定位所属分组 */
  scope: string
}

export interface ProofLocateRequest extends ProofLocateTarget {
  id: number
}

/** 「已定位，可返回校对结果」的提示状态（只在弹窗被迫收起时出现） */
export interface ProofLocateReturnPrompt {
  chapterId: string
  source: ProofLocateSource
  issueKey: number
  index: number
  total: number
  quote: string
  scope: string
}

type ProofLocateHandler = (request: ProofLocateRequest) => boolean

const handlers = new Set<ProofLocateHandler>()
let sequence = 0

/** 订阅定位请求；返回取消订阅。同一个组件实例只应订阅一次。 */
export function subscribeProofLocate(handler: ProofLocateHandler): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

/**
 * 请求把正文滚到某条校对结果并选中。
 *
 * @returns true = 已被某个正文视图接手（成功与否由它自己提示）；
 *          false = 没有任何正文视图在听（例如当前不在正文页），调用方应说明无法定位。
 */
export function requestProofLocate(target: ProofLocateTarget): boolean {
  const request: ProofLocateRequest = { ...target, id: ++sequence }
  let handled = false
  for (const handler of handlers) {
    // 多个订阅者时全部通知：各自判断章节归属，真处理的那个返回 true。
    if (handler(request)) handled = true
  }
  return handled
}

/** 仅供测试：清空订阅与序号，避免用例之间互相污染 */
export function resetProofLocateChannel(): void {
  handlers.clear()
  sequence = 0
}

// ============ 数据库变更事实总线（3.7.0 · W1 统一地基）============
//
// 为什么有它（见 docs/归档/3.7/3.7.0-开发规划方案-2026-11-23.md §3 W1.2 R1）：
//   保存路径不止一条 —— 手填 / 草稿合并 / AI 写入 / 导入 / MCP 都写库。
//   若把「大纲变更 → 未来章待重审」的钩子挂在 UI 保存函数上，必然漏掉 AI/导入/MCP；
//   所以钩子一律挂在 **db 收口点**（`saveFormDataFor` / `saveTableRow` / `saveCardRecord` /
//   `saveChapter` / `patchChapter`），由这里统一向外发事实。
//
// 🔴 本模块只发**事实**，不做任何业务判断：
//   · 不知道哪个 tab 是大纲、哪条记录该打标 —— 那些在 `revision/changeWatch` 里；
//   · 全部用 try/catch 隔离：**保存是主路径，通知是旁路**，任何消费者抛错都绝不能让保存失败；
//   · 零依赖（不 import db / revision / UI），避免 db ↔ revision 循环依赖。
//
// 订阅/发射是同步的（订阅立即生效），消费方自己异步处理 —— 这里不等 await。

/** 写库事实的类别：表单 / 表格行 / 卡片 / 章节正文 */
export type DbChangeKind = 'form' | 'row' | 'card' | 'chapter'

/** 字段表快照（form / row / card 用；卡名单列，便于识别章号） */
export interface DbChangePayload {
  /** 卡片名 / 表格行名（表单没有名字时为 undefined） */
  name?: string
  data: Record<string, string>
}

export interface DbChangeFact {
  /** 项目 id —— 消费者按项目合并、按项目判归属 */
  pid: string
  kind: DbChangeKind
  /** 页签 id（chapter 为空串） */
  tabId: string
  /** 记录 id（form 用 tabId 自身；chapter 用章 id） */
  recordId: string
  /** 改前快照：读不到旧值（新建）时为 undefined */
  before?: DbChangePayload
  /** 改后快照：写入成功后的值 */
  after?: DbChangePayload
  /**
   * 章正文是否真的变了（仅 `kind === 'chapter'`）。
   * 🔴 正文体积大，不随事实携带全文 —— 消费者需要摘要时按需读库；
   *    这里只给「正文变了没有」这个确定性事实，标题/摘要改动不误触发正文类分析。
   */
  contentChanged?: boolean
}

type Listener = (fact: DbChangeFact) => void

const listeners = new Set<Listener>()

/** 订阅变更事实；返回退订函数（应用启动时注册一次，测试可随时退订） */
export function onDbChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 清空全部订阅（**仅测试用**：避免用例之间串味） */
export function clearDbChangeListeners(): void {
  listeners.clear()
}

/**
 * 发射一条变更事实。
 *
 * 🔴 永不抛错：每个订阅者单独 try/catch。保存已经把数据写进库里了，
 *    这时候因为「打标」把保存报成失败，作者会重试、会以为稿子没存上。
 */
export function emitDbChange(fact: DbChangeFact): void {
  if (!fact || !fact.pid) return
  for (const listener of [...listeners]) {
    try {
      listener(fact)
    } catch {
      // 旁路：消费者的异常在这里吞掉，保存结果不受影响
    }
  }
}

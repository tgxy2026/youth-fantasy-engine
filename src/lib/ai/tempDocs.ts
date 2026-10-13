// ============ AI 弹窗「附加文件」：一次性资料（3.0.3）============
//
// 【它是什么】作者在某个 AI 弹窗里**临时**递一份文件（txt / md / docx），只喂给**这一次**请求，
//   不落素材资料库、不建索引、关掉弹窗就没了。
//
// 【与「我的参考资料」的区别】（这两个不是一回事，别混）
//   · 我的参考资料（`lib/search/knowledgeBase.ts`）：长期挂载 → 建索引 → 每次按需召回片段；
//   · 本模块：临时递一份**完整正文**给这一次任务。
//   作者想"以后每次都能读到"就挂参考资料；只想"这次让它看看这份稿子"就用这里。
//   解析直接复用 `lib/storage/chapterImport`（txt/md/docx 手写零依赖解析）。
//
// 🔴 生命周期纪律（务必守住）：
//   · **弹窗卸载时必须 `clearTempDocs()`** —— 否则作者关掉这个弹窗后，下一次在别处发起的
//     AI 请求会莫名带上上次那个文件，而他完全看不出原因。
//   · 组件侧统一由 `TempAttachmentPicker` 负责设置与清理，别在别处手动 set。
//
// 【为什么独立成模块】上下文装配器 `aiContext.ts` 已经贴着"单文件 1200 行"的结构闸上限
//   （本项目 `tests/structureGates.test.ts` ①），而这段逻辑与装配本身无关，抽出来正好把关闸让开，
//   职责也更清楚：这里是"会话级的一次性附件"，那里只管"怎么组装"。
// 🔴 依赖方向：本模块**不 import 任何东西**（纯逻辑 + 模块级状态）——
//    这样 `aiContext`、以及任何 UI 组件都能自由依赖它，不会形成环。

export interface TempDoc {
  /** 文件名（注入时作为小标题，便于作者在「上下文查看」里认出来源） */
  name: string
  /** 已解析的纯文本 */
  text: string
}

let tempDocs: TempDoc[] = []
/** 当前持有附加文件的组件实例（`useId`）—— 见 `setTempDocs` 的"只清自己的"规则 */
let tempDocsOwner: string | null = null

/**
 * 设置附加文件。**只在自己确实有内容时才接管**，空数组不覆盖别人 ——
 * 因为"多个 AI 面板可能同时挂载"（AI 助手面板 + 创作面板 + 审计弹窗…），
 * 而每个 picker 挂载时都会先同步一次空列表；若空列表无条件覆盖，
 * 就会把另一个面板刚附加好的文件清掉（用户完全看不出为什么）。
 */
export function setTempDocs(ownerId: string, docs: TempDoc[]): void {
  const clean = Array.isArray(docs) ? docs.filter(d => d && d.text && d.text.trim()) : []
  if (clean.length === 0) {
    if (tempDocsOwner === ownerId) { tempDocs = []; tempDocsOwner = null }
    return
  }
  tempDocs = clean
  tempDocsOwner = ownerId
}

/**
 * 清空附加文件 —— **弹窗卸载时必须调**（见上方生命周期纪律）。
 * 同样只清自己那份：不是自己的持有者就不动，免得把别人正在用的文件一起清掉。
 */
export function clearTempDocs(ownerId: string): void {
  if (tempDocsOwner === ownerId) { tempDocs = []; tempDocsOwner = null }
}

/** 读当前附加文件（供界面回显；注入由 `aiContext.buildProjectContext` 完成） */
export function getTempDocs(): TempDoc[] {
  return tempDocs
}

/** 单份附加文件注入上限 2 万字、合计 4 万字 —— 再多就该走「参考资料」正式挂载了 */
export const TEMP_DOC_PER_CHARS = 20_000
export const TEMP_DOC_TOTAL_CHARS = 40_000

/**
 * 把附加文件渲染成可注入的一段（超限按序截断，并在文末**如实说明**——不静默丢）。
 *
 * 🔴 它是「整份正文」，不做相关性筛选 —— 与〖参考资料〗"只给片段"的口径不同：
 *    参考资料是长期挂载的、可能很大，故按相似度截片段；这里是作者本次**特意**递进来的，
 *    默认就是"让它全看"，故只做长度兜底。
 */
export function renderTempDocs(docs: TempDoc[]): string {
  const out: string[] = []
  let used = 0
  const dropped: string[] = []
  for (const d of docs) {
    if (used >= TEMP_DOC_TOTAL_CHARS) { dropped.push(d.name); continue }
    const body = d.text.trim()
    const clipped = body.length > TEMP_DOC_PER_CHARS
      ? body.slice(0, TEMP_DOC_PER_CHARS) + `\n（以上为该文件前 ${TEMP_DOC_PER_CHARS} 字，其余已略）`
      : body
    const seg = `◆ ${d.name}\n${clipped}`
    out.push(seg)
    used += seg.length
  }
  if (dropped.length > 0) out.push(`（以下文件因长度上限未带入：${dropped.join('、')}）`)
  return out.join('\n\n')
}

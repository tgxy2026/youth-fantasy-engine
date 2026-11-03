/**
 * 本章资料绑定 · **写入安全判据**（3.4.0 · B）
 *
 * 【为什么值得单独一个模块】
 * 这里的两条判断都曾经写反过，而且写反了**界面上看不出来**：
 *   ① 读失败时是否允许写 —— 原实现读失败也把 `bindingLoaded` 置 true，于是作者在空绑定上
 *      点一下「固定」，就会把整条 `chapterContext32:<章>` 覆盖成 `{pinnedRefs:[...]}`，
 *      库里的原绑定**静默消失**。规划 §四：「读取失败不当作空数据覆盖」。
 *   ② 读不到资料目录时，固定项该怎么说 —— 说成「记录已删除」会让作者以为资料没了，
 *      其实只是目录这次没读出来。
 *
 * 纯函数：两句话都能被单测钉住，不必把 React / IndexedDB 拖进来。
 */

export type BindingReadStatus = 'loading' | 'ready' | 'failed'

export interface WriteGate {
  allowed: boolean
  /** 被拦下时给作者看的原因（不是给日志看的技术栈） */
  reason: string
}

/**
 * 当前是否允许改「本章资料绑定」。
 *
 * 🔴 只有 `ready` 允许写：loading 时点下去写的是占位空绑定，failed 时写的是"读失败后的空态"，
 *    两种都会覆盖库里真实存在的记录。
 */
export function bindingWriteGate(status: BindingReadStatus): WriteGate {
  if (status === 'ready') return { allowed: true, reason: '' }
  if (status === 'loading') return { allowed: false, reason: '本章资料绑定还在读取，请稍候再操作' }
  return { allowed: false, reason: '本章资料绑定尚未读取成功，已阻止保存以免覆盖原记录' }
}

/**
 * 已固定条目「查不到」时的说明文案。
 *
 * @param tabVisible  项目是否启用了该资料模块（策略禁用 ≠ 记录被删）
 * @param found       在已加载的目录里找到了对应记录
 * @param catalogError 目录整体读取失败的原因（空串 = 读成功）
 */
export function pinnedUnavailableLabel(args: {
  tabVisible: boolean
  found: boolean
  catalogError: string
}): string {
  if (!args.tabVisible) return '当前项目未启用此资料模块'
  if (args.found) return ''
  // 🔴 目录没读出来时只能说"暂时无法确认"，不能说"记录已删除"
  if (args.catalogError) return `${args.catalogError}，暂时无法确认这条资料是否还在`
  return '记录已删除或暂时不可用'
}

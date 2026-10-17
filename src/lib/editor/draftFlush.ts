/**
 * 编辑器草稿「关窗前冲刷」的跨模块通道（2026-10-17 全量审计 P1）。
 *
 * 【为什么需要】
 *   正文保存是 **2 秒防抖**；而 `App` 的 `beforeunload` / `pagehide` 只冲刷桌面 store 的
 *   内存快照（`flushDesktopSync` / `flushPortableBeacon`）—— 草稿此时**还没进 store**，
 *   于是「写完一句立刻关窗」会丢掉最后 ≤2 秒的正文，而且写盘返回成功、毫无提示。
 *
 *   编辑器 hook 在深层组件里，App 拿不到它的实例，故用一个**模块级登记器**（与 sync 层
 *   既有的 `onSyncConflict` 同一模式）：编辑器挂载时注册「立刻落草稿」，卸载时注销；
 *   App 关窗时先调它、再写盘。
 *
 * 【时序】
 *   `flushEditorDraftNow()` 返回 Promise。`beforeunload` 里不能 await，但**微任务**会在
 *   当前任务结束前跑完（桌面版的 store 是内存实现，不产生宏任务）⇒ 链条来得及；
 *   即便某次来不及，`pagehide` 还会再兜一次（两个事件都挂）。
 */
type Flusher = () => Promise<void>

let flusher: Flusher | null = null

/** 注册 / 注销编辑器草稿冲刷器（编辑器挂载时注册，卸载时注销） */
export function registerEditorDraftFlush(fn: Flusher | null): void {
  flusher = fn
}

/**
 * 立刻把编辑器未落库的草稿写进 store（没有注册时是空操作）。
 * 失败不抛出 —— 调用方（关窗流程）要继续做写盘，不能被这里打断。
 */
export function flushEditorDraftNow(): Promise<void> {
  const fn = flusher
  if (!fn) return Promise.resolve()
  try {
    return fn().catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

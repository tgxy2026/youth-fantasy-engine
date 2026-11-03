/**
 * 时光机恢复 · **前置校验**（3.4.0 · C）
 *
 * 【为什么单独成模块】
 * 恢复一章 = 覆盖作者正在写的东西。真正危险的不是"恢复"这个动作，而是**它认错了目标**：
 *   · 弹窗开着时作者切了章（或恢复按钮被异步拖到切章之后才执行）⇒ 会把 A 章的版本写进 B 章；
 *   · 12 版池会淘汰旧版，作者停留十分钟再点恢复 ⇒ 目标快照已经不在；
 *   · 同一条快照被 AI 流程重写过（内容变了）⇒ 作者看到的预览与实际写入不一致。
 *
 * 这三种都在 `restoreSnapshot` 里 await 之后才可能发生，所以必须**在执行前再校验一次**，
 * 而不是依赖打开弹窗时的 UI 状态。判据放在这里 ⇒ 单测直接钉死；措辞也统一，
 * 界面与日志不会出现「已删除」和「不存在」两种说法。
 */

export interface RestoreTarget {
  chapterId: string
  /** 恢复执行那一刻编辑器里打开的章（null = 没有打开任何章） */
  activeChapterId: string | null
  /** 目标章是否仍在项目里 */
  chapterExists: boolean
  /** 目标快照；null = 已被 12 版上限淘汰 / 已被清理 */
  snapshot: { content: string } | null
  /** 作者在预览里看到并确认要恢复的内容 */
  expectedContent: string
}

export type RestoreCheck = { ok: true } | { ok: false; message: string }

/**
 * 逐条校验，**顺序固定**：先章、再当前章、再版本存在、最后内容一致。
 * 顺序影响提示的准确度 —— 章都没了却先报"内容变化"会误导作者去重选版本。
 */
export function checkRestoreTarget(t: RestoreTarget): RestoreCheck {
  if (!t.chapterExists) {
    return { ok: false, message: '要恢复的章节已不在项目中，本次未做任何修改。' }
  }
  if (t.activeChapterId !== t.chapterId) {
    return { ok: false, message: '当前已切换到其他章节，本次未做任何修改；请回到该章再试。' }
  }
  if (!t.snapshot) {
    return { ok: false, message: '这个历史版本已不存在（可能被新快照挤出 12 版上限），本次未做修改。' }
  }
  if (t.snapshot.content !== t.expectedContent) {
    return { ok: false, message: '历史版本内容已变化，请重新打开时光机再选，本次未做修改。' }
  }
  return { ok: true }
}

/**
 * 恢复失败的统一措辞：**必须说明草稿还在**。
 * 作者看到「失败」第一反应是"我的稿呢" —— 不含这句话的报错会让他在恐慌里做多余操作。
 */
export function restoreFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `恢复失败：${detail}。恢复前的草稿仍保留，可重试或另选版本。`
}

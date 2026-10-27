/**
 * 「设定检索里内联改字段」写完之后的判定（UX08）。
 *
 * 为什么单独成模块：这条判据要回答的问题是「这次修改到底算不算存上了」，
 * 而它此前写在组件的 `try/finally` 里，只有一条路会被当成成功——
 * 连**目标记录已经不存在**（一个字符都没写进去）也会照常刷新并收起编辑器，
 * 作者看到界面回到新值就以为改好了（2026-10-27 实测确认的假成功）。
 *
 * 抽成纯函数有三个好处：
 * ① 判定可以被单测钉住，不用靠「驱动设定检索面板」这种三层前置的真机路径；
 * ② 组件里只剩「拿到 written / error 之后照着办」，不会再各写一套；
 * ③ 文案集中一处，失败原因不会这一处说「没写入」、那一处说「保存成功」。
 */

/** 写失败/未写入时的对外说明（作者能照着做，不承诺"已保存"） */
export const FIELD_SAVE_MISSING = '这条设定已经不在了，本次修改没有写入。请关掉编辑后重新检索。'

export type FieldSaveOutcome =
  | { ok: true }
  | { ok: false; kind: 'missing' | 'failed'; message: string }

/**
 * 判定一次内联保存的结果。
 * 🔴 `written` 必须是**真的写进去了**（记录找到且 await 成功），不能拿「点了保存」当依据；
 *    传 `false` 只有两种正当理由：目标记录不存在，或者写入抛错（`error`）。
 */
export function describeFieldSave(input: { written: boolean; error?: unknown }): FieldSaveOutcome {
  if (input.written) return { ok: true }
  if (input.error !== undefined) {
    const raw = input.error instanceof Error ? input.error.message : String(input.error)
    return { ok: false, kind: 'failed', message: `本次修改未确认保存：${raw}` }
  }
  return { ok: false, kind: 'missing', message: FIELD_SAVE_MISSING }
}

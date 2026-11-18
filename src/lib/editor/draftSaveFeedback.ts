/**
 * 草稿保存反馈的状态映射（3.6.1 · B7 从 `DraftSaveFeedback` 抽出）。
 *
 * 【为什么这四态必须钉住】这一行是章后整理与自动保存验收的**唯一观察点**：
 * 作者看到的「已提交 / 还有修改待保存 / 正在提交 / 失败」四句话，
 * 决定了他是继续写、还是去手动保存、还是以为已经存好了。
 * 🔴 优先级不能换：**有错误先说错误**（错误时即使还在保存也要给重试入口），
 *    其次「正在提交」，再次「还有修改」，最后才是「已提交」；三者都不成立时**整行不显示**。
 *
 * 🔴 语义边界（组件注释原话）：本页「已提交」≠ 后端最终写入成功 —— 后者要看存储区回执。
 */
export type DraftSaveFeedbackKind = 'error' | 'submitting' | 'pending' | 'submitted' | 'hidden'

export interface DraftSaveFeedbackState {
  /** 页面级错误信息（空串 = 没有错误） */
  error: string
  saving: boolean
  submitted: boolean
  dirty: boolean
}

export function draftSaveFeedbackOf(state: DraftSaveFeedbackState): { kind: DraftSaveFeedbackKind; text: string } {
  if (state.error) return { kind: 'error', text: state.error }
  if (state.saving) return { kind: 'submitting', text: '正在提交本次修改…' }
  if (state.dirty) return { kind: 'pending', text: '还有修改待保存。' }
  if (state.submitted) return { kind: 'submitted', text: '本页修改已提交；最终写入状态请查看存储区。' }
  return { kind: 'hidden', text: '' }
}

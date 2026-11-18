/**
 * 角色卡「基本」区块的两处判定（3.6.1 · B7 从 `TavernCardBasics` 抽出）。
 *
 * 【为什么抽这两处】
 *   ① 数值备注：空串必须**删键**，不能留 `''`。留空串会让「模型会读取备注」的注入逻辑
 *      读到一堆空备注，提示词变长却没有任何信息，且界面上分不清「没写」与「写了空的」。
 *   ② 数值输入框的默认值：`num` 型未填时显示初始值（作者看到 50 而不是空白），
 *      `text` 型未填时留空 —— 写反了会让文本项显示成「0」。
 */
import type { VarDef } from '@/lib/tavern/types'

/** 数值备注：trim 后为空则删键（不留空串），否则写入 trim 后的文本 */
export function applyVarNote(notes: Record<string, string>, key: string, raw: string): Record<string, string> {
  const next = { ...notes }
  const text = raw.trim()
  if (text) next[key] = text
  else delete next[key]
  return next
}

/** 数值输入框的 defaultValue：数字型未填时显示初始值，其它类型留空 */
export function varInputDefaultValue(def: Pick<VarDef, 'kind' | 'init'>, value: unknown): string {
  const filled = value !== undefined && value !== null && value !== ''
  if (filled) return String(value)
  return def.kind === 'num' ? String(def.init) : ''
}

/** 归属故事提示的两种状态：自由状态要说清代价，已归属只需说明来源 */
export function cardStoryHint(storyId: string): 'free' | 'bound' {
  return storyId ? 'bound' : 'free'
}

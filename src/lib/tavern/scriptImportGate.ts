/**
 * 故事剧本导入弹窗的「能不能点」判定（3.6.1 · B7 从 `TavernScriptImportDialog` 抽出）。
 *
 * 【为什么抽】解析、冲突检测、追加语义都在 `lib/tavern/storyImport`（有全量单测），
 * 组件里唯一容易写歪的是那颗主按钮：五种情况各有一句话，顺序错了会给作者错的理由
 * （最典型：明明有重名冲突，却说「先选一个目标故事」）。
 * 抽出来后顺序与文案都被测试钉住，组件只负责渲染。
 */
export type ScriptImportMode = 'create' | 'append'

export interface ScriptImportGateInput {
  mode: ScriptImportMode
  parsedOk: boolean
  busy: boolean
  targetStoryId: string
  conflictCount: number
  /** 追加模式下这份文本还有没有可追加的内容（世界设定不导入 ⇒ 只有设定就等于没内容） */
  nothingToAppend: boolean
  /** 目标故事显示名（仅用于「补进《…》」那句标题） */
  targetLabel: string
}

/**
 * 🔴 `busy` 只影响**能不能点**，不改变提示语：
 *    3.6.1 之前的实现里，忙的时候标题仍然是「把上面解析出来的内容建成一个新故事」，
 *    这里逐字保留（改文案属产品决定）。
 */
export function decideScriptImportGate(input: ScriptImportGateInput): { canGo: boolean; title: string } {
  if (!input.parsedOk) return { canGo: false, title: '先粘贴符合模板的文本' }
  if (input.mode === 'create') {
    return { canGo: !input.busy, title: '把上面解析出来的内容建成一个新故事' }
  }
  if (!input.targetStoryId) return { canGo: false, title: '先选一个目标故事' }
  if (input.conflictCount > 0) return { canGo: false, title: '先按上面的清单改名，再追加' }
  if (input.nothingToAppend) return { canGo: false, title: '这份文本里没有可追加的内容' }
  return { canGo: !input.busy, title: `把这些词条与剧本补进「${input.targetLabel}」` }
}

/** 两个结局各自的回执人话（含「世界设定已忽略」这句如实告知） */
export function scriptImportResultText(input: {
  mode: ScriptImportMode
  storyLabel: string
  entryCount: number
  scriptCount: number
  ignoredSettingChars: number
}): string {
  const counts = `词条 ${input.entryCount} 条 · 剧本 ${input.scriptCount} 份`
  if (input.mode === 'create') return `已导入「${input.storyLabel}」：${counts}`
  return `已追加到「${input.storyLabel}」：${counts}${input.ignoredSettingChars ? '（文本里的世界设定已忽略）' : ''}`
}

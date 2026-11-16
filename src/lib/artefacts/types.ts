/**
 * 作者成果记录 · 类型（3.6.0 · A 包）
 *
 * 依据：`docs/3.6.0-M0-数据与执行台账现状盘点-2026-11-17.md` 第 6 节。
 *
 * 🔴 三个概念必须分清（混了就会出现「任务成功＝成果已保存」这种假绿灯）：
 *    · **执行台账**（`taskHeads`/`taskUnits`）：本机一次运行的结果，不进项目包、不随云同步；
 *    · **作者成果**（本文件）：作者显式点「保存为成果」后才存在的项目级资料，随项目包与备份走；
 *    · **正式数据**（正文/设定/大纲）：作者确认后写进各自 store，成果无权自动写。
 *
 * 本文件只放类型，不 import 任何运行时模块（便于被 db 层与 UI 同时引用而不成环）。
 */

/** 成果种类：与 3.6.0 的 B/C/D/F 四个工作包一一对应 */
export type ArtefactKind = 'analysis' | 'reference' | 'review' | 'candidate'

/**
 * 作者对这条成果的处置。
 * · `draft`   —— 生成后还没审；
 * · `kept`    —— 作者保留（进入项目包与备份的“成果”本体）；
 * · `excluded` —— 作者排除（保留记录但不再展示/发送，可批量清理）。
 */
export type ArtefactState = 'draft' | 'kept' | 'excluded'

/** 来源定位：用于「结果是否过期」判定，**不存原文** */
export interface ArtefactSource {
  /** 来源页签（如 races / history） */
  tabId?: string
  chapterId?: string
  rowId?: string
  cardId?: string
  /** UTF-16 半开区间，按**原始字符串**计位（与 JS 字符索引一致） */
  range?: [number, number]
  /** 短引（≤200 字符）；用于人工核对，不当作全文备份 */
  quote?: string
  /** 强摘要 + 长度（见 M0 §15.2；短哈希不得单独作为过期判据） */
  fingerprint: string
}

/** 本次实际读取过的依赖（不是项目全部内容） */
export interface ArtefactDep {
  kind: 'chapter' | 'setting' | 'outline' | 'reference' | 'anchor'
  id: string
  fingerprint: string
}

/** 过期标记：结果仍可读，但**不得直接应用** */
export interface ArtefactStale {
  at: number
  reason: 'source-changed' | 'dep-changed' | 'version-unknown'
}

export interface ArtefactRecord {
  /** 稳定 id（uid）；导入时换新，避免跨项目冲突 */
  id: string
  kind: ArtefactKind
  projectId: string
  source: ArtefactSource
  deps: ArtefactDep[]
  state: ArtefactState
  stale?: ArtefactStale
  /** 各自工作包定义的结构（分析卡 / 参考卡 / 审读摘要 / 候选） */
  payload: unknown
  createdAt: number
  updatedAt: number
}

/** 单项目全部成果（存在 `settingsKV` 的 `<projectId>::artefacts` 一个键里） */
export interface ArtefactStore {
  formatVersion: 1
  items: ArtefactRecord[]
}

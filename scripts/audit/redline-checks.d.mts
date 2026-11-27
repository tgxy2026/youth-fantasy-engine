// 3.7.5：redline-checks.mjs 的类型声明（供单测直接 import，避免带入重依赖）
export type RedlineRule =
  | 'redline.clipboard'
  | 'redline.raw-vh'
  | 'redline.svg-css-var'
  | 'redline.zindex-magic'
  | 'redline.ghost-text'
  | 'redline.ime-enter'

export interface RedlineFinding {
  rule: RedlineRule
  file: string
  line: number
  message: string
}

export declare function scanRedlinesSource(file: string, text: string): RedlineFinding[]
export declare function scanRedlines(root: string): {
  files: number
  findings: RedlineFinding[]
  stats: { findings: number }
}

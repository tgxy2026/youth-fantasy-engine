// ============ AI 能力矩阵 ============
//
// 集中定义「哪个页签接哪种 AI 能力」，避免各组件各写一套判断。
//
// 第一原则（1.5.0 起不可动摇）：
//   AI 只做锦上添花。所有页签在「未配置任何 AI 模型」时都必须完整可用——
//   AI 入口仅表现为按钮禁用 + 说明文案，绝不阻断、绝不报错、绝不影响手动填写。

import type { TabDef } from './types'
import { isVolumeLedgerTab } from './schema'

export type AICapability =
  /** AI 补全：把作者的粗略草图整理并补全成完整设定（用于凭空建档的实体） */
  | 'fill'
  /** AI 整理：从已有数据 / 章节正文中抽取结构化条目，增量补充且不重复已有条目 */
  | 'organize'
  /** 不接 AI 写入 */
  | 'none'

/**
 * 不接 AI 写入的分组：
 * - 大纲规划（全书总纲 / 章节总表 / 分卷大纲 / 章节细纲）：属作者的核心创作决策，
 *   由 AI 代填反而绑手脚。需要脑暴时去「灵感启发 → AI 辅助规划」对话讨论更合适。
 * - 运营维护（写作规范 / 设定变更 / 灵感素材 / 读者反馈）：作者自己的规范与运营台账，
 *   AI 无从代笔。
 */
const NO_AI_GROUPS = ['大纲规划', '运营维护']

/**
 * 走「AI 整理」的表：内容本质是「从已写正文里沉淀出的叙事事实」，
 * 适合让模型读正文后增量抽取，而非凭空补全。
 */
const ORGANIZE_TAB_IDS = new Set([
  'relations',    // 人物关系
  'foreshadow',   // 伏笔追踪
  'timeline',     // 时间脉络
  'hookpoints',   // 爽点节奏
  'subplots',     // 支线剧情
  'secrets',      // 知情权限
])

/**
 * 明确不接 AI 的个别页签（即使所属分组允许）：
 * - progress 写作进度：纯码字统计流水（日期 / 实际字数 / 存稿缓冲），
 *   由作者与系统统计填写，AI 既无从抽取也无从补全，接上只会误导。
 */
const NO_AI_TAB_IDS = new Set(['progress'])

export function aiCapabilityOf(tab: TabDef): AICapability {
  if (NO_AI_TAB_IDS.has(tab.id)) return 'none'
  // 章节总表：虽属「大纲规划」组，但本质是串联伏笔/时间脉络/爽点的叙事主轴，
  // 适合从已写正文/细纲自动抽取「出场人物 / 埋设·回收伏笔编号」等，故特批为 organize。
  if (tab.id === 'chapter-master' || isVolumeLedgerTab(tab.id)) return 'organize'
  if (NO_AI_GROUPS.includes(tab.group)) return 'none'
  if (ORGANIZE_TAB_IDS.has(tab.id)) return 'organize'
  return 'fill'
}

/** 未配置模型时，所有 AI 入口按钮的统一禁用提示 */
export const AI_DISABLED_HINT =
  '需先接入 AI 模型：到「灵感启发 → AI 辅助规划 → 模型设置」添加本地 Ollama 或联网模型即可启用。' +
  '（未接入不影响本页任何手动填写功能）'

/**
 * 「AI 整理」判重用的关键列：这些列的值组合相同即视为同一条，不重复写入。
 * 未列出的表回退为「首个非编号列」。
 */
const ORGANIZE_KEYS: Record<string, string[]> = {
  relations: ['人物A', '人物B'],
  foreshadow: ['伏笔内容'],
  timeline: ['章节号'],
  hookpoints: ['章节号', '爽点内容'],
  subplots: ['支线名称'],
  secrets: ['秘密内容', '知情者'],
  'chapter-master': ['章节标题'],
}

/** 该表用于判重的列名（已过滤为实际存在的列） */
export function organizeKeyColumns(tab: TabDef): string[] {
  const cols = tab.columns ?? []
  const named = ORGANIZE_KEYS[tab.id]
  if (named) {
    const exist = named.filter(n => cols.some(c => c.name === n))
    if (exist.length > 0) return exist
  }
  const first = cols.find(c => c.name !== '编号' && c.name !== '章节号')
  return first ? [first.name] : []
}

/** 关系网这类「无序对」表：判重时 A-B 与 B-A 视为同一条关系 */
export function isUnorderedPairTab(tabId: string): boolean {
  return tabId === 'relations'
}

/** 「AI 整理」面板的引导文案（各表语境不同，给作者明确预期） */
export function organizeHint(tabId: string): string {
  if (tabId === 'chapter-master' || isVolumeLedgerTab(tabId)) {
    return '让 AI 从已写章节正文 / 细纲中，抽取尚未登记到本卷章节台账的条目（一句话事件、出场人物、埋设/回收伏笔编号等）。'
  }
  switch (tabId) {
    case 'relations':
      return '让 AI 读取角色卡与章节正文，整理出尚未登记的人物关系（已有关系不会重复生成）。'
    case 'foreshadow':
      return '让 AI 从章节正文中找出已埋下但尚未登记的伏笔线索。'
    case 'timeline':
      return '让 AI 从章节正文中提取时间流逝线索，补登尚未记录的章节。'
    case 'hookpoints':
      return '让 AI 从章节正文中识别爽点与章末钩子，补登尚未记录的条目。'
    case 'subplots':
      return '让 AI 从章节正文与已有设定中梳理正在推进的支线，补登尚未登记的线索。'
    case 'secrets':
      return '让 AI 从章节正文中找出"谁知道了什么秘密"，补登尚未登记的知情关系。'
    case 'chapter-master':
      return '让 AI 从已写章节正文 / 细纲中，抽取尚未登记到章节总表的条目（一句话事件、出场人物、埋设/回收伏笔编号等）。'
    default:
      return '让 AI 从已有数据与章节正文中抽取尚未登记的条目。'
  }
}

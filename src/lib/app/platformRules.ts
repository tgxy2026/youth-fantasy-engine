// ============ 分平台投稿规则（C4 · 2.4.2） ============
//
// 🔴 立场与边界（三条，动本文件前先读）：
//   1. 这里只描述「各平台通常更关注哪几类内容」这类**结构性差异**，不做风险打分、不评优劣、不判能否发布；
//   2. 平台规则（含 AI 使用口径）**随时会变**，所有文案都标注「以平台后台 / 最新公告为准」；
//   3. 本模块**不做任何降低检出率的事** —— 与「创作主权存证 + 如实申报」的产品立场一致。
import type { SensitiveHit } from '@/lib/editor/sensitiveWords'

export type PlatformId = 'general' | 'jjwxc' | 'qidian'

export interface PlatformRule {
  id: PlatformId
  name: string
  /** 该平台通常**更关注**的内置词库类别（其余类别仍会扫，只是不标「重点关注」） */
  focusCategories: string[]
  /** 投稿提示：只写结构性事实与「以官方为准」的提醒，不写应对策略 */
  notes: string[]
  /** 建议单章字数区间（**参考输入**，软件不据此判定达标） */
  suggestWordRange: [number, number]
}

export const PLATFORM_RULES: PlatformRule[] = [
  {
    id: 'general',
    name: '通用',
    focusCategories: ['涉毒', '涉暴涉恐', '赌博', '色情低俗', '违法行为', '未成年人保护'],
    notes: ['不针对某一平台：全部类别同等对待，适合先过一遍再按目标平台细看。'],
    suggestWordRange: [2000, 6000],
  },
  {
    id: 'jjwxc',
    name: '晋江',
    // 晋江对性描写与未成年人相关内容的审核口径，业内公认为最严一档
    focusCategories: ['色情低俗', '未成年人保护', '涉毒', '涉暴涉恐'],
    notes: [
      '晋江对性描写、未成年人相关内容与敏感题材的审核通常是全网最严一档，这几类建议重点复核。',
      'AI 使用口径（2026-08 核查，规则随时变）：晋江对 AI 参与写作的限制最严，据公开说明仅允许校对 / 要素整理 / 粗纲一类辅助。',
      '以上均以晋江后台与最新公告为准 —— 本面板只做提示，不构成任何判定。',
    ],
    suggestWordRange: [3000, 8000],
  },
  {
    id: 'qidian',
    name: '起点',
    focusCategories: ['涉毒', '涉暴涉恐', '赌博', '违法行为'],
    notes: [
      '起点的审核重心通常在涉黑涉恶、赌博、违法流程描写一类，这几类建议重点复核。',
      'AI 使用口径（2026-08 核查，规则随时变）：起点要求如实申报 AI 参与情况，占比与人工改写比例都有要求。',
      '以上均以起点后台与最新公告为准 —— 本面板只做提示，不构成任何判定。',
    ],
    suggestWordRange: [2000, 5000],
  },
]

/** 按 id 取规则；未收录的 id 一律回落到通用档（新增平台前先在这里登记） */
export function platformRuleOf(id: PlatformId | string): PlatformRule {
  return PLATFORM_RULES.find(r => r.id === id) ?? PLATFORM_RULES[0]
}

/** 命中是否落在「该平台重点关注」的类别里（自定义词一律视为重点关注） */
export function isFocused(rule: PlatformRule, category: string): boolean {
  return category === '自定义' || rule.focusCategories.includes(category)
}

export interface PlatformHit extends SensitiveHit {
  /** 所属内置类别（自定义词为「自定义」） */
  category: string
  /** 是否属于该平台重点关注的类别 */
  focused: boolean
}

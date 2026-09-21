/**
 * 敏感词检测（参考橙瓜码字 / 作家助手「违禁词检测」）
 * 内置一份基础演示词库（毒品/暴恐/色情低俗/赌博/其他高危），
 * 主要靠用户在「检查工具」页导入平台官方词库或手动补充自定义词。
 */

import { contextSnippet } from './contextSnippet'

/** 内置基础词库（按类别）。刻意从简：真实平台词库请自行导入。 */
export const BUILTIN_WORDS: Record<string, string[]> = {
  涉毒: ['冰毒', '海洛因', '可卡因', '大麻', '摇头丸', '制毒', '贩毒', '吸毒', '罂粟', '鸦片'],
  涉暴涉恐: ['炸弹', '炸药', '雷管', '自制枪', '枪支买卖', '买凶', '杀人方法', '制式武器', '军火'],
  赌博: ['赌球', '赌场', '地下六合彩', '开盘坐庄', '高利贷', '放贷收数'],
  色情低俗: ['一夜情', '约炮', '嫖娼', '卖淫', '援交', '乱伦', '嫖资'],
  违法行为: ['洗钱', '行贿', '受贿', '走私', '人口买卖', '绑架勒索', '电信诈骗'],
  未成年人保护: ['未成年人饮酒', '教唆自杀', '自残教程'],
}

export interface SensitiveHit {
  word: string
  count: number
  /** 首次出现的上下文（前后各 12 字） */
  context: string
}

/** 扫描文本，返回命中列表（按出现次数降序） */
export function scanText(text: string, customWords: string[] = []): SensitiveHit[] {
  const words = new Set<string>()
  for (const list of Object.values(BUILTIN_WORDS)) for (const w of list) words.add(w)
  for (const w of customWords) {
    const t = w.trim()
    if (t) words.add(t)
  }
  const hits: SensitiveHit[] = []
  for (const word of words) {
    let count = 0
    let firstIdx = -1
    let idx = text.indexOf(word)
    while (idx !== -1) {
      if (count === 0) firstIdx = idx
      count++
      idx = text.indexOf(word, idx + word.length)
    }
    if (count > 0) {
      hits.push({ word, count, context: contextSnippet(text, firstIdx, word.length) })
    }
  }
  return hits.sort((a, b) => b.count - a.count)
}

/** 一键替换命中词（默认替换为 ■■）。
 * 按词长降序替换：先处理较长的词，避免「短词包含于长词」时短词先被替换、
 * 导致长词残留（如先替换「赌博」→■■，再找不到「网络赌博」）。 */
export function replaceHits(text: string, hits: SensitiveHit[], token = '■■'): string {
  let out = text
  for (const h of [...hits].sort((a, b) => b.word.length - a.word.length)) {
    out = out.split(h.word).join(token)
  }
  return out
}

// ============ 自定义敏感词（settingsKV::customSensitiveWords 跨项目共享） ============
import * as db from './db'

export async function getCustomSensitiveWords(): Promise<string[]> {
  return db.getSetting<string[]>('customSensitiveWords', [])
}

export async function setCustomSensitiveWords(list: string[]): Promise<void> {
  await db.setSetting('customSensitiveWords', list)
}

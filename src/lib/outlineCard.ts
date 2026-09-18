/**
 * 《章节细纲》卡的**命名与解析** —— 唯一来源。
 *
 * 【为什么单独一个模块】
 * 细纲卡的卡名是「第N章 标题」这条约定，被三处用到：`aiWorkflow.commitOutline` 写卡名、
 * `loadChapterOutlines` 按卡名取章号、正文概要回填时按章号匹配。三处各自拼一次字符串或写一次正则，
 * 就一定会漂移 —— 而漂移的表现是「细纲读不回来」，两边看着却都对（红线里的经典坑）。
 * 所以把拼法与解析收在这里。
 *
 * ⚠️ 这是**卡名**约定，不是"章节标题里有没有章号"。后者在 `chapterSeq` 里是刻意**不解析**的
 *   （作者把章名叫「序章」「番外·铁柱传」都不影响叙事顺序）。别把两者混为一谈。
 */
import { resolveSlot } from './flow/fieldMap'

/** 细纲卡所在的页签 id */
export const OUTLINE_TAB_ID = 'chapter-outline'

/** 「本章一句话事件」的**语义**槽位名；真键（`模块::字段`）用 `outlineEventKey()` 现查 */
export const OUTLINE_EVENT_SLOT = '本章一句话事件'

/** 细纲卡的标准卡名：`第3章 风云`（标题为空时退化为 `第3章`） */
export function outlineCardName(no: number, title: string): string {
  return `第${no}章 ${(title ?? '').trim()}`.trim()
}

/**
 * 从细纲卡名取章号；取不到返回 0。
 * 卡名由 `outlineCardName()` 写入，故这里只认 `第N章` 一种形态（阿拉伯数字）。
 */
export function chapterNoOf(cardName: string): number {
  const m = (cardName ?? '').match(/第\s*(\d+)\s*章/)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * 「本章一句话事件」的真实存储键（`模块::字段`）。
 * 🔴 可能返回 null（schema 改过字段名）—— 调用方必须处理，别硬写一个不存在的键，
 *    那会写出一列幽灵数据。
 */
export function outlineEventKey(): string | null {
  return resolveSlot(OUTLINE_TAB_ID, OUTLINE_EVENT_SLOT)
}

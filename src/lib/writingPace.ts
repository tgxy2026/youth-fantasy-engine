/**
 * 「创意写作」的体量推荐 —— 一轮连写多少章比较合适。
 *
 * 🔴 口径先说清（与拆书 `bookbreak/recommend.ts` 同构，但**别共用常量**，两件事的性质不同）：
 *    连写是**一章一次模型调用**，单章目标字数 2500 上下，送进模型的只有「项目设定 + 最近章节摘要」。
 *    所以**章数本身不会撞模型窗口**，不会出现"写太多导致模型读不下"。
 *    真正受限的是**总耗时** —— 本地模型每章要跑一次完整生成，一次几分钟。
 *    因此这里给的是「推荐章数 + 预计总耗时」，不是"最多能写多少章"；
 *    界面文案也必须这么写，否则作者会误以为这是个硬上限。
 *
 * 耗时为**粗估**：本地受模型大小 / 量化 / 显存影响极大，云端快而稳。区间取宽，宁保守勿乐观。
 * 参照：云端 Qwen3-30B 出一章 400 余字约 6s（见 2.2.0 体量纪律那次修复），
 * 按字数线性外推到 2500 字并留出安全边际，得到下面的系数。
 */
import type { CapacityAdvice } from '@/lib/modelCapacity'

/** 与 `runCreativeWriting` 的章数上限保持一致（界面输入框也用它） */
export const MAX_CHAPTERS = 60

/**
 * 一轮跑完的「舒服」总时长（分钟）。超过就该劝作者分段 ——
 * 不是为了保护模型，是为了保护作者的注意力：连写一小时没人盯着，写歪了也白写。
 */
export const COMFORT_MINUTES = 20

/**
 * 单章耗时的**倍率**与**附加短调用次数**。
 *
 * 🔴 口径修正（2026-09-18，读 `autoContinue` 源码核出来的，旧注释是错的）：
 *   原先这里写"一章一次调用" —— **不对**。连写一章实际会调模型 **5~8 次**：
 *     续写正文 →（去 AI 味，默认关）→ 字数校准 → **AI 编辑自检** →（发现问题则）改写修正
 *     → 二次字数校准 → 生成标题 → 生成 1/10 摘要 → 抽取并补登设定
 *   其中"续写"与"改写修正"都是长输出（各要生成一章的量），其余是短输出但各有固定开销
 *   （每次都要重新 prefill 上下文）。
 *   故：单章耗时 ≈ 一次长生成 × CHAPTER_MULTIPLIER + EXTRA_CALLS × 固定开销。
 *   实测印证：本地 27B 写一章（目标 800 字）**2~4 分钟**；按旧口径（一次调用）会低估 3 倍以上。
 */
const CHAPTER_MULTIPLIER = 2.2
const EXTRA_CALLS = 4

/** 一次长生成的耗时（秒）：固定开销 + 按千字线性增长。输入侧开销不随字数变，故拆成两项。 */
function secPerChapter(cap: CapacityAdvice, targetWords: number): [number, number] {
  const k = Math.max(0.2, targetWords / 1000) // 千字
  const fixed = cap.local ? 25 : 8
  const perK: [number, number] = cap.local ? [30, 70] : [8, 20]
  const one: [number, number] = [fixed + k * perK[0], fixed + k * perK[1]]
  return [
    Math.round(one[0] * CHAPTER_MULTIPLIER + EXTRA_CALLS * fixed),
    Math.round(one[1] * CHAPTER_MULTIPLIER + EXTRA_CALLS * fixed),
  ]
}

export interface PaceAdvice {
  /** 推荐连写章数（按"一轮别超过 COMFORT_MINUTES"倒推，保守取慢的那一侧） */
  recommendedChapters: number
  /** 按**作者当前填的章数**估算的总耗时（分钟） */
  minutes: [number, number]
  /** 单章耗时区间（秒）—— 界面解释"为什么是这个推荐值"时用 */
  secPerChapter: [number, number]
  /** ok＝舒服 / large＝偏长，建议分段 / long＝很长，先跑几章试试 */
  level: 'ok' | 'large' | 'long'
  /** 当前模型一句话描述（来自模型能力推算） */
  model: string
  /** 给作者看的人话说明 */
  note: string
}

/**
 * 按模型能力 + 作者当前设定给出体量建议。
 * @param chapters    作者当前填的连写章数
 * @param targetWords 每章目标字数
 */
export function advisePace(
  cap: CapacityAdvice,
  opts: { chapters: number; targetWords: number },
): PaceAdvice {
  const chapters = Math.max(1, Math.min(MAX_CHAPTERS, Math.round(opts.chapters) || 1))
  const per = secPerChapter(cap, opts.targetWords)
  const minutes: [number, number] = [
    Math.max(1, Math.round((chapters * per[0]) / 60)),
    Math.max(1, Math.round((chapters * per[1]) / 60)),
  ]
  // 保守取慢侧：宁可少写几章，也不要让人开了就跑一小时。
  const recommendedChapters = Math.max(1, Math.min(MAX_CHAPTERS, Math.floor((COMFORT_MINUTES * 60) / per[1])))
  const level: PaceAdvice['level'] = chapters <= recommendedChapters
    ? 'ok'
    : chapters <= recommendedChapters * 2 ? 'large' : 'long'
  // 区间两端相同时只写一个数（"预计 1~1 分钟"看着像 bug）
  const time = minutes[0] === minutes[1] ? `${minutes[0]} 分钟` : `${minutes[0]}~${minutes[1]} 分钟`
  // 口径说明放在**所有档位**都出现的位置：它回答的是"这个数是不是硬上限"，
  // 而作者恰恰在最想多写（也就是 large/long 档）时最需要知道"不是"。
  const base = '连写一章要跑 5~8 次模型调用（续写、编辑自检、字数校准、标题、摘要、设定抽取），一次一章、不受模型窗口限制。'
  const note = level === 'ok'
    ? `预计 ${time}。${base}`
    : level === 'large'
      ? `预计 ${time} —— 偏长。${base}建议先写 ${recommendedChapters} 章看看文风对不对味，满意了再多写几章。`
      : `预计 ${time} —— 很长，中途容易写飘。${base}建议改成 ${recommendedChapters} 章一轮，分几轮跑（每轮之间可以停下来自己改）。`
  return {
    recommendedChapters,
    minutes,
    secPerChapter: per,
    level,
    model: cap.headline,
    note,
  }
}

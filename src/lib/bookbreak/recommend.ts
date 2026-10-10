/**
 * 拆书的「导入量 + 耗时」推荐。
 *
 * 🔴 口径必须先说清（老大 2026-09-18 需求：「按模型处理能力推荐导入数据量」）：
 *    拆书是**逐章 / 逐块**抽取 —— 单次发给模型的只有**一章**（≤ `maxUnitChars`，默认 4000 字），
 *    所以**导入量本身不会撞模型窗口**，不会出现"喂太多导致模型处理不了"。
 *    真正受限的是**调用次数与总耗时**（一章一次调用）。
 *    因此这里给的是「推荐单次导入字数 + 预计调用次数 + 预计耗时」，而不是"最多能喂多少字"；
 *    界面文案也必须这么写，否则用户会误以为这是一锤子读完。
 *    （唯一真受窗口硬限的是"一次读完整本给整体判断"那种整体性抽取，本流程不做。）
 *
 * 耗时为**粗估**：本地受模型大小/显存影响很大，云端快而稳。区间取宽，宁保守勿乐观。
 */
import type { CapacityAdvice } from '@/lib/modelCapacity'
import type { SplitResult } from '@/lib/bookbreak/split'

/**
 * 单次抽取的粗估耗时（秒）。
 *
 * 🔴 B2（全字段抽取）之后每章输出从「专名+一句话描述」涨到**每条十几个字段**，
 *    单次调用明显变长：2026-09-18 用云端 Qwen3-30B-Instruct 实测示范项目 6 章
 *    （9 个抽取单元）共用 456.6s ≈ **51s/次**。旧口径（云端 8~18s）已低估 3~6 倍，
 *    故这里整体上调；区间取宽，宁保守勿乐观（本地 27B 受显存/量化影响更大）。
 */
function secPerCall(cap: CapacityAdvice): [number, number] {
  return cap.local ? [60, 150] : [25, 60]
}

/** 一轮跑完的「舒服」调用次数上限：超过就建议分段 */
export const COMFORT_CALLS = 40
/** 单轮的硬顶（与 run.ts 的 maxUnits 默认值一致） */
export const HARD_CALLS = 120

export interface ImportAdvice {
  /** 预计调用次数（按切分结果算） */
  calls: number
  /** 单次喂给模型的字数上限（一章/一块） */
  unitChars: number
  /** 预计耗时区间（分钟） */
  minutes: [number, number]
  /** 推荐单次导入的字数上限 */
  recommendedChars: number
  /** 推荐单次导入的章数上限 */
  recommendedChapters: number
  /** 每章平均字数（推荐值的依据） */
  avgChapterChars: number
  /** ok＝放心跑 / large＝建议先试跑一段 / too-large＝会被截断，必须拆分 */
  level: 'ok' | 'large' | 'too-large'
  /** 当前模型一句话描述（来自模型能力推算） */
  model: string
  /** 给用户看的人话说明 */
  note: string
}

/**
 * 按切分结果 + 模型能力给出导入建议。
 * @param maxUnitChars 单个抽取单元的字符上限（与 run.ts 保持一致）
 * @param maxUnits 抽取单元数上限（与 run.ts 保持一致）
 */
export function adviseImport(
  sp: SplitResult,
  cap: CapacityAdvice,
  opts: { maxUnitChars?: number; maxUnits?: number } = {},
): ImportAdvice {
  const unitChars = opts.maxUnitChars ?? 4000
  const maxUnits = opts.maxUnits ?? HARD_CALLS
  const count = Math.max(0, sp.chapters.length)
  // 🔴 分级要用**未钳制**的次数判断：钳完再比 `calls > maxUnits` 恒为 false，
  //    会让"超出上限、会被截断"这种最该警告的情况反而报成"偏多"（测试抓到过）。
  let rawCalls = 0
  for (const ch of sp.chapters) rawCalls += Math.max(1, Math.ceil(ch.text.length / unitChars))
  const calls = Math.min(rawCalls, maxUnits)
  const avg = count > 0 ? Math.round(sp.stats.chars / count) : 3000
  const [lo, hi] = secPerCall(cap)
  const minutes: [number, number] = [
    Math.max(1, Math.round((calls * lo) / 60)),
    Math.max(1, Math.round((calls * hi) / 60)),
  ]
  const level: ImportAdvice['level'] = rawCalls > maxUnits || sp.stats.truncated
    ? 'too-large'
    : calls > COMFORT_CALLS ? 'large' : 'ok'
  const time = `${minutes[0]}~${minutes[1]} 分钟`
  const note = level === 'ok'
    ? `预计 ${calls} 次模型调用，约 ${time}。逐章抽取、单次只喂一章，不受模型窗口限制。`
    : level === 'large'
      ? `预计 ${calls} 次模型调用，约 ${time} —— 偏多。建议先导入 5~10 万字试跑一轮，确认抽取质量后再上整本。`
      : `超出单轮处理上限（${maxUnits} 块），本轮只会处理前面的部分。请把原文拆成几份分别导入，或先导入其中一段。`
  return {
    calls,
    unitChars,
    minutes,
    recommendedChars: COMFORT_CALLS * avg,
    recommendedChapters: COMFORT_CALLS,
    avgChapterChars: avg,
    level,
    model: cap.headline,
    note,
  }
}

/**
 * 拆书末尾「全书级设定汇总」的材料拼装。
 *
 * 【为什么用"已抽出的实体"当输入，而不是把原文整本再喂一遍】
 * 前面的抽取阶段已经逐章读懂过原文（B2 全字段：身份定位 / 境界 / 类别 / 剧情作用…），
 * 拿它当汇总输入比重读几十万字便宜两个数量级，而且专名天然与已落库设定一致 ——
 * 重新读一遍反而容易冒出"新造的写法"。原文只截取**开头一段**当题材样本：
 * 开篇最能定调性（世界名、体系名、主角处境、赛道，多半都在前几百字里）。
 *
 * 🔴 材料必须有上限。汇总是一次调用，把几千条实体原样塞进去必然撞窗口 ——
 *    而撞窗口的表现是**静默截断**（模型只看到前半段却照样输出得很像样）。
 *    所以按"类目聚合 + 每类取前 N 条 + 单条截断 + 总量封顶"层层收口，并在超限时**明说已省略**。
 */
import type { SettingEntityType } from '@/lib/ai/aiTasks'
import type { EntityBatch } from '@/lib/flow/draft'

export interface FormMaterialOptions {
  /** 每个类目最多带多少条（默认 40） */
  perType?: number
  /** 单条实体最多多少字（默认 120） */
  perEntityChars?: number
  /** 原文开头截取多少字（默认 600） */
  rawHeadChars?: number
  /** 材料总字数上限（默认 8000） */
  maxChars?: number
}

/** 类目展示顺序（人物 → 势力 → 地点 → 种族 → 物品 → 术语）——与实体类型枚举一致 */
const TYPE_ORDER: SettingEntityType[] = ['人物', '势力', '地点', '种族', '物品', '术语']

/** 单条实体 → 一行文本（别称与全字段都带上：汇总要的正是这些信息） */
function formatEntity(e: { name: string; desc?: string; aliases?: string[]; fields?: Record<string, string> }, limit: number): string {
  const alts = e.aliases?.length ? `（别称：${e.aliases.join('、')}）` : ''
  const detail = e.fields
    ? Object.entries(e.fields)
      .filter(([, v]) => (v ?? '').trim())
      .map(([k, v]) => `${k}=${v}`)
      .join('；')
    : ''
  const body = [e.desc, detail].filter(Boolean).join('；')
  return `- ${e.name}${alts}${body ? `：${body}` : ''}`.slice(0, limit)
}

/**
 * 拼出汇总阶段的输入材料。
 * @param batches 抽取阶段产出的实体批次
 * @param rawHead 原文开头（只取前 `rawHeadChars` 字当题材样本）
 */
export function buildFormMaterial(
  batches: EntityBatch[],
  rawHead = '',
  opts: FormMaterialOptions = {},
): string {
  const perType = opts.perType ?? 40
  const perEntityChars = opts.perEntityChars ?? 120
  const rawHeadChars = opts.rawHeadChars ?? 600
  const maxChars = opts.maxChars ?? 8000

  const byType = new Map<SettingEntityType, string[]>()
  for (const b of batches) {
    for (const e of b.entities) {
      if (!e?.name?.trim()) continue
      const arr = byType.get(e.type) ?? []
      if (arr.length >= perType) continue // 每类只取前 N 条（材料是"代表作"，不是全量清单）
      arr.push(formatEntity(e, perEntityChars))
      byType.set(e.type, arr)
    }
  }

  const parts: string[] = []
  const head = (rawHead ?? '').trim()
  if (head) parts.push(`〖开篇原文样本〗\n${head.slice(0, rawHeadChars)}`)
  for (const type of TYPE_ORDER) {
    const lines = byType.get(type)
    if (!lines?.length) continue
    parts.push(`〖${type}〗（${lines.length} 条）\n${lines.join('\n')}`)
  }

  let out = parts.join('\n\n')
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（材料过长，后面已省略）`
  return out
}

/**
 * 3.2.0 · WQ8 证据守卫（抽取实体的原文依据核验）
 *
 * 方案 §16.9 / §M3：「证据/文本守卫先行接入」「未检如实显示、**伪造证据被拒**」。
 *
 * 这里核验的是**设定抽取**返回的 `evidence` 字段：模型被要求附上「原文原句」，
 * 但实际会顺手编一句看着很像的话。**编造的证据比没有证据更糟** ——
 * 作者看到"原文：王铁柱提锤走来"会以为这句话真在正文里，于是放弃自己核对。
 *
 * 🔴 判定口径（刻意保守，宁可漏判也不冤枉）：
 *  · `quoted`      —— 证据原文逐字出现在正文里；
 *  · `paraphrased` —— 去掉标点/空白后命中，或证据的前 12 个字命中（模型常把引文截短、加省略号）；
 *  · `missing`     —— 都对不上（大概率是编的，但也可能是模型大改写过）；
 *  · `empty`       —— 本来就没给证据（创意写作/设定奠基是凭种子生成，无原文，属正常）。
 *
 * ⚠️ **不据此丢弃实体**：`missing` 也可能是模型把两句话合并转述了。丢弃会丢真信息，
 *    所以本模块只**如实报告**，由调用方决定怎么提示作者；真要"拒收"，需要作者确认。
 */

export type EvidenceState = 'quoted' | 'paraphrased' | 'missing' | 'empty'

export interface EvidenceItem {
  /** 实体名（便于作者定位是哪一条） */
  name: string
  state: EvidenceState
  /** 引文（截断到 40 字，够辨认即可） */
  quote: string
}

export interface EvidenceReport {
  total: number
  quoted: number
  paraphrased: number
  missing: number
  empty: number
  items: EvidenceItem[]
  /** 有没有真的核验过（正文为空 ⇒ 无从核验，调用方不该据此提示） */
  checked: boolean
}

/** 去掉标点/空白/常见引号，只留实义字符 —— 用来容忍模型的标点差异 */
function normalize(s: string): string {
  return s.replace(/[\s，。！？；：、“”‘’"'《》〈〉（）()【】\[\]…—\-·,.!?;:]/g, '')
}

const HEAD_CHARS = 12

/**
 * 核验一批实体的证据。
 *
 * @param body 本章正文（拆书场景则是原书章节）；空串 ⇒ `checked:false`，全部记 `empty`
 */
export function checkEntityEvidence(
  entities: readonly { name: string; evidence?: string }[],
  body: string,
): EvidenceReport {
  const text = body.trim()
  if (!text) {
    return {
      total: entities.length, quoted: 0, paraphrased: 0, missing: 0,
      empty: entities.length, items: entities.map(e => ({ name: e.name, state: 'empty' as const, quote: '' })),
      checked: false,
    }
  }
  const normBody = normalize(text)
  const items: EvidenceItem[] = []
  let quoted = 0, paraphrased = 0, missing = 0, empty = 0

  for (const e of entities) {
    const quote = (e.evidence ?? '').trim()
    if (!quote) {
      empty++
      items.push({ name: e.name, state: 'empty', quote: '' })
      continue
    }
    const brief = quote.length > 40 ? `${quote.slice(0, 40)}…` : quote
    if (text.includes(quote)) {
      quoted++
      items.push({ name: e.name, state: 'quoted', quote: brief })
      continue
    }
    const normQuote = normalize(quote)
    const head = normalize(quote).slice(0, HEAD_CHARS)
    if ((normQuote && normBody.includes(normQuote)) || (head.length >= 4 && normBody.includes(head))) {
      paraphrased++
      items.push({ name: e.name, state: 'paraphrased', quote: brief })
      continue
    }
    missing++
    items.push({ name: e.name, state: 'missing', quote: brief })
  }

  return { total: entities.length, quoted, paraphrased, missing, empty, items, checked: true }
}

/** 一句话摘要（给日志/回执用；没有问题就返回空串，别刷屏） */
export function describeEvidence(report: EvidenceReport): string {
  if (!report.checked || report.missing === 0) return ''
  const names = report.items.filter(i => i.state === 'missing').map(i => i.name).slice(0, 3).join('、')
  const more = report.missing > 3 ? ` 等 ${report.missing} 条` : ''
  return `${report.missing} 条抽取证据未在正文找到（${names}${more}，可能是模型转述或编造，建议抽查）`
}

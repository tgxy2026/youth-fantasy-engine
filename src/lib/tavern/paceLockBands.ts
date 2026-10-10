// ============ 进度锁 ↔ 数值档位：起点推断与一致性提示（W2-4 · §13 F1/F2）============
//
// 为什么有它（§13 现场证据）：卡文写着「已完全信任」，新会话数值却从 0（中立）起 ——
// 模型看到裸 0，就把角色演得像刚认识的陌生人（主人报障「十香/折纸对士道像陌生人」的成因之一）。
// 反过来，数值早已涨到「全然信赖」，卡文的进度锁还停在旧阶段，也没人提醒。
//
// 🔴 两条纪律：
//   ① **复用 `VAR_BANDS`** —— 档位名与区间都取自那张表，绝不另造一套刻度
//      （否则界面显示、扮演侧注入、本模块推断会各说各话）；
//   ② **推不出就不猜** —— 卡文为空 / 没命中任何措辞 ⇒ 返回 null，调用方保持原行为。
//
// 🔒 不扩范围（§12.3 / §13.4）：本模块**只管「起点、显示与提示」**。
//    亲密内容的解锁权仍在角色卡 `conduct.rating` / `bottomLine` / `paceLock` ——
//    不因数值升高而自动放开尺度。
import { bandOf, bandsOf, varDefOf, type VarKey, type VarValues } from './types'

/**
 * 卡文措辞 → 目标档位。
 *
 * 🔴 顺序有意义：**先匹配更具体的**（「完全信任」要排在「信任」前面，
 *    否则前者会被后者先吃掉、落到低一档）。
 * ⚠️ 只认明确表达关系阶段的措辞；「按剧情节奏」「自然推进」这类**故意不认** ——
 *    那种卡文没有给出阶段，猜出来的起点比 0 更糟。
 */
const PACE_HINTS: { re: RegExp; key: VarKey; band: string }[] = [
  // —— 信任 ——
  { re: /(完全信任|全然信赖|毫无保留|绝对信赖|无条件相信)/, key: 'trust', band: '全然信赖' },
  { re: /(建立信任|已有信任|开始信任|愿意托付|可以托付)/, key: 'trust', band: '信任' },
  { re: /(提防|戒备|戒心|不信任|互不信任)/, key: 'trust', band: '提防' },
  // —— 好感 ——
  { re: /(亲密|恋人|爱人|依赖|如胶似漆|情投意合)/, key: 'affection', band: '亲密依赖' },
  { re: /(亲近|好感|熟络|亲近起来|互有好感|朋友以上)/, key: 'affection', band: '亲近' },
  { re: /(反感|疏远|冷淡|陌生|敌对|讨厌)/, key: 'affection', band: '反感' },
]

/** 取某档的**区间中点**作为锚点（区间语义 `[from, to)`，末档闭；与 `bandOf` 同源） */
export function bandAnchorOf(key: VarKey, bandName: string): number | null {
  const bands = bandsOf(key)
  if (!bands) return null
  const b = bands.find(x => x.name === bandName)
  if (!b) return null
  return Math.round((b.from + b.to) / 2)
}

/** 卡文措辞命中的目标档（供 F1 与 F2 共用；多个命中时取**先匹配**的那个） */
export function paceLockTargets(paceLock: string): { key: VarKey; band: string }[] {
  const text = (paceLock ?? '').trim()
  if (!text) return []
  const out: { key: VarKey; band: string }[] = []
  for (const h of PACE_HINTS) {
    if (!h.re.test(text)) continue
    // 同一项只取第一条命中的（先具体后宽泛）
    if (out.some(o => o.key === h.key)) continue
    out.push({ key: h.key, band: h.band })
  }
  return out
}

/**
 * 从卡文「进度锁」推断**起始数值**（§13 F1）。
 *
 * @returns 推得出时返回 `{ affection?: n, trust?: n }`（只含命中的项）；
 *          推不出（卡文空 / 无措辞命中 / 档位名对不上）⇒ **null**（调用方保持现状）
 */
export function paceLockStartValues(paceLock: string): Partial<Record<VarKey, number>> | null {
  const targets = paceLockTargets(paceLock)
  if (!targets.length) return null
  const out: Partial<Record<VarKey, number>> = {}
  for (const t of targets) {
    const anchor = bandAnchorOf(t.key, t.band)
    if (anchor !== null) out[t.key] = anchor
  }
  return Object.keys(out).length ? out : null
}

/** 一条「卡文档位 vs 当前数值档位」的不一致 */
export interface PaceDrift {
  key: VarKey
  /** 中文名（好感 / 信任 / 精神） */
  label: string
  /** 卡文声称的阶段 */
  wantBand: string
  /** 当前数值实际落在哪一档（值缺失时为 null） */
  nowBand: string | null
}

/**
 * 一致性检查（§13 F2）：卡文声称的阶段 vs **当前数值**所在档 —— 不一致才产出。
 *
 * ⚠️ 只对**卡文明确提到**的项检查（没提的项不产出 —— 作者没表达意图，谈不上"不一致"）。
 * 🔴 本函数**只产出建议**，绝不写卡；改不改由作者裁决。
 */
export function paceLockDrift(paceLock: string, values: VarValues | undefined): PaceDrift[] {
  const targets = paceLockTargets(paceLock)
  if (!targets.length) return []
  const out: PaceDrift[] = []
  for (const t of targets) {
    const b = bandOf(t.key, values?.[t.key])
    const nowBand = b?.name ?? null
    if (nowBand === t.band) continue
    out.push({ key: t.key, label: varDefOf(t.key)?.label ?? t.key, wantBand: t.band, nowBand })
  }
  return out
}


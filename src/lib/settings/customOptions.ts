/**
 * 自定义下拉选项的「有效选项」解析（纯函数，零 React）。
 *
 * 【为什么单独放 lib 而不是留在 components/CustomSelect】
 * 这条规则决定「某一列到底有哪些合法取值」，**四个消费方必须完全一致**：
 *   ① 行内下拉（CustomSelect）
 *   ② 表头筛选下拉（TableSheet）
 *   ③ 地图图例（GeoMapEditor）
 *   ④ 「AI 整理」喂给模型的候选值（见 lib/organizeRows.ts）
 * 口径不一致的后果很具体：界面里能选的值，AI 认为不合法；或反过来说——模型返回一个
 * 界面下拉里根本不存在的值，写回表里就成了"幽灵选项"。
 *
 * 而 ④ 住在 lib（一键拆书的流水线也要用它），lib **不得反向依赖 components**（分层红线，
 * 见 tests/importCycles.test.ts），所以解析规则必须落在 lib 这一侧，组件层改为再导出。
 */
import type { CustomOptionPayload } from '@/lib/db'

export interface ResolvedOption {
  /** 展示名（内置项已应用改名） */
  name: string
  /** 内置项的原始名（用于取内置配色）；自定义项为 undefined */
  builtinOrigin?: string
  kind: 'builtin' | 'user'
}

/**
 * 按与下拉完全一致的规则算出「有效选项列表」：
 * 内置项（去掉 hidden、应用 renamed）在前，用户自定义项在后，同名去重。
 * 供图例等只读场景复用，避免各处重复实现导致口径不一致。
 */
export function resolveOptions(builtin: string[], payload: CustomOptionPayload): ResolvedOption[] {
  const renamed = payload.renamed ?? {}
  const out: ResolvedOption[] = []
  const seen = new Set<string>()
  for (const b of builtin) {
    if (payload.hidden.includes(b)) continue
    const display = renamed[b] ?? b
    if (seen.has(display)) continue
    seen.add(display)
    out.push({ name: display, builtinOrigin: b, kind: 'builtin' })
  }
  for (const u of payload.items) {
    if (seen.has(u)) continue
    seen.add(u)
    out.push({ name: u, kind: 'user' })
  }
  return out
}

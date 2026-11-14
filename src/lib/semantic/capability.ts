// ============ 语义检索 · 能力探测 ============
//
// 3.5.5：ACP 模式下引擎发不出 `/embeddings` 请求（所有模型请求都经 Agent，
// 而 `withApiModeLease` 会直接拒绝），所以「有没有配嵌入模型」**不再等于**「能不能做语义检索」。
//
// 在此之前，ACP 里语义召回会一路静默返回空 —— 界面显示「语义检索已就绪」，
// 注入里却永远没有召回段。作者无法分辨是「库里没相关内容」还是「这个模式根本做不了」。
//
// 🔴 本模块只做判断，不读向量库、不发请求、不渲染。
// 🔴 判据必须**只此一处**：注入层、设置页、索引页都调它。
//    各写一份的结果是「设置页说可用、注入层说不可用」，那比不提示更糟。
import { WEB, WEB_GUEST } from '@/lib/app/platform'
import { connectionModeStatus, hasLocalModeHost } from '@/lib/agentHost/modeBridge'

export type SemanticCapabilityMode =
  /** 真·语义检索（向量 + 余弦） */
  | 'semantic'
  /** 降级：本地词面匹配，召回率下降但能用 */
  | 'keyword'
  /** 完全不可用（既没法嵌入，也没有索引可降级） */
  | 'off'

export interface SemanticCapability {
  mode: SemanticCapabilityMode
  /** 给界面用的短语，如「语义检索」「关键词降级」 */
  label: string
  /** 为什么是当前模式；`semantic` 时为空串 */
  reason: string
  /** 是否由 ACP 模式导致（界面据此指出「切回 API 模式可恢复完整召回」） */
  byAcp: boolean
}

/** 网页版没有本机模式宿主，也就不存在 ACP —— 嵌入是否可用只取决于配置。 */
function modeOutsideAcp(): boolean {
  return WEB || WEB_GUEST || !hasLocalModeHost()
}

/**
 * 探测结果缓存。
 *
 * 🔴 为什么允许滞后：`buildSemanticRecallBlock` 在**每次构造上下文**时都会问一次，
 *    而便携版的模式查询是一次 HTTP 往返 —— 不快照的话，每次按 AI 按钮都多一个 RTT。
 *    2 秒足够覆盖同一轮里的重复询问，又短到「切成 ACP 后下一次注入就会降级」。
 *    模式切换本身有 `switching` 阶段，且语义召回只是"补一层"，这两秒的滞后不改变任何写入。
 */
const CACHE_TTL_MS = 2000
let cached: { at: number; value: SemanticCapability } | null = null

/**
 * 探测当前能用到哪一档语义检索。
 *
 * **永不抛**：读模式失败时按 `keyword` 处理 —— 宁可降级，也不能让一次探测异常
 * 把整段上下文构造打断（语义召回本来就是"补一层"）。
 */
export async function semanticCapability(): Promise<SemanticCapability> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value
  const value = await probe()
  cached = { at: now, value }
  return value
}

/** 单测用：清掉缓存，避免用例之间互相污染。 */
export function __resetSemanticCapabilityCache(): void {
  cached = null
}

async function probe(): Promise<SemanticCapability> {
  if (modeOutsideAcp()) {
    return { mode: 'semantic', label: '语义检索', reason: '', byAcp: false }
  }
  let mode: string | null = null
  try {
    const st = await connectionModeStatus()
    mode = st.mode ?? null
    // 切换中 / 阻塞 / 读不到宿主：此刻既不能确定能发嵌入，也不能确定不能
    if (st.phase !== 'stable') {
      return {
        mode: 'keyword',
        label: '关键词降级',
        reason: '连接模式正在切换或未就绪，暂时无法确认能否使用嵌入模型，已改用本地关键词匹配。',
        byAcp: false,
      }
    }
  } catch {
    return {
      mode: 'keyword',
      label: '关键词降级',
      reason: '读不到当前连接模式，已保守地改用本地关键词匹配。',
      byAcp: false,
    }
  }
  if (mode === 'acp') {
    return {
      mode: 'keyword',
      label: '关键词降级',
      reason: 'ACP 模式下所有模型请求都经 Agent，引擎发不出嵌入请求，语义召回已降级为本地关键词匹配；切回 API 模式可恢复完整召回。',
      byAcp: true,
    }
  }
  return { mode: 'semantic', label: '语义检索', reason: '', byAcp: false }
}

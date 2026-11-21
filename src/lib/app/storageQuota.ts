// ============ 存储配额（3.6.2 · W4）============
//
// 【为什么要有】本应用把整库放在一个 JSON / IndexedDB 里。配额快满时的表现很难看：
//   保存开始失败、但界面只报"保存失败"，作者往往以为是软件坏了，而不是"空间不够"。
//   提前一档提示，能让他主动导出备份、清一清旧备份，而不是在写到一半时撞墙。
//
// 🔴 三条口径（写死在这里，别在界面层再判一遍）：
//   ① `quota = 0` / 缺失 / 非有限 ⇒ **unknown**，绝不弹提示。
//      浏览器隐私模式、部分 WebView、以及 `estimate()` 未实现时都会给 0 或全 0 对象。
//      把 0 当"已用满"会天天误报，那条提示的信用一次就没了。
//   ② 阈值只有两档：`>= 95%` critical、`>= 80%` warn。80 以下不打扰。
//   ③ **判定是纯函数**。提示的"一天只提一次"是另一层（见 `quotaNotice.ts`），
//      两层分开才能各自被测。
//
// ⚠️ `navigator.storage.estimate()` 给的是**整个源**的用量（本应用 + 同源其它存储），
//   不是"本应用独占"。所以文案只能说"这个存储空间快满了"，不能说"你的作品占了 95%"。

/** 配额档位 */
export type QuotaLevel = 'ok' | 'warn' | 'critical' | 'unknown'

export interface QuotaInfo {
  /** 已用字节（整个源） */
  usage: number
  /** 配额字节；未知为 0 */
  quota: number
}

/** 阈值（与文案档位一一对应；改这里要同步改 `quotaNotice` 的措辞） */
export const QUOTA_WARN_RATIO = 0.8
export const QUOTA_CRITICAL_RATIO = 0.95

/**
 * 判定档位（纯函数）。
 *
 * @param usage 已用字节
 * @param quota 配额字节；`<=0` / 非有限 ⇒ unknown
 */
export function quotaLevel(usage: number, quota: number): QuotaLevel {
  // 口径①：拿不到配额就什么都不说
  if (!Number.isFinite(quota) || quota <= 0) return 'unknown'
  if (!Number.isFinite(usage) || usage < 0) return 'unknown'
  const ratio = usage / quota
  if (ratio >= QUOTA_CRITICAL_RATIO) return 'critical'
  if (ratio >= QUOTA_WARN_RATIO) return 'warn'
  return 'ok'
}

/** 已用百分比（0–100，保留整数）；配额未知返回 null（**不是 0**） */
export function quotaPercent(usage: number, quota: number): number | null {
  if (quotaLevel(usage, quota) === 'unknown') return null
  return Math.min(100, Math.round((usage / quota) * 100))
}

/**
 * 读浏览器给的配额估算。
 * 取不到 / 抛错 / 全 0 ⇒ null（**永不抛**：这条链路只在后台静默跑）。
 *
 * @param estimate 可注入，便于单测（默认用 `navigator.storage.estimate`）
 */
export async function readQuota(
  estimate?: () => Promise<{ usage?: number; quota?: number } | undefined>,
): Promise<QuotaInfo | null> {
  try {
    const fn = estimate
      ?? (typeof navigator !== 'undefined' && navigator.storage?.estimate
        ? () => navigator.storage.estimate() as Promise<{ usage?: number; quota?: number }>
        : null)
    if (!fn) return null
    const r = await fn()
    if (!r) return null
    const usage = typeof r.usage === 'number' ? r.usage : NaN
    const quota = typeof r.quota === 'number' ? r.quota : NaN
    // 两项都没给 ⇒ 视为不可用（口径①）
    if (quotaLevel(usage, quota) === 'unknown') return null
    return { usage, quota }
  } catch {
    return null
  }
}

/**
 * 提示用的"档位 + 日期"记忆键。
 *
 * 🔴 为什么带日期而不是只记档位：`warn` 提过一次之后，一周后仍然 `warn`（作者没腾空间），
 *    这时应该再提醒一次；而**同一天内**连提三次只会让人关掉提示。
 *    跨天重置是"温和地再提一次"，不是"不再提"。
 */
export function quotaNoticeKey(level: QuotaLevel, today: string): string {
  return `${level}@${today}`
}

/**
 * 今天这个档位要不要提示（纯函数）。
 *
 * @param level    当前档位
 * @param lastKey  上次提示记下的键（`quotaNoticeKey` 的产物）
 * @param today    今天的本地日期键（`YYYY-MM-DD`）
 */
export function shouldNotifyQuota(level: QuotaLevel, lastKey: string | null, today: string): boolean {
  // ok / unknown 永远不提示（口径①②）
  if (level !== 'warn' && level !== 'critical') return false
  if (lastKey && lastKey === quotaNoticeKey(level, today)) return false
  return true
}

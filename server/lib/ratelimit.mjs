// ============ 极简滑动窗口限流（防爆破 / 防批量注册） ============
//
// 不用 Redis：单进程 + 单机部署，一个 Map 就够。将来上多进程再换。
// 🔴 必须自带清理：Map 只增不减的话，扫描器把 IP 刷一遍就能把内存吃满（1.7 G 机器尤其要命）。
const buckets = new Map()

/** 每 5 分钟清一次过期桶（惰性 + 定时双保险） */
const SWEEP_MS = 5 * 60 * 1000
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) {
    if (now - b.start > b.windowMs * 2) buckets.delete(k)
  }
}, SWEEP_MS)
sweeper.unref?.()

/**
 * @returns {{ok:boolean, retryAfter?:number}}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0, windowMs }
    buckets.set(key, b)
  }
  b.count += 1
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)) }
  }
  return { ok: true }
}

/** 成功后清账（例如登录成功，把该 IP 的失败计数抹掉） */
export function resetLimit(key) {
  buckets.delete(key)
}

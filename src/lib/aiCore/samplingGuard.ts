/**
 * 「这个端点 + 这个模型不接受自定义采样参数」的**会话内记忆**（2026-11-23 · 3.6.2 网页版热修之二）。
 *
 * 【为什么需要它】只按模型名识别（`FIXED_SAMPLING_RE`）永远有漏网：中转站把模型改名、
 *   用户手填 `kimi-latest`、私有部署换了名字 —— 一律认不出。真正的兜底只能是
 *   **撞一次 400 就记住**，之后本次会话不再发采样参数，并在设置页提醒作者去勾选开关。
 *
 * 【为什么只存内存、不写用户配置】
 *   · 写 provider 要经过 `saveProviders()`（带存储上下文校验），在 AI 调用链里改用户配置
 *     既可能撞上"存储已切换"的守卫，也会让作者莫名其妙发现配置被改了；
 *   · 这只是"少浪费一次请求"的优化，刷新后重试一次 400 的代价可以接受；
 *   · 真正的持久化是**作者在设置页勾选「不发送采样参数」**——那才是他知情的选择。
 *   所以：内存 Set 负责"这一次别再试"，provider 上的 `disableSampling` 负责"以后都别发"。
 *
 * 🔴 键里带 **model**：同一个端点条目换了模型（`kimi-k2.6` → `deepseek-chat`）就该重新判断，
 *    否则换到支持温度的模型上会白白不发温度。
 * 🔴 空 id 不记录：`config.id` 缺失时宁可每次都试，也不要污染一个空键把所有人都禁掉。
 */
const SEP = '\u0000'
const rejected = new Set<string>()

function keyOf(providerId: string, model: string): string {
  const id = String(providerId || '').trim()
  if (!id) return ''
  return id + SEP + String(model || '').trim()
}

/** 记录「该端点 + 模型」的采样参数被服务端拒绝过（本会话内不再发采样参数） */
export function markSamplingRejected(providerId: string, model: string): void {
  const k = keyOf(providerId, model)
  if (k) rejected.add(k)
}

/** 该端点 + 模型是否已在本会话里因采样参数被拒 */
export function isSamplingRejected(providerId: string, model: string): boolean {
  const k = keyOf(providerId, model)
  return !!k && rejected.has(k)
}

/** 作者在设置页取消勾选后清掉记忆（下次会重新真实试一次，避免"永远不敢发"） */
export function clearSamplingRejected(providerId: string, model: string): void {
  const k = keyOf(providerId, model)
  if (k) rejected.delete(k)
}

import { hash } from './fixtures/table-fixtures.mjs'

/**
 * 计量实现版本。
 * 🔴 v2（2026-10-25 16:40）：修一处**假绿** —— `--mode compare` 遇到环境/夹具/阈值不兼容时，
 *    错误被 catch 吞掉、状态仍停在 `baseline-recorded`，执行器据此 exit 0，等于「比不了也算过」。
 *    修法与影响：compare 失败必须落 `failed`；因为改了执行器，指纹随之变化，
 *    v1 的旧基线（`.workbuddy/tmp/table-performance-024EoR/`，node v22.23.2 采）**不再可比**，
 *    需要在 v2 下重采基线 —— 这是有意的，不是回归。
 * 🔴 v3（2026-10-25 17:40）：P0 余项补指标 —— **筛选 / 清筛选 / 连续滚动分布**。
 *    新增样本键 filter(5) / clear(5) / scroll(40)，阈值各自独立；同样需要重采基线。
 * 🔴 v4（2026-10-25 17:50）：**滚动指标的定义错了，重做**。旧口径是「每步推进 1/40 全表」——
 *    medium 一步 300px、large 一步 1000px（约 25 行），既不是真实滚轮步长，又把
 *    「新挂 20 行 vs 0 行」混成了同一个数字（诊断：800px/20 行 = 125ms，1px/0 行 = 19ms）。
 *    现在改成**固定 120px/步、60 步、在页面内计时**（去掉 Playwright 往返开销），并给出阈值。
 * 🔴 v5（2026-10-25 18:20）：**save 的计时也被探针自己污染了**。原来每 25ms 轮询一次
 *    `readStores()`（开库 + getAll(tableRows) + getAll(projects) + 关库），large 一次约 40ms，
 *    连产品本身只要 13~45ms 的保存被量成 450ms。现在轮询改成「按主键读单条」（约 2~5ms），
 *    整表回读仍然做 —— 但只做**一次**、且**不计时**，作为持久化断言（`complete persisted records`）。
 * 🔴 v6（2026-10-25 18:45）：**补上真正的「退化闸」**。原来 `--mode compare` 只把差值算出来写进报告，
 *    判定仍只看绝对阈值 —— 也就是「以前 60ms、现在 300ms 但没超 1000ms」会被判通过，
 *    而且小表/树形/混合（`THRESHOLDS` 里没有它们）**永远判不出通过**（`absolute` 为 null ⇒ threshold-failed）。
 *    现在 compare 用 `REGRESSION_LIMITS` 判相对回归（任何夹具都适用），绝对阈值有才算。
 *    同样需要重采基线（口径变了）。
 * 🔴 v7（2026-10-25 19:10）：**filter/clear 的样本量从 5 提到 20**。
 *    原因：nearest-rank 的 P95 在 n=5 时就是**最大值**（ceil(4.75)-1 = 4），
 *    同一份代码重跑一次 filter 就从 30.2ms 跳到 39.8ms（+32%）被退化闸判红 —— 那是统计噪声，不是退化。
 *    n=20 时 P95 取第 19 个，才是「P95」该有的意思；代价是每夹具多花约 4 秒。
 *    **不放宽阈值**来换绿：绝对阈值一个没动，是让统计量先站得住。
 * 🔴 v8（2026-10-25 19:30）：两件事一起改，都是「口径站不住」而不是「数字难看」：
 *    ① `save` 样本 10→20：n=10 的 nearest-rank P95 同样是**最大值**，
 *       便携 medium 九个样本 890~901ms、第十个 1510ms 就把 P95 顶到 1510（判红）。
 *       实测口径要能代表「作者平常感受到的速度」，不能被单个离群点定义。
 *    ② **便携后端单独定阈值**：便携的保存是「整库 HTTP + 原子写盘」，不是 IDB 事务
 *       （实测 p50 约 0.9s vs guest 约 60ms —— 差一个数量级，不是慢，是机制不同）。
 *       共用一套阈值只有两种结果：要么把便携永远判红，要么把 guest 的闸门放到形同虚设。
 * 🔴 v9（2026-10-25 19:50）：**退化闸的噪声地板改成按指标定**。
 *    实测（small 连跑两次，p50 只差 0.06ms）P95 却摆了 +9.7ms（input）/ +19.4ms（save）——
 *    P95 的抖动是「绝对毫秒」级的，和基线大小无关（20ms 的指标 +10ms 就是 +50%），
 *    统一 5ms 地板必然误报。而每个指标的抖动上限其实由**它自己的量化间隔**决定：
 *    save 靠 15ms 轮询确认、filter/clear 靠 20ms 轮询读「共 N 行」、input/open 是 rAF+提交、
 *    scroll 是页内两帧。地板就取这些间隔，超了才叫退化。
 */
export const MEASUREMENT_VERSION = 9
export const SAMPLE_PLAN = Object.freeze({ warmup: 1, open: 5, input: 30, save: 20, filter: 20, clear: 20, scroll: 60 })
/**
 * 样本量下限与统计量可信度的关系（写下来是为了以后别再踩）：
 *   · nearest-rank P95 需要 n ≥ 20 才有意义（n=5 时它等于最大值，一次抖动就判红）；
 *   · 所以 filter/clear/save 这类「慢操作」也要凑够 20，不能图快只跑 5 次。
 */
/** 滚动步长（CSS 像素，≈ 一次滚轮/触控板的一次推进量）。每步新挂 1~3 行，才是作者真实的手感 */
export const SCROLL_STEP_PX = 120
/** 全部计时指标。新增指标必须同时进 SAMPLE_PLAN / THRESHOLDS / validateSamples / compareBaseline */
export const METRIC_KEYS = Object.freeze(['open', 'input', 'save', 'filter', 'clear', 'scroll'])
/**
 * 绝对阈值。两层：`<backend>.<fixture>` 优先，其次 `<fixture>`（= 网页端口径）。
 *
 * 🔴 便携后端为什么单独一套：它的保存是「整库 JSON 过 HTTP + 原子写盘」，网页端是 IDB 事务。
 *    实测同一台机器、同一夹具：guest 保存 p50 ≈ 60ms，便携 ≈ 900ms（整库 4.6MB 写盘）。
 *    共用一个数字的结果只有两种 —— 便携永远红，或者网页端的闸门形同虚设。
 *    便携侧留 2 倍余量（实测 p50 ~0.9~1.0s ⇒ 2.0~2.5s），是本机 Defender 扫描时的最差区间。
 * scroll 阈值 = 60fps 预算内（50/60ms）：120px 一步只新挂 1~3 行，若这一步都超 50ms，
 *    说明挂着的那 15 行本身太贵，该回头查单行成本，而不是调阈值。
 */
export const THRESHOLDS = Object.freeze({
  medium: { openP50: 1000, openMax: 2000, inputP95: 100, saveP95: 1000, filterP95: 500, clearP95: 500, scrollP95: 50 },
  large: { openP50: 2000, openMax: 3000, inputP95: 120, saveP95: 1500, filterP95: 800, clearP95: 800, scrollP95: 60 },
  portable: {
    medium: { openP50: 1000, openMax: 2500, inputP95: 120, saveP95: 2000, filterP95: 800, clearP95: 800, scrollP95: 60 },
    large: { openP50: 2000, openMax: 3500, inputP95: 150, saveP95: 2500, filterP95: 1000, clearP95: 1000, scrollP95: 80 },
  },
})
/** 取某个后端 + 夹具的阈值（便携找 portable.<fixture>，其余用 <fixture>） */
export function thresholdsFor(backend, fixture) {
  return THRESHOLDS[backend]?.[fixture] ?? THRESHOLDS[fixture] ?? null
}
/**
 * 相对退化闸（compare 用）。
 *
 * 🔴 为什么必须有：绝对阈值只管「有没有超上限」，管不了「比上一版慢多少」。
 *    小表（small）/树形（tree）/混合（mixed）没有绝对阈值，旧逻辑必然判 `threshold-failed`，
 *    等于这三类夹具根本没有退化闸。
 * `noiseFloorMs`：单机计时的抖动实测在 ±10% 上下（同一份代码 medium 打开 166→176ms），
 *    所以差值小于 5ms 一律当噪声，不判退 —— 否则闸会天天红，最后被当成狼来了。
 */
export const REGRESSION_LIMITS = Object.freeze({
  p50Relative: 0.2,
  p95Relative: 0.3,
  noiseFloorMs: 5,
  /**
   * 每个指标自己的噪声地板（毫秒）。差值小于它一律算噪声。
   * · save 30 = 2×15ms 轮询间隔（多等一轮就是 15ms，不能算退化）；
   * · filter/clear 20 = 读「共 N 行」的轮询间隔；
   * · input/open 15 = 一次 rAF + React 提交的实测抖动（同一份代码 20ms↔30ms 反复横跳）；
   * · scroll 5 = 页内计时，抖动不到 2ms。
   */
  noiseFloorByKey: Object.freeze({ open: 15, input: 15, save: 30, filter: 20, clear: 20, scroll: 5 }),
})
export function summarize(samples, minimum = 1) {
  if (samples.length < minimum || samples.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid or insufficient timing samples')
  const ordered = [...samples].sort((a, b) => a - b)
  // Nearest-rank quantile, including P50; raw order is retained separately in reports.
  return { count: samples.length, p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1], worst: ordered.at(-1) }
}
export function validateSamples(metrics, plan = SAMPLE_PLAN) {
  return Object.fromEntries(METRIC_KEYS.map(key => [key, summarize(metrics[key], plan[key])]))
}
export function comparisonKey(report) {
  return hash({ measurementVersion: report.measurementVersion, environmentHash: report.environmentHash,
    measurementHash: report.measurementHash, fixtureHash: report.fixtureHash, backend: report.backend, samplePlan: report.samplePlan, thresholds: report.thresholds })
}
export function compareBaseline(current, baseline) {
  const { integrityHash, ...body } = baseline
  if (!integrityHash || hash(body) !== integrityHash || !baseline.checks?.length || baseline.checks.some(c => c.ok !== true)) throw new Error('Baseline integrity or functional prerequisites invalid')
  if (baseline.mode !== 'measure' || baseline.status !== 'baseline-recorded' || baseline.measurementVersion !== MEASUREMENT_VERSION || !baseline.baselineId || baseline.baselineId !== comparisonKey(baseline)) throw new Error('Invalid frozen baseline')
  if (comparisonKey(current) !== baseline.baselineId) throw new Error('Incompatible baseline environment, fixtures, measurement or thresholds')
  validateSamples(current.metricsSamples); validateSamples(baseline.metricsSamples)
  const changes = {}, regressions = []
  for (const key of METRIC_KEYS) {
    const a = summarize(current.metricsSamples[key]), b = summarize(baseline.metricsSamples[key])
    changes[key] = {
      p50DeltaMs: a.p50 - b.p50, p95DeltaMs: a.p95 - b.p95,
      p50Relative: b.p50 === 0 ? null : a.p50 / b.p50 - 1,
      p95Relative: b.p95 === 0 ? null : a.p95 / b.p95 - 1,
    }
    // 每个指标有自己的抖动上限（量化间隔），优先用它；没定义就退回全局地板
    const floor = Math.max(REGRESSION_LIMITS.noiseFloorMs, REGRESSION_LIMITS.noiseFloorByKey[key] ?? 0)
    for (const [metric, limit] of [['p50', REGRESSION_LIMITS.p50Relative], ['p95', REGRESSION_LIMITS.p95Relative]]) {
      const from = b[metric], to = a[metric]
      // 差值小于噪声地板就不算退化：否则 20ms→30ms（P95 抖动）也会红
      if (to - from > Math.max(floor, from * limit))
        regressions.push({ key, metric, baselineMs: from, currentMs: to, relative: from === 0 ? null : to / from - 1 })
    }
  }
  return { changes, regressions }
}

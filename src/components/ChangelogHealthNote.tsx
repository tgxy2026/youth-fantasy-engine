/**
 * 「设定变更」页的数据体检提示（2.9.2 · 方案 C）。
 *
 * 为什么挂这一页：「设定变更」是「改设定先登记」的闸口 —— 而 `dataHealth` 查的正是
 * **引用断链 / 编号重复 / 必填空缺失** 这类会因改设定而产生的问题，在这一页看到它最顺手。
 * 此前 `dataHealth` 只有「检查工具」页一个入口，得作者专门去开。
 *
 * 🔴 三条口径（方案 §3 的 C 方案，2026-10-09 拍板）：
 *   ① **不常驻区块** —— 只在真检出「冲突」（error）级问题时才渲染那一行；无问题则与改动前**一字不差**；
 *   ② **静默跑** —— 失败不弹错、不打扰（体检是辅助，不能反过来挡住这一页）；
 *   ③ **只报数、不判定** —— 给条数与去处，逐条上下文仍在「检查工具 → 数据体检」里看。
 *
 * ⚠️ 为什么带模块级缓存：`runDataHealthCheck()` 会扫全库的表格数据，而页签来回切会反复触发它。
 *    缓存按「项目 + 数据版本（`project.updatedAt`）」失效，另加 5 分钟 TTL 兜住
 *    「同一数据版本内反复进出这一页」的场景。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import * as db from '../lib/db'
import { runDataHealthCheck } from '../lib/dataHealth'

/** 同一数据版本内的复扫间隔（兜住「反复进出该页」） */
const TTL_MS = 5 * 60 * 1000

let cache: { pid: string; rev: number; ts: number; errors: number } | null = null

export default function ChangelogHealthNote({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState(cache?.errors ?? 0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const pid = db.getCurrentProjectId()
        const proj = (await db.getProject(pid)) as { updatedAt?: number } | undefined
        const rev = proj?.updatedAt ?? 0
        const now = Date.now()
        // 命中缓存：同一项目、同一数据版本、且未过期 ⇒ 直接用
        // 🔴 `rev > 0` 守卫与 `lib/checkLog.revisionOf` 同口径 —— 取不到项目版本号时
        //    **不能**走缓存：0 === 0 会让缓存永不失效，只剩 TTL 兜底（2026-10-09 审计修）。
        if (cache && cache.pid === pid && rev > 0 && cache.rev === rev && now - cache.ts < TTL_MS) {
          if (!cancelled) setErrors(cache.errors)
          return
        }
        const r = await runDataHealthCheck()
        const n = r.issues.filter(i => i.severity === 'error').length
        cache = { pid, rev, ts: now, errors: n }
        if (!cancelled) setErrors(n)
      } catch {
        // 静默：体检失败绝不该影响这一页的正常使用
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <>
      {errors > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-11 leading-relaxed text-ink-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          <span>
            数据体检检出 <b className="text-danger tabular-nums">{errors}</b> 处「冲突」级问题 ——
            改设定前建议先处理（逐条上下文在「检查工具 → 数据体检」）。
          </span>
        </div>
      )}
      {children}
    </>
  )
}

import { useEffect, useMemo, useState } from 'react'
import * as db from '../lib/db'
import { Flag, Zap, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'

/**
 * 剧情线视图（v1.6.1）
 * 把「伏笔追踪 + 爽点节奏 + 时间脉络」三张表按章节串成一条叙事主线：
 * 每章显示 关键事件 / 爽点 / 伏笔埋设与回收，一眼看清节奏有没有断档、
 * 哪些伏笔埋了没收（悬空/已到点未回收）。
 * 纯本地聚合，无需 AI。
 */

interface Hook { type: string; content: string; hook: string }
interface ChapterNode {
  no: number
  title: string
  events: string[]
  hooks: Hook[]
  planted: string[]   // 伏笔编号（本章埋设）
  reaped: string[]    // 伏笔编号（本章回收）
}

const noOf = (s: unknown): number => {
  const m = String(s ?? '').match(/第\s*(\d+)\s*章/)
  return m ? Number(m[1]) : 0
}

export default function StorylineView() {
  const [nodes, setNodes] = useState<ChapterNode[] | null>(null)
  const [stats, setStats] = useState<{ planted: number; reaped: number; open: number; overdue: number }>({ planted: 0, reaped: 0, open: 0, overdue: 0 })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [fsRows, hpRows, tlRows] = await Promise.all([
          db.getTableRows('foreshadow'),
          db.getTableRows('hookpoints'),
          db.getTableRows('timeline'),
        ])
        if (cancelled) return

        const map = new Map<number, ChapterNode>()
        const ensure = (no: number, title: string): ChapterNode => {
          let n = map.get(no)
          if (!n) {
            n = { no, title, events: [], hooks: [], planted: [], reaped: [] }
            map.set(no, n)
          }
          if (title && !n.title) n.title = title
          return n
        }

        // 时间线 → 每章关键事件（有故事内时间的优先按时间排序，兜底按章节号）
        const tlSorted = [...tlRows].sort((a, b) => {
          const ta = String(a.data['故事内时间'] ?? '').trim()
          const tb = String(b.data['故事内时间'] ?? '').trim()
          if (ta && tb && ta !== tb) return ta < tb ? -1 : 1
          return noOf(a.data['章节号']) - noOf(b.data['章节号'])
        })
        for (const r of tlSorted) {
          const ev = String(r.data['本章关键事件'] ?? '').trim()
          if (!ev) continue
          ensure(noOf(r.data['章节号']), String(r.data['章节标题'] ?? '')).events.push(ev)
        }

        // 爽点 → 每章钩子
        for (const r of hpRows) {
          const content = String(r.data['爽点内容'] ?? '').trim()
          if (!content) continue
          ensure(noOf(r.data['章节号']), String(r.data['章节标题'] ?? '')).hooks.push({
            type: String(r.data['爽点类型'] ?? '爽点'),
            content,
            hook: String(r.data['章末钩子'] ?? '').trim(),
          })
        }

        // 伏笔 → 埋设 / 回收挂到对应章节
        let planted = 0, reaped = 0, open = 0, overdue = 0
        const fsList: { no: number; id: string; status: string; title: string; reapNo: number }[] = []
        for (const r of fsRows) {
          const id = String(r.data['编号'] ?? '').trim() || '伏笔'
          const status = String(r.data['状态'] ?? '').trim()
          const plantNo = noOf(r.data['埋设位置'])
          const reapNo = noOf(r.data['计划回收位置'])
          const title = String(r.data['伏笔内容'] ?? '').trim().slice(0, 28)
          if (plantNo > 0) {
            ensure(plantNo, '').planted.push(id)
            planted++
          }
          if (status === '已回收' && reapNo > 0) {
            ensure(reapNo, '').reaped.push(id)
            reaped++
          }
          if (status !== '已回收' && status !== '已作废') {
            open++
            fsList.push({ no: plantNo, id, status, title, reapNo })
          }
        }
        // 已到回收点却未回收（计划回收章 ≤ 当前已有章节数上限，且未标记回收）
        const maxNo = Math.max(0, ...map.keys())
        for (const f of fsList) {
          if (f.reapNo > 0 && f.reapNo <= maxNo) overdue++
        }

        if (cancelled) return
        const list = [...map.values()].sort((a, b) => a.no - b.no)
        setNodes(list)
        setStats({ planted, reaped, open, overdue })
      } catch { /* 读表失败静默，显示空态 */ }
    })()
    return () => { cancelled = true }
  }, [])

  const hasData = useMemo(() => (nodes ?? []).some(n => n.events.length || n.hooks.length || n.planted.length || n.reaped.length), [nodes])

  if (!nodes) {
    return <div className="flex items-center justify-center py-16 text-ink-500 text-[12px]"><Loader2 size={13} className="animate-spin mr-2" />正在聚合剧情线…</div>
  }

  if (!hasData) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-16 text-center text-ink-500 text-[13px]">
        还没有剧情数据——先在「伏笔追踪 / 爽点节奏 / 时间脉络」登记内容，剧情线会自动聚合。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 顶部统计条 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="已埋设伏笔" value={stats.planted} tone="amber" />
        <Stat label="已回收伏笔" value={stats.reaped} tone="green" />
        <Stat label="未回收（悬空）" value={stats.open} tone={stats.open ? 'red' : 'green'} />
        <Stat label="已到点未回收" value={stats.overdue} tone={stats.overdue ? 'red' : 'green'} />
      </div>

      {/* 章节主线 */}
      <div className="relative pl-8">
        {nodes.map(n => {
          const empty = n.events.length === 0 && n.hooks.length === 0 && n.planted.length === 0 && n.reaped.length === 0
          return (
            <div key={n.no} className="relative pb-4 pl-2">
              {/* 竖线 + 节点 */}
              <div className="absolute left-0 top-0 bottom-0 w-px bg-ink-700" />
              <div className="absolute left-[-4px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-amber bg-ink-900" />
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[13px] font-bold text-ink-100">第 {n.no} 章</span>
                {n.title && <span className="text-[12px] text-ink-400">{n.title}</span>}
                {n.planted.length > 0 && <span className="text-[10px] px-1.5 py-px rounded bg-amber/10 text-amber border border-amber/25">埋 {n.planted.join(' ')}</span>}
                {n.reaped.length > 0 && <span className="text-[10px] px-1.5 py-px rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">收 {n.reaped.join(' ')}</span>}
              </div>
              {empty ? (
                <div className="text-[11px] text-ink-500 italic">（本章无登记事件 / 爽点 / 伏笔）</div>
              ) : (
                <div className="space-y-1">
                  {n.events.map((e, i) => (
                    <div key={`e${i}`} className="flex items-start gap-1.5 text-[12px] text-ink-200 leading-snug">
                      <Flag size={11} className="mt-0.5 shrink-0 text-ink-500" />
                      <span>{e}</span>
                    </div>
                  ))}
                  {n.hooks.map((h, i) => (
                    <div key={`h${i}`} className="flex items-start gap-1.5 text-[12px] text-amber/90 leading-snug">
                      <Zap size={11} className="mt-0.5 shrink-0 text-amber" />
                      <span>
                        <span className="px-1 py-px mr-1 rounded bg-amber/10 border border-amber/25 text-[10px]">{h.type}</span>
                        {h.content}
                        {h.hook && <span className="text-ink-400"> · 钩子：{h.hook}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {stats.overdue > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[11.5px] text-red-300 leading-relaxed">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            有 <b>{stats.overdue}</b> 条伏笔的「计划回收位置」已到章（当前剧情已进行到对应章节），但状态仍是未回收——
            记得在伏笔追踪把它们回收掉，或调整计划回收位置，避免伏笔悬空。
          </span>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'amber' | 'green' | 'red' }) {
  const cls = tone === 'amber' ? 'text-amber' : tone === 'green' ? 'text-emerald-400' : 'text-red-400'
  return (
    <div className="bg-ink-800 rounded-lg px-3 py-2">
      <div className="text-[10px] text-ink-500">{label}</div>
      <div className={`text-[16px] font-bold mt-0.5 ${cls}`}>{value}</div>
    </div>
  )
}

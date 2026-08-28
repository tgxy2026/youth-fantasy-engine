import { useEffect, useState, useMemo } from 'react'
import * as db from '../lib/db'
import type { Chapter, CardRecord } from '../lib/types'

interface Props {
  onNavigate: (id: string, chapterId?: string) => void
}

/**
 * 角色出场分布图（v1.3）
 * 扫描各章正文，统计每位角色（主要 / 次要 / NPC 角色卡）在各章的出现次数，
 * 以热力矩阵呈现；点单元格直达对应章节。
 */
export default function CharacterDistribution({ onNavigate }: Props) {
  const [rows, setRows] = useState<{ name: string; counts: Record<string, number>; total: number }[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    (async () => {
      const [main, sec, chs] = await Promise.all([
        db.getCardRecords('char-main'),
        db.getCardRecords('char-secondary'),
        db.getAllChapters(),
      ])
      // 只统计主要 / 次要角色；排除 NPC 角色卡，且过滤掉「人物状态 = 已退场」的角色
      const cards: CardRecord[] = [...main, ...sec].filter(
        c => (c.data['人物状态'] ?? '').trim() !== '已退场'
      )
      const names = cards.map(c => c.name).filter(n => n && n.trim().length > 0)
      const chsWithContent = chs.filter(c => c.content && c.content.trim())
      const data = names.map(name => {
        const counts: Record<string, number> = {}
        let total = 0
        for (const ch of chsWithContent) {
          const c = countOccurrences(ch.content, name)
          if (c > 0) { counts[ch.id] = c; total += c }
        }
        return { name, counts, total }
      }).filter(d => d.total > 0).sort((a, b) => b.total - a.total)
      setRows(data)
      setChapters(chsWithContent)
      setLoaded(true)
    })()
  }, [])

  const topChars = rows
  const topChapters = chapters
  const maxCount = useMemo(() => Math.max(1, ...rows.flatMap(r => Object.values(r.counts))), [rows])

  if (!loaded) return <div className="py-8 text-center text-ink-500 text-[12px]">加载中…</div>

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-12 text-center text-ink-500 text-[12px] leading-relaxed">
        还没有可统计的出场数据——先在角色卡新建角色，并在正文里写几章，<br />
        系统会自动统计每位角色在各章的出场次数。
      </div>
    )
  }

  const cellColor = (c: number) => {
    if (c === 0) return 'bg-ink-800'
    const r = c / maxCount
    if (r < 0.2) return 'bg-amber/25'
    if (r < 0.45) return 'bg-amber/45'
    if (r < 0.75) return 'bg-amber/70'
    return 'bg-amber'
  }

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850 p-4 overflow-hidden">
      <div className="max-h-[68vh] overflow-auto">
        <table className="border-collapse text-[10px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-ink-850 text-left text-ink-400 font-medium px-2 py-1.5 pr-3 whitespace-nowrap">角色 \\ 章节</th>
              {topChapters.map(ch => (
                <th key={ch.id} className="text-ink-500 font-normal px-0.5 py-1.5 align-bottom" style={{ width: 22 }}>
                  <div className="whitespace-nowrap" style={{ writingMode: 'vertical-rl' }} title={`${ch.title}（点单元格跳转）`}>
                    {ch.title.length > 10 ? ch.title.slice(0, 10) + '…' : ch.title}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topChars.map(r => (
              <tr key={r.name}>
                <td className="sticky left-0 z-10 bg-ink-850 text-ink-200 font-medium px-2 py-1 pr-3 whitespace-nowrap">{r.name}</td>
                {topChapters.map(ch => {
                  const c = r.counts[ch.id] ?? 0
                  return (
                    <td key={ch.id} className="p-0.5">
                      <button
                        onClick={() => onNavigate('editor', ch.id)}
                        title={`${r.name} 在《${ch.title}》出场 ${c} 次 · 点击直达`}
                        className={`w-[20px] h-[20px] rounded-[3px] ${cellColor(c)} hover:ring-1 hover:ring-amber transition-all`}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-1.5 mt-3 text-[9px] text-ink-500">
        <span>少</span>
        <span className="w-[14px] h-[14px] rounded-[3px] bg-ink-800 inline-block" />
        <span className="w-[14px] h-[14px] rounded-[3px] bg-amber/25 inline-block" />
        <span className="w-[14px] h-[14px] rounded-[3px] bg-amber/45 inline-block" />
        <span className="w-[14px] h-[14px] rounded-[3px] bg-amber/70 inline-block" />
        <span className="w-[14px] h-[14px] rounded-[3px] bg-amber inline-block" />
        <span>多</span>
        <span className="ml-3">颜色越亮 = 该章出场次数越多 · 展示全部角色（主要/次要，不含 NPC 与已退场）/ 全部章节 · 点击单元格直达章节 · 容器可滚动</span>
      </div>
    </div>
  )
}

function countOccurrences(text: string, name: string): number {
  if (!name) return 0
  let i = 0, c = 0
  const n = name.length
  while ((i = text.indexOf(name, i)) !== -1) { c++; i += n }
  return c
}

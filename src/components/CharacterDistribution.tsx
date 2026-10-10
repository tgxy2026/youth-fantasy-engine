import { useEffect, useState } from 'react'
import { Z } from '@/lib/zLayer'
import * as db from '@/lib/db'
import type { CardRecord } from '@/lib/types'
import { Button } from '@/components/Button'
import { clipText } from '@/lib/textClip'
import { splitNames } from '@/lib/audit'
import { foldVh } from '@/lib/theme'

interface Props {
  onNavigate: (id: string, chapterId?: string) => void
}

/**
 * 角色出场分布图（v1.3 · 2.9.1 改口径）
 *
 * 🔴 2.9.1 换数据源：改读《章节总表》各卷台账的「**出场人物**」登记列
 *    （此前是逐章扫正文数名字）。两条理由：
 *     ① **口径统一** —— 「出场人物」是全项目公认的出场权威口径，一致性校验、
 *        AI 上下文的人物共现矩阵、情节推演读的都是它；本图先前另扫正文，
 *        两套口径必然分裂（正文提及 ≠ 出场：回忆、转述、别人提名字都会被算进去）。
 *     ② **零成本** —— 不必把全书正文读进内存，也不必每章做一次子串扫描。
 *    ⇒ 矩阵语义随之从「提及次数热度」变成「该章有没有登记出场」。
 */
export default function CharacterDistribution({ onNavigate }: Props) {
  const [rows, setRows] = useState<{ name: string; counts: Record<string, number>; total: number }[]>([])
  const [chapters, setChapters] = useState<{ id: string; title: string }[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    (async () => {
      const [main, sec, ledger] = await Promise.all([
        db.getCardRecords('char-main'),
        db.getCardRecords('char-secondary'),
        db.getAllChapterLedgerRows(),
      ])
      // 只统计主要 / 次要角色；排除 NPC 角色卡，且过滤掉「人物状态 = 已退场」的角色
      const cards: CardRecord[] = [...main, ...sec].filter(
        c => (c.data['人物状态'] ?? '').trim() !== '已退场'
      )
      const names = cards.map(c => c.name).filter(n => n && n.trim().length > 0)
      // 台账行 id 形如 `ch-<章节id>`（与 continuityCheck / PlotCanvas 同款取法）
      const cast = ledger
        .map(r => ({
          id: r.id.startsWith('ch-') ? r.id.slice(3) : r.id,
          title: (r.data['章节标题'] ?? '').trim(),
          who: splitNames(r.data['出场人物']),
        }))
        .filter(x => x.who.length > 0)
      const data = names.map(name => {
        const counts: Record<string, number> = {}
        let total = 0
        for (const ch of cast) {
          if (ch.who.includes(name)) { counts[ch.id] = 1; total++ }
        }
        return { name, counts, total }
      }).filter(d => d.total > 0).sort((a, b) => b.total - a.total)
      setRows(data)
      setChapters(cast.map(x => ({ id: x.id, title: x.title || '未命名' })))
      setLoaded(true)
    })()
  }, [])

  const topChars = rows
  const topChapters = chapters

  if (!loaded) return <div className="py-8 text-center text-ink-500 text-12">加载中…</div>

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-12 text-center text-ink-500 text-12 leading-relaxed">
        还没有可统计的出场数据——先在角色卡新建角色，<br />
        再到《章节总表》各卷台账的「出场人物」列，登记每章有谁出场。
      </div>
    )
  }

  // 2.9.1：数据源改为「出场人物」登记列后，矩阵是「出场 / 未登记」两态（不再是提及次数热度）
  const cellColor = (c: number) => (c > 0 ? 'bg-amber' : 'bg-ink-800')

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850 p-4 overflow-hidden">
      <div className="overflow-auto" style={{ maxHeight: foldVh('68vh') }}>
        <table className="border-collapse text-10">
          <thead>
            <tr>
              <th className="sticky left-0 bg-ink-850 text-left text-ink-400 font-medium px-2 py-1.5 pr-3 whitespace-nowrap" style={{ zIndex: Z.pageHandle }}>角色 \\ 章节</th>
              {topChapters.map(ch => (
                <th key={ch.id} className="text-ink-500 font-normal px-0.5 py-1.5 align-bottom" style={{ width: 22 }}>
                  <div className="whitespace-nowrap" style={{ writingMode: 'vertical-rl' }} title={`${ch.title}（点单元格跳转）`}>
                    {clipText(ch.title, 10)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topChars.map(r => (
              <tr key={r.name}>
                <td className="sticky left-0 bg-ink-850 text-ink-200 font-medium px-2 py-1 pr-3 whitespace-nowrap" style={{ zIndex: Z.pageHandle }}>{r.name}</td>
                {topChapters.map(ch => {
                  const c = r.counts[ch.id] ?? 0
                  return (
                    <td key={ch.id} className="p-0.5">
                      <Button variant="bare"
                        onClick={() => onNavigate('editor', ch.id)}
                        title={`${r.name} 在《${ch.title}》${c > 0 ? '有出场登记' : '未登记出场'} · 点击直达`}
                        className={`w-[20px] h-[20px] rounded-3 ${cellColor(c)} hover:ring-1 hover:ring-amber transition-all`}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-1.5 mt-3 text-9 text-ink-500">
        <span className="w-14px h-14px rounded-3 bg-ink-800 inline-block" />
        <span>未登记</span>
        <span className="w-14px h-14px rounded-3 bg-amber inline-block" />
        <span>出场</span>
        <span className="ml-3">数据取自《章节总表》各卷台账的「出场人物」列 · 展示全部角色（主要/次要，不含 NPC 与已退场）/ 已登记出场的章节 · 点击单元格直达章节 · 容器可滚动</span>
      </div>
    </div>
  )
}

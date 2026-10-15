/**
 * 资料提及结果面板（3.1 P1）
 *
 * 角色卡 / 表格设定行点「提及」按钮后弹出：列出该资料（主名称 + 别称）在正文中
 * 出现的全部章节，点击结果跳转对应正文编辑。
 *
 * 版式复用统一全文检索（FullTextSearch）的命令面板范式：Modal + align=top +
 * 自绘头部 + bare 按钮结果行 + 底部状态条；差异点：
 *   · 无搜索框（资料名即查询词，别称由 `readAliases` 提供）；
 *   · 结果项增加命中次数与命中别称徽标；
 *   · 分批渲染（300+ 章项目最坏情况全命中，不能一次铺满）。
 *
 * 🔴 纯读组件：不写任何数据、不做实体合并（规划书红线「不可在未确认时自动合并同名实体」）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Search, Hash, CornerDownLeft, X } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { foldVh } from '@/lib/settings/theme'
import { findMentions, type MentionHit } from '@/lib/search/mentions'

interface Props {
  /** 资料主名称（面板标题与检索词） */
  name: string
  /** 别称列表（readAliases 产出） */
  aliases: string[]
  onClose: () => void
  /** 跳转正文：id 固定 'editor'，chapterId 为目标章节 */
  onNavigate: (id: string, chapterId?: string) => void
}

/** 每批渲染的章节数（300+ 章全命中时避免一次铺满卡顿） */
const PAGE = 50

export default function MentionPanel({ name, aliases, onClose, onNavigate }: Props) {
  const [hits, setHits] = useState<MentionHit[] | null>(null)
  const [error, setError] = useState('')
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let alive = true
    setError('')
    // 🔴 必须有 catch：读库 reject（磁盘占用 / 索引异常 / 切项目竞态）时若漏掉，
    //    hits 恒为 null ⇒ 面板永远停在「检索中…」，作者既看不到失败、也没有重试入口。
    findMentions(name, aliases)
      .then(rs => { if (alive) setHits(rs) })
      .catch(e => {
        if (!alive) return
        setHits([])
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => { alive = false }
  }, [name, aliases])

  const visible = useMemo(() => (hits ?? []).slice(0, shown), [hits, shown])
  const total = hits?.length ?? 0
  const totalHits = useMemo(() => (hits ?? []).reduce((s, h) => s + h.hits, 0), [hits])

  return (
    <Modal open onClose={onClose} hideHeader align="top" topOffset="12vh" width="xl" bodyClassName="!p-0">
      {/* 头部：资料名 + 别称徽标 + 关闭 */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-ink-700">
        <Search size={15} className="text-amber shrink-0" />
        <span className="text-14 font-medium text-ink-50 truncate">「{name}」的正文提及</span>
        {aliases.length > 0 && (
          <span className="text-10 px-1.5 py-px rounded shrink-0 border border-amber/25 bg-amber/10 text-amber/90 truncate max-w-40"
            title={`别称：${aliases.join('、')}`}>
            别称 {aliases.length}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="icon-muted" onClick={onClose} className="p-1 shrink-0" title="关闭"><X size={16} /></Button>
      </div>

      {/* 结果列表 */}
      <div className="overflow-y-auto py-2" style={{ maxHeight: foldVh('60vh') }}>
        {error && (
          <div className="text-center text-danger text-12 py-10">检索失败：{error}</div>
        )}
        {!hits && !error && (
          <div className="text-center text-ink-500 text-12 py-10">检索中…</div>
        )}
        {hits && !error && total === 0 && (
          <div className="text-center text-ink-500 text-12 py-10">
            正文中暂未提及「{name}」{aliases.length > 0 ? '（含别称）' : ''}
          </div>
        )}
        {visible.map(h => (
          <Button variant="bare"
            key={h.chapterId}
            onClick={() => { onNavigate('editor', h.chapterId); onClose() }}
            className="w-full text-left !justify-start px-4 py-2 flex items-start gap-2.5 transition-colors hover:bg-ink-800/60"
          >
            <span className="mt-0.5 text-10 px-1.5 py-px rounded shrink-0 border border-info/30 text-info max-w-28 truncate"
              title={h.volumeTitle}>
              {h.volumeTitle}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-13 text-ink-100 font-medium truncate block">{h.chapterTitle}</span>
              <span className="text-11 text-ink-500 line-clamp-1 block">{h.firstSnippet || '（无正文摘要）'}</span>
              {h.matchedTerms.length > 1 && (
                <span className="text-10 text-ink-600 truncate block">命中：{h.matchedTerms.join('、')}</span>
              )}
            </span>
            <span className="mt-0.5 shrink-0 flex items-center gap-1 text-10 text-ink-500" title={`该章命中 ${h.hits} 处`}>
              <Hash size={10} />{h.hits}
            </span>
            <CornerDownLeft size={12} className="mt-1 shrink-0 text-ink-700" />
          </Button>
        ))}
        {hits && shown < total && (
          <div className="px-4 py-2 text-center">
            <Button variant="secondary" size="sm" onClick={() => setShown(s => s + PAGE)}>
              显示更多（剩余 {total - shown} 章）
            </Button>
          </div>
        )}
      </div>

      {/* 底部状态条 */}
      <div className="flex items-center gap-3 px-4 h-9 border-t border-ink-700 text-10 text-ink-600 bg-ink-900/60">
        <span className="flex items-center gap-1"><Hash size={10} />{error ? '检索失败' : `${total} 章提及 · ${totalHits} 处`}</span>
        <span className="flex-1" />
        <span>点击结果跳转正文</span>
      </div>
    </Modal>
  )
}

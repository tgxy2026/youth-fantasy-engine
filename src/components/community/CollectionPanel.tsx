/**
 * 合集阅读页（3.6.2）。
 *
 * 【为什么做成浮层，而不是广场的一个页签】
 * 广场现有页签是「广场 / 我的投稿 / 排行 / 设置」，多一个页签会把导航撑宽，
 * 而合集是从「收录于《XX》」点进来的**上下文跳转**——浮层能保留原位置，关掉就回到原来那篇。
 *
 * 🔴 本版**只读**：目录 + 篇目。编辑（改名 / 排序 / 移出）在「我的投稿」里做，
 *    因为那些操作都需要作者身份与配额校验，放在读者也能打开的浮层里容易点错。
 */
import { useEffect, useState } from 'react'
import { LibraryBig, Loader2 } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { fetchCollection } from '@/lib/community/api'
import { formatViews } from '@/lib/community/format'
import type { CommunityCollectionPage } from '@/lib/community/types'

interface Props {
  collectionId: string
  onClose: () => void
  onOpenPost: (postId: string) => void
}

function fmtDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function CollectionPanel({ collectionId, onClose, onOpenPost }: Props) {
  const [data, setData] = useState<CommunityCollectionPage | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError('')
    void (async () => {
      try {
        const r = await fetchCollection(collectionId)
        if (!cancelled) setData(r.collection)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '读取合集失败')
      }
    })()
    return () => { cancelled = true }
  }, [collectionId])

  return (
    <Modal
      open
      onClose={onClose}
      title={data ? data.title : '合集'}
      icon={<LibraryBig size={16} />}
      width={720}
      maxHeight="84vh"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>}
    >
      {error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-13 text-danger" role="alert">
          {error}
        </div>
      )}

      {!error && !data && (
        <div className="flex items-center gap-2 py-6 text-13 text-ink-400">
          <Loader2 size={14} className="animate-spin" /> 读取中…
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {data.intro && <p className="text-13 leading-relaxed text-ink-300">{data.intro}</p>}

          {/**
            * 🔴 「合计浏览」不是「读者数」：同一人读 10 篇会算 10 次。
            *    措辞写错就是误导，这条在方案里写死了。
            */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-400">
            <span>{data.postCount} 篇</span>
            <span>合计浏览 {formatViews(data.totalViews)}</span>
            <span>最近更新 {fmtDate(data.updatedAt)}</span>
            <span className="text-ink-500">按第 1 篇起顺序阅读</span>
          </p>

          {data.items.length === 0 ? (
            <p className="py-6 text-center text-13 text-ink-500">
              这个合集里还没有可以阅读的篇目{data.isMine ? '（你挂进去的可能还在审核或未发布）' : '。'}
            </p>
          ) : (
            <ol className="space-y-1">
              {data.items.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onOpenPost(p.id)}
                    className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
                  >
                    <span className="w-6 shrink-0 text-right text-11 tabular-nums text-ink-500">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-13 text-ink-200 group-hover:text-amber">{p.title}</span>
                    <span className="shrink-0 text-11 tabular-nums text-ink-400">{formatViews(p.views)}</span>
                    <span className="hidden shrink-0 text-11 text-ink-500 sm:inline">{fmtDate(p.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {data.isMine && (
            <p className="rounded-lg border border-ink-700 yfe-surface-3 px-3 py-2 text-11 leading-relaxed text-ink-400">
              这是你的合集。要改名、删合集或调整篇目，请到「我的投稿」里操作 —— 那里会再校验一次权限。
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}

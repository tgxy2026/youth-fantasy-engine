/**
 * 颉文姬 · 整理（章后整理：事实 / 伏笔 / 关系 / 人物状态 ＋ 未来影响）（3.0 · W2-1）
 *
 * 与「补登」的分工：
 *   · 补登 —— 只管设定实体（事实），行为一字未动（本面板不取代它）；
 *   · 整理 —— 一次过四类；并显示「未来计划被上游变化波及」的标记。
 *
 * 🔴 与所有 AI 入口同规矩：AI 只抽候选，「是否已登记 / 是否真变了」由 lib 层确定性比对；
 *    未登记的一律**只提示、不凭空建**；采纳前都要作者勾选。
 * 状态全部来自 useJieWenJiModel（组件只收 m）。
 */
import { Loader2, RefreshCw, Save, AlertTriangle } from 'lucide-react'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { Button } from './Button'
import { POST_KINDS, POST_STATUS_META } from './jieWenJiParts'
import type { JieWenJiModel } from './useJieWenJiModel'

export default function JieWenJiPostProcess({ m }: { m: JieWenJiModel }) {
  const { aiReady, post, postPicked, setPostPicked, postSaving, runPost, commitPost, impacts, dismissImpact, content } = m
  return (
    <div className="space-y-2.5">
      <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="text-11 text-ink-300 leading-relaxed">
            写完本章后一键整理「事实 / 伏笔 / 关系 / 人物状态」四类变化。
            <span className="text-ink-500">AI 只负责抽取，「是否已登记、是否真变了」由程序精确比对；没登记过的一律只提示、不凭空建，采纳前都要你勾选。</span>
          </div>
          <Button onClick={runPost}
            disabled={!aiReady || post.loading || !content.trim()}
            title={!aiReady ? AI_DISABLED_HINT : post.scannedAt ? '重新整理本章' : '整理本章'} variant="primary" size="md" className="shrink-0 flex items-center rounded">
            {post.loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {post.loading ? '整理中' : post.scannedAt ? '重新整理' : '整理本章'}
          </Button>
        </div>
        {!aiReady && <div className="mt-1.5 text-10 text-ink-500">{AI_DISABLED_HINT}</div>}
      </div>

      {/* 未来影响：章纲里「本章之后」的计划被上游变化波及（只提示，不自动改章纲） */}
      {impacts.length > 0 && (
        <div className="rounded-lg border border-amber/30 bg-amber/5 p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={11} className="text-amber shrink-0" />
            <span className="text-11 text-amber font-medium">未来计划待重审</span>
            <span className="text-10 text-ink-500">{impacts.length} 章</span>
          </div>
          <div className="text-10 text-ink-400 leading-relaxed mb-1.5">
            已写正文被改动后，章纲里「这一章之后」的规划可能已过时。核对完点「已处理」清掉标记即可。
          </div>
          <div className="space-y-1">
            {impacts.map(im => (
              <div key={im.chapterNo} className="flex items-center gap-1.5">
                <span className="text-11 text-ink-100 flex-1 min-w-0">
                  第 {im.chapterNo} 章
                  <span className="text-10 text-ink-500">（因第 {im.fromChapterNo} 章{im.reason}）</span>
                </span>
                <Button variant="bare" type="button" onClick={() => dismissImpact(im.chapterNo)}
                  className="text-10 text-ink-400 hover:text-amber shrink-0">已处理</Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {post.error && <div className="text-11 text-danger px-1">{post.error}</div>}

      {!post.loading && post.scannedAt === 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-900/30 px-3 py-4 text-center text-11 text-ink-500">
          点右上「整理本章」开始扫描
        </div>
      )}

      {!post.loading && post.scannedAt > 0 && post.items.length === 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-900/30 px-3 py-4 text-center text-11 text-ink-500">
          本章没有需要整理的条目
        </div>
      )}

      {POST_KINDS.map(k => {
        const list = post.items.filter(i => i.kind === k.kind)
        if (list.length === 0) return null
        return (
          <div key={k.kind}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-11 text-amber font-medium">{k.label}</span>
              <span className="text-10 text-ink-500">{list.length} 条</span>
              <span className="text-10 text-ink-600 truncate">{k.hint}</span>
            </div>
            <div className="space-y-1">
              {list.map(it => {
                const meta = POST_STATUS_META[it.status]
                // 无变化的不给勾（写了也没意义）
                const canPick = it.status !== 'registered'
                return (
                  <div key={it.key}
                    className={`rounded-lg border px-2 py-1.5 ${canPick ? 'border-ink-600 bg-ink-900/50' : 'border-ink-700/60 bg-ink-900/20'}`}>
                    <div className="flex items-start gap-1.5">
                      {canPick ? (
                        <input
                          type="checkbox"
                          checked={postPicked.has(it.key)}
                          onChange={e => setPostPicked(prev => {
                            const n = new Set(prev)
                            e.target.checked ? n.add(it.key) : n.delete(it.key)
                            return n
                          })}
                          className="mt-3px shrink-0 accent-amber cursor-pointer"
                          title="勾选后一键写入"
                        />
                      ) : (
                        <span className="mt-3px w-3 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-12 text-ink-100">{it.label}</span>
                          <span className={`inline-block px-1 py-px rounded text-9 border ${meta.cls}`}>{meta.label}</span>
                        </div>
                        {it.detail && <div className="mt-0.5 text-11 text-ink-300 leading-relaxed">{it.detail}</div>}
                        {it.evidence && it.evidence !== it.detail && (
                          <div className="mt-1 text-10 text-ink-500 border-l-2 border-ink-700 pl-1.5 leading-relaxed">
                            「{it.evidence}」
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {post.items.length > 0 && (
        <Button onClick={commitPost}
          disabled={postSaving || postPicked.size === 0} variant="primary" size="md" className="w-full flex items-center justify-center">
          {postSaving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          {postSaving ? '写入中' : `写入选中的 ${postPicked.size} 项`}
        </Button>
      )}
    </div>
  )
}

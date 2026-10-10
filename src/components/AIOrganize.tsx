import { foldVh } from '../lib/theme'
import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Check, Loader2, AlertCircle, RefreshCw, CircleStop,
  CheckSquare, Square, BookOpen, ClipboardPaste, Database,
} from 'lucide-react'
import { Modal } from './Modal'
import type { CalendarDef, Chapter, TabDef } from '../lib/types'
import { getAllChapters, getAllVolumes } from '../lib/db'
import { getChapterTexts } from '../lib/aiContext'
import { flattenChapters } from '../lib/chapterSeq'
import type { OrganizeResult } from '../lib/aiTasks'
import type { VisCtx } from '../lib/schema'
import { useAIReady } from '../lib/useAIReady'
import { useTaskRunner } from '../lib/aiTaskCenter'
import { showToast } from './dialogs'
import { organizeHint, AI_DISABLED_HINT, isDirectedPairTab } from '../lib/aiScope'
import { organizeKeyColsOf, organizeRows } from '../lib/organizeRows'
import AutoTextarea from './AutoTextarea'
import { Button } from './Button'

interface Props {
  tab: TabDef
  /** 已有行数据（含未保存草稿合并结果），用于判重——必须传全，否则重复条目会漏过 */
  existing: Record<string, string>[]
  calendars?: CalendarDef[]
  ctx: VisCtx
  /** 采用：批量写入选中的新行 */
  onAdd: (rows: Record<string, string>[]) => Promise<void> | void
  onClose: () => void
}

type SourceMode = 'chapters' | 'paste' | 'settings'

/**
 * AI 整理弹窗。
 *
 * 与「AI 新增」的本质区别：新增是凭空造设定，整理是把作者**已经写出来**的事实登记入表。
 * 因此这里必须做到两件事：
 *   1. 数据来源明确（指定章节正文 / 手动粘贴 / 仅依据已有设定）；
 *   2. 绝不产生重复条目 —— prompt 里带上已登记条目清单，返回后再按关键列本地去重。
 */
export default function AIOrganize({ tab, existing, calendars = [], ctx = { type: 'full', features: [] }, onAdd, onClose }: Props) {
  // 🔴 未配置模型时**预先禁用**「开始整理」（2026-09-20 六维审计 F1）。
  //    原先只按 `loading` 禁用 ⇒ 没配模型的机器上按钮是可点的，点下去要等一整轮请求失败
  //    才弹 toast，用户只会以为「点了没反应」。判据与真实调用一致：整理链路走 requireActiveProvider。
  const { ready: aiReady } = useAIReady()
  const [mode, setMode] = useState<SourceMode>('chapters')
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [paste, setPaste] = useState('')
  const [useCtx, setUseCtx] = useState(true)

  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  /** apply（写入表格）自身的失败 —— 与 AI 任务的 error 分开存，共用同一个提示框展示 */
  const [applyErr, setApplyErr] = useState<string | null>(null)

  // 🔴 接到任务中心（清单 #009）：切页签 / 关弹窗都不会再掐断请求，结果也不会蒸发。
  //    弹窗重开时 `result` 直接从任务中心读回，因此「切走再回来」结果仍在。
  const t = useTaskRunner<OrganizeResult, string>({
    ownerTab: tab.id, kind: 'organize', title: `AI 整理 · ${tab.name}`,
    // 整理结果会写进这张表 —— 若别的任务同时也在写它，任务中心会轻提示一次（不阻断）
    writes: [`table:${tab.id}`],
  })
  const loading = t.running
  const phase = t.task?.progress ?? ''
  const result = t.result
  const error = t.error || applyErr

  // 结果一到（含重新挂载后从任务中心读回）就默认全选 —— 与迁移前行为一致
  useEffect(() => {
    if (t.result) setChecked(new Set(t.result.rows.map((_, i) => i)))
  }, [t.result])

  const keyCols = useMemo(() => organizeKeyColsOf(tab), [tab])
  const directed = isDirectedPairTab(tab.id)
  // 编号列由系统自动续号，不让模型插手
  const aiCols = useMemo(() => (tab.columns ?? []).filter(c => c.name !== '编号'), [tab])

  useEffect(() => {
    let alive = true
    Promise.all([getAllChapters(), getAllVolumes()])
      .then(([list, vols]) => {
        if (!alive) return
        // 按 (卷序, 章序) 展平：直接全局按 order 排会把各卷同序号的章交错，
        // 「最后一章」「最近 3 章」默认勾选就会喂错章给 AI
        const sorted = flattenChapters(vols, list)
        setChapters(sorted)
        // 默认勾选最后一章：多数场景是「刚写完一章，顺手整理」
        const last = sorted.filter(c => c.content.trim()).slice(-1)[0]
        if (last) setPicked(new Set([last.id]))
      })
      .catch(() => setChapters([]))
    return () => { alive = false }
  }, [ctx])

  const written = useMemo(() => chapters.filter(c => c.content.trim()), [chapters])

  const stop = () => t.stop()

  const run = () => {
    // 前置校验放在**起任务之前** —— 「没勾章节」这类问题当场提示即可，不该起一个必然失败的任务
    if (mode === 'chapters' && picked.size === 0) {
      showToast('请至少勾选一章正文，或切换到「仅依据已有设定」/「手动粘贴」。', 'info')
      return
    }
    if (mode === 'paste' && !paste.trim()) { showToast('请先粘贴要整理的文本。', 'info'); return }
    setApplyErr(null)
    setChecked(new Set())
    // 输入在**发起时快照进闭包**：任务在 store 里跑，用户切走 / 关弹窗后不应再受界面影响
    const srcMode = mode, srcPicked = [...picked], srcPaste = paste, srcUseCtx = useCtx
    // ⚠️ 闭包参数**不能叫 `ctx`** —— 会遮蔽组件的 `props.ctx`（VisCtx），
    //    传进 organizeRows 的就不是项目可见性上下文了（tsc 当场抓到过）。
    t.run(async job => {
      let src = ''
      if (srcMode === 'chapters') {
        job.progress('正在读取章节正文…')
        src = await getChapterTexts(srcPicked, 16000)
        if (!src.trim()) throw new Error('勾选的章节还没有正文内容。')
      } else if (srcMode === 'paste') {
        src = srcPaste
      }

      // 执行体在 lib/organizeRows.ts —— 与「一键拆书」末尾的「整理关系」阶段共用同一套口径
      // （候选值注入 / 项目资料打包 / 本地判重），不让两处各写一份导致漂移。
      return organizeRows(tab, {
        existing,
        sourceText: src,
        useCtx: srcUseCtx,
        includeChapterList: srcMode !== 'chapters',
        maxRows: 12,
        signal: job.signal,
        ctx,
        calendars,
        onPhase: job.progress,
      })
    })
  }

  const apply = async () => {
    if (!result) return
    const rows = result.rows.filter((_, i) => checked.has(i))
    if (rows.length === 0) return
    setAdding(true)
    try {
      await onAdd(rows)
      onClose()
    } catch (e) {
      setApplyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  const toggleChapter = (id: string) => {
    setPicked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const toggleRow = (i: number) => {
    setChecked(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  const modeBtn = (m: SourceMode, icon: React.ReactNode, label: string) => (
    <Button variant="toggle" selected={mode === m}
      onClick={() => setMode(m)}
      className="flex items-center gap-1.5 rounded-lg border"
    >
      {icon} {label}
    </Button>
  )

  return (
    <Modal open onClose={onClose} icon={<Sparkles size={14} />} title={`AI 整理 · ${tab.name}`} width="2xl" maxHeight="90vh">

        <div className="space-y-4">
          <p className="text-12 text-ink-400 leading-relaxed">
            {organizeHint(tab.id)}
            <br />
            判重依据：<span className="text-amber/80">{keyCols.join(' + ') || '（首列）'}</span>
            {directed && '（A→B 为有向关系；同一对可登记多种关系，仅「同对同向 + 同类型」才算重复）'}，已登记 {existing.length} 条，模型不会重复生成。
          </p>

          {/* 数据来源 */}
          <div className="space-y-2">
            <div className="text-12 text-ink-300">整理依据</div>
            <div className="flex items-center gap-2 flex-wrap">
              {modeBtn('chapters', <BookOpen size={12} />, '指定章节正文')}
              {modeBtn('paste', <ClipboardPaste size={12} />, '手动粘贴文本')}
              {modeBtn('settings', <Database size={12} />, '仅依据已有设定')}
            </div>

            {mode === 'chapters' && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/40">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-700 text-11 text-ink-400">
                  <span>已选 {picked.size} / {written.length} 章（有正文的章节）</span>
                  <Button variant="bare"
                    onClick={() => setPicked(new Set(written.slice(-3).map(c => c.id)))}
                    className="ml-auto px-2 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700"
                  >
                    最近 3 章
                  </Button>
                  <Button variant="bare"
                    onClick={() => setPicked(new Set(written.map(c => c.id)))}
                    className="px-2 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700"
                  >
                    全选
                  </Button>
                  <Button variant="bare"
                    onClick={() => setPicked(new Set())}
                    className="px-2 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700"
                  >
                    清空
                  </Button>
                </div>
                <div className="overflow-y-auto p-1.5"
style={{ maxHeight: foldVh('26vh') }}>
                  {written.length === 0 && (
                    <div className="px-2 py-3 text-12 text-ink-500">还没有写好正文的章节，可改用「仅依据已有设定」。</div>
                  )}
                  {written.map(c => (
                    <Button variant="bare"
                      key={c.id}
                      onClick={() => toggleChapter(c.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-ink-800/60"
                    >
                      {picked.has(c.id)
                        ? <CheckSquare size={13} className="text-amber shrink-0" />
                        : <Square size={13} className="text-ink-600 shrink-0" />}
                      <span className="text-12 text-ink-200 truncate">{c.title || '未命名章节'}</span>
                      <span className="ml-auto text-11 text-ink-500 shrink-0">{c.wordCount || 0} 字</span>
                    </Button>
                  ))}
                </div>
                <div className="px-3 py-1.5 border-t border-ink-700 text-11 text-ink-500">
                  选太多章会超出模型上下文，超出部分自动截断；建议一次 1~3 章，整理更准。
                </div>
              </div>
            )}

            {mode === 'paste' && (
              <AutoTextarea
                value={paste}
                onChange={setPaste}
                placeholder="把要整理的文本粘贴进来（章节片段、大纲草稿、设定笔记都行）……"
                textClass="text-13"
                minHeight={90}
                maxHeight={240}
              />
            )}

            {mode === 'settings' && (
              <div className="text-11 text-ink-500 px-1">
                不带正文，仅从已填写的世界观 / 角色卡 / 各类设定表中，挑出本表尚未登记的条目。
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-12 text-ink-300 cursor-pointer select-none">
            <input type="checkbox" checked={useCtx} onChange={e => setUseCtx(e.target.checked)} className="accent-amber" />
            带入项目资料（世界观 / 角色卡 / 各类设定），让人名与设定对得上
          </label>

          {!result && (
            <div className="flex items-center gap-2">
              <Button onClick={run}
                disabled={loading || !aiReady} title={!aiReady ? AI_DISABLED_HINT : undefined} variant="primary" size="md" className="flex items-center">
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {loading ? (phase || '正在整理…') : '开始整理'}
              </Button>
              {loading && (
                <Button onClick={stop} variant="secondary" size="md" className="flex items-center">
                  <CircleStop size={12} /> 停止
                </Button>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <>
              <div className="text-12 text-ink-400">
                模型返回 {result.rawCount} 条
                {result.dupSkipped > 0 && <> · 与已有条目重复已丢弃 <span className="text-amber/80">{result.dupSkipped}</span> 条</>}
                {result.invalidSkipped > 0 && <> · 关键列缺失丢弃 {result.invalidSkipped} 条</>}
                · 可新增 <span className="text-amber/80">{result.rows.length}</span> 条
              </div>

              {result.rows.length === 0 ? (
                <div className="px-3 py-3 rounded-lg bg-ink-900/50 border border-ink-700 text-12 text-ink-400">
                  没有可新增的条目 —— 要么正文里的内容已经全部登记过，要么这段文本里没有可抽取的信息。
                  可以换几章正文，或改用「手动粘贴」给一段更明确的文本。
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Button variant="bare"
                      onClick={() => setChecked(new Set(result.rows.map((_, i) => i)))}
                      className="px-2 py-1 rounded bg-ink-800 border border-ink-700 text-11 text-ink-300 hover:bg-ink-700"
                    >
                      全选
                    </Button>
                    <Button variant="bare"
                      onClick={() => setChecked(new Set())}
                      className="px-2 py-1 rounded bg-ink-800 border border-ink-700 text-11 text-ink-300 hover:bg-ink-700"
                    >
                      清空
                    </Button>
                    <span className="text-11 text-ink-500">取消勾选即不写入；写入后仍可在表格里继续编辑。</span>
                  </div>

                  <div className="space-y-2 overflow-y-auto pr-1"
                  style={{ maxHeight: foldVh('38vh') }}>
                    {result.rows.map((row, i) => (
                      <Button variant="bare"
                        key={i}
                        onClick={() => toggleRow(i)}
                        className={`w-full text-left !justify-start rounded-lg border px-3 py-2 transition-colors ${
                          checked.has(i) ? 'border-amber/30 bg-amber/5' : 'border-ink-700 bg-ink-900/40 opacity-60'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          {checked.has(i)
                            ? <CheckSquare size={13} className="text-amber shrink-0" />
                            : <Square size={13} className="text-ink-600 shrink-0" />}
                          <span className="text-12 font-medium text-ink-100 truncate">
                            {keyCols.map(c => row[c]).filter(Boolean).join(' — ') || '（未命名条目）'}
                          </span>
                        </div>
                        <div className="pl-5 space-y-0.5">
                          {aiCols.map(c =>
                            keyCols.includes(c.name) || !row[c.name]?.trim() ? null : (
                              <div key={c.name} className="text-11 text-ink-400 break-words">
                                <span className="text-ink-500">{c.name}：</span>
                                {row[c.name]}
                              </div>
                            ),
                          )}
                        </div>
                      </Button>
                    ))}
                  </div>
                </>
              )}

              <div className="flex items-center gap-2 pt-1">
                {result.rows.length > 0 && (
                  <Button onClick={apply}
                    disabled={adding || checked.size === 0} variant="primary" size="md" className="flex items-center">
                    {adding ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    添加选中 {checked.size} 条
                  </Button>
                )}
                <Button
                  onClick={() => { t.clear(); setChecked(new Set()) }}
                  variant="secondary" size="md"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-12 hover:bg-ink-600"
                >
                  <RefreshCw size={12} /> 重新整理
                </Button>
                <Button variant="secondary" onClick={onClose} className="ml-auto">
                  取消
                </Button>
              </div>
            </>
          )}
        </div>
    </Modal>
  )
}

/**
 * 我的参考资料（2.8.0 · 台账 #017）—— 挂在「素材资料」页末尾，**不新增页签**。
 *
 * 与上面的内置素材的区别：那些是「只读参考」（人看的），这些是「挂载资料」（AI 按需读的）。
 *
 * 🔴 三条界面纪律（与本项目其它 AI 面板同款）：
 *   · 长任务（建索引）走 `useTaskRunner` —— 切走再回来进度还在，不能把 loading 放在本地 state；
 *   · 「异步落盘 + 通知界面刷新」**先 await 写盘再 setVer**，否则会读到写盘前的旧值；
 *   · 未配置时按钮**置灰并写明原因**（`embeddingStatus` 给原因），不让作者点了才发现不能跑。
 *
 * 🔴 导入**不自动建索引**（`enabled: false`）—— 省嵌入额度，等作者显式勾选启用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Database, FileText, Loader2, Plus, Search, Trash2, Upload, X,
} from 'lucide-react'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import { confirmDialog, showToast } from './dialogs'
import { useTaskRunner } from '../lib/aiTaskCenter'
import * as db from '../lib/db'
import { readDocxText, isDocxFileName, isLegacyDocFileName } from '../lib/docxImport'
import { embeddingStatus, resolveEmbedConfig } from '../lib/semantic/settings'
import type { RecallHit } from '../lib/semantic/recall'
import {
  KB_MAX_CHARS, KB_TOP_K,
  importDoc, listDocs, recallKnowledge, reindexAll, reindexDoc, removeDoc, setDocEnabled,
  type KbDoc, type KbSourceType, type ReindexProgress,
} from '../lib/knowledgeBase'

interface ReindexResult {
  ok: boolean
  docs: number
  chunks: number
  failed: number
  error?: string
}

export default function KnowledgeBasePanel() {
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [hint, setHint] = useState('')
  /** 嵌入模型是否配好 —— 与 hint 分开存：hint 是给人看的文案，判定不能依赖它 */
  const [ready, setReady] = useState(false)
  const [ver, setVer] = useState(0)
  const [busy, setBusy] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<RecallHit[] | null>(null)
  const [probing, setProbing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const runner = useTaskRunner<ReindexResult, ReindexProgress>({
    ownerTab: 'material-library',
    kind: 'kb-index',
    title: '建立参考资料索引',
    writes: ['kb'],
  })

  const refresh = useCallback(async () => {
    // ⚠️ 项目 id 现取：面板可能跨项目存活（切项目后不能拿旧 id 去读）
    setDocs(await listDocs(db.getCurrentProjectId()))
    const st = await embeddingStatus()
    setReady(st.ready)
    setHint(st.ready ? st.label : st.reason)
  }, [])

  useEffect(() => { void refresh() }, [refresh, ver])

  // 任务一结束就重新读一次（索引数与状态变了）；只认已结束的状态
  const taskStatus = runner.task?.status
  useEffect(() => {
    if (taskStatus === 'done' || taskStatus === 'failed') setVer(v => v + 1)
  }, [taskStatus])

  const currentProject = () => db.getCurrentProjectId()

  /** 选文件导入（txt / md / docx；.doc 旧格式明确劝退） */
  const onFiles = async (files: FileList | null) => {
    const pid = currentProject()
    if (!files || files.length === 0) return
    if (!pid) { showToast('请先打开一个项目', 'error'); return }
    setBusy(true)
    let added = 0
    let truncated = 0
    const failed: string[] = []
    try {
      for (const f of Array.from(files)) {
        try {
          let text = ''
          let sourceType: KbSourceType = 'txt'
          if (isLegacyDocFileName(f.name)) {
            failed.push(`${f.name}（.doc 是旧版格式，请先另存为 .docx 或 .txt）`)
            continue
          } else if (isDocxFileName(f.name)) {
            text = (await readDocxText(await f.arrayBuffer())).text
            sourceType = 'docx'
          } else {
            text = await f.text()
            sourceType = /\.md$/i.test(f.name) ? 'md' : 'txt'
          }
          const r = await importDoc({
            projectId: pid,
            title: f.name.replace(/\.[^.]+$/, ''),
            text,
            sourceType,
          })
          if (r.ok) {
            added++
            if (r.truncated) truncated++
          } else {
            failed.push(`${f.name}（${r.error ?? '未知原因'}）`)
          }
        } catch (e) {
          failed.push(`${f.name}（${e instanceof Error ? e.message : String(e)}）`)
        }
      }
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
    if (added > 0) setVer(v => v + 1)
    if (added > 0 && failed.length === 0) {
      showToast(truncated > 0
        ? `已导入 ${added} 篇（其中 ${truncated} 篇超长已截到 ${KB_MAX_CHARS} 字，见下方说明）`
        : `已导入 ${added} 篇。默认未启用 —— 勾选「启用」后才会参与召回`)
    } else if (added > 0) {
      showToast(`已导入 ${added} 篇，另有 ${failed.length} 篇失败：${failed[0]}`, 'error')
    } else if (failed.length > 0) {
      showToast(`导入失败：${failed[0]}`, 'error')
    }
  }

  /** 粘贴文本导入 */
  const onPasteAdd = async () => {
    const pid = currentProject()
    if (!pid) { showToast('请先打开一个项目', 'error'); return }
    const r = await importDoc({
      projectId: pid,
      title: pasteTitle.trim() || '粘贴的参考资料',
      text: pasteText,
      sourceType: 'paste',
    })
    if (!r.ok) { showToast(r.error ?? '导入失败', 'error'); return }
    setPasteTitle('')
    setPasteText('')
    setPasteOpen(false)
    setVer(v => v + 1)
    showToast(r.truncated
      ? `已导入（内容超长，已截到 ${KB_MAX_CHARS} 字）`
      : '已导入。默认未启用 —— 勾选「启用」后才会参与召回')
  }

  /**
   * 勾选启用。
   * 🔴 刚开启且还没建索引时**顺手建一份**（配好嵌入模型才做）——
   *    否则作者以为开了就生效，实际召回一直空，很难自己查出原因。
   */
  const onToggle = async (doc: KbDoc, on: boolean) => {
    const pid = currentProject()
    if (!pid) return
    await setDocEnabled(pid, doc.id, on)
    if (on && doc.chunkCount === 0) {
      const cfg = await resolveEmbedConfig()
      if (cfg) {
        const r = await reindexDoc(pid, doc.id, cfg)
        showToast(r.ok ? `已启用并建立索引（${r.chunks} 块）` : `已启用，但索引没建起来：${r.error ?? '未知原因'}`,
          r.ok ? 'success' : 'error')
      } else {
        showToast('已启用。还没配嵌入模型，现在只走关键词匹配（效果差些）', 'success')
      }
    }
    setVer(v => v + 1)
  }

  const onRemove = async (doc: KbDoc) => {
    const ok = await confirmDialog({
      title: '删除参考资料',
      message: `将删除「${doc.title}」及其索引片段。\n\n删掉之后，写作时不会再召回它的内容（正文与设定不受影响）。`,
      danger: true,
    })
    if (!ok) return
    const okDel = await removeDoc(currentProject(), doc.id)
    showToast(okDel ? '已删除' : '删除失败', okDel ? 'success' : 'error')
    setVer(v => v + 1)
  }

  /** 重建索引（只对**已启用**的资料）—— 长任务，走任务中心 */
  const onReindex = async () => {
    const pid = currentProject()
    if (!pid) { showToast('请先打开一个项目', 'error'); return }
    const cfg = await resolveEmbedConfig()
    if (!cfg) {
      showToast(hint || '请先在「模型设置 → 语义检索」里选好嵌入模型', 'error')
      return
    }
    runner.run(
      async ctx => reindexAll(pid, cfg, ctx.signal, p => ctx.progress(p)),
      info => {
        const r = info.result
        if (info.status === 'done' && r?.ok) {
          return {
            text: `「建立参考资料索引」完成：已索引 ${r.docs} 篇 / ${r.chunks} 块${r.failed ? ` · ${r.failed} 篇失败` : ''}`,
            kind: 'success' as const,
          }
        }
        if (info.status === 'done' && r && !r.ok) {
          return { text: `「建立参考资料索引」失败：${r.error ?? '未知原因'}`, kind: 'error' as const }
        }
        return null
      },
    )
  }

  /** 检索预览：让作者自己判断"这篇资料到底能不能被捞出来" */
  const onProbe = async () => {
    const query = q.trim()
    if (!query) return
    setProbing(true)
    try {
      const cfg = await resolveEmbedConfig()
      setHits(await recallKnowledge(query, { projectId: currentProject(), cfg, topK: KB_TOP_K + 2 }))
    } finally {
      setProbing(false)
    }
  }

  const running = runner.running
  const prog = runner.task?.progress ?? null
  const enabledCount = docs.filter(d => d.enabled).length
  const canIndex = !running && docs.length > 0 && ready

  return (
    <div className="mt-8 pt-6 border-t border-ink-800">
      <div className="flex items-center gap-1.5 mb-1">
        <h2 className="text-base font-bold text-ink-50">我的参考资料</h2>
        <span className="text-12 text-ink-400">长期挂载 · 按需召回</span>
        <HelpPopover title="我的参考资料怎么用" side="right" width="24rem" size={13}>
          <p>把设定集 / 资料 / 笔记挂在这里，写作时 AI 会按「与当前章节意思相近」自动捞出相关片段补进上下文 —— 与上面那些内置素材不同，这些是<b>给你的 AI 读</b>的。</p>
          <p className="mt-1.5">与「一键拆书」的区别：拆书是把一本书<b>一次性</b>抽成设定、抽完就散；这里是<b>长期挂着</b>、随时可用。</p>
          <p className="mt-1.5">🔴 <b>导入不会自动生效</b>：要你在列表里勾选「启用」，它才会参与召回。导入本身也不消耗额度。</p>
          <p className="mt-1.5">配好嵌入模型走语义匹配（更准）；没配则退化为关键词匹配（还能用，只是差些）。</p>
          <p className="mt-1.5">📁 资料只存在本机：<b>不参与云盘同步，也不打进备份 / 导出</b>（换机器要重新导入一次）。</p>
          <AIDataSourceNote feature="kb-recall" />
        </HelpPopover>
      </div>
      <p className="mt-1 mb-3 text-13 text-ink-300">
        支持 .txt / .md / .docx（或直接粘贴）。长文档只按片段召回，不会整篇塞进上下文。
      </p>

      <div className={docs.length === 0 && !pasteOpen ? 'hidden' : 'space-y-2'}>
        {/* 工具栏 */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.docx,text/plain"
            multiple
            className="hidden"
            onChange={e => void onFiles(e.target.files)}
          />
          <Button variant="secondary" size="sm" disabled={running || busy}
            onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} 导入文件
          </Button>
          <Button variant="secondary" size="sm" disabled={running || busy}
            onClick={() => setPasteOpen(v => !v)}>
            <Plus size={12} /> 粘贴文本
          </Button>
          {docs.length > 0 && (
            <Button variant="secondary" size="sm" disabled={!canIndex || enabledCount === 0}
              onClick={() => void onReindex()}
              title={enabledCount === 0 ? '先把要用的资料勾选「启用」' : !canIndex ? (hint || '先配好嵌入模型') : '重新嵌入所有已启用资料（换了嵌入模型后必须用它）'}>
              重建索引
            </Button>
          )}
          {running && <Button variant="secondary" size="sm" onClick={() => runner.stop()}>停止</Button>}
          <span className="text-11 text-ink-500">
            {docs.length > 0 && `共 ${docs.length} 篇 · 已启用 ${enabledCount} 篇`}
            {!hint ? '' : ` · ${hint}`}
          </span>
        </div>

        {/* 进度 */}
        {running && prog && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-11 text-ink-400">
              <Loader2 size={11} className="animate-spin" />
              <span>正在向量化{prog.title ? `：${prog.title}` : '…'}</span>
              {prog.total > 0 && <span className="text-ink-500">{prog.done} / {prog.total}</span>}
            </div>
            {prog.total > 0 && (
              <div className="h-1 rounded-full bg-ink-800 overflow-hidden">
                <div className="h-full bg-amber/70 transition-all"
                  style={{ width: `${Math.min(100, Math.round((prog.done / prog.total) * 100))}%` }} />
              </div>
            )}
          </div>
        )}

        {runner.error && (
          <div className="flex items-start gap-1.5 text-11 text-danger">
            <AlertCircle size={11} className="mt-0.5 shrink-0" /> {runner.error}
          </div>
        )}

        {/* 粘贴区 */}
        {pasteOpen && (
          <div className="bg-ink-800 border border-ink-700 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 bg-ink-950 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
                value={pasteTitle}
                onChange={e => setPasteTitle(e.target.value)}
                placeholder="资料标题（留空则用「粘贴的参考资料」）"
              />
              <button className="shrink-0 text-ink-500 hover:text-ink-200" onClick={() => setPasteOpen(false)} title="收起">
                <X size={14} />
              </button>
            </div>
            <textarea
              className="w-full h-32 bg-ink-950 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-2 outline-none focus:border-amber/40 placeholder:text-ink-600 resize-y"
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder="把资料粘贴到这里…"
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" disabled={!pasteText.trim() || busy}
                onClick={() => void onPasteAdd()}>
                添加
              </Button>
              <span className="text-11 text-ink-500">
                单篇上限 {KB_MAX_CHARS.toLocaleString()} 字，超出会截断并告知
              </span>
            </div>
          </div>
        )}

        {/* 列表 */}
        {docs.map(d => (
          <div key={d.id} className="flex items-center gap-2.5 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
            <input
              type="checkbox"
              className="accent-amber shrink-0"
              checked={d.enabled}
              disabled={running || busy}
              onChange={e => void onToggle(d, e.target.checked)}
              title={d.enabled ? '已启用：会被召回' : '未启用：不会被召回'}
            />
            <FileText size={13} className={`shrink-0 ${d.enabled ? 'text-amber' : 'text-ink-600'}`} />
            <div className="min-w-0 flex-1">
              <div className={`text-12 truncate ${d.enabled ? 'text-ink-100' : 'text-ink-400'}`} title={d.title}>
                {d.title}
              </div>
              <div className="text-10 text-ink-500">
                {d.sourceType.toUpperCase()} · {d.chars.toLocaleString()} 字
                {d.chunkCount > 0 ? ` · 已索引 ${d.chunkCount} 块` : ' · 未建索引'}
              </div>
            </div>
            <Button variant="icon-danger" size="xs" className="shrink-0"
              disabled={running} onClick={() => void onRemove(d)} title="删除这篇及其索引">
              <Trash2 size={12} />
            </Button>
          </div>
        ))}

        {/* 检索预览 */}
        {docs.length > 0 && (
          <div className="pt-1 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1" style={{ maxWidth: 420 }}>
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
                <input
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-ink-950 border border-ink-700 text-ink-200 text-12 outline-none focus:border-amber placeholder:text-ink-600"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void onProbe() }}
                  placeholder="试试检索：粘一句正文，看会捞出哪些片段…"
                />
              </div>
              <Button variant="secondary" size="sm" disabled={probing || !q.trim()} onClick={() => void onProbe()}>
                {probing ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} 试一下
              </Button>
              {hits && (
                <Button variant="bare" size="sm" className="text-ink-400" onClick={() => setHits(null)}>
                  清空结果
                </Button>
              )}
            </div>
            {hits && (
              <div className="space-y-1.5">
                {hits.length === 0 ? (
                  <div className="text-11 text-ink-500">
                    没捞到任何片段 —— 可能这篇资料没启用、没建索引，或内容与查询确实不相关。
                  </div>
                ) : (
                  <>
                    <div className="text-11 text-ink-500">捞到 {hits.length} 段（正式注入时最多取 {KB_TOP_K} 段）：</div>
                    {hits.map((h, i) => (
                      <div key={`${h.refId}-${h.chunkIdx}-${i}`} className="bg-ink-900/60 border border-ink-800 rounded-lg px-3 py-2">
                        <div className="text-10 text-ink-500 mb-0.5">
                          {h.title} · 第 {h.chunkIdx + 1} 段 · 相关度 {h.score.toFixed(2)}
                        </div>
                        <div className="text-11 leading-relaxed text-ink-300 whitespace-pre-wrap break-words">
                          {h.text.length > 300 ? h.text.slice(0, 300) + '…' : h.text}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 空态 */}
      {docs.length === 0 && !pasteOpen && (
        <div className="flex flex-col items-center gap-2 py-6 text-ink-500">
          <Database size={20} />
          <div className="text-12">还没挂载任何参考资料</div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload size={12} /> 导入文件
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPasteOpen(true)}>
              <Plus size={12} /> 粘贴文本
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

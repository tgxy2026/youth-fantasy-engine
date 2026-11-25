/**
 * WCP 资料包导出弹窗（3.7.3 · W4）。
 *
 * 用途：在业务页就近把「当前任务需要的最小资料」打包，下载 / 复制后交给网页模型。
 * 三档中这里只出 Delta / Full（Base 是长期底包，统一在「模型设置 → WCP 模式」导出）。
 *
 * 🔴 纯前端：只读项目数据，不写任何正史；`下载 / 复制` 也不会改动底包过期指纹。
 * 🔴 装入清单如实展示「完整 / 裁剪 / 省略」与原因（来自 `packWcpDocument` 的 TOC），
 *    不把「预算不够」藏成一个总数。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Copy, FileText, FileUp, RefreshCw } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import AutoTextarea from '@/components/common/AutoTextarea'
import NumberField from '@/components/common/NumberField'
import { LoadingState } from '@/components/common/LoadingState'
import { copyText, showToast } from '@/components/dialogs/dialogs'
import { downloadText } from '@/lib/storage/zip'
import { collectWcpPack } from '@/lib/wcp/wcpCollect'
import { packWcpDocument, type WcpPackResult } from '@/lib/wcp/wcpPacker'
import { getWcpScenario } from '@/lib/wcp/wcpTemplates'
import { loadWcpGlobalConfig, loadWcpProjectState } from '@/lib/wcp/wcpSettings'
import {
  WCP_PREV_CHAPTER_MAX,
  WCP_PREV_SUMMARY_MAX,
  type WcpGlobalConfig,
  type WcpSceneId,
} from '@/lib/wcp/wcpTypes'

export interface WcpExportModalProps {
  open: boolean
  onClose: () => void
  scene: WcpSceneId
  chapterId?: string
  chapterTitle?: string
  chapterNo?: number
  /** 编辑器当前草稿（可能尚未落库） */
  draft?: string
  /** 选中片段（润色场景） */
  selectedText?: string
  /** 小传场景的角色 */
  focusCharacterId?: string
  focusCharacterName?: string
  /** 打开「粘贴网页回复」回流弹窗（由调用方负责切换两个弹窗） */
  onOpenImport?: () => void
}

const FIELD_LABEL = 'text-12 text-ink-300'

export default function WcpExportModal({
  open, onClose, scene, chapterId, chapterTitle, chapterNo, draft = '', selectedText = '',
  focusCharacterId, focusCharacterName, onOpenImport,
}: WcpExportModalProps) {
  const meta = getWcpScenario(scene)
  const [cfg, setCfg] = useState<WcpGlobalConfig | null>(null)
  /** 当前项目实际勾选的底包模块（Full 包按作者选择取，不再固定用出厂默认） */
  const [baseModules, setBaseModules] = useState<string[] | null>(null)
  const [kind, setKind] = useState<'delta' | 'full'>(meta.recommendedKind === 'full' ? 'full' : 'delta')
  const [prevChapterCount, setPrevChapterCount] = useState(1)
  const [prevSummaryCount, setPrevSummaryCount] = useState(3)
  const [extra, setExtra] = useState('')
  const [pack, setPack] = useState<WcpPackResult | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    void (async () => {
      const [g, p] = await Promise.all([loadWcpGlobalConfig(), loadWcpProjectState()])
      if (!active) return
      setCfg(g)
      setBaseModules(p.baseModules)
      // 场景明确推荐「完整包」（大纲 / 找茬）时尊重场景；其余沿用全局默认形态
      setKind(meta.recommendedKind === 'full' ? 'full' : g.defaultPackKind)
      setPrevChapterCount(g.prevChapterCount)
      setPrevSummaryCount(g.prevSummaryCount)
      setExtra('')
      setPack(null)
      setNotes([])
    })()
    return () => { active = false }
  }, [open, meta.recommendedKind])

  // 任何取材 / 格式变化都让旧预览失效，避免「改了设置还下载旧包」
  const invalidate = () => setPack(null)

  const build = useCallback(async () => {
    if (!cfg) return
    setBusy(true)
    try {
      const collected = await collectWcpPack({
        kind,
        scene,
        summaryFormat: cfg.summaryFormat,
        ...(chapterId ? { chapterId } : {}),
        ...(chapterNo && chapterNo > 0 ? { chapterNo } : {}),
        ...(chapterTitle ? { chapterTitle } : {}),
        draft,
        selectedText,
        prevChapterCount,
        prevSummaryCount,
        ...(focusCharacterId ? { focusCharacterId } : {}),
        ...(focusCharacterName ? { focusCharacterName } : {}),
        budgetChars: cfg.maxPackBudgetChars,
        ext: cfg.defaultFileExt,
        ...(baseModules ? { baseModules } : {}),
        includeWriterNotes: cfg.includeWriterNotes,
        extraInstruction: extra,
      })
      setPack(packWcpDocument(collected.pack))
      setNotes(collected.notes)
    } catch (e) {
      showToast('资料包装配失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }, [cfg, kind, scene, chapterId, chapterNo, chapterTitle, draft, selectedText, prevChapterCount, prevSummaryCount, focusCharacterId, focusCharacterName, extra, baseModules])

  const copyPack = async () => {
    if (!pack) return
    await copyText(pack.text, '资料包已复制到剪贴板')
  }

  const downloadPack = () => {
    if (!pack || !cfg) return
    const mime = cfg.defaultFileExt === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8'
    downloadText(pack.filename, pack.text, mime)
    showToast('资料包已下载。', 'success')
  }

  const showChapterWindow = scene === 'chapter-continue' || scene === 'chapter-polish' || scene === 'continuity-audit'

  const footer = (
    <>
      <Button variant="secondary" size="md" onClick={onClose}>关闭</Button>
      {onOpenImport && (
        <Button variant="secondary" size="md" onClick={() => { onClose(); onOpenImport() }}>
          粘贴网页回复
        </Button>
      )}
      <Button variant="secondary" size="md" onClick={() => void copyPack()} disabled={!pack}>
        <Copy size={13} /> 复制全文
      </Button>
      <Button variant="primary" size="md" onClick={downloadPack} disabled={!pack}>
        <FileUp size={13} /> 下载 .{cfg?.defaultFileExt ?? 'md'}
      </Button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title={`WCP 导出 · ${meta.name}${chapterNo ? ` · 第${chapterNo}章` : ''}`} width="2xl" maxHeight="86vh" footer={footer} footerAlign="end">
      {!cfg ? <LoadingState text="正在读取 WCP 偏好…" /> : (
        <div className="space-y-4">
          <p className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-11 text-ink-400 leading-relaxed">
            {meta.materialHint}
            <span className="text-ink-500">　·　导出的资料包不会写入任何项目数据；复制与下载都不会改动「底包导出记录」。</span>
          </p>
          {kind === 'full' && baseModules && baseModules.length === 0 && (
            <p className="rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-11 text-amber">
              当前项目没有勾选任何底包模块：完整包只会带当前章增量与规则，不含长期设定。可先到「模型设置 → WCP 模式」勾选底包模块。
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={FIELD_LABEL}>包形态</span>
              <div className="inline-flex gap-1.5">
                <Button variant="toggle" size="sm" selected={kind === 'delta'}
                  onClick={() => { setKind('delta'); invalidate() }}>增量包</Button>
                <Button variant="toggle" size="sm" selected={kind === 'full'}
                  onClick={() => { setKind('full'); invalidate() }}>完整包</Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={FIELD_LABEL}>摘要格式</span>
              <div className="inline-flex gap-1.5">
                <Button variant="toggle" size="sm" selected={cfg.summaryFormat === 'json'}
                  onClick={() => { setCfg({ ...cfg, summaryFormat: 'json' }); invalidate() }}>JSON</Button>
                <Button variant="toggle" size="sm" selected={cfg.summaryFormat === 'markdown'}
                  onClick={() => { setCfg({ ...cfg, summaryFormat: 'markdown' }); invalidate() }}>Markdown 清单</Button>
              </div>
            </div>
            {showChapterWindow && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={FIELD_LABEL}>前文章节数</span>
                  <NumberField value={prevChapterCount} min={0} max={WCP_PREV_CHAPTER_MAX} className="w-20"
                    ariaLabel="前文章节数" onChange={v => { setPrevChapterCount(v ?? 0); invalidate() }} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={FIELD_LABEL}>章节摘要数</span>
                  <NumberField value={prevSummaryCount} min={0} max={WCP_PREV_SUMMARY_MAX} className="w-20"
                    ariaLabel="章节摘要数" onChange={v => { setPrevSummaryCount(v ?? 0); invalidate() }} />
                </div>
              </>
            )}
          </div>

          {cfg.includeWriterNotes && (
            <div>
              <p className={FIELD_LABEL}>作者补充说明（可选，会写进资料包）</p>
              <AutoTextarea value={extra} onChange={v => { setExtra(v); invalidate() }} minRows={3} maxHeight={180}
                placeholder="例如：这一章要让林晚第一次主动用剑；保留上一章的雨夜意象。" />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => void build()} disabled={busy}>
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {pack ? '重新生成' : '生成资料包'}
            </Button>
            {notes.length > 0 && <span className="text-11 text-ink-500">{notes.join('　·　')}</span>}
          </div>

          {pack && (
            <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
              <p className="flex flex-wrap items-center gap-2 text-11 text-ink-400">
                <FileText size={12} className="text-amber" />
                {pack.filename}
                <span className="text-ink-500">· {pack.chars} 字符 / 预算 {pack.budgetChars}</span>
                <span className="text-ink-500">· 完整 {pack.fullCount} / 裁剪 {pack.trimmedCount} / 省略 {pack.droppedCount}</span>
              </p>
              <ul className="mt-1.5 max-h-40 overflow-auto space-y-0.5 text-11 text-ink-300">
                {pack.toc.map(e => (
                  <li key={e.id}>
                    · {e.title}：{e.chars} 字符（{e.scope === 'full' ? '完整' : e.scope === 'trimmed' ? '裁剪' : '省略'}）
                    {e.reason ? <span className="text-ink-500">　{e.reason}</span> : null}
                  </li>
                ))}
              </ul>
              {pack.droppedCount > 0 && (
                <p className="mt-1.5 flex items-start gap-1.5 text-11 text-amber">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  有段落因单包预算被省略。可调大「模型设置 → WCP 模式」里的字符预算，或减少前文章数。
                </p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-11 text-ink-400 hover:text-ink-200">查看全文预览</summary>
                <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-700 bg-ink-950/60 p-2.5 text-11 text-ink-300">
                  {pack.text}
                </pre>
              </details>
            </div>
          )}

          <p className="text-11 text-ink-500 leading-relaxed">
            导出后，把全文放进网页模型（或已持有底包的对话）；回来点「粘贴网页回复」，正文可入章，变动摘要勾选后才写入资料库。
          </p>
        </div>
      )}
    </Modal>
  )
}
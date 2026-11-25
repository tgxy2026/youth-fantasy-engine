/**
 * WCP 网页回复回流弹窗（3.7.3 · W4）。
 *
 * 职责：
 *   ① 把整段网页回复拆成 Part 1 正文 + Part 2 变动摘要（`wcpParser`）；
 *   ② Part 1 永远可用：复制 / 追加 / 替换 / 替换选中 / 交给业务页回调；
 *   ③ Part 2 的 JSON 候选经 `chapterPostProcess` 比对后，**作者勾选**才落库；
 *   ④ JSON 失败时正文照样完整保留，并给「一键切换为 Markdown 清单模式」。
 *
 * 🔴 不静默覆写正史：替换整章要二次确认；候选写入只调用既有 `applyPostProcess`。
 * 🔴 未登记条目（伏笔 / 关系 / 物品 / 小传）只提示，不提供勾选框。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, FileText, ListChecks, Loader2, Replace, Save } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import AutoTextarea from '@/components/common/AutoTextarea'
import { LoadingState } from '@/components/common/LoadingState'
import { confirmDialog, copyText, showToast } from '@/components/dialogs/dialogs'
import type { PostProcessItem, PostProcessStatus } from '@/lib/outline/chapterPostProcess'
import {
  applyWcpCandidates,
  buildWcpCandidates,
  isWcpItemSelectable,
  summarizeWcpCandidates,
} from '@/lib/wcp/wcpApply'
import { hasWcpCandidates, parseWcpReply } from '@/lib/wcp/wcpParser'
import { loadWcpGlobalConfig, saveWcpGlobalConfig } from '@/lib/wcp/wcpSettings'
import { getWcpScenario, wcpContractSample } from '@/lib/wcp/wcpTemplates'
import type { WcpGlobalConfig, WcpSceneId } from '@/lib/wcp/wcpTypes'

export interface WcpImportModalProps {
  open: boolean
  onClose: () => void
  scene: WcpSceneId
  chapterId?: string
  chapterTitle?: string
  chapterNo?: number
  /** 本章正文（候选比对与「替换整章」确认用） */
  content?: string
  onAppendBody?: (text: string) => void
  onReplaceBody?: (text: string) => void
  onReplaceSelection?: (text: string) => void
  /** 业务页专用正文用途（如「存为小传正文」「填入细纲草稿」） */
  onUseBody?: (text: string) => void
  useBodyLabel?: string
  onApplied?: (created: number) => void
}

const STATUS_META: Record<PostProcessStatus, { label: string; cls: string }> = {
  new: { label: '新增', cls: 'border-amber/30 bg-amber/10 text-amber' },
  changed: { label: '可写入', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  registered: { label: '已存在', cls: 'border-ink-700 bg-ink-800/60 text-ink-400' },
  duplicate: { label: '重复', cls: 'border-ink-700 bg-ink-800/60 text-ink-400' },
  unregistered: { label: '需先登记', cls: 'border-danger/30 bg-danger/10 text-danger' },
}

const BODY_LABEL: Record<WcpSceneId, string> = {
  'chapter-continue': '接续正文',
  'chapter-polish': '润色后片段',
  'outline-expand': '推纲 / 细纲文本',
  'continuity-audit': '矛盾清单',
  'bio-organize': '小传正文',
}

export default function WcpImportModal({
  open, onClose, scene, chapterId, chapterTitle, chapterNo, content = '',
  onAppendBody, onReplaceBody, onReplaceSelection, onUseBody, useBodyLabel, onApplied,
}: WcpImportModalProps) {
  const meta = getWcpScenario(scene)
  const [cfg, setCfg] = useState<WcpGlobalConfig | null>(null)
  const [text, setText] = useState('')
  const [items, setItems] = useState<PostProcessItem[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [building, setBuilding] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<{ created: number; failed: string[]; warnings?: string[] } | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    void (async () => {
      const g = await loadWcpGlobalConfig()
      if (!active) return
      setCfg(g)
      setText('')
      setItems(null)
      setPicked(new Set())
      setResult(null)
    })()
    return () => { active = false }
  }, [open])

  const parsed = useMemo(
    () => (text.trim() ? parseWcpReply(text, cfg?.summaryFormat ?? 'json') : null),
    [text, cfg?.summaryFormat],
  )

  // 粘贴文本或摘要格式一变，旧候选立即作废 —— 否则会把「上一段文本」的比对结果写进库里
  useEffect(() => {
    setItems(null)
    setPicked(new Set())
    setResult(null)
  }, [text, cfg?.summaryFormat])

  const stats = items ? summarizeWcpCandidates(items) : null
  /** 没有卡片 / 纯文本 / JSON 失败时都展示原文，避免「解析失败就什么都看不到」 */
  const showRawChanges = !!parsed && (parsed.format === 'none' || parsed.markdownCards.length === 0)

  const copyBody = async () => {
    if (!parsed?.body) return
    await copyText(parsed.body, '正文已复制到剪贴板')
  }

  const appendBody = () => {
    if (!parsed?.body || !onAppendBody) return
    onAppendBody(parsed.body)
    showToast('已追加到章末（可在编辑器里继续调整）。', 'success')
  }

  const replaceBody = async () => {
    if (!parsed?.body || !onReplaceBody) return
    const ok = await confirmDialog({
      title: '替换整章正文？',
      message: '这会用第一部分正文替换本章现有正文。当前正文会按既有保存机制落库，替换前建议先确认已保存或已有历史版本。',
      confirmText: '替换整章',
      danger: true,
    })
    if (!ok) return
    onReplaceBody(parsed.body)
    showToast('已替换整章正文。', 'success')
  }

  const switchToMarkdown = async () => {
    try {
      const saved = await saveWcpGlobalConfig({ summaryFormat: 'markdown' })
      setCfg(saved)
      showToast('已切换为 Markdown 清单模式；之后的导出与解析都按该格式。', 'success')
    } catch (e) {
      showToast('切换失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const switchFormat = async (format: WcpGlobalConfig['summaryFormat']) => {
    try {
      setCfg(await saveWcpGlobalConfig({ summaryFormat: format }))
    } catch (e) {
      showToast('格式切换失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const buildCandidates = async () => {
    if (!parsed || !chapterId) return
    setBuilding(true)
    setResult(null)
    try {
      const built = await buildWcpCandidates({
        chapterId,
        chapterTitle: chapterTitle ?? '',
        content,
        changes: parsed.changes,
      })
      setItems(built.items)
      setPicked(new Set(built.items.filter(isWcpItemSelectable).map(i => i.key)))
      if (!built.items.length) showToast('本次变动摘要没有可核对条目。', 'info')
      if (built.notes.length) showToast(built.notes.join('　'), 'info')
    } catch (e) {
      showToast('候选生成失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBuilding(false)
    }
  }

  const applySelected = async () => {
    if (!items || !chapterId) return
    const chosen = items.filter(i => picked.has(i.key) && isWcpItemSelectable(i))
    if (!chosen.length) {
      showToast('请先勾选要写入的条目。', 'error')
      return
    }
    setApplying(true)
    try {
      const res = await applyWcpCandidates(
        { chapterId, chapterTitle: chapterTitle ?? '', content },
        chosen,
        chapterNo ?? 0,
      )
      setResult(res)
      if (res.created > 0) {
        setPicked(new Set())
        showToast(`已写入 ${res.created} 条；失败 ${res.failed.length} 条。`, res.failed.length ? 'info' : 'success')
        onApplied?.(res.created)
      } else {
        showToast('没有条目写入成功；请查看下方失败原因。', 'error')
      }
    } catch (e) {
      showToast('写入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setApplying(false)
    }
  }

  const togglePicked = (key: string) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={`WCP 回流 · ${meta.name}`} width="2xl" maxHeight="88vh"
      footer={<Button variant="secondary" size="md" onClick={onClose}>关闭</Button>} footerAlign="end">
      {!cfg ? <LoadingState text="正在读取 WCP 偏好…" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
            <span className="text-11 text-ink-500">摘要格式</span>
            <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'json'}
              onClick={() => void switchFormat('json')}>JSON</Button>
            <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'markdown'}
              onClick={() => void switchFormat('markdown')}>Markdown 清单</Button>
            <span className="ml-auto text-11 text-ink-500">只解析、不自动写入；正文与候选都要你确认。</span>
          </div>

          <AutoTextarea value={text} onChange={setText} minRows={7} maxHeight={300} textClass="text-12"
            placeholder={`把网页模型的完整回复粘到这里。示例：\n${wcpContractSample(cfg.summaryFormat)}`} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setText(wcpContractSample(cfg.summaryFormat))}>填入示例</Button>
            <Button variant="secondary" size="sm" onClick={() => { setText(''); setItems(null); setResult(null) }} disabled={!text}>清空</Button>
            {parsed && <span className="text-11 text-ink-500">识别为：{parsed.format === 'json' ? 'JSON 变动摘要' : parsed.format === 'markdown' ? 'Markdown 清单' : '纯正文'}</span>}
          </div>

          {parsed && (
            <>
              {parsed.jsonFailed && (
                <div className="rounded-lg border border-amber/35 bg-amber/10 px-3 py-2.5">
                  <p className="flex items-start gap-1.5 text-12 text-amber">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    检测到当前网页模型返回的 JSON 格式不完整。已完整保留第一部分正文，可照常复制 / 入章；若该模型较难稳定输出 JSON，可一键切换为对人眼更友好的固定 Markdown 清单。
                  </p>
                  <Button variant="primary" size="sm" className="mt-2" onClick={() => void switchToMarkdown()}>
                    一键切换为 Markdown 清单模式
                  </Button>
                </div>
              )}

              {parsed.warnings.length > 0 && (
                <ul className="space-y-0.5 text-11 text-ink-500">
                  {parsed.warnings.map((w, i) => <li key={i}>· {w}</li>)}
                </ul>
              )}

              <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                <p className="flex flex-wrap items-center gap-2 text-11 text-ink-300">
                  <FileText size={12} className="text-amber" />
                  第一部分 · {BODY_LABEL[scene]}
                  <span className="text-ink-500">· {parsed.body.length} 字符</span>
                </p>
                <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-700 bg-ink-950/60 p-2.5 text-12 text-ink-200">
                  {parsed.body || '（第一部分为空）'}
                </pre>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" onClick={() => void copyBody()} disabled={!parsed.body}>
                    <Copy size={12} /> 复制正文
                  </Button>
                  {onAppendBody && (
                    <Button variant="secondary" size="sm" onClick={appendBody} disabled={!parsed.body}>
                      <Save size={12} /> 追加到章末
                    </Button>
                  )}
                  {onReplaceBody && (
                    <Button variant="secondary" size="sm" onClick={() => void replaceBody()} disabled={!parsed.body}>
                      <Replace size={12} /> 替换整章
                    </Button>
                  )}
                  {onReplaceSelection && (
                    <Button variant="secondary" size="sm" onClick={() => { if (parsed.body) { onReplaceSelection(parsed.body); showToast('已替换选中片段。', 'success') } }}
                      disabled={!parsed.body}>
                      <Replace size={12} /> 替换选中片段
                    </Button>
                  )}
                  {onUseBody && (
                    <Button variant="secondary" size="sm" onClick={() => { if (parsed.body) { onUseBody(parsed.body); showToast('已交给当前页面处理。', 'success') } }}
                      disabled={!parsed.body}>
                      {useBodyLabel ?? '使用这段正文'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                <p className="flex flex-wrap items-center gap-2 text-11 text-ink-300">
                  <ListChecks size={12} className="text-amber" />
                  第二部分 · 变动摘要
                  {parsed.format === 'json' && parsed.jsonFailed && <span className="text-amber">（解析失败，仅保留原文）</span>}
                </p>

                {parsed.format === 'markdown' && parsed.markdownCards.length > 0 && (
                  <div className="mt-1.5 space-y-2">
                    {parsed.markdownCards.map((c, i) => (
                      <div key={i}>
                        <p className="text-11 font-medium text-ink-300">{c.section}</p>
                        <ul className="mt-0.5 space-y-0.5 text-11 text-ink-400">
                          {c.items.map((it, j) => <li key={j}>· {it}</li>)}
                        </ul>
                      </div>
                    ))}
                    <p className="text-11 text-ink-500">Markdown 清单不含可直接入库的候选；请按上面的卡片人工核对。</p>
                  </div>
                )}

                {parsed.format === 'json' && !parsed.jsonFailed && (
                  <>
                    <p className="mt-1 text-11 text-ink-500">
                      候选必须与库内登记现状比对后才能勾选；未登记的伏笔 / 关系 / 物品 / 小传只提示，不会凭空建。
                    </p>
                    {!chapterId && <p className="mt-1 text-11 text-amber">当前上下文没有章节 id，候选写入不可用。</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => void buildCandidates()}
                        disabled={building || !chapterId || !hasWcpCandidates(parsed.changes)}>
                        {building ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
                        {items ? '重新比对' : '比对成候选'}
                      </Button>
                      {items && stats && (
                        <span className="text-11 text-ink-500">
                          可勾选 {stats.selectable} · 仅提示 {stats.hintOnly} · 已存在 {stats.registered}
                        </span>
                      )}
                    </div>

                    {items && (
                      <div className="mt-2 max-h-64 overflow-auto space-y-1.5">
                        {items.map((item, idx) => {
                          const selectable = isWcpItemSelectable(item)
                          const st = STATUS_META[item.status]
                          return (
                            <label key={`${item.key}::${idx}`} className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/50 px-2.5 py-1.5">
                              <input type="checkbox" className="mt-0.5 shrink-0" disabled={!selectable}
                                checked={selectable && picked.has(item.key)} onChange={() => togglePicked(item.key)} />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-12 text-ink-200">{item.label}</span>
                                  <span className={`rounded border px-1 py-0.5 text-10 ${st.cls}`}>{st.label}</span>
                                </span>
                                <span className="block text-11 text-ink-500 leading-relaxed">{item.detail}</span>
                                {item.evidence && <span className="block text-11 text-ink-600">依据：「{item.evidence}」</span>}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )}

                    {items && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button variant="primary" size="sm" onClick={() => void applySelected()}
                          disabled={applying || !chapterId || picked.size === 0}>
                          {applying ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                          写入勾选条目
                        </Button>
                        <span className="text-11 text-ink-500">只追加不覆盖；写入后可在对应页签继续修改。</span>
                      </div>
                    )}
                  </>
                )}

                {showRawChanges && (
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-700 bg-ink-950/60 p-2.5 text-11 text-ink-300">
                    {parsed.rawChanges || '（没有识别到第二部分）'}
                  </pre>
                )}

                {result && (
                  <div className="mt-2 rounded-md border border-ink-700 bg-ink-900/60 px-2.5 py-2 text-11">
                    <p className="flex items-center gap-1.5 text-emerald-300"><CheckCircle2 size={12} /> 已写入 {result.created} 条</p>
                    {result.failed.length > 0 && <p className="mt-1 text-danger">失败 {result.failed.length} 条：{result.failed.slice(0, 3).join('、')}{result.failed.length > 3 ? ' 等' : ''}</p>}
                    {(result.warnings ?? []).map((w, i) => <p key={i} className="mt-1 text-amber">{w}</p>)}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
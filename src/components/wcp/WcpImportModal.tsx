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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Copy, FileText, Replace, Save, Upload,
} from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import AutoTextarea from '@/components/common/AutoTextarea'
import { LoadingState } from '@/components/common/LoadingState'
import { confirmDialog, copyText, showToast } from '@/components/dialogs/dialogs'
import * as db from '@/lib/db'
import type { PostProcessItem } from '@/lib/outline/chapterPostProcess'
import WcpOutboxCard from '@/components/wcp/WcpOutboxCard'
import WcpChangesPanel from '@/components/wcp/WcpChangesPanel'
import {
  applyWcpCandidates,
  buildWcpCandidates,
  isWcpItemSelectable,
  summarizeWcpCandidates,
} from '@/lib/wcp/wcpApply'
import { hasWcpCandidates } from '@/lib/wcp/wcpParser'
import { loadWcpGlobalConfig, saveWcpGlobalConfig } from '@/lib/wcp/wcpSettings'
import { wcpWorkspaceFolderName, parseWcpWorkspaceJsonFile } from '@/lib/wcp/wcpWorkspaceBuilder'
import {
  decideOutboxArchiveAfterBody,
  resolveWcpImportParse,
  type WcpLoadedJsonParse,
} from '@/lib/wcp/wcpWorkspaceImportRules'
import {
  hasWcpWorkspaceBridge,
  workspaceArchiveOutbox,
  workspaceDefaultRoot,
  workspaceReadOutbox,
  workspaceScanOutbox,
  type WcpWorkspaceOutboxEntry,
} from '@/lib/wcp/wcpWorkspaceClient'
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
  onReplaceSelection?: (text: string) => boolean | void
  /** 业务页专用正文用途（如「存为小传正文」「填入细纲草稿」） */
  onUseBody?: (text: string) => void
  useBodyLabel?: string
  onApplied?: (created: number) => void
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
  // ---- 3.7.4 · 本地 Agent 收件箱（outbox/）----
  const [outbox, setOutbox] = useState<WcpWorkspaceOutboxEntry[]>([])
  const [outboxBusy, setOutboxBusy] = useState(false)
  const [outboxError, setOutboxError] = useState('')
  const [outboxPreview, setOutboxPreview] = useState<{ name: string; text: string } | null>(null)
  const [outboxLoaded, setOutboxLoaded] = useState<{ base: string; jsonName?: string; mdName?: string; projectName: string } | null>(null)
  const wsLocRef = useRef<{ root: string; folder: string } | null>(null)
  /** 载入收件箱产物时写入的规范化文本：跳过「文本变化清空候选」的一次误清 */
  const autoLoadTextRef = useRef('')
  /** .wcp.json 解析结果：与文本框内容绑定，避免被全局 Markdown 格式误重解析 */
  const [loadedJson, setLoadedJson] = useState<WcpLoadedJsonParse | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const hasOutbox = hasWcpWorkspaceBridge()

  const locateWorkspace = useCallback(async () => {
    const pid = db.getCurrentProjectId()
    if (!pid) return null
    const cfgNow = await loadWcpGlobalConfig()
    const project = await db.getProject(pid).catch(() => undefined)
    const root = cfgNow.workspaceRoot || await workspaceDefaultRoot()
    if (!root) return null
    return { root, folder: wcpWorkspaceFolderName(project?.name || '未命名作品', pid) }
  }, [])

  const scanOutbox = useCallback(async () => {
    if (!hasOutbox) return
    setOutboxBusy(true)
    try {
      const loc = await locateWorkspace()
      wsLocRef.current = loc
      if (!loc) { setOutbox([]); return }
      const r = await workspaceScanOutbox(loc.root, loc.folder)
      if (!r.ok) { setOutboxError(r.error || '扫描收件箱失败。'); setOutbox([]); return }
      setOutboxError('')
      setOutbox(r.entries)
    } finally {
      setOutboxBusy(false)
    }
  }, [hasOutbox, locateWorkspace])

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
      setOutboxLoaded(null)
      setOutboxPreview(null)
      setLoadedJson(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      void scanOutbox()
    })()
    return () => { active = false }
  }, [open, scanOutbox])

  const parsed = useMemo(
    () => resolveWcpImportParse(text, cfg?.summaryFormat ?? 'json', loadedJson),
    [text, cfg?.summaryFormat, loadedJson],
  )

  // 粘贴文本或摘要格式一变，旧候选立即作废 —— 否则会把「上一段文本」的比对结果写进库里
  useEffect(() => {
    if (text && text === autoLoadTextRef.current) {
      autoLoadTextRef.current = ''
      return
    }
    // .wcp.json 的解析结果是权威口径：格式开关变化不该让它失效
    if (loadedJson && text === loadedJson.text) return
    setLoadedJson(null)
    setItems(null)
    setPicked(new Set())
    setResult(null)
  }, [text, cfg?.summaryFormat, loadedJson])

  const stats = items ? summarizeWcpCandidates(items) : null
  /** 仅无第二部分 / JSON 失败 / Markdown 无结构化卡片时展示原文；JSON 正常解析后由候选比对区接管 */
  const showRawChanges = !!parsed && (parsed.format === 'none' || parsed.jsonFailed || (parsed.format === 'markdown' && parsed.markdownCards.length === 0))
  /** 先比对候选再追加正文时，库内正文尚未包含第一部分，合并后才能让引文核验命中新写出的原句 */
  const effectiveContent = parsed?.body && !content.includes(parsed.body)
    ? [content.trimEnd(), parsed.body].filter(Boolean).join('\n\n')
    : content

  const readOutboxText = async (name: string): Promise<string | null> => {
    const loc = wsLocRef.current
    if (!loc) { showToast('还没有定位到工作区目录。', 'error'); return null }
    const r = await workspaceReadOutbox(loc.root, loc.folder, name)
    if (!r.ok) { showToast(r.error || '读取收件箱文件失败。', 'error', 6000); return null }
    return r.text
  }

  /** 所有 `.wcp.json` 来源（收件箱 / 本地文件）共用的载入链：Schema 校验 → 跨书拦截 → 直接比对候选 */
  const applyWorkspaceJson = async (
    raw: string,
    meta: { base: string; jsonName?: string; mdName?: string; projectName?: string; archiveable: boolean },
  ) => {
    const pid = db.getCurrentProjectId()
    const parsedJson = parseWcpWorkspaceJsonFile(raw, pid)
    if (!parsedJson.ok) {
      const detail = parsedJson.details.length ? `（${parsedJson.details.slice(0, 3).join('；')}）` : ''
      setOutboxError(parsedJson.error + detail)
      showToast(parsedJson.error, 'error', 7000)
      return
    }
    setOutboxError('')
    setOutboxPreview(null)
    setText(parsedJson.replyText)
    autoLoadTextRef.current = parsedJson.replyText
    setLoadedJson({ text: parsedJson.replyText, result: parsedJson.result })
    setOutboxLoaded(meta.archiveable
      ? {
        base: meta.base,
        ...(meta.jsonName ? { jsonName: meta.jsonName } : {}),
        ...(meta.mdName ? { mdName: meta.mdName } : {}),
        projectName: parsedJson.projectName || '当前作品',
      }
      : null)
    setResult(null)

    const parsed = parsedJson.result
    if (chapterId && hasWcpCandidates(parsed.changes)) {
      const merged = parsed.body && !content.includes(parsed.body)
        ? [content.trimEnd(), parsed.body].filter(Boolean).join('\n\n')
        : content
      try {
        const built = await buildWcpCandidates({ chapterId, chapterTitle: chapterTitle ?? '', content: merged, changes: parsed.changes })
        setItems(built.items)
        setPicked(new Set(built.items.filter(isWcpItemSelectable).map(i => i.key)))
        if (built.notes.length) showToast(built.notes.join('　'), 'info')
      } catch (e) {
        showToast('候选生成失败：' + (e instanceof Error ? e.message : String(e)), 'error')
      }
    }
    if (parsed.warnings.length) showToast(parsed.warnings.slice(0, 2).join('　'), 'info')
    showToast(meta.archiveable
      ? `已载入「${meta.base}」；勾选后写入，导入成功后自动归档。`
      : `已载入「${meta.base}」；本地文件没有归档来源，不入收件箱。`, 'success')
  }

  /** 一键载入收件箱 `.wcp.json` */
  const loadOutboxJson = async (entry: WcpWorkspaceOutboxEntry) => {
    if (!entry.jsonName) return
    const raw = await readOutboxText(entry.jsonName)
    if (raw == null) return
    await applyWorkspaceJson(raw, {
      base: entry.base,
      jsonName: entry.jsonName,
      ...(entry.mdName ? { mdName: entry.mdName } : {}),
      archiveable: true,
    })
  }

  /** 三形态通用的「选择本地文件」：`.wcp.json` 走同一套 Schema + 跨书校验，`.md` 走双段解析 */
  const pickLocalFile = async (file: File) => {
    let raw = ''
    try {
      raw = await file.text()
    } catch (e) {
      showToast('读取本地文件失败：' + (e instanceof Error ? e.message : String(e)), 'error', 6000)
      return
    }
    const isJsonArtifact = /\.wcp\.json$/i.test(file.name) || /"schemaVersion"\s*:\s*"wcp-output\/v1"/.test(raw)
    if (isJsonArtifact) {
      const base = file.name.replace(/\.(wcp\.json|md|markdown)$/i, '')
      await applyWorkspaceJson(raw, {
        base,
        ...(/\.wcp\.json$/i.test(file.name) ? { jsonName: file.name } : {}),
        archiveable: false,
      })
      return
    }
    setOutboxError('')
    setOutboxPreview(null)
    setOutboxLoaded(null)
    setLoadedJson(null)
    setText(raw)
    showToast(`已载入本地文件「${file.name}」，请核对正文与候选。`, 'success')
  }

  /** 载入同名 `.md`（人类可读产物）：直接走既有双段解析 */
  const loadOutboxMarkdown = async (entry: WcpWorkspaceOutboxEntry) => {
    if (!entry.mdName) return
    const textMd = await readOutboxText(entry.mdName)
    if (textMd == null) return
    setOutboxError('')
    setOutboxPreview(null)
    setLoadedJson(null)
    setText(textMd)
    setOutboxLoaded({ base: entry.base, ...(entry.jsonName ? { jsonName: entry.jsonName } : {}), mdName: entry.mdName, projectName: '当前作品' })
    showToast(`已载入「${entry.base}.md」；可复制正文或比对候选。`, 'success')
  }

  const previewOutboxMarkdown = async (entry: WcpWorkspaceOutboxEntry) => {
    if (!entry.mdName) return
    const textMd = await readOutboxText(entry.mdName)
    if (textMd == null) return
    setOutboxPreview({ name: entry.mdName, text: textMd })
  }

  const copyOutboxMarkdown = async (entry: WcpWorkspaceOutboxEntry) => {
    if (!entry.mdName) return
    const textMd = await readOutboxText(entry.mdName)
    if (textMd == null) return
    await copyText(textMd, 'Markdown 产物已复制')
  }

  /** 成对归档到 `outbox/imported/`（D3）：成功后刷新收件箱列表 */
  const archiveLoadedOutbox = useCallback(async (quiet = false) => {
    const loc = wsLocRef.current
    const meta = outboxLoaded
    if (!hasOutbox || !loc || !meta) return
    const r = await workspaceArchiveOutbox(loc.root, loc.folder, {
      ...(meta.jsonName ? { jsonName: meta.jsonName } : {}),
      ...(meta.mdName ? { mdName: meta.mdName } : {}),
    })
    if (r.ok) {
      setOutboxLoaded(null)
      if (!quiet) showToast(`已归档 ${r.archived.length} 个文件到 outbox/imported/。`, 'success')
      await scanOutbox()
    } else if (!quiet) {
      showToast('归档失败：' + (r.error || '未知原因'), 'error', 6000)
    }
  }, [hasOutbox, outboxLoaded, scanOutbox])

  /**
   * 正文动作成功后的归档时机（复核修复 P1-2）。
   * 若还有未写入的可勾选候选，先不归档 —— 否则原件被移走，回头勾选候选时已找不到来源。
   */
  const archiveAfterBodyAction = () => {
    const pendingCandidates = !!items?.some(isWcpItemSelectable)
    const decision = decideOutboxArchiveAfterBody({
      archiveEnabled: !!cfg?.archiveOutboxAfterImport,
      hasLoadedSource: !!outboxLoaded,
      pendingCandidates,
    })
    if (decision === 'archive') void archiveLoadedOutbox(true)
    else if (decision === 'defer') {
      showToast('正文已采用；还有未写入的设定候选，等你勾选写入成功后再自动归档。', 'info', 6000)
    }
  }

  const copyBody = async () => {
    if (!parsed?.body) return
    await copyText(parsed.body, '正文已复制到剪贴板')
  }

  const appendBody = () => {
    if (!parsed?.body || !onAppendBody) return
    onAppendBody(parsed.body)
    showToast('已追加到章末（可在编辑器里继续调整）。', 'success')
    archiveAfterBodyAction()
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
    archiveAfterBodyAction()
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
        content: effectiveContent,
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
        { chapterId, chapterTitle: chapterTitle ?? '', content: effectiveContent },
        chosen,
        chapterNo ?? 0,
      )
      setResult(res)
      if (res.created > 0) {
        setPicked(new Set())
        showToast(`已写入 ${res.created} 条；失败 ${res.failed.length} 条。`, res.failed.length ? 'info' : 'success')
        onApplied?.(res.created)
        // D3：成功导入后把来源 `.wcp.json` + `.md` 成对移入 outbox/imported/
        if (cfg?.archiveOutboxAfterImport && outboxLoaded) void archiveLoadedOutbox(true)
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
          {hasOutbox && (
            <WcpOutboxCard
              entries={outbox}
              busy={outboxBusy}
              error={outboxError}
              loaded={outboxLoaded}
              preview={outboxPreview}
              onScan={() => void scanOutbox()}
              onLoadJson={entry => void loadOutboxJson(entry)}
              onPreviewMd={entry => void previewOutboxMarkdown(entry)}
              onCopyMd={entry => void copyOutboxMarkdown(entry)}
              onLoadMd={entry => void loadOutboxMarkdown(entry)}
              onArchive={() => void archiveLoadedOutbox(false)}
              onCopyPreview={() => { if (outboxPreview) void copyText(outboxPreview.text, 'Markdown 产物已复制') }}
              onClosePreview={() => setOutboxPreview(null)}
            />
          )}
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
            <span className="text-11 text-ink-500">摘要格式</span>
            <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'json'}
              onClick={() => void switchFormat('json')}>JSON</Button>
            <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'markdown'}
              onClick={() => void switchFormat('markdown')}>Markdown 清单</Button>
            <span className="ml-auto text-11 text-ink-500">只解析、不自动写入；正文与候选都要你确认。</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload size={12} /> 选择本地文件（.wcp.json / .md）
            </Button>
            <span className="text-11 text-ink-500">桌面 / 便携 / 网页都可用；选中 `.wcp.json` 会先做契约与跨书校验。</span>
            <input ref={fileInputRef} type="file" accept=".json,.md,.markdown,application/json,text/markdown" className="hidden"
              onChange={e => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void pickLocalFile(file)
              }} />
          </div>
          <AutoTextarea value={text} onChange={setText} minRows={7} maxHeight={300} textClass="text-12"
            placeholder={`把网页模型的完整回复粘到这里。示例：\n${wcpContractSample(cfg.summaryFormat)}`} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setText(wcpContractSample(cfg.summaryFormat))}>填入示例</Button>
            <Button variant="secondary" size="sm" onClick={() => { setText(''); setItems(null); setResult(null); setLoadedJson(null); setOutboxLoaded(null) }} disabled={!text}>清空</Button>
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
                    <Button variant="secondary" size="sm" onClick={() => { if (parsed.body && onReplaceSelection(parsed.body) !== false) { showToast('已替换选中片段。', 'success'); archiveAfterBodyAction() } }}
                      disabled={!parsed.body}>
                      <Replace size={12} /> 替换选中片段
                    </Button>
                  )}
                  {onUseBody && (
                    <Button variant="secondary" size="sm" onClick={() => { if (parsed.body) { onUseBody(parsed.body); showToast('已交给当前页面处理。', 'success'); archiveAfterBodyAction() } }}
                      disabled={!parsed.body}>
                      {useBodyLabel ?? '使用这段正文'}
                    </Button>
                  )}
                </div>
              </div>

              <WcpChangesPanel
                parsed={parsed}
                items={items}
                picked={picked}
                building={building}
                applying={applying}
                stats={stats}
                {...(chapterId ? { chapterId } : {})}
                showRawChanges={showRawChanges}
                result={result}
                onBuild={() => void buildCandidates()}
                onApply={() => void applySelected()}
                onToggle={togglePicked}
              />
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

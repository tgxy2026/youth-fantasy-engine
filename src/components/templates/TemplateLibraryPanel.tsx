/**
 * 个人模板库面板（3.2.0 · T1）—— 存取、发版、升级、模板包。
 *
 * 边界（方案 §3.5）：
 *   · 库只存在**本机**（`meta`，云同步排除），分享走显式模板包；
 *   · 发布新版本**不改已有项目**；项目要换结构必须走升级预览（迁移），
 *     因此这里的「升级」只回调 `onUpgrade`，落库仍由 `TemplateManagerDialog` 走迁移层。
 *   · 模板包只含结构，不含条目正文 / 图片 / 凭据。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUpCircle, BookMarked, Download, Upload } from 'lucide-react'
import type { TabDef } from '@/lib/types'
import type { TemplateDef } from '@/lib/templates/definition'
import {
  listLibraryTemplates, loadLibraryVersion, publishAsNewTemplate, publishTemplateDef,
  type LibraryIndexEntry,
} from '@/lib/templates/library'
import { exportTemplatePack, importPackToLibrary } from '@/lib/templates/packIO'
import { saveTemplateDef } from '@/lib/templates/store'
import { captureCandidateOwner } from '@/lib/ai/candidateContext'
import { getStorageContextEpoch, subscribeStorageContext } from '@/lib/storage/contextEpoch'
import { downloadBlob } from '@/lib/storage/zip'
import { Button } from '@/components/common/Button'

interface Props {
  tab: TabDef
  current: TemplateDef | null
  busy: boolean
  /** 选好库版本后交给父组件做迁移预览（不在这里执行） */
  onUpgrade: (def: TemplateDef, version: number) => void | Promise<void>
}

const SELECT = 'text-11 px-2 py-1 rounded-lg bg-ink-900 border border-ink-700 text-ink-200 outline-none focus:border-amber/50'

function versionLabel(v: number): string {
  return `第 ${v} 版`
}

export default function TemplateLibraryPanel({ tab, current, busy, onUpgrade }: Props) {
  useSyncExternalStore(subscribeStorageContext, getStorageContextEpoch)
  const [owner] = useState(() => ({ ...captureCandidateOwner(), tabId: tab.id }))
  const pid = owner.projectId, alive = useRef(true)
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const ownsView = useCallback(() => alive.current && owner.current() && owner.tabId === tab.id, [owner, tab.id])
  const [entries, setEntries] = useState<LibraryIndexEntry[]>([])
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [working, setWorking] = useState(false)
  const workingRef = useRef(false), readRequest = useRef(0)
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState('')
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' | 'info' } | null>(null)
  const notify = (text: string, tone: 'error' | 'success' | 'info' = 'success') => { if (ownsView()) setNotice({ text, tone }) }
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    if (!ownsView()) return
    const request = ++readRequest.current
    setReading(true); setReadError('')
    try {
      const all = await listLibraryTemplates()
      if (ownsView() && request === readRequest.current) setEntries(all.filter(e => e.tabId === tab.id))
    } catch {
      if (ownsView() && request === readRequest.current) setReadError('个人模板库读取失败，当前列表尚未确认。请重新读取；已有内容不会因此被当作空库。')
    } finally { if (ownsView() && request === readRequest.current) setReading(false) }
  }, [tab.id, ownsView])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (job: () => Promise<void>) => {
    if (workingRef.current || busy || !ownsView()) return
    workingRef.current = true
    setWorking(true)
    setNotice(null)
    try { await job() } catch {
      notify('操作未完成，部分提交可能已被接受。请先重新读取原个人库核对，再重试；最终写入状态请查看存储区。', 'error')
    } finally { workingRef.current = false; if (ownsView()) setWorking(false) }
  }

  const publishAsNew = () => run(async () => {
    if (!current) return
    const r = await publishAsNewTemplate(current)
    if (!ownsView()) return
    if (!r.ok) { notify(`存入个人库失败：${r.detail}`, 'error'); return }
    // 项目快照里记下出处：之后「发布新版本」才有明确的目标模板
    const adopted: TemplateDef = {
      ...current,
      templateId: r.templateId,
      origin: { kind: 'library', templateId: r.templateId, version: r.version, fromName: current.name },
    }
    const saved = await saveTemplateDef(pid, adopted)
    if (!ownsView()) return
    if (!saved.ok) {
      notify(`个人库提交已接收，但项目出处未提交：${saved.violations.map(v => v.detail).join('；')}。请保留当前模板并核对后重试。`, 'error')
      return
    }
    notify(r.created ? `已存入个人模板库（${versionLabel(r.version)}）` : '库里已有相同内容', 'success')
    await refresh()
  })

  const publishNext = () => run(async () => {
    if (!current) return
    // Older snapshots recorded library provenance without copying its templateId.
    // Continue that actual version line instead of creating a second, unrelated one.
    const target = current.origin.kind === 'library' ? { ...current, templateId: current.origin.templateId } : current
    const r = await publishTemplateDef(target)
    if (!ownsView()) return
    if (!r.ok) {
      notify(
        r.code === 'version-conflict'
          ? `${r.detail} 可改用「另存为新模板」。`
          : `发布失败：${r.detail}`,
        'error',
      )
      return
    }
    notify(
      r.created ? `已发布${versionLabel(r.version)}（当前项目仍停在已采用的版本）` : '库里没有变化',
      'success',
    )
    await refresh()
  })

  const exportPack = () => run(async () => {
    if (!current) return
    const r = exportTemplatePack([current])
    if (!r.ok) { notify(`导出失败：${r.detail}`, 'error'); return }
    downloadBlob(`${tab.name}-模板包.json`, new Blob([r.text], { type: 'application/json' }))
    notify('已导出模板包（只含结构，不含条目与图片）', 'success')
  })

  const importPack = (file: File) => run(async () => {
    const text = await file.text()
    if (!ownsView()) return
    const r = await importPackToLibrary(text)
    if (!ownsView()) return
    if (!r.ok) { notify(`导入失败：${r.detail}`, 'error'); return }
    const conflicts = r.outcomes.filter(o => o.kind === 'conflict')
    const published = r.outcomes.filter(o => o.kind === 'published')
    if (conflicts.length > 0) {
      notify(
        `已导入 ${published.length} 份；${conflicts.length} 份与已发布版本冲突：${conflicts[0].detail}`,
        'error',
      )
    } else {
      notify(`已导入 ${published.length} 份模板到个人库`, 'success')
    }
    await refresh()
  })

  const upgrade = (entry: LibraryIndexEntry, version: number) => run(async () => {
    const def = await loadLibraryVersion(entry.templateId, version)
    if (!ownsView()) return
    if (!def) { notify('该版本读不出来，可能已损坏', 'error'); return }
    await onUpgrade(def.def, version)
  })

  const canPublishNext = current?.origin.kind === 'library'
  const disabled = working || busy || reading || !!readError || !ownsView()

  if (!ownsView()) return <section data-template-library role="status" className="text-12 text-amber">项目或存储已切换，请重新打开模板管理后操作。</section>

  return (
    <section data-template-library className="rounded-xl border border-ink-700 bg-ink-800/50 px-3.5 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <BookMarked size={13} className="text-amber" />
        <h3 className="text-12 font-semibold text-ink-100">个人模板库</h3>
        <span className="text-10 text-ink-500">仅本机 · 不进云同步</span>
        <Button variant="secondary" size="xs" className="ml-auto" onClick={() => void refresh()} disabled={working || busy || reading}>重新读取个人库</Button>
      </div>

      {reading && <p role="status" className="text-11 text-ink-400">正在读取个人模板库…</p>}
      {readError && <p role="alert" className="text-12 text-danger">{readError}</p>}
      {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} data-library-feedback={notice.tone}
        className={`rounded-lg border px-3 py-2 text-12 ${notice.tone === 'error' ? 'border-danger/40 text-danger' : 'border-ink-700 text-ink-300'}`}>{notice.text}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {current && !canPublishNext && (
          <Button variant="secondary" size="sm" onClick={() => void publishAsNew()} disabled={disabled}>
            存为个人模板
          </Button>
        )}
        {current && canPublishNext && (
          <>
            <Button variant="secondary" size="sm" onClick={() => void publishNext()} disabled={disabled}>
              发布新版本
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void publishAsNew()} disabled={disabled} title="换一个模板标识另存，不影响当前模板的版本线">
              另存为新模板
            </Button>
          </>
        )}
        {current && (
          <Button variant="secondary" size="sm" onClick={() => void exportPack()} disabled={disabled} className="flex items-center gap-1.5">
            <Download size={12} /> 导出模板包
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={disabled} className="flex items-center gap-1.5">
          <Upload size={12} /> 导入模板包
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) void importPack(f)
            e.target.value = ''
          }}
        />
      </div>

      {!reading && !readError && entries.length === 0 ? (
        <p className="text-11 text-ink-500 leading-relaxed">
          这一页还没有存入个人库的模板。存一份之后，就可以在其他项目里复用同一套结构。
        </p>
      ) : entries.length > 0 ? (
        <ul className="space-y-1.5">
          {entries.map(e => {
            const version = picked[e.templateId] ?? e.latestVersion
            return (
              <li key={e.templateId} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-2.5 py-1.5">
                <span className="text-11 text-ink-100 truncate min-w-0 flex-1" title={e.name}>{e.name}</span>
                <select
                  className={SELECT}
                  value={version}
                  onChange={ev => setPicked(p => ({ ...p, [e.templateId]: Number(ev.target.value) }))}
                  title="选择要升级到的库版本"
                >
                  {e.versions.map(v => (
                    <option key={v} value={v}>
                      {versionLabel(v)}{v === e.latestVersion ? '（最新）' : ''}
                    </option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void upgrade(e, version)}
                  className="flex items-center gap-1.5"
                  title="先看变更计划（保留 / 改动 / 新增 / 归档 / 影响多少条资料），确认后才执行迁移"
                >
                  <ArrowUpCircle size={12} /> 升级预览
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}

      <p className="text-10 text-ink-500 leading-relaxed">
        本页反馈表示提交结果，最终写入状态请查看存储区。
        发布新版本不会改动已经采用旧版本的项目；要换结构请对目标项目做一次「升级预览」。
      </p>
    </section>
  )
}

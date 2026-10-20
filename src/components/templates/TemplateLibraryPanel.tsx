/**
 * 个人模板库面板（3.2.0 · T1）—— 存取、发版、升级、模板包。
 *
 * 边界（方案 §3.5）：
 *   · 库只存在**本机**（`meta`，云同步排除），分享走显式模板包；
 *   · 发布新版本**不改已有项目**；项目要换结构必须走升级预览（迁移），
 *     因此这里的「升级」只回调 `onUpgrade`，落库仍由 `TemplateManagerDialog` 走迁移层。
 *   · 模板包只含结构，不含条目正文 / 图片 / 凭据。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, BookMarked, Download, Upload } from 'lucide-react'
import type { TabDef } from '@/lib/types'
import type { TemplateDef } from '@/lib/templates/definition'
import {
  listLibraryTemplates, loadLibraryVersion, publishAsNewTemplate, publishTemplateDef,
  type LibraryIndexEntry,
} from '@/lib/templates/library'
import { exportTemplatePack, importPackToLibrary } from '@/lib/templates/packIO'
import { saveTemplateDef } from '@/lib/templates/store'
import { getCurrentProjectId } from '@/lib/db'
import { downloadBlob } from '@/lib/storage/zip'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'

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
  const pid = getCurrentProjectId()
  const [entries, setEntries] = useState<LibraryIndexEntry[]>([])
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [working, setWorking] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const all = await listLibraryTemplates()
      setEntries(all.filter(e => e.tabId === tab.id))
    } catch {
      setEntries([])
    }
  }, [tab.id])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (job: () => Promise<void>) => {
    if (working || busy) return
    setWorking(true)
    try { await job() } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error')
    } finally { setWorking(false) }
  }

  const publishAsNew = () => run(async () => {
    if (!current) return
    const r = await publishAsNewTemplate(current)
    if (!r.ok) { showToast(`存入个人库失败：${r.detail}`, 'error'); return }
    // 项目快照里记下出处：之后「发布新版本」才有明确的目标模板
    const adopted: TemplateDef = {
      ...current,
      origin: { kind: 'library', templateId: r.templateId, version: r.version, fromName: current.name },
    }
    const saved = await saveTemplateDef(pid, adopted)
    if (!saved.ok) {
      showToast(`已存入个人库，但项目出处未写入：${saved.violations.map(v => v.detail).join('；')}`, 'error')
      return
    }
    showToast(r.created ? `已存入个人模板库（${versionLabel(r.version)}）` : '库里已有相同内容', 'success')
    await refresh()
  })

  const publishNext = () => run(async () => {
    if (!current) return
    const r = await publishTemplateDef(current)
    if (!r.ok) {
      showToast(
        r.code === 'version-conflict'
          ? `${r.detail} 可改用「另存为新模板」。`
          : `发布失败：${r.detail}`,
        'error',
      )
      return
    }
    showToast(
      r.created ? `已发布${versionLabel(r.version)}（当前项目仍停在已采用的版本）` : '库里没有变化',
      'success',
    )
    await refresh()
  })

  const exportPack = () => run(async () => {
    if (!current) return
    const r = exportTemplatePack([current])
    if (!r.ok) { showToast(`导出失败：${r.detail}`, 'error'); return }
    downloadBlob(`${tab.name}-模板包.json`, new Blob([r.text], { type: 'application/json' }))
    showToast('已导出模板包（只含结构，不含条目与图片）', 'success')
  })

  const importPack = (file: File) => run(async () => {
    const text = await file.text()
    const r = await importPackToLibrary(text)
    if (!r.ok) { showToast(`导入失败：${r.detail}`, 'error'); return }
    const conflicts = r.outcomes.filter(o => o.kind === 'conflict')
    const published = r.outcomes.filter(o => o.kind === 'published')
    if (conflicts.length > 0) {
      showToast(
        `已导入 ${published.length} 份；${conflicts.length} 份与已发布版本冲突：${conflicts[0].detail}`,
        'error', 8000,
      )
    } else {
      showToast(`已导入 ${published.length} 份模板到个人库`, 'success')
    }
    await refresh()
  })

  const upgrade = (entry: LibraryIndexEntry, version: number) => run(async () => {
    const def = await loadLibraryVersion(entry.templateId, version)
    if (!def) { showToast('该版本读不出来，可能已损坏', 'error'); return }
    await onUpgrade(def.def, version)
  })

  const canPublishNext = current?.origin.kind === 'library'
  const disabled = working || busy

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-800/50 px-3.5 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <BookMarked size={13} className="text-amber" />
        <h3 className="text-12 font-semibold text-ink-100">个人模板库</h3>
        <span className="text-10 text-ink-500">仅本机 · 不进云同步</span>
      </div>

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
            <Button variant="ghost" size="sm" onClick={() => void publishAsNew()} disabled={disabled} title="换一个模板标识另存，不影响当前模板的版本线">
              另存为新模板
            </Button>
          </>
        )}
        {current && (
          <Button variant="ghost" size="sm" onClick={() => void exportPack()} disabled={disabled} className="flex items-center gap-1.5">
            <Download size={12} /> 导出模板包
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={disabled} className="flex items-center gap-1.5">
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

      {entries.length === 0 ? (
        <p className="text-11 text-ink-500 leading-relaxed">
          这一页还没有存入个人库的模板。存一份之后，就可以在其他项目里复用同一套结构。
        </p>
      ) : (
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
      )}

      <p className="text-10 text-ink-500 leading-relaxed">
        发布新版本不会改动已经采用旧版本的项目；要换结构请对目标项目做一次「升级预览」。
      </p>
    </section>
  )
}

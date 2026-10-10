/**
 * 3.0 · W3-1c 定稿与版本（作品版本冻结 + 版本历史）
 *
 * §10.3 #7 的落地面板，三段：
 *   ① **完成检查**（本地即时算）：字数 / 章数 / 已写 M/N / 空章清单；
 *   ② **发布闸门**：缺章 / 空书 / 未分卷 / 空卷 —— blocker 红、warn 琥珀、全绿态；
 *   ③ **版本历史**：每版一行，展示名称 / 备注 / 指纹 / 字数 / 时间 / 与当前稿是否一致，
 *      可导出外置 JSON / 恢复 / 删除。
 *
 * 🔴 三条纪律（改前先读）：
 *   · **闸门不硬拦**：有 blocker 时主按钮降级为「仍要冻结（有 N 项未通过）」，作者确认后仍可冻结
 *     （「AI 只辅助、作者裁决」）。
 *   · **冻结 = 复用 backups**：定稿版本就是一份 `kind='frozen'` 的备份 —— 恢复走 `restoreBackup`
 *     （含 id 重映射 / 先写后删 / 不删快照），导出走 `buildBackupFile`，绝不另起一套。
 *   · **指纹只标注不重跑**：版本指纹 ≠ 当前稿指纹时，只显示「当前稿已改过」，绝不自动重冻结 / 重审校。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookMarked, Loader2, Lock, FileUp, RotateCcw, Trash2, X, AlertTriangle, CheckCircle2,
} from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter, Volume } from '@/lib/types'
import { bookStats, bookFingerprint, evaluatePublishGate, shortFingerprint } from '@/lib/bookVersion'
import { Button } from '@/components/Button'
import { confirmDialog, showToast } from '@/components/dialogs'
import { downloadBlob } from '@/lib/zip'
import { rebuildKbIndexAfterRestore } from '@/lib/kbRestoreIndex'
import { Z } from '@/lib/zLayer'
import { foldVh } from '@/lib/theme'

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function BookVersionPanel({
  onClose, onRestored,
}: {
  onClose: () => void
  /** 恢复历史版本后通知外部重载（轨迹页据此刷新） */
  onRestored?: () => void
}) {
  const pid = db.getCurrentProjectId() ?? ''
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [versions, setVersions] = useState<db.BackupMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  /** 有 blocker 时，作者勾「我知道，仍要冻结」才放开主按钮 */
  const [forced, setForced] = useState(false)

  const load = useCallback(async () => {
    try {
      const [chs, vols, vs] = await Promise.all([
        db.getAllChapters().catch(() => [] as Chapter[]),
        db.getAllVolumes().catch(() => [] as Volume[]),
        pid ? db.listFrozenVersions(pid).catch(() => [] as db.BackupMeta[]) : Promise.resolve([] as db.BackupMeta[]),
      ])
      setChapters(chs)
      setVolumes(vols)
      setVersions(vs)
    } finally {
      setLoading(false)
    }
  }, [pid])

  useEffect(() => { void load() }, [load])

  const stats = useMemo(() => bookStats(chapters, volumes), [chapters, volumes])
  const gate = useMemo(() => evaluatePublishGate(stats, chapters, volumes), [stats, chapters, volumes])
  const fp = useMemo(() => bookFingerprint(chapters), [chapters])

  const canFreeze = !busy && !!pid && (gate.ok || forced)

  const doFreeze = async () => {
    if (!canFreeze) return
    setBusy(true)
    try {
      await db.createFrozenVersion(pid, {
        name,
        note,
        fingerprint: fp,
        stats: {
          volumes: stats.volumes,
          chapters: stats.chapters,
          writtenChapters: stats.writtenChapters,
          totalWords: stats.totalWords,
        },
      })
      setName(''); setNote(''); setForced(false)
      await load()
      showToast('已冻结这一版', 'success')
    } catch (e) {
      showToast('冻结失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  const exportVersion = async (v: db.BackupMeta) => {
    if (busy) return
    setBusy(true)
    try {
      const f = await db.buildBackupFile(v.id)
      if (!f) { showToast('这一版的数据已缺失，无法导出', 'error'); return }
      downloadBlob(f.filename, new Blob([f.content], { type: 'application/json' }))
      showToast(`已导出 ${f.filename}`)
    } catch (e) {
      showToast('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  const restoreVersion = async (v: db.BackupMeta) => {
    if (busy) return
    if (!await confirmDialog({
      title: '恢复到这一版',
      message: `确定把当前项目恢复到「${v.label}」？\n时间：${fmt(v.createdAt)}\n\n恢复会用这一版的内容覆盖当前全部数据（卷/章/设定表/角色卡），覆盖后不可撤销。\n建议先「冻结」当前稿留一份再恢复。`,
      confirmText: '恢复', danger: true,
    })) return
    setBusy(true)
    try {
      await db.restoreBackup(v.id)
      // #017 收尾：包里带回来的「已启用」资料是没索引的，不重建＝静默降级（与 BackupManager 同一处理）
      void rebuildKbIndexAfterRestore(pid)
      await load()
      onRestored?.()
      showToast('已恢复到该版本', 'success')
    } catch (e) {
      showToast('恢复失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeVersion = async (v: db.BackupMeta) => {
    if (busy) return
    if (!await confirmDialog({ title: '删除这一版', message: `确定删除「${v.label}」？此操作不可撤销。`, danger: true })) return
    setBusy(true)
    try {
      await db.deleteBackup(v.id)
      await load()
    } catch (e) {
      showToast('删除失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 bg-ink-950/70 backdrop-blur-sm" style={{ zIndex: Z.modal }}>
      <div className="w-full max-w-[760px] flex flex-col rounded-2xl bg-ink-850 border border-ink-700 shadow-2xl overflow-hidden" style={{ maxHeight: foldVh('84vh') }}>
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-ink-700/70 flex items-center gap-2">
          <BookMarked size={16} className="text-amber" />
          <div className="text-14 font-semibold text-ink-50">定稿与版本</div>
          <div className="text-11 text-ink-500">冻结这一版 · 版本历史</div>
          <button onClick={onClose} className="ml-auto text-ink-400 hover:text-ink-100" title="关闭">
            <X size={16} />
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 gap-2 text-ink-400">
              <Loader2 size={18} className="animate-spin text-amber" />
              <span className="text-13">读取中…</span>
            </div>
          ) : (
            <>
              {/* ① 完成检查 */}
              <section className="rounded-xl border border-ink-700 bg-ink-900/40 px-4 py-3">
                <div className="text-12 font-medium text-ink-200 mb-2">完成检查</div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-11 text-ink-300">
                  <span>总字数 <b className="text-ink-100 tabular-nums">{stats.totalWords.toLocaleString('zh-CN')}</b></span>
                  <span>章节 <b className="text-ink-100 tabular-nums">{stats.writtenChapters}</b> / {stats.chapters} 章已有正文</span>
                  <span>分卷 <b className="text-ink-100 tabular-nums">{stats.volumes}</b></span>
                  <span>平均 <b className="text-ink-100 tabular-nums">{stats.avgWordsPerWritten.toLocaleString('zh-CN')}</b> 字/已写章</span>
                </div>
              </section>

              {/* ② 发布闸门 */}
              <section className={`rounded-xl border px-4 py-3 ${
                gate.ok ? 'border-emerald-700/40 bg-emerald-950/10' : 'border-amber/40 bg-amber/5'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  {gate.ok
                    ? <CheckCircle2 size={14} className="text-success" />
                    : <AlertTriangle size={14} className="text-amber" />}
                  <span className="text-12 font-medium text-ink-200">
                    {gate.ok ? '发布闸门：通过' : `发布闸门：${gate.blockers.length} 项阻断`}
                  </span>
                  {gate.warnings.length > 0 && (
                    <span className="text-11 text-ink-500">· {gate.warnings.length} 项提醒</span>
                  )}
                </div>
                {gate.blockers.length === 0 && gate.warnings.length === 0 && (
                  <div className="text-11 text-ink-400">没有发现问题。可以冻结这一版。</div>
                )}
                {gate.blockers.map(b => (
                  <div key={b.key} className="mb-1.5 last:mb-0">
                    <div className="text-11 text-danger">⛔ {b.title}</div>
                    <div className="text-10 text-ink-400 leading-relaxed mt-0.5">{b.detail}</div>
                  </div>
                ))}
                {gate.warnings.map(w => (
                  <div key={w.key} className="mb-1.5 last:mb-0">
                    <div className="text-11 text-amber/90">⚠ {w.title}</div>
                    <div className="text-10 text-ink-400 leading-relaxed mt-0.5">{w.detail}</div>
                  </div>
                ))}
                {!gate.ok && (
                  <label className="mt-2 flex items-center gap-1.5 text-11 text-ink-300 cursor-pointer select-none">
                    <input type="checkbox" checked={forced} onChange={e => setForced(e.target.checked)} className="accent-amber" />
                    我知道有 {gate.blockers.length} 项未通过，仍要冻结这一版
                  </label>
                )}
                <div className="mt-2 text-10 text-ink-500 leading-relaxed">
                  闸门只做确定性检查（缺章 / 空书 / 未分卷 / 空卷），不判优劣、不跑 AI。
                  伏笔 / 连续性 / 投稿预检请见「检查工具」页。
                </div>
              </section>

              {/* ③ 冻结表单 */}
              <section className="rounded-xl border border-ink-700 bg-ink-900/40 px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <Lock size={13} className="text-amber" />
                  <span className="text-12 font-medium text-ink-200">冻结这一版</span>
                  <span className="text-10 text-ink-500">
                    当前稿指纹 {shortFingerprint(fp)}
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="版本名（留空则按时间自动命名）"
                    className="flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-11 text-ink-200 outline-none focus:border-amber"
                  />
                  <input
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="备注（可选）"
                    className="flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-11 text-ink-200 outline-none focus:border-amber"
                  />
                  <Button variant="primary" size="sm" disabled={!canFreeze} onClick={() => void doFreeze()} className="gap-1.5 shrink-0">
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <BookMarked size={12} />}
                    {gate.ok ? '冻结这一版' : `仍要冻结（${gate.blockers.length} 项未通过）`}
                  </Button>
                </div>
              </section>

              {/* ④ 版本历史 */}
              <section>
                <div className="text-12 font-medium text-ink-200 mb-2">
                  版本历史 <span className="text-10 text-ink-500">（共 {versions.length} 版 · 不会自动删除）</span>
                </div>
                {versions.length === 0 ? (
                  <div className="text-13 text-ink-500 py-6 text-center rounded-xl border border-dashed border-ink-700">
                    还没有冻结过版本。
                    <div className="text-11 mt-1">满意当前稿时，点上面的「冻结这一版」留个档。</div>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {versions.map(v => {
                      const same = !!v.fingerprint && v.fingerprint === fp
                      return (
                        <li key={v.id} className="rounded-xl bg-ink-900/50 border border-ink-700/60 px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <BookMarked size={12} className="text-amber shrink-0" />
                            <span className="text-13 text-ink-100">{v.label}</span>
                            <span className={`text-10 px-1.5 py-0.5 rounded ${
                              same ? 'bg-emerald-950/40 text-success' : 'bg-amber/10 text-amber/90'
                            }`}>
                              {same ? '与当前稿一致' : '当前稿已改过'}
                            </span>
                            <span className="ml-auto text-10 text-ink-500">指纹 {shortFingerprint(v.fingerprint ?? '')}</span>
                          </div>
                          {v.note && <div className="mt-1 text-11 text-ink-300">{v.note}</div>}
                          <div className="mt-1 text-11 text-ink-500">
                            {fmt(v.createdAt)}
                            {v.stats && (
                              <> · {v.stats.writtenChapters}/{v.stats.chapters} 章 · {v.stats.totalWords.toLocaleString('zh-CN')} 字</>
                            )}
                            {typeof v.bytes === 'number' && v.bytes > 0 && <> · {Math.round(v.bytes / 1024)} KB</>}
                          </div>
                          <div className="mt-2 flex items-center gap-1.5">
                            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void exportVersion(v)} className="gap-1">
                              <FileUp size={12} /> 导出
                            </Button>
                            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void restoreVersion(v)} className="gap-1" title="用这一版覆盖当前稿">
                              <RotateCcw size={12} /> 恢复
                            </Button>
                            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void removeVersion(v)} className="gap-1" title="删除这一版">
                              <Trash2 size={12} /> 删除
                            </Button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-ink-700/70 flex items-center justify-between gap-3">
          <span className="text-11 text-ink-500">
            定稿版本随项目导出 / 备份一并带走；「恢复」会用该版覆盖当前稿，建议先冻存当前版本。
          </span>
          <Button variant="primary" size="sm" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  )
}

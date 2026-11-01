/**
 * 3.3.3 · B4：灵感素材 → 目标Table条目的**预览与确认**弹窗。
 *
 * 🔴 只在作者点「确认转换」后才建行；取消 / 关窗 / 切目标都零写入。
 * 🔴 目标行先落库，成功后才回报来源补丁；来源补丁由 TableSheet 走它自己的草稿+保存链路，
 *    这样"来源没标上"不会把目标行也吞掉（失败保留来源，不假装原子事务）。
 * 🔴 同一来源重复点同一目标：目标表已有 `来源：IDEA00xx` 的行 ⇒ 只回报"已转过"，不再建。
 */
import { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { getCurrentProjectId, getTableRowsFor, saveTableRow } from '@/lib/db'
import { getTab } from '@/lib/schema'
import { uid } from '@/lib/app/id'
import {
  IDEA_TARGETS, ideaTargetOf, ideaTargetOrder, planIdeaConversion, planIdeaSourcePatch,
} from '@/lib/forms/ideasConvert'
import type { TableRow } from '@/lib/types'

export interface IdeaSource {
  row: TableRow
  /** 当前草稿里的编号与正文（可能是还没保存的修改） */
  code: string
  text: string
  /** 当前草稿合并后的整行数据（来源补丁基于它合并，避免覆盖未保存的备注） */
  data: Record<string, string>
}

interface Props {
  open: boolean
  source: IdeaSource | null
  onClose: () => void
  /** 建行成功后回报：目标去向 + 来源行要写的字段（由 TableSheet 并入草稿并保存） */
  onConverted: (info: { sourceId: string; label: string; code: string; sourcePatch: Record<string, string> }) => void
}

export default function IdeaConvertDialog({ open, source, onClose, onConverted }: Props) {
  const [targetTabId, setTargetTabId] = useState('foreshadow')
  const [targetRows, setTargetRows] = useState<TableRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true); setLoadError(''); setTargetRows([])
    getTableRowsFor(getCurrentProjectId(), targetTabId)
      .then(rows => { if (alive) setTargetRows(rows) })
      .catch(() => { if (alive) setLoadError('目标表现在读不出来，先别转换，稍后重试。') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, targetTabId])

  const target = useMemo(() => ideaTargetOf(targetTabId), [targetTabId])
  const columns = useMemo(
    () => (getTab(targetTabId)?.columns ?? []).map(c => c.name),
    [targetTabId],
  )
  const plan = useMemo(
    () => source && target
      ? planIdeaConversion({
        source: { id: source.row.id, code: source.code, text: source.text },
        target, targetRows, columns,
      })
      : null,
    [source, target, targetRows, columns],
  )

  const confirmConvert = async () => {
    if (!source || !target || !plan || saving) return
    if (!plan.ok) { showToast(plan.reason, 'error'); return }
    if (plan.reused) {
      showToast(`这条灵感已经转成 ${target.label} ${plan.reused.code || '（未编号）'}，没有重复建条目`, 'info')
      onClose()
      return
    }
    setSaving(true)
    try {
      const row: TableRow = {
        id: uid(),
        projectId: getCurrentProjectId(),
        tabId: targetTabId,
        order: ideaTargetOrder(targetRows),
        data: plan.fields,
      }
      await saveTableRow(row)
      onClose()
      const ideaCols = (getTab('ideas')?.columns ?? []).map(c => c.name)
      onConverted({
        sourceId: source.row.id,
        label: target.label,
        code: plan.fields['编号'] ?? '',
        sourcePatch: planIdeaSourcePatch(source.data, ideaCols, {
          label: target.label, code: plan.fields['编号'] ?? '',
        }),
      })
      showToast(`已转为 ${target.label} ${plan.fields['编号'] || ''}`, 'success')
    } catch (e) {
      showToast(`转换失败：${(e as Error)?.message || '未知原因'}。来源灵感没有改动，可以直接重试`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="把灵感转为目标条目"
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消（不转换）</Button>
          <Button onClick={() => void confirmConvert()} disabled={saving || loading || !plan?.ok || !!loadError}>
            {saving ? '正在建条目…' : plan?.reused ? '已转过，知道了' : '确认转换'}
          </Button>
        </>
      }
    >
      {!source ? null : (
        <div className="space-y-4">
          <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
            <div className="text-11 text-ink-400 mb-1">来源灵感 {source.code || '（未编号）'}
              {source.row.data['状态'] && <span className="ml-2">当前状态：{source.row.data['状态']}</span>}
            </div>
            <div className="text-12 text-ink-100 whitespace-pre-wrap break-words leading-relaxed max-h-32 overflow-y-auto">
              {source.text.trim() || '（这条灵感还没有内容）'}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-12 text-ink-300">转到</span>
            <select
              value={targetTabId}
              onChange={e => setTargetTabId(e.target.value)}
              className="bg-ink-800 border border-ink-700 rounded-md px-2.5 py-1.5 text-12 text-ink-100"
            >
              {IDEA_TARGETS.map(t => <option key={t.tabId} value={t.tabId}>{t.label}</option>)}
            </select>
            <span className="text-11 text-ink-500">只建一行，不改这条灵感的正文</span>
          </div>

          {loading && <p className="text-11 text-ink-400">正在读目标表…</p>}
          {loadError && <p className="text-11 text-danger">{loadError}</p>}

          {plan && !loading && (
            <>
              {!plan.ok && <p className="text-11 text-danger leading-relaxed">{plan.reason}</p>}
              {plan.reused && (
                <p className="text-11 text-amber leading-relaxed rounded-lg border border-amber/30 bg-amber/5 p-3">
                  这条灵感已经转过：{target?.label} {plan.reused.code || '（未编号）'}。
                  再点确认也不会重复建条目（目标行备注里已有来源标记）。
                </p>
              )}
              {plan.ok && !plan.reused && (
                <>
                  <div className="rounded-lg border border-ink-700 overflow-hidden">
                    <div className="px-3 py-2 text-11 text-ink-400 bg-ink-850 border-b border-ink-700">
                      将写入 {target?.label} 的这几列
                    </div>
                    <div className="divide-y divide-ink-700 max-h-60 overflow-y-auto">
                      {plan.preview.map(p => (
                        <div key={p.column} className="px-3 py-2 grid grid-cols-[7rem_1fr] gap-2">
                          <span className="text-11 text-ink-400">{p.column}</span>
                          <span className="text-11 text-ink-100 whitespace-pre-wrap break-words">{p.value || '（空）'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {plan.emptyImportant.length > 0 && (
                    <p className="text-11 text-ink-400 leading-relaxed">
                      这些列会留空，建完后到{target?.label}补：{plan.emptyImportant.join('、')}
                    </p>
                  )}
                  <p className="text-11 text-ink-500 leading-relaxed">
                    建行成功后，会把这条灵感标为「已用」，并在备注里写去向；目标行备注写「来源：{source.code || '（未编号灵感）'}」。
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
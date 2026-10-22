/**
 * 封存版本差异查看（3.2.1 · T-10 · 方案 §10.1 C1）
 *
 * 【它解决什么】
 *   世界引擎里封存了多个版本后，作者只能看到「v1 / v2 / v3 + 指纹」，回答不了
 *   「这两版之间到底改了什么」。本弹窗把两个封存版本按 (tabId, kind, rowId) 对齐后，
 *   列出新增 / 删除 / 修改的条目与字段前后值。
 *
 * 🔴 三条边界（方案 §10.1 原文）：
 *   ① **只读** —— 看差异不修改当前项目，也不改版本溯源；
 *   ② 同指纹 ⇒ 内容一致（不装作"有细微差别"）；
 *   ③ 删掉的行不会被"补回来"，这里只展示差异，没有任何应用动作。
 */
import { useMemo, useState } from 'react'
import { Copy, GitCompare } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { diffWorldVersions, formatDiffAsMarkdown, type WorldDiffKind } from '@/lib/world/worldDiff'
import type { WorldStoredRecord } from '@/lib/world/worldTypes'

const KIND_LABEL: Record<string, string> = { form: '表单', table: '表格', card: '卡片', sub: '子表' }
const DIFF_STYLE: Record<WorldDiffKind, string> = {
  added: 'text-success',
  removed: 'text-danger',
  modified: 'text-amber',
  unchanged: 'text-ink-500',
}
const DIFF_LABEL: Record<WorldDiffKind, string> = {
  added: '新增', removed: '删除', modified: '修改', unchanged: '未变',
}
/** 明细最多渲染多少条（剩余只报数，避免上千行把弹窗拖死） */
const MAX_ROWS = 200

function fmtVal(v: unknown): string {
  if (v === undefined || v === null || v === '') return '（空）'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

const fmtKey = (k: string) => k.replace('::', ' · ')

function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function WorldVersionDiffDialog({ world, open, onClose }: {
  world: WorldStoredRecord
  open: boolean
  onClose: () => void
}) {
  const versions = world.versions
  const last = versions.length - 1
  /** 默认比最近两版（作者最常问的就是"这次封存改了什么"） */
  const [oldV, setOldV] = useState(last > 0 ? versions[last - 1].v : 0)
  const [newV, setNewV] = useState(last >= 0 ? versions[last].v : 0)
  const [showUnchanged, setShowUnchanged] = useState(false)

  const diff = useMemo(() => {
    const a = versions.find(v => v.v === oldV)
    const b = versions.find(v => v.v === newV)
    if (!a || !b) return null
    return diffWorldVersions(a, b)
  }, [versions, oldV, newV])

  const changed = useMemo(
    () => (diff ? diff.entryDiffs.filter(e => e.diffKind !== 'unchanged') : []),
    [diff],
  )
  const shown = changed.slice(0, MAX_ROWS)

  const copyMarkdown = async () => {
    if (!diff) return
    try {
      await navigator.clipboard.writeText(formatDiffAsMarkdown(diff))
      showToast('差异已复制为 Markdown', 'success')
    } catch {
      showToast('复制失败：浏览器拒绝了剪贴板访问', 'error')
    }
  }

  const versionBtn = (v: (typeof versions)[number], selected: boolean, onPick: () => void) => (
    <button
      key={v.v}
      type="button"
      onClick={onPick}
      className={`rounded-md border px-2 py-0.5 text-11 transition-colors ${
        selected
          ? 'border-amber/60 bg-amber/15 text-amber'
          : 'border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200'
      }`}
      title={v.note ? `v${v.v}：${v.note}` : `v${v.v}`}
    >
      v{v.v} · {fmtTime(v.at)}
    </button>
  )

  return (
    <Modal open={open} onClose={onClose} title="版本差异" icon={<GitCompare size={14} className="text-amber" />} width="2xl">
      <div className="space-y-3 text-11 text-ink-300">
        <p className="text-ink-500">
          只读对比：不会修改当前项目，也不会改动版本历史。
        </p>

        {/* 选版本 */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 shrink-0 text-ink-500">旧版本</span>
            {versions.map(v => versionBtn(v, v.v === oldV, () => setOldV(v.v)))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 shrink-0 text-ink-500">新版本</span>
            {versions.map(v => versionBtn(v, v.v === newV, () => setNewV(v.v)))}
          </div>
        </div>

        {!diff ? (
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-ink-500">
            选两个不同的版本再看。当前选的版本不存在（可能刚被删）。
          </div>
        ) : (
          <>
            {/* 汇总 */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
              <span className="text-ink-200">v{oldV} → v{newV}</span>
              {/* 0 值不带语义色：数字为 0 时用灰，避免"删除 0"常驻一条红字 */}
              <span className={diff.addedCount ? 'text-success' : 'text-ink-500'}>新增 {diff.addedCount}</span>
              <span className={diff.removedCount ? 'text-danger' : 'text-ink-500'}>删除 {diff.removedCount}</span>
              <span className={diff.modifiedCount ? 'text-amber' : 'text-ink-500'}>修改 {diff.modifiedCount}</span>
              <span className="text-ink-500">未变 {diff.unchangedCount}</span>
            </div>

            {changed.length === 0 ? (
              <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
                <span className="text-success">两版内容一致</span>
                <span className="ml-2 text-ink-500">
                  （条目数与字段值都相同；指纹相同就是"没改过"，不是"差异太小看不见"）
                </span>
              </div>
            ) : (
              <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: '46vh' }}>
                {shown.map(e => (
                  <div key={`${e.tabId}::${e.kind}::${e.rowId}`} className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 ${DIFF_STYLE[e.diffKind]}`}>{DIFF_LABEL[e.diffKind]}</span>
                      <span className="text-ink-100">{e.name || '（未命名）'}</span>
                      <span className="text-10 text-ink-500">
                        {e.tabId} · {KIND_LABEL[e.kind] ?? e.kind}
                      </span>
                      {e.activeChanged && (
                        <span className="text-10 text-amber">
                          活跃：{e.oldActive ? '是' : '否'} → {e.newActive ? '是' : '否'}
                        </span>
                      )}
                    </div>
                    {e.fieldDiffs.length > 0 && (
                      <ul className="mt-0.5 space-y-0.5 pl-2">
                        {e.fieldDiffs.slice(0, 12).map(f => (
                          <li key={f.fieldName} className="text-10 text-ink-400">
                            <span className="text-ink-300">{fmtKey(f.fieldName)}</span>
                            <span className="mx-1 text-ink-600">|</span>
                            <span className="text-ink-500">{fmtVal(f.oldValue)}</span>
                            <span className="mx-1 text-ink-600">→</span>
                            <span className="text-ink-200">{fmtVal(f.newValue)}</span>
                          </li>
                        ))}
                        {e.fieldDiffs.length > 12 && (
                          <li className="text-10 text-ink-500">另有 {e.fieldDiffs.length - 12} 个字段变化未显示</li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}
                {changed.length > MAX_ROWS && (
                  <div className="text-10 text-ink-500">
                    另有 {changed.length - MAX_ROWS} 条变化未显示 —— 用下方「复制 Markdown」拿完整清单。
                  </div>
                )}
              </div>
            )}

            {/* 未变条目：默认不展开，避免淹没真正的变化 */}
            {diff.unchangedCount > 0 && (
              <div>
                <button
                  type="button"
                  className="text-10 text-ink-400 hover:text-ink-100"
                  onClick={() => setShowUnchanged(v => !v)}
                >
                  {showUnchanged ? '收起' : '展开'}未变的 {diff.unchangedCount} 条
                </button>
                {showUnchanged && (
                  <ul className="mt-1 space-y-0.5 pl-2">
                    {diff.entryDiffs.filter(e => e.diffKind === 'unchanged').slice(0, MAX_ROWS).map(e => (
                      <li key={`${e.tabId}::${e.kind}::${e.rowId}`} className="text-10 text-ink-500">
                        {e.name || '（未命名）'} · {e.tabId}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-ink-700 pt-2">
          <Button variant="ghost" size="sm" onClick={copyMarkdown} disabled={!diff}>
            <Copy size={12} /> 复制 Markdown
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Modal>
  )
}

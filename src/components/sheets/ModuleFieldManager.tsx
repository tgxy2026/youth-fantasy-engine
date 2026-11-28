/**
 * 模块化表单 / 卡片 / 大纲页签的轻量「自定义字段」管理按钮与弹窗（3.7.6 · P1）。
 *
 * 与图鉴的 `AtlasFieldManager` 同源：复用 `atlasSchema::<tabId>`、`cf_<uid>` 与 `fieldNameGuard`，
 * 不碰 `模块名::字段名` 内置数据，也不引入重型模板迁移弹窗。
 */
import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus, Save, Settings2, X } from 'lucide-react'
import type { TabDef } from '@/lib/types'
import type { AtlasFieldDefinition, AtlasSchemaConfig, CustomFieldType } from '@/lib/atlas/types'
import { ATLAS_FIELD_TYPE_LABEL } from '@/lib/atlas/values'
import { builtinFieldNameConflict } from '@/lib/atlas/fieldNameGuard'
import { newFieldId } from '@/lib/atlas/persistence'
import { moduleGroupsOf } from '@/lib/forms/customFields'
import { useFieldDisplayLabels } from '@/lib/templates/useFieldRenames'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'

const INPUT = 'w-full text-12 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50'
const FIELD_TYPES: readonly CustomFieldType[] = ['text', 'longText', 'number', 'select', 'multiSelect', 'boolean']

interface ButtonProps {
  tab: TabDef
  config: AtlasSchemaConfig
  readOnly?: boolean
  onSave: (next: AtlasSchemaConfig) => Promise<AtlasSchemaConfig>
  size?: 'sm' | 'md'
}

export default function ModuleFieldManagerButton({ tab, config, readOnly, onSave, size = 'md' }: ButtonProps) {
  const [open, setOpen] = useState(false)
  const activeCount = config.fields.filter(f => !f.archived).length
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5"
        title="自定义字段：为本页追加、调整或归档自定义字段（不改动内置字段与已填内容）"
      >
        <Settings2 size={12} />
        自定义字段{activeCount > 0 ? ` (${activeCount})` : ''}
      </Button>
      {open && (
        <ModuleFieldManagerModal
          tab={tab}
          config={config}
          readOnly={readOnly}
          onSave={onSave}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ModuleFieldManagerModal({
  tab, config, readOnly, onSave, onClose,
}: {
  tab: TabDef
  config: AtlasSchemaConfig
  readOnly?: boolean
  onSave: (next: AtlasSchemaConfig) => Promise<AtlasSchemaConfig>
  onClose: () => void
}) {
  const groups = useMemo(() => moduleGroupsOf(tab), [tab])
  const builtinKeys = useMemo(
    () => (tab.modules ?? []).flatMap(m => m.fields.map(f => `${m.name}::${f.name}`)),
    [tab],
  )
  const aliasLabels = useFieldDisplayLabels(tab.id, builtinKeys)
  const builtinLabels = useMemo(
    () => builtinKeys.map(k => (aliasLabels[k] ?? k.split('::').pop() ?? k).trim()).filter(Boolean),
    [builtinKeys, aliasLabels],
  )

  const active = useMemo(() => config.fields.filter(f => !f.archived).sort((a, b) => a.order - b.order), [config.fields])
  const archived = useMemo(() => config.fields.filter(f => f.archived), [config.fields])

  const [draft, setDraft] = useState<AtlasFieldDefinition | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [optionsText, setOptionsText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const startCreate = () => {
    setErr('')
    setEditingId(null)
    setOptionsText('')
    setDraft({
      id: newFieldId(),
      label: '',
      type: 'text',
      description: '',
      appliesTo: '*',
      groupId: groups[0]?.id ?? 'extra',
      order: active.length > 0 ? Math.max(...active.map(f => f.order)) + 1 : 0,
      tableVisible: false,
      detailVisible: true,
      searchable: true,
      aiReadable: true,
      aiWritable: false,
      archived: false,
    })
  }

  const startEdit = (f: AtlasFieldDefinition) => {
    setErr('')
    setEditingId(f.id)
    setOptionsText((f.options ?? []).join('\n'))
    setDraft({ ...f, options: f.options ? [...f.options] : undefined })
  }

  const commitSave = async (nextFields: AtlasFieldDefinition[]) => {
    setBusy(true)
    try {
      await onSave({ ...config, fields: nextFields })
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存字段配置失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = async () => {
    if (!draft || readOnly || busy) return
    const label = draft.label.trim()
    if (!label) { setErr('字段名不能为空'); return }
    if ([...label].length > 20) { setErr('字段名最多 20 个字'); return }
    const conflict = builtinFieldNameConflict(label, builtinLabels)
    if (conflict) { setErr(conflict); return }
    const dupCustom = config.fields.some(f => f.id !== draft.id && !f.archived && f.label.trim() === label)
    if (dupCustom) { setErr(`已有叫「${label}」的自定义字段，请换个名字`); return }

    const needsOpts = draft.type === 'select' || draft.type === 'multiSelect'
    const options = needsOpts
      ? [...new Set(optionsText.split('\n').map(s => s.trim()).filter(Boolean))]
      : undefined
    if (needsOpts && (!options || options.length === 0)) {
      setErr('单选 / 多选字段请至少填写一个选项')
      return
    }
    const clean: AtlasFieldDefinition = {
      ...draft,
      label,
      description: draft.description.trim(),
      unit: draft.type === 'number' && draft.unit?.trim() ? draft.unit.trim() : undefined,
      options,
    }
    const nextFields = editingId
      ? config.fields.map(f => (f.id === editingId ? clean : f))
      : [...config.fields, clean]
    await commitSave(nextFields)
    setDraft(null)
    setEditingId(null)
  }

  const moveOrder = async (fieldId: string, delta: -1 | 1) => {
    if (readOnly || busy) return
    const idx = active.findIndex(f => f.id === fieldId)
    const to = idx + delta
    if (idx < 0 || to < 0 || to >= active.length) return
    const a = active[idx]
    const b = active[to]
    const nextFields = config.fields.map(f => (
      f.id === a.id ? { ...f, order: b.order } : f.id === b.id ? { ...f, order: a.order } : f
    ))
    await commitSave(nextFields)
  }

  const toggleArchive = async (fieldId: string, toArchived: boolean) => {
    if (readOnly || busy) return
    const nextFields = config.fields.map(f => (f.id === fieldId ? { ...f, archived: toArchived } : f))
    await commitSave(nextFields)
  }

  const groupLabel = (gid: string) => groups.find(g => g.id === gid)?.label ?? '自定义字段'

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Settings2 size={14} />}
      title={`自定义字段 · ${tab.name}`}
      width={720}
      maxHeight="84vh"
      footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}
    >
      <div className="space-y-4">
        {readOnly && (
          <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-11 text-amber">
            当前字段配置由更高版本软件写入，已锁定为只读浏览。
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-11 text-ink-400">
            自定义字段使用独立存储键（<code>cf_*</code>），改名或调整分组均不会影响已有数据。
          </p>
          {!readOnly && !draft && (
            <Button variant="primary" solid size="sm" onClick={startCreate} className="shrink-0 flex items-center gap-1">
              <Plus size={12} /> 新增字段
            </Button>
          )}
        </div>

        {draft && (
          <section className="rounded-xl border border-amber/30 bg-amber/5 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-12 font-semibold text-ink-100">
                {editingId ? `编辑字段 · ${draft.label}` : '新增自定义字段'}
              </h3>
              <Button variant="bare" iconOnly size="xs" onClick={() => { setDraft(null); setEditingId(null) }} title="取消">
                <X size={13} />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-11 text-ink-400">字段名（1–20 字）</span>
                <input
                  className={`mt-1 ${INPUT}`}
                  value={draft.label}
                  maxLength={20}
                  placeholder="例如：核心卖点补充"
                  onChange={e => { setErr(''); setDraft({ ...draft, label: e.target.value }) }}
                />
              </label>
              <label className="block">
                <span className="text-11 text-ink-400">类型</span>
                <select
                  className={`mt-1 ${INPUT}`}
                  value={draft.type}
                  disabled={Boolean(editingId)}
                  onChange={e => setDraft({ ...draft, type: e.target.value as CustomFieldType })}
                >
                  {FIELD_TYPES.map(t => <option key={t} value={t}>{ATLAS_FIELD_TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-11 text-ink-400">所属模块</span>
                <select
                  className={`mt-1 ${INPUT}`}
                  value={draft.groupId}
                  onChange={e => setDraft({ ...draft, groupId: e.target.value })}
                >
                  {groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                </select>
              </label>
              {draft.type === 'number' && (
                <label className="block">
                  <span className="text-11 text-ink-400">单位（如「年」「层」）</span>
                  <input
                    className={`mt-1 ${INPUT}`}
                    value={draft.unit ?? ''}
                    maxLength={10}
                    onChange={e => setDraft({ ...draft, unit: e.target.value })}
                  />
                </label>
              )}
            </div>
            {(draft.type === 'select' || draft.type === 'multiSelect') && (
              <label className="block">
                <span className="text-11 text-ink-400">选项（每行一个）</span>
                <textarea
                  className={`mt-1 ${INPUT} h-20 resize-none`}
                  value={optionsText}
                  onChange={e => setOptionsText(e.target.value)}
                  placeholder={'选项一\n选项二'}
                />
              </label>
            )}
            <label className="block">
              <span className="text-11 text-ink-400">字段说明（给人看，也给 AI 参考）</span>
              <input
                className={`mt-1 ${INPUT}`}
                value={draft.description}
                maxLength={200}
                onChange={e => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <div className="flex flex-wrap items-center gap-4 text-11 text-ink-300">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.searchable} onChange={e => setDraft({ ...draft, searchable: e.target.checked })} />
                可被检索
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.aiReadable} onChange={e => setDraft({ ...draft, aiReadable: e.target.checked })} />
                允许 AI 参考
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.aiWritable} onChange={e => setDraft({ ...draft, aiWritable: e.target.checked })} />
                允许 AI 补全填写
              </label>
            </div>
            {err && <div className="text-11 text-danger">{err}</div>}
            <div className="flex items-center gap-2">
              <Button variant="primary" solid size="sm" disabled={busy} onClick={() => void saveDraft()} className="flex items-center gap-1">
                <Save size={12} /> {busy ? '保存中…' : '保存字段'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setDraft(null); setEditingId(null) }}>取消</Button>
            </div>
          </section>
        )}

        {active.length === 0 ? (
          <div className="rounded-xl border border-ink-700/70 bg-ink-900/40 px-4 py-6 text-center text-12 text-ink-400">
            还没有自定义字段，点右上角「新增字段」即可为本页添加。
          </div>
        ) : (
          <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700 overflow-hidden">
            {active.map((f, idx) => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2 bg-ink-850/60">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-12 font-medium text-ink-100 truncate">{f.label}</span>
                    <span className="text-10 px-1.5 py-0.5 rounded bg-ink-900 border border-ink-700 text-ink-400">
                      {ATLAS_FIELD_TYPE_LABEL[f.type]}
                    </span>
                    <span className="text-10 text-ink-500 truncate">{groupLabel(f.groupId)}</span>
                    {f.aiWritable && (
                      <span className="text-10 px-1.5 py-0.5 rounded bg-info/10 border border-info/30 text-info">AI 可写</span>
                    )}
                  </div>
                  {f.description && <p className="text-10 text-ink-500 truncate mt-0.5">{f.description}</p>}
                </div>
                {!readOnly && (
                  <div className="shrink-0 flex items-center gap-0.5">
                    <Button variant="bare" iconOnly size="xs" disabled={idx === 0 || busy} onClick={() => void moveOrder(f.id, -1)} title="上移">
                      <ArrowUp size={12} />
                    </Button>
                    <Button variant="bare" iconOnly size="xs" disabled={idx === active.length - 1 || busy} onClick={() => void moveOrder(f.id, 1)} title="下移">
                      <ArrowDown size={12} />
                    </Button>
                    <Button variant="bare" iconOnly size="xs" disabled={busy} onClick={() => startEdit(f)} title="编辑">
                      <Pencil size={12} />
                    </Button>
                    <Button variant="bare" iconOnly size="xs" disabled={busy} className="hover:text-danger" onClick={() => void toggleArchive(f.id, true)} title="归档（保留已填数据）">
                      <Archive size={12} />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {archived.length > 0 && (
          <details className="rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2">
            <summary className="text-11 text-ink-400 cursor-pointer">
              已归档（{archived.length}）· 已填数据保留，可随时恢复
            </summary>
            <ul className="mt-2 space-y-1.5">
              {archived.map(f => (
                <li key={f.id} className="flex items-center gap-2 text-12 text-ink-400">
                  <span className="truncate">{f.label}</span>
                  <span className="text-10 text-ink-600">{ATLAS_FIELD_TYPE_LABEL[f.type]}</span>
                  {!readOnly && (
                    <Button
                      variant="bare"
                      size="xs"
                      disabled={busy}
                      className="ml-auto flex items-center gap-1 text-ink-400 hover:text-amber"
                      onClick={() => void toggleArchive(f.id, false)}
                    >
                      <ArchiveRestore size={11} /> 恢复
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  )
}

/**
 * 模板管理（3.2.0 · T1）—— 七个页签的模板编辑 / 采用 / 迁移确认 / 恢复入口。
 *
 * 流程（严格按方案 §3.5–§3.6）：
 *   ① 采用前先看一遍只读变更计划（保留 / 改动 / 新增 / 归档 / 值怎么办）；
 *   ② 确认后才执行迁移（备份 → 写值 → 写模板 → 索引校验）；
 *   ③ 迁移中断留下的阻断日志，在打开本弹窗时直接给出「恢复到迁移前」。
 *
 * 🔴 本组件不直接写 settingsKV：所有落库都走 `applyTemplateMigration`，
 *    否则值转换、备份、索引与缓存失效会被绕过（那正是迁移层存在的理由）。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, Pencil, Plus,
  RefreshCw, RotateCcw, Settings2, Trash2, X,
} from 'lucide-react'
import type { TabDef } from '@/lib/types'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import { atlasCategoryOptions, isAtlasTab } from '@/lib/atlas/schema'
import { getCurrentProjectId } from '@/lib/db'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { LoadingState } from '@/components/common/LoadingState'
import { moduleAliasTargets } from '@/components/sheets/FieldAliasButton'
import { useFieldAliases } from '@/lib/settings/fieldAlias'
import {
  addCustomField, addGroup, archiveField, fieldsOfGroup, finalizeTemplateDef, moveField,
  moveGroup, orderedGroups, patchField, removeGroup, renameGroup, renameTemplate,
  restoreField, setFieldPermissions, setNameField,
  type EditableFieldPatch,
} from '@/lib/templates/draftOps'
import {
  snapshotOfAtlas, snapshotOfBlank, snapshotOfBuiltin,
} from '@/lib/templates/snapshot'
import { deleteTemplateDef, loadTemplateDef, subscribeTemplateStore } from '@/lib/templates/store'
import { checkTemplateDef } from '@/lib/templates/limits'
import { planTemplateChange, type TemplateChangePlan } from '@/lib/templates/plan'
import {
  applyTemplateMigration, countValuesForFields, recoverTemplateMigration,
  type MigrationResult,
} from '@/lib/templates/migrate'
import {
  blockingMigrationOf, type MigrationLog,
} from '@/lib/templates/migrationLog'
import { migrationStateLabel } from '@/lib/templates/migrationGuard'
import type { TemplateDef } from '@/lib/templates/definition'
import type { EffectiveField, TemplateFieldPermissions, TemplateFieldType } from '@/lib/templates/types'
import { previewLibraryUpgrade } from '@/lib/templates/library'
import TemplateFieldEditor, { TYPE_LABEL } from './TemplateFieldEditor'
import TemplatePlanView from './TemplatePlanView'
import TemplateLibraryPanel from './TemplateLibraryPanel'

const INPUT = 'w-full text-12 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50'

type Mode = 'overview' | 'edit' | 'plan'
type Editing = { kind: 'create'; groupId: string } | { kind: 'edit'; fieldId: string } | null

interface Props {
  tab: TabDef
  atlasConfig?: AtlasSchemaConfig | null
  onClose: () => void
}

export default function TemplateManagerDialog({ tab, atlasConfig = null, onClose }: Props) {
  const pid = getCurrentProjectId()
  const [current, setCurrent] = useState<TemplateDef | null>(null)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [draft, setDraft] = useState<TemplateDef | null>(null)
  const [mode, setMode] = useState<Mode>('overview')
  const [plan, setPlan] = useState<TemplateChangePlan | null>(null)
  const [planFrom, setPlanFrom] = useState<TemplateDef | null>(null)
  const [approved, setApproved] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing>(null)
  const [editingGroup, setEditingGroup] = useState<{ id: string; label: string } | null>(null)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [blocking, setBlocking] = useState<MigrationLog | null>(null)

  const isAtlas = isAtlasTab(tab.id)
  const aliasKeys = useMemo(
    () => (isAtlas
      ? (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name)
      : moduleAliasTargets(tab.modules).map(t => t.key)),
    [isAtlas, tab],
  )
  const { map: aliasMap } = useFieldAliases(tab.id, aliasKeys)
  const categories = useMemo(() => atlasCategoryOptions(tab), [tab])

  useEffect(() => {
    let alive = true
    const reload = () => {
      void loadTemplateDef(pid, tab.id)
        .then(d => { if (alive) { setCurrent(d); setLoadedOnce(true) } })
        .catch(() => { if (alive) setLoadedOnce(true) })
      void blockingMigrationOf(pid, tab.id)
        .then(l => { if (alive) setBlocking(l) })
        .catch(() => { /* 读不到日志时按“无阻断”处理，迁移本身仍会再核一次 */ })
    }
    reload()
    const off = subscribeTemplateStore(reload)
    return () => { alive = false; off() }
  }, [pid, tab.id])

  const snapshot = (kind: 'builtin' | 'blank'): TemplateDef => {
    if (kind === 'blank') return snapshotOfBlank(tab)
    if (isAtlas) {
      return snapshotOfAtlas(tab, {
        aliases: aliasMap,
        config: atlasConfig,
        name: `${tab.name}·自定义`,
      })
    }
    return snapshotOfBuiltin(tab, { aliases: aliasMap, name: `${tab.name}·自定义` })
  }

  const startEdit = (kind: 'builtin' | 'blank') => {
    setDraft(snapshot(kind))
    setEditing(null)
    setEditingGroup(null)
    setNewGroup(null)
    setResult(null)
    setErr('')
    setMode('edit')
  }

  /** 编辑已采用的模板：以快照本身为草稿，不能重新从 schema 派生（那会把作者的改动冲掉） */
  const editCurrent = () => {
    if (!current) return
    setDraft(current)
    setEditing(null)
    setEditingGroup(null)
    setNewGroup(null)
    setResult(null)
    setErr('')
    setMode('edit')
  }

  const patchDraftField = (fieldId: string, p: EditableFieldPatch) => {
    setDraft(d => (d ? patchField(d, fieldId, p) : d))
  }

  const patchDraftPerms = (fieldId: string, p: Partial<TemplateFieldPermissions>) => {
    setDraft(d => (d ? setFieldPermissions(d, fieldId, p) : d))
  }

  const createField = (input: { label: string; type: TemplateFieldType; groupId: string }) => {
    setDraft(d => {
      if (!d) return d
      const r = addCustomField(d, input)
      return r.def
    })
    setEditing(null)
  }

  const removeGroupNow = async (groupId: string, label: string) => {
    if (!draft) return
    if (draft.groups.length <= 1) {
      showToast('至少要保留一个分组', 'error')
      return
    }
    if (!await confirmDialog({
      title: `删除分组「${label}」`,
      message: '分组里的字段不会被删除，会移动到第一个剩余分组。',
      danger: true,
    })) return
    setDraft(d => (d ? removeGroup(d, groupId) : d))
  }

  const archiveNow = async (f: EffectiveField) => {
    if (!await confirmDialog({
      title: `归档字段「${f.label}」`,
      message: '字段与已填内容都会保留，只是不再显示；随时可以在这里恢复。',
    })) return
    setDraft(d => (d ? archiveField(d, f.id) : d))
  }

  /** 生成只读计划：先算受影响字段的现有值规模，再推演 */
  const preview = async () => {
    if (!draft) return
    const to = finalizeTemplateDef(draft, { revision: (current?.revision ?? 0) + 1 })
    const violations = checkTemplateDef(to)
    if (violations.length > 0) {
      setErr(violations.map(v => v.detail).join('\n'))
      return
    }
    if (!to.nameFieldId) {
      setErr('请先在模板顶部指定一个名称字段（表格 / 卡片的记录标题）')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const counts = await countValuesForFields(pid, tab.id, (current?.fields ?? []).map(f => f.id))
      const nextPlan = planTemplateChange(current, to, { valueCounts: counts })
      setPlan(nextPlan)
      setPlanFrom(current)
      setApproved({})
      setResult(null)
      setMode('plan')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!plan || !draft) return
    const to = finalizeTemplateDef(draft, { revision: (current?.revision ?? 0) + 1 })
    setBusy(true)
    setErr('')
    try {
      const res = await applyTemplateMigration({
        pid,
        tabId: tab.id,
        plan,
        to,
        expectedFrom: planFrom,
        ...(Object.keys(approved).length > 0 ? { approvedMaps: approved } : {}),
      })
      setResult(res)
      if (res.ok) {
        if (res.state === 'noop') {
          showToast('模板没有变化，未写入', 'info')
        } else if (res.state === 'done-partial') {
          showToast(`模板已切换；有 ${res.log.failures.length + res.log.manualFields.length} 项需人工处理`, 'error', 8000)
        } else {
          showToast('模板已采用', 'success')
        }
        setCurrent(await loadTemplateDef(pid, tab.id))
        setBlocking(await blockingMigrationOf(pid, tab.id))
        setMode('overview')
      } else {
        setErr(`${res.detail}${res.recovered ? '' : '（恢复未完成，请勿继续编辑该页签）'}`)
        setBlocking(await blockingMigrationOf(pid, tab.id))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const recover = async () => {
    if (!await confirmDialog({
      title: '恢复到迁移前',
      message: '会把被改写过的值按迁移备份写回，并把模板恢复成迁移前的那一版。迁移后新写的内容可能被覆盖，请确认。',
      danger: true,
    })) return
    setBusy(true)
    setErr('')
    try {
      const r = await recoverTemplateMigration(pid, tab.id)
      if (r.ok) {
        showToast(r.state === 'recovered' ? `已恢复（写回 ${r.restoredValues} 条值）` : '没有需要恢复的内容', 'success')
        setCurrent(await loadTemplateDef(pid, tab.id))
        setBlocking(await blockingMigrationOf(pid, tab.id))
        setResult(null)
        setMode('overview')
      } else {
        setErr(r.detail)
        setBlocking(await blockingMigrationOf(pid, tab.id))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const abandon = async () => {
    if (!await confirmDialog({
      title: '放弃自定义模板',
      message: '将退回内置结构。自定义字段的值不会被删除，但界面不再显示这些字段；之后重新采用模板可再看到。',
      danger: true,
    })) return
    setBusy(true)
    try {
      await deleteTemplateDef(pid, tab.id)
      setCurrent(null)
      showToast('已退回内置结构', 'success')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleMap = (fromId: string, toId: string, checked: boolean) => {
    setApproved(a => {
      const next = { ...a }
      if (checked) next[fromId] = toId
      else delete next[fromId]
      return next
    })
  }

  /**
   * 个人库版本 → 项目：先出**同一份**变更计划，再进 `plan` 视图由作者确认。
   * 🔴 这里绝不直接写库：库升级与手工编辑是同一条迁移链路（备份 / 值转换 / 日志）。
   */
  const upgradeFromLibrary = async (libDef: TemplateDef, version: number) => {
    setBusy(true)
    setErr('')
    try {
      const preview = await previewLibraryUpgrade(pid, tab.id, libDef, { projectDef: current })
      const to: TemplateDef = {
        ...libDef,
        revision: (current?.revision ?? 0) + 1,
        origin: { kind: 'library', templateId: libDef.templateId, version, fromName: libDef.name },
      }
      setDraft(to)
      setPlan(preview.plan)
      setPlanFrom(current)
      setApproved({})
      setResult(null)
      setMode('plan')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /* ───────────── 渲染 ───────────── */

  const footer = mode === 'plan' ? (
    <>
      <Button variant="secondary" onClick={() => { setMode('edit'); setErr('') }} disabled={busy}>
        返回编辑
      </Button>
      <Button
        variant="primary"
        solid
        onClick={() => void apply()}
        disabled={busy || !plan || plan.blockers.length > 0}
        title={plan && plan.blockers.length > 0 ? '先处理变更计划里的阻断项' : '执行迁移并切换到新模板'}
      >
        {busy ? '正在采用…' : '确认采用'}
      </Button>
    </>
  ) : mode === 'edit' ? (
    <>
      <Button variant="secondary" onClick={() => { setMode('overview'); setErr('') }} disabled={busy}>
        取消编辑
      </Button>
      <Button variant="primary" solid onClick={() => void preview()} disabled={busy} className="flex items-center gap-1.5">
        <RefreshCw size={12} /> {busy ? '推演中…' : '预览变更并采用'}
      </Button>
    </>
  ) : (
    <Button variant="secondary" onClick={onClose}>关闭</Button>
  )

  return (
    <Modal
      open
      onClose={onClose}
      title={`模板 · ${tab.name}`}
      icon={<Settings2 size={14} />}
      width={860}
      maxHeight="88vh"
      footer={footer}
    >
      {!loadedOnce ? <LoadingState /> : (
        <div className="space-y-4">
          {blocking && mode !== 'plan' && (
            <div className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3 space-y-2">
              <div className="flex items-center gap-1.5 text-12 font-medium text-danger">
                <AlertTriangle size={13} />
                上一次模板迁移没有正常结束：{migrationStateLabel(blocking.state)}
              </div>
              <p className="text-11 text-ink-200 leading-relaxed">
                该页签的写入仍被阻断，避免旧结构的值被写进新结构。请先恢复到迁移前，再重新编辑模板。
              </p>
              <Button variant="danger" size="sm" onClick={() => void recover()} disabled={busy} className="flex items-center gap-1.5">
                <RotateCcw size={12} /> {busy ? '恢复中…' : '恢复到迁移前'}
              </Button>
            </div>
          )}

          {err && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-11 text-danger whitespace-pre-line leading-relaxed">
              {err}
            </div>
          )}

          {mode === 'overview' && (
            <>
              <section className="rounded-xl border border-ink-700 bg-ink-800/50 px-3.5 py-3 space-y-2">
                <h3 className="text-12 font-semibold text-ink-100">当前状态</h3>
                {current ? (
                  <p className="text-11 text-ink-300 leading-relaxed">
                    已采用模板「<b className="text-ink-100">{current.name}</b>」·
                    第 {current.revision} 版 · {current.fields.filter(f => !f.archived).length} 个字段
                    （自定义 {current.fields.filter(f => f.source === 'custom' && !f.archived).length} 个）。
                    结构已固定为这份快照，内置 schema 再变也不会悄悄改动。
                  </p>
                ) : (
                  <p className="text-11 text-ink-300 leading-relaxed">
                    还没有采用模板，当前沿用<b className="text-ink-100">内置结构</b>。
                    采用模板后，字段的增删改与顺序都以你的这份定义为准。
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {current ? (
                    <Button variant="primary" solid size="sm" onClick={editCurrent} className="flex items-center gap-1.5">
                      <Pencil size={12} /> 编辑当前模板
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" solid size="sm" onClick={() => startEdit('builtin')} className="flex items-center gap-1.5">
                        <Plus size={12} /> 从当前结构开始
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => startEdit('blank')} className="flex items-center gap-1.5">
                        <Plus size={12} /> 从空白开始
                      </Button>
                    </>
                  )}
                  {current && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => startEdit('blank')}>
                        从空白重建
                      </Button>
                      <Button variant="icon-danger" size="sm" onClick={() => void abandon()} disabled={busy} title="退回内置结构（自定义字段的值仍保留在库里）">
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </section>

              <TemplateLibraryPanel
                tab={tab}
                current={current}
                busy={busy}
                onUpgrade={(def, version) => void upgradeFromLibrary(def, version)}
              />

              {result && !result.ok && result.log && (
                <MigrationLogView log={result.log} />
              )}
              {result && result.ok && result.state !== 'noop' && (
                <MigrationLogView log={result.log} />
              )}
            </>
          )}

          {mode === 'edit' && draft && (
            <EditView
              draft={draft}
              setDraft={setDraft}
              categories={categories}
              editing={editing}
              setEditing={setEditing}
              editingGroup={editingGroup}
              setEditingGroup={setEditingGroup}
              newGroup={newGroup}
              setNewGroup={setNewGroup}
              patchField={patchDraftField}
              patchPerms={patchDraftPerms}
              createField={createField}
              removeGroupNow={id => void removeGroupNow(id, draft.groups.find(g => g.id === id)?.label ?? id)}
              archiveNow={f => void archiveNow(f)}
            />
          )}

          {mode === 'plan' && plan && draft && (
            <TemplatePlanView
              plan={plan}
              from={planFrom}
              to={finalizeTemplateDef(draft, { revision: (current?.revision ?? 0) + 1 })}
              approvedMaps={approved}
              onToggleMap={toggleMap}
            />
          )}
        </div>
      )}
    </Modal>
  )
}

/* ────────────────────────── 编辑视图 ────────────────────────── */

interface EditProps {
  draft: TemplateDef
  setDraft: (next: TemplateDef) => void
  categories: string[]
  editing: Editing
  setEditing: (e: Editing) => void
  editingGroup: { id: string; label: string } | null
  setEditingGroup: (g: { id: string; label: string } | null) => void
  newGroup: string | null
  setNewGroup: (v: string | null) => void
  patchField: (id: string, p: EditableFieldPatch) => void
  patchPerms: (id: string, p: Partial<TemplateFieldPermissions>) => void
  createField: (input: { label: string; type: TemplateFieldType; groupId: string }) => void
  removeGroupNow: (id: string) => void
  archiveNow: (f: EffectiveField) => void
}

function EditView({
  draft, setDraft, categories, editing, setEditing, editingGroup, setEditingGroup,
  newGroup, setNewGroup, patchField, patchPerms, createField, removeGroupNow, archiveNow,
}: EditProps) {
  const groups = orderedGroups(draft)
  const activeFields = draft.fields.filter(f => !f.archived)
  const archived = draft.fields.filter(f => f.archived)
  const editingField = editing?.kind === 'edit'
    ? draft.fields.find(f => f.id === editing.fieldId)
    : undefined

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-11 text-ink-400">模板名称（1–20 字）</span>
          <input
            className={`mt-1 ${INPUT}`}
            value={draft.name}
            maxLength={20}
            onChange={e => setDraft(renameTemplate(draft, e.target.value))}
          />
        </label>
        <label className="block">
          <span className="text-11 text-ink-400">名称字段（记录标题 / 卡片主名）</span>
          <select
            className={`mt-1 ${INPUT}`}
            value={draft.nameFieldId}
            onChange={e => setDraft(setNameField(draft, e.target.value))}
          >
            {activeFields.length === 0 && <option value="">（没有可用字段）</option>}
            {activeFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
      </section>

      {/* 分组 */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2">
            <span className="w-1 h-3.5 bg-amber rounded-full" />
            分组与字段（{groups.length} 个分组 · {activeFields.length} 个字段）
          </h3>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setNewGroup('')}
            className="flex items-center gap-1.5"
          >
            <Plus size={12} /> 新增分组
          </Button>
        </div>

        {newGroup !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2">
            <input
              className={INPUT}
              value={newGroup}
              maxLength={20}
              placeholder="分组名，例如「战斗数据」"
              onChange={e => setNewGroup(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const label = newGroup.trim()
                if (!label) return
                setDraft(addGroup(draft, label))
                setNewGroup(null)
              }}
            >
              创建
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setNewGroup(null)}>取消</Button>
          </div>
        )}

        {groups.map((g, gi) => {
          const list = fieldsOfGroup(draft, g.id).filter(f => !f.archived)
          return (
            <div key={g.id} className="rounded-xl border border-ink-700 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-ink-800/60 border-b border-ink-700">
                {editingGroup?.id === g.id ? (
                  <>
                    <input
                      className={INPUT}
                      value={editingGroup.label}
                      maxLength={20}
                      onChange={e => setEditingGroup({ id: g.id, label: e.target.value })}
                    />
                    <Button
                      variant="bare"
                      iconOnly
                      size="xs"
                      className="text-success"
                      onClick={() => {
                        const label = editingGroup.label.trim()
                        if (label) setDraft(renameGroup(draft, g.id, label))
                        setEditingGroup(null)
                      }}
                      title="保存分组名"
                    >
                      <Check size={12} />
                    </Button>
                    <Button variant="bare" iconOnly size="xs" onClick={() => setEditingGroup(null)} title="取消">
                      <X size={12} />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-12 font-medium text-ink-100">{g.label}</span>
                    <span className="text-10 text-ink-500">{list.length} 个字段</span>
                    <div className="ml-auto flex items-center gap-0.5">
                      <Button variant="bare" iconOnly size="xs" disabled={gi === 0}
                        onClick={() => setDraft(moveGroup(draft, g.id, -1))} title="分组上移">
                        <ArrowUp size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs" disabled={gi === groups.length - 1}
                        onClick={() => setDraft(moveGroup(draft, g.id, 1))} title="分组下移">
                        <ArrowDown size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs"
                        onClick={() => setEditingGroup({ id: g.id, label: g.label })} title="重命名分组">
                        <Pencil size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs" disabled={groups.length <= 1}
                        className="hover:text-danger" onClick={() => removeGroupNow(g.id)} title="删除分组（字段会移到第一个剩余分组）">
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <ul className="divide-y divide-ink-700">
                {list.map((f, fi) => (
                  <li key={f.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-12 text-ink-100 truncate">{f.label}</span>
                        <span className="shrink-0 text-10 px-1.5 py-0.5 rounded bg-ink-900 border border-ink-700 text-ink-400">
                          {TYPE_LABEL[f.type]}
                        </span>
                        <span className="shrink-0 text-10 text-ink-600">
                          {f.source === 'builtin' ? '内置' : '自定义'}
                        </span>
                        {draft.nameFieldId === f.id && (
                          <span className="shrink-0 text-10 px-1.5 py-0.5 rounded bg-amber/15 border border-amber/30 text-amber">
                            名称字段
                          </span>
                        )}
                        {f.permissions.aiWrite && (
                          <span className="shrink-0 text-10 px-1.5 py-0.5 rounded bg-info/10 border border-info/30 text-info">
                            AI 可写
                          </span>
                        )}
                      </div>
                      {f.description && (
                        <div className="mt-0.5 text-10 text-ink-500 truncate" title={f.description}>{f.description}</div>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-0.5">
                      <Button variant="bare" iconOnly size="xs" disabled={fi === 0}
                        onClick={() => setDraft(moveField(draft, f.id, -1))} title="上移">
                        <ArrowUp size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs" disabled={fi === list.length - 1}
                        onClick={() => setDraft(moveField(draft, f.id, 1))} title="下移">
                        <ArrowDown size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs"
                        onClick={() => setEditing({ kind: 'edit', fieldId: f.id })} title="编辑字段">
                        <Pencil size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs"
                        className="hover:text-danger" onClick={() => archiveNow(f)}
                        title="归档（字段与已填内容保留，可恢复）">
                        <Archive size={12} />
                      </Button>
                    </div>
                  </li>
                ))}
                <li className="px-3 py-2">
                  <Button
                    variant="bare"
                    size="xs"
                    className="text-ink-400 hover:text-amber flex items-center gap-1"
                    onClick={() => setEditing({ kind: 'create', groupId: g.id })}
                  >
                    <Plus size={11} /> 在这个分组里加字段
                  </Button>
                </li>
              </ul>
            </div>
          )
        })}
      </section>

      {/* 字段编辑 / 新建 */}
      {editing?.kind === 'edit' && editingField && (
        <TemplateFieldEditor
          key={editingField.id}
          mode="edit"
          field={editingField}
          groups={groups}
          categories={categories}
          defaultGroupId={editingField.groupId}
          onPatch={p => patchField(editingField.id, p)}
          onPermissions={p => patchPerms(editingField.id, p)}
          onCreate={() => { /* 编辑模式不创建 */ }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'create' && (
        <TemplateFieldEditor
          key={`new-${editing.groupId}`}
          mode="create"
          groups={groups}
          categories={categories}
          defaultGroupId={editing.groupId}
          onPatch={() => { /* 创建模式只改本地表单 */ }}
          onPermissions={() => { /* 权限在建立后编辑 */ }}
          onCreate={createField}
          onClose={() => setEditing(null)}
        />
      )}

      {/* 归档区 */}
      {archived.length > 0 && (
        <details className="rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2">
          <summary className="text-11 text-ink-400 cursor-pointer">
            已归档（{archived.length}）· 字段与已填内容都还在，可随时恢复
          </summary>
          <ul className="mt-2 space-y-1.5">
            {archived.map(f => (
              <li key={f.id} className="flex items-center gap-2 text-12 text-ink-400">
                <span className="truncate">{f.label}</span>
                <span className="text-10 text-ink-600">{TYPE_LABEL[f.type]}</span>
                <Button
                  variant="bare"
                  size="xs"
                  className="ml-auto flex items-center gap-1 text-ink-400 hover:text-amber"
                  onClick={() => setDraft(restoreField(draft, f.id))}
                >
                  <ArchiveRestore size={11} /> 恢复
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/* ────────────────────────── 迁移结果 ────────────────────────── */

function MigrationLogView({ log }: { log: MigrationLog }) {
  const pending = log.failures.length + log.manualFields.length
  return (
    <section className="rounded-xl border border-ink-700 bg-ink-800/50 px-3.5 py-3 space-y-1.5">
      <h3 className="text-12 font-semibold text-ink-100">
        迁移结果：{migrationStateLabel(log.state)}
      </h3>
      {log.note && <p className="text-11 text-ink-300 leading-relaxed">{log.note}</p>}
      <p className="text-10 text-ink-500">
        写回 {log.writtenValues} 条值{log.backupVerified ? ' · 备份已读回校验' : ''}
        {pending > 0 ? ` · ${pending} 项需人工处理（值已保留，未丢）` : ''}
      </p>
      {log.failures.length > 0 && (
        <details className="text-10 text-ink-400">
          <summary className="cursor-pointer">逐条转换失败（{log.failures.length}）</summary>
          <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {log.failures.slice(0, 50).map((f, i) => (
              <li key={i}>· {f.label ?? f.fieldId}：{f.reason}{f.value ? `（原值：${f.value.slice(0, 40)}）` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      {log.manualFields.length > 0 && (
        <details className="text-10 text-ink-400">
          <summary className="cursor-pointer">需人工处理的字段（{log.manualFields.length}）</summary>
          <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {log.manualFields.map((m, i) => (
              <li key={i}>· {m.label}：{m.count} 条 · {m.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

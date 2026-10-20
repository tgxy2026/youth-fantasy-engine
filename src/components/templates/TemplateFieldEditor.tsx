/**
 * 单个模板字段的编辑表单（3.2.0 · T1）。
 *
 * 🔴 只改 `TemplateDef` 草稿，不落库；点「预览并采用」之后才走迁移。
 * 🔴 字段 ID / 存储键只读展示，改名永远只动 `label`。
 */
import { useState } from 'react'
import { Save, X } from 'lucide-react'
import type { EffectiveField, EffectiveGroup, TemplateFieldPermissions, TemplateFieldType } from '@/lib/templates/types'
import type { EditableFieldPatch } from '@/lib/templates/draftOps'
import { Button } from '@/components/common/Button'

export const TYPE_LABEL: Record<TemplateFieldType, string> = {
  text: '短文本',
  textarea: '长文本',
  number: '数字',
  select: '单选',
  multiSelect: '多选',
  boolean: '是/否',
  date: '日期',
  calendar: '历法日期',
  tableRef: '跨表引用',
  character: '角色',
  characters: '多角色',
  other: '未识别（只读）',
}

const INPUT = 'w-full text-12 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50'

const PERM_LABEL: [keyof TemplateFieldPermissions, string, string][] = [
  ['table', '表格里显示', '关掉后表格里看不到这一列（值仍在）'],
  ['detail', '详情里显示', '关掉后卡片 / 详情不展示'],
  ['search', '可被搜索', '参与设定检索'],
  ['aiRead', '允许 AI 参考', '已存值可进入模型上下文与索引'],
  ['aiWrite', '允许 AI 填写', 'AI 补全 / 整理时会写这一栏'],
]

interface CreateInput {
  label: string
  type: TemplateFieldType
  groupId: string
}

interface Props {
  mode: 'create' | 'edit'
  field?: EffectiveField
  groups: EffectiveGroup[]
  categories: string[]
  defaultGroupId: string
  onPatch: (patch: EditableFieldPatch) => void
  onPermissions: (patch: Partial<TemplateFieldPermissions>) => void
  onCreate: (input: CreateInput) => void
  onClose: () => void
}

export default function TemplateFieldEditor({
  mode, field, groups, categories, defaultGroupId, onPatch, onPermissions, onCreate, onClose,
}: Props) {
  const [label, setLabel] = useState(field?.label ?? '')
  const [type, setType] = useState<TemplateFieldType>(field?.type ?? 'text')
  const [groupId, setGroupId] = useState(field?.groupId ?? defaultGroupId)
  const [description, setDescription] = useState(field?.description ?? '')
  const [example, setExample] = useState(field?.example ?? '')
  const [unit, setUnit] = useState(field?.unit ?? '')
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join('\n'))
  const [fixedOptions, setFixedOptions] = useState(Boolean(field?.fixedOptions))
  const [appliesTo, setAppliesTo] = useState<'*' | string[]>(field?.appliesTo ?? '*')
  const [err, setErr] = useState('')

  const patch = (p: EditableFieldPatch) => {
    if (mode === 'edit') onPatch(p)
  }

  const commitOptions = () => {
    const list = [...new Set(optionsText.split('\n').map(s => s.trim()).filter(Boolean))]
    setOptionsText(list.join('\n'))
    patch({ options: list.length > 0 ? list : undefined })
  }

  const submitCreate = () => {
    const name = label.trim()
    if (!name) { setErr('字段名不能为空'); return }
    if ([...name].length > 20) { setErr('字段名最多 20 个字'); return }
    if (!groups.some(g => g.id === groupId)) { setErr('请选择所属分组'); return }
    onCreate({ label: name, type, groupId })
  }

  const typeEditable = true
  const needsOptions = type === 'select' || type === 'multiSelect'

  return (
    <section className="rounded-xl border border-amber/30 bg-amber/5 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-12 font-semibold text-ink-100">
          {mode === 'create' ? '新增字段' : `编辑字段 · ${field?.label ?? ''}`}
        </h3>
        <Button variant="bare" iconOnly size="xs" onClick={onClose} title="取消">
          <X size={13} />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-11 text-ink-400">字段名（1–20 字）</span>
          <input
            className={`mt-1 ${INPUT}`}
            value={label}
            maxLength={20}
            placeholder="例如：食性"
            onChange={e => {
              setLabel(e.target.value)
              patch({ label: e.target.value })
            }}
          />
        </label>
        <label className="block">
          <span className="text-11 text-ink-400">类型</span>
          <select
            className={`mt-1 ${INPUT}`}
            value={type}
            disabled={!typeEditable}
            onChange={e => {
              const t = e.target.value as TemplateFieldType
              setType(t)
              patch({ type: t })
              if (t !== 'select' && t !== 'multiSelect') patch({ fixedOptions: undefined })
            }}
          >
            {(Object.keys(TYPE_LABEL) as TemplateFieldType[]).map(t => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-11 text-ink-400">所属分组</span>
          <select
            className={`mt-1 ${INPUT}`}
            value={groupId}
            onChange={e => {
              setGroupId(e.target.value)
              patch({ groupId: e.target.value })
            }}
          >
            {groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
        {type === 'number' && (
          <label className="block">
            <span className="text-11 text-ink-400">单位（如「年」「里」）</span>
            <input
              className={`mt-1 ${INPUT}`}
              value={unit}
              maxLength={10}
              onChange={e => {
                setUnit(e.target.value)
                patch({ unit: e.target.value })
              }}
            />
          </label>
        )}
      </div>

      {field && (
        <p className="text-10 text-ink-500">
          存储键：<code className="text-ink-400">{field.sourceKey}</code>
          （{field.source === 'builtin' ? '内置字段' : '自定义字段'}，改名不影响已填内容）
        </p>
      )}

      {field?.source === 'builtin' && type !== field.type && (
        <p className="rounded-lg border border-amber/30 bg-amber/5 px-2.5 py-1.5 text-10 text-amber/90 leading-relaxed">
          内置字段改类型属于「改义」：采用后会按变更计划逐条转换，无法自动转换的值保留原样并列入人工清单。
        </p>
      )}

      <label className="block">
        <span className="text-11 text-ink-400">说明（给人看，也给 AI 看；≤500 字）</span>
        <textarea
          className={`mt-1 ${INPUT} h-16 resize-none`}
          value={description}
          maxLength={500}
          placeholder="这个字段要填什么、有什么限制……"
          onChange={e => {
            setDescription(e.target.value)
            patch({ description: e.target.value })
          }}
        />
      </label>

      <label className="block">
        <span className="text-11 text-ink-400">填写示例（会一并交给 AI 作参考）</span>
        <input
          className={`mt-1 ${INPUT}`}
          value={example}
          maxLength={200}
          placeholder="例如：肉食"
          onChange={e => {
            setExample(e.target.value)
            patch({ example: e.target.value })
          }}
        />
      </label>

      {needsOptions && (
        <>
          <label className="block">
            <span className="text-11 text-ink-400">选项（一行一个，最多 100 项）</span>
            <textarea
              className={`mt-1 ${INPUT} h-20 resize-none`}
              value={optionsText}
              placeholder={'肉食\n草食\n杂食'}
              onChange={e => setOptionsText(e.target.value)}
              onBlur={commitOptions}
            />
          </label>
          <label className="flex items-center gap-1 text-11 text-ink-300">
            <input
              type="checkbox"
              checked={fixedOptions}
              onChange={e => {
                setFixedOptions(e.target.checked)
                patch({ fixedOptions: e.target.checked })
              }}
            />
            封闭枚举（作者不能在表格里增改选项）
          </label>
        </>
      )}

      {categories.length > 0 && (
        <div>
          <span className="text-11 text-ink-400">适用类别</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-11 text-ink-300">
              <input
                type="checkbox"
                checked={appliesTo === '*'}
                onChange={e => {
                  const next: '*' | string[] = e.target.checked ? '*' : []
                  setAppliesTo(next)
                  patch({ appliesTo: next })
                }}
              />
              不限类别
            </label>
            {appliesTo !== '*' && categories.map(c => {
              const on = appliesTo.includes(c)
              return (
                <label key={c} className="flex items-center gap-1 text-11 text-ink-300">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={e => {
                      const next = e.target.checked
                        ? [...appliesTo, c]
                        : appliesTo.filter(x => x !== c)
                      setAppliesTo(next)
                      patch({ appliesTo: next })
                    }}
                  />
                  {c}
                </label>
              )
            })}
          </div>
        </div>
      )}

      {mode === 'edit' && field && (
        <div className="text-11 text-ink-300">
          <span className="text-ink-400">权限</span>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {PERM_LABEL.map(([key, label, title]) => (
              <label key={key} className="flex items-center gap-1" title={title}>
                <input
                  type="checkbox"
                  checked={field.permissions[key]}
                  onChange={e => onPermissions({ [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      {err && <div className="text-11 text-danger">{err}</div>}

      {mode === 'create' && (
        <div className="flex items-center gap-2">
          <Button variant="primary" solid size="md" onClick={submitCreate} className="flex items-center gap-1.5">
            <Save size={12} /> 创建字段
          </Button>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
        </div>
      )}
    </section>
  )
}

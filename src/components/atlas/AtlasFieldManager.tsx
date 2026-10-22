/**
 * 字段设置（3.1.3 · F2）—— 「种族生物 / 物品资源」的自定义字段管理。
 *
 * 依据：方案 §5.2 操作规则。本轮做到：
 *   新增 / 编辑（改名·说明·单位·选项·分组·适用类别·显示与 AI 开关）/ 归档 / 恢复 / 排序。
 *
 * 🔴 本轮**不做**的两件事（都写在方案里，别以为是漏了）：
 *   · 类型原位转换（文本↔长文本也留到后续，§5.2 要求预览与逐条处理超限值）；
 *   · 永久删除（§5.2 要求先出影响数 + 可恢复备份，属 F6 的活）。
 *   因此这里只有「归档」——定义与值都留着，随时能恢复。
 *
 * 🔴 内置字段的**显示名**也在这里改（2026-10-18 主人反馈：表头「字段名」和「字段设置」是同一件事，
 *    不该并排两个按钮）。存储不变：仍写 `fieldAlias`（`{存储键: 显示名}`），
 *    所以 AI 读表的语义、分组归属、已填数据全都不受影响 —— 面板里只改「界面上那几个字」。
 *    其他页签（人物关系 / 历史事件…）没有本面板，仍用表头的「字段名」按钮，两边共用同一份存储。
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Check, Pencil, Plus, RotateCcw, Type, X } from 'lucide-react'
import type { TabDef } from '@/lib/types'
import type { AtlasFieldDefinition, AtlasSchemaConfig, CustomFieldType } from '@/lib/atlas/types'
import { atlasBadgeKeys, atlasCategoryOptions, atlasGroupsOf } from '@/lib/atlas/schema'
import { ATLAS_FIELD_TYPE_LABEL } from '@/lib/atlas/values'
import { newFieldId } from '@/lib/atlas/persistence'
import { MAX_ALIAS_LEN, sanitizeAliases, validateAliasInput, type AliasMap } from '@/lib/settings/fieldAlias'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'

interface Props {
  tab: TabDef
  config: AtlasSchemaConfig
  /** 落库由父组件负责（它持有 projectId 与最新 revision） */
  onSave: (next: AtlasSchemaConfig) => void | Promise<void>
  onClose: () => void
  /** 配置来自更高版本：只读浏览，禁止修改（方案 §8.4） */
  readOnly?: boolean
  /** 内置字段的存储键（＝列名，顺序即列顺序）；给了才显示「内置字段显示名」一块 */
  aliasKeys?: readonly string[]
  /** 当前显示名覆写表（来自 `lib/settings/fieldAlias` 的 `map`） */
  aliases?: AliasMap
  /** 保存显示名；不传 ⇒ 这一块不显示（别的页签本来就没有本面板） */
  onSaveAliases?: (next: AliasMap) => void | Promise<void>
}


/** 输入框统一样式（与表头筛选保持一致的低调风格） */
const INPUT = 'w-full text-12 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50'
const SWITCH_OFF = 'text-ink-500 hover:text-danger'

export default function AtlasFieldManager({
  tab, config, onSave, onClose, readOnly, aliasKeys, aliases, onSaveAliases,
}: Props) {
  const groups = atlasGroupsOf(tab.id, config)
  const categories = atlasCategoryOptions(tab)
  const active = config.fields.filter(f => !f.archived).sort((a, b) => a.order - b.order)
  const archived = config.fields.filter(f => f.archived)

  const [draft, setDraft] = useState<AtlasFieldDefinition | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  /* ---- 内置字段显示名（原表头「字段名」入口） ---- */
  // 复制成可变数组：校验/清洗函数签名收的是 string[]（它们会排序/去空，不该吃 readonly）
  const aliasList = [...(aliasKeys ?? [])]
  const [aliasDraft, setAliasDraft] = useState<AliasMap>(() => ({ ...(aliases ?? {}) }))
  const [aliasErr, setAliasErr] = useState('')
  const [aliasBusy, setAliasBusy] = useState(false)
  const [aliasSaved, setAliasSaved] = useState(false)
  /** 已改名的内置字段数（标题上显示，让作者一眼知道"我动过几个"） */
  const renamedCount = aliasList.filter(k => (aliasDraft[k] ?? '').trim().length > 0).length

  const saveAliasesNow = async () => {
    if (!onSaveAliases) return
    // 逐项过校验（重名 / 过长 / 含换行），跟表头「字段名」弹窗同一套规则
    for (const key of aliasList) {
      const msg = validateAliasInput(aliasList, aliasDraft, key, aliasDraft[key] ?? '')
      if (msg) { setAliasErr(`${key}：${msg}`); return }
    }
    setAliasBusy(true)
    try {
      await onSaveAliases(sanitizeAliases(aliasList, aliasDraft))
      setAliasErr('')
      setAliasSaved(true)
      window.setTimeout(() => setAliasSaved(false), 1800)
    } catch (e) {
      setAliasErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAliasBusy(false)
    }
  }

  const resetAliases = () => {
    // 清空＝全部回默认名（不是"撤销本次编辑"）—— 与表头弹窗的「全部恢复默认」同义
    setAliasDraft({})
    setAliasErr('')
  }

  const blank = (): AtlasFieldDefinition => ({
    id: newFieldId(),
    label: '',
    type: 'text',
    description: '',
    unit: undefined,
    options: [],
    appliesTo: '*',
    groupId: groups[groups.length - 1]?.id ?? 'extra',
    order: active.length * 10,
    tableVisible: true,
    detailVisible: true,
    searchable: true,
    aiReadable: true,
    aiWritable: false,
    archived: false,
  })

  /** 卡片摘要候选：内置列 + 未归档自定义字段（摘要不做类别过滤 —— 它是全表展示口径） */
  /** 徽标字段：摘要里再选它们＝卡片上同一行字出现两次，所以 chip 上标出来 */
  const badgeKeys = atlasBadgeKeys(tab.id)
  const summaryCandidates = useMemo(() => [
    ...(tab.columns ?? []).filter(c => !c.hidden).map(c => ({ key: c.name, label: c.name })),
    ...config.fields
      .filter(f => !f.archived)
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(f => ({ key: f.id, label: f.label })),
  ], [tab.columns, config.fields])

  /** 摘要最多 3 项、按勾选顺序显示；全部取消 = 回到系统默认三项 */
  const toggleSummary = (key: string) => {
    const cur = config.summaryKeys
    const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key].slice(0, 3)
    void commit({ ...config, summaryKeys: next }, { keepDraft: true })
  }

  const commit = async (next: AtlasSchemaConfig, opts?: { keepDraft?: boolean }) => {
    setBusy(true)
    try {
      await onSave(next)
      if (!opts?.keepDraft) {
        setDraft(null)
        setEditingId(null)
      }
      setErr('')
    } catch (e) {
      // 🔴 必须接住（3.1.3 · R06）：写入服务会主动抛错拒写（未来版本 / 读取失败 / 结构损坏），
      //    漏掉这个 catch 就变成未处理 Promise —— 作者点完"保存"什么反馈都没有，
      //    还以为存上了（其实配置一动没动）。
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 数组顺序即展示顺序，写回时统一折算成 order（步长 10，给将来插队留空间） */
  const reorder = (list: AtlasFieldDefinition[]): AtlasSchemaConfig => {
    const orderOf = new Map(list.map((f, i) => [f.id, i * 10]))
    return {
      ...config,
      fields: config.fields.map(f => (orderOf.has(f.id) ? { ...f, order: orderOf.get(f.id)! } : f)),
    }
  }

  const move = (id: string, dir: -1 | 1) => {
    const list = [...active]
    const i = list.findIndex(f => f.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
    void commit(reorder(list))
  }

  const validate = (f: AtlasFieldDefinition): string => {
    const label = f.label.trim()
    if (!label) return '字段名不能为空'
    if (label.length > 20) return '字段名最多 20 个字'
    const dup = active.some(x => x.id !== f.id && x.label.trim() === label)
    if (dup) return `已有同名字段「${label}」`
    if ((f.type === 'select' || f.type === 'multiSelect') && (f.options ?? []).length === 0) {
      return '单选 / 多选字段至少要有一个选项'
    }
    return ''
  }

  const submitDraft = () => {
    if (!draft) return
    const msg = validate(draft)
    if (msg) { setErr(msg); return }
    const clean: AtlasFieldDefinition = {
      ...draft,
      label: draft.label.trim(),
      description: draft.description.trim().slice(0, 500),
      unit: draft.type === 'number' ? (draft.unit ?? '').trim().slice(0, 10) || undefined : undefined,
      options: draft.type === 'select' || draft.type === 'multiSelect'
        ? [...new Set((draft.options ?? []).map(s => s.trim()).filter(Boolean))].slice(0, 50)
        : undefined,
      appliesTo: draft.appliesTo === '*' ? '*' : draft.appliesTo,
    }
    const exists = config.fields.some(f => f.id === clean.id)
    const next: AtlasSchemaConfig = {
      ...config,
      fields: exists ? config.fields.map(f => (f.id === clean.id ? clean : f)) : [...config.fields, clean],
    }
    void commit(next)
  }

  const setArchived = (f: AtlasFieldDefinition, archivedFlag: boolean) => {
    void commit({ ...config, fields: config.fields.map(x => (x.id === f.id ? { ...x, archived: archivedFlag } : x)) })
  }

  const patch = (p: Partial<AtlasFieldDefinition>) => setDraft(d => (d ? { ...d, ...p } : d))

  return (
    <Modal
      open
      onClose={onClose}
      title={`字段设置 · ${tab.name}`}
      width="lg"
      maxHeight="82vh"
      footer={
        <Button variant="secondary" onClick={onClose}>关闭</Button>
      }
    >
      <div className="space-y-4">
        <p className="text-11 text-ink-400 leading-relaxed">
          自定义字段会同时出现在<strong className="text-ink-200">表格</strong>（追加在右侧列）和
          <strong className="text-ink-200">图鉴卡片 / 详情</strong>里；字段名的显示与存储分离 ——
          改名不会动已填的内容。
          <br />
          内置字段（{tab.columns?.length ?? 0} 个）沿用原表格定义，
          <strong className="text-ink-200">不在这里增删</strong>；想给它们换个看得懂的名字，
          用下方「内置字段显示名」。
        </p>

        {readOnly && (
          <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-11 text-amber/90">
            这份字段配置来自更新版本的软件，本版只做只读展示 —— 为避免写坏结构，暂不允许修改。
          </div>
        )}

        {/* 自定义字段列表 */}
        <section className="space-y-2">
          <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2">
            <span className="w-1 h-3.5 bg-amber rounded-full" />
            自定义字段（{active.length}）
          </h3>
          {active.length === 0 ? (
            <div className="rounded-lg border border-dashed border-ink-700 px-3 py-6 text-center text-11 text-ink-500">
              还没有自定义字段。点下面的「新增字段」给这一页加一个专属栏目（例如给魔兽加「食性」、给丹药加「副作用」）。
            </div>
          ) : (
            <ul className="space-y-1.5">
              {active.map((f, i) => (
                <li key={f.id} className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-13 text-ink-100 truncate">{f.label}</span>
                      <span className="shrink-0 text-10 px-1.5 py-0.5 rounded bg-ink-900 border border-ink-700 text-ink-400">
                        {ATLAS_FIELD_TYPE_LABEL[f.type]}
                      </span>
                      <span className="shrink-0 text-10 text-ink-500">
                        {groups.find(g => g.id === f.groupId)?.label ?? '补充资料'}
                      </span>
                      {/* 隐藏但 AI 可写：列表里就该看得见，不能等点进编辑才知道（3.1.3 · R12） */}
                      {!f.tableVisible && f.aiWritable && (
                        <span
                          className="shrink-0 text-10 px-1.5 py-0.5 rounded bg-amber/15 border border-amber/30 text-amber"
                          title="表格里看不见这一栏，但 AI 仍会往里写 —— 值只出现在详情与检索里"
                        >
                          隐藏 · AI 会写
                        </span>
                      )}
                    </div>
                    {f.description && (
                      <div className="mt-0.5 text-10 text-ink-500 truncate" title={f.description}>{f.description}</div>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="shrink-0 flex items-center gap-0.5">
                      <Button variant="bare" iconOnly size="xs" onClick={() => move(f.id, -1)} disabled={i === 0 || busy} title="上移">
                        <ArrowUp size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs" onClick={() => move(f.id, 1)} disabled={i === active.length - 1 || busy} title="下移">
                        <ArrowDown size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs" onClick={() => { setDraft({ ...f }); setEditingId(f.id); setErr('') }} title="编辑">
                        <Pencil size={12} />
                      </Button>
                      <Button variant="bare" iconOnly size="xs" className={SWITCH_OFF} onClick={() => setArchived(f, true)} disabled={busy} title="归档：字段与已填内容都保留，只是不再显示">
                        <Archive size={12} />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 新建 / 编辑表单 */}
        {!readOnly && (
          draft ? (
            <section className="rounded-xl border border-amber/30 bg-amber/5 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-12 font-semibold text-ink-100">
                  {editingId ? `编辑字段 · ${draft.label || '未命名'}` : '新增字段'}
                </h3>
                <Button variant="bare" iconOnly size="xs" onClick={() => { setDraft(null); setEditingId(null); setErr('') }} title="取消">
                  <X size={13} />
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-11 text-ink-400">字段名（≤20 字）</span>
                  <input className={`mt-1 ${INPUT}`} value={draft.label} maxLength={20}
                    placeholder="例如：食性" onChange={e => patch({ label: e.target.value })} />
                </label>
                <label className="block">
                  <span className="text-11 text-ink-400">类型{editingId ? '（建立后不可改）' : ''}</span>
                  <select className={`mt-1 ${INPUT}`} value={draft.type} disabled={!!editingId}
                    onChange={e => patch({ type: e.target.value as CustomFieldType })}>
                    {(Object.keys(ATLAS_FIELD_TYPE_LABEL) as CustomFieldType[]).map(t => (
                      <option key={t} value={t}>{ATLAS_FIELD_TYPE_LABEL[t]}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-11 text-ink-400">所属分组</span>
                  <select className={`mt-1 ${INPUT}`} value={draft.groupId} onChange={e => patch({ groupId: e.target.value })}>
                    {groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </label>
                {draft.type === 'number' && (
                  <label className="block">
                    <span className="text-11 text-ink-400">单位（如「年」「里」）</span>
                    <input className={`mt-1 ${INPUT}`} value={draft.unit ?? ''} maxLength={10}
                      onChange={e => patch({ unit: e.target.value })} />
                  </label>
                )}
              </div>

              <label className="block">
                <span className="text-11 text-ink-400">说明（给人看，也给 AI 看；≤500 字）</span>
                <textarea className={`mt-1 ${INPUT} h-16 resize-none`} value={draft.description} maxLength={500}
                  placeholder="这个字段要填什么、有什么限制……"
                  onChange={e => patch({ description: e.target.value })} />
              </label>

              {(draft.type === 'select' || draft.type === 'multiSelect') && (
                <label className="block">
                  <span className="text-11 text-ink-400">选项（一行一个，最多 50 项）</span>
                  <textarea
                    className={`mt-1 ${INPUT} h-20 resize-none`}
                    value={(draft.options ?? []).join('\n')}
                    placeholder={'肉食\n草食\n杂食'}
                    onChange={e => patch({ options: e.target.value.split('\n') })}
                  />
                </label>
              )}

              {categories.length > 0 && (
                <div>
                  <span className="text-11 text-ink-400">适用类别</span>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-11 text-ink-300">
                      <input type="checkbox" checked={draft.appliesTo === '*'}
                        onChange={e => patch({ appliesTo: e.target.checked ? '*' : [] })} />
                      不限类别
                    </label>
                    {draft.appliesTo !== '*' && categories.map(c => {
                      const list = draft.appliesTo as string[]
                      const on = list.includes(c)
                      return (
                        <label key={c} className="flex items-center gap-1 text-11 text-ink-300">
                          <input type="checkbox" checked={on} onChange={e => {
                            const next = e.target.checked ? [...list, c] : list.filter(x => x !== c)
                            patch({ appliesTo: next })
                          }} />
                          {c}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {([
                  ['tableVisible', '表格里显示'],
                  ['detailVisible', '详情里显示'],
                  ['searchable', '可被搜索'],
                  ['aiReadable', '允许 AI 参考'],
                  ['aiWritable', '允许 AI 填写'],
                ] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1 text-11 text-ink-300">
                    <input type="checkbox" checked={draft[k]} onChange={e => patch({ [k]: e.target.checked } as Partial<AtlasFieldDefinition>)} />
                    {label}
                  </label>
                ))}
              </div>

              {/* 🔴 3.1.3 · R12（主人 2026-10-19 拍板「按推荐优化」）：
                  两个开关**保持独立**（隐藏 ≠ 禁写，否则会改动作者已有的配置语义），
                  但「看不见的栏位被 AI 悄悄写」必须说出来 —— 否则作者在表格里找不到值，
                  会以为 AI 编造了内容。这里只在真的会发生时提示，平时不占版面。 */}
              {!draft.tableVisible && draft.aiWritable && (
                <p className="rounded-lg border border-amber/30 bg-amber/5 px-2.5 py-1.5 text-10 text-amber/90 leading-relaxed">
                  这一栏在表格里看不见，但 AI 仍会往里写 —— 值会出现在详情与检索里，表格中却查不到。
                  想彻底挡住 AI，请同时关掉「允许 AI 填写」。
                </p>
              )}

              {err && <div className="text-11 text-danger">{err}</div>}

              <div className="flex items-center gap-2">
                <Button variant="primary" solid size="md" onClick={submitDraft} disabled={busy}>
                  {editingId ? '保存修改' : '创建字段'}
                </Button>
                <Button variant="secondary" size="md" onClick={() => { setDraft(null); setEditingId(null); setErr('') }}>
                  取消
                </Button>
              </div>
            </section>
          ) : (
            <Button variant="secondary" size="md" onClick={() => { setDraft(blank()); setEditingId(null); setErr('') }} className="flex items-center gap-1.5">
              <Plus size={13} /> 新增字段
            </Button>
          )
        )}

        {/* 内置字段显示名（2026-10-18 合并：原来是表头另一个「字段名」按钮，两件事挤在一行） */}
        {onSaveAliases && aliasList.length > 0 && (
          <section className="space-y-2">
            <details>
              <summary className="flex items-center gap-2 text-12 font-semibold text-ink-200 cursor-pointer select-none">
                <span className="w-1 h-3.5 bg-amber rounded-full" />
                <Type size={12} className="text-ink-400" />
                内置字段显示名
                <span className="text-10 font-normal text-ink-500">
                  {renamedCount > 0 ? `${renamedCount} 个已改名` : '未改名'} · 只改界面上的字
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                <p className="text-10 text-ink-500 leading-relaxed">
                  留空＝用原字段名。AI 读表仍按<b>原字段名</b>理解这一列，
                  改名不动已填内容、不动分组、不动存储键。
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {aliasList.map(key => (
                    <label key={key} className="flex items-center gap-2 min-w-0">
                      <span className="text-11 text-ink-500 w-28 shrink-0 truncate" title={key}>{key}</span>
                      <input
                        value={aliasDraft[key] ?? ''}
                        placeholder={key}
                        maxLength={MAX_ALIAS_LEN}
                        disabled={!!readOnly}
                        onChange={e => setAliasDraft(d => ({ ...d, [key]: e.target.value }))}
                        className={INPUT}
                      />
                    </label>
                  ))}
                </div>
                {aliasErr && <div className="text-11 text-danger">{aliasErr}</div>}
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="md" onClick={() => void saveAliasesNow()} disabled={!!readOnly || aliasBusy}>
                    <Check size={12} /> {aliasBusy ? '保存中…' : '保存显示名'}
                  </Button>
                  <Button variant="secondary" size="md" onClick={resetAliases} disabled={!!readOnly}>
                    <RotateCcw size={12} /> 全部恢复默认
                  </Button>
                  {aliasSaved && <span className="text-11 text-success">已保存</span>}
                </div>
              </div>
            </details>
          </section>
        )}

        {/* 卡片摘要（方案 §3.2 必交付项）：最多 3 项，按勾选顺序；全不勾＝系统默认 */}
        <section className="space-y-2">
          <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2">
            <span className="w-1 h-3.5 bg-amber rounded-full" />
            卡片摘要（{config.summaryKeys.length} / 3）
            {config.summaryKeys.length > 0 && !readOnly && (
              <Button
                variant="bare"
                size="xs"
                className="ml-auto text-10 text-ink-400 hover:text-amber"
                onClick={() => void commit({ ...config, summaryKeys: [] }, { keepDraft: true })}
                title="清空后回到系统默认三项"
              >
                恢复默认
              </Button>
            )}
          </h3>
          <p className="text-10 text-ink-500 leading-relaxed">
            图鉴卡片在「名称 + 类别」徽标下方，最多再显示 3 项；按勾选顺序排列。
            一个都不勾 = 用系统默认（各页签的默认三项都
            <strong className="text-ink-300">避开了徽标已显示的字段</strong>，不会重复）。
            标着「徽标」的字段已经在卡片上显示过，通常不必再选。
          </p>
          <div className="flex flex-wrap gap-1.5">
            {summaryCandidates.map(c => {
              const idx = config.summaryKeys.indexOf(c.key)
              const checked = idx >= 0
              const disabled = !!readOnly || (!checked && config.summaryKeys.length >= 3)
              return (
                <label
                  key={c.key}
                  title={disabled && !checked ? '最多 3 项 —— 先取消一个，或点右上「恢复默认」清空' : c.label}
                  className={`flex items-center gap-1 text-11 px-2 py-1 rounded-lg border transition-colors ${
                    checked
                      ? 'border-amber/40 bg-amber/10 text-amber'
                      : 'border-ink-700 bg-ink-800/60 text-ink-300'
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-ink-600'}`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleSummary(c.key)}
                  />
                  {checked && <span className="text-10 text-amber/80">{idx + 1}</span>}
                  {c.label}
                  {badgeKeys.includes(c.key) && !checked && (
                    <span className="text-9 text-ink-600" title="这一项已经在卡片名称下方作为徽标显示">徽标</span>
                  )}
                </label>
              )
            })}
          </div>
        </section>

        {/* 归档区 */}
        {archived.length > 0 && (
          <details className="rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2">
            <summary className="text-11 text-ink-400 cursor-pointer">已归档（{archived.length}）· 内容都还在，可随时恢复</summary>
            <ul className="mt-2 space-y-1.5">
              {archived.map(f => (
                <li key={f.id} className="flex items-center gap-2 text-12 text-ink-400">
                  <span className="truncate">{f.label}</span>
                  <span className="text-10 text-ink-600">{ATLAS_FIELD_TYPE_LABEL[f.type]}</span>
                  {!readOnly && (
                    <Button variant="bare" size="xs" onClick={() => setArchived(f, false)} disabled={busy}
                      className="ml-auto flex items-center gap-1 text-ink-400 hover:text-amber">
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

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { TabDef, CardRecord } from '../lib/types'
import { SABC_LABELS, CARD_TABLE_REF_FIELDS } from '../lib/schema'
import { getCardRecords, saveCardRecord, deleteCardRecord, getCurrentProjectId } from '../lib/db'
import { uid } from '../lib/id'
import { Plus, Trash2, UserRound, Info, Save, Check, Sparkles, EyeOff } from 'lucide-react'
import HelpPopover from './HelpPopover'
import AutoTextarea from './AutoTextarea'
import TableRefSelect from './TableRefSelect'
import AITemplateFill from './AITemplateFill'
import PromptModal from './PromptModal'
import { confirmDialog } from './dialogs'
import type { TemplateField } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT, aiCapabilityOf } from '../lib/aiScope'
import { Button } from './Button'
import { SaveFab } from './SaveFab'
import { LoadingState } from './LoadingState'

/** 角色卡中以「下拉」形式填写的字段（与设定检索 CARD_SELECT_FIELDS 对应）：value 为存储值，label 为展示文案 */
const CARD_SELECT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  '人物状态': [
    { value: '未登场', label: '未登场' },
    { value: '已登场', label: '已登场' },
    { value: '已退场', label: '已退场' },
  ],
  '保密等级': Object.entries(SABC_LABELS).map(([value, label]) => ({ value, label })),
}

interface Props {
  tab: TabDef
}

export default function CharacterSheet({ tab }: Props) {
  const [records, setRecords] = useState<CardRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // 当前编辑中的本地副本（dirty 状态）
  const [draft, setDraft] = useState<CardRecord | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  // AI 补全设定弹窗
  const [showFill, setShowFill] = useState(false)
  // 筛选：开启后隐藏「人物状态 = 已退场」的角色，避免角色过多时难以定位
  const [hideRetired, setHideRetired] = useState(false)
  const statusOf = (rec: CardRecord) => {
    const k = Object.keys(rec.data).find(kk => kk.endsWith('::人物状态'))
    return k ? (rec.data[k] || '').trim() : ''
  }
  const visibleRecords = hideRetired ? records.filter(r => statusOf(r) !== '已退场') : records
  const cardFields = useMemo<TemplateField[]>(
    () => (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
    }))),
    [tab.id],
  )

  // AI 入口：本页签适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()

  // 用 ref 持有最新状态，避免切换页签时因 effect 闭包过期而丢失未保存草稿
  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const tabIdRef = useRef(tab.id)
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => { draftRef.current = draft }, [draft])

  useEffect(() => {
    // 切到别的页签前，先把当前角色卡未保存的修改落库（之前会静默丢弃）
    if (dirtyRef.current && draftRef.current) {
      void saveCardRecord(draftRef.current)
    }
    tabIdRef.current = tab.id
    getCardRecords(tab.id).then(r => {
      setRecords(r)
      if (r.length > 0) {
        setActiveId(r[0].id)
        setDraft(r[0])
      } else {
        setActiveId(null)
        setDraft(null)
      }
      setLoaded(true)
    })
  }, [tab.id])

  // 切换 active（同一页签内不同角色卡）时刷新 draft；切换前先落盘上一卡未保存的修改，避免静默丢稿
  useEffect(() => {
    const prev = prevActiveRef.current
    // 仅当「确实切到了另一张仍存在的卡」才存旧卡草稿；因删除导致的切换不存档（避免复活已删卡）
    if (prev && prev !== activeId && dirtyRef.current && draftRef.current && records.some(r => r.id === prev)) {
      void saveCardRecord(draftRef.current)
    }
    prevActiveRef.current = activeId
    if (!activeId) { setDraft(null); return }
    // 关键守卫：activeId 未变、但 records 因「其它卡增删改」而变化时，若当前草稿有未保存编辑，
    // 绝不能用库里的旧记录回灌覆盖 —— 否则用户改了半天、去删另一张卡，编辑内容就静默蒸发了。
    // （draftRef/dirtyRef 的同步 effect 声明在下方，此处读到的是上一轮渲染的值，正是我们想要的「切换前」状态）
    if (draftRef.current?.id === activeId && dirtyRef.current) return
    const rec = records.find(r => r.id === activeId)
    setDraft(rec ? { ...rec, data: { ...rec.data } } : null)
  }, [activeId, records])

  // v1.6：新增/改名走应用内 PromptModal（浏览器 prompt 在 Electron 桌面端无实现、点击无反应）
  const [namePrompt, setNamePrompt] = useState<null | { kind: 'add' | 'rename'; def?: string }>(null)

  const addCard = () => setNamePrompt({ kind: 'add' })

  // AI 补全：草图 → 模型补全全部字段 → 直接建卡（key 即 `模块::字段`，与渲染一致）
  const handleFill = async (values: Record<string, string>) => {
    const nameKey = Object.keys(values).find(k => k.endsWith('::姓名'))
    const name = (nameKey ? values[nameKey] : '')?.trim() || '未命名角色'
    const rec: CardRecord = {
      id: uid(),
      projectId: getCurrentProjectId(),
      tabId: tab.id,
      name,
      data: { ...values },
      order: records.length,
    }
    await saveCardRecord(rec)
    setRecords([...records, rec])
    setActiveId(rec.id)
    setDraft(rec)
    setShowFill(false)
  }

  const submitNamePrompt = async (v: string) => {
    const p = namePrompt
    setNamePrompt(null)
    if (!v || !p) return
    if (p.kind === 'add') {
      const rec: CardRecord = { id: uid(), projectId: getCurrentProjectId(), tabId: tab.id, name: v, data: {}, order: records.length }
      await saveCardRecord(rec)
      setRecords([...records, rec])
      setActiveId(rec.id)
      setDraft(rec)
    } else {
      if (!draft || v === draft.name) return
      setDraft({ ...draft, name: v })
    }
  }

  const renameCard = () => {
    if (draft) setNamePrompt({ kind: 'rename', def: draft.name })
  }

  const removeCard = async (id: string) => {
    const rec = records.find(r => r.id === id)
    if (!rec) return
    if (!await confirmDialog({ title: '删除角色卡', message: `确定删除「${rec.name}」的角色卡？`, danger: true })) return
    await deleteCardRecord(id)
    const next = records.filter(r => r.id !== id)
    setRecords(next)
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null)
    }
  }

  const updateField = (path: string, value: string) => {
    if (!draft) return
    setDraft({ ...draft, data: { ...draft.data, [path]: value } })
    setSaved(false)
  }

  // memo 化：避免每次渲染都对 draft 与源记录做两次完整 JSON 序列化
  const dirty = useMemo(
    () => !!draft && JSON.stringify(draft) !== JSON.stringify(records.find(r => r.id === draft.id)),
    [draft, records]
  )

  // dirty 在上方 memo 声明；dirtyRef 已在组件顶部声明，这里只做同步
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  const save = useCallback(async () => {
    if (!draft || !dirty) return
    setSaving(true)
    await saveCardRecord(draft)
    setRecords(records.map(r => (r.id === draft.id ? draft : r)))
    setSaving(false)
    setSaved(true)
    savedTimer.current = setTimeout(() => setSaved(false), 1500)
  }, [draft, dirty, records])

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, save])

  if (!loaded) return <LoadingState />

  return (
    <div className="page-enter">
      <header className="mb-5 flex items-start justify-between gap-4 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
            <HelpPopover title={`${tab.name} · 怎么填`} width="22rem" size={13}>{`这是「${tab.name}」角色卡，按模块填写人物设定：

• 左侧列表切换 / 新建 / 删除角色；点击上方姓名可直接改名（保存后生效）。
• 右侧按模块（基础信息、外貌、性格……）分栏填写，长文会自动撑高输入框。
• 「人物状态」用下拉选择：未登场 / 已登场 / 已退场，便于统计登场进度。
• 字段带「示例」时可参考填法；修改后点右上「保存」或按 Ctrl+S。
• 右上「隐藏已退场」开关：开启后列表与统计隐藏「人物状态 = 已退场」的角色，角色过多时方便聚焦。`}</HelpPopover>
          </div>
          <p className="mt-1.5 text-[13px] text-ink-300 leading-relaxed max-w-3xl">{tab.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[11px] transition-opacity ${saved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>
            <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
          </span>
          <Button variant="toggle" selected={dirty}
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium hover:bg-amber/25"
            title={dirty ? '保存（Ctrl+S）' : '无未保存修改'}
          >
            <Save size={12} /> {saving ? '保存中…' : (dirty ? '保存' : '已保存')}
          </Button>
          <Button onClick={addCard} variant="primary" size="md" className="flex items-center text-[13px]">
            <Plus size={14} /> 新建角色
          </Button>
          {aiCap !== 'none' && (
            <Button variant="secondary" onClick={() => setShowFill(true)} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '提供粗略设定，让 AI 补全角色卡其余字段'}>
              <Sparkles size={14} /> AI 补全
            </Button>
          )}
          <Button variant="toggle" selected={hideRetired}
            onClick={() => setHideRetired(v => !v)}
            className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium hover:bg-amber/25"
            title="隐藏「人物状态 = 已退场」的角色，避免列表过长"
          >
            <EyeOff size={14} /> 隐藏已退场
          </Button>
        </div>
      </header>

      <div className="flex gap-5" style={{ minHeight: 'calc(100vh / var(--ui-zoom, 1) - 180px)' }}>
        {/* 角色列表 */}
        <div className="w-44 shrink-0 space-y-1.5">
          {visibleRecords.map(rec => {
            const isActive = activeId === rec.id
            const isDirty = isActive && dirty
            return (
              <div
                key={rec.id}
                onClick={() => setActiveId(rec.id)}
                className={`group cursor-pointer rounded-lg border px-3 py-2.5 transition-all duration-150
                  ${isActive
                    ? 'bg-amber/10 border-amber/30 text-amber'
                    : 'bg-ink-850 border-ink-700 text-ink-300 hover:border-ink-500'}`}
              >
                <div className="flex items-center gap-2">
                  <UserRound size={13} className="shrink-0" />
                  <span className="text-[13px] font-medium truncate flex-1">{rec.name}</span>
                  {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title="有未保存修改" />}
                  <Button variant="icon-danger" onClick={e => { e.stopPropagation(); removeCard(rec.id) }} className="opacity-40 group-hover:opacity-100 transition-all">
                    <Trash2 size={12} />
                  </Button>
                </div>
                <div className="text-[10px] text-ink-500 mt-0.5 truncate">
                  {Object.values(rec.data).find(v => v) || '未填写'}
                </div>
              </div>
            )
          })}
          {visibleRecords.length === 0 && (
            <div className="text-center text-ink-500 text-[12px] py-12 border border-dashed border-ink-700 rounded-lg">
              {records.length === 0 ? '点击右上角新建角色' : '已退场的角色已隐藏'}
            </div>
          )}
        </div>

        {/* 编辑区 */}
        <div className="flex-1 min-w-0">
          {draft ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <h2
                  className="text-lg font-bold text-amber cursor-pointer hover:text-amber-soft"
                  onClick={renameCard}
                  title="点击改名（保存后生效）"
                >
                  {draft.name}
                </h2>
                <span className="text-[10px] text-ink-500">点击姓名可改名 · 修改后点「保存」</span>
              </div>
              {tab.modules!.map(mod => (
                <section key={mod.name} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
                  <div className="px-4 py-2.5 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
                    <span className="w-1 h-3 rounded-full bg-amber/70" />
                    <h3 className="text-[12px] font-semibold text-ink-100">{mod.name}</h3>
                  </div>
                  <div className="divide-y divide-ink-700/60">
                    {mod.fields.map(field => {
                      const key = `${mod.name}::${field.name}`
                      const val = draft.data[key] ?? ''
                      return (
                        <div key={key} className="px-4 py-3 grid grid-cols-[140px_1fr] gap-3 hover:bg-ink-800/40 transition-colors">
                          <div>
                            <div className="text-[12px] font-medium text-ink-100">{field.name}</div>
                            {field.desc && <div className="field-desc mt-0.5">{field.desc}</div>}
                          </div>
                          <div>
                            {/* 所属势力 / 种族 等字段：从其他设定表取值，禁止手动输入（根治同名异写导致的归属错乱） */}
                            {CARD_TABLE_REF_FIELDS[field.name] ? (
                              <TableRefSelect
                                value={val}
                                onChange={v => updateField(key, v)}
                                refTabId={CARD_TABLE_REF_FIELDS[field.name].tabId}
                                refCol={CARD_TABLE_REF_FIELDS[field.name].col}
                                placeholder={`选择${field.name}`}
                              />
                            ) : CARD_SELECT_OPTIONS[field.name] ? (
                              <select
                                value={val}
                                onChange={e => updateField(key, e.target.value)}
                                className="w-full text-[12px] bg-ink-800 border border-ink-700 rounded px-2 py-1"
                              >
                                {CARD_SELECT_OPTIONS[field.name].map(o => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            ) : (
                              <AutoTextarea
                                value={val}
                                onChange={v => updateField(key, v)}
                                placeholder="点击填写…"
                                className="text-[12px]"
                                minHeight={32}
                              />
                            )}
                            {!val && field.example && (
                              <div className="field-example flex items-start gap-1 mt-0.5">
                                <Info size={10} className="mt-0.5 shrink-0" />
                                <span>示例：{field.example}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-ink-500 text-sm border border-dashed border-ink-700 rounded-xl">
              选择左侧角色或新建一个
            </div>
          )}
        </div>
      </div>

      {tab.tips && tab.tips.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber/20 bg-amber/5 p-4 space-y-1.5">
          {tab.tips.map((tip, i) => (
            <div key={i} className="text-[12px] text-amber/80 leading-relaxed flex items-start gap-2">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      )}

      {/* 浮动保存按钮 */}
      {dirty && <SaveFab onClick={save} label={`保存「${draft?.name}」修改`} />}

      {showFill && (
        <AITemplateFill
          fields={cardFields}
          title={`AI 补全 · ${tab.name}`}
          sketchPlaceholder="例如：一个叫叶昭的少年，是没落剑派最后一名弟子，性格倔强但重情义，想复兴门派……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}

      {/* v1.6：应用内输入弹窗（替代浏览器 prompt，桌面端可用） */}
      <PromptModal
        open={!!namePrompt}
        title={namePrompt?.kind === 'rename' ? '修改角色姓名' : '新建角色'}
        label={namePrompt?.kind === 'rename' ? '修改后点「保存」生效' : undefined}
        defaultValue={namePrompt?.def ?? ''}
        placeholder="请输入角色姓名"
        onSubmit={submitNamePrompt}
        onCancel={() => setNamePrompt(null)}
      />
    </div>
  )
}

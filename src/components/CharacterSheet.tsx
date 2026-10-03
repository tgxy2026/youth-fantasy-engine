import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { UNSAVED_CHANGES_HINT } from '../lib/constants'
import { Z } from '../lib/zLayer'
import type { TabDef, CardRecord } from '../lib/types'
import { SABC_LABELS, CARD_TABLE_REF_FIELDS } from '../lib/schema'
import { getCardRecords, saveCardRecord, deleteCardRecord, getCurrentProjectId } from '../lib/db'
import { clearFreeDraft } from '../lib/freeDraft'
import { uid } from '../lib/id'
import { Plus, Trash2, UserRound, Info, Save, Check, Sparkles, EyeOff, ImagePlus, X, Loader2, Wand2 } from 'lucide-react'
import { readPortraitFile, dataUrlBytes, PORTRAIT_ACCEPT } from '../lib/imagePortrait'
import { PORTRAIT_HINT_SPEC } from '../lib/portraitSpec'
import HelpPopover from './HelpPopover'
import AutoTextarea from './AutoTextarea'
import TableRefSelect from './TableRefSelect'
import AITemplateFill from './AITemplateFill'
import PromptModal from './PromptModal'
import { confirmDialog, showToast } from './dialogs'
import type { TemplateField } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { useSaveHotkey } from '../lib/useSaveHotkey'
import FieldAliasButton, { moduleAliasTargets } from './FieldAliasButton'
import { useFieldAliases } from '../lib/fieldAlias'
import { contentMinH, CARD_SHEET_CHROME_PX } from '../lib/theme'
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

/**
 * 长文本字段**不封顶**的卡片页签（单一判据）：名单内的页签，其文本字段随内容一路长高、
 * 永不出现内部滚动条（AutoTextarea 传 maxHeight=0）；不在名单内的仍走默认 360px 封顶。
 * 「其他设定」是兜底页、一条卡就是一段长短不一的设定说明，写多长都该完整摊开（2026-09-25 社区反馈）。
 * 🔴 新页签想要同样手感 → **只往这个 Set 加 tab.id**，别在渲染处加 if。
 */
const UNBOUNDED_CARD_TABS = new Set(['misc-settings'])

interface Props {
  tab: TabDef
  /**
   * 从别处（如酒馆「推演报告」里的定位链接）跳过来时，要**直接打开的那条记录**。
   * 🔴 审计 P1-5：card 类页签以前收不到这个参数 —— 报告里指向角色卡的问题，
   *    点进来只是切了个页签、什么都不选中，作者会以为那个链接是坏的。
   */
  focusRowId?: string | null
  onFocusConsumed?: () => void
}

export default function CharacterSheet({ tab, focusRowId, onFocusConsumed }: Props) {
  const [records, setRecords] = useState<CardRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // 当前编辑中的本地副本（dirty 状态）
  const [draft, setDraft] = useState<CardRecord | null>(null)
  const [saved, setSaved] = useState(false)
  /** B7：立绘压缩中（压缩是异步的，要防重复点击） */
  const [portraitBusy, setPortraitBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  // AI 新增弹窗（原「AI 补全」，2026-10-03 改名 —— 它实际是凭空建一张新卡）
  const [showFill, setShowFill] = useState(false)
  // AI 补全弹窗（在**当前这张卡**上补空白字段，已填的保留）
  const [showFillExisting, setShowFillExisting] = useState(false)
  // 筛选：开启后隐藏「人物状态 = 已退场」的角色，避免角色过多时难以定位
  const [hideRetired, setHideRetired] = useState(false)
  /** 字段显示名（2.7.3）：只改界面上这行字，取值仍走「模块名::字段名」存储键 */
  const aliasTargets = useMemo(() => moduleAliasTargets(tab.modules), [tab])
  const { labels: aliasLabels } = useFieldAliases(
    tab.id,
    useMemo(() => aliasTargets.map(t => t.key), [aliasTargets]),
  )
  const statusOf = (rec: CardRecord) => {
    const k = Object.keys(rec.data).find(kk => kk.endsWith('::人物状态'))
    return k ? (rec.data[k] || '').trim() : ''
  }
  /**
   * 卡片单位名词 —— CharacterSheet 从 1.x 起只服务角色卡，文案里写死了「角色」；
   * 2.3.0 新增「其他设定」（世界构建组）后同一个组件也服务非角色卡片表，
   * 于是「新建角色 / 删除角色卡 / 已退场的角色」全成了错话（老大实测发现）。
   * 这里照 OutlineSheet 的范式（`const noun = isVolume ? '分卷' : '章节'`）参数化。
   * 🔴 术语用「设定」而不是「条目」：卡里装的确实是一条条设定（如「灵力潮汐周期」）。
   */
  const isCharTab = tab.group === '角色管理'
  const noun = isCharTab ? '角色' : '设定'
  const nounCard = isCharTab ? '角色卡' : '设定'
  const visibleRecords = hideRetired ? records.filter(r => statusOf(r) !== '已退场') : records
  const cardFields = useMemo<TemplateField[]>(
    () => (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
    }))),
    // 🔴 这里读的是 tab.modules，依赖就必须锚在 tab 本身。
    //    只写 tab.id 时，同一页签的字段结构被改动（如项目形态/自定义页签重算 schema）
    //    不会重算，AI 补全弹窗会继续用旧字段表。
    [tab],
  )

  // AI 入口：本页签适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()

  // 定位到指定记录（报告跳转）：records 到位后选中它，并回报"已消费"。
  // 不写进加载流程里，是因为 focusRowId 可能在组件已经挂载后才变化（同一页签二次跳转）。
  useEffect(() => {
    if (!focusRowId) return
    if (!records.some(r => r.id === focusRowId)) return
    setActiveId(focusRowId)
    onFocusConsumed?.()
  }, [focusRowId, records, onFocusConsumed])

  // 用 ref 持有最新状态，避免切换页签时因 effect 闭包过期而丢失未保存草稿
  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const tabIdRef = useRef(tab.id)
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => { draftRef.current = draft }, [draft])

  /**
   * 🔴 卸载时冲刷未保存的卡片修改。原因同 TableSheet：`App.tsx` 的「key={tab.id}」
   * 会让下面那个 [tab.id] 守卫在重挂后失效（dirtyRef 初值为 false）。
   * 注意：同页签内切卡（activeId 变化）不会重挂，那条守卫仍然有效，与此条互补。
   */
  useEffect(() => () => {
    if (dirtyRef.current && draftRef.current) void saveCardRecord(draftRef.current)
  }, [])

  useEffect(() => {
    // 切到别的页签前，先把当前卡片未保存的修改落库（之前会静默丢弃）
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

  // 切换 active（同一页签内不同卡片）时刷新 draft；切换前先落盘上一卡未保存的修改，避免静默丢稿
  useEffect(() => {
    const prev = prevActiveRef.current
    // 仅当「确实切到了另一张仍存在的卡」才存旧卡草稿；因删除导致的切换不存档（避免复活已删卡）
    if (prev && prev !== activeId && dirtyRef.current && draftRef.current && records.some(r => r.id === prev)) {
      const done = draftRef.current
      void saveCardRecord(done)
      // 🔴 落库后必须同步刷新内存 records：否则切回来时用**库里的旧记录**回灌，
      //    刚保存的编辑在界面上又消失（数据其实已入库，但用户看到的是「白改了」，
      //    且此后 dirty 归零，再改一处保存就会把它覆盖回去）。2026-09-18 实机抓到：
      //    「切走再切回值回退、但刷新后值又在」——这个组合特征正是内存副本过期。
      setRecords(list => list.map(r => (r.id === done.id ? done : r)))
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

  // AI 新增：草图 → 模型补全全部字段 → 直接建卡（key 即 `模块::字段`，与渲染一致）
  const handleFill = async (values: Record<string, string>) => {
    const nameKey = Object.keys(values).find(k => k.endsWith('::姓名'))
    const name = (nameKey ? values[nameKey] : '')?.trim() || `未命名${noun}`
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

  /**
   * AI 补全（已有卡）：只补**当前这张卡**未填的字段，已填的保留 —— 与 FormSheet / 表格行同一口径。
   * 🔴 与 handleFill 的区别：那个是「AI 新增」（凭空建一张新卡），这个是「AI 补全」（在已有卡上补空白）。
   * 采用后只写回 draft（不落库），由作者核对后点保存；dirty 是 draft 与库中记录的比对，会自动亮起。
   */
  const handleFillExisting = (values: Record<string, string>) => {
    if (!draft) return
    const next = { ...draft, data: { ...draft.data } }
    for (const [k, v] of Object.entries(values)) if (v && v.trim()) next.data[k] = v
    setDraft(next)
    setShowFillExisting(false)
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
    if (!await confirmDialog({ title: `删除${nounCard}`, message: `确定删除「${rec.name}」的${nounCard}？`, danger: true })) return
    // 🔴 2.4.4 六维审计：草稿本按「记录 id」存（card::页签::记录id），卡删了草稿必须跟着走，
    //    否则孤儿草稿永久留在 settingsKV 里并随备份 / 云同步搬运
    void clearFreeDraft(`card::${tab.id}::${id}`)
    await deleteCardRecord(id)
    const next = records.filter(r => r.id !== id)
    setRecords(next)
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null)
    }
  }

  /**
   * 🔴 B7（2.4.1）：角色立绘 —— **两个位**（`portrait` / `portrait2`）。
   * 「两张」的由来（2026-09-22 老大）：右侧竖着一整列，只放一张时下边空着一块；
   * 与其留白，不如再给一个位（正装 / 便装、或两个姿态）并排铺满。
   * 走 `dirty`（整对象 JSON 比对）自动变"未保存"，无需额外标记。
   * `undefined` = 删除该位立绘（字段可选，删了就回到"没传"的状态）。
   */
  const updatePortrait = async (file: File | null, slot: 1 | 2 = 1) => {
    if (!file) {
      setDraft(d => (d ? (slot === 2 ? { ...d, portrait2: undefined } : { ...d, portrait: undefined }) : d))
      return
    }
    setPortraitBusy(true)
    try {
      const r = await readPortraitFile(file)
      setDraft(d => (d ? (slot === 2 ? { ...d, portrait2: r.dataUrl } : { ...d, portrait: r.dataUrl }) : d))
      const who = slot === 2 ? '立绘 2 ' : '立绘 '
      showToast(
        r.downscaled
          ? `${who}已就绪（${Math.round(r.bytes / 1024)}KB · 为控制体积用了压缩档 ${r.quality}）`
          : `${who}已就绪（${Math.round(r.bytes / 1024)}KB）`,
        'success',
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : '这张图不能用作立绘', 'error')
    } finally {
      setPortraitBusy(false)
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
    try {
      await saveCardRecord(draft)
      setRecords(records.map(r => (r.id === draft.id ? draft : r)))
      setSaved(true)
      savedTimer.current = setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setSaving(false)
    }
  }, [draft, dirty, records])

  // Ctrl/Cmd+S（2.7.3：收敛到 useSaveHotkey）
  useSaveHotkey(() => void save(), dirty)

  if (!loaded) return <LoadingState />

  return (
    <div className="page-enter">
      <header className="mb-5 flex items-start justify-between gap-4 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
            <HelpPopover title={`${tab.name} · 怎么填`} width="22rem" size={13}>{isCharTab ? `这是「${tab.name}」角色卡，按模块填写人物设定：

· 左侧列表切换 / 新建 / 删除角色；点击上方姓名可直接改名（保存后生效）。
· 右侧按模块（基础信息、外貌、性格……）分栏填写，长文会自动撑高输入框。
· 「人物状态」用下拉选择：未登场 / 已登场 / 已退场，便于统计登场进度。
· 字段带「示例」时可参考填法；修改后点右上「保存」或按 Ctrl+S。
· 右上「隐藏已退场」开关：开启后列表与统计隐藏「人物状态 = 已退场」的角色，角色过多时方便聚焦。`
: `这是「${tab.name}」，一条一张卡：

· 左侧列表切换 / 新建 / 删除设定；点击上方标题可直接改名（保存后生效）。
· 卡名就是这条设定的名字 —— 正文编辑器会把它做引用高亮，所以名字起得越具体越好。
· 右侧按字段填写，长文会自动撑高输入框；字段带「示例」时可参考填法。
· 修改后点右上「保存」或按 Ctrl+S；存不下的内容可分段，不必挤在一行里。
· 这里的内容同样会进 AI 的设定资料，模型写正文时读得到。`}</HelpPopover>
          </div>
          <p className="mt-1.5 text-13 text-ink-300 leading-relaxed max-w-3xl">{tab.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-11 transition-opacity ${saved ? 'opacity-100 text-success' : 'opacity-0'}`}>
            <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
          </span>
          <FieldAliasButton
            tabId={tab.id}
            tabName={tab.name}
            intro="给这一页的字段起你自己看得懂的名字（每张卡用的是同一套字段）。"
            targets={aliasTargets}
          />
          <Button variant="toggle" selected={dirty}
            onClick={save}
            disabled={!dirty || saving}
            className="font-medium hover:bg-amber/25"
            title={dirty ? '保存（Ctrl+S）' : '无未保存的改动'}
          >
            <Save size={12} /> {saving ? '保存中…' : (dirty ? '保存' : '已保存')}
          </Button>
          <Button onClick={addCard} variant="primary" size="md" className="flex items-center">
            <Plus size={14} /> 新建{noun}
          </Button>
          {aiCap !== 'none' && (
            <>
              {/* 🔴 2026-10-03 老大定案：这一组两个入口语义必须分清 ——
                  「AI 新增」= 凭空建一张新卡（原「AI 补全」改名，它从来就是新建行为）；
                  「AI 补全」= 在**当前这张卡**上补空白（与表单页 / 表格行同一口径，已填的保留）。 */}
              <Button variant="secondary" onClick={() => setShowFill(true)} disabled={!aiReady} className="flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : `提供粗略设定，让 AI 新建一张${noun}（不影响已有卡）`}>
                <Sparkles size={14} /> AI 新增
              </Button>
              <Button variant="secondary" onClick={() => setShowFillExisting(true)} disabled={!aiReady || !draft} className="flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : !draft ? '先选一张卡，再让 AI 补全它的空白字段' : `让 AI 补全「${draft.name}」未填写的字段（已填的会保留）`}>
                <Wand2 size={14} /> AI 补全
              </Button>
            </>
          )}
          {/* 只看角色卡：非角色卡片表（世界构建的「其他设定」）没有「人物状态」字段，
              这个开关对它们点了也没有任何效果 —— 与其摆着让人困惑，不如不渲染 */}
          {isCharTab && (
            <Button variant="toggle" selected={hideRetired}
              onClick={() => setHideRetired(v => !v)}
              className="font-medium hover:bg-amber/25"
              title="隐藏「人物状态 = 已退场」的角色，避免列表过长"
            >
              <EyeOff size={14} /> 隐藏已退场
            </Button>
          )}
        </div>
      </header>

      {/* 🔴 2026-09-22 六维审计 P2：内联长度走 `foldVh()`，别手抄 `calc(100vh / var(--ui-zoom,1))` ——
          手抄的等价式在 token 名变一次就静默失效（本处原先是手写的）。 */}
      <div className="flex gap-5" style={{ minHeight: contentMinH(CARD_SHEET_CHROME_PX) }}>
        {/* 卡片列表 */}
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
                    ? 'bg-amber/15 border-amber/30 text-amber'
                    : 'bg-ink-850 border-ink-700 text-ink-300 hover:border-ink-500'}`}
              >
                <div className="flex items-center gap-2">
                  <UserRound size={13} className="shrink-0" />
                  <span className="text-13 font-medium truncate flex-1">{rec.name}</span>
                  {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title={UNSAVED_CHANGES_HINT} />}
                  <Button variant="icon-danger" onClick={e => { e.stopPropagation(); removeCard(rec.id) }} className="opacity-40 group-hover:opacity-100 transition-all">
                    <Trash2 size={12} />
                  </Button>
                </div>
                <div className="text-10 text-ink-500 mt-0.5 truncate">
                  {Object.values(rec.data).find(v => v) || '未填写'}
                </div>
              </div>
            )
          })}
          {visibleRecords.length === 0 && (
            <div className="text-center text-ink-500 text-12 py-12 border border-dashed border-ink-700 rounded-lg">
              {/* 后一支只在角色卡可达（开关仅角色卡渲染、且过滤依据是「人物状态」），故保留「角色」字样 */}
              {records.length === 0 ? `点击右上角新建${noun}` : '已退场的角色已隐藏'}
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
                <span className="text-10 text-ink-500">点击姓名可改名 · 修改后点「保存」</span>
              </div>
              {tab.modules!.map(mod => {
                // ⚠️ 模块名在 schema 里带序号（「一、基础信息」）—— 别用全等去比，
                //    否则条件永远不成立、立绘位静默不渲染（2026-09-22 实机踩过）。
                const isBasicMod = mod.name.includes('基础信息')
                return (
                <section key={mod.name} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
                  <div className="px-4 py-2.5 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
                    <span className="w-1 h-3 rounded-full bg-amber/70" />
                    <h3 className="text-12 font-semibold text-ink-100">{mod.name}</h3>
                  </div>
                  {/* 🔴 B7：只在「基础信息」模块里做左右分栏 ——
                      这一模块的字段都极短（姓名 / 别称 / 保密等级 / 身份定位），
                      输入框收窄后右侧会空出一大片，正好让立绘占住。
                      ⚠️ 2026-09-22 返工两处：
                        ① 立绘块必须在**字段区之后**（DOM 顺序 = 显示在右）。第一版写在字段区之前，
                           于是立绘跑到**左侧**去了；
                        ② 尺寸 144px → 256 / 288px（xl），文本框同时收窄（见下方 max-w）。
                      其余模块（外貌 / 性格…）字段可长可短，一栏到底更合适，不动。 */}
                  <div className={isBasicMod ? 'flex items-stretch' : ''}>
                  {/* 字段区（左）：包一层 flex-col + justify-center，让它在立绘撑高时**均匀铺开**而不是顶在上边 */}
                  <div className={`divide-y divide-ink-700/60 ${isBasicMod ? 'flex-1 min-w-0 flex flex-col justify-center' : ''}`}>
                    {mod.fields.map(field => {
                      const key = `${mod.name}::${field.name}`
                      const val = draft.data[key] ?? ''
                      return (
                        <div key={key} className={`px-4 py-3 grid gap-3 hover:bg-ink-800/40 transition-colors ${
                          isBasicMod ? 'grid-cols-[104px_1fr]' : 'grid-cols-[140px_1fr]'
                        }`}>
                          <div>
                            <div
                              className="text-12 font-medium text-ink-100"
                              title={aliasLabels[key] === field.name ? undefined : `${field.name}（AI 仍按这个原字段名理解）`}
                            >{aliasLabels[key]}</div>
                            {field.desc && <div className="field-desc mt-0.5">{field.desc}</div>}
                          </div>
                          {/* ⚠️ 2026-09-22 **二次返工**：上一版把这里收在 `max-w-[26rem]`，结果输入框与立绘
                              之间空出一大块（老大原话「中间你打算放啥呢」）。正确做法是让输入框**吃满字段区**：
                              它的宽度上限本来就由「卡片宽 − 立绘列」自然决定，不该再人为设一个更小的上限。 */}
                          <div>
                            {/* 所属势力 / 种族 等字段：从其他设定表取值，禁止手动输入（根治同名异写导致的归属错乱） */}
                            {CARD_TABLE_REF_FIELDS[field.name] ? (
                              <TableRefSelect
                                value={val}
                                onChange={v => updateField(key, v)}
                                refTabId={CARD_TABLE_REF_FIELDS[field.name].tabId}
                                refCol={CARD_TABLE_REF_FIELDS[field.name].col}
                                multi={CARD_TABLE_REF_FIELDS[field.name].multi}
                                placeholder={`选择${field.name}`}
                              />
                            ) : CARD_SELECT_OPTIONS[field.name] ? (
                              <select
                                value={val}
                                onChange={e => updateField(key, e.target.value)}
                                className="w-full text-12 bg-ink-800 border border-ink-700 rounded px-2 py-1"
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
                                className="text-12"
                                minHeight={32}
                                maxHeight={UNBOUNDED_CARD_TABS.has(tab.id) ? 0 : undefined}
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
                  {/* 立绘位列（B7）—— 🔴 必须在字段区**之后**：DOM 顺序决定它显示在右侧。
                      与基础信息模块**融合**：只加一条左边框做分隔，不另立卡片。
                      ⚠️ 2026-09-22 三次调整：1 张（144px）→ 1 张（256px）→ **2 张并排**
                      （`w-80 / xl:w-[32rem]`；xl 下每张可视宽约 234px、高约 416px）。
                      两张的用意是把这一列**竖向占满** —— 只放一张时下方会空着一块。 */}
                  {isBasicMod && (
                    <div className="w-[17.5rem] shrink-0 border-l border-ink-700 px-4 py-3 flex flex-col">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-11 text-ink-400">人物立绘</span>
                        <span className="ml-auto text-10 text-ink-500">两张 · 9:16 不裁切</span>
                      </div>
                      {/* 🔴 **竖向**排列（不是并排）：右列是一整条竖空间（实测 894px 高），单张只占 415px、
                          下边空一半；上下各一格才叫「竖向占满」。并排那版还试过 —— 列宽翻倍会把左列
                          字段区挤扁（实测输入框只剩 382px）。 */}
                      <div className="flex-1 min-h-0 flex flex-col gap-3 items-center">
                        {([1, 2] as const).map(slot => {
                          const src = slot === 2 ? draft.portrait2 : draft.portrait
                          return (
                            <div key={slot} className="flex-1 min-h-0 w-full flex flex-col items-center">
                              {/* label：flex-1 定**高**、self-center 防被拉伸 ⇒ **宽**由 aspect-ratio 反推（9:16） */}
                              <label
                                className={`relative block flex-1 min-h-0 self-center max-w-full rounded-lg border border-dashed overflow-hidden cursor-pointer transition-colors ${
                                  portraitBusy ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-amber/60'
                                }`}
                                style={{ aspectRatio: '9 / 16' }}
                                title={PORTRAIT_HINT_SPEC}
                              >
                                <input
                                  type="file"
                                  accept={PORTRAIT_ACCEPT}
                                  className="hidden"
                                  disabled={portraitBusy}
                                  onChange={e => {
                                    const f = e.target.files?.[0]
                                    void updatePortrait(f ?? null, slot)
                                    e.currentTarget.value = ''   // 允许连续选同一张
                                  }}
                                />
                                {src ? (
                                  <img src={src} alt={`${draft.name} 的立绘 ${slot}`} className="w-full h-full object-cover" />
                                ) : (
                                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-ink-500">
                                    {portraitBusy
                                      ? <Loader2 size={18} className="animate-spin" />
                                      : <ImagePlus size={18} />}
                                    <span className="text-10">{portraitBusy ? '处理中…' : '点击上传'}</span>
                                  </span>
                                )}
                              </label>
                              <div className="mt-1.5 flex items-center gap-1.5 w-full shrink-0">
                                <span className="text-10 text-ink-500 tabular-nums">
                                  {src ? `${Math.round(dataUrlBytes(src) / 1024)}KB` : `立绘 ${slot}`}
                                </span>
                                {src && (
                                  <Button
                                    variant="icon-danger" iconOnly size="xs"
                                    title={`移除立绘 ${slot}`} aria-label={`移除立绘 ${slot}`}
                                    className="ml-auto shrink-0"
                                    onClick={() => void updatePortrait(null, slot)}
                                  >
                                    <X size={11} />
                                  </Button>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {/* 闭合「基础信息」的左右分栏容器（其余模块这个 div 不生成，类名为空也无害） */}
                  </div>
                </section>
                )
              })}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-ink-500 text-sm border border-dashed border-ink-700 rounded-xl">
              选择左侧{noun}或新建一个
            </div>
          )}
        </div>
      </div>

      {tab.tips && tab.tips.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber/20 bg-amber/5 p-4 space-y-1.5">
          {tab.tips.map((tip, i) => (
            <div key={i} className="text-12 text-amber/80 leading-relaxed flex items-start gap-2">
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
          // 草稿本按「这张卡」存：换到另一张角色卡时，攒的草稿不会跟错人
          draftScope={`card::${tab.id}::${draft?.id ?? 'new'}`}
          title={`AI 新增 · ${tab.name}`}
          sketchPlaceholder="例如：一个叫叶昭的少年，是没落剑派最后一名弟子，性格倔强但重情义，想复兴门派……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}

      {showFillExisting && draft && (
        <AITemplateFill
          fields={cardFields}
          existing={draft.data}
          draftScope={`card::${tab.id}::${draft.id}`}
          title={`AI 补全 · ${draft.name}`}
          sketchPlaceholder={`补充「${draft.name}」已填内容的背景 / 细节，让 AI 补全其余空白字段（已填的不会动）…`}
          onSubmit={handleFillExisting}
          onClose={() => setShowFillExisting(false)}
        />
      )}

      {/* v1.6：应用内输入弹窗（替代浏览器 prompt，桌面端可用） */}
      <PromptModal
        open={!!namePrompt}
        title={namePrompt?.kind === 'rename' ? `修改${noun}名称` : `新建${noun}`}
        label={namePrompt?.kind === 'rename' ? '修改后点「保存」生效' : undefined}
        defaultValue={namePrompt?.def ?? ''}
        placeholder={`请输入${noun}名称`}
        onSubmit={submitNamePrompt}
        onCancel={() => setNamePrompt(null)}
      />
    </div>
  )
}

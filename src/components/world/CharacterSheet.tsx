import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import { Z } from '@/lib/app/zLayer'
import type { TabDef, CardRecord } from '@/lib/types'
import { CARD_TABLE_REF_FIELDS, type VisCtx } from '@/lib/schema'
import { getCardRecords, saveCardRecord, deleteCardRecord, getCurrentProjectId } from '@/lib/db'
import { clearFreeDraft } from '@/lib/editor/freeDraft'
import { uid } from '@/lib/app/id'
import { Plus, Trash2, UserRound, Info, Save, Check, Sparkles, EyeOff, ImagePlus, X, Loader2, Wand2, Search, FileDown, FileUp } from 'lucide-react'
import { readPortraitFile, dataUrlBytes, PORTRAIT_ACCEPT } from '@/lib/media/imagePortrait'
import { PORTRAIT_HINT_SPEC } from '@/lib/media/portraitSpec'
import HelpPopover from '@/components/common/HelpPopover'
import AutoTextarea from '@/components/common/AutoTextarea'
import TableRefSelect from '@/components/sheets/TableRefSelect'
import AITemplateFill from '@/components/ai/AITemplateFill'
import PromptModal from '@/components/dialogs/PromptModal'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import type { TemplateField } from '@/lib/ai'
import { useAIReady } from '@/lib/ai/useAIReady'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import FieldAliasButton, { moduleAliasTargets } from '@/components/sheets/FieldAliasButton'
import { useFieldAliases } from '@/lib/settings/fieldAlias'
import { contentHeight, CARD_SHEET_CHROME_PX } from '@/lib/settings/theme'
import { MasterDetail, MasterList, useMasterFilter, useMasterQuery } from '@/components/common/MasterDetail'
import { AI_DISABLED_HINT, aiCapabilityOf } from '@/lib/ai/aiScope'
import { Button } from '@/components/common/Button'
import { SaveFab } from '@/components/common/SaveFab'
import { LoadingState } from '@/components/common/LoadingState'
import { usePersistedBool } from '@/lib/settings/uiPrefs'
import { readAliases } from '@/lib/settings/aliases'
import MentionPanel from '@/components/app/MentionPanel'
import TableImportDialog from '@/components/sheets/TableImportDialog'
import { buildCardImportGuide, buildCardRecords, cardNamePath, cardRecordsToTableRows, cardTabToTableTab, exportCardsCsv } from '@/lib/storage/cardIO'
import { CARD_SELECT_FIELDS } from '@/lib/world/cardFields'
import { downloadBlob } from '@/lib/storage/zip'
import type { ImportRowResult } from '@/lib/storage/tableIO'

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
  /** 跳转页签 / 正文（3.1 P1「资料提及」面板的章节跳转用） */
  onNavigate?: (id: string, chapterId?: string) => void
  /**
   * 可见性上下文（3.1.x）：透传给批量导入弹窗，供「AI 智能拆分」注入候选值
   * （角色名 / 势力名等）。与 `TableSheet` 的 `ctx` 同一口径。
   */
  ctx?: VisCtx
}

export default function CharacterSheet({ tab, focusRowId, onFocusConsumed, onNavigate, ctx = { type: 'full', features: [] } }: Props) {
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
  const [hideRetired, setHideRetired] = usePersistedBool('character-sheet-hide-retired', false)
  /** 「资料提及」面板（3.1 P1）：卡片标题行放大镜按钮打开，纯读不落库 */
  const [mention, setMention] = useState<{ name: string; aliases: string[] } | null>(null)
  /** 批量导入弹窗（3.1.x）：角色页签的「导入」按钮打开 */
  const [showImport, setShowImport] = useState(false)
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
  /**
   * 批量导入 / 导出用的**虚拟表格页签**（3.1.x）：把 `tab.modules` 拍平成 `columns`，
   * 让世界构建组那一整套 tableIO 逻辑（解析 / 映射 / 校验 / 模板 / 说明）原样复用 ——
   * 见 `lib/storage/cardIO.ts` 的头注。
   */
  const vtab = useMemo(() => cardTabToTableTab(tab), [tab])
  const visibleRecords = hideRetired ? records.filter(r => statusOf(r) !== '已退场') : records

  // 左栏搜索（A+C 的 C 项）：角色一多时，滚只解决「翻得到」、搜才解决「定位快」
  const [listQuery, setListQuery] = useMasterQuery()
  const { filtered: shownRecords, isFiltering } = useMasterFilter(
    visibleRecords, listQuery, r => r.name,
  )
  // 空态语义：0 张卡 / 全被「已退场」隐藏 / 搜索无结果 —— 三者文案不同
  const listEmptyHint = records.length === 0
    ? `点击右上角新建${noun}`
    : isFiltering
      ? '没有匹配的角色'
      : '已退场的角色已隐藏'
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
    // 🔴 补 alive 守卫（2026-10-10 六维审计）：读写途中卸载会往已卸载组件 setState。
    //    同文件其它 effect、TavernScript 的同类 effect 都已有守卫，只有这里漏了。
    let alive = true
    void getCardRecords(tab.id).then(r => {
      if (!alive) return
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
    return () => { alive = false }
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

  /**
   * 切到另一张卡之前，先把当前卡未保存的编辑落库。
   *
   * 🔴 R8（2026-10-16 独立复核）：凡是「新建 / 导入后自动切卡」的路径都必须**显式**先走这里。
   *    不能指望下面那个切卡 effect 兜底 —— `draftRef` 的同步 effect 声明在切卡 effect **之前**，
   *    所以「同一批次设置 records + activeId + draft」一发生，`draftRef.current` 已指向新卡；
   *    切卡 effect 里那句「保存上一张」取到的其实是新卡，**旧编辑静默蒸发**
   *    （界面与隔离 IndexedDB 双确认：改完不保存就导入，切回来恢复原值）。
   *
   * @returns 是否允许继续切卡。落库失败返回 false ⇒ 调用方必须中止，保留旧草稿与选择。
   */
  const flushCurrentDraft = useCallback(async (): Promise<boolean> => {
    const cur = draftRef.current
    if (!dirtyRef.current || !cur) return true
    try {
      await saveCardRecord(cur)
      // 同步内存副本：否则切回来时用库里的旧记录回灌，刚保存的编辑又「消失」
      setRecords(list => list.map(r => (r.id === cur.id ? cur : r)))
      // 立刻归零，免得切卡 effect 把这张卡当成「还有脏草稿」再存一次
      dirtyRef.current = false
      return true
    } catch (e) {
      showToast(
        `保存当前${nounCard}失败，已取消本次操作 —— 请先手动保存后重试：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
      return false
    }
  }, [nounCard])

  // AI 新增：草图 → 模型补全全部字段 → 直接建卡（key 即 `模块::字段`，与渲染一致）
  const handleFill = async (values: Record<string, string>) => {
    // R8：建卡后会自动切到新卡，先把当前卡的脏草稿落库（失败则中止）
    if (!await flushCurrentDraft()) return
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
      // R8：新建后会自动切到新卡，先把当前卡的脏草稿落库（失败则中止，不建新卡）
      if (!await flushCurrentDraft()) return
      const rec: CardRecord = { id: uid(), projectId: getCurrentProjectId(), tabId: tab.id, name: v, data: {}, order: records.length }
      await saveCardRecord(rec)
      setRecords([...records, rec])
      setActiveId(rec.id)
      setDraft(rec)
    } else {
      if (!draft || v === draft.name) return
      // R9：标题改了但「姓名」字段还空着 → 顺手补上，免得导出 / 判重时两边对不上。
      // 已填过姓名的不动 —— 作者可能故意让标题与姓名不同（标题「陈渊（主角）」、姓名「陈渊」）。
      const np = cardNamePath(tab)
      const next: CardRecord = { ...draft, name: v }
      if (np && !(draft.data[np] ?? '').trim()) next.data = { ...draft.data, [np]: v }
      setDraft(next)
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
   * 批量导入（3.1.x）：把勾选的导入行转成角色卡逐条落库，然后刷新左栏并选中第一张新卡。
   *
   * 🔴 逐条串行 await（不用 forEach + void）：与 TableSheet「清空全部」同一个教训 ——
   *    并发发起且不等待会把失败静默吞掉（界面已加进来、库里其实没写进去，重开这一页就消失）。
   */
  const handleImport = async (picked: ImportRowResult[]) => {
    // R8：导入后会自动切到第一张新卡，先把当前卡的脏草稿落库（失败则中止导入）
    if (!await flushCurrentDraft()) return
    const created = buildCardRecords(picked, tab, records, getCurrentProjectId(), uid)
    const okOnes: CardRecord[] = []
    let failed = 0
    for (const rec of created) {
      try { await saveCardRecord(rec); okOnes.push(rec) } catch { failed++ }
    }
    if (okOnes.length) {
      setRecords(prev => [...prev, ...okOnes])
      setActiveId(okOnes[0].id)
      setDraft(okOnes[0])
    }
    showToast(
      failed
        ? `已导入 ${okOnes.length} 张，另有 ${failed} 张没能写入 —— 请重试`
        : `已导入 ${okOnes.length} 张${nounCard}`,
      failed ? 'error' : 'success',
    )
  }

  /**
   * 导出本页全部卡片为 CSV（UTF-8 BOM，Excel 直接打开不乱码）。
   *
   * 🔴 用「含当前未保存草稿」的列表，而不是裸库数据 —— 与 TableSheet 的导出同一口径：
   *    作者刚改完还没保存就导出，导出的文件里看不到自己的改动，而屏幕上明明有。
   */
  const exportCsv = () => {
    if (records.length === 0) {
      showToast(`还没有${nounCard}可导出 —— 可先用「导入」批量录入，或点「新建${noun}」逐张录入。`, 'info')
      return
    }
    const list = draft ? records.map(r => (r.id === draft.id ? draft : r)) : records
    downloadBlob(`${tab.name}.csv`, new Blob(['\uFEFF' + exportCardsCsv(tab, list)], { type: 'text/csv;charset=utf-8' }))
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
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
        <div className="min-w-[14rem] flex-1">
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
        {/* 🔴 2026-10-09 与 TableSheet 同一处修复：工具条 `shrink-0` + 标题只有 `min-w-0`
            ⇒ 窄窗口下标题被压成一条竖缝（本页需 992px，1000px 窗口只有 728px）。
            改成「放不下就折行」：左栏 flex-1 + 保底 14rem；工具条 ml-auto + 内部可折行。 */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
          {/* 批量导入 / 导出（3.1.x）：对齐世界构建组表格页签那套能力（导出模板 → 填写 → 导入回项目）。
              ⚠️ 只在角色页签出现 ——「其他设定」是兜底页、暂不铺开（需要时去掉 isCharTab 判断即可）。 */}
          {isCharTab && (
            <>
              <Button variant="secondary" onClick={() => setShowImport(true)} className="flex items-center gap-1.5 font-medium transition-colors" title={`批量导入：粘贴表格 / CSV / 纯文本，或上传文件；散文式设定可用「AI 智能拆分」自动解析成多张${nounCard}`}>
                <FileDown size={14} /> 导入
              </Button>
              <Button variant="secondary" onClick={exportCsv} className="flex items-center gap-1.5 font-medium transition-colors" title={`导出全部${nounCard}为 CSV（Excel 可直接打开）`}>
                <FileUp size={14} /> 导出
              </Button>
            </>
          )}
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
      {/* 🔴 2026-10-05：`minHeight` → **锁定 `height`** + 两栏各自滚动。
          原先只有 minHeight，左栏角色一多就把整页撑高、右栏被拖着一起滚到底
          （社区反馈：批量改某栏数据要上下来回滚）。见 `MasterDetail.tsx` 说明。 */}
      <MasterDetail height={contentHeight(CARD_SHEET_CHROME_PX)}>
        {/* 卡片列表（含搜索 + 独立滚动） */}
        <MasterList
          widthClass="w-44 lg:w-52"
          query={listQuery}
          onQueryChange={setListQuery}
          placeholder="搜角色名…"
          searchHint={isFiltering
            ? <span className="text-10 text-ink-500">筛出 {shownRecords.length} / 共 {records.length}</span>
            : undefined}
          emptyHint={listEmptyHint}
          isEmpty={shownRecords.length === 0}
        >
          {shownRecords.map(rec => {
            const isActive = activeId === rec.id
            const isDirty = isActive && dirty
            return (
              <div
                key={rec.id}
                onClick={() => setActiveId(rec.id)}
                title={rec.name}
                className={`group cursor-pointer rounded-lg border px-3 py-2.5 transition-all duration-150
                  ${isActive
                    ? 'bg-amber/15 border-amber/30 text-amber'
                    : 'bg-ink-850 border-ink-700 text-ink-300 hover:border-ink-500'}`}
              >
                <div className="flex items-center gap-2">
                  <UserRound size={13} className="shrink-0" />
                  <span className="text-13 font-medium truncate flex-1">{rec.name}</span>
                  {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title={UNSAVED_CHANGES_HINT} />}
                  <Button variant="bare" iconOnly size="xs" title={`查看「${rec.name}」在正文中的提及`}
                    onClick={e => { e.stopPropagation(); setMention({ name: rec.name, aliases: readAliases(tab.id, rec.data) }) }}
                    className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all">
                    <Search size={12} />
                  </Button>
                  <Button variant="icon-danger" iconOnly size="xs" title="删除这张角色卡" onClick={e => { e.stopPropagation(); removeCard(rec.id) }} className="opacity-40 group-hover:opacity-100 transition-all">
                    <Trash2 size={12} />
                  </Button>
                </div>
                <div className="text-10 text-ink-500 mt-0.5 truncate">
                  {Object.values(rec.data).find(v => v) || '未填写'}
                </div>
              </div>
            )
          })}
        </MasterList>

        {/* 编辑区（独立滚动） */}
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1">
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
                            ) : CARD_SELECT_FIELDS[field.name] ? (
                              <select
                                value={val}
                                onChange={e => updateField(key, e.target.value)}
                                className="w-full text-12 bg-ink-800 border border-ink-700 rounded px-2 py-1"
                              >
                                {CARD_SELECT_FIELDS[field.name].map(o => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            ) : (
                              <AutoTextarea
                                value={val}
                                onChange={v => updateField(key, v)}
                                placeholder="点击填写…"
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
      </MasterDetail>

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

      {/* 3.1.x：批量导入弹窗 —— 复用世界构建组那套表格导入（`TableImportDialog`），
          传的是**虚拟表格页签**（`cardTabToTableTab`），故解析 / 校验 / 模板 / 说明 / AI 拆分全部原样复用。 */}
      {showImport && (
        <TableImportDialog
          tab={vtab}
          existing={cardRecordsToTableRows(tab, records)}
          visCtx={ctx}
          guideBuilder={buildCardImportGuide}
          onAdd={handleImport}
          onClose={() => setShowImport(false)}
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

      {/* 3.1 P1：资料提及结果面板（纯读，见 MentionPanel 头注） */}
      {mention && (
        <MentionPanel
          name={mention.name}
          aliases={mention.aliases}
          onClose={() => setMention(null)}
          onNavigate={onNavigate ?? (() => {})}
        />
      )}
    </div>
  )
}

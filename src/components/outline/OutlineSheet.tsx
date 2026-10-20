import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import { Z } from '@/lib/app/zLayer'
import type { TabDef, CardRecord } from '@/lib/types'
import { getCardRecords, saveCardRecord, deleteCardRecord, getCurrentProjectId } from '@/lib/db'
import { uid } from '@/lib/app/id'
import {
  Plus, Trash2, Info, Save, Check, Copy, ChevronUp, ChevronDown, BookOpen, FileText, Layers, Sparkles, Wand2,
} from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import AutoTextarea from '@/components/common/AutoTextarea'
import PromptModal from '@/components/dialogs/PromptModal'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import TemplateLibrary from '@/components/library/TemplateLibrary'
import { contentHeight, OUTLINE_SHEET_CHROME_PX } from '@/lib/settings/theme'
import { MasterDetail, MasterList, useMasterFilter, useMasterQuery } from '@/components/common/MasterDetail'
import { Button } from '@/components/common/Button'
import { SaveFab } from '@/components/common/SaveFab'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import FieldAliasButton, { moduleAliasTargets } from '@/components/sheets/FieldAliasButton'
import { useFieldDisplayLabels } from '@/lib/templates/useFieldRenames'
import { LoadingState } from '@/components/common/LoadingState'
import AITemplateFill from '@/components/ai/AITemplateFill'
import type { TemplateField, FillContext } from '@/lib/ai'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT, aiCapabilityOf } from '@/lib/ai/aiScope'
// R4a · 2.6.0：结构模板节拍对照条（只读）。模板选择的单一来源在 creativeSession，
// 与创意写作 / 检查工具「全书结构配比」共用同一份（hydrate 幂等，本页可能从未打开过创意写作）。
import { hydrateCreativeSession, useCreativeSession } from '@/lib/creative/creativeSession'
import { getStoryTemplate } from '@/lib/outline/storyStructures'

interface Props {
  tab: TabDef
}

/**
 * 大纲多记录编辑页（分卷大纲 / 章节细纲）
 * 左侧目录列表：新增 / 改名 / 删除 / 复制 / 上移下移排序
 * 右侧编辑区：全宽双栏模块表单，编辑"卷名/章节号"字段时自动同步目录名
 */
export default function OutlineSheet({ tab }: Props) {
  const isVolume = tab.id === 'volume-outline'
  const noun = isVolume ? '分卷' : '章节'
  // 编辑该字段时自动同步目录列表名
  const nameKey = isVolume ? '一、本卷定位::卷名' : '一、本章定位::章节号/标题'

  // 左栏搜索（A+C 的 C 项）：与 CharacterSheet 同口径
  const [listQuery, setListQuery] = useMasterQuery()

  /** 本页签的补全语境 —— 决定发哪条系统提示词（分卷大纲 / 章节细纲各一条；见 lib/ai.ts 的 FillContext） */
  const fillContext: FillContext = isVolume ? 'outline-volume' : 'outline-chapter'
  // AI 入口：本页签适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()
  /** AI 补全用的字段模板（key = `模块名::字段名`，与落库的键同名） */
  const cardFields = useMemo<TemplateField[]>(
    () => (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
    }))),
    // 🔴 同 CharacterSheet：读 tab.modules 就得依赖 tab 本身，只写 tab.id 会在字段结构变化时沿用旧字段表
    [tab],
  )

  const [records, setRecords] = useState<CardRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<CardRecord | null>(null)
  // 🔴 用 ref 持有最新草稿：下面「切换卡片」的 effect 里读到的是**切换前**的那一份 —— 正是要落库的。
  //    （与 CharacterSheet 的切卡守卫同型。审计 2026-09-18 P1-3：原先直接 setDraft(新卡)，
  //      未保存的编辑静默消失，SaveFab 也一并消失、界面上没有任何提示。）
  // 🔴🔴 同步 effect **必须声明在下方**（「切换 active 时落库旧草稿」那个 effect 之后）：
  //    React 按**声明顺序**执行 effect。写在这里的话，新建 / 复制 / AI 新增这类
  //    「setActiveId + setDraft 在同一批次里发生」的操作会先把它刷成新卡，
  //    切换 effect 再去读就拿到**新草稿**、而不是要落库的旧草稿 ⇒ 旧卡未保存的编辑静默蒸发。
  //    2026-10-18 独立复核：此处注释原写「同步 effect 声明在下方」，实际却写在上方 —— 注释与实现相反。
  const draftRef = useRef(draft)
  const prevActiveRef = useRef<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  const [tplOpen, setTplOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // AI 新增弹窗（凭空建一条新大纲）／AI 补全弹窗（在**当前这一条**上补空白，已填的保留）
  const [showFillNew, setShowFillNew] = useState(false)
  const [showFillExisting, setShowFillExisting] = useState(false)

  /** 字段显示名（2.7.3）：只改界面上这行字，取值仍走「模块名::字段名」存储键 */
  const aliasTargets = useMemo(() => moduleAliasTargets(tab.modules), [tab])
  const aliasKeys = useMemo(() => aliasTargets.map(t => t.key), [aliasTargets])
  const aliasLabels = useFieldDisplayLabels(tab.id, aliasKeys)

  // ---- R4a · 2.6.0 结构模板节拍对照（章节细纲页只读展示） ----
  useEffect(() => { hydrateCreativeSession() }, [])
  const structureId = useCreativeSession().inputs.structureId
  const structureTpl = !isVolume ? getStoryTemplate(structureId) : null
  /** 从卡片名解析章号（与 nextChapterNo 同一口径；解析不到的卡不参与折算） */
  const chapterNos = useMemo(
    () => records.map(r => Number(r.name.match(/第(\d+)章/)?.[1] ?? 0)),
    [records]
  )
  const beatRanges = useMemo(() => {
    if (!structureTpl || records.length === 0) return null
    // 全书尺度：细纲卡数与最大手填章号取大（作者可能跳着排章号）
    const maxNo = chapterNos.reduce((s, n) => Math.max(s, n), 0)
    const m = Math.max(records.length, maxNo, 1)
    // 与归属公式互逆的反推：章 N 的位置 = ((N−0.5)/M)×100 ∈ [from,to)
    //  ⟺ N ≥ from·M/100 + 0.5 且 N < to·M/100 + 0.5
    const ranges = structureTpl.beats.map(b => ({
      name: b.name,
      brief: b.brief,
      from: Math.max(1, Math.ceil((b.from * m) / 100 + 0.5)),
      to: Math.min(m, Math.ceil((b.to * m) / 100 + 0.5) - 1),
    }))
    return { m, ranges }
  }, [structureTpl, records.length, chapterNos])
  // 当前编辑章落在哪一拍（高亮用；名字里没有章号就不高亮）
  const activeBeatIdx = useMemo(() => {
    if (!beatRanges || !draft) return -1
    const no = Number(draft.name.match(/第(\d+)章/)?.[1] ?? 0)
    if (!no) return -1
    const pos = ((no - 0.5) / beatRanges.m) * 100
    const tplBeats = structureTpl?.beats ?? []
    return tplBeats.findIndex(b => pos >= b.from && pos < b.to)
  }, [beatRanges, draft, structureTpl])

  // 左栏按名称筛选（A+C 的 C 项）
  const { filtered: shownRecords, isFiltering } = useMasterFilter(records, listQuery, r => r.name)

  useEffect(() => {
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
  }, [tab.id, reloadKey])

  // 切换 active 时刷新 draft —— 切换前先把上一张未保存的草稿落库（不然编辑静默蒸发）
  useEffect(() => {
    const prev = prevActiveRef.current
    // 仅当「确实切到了另一张仍存在的卡」才存旧草稿；因删除导致的切换不存档（免得把已删的卡复活）
    if (prev && prev !== activeId && dirtyRef.current && draftRef.current && records.some(r => r.id === prev)) {
      const done = draftRef.current
      // 🔴 失败必须出声（本项目「绝不静默」口径）：`void` 掉的话写盘失败会被吞，
      //    作者以为切走时自动存上了，重开项目编辑却没了 —— 这正是独立复核要核对的失败路径。
      void saveCardRecord(done).catch(() => {
        showToast('切换前自动保存上一份编辑失败，请回到那一张手动保存一次', 'error')
      })
      // 🔴 落库后必须同步刷新内存 records：否则切回来时用**库里的旧记录**回灌，
      //    刚保存的编辑在界面上又消失（数据其实已入库，但用户看到的是「白改了」，
      //    且此后 dirty 归零，再改一处保存就会把它覆盖回去）。2026-09-18 实机抓到：
      //    「切走再切回值回退、但刷新后值又在」——这个组合特征正是内存副本过期。
      setRecords(list => list.map(r => (r.id === done.id ? done : r)))
    }
    prevActiveRef.current = activeId
    if (!activeId) { setDraft(null); return }
    // 关键守卫：activeId 没变、但 records 因「其它卡增删改」而变化时，若当前草稿有未保存编辑，
    // 绝不能用库里的旧记录回灌覆盖（否则改了半天、顺手去删另一张卡，编辑就没了）。
    // draftRef / dirtyRef 的同步 effect 声明在下方，此处读到的是上一轮渲染的值 —— 正是「切换前」状态。
    if (draftRef.current?.id === activeId && dirtyRef.current) return
    const rec = records.find(r => r.id === activeId)
    setDraft(rec ? { ...rec, data: { ...rec.data } } : null)
  }, [activeId, records])
  // 🔴 draftRef 同步刻意排在**上面那个 effect 之后**（理由见声明处的长注释）
  useEffect(() => { draftRef.current = draft }, [draft])

  // v1.6：新增/改名走应用内 PromptModal（浏览器 prompt 在 Electron 桌面端无实现、点击无反应）
  const [namePrompt, setNamePrompt] = useState<null | { kind: 'add' | 'rename'; def?: string }>(null)

  const addRecord = () => {
    const defaultName = isVolume ? `第${records.length + 1}卷` : `第${nextChapterNo(records)}章`
    setNamePrompt({ kind: 'add', def: defaultName })
  }

  /** 推算下一个章节号（从已有记录名里找最大的"第N章"） */
  function nextChapterNo(recs: CardRecord[]): string {
    let max = 0
    for (const r of recs) {
      const m = r.name.match(/第(\d+)章/)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return String(max + 1)
  }

  const submitNamePrompt = async (v: string) => {
    const p = namePrompt
    setNamePrompt(null)
    if (!v || !p) return
    if (p.kind === 'add') {
      // 倒序：新建卡片 order 取当前最小 order −1，使其始终排在最上方（创建时间倒序）
      const newOrder = records.length ? Math.min(...records.map(r => r.order)) - 1 : 0
      const rec: CardRecord = {
        id: uid(), projectId: getCurrentProjectId(), tabId: tab.id,
        name: v.trim(), data: { [nameKey]: v.trim() }, order: newOrder,
      }
      // 🔴 写库失败就**不切换选择、不替换草稿**：否则界面上多出一条库里根本没有的卡
      //    （刷新即消失），而作者此刻的原编辑还挂在旧草稿上（运行契约 draft.failure）。
      try {
        await saveCardRecord(rec)
      } catch {
        showToast(`新建${noun}失败，改动没有保存 —— 请重试`, 'error')
        return
      }
      setRecords([rec, ...records])
      // 🔴 2026-10-19 全量审计（draft.switch）：新建后要切到新卡，必须走 `switchTo` ——
      //    它会**先冲刷旧草稿、写盘失败就不切**。原先这里直接 `setActiveId` 再靠切换 effect 补存，
      //    一旦补存失败，作者已经站在新卡上、旧编辑被顶掉，只剩一句 toast（与角色卡 R8 同类）。
      //    落库顺序保持：先 `saveCardRecord(rec)`（新卡进库）→ 进列表 → 冲刷成功才切过去。
      if (!(await switchTo(rec.id, `「${rec.name}」已建好（在列表最上方），但当前这张的改动没能保存 —— 已留在原处，先手动保存一次再切`))) return
      setDraft(rec)
    } else {
      if (!draft || v.trim() === draft.name) return
      setDraft({ ...draft, name: v.trim(), data: { ...draft.data, [nameKey]: v.trim() } })
      setSaved(false)
    }
  }

  const renameRecord = () => {
    if (draft) setNamePrompt({ kind: 'rename', def: draft.name })
  }

  const duplicateRecord = async () => {
    if (!draft) return
    const name = `${draft.name}（副本）`
    // 复制的卡片同样排在最上方（倒序）
    const newOrder = records.length ? Math.min(...records.map(r => r.order)) - 1 : 0
    const rec: CardRecord = {
      id: uid(), projectId: getCurrentProjectId(), tabId: tab.id,
      name, data: { ...draft.data, [nameKey]: name }, order: newOrder,
    }
    // 与「新建」同口径：落库失败不切换选择，避免界面出现一条刷新即消失的幽灵卡
    try {
      await saveCardRecord(rec)
    } catch {
      showToast('复制失败，改动没有保存 —— 请重试', 'error')
      return
    }
    setRecords([rec, ...records])
    // 与新建同口径（2026-10-19 审计）：复制出副本后要切过去，先冲刷旧草稿、失败不切
    if (!(await switchTo(rec.id, `副本「${name}」已建好，但当前这张的改动没能保存 —— 已留在原处，先手动保存一次再切`))) return
    setDraft(rec)
  }

  const removeRecord = async (id: string) => {
    const rec = records.find(r => r.id === id)
    if (!rec) return
    // C-8 · 2.6.0：弹窗用页签实名（章节细纲 / 分卷大纲）——原来拼「${noun}大纲」会在细纲页写出「章节大纲」
    if (!await confirmDialog({ title: `删除${tab.name}`, message: `确定删除「${rec.name}」的这份${tab.name}？`, danger: true })) return
    await deleteCardRecord(id)
    const next = records.filter(r => r.id !== id)
    setRecords(next)
    if (activeId === id) setActiveId(next[0]?.id ?? null)
  }

  /** 上移/下移：交换 order 并持久化 */
  const moveRecord = async (id: string, dir: -1 | 1) => {
    const idx = records.findIndex(r => r.id === id)
    const target = idx + dir
    if (idx < 0 || target < 0 || target >= records.length) return
    const next = [...records]
    const a = { ...next[idx], order: next[target].order }
    const b = { ...next[target], order: next[idx].order }
    next[idx] = a; next[target] = b
    // 按 order 重排，保证列表顺序与 order 一致（手动上移/下移后视觉立即移动）
    setRecords(next.sort((a, b) => a.order - b.order))
    // 排序已先落到界面上（视觉立即移动），故写库失败不回滚、但**必须出声**，
    //    否则 order 的库内值与界面不一致，作者无从察觉。
    try {
      await saveCardRecord(a)
      await saveCardRecord(b)
    } catch {
      showToast('排序没能写入，请再拖一次（界面顺序可能与库内不一致）', 'error')
    }
    // 若 draft 被移动，同步其 order
    setDraft(d => (d && (d.id === a.id || d.id === b.id) ? next.find(r => r.id === d.id)! : d))
  }

  const updateField = (path: string, value: string) => {
    if (!draft) return
    const next: CardRecord = { ...draft, data: { ...draft.data, [path]: value } }
    // 编辑名称字段时同步目录名
    if (path === nameKey && value.trim()) next.name = value.trim()
    setDraft(next)
    setSaved(false)
  }

  /**
   * AI 新增：草图 → 模型补全全部字段 → 直接建一条新大纲（与 CharacterSheet 的「AI 新增」同口径）。
   * 🔴 新条目排在目录**最上方**（order = 当前最小 order − 1），与本页「新建{分卷/章节}」一致
   *    （本页是创建时间倒序）。名称取本页的名称字段，取不到才用「未命名」。
   */
  const handleFillNew = async (values: Record<string, string>) => {
    const name = (values[nameKey] ?? '').trim() || `未命名${noun}`
    const newOrder = records.length ? Math.min(...records.map(r => r.order)) - 1 : 0
    const rec: CardRecord = {
      id: uid(), projectId: getCurrentProjectId(), tabId: tab.id,
      name, data: { ...values }, order: newOrder,
    }
    // 同口径：落库失败就不切换选择、也不关弹窗（作者还能改完再提交一次）
    try {
      await saveCardRecord(rec)
    } catch {
      showToast(`AI 新增${noun}失败，改动没有保存 —— 请重试`, 'error')
      return
    }
    setRecords([rec, ...records])
    // 与「新建」同口径（2026-10-19 审计）：切到 AI 新条目之前先冲刷旧草稿，失败就留在原处
    if (!(await switchTo(rec.id, `「${rec.name}」已建好（在列表最上方），但当前这张的改动没能保存 —— 已留在原处，先手动保存一次再切`))) {
      setShowFillNew(false)   // 新条目已入库，留着弹窗再提交会建出第二张
      return
    }
    setDraft(rec)
    setShowFillNew(false)
  }

  /**
   * AI 补全（已有条目）：只补**当前这一条**未填的字段，已填的保留 —— 与角色卡 / 表单页同一口径。
   * 🔴 与 handleFillNew 的区别：那个是「AI 新增」（凭空建一条），这个是「AI 补全」（在已有条目上补空白）。
   * 采用后只写回 draft（不落库），由作者核对后点保存；dirty 是 draft 与库中记录的比对，会自动亮起。
   */
  const handleFillExisting = (values: Record<string, string>) => {
    if (!draft) return
    const next: CardRecord = { ...draft, data: { ...draft.data } }
    for (const [k, v] of Object.entries(values)) if (v && v.trim()) next.data[k] = v
    setDraft(next)
    setShowFillExisting(false)
  }

  // memo 化：避免每次渲染都对 draft 与源记录做两次完整 JSON 序列化
  const dirty = useMemo(
    () => !!draft && JSON.stringify(draft) !== JSON.stringify(records.find(r => r.id === draft.id)),
    [draft, records]
  )

  // 🔴 与上面那个切换守卫配对：声明顺序在它之后，所以守卫里读到的是「上一轮」的脏标记（切换前状态）
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  /**
   * 切换当前卡片（运行契约 draft.failure）：
   *   🔴 **先冲刷旧草稿、成功才真的换选择** —— 写盘失败就留在原地并出声。
   *     原先是「先切过去，再由 effect 补存旧草稿」：一旦那次补存失败，界面已经在新卡上，
   *     旧编辑既没入库、也从 draft 里被顶掉了 ⇒ 作者看到的只有「白改了」，且无从察觉
   *     （2026-10-18 独立复核：draft.failure 契约）。
   */
  const switchTo = useCallback(async (id: string | null, failHint?: string) => {
    const cur = draftRef.current
    if (cur && cur.id !== id && dirtyRef.current && records.some(r => r.id === cur.id)) {
      try {
        await saveCardRecord(cur)
        // 与切换守卫同口径：落库后同步内存副本，否则切回来会用库里的旧记录回灌
        setRecords(list => list.map(r => (r.id === cur.id ? cur : r)))
      } catch {
        showToast(failHint ?? '上一张的改动没能保存，已留在原处 —— 请手动保存一次再切换', 'error')
        return false
      }
    }
    setActiveId(id)
    return true
  }, [records])

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

  const filledCount = draft ? Object.values(draft.data).filter(v => v && v.trim()).length : 0
  const totalFields = tab.modules?.reduce((s, m) => s + m.fields.length, 0) ?? 0

  return (
    <div className="w-full page-enter">
      {/* 头部 */}
      <header className="mb-5 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
              <HelpPopover title={`${tab.name} · 怎么填`} width="22rem" size={13}>{`这是「${tab.name}」大纲，按${noun}拆分规划：

· 左侧目录用「新建${noun}」新增；悬停可上移 / 下移排序、删除、复制。
· 编辑「卷名 / 章节号·标题」时会自动同步左侧目录名。
· 右侧按模块（定位 / 核心 / 钩子……）双栏铺开，长文自动撑高。
· 顶部进度条显示当前${noun}已填字段比例；修改后点「保存」或 Ctrl+S。`}</HelpPopover>
            </div>
            <p className="mt-1.5 text-13 text-ink-300 leading-relaxed max-w-none">{tab.description}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            <span className="text-11 text-ink-500">{records.length} 个{noun}</span>
            <span className={`text-11 transition-opacity ${saved ? 'opacity-100 text-success' : 'opacity-0'}`}>
              <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
            </span>
            <FieldAliasButton
              tabId={tab.id}
              tabName={tab.name}
              intro={`给这一页的字段起你自己看得懂的名字（每张${noun}用的是同一套字段）。`}
              targets={aliasTargets}
            />
            <Button variant="toggle" selected={dirty}
              onClick={save}
              disabled={!dirty || saving}
              className="font-medium hover:bg-amber/25"
              title={dirty ? '保存（Ctrl+S）' : '无未保存的改动'}
            >
              <Save size={13} /> {saving ? '保存中…' : (dirty ? '保存' : '已保存')}
            </Button>
            <Button variant="secondary" onClick={() => setTplOpen(true)} className="flex items-center gap-1.5 font-medium transition-colors" title="套用经典结构模板快速搭建大纲">
              <Layers size={14} /> 模板库
            </Button>
            <Button onClick={addRecord} variant="primary" size="md" className="flex items-center">
              <Plus size={14} /> 新建{noun}
            </Button>
            {aiCap !== 'none' && (
              <>
                {/* 🔴 2026-10-03 老大定案：与角色管理组同一组语义 ——
                    「AI 新增」= 凭空建一条新大纲（不影响已有条目）；
                    「AI 补全」= 在**当前这一条**上补空白（与表单页 / 表格行同一口径，已填的保留）。 */}
                <Button variant="secondary" onClick={() => setShowFillNew(true)} disabled={!aiReady} className="flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : `提供粗略想法，让 AI 新建一份${tab.name}（不影响已有${noun}）`}>
                  <Sparkles size={14} /> AI 新增
                </Button>
                <Button variant="secondary" onClick={() => setShowFillExisting(true)} disabled={!aiReady || !draft} className="flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : !draft ? `先选一条${noun}，再让 AI 补全它的空白字段` : `让 AI 补全「${draft.name}」未填写的字段（已填的会保留）`}>
                  <Wand2 size={14} /> AI 补全
                </Button>
              </>
            )}
          </div>
        </div>
        {draft && (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-1 bg-ink-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber/70 rounded-full transition-all duration-500"
                style={{ width: `${totalFields ? (filledCount / totalFields) * 100 : 0}%` }}
              />
            </div>
            <span className="text-10 text-ink-400 shrink-0">{draft.name} · {filledCount} / {totalFields} 项已填</span>
          </div>
        )}
      </header>

      {/* R4a · 2.6.0 结构模板节拍对照条（章节细纲页 · 只读）：按细纲卡数折算各拍章号范围，
          当前编辑章所在拍高亮。模板选择跟随创意写作 / 全书结构配比（单一来源），此处不提供切换。 */}
      {!isVolume && beatRanges && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2">
          <span className="text-10 text-ink-500 shrink-0">结构对照 · {structureTpl!.name}</span>
          {/* 🔴 问号紧跟功能名（红线）：必须排在标签之后、chips 之前，否则被 flex-wrap 的 chips 挤到行尾 */}
          <HelpPopover title="结构对照 · 怎么用" width="22rem">
            {'只读参考条：把所选结构模板的节拍按全书章数折算成章号范围，'
              + '写细纲时可以对着看「这一章落在故事的哪一拍」——当前编辑章所在的拍会高亮。\n\n'
              + '· 模板在「创意写作」面板或检查工具「全书结构配比」里选择，这里跟随同一份选择、不单独存；\n'
              + '· 折算依据是细纲卡数（以及手填章节号里的最大值），选「不使用结构模板」时本条不显示；\n'
              + '· 分卷大纲页不显示——模板是全书章数口径，对卷数折算没有参考意义。'}
          </HelpPopover>
          {beatRanges.ranges.map((r, i) => (
            <span
              key={r.name}
              className={`px-2 py-0.5 rounded-md border text-11 ${
                i === activeBeatIdx
                  ? 'bg-amber/15 border-amber/40 text-amber'
                  : 'bg-ink-800 border-ink-700 text-ink-300'
              }`}
              title={`${r.name}：${r.brief}`}
            >
              {r.name} {r.to >= r.from ? (r.to > r.from ? `${r.from}-${r.to}` : `${r.from}`) : '—'} 章
            </span>
          ))}
        </div>
      )}

      {/* 🔴 2026-09-22 六维审计 P2：内联长度走 `foldVh()`（原来手抄等价式，见 `CharacterSheet` 同处说明）。 */}
      {/* 🔴 2026-10-05：`minHeight` → **锁定 `height`** + 两栏各自滚动（与 CharacterSheet 同批）。
          原先只有 minHeight，卷/章大纲条目一多就把整页撑高、右栏被拖着一起滚到底。 */}
      <MasterDetail height={contentHeight(OUTLINE_SHEET_CHROME_PX)}>
        {/* 目录列表（含搜索 + 独立滚动） */}
        <MasterList
          widthClass="w-52 lg:w-56"
          query={listQuery}
          onQueryChange={setListQuery}
          placeholder={`搜${noun}名…`}
          searchHint={isFiltering
            ? <span className="text-10 text-ink-500">筛出 {shownRecords.length} / 共 {records.length}</span>
            : undefined}
          emptyHint={records.length === 0 ? `还没有${noun}大纲` : '没有匹配的条目'}
          isEmpty={shownRecords.length === 0}
        >
          {shownRecords.map((rec, i) => {
            const isActive = activeId === rec.id
            const isDirty = isActive && dirty
            return (
              <div
                key={rec.id}
                onClick={() => void switchTo(rec.id)}
                title={rec.name}
                className={`group cursor-pointer rounded-lg border px-2.5 py-2.5 transition-all duration-150
                  ${isActive
                    ? 'bg-amber/15 border-amber/30 text-amber'
                    : 'bg-ink-850 border-ink-700 text-ink-300 hover:border-ink-500'}`}
              >
                <div className="flex items-center gap-1.5">
                  {isVolume ? <BookOpen size={13} className="shrink-0" /> : <FileText size={13} className="shrink-0" />}
                  <span className="text-13 font-medium truncate flex-1">{rec.name}</span>
                  {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title={UNSAVED_CHANGES_HINT} />}
                </div>
                <div className="text-10 text-ink-500 mt-0.5 truncate">
                  {Object.entries(rec.data)
                    .filter(([k, v]) => v && v.trim() && k !== nameKey)
                    .map(([, v]) => v)[0] || '未填写'}
                </div>
                {/* 悬停操作：排序 / 删除 */}
                <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="bare" iconOnly size="xs"
                    disabled={i === 0}
                    onClick={e => { e.stopPropagation(); moveRecord(rec.id, -1) }}
                    className="text-ink-500 hover:text-amber disabled:opacity-30 disabled:cursor-not-allowed"
                    title="上移"
                  >
                    <ChevronUp size={12} />
                  </Button>
                  <Button variant="bare" iconOnly size="xs"
                    disabled={i === records.length - 1}
                    onClick={e => { e.stopPropagation(); moveRecord(rec.id, 1) }}
                    className="text-ink-500 hover:text-amber disabled:opacity-30 disabled:cursor-not-allowed"
                    title="下移"
                  >
                    <ChevronDown size={12} />
                  </Button>
                  <span className="flex-1" />
                  {/* 🔴 2026-09-22 六维审计 P2：与 `AIConfigPanel` 同一个病 —— `icon-danger` 没传 size
                      ⇒ 走 ICON_SIZE.sm = h-8(32px)，而同一操作条左端的「上移 / 下移」是 `iconOnly size="xs"`(24px)，
                      被 `<span className="flex-1" />` 撑到两端后**差 8px**。补 `iconOnly size="xs"` 对齐。 */}
                  <Button variant="icon-danger" iconOnly size="xs" onClick={e => { e.stopPropagation(); removeRecord(rec.id) }} title={`删除该${noun}`}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
            )
          })}
        </MasterList>

        {/* 编辑区：全宽双栏（独立滚动） */}
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1">
          {draft ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <h2
                  className="text-lg font-bold text-amber cursor-pointer hover:text-amber-soft"
                  onClick={renameRecord}
                  title="点击改名（保存后生效）"
                >
                  {draft.name}
                </h2>
                <span className="text-10 text-ink-500">点击名称可改名 · 修改后点「保存」</span>
                <span className="flex-1" />
                <Button onClick={duplicateRecord}
                  
                  title={`复制当前${noun}大纲为新${noun}`} variant="secondary" size="md" className="flex items-center">
                  <Copy size={11} /> 复制
                </Button>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                {tab.modules!.map(mod => (
                  <section key={mod.name} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
                    <div className="px-4 py-2.5 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
                      <span className="w-1 h-3 rounded-full bg-amber/70" />
                      <h3 className="text-12 font-semibold text-ink-100">{mod.name}</h3>
                      <span className="text-10 text-ink-500 ml-auto">{mod.fields.length} 项</span>
                    </div>
                    <div className="divide-y divide-ink-700/60">
                      {mod.fields.map(field => {
                        const key = `${mod.name}::${field.name}`
                        const val = draft.data[key] ?? ''
                        return (
                          <div key={key} className="px-4 py-3 grid grid-cols-[140px_1fr] gap-3 hover:bg-ink-800/40 transition-colors">
                            <div>
                              <div
                                className="text-12 font-medium text-ink-100"
                                title={aliasLabels[key] === field.name ? undefined : `${field.name}（存储键不变，AI 按当前名称理解）`}
                              >{aliasLabels[key]}</div>
                              {field.desc && <div className="field-desc mt-0.5">{field.desc}</div>}
                            </div>
                            <div>
                              <AutoTextarea
                                value={val}
                                onChange={v => updateField(key, v)}
                                placeholder="点击填写…"
                                className="text-12"
                                minHeight={32}
                              />
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

      {tplOpen && (
        <TemplateLibrary
          tabId={tab.id}
          isVolume={isVolume}
          onApplied={() => setReloadKey(k => k + 1)}
          onClose={() => setTplOpen(false)}
        />
      )}

      {showFillNew && (
        <AITemplateFill
          fields={cardFields}
          tabId={tab.id}
          context={fillContext}
          draftScope={`card::${tab.id}::new`}
          title={`AI 新增 · ${tab.name}`}
          sketchPlaceholder={isVolume
            ? '例如：这一卷讲主角初入宗门、卷入内门争斗，卷末以「师父被害」收尾，逼他下山……'
            : '例如：这一章主角第一次动用吞天魔功，在擂台上反杀挑衅的师兄，结尾被长老盯上……'}
          onSubmit={handleFillNew}
          onClose={() => setShowFillNew(false)}
        />
      )}

      {showFillExisting && draft && (
        <AITemplateFill
          fields={cardFields}
          tabId={tab.id}
          context={fillContext}
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

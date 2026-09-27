import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { UNSAVED_CHANGES_HINT } from '../lib/constants'
import { Z } from '../lib/zLayer'
import type { TabDef, CardRecord } from '../lib/types'
import { getCardRecords, saveCardRecord, deleteCardRecord, getCurrentProjectId } from '../lib/db'
import { uid } from '../lib/id'
import {
  Plus, Trash2, Info, Save, Check, Copy, ChevronUp, ChevronDown, BookOpen, FileText, Layers,
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import AutoTextarea from './AutoTextarea'
import PromptModal from './PromptModal'
import { confirmDialog, showToast } from './dialogs'
import TemplateLibrary from './TemplateLibrary'
import { contentMinH, OUTLINE_SHEET_CHROME_PX } from '../lib/theme'
import { Button } from './Button'
import { SaveFab } from './SaveFab'
import { LoadingState } from './LoadingState'
// R4a · 2.6.0：结构模板节拍对照条（只读）。模板选择的单一来源在 creativeSession，
// 与创意写作 / 检查工具「全书结构配比」共用同一份（hydrate 幂等，本页可能从未打开过创意写作）。
import { hydrateCreativeSession, useCreativeSession } from '../lib/creativeSession'
import { getStoryTemplate } from '../lib/storyStructures'

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

  const [records, setRecords] = useState<CardRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<CardRecord | null>(null)
  // 🔴 用 ref 持有最新草稿：下面「切换卡片」的 effect 里读到的是**切换前**的那一份 —— 正是要落库的。
  //    （与 CharacterSheet 的切卡守卫同型。审计 2026-09-18 P1-3：原先直接 setDraft(新卡)，
  //      未保存的编辑静默消失，SaveFab 也一并消失、界面上没有任何提示。）
  const draftRef = useRef(draft)
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => { draftRef.current = draft }, [draft])
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  const [tplOpen, setTplOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

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
      void saveCardRecord(done)
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
      await saveCardRecord(rec)
      setRecords([rec, ...records])
      setActiveId(rec.id)
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
    await saveCardRecord(rec)
    setRecords([rec, ...records])
    setActiveId(rec.id)
    setDraft(rec)
  }

  const removeRecord = async (id: string) => {
    const rec = records.find(r => r.id === id)
    if (!rec) return
    if (!await confirmDialog({ title: `删除${noun}大纲`, message: `确定删除「${rec.name}」的${noun}大纲？`, danger: true })) return
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
    await saveCardRecord(a)
    await saveCardRecord(b)
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

  // memo 化：避免每次渲染都对 draft 与源记录做两次完整 JSON 序列化
  const dirty = useMemo(
    () => !!draft && JSON.stringify(draft) !== JSON.stringify(records.find(r => r.id === draft.id)),
    [draft, records]
  )

  // 🔴 与上面那个切换守卫配对：声明顺序在它之后，所以守卫里读到的是「上一轮」的脏标记（切换前状态）
  const dirtyRef = useRef(false)
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

• 左侧目录用「新建${noun}」新增；悬停可上移 / 下移排序、删除、复制。
• 编辑「卷名 / 章节号·标题」时会自动同步左侧目录名。
• 右侧按模块（定位 / 核心 / 钩子……）双栏铺开，长文自动撑高。
• 顶部进度条显示当前${noun}已填字段比例；修改后点「保存」或 Ctrl+S。`}</HelpPopover>
            </div>
            <p className="mt-1.5 text-13 text-ink-300 leading-relaxed max-w-none">{tab.description}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            <span className="text-11 text-ink-500">{records.length} 个{noun}</span>
            <span className={`text-11 transition-opacity ${saved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>
              <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
            </span>
            <Button variant="toggle" selected={dirty}
              onClick={save}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium hover:bg-amber/25"
              title={dirty ? '保存（Ctrl+S）' : '无未保存的改动'}
            >
              <Save size={13} /> {saving ? '保存中…' : (dirty ? '保存' : '已保存')}
            </Button>
            <Button variant="secondary" onClick={() => setTplOpen(true)} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium transition-colors" title="套用经典结构模板快速搭建大纲">
              <Layers size={14} /> 模板库
            </Button>
            <Button onClick={addRecord} variant="primary" size="md" className="flex items-center text-13">
              <Plus size={14} /> 新建{noun}
            </Button>
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
          <HelpPopover title="结构对照 · 怎么用" width="22rem">
            {'只读参考条：把所选结构模板的节拍按全书章数折算成章号范围，'
              + '写细纲时可以对着看「这一章落在故事的哪一拍」——当前编辑章所在的拍会高亮。\n\n'
              + '· 模板在「创意写作」面板或检查工具「全书结构配比」里选择，这里跟随同一份选择、不单独存；\n'
              + '· 折算依据是细纲卡数（以及手填章节号里的最大值），选「不使用结构模板」时本条不显示；\n'
              + '· 分卷大纲页不显示——模板是全书章数口径，对卷数折算没有参考意义。'}
          </HelpPopover>
        </div>
      )}

      {/* 🔴 2026-09-22 六维审计 P2：内联长度走 `foldVh()`（原来手抄等价式，见 `CharacterSheet` 同处说明）。 */}
      <div className="flex gap-5" style={{ minHeight: contentMinH(OUTLINE_SHEET_CHROME_PX) }}>
        {/* 目录列表 */}
        <div className="w-52 shrink-0 space-y-1.5">
          {records.map((rec, i) => {
            const isActive = activeId === rec.id
            const isDirty = isActive && dirty
            return (
              <div
                key={rec.id}
                onClick={() => setActiveId(rec.id)}
                className={`group cursor-pointer rounded-lg border px-2.5 py-2.5 transition-all duration-150
                  ${isActive
                    ? 'bg-amber/10 border-amber/30 text-amber'
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
          {records.length === 0 && (
            <div className="text-center text-ink-500 text-12 py-10 border border-dashed border-ink-700 rounded-lg leading-relaxed">
              还没有{noun}大纲<br />
              <span className="text-11">点击右上角「新建{noun}」开始</span>
            </div>
          )}
        </div>

        {/* 编辑区：全宽双栏 */}
        <div className="flex-1 min-w-0">
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
                  
                  title={`复制当前${noun}大纲为新${noun}`} variant="secondary" size="md" className="flex items-center text-11">
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
                              <div className="text-12 font-medium text-ink-100">{field.name}</div>
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

      {tplOpen && (
        <TemplateLibrary
          tabId={tab.id}
          isVolume={isVolume}
          onApplied={() => setReloadKey(k => k + 1)}
          onClose={() => setTplOpen(false)}
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

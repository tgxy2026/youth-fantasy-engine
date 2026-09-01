import { useEffect, useState, useCallback, useRef, useMemo, type MouseEvent as ReactMouseEvent } from 'react'
import type { TabDef, TableRow, CalendarDef } from '../lib/types'
import { getTableRows, saveTableRow, deleteTableRow, getCurrentProjectId, getSetting, setSetting, getCustomOptions, getAllChapterLedgerRows, type CustomOptionPayload } from '../lib/db'
import { SABC_LABELS, isVolumeLedgerTab, type VisCtx } from '../lib/schema'
import { AUTONUM_GROUPS, nextAutoCode } from '../lib/autoCode'
import { uid } from '../lib/id'
import { Plus, Trash2, Info, Link2, Save, Check, Calendar, Table2, PenLine, Hash, Users, ChevronDown, ChevronRight, AlertTriangle, Network, Sparkles, GitBranch } from 'lucide-react'
import CustomSelect, { CUSTOM_OPTIONS_EVENT, resolveOptions } from './CustomSelect'
import HistoryTimeline from './HistoryTimeline'
import StoryTimeline from './StoryTimeline'
import StorylineView from './StorylineView'
import StoryDateInput from './StoryDateInput'
import CalendarPicker from './CalendarPicker'
import RelationGraph from './RelationGraph'
import FactionGraph from './FactionGraph'
import CharacterSelect from './CharacterSelect'
import TableRefSelect from './TableRefSelect'
import CalendarSelect from './CalendarSelect'
import HelpPopover from './HelpPopover'
import AITemplateFill from './AITemplateFill'
import AIOrganize from './AIOrganize'
import type { TemplateField } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT, aiCapabilityOf } from '../lib/aiScope'
import FeedbackAIPanel from './FeedbackAIPanel'
import TermDedupPanel from './TermDedupPanel'
import { confirmDialog } from './dialogs'
import { Button } from './Button'

interface Props {
  tab: TabDef
  onNavigate?: (id: string, chapterId?: string) => void
  /** 可见性上下文：透传给角色选择下拉 / AI 整理，控制 NPC 角色卡与跨表引用范围 */
  ctx: VisCtx
  /** 数据体检 / 跨组件跳转带下来的目标行 id：挂载后滚动并高亮该行 */
  focusRowId?: string | null
  /** 高亮消费完毕后回调，用于清除上层 focusRowId 以便重复跳转 */
  onFocusConsumed?: () => void
}

/**
 * 编号自然排序键：数字段补零后拼接，使 "F2" < "F10"、"9" < "10"
 * 返回 null 表示编号为空或纯文字（无法参与编号排序）
 */
function codeSortKey(s: string | undefined): string | null {
  if (!s || !s.trim()) return null
  const raw = s.trim()
  if (!/\d/.test(raw)) return null
  return raw.replace(/\d+/g, m => m.padStart(8, '0'))
}

/**
 * 表格自动排序规则：
 * - 有「编号」/「章节号」列的表格：按编号升序，编号空白的行自动沉底
 * - 无编号列的表格：按最后编辑时间降序（最近编辑的排最前）
 */
function sortRows(tab: TabDef, rows: TableRow[]): TableRow[] {
  const list = [...rows]
  // 按创建时间倒序：越新创建的行越靠上（章节总表等"后写的在最前"场景）
  if (tab.newestFirst) {
    const key = (r: TableRow) => r.createdAt ?? r.order ?? 0
    list.sort((a, b) => key(b) - key(a))
    return list
  }
  const idCol = tab.columns?.find(c => c.name === '编号' || c.name === '章节号')?.name
  if (idCol) {
    const key = (r: TableRow) => codeSortKey(r.data[idCol])
    list.sort((a, b) => {
      const ka = key(a), kb = key(b)
      if (!ka && !kb) return 0
      if (!ka) return 1   // 空白编号沉底
      if (!kb) return -1
      return ka.localeCompare(kb)
    })
  } else {
    list.sort((a, b) => (b.updatedAt ?? b.order ?? 0) - (a.updatedAt ?? a.order ?? 0))
  }
  return list
}

/** 人物关系中内容较长的列：编辑面板中占满整行 */
const LONG_REL_COLS = new Set([
  '关系现状', '知情度（互相知道什么）', '关系起点/契机',
  '演变轨迹（按卷）', '演变触发事件', '关系终点', '戏剧功能', '备注',
])

/** 特殊行的自动着色规则 */
function rowBadgeClass(tabId: string, data: Record<string, string>): string | null {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const found = Object.entries(data).find(([kk]) => kk.includes(k))
      if (found) return found[1]
    }
    return ''
  }
  if (tabId === 'relations') {
    const t = get('关系类型')
    if (t.includes('敌对') || t.includes('恩怨')) return 'bg-red-500/5'
    if (t.includes('CP') || t.includes('感情')) return 'bg-pink-500/5'
    if (t.includes('盟友')) return 'bg-emerald-500/5'
    if (t.includes('亲属') || t.includes('师徒')) return 'bg-sky-500/5'
  }
  if (tabId === 'foreshadow') {
    const s = get('状态'), imp = get('重要度')
    if (s === '已回收') return 'bg-emerald-500/5'
    if (imp === '全书级') return 'bg-amber/5'
  }
  if (tabId === 'changelog') {
    const s = get('已发布章节冲突')
    if (s === '有-未处理') return 'bg-red-500/10'
  }
  if (tabId === 'secrets') {
    const r = get('泄露风险')
    if (r === '高') return 'bg-red-500/10'
    if (r === '中') return 'bg-amber/10'
  }
  if (tabId === 'progress') {
    const s = get('完成状态')
    if (s === '断更') return 'bg-red-500/10'
    if (s === '超额') return 'bg-emerald-500/5'
  }
  return null
}

/**
 * 表格文本单元格：自动换行、随内容撑高，但最多约 3 行（≈78px）即封顶并裁切；
 * 超长内容通过原生 title 在悬停时以"小窗"展示全文，避免表格行高被无限撑大。
 */
function CellTextarea({ value, onChange, invalid, title }: {
  value: string
  onChange: (v: string) => void
  invalid?: boolean
  title?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    const MAX = 78 // 约 3 行高度，超过则截断（由悬停 title 展示全文）
    ta.style.height = Math.min(ta.scrollHeight, MAX) + 'px'
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      rows={1}
      title={title ?? value}
      className={`!py-1 text-[12px] w-full whitespace-pre-wrap break-words resize-none overflow-hidden bg-transparent ${invalid ? '!border-red-500/60 text-red-300' : ''}`}
    />
  )
}

export default function TableSheet({ tab, onNavigate, ctx = { type: 'full', features: [] }, focusRowId, onFocusConsumed }: Props) {
  const [rows, setRows] = useState<TableRow[]>([])
  // 数据体检 / 跨组件跳转：聚焦并高亮目标行
  const [hlRowId, setHlRowId] = useState<string | null>(null)
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const [loaded, setLoaded] = useState(false)
  // history / timeline 两个页签提供"表格 ⇄ 时间轴"视图切换
  const isTimelineCapable = tab.id === 'history' || tab.id === 'timeline'
  // 人物关系 / 势力关系 提供"关系图"视图
  const isGraphCapable = tab.id === 'relations' || tab.id === 'faction-rels'
  // 伏笔追踪提供"剧情线"视图（聚合伏笔 + 爽点 + 时间脉络，v1.6.1）
  const isStorylineCapable = tab.id === 'foreshadow'
  // 章节总表：只读汇总视图（聚合所有卷台账），不可直接编辑，编辑请到各卷子表
  const isMaster = tab.id === 'chapter-master'
  const [viewMode, setViewMode] = useState<'table' | 'timeline' | 'graph' | 'storyline'>('table')
  // 历法配置（项目级多历法数值体系），时间轴按数值判定跨历法先后顺序
  const [calendars, setCalendars] = useState<CalendarDef[]>([{ name: '灵历', value: 0 }])
  // draft = 未保存的编辑态（key=行id, value=该行字段副本）
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // 人物关系分组视图：分组（人物名）与关系行的展开状态
  const [relGroupOpen, setRelGroupOpen] = useState<Set<string>>(new Set())
  const [relRowOpen, setRelRowOpen] = useState<Set<string>>(new Set())
  // 编号防重复：已删除不复用的编号（按项目+页签持久化）
  const [retiredCodes, setRetiredCodes] = useState<Set<string>>(new Set())
  // 编号校验错误提示（保存时校验，展示在页签顶部）
  const [codeError, setCodeError] = useState<string | null>(null)
  // 编号列名（仅「编号」列参与防重复校验；「章节号」由系统自动生成，不校验）
  const codeCol = tab.columns?.find(c => c.name === '编号')?.name
  // AI 入口：本表适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()
  const [showFill, setShowFill] = useState(false)
  const [showOrganize, setShowOrganize] = useState(false)
  /** 行级「AI 补全本行空白」：只针对这一行、只填仍为空的单元格，绝不越界到其他行/表 */
  const [fillRow, setFillRow] = useState<TableRow | null>(null)
  // 读者反馈 / 名词术语的专属 AI 入口（独立于补全/整理能力矩阵）
  const [showFeedbackAI, setShowFeedbackAI] = useState(false)
  const [showDedupAI, setShowDedupAI] = useState(false)
  const tableFields = useMemo<TemplateField[]>(
    () => (tab.columns ?? []).filter(c => !c.hidden).map(c => ({ key: c.name, label: c.name, locked: c.name === codeCol })),
    [tab.id, codeCol],
  )
  // 保存闪烁定时器（卸载时清理，防止组件卸载后仍触发 setState）
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  // 用 ref 持有最新草稿与行数据，避免切换页签时因 effect 闭包过期而丢失未保存草稿
  const draftsRef = useRef(drafts)
  const rowsRef = useRef(rows)
  const tabIdRef = useRef(tab.id)
  useEffect(() => { draftsRef.current = drafts }, [drafts])
  useEffect(() => { rowsRef.current = rows }, [rows])

  // 跨组件跳转聚焦：数据体检「跳转修复」/ 地图「跳到地理风物」带 rowId 时，滚动到该行并高亮
  useEffect(() => {
    if (!focusRowId) return
    const el = rowRefs.current[focusRowId]
    if (!el) return
    setHlRowId(focusRowId)
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(() => {
      setHlRowId(null)
      onFocusConsumed?.()
    }, 2600)
    return () => clearTimeout(timer)
  }, [focusRowId, rows])

  // 列宽（按表独立记忆）：表头可拖拽调整，默认列宽更合理
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(`yfe-colw::${tab.id}`) || '{}') } catch { return {} }
  })
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null)
  // 表头筛选：每列一个关键字，行内该列命中即保留
  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  /**
   * 各下拉列的「自定义选项」载荷（用户新增项 / 隐藏项 / 内置改名）。
   * 表头筛选下拉必须与行内 CustomSelect 用同一口径（resolveOptions）渲染，
   * 否则用户新增的自定义值在筛选里看不到（1.9.1 修复）。
   */
  const [customOpts, setCustomOpts] = useState<Record<string, CustomOptionPayload>>({})

  const defaultColWidth = (col: { name: string; type?: string }) => {
    if (col.name === '编号' || col.name === '章节号') return 110
    if (col.type === 'date') return 220
    if (col.type === 'calendar') return 150
    if (col.type === 'select') return 134
    return 178
  }
  const widthOf = (colName: string) => {
    const c = tab.columns?.find(x => x.name === colName)
    if (!c) return 160
    return colWidths[colName] ?? defaultColWidth(c)
  }
  const onResizeStart = (e: ReactMouseEvent, colName: string) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { col: colName, startX: e.clientX, startW: widthOf(colName) }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const w = Math.max(90, Math.min(640, Math.round(dragRef.current.startW + dx)))
      setColWidths(prev => ({ ...prev, [dragRef.current!.col]: w }))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { localStorage.setItem(`yfe-colw::${tab.id}`, JSON.stringify(colWidthsRef.current)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => () => clearTimeout(savedTimer.current), [])

  useEffect(() => {
    // 切到别的页签前，把当前页签未保存的表格草稿逐行落库（之前会静默丢弃）
    const prevId = tabIdRef.current
    const prevDrafts = draftsRef.current
    if (prevId !== tab.id && prevDrafts && Object.keys(prevDrafts).length > 0) {
      const prevRows = rowsRef.current
      for (const rowId of Object.keys(prevDrafts)) {
        const orig = prevRows.find(r => r.id === rowId)
        if (orig) void saveTableRow({ ...orig, data: { ...orig.data, ...prevDrafts[rowId] } })
      }
    }
    tabIdRef.current = tab.id
    const loadRows = tab.id === 'chapter-master'
      ? getAllChapterLedgerRows()
      : getTableRows(tab.id)
    loadRows.then(r => {
      setRows(r)
      setLoaded(true)
    })
    setViewMode('table')
    setRelGroupOpen(new Set())
    setRelRowOpen(new Set())
    setCodeError(null)
    setDrafts({}) // 新页签从干净草稿开始（旧草稿已落库）
    if (codeCol) {
      getSetting<string[]>(`retiredCodes::${tab.id}`, []).then(list => setRetiredCodes(new Set(list)))
    }
    if (tab.id === 'history' || tab.id === 'timeline') {
      // 加载历法配置；兼容旧版单值 calendarName：若存在则迁移为多历法
      getSetting<CalendarDef[]>('calendars', []).then(list => {
        if (list && list.length > 0) { setCalendars(list); return }
        getSetting<string>('calendarName', '').then(old => {
          if (old && old.trim()) {
            const migrated = [{ name: old.trim(), value: 0 }]
            setCalendars(migrated)
            setSetting('calendars', migrated)
            setSetting('calendarName', '')
          }
        })
      })
    }
  }, [tab.id]) // eslint-disable-line

  const saveCalendars = (next: CalendarDef[]) => {
    setCalendars(next)
    setSetting('calendars', next)
  }

  const dirtyKeys = Object.keys(drafts)

  const setCellDraft = (rowId: string, colName: string, value: string) => {
    setDrafts(prev => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? rows.find(r => r.id === rowId)?.data ?? {}), [colName]: value },
    }))
    setSaved(false)
    // 用户修改了编号相关内容时清除上次的校验错误提示
    if (codeError) setCodeError(null)
  }

  /**
   * 编号唯一性校验（保存前调用）：
   * - 合并 draft 后逐行提取编号，检测多行重复
   * - 编号若命中「已删除不复用」的退役编号池，同样阻止保存
   * 返回错误信息（null 表示通过）
   */
  const validateCodes = (): string | null => {
    if (!codeCol) return null
    const owner = new Map<string, number>()
    for (const r of rows) {
      const code = ((drafts[r.id]?.[codeCol] ?? r.data[codeCol] ?? '') as string).trim()
      if (!code) continue
      owner.set(code, (owner.get(code) ?? 0) + 1)
    }
    const errs: string[] = []
    for (const [code, count] of owner) {
      if (retiredCodes.has(code)) {
        errs.push(`「${code}」是已删除条目用过的编号（编号不复用），请换一个`)
      } else if (count > 1) {
        errs.push(`「${code}」被 ${count} 行重复使用`)
      }
    }
    return errs.length > 0 ? errs.join('；') : null
  }

  /** 行删除时，将其编号登记进「退役编号池」（不复用）。支持批量，避免多次写入互相覆盖 */
  const retireCodes = async (targets: TableRow[]) => {
    if (!codeCol) return
    const next = new Set(retiredCodes)
    let changed = false
    for (const row of targets) {
      const code = ((drafts[row.id]?.[codeCol] ?? row.data[codeCol] ?? '') as string).trim()
      if (code && !next.has(code)) { next.add(code); changed = true }
    }
    if (!changed) return
    setRetiredCodes(next)
    await setSetting(`retiredCodes::${tab.id}`, [...next])
  }

  const saveAll = useCallback(async () => {
    if (dirtyKeys.length === 0) return
    // 编号防重复校验：不通过则拒绝保存并提示
    const err = validateCodes()
    if (err) {
      setCodeError(err)
      setSaving(false)
      return
    }
    setCodeError(null)
    setSaving(true)
    for (const rowId of dirtyKeys) {
      const orig = rows.find(r => r.id === rowId)
      if (!orig) continue
      const merged = { ...orig.data, ...drafts[rowId] }
      await saveTableRow({ ...orig, data: merged })
    }
    // 提交后合并回 rows，清空 drafts
    setRows(prev => prev.map(r => drafts[r.id] ? { ...r, data: { ...r.data, ...drafts[r.id] } } : r))
    setDrafts({})
    setSaving(false)
    setSaved(true)
    clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 1500)
  }, [dirtyKeys, drafts, rows, retiredCodes, codeCol, tab.id])

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirtyKeys.length > 0) saveAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirtyKeys, saveAll])

  const addRow = async () => {
    const data: Record<string, string> = {}
    tab.columns!.forEach(col => { data[col.name] = '' })
    // 自动编号：世界构建 / 创作管理 / 运营维护 分组下带「编号」列的表，新增行自动续号（4 位补零，从 0001 起）
    if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
      data[codeCol] = nextAutoCode(tab.id, rows, drafts, codeCol)
    }
    const row: TableRow = { id: uid(), projectId: getCurrentProjectId(), tabId: tab.id, data, order: rows.length, createdAt: Date.now() }
    await saveTableRow(row)
    setRows([...rows, row])
    // 人物关系：新增的空行落在「未命名关系」分组，自动展开并定位到该行编辑
    if (tab.id === 'relations') {
      setRelGroupOpen(prev => new Set(prev).add('rel-__unnamed__'))
      setRelRowOpen(prev => new Set(prev).add(row.id))
    }
  }

  const removeRow = async (rowId: string) => {
    if (!await confirmDialog({ title: '删除这一行', message: '确定删除这一行？', danger: true })) return
    const target = rows.find(r => r.id === rowId)
    if (target) await retireCodes([target])  // 编号登记进退役池，防止复用
    await deleteTableRow(rowId)
    setRows(rows.filter(r => r.id !== rowId))
    setDrafts(prev => {
      const next = { ...prev }
      delete next[rowId]
      return next
    })
  }

  // AI 补全：建行（自动编号）+ 用模型补全的单元格值填充各列（编号列 locked，不覆盖）
  const handleFill = async (values: Record<string, string>) => {
    const data: Record<string, string> = {}
    tab.columns!.forEach(col => { data[col.name] = '' })
    if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
      data[codeCol] = nextAutoCode(tab.id, rows, drafts, codeCol)
    }
    const row: TableRow = { id: uid(), projectId: getCurrentProjectId(), tabId: tab.id, data, order: rows.length, createdAt: Date.now() }
    await saveTableRow(row)
    setRows([...rows, row])
    for (const [k, v] of Object.entries(values)) {
      if (k !== codeCol) setCellDraft(row.id, k, v)
    }
    setShowFill(false)
  }

  /**
   * AI 补全本行空白：只把当前行「仍未填写（含未保存草稿为空）」的单元格交给 AI 结果回填，
   * 已填的单元格一律不动 —— 作用域严格限定在「当前表 / 这一行」，不影响其他行或其他表（如种族生物）。
   */
  const handleFillRow = (row: TableRow, values: Record<string, string>) => {
    for (const [k, v] of Object.entries(values)) {
      if (k === codeCol) continue
      const cur = ((drafts[row.id]?.[k] ?? row.data[k] ?? '') as string).trim()
      if (!cur) setCellDraft(row.id, k, v)
    }
    setFillRow(null)
  }

  /**
   * AI 整理：批量落盘新条目。
   * 直接写库（不进 drafts）—— 整理出来的是已确认的事实条目，作者在弹窗里已逐条勾选过，
   * 再让他手动按一次「保存」纯属多余；写完仍可在表格里继续改。
   * 编号在循环内累加计算，避免多行拿到同一个编号。
   */
  const handleOrganize = async (newRows: Record<string, string>[]) => {
    const created: TableRow[] = []
    for (const vals of newRows) {
      const data: Record<string, string> = {}
      tab.columns!.forEach(col => { data[col.name] = vals[col.name] ?? '' })
      if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
        data[codeCol] = nextAutoCode(tab.id, [...rows, ...created], drafts, codeCol)
      }
      const row: TableRow = {
        id: uid(),
        projectId: getCurrentProjectId(),
        tabId: tab.id,
        data,
        order: rows.length + created.length,
        createdAt: Date.now(),
      }
      await saveTableRow(row)
      created.push(row)
    }
    setRows(prev => [...prev, ...created])
    // 关系网分组视图：把新整理出的关系所属分组展开，作者一眼能看到成果
    if (tab.id === 'relations') {
      setRelGroupOpen(prev => {
        const next = new Set(prev)
        created.forEach(r => {
          const a = (r.data['人物A'] ?? '').trim()
          const b = (r.data['人物B'] ?? '').trim()
          if (a) next.add(`rel-${a}`)
          if (b) next.add(`rel-${b}`)
        })
        return next
      })
    }
  }

  // 自动排序：有编号列按编号升序（空白沉底），否则按最后编辑时间降序
  // 注意：必须在所有提前 return 之前调用，否则违反 Hooks 规则导致黑屏崩溃
  const sortedRows = useMemo(
    () => sortRows(tab, rows.map(r => ({ ...r, data: { ...r.data, ...(drafts[r.id] ?? {}) } }))),
    [tab, rows, drafts],
  )

  /**
   * 人物关系：按人物分组视图。
   * 每条关系会同时归入「人物A」与「人物B」两个文件夹；人物不存在时自动新建文件夹。
   * 人物A/人物B 均未填写的行归入「未命名关系」待整理区。
   */
  const relationGroups = useMemo(() => {
    if (tab.id !== 'relations') return [] as { key: string; name: string; rows: TableRow[]; unnamed?: boolean }[]
    const map = new Map<string, TableRow[]>()
    const unnamed: TableRow[] = []
    for (const row of sortedRows) {
      const a = (row.data['人物A'] ?? '').trim()
      const b = (row.data['人物B'] ?? '').trim()
      if (!a && !b) { unnamed.push(row); continue }
      if (a) { const arr = map.get(a); arr ? arr.push(row) : map.set(a, [row]) }
      if (b && b !== a) { const arr = map.get(b); arr ? arr.push(row) : map.set(b, [row]) }
    }
    const groups: { key: string; name: string; rows: TableRow[]; unnamed?: boolean }[] = [...map.entries()]
      .map(([name, rs]) => ({ key: `rel-${name}`, name, rows: rs }))
      .sort((x, y) => y.rows.length - x.rows.length || x.name.localeCompare(y.name, 'zh'))
    if (unnamed.length > 0) {
      groups.unshift({ key: 'rel-__unnamed__', name: '未命名关系（待填写人物A/人物B）', rows: unnamed, unnamed: true })
    }
    return groups
  }, [tab.id, sortedRows])

  // 获取某行的当前值（draft 优先于已保存）
  const cellVal = (r: TableRow, colName: string) => {
    if (drafts[r.id] && colName in drafts[r.id]) return drafts[r.id][colName]
    return r.data[colName] ?? ''
  }
  // 表头筛选：仅保留在筛选列上命中关键字的行
  // 下拉（select）列用精确匹配选项；文本列用包含匹配
  const selectCols = useMemo(
    () => (tab.columns ?? []).filter(c => !c.hidden && c.type === 'select' && c.options),
    [tab.columns]
  )
  const selectColNames = useMemo(() => new Set(selectCols.map(c => c.name)), [selectCols])

  /**
   * 装载各下拉列的自定义选项；并监听 CUSTOM_OPTIONS_EVENT，
   * 让用户在行内下拉里新增/删除/改名后，表头筛选下拉立刻同步。
   */
  const loadCustomOpts = useCallback(async () => {
    if (selectCols.length === 0) return
    const entries = await Promise.all(
      selectCols.map(async c => [c.name, await getCustomOptions(tab.id, c.name)] as const)
    )
    setCustomOpts(Object.fromEntries(entries))
  }, [selectCols, tab.id])

  useEffect(() => { void loadCustomOpts() }, [loadCustomOpts])

  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; colName: string }>).detail
      if (d && d.tabId !== tab.id) return
      void loadCustomOpts()
    }
    window.addEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
  }, [loadCustomOpts, tab.id])

  /**
   * 表头筛选下拉的候选值：与行内 CustomSelect 完全同口径
   * （内置项去掉 hidden、应用 renamed，再拼上用户自定义项，同名去重）。
   */
  const filterOptionsOf = (col: (typeof selectCols)[number]) =>
    resolveOptions(col.options ?? [], customOpts[col.name] ?? { items: [], hidden: [] })
      .map(o => o.name)
  const filteredRows = useMemo(() => {
    const active = Object.entries(colFilters).filter(([, v]) => (v ?? '').trim().length > 0)
    if (active.length === 0) return sortedRows
    return sortedRows.filter(r => active.every(([col, v]) => {
      const cell = (cellVal(r, col) ?? '').trim()
      if (selectColNames.has(col)) return cell === v.trim() // 下拉列：精确匹配选中项
      return cell.toLowerCase().includes(v.trim().toLowerCase()) // 文本列：包含匹配
    }))
  }, [sortedRows, colFilters, selectColNames])

  /**
   * 自引用父级列（同一表内的上下级隶属）：国家势力·上级 / 地理风物·层级归属。
   * 检测到即把表格渲染成可折叠的树（缩进 + 折叠箭头），并提供「在其下新增子条目」。
   */
  const parentCol = useMemo(
    () => (tab.columns?.find(c => c.type === 'tableRef' && c.refTab === tab.id)?.name) ?? null,
    [tab],
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (id: string) =>
    setCollapsed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  // 树形层级计算（仅当存在自引用父级列时）
  const tree = useMemo(() => {
    if (!parentCol) return null
    const dCol = tab.displayCol ?? '名称'
    const nameOf = (r: TableRow) => ((drafts[r.id]?.[dCol] ?? r.data[dCol] ?? '') as string).trim()
    const parentOf = (r: TableRow) => ((drafts[r.id]?.[parentCol] ?? r.data[parentCol] ?? '') as string).trim()
    const byName = new Map<string, TableRow>()
    for (const r of filteredRows) {
      const n = nameOf(r)
      if (n && !byName.has(n)) byName.set(n, r)
    }
    const childrenByRowId = new Map<string, TableRow[]>()
    for (const r of filteredRows) {
      const p = parentOf(r)
      if (!p) continue
      const pr = byName.get(p)
      if (!pr) continue // 父级不在本表名称中 → 视为根
      const arr = childrenByRowId.get(pr.id) ?? []
      arr.push(r); childrenByRowId.set(pr.id, arr)
    }
    const descendantNames = (rowId: string, acc: Set<string>) => {
      for (const k of childrenByRowId.get(rowId) ?? []) {
        const n = nameOf(k); if (n) acc.add(n)
        descendantNames(k.id, acc)
      }
    }
    const order: { row: TableRow; depth: number; hasChildren: boolean }[] = []
    const visited = new Set<string>()
    const walk = (r: TableRow, depth: number) => {
      if (visited.has(r.id)) return // 防环（异常数据时也不会死循环）
      visited.add(r.id)
      const kids = childrenByRowId.get(r.id) ?? []
      order.push({ row: r, depth, hasChildren: kids.length > 0 })
      if (!collapsed.has(r.id)) for (const k of kids) walk(k, depth + 1)
    }
    for (const r of filteredRows) {
      const p = parentOf(r)
      if (!p || !byName.has(p)) walk(r, 0) // 根节点
    }
    return { order, childrenByRowId, descendantNames, nameOf }
  }, [parentCol, tab.displayCol, filteredRows, drafts, collapsed])

  const bodyRows: { row: TableRow; depth: number; hasChildren: boolean }[] =
    parentCol && tree ? tree.order : filteredRows.map(r => ({ row: r, depth: 0, hasChildren: false }))

  /** 在指定父级下新增子条目：新建一行并预置父级列，落库即生效 */
  const addChild = (parentName: string) => {
    if (!parentCol) return
    const dCol = tab.displayCol ?? '名称'
    const parentOf = (r: TableRow) => ((drafts[r.id]?.[parentCol] ?? r.data[parentCol] ?? '') as string).trim()
    const nameOf = (r: TableRow) => ((drafts[r.id]?.[dCol] ?? r.data[dCol] ?? '') as string).trim()
    const data: Record<string, string> = {}
    tab.columns!.forEach(col => { data[col.name] = '' })
    data[parentCol] = parentName
    if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
      // 子条目编号 = 父级编号 + "-NNN"（如 N0001 → N0001-001）；父级顺序自动编号规则不变
      const parentRow = rows.find(r => nameOf(r) === parentName)
      const parentCode = parentRow ? ((drafts[parentRow.id]?.[codeCol] ?? parentRow.data[codeCol] ?? '') as string).trim() : ''
      const base = parentCode || parentName
      const siblingCount = rows.filter(r => parentOf(r) === parentName).length
      data[codeCol] = `${base}-${String(siblingCount + 1).padStart(3, '0')}`
    }
    const row: TableRow = { id: uid(), projectId: getCurrentProjectId(), tabId: tab.id, data, order: rows.length, createdAt: Date.now() }
    void saveTableRow(row)
    setRows([...rows, row])
    setCollapsed(new Set()) // 确保父级处于展开态，子条目立即可见
  }

  // 表总宽 = 各列宽之和 + 序号列(40) + 操作列(48)。超出容器时由外层 overflow-x-auto 出横向滑条，
  // 而非压缩其他列（拖动某列只改它自己，不影响其余列宽）。
  const totalWidth = tab.columns
    ? tab.columns.filter(c => !c.hidden).reduce((s, c) => s + widthOf(c.name), 0) + 40 + 28
    : 0

  if (!loaded) return <div className="p-8 text-ink-400 text-sm">加载中…</div>

  const isRowDirty = (r: TableRow) => !!drafts[r.id] && Object.keys(drafts[r.id]).length > 0

  /** 编号是否无效（重复或已退役）：输入时即红框提示 */
  const isInvalidCode = (row: TableRow): boolean => {
    if (!codeCol) return false
    const code = cellVal(row, codeCol).trim()
    if (!code) return false
    if (retiredCodes.has(code)) return true
    const same = rows.filter(r => (drafts[r.id]?.[codeCol] ?? r.data[codeCol] ?? '').trim() === code)
    return same.length > 1
  }

  return (
    <div className="page-enter">
      {/* 头部 */}
      <header className="mb-5 flex items-start justify-between gap-4 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
            <HelpPopover title={`${tab.name} · 怎么用`} width="23rem" size={13}>{`这是「${tab.name}」数据表，常见操作：

• 右上「新增一行」添加记录；表格内直接点单元格编辑，改完点「保存」（或 Ctrl+S）。
• 列宽可拖拽：拖动列标题右缘的分隔条调整宽度，只改当前列、不挤压其他列；整体超出页面时表格底部出现横向滑条。
• 表头筛选（v1.9.1）：每列标题下方都有筛选框——文本列输入关键字按「包含」匹配；下拉列点开选值按「精确」匹配，候选值与行内下拉完全一致（含你自己新增的自定义值，以及被隐藏 / 改名后的内置项），在行内改动选项后表头会立即同步。
• 下拉类型的列（如状态、关系类型）点击即弹出选项，可自定义 / 重命名。
• 部分列是专用控件：真实日期列（如发布日期、写作进度日期）点开弹出月历选择；人物关系的「人物A / 人物B」从已创建角色卡中选择、不可手填。
• 带「编号 / 章节号」的表按编号自动排序，空白沉底（**章节总表例外**：按创建时间倒序，最新写的章节在最上面）；编号不可重复、删除后不复用。
• 单元格里出现 F01 / H01 这类编号，会自动生成跳转按钮，直达伏笔表 / 历史事件。
• 历史事件、时间脉络页签可在右上「表格 ⇄ 时间轴」切换视图；时间轴可设历法名（点历法框旁的 ? 了解）。
• 人物关系按「人物A / 人物B」自动归入双方文件夹，便于按人查阅；右上「表格 ⇄ 关系图」可切换关系图。
• 关系图交互（v1.6）：**拖动节点**微调布局、**拖拽空白处平移**画布、**滚轮缩放**（0.4x–3x）、**点击节点收起/展开**其关系边；工具栏有放大/缩小/重置视图；底部图例按关系类型着色——自定义的关系类型也有专属颜色。
• 伏笔追踪可切到「剧情线」视图（v1.6.1）：自动聚合伏笔（埋设/回收）、爽点、时间脉络事件，按章节串成一条叙事主线；顶部统计悬空伏笔与「已到点未回收」的警示。
• 带「上级 / 层级归属」列的表（国家势力、地理风物、种族生物、物品资源、历史事件、名词术语等）支持**树形层级**：按隶属关系折叠 / 展开，行首 'GitBranch' 按钮可在某条下**新增子条目**（编号形如「父编号-001」，父级顺序号不变），父级下拉自动排除自身与子孙防成环。
• 行首三个小按钮：删除此行、'Sparkles' 用 AI 补全**本行空白**（只填当前行未填字段，不影响其他行 / 表）、'GitBranch' 新增子条目；章节总表行首另有「打开正文」按钮。
• 批量：右上「AI 整理」从章节正文 / 已有设定**批量整理**出尚未登记的条目并落盘（不重复生成）；人物关系 / 历史事件支持「清空全部」批量删除。`}</HelpPopover>
          </div>
          <p className="mt-1.5 text-[13px] text-ink-300 leading-relaxed max-w-3xl">{tab.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[11px] transition-opacity ${saved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>
            <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
          </span>
          <span className="text-[10px] text-ink-500">
            {tab.id === 'relations'
              ? `共 ${rows.length} 条关系 · ${relationGroups.filter(g => !g.unnamed).length} 位人物`
              : tab.newestFirst
                ? `共 ${filteredRows.length} 行 · 按创建时间倒序`
                : tab.columns?.some(c => c.name === '编号' || c.name === '章节号')
                  ? `共 ${filteredRows.length} 行 · 按编号排序`
                  : `共 ${filteredRows.length} 行 · 按编辑时间排序`}
          </span>
          {!isMaster && (
          <Button variant="bare"
            onClick={saveAll}
            disabled={dirtyKeys.length === 0 || saving}
            className={`flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium border transition-colors
              ${dirtyKeys.length > 0
                ? 'bg-amber/15 text-amber border-amber/40 hover:bg-amber/25'
                : 'bg-ink-800 text-ink-500 border-ink-700 cursor-not-allowed'}`}
            title={dirtyKeys.length > 0 ? '保存全部（Ctrl+S）' : '无未保存修改'}
          >
            <Save size={13} /> {saving ? '保存中…' : '保存'}
          </Button>
          )}
          {/* 多行批量删除按钮（人物关系 / 历史事件支持） */}
          {['relations', 'history'].includes(tab.id) && rows.length > 0 && (
            <Button variant="bare"
              onClick={async () => {
                if (!await confirmDialog({ title: `清空「${tab.name}」`, message: `确定清空「${tab.name}」中所有 ${rows.length} 条记录？`, danger: true })) return
                retireCodes(rows).then(() => {  // 全部编号登记进退役池，防止复用
                  rows.forEach(row => { void deleteTableRow(row.id) })
                })
                setRows([])
                setDrafts({})
              }}
              className="flex items-center gap-1.5 px-3.5 h-9 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg text-[13px] font-medium hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={14} /> 清空全部
            </Button>
          )}
          {isTimelineCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-[12px] transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('timeline')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-[12px] transition-colors
                  ${viewMode === 'timeline' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Calendar size={11} /> 时间轴
              </Button>
            </div>
          )}
          {isGraphCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-[12px] transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-[12px] transition-colors
                  ${viewMode === 'graph' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Network size={11} /> 关系图
              </Button>
            </div>
          )}
          {isStorylineCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-[12px] transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('storyline')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-[12px] transition-colors
                  ${viewMode === 'storyline' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <GitBranch size={11} /> 剧情线
              </Button>
            </div>
          )}
          {!isMaster && (
          <Button onClick={addRow} variant="primary" size="md" className="flex items-center text-[13px] shrink-0">
            <Plus size={14} /> {tab.id === 'relations' ? '新增一条关系' : '新增一行'}
          </Button>
          )}
          {aiCap !== 'none' && !isMaster && (
            <Button variant="secondary" onClick={() => (aiCap === 'organize' ? setShowOrganize(true) : setShowFill(true))} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={ !aiReady ? AI_DISABLED_HINT : aiCap === 'organize' ? '让 AI 从章节正文 / 已有设定中整理出尚未登记的条目（不会重复生成）' : '新建一行，并提供粗略设定由 AI 补全（不影响已有行 / 其他表）' }>
              <Sparkles size={14} /> {aiCap === 'organize' ? 'AI 整理' : 'AI 补全'}
            </Button>
          )}
          {/* 读者反馈：AI 分析（运营维护组，不接补全/整理，单独开分析入口） */}
          {tab.id === 'feedback' && (
            <Button variant="secondary" onClick={() => setShowFeedbackAI(true)} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '用 AI 分析读者反馈数据：流失归因 + 应对建议'}>
              <Sparkles size={14} /> AI 分析反馈
            </Button>
          )}
          {/* 名词术语：AI 查重（在「AI 补全」之外，额外提供同义/重复归一入口） */}
          {tab.id === 'terms' && (
            <Button variant="secondary" onClick={() => setShowDedupAI(true)} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[13px] font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '用 AI 查找同义/重复的术语，建议合并归一'}>
              <Sparkles size={14} /> AI 查重
            </Button>
          )}
        </div>
      </header>

      {/* 编号规则说明（有编号列的表格展示，防止编号混乱无法识别） */}
      {tab.codeRule && (
        <div className="mb-4 rounded-lg border border-amber/20 bg-amber/5 px-3.5 py-2.5 flex items-start gap-2">
          <Hash size={12} className="mt-0.5 shrink-0 text-amber/80" />
          <span className="text-[11.5px] text-amber/80 leading-relaxed">{tab.codeRule}</span>
        </div>
      )}

      {/* 编号校验错误：存在重复/退役编号时阻止保存并提示修改 */}
      {codeError && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 flex items-start gap-2 animate-pulse">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red-400" />
          <span className="text-[11.5px] text-red-300 leading-relaxed">
            <b>编号校验未通过，无法保存：</b>{codeError}。请修改编号后重新保存。
          </span>
        </div>
      )}

      {/* history / timeline 页签可切到时间轴视图；人物关系可切到关系图 */}
      {viewMode === 'graph' ? (
        tab.id === 'faction-rels' ? <FactionGraph rows={rows} onNavigate={onNavigate} /> : <RelationGraph rows={rows} />
      ) : viewMode === 'storyline' && tab.id === 'foreshadow' ? (
        <StorylineView />
      ) : viewMode === 'timeline' && tab.id === 'history' ? (
        <HistoryTimeline rows={rows} tab={tab} calendars={calendars} />
      ) : viewMode === 'timeline' && tab.id === 'timeline' ? (
        <StoryTimeline rows={rows} tab={tab} calendars={calendars} />
      ) : tab.id === 'relations' ? (
        /* ============ 人物关系：按人物分组的文件夹视图 ============ */
        <div className="space-y-2.5">
          {rows.length === 0 && (
            <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-16 text-center text-ink-500">
              <div className="flex flex-col items-center gap-2">
                <Users size={20} className="text-ink-600" />
                <span>还没有人物关系，点击右上角「新增一行」开始</span>
              </div>
            </div>
          )}
          {relationGroups.map(g => {
            const gOpen = relGroupOpen.has(g.key)
            return (
              <div key={g.key} className={`rounded-xl border overflow-hidden ${g.unnamed ? 'border-dashed border-ink-600 bg-ink-850/50' : 'border-ink-700 bg-ink-850'}`}>
                <Button variant="bare"
                  onClick={() => {
                    const next = new Set(relGroupOpen)
                    if (next.has(g.key)) next.delete(g.key); else next.add(g.key)
                    setRelGroupOpen(next)
                  }}
                  className="w-full !flex items-center gap-2 px-3.5 py-2.5 hover:bg-ink-800/60 transition-colors text-left !justify-start"
                >
                  <span className="text-ink-500">{gOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  <Users size={12} className="text-amber/80 shrink-0" />
                  <span className="text-[13px] font-semibold text-ink-100 truncate">{g.name}</span>
                  <span className="text-[10px] text-ink-500 shrink-0">{g.rows.length} 条关系</span>
                </Button>
                {gOpen && (
                  <div className="border-t border-ink-700/60 px-3 py-2.5 space-y-2">
                    {g.rows.map(row => {
                      const a = (row.data['人物A'] ?? '').trim()
                      const other = a === g.name ? (row.data['人物B'] ?? '').trim() : a
                      const type = row.data['关系类型'] ?? ''
                      const status = row.data['关系现状'] ?? ''
                      const rOpen = relRowOpen.has(row.id)
                      const bg = rowBadgeClass(tab.id, row.data)
                      const dirty = isRowDirty(row)
                      return (
                        <div key={row.id} className={`group rounded-lg border ${bg ?? ''} ${dirty ? 'border-amber/40' : 'border-ink-700/70'} hover:border-ink-600 transition-colors`}>
                          <div className="flex items-center gap-2 px-3 py-2">
                            <Button variant="bare"
                              onClick={() => {
                                const next = new Set(relRowOpen)
                                if (next.has(row.id)) next.delete(row.id); else next.add(row.id)
                                setRelRowOpen(next)
                              }}
                              className="flex-1 !flex items-center gap-2 min-w-0 text-left !justify-start"
                            >
                              <span className="text-ink-500 shrink-0">{rOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                              <span className="text-[12.5px] text-ink-100 font-medium truncate">↔ {other || '（未填写对方人物）'}</span>
                              {type && (
                                <span className="px-1.5 py-px text-[10px] rounded bg-ink-800 text-ink-300 border border-ink-700 shrink-0">{type}</span>
                              )}
                              {!rOpen && status && <span className="text-[11px] text-ink-500 truncate">{status}</span>}
                              {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title="有未保存修改" />}
                            </Button>
                            <Button variant="icon-danger" onClick={() => removeRow(row.id)} className="opacity-40 group-hover:opacity-100 transition-all p-1 shrink-0" title="删除此条关系">
                              <Trash2 size={12} />
                            </Button>
                            {aiCap !== 'none' && (
                              <Button variant="bare" iconOnly size="xs"
                                onClick={() => setFillRow(row)}
                                disabled={!aiReady}
                                className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="AI 补全本行空白：只填这一行未填写的字段，不影响其他行 / 表"
                              >
                                <Sparkles size={12} />
                              </Button>
                            )}
                          </div>
                          {rOpen && (
                                <div className="px-3 pb-3 pt-1 border-t border-ink-700/50 mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2.5">
                                  {tab.columns!.filter(col => !col.hidden).map(col => {
                                const val = cellVal(row, col.name)
                                const long = LONG_REL_COLS.has(col.name)
                                return (
                                  <div key={col.name} className={long ? 'md:col-span-2' : ''}>
                                    <div className="text-[10px] text-ink-500 mb-1">{col.name}</div>
                                    {col.type === 'tableRef' ? (
                                      /* 跨表引用：从来源设定表取值，禁止手动输入 */
                                      <TableRefSelect
                                        refTabId={col.refTab!}
                                        refCol={col.refCol!}
                                        value={val}
                                        onChange={v => setCellDraft(row.id, col.name, v)}
                                        placeholder={col.name}
                                      />
                                    ) : col.type === 'select' && col.options ? (
                                      <CustomSelect
                                        tabId={tab.id}
                                        colName={col.name}
                                        options={col.options}
                                        value={val}
                                        onChange={v => setCellDraft(row.id, col.name, v)}
                                        labelMap={col.name === '保密等级' ? SABC_LABELS : undefined}
                                      />
                                    ) : col.type === 'character' ? (
                                      /* 人物A / 人物B：从已创建角色卡选择，禁止手动输入 */
                                      <CharacterSelect
                                        value={val}
                                        onChange={v => setCellDraft(row.id, col.name, v)}
                                        placeholder={col.name}
                                        ctx={ctx}
                                      />
                                    ) : (
                                      <input
                                        type={col.type === 'number' ? 'number' : 'text'}
                                        value={val}
                                        onChange={e => setCellDraft(row.id, col.name, e.target.value)}
                                        placeholder={col.name}
                                        className="!py-1 text-[12px] w-full"
                                      />
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <>
      {/* 表格 */}
      <div className="rounded-xl border border-ink-700 bg-ink-850 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-[12px] table-fixed" style={{ width: totalWidth || undefined, minWidth: '100%' }}>
            <thead>
              <tr className="bg-ink-800 border-b border-ink-700">
                <th className="w-10 px-2 py-2.5 align-middle text-ink-500 text-[10px] font-medium">#</th>
                <th className="w-7 px-1 py-2.5 align-middle" />
                {tab.columns!.filter(col => !col.hidden).map(col => (
                  <th key={col.name} className="px-3 py-2 align-middle text-left text-ink-200 font-semibold whitespace-nowrap relative" style={{ width: widthOf(col.name) }}>
                    <div className="truncate">{col.name}</div>
                    {col.type === 'select' && col.options ? (
                      <select
                        value={colFilters[col.name] ?? ''}
                        onChange={e => setColFilters(prev => ({ ...prev, [col.name]: e.target.value }))}
                        className="mt-1 w-full text-[10px] px-1 py-0.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 outline-none focus:border-amber/40"
                      >
                        <option value="">全部</option>
                        {/* 与行内下拉同口径：内置（去隐藏/应用改名）+ 用户自定义项 */}
                        {filterOptionsOf(col).map(opt => (
                          <option key={opt} value={opt}>{SABC_LABELS[opt] ?? opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={colFilters[col.name] ?? ''}
                        onChange={e => setColFilters(prev => ({ ...prev, [col.name]: e.target.value }))}
                        placeholder="筛选"
                        className="mt-1 w-full text-[10px] px-1.5 py-0.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 placeholder:text-ink-600 outline-none focus:border-amber/40"
                      />
                    )}
                    <div
                      onMouseDown={e => onResizeStart(e, col.name)}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-amber/30 transition-colors"
                      title="拖拽调整列宽"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/50">
              {(rows.length === 0 || bodyRows.length === 0) && (
                <tr>
                  <td colSpan={tab.columns!.filter(c => !c.hidden).length + 2} className="px-4 py-16 text-center text-ink-500">
                    <div className="flex flex-col items-center gap-2">
                      <Plus size={20} className="text-ink-600" />
                      <span>{rows.length === 0 ? (isMaster ? '各卷台账还没有章节，去左侧各卷「章节台账」表录入即可在此汇总显示' : '还没有记录，点击右上角「新增一行」开始') : '没有符合筛选条件的记录'}</span>
                    </div>
                  </td>
                </tr>
              )}
              {bodyRows.map((entry, i) => {
                const row = entry.row
                const depth = entry.depth
                const hasChildren = entry.hasChildren
                // 合并 draft 后的最终数据，用于行底色
                const bg = rowBadgeClass(tab.id, row.data)
                const rowDirty = isRowDirty(row)
                // 章节总表 / 各卷台账联动行：id 形如 ch-<chapterId>，提供直达写作入口
                const chapterLink = (tab.id === 'chapter-master' || isVolumeLedgerTab(tab.id)) && row.id.startsWith('ch-')
                  ? row.id.slice(3) : null
                return (
                  <tr
                    key={row.id}
                    ref={el => { rowRefs.current[row.id] = el }}
                    className={`group hover:bg-ink-800/60 transition-colors ${bg ?? ''} ${rowDirty ? 'bg-amber/5' : ''} ${hlRowId === row.id ? 'ring-2 ring-emerald-400/80 bg-emerald-500/10' : ''}`}
                  >
                    <td className="px-2 py-1 text-center text-ink-500 text-[10px] relative">
                      {i + 1}
                      {rowDirty && <span className="absolute left-0 top-1 w-0.5 h-5 bg-amber rounded-r" />}
                    </td>
                    <td className="w-7 px-1 py-1 align-middle">
                      <div className="flex flex-col items-center justify-center gap-0.5 h-full">
                      {chapterLink && (
                        <Button variant="bare" iconOnly size="xs"
                          onClick={() => onNavigate?.('editor', chapterLink)}
                          className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
                          title="打开本章正文编辑"
                        >
                          <PenLine size={12} />
                        </Button>
                      )}
                      {!isMaster && (
                      <Button variant="icon-danger" onClick={() => removeRow(row.id)} className="opacity-40 group-hover:opacity-100 transition-all p-1" title="删除此行">
                        <Trash2 size={12} />
                      </Button>
                      )}
                      {aiCap !== 'none' && !isMaster && (
                        <Button variant="bare" iconOnly size="xs"
                          onClick={() => setFillRow(row)}
                          disabled={!aiReady}
                          className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                          title="AI 补全本行空白：只填这一行未填写的字段，不影响其他行 / 表"
                        >
                          <Sparkles size={12} />
                        </Button>
                      )}
                      {parentCol && tree && (
                        <Button variant="bare" iconOnly size="xs"
                          onClick={() => addChild(tree.nameOf(row))}
                          className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
                          title={`在「${tree.nameOf(row) || '该项'}」下新增子条目`}
                        >
                          <GitBranch size={12} />
                        </Button>
                      )}
                      </div>
                    </td>
                    {tab.columns!.filter(col => !col.hidden).map(col => {
                      const val = cellVal(row, col.name)
                      if (isMaster) {
                        const fh = (tab.id !== 'foreshadow' && tab.id !== 'history' && val.match(/[FH]\d+/g)) || null
                        return (
                          <td key={col.name} className="px-1 py-1 align-middle" style={{ width: widthOf(col.name) }}>
                            <div className="px-2 py-1 text-[12px] text-ink-200 whitespace-pre-wrap break-words leading-relaxed">
                              {val ? val : <span className="text-ink-600">—</span>}
                            </div>
                            {fh && (
                              <div className="flex flex-wrap gap-1 mt-0.5 px-2">
                                {fh.map(code => (
                                  <Button variant="bare"
                                    key={code}
                                    onClick={() => onNavigate?.(code.startsWith('F') ? 'foreshadow' : 'history')}
                                    className="inline-flex items-center gap-0.5 px-1.5 py-px text-[11px] rounded bg-amber/10 text-amber/90 border border-amber/25 hover:bg-amber/25 transition-colors"
                                    title={`查看 ${code}（跳转${code.startsWith('F') ? '伏笔追踪' : '历史事件'}）`}
                                  >
                                    <Link2 size={9} />{code}
                                  </Button>
                                ))}
                              </div>
                            )}
                          </td>
                        )
                      }
                      return (
                        <td key={col.name} className="px-1 py-1 align-middle" style={{ width: widthOf(col.name) }}>
                          {col.type === 'date' ? (
                            /* 严格"某年某月某日"日期输入 */
                            <StoryDateInput
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                            />
                          ) : col.type === 'calendar' ? (
                            /* 真实日历日期：弹出月历选择 */
                            <CalendarPicker
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                            />
                          ) : col.type === 'character' ? (
                            /* 角色卡单选：从已创建角色中选，禁止手动输入 */
                            <CharacterSelect
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                              placeholder={col.name}
                              ctx={ctx}
                            />
                          ) : col.type === 'characters' ? (
                            /* 角色卡多选：从已创建角色中选，禁止手动输入 */
                            <CharacterSelect
                              multi
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                              placeholder={col.name}
                              ctx={ctx}
                            />
                          ) : col.calendar ? (
                            /* 历法列：选项来自项目级历法配置，支持新增/删改/数值 */
                            <CalendarSelect
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                              calendars={calendars}
                              onCalendarsChange={saveCalendars}
                            />
                          ) : col.type === 'tableRef' ? (
                            /* 跨表引用：从来源设定表取值，禁止手动输入；自引用父级列排除自身+子孙防成环 */
                            <TableRefSelect
                              refTabId={col.refTab!}
                              refCol={col.refCol!}
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                              placeholder={col.name}
                              excludeNames={
                                parentCol && col.name === parentCol && tree
                                  ? (() => {
                                      const s = new Set<string>()
                                      const n = tree.nameOf(row)
                                      if (n) s.add(n)
                                      tree.descendantNames(row.id, s)
                                      return [...s]
                                    })()
                                  : undefined
                              }
                            />
                          ) : col.type === 'select' && col.options ? (
                            <CustomSelect
                              tabId={tab.id}
                              colName={col.name}
                              options={col.options}
                              value={val}
                              onChange={v => setCellDraft(row.id, col.name, v)}
                              labelMap={col.name === '保密等级' ? SABC_LABELS : undefined}
                            />
                          ) : col.type === 'number' ? (
                            <input
                              type="number"
                              value={val}
                              onChange={e => setCellDraft(row.id, col.name, e.target.value)}
                              className="!py-1 text-[12px] w-full bg-ink-900 border border-ink-700 rounded px-2 outline-none focus:border-amber/50"
                            />
                          ) : (
                            col.name === tab.displayCol && parentCol ? (
                              <div className="flex items-start gap-1" style={{ paddingLeft: depth * 14 }}>
                                {hasChildren ? (
                                  <Button variant="icon-amber" type="button" onClick={() => toggleCollapse(row.id)} className="mt-1 shrink-0" title={collapsed.has(row.id) ? '展开子条目' : '折叠子条目'}>
                                    {collapsed.has(row.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                  </Button>
                                ) : (
                                  <span className="mt-1 w-[11px] shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <CellTextarea
                                    value={val}
                                    onChange={v => setCellDraft(row.id, col.name, v)}
                                    invalid={col.name === codeCol && isInvalidCode(row)}
                                    title={col.name === codeCol && isInvalidCode(row) ? '编号重复或已被删除条目占用（编号不复用），保存前请修改' : undefined}
                                  />
                                  {/* 编号联动：F01 → 伏笔追踪，H01 → 历史事件 */}
                                  {tab.id !== 'foreshadow' && tab.id !== 'history' && val.match(/[FH]\d+/) && (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                      {val.match(/[FH]\d+/g)!.map(code => (
                                        <Button variant="bare"
                                          key={code}
                                          onClick={() => onNavigate?.(code.startsWith('F') ? 'foreshadow' : 'history')}
                                          className="inline-flex items-center gap-0.5 px-1.5 py-px text-[11px] rounded bg-amber/10 text-amber/90 border border-amber/25 hover:bg-amber/25 transition-colors"
                                          title={`查看 ${code}（跳转${code.startsWith('F') ? '伏笔追踪' : '历史事件'}）`}
                                        >
                                          <Link2 size={9} />{code}
                                        </Button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : (
                            <>
                              <CellTextarea
                                value={val}
                                onChange={v => setCellDraft(row.id, col.name, v)}
                                invalid={col.name === codeCol && isInvalidCode(row)}
                                title={col.name === codeCol && isInvalidCode(row) ? '编号重复或已被删除条目占用（编号不复用），保存前请修改' : undefined}
                              />
                              {/* 编号联动：F01 → 伏笔追踪，H01 → 历史事件 */}
                              {tab.id !== 'foreshadow' && tab.id !== 'history' && val.match(/[FH]\d+/) && (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                  {val.match(/[FH]\d+/g)!.map(code => (
                                    <Button variant="bare"
                                      key={code}
                                      onClick={() => onNavigate?.(code.startsWith('F') ? 'foreshadow' : 'history')}
                                      className="inline-flex items-center gap-0.5 px-1.5 py-px text-[11px] rounded bg-amber/10 text-amber/90 border border-amber/25 hover:bg-amber/25 transition-colors"
                                      title={`查看 ${code}（跳转${code.startsWith('F') ? '伏笔追踪' : '历史事件'}）`}
                                    >
                                      <Link2 size={9} />{code}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </>
                            )
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}

      {/* 底部提示 */}
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

      {dirtyKeys.length > 0 && !isMaster && (
        <div className="fixed bottom-6 right-6 z-20">
          <Button onClick={saveAll} variant="primary" solid size="md" className="flex items-center text-ink-900 transition-all animate-pulse">
            <Save size={14} /> 保存 {dirtyKeys.length} 行修改
          </Button>
        </div>
      )}

      {showFill && (
        <AITemplateFill
          fields={tableFields}
          title={`AI 补全 · ${tab.name}`}
          sketchPlaceholder="例如：北境最大的商盟，掌控三条主干商路，与皇室关系微妙，暗中资助主角……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}

      {fillRow && (
        <AITemplateFill
          fields={tableFields}
          existing={fillRow.data}
          title={`AI 补全本行空白 · ${tab.name}`}
          sketchPlaceholder="补充这一行已填内容的背景 / 细节，让 AI 补全其余空白字段（已填的不会动）…"
          onSubmit={values => handleFillRow(fillRow, values)}
          onClose={() => setFillRow(null)}
        />
      )}

      {showOrganize && (
        <AIOrganize
          tab={tab}
          existing={sortedRows.map(r => r.data)}
          calendars={calendars}
          ctx={ctx}
          onAdd={handleOrganize}
          onClose={() => setShowOrganize(false)}
        />
      )}
      {showFeedbackAI && (
        <FeedbackAIPanel rows={rows.map(r => r.data)} onClose={() => setShowFeedbackAI(false)} />
      )}
      {showDedupAI && (
        <TermDedupPanel rows={rows.map(r => r.data)} onClose={() => setShowDedupAI(false)} />
      )}
    </div>
  )
}

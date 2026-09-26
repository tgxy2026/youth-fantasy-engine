import { useEffect, useMemo, useRef, useState } from 'react'
import * as db from '../lib/db'
import { TABS, SETTING_SUBTABS, RELATION_PAIR_TAB_IDS, tabVisible, type VisCtx, SABC, SABC_LABELS, CARD_TABLE_REF_FIELDS } from '../lib/schema'
import type { TableRow, CardRecord, CalendarDef } from '../lib/types'
import { Search, RefreshCw, BookMarked, ChevronDown, ChevronRight, Info, Pencil, X } from 'lucide-react'
import HelpPopover from './HelpPopover'
import CustomSelect from './CustomSelect'
import CharacterSelect from './CharacterSelect'
import TableRefSelect from './TableRefSelect'
import StoryDateInput from './StoryDateInput'
import CalendarSelect from './CalendarSelect'
import { useCalendarRule } from '../lib/useCalendarRule'
import { Button } from './Button'

type DocKind = 'card' | 'table' | 'relation'

/** 字段（携带原表单的控件类型，保证在此编辑时与原表单一致：下拉仍是下拉） */
interface DocField {
  label: string
  value: string
  dataKey: string
  /** 'select' = 原表单里该字段是下拉选择；'characters' = 多选角色卡；'date' = 结构化故事内时间；'calendar-select' = 历法列；'tableRef' = 跨表引用（从别的设定表取值） */
  type?: 'text' | 'select' | 'characters' | 'date' | 'calendar-select' | 'tableRef'
  options?: string[]
  /** tableRef 类型携带来源表与列（multi = 多选，与角色卡同口径） */
  refTab?: string
  refCol?: string
  multi?: boolean
}

/** 角色卡里以下拉形式填写的字段（与 CharacterSheet 保持一致） */
const CARD_SELECT_FIELDS: Record<string, string[]> = {
  '人物状态': ['未登场', '已登场', '已退场'],
  // 🔴 引用 schema 的单一源，别抄一份 —— 2.2.0 加 D 档时正是这里漏改了
  '保密等级': SABC,
}

interface Doc {
  key: string
  kind: DocKind
  source: string       // 页签名（如"主要角色"）
  group: string        // 一级分组（角色管理/世界构建/创作管理）
  tabId: string        // 用于点击跳转到对应页签
  recordId?: string    // 卡片/表格记录 id（用于联动回写）
  subtitle?: string    // 关系网的副标题（"甲→乙"）
  title: string
  fields: DocField[]
  matchField?: { label: string; value: string }
}

interface Props {
  onNavigate?: (id: string) => void
  /** 可见性上下文：精简/极简项目隐藏对应标记的页签，自定义项目按启用功能集过滤 */
  ctx: VisCtx
}

const TOP_GROUPS = ['角色管理', '世界构建', '创作管理'] as const

export default function SettingSearch({ onNavigate, ctx }: Props) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [query, setQuery] = useState('')
  const [topGroup, setTopGroup] = useState<typeof TOP_GROUPS[number]>('角色管理')
  const [activeSub, setActiveSub] = useState<string>('all')
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState<{ key: string; idx: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [savingField, setSavingField] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 自定义项目按启用功能集过滤页签可见性；完整项目全量可搜（历史遗留的精简/极简类型已废弃移除）
  const hiddenTabs = useMemo(
    () => new Set(TABS.filter(t => !tabVisible(t.id, ctx)).map(t => t.id)),
    [ctx]
  )
  /**
   * 🔴 索引重建 effect 的依赖要用这个**内容字符串**，不能直接依赖 hiddenTabs：
   * Set 是每次 memo 重算都新建的对象，而 ctx 来自上层、引用稳定性无从保证 ——
   * 直接依赖会形成「effect 重跑 → setDocs → 重渲染 → 新 Set → 再重跑」的循环。
   * 拼成逗号串后按值比较，可见性真的变了才重建（此前只挂 [reloadKey]，
   * 项目形态变化时索引会停留在旧可见集上）。
   */
  const hiddenTabsKey = useMemo(() => [...hiddenTabs].sort().join(','), [hiddenTabs])

  // 一级页签：若某分组下已无任何已启用子页签，则隐藏该分组
  const visibleTopGroups = useMemo(
    () => TOP_GROUPS.filter(g => (SETTING_SUBTABS[g] ?? []).some(id => !hiddenTabs.has(id))),
    [hiddenTabs]
  )
  // 当前选中的一级页签若已不可见（如项目形态切换导致），回退到第一个可见分组
  const activeTop = visibleTopGroups.includes(topGroup) ? topGroup : (visibleTopGroups[0] ?? '角色管理')

  // 历法配置（项目级，历史事件 / 时间脉络「历法」列的下拉来源）
  const [calendars, setCalendars] = useState<CalendarDef[]>([{ name: '灵历', value: 0 }])
  // 历法规则（一年几个月 / 每月几天）：这里改设定也要按它出月/日候选，否则与表格页口径不一致
  const { rule: calendarRule } = useCalendarRule()
  useEffect(() => {
    db.getSetting<CalendarDef[]>('calendars', []).then(v => { if (v && v.length > 0) setCalendars(v) })
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { tableRows, cardRecords } = await db.loadAllData()
      if (cancelled) return
      const out: Doc[] = []
      // 表单型：每个已填字段一条（不进入本检索，检索聚焦人物/世界/创作）
      // 表格型 + 卡片型：人物关系按人物汇总（见下方分组逻辑）
      // 卡片型（角色卡）：每张卡一条
      for (const tab of TABS) {
        if (hiddenTabs.has(tab.id)) continue
        if (tab.type === 'card' && (tab.group === '角色管理' || tab.group === '世界构建' || tab.group === '创作管理')) {
          const recs: CardRecord[] = cardRecords.filter(r => r.tabId === tab.id)
          for (const rec of recs) {
            // 角色卡需要过滤："未登场"的角色不显示
            // （人物状态字段可能位于不同模块下，如"一、基础信息::人物状态"或"NPC档案::人物状态"，统一按字段名查找）
            if (tab.group === '角色管理') {
              const status = Object.entries(rec.data).find(([k]) => k.endsWith('::人物状态'))?.[1]
              if (status === '未登场') continue
            }
            out.push({
              key: `card-${rec.id}`,
              kind: 'card',
              source: tab.name,
              group: tab.group,
              tabId: tab.id,
              recordId: rec.id,
              title: rec.name,
              fields: Object.entries(rec.data)
                .filter(([, v]) => v && v.trim())
                .map(([k, v]) => {
                  const [, fieldName] = k.split('::')
                  const label = fieldName ?? k
                  const opts = CARD_SELECT_FIELDS[label]
                  const ref = CARD_TABLE_REF_FIELDS[label]
                  if (ref) return { label, value: v, dataKey: k, type: 'tableRef' as const, refTab: ref.tabId, refCol: ref.col, multi: ref.multi }
                  return opts
                    ? { label, value: v, dataKey: k, type: 'select' as const, options: opts }
                    : { label, value: v, dataKey: k }
                }),
            })
          }
        }
      }
      // 表格型
      for (const tab of TABS) {
        if (hiddenTabs.has(tab.id)) continue
        if (tab.type !== 'table') continue
        if (tab.group !== '角色管理' && tab.group !== '世界构建' && tab.group !== '创作管理') continue
        if (tab.id === 'relations') continue // 人物关系走下方"按人物汇总"逻辑
        const rows: TableRow[] = tableRows.filter(r => r.tabId === tab.id)
        const colNames = tab.columns?.map(c => c.name) ?? []
        // 列定义索引：用于让编辑时沿用原表格的控件类型（select 列仍走下拉）
        const colMap = new Map((tab.columns ?? []).map(c => [c.name, c]))
        const isPair = RELATION_PAIR_TAB_IDS.has(tab.id)
        const displayCol = tab.displayCol ?? (isPair ? '人物A' : colNames[0])
        const subtitleCol = tab.subtitleCol
        for (const r of rows) {
          // === 过滤：伏笔总表，状态 == '已回收' 的不显示 ===
          if (tab.id === 'foreshadow') {
            const status = r.data['状态']
            if (status === '已回收') continue
          }
          const filled = Object.entries(r.data).filter(([, v]) => v && v.trim())
          if (filled.length === 0) continue
          // 主标题：displayCol 指定列；空时回退到第一个非空列
          const displayVal = (displayCol && r.data[displayCol]) || filled.find(([, v]) => v && v.trim())?.[1] || ''
          // 副标题：subtitleCol 指定列（关系网默认甲→乙）
          let subtitle: string | undefined
          if (isPair && r.data['人物A'] && r.data['人物B']) {
            subtitle = `${r.data['人物A']} → ${r.data['人物B']}`
          } else if (subtitleCol && r.data[subtitleCol] && r.data[subtitleCol] !== displayVal) {
            subtitle = r.data[subtitleCol]
          }
          out.push({
            key: `table-${r.id}`,
            kind: 'table',
            source: tab.name,
            group: tab.group,
            tabId: tab.id,
            recordId: r.id,
            subtitle,
            title: displayVal || '（未命名）',
            fields: colNames
              .filter(n => r.data[n] && r.data[n].trim())
              .map(n => {
                const col = colMap.get(n)
                return col?.calendar
                  ? { label: n, value: r.data[n], dataKey: n, type: 'calendar-select' as const }
                  : col?.type === 'tableRef'
                  ? { label: n, value: r.data[n], dataKey: n, type: 'tableRef' as const, refTab: col.refTab, refCol: col.refCol }
                  : col?.type === 'select' && col.options
                  ? { label: n, value: r.data[n], dataKey: n, type: 'select' as const, options: col.options }
                  : col?.type === 'characters'
                  ? { label: n, value: r.data[n], dataKey: n, type: 'characters' as const }
                  : col?.type === 'date'
                  ? { label: n, value: r.data[n], dataKey: n, type: 'date' as const }
                  : { label: n, value: r.data[n], dataKey: n }
              }),
          })
        }
      }
      // ============ 人物关系：按人物汇总 ============
      // 每位人物一条记录（标题=人物名），展开后二级列表显示其全部人物关系；
      // 人物A 与人物B 各自汇总，某人物不存在时（仅出现在关系表中）也会自动生成条目。
      // 精简/极简项目隐藏「人物关系」页签时，其数据也不进入检索索引
      if (!hiddenTabs.has('relations')) {
        const relRows = tableRows.filter(r => r.tabId === 'relations')
        const byChar = new Map<string, { other: string; type: string; detail: string }[]>()
        for (const r of relRows) {
          const a = (r.data['人物A'] ?? '').trim()
          const b = (r.data['人物B'] ?? '').trim()
          if (!a && !b) continue
          const type = r.data['关系类型'] ?? ''
          const detail = ['关系现状', '知情度（互相知道什么）', '演变轨迹（按卷）', '关系终点']
            .map(k => r.data[k]).filter(Boolean).join('；')
          const add = (name: string, other: string) => {
            const item = { other: other || '（未填写对方）', type, detail }
            const arr = byChar.get(name)
            arr ? arr.push(item) : byChar.set(name, [item])
          }
          if (a) add(a, b)
          if (b && b !== a) add(b, a)
        }
        const grouped = [...byChar.entries()]
          .sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0], 'zh'))
        for (const [name, rels] of grouped) {
          out.push({
            key: `rel-${name}`,
            kind: 'relation',
            source: '人物关系',
            group: '角色管理',
            tabId: 'relations',
            title: name,
            subtitle: `${rels.length} 条人物关系`,
            fields: rels.map(rel => ({
              label: `${rel.other}${rel.type ? `（${rel.type}）` : ''}`,
              value: rel.detail || '（暂无详情）',
              dataKey: '',
            })),
          })
        }
      }
      setDocs(out)
      setLoaded(true)
    })()
    return () => { cancelled = true }
    // hiddenTabs 的内容变化由 hiddenTabsKey 等价代表（见其定义处说明）；
    // 直接依赖 hiddenTabs 这个 Set 会因引用每次重建把 effect 拖进循环，故刻意不加。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, hiddenTabsKey])

  // 切换一级页签时，把二级筛选重置为 'all'
  useEffect(() => { setActiveSub('all') }, [topGroup])

  // 当前一级页签下的二级子项
  const subOptions = useMemo(() => {
    const subs = (SETTING_SUBTABS[activeTop] ?? []).filter(id => !hiddenTabs.has(id))
    const labels = subs.map(id => TABS.find(t => t.id === id)?.name ?? id)
    return [{ id: 'all', name: '全部' }, ...subs.map((id, i) => ({ id, name: labels[i] }))]
    // activeTop 已含 topGroup 的全部信息（它 = 可见分组兜底后的值，见上方定义），
    // 故只依赖 activeTop + hiddenTabs：topGroup 指向的分组被隐藏时会回退到第一个可见分组，
    // 此时二级项必须跟着换 —— 这正是 activeTop 存在的意义。
  }, [hiddenTabs, activeTop])

  // 当前可见的 docs
  const visibleDocs = useMemo(() => {
    return docs.filter(d => d.group === activeTop)
  }, [docs, activeTop])

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    let list = visibleDocs
    if (activeSub !== 'all') list = list.filter(d => d.tabId === activeSub)
    if (!q) {
      const priority = ['主要角色', '次要角色', 'NPC角色', '人物关系', '国家势力', '伏笔追踪', '名词术语']
      return [...list].sort((a, b) => {
        const pa = priority.indexOf(a.source), pb = priority.indexOf(b.source)
        return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
      }).slice(0, 20)
    }
    return list
      .map(d => {
        if (d.title.toLowerCase().includes(q)) {
          return { d, rank: 0, match: d.title }
        }
        if (d.subtitle && d.subtitle.toLowerCase().includes(q)) {
          return { d, rank: 0, match: d.subtitle }
        }
        const hit = d.fields.find(f => f.value.toLowerCase().includes(q) || f.label.toLowerCase().includes(q))
        if (hit) return { d, rank: 1, match: `${hit.label}：${hit.value}` }
        return null
      })
      .filter((x): x is { d: Doc; rank: number; match: string } => x !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 50)
      .map(x => ({ ...x.d, matchField: { label: '', value: x.match } }))
  }, [visibleDocs, q, activeSub])

  const toggle = (key: string) => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key); else next.add(key)
    setExpanded(next)
  }

  /** 在设定检索区内直接编辑某字段，保存后回写到对应设定表（角色卡 / 表格） */
  const saveField = async (doc: Doc, field: DocField, val: string) => {
    if (doc.kind === 'relation' || !doc.recordId) return
    setSavingField(true)
    try {
      if (doc.kind === 'card') {
        const recs = await db.getCardRecords(doc.tabId)
        const rec = recs.find(r => r.id === doc.recordId)
        if (rec) { rec.data[field.dataKey] = val; await db.saveCardRecord(rec) }
      } else if (doc.kind === 'table') {
        const rows = await db.getTableRows(doc.tabId)
        const row = rows.find(r => r.id === doc.recordId)
        if (row) { row.data[field.dataKey] = val; await db.saveTableRow(row) }
      }
      setReloadKey(k => k + 1)
      setEditing(null)
    } finally {
      setSavingField(false)
    }
  }

  const totalForGroup = useMemo(() => {
    const map: Record<string, number> = {}
    for (const g of TOP_GROUPS) map[g] = 0
    for (const d of docs) if (map[d.group] !== undefined) map[d.group]++
    return map
  }, [docs])

  return (
    <div className="flex flex-col h-full border-r border-ink-700 bg-ink-900 min-w-0">
      {/* 头部搜索 */}
      <div className="px-3 pt-3 pb-2 border-b border-ink-700 shrink-0">
        <div className="flex items-center gap-1.5">
          <Search size={13} className="text-amber shrink-0" />
          <span className="text-12 font-semibold text-ink-200 flex-1">设定检索</span>
          <HelpPopover title="设定检索与联动编辑" width="23rem" side="right">
            {'左侧是全书设定的实时速查索引，按角色 / 世界 / 创作三大类组织。\n\n· 输入关键词检索本组设定（角色名、伏笔、境界、地名…）；\n· 展开任意一条可查看全部字段，点字段右侧的 ✎ 就地修改，自动同步回对应角色卡 / 设定表，不必跳页重填；\n· 原表单里是下拉选择的字段（人物状态、伏笔状态、重要程度…），在这里同样是下拉，选项可增删改，选中即保存；\n· 角色类的多选字段（如《知情权限》的「知情者」）在这里同样从已创建角色卡中多选、不可手填，与设定表完全一致；\n· 真实日期字段（写作进度、读者反馈等）点开弹出月历选择；故事内时间（某年某月某日）用结构化下拉填写，避免时间轴排序错乱；\n· 纯文本字段改完点「保存」生效；\n· "→ 跳转到" 直达该设定所在页签做大改；\n· 右上旋转箭头可重建索引（在别处新填的内容没出现时点一下）。\n\n注：已回收的伏笔、未登场的角色不进入索引，避免刷屏。'}
          </HelpPopover>
          <Button variant="bare" iconOnly size="xs"
            onClick={() => setReloadKey(k => k + 1)}
            className="text-ink-500 hover:text-amber transition-colors"
            title="重新加载设定数据"
          >
            <RefreshCw size={12} className={loaded ? '' : 'animate-spin'} />
          </Button>
        </div>
        <div className="relative mt-2">
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜角色名 / 伏笔 / 境界 / 地名…"
            className="w-full !pl-7 text-12"
          />
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
        </div>
        {/* 一级页签：角色管理 / 世界构建 / 创作管理（无可见子项的自动隐藏） */}
        <div className="flex gap-1 mt-2">
          {visibleTopGroups.map(g => (
            <Button variant="bare"
              key={g}
              onClick={() => setTopGroup(g)}
              className={`flex-1 px-2 py-1 rounded-md text-11 border transition-colors
                ${activeTop === g
                  ? 'bg-amber/15 text-amber border-amber/30 font-medium'
                  : 'text-ink-400 border-ink-700 hover:border-ink-500'}`}
            >
              {g}
              <span className="ml-1 text-9 text-ink-500">{totalForGroup[g] ?? 0}</span>
            </Button>
          ))}
        </div>
        {/* 二级子项筛选 */}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {subOptions.map(s => (
            <Button variant="bare"
              key={s.id}
              onClick={() => setActiveSub(s.id)}
              className={`px-1.5 py-0.5 rounded text-10 border transition-colors
                ${activeSub === s.id
                  ? 'bg-ink-700 text-ink-100 border-ink-500'
                  : 'text-ink-500 border-ink-800 hover:text-ink-300'}`}
            >
              {s.name}
            </Button>
          ))}
        </div>
      </div>

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!loaded ? (
          <div className="text-center py-10 text-11 text-ink-500">加载设定索引…</div>
        ) : results.length === 0 ? (
          <div className="text-center py-10 text-11 text-ink-500 leading-relaxed">
            {q ? `没有匹配「${query}」的设定` : `${activeTop} 暂无已填设定`}<br />
            <span className="text-10 text-ink-600">在左侧各页签填写后，点右上角刷新按钮重建索引</span>
          </div>
        ) : (
          <>
            {!q && (
              <div className="flex items-start gap-1.5 px-1.5 pb-2 mb-1 text-10 text-ink-500 border-b border-ink-700/60">
                <Info size={10} className="mt-0.5 shrink-0" />
                <span>高频速查预览 · 输入关键词检索本组 {visibleDocs.length} 条设定</span>
              </div>
            )}
            <div className="space-y-1">
              {results.map(doc => {
                const open = expanded.has(doc.key)
                const snippet = doc.matchField?.value ?? doc.subtitle ?? doc.fields[0]?.value ?? ''
                return (
                  <div key={doc.key} className="rounded-lg bg-ink-850/70 border border-ink-700/70 hover:border-ink-600 transition-colors">
                    <Button variant="bare"
                      onClick={() => toggle(doc.key)}
                      className="w-full text-left !justify-start px-2.5 py-2"
                    >
                      <div className="w-full flex flex-col items-start text-left">
                        <div className="flex items-center gap-1.5 w-full">
                          {open ? <ChevronDown size={11} className="text-ink-500 shrink-0" /> : <ChevronRight size={11} className="text-ink-500 shrink-0" />}
                          <span className="text-12 font-medium text-ink-100 truncate flex-1">{doc.title}</span>
                          <span className="px-1.5 py-px text-9 rounded bg-ink-800 text-ink-400 border border-ink-700 shrink-0">{doc.source}</span>
                        </div>
                        {!open && doc.subtitle && (
                          <div className="text-10 text-amber/70 mt-0.5 pl-4 truncate w-full">{doc.subtitle}</div>
                        )}
                        {!open && !doc.subtitle && snippet && (
                          <div className="text-10 text-ink-500 mt-1 truncate pl-4 w-full">{snippet}</div>
                        )}
                      </div>
                    </Button>
                    {open && (
                      <div className="px-3 pb-2.5 pt-0.5 space-y-1.5">
                        {doc.subtitle && (
                          <div className="text-10 text-amber/80 pb-1 border-b border-ink-700/60">{doc.subtitle}</div>
                        )}
                        {doc.fields.map((f, i) => {
                          const isEditing = editing?.key === doc.key && editing.idx === i
                          return (
                            <div key={i}>
                              <div className="flex items-center gap-1">
                                {f.label && <div className="text-10 text-amber/70">{f.label}</div>}
                                {doc.kind !== 'relation' && !isEditing && (
                                  <Button variant="bare" iconOnly size="xs"
                                    onClick={() => { setEditing({ key: doc.key, idx: i }); setDraft(f.value) }}
                                    className="ml-auto text-ink-600 hover:text-amber transition-colors shrink-0"
                                    title="在此直接修改并同步到设定表"
                                  >
                                    <Pencil size={10} />
                                  </Button>
                                )}
                              </div>
                                  {isEditing ? (
                                <div className="mt-0.5">
                                  {/* 下拉字段：沿用原表单/表格的下拉控件（可增删改选项），选中即回写 */}
                                  {f.type === 'tableRef' ? (
                                    /* 跨表引用：从来源设定表取值，禁止手动输入，与原表一致 */
                                    <div className="mt-0.5">
                                      <TableRefSelect
                                        refTabId={f.refTab!}
                                        refCol={f.refCol!}
                                        multi={f.multi}
                                        value={draft}
                                        onChange={v => { setDraft(v); saveField(doc, f, v) }}
                                        placeholder={`选择${f.label}`}
                                      />
                                    </div>
                                  ) : f.type === 'select' && f.options ? (
                                    <div className="flex items-center gap-1">
                                      <div className="flex-1 min-w-0 bg-ink-900 border border-amber/40 rounded">
                                        {doc.kind === 'table' ? (
                                        <CustomSelect
                                          tabId={doc.tabId}
                                          colName={f.dataKey}
                                          options={f.options}
                                          value={draft}
                                          onChange={v => { setDraft(v); saveField(doc, f, v) }}
                                          labelMap={f.label === '保密等级' ? SABC_LABELS : undefined}
                                          fixedOptions={f.label === '保密等级'}
                                        />
                                        ) : (
                                          <select
                                            value={draft}
                                            autoFocus
                                            onChange={e => { setDraft(e.target.value); saveField(doc, f, e.target.value) }}
                                            className="w-full !py-1 !px-1.5 text-11 !bg-transparent !border-0"
                                          >
                                            {f.options.map(o => <option key={o} value={o}>{SABC_LABELS[o] ?? o}</option>)}
                                          </select>
                                        )}
                                      </div>
                                      <Button variant="icon-muted" onClick={() => setEditing(null)} className="p-1 shrink-0" title="收起（选中选项即已保存）"><X size={11} /></Button>
                                    </div>
                                  ) : f.type === 'characters' ? (
                                    /* 多选角色：从已创建角色卡中选择，禁止手动输入，与原表一致 */
                                    <div className="mt-0.5">
                                      <CharacterSelect
                                        multi
                                        value={draft}
                                        onChange={v => { setDraft(v); saveField(doc, f, v) }}
                                        placeholder="选择角色（可多选）"
                                        ctx={ctx}
                                      />
                                    </div>
                                  ) : f.type === 'date' ? (
                                    /* 故事内时间：结构化 某年某月某日 输入，与原表一致（月/日候选按项目历法规则） */
                                    <div className="mt-0.5">
                                      <StoryDateInput
                                        value={draft}
                                        rule={calendarRule}
                                        onChange={v => { setDraft(v); saveField(doc, f, v) }}
                                      />
                                    </div>
                                  ) : f.type === 'calendar-select' ? (
                                    /* 历法列：从项目级历法配置选择，可新增/删改/数值，与设定表完全一致 */
                                    <div className="mt-0.5">
                                      <CalendarSelect
                                        value={draft}
                                        onChange={v => { setDraft(v); saveField(doc, f, v) }}
                                        calendars={calendars}
                                        onCalendarsChange={next => { setCalendars(next); db.setSetting('calendars', next) }}
                                      />
                                    </div>
                                  ) : (
                                    <textarea
                                      value={draft}
                                      autoFocus
                                      onChange={e => setDraft(e.target.value)}
                                      className="w-full !py-1 !px-1.5 text-11 bg-ink-900 border border-amber/40 rounded resize-y min-h-[48px]"
                                    />
                                  )}
                                  {f.type === 'select' || f.type === 'characters' || f.type === 'date' || f.type === 'calendar-select' || f.type === 'tableRef' ? (
                                    <div className="mt-1 text-10 text-ink-500">改动即自动同步到「{doc.source}」</div>
                                  ) : (
                                    <div className="flex gap-1.5 mt-1">
                                      <Button variant="primary" size="xs" disabled={savingField} onClick={() => saveField(doc, f, draft)}>保存</Button>
                                      <Button variant="secondary" size="xs"
                                        onClick={() => setEditing(null)}
                                      >取消</Button>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="text-11 text-ink-300 leading-relaxed whitespace-pre-wrap">{f.label === '保密等级' && SABC_LABELS[f.value] ? SABC_LABELS[f.value] : f.value}</div>
                              )}
                            </div>
                          )
                        })}
                        {doc.fields.length === 0 && <div className="text-11 text-ink-500">（暂无内容）</div>}
                        {onNavigate && (
                          <Button variant="bare"
                            onClick={() => onNavigate(doc.tabId)}
                            className="text-11 text-ink-500 hover:text-amber transition-colors mt-1"
                          >
                            → 跳转到「{doc.source}」
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* 底部：去填写 */}
      {/* 🔴 底部状态条统一 h-10：与编辑器状态条（NovelEditor）/ 侧栏左下角把手（Sidebar）
          三条上边框横线对齐（2.5.2 UI 修复，以本条为基准统一高度） */}
      <div className="h-10 px-3 flex items-center border-t border-ink-700 shrink-0">
        <Button variant="bare"
          onClick={() => onNavigate?.('guide')}
          className="flex items-center gap-1.5 text-11 text-ink-500 hover:text-amber transition-colors"
        >
          <BookMarked size={10} /> 设定不齐？查看填写指南
        </Button>
      </div>
    </div>
  )
}

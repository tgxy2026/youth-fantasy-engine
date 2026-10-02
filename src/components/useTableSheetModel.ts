/**
 * 表格页签的**状态与生命周期**（从 `TableSheet.tsx` 拆出来的，2026-09-19）。
 *
 * 【为什么这么拆】
 *   `TableSheet.tsx` 原先 1381 行：逻辑 576 行 + JSX 646 行，JSX 直接用到 61 个
 *   组件作用域名字（全组件声明 91 个）。状态、effect 与视图互相缠绕在一个函数体里 ——
 *   想改一处保存逻辑，得在 1381 行里先认出哪些 effect 与它有关。
 *
 *   这里做的是**只搬不改**：把 state / effect / 派生值 / 动作整体收进本 hook，
 *   视图侧用同名解构接回来（JSX 一个字不改）。改完两边各自单一职责：
 *   改行为看这个文件，改长相看视图。
 *
 * 🔴 关心的红线（搬动时逐条保住）：
 *   · **卸载冲刷草稿**：`App.tsx` 给表格页签加了 `key={tab.id}`，切页签时组件整体重挂 →
 *     「prevId !== tab.id」那条守卫恒假；唯一与 key 无关的落点是卸载清理（见下）。
 *   · **Ctrl/Cmd+S** 只在本页签有草稿时生效，绝不拦全局快捷键。
 *   · **列宽记忆**写 localStorage 是纯 UI 偏好：写失败（隐私模式/配额满）静默忽略。
 *   · **编号 = 补最小空号**（见 lib/autoCode.ts）：删除的编号允许被新增条目复用，
 *     删除前经 lib/codeRefs.ts 做引用检查并在确认弹窗里如实提示（只提示、不拦截）。
 *   · 列宽拖拽的位移必须按界面缩放折算（clientX 是视口像素，列宽是 CSS 像素）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { CalendarDef, TableRow, TabDef } from '../lib/types'
import {
  deleteTableRow, getAllChapterLedgerRows, getCurrentProjectId, getCustomOptions,
  getSetting, getTableRows, saveTableRow, setSetting, type CustomOptionPayload,
} from '../lib/db'
import { AUTONUM_GROUPS, nextAutoCode } from '../lib/autoCode'
import { countCodeRefs, codeRefWarning } from '../lib/codeRefs'
import { uid } from '../lib/id'
import { aiCapabilityOf } from '../lib/aiScope'
import { buildImportRows, type ImportRowResult } from '../lib/tableIO'
import { useAIReady } from '../lib/useAIReady'
import { clearFreeDraft } from '../lib/freeDraft'
import { useCalendarRule } from '../lib/useCalendarRule'
import { CUSTOM_OPTIONS_EVENT, resolveOptions } from './CustomSelect'
import { usePersistedSet } from '../lib/uiPrefs'
import { showToast, confirmDialog } from './dialogs'
import type { TemplateField } from '../lib/ai'

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

type Args = {
  tab: TabDef
  /** 数据体检 / 跨组件跳转带下来的目标行 id */
  focusRowId?: string | null
  /** 高亮消费后回调（清除上层 focusRowId 以便重复跳转） */
  onFocusConsumed?: () => void
}

export function useTableSheetModel({ tab, focusRowId, onFocusConsumed }: Args) {
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
  // 编号校验错误提示（保存时校验，展示在页签顶部）
  const [codeError, setCodeError] = useState<string | null>(null)
  // 编号列名（仅「编号」列参与防重复校验；「章节号」由系统自动生成，不校验）
  const codeCol = tab.columns?.find(c => c.name === '编号')?.name
  // AI 入口：本表适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()
  const [showFill, setShowFill] = useState(false)
  const [showOrganize, setShowOrganize] = useState(false)
  const [showImport, setShowImport] = useState(false)
  /** 行级「AI 补全本行空白」：只针对这一行、只填仍为空的单元格，绝不越界到其他行/表 */
  const [fillRow, setFillRow] = useState<TableRow | null>(null)
  // 读者反馈 / 名词术语的专属 AI 入口（独立于补全/整理能力矩阵）
  const [showFeedbackAI, setShowFeedbackAI] = useState(false)
  const [showDedupAI, setShowDedupAI] = useState(false)
  const tableFields = useMemo<TemplateField[]>(
    () => (tab.columns ?? []).filter(c => !c.hidden).map(c => ({ key: c.name, label: c.name, locked: c.name === codeCol })),
    // 🔴 读 tab.columns，依赖锚在 tab 本身（getTab 返回模块常量引用，同一页签稳定）
    [tab, codeCol],
  )
  // 保存闪烁定时器（卸载时清理，防止组件卸载后仍触发 setState）
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  // 用 ref 持有最新草稿与行数据，避免切换页签时因 effect 闭包过期而丢失未保存草稿
  const draftsRef = useRef(drafts)
  const rowsRef = useRef(rows)
  const tabIdRef = useRef(tab.id)
  useEffect(() => { draftsRef.current = drafts }, [drafts])
  useEffect(() => { rowsRef.current = rows }, [rows])

  /**
   * 🔴 卸载时冲刷未保存的表格草稿。
   *
   * 为什么必须放在卸载清理里：`App.tsx` 给本组件加了「key={tab.id}」，切页签时组件整体重挂 ——
   * 于是下面那个 [tab.id] 守卫里的 tabIdRef.current 初值就是新 id，
   * 「prevId !== tab.id」恒假、分支永不执行（未保存草稿被静默丢弃）。
   * 卸载清理是唯一与 key 无关的稳妥落点。
   */
  useEffect(() => () => {
    const pending = draftsRef.current
    if (!pending || Object.keys(pending).length === 0) return
    const snapshot = rowsRef.current
    for (const rowId of Object.keys(pending)) {
      const orig = snapshot.find(r => r.id === rowId)
      if (orig) void saveTableRow({ ...orig, data: { ...orig.data, ...pending[rowId] } })
    }
  }, [])

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
    // onFocusConsumed 由 App.tsx 用 useCallback 钉住引用（clearFocusRow），
    // 依赖它不会导致 effect 每次渲染重跑。
  }, [focusRowId, rows, onFocusConsumed])

  // 列宽（按表独立记忆）：表头可拖拽调整，默认列宽更合理
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(`yfe-colw::${tab.id}`) || '{}') } catch { return {} }
  })
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null)
  /** 🔴 2026-09-22 六维审计 P2：拖拽期间挂上的 window 监听，卸载时也要能摘掉
   *  （原来只在 `onUp` 里 removeEventListener —— 拖到一半切页签/组件被卸载时 `onUp` 永不触发，
   *   这对监听就永久留在 window 上，越拖越积）。 */
  const dragCleanupRef = useRef<(() => void) | null>(null)
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
      // 🔴 整份拖拽上下文**同步捕获**到局部量 d —— setColWidths 的 updater 是**延迟执行**的
      //    （React 在渲染阶段才调用它），而那时 mouseup 早已把 dragRef.current 置空；
      //    此前写 `[dragRef.current!.col]` 会抛「Cannot read properties of null (reading 'col')」
      //    （2026-09-20 老大实测：打开表格页签拖列宽即崩）。
      //    ⚠️ `!` 只是 TS 断言，**编译后没有任何运行时保护**，「上一步 if 判过非空」救不了下一步。
      //    范式对齐 useSvgPanZoom / PlotCanvas：回调开头取一次，updater 只碰局部量。
      const d = dragRef.current
      if (!d) return
      // 🔴 位移要按界面缩放折算：clientX 是**视口像素**，而 startW 是 CSS 像素（列宽）。
      //    不除 zoom 时，108% 下拖动会比光标快约 8%，而且算错的列宽会被写进 localStorage 长期留存。
      const z = Number(document.documentElement.style.zoom) || 1
      const dx = (ev.clientX - d.startX) / z
      const w = Math.max(90, Math.min(640, Math.round(d.startW + dx)))
      setColWidths(prev => ({ ...prev, [d.col]: w }))
    }
    const onUp = () => {
      dragRef.current = null
      dragCleanupRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 列宽属纯 UI 偏好，存不进 localStorage（隐私模式/配额满）也不影响数据，
      // 故此处刻意不提示、不降级——刷新后回到默认列宽即可。
      try { localStorage.setItem(`yfe-colw::${tab.id}`, JSON.stringify(colWidthsRef.current)) } catch { /* 见上：可安全忽略 */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // 记录清理函数：正常松手走 onUp，拖拽途中被卸载则由下面的卸载 effect 兜底
    dragCleanupRef.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }

  useEffect(() => () => {
    clearTimeout(savedTimer.current)
    dragCleanupRef.current?.()   // 🔴 拖拽途中被卸载时的兜底（见 dragCleanupRef 声明处）
  }, [])

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
    // 🔴 2026-09-29：不再加载「退役编号池」（retiredCodes）—— 编号改为补最小空号，删除后的编号允许复用。
    //    旧库里残留的 retiredCodes::<tabId> 数据无害（不再读写），无需迁移清理。
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
    // 🔴 依赖只写 tab.id：本 effect 是「切页签时重置」，故意不跟 rows/drafts 等联动
  }, [tab.id])

  /**
   * 保存历法清单（2.7.2：改由页头「历法规则」弹窗统一提交，见 `CalendarRuleModal`）。
   *
   * 🔴 `renames` ＝「改名」的连带更新。历法是**项目级**的，历史事件 / 时间脉络两张表的
   *    「历法」列都引用它。若只改配置不改行，那些行就成了下拉里查不到的孤儿值
   *    （时间轴上还会因取不到历法权重而排序错乱）。所以改名要一次性把两张表里
   *    所有引用旧名的行改成新名。
   * ⚠️ **删除不在这里处理**：按定版口径，删除只把历法从清单移除，已填的行保留旧名文本
   *    （清空行＝销毁作者数据，交给他自己决定要不要改）。
   */
  const saveCalendars = useCallback(async (
    next: CalendarDef[],
    renames: Array<{ from: string; to: string }> = [],
  ) => {
    setCalendars(next)
    void setSetting('calendars', next)
    if (renames.length === 0) return

    const map = new Map(renames.map(r => [r.from, r.to]))
    const hit: string[] = []
    for (const tid of ['history', 'timeline']) {
      const list = await getTableRows(tid)
      let changed = 0
      for (const row of list) {
        const cur = (row.data['历法'] ?? '').trim()
        const to = map.get(cur)
        if (!to) continue
        await saveTableRow({ ...row, data: { ...row.data, '历法': to } })
        changed++
      }
      if (changed === 0) continue
      hit.push(`${tid === 'history' ? '历史事件' : '时间脉络'} ${changed} 行`)
      // 当前页签就是这张表 ⇒ 内存态（含未保存草稿）一起改，否则界面仍显示旧名、一保存又写回去
      if (tab.id === tid) {
        setRows(prev => prev.map(r => {
          const to2 = map.get((r.data['历法'] ?? '').trim())
          return to2 ? { ...r, data: { ...r.data, '历法': to2 } } : r
        }))
        setDrafts(prev => {
          const out: Record<string, Record<string, string>> = {}
          for (const [rid, fields] of Object.entries(prev)) {
            const to2 = map.get((fields['历法'] ?? '').trim())
            out[rid] = to2 ? { ...fields, '历法': to2 } : fields
          }
          return out
        })
      }
    }
    if (hit.length > 0) showToast(`历法改名已同步：${hit.join('、')}`)
  }, [tab.id])

  // 历法规则（一年几个月 / 每月几天）—— 项目级，月/日下拉与"持续时长"都按它算
  const { rule: calendarRule, setRule: setCalendarRule } = useCalendarRule()

  const dirtyKeys = Object.keys(drafts)

  const setCellDraft = (rowId: string, colName: string, value: string) => {
    setDrafts(prev => {
      const prevData = prev[rowId] ?? rows.find(r => r.id === rowId)?.data ?? {}
      const base = { ...prevData, [colName]: value }
      // 🔴 2.4.4 时间口径（主人哥哥定版）：**时间点事件也要发生=结束**。
      //    填「发生时间」时「结束时间」跟随，直到作者手动改过它。判定"没手动改过"：
      //    ① 结束时间为空（还没填）；② 结束时间 === 改动前的发生时间（是上一轮自动跟随的结果）。
      //    ②是关键 —— 发生时间是"年→月→日"渐进写回的，若只判空，第一次联动就会把
      //    结束时间锁死在「3024年」这种中间态（实机抓到过）。
      //    作者把结束时间改成别的值后，联动立刻停止，绝不覆盖他的意图。
      if (colName === '发生时间' && value) {
        const oldStart = String(prevData['发生时间'] ?? '')
        const curEnd = String(base['结束时间'] ?? '')
        if (!curEnd.trim() || curEnd === oldStart) base['结束时间'] = value
      }
      return { ...prev, [rowId]: base }
    })
    setSaved(false)
    // 用户修改了编号相关内容时清除上次的校验错误提示
    if (codeError) setCodeError(null)
  }

  /**
   * 编号唯一性校验（保存前调用）：合并 draft 后逐行提取编号，检测多行重复。
   * 🔴 2026-09-29：删掉了「命中退役编号池也阻止保存」那条 —— 编号改为补最小空号，
   *    已删除条目的编号**允许**被重新使用（删除时另有引用提示）。只保留真正的重复检测。
   * 返回错误信息（null 表示通过）
   */
  const validateCodes = useCallback((): string | null => {
    if (!codeCol) return null
    const owner = new Map<string, number>()
    for (const r of rows) {
      const code = ((drafts[r.id]?.[codeCol] ?? r.data[codeCol] ?? '') as string).trim()
      if (!code) continue
      owner.set(code, (owner.get(code) ?? 0) + 1)
    }
    const errs: string[] = []
    for (const [code, count] of owner) {
      if (count > 1) errs.push(`「${code}」被 ${count} 行重复使用`)
    }
    return errs.length > 0 ? errs.join('；') : null
  }, [codeCol, rows, drafts])

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
    try {
      for (const rowId of dirtyKeys) {
        const orig = rows.find(r => r.id === rowId)
        if (!orig) continue
        const merged = { ...orig.data, ...drafts[rowId] }
        await saveTableRow({ ...orig, data: merged })
      }
      // 提交后合并回 rows，清空 drafts
      setRows(prev => prev.map(r => drafts[r.id] ? { ...r, data: { ...r.data, ...drafts[r.id] } } : r))
      setDrafts({})
      setSaved(true)
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      // 🔴 失败时**不清 drafts**：作者的改动还在输入框里，可以直接重试（审计 P1-5）
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setSaving(false)
    }
    // codeCol / retiredCodes / tab.id 已被 validateCodes 一并封装进它的依赖，
    // 此处不再重复列出（重复不影响正确性，但会让依赖表失真）。
  }, [dirtyKeys, drafts, rows, validateCodes])

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
    // 🔴 编号改为「补最小空号」后（2026-09-29），被删编号可能被新条目重新占用 ——
    //    删除前先如实告诉作者「这个编号在别处出现了几处」，由他自己判断有没有引用。
    //    无引用就是无风险删除；有引用也只提示、不拦（作者可以自行确认后删除）。
    const target = rows.find(r => r.id === rowId)
    const code = codeCol && target
      ? ((drafts[target.id]?.[codeCol] ?? target.data[codeCol] ?? '') as string).trim()
      : ''
    let warn = ''
    if (code) {
      const refs = await countCodeRefs(code, { tabId: tab.id, rowId: target?.id })
      warn = codeRefWarning(code, refs)
    }
    if (!await confirmDialog({
      title: '删除这一行',
      message: `确定删除这一行？${warn}`,
      danger: true,
    })) return
    // 🔴 2.4.4 六维审计：删行清掉该行的 AI 补全草稿（row::页签::行id），防孤儿残留
    void clearFreeDraft(`row::${tab.id}::${rowId}`)
    try {
      await deleteTableRow(rowId)
    } catch (e) {
      // 删除落库失败必须说出来：行其实还在，界面别假装删掉了（与 saveAll 的失败口径一致）
      showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      return
    }
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
    try {
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
    } catch (e) {
      // 🔴 2026-10-02 六维审计 P1（与 handleImport 同一条纪律）：已成功落库的行**必须先并入内存再抛**，
      //    否则「库里有、界面没有」—— 作者重试这批行会被再写一遍，变成重复条目。
      if (created.length) setRows(prev => [...prev, ...created])
      throw e
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

  /**
   * 批量导入落盘（2.6.4）：与 handleOrganize 同口径 —— 直接写库、不进 drafts；
   * 行的构造（含编号补号）交给 lib/tableIO.buildImportRows（纯函数，可单测）。
   */
  const handleImport = async (picked: ImportRowResult[]) => {
    const created = buildImportRows(picked, tab, rows, getCurrentProjectId(), uid, drafts)
    // 🔴 2026-10-02 六维审计 P1：逐行落库时若中途失败（IPC / IDB 写失败），旧实现会让**已写进库的行**
    //    停在内存之外 —— setRows 不执行 ⇒ 界面看不到它们；作者点重试，这些行会被**再写一遍**（重复条目）。
    //    改为：把已成功的行也并入内存后再抛（弹窗的 catch 会显示原因、且不关窗；已导入的行随即变成
    //    「与已有重复」而被自动取消勾选），重试只会补写剩下的部分。
    const saved: TableRow[] = []
    try {
      for (const row of created) {
        await saveTableRow(row)
        saved.push(row)
      }
    } catch (e) {
      if (saved.length) setRows(prev => [...prev, ...saved])
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(`已写入 ${saved.length}/${created.length} 条后中断：${reason}`)
    }
    setRows(prev => [...prev, ...created])
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
  // 🔴 必须 useCallback 且依赖 drafts：下面 filteredRows 依赖本函数，而本函数读 drafts ——
  //    此前 filteredRows 的依赖里没有 drafts，导致「正按某列筛选时编辑该列单元格，
  //    命中结果不实时重算」（编辑后行不随条件变化消失/出现）。
  const cellVal = useCallback((r: TableRow, colName: string) => {
    if (drafts[r.id] && colName in drafts[r.id]) return drafts[r.id][colName]
    return r.data[colName] ?? ''
  }, [drafts])
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
      if (selectColNames.has(col)) {
        // 下拉列：候选值是「显示名」（内置项可能已被用户改名，见 resolveOptions），
        // 而单元格里存的仍是原名 —— 必须先把存储值转成显示名再比，
        // 否则选中改名后的项会一行都筛不出来（2026-09-29 社区反馈修复）。
        const renamed = customOpts[col]?.renamed ?? {}
        const shown = renamed[cell] ?? cell
        return shown === v.trim() || cell === v.trim()   // 兼容旧版把值写成新名的脏数据
      }
      return cell.toLowerCase().includes(v.trim().toLowerCase()) // 文本列：包含匹配
    }))
  }, [sortedRows, colFilters, selectColNames, cellVal, customOpts])

  /**
   * 自引用父级列（同一表内的上下级隶属）：国家势力·上级 / 地理风物·层级归属。
   * 检测到即把表格渲染成可折叠的树（缩进 + 折叠箭头），并提供「在其下新增子条目」。
   */
  const parentCol = useMemo(
    () => (tab.columns?.find(c => c.type === 'tableRef' && c.refTab === tab.id)?.name) ?? null,
    [tab],
  )
  // 树折叠状态**按页签记忆**（见 lib/uiPrefs）：国家势力的层级、历史事件的上下级
  // 各记各的；切到别的表不会继承上一个表的折叠。存的是「已折叠的行 id」，
  // 空集合 = 全展开 = 首次安装的默认观感。行被删除后留下的 id 无害（新行 id 不复用）。
  const [collapsed, setCollapsed] = usePersistedSet(`table-collapsed:${tab.id}`)
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
    setCollapsed(() => new Set<string>()) // 确保父级处于展开态，子条目立即可见
  }

  // 表总宽 = 各列宽之和 + 序号列(40) + 操作列(48)。超出容器时由外层 overflow-x-auto 出横向滑条，
  // 而非压缩其他列（拖动某列只改它自己，不影响其余列宽）。
  const totalWidth = tab.columns
    ? tab.columns.filter(c => !c.hidden).reduce((s, c) => s + widthOf(c.name), 0) + 40 + 28
    : 0

  const isRowDirty = (r: TableRow) => !!drafts[r.id] && Object.keys(drafts[r.id]).length > 0

  /** 编号是否无效（与同表其它行重复）：输入时即红框提示。
   *  🔴 2026-09-29：去掉「命中退役编号池也判无效」—— 编号改为补最小空号，删除后的编号允许复用。 */
  const isInvalidCode = (row: TableRow): boolean => {
    if (!codeCol) return false
    const code = cellVal(row, codeCol).trim()
    if (!code) return false
    const same = rows.filter(r => (drafts[r.id]?.[codeCol] ?? r.data[codeCol] ?? '').trim() === code)
    return same.length > 1
  }

  return {
    // 落库与装载
    rows, setRows, drafts, setDrafts, saving, saved, dirtyKeys, saveAll, loaded,
    // 行编辑
    setCellDraft, cellVal, isRowDirty, isInvalidCode, addRow, removeRow,
    // 排序与筛选
    sortedRows, filteredRows, colFilters, setColFilters, filterOptionsOf,
    // 列宽与拖拽
    widthOf, onResizeStart, totalWidth,
    // 树形层级
    parentCol, collapsed, toggleCollapse, tree, bodyRows, addChild,
    // 编号
    codeCol, codeError,
    // 视图与高亮
    viewMode, setViewMode, isTimelineCapable, isGraphCapable, isStorylineCapable, isMaster, aiCap, aiReady, hlRowId, rowRefs,
    // 人物关系分组
    relationGroups, relGroupOpen, setRelGroupOpen, relRowOpen, setRelRowOpen,
    // 历法
    calendars, saveCalendars,
    // 历法规则（一年几个月 / 每月几天）
    calendarRule, setCalendarRule,
    // AI 入口
    tableFields, showFill, setShowFill, showOrganize, setShowOrganize, showImport, setShowImport, fillRow, setFillRow, showFeedbackAI, setShowFeedbackAI, showDedupAI, setShowDedupAI, handleFill, handleFillRow, handleOrganize, handleImport,
  }
}

/** 供子组件用的类型：`TableSheetRow` / `TableRelationGroups` 都收这一个 prop */
export type TableSheetModel = ReturnType<typeof useTableSheetModel>

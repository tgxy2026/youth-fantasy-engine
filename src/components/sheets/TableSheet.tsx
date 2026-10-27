/**
 * 表格页签（世界构建 / 创作管理 / 运营维护各表的通用编辑器）。
 *
 * 本文件**只负责长相**：状态、effect、派生值与动作全部在 `useTableSheetModel()`（2026-09-19 拆出）。
 * 下面那行同名解构是刻意的 —— 让 JSX 保持原样、零改动，把「搬家」与「改造」分开做。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TabDef } from '@/lib/types'
import { Z } from '@/lib/app/zLayer'
import { addCustomItem, deleteTableRow, getCurrentProjectId } from '@/lib/db'
import { SABC_LABELS, type VisCtx } from '@/lib/schema'
import { Plus, Trash2, Info, Save, Check, Calendar, CalendarClock, Table2, Hash, AlertTriangle, Network, Sparkles, GitBranch, FileDown, FileUp, BookOpen, Settings2, LayoutTemplate } from 'lucide-react'
import HistoryTimeline from '@/components/outline/HistoryTimeline'
import StoryTimeline from '@/components/outline/StoryTimeline'
import StorylineView from '@/components/outline/StorylineView'
import RelationGraph from '@/components/world/RelationGraph'
import FactionGraph from '@/components/world/FactionGraph'
import HelpPopover from '@/components/common/HelpPopover'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import AITemplateFill from '@/components/ai/AITemplateFill'
import AIOrganize from '@/components/ai/AIOrganize'
import TableImportDialog from '@/components/sheets/TableImportDialog'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { exportRowsCsv } from '@/lib/storage/tableIO'
import { downloadBlob } from '@/lib/storage/zip'
import FeedbackAIPanel from '@/components/ai/FeedbackAIPanel'
import TermDedupPanel from '@/components/tools/TermDedupPanel'
import CalendarRuleModal from '@/components/common/CalendarRuleModal'
import FieldAliasButton, { tableAliasTargets } from '@/components/sheets/FieldAliasButton'
import { useFieldRenames } from '@/lib/templates/useFieldRenames'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import MentionPanel from '@/components/app/MentionPanel'
import { Button } from '@/components/common/Button'
import { SaveFab } from '@/components/common/SaveFab'
import { LoadingState } from '@/components/common/LoadingState'
import TableSheetRow from '@/components/sheets/TableSheetRow'
import TableRelationGroups from '@/components/sheets/TableRelationGroups'
import { useTableSheetModel, ROW_ACTION_COL_W } from '@/components/sheets/useTableSheetModel'
import TableMoreMenu, { type MoreMenuItem } from '@/components/sheets/TableMoreMenu'
import AtlasView from '@/components/atlas/AtlasView'
import AtlasFieldManager from '@/components/atlas/AtlasFieldManager'
import TemplateManagerDialog from '@/components/templates/TemplateManagerDialog'
import { isTemplateTab } from '@/lib/templates/eligible'
import type { AtlasColumn } from '@/lib/atlas/columns'
import type { CustomFieldType } from '@/lib/atlas/types'
import { atlasDisplayValue } from '@/lib/atlas/schema'
import { buildAtlasPackage, parseAtlasPackage, previewAtlasImport, typeLabelsOf } from '@/lib/atlas/packageIO'
import { ATLAS_FIELD_TYPE_LABEL } from '@/lib/atlas/values'
import { atlasCategoryOptions } from '@/lib/atlas/schema'
import { usePanScroll } from '@/lib/app/usePanScroll'
import { useRowWindow } from '@/components/sheets/useRowWindow'
import { foldVh } from '@/lib/settings/theme'
import { captureWorkspaceView } from '@/lib/settings/workspaceRuntime'
import DraftSaveFeedback from '@/components/common/DraftSaveFeedback'
import { useTableWorkspaceScroll } from './useTableWorkspaceScroll'

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


/** 行窗口化阈值：小表全量渲染（零行为变化），超过就先窗口化再做别的优化 */
const ROW_WINDOW_THRESHOLD = 80

export default function TableSheet({ tab, onNavigate, ctx = { type: 'full', features: [] }, focusRowId, onFocusConsumed }: Props) {
  const model = useTableSheetModel({ tab, focusRowId, onFocusConsumed })
  /** 「历法规则」弹窗（历法清单 + 一年几个月 / 每月几天） */
  const [showCalRule, setShowCalRule] = useState(false)
  /** 「资料提及」面板（3.1 P1）：行内放大镜按钮打开，纯读不落库 */
  const [mention, setMention] = useState<{ name: string; aliases: string[] } | null>(null)
  /** 3.1.3：字段设置弹窗（自定义字段增删改、归档恢复、排序） */
  const [showFieldMgr, setShowFieldMgr] = useState(false)
  /** 3.2.0：模板管理弹窗（七个页签；采用后结构由模板快照决定） */
  const [showTemplate, setShowTemplate] = useState(false)
  useEffect(() => {
    setShowCalRule(false); setMention(null); setShowFieldMgr(false); setShowTemplate(false)
  }, [model.recordOwnerKey])
  /** 字段显示名（2.7.3）：只改界面上的字，存储键一个字节都不碰 */
  const aliasTargets = useMemo(
    () => tableAliasTargets((tab.columns ?? []).filter(c => !c.hidden)),
    [tab],
  )
  const aliasCols = useMemo(() => aliasTargets.map(t => t.key), [aliasTargets])
  const { labels: aliasLabels, renamed: aliasRenamed, save: saveRenames } = useFieldRenames(tab.id, aliasCols)

  /**
   * 表头显示名 / 悬停说明（3.1.3）：自定义字段用它的**字段名**，内置字段仍走别名单。
   * 🔴 两者都只影响显示 —— 存储键永远是 `col.name`（内置＝列名，自定义＝`cf_*`）。
   */
  const colLabelOf = (col: AtlasColumn) => col.templateLabel ?? col.atlasField?.label ?? aliasLabels[col.name] ?? col.name
  const colTitleOf = (col: AtlasColumn) => col.atlasField
    ? (col.atlasField.description || `自定义字段（存储键 ${col.name}，改名不影响已填内容）`)
    : (col.templateLabel && col.templateLabel !== col.name
      ? `${col.name}（模板显示名；存储键不变）`
      : aliasLabels[col.name] === col.name ? undefined : `${col.name}（存储键不变，AI 按当前名称理解）`)

  const {
    // 落库与装载
    rows, setRows, setDrafts, saving, saved, dirtyKeys, saveAll, loaded,
    // 行编辑（图鉴详情的就地编辑走的也是这一份草稿，不另开一套）
    addRow, setCellDraft, cellVal, isRowDirty, revertCellDrafts,
    // 排序与筛选
    sortedRows, filteredRows, colFilters, setColFilters, filterOptionsOf,
    // 列宽与拖拽
    widthOf, onResizeStart, totalWidth,
    // 树形层级
    bodyRows, 
    // 编号
    codeError,
    // 视图与高亮
    viewMode, setViewMode: storeViewMode, isTimelineCapable, isGraphCapable, isStorylineCapable, isAtlasCapable, isMaster, aiCap, aiReady,
    // 图鉴字段配置（3.1.3）
    effectiveColumns, atlasConfig, atlasNewerFormat, saveAtlasConfig, saveRowImage, atlasImageUsage, atlasImageLimit, importAtlasPackage, createAtlasFields,
    // 采用模板（3.2.0）
    templateDef,
    // 人物关系分组
    relationGroups, 
    // 历法
    calendars, saveCalendars, calendarRule, setCalendarRule,
    // AI 入口
    tableFields, showFill, setShowFill, showOrganize, setShowOrganize, showImport, setShowImport, fillRow, setFillRow, showFeedbackAI, setShowFeedbackAI, showDedupAI, setShowDedupAI, handleFill, handleFillRow, handleOrganize, handleImport,
  } = model
  const setViewMode: typeof storeViewMode = next => { captureWorkspaceView(); storeViewMode(next) }

  /**
   * 自定义字段的**类型信息**（存储键 → 类型 / 单位）—— CSV 导入回导用（3.1.3 · R09）。
   * 导出写的是给人看的值（多选→顿号、布尔→是/否、带单位数字→"18 级"），
   * 导入时必须按这份类型表还原成库里存的值，否则控件全部回显不出来。
   */
  const atlasFieldTypes = useMemo(() => {
    const out: Record<string, { customType?: CustomFieldType; unit?: string }> = {}
    for (const c of effectiveColumns) {
      if (!c.atlasField) continue
      out[c.name] = { customType: c.atlasField.customType, unit: c.atlasField.unit }
    }
    return out
  }, [effectiveColumns])

  /**
   * 导出本表为 CSV（UTF-8 BOM，Excel 直接打开不乱码）。
   * 🔴 用 `sortedRows` 而不是 `rows`（2026-10-02 六维审计 P2）：它才是屏幕上这份视图 ——
   *    与表格排序一致、且已并入未保存草稿。旧实现导出的是裸库数据：作者刚改完还没保存就导出，
   *    导出的文件里**看不到自己的改动**，而屏幕上明明有。
   * 🔴 3.1.3：列清单走 `effectiveColumns`（含自定义字段），列头用**字段名**（不暴露 cf_ 键），
   *    自定义字段的值按显示形态导出（多选→顿号、布尔→是/否）；内置列一律原值，否则导不回来。
   */
  const exportCsv = () => {
    const columns = effectiveColumns.map(col => ({ name: col.name, label: colLabelOf(col) }))
    const textOf = (name: string, raw: string) => {
      const col = effectiveColumns.find(c => c.name === name)
      return col?.atlasField ? atlasDisplayValue(col.atlasField, raw) : raw
    }
    const csv = exportRowsCsv(tab, sortedRows, { columns, textOf })
    downloadBlob(`${tab.name}.csv`, new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }))
    // 🔴 3.1.3 · R09（主人 2026-10-19 拍板）：只对**自有格式**承诺无损。
    //    CSV 是给 Excel 看的通用交换格式 —— 多维候选会被铺成一段纯文本、主图与附件根本不在里面、
    //    换行以外的排版还原不回来。导出后必须把这条边界说出来，
    //    否则作者会以为"导出的 CSV 就是完整备份"，换台机器导回来才发现少了东西。
    showToast(
      isAtlasCapable
        ? `已导出 CSV（${sortedRows.length} 条）· 通用交换格式：多维候选与主图不在里面，要完整保真请用「导出资料包」`
        : `已导出 CSV（${sortedRows.length} 条）· 只保文字：多维值按顿号铺平，格式与附件不跟着走`,
      'info', 6000,
    )
  }

  /**
   * 图鉴资料包 · 导出（方案 §8.2）：字段定义 + 全部条目 + 主图。
   * 🔴 用 `sortedRows`（含未保存草稿），与 CSV 同口径 —— 作者看到什么就带走什么。
   */
  const exportAtlasPackage = () => {
    const pkg = buildAtlasPackage(tab, atlasConfig, sortedRows)
    downloadBlob(
      `${tab.name}-图鉴资料包.json`,
      new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }),
    )
    showToast(`已导出 ${pkg.rows.length} 条（自定义字段 ${pkg.schema.fields.length} 个）`, 'success')
  }

  /**
   * 图鉴资料包 · 导入（方案 §8.3）：**先校验、再预览确认、最后才动库**。
   * 不完整/超限的包在动目标项目之前就被拒绝；页签不一致会额外问一次。
   */
  const importAtlasPackageFile = async (file: File) => {
    let owner: ReturnType<typeof model.beginOperation>
    try { owner = model.beginOperation() } catch { return }
    let text: string
    try {
      text = await file.text()
    } catch {
      if (owner.current()) showToast('文件读取失败', 'error')
      return
    }
    if (!owner.current()) return
    const r = parseAtlasPackage(text)
    if (!r.ok) { showToast(r.reason, 'error'); return }

    if (r.pkg.tabId !== tab.id) {
      const go = await confirmDialog({
        title: '页签不一致',
        message: `这份资料包来自「${r.pkg.tabName}」，当前页签是「${tab.name}」。\n\n继续导入会把它的字段与条目并入当前页签（不会删除现有内容），确定吗？`,
        danger: true,
      })
      if (!go) return
      if (!owner.current()) return
    }

    const p = previewAtlasImport(r.pkg, atlasConfig, atlasCategoryOptions(tab))
    // 这份包涉及哪些字段类型：单选 / 多选导入后需要配选项，作者提前知道能少一次意外
    const pkgTypes = typeLabelsOf(r.pkg.schema.fields)
    const typeNote = pkgTypes.length > 0
      ? `（类型：${pkgTypes.map(t => ATLAS_FIELD_TYPE_LABEL[t]).join(' / ')}）`
      : ''
    // 🔴 R08：名字撞车但定义不同的字段会另建并改名 —— **导入前**就要说清楚，
    //    否则导完凭空多一个「食性（2）」，作者只会以为是 bug。
    const conflictNote = p.conflicts.length > 0
      ? `\n\n有 ${p.conflicts.length} 个字段与现有字段同名但定义不同，不会硬合并，将**另建并改名**：${p.conflicts.slice(0, 3).map(c => `「${c.label}」→「${c.label}（新）」(${c.reason})`).join('；')}`
      : ''
    const catNote = p.unknownCategories.length > 0
      ? `\n\n类别值里有 ${p.unknownCategories.length} 个目标表还没有（${p.unknownCategories.slice(0, 3).join('、')}${p.unknownCategories.length > 3 ? '…' : ''}）—— 导入后会自动登记成「类别」列的自定义选项，不会丢值。`
      : ''
    const ok = await confirmDialog({
      title: '导入图鉴资料包',
      message: `将导入 ${p.rows} 条条目；字段：复用 ${p.reusedFields} 个、新建 ${p.createdFields} 个${typeNote}；其中 ${p.images} 条带主图。\n\n导入只**新增**、不覆盖现有条目；图片受项目容量限制（装不下会跳过图片并在结果里说明）。${catNote}${conflictNote}`,
    })
    if (!ok) return
    if (!owner.current()) return

    try {
      const res = await importAtlasPackage(r.pkg)
      owner.assertCurrent()
      // 未知类别值登记为「类别」列的自定义选项 —— 否则行内下拉显示空白，作者会以为值丢了
      for (const v of p.unknownCategories) {
        owner.assertCurrent()
        try { await addCustomItem(tab.id, '类别', v) } catch { /* 登记失败不影响条目本身 */ }
        owner.assertCurrent()
      }
      const strip = res.strippedImages > 0 ? `；容量不足，有 ${res.strippedImages} 条图片未导入` : ''
      // 🔴 R11：如实报"部分成功"—— 已入库的已并入列表，失败的那几条没进来；
      //    同一份包再导一次只会补上缺的（条目 id 由包指纹算出，重试幂等，不会翻倍）。
      const partial = res.failed > 0 ? `；${res.failed} 条落库失败（${res.failure}）—— 已导入的已在列表里，可再导一次补齐` : ''
      const level = res.failed > 0 ? 'error' : (strip ? 'error' : 'success')
      showToast(`已导入 ${res.added} 条，新建字段 ${res.createdFields} 个${strip}${partial}`, level)
    } catch (e) {
      if (!owner.current()) return
      showToast('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  /**
   * 「导入导出」菜单的项（3.1.2 B 条起；2026-10-18 起菜单里**只剩导入/导出**）。
   * 母表（章节总表）不提供导入导出 —— 它的行由各卷台账驱动，手填会打架，故整份菜单为空 ⇒ 组件自动不渲染。
   *
   * 🔴 「清空全部」已从这个菜单里挪出去（见下方 `canClear`）：它一在里面，菜单就只能叫「更多」，
   *    而主人反馈「点开才知道是导入导出」。现在菜单永远只有导入导出 ⇒ 按钮名可以如实叫「导入导出」，
   *    清空变成旁边一个**常态中性、hover 才红**的图标键（危险色不常驻，见项目红线）。
   */
  const moreItems: MoreMenuItem[] = isMaster ? [] : [
    {
      key: 'import',
      label: '批量导入',
      icon: <FileDown size={13} />,
      title: '批量导入：粘贴表格 / CSV / 纯文本并上传文件；散文式设定可用「AI 智能拆分」自动解析成多条',
      onClick: () => setShowImport(true),
    },
    {
      key: 'export',
      label: '导出 CSV',
      icon: <FileUp size={13} />,
      title: '导出本表数据为 CSV（Excel 可直接打开）· 通用交换格式，多维候选与图片不在里面',
      onClick: exportCsv,
    },
  ]

  /** 只有人物关系 / 历史事件支持清空（与原来菜单项的可见条件逐字一致，功能不增减） */
  const canClear = ['relations', 'history'].includes(tab.id) && rows.length > 0

  /**
   * 清空本表全部记录。
   * 🔴 串行 await（2026-10-10 六维审计）：原先 forEach + void 是**并发发起且不等待**，
   *    失败被静默吞掉 ⇒ 界面已清空、库里可能残留（重开这一页它们又冒出来）。
   */
  const clearAll = async () => {
    if (!await confirmDialog({ title: `清空「${tab.name}」`, message: `确定清空「${tab.name}」中所有 ${rows.length} 条记录？`, danger: true })) return
    let failedCount = 0
    for (const row of rows) {
      try { await deleteTableRow(row.id) } catch { failedCount++ }
    }
    setRows([])
    setDrafts({})
    if (failedCount) showToast(`有 ${failedCount} 条没能删掉（其余已清除）—— 请再试一次`, 'error')
  }

  /**
   * 宽表格「左键按住拖动平移」（2026-10-17 主人反馈）＋ **表头冻结**。
   *   原状：横向只能拖底部滚动条；表格一长往下翻，表头（列名 + 筛选框）就滚没了。
   *   现在：左键按住表格左右一拖即横向平移（阈值 4px，单击仍正常进单元格）；
   *        表格内容区独立纵向滚动，表头 `sticky` 钉在顶部，`maxHeight` 只在**内容确实长**时才生效。
   *   按键口径：只认**左键**（主人 review 拍板「保留一个常用的就好」；右键就是系统菜单，本表格没有自有右键菜单）。
   * 🔴 必须放在 `if (!loaded) return` **之前** —— React 要求 hook 的调用顺序每次渲染都一致。
   */
  const pan = usePanScroll<HTMLDivElement>()

  /**
   * 行窗口化（3.2.3 · P2）：行数超过阈值时只挂视口附近的行。
   * 实测依据见 `docs/归档/3.2/3.2.3-P1行级读取上提-2026-10-25.md` —— 取数放大修完后，
   * 300 行 × 74 列的首屏 12.7 s 全部花在「22,200 个单元格全量挂 DOM」上。
   * 🔴 阈值以下是全量渲染（小表零行为变化）；跳转聚焦的行用 `pinnedId` 强制留在窗口里。
   */
  const rowIds = useMemo(() => model.bodyRows.map(entry => entry.row.id), [model.bodyRows])
  /** 跳转聚焦：只在目标行**变化**时滚一次（否则高亮期间每次输入都会把容器拉回去） */
  const lastFocusId = useRef<string | null>(null)
  const [restoreRowId, pinRestore] = useState<string | null>(null)
  const rowWindow = useRowWindow({
    ids: rowIds,
    rowRefs: model.rowRefs,
    scrollRef: pan.ref,
    enabled: loaded && viewMode === 'table' && rowIds.length > ROW_WINDOW_THRESHOLD,
    pinnedId: focusRowId ?? restoreRowId,
  })
  const revealRow = rowWindow.revealId
  useTableWorkspaceScroll({ tabId: tab.id, ready: loaded && viewMode === 'table' && tab.id !== 'relations',
    ids: rowIds, filters: colFilters, scrollRef: pan.ref, revealId: revealRow, focusRowId, pinRestore })

  /**
   * 跳转聚焦先「滚到附近」：虚拟化后目标行可能压根没挂载，靠 scrollIntoView 会扑空。
   * 模型侧再用有界轮询接住高亮（见 `useTableSheetModel` 的 focusRowId effect）。
   */
  useEffect(() => {
    if (!focusRowId || lastFocusId.current === focusRowId) return
    lastFocusId.current = focusRowId
    revealRow(focusRowId)
  }, [focusRowId, revealRow])

  /**
   * 「右边还有内容」渐隐提示（3.1.2 视觉巡检 C 条）：
   *   列一多，表格总宽就会超过容器（table-fixed 的正常机制），最右一列常被切掉半个列名 ——
   *   那不是渲染坏了，但界面上**没有任何「还能往右滑」的暗示**，作者第一眼会当成 bug。
   *   这里在容器右缘压一道渐隐；滑到最右（没有更多内容）时它自动消失，不留常驻装饰。
   */
  const [scrollHint, setScrollHint] = useState(false)
  const syncScrollHint = useCallback(() => {
    const el = pan.ref.current
    setScrollHint(!!el && el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
  }, [pan.ref])
  useEffect(() => {
    syncScrollHint()
    const el = pan.ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // 容器尺寸变了（窗口缩放 / 界面缩放 / 列宽拖拽）也要重算，否则提示会僵在旧状态
    const ro = new ResizeObserver(syncScrollHint)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows/totalWidth 变化会改变 scrollWidth，需重算
  }, [syncScrollHint, rows.length, totalWidth, tab.id])

  if (model.loadError) return <div role="alert" className="rounded-xl border border-danger/40 p-5 text-13 text-ink-200">
    <h1 className="mb-2 font-semibold">暂时无法读取{tab.name}</h1>
    <p className="mb-3 text-ink-400">请确认存储连接后重新读取。</p>
    <Button onClick={model.retry} variant="secondary">重试读取表格</Button>
  </div>
  if (!loaded) return <LoadingState />

  return (
    <div className="page-enter">
      {/* 头部
          🔴🔴 2026-10-09 主人反馈「缩小窗口时页面显示异常」：本页工具条很长（历史事件表 1105px），
          原来它是 `shrink-0`（不可压缩）、而左侧标题容器只有 `min-w-0`（**能被压到 0 宽**）——
          于是可用宽度不足时标题与描述被压成一条竖缝、工具条右侧被裁掉。
          现在改成「**放不下就折行**」：
            · header 加 `flex-wrap` —— 一行塞不下时工具条整体落到第二行；
            · 左栏 `flex-1` + `min-w-[14rem]` —— flex-basis 归零，让换行判断不受它那长描述影响
              （否则宽屏也会误判成"放不下"），同时保底 224px 不再被压成 0；
            · 工具条去掉 `shrink-0` 并加 `flex-wrap justify-end ml-auto` ——
              它独占一行时会被压到行宽、内部按钮再按需折行，且始终靠右。
          宽屏下三者都不生效 ⇒ 版式与改动前逐像素一致。 */}
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
        <div className="min-w-[14rem] flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
            <HelpPopover title={`${tab.name} · 怎么用`} width="23rem" size={13}>{`这是「${tab.name}」数据表，常见操作：

· 右上「新增一行」添加记录；表格内直接点单元格编辑，改完点「保存」（或 Ctrl+S）。
· 列宽可拖拽：拖动列标题右缘的分隔条调整宽度，只改当前列、不挤压其他列；整体超出页面时表格底部出现横向滑条。
· 表头筛选（v1.9.1）：每列标题下方都有筛选框——文本列输入关键字按「包含」匹配；下拉列点开选值按「精确」匹配，候选值与行内下拉完全一致（含你自己新增的自定义值，以及被隐藏 / 改名后的内置项），在行内改动选项后表头会立即同步。
· 下拉类型的列（如状态、关系类型）点击即弹出选项，可自定义 / 重命名；但「保密等级」「历法」等固定 / 受管列是封闭枚举，不提供自定义入口。
· 部分列是专用控件：真实日期列（如发布日期、写作进度日期）点开弹出月历选择；人物关系的「人物A / 人物B」从已创建角色卡中选择、不可手填。
· 带「编号 / 章节号」的表按编号自动排序，空白沉底（章节总表例外：按创建时间倒序，最新写的章节在最上面）；编号不可重复，删除后的编号会被后续新增的条目补上（补最小的空号），删除前有引用检查提示。
· 单元格里出现 F0001 / H0001 这类编号，会自动生成跳转按钮，直达伏笔表 / 历史事件。
· 历史事件、时间脉络页签可在右上「表格 ⇄ 时间轴」切换视图；时间轴按「历法」列的数值判定跨历法先后顺序。历法的全部设置都在页头「历法规则」里统一管理（新增 / 改名 / 删除 / 改数值），表格的「历法」列只做选择 —— 改名会连带更新两张表里已引用旧名的行，删除则只把历法从清单移除、已填的行保留旧名文本。
· 这两张表的时间是「发生时间 / 结束时间」两端：一天内的事两端填同一天，持续性的事件填上结束时间，时间轴会用一段横条画出这段时长。年份可填负数与 0（如 -300 = 公元前 300 年）；「一年几个月、每月几天」在页头「历法规则」里改（默认 12 月 × 30 天）。
· 时间轴的「间距」可切「等距」（默认）与「按时间」：按真实时间差排布；遇到超长空档会自动压缩，并在轴上画断裂符 ⟋⟋ 标出真实跨度（悬停看详情），避免整条轴被一个空档撑爆。
· 人物关系按「人物A / 人物B」自动归入双方文件夹，便于按人查阅；右上「表格 ⇄ 关系图」可切换关系图。同一对人物 / 势力可登记多条关系（「人物A → 人物B」为有向，A 是视角主体；如既「盟友」又「暗中提防」），只有「同对同向 + 同类型」才算重复。
· 关系图交互（v1.6；多关系 v2.1）：「拖动节点」微调布局、「拖拽空白处平移」画布、「滚轮缩放」（0.4x–3x）、「点击节点收起/展开」其关系边；工具栏有放大/缩小/重置视图；底部图例按关系类型着色——自定义的关系类型也有专属颜色。同一对的多条关系会分弧铺开、并用箭头标出各自方向。
· 伏笔追踪可切到「剧情线」视图（v1.6.1）：自动聚合伏笔（埋设/回收）、爽点、时间脉络事件，按章节串成一条叙事主线；顶部统计悬空伏笔与「已到点未回收」的警示。
· 带「上级 / 层级归属」列的表（国家势力、地理风物、种族生物、物品资源、历史事件、名词术语等）支持「树形层级」：按隶属关系折叠 / 展开，行首的树形图标按钮可在某条下新增子条目（编号形如「父编号-001」，父级顺序号不变），父级下拉自动排除自身与子孙防成环。
· 行首操作会按表格能力显示：适用时可删除此行、AI 补全本行空白（只填当前行未填字段，不影响其他行 / 表）或新增子条目；母表、无 AI 能力或无层级的表会隐藏不适用操作。章节总表行首另有「打开正文」按钮。
· 批量：右上角的 AI 按钮（不同表显示为「AI 整理」或「AI 新增」，部分表没有这个按钮）——「AI 整理」从章节正文 / 已有设定批量整理出尚未登记的条目并落盘（不重复生成）；「AI 新增」则新建一行并由 AI 补全整行。
· 右上「更多」菜单里是低频操作：**批量导入**（粘贴表格 / CSV / 纯文本或上传文件，散文式设定可用「AI 智能拆分」自动解析成多条）、**导出 CSV**（Excel 可直接打开）；人物关系 / 历史事件另有**清空全部**（会先问一次再删）。
· CSV 是**通用交换格式，不是无损备份**：多维候选会被铺成一段纯文本、图片与附件根本不在文件里、换行以外的排版也还原不回来。要原样搬运（含字段定义与主图），请用图鉴页签的「导出资料包」。`}
            <AIDataSourceNote feature="organize-rows" />
          </HelpPopover>
          </div>
          <p className="mt-1.5 text-13 text-ink-300 leading-relaxed max-w-3xl">{tab.description}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className={`text-11 transition-opacity ${saved ? 'opacity-100 text-success' : 'opacity-0'}`}>
            <Check size={11} className="inline -mt-0.5 mr-0.5" />已提交
          </span>
          <span className="text-10 text-ink-500">
            {tab.id === 'relations'
              ? `共 ${rows.length} 条关系 · ${relationGroups.filter(g => !g.unnamed).length} 位人物`
              : tab.newestFirst
                ? `共 ${filteredRows.length} 行 · 按创建时间倒序`
                : tab.columns?.some(c => c.name === '编号' || c.name === '章节号')
                  ? `共 ${filteredRows.length} 行 · 按编号排序`
                  : `共 ${filteredRows.length} 行 · 按编辑时间排序`}
          </span>
          {/* 字段显示名 + 字段设置＝同一件事的两个入口（2026-10-18 主人反馈）。
              图鉴页签把它并进「字段设置」面板，这里就不再单独出现；其他表格没有那个面板，
              仍用「字段名」按钮 —— 两边写的是同一份 `fieldAlias` 存储。 */}
          {aliasCols.length > 0 && !isAtlasCapable && !templateDef && (
            <FieldAliasButton
              tabId={tab.id}
              tabName={tab.name}
              intro="给这一页的列起你自己看得懂的名字（例如把「契约/驯化关系」改成「外勤预约」）。"
              targets={aliasTargets}
            />
          )}
          {/* 3.2.0 T1：模板管理（七个页签）。采用过模板后，字段设置 / 字段名都收进这里 ——
              结构只认一份快照，避免两个入口各改一半。 */}
          {isTemplateTab(tab.id) && (
            <Button variant="secondary" onClick={() => setShowTemplate(true)}
              className="flex items-center gap-1.5"
              title={templateDef
                ? `模板「${templateDef.name}」第 ${templateDef.revision} 版：编辑字段与分组、预览变更、恢复到迁移前`
                : '套用模板：把当前结构固定成一份可编辑快照，或从空白开始设计这一页'}
            >
              <LayoutTemplate size={12} /> {templateDef ? '模板' : '套用模板'}
            </Button>
          )}
          {/* 3.1.3：字段设置（自定义字段增删改 / 归档恢复 / 排序 + 内置字段显示名），只对图鉴页签出现 */}
          {isAtlasCapable && !templateDef && (
            <Button variant="secondary" onClick={() => setShowFieldMgr(true)}
              className="flex items-center gap-1.5"
              title="字段设置：加自定义字段（例如魔兽的「食性」、丹药的「副作用」），改内置字段的显示名，可归档 / 恢复 / 调整顺序"
            >
              <Settings2 size={12} /> 字段设置
            </Button>
          )}
          {!isMaster && (
          <Button variant="bare"
            onClick={saveAll}
            disabled={dirtyKeys.length === 0 || saving}
            className={`flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium border transition-colors
              ${dirtyKeys.length > 0
                ? 'bg-amber/15 text-amber border-amber/40 hover:bg-amber/25'
                : 'bg-ink-800 text-ink-500 border-ink-700 cursor-not-allowed'}`}
            title={dirtyKeys.length > 0 ? '保存全部（Ctrl+S）' : '无未保存的改动'}
          >
            <Save size={13} /> {saving ? '保存中…' : '保存'}
          </Button>
          )}
          {/* 3.1.2 B 条：低频 / 危险操作收进「更多」菜单（原「清空全部」是常驻红按钮 ——
              危险色常驻会压住整页的重点，且它与「导入 / 导出」一起把工具条挤到折行） */}
          <TableMoreMenu items={moreItems} />
          {/* 清空全部：单独一个图标键，常态中性、hover 才红（危险色不常驻是本项目红线） */}
          {canClear && (
            <Button variant="icon-danger" size="sm" onClick={() => void clearAll()}
              title={`清空「${tab.name}」中所有 ${rows.length} 条记录（会先问你一次，删了不可恢复）`}>
              <Trash2 size={13} />
            </Button>
          )}
          {/* 3.1.3：种族生物 / 物品资源的「表格 ⇄ 图鉴」（方案 §3.1；入口只开放 races / items） */}
          {isAtlasCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('atlas')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'atlas' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
                title="图鉴视图：卡片墙浏览，点卡片看完整资料，可就地编辑（与表格共用同一份草稿）"
              >
                <BookOpen size={11} /> 图鉴
              </Button>
            </div>
          )}
          {isTimelineCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('timeline')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'timeline' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Calendar size={11} /> 时间轴
              </Button>
            </div>
          )}
          {/* 历法规则：只有带「故事内时间」列的表（历史事件 / 时间脉络）才需要它。
              ⚠️ 刻意挂在时间轴切换旁边 —— 这两件事本来就是同一件事的两半（排序口径）。 */}
          {isTimelineCapable && (
            <Button variant="secondary" onClick={() => setShowCalRule(true)}
              className="flex items-center gap-1.5 font-medium shrink-0"
              title={`当前：一年 ${calendarRule.monthsPerYear} 个月 × 每月 ${calendarRule.daysPerMonth} 天（共 ${calendarRule.monthsPerYear * calendarRule.daysPerMonth} 天）。点这里修改 —— 月份与日期的下拉、时间轴的持续时长都按它算`}
            >
              <CalendarClock size={12} /> 历法规则
            </Button>
          )}
          {isGraphCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
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
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('storyline')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'storyline' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <GitBranch size={11} /> 剧情线
              </Button>
            </div>
          )}
          {!isMaster && (
          <Button onClick={addRow} variant="primary" size="md" className="flex items-center shrink-0">
            <Plus size={14} /> {tab.id === 'relations' ? '新增一条关系' : '新增一行'}
          </Button>
          )}
          {aiCap !== 'none' && !isMaster && (
            <Button variant="secondary" onClick={() => (aiCap === 'organize' ? setShowOrganize(true) : setShowFill(true))} disabled={!aiReady} className="flex items-center gap-1.5 transition-colors shrink-0 disabled:hover:bg-ink-800" title={ !aiReady ? AI_DISABLED_HINT : aiCap === 'organize' ? '让 AI 从章节正文 / 已有设定中整理出尚未登记的条目（不会重复生成）' : 'AI 新增一行：提供粗略设定，由 AI 补全整行字段后落盘（不影响已有行 / 其他表）' }>
              <Sparkles size={14} /> {aiCap === 'organize' ? 'AI 整理' : 'AI 新增'}
            </Button>
          )}
          {/* 读者反馈：AI 分析（运营维护组，不接补全/整理，单独开分析入口） */}
          {tab.id === 'feedback' && (
            <Button variant="secondary" onClick={() => setShowFeedbackAI(true)} disabled={!aiReady} className="flex items-center gap-1.5 transition-colors shrink-0 disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '用 AI 分析读者反馈数据：流失归因 + 应对建议'}>
              <Sparkles size={14} /> AI 分析反馈
            </Button>
          )}
          {/* 名词术语：AI 查重（在「AI 新增」之外，额外提供同义/重复归一入口） */}
          {tab.id === 'terms' && (
            <Button variant="secondary" onClick={() => setShowDedupAI(true)} disabled={!aiReady} className="flex items-center gap-1.5 transition-colors shrink-0 disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '用 AI 查找同义/重复的术语，建议合并归一'}>
              <Sparkles size={14} /> AI 查重
            </Button>
          )}
        </div>
      </header>

      {/* 编号规则说明（有编号列的表格展示，防止编号混乱无法识别） */}
      {tab.codeRule && (
        <div className="mb-4 rounded-lg border border-amber/20 bg-amber/5 px-3.5 py-2.5 flex items-start gap-2">
          <Hash size={12} className="mt-0.5 shrink-0 text-amber/80" />
          <span className="text-11 text-amber/80 leading-relaxed">{tab.codeRule}</span>
        </div>
      )}

      {/* 编号校验错误：存在重复编号时阻止保存并提示修改 */}
      {codeError && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 flex items-start gap-2 animate-pulse">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-danger" />
          <span className="text-11 text-danger leading-relaxed">
            <b>编号校验未通过，无法保存：</b>{codeError}。请修改编号后重新保存。
          </span>
        </div>
      )}

      {/* history / timeline 页签可切到时间轴视图；人物关系可切到关系图 */}
      <DraftSaveFeedback state={model.saveState} dirty={dirtyKeys.length > 0} onRetry={() => void saveAll()} />
      {viewMode === 'atlas' && isAtlasCapable ? (
        /* ============ 3.1.3 图鉴视图（卡片墙 + 详情，实现已拆到 components/atlas） ============ */
        <AtlasView
          projectId={getCurrentProjectId()}
          focusRowId={focusRowId}
          onFocusConsumed={onFocusConsumed}
          tab={tab}
          rows={filteredRows}
          aliases={aliasLabels}
          config={atlasConfig}
          templateDef={templateDef}
          onEditInTable={() => setViewMode('table')}
          onSaveImage={saveRowImage}
          imageUsage={atlasImageUsage}
          imageLimit={atlasImageLimit}
          onExportPackage={exportAtlasPackage}
          onImportPackage={file => void importAtlasPackageFile(file)}
          // 🟢 3.1.3 详情就地编辑：值与草稿全走表格这一份，详情不持有第二份数据
          cellValue={cellVal}
          onCellChange={setCellDraft}
          dirtyOf={id => {
            const r = rows.find(x => x.id === id)
            return r ? isRowDirty(r) : false
          }}
          saving={saving}
          onSave={saveAll}
          onRevert={revertCellDrafts}
        />
      ) : viewMode === 'graph' ? (
        tab.id === 'faction-rels' ? <FactionGraph rows={rows} onNavigate={onNavigate} /> : <RelationGraph rows={rows} />
      ) : viewMode === 'storyline' && tab.id === 'foreshadow' ? (
        <StorylineView />
      ) : viewMode === 'timeline' && tab.id === 'history' ? (
        <HistoryTimeline rows={rows} tab={tab} calendars={calendars} calendarRule={calendarRule} />
      ) : viewMode === 'timeline' && tab.id === 'timeline' ? (
        <StoryTimeline rows={rows} tab={tab} calendars={calendars} calendarRule={calendarRule} />
  ) : tab.id === 'relations' ? (
    /* ============ 人物关系：按人物分组的文件夹视图（实现已拆到 TableRelationGroups） ============ */
    <TableRelationGroups tab={tab} model={model} ctx={ctx}
      onOpenMentions={(name, aliases) => setMention({ name, aliases })} />
  ) : (
        <>
      {/* 表格 */}
      <div className="relative rounded-xl border border-ink-700 bg-ink-850 overflow-hidden">
        {/* 🔴 表头冻结 + 左键拖拽平移（2026-10-17）：纵向滚动收进本容器（maxHeight 只在内容长时生效），
            表头 sticky 钉顶；横向既可拖滚动条，也可左键按住直接拖动。 */}
        <div
          ref={pan.ref}
          data-table-scroll
          onScroll={syncScrollHint}
          onMouseDown={pan.handlers.onMouseDown}
          onMouseMove={pan.handlers.onMouseMove}
          onMouseUp={pan.handlers.onMouseUp}
          onMouseLeave={pan.handlers.onMouseLeave}
          onClickCapture={pan.handlers.onClickCapture}
          className={
            'overflow-x-auto overflow-y-auto ' +
            (pan.dragging ? 'cursor-grabbing select-none ' : 'cursor-grab ')
          }
          style={{ maxHeight: foldVh('62vh') }}
        >
          <table className="text-12 table-fixed" style={{ width: totalWidth || undefined, minWidth: '100%' }}>
            {/* 🔴 sticky 表头：tr 上 sticky + 每个 th 补不透明背景（否则滚动时下面几行会透出来） */}
            <thead>
              <tr className="sticky top-0 z-10 bg-ink-800 border-b border-ink-700">
                <th className="bg-ink-800 w-10 px-2 py-2.5 align-middle text-ink-500 text-10 font-medium">#</th>
                <th className="bg-ink-800 px-1 py-2.5 align-middle" style={{ width: ROW_ACTION_COL_W }} />
                {effectiveColumns.map(col => (
                  <th key={col.name} data-workspace-column={col.name} className="bg-ink-800 px-3 py-2 align-middle text-left text-ink-200 font-semibold whitespace-nowrap relative" style={{ width: widthOf(col.name) }}>
                    <div className="truncate" title={colTitleOf(col)}>{colLabelOf(col)}</div>
                    {col.type === 'select' && col.options ? (
                      <select
                        value={colFilters[col.name] ?? ''}
                        onChange={e => setColFilters(prev => ({ ...prev, [col.name]: e.target.value }))}
                        className="mt-1 w-full text-10 px-1 py-0.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 outline-none focus:border-amber/40"
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
                        className="mt-1 w-full text-10 px-1.5 py-0.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 placeholder:text-ink-600 outline-none focus:border-amber/40"
                      />
                    )}
                    <div
                      onMouseDown={e => onResizeStart(e, col.name)}
                      data-nodrag
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
                  <td colSpan={effectiveColumns.length + 2} className="px-4 py-16 text-center text-ink-500">
                    <div className="flex flex-col items-center gap-2">
                      <Plus size={20} className="text-ink-600" />
                      <span>{rows.length === 0 ? (isMaster ? '各卷台账还没有章节，去左侧各卷「章节台账」表录入即可在此汇总显示' : '还没有记录，点击右上角「新增一行」开始') : '没有符合筛选条件的记录'}</span>
                    </div>
                  </td>
                </tr>
              )}
              {/* 窗口上方的行用一条撑高占位行顶上：表格结构不变（sticky 表头 / table-fixed 列宽 / 拖拽平移都不受影响） */}
              {rowWindow.topPad > 0 && (
                <tr aria-hidden data-row-spacer="top">
                  <td colSpan={effectiveColumns.length + 2} style={{ height: rowWindow.topPad, padding: 0, border: 0 }} />
                </tr>
              )}
              {bodyRows.slice(rowWindow.start, rowWindow.end).map((entry, i) => (
                <TableSheetRow
                  key={entry.row.id}
                  tab={tab}
                  model={model}
                  entry={entry}
                  index={rowWindow.start + i}
                  onNavigate={onNavigate}
                  onOpenMentions={(name, aliases) => setMention({ name, aliases })}
                  ctx={ctx}
                />
              ))}
              {rowWindow.bottomPad > 0 && (
                <tr aria-hidden data-row-spacer="bottom">
                  <td colSpan={effectiveColumns.length + 2} style={{ height: rowWindow.bottomPad, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* C 条：右侧渐隐提示（只在确实还有内容没露出来时出现；纯装饰，不接鼠标事件） */}
        {scrollHint && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-ink-850 via-ink-850/70 to-transparent"
            style={{ zIndex: Z.pageBase }}
          />
        )}
      </div>
        </>
      )}

      {/* 底部提示 */}
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

      {dirtyKeys.length > 0 && !isMaster && viewMode !== 'atlas' && (
        <SaveFab onClick={saveAll} label={`保存 ${dirtyKeys.length} 行修改`} />
      )}

      {showFill && (
        <AITemplateFill
          fields={tableFields}
          tabId={tab.id}
          draftScope={`table::${tab.id}`}
          title={`AI 新增 · ${tab.name}`}
          sketchPlaceholder="例如：北境最大的商盟，掌控三条主干商路，与皇室关系微妙，暗中资助主角……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}

      {fillRow && (
        <AITemplateFill
          fields={tableFields}
          tabId={tab.id}
          existing={fillRow.data}
          draftScope={`row::${tab.id}::${fillRow.id}`}
          title={`AI 补全本行空白 · ${tab.name}`}
          sketchPlaceholder="补充这一行已填内容的背景 / 细节，让 AI 补全其余空白字段（已填的不会动）…"
          onSubmit={values => handleFillRow(fillRow, values)}
          onClose={() => setFillRow(null)}
        />
      )}

      {showImport && (
        <TableImportDialog
          tab={tab}
          existing={sortedRows}
          calendars={calendars}
          visCtx={ctx}
          extraColumns={effectiveColumns
            .filter(c => c.atlasField)
            .map(c => ({ name: c.name, label: c.atlasField!.label }))}
          // 🔴 R09：类型信息一起传，导出的"显示值"才能还原成库里的"存储值"
          fieldTypes={atlasFieldTypes}
          onCreateFields={isAtlasCapable ? createAtlasFields : undefined}
          onAdd={handleImport}
          onClose={() => setShowImport(false)}
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
      {isAtlasCapable && showFieldMgr && atlasConfig && (
        <AtlasFieldManager
          tab={tab}
          config={atlasConfig}
          readOnly={atlasNewerFormat}
          aliasKeys={aliasCols}
          aliases={aliasRenamed}
          onSaveAliases={next => saveRenames(next, {})}
          onSave={saveAtlasConfig}
          onClose={() => setShowFieldMgr(false)}
        />
      )}
      {isTemplateTab(tab.id) && showTemplate && (
        <TemplateManagerDialog
          tab={tab}
          atlasConfig={atlasConfig}
          onClose={() => setShowTemplate(false)}
        />
      )}
      {showCalRule && (
        <CalendarRuleModal
          open
          rule={calendarRule}
          calendars={calendars}
          onSave={({ rule: nextRule, calendars: nextCalendars, renames }) => {
            setCalendarRule(nextRule)
            // 改名要连带更新已引用旧名的行（历史事件 / 时间脉络），见 saveCalendars 的注释
            void saveCalendars(nextCalendars, renames)
            setShowCalRule(false)
          }}
          onClose={() => setShowCalRule(false)}
        />
      )}
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


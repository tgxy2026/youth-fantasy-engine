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
 *   · **列宽记忆**走 uiPrefs（`yfe-ui:` 命名空间）的纯 UI 偏好：写失败（隐私模式/配额满）静默忽略；
 *     老键 `yfe-colw::<表 id>` 首次读取时一次性迁移过来（不迁移＝老用户调过的列宽静默回默认）。
 *   · **编号 = 补最小空号**（见 lib/autoCode.ts）：删除的编号允许被新增条目复用，
 *     删除前经 lib/codeRefs.ts 做引用检查并在确认弹窗里如实提示（只提示、不拦截）。
 *   · 列宽拖拽的位移必须按界面缩放折算（clientX 是视口像素，列宽是 CSS 像素）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { CalendarDef, TableRow, TabDef } from '@/lib/types'
import {
  deleteTableRow, getCurrentProjectId, getCustomOptions,
  getSetting, getTableRows, getTableRowsFor, saveTableRow, setSetting, setSettingFor, type CustomOptionPayload,
} from '@/lib/db'
import { AUTONUM_GROUPS, nextAutoCode } from '@/lib/ai/autoCode'
import { countCodeRefs, codeRefWarning } from '@/lib/app/codeRefs'
import {
  ATLAS_TABS, atlasAiVisibilityChanged, emptyAtlasSchema, isAtlasTab,
} from '@/lib/atlas/schema'
import { loadAtlasAiWriteTargets, type AtlasAiWriteTargets } from '@/lib/ai/atlasContext'
import { aiWriteFieldsOf, fieldHintForAI } from '@/lib/templates/consumers'
import { invalidateIndex } from '@/lib/semantic/indexer'
import { customColumnWidth } from '@/lib/atlas/columns'
import { useSheetTemplate, useAiWriteBasis } from '@/components/templates/useSheetTemplate'
import { guardTabWrite } from '@/lib/templates/migrationGuard'
import { loadAtlasSchema, newFieldId, saveAtlasSchema } from '@/lib/atlas/persistence'
import { useTableRefOptions } from '@/components/sheets/useTableRefOptions'
import { useRowFocusHighlight } from '@/components/sheets/useRowFocusHighlight'
import { coerceAiValue } from '@/lib/atlas/values'
import { ATLAS_TOTAL_LIMIT, atlasImageUsageOf, checkAtlasBudget } from '@/lib/atlas/quota'
import { WEB_CLOUD } from '@/lib/app/platform'
import { packageRowId, planAtlasImport, type AtlasPackage } from '@/lib/atlas/packageIO'
import {
  colWidthsKey, migrateColWidths, sortRows, TABLE_VIEW_MODES, type TableViewMode,
} from '@/components/sheets/tableSheetOrder'
import { revertDraftCells } from '@/components/sheets/tableSheetDraftOps'
import { useTableRecordWorkspace } from './useTableRecordWorkspace'
import { createTableImageWriter } from '@/lib/atlas/writeImage'
import type { AtlasFieldDefinition, AtlasSchemaConfig, AtlasTabId, CustomFieldType } from '@/lib/atlas/types'
import { uid } from '@/lib/app/id'
import { captureCandidateOwner } from '@/lib/ai/candidateContext'
import { useTableWorkspaceFilters } from './useTableWorkspaceFilters'
import { aiCapabilityOf } from '@/lib/ai/aiScope'
import { buildImportRows, type ImportRowResult } from '@/lib/storage/tableIO'
import { useAIReady } from '@/lib/ai/useAIReady'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { clearFreeDraft } from '@/lib/editor/freeDraft'
import { useCalendarRule } from '@/lib/app/useCalendarRule'
import { CUSTOM_OPTIONS_EVENT, resolveOptions } from '@/components/common/CustomSelect'
import { usePersistedSet, usePersistedEnum, readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import type { TemplateField } from '@/lib/ai'

/**
 * 行首操作列宽（px）—— 🔴 **单一真源，三处必须同源**，不许各写各的：
 *   ① 本文件 `totalWidth` 累加它；
 *   ② `TableSheet.tsx` 表头 th 用它设宽；
 *   ③ `TableSheetRow.tsx` 行首 td 用它设宽。
 * 为什么是 64：OPT-008（主人 2026-10-17）行首钮从「28px 窄列竖排」改 **2×2** ——
 *   两枚 24px 图标钮（Button xs iconOnly，`h-6 w-6`）＋ 2px 间距 ＋ 8px 内边距 ≈ 58px ⇒ 取 64。
 *   原 28px 单列竖排 4 钮会把**每一行**撑高约 100px（主人：「页面变得很长、很难看」）。
 */
export const ROW_ACTION_COL_W = 64

type Args = {
  tab: TabDef
  /** 数据体检 / 跨组件跳转带下来的目标行 id */
  focusRowId?: string | null
  /** 高亮消费后回调（清除上层 focusRowId 以便重复跳转） */
  onFocusConsumed?: () => void
}

export function useTableSheetModel({ tab, focusRowId, onFocusConsumed }: Args) {
  const validateBeforeSave = useRef<() => string | null>(() => null)
  const { rows, setRows, rowsRef, drafts, setDrafts, draftsRef, loaded, loadError, retry,
    saving, flushRecords, saveState, ownerKey: recordOwnerKey, projectId: recordProjectId, isCurrent: isRecordCurrent,
    beginOperation } = useTableRecordWorkspace(tab.id, () => validateBeforeSave.current())
  // 数据体检 / 跨组件跳转：聚焦并高亮目标行
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  // history / timeline 两个页签提供"表格 ⇄ 时间轴"视图切换
  const isTimelineCapable = tab.id === 'history' || tab.id === 'timeline'
  // 人物关系 / 势力关系 提供"关系图"视图
  const isGraphCapable = tab.id === 'relations' || tab.id === 'faction-rels'
  // 伏笔追踪提供"剧情线"视图（聚合伏笔 + 爽点 + 时间脉络，v1.6.1）
  const isStorylineCapable = tab.id === 'foreshadow'
  /**
   * 3.1.3：种族生物 / 物品资源提供「表格 ⇄ 图鉴」视图切换。
   * 🔴 判据只有一个来源 —— `lib/atlas/schema.ts` 的 `isAtlasTab()`：
   *    这里写死 `tab.id === 'races' || ...` 就会与字段解析层各说各话。
   */
  const isAtlasCapable = isAtlasTab(tab.id)
  // 章节总表：只读汇总视图（聚合所有卷台账），不可直接编辑，编辑请到各卷子表
  const isMaster = tab.id === 'chapter-master'
  /**
   * 视图偏好（方案 §3.4）：按「项目 + 页签」记忆，切走再回来仍是上次那个视图。
   * 🔴 旧实现在切页签的 effect 里 `setViewMode('table')` 强制重置 —— 与「记住偏好」直接冲突，已删。
   *    存下的视图若本页签根本不支持（配置改过 / 换了项目），下面回落到表格。
   */
  const [viewModeStored, setViewMode] = usePersistedEnum<TableViewMode>(
    `table-view::${getCurrentProjectId()}::${tab.id}`,
    TABLE_VIEW_MODES,
    'table',
  )
  const viewMode: TableViewMode =
    (viewModeStored === 'atlas' && !isAtlasCapable) ||
    (viewModeStored === 'timeline' && !isTimelineCapable) ||
    (viewModeStored === 'graph' && !isGraphCapable) ||
    (viewModeStored === 'storyline' && !isStorylineCapable)
      ? 'table'
      : viewModeStored

  /**
   * 3.1.3 图鉴：字段配置（项目级设置 `atlasSchema::<tabId>`，随项目 / 备份 / 同步走）。
   * 🔴 读取用**显式 projectId**（`loadAtlasSchema` 内部走 getSettingFor），
   *    读取失败只提示、**绝不回写空配置** —— 那会把作者的字段定义整份清掉。
   */
  const [atlasConfig, setAtlasConfig] = useState<AtlasSchemaConfig | null>(null)
  const [atlasNewerFormat, setAtlasNewerFormat] = useState(false)
  const [atlasConfigError, setAtlasConfigError] = useState<string | null>(null)
  useEffect(() => {
    if (!isAtlasCapable) {
      setAtlasConfig(null)
      setAtlasNewerFormat(false)
      setAtlasConfigError(null)
      return
    }
    let cancelled = false
    const pid = recordProjectId
    void loadAtlasSchema(pid, tab.id as AtlasTabId).then(r => {
      if (cancelled || !isRecordCurrent()) return
      setAtlasConfig(r.config)
      setAtlasNewerFormat(r.newerFormat)
      setAtlasConfigError(r.error ?? null)
      if (r.error) showToast(`字段配置读取失败：${r.error}`, 'error')
    })
    return () => { cancelled = true }
  }, [isAtlasCapable, tab.id, recordProjectId, recordOwnerKey, isRecordCurrent])

  /**
   * 本页签实际渲染的列（内置列原样 + 自定义字段）。
   * 🔴 采用过模板 ⇒ 结构由快照决定（`useSheetTemplate`），内置 schema 再变也不动；
   *    没采用 ⇒ 图鉴配置 / `tab.columns`，行为与 3.1.3 逐字一致。
   */
  const { def: templateDef, effectiveColumns, aiWriteTemplate } = useSheetTemplate(tab, atlasConfig)

  /**
   * 保存字段配置：revision 自增在 persistence 里做，界面状态必须用**返回值**覆盖。
   *
   * 🔴 3.1.3 · R04：**改了字段的 AI 可见性就必须作废旧索引**。
   *    语义索引是已经算好的文本快照，作者把「允许 AI 参考」关掉、或把字段归档之后，
   *    旧向量里那段内容还在 —— 语义召回照样能捞出来注回提示词，
   *    等于"开关关了、AI 还是知道"。宁可让他重建一次，也不能留这个口子。
   */
  const saveAtlasConfig = useCallback(async (next: AtlasSchemaConfig) => {
    const owner = beginOperation(), pid = owner.projectId
    const saved = await saveAtlasSchema(pid, tab.id as AtlasTabId, next)
    owner.assertCurrent()
    setAtlasConfig(saved)
    if (atlasAiVisibilityChanged(atlasConfig?.fields ?? [], saved.fields)) {
      try {
        await invalidateIndex(pid)
        owner.assertCurrent()
        showToast('字段的 AI 可见性已变更，旧语义索引作废 —— 请在「语义检索」里重建后再使用', 'error')
      } catch {
        if (!owner.current()) return
        showToast('旧语义索引作废失败，请到「语义检索」手动重建', 'error')
      }
    }
  }, [tab.id, atlasConfig, beginOperation])

  /**
   * 项目图鉴图片占用（方案 §6.2）：**所有图鉴页签合计**，不是只算当前表。
   * 当前表从内存 `rows` 算（含刚上传/刚删的），其余页签读一次库补上 —— 只在切页签时刷新。
   *
   * 🔴 别写回「只差一个页签」的老写法（`tab.id === 'races' ? 'items' : 'races'`）：
   *    3.1.3 起有四个图鉴页签，那样 nations / geography 的图根本不进配额，上限形同虚设。
   */
  const [otherAtlasImageBytes, setOtherAtlasImageBytes] = useState(0)
  useEffect(() => {
    if (!isAtlasCapable) { setOtherAtlasImageBytes(0); return }
    let cancelled = false
    const peers = ATLAS_TABS.filter(id => id !== tab.id)
    void Promise.all(peers.map(id => getTableRows(id).catch(() => [])))
      .then(lists => {
        if (!cancelled) setOtherAtlasImageBytes(lists.reduce((n, rs) => n + atlasImageUsageOf(rs).used, 0))
      })
      // 读不到就先按 0 算：这是"提示用"的量，不该阻断上传（真超限也还有硬闸兜底）
      .catch(() => { if (!cancelled) setOtherAtlasImageBytes(0) })
    return () => { cancelled = true }
  }, [isAtlasCapable, tab.id])

  /**
   * 批量新建自定义字段（3.1.3 · CSV 导入时「认不出的列」一步变成字段）。
   * 🔴 新字段一律落在「补充资料」组、`aiWritable: false`（作者没显式同意前，AI 不该往里写）；
   *    单选/多选先建空候选值 —— 让作者去「字段设置」补，别替他猜。
   */
  const createAtlasFields = useCallback(async (items: { label: string; type: CustomFieldType }[]) => {
    const cfg = atlasConfig ?? emptyAtlasSchema()
    const start = cfg.fields.length
    const created: AtlasFieldDefinition[] = items.map((it, i) => ({
      id: newFieldId(),
      label: it.label.slice(0, 20),
      type: it.type,
      description: '',
      options: [],
      appliesTo: '*',
      groupId: 'extra',
      order: (start + i) * 10,
      tableVisible: true,
      detailVisible: true,
      searchable: true,
      aiReadable: true,
      aiWritable: false,
      archived: false,
    }))
    await saveAtlasConfig({ ...cfg, fields: [...cfg.fields, ...created] })
  }, [atlasConfig, saveAtlasConfig])

  const atlasImageUsage = useMemo(
    () => atlasImageUsageOf(rows).used + otherAtlasImageBytes,
    [rows, otherAtlasImageBytes],
  )

  /**
   * 项目图片总上限按**运行形态**取（2026-10-18 主人拍板）：
   *   · 网页版云端账号（`WEB_CLOUD`）—— 数据进服务器配额，32MiB 硬上限 + 80% 预警；
   *   · 桌面 / 便携 / 游客网页版 —— 数据在自己机器上，**不限**（`Infinity`）。
   * 🔴 不要在这里给本地也塞一个"宽松上限"：任何数字都会在几年后变成用户的新墙，
   *    而本地存储的真实边界是磁盘，不是我们能拍的数字。
   */
  const atlasImageLimit = WEB_CLOUD ? ATLAS_TOTAL_LIMIT : Number.POSITIVE_INFINITY

  // 历法配置（项目级多历法数值体系），时间轴按数值判定跨历法先后顺序
  const [calendars, setCalendars] = useState<CalendarDef[]>([{ name: '灵历', value: 0 }])
  // draft = 未保存的编辑态（key=行id, value=该行字段副本）
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
  /**
   * 🔴 AI 的**输出目标**按 `purpose:'aiWrite'` 独立解析（3.1.3 · R12）：只看 `aiWritable`、
   *    不看 `tableVisible`（隐藏列＝不占地方，≠ 不许 AI 写）。
   * 3.2.0 · WT0-4：改从有效模板取 —— 内置＝`source==='builtin'`，自定义＝已筛过 `aiWritable` 的投影。
   */
  const aiFieldTargets = useMemo(() => aiWriteFieldsOf(aiWriteTemplate), [aiWriteTemplate])
  // WT2 生成期基准：弹窗打开那一刻的写回语义摘要（见 `useAiWriteBasis` 头注）
  const aiGenBasisRef = useAiWriteBasis(showFill || !!fillRow || showOrganize, aiWriteTemplate.semanticDigest)

  /**
   * 交给 AI 的字段清单（AI 新增 / 补全本行 / 整理共用同一份）。
   * 3.1.3：包含自定义字段，但只收 `aiWritable` 的 —— 作者在「字段设置」里关掉「允许 AI 填写」之后，
   * 这个字段就不再是输出目标（模型看不到它，也就不会去编它的值）。
   * 🔴 R12：自定义字段把**类型 / 单位 / 候选 / 说明**一并交给模型（否则它只能瞎编，
   *    写出来的值又被 `coerceAiValue` 拒掉 —— 作者看到的就是"AI 又跳过一堆字段"）。
   */
  const tableFields = useMemo<TemplateField[]>(() => [
    ...aiFieldTargets.builtinKeys.map(k => ({ key: k, label: k, locked: k === codeCol })),
    ...aiFieldTargets.custom.map(p => ({
      key: p.key,
      label: p.label,
      locked: p.key === codeCol,
      ...(fieldHintForAI(p) ? { desc: fieldHintForAI(p) } : {}),
    })),
  ], [codeCol, aiFieldTargets])

  /** 按存储键找自定义字段定义（内置列返回 null）—— AI 回填时判断要不要做类型校验 */
  const atlasFieldOf = (key: string) =>
    effectiveColumns.find(c => c.name === key)?.atlasField
    // 🔴 隐藏了但仍允许 AI 写的字段也要能找到定义，否则类型校验会被跳过（R12）
    ?? aiFieldTargets.custom.find(f => f.key === key)
    ?? null

  /**
   * 应用 AI 结果前的**基准复核**（R12；WT2 改语义摘要）：重读最新可写目标，
   * 锁写 / 生成期语义变了 / 字段被删 ⇒ 放弃本次回填，绝不拿旧清单往新库里写。
   * 🔴 不与配置 `revision` 比：采用快照后那是快照自己的代号，与配置各数各的。
   */
  const verifyAiWriteBase = useCallback(async (): Promise<AtlasAiWriteTargets | null> => {
    const pid = getCurrentProjectId()
    // 3.2.0：迁移期间**在途 AI 结果不许回填**（方案 §3.6）—— 它们出自旧字段清单
    const conflict = await guardTabWrite(pid, tab.id, 'ai-writeback')
    if (conflict) { showToast(`${conflict.message}${conflict.hint}`, 'error'); return null }
    const targets = await loadAtlasAiWriteTargets(tab, pid)
    if (targets.lockedReason) {
      showToast(`已放弃本次 AI 回填：${targets.lockedReason}`, 'error')
      return null
    }
    if (aiGenBasisRef.current && targets.basis && targets.basis !== aiGenBasisRef.current) {
      showToast('字段定义在生成期间被人改过（为避免写错字段，本次结果已作废），请重新生成', 'error')
      return null
    }
    return targets
  }, [tab, aiGenBasisRef])

  /**
   * 图鉴主图保存（3.1.3）。
   *
   * 🔴 为什么不走 `drafts`：草稿是「`data` 里字段值的补丁」，而主图在 `TableRow` **顶层**。
   *    所以图片是**即选即存**：上传成功就落库并同步内存行，不参与"未保存改动"计数 ——
   *    否则用户以为按 Ctrl+S 才保存，实际上图没保存（或反过来，保存了一堆图却没按保存）。
   */
  const saveRowImage = useMemo(() => createTableImageWriter({ projectId: recordProjectId, tabId: tab.id,
    current: isRecordCurrent, read: () => rowsRef.current,
    committed: next => setRows(prev => prev.map(row => row.id === next.id ? next : row)),
  }), [recordProjectId, tab.id, isRecordCurrent, rowsRef, setRows])
  // 保存闪烁定时器（卸载时清理，防止组件卸载后仍触发 setState）
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  // 跨组件跳转聚焦：数据体检「跳转修复」/ 地图「跳到地理风物」带 rowId 时，滚动到该行并高亮。
  // 只挂视口附近的行之后，目标行可能还没挂载 ⇒ 实现里带**有界轮询**（见 useRowFocusHighlight）。
  const hlRowId = useRowFocusHighlight({ focusRowId, rowRefs, rows, onFocusConsumed })

  // 列宽（按表独立记忆）：表头可拖拽调整，默认列宽更合理
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const raw = readStringPref(colWidthsKey(tab.id)) ?? migrateColWidths(tab.id)
    try { return raw ? (JSON.parse(raw) as Record<string, number>) : {} } catch { return {} }
  })
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null)
  /** 🔴 2026-09-22 六维审计 P2：拖拽期间挂上的 window 监听，卸载时也要能摘掉
   *  （原来只在 `onUp` 里 removeEventListener —— 拖到一半切页签/组件被卸载时 `onUp` 永不触发，
   *   这对监听就永久留在 window 上，越拖越积）。 */
  const dragCleanupRef = useRef<(() => void) | null>(null)
  // 表头筛选：每列一个关键字，行内该列命中即保留
  const [colFilters, setColFilters] = useTableWorkspaceFilters(tab.id, focusRowId)
  /**
   * 各下拉列的「自定义选项」载荷（用户新增项 / 隐藏项 / 内置改名）。
   * 表头筛选下拉必须与行内 CustomSelect 用同一口径（resolveOptions）渲染，
   * 否则用户新增的自定义值在筛选里看不到（1.9.1 修复）。
   */
  const [customOpts, setCustomOpts] = useState<Record<string, CustomOptionPayload>>({})

  const defaultColWidth = (col: { name: string; type?: string }) => {
    // 3.1.2 G 条：110 → 130。地理风物的层级编号形如 `G0001-001-001`，110 刚好卡在边缘，
    // 配合单元格 nowrap 后仍会被裁掉尾巴；给到 130 让这类编号能完整显示一次。
    if (col.name === '编号' || col.name === '章节号') return 130
    if (col.type === 'date') return 220
    if (col.type === 'calendar') return 150
    if (col.type === 'select') return 134
    return 178
  }
  const widthOf = (colName: string) => {
    const c = effectiveColumns.find(x => x.name === colName)
    if (!c) return 160
    // 自定义字段按类型给默认宽度（数字窄、长文本宽）；作者拖过列宽则以记忆值为准
    const custom = c.atlasField ? customColumnWidth(c.atlasField.customType ?? 'text') : null
    return colWidths[colName] ?? (custom ?? defaultColWidth(c))
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
      // 列宽属纯 UI 偏好，写不进去（隐私模式/配额满）也不影响数据 —— writeStringPref 内部已静默兜底，
      // 故此处刻意不提示、不降级：刷新后回到默认列宽即可。
      writeStringPref(colWidthsKey(tab.id), JSON.stringify(colWidthsRef.current))
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
    const owner = captureCandidateOwner()
    setRelGroupOpen(new Set())
    setRelRowOpen(new Set())
    setCodeError(null)
    setShowFill(false); setShowOrganize(false); setShowImport(false); setFillRow(null)
    setShowFeedbackAI(false); setShowDedupAI(false)
    // 🔴 2026-09-29：不再加载「退役编号池」（retiredCodes）—— 编号改为补最小空号，删除后的编号允许复用。
    //    旧库里残留的 retiredCodes::<tabId> 数据无害（不再读写），无需迁移清理。
    if (tab.id === 'history' || tab.id === 'timeline') {
      // 加载历法配置；兼容旧版单值 calendarName：若存在则迁移为多历法
      getSetting<CalendarDef[]>('calendars', []).then(list => {
        if (!owner.current()) return
        if (list && list.length > 0) { setCalendars(list); return }
        getSetting<string>('calendarName', '').then(old => {
          if (!owner.current()) return
          if (old && old.trim()) {
            const migrated = [{ name: old.trim(), value: 0 }]
            setCalendars(migrated)
            setSetting('calendars', migrated)
            setSetting('calendarName', '')
          }
        })
      })
    }
    // Only a real record owner/tab change resets these entry points; optional view invalidation does not.
  }, [tab.id, recordOwnerKey])

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
    const map = new Map(renames.map(r => [r.from, r.to]))
    const hit: string[] = []
    // 🔴 2026-10-02 六维审计 P2：这条级联是异步 fire-and-forget（调用方 void）——
    //    不兜底的话，中途写失败会留下「配置已改、行还是旧名」的孤儿值（正是本功能要根治的问题），
    //    还会产生 unhandled rejection、界面上一个字都不说。
    try {
      const owner = beginOperation()
      await setSettingFor(owner.projectId, 'calendars', next)
      owner.assertCurrent(); setCalendars(next)
      if (renames.length === 0) return
      for (const tid of ['history', 'timeline']) {
        owner.assertCurrent()
        const list = await getTableRowsFor(owner.projectId, tid)
        owner.assertCurrent()
        let changed = 0
        for (const row of list) {
          const cur = (row.data['历法'] ?? '').trim()
          const to = map.get(cur)
          if (!to) continue
          owner.assertCurrent()
          await saveTableRow({ ...row, data: { ...row.data, '历法': to } })
          owner.assertCurrent()
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
    } catch (e) {
      if (!isRecordCurrent()) return
      showToast(
        `历法改名未能全部同步（${hit.length ? `已改：${hit.join('、')}；` : ''}请打开这两张表核对后重存一次）：`
        + (e instanceof Error ? e.message : String(e)),
        'error', 8000,
      )
      return
    }
    if (hit.length > 0) showToast(`历法改名已同步：${hit.join('、')}`)
  }, [tab.id, setDrafts, setRows, beginOperation, isRecordCurrent])

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
   * 详情面板「撤销本次改动」（3.1.3 · 就地编辑）：只回滚详情里动过的那几栏 ——
   * 与库值一致的直接摘掉草稿，不一致的写回快照值；表格里其它未保存改动一根不动。
   */
  const revertCellDrafts = (rowId: string, values: Record<string, string>) => {
    const base = rows.find(r => r.id === rowId)?.data ?? {}
    setDrafts(prev => revertDraftCells(prev, base, rowId, values))
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

  validateBeforeSave.current = validateCodes
  const saveAll = useCallback(async () => {
    if (dirtyKeys.length === 0) return
    const owner = captureCandidateOwner()
    const conflict = await guardTabWrite(getCurrentProjectId(), tab.id, 'draft')
    if (conflict) { if (owner.current()) showToast(conflict.message + conflict.hint, 'error'); return }
    if (!owner.current()) return
    const err = validateCodes()
    if (err) { setCodeError(err); return }
    setCodeError(null)
    try {
      const result = await flushRecords()
      if (!result.ok) throw result.error
      if (!owner.current()) return
      setSaved(Object.keys(draftsRef.current).length === 0)
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 1500)
    } catch (error) {
      if (owner.current()) showToast('保存失败：' + (error instanceof Error ? error.message : String(error)), 'error')
    }
  }, [dirtyKeys, validateCodes, tab.id, flushRecords, draftsRef])

  // Ctrl/Cmd+S（2.7.3：收敛到 useSaveHotkey）
  useSaveHotkey(() => void saveAll(), dirtyKeys.length > 0)

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
    const owner = captureCandidateOwner()
    // 🔴 R12：先核基准 —— 生成期间字段定义若变过，旧结果一律作废（不拿旧清单写新库）
    const base = await verifyAiWriteBase()
    if (!base) return false
    if (!owner.current()) return false
    const data: Record<string, string> = {}
    tab.columns!.forEach(col => { data[col.name] = '' })
    if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
      data[codeCol] = nextAutoCode(tab.id, rows, drafts, codeCol)
    }
    const row: TableRow = { id: uid(), projectId: owner.projectId, tabId: tab.id, data, order: rows.length, createdAt: Date.now() }
    await saveTableRow(row)
    if (!owner.current()) return false
    setRows(list => [...list, row])
    const rejected: string[] = []
    for (const [k, v] of Object.entries(values)) {
      if (k === codeCol) continue
      // 🔴 R12：未知键**不再**默默当普通草稿写进去（修复前没有统一允许键校验）
      if (!base.allowedKeys.has(k)) { rejected.push(`「${k}」不是这张表的字段`); continue }
      const af = base.fields.get(k) ?? atlasFieldOf(k)
      if (af) {
        // 3.1.3：自定义字段先过类型校验（与「补全本行」同一口径）
        const r = coerceAiValue(af, v)
        if (!r.ok) { rejected.push(r.reason); continue }
        if (r.value) setCellDraft(row.id, k, r.value)
        continue
      }
      setCellDraft(row.id, k, v)
    }
    if (rejected.length > 0) {
      showToast(`AI 返回的 ${rejected.length} 个值没被采用，已跳过：${rejected[0]}`, 'error')
    }
    setShowFill(false)
  }

  /**
   * AI 补全本行空白：只把当前行「仍未填写（含未保存草稿为空）」的单元格交给 AI 结果回填，
   * 已填的单元格一律不动 —— 作用域严格限定在「当前表 / 这一行」，不影响其他行或其他表（如种族生物）。
   *
   * 3.1.3：自定义字段先过 `coerceAiValue`（数字 / 选项 / 是真假 都要校验），
   * 不合法的值**跳过并如实报数**，绝不静默写进去（方案 §7.3）。
   *
   * 🔴 R12：另外核两道基准 ——
   *   · 字段定义在生成期间变过 ⇒ 作废（值可能已不属于现在的字段）；
   *   · **这一行的内容在生成期间变过** ⇒ 作废（AI 是按"当时还空着哪些格"补的，
   *     作者中途手填过的话，补出来的东西就是基于过期事实的）。
   */
  const handleFillRow = async (row: TableRow, values: Record<string, string>) => {
    const owner = captureCandidateOwner()
    const base = await verifyAiWriteBase()
    if (!owner.current()) return false
    if (!base) { setFillRow(null); return false }
    const now = rowsRef.current.find(r => r.id === row.id)
    if (!now) {
      showToast('这一行已经不在了（本次补全结果已作废）', 'error')
      setFillRow(null)
      return false
    }
    if (JSON.stringify(now.data) !== JSON.stringify(row.data)) {
      showToast('这一行的内容在生成期间变过（为避免覆盖，本次结果已作废），请重新生成', 'error')
      setFillRow(null)
      return false
    }
    const rejected: string[] = []
    for (const [k, v] of Object.entries(values)) {
      if (k === codeCol) continue
      if (!base.allowedKeys.has(k)) { rejected.push(`「${k}」不是这张表的字段`); continue }
      const cur = ((drafts[row.id]?.[k] ?? row.data[k] ?? '') as string).trim()
      if (cur) continue
      const af = base.fields.get(k) ?? atlasFieldOf(k)
      if (af) {
        const r = coerceAiValue(af, v)
        if (!r.ok) { rejected.push(r.reason); continue }
        if (r.value) setCellDraft(row.id, k, r.value)
        continue
      }
      setCellDraft(row.id, k, v)
    }
    if (rejected.length > 0) {
      showToast(`AI 返回的 ${rejected.length} 个值没被采用，已跳过：${rejected[0]}`, 'error')
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
    const owner = beginOperation()
    // 🔴 R12：整理也是 AI 写入 —— 同样要核基准（字段定义在生成期间改过就作废）
    const base = await verifyAiWriteBase()
    owner.assertCurrent()
    if (!base) return
    const created: TableRow[] = []
    let rejectedCustom = 0
    try {
      for (const vals of newRows) {
        owner.assertCurrent()
        const data: Record<string, string> = {}
        tab.columns!.forEach(col => { data[col.name] = vals[col.name] ?? '' })
        // 3.1.3：自定义字段（只收作者允许 AI 填写、且通过类型校验的值；未知键一律丢弃）
        // 🔴 R12：目标清单取自**重读的**可写目标（隐藏但允许写的字段也算，被禁写的一律不算）
        for (const [key, af] of base.fields) {
          if (!(key in vals)) continue
          const r = coerceAiValue(af, vals[key])
          if (!r.ok) { rejectedCustom++; continue }
          if (r.value) data[key] = r.value
        }
        if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
          data[codeCol] = nextAutoCode(tab.id, [...rows, ...created], drafts, codeCol)
        }
        const row: TableRow = {
          id: uid(),
          projectId: owner.projectId,
          tabId: tab.id,
          data,
          order: rows.length + created.length,
          createdAt: Date.now(),
        }
        await saveTableRow(row)
        owner.assertCurrent()
        created.push(row)
      }
    } catch (e) {
      // 🔴 2026-10-02 六维审计 P1（与 handleImport 同一条纪律）：已成功落库的行**必须先并入内存再抛**，
      //    否则「库里有、界面没有」—— 作者重试这批行会被再写一遍，变成重复条目。
      if (created.length) setRows(prev => [...prev, ...created])
      throw e
    }
    setRows(prev => [...prev, ...created])
    if (rejectedCustom > 0) {
      showToast(`AI 整理的结果里有 ${rejectedCustom} 个自定义字段值不符合规则，已跳过`, 'error')
    }
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
   * 导入图鉴资料包（3.1.3 · 方案 §8.3）：**先在内存里算计划，再逐行落库**。
   *
   * 🔴 三条纪律：
   *   1. 字段先落配置、行后落库 —— 行的 `data` 键已经按新字段 id 重映射过，配置不在就先写行
   *      会得到一堆"孤键"（图鉴能显示值，但字段列里查无此字段）；
   *   2. 图片按容量闸判断：总量装不下就**整批不带图**（而不是装一半），并如实报告跳过了几条；
   *   3. 逐行 `await` 写库（不用 forEach 并发）—— 中途失败时已写入的行要并入内存，不能"库里有界面没有"。
   */
  const importAtlasPackage = useCallback(async (pkg: AtlasPackage): Promise<{
    added: number
    createdFields: number
    reusedFields: number
    strippedImages: number
    totalImages: number
    /** 落库失败的行数（3.1.3 · R11：如实报数，不静默） */
    failed: number
    /** 最后一次失败的原因 */
    failure: string
  }> => {
    const owner = beginOperation()
    const cfg = atlasConfig ?? emptyAtlasSchema()
    const plan = planAtlasImport(pkg, cfg, newFieldId)
    const incomingImages = plan.rows.reduce((n, r) => n + (r.atlasImage?.bytes ?? 0), 0)
    const stripImages = checkAtlasBudget(atlasImageUsage, incomingImages, atlasImageLimit).level === 'over'

    // 1) 字段配置（含新分组）
    if (plan.created.length > 0) {
      const groupIds = new Set(cfg.groups.map(g => g.id))
      const extraGroups = pkg.schema.groups.filter(g => !groupIds.has(g.id))
      await saveAtlasConfig({
        ...cfg,
        fields: plan.fields,
        groups: [...cfg.groups, ...extraGroups],
      })
      owner.assertCurrent()
    }

    // 2) 条目
    const created: TableRow[] = []
    let failed = 0
    let failure = ''
    try {
      for (let i = 0; i < plan.rows.length; i++) {
        owner.assertCurrent()
        const r = plan.rows[i]
        const data: Record<string, string> = { ...r.data }
        if (codeCol && AUTONUM_GROUPS.has(tab.group)) {
          data[codeCol] = nextAutoCode(tab.id, [...rowsRef.current, ...created], {}, codeCol)
        }
        const row: TableRow = {
          // 🔴 稳定 id（3.1.3 · R11）：同一份包重导得到同一批 id ⇒ **重试是幂等的**，
          //    不会把上次已成功的行再写一遍变成重复条目（修复前用的是 uid()，重试即翻倍）。
          id: packageRowId(pkg, i),
          projectId: owner.projectId,
          tabId: tab.id,
          data,
          order: rowsRef.current.length + created.length,
          createdAt: Date.now(),
          ...(r.atlasImage && !stripImages ? { atlasImage: r.atlasImage } : {}),
        }
        try {
          await saveTableRow(row)
          owner.assertCurrent()
          created.push(row)
        } catch (e) {
          // 🔴 单行失败**不吞也不中断**：记下来继续，最后如实报数（同 handleImport 的口径）
          owner.assertCurrent() // Changing owner stops the batch; it is not a recoverable row failure.
          failed++
          failure = e instanceof Error ? e.message : String(e)
        }
      }
    } finally {
      // 🔴 已成功的行**必须**先并入内存再谈别的：否则"库里有、界面没有"，
      //    作者刷新才看到，还可能以为没导进去又导一次（修复前只在全部成功时才 setRows）。
      if (created.length) setRows(prev => [...prev, ...created])
    }

    return {
      added: created.length,
      createdFields: plan.created.length,
      reusedFields: plan.reused.length,
      strippedImages: stripImages ? plan.imageRows : 0,
      totalImages: plan.imageRows,
      failed,
      failure,
    }
  }, [atlasConfig, atlasImageLimit, atlasImageUsage, codeCol, tab.id, tab.group, saveAtlasConfig, rowsRef, setRows, beginOperation])

  /**
   * 批量导入落盘（2.6.4）：与 handleOrganize 同口径 —— 直接写库、不进 drafts；
   * 行的构造（含编号补号）交给 lib/tableIO.buildImportRows（纯函数，可单测）。
   */
  const handleImport = async (picked: ImportRowResult[]) => {
    const owner = beginOperation()
    // 3.2.0：迁移期间整行导入会让新旧结构混在一行里（方案 §3.6）
    const conflict = await guardTabWrite(owner.projectId, tab.id, 'import')
    owner.assertCurrent()
    if (conflict) throw new Error(`${conflict.message}${conflict.hint}`)
    const created = buildImportRows(picked, tab, rows, owner.projectId, uid, drafts)
    // 🔴 2026-10-02 六维审计 P1：逐行落库时若中途失败（IPC / IDB 写失败），旧实现会让**已写进库的行**
    //    停在内存之外 —— setRows 不执行 ⇒ 界面看不到它们；作者点重试，这些行会被**再写一遍**（重复条目）。
    //    改为：把已成功的行也并入内存后再抛（弹窗的 catch 会显示原因、且不关窗；已导入的行随即变成
    //    「与已有重复」而被自动取消勾选），重试只会补写剩下的部分。
    const saved: TableRow[] = []
    try {
      for (const row of created) {
        owner.assertCurrent()
        await saveTableRow(row)
        owner.assertCurrent()
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
  /**
   * 表头筛选的下拉列。自定义「是/否」字段排除在外 —— 它的存储值是 `true/false`，
   * 露出到筛选项里既不直观，也和行内「是/否」显示不一致。
   */
  const selectCols = useMemo(
    () => effectiveColumns.filter(c => c.type === 'select' && c.options && c.atlasField?.customType !== 'boolean'),
    [effectiveColumns]
  )
  const selectColNames = useMemo(() => new Set(selectCols.map(c => c.name)), [selectCols])

  /**
   * 装载各下拉列的自定义选项；并监听 CUSTOM_OPTIONS_EVENT，
   * 让用户在行内下拉里新增/删除/改名后，表头筛选下拉立刻同步。
   */
  const loadCustomOpts = useCallback(async () => {
    // 自定义字段的候选值来自字段定义，不参与「内置列自定义选项」那套（也就没必要读库）
    const builtinSelects = selectCols.filter(c => !c.atlasField)
    if (builtinSelects.length === 0) return
    const entries = await Promise.all(
      builtinSelects.map(async c => [c.name, await getCustomOptions(tab.id, c.name)] as const)
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

  const refOptions = useTableRefOptions(effectiveColumns) // 跨表候选值：每列读一次（实现见该 hook）
  /**
   * 表头筛选下拉的候选值：与行内 CustomSelect 完全同口径
   * （内置项去掉 hidden、应用 renamed，再拼上用户自定义项，同名去重）。
   */
  const filterOptionsOf = (col: (typeof selectCols)[number]) => {
    // 自定义字段：候选值只来自字段定义（label 是唯一名称来源，没有「用户改名」这一层）
    if (col.atlasField) return col.atlasField.options ?? []
    return resolveOptions(col.options ?? [], customOpts[col.name] ?? { items: [], hidden: [] })
      .map(o => o.name)
  }
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

  // 表总宽 = 各列宽之和 + 序号列(40) + 行首操作列(ROW_ACTION_COL_W)。超出容器时由外层
  // overflow-x-auto 出横向滑条，而非压缩其他列（拖动某列只改它自己，不影响其余列宽）。
  const totalWidth = effectiveColumns
    ? effectiveColumns.reduce((s, c) => s + widthOf(c.name), 0) + 40 + ROW_ACTION_COL_W
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
    rows, setRows, drafts, setDrafts, saving, saved, dirtyKeys, saveAll, loaded, loadError, retry, saveState, recordOwnerKey, beginOperation,
    // 行编辑
    setCellDraft, cellVal, isRowDirty, isInvalidCode, addRow, removeRow, revertCellDrafts,
    // 排序与筛选
    sortedRows, filteredRows, colFilters, setColFilters, filterOptionsOf,
    // 列宽与拖拽
    widthOf, onResizeStart, totalWidth,
    // 树形层级
    parentCol, collapsed, toggleCollapse, tree, bodyRows, addChild,
    // 编号
    codeCol, codeError,
    refOptions, customOpts, // 跨表候选值 / 内置下拉选项：都改成「每列读一次、逐行传下去」
    // 视图与高亮
    viewMode, setViewMode, isTimelineCapable, isGraphCapable, isStorylineCapable, isAtlasCapable, isMaster, aiCap, aiReady, hlRowId, rowRefs,
    // 图鉴字段配置（3.1.3）
    effectiveColumns, atlasConfig, atlasNewerFormat, atlasConfigError, saveAtlasConfig, saveRowImage, atlasImageUsage, atlasImageLimit, importAtlasPackage, createAtlasFields,
    // 采用模板（3.2.0）
    templateDef,
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

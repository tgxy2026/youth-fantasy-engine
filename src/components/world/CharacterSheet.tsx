import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import { Z } from '@/lib/app/zLayer'
import type { TabDef, CardRecord } from '@/lib/types'
import { CARD_TABLE_REF_FIELDS, type VisCtx } from '@/lib/schema'
import { getCardRecords, saveCardRecord, deleteCardRecord, getCurrentProjectId } from '@/lib/db'
import { clearFreeDraft } from '@/lib/editor/freeDraft'
import { uid } from '@/lib/app/id'
import { Plus, Trash2, UserRound, Info, Save, Check, EyeOff, Search } from 'lucide-react'
import { readPortraitFile } from '@/lib/media/imagePortrait'
import HelpPopover from '@/components/common/HelpPopover'
import CharacterTools from '@/components/world/CharacterTools'
import FieldDescription from '@/components/common/FieldDescription'
import CharacterPortraitPanel from '@/components/world/CharacterPortraitPanel'
import CharacterProfileHeader from '@/components/world/CharacterProfileHeader'
import { characterProfileFields, characterProfileFacts } from '@/lib/world/characterProfile'
import AutoTextarea from '@/components/common/AutoTextarea'
import TableRefSelect from '@/components/sheets/TableRefSelect'
import AITemplateFill from '@/components/ai/AITemplateFill'
import PromptModal from '@/components/dialogs/PromptModal'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import type { TemplateField } from '@/lib/ai'
import { useAIReady } from '@/lib/ai/useAIReady'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import FieldAliasButton, { moduleAliasTargets } from '@/components/sheets/FieldAliasButton'
import { useFieldDisplayLabels } from '@/lib/templates/useFieldRenames'
import { useFieldGating } from '@/lib/templates/useFieldLabels'
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
import { characterCardTargets, isCharacterCardTab, planCardMove } from '@/lib/world/cardMove'
import CardMoveDialog from '@/components/world/CardMoveDialog'
import { downloadBlob } from '@/lib/storage/zip'
import type { ImportRowResult } from '@/lib/storage/tableIO'
import { useSheetTemplate, useAiWriteBasis } from '@/components/templates/useSheetTemplate'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { cardGroupsOfTemplate } from '@/lib/templates/render'
import { pickValuesOfKeys } from '@/lib/templates/consumers'
import type { TemplateFieldType } from '@/lib/templates/types'
import TemplateManagerDialog from '@/components/templates/TemplateManagerDialog'
import { isTemplateTab } from '@/lib/templates/eligible'
import { guardTabWrite, type TabWriteSource } from '@/lib/templates/migrationGuard'
import AtlasCellInput from '@/components/atlas/AtlasCellInput'
import type { ResolvedAtlasField } from '@/lib/atlas/types'
import { useDetailWorkspaceView } from '@/components/common/useDetailWorkspaceView'

/**
 * 长文本字段**不封顶**的卡片页签（单一判据）：名单内的页签，其文本字段随内容一路长高、
 * 永不出现内部滚动条（AutoTextarea 传 maxHeight=0）；不在名单内的仍走默认 360px 封顶。
 * 「其他设定」是兜底页、一条卡就是一段长短不一的设定说明，写多长都该完整摊开（2026-09-25 社区反馈）。
 * 🔴 新页签想要同样手感 → **只往这个 Set 加 tab.id**，别在渲染处加 if。
 */
const UNBOUNDED_CARD_TABS = new Set(['misc-settings'])

/** 3.2.0：卡片渲染的统一模型（内置模块 / 模板分组都折算成它） */
interface CardFieldView {
  key: string
  /** 原字段名（内置字段的特殊控件仍按它匹配） */
  name: string
  label: string
  desc?: string
  example?: string
  type: TemplateFieldType
  /** 下拉候选（模板里改过类型的字段才有） */
  options?: string[]
  customType?: ResolvedAtlasField['customType']
  atlasField?: ResolvedAtlasField
  source: 'builtin' | 'custom'
}
interface CardGroupView {
  id: string
  label: string
  /** 立绘列只在这一组渲染（沿用原判据：组名含「基础信息」） */
  isBasic: boolean
  fields: CardFieldView[]
}

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
  const portraitRequest = useRef({ version: 0 })
  useEffect(() => {
    const request = portraitRequest.current
    request.version++
    setPortraitBusy(false)
    return () => { request.version++ }
  }, [activeId, tab.id])
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
  /** 跨页签移动弹窗（3.1.3）：主要 / 次要 / NPC 三张角色卡之间搬运 */
  const [moveOpen, setMoveOpen] = useState(false)
  /** 3.2.0：模板管理弹窗（三张角色卡） */
  const [showTemplate, setShowTemplate] = useState(false)
  /**
   * 可移动到的目标页签。只认「角色管理组的三张角色卡」——
   * 「其他设定」虽然也是 card 型，但它不是人物档案，字段语义对不上，不该出现在这里。
   */
  const moveTargets = useMemo(
    () => (isCharacterCardTab(tab.id) ? characterCardTargets(tab.id) : []),
    [tab.id],
  )
  /** 字段显示名（2.7.3）：只改界面上这行字，取值仍走「模块名::字段名」存储键 */
  const aliasTargets = useMemo(() => moduleAliasTargets(tab.modules), [tab])
  const aliasKeys = useMemo(() => aliasTargets.map(t => t.key), [aliasTargets])
  const aliasLabels = useFieldDisplayLabels(tab.id, aliasKeys)
  // T3：含义未确认字段（§3.12.3.3）—— 卡片页签自行收口：不当 AI 填写目标，值也不进材料。
  const cardPending = useFieldGating(tab.id).pending
  /**
   * 3.2.0：本页签采用的模板快照。
   * 🔴 有快照 ⇒ 卡片的模块 / 字段 / 显示名全部按快照渲染；
   *    没有 ⇒ 逐字沿用 `tab.modules`，老项目行为不变。
   */
  const { def: templateDef } = useSheetTemplate(tab, null)
  const templateView = useMemo(
    () => (templateDef
      ? resolveTemplateForTab(tab, { def: templateDef, purpose: 'detail', ignoreAppliesTo: true })
      : null),
    [tab, templateDef],
  )
  /** 统一的渲染模型：内置模块与模板分组都折算成同一形状，渲染处不再分支 */
  const cardGroups = useMemo<CardGroupView[]>(() => {
    if (!templateDef || !templateView) {
      return (tab.modules ?? []).map(m => ({
        id: m.name,
        label: m.name,
        isBasic: m.name.includes('基础信息'),
        fields: m.fields.map(f => {
          const key = `${m.name}::${f.name}`
          return {
            key,
            name: f.name,
            label: aliasLabels[key] ?? f.name,
            ...(f.desc ? { desc: f.desc } : {}),
            ...(f.example ? { example: f.example } : {}),
            type: (f.kind === 'numeric' ? 'number' : 'textarea') as TemplateFieldType,
            source: 'builtin' as const,
          }
        }),
      }))
    }
    return cardGroupsOfTemplate(tab, templateView).map(g => ({
      id: g.id,
      label: g.label,
      isBasic: g.isBasic,
      fields: g.fields.map(f => ({
        key: f.key,
        name: f.name || f.label,
        label: f.label,
        ...(f.desc ? { desc: f.desc } : {}),
        ...(f.example ? { example: f.example } : {}),
        type: f.type,
        ...(f.options ? { options: [...f.options] } : {}),
        ...(f.customType ? { customType: f.customType } : {}),
        ...(f.atlasField ? { atlasField: f.atlasField } : {}),
        source: f.source,
      })),
    }))
  }, [tab, templateDef, templateView, aliasLabels])

  const fieldPermissions = useMemo(() => new Map(templateView?.fields.map(field => [field.sourceKey, field.permissions]) ?? []), [templateView])

  // UX06 · 详情页现场：记住「哪些分组展开着、滚到哪」（切换卡片/换页签回来都能接上）
  // 🔴 pageId 带 tab.id：主要角色与次要角色、各种「其他设定」各记各的，记录不串。
  const detailRef = useRef<HTMLDivElement>(null)
  const defaultGroups = useMemo(
    () => cardGroups.filter((group, index) => group.isBasic || index === 0).map(group => group.id),
    [cardGroups],
  )
  const { expanded, toggle } = useDetailWorkspaceView({
    pageId: `character:${tab.id}`,
    objectId: draft?.id ?? null,
    defaultGroups,
    scrollRef: detailRef,
  })
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
  const profileFields = useMemo(() => isCharTab ? characterProfileFields(
    templateView ?? resolveTemplateForTab(tab, { aliases: aliasLabels, purpose: 'detail' }),
    templateDef?.bindings, cardPending,
  ) : cardGroups.flatMap(group => group.fields.map(field => ({ sourceKey: field.key, label: field.label }))),
  [isCharTab, tab, templateView, templateDef, aliasLabels, cardPending, cardGroups])
  /**
   * 批量导入 / 导出用的**虚拟表格页签**（3.1.x）：把 `tab.modules` 拍平成 `columns`，
   * 让世界构建组那一整套 tableIO 逻辑（解析 / 映射 / 校验 / 模板 / 说明）原样复用 ——
   * 见 `lib/storage/cardIO.ts` 的头注。
   */
  const vtab = useMemo(() => cardTabToTableTab(tab), [tab])
  /**
   * 含当前未保存草稿的记录列表 —— **导出**与**导入判重**共用它。
   *
   * 🔴 与 `TableSheet` 的 `sortedRows` 同口径：屏幕上是什么，导出 / 判重就按什么算。
   *    判重若只读裸库数据，作者改了名（还没保存）再导入同名 CSV 就不会判重 ⇒ 重复建卡；
   *    而导出又并了草稿 —— 同一页两个口径自相矛盾，最难自查。
   */
  const recordsWithDraft = useMemo(
    () => (draft ? records.map(r => (r.id === draft.id ? draft : r)) : records),
    [records, draft],
  )
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
    () => (templateDef
      ? cardGroups.flatMap(g => g.fields.map(f => ({
        key: f.key,
        label: f.label,
        desc: f.desc,
        example: f.example,
      })))
      // 未采用模板：逐字保持原口径（标签用原字段名，不用别名）
      : (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
        key: `${m.name}::${f.name}`,
        label: f.name,
        desc: f.desc,
        example: f.example,
      })))),
    // 🔴 这里读的是 tab.modules / 模板快照，依赖就必须锚在它们本身。
    //    只写 tab.id 时，同一页签的字段结构被改动（如项目形态/自定义页签重算 schema）
    //    不会重算，AI 补全弹窗会继续用旧字段表。
    [tab, templateDef, cardGroups],
  )
  /**
   * 交给 AI 的卡片字段（3.2.0 · WT2）。
   *
   * 🔴 采用模板后按 `purpose:'aiWrite'` 解析：作者在模板里关掉「AI 可填写」的字段
   *    既不该出现在提示词里，也不该被回填 —— 与表格页签同一口径。
   * 🔴 未采用模板时沿用 `cardFields`：老项目没有快照，行为一个字节都不动。
   */
  const cardAiFields = useMemo<TemplateField[]>(() => {
    const base = !templateDef
      ? cardFields
      : resolveTemplateForTab(tab, { def: templateDef, purpose: 'aiWrite', ignoreAppliesTo: true }).fields
        .map(f => ({
          key: f.sourceKey,
          label: f.label,
          ...(f.description ? { desc: f.description } : {}),
          ...(f.example ? { example: f.example } : {}),
        }))
    return cardPending.size ? base.filter(f => !cardPending.has(f.key)) : base
  }, [tab, templateDef, cardFields, cardPending])

  /**
   * AI **可参考**的键（`purpose:'aiRead'`）。
   *
   * 🔴 为什么要单独有：`existing` 会被摊平成「已有什么」发给模型。模板里关掉
   *    「允许 AI 参考」的字段即使可写，其**已填值也不能进入这份材料**。
   *    未采用模板 ⇒ null，沿用原来的整份草稿。
   */
  const cardAiReadKeys = useMemo<Set<string> | null>(() => {
    if (!templateDef) return null
    const tpl = resolveTemplateForTab(tab, { def: templateDef, purpose: 'aiRead', ignoreAppliesTo: true })
    // 待确认字段同样不许参考（确认前不按旧名解释、也不推断新义）
    return new Set(tpl.fields.filter(f => !cardPending.has(f.sourceKey)).map(f => f.sourceKey))
  }, [tab, templateDef, cardPending])

  /** 只把可参考字段的已填值交给 AI（禁读 / 待确认字段的值一律不出现在材料里） */
  const cardAiExisting = useMemo(() => {
    if (!draft) return undefined
    if (!cardAiReadKeys && !cardPending.size) return draft.data
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft.data)) {
      if (cardPending.has(k) || (cardAiReadKeys && !cardAiReadKeys.has(k))) continue
      out[k] = v
    }
    return out
  }, [draft, cardAiReadKeys, cardPending])

  /**
   * 「AI 补全」的字段清单：**已填但禁读**的字段标 `locked`。
   * 不标的话，它既不在 `existing` 里（值不能发出去）又被当成空字段 ——
   * AI 会去「补」一个作者早已填好的栏，采用时把它覆盖掉。
   */
  const cardAiFillFields = useMemo<TemplateField[]>(() => {
    if (!cardAiReadKeys || !draft) return cardAiFields
    return cardAiFields.map(f =>
      !cardAiReadKeys.has(f.key) && (draft.data[f.key] ?? '').trim() ? { ...f, locked: true } : f)
  }, [cardAiFields, cardAiReadKeys, draft])

  // WT2 生成期基准：弹窗打开那一刻的模板语义摘要（未采用模板时为空串 = 不判失效）
  const aiBasisRef = useAiWriteBasis(showFill || showFillExisting, templateDef?.semanticDigest ?? '')

  /**
   * AI 结果落笔前复核：模板变了 ⇒ 整批作废；只保留**当前可写字段**的值。
   * 🔴 防幽灵写入：模型可能按旧清单返回已删除 / 已归档 / 已禁写的键，
   *    直接摊进 `data` 会在卡片里留下模板看不见、但导出与索引仍可能碰到的字段。
   */
  const acceptAiValues = (values: Record<string, string>): Record<string, string> | null => {
    if (templateDef && aiBasisRef.current && templateDef.semanticDigest !== aiBasisRef.current) {
      showToast('模板在生成期间改过（为避免写进已不存在的字段，本次结果已作废），请重新生成', 'error')
      return null
    }
    if (!templateDef) return values
    const { picked, dropped } = pickValuesOfKeys(values, cardAiFields.map(f => f.key))
    if (dropped > 0) showToast(`已忽略 ${dropped} 个当前模板中不可写的字段`, 'error')
    return picked
  }
  /**
   * 标题改名时要顺带补「姓名」的存储键。
   * 🔴 采用模板后以模板的 `nameFieldId` 为准 —— 作者可能把姓名换成了别的字段，
   *    继续用 `cardNamePath` 会往一个已经隐藏/归档的旧槽位里写值。
   */
  const nameStorageKey = useMemo(() => {
    if (templateDef) {
      const f = templateDef.fields.find(x => x.id === templateDef.nameFieldId)
      if (f) return f.sourceKey
    }
    return cardNamePath(tab)
  }, [templateDef, tab])
  /**
   * 3.2.0：迁移期间**不许落库**（方案 §3.6）。
   *
   * 🔴 静默路径（卸载 / 切页签 / 切卡）也用同一个判据：这些路径以前直接 `saveCardRecord`，
   *    迁移窗口里正好会把旧结构的草稿灌进新结构。拦掉只是「这次没自动存」，
   *    草稿仍在内存里（切页签会丢，但那是迁移场景下唯一不制造脏数据的选择）。
   */
  const saveDraftIfAllowed = useCallback(async (rec: CardRecord): Promise<boolean> => {
    if (await guardTabWrite(rec.projectId, rec.tabId, 'autosave')) return false
    await saveCardRecord(rec)
    return true
  }, [])

  /** 用户主动触发的写入：冲突要**说出来**，并把下一步做法一起给出 */
  const blockedByMigration = useCallback(async (source: TabWriteSource): Promise<boolean> => {
    const conflict = await guardTabWrite(getCurrentProjectId(), tab.id, source)
    if (!conflict) return false
    showToast(`${conflict.message}${conflict.hint}`, 'error')
    return true
  }, [tab.id])

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
    if (dirtyRef.current && draftRef.current) void saveDraftIfAllowed(draftRef.current)
  }, [saveDraftIfAllowed])

  useEffect(() => {
    // 切到别的页签前，先把当前卡片未保存的修改落库（之前会静默丢弃）
    if (dirtyRef.current && draftRef.current) {
      void saveDraftIfAllowed(draftRef.current)
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
  }, [tab.id, saveDraftIfAllowed])

  // 切换 active（同一页签内不同卡片）时刷新 draft；切换前先落盘上一卡未保存的修改，避免静默丢稿
  useEffect(() => {
    const prev = prevActiveRef.current
    // 仅当「确实切到了另一张仍存在的卡」才存旧卡草稿；因删除导致的切换不存档（避免复活已删卡）
    if (prev && prev !== activeId && dirtyRef.current && draftRef.current && records.some(r => r.id === prev)) {
      const done = draftRef.current
      void saveDraftIfAllowed(done)
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
  }, [activeId, records, saveDraftIfAllowed])

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
   * @param silent 静默模式：不弹 toast，把「提示」交给调用方。导入路径用它 ——
   *   那里需要把失败**抛给导入弹窗**，让弹窗不关窗、保留粘贴内容，作者才能真的「重试」。
   *
   * 🔴 **调用方纪律**：本函数用**函数式** `setRecords` 同步内存副本，所以紧接着追加新卡时
   *    也必须写 `setRecords(list => [...list, rec])`。写成 `setRecords([...records, rec])`
   *    （闭包里的旧数组）会**整个覆盖**掉本次同步 —— 表现为「库里已是新值、界面还是旧值」，
   *    作者再改一处保存就把刚才的编辑写回旧值。这是 2026-10-16 自审抓出的 R8 残留。
   */
  const flushCurrentDraft = useCallback(async (silent = false): Promise<boolean> => {
    const cur = draftRef.current
    if (!dirtyRef.current || !cur) return true
    // 3.2.0：迁移窗口内不冲刷旧草稿（方案 §3.6）—— 不写 = 不制造串字段的脏数据
    const conflict = await guardTabWrite(cur.projectId, cur.tabId, 'autosave')
    if (conflict) {
      if (!silent) showToast(`${conflict.message}${conflict.hint}`, 'error')
      return false
    }
    try {
      await saveCardRecord(cur)
      // 同步内存副本：否则切回来时用库里的旧记录回灌，刚保存的编辑又「消失」
      setRecords(list => list.map(r => (r.id === cur.id ? cur : r)))
      // 立刻归零，免得切卡 effect 把这张卡当成「还有脏草稿」再存一次
      dirtyRef.current = false
      return true
    } catch (e) {
      if (!silent) {
        showToast(
          `保存当前${nounCard}失败，已取消本次操作 —— 请先手动保存后重试：${e instanceof Error ? e.message : String(e)}`,
          'error',
        )
      }
      return false
    }
  }, [nounCard])

  // AI 新增：草图 → 模型补全全部字段 → 直接建卡（key 即 `模块::字段`，与渲染一致）
  const handleFill = async (values: Record<string, string>) => {
    // R8：建卡后会自动切到新卡，先把当前卡的脏草稿落库（失败则中止）
    if (await blockedByMigration('ai-writeback')) return
    const accepted = acceptAiValues(values)
    if (!accepted) return
    if (!await flushCurrentDraft()) return
    const name = (nameStorageKey ? values[nameStorageKey] : '')?.trim() || `未命名${noun}`
    const rec: CardRecord = {
      id: uid(),
      projectId: getCurrentProjectId(),
      tabId: tab.id,
      name,
      data: { ...accepted },
      order: records.length,
    }
    await saveCardRecord(rec)
    setRecords(list => [...list, rec])
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
    const accepted = acceptAiValues(values)
    if (!accepted) return
    const next = { ...draft, data: { ...draft.data } }
    for (const [k, v] of Object.entries(accepted)) {
      // 只补空白：生成期间作者手填的内容不覆盖（模型可能按过期空白清单返回它）
      const cur = ((next.data[k] ?? '') as string).trim()
      if (cur) continue
      if (v && v.trim()) next.data[k] = v
    }
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
      setRecords(list => [...list, rec])
      setActiveId(rec.id)
      setDraft(rec)
    } else {
      if (!draft || v === draft.name) return
      // R9：标题改了但「姓名」字段还空着 → 顺手补上，免得导出 / 判重时两边对不上。
      // 已填过姓名的不动 —— 作者可能故意让标题与姓名不同（标题「陈渊（主角）」、姓名「陈渊」）。
      // 3.2.0：采用模板后「姓名栏」以模板的 nameFieldId 为准（见 nameStorageKey）。
      const np = nameStorageKey
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
   * 跨页签移动（3.1.3）：把当前这张卡连同立绘搬到另一张角色卡页签。
   *
   * 三条纪律：
   *  ① **先冲刷脏草稿**再搬。否则作者刚改的两行还只在 draft 里，搬过去的是库里的旧值，
   *     而旧页签那张卡已经没了 —— 改的内容就彻底找不回来。
   *  ② 用 `planCardMove()` 现算一次（不信任弹窗传来的预览）：预览可能是几十秒前的快照。
   *  ③ 保留原 `id` 与 `createdAt`：这是同一张卡换了住址，不是新建一张。立绘字段也随 `...latest` 带过去。
   *     落库失败直接抛给弹窗（它会把原因显示在弹窗里，作者可重试，不会留下"卡在半路"的状态）。
   */
  const moveCardTo = async (to: TabDef) => {
    const cur = draftRef.current
    if (!cur) throw new Error('当前没有选中的角色卡')
    if (!await flushCurrentDraft(true)) {
      throw new Error(`当前${nounCard}未能保存，移动已取消 —— 请先手动保存后重试`)
    }
    const latest = draftRef.current ?? cur
    const plan = planCardMove(tab, to, latest)
    // 接在目标页签列表末尾：搬过去的卡不该插队到别人前面
    const targetRecords = await getCardRecords(to.id)
    const next: CardRecord = { ...latest, tabId: to.id, data: plan.data, order: targetRecords.length }
    await saveCardRecord(next)
    // 草稿本按「页签::记录id」存 —— 旧页签那份已经没意义，留着就是孤儿
    void clearFreeDraft(`card::${tab.id}::${next.id}`)
    const left = records.filter(r => r.id !== next.id)
    setRecords(left)
    setActiveId(left[0]?.id ?? null)
    setMoveOpen(false)
    showToast(
      plan.lost.length
        ? `「${latest.name}」已移动到「${to.name}」；${plan.lost.length} 项无对应栏位的内容已按确认丢弃`
        : `「${latest.name}」已移动到「${to.name}」，${plan.carried.length} 项已带过去`,
      plan.lost.length ? 'info' : 'success',
    )
  }

  /**
   * 批量导入（3.1.x）：把勾选的导入行转成角色卡逐条落库，然后刷新左栏并选中第一张新卡。
   *
   * 🔴 逐条串行 await（不用 forEach + void）：与 TableSheet「清空全部」同一个教训 ——
   *    并发发起且不等待会把失败静默吞掉（界面已加进来、库里其实没写进去，重开这一页就消失）。
   */
  const handleImport = async (picked: ImportRowResult[]) => {
    // 3.2.0：迁移期间整行导入会让新旧结构混在一张卡里（方案 §3.6）⇒ 抛出原因，让弹窗保留粘贴内容
    const conflict = await guardTabWrite(getCurrentProjectId(), tab.id, 'import')
    if (conflict) throw new Error(`${conflict.message}${conflict.hint}`)
    // R8：导入后会自动切到第一张新卡，先把当前卡的脏草稿落库。
    // 🔴 失败必须**抛错**，不能静默 return —— 弹窗的 apply() 只在 onAdd 抛错时才不关窗；
    //    直接 return 会让它照常 onClose()，粘贴的内容连同「重试」的机会一起没了。
    if (!await flushCurrentDraft(true)) {
      throw new Error('当前角色卡未能保存，导入已取消 —— 请先手动保存后重试')
    }
    const created = buildCardRecords(picked, tab, records, getCurrentProjectId(), uid)
    const okOnes: CardRecord[] = []
    let failed = 0
    let firstErr = ''
    for (const rec of created) {
      try { await saveCardRecord(rec); okOnes.push(rec) } catch (e) {
        failed++
        // 带上第一条失败原因：只报「N 张没能写入」等于让作者去猜（磁盘满？权限？IDB 异常？）
        if (!firstErr) firstErr = e instanceof Error ? e.message : String(e)
      }
    }
    if (okOnes.length) {
      setRecords(prev => [...prev, ...okOnes])
      setActiveId(okOnes[0].id)
      setDraft(okOnes[0])
    }
    showToast(
      failed
        ? `已导入 ${okOnes.length} 张，另有 ${failed} 张没能写入（${firstErr}）—— 请重试`
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
    downloadBlob(`${tab.name}.csv`, new Blob(['\uFEFF' + exportCardsCsv(tab, recordsWithDraft)], { type: 'text/csv;charset=utf-8' }))
  }

  /**
   * 🔴 B7（2.4.1）：角色立绘 —— **两个位**（`portrait` / `portrait2`）。
   * 「两张」的由来（2026-09-22 老大）：右侧竖着一整列，只放一张时下边空着一块；
   * 与其留白，不如再给一个位（正装 / 便装、或两个姿态）并排铺满。
   * 走 `dirty`（整对象 JSON 比对）自动变"未保存"，无需额外标记。
   * `undefined` = 删除该位立绘（字段可选，删了就回到"没传"的状态）。
   */
  const updatePortrait = async (file: File | null, slot: 1 | 2 = 1) => {
    const targetId = draft?.id
    const targetProject = draft?.projectId
    if (!targetId) return
    if (!file) {
      setDraft(d => (d ? (slot === 2 ? { ...d, portrait2: undefined } : { ...d, portrait: undefined }) : d))
      return
    }
    const request = ++portraitRequest.current.version
    setPortraitBusy(true)
    try {
      const r = await readPortraitFile(file)
      if (request !== portraitRequest.current.version || draftRef.current?.id !== targetId || draftRef.current.projectId !== targetProject) return
      setDraft(d => (d?.id === targetId && d.projectId === targetProject ? (slot === 2 ? { ...d, portrait2: r.dataUrl } : { ...d, portrait: r.dataUrl }) : d))
      const who = slot === 2 ? '立绘 2 ' : '立绘 '
      showToast(
        r.downscaled
          ? `${who}已就绪（${Math.round(r.bytes / 1024)}KB · 为控制体积用了压缩档 ${r.quality}）`
          : `${who}已就绪（${Math.round(r.bytes / 1024)}KB）`,
        'success',
      )
    } catch (e) {
      if (request !== portraitRequest.current.version) return
      showToast(e instanceof Error ? e.message : '这张图不能用作立绘', 'error')
    } finally {
      if (request === portraitRequest.current.version) setPortraitBusy(false)
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
    // 3.2.0：迁移窗口内不写旧结构（方案 §3.6）；作者可据此决定等迁移完再存
    if (await blockedByMigration('draft')) return
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
  }, [draft, dirty, records, blockedByMigration])

  // Ctrl/Cmd+S（2.7.3：收敛到 useSaveHotkey）
  useSaveHotkey(() => void save(), dirty)

  if (!loaded) return <LoadingState />

  return (
    <div className="page-enter h-full min-h-0 flex flex-col" data-character-workspace>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 shrink-0 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
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
          <CharacterTools noun={noun} isCharacter={isCharTab}
            templateTitle={isTemplateTab(tab.id) ? (templateDef
              ? '模板「' + templateDef.name + '」第 ' + templateDef.revision + ' 版：编辑字段与分组、预览变更、恢复到迁移前'
              : '套用模板：固定当前结构，或从空白开始设计字段') : undefined}
            alias={!templateDef && <FieldAliasButton tabId={tab.id} tabName={tab.name} size="sm" variant="bare"
              intro="给这一页的字段起你自己看得懂的名字（每张卡用的是同一套字段）。" targets={aliasTargets} />}
            aiEnabled={aiCap !== 'none'} aiDisabledHint={!aiReady ? AI_DISABLED_HINT : undefined}
            hasSelection={!!draft} canMove={moveTargets.length > 0}
            onTemplate={() => setShowTemplate(true)} onImport={() => setShowImport(true)} onExport={exportCsv}
            onCreateAI={() => setShowFill(true)} onFillAI={() => setShowFillExisting(true)} onMove={() => setMoveOpen(true)} />
          {/* 只看角色卡：非角色卡片表（世界构建的「其他设定」）没有「人物状态」字段，
              这个开关对它们点了也没有任何效果 —— 与其摆着让人困惑，不如不渲染 */}
          {isCharTab && (
            <Button variant="toggle" selected={hideRetired} aria-pressed={hideRetired}
              onClick={() => setHideRetired(v => !v)}
              className="font-medium hover:bg-amber/25"
              title="隐藏「人物状态 = 已退场」的角色，避免列表过长"
            >
              <EyeOff size={14} /> 隐藏已退场
            </Button>
          )}
        </div>
      </header>

      {/* The App workspace supplies a definite height; header wrapping consumes real space. */}
      <MasterDetail>
        {/* 卡片列表（含搜索 + 独立滚动） */}
        <MasterList
          widthClass="w-44 lg:w-52"
          query={listQuery}
          onQueryChange={setListQuery}
          placeholder={`搜${noun}名…`}
          searchHint={isFiltering
            ? <span className="text-10 text-ink-500">筛出 {shownRecords.length} / 共 {records.length}</span>
            : undefined}
          emptyHint={listEmptyHint}
          isEmpty={shownRecords.length === 0}
        >
          {shownRecords.map(rec => {
            const isActive = activeId === rec.id
            const isDirty = isActive && dirty
            const current = isActive && draft ? draft : rec
            const preview = characterProfileFacts(profileFields, current.data)[0]
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
                  <Button variant="bare" className="min-w-0 flex-1 !justify-start" onClick={() => setActiveId(rec.id)} aria-pressed={isActive} aria-label={'选择'+noun+'：'+current.name}>
                    <UserRound size={13} className="shrink-0" />
                    <span className="text-13 font-medium truncate">{current.name}</span>
                  </Button>
                  {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title={UNSAVED_CHANGES_HINT} />}
                  <Button variant="bare" iconOnly size="xs" title={`查看「${rec.name}」在正文中的提及`}
                    onClick={e => { e.stopPropagation(); setMention({ name: current.name, aliases: readAliases(tab.id, current.data) }) }}
                    className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all">
                    <Search size={12} />
                  </Button>
                  <Button variant="icon-danger" iconOnly size="xs" title={`删除这条${nounCard}`} onClick={e => { e.stopPropagation(); removeCard(rec.id) }} className="opacity-40 group-hover:opacity-100 transition-all">
                    <Trash2 size={12} />
                  </Button>
                </div>
                <div className="text-10 text-ink-500 mt-0.5 truncate" title={preview ? `${preview.label}：${preview.value}` : undefined}>
                  {preview ? `${preview.label}：${preview.value}` : '暂无简要信息'}
                </div>
              </div>
            )
          })}
        </MasterList>

        {/* 编辑区（独立滚动） */}
        <div ref={detailRef} data-character-detail className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1">
          {draft ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <CharacterProfileHeader name={draft.name} portrait={draft.portrait || draft.portrait2}
                  facts={isCharTab ? characterProfileFacts(profileFields, draft.data) : []} onRename={renameCard} />
              </div>
              {cardGroups.map(group => {
                // ⚠️ 立绘列挂在「基础信息」组上：是否基础组由 cardGroups 统一算好
                //    （模板可以改名，不再按名字现场比 —— 2026-09-22 曾因此静默不渲染）。
                const isBasicMod = group.isBasic
                return (
                <details key={group.id} open={expanded.has(group.id)} onToggle={e => toggle(group.id, e.currentTarget.open)} data-card-group={group.id} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
                  <summary className="px-4 py-2.5 bg-ink-800 border-b border-ink-700 cursor-pointer text-12 font-semibold text-ink-100">
                    <span>{group.label}</span><span className="ml-2 text-11 font-normal text-ink-400">{group.fields.length} 项</span>
                  </summary>
                  {/* Uploaded portraits retain the established right-side width; empty slots fold below fields. */}
                  <div className={isBasicMod ? '@container/character-basic flex flex-wrap items-stretch' : ''}>
                  {/* 字段区（左）：包一层 flex-col + justify-center，让它在立绘撑高时**均匀铺开**而不是顶在上边 */}
                  <div className={`divide-y divide-ink-700/60 ${isBasicMod ? 'flex-1 min-w-[min(100%,20rem)] flex flex-col justify-center' : ''}`}>
                    {group.fields.map(field => {
                      const key = field.key
                      const permissions = fieldPermissions.get(key)
                      const val = draft.data[key] ?? ''
                      const labelTitle = field.atlasField
                        ? (field.desc || `自定义字段（存储键 ${key}，改名不影响已填内容）`)
                        : field.label !== field.name
                          ? `${field.name}（存储键不变，AI 按当前名称理解）`
                          : undefined
                      return (
                        <div key={key} data-card-field={key} className={`px-4 py-3 grid gap-3 hover:bg-ink-800/40 transition-colors ${
                          isBasicMod ? 'grid-cols-1 @min-[28rem]/workspace:grid-cols-[104px_minmax(0,1fr)]' : 'grid-cols-1 @min-[40rem]/workspace:grid-cols-[140px_minmax(0,1fr)]'
                        }`}>
                          <div>
                            <div
                              className="text-12 font-medium text-ink-100"
                              title={labelTitle}
                            >{field.label}</div>
                            <FieldDescription label={field.label} description={field.desc} />
                            {cardPending.has(key) ? <p className="mt-1 text-11 text-amber">含义待确认：不供 AI 参考或填写</p>
                              : permissions && (!permissions.aiRead || !permissions.aiWrite) && <p className="mt-1 text-11 text-ink-300">
                                {[!permissions.aiRead && '不供 AI 参考', !permissions.aiWrite && '不允许 AI 填写'].filter(Boolean).join(' · ')}
                              </p>}
                          </div>
                          {/* ⚠️ 2026-09-22 **二次返工**：上一版把这里收在 `max-w-[26rem]`，结果输入框与立绘
                              之间空出一大块（老大原话「中间你打算放啥呢」）。正确做法是让输入框**吃满字段区**：
                              它的宽度上限本来就由「卡片宽 − 立绘列」自然决定，不该再人为设一个更小的上限。 */}
                          <div>
                            {/* 自定义字段（模板新增）走图鉴那套六类型控件；内置字段仍按原业务映射渲染 */}
                            {field.customType && field.atlasField ? (
                              <AtlasCellInput
                                field={field.atlasField}
                                value={val}
                                onChange={v => updateField(key, v)}
                              />
                            ) : CARD_TABLE_REF_FIELDS[field.name] ? (
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
                                aria-label={field.label}
                                value={val}
                                onChange={e => updateField(key, e.target.value)}
                                className="w-full text-12 bg-ink-800 border border-ink-700 rounded px-2 py-1"
                              >
                                {CARD_SELECT_FIELDS[field.name].map(o => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            ) : field.type === 'boolean' ? (
                              <select
                                aria-label={field.label}
                                value={val}
                                onChange={e => updateField(key, e.target.value)}
                                className="w-full text-12 bg-ink-800 border border-ink-700 rounded px-2 py-1"
                              >
                                <option value="">—</option>
                                <option value="true">是</option>
                                <option value="false">否</option>
                              </select>
                            ) : field.type === 'select' && (field.options?.length ?? 0) > 0 ? (
                              <select
                                aria-label={field.label}
                                value={val}
                                onChange={e => updateField(key, e.target.value)}
                                className="w-full text-12 bg-ink-800 border border-ink-700 rounded px-2 py-1"
                              >
                                <option value="">—</option>
                                {field.options!.map(o => (
                                  <option key={o} value={o}>{o}</option>
                                ))}
                              </select>
                            ) : (
                              <AutoTextarea
                                ariaLabel={field.label}
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
                  {isBasicMod && (<CharacterPortraitPanel
                      name={draft.name} portrait={draft.portrait} portrait2={draft.portrait2} busy={portraitBusy}
                      onPick={(f, slot) => void updatePortrait(f, slot)} onRemove={slot => void updatePortrait(null, slot)} />)}
                  {/* 闭合「基础信息」的左右分栏容器（其余模块这个 div 不生成，类名为空也无害） */}
                  </div>
                </details>
                )
              })}
              {!cardGroups.some(group => group.isBasic) && (<CharacterPortraitPanel
                      name={draft.name} portrait={draft.portrait} portrait2={draft.portrait2} busy={portraitBusy}
                      onPick={(f, slot) => void updatePortrait(f, slot)} onRemove={slot => void updatePortrait(null, slot)} />)}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-ink-500 text-sm border border-dashed border-ink-700 rounded-xl">
              选择左侧{noun}或新建一个
            </div>
          )}
        </div>
      </MasterDetail>

      {tab.tips && tab.tips.length > 0 && (
        <div className="mt-3 max-h-24 shrink-0 overflow-y-auto rounded-xl border border-amber/20 bg-amber/5 p-3 space-y-1.5">
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
          fields={cardAiFields}
          tabId={tab.id}
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
          fields={cardAiFillFields}
          tabId={tab.id}
          existing={cardAiExisting}
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
          existing={cardRecordsToTableRows(tab, recordsWithDraft)}
          visCtx={ctx}
          guideBuilder={buildCardImportGuide}
          onAdd={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* 3.2.0：模板管理（采用 / 编辑 / 预览迁移 / 恢复） */}
      {isTemplateTab(tab.id) && showTemplate && (
        <TemplateManagerDialog tab={tab} onClose={() => setShowTemplate(false)} />
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

      {/* 3.1.3：跨页签移动 —— rec 用当前草稿（未保存的修改也一起搬，见 moveCardTo） */}
      {moveOpen && draft && moveTargets.length > 0 && (
        <CardMoveDialog
          rec={draft}
          from={tab}
          targets={moveTargets}
          onClose={() => setMoveOpen(false)}
          onConfirm={moveCardTo}
        />
      )}

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

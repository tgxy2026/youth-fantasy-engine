/**
 * 图鉴视图（3.1.3 · 骨架版）—— 「种族生物 / 物品资源」两个页签的卡片墙。
 *
 * 依据：方案 §3.1（页签布局）/ §3.2（卡片及详情）。
 *
 * 本轮已落地：卡片网格、右侧详情（窄屏覆盖 + 返回）、无图占位、空态、按分组只读展示。
 * 本轮**未做**（下一步 F3/F4）：就地编辑、图片上传、卡片密度、侧栏宽度拖拽、层级树联动。
 *
 * 🔴 数据口径：`rows` 由调用方传入 `filteredRows` —— 即**已并入未保存草稿、且已应用表头筛选**
 *    的那一份（与表格视图逐字一致）。图鉴不自己去读库，否则「表格里刚改、图鉴看不见」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import type { TableRow, TabDef } from '@/lib/types'
import {
  atlasCardBadges, atlasFieldsForCategory, atlasSections, atlasSummaryFields, resolveAtlasFields,
} from '@/lib/atlas/schema'
import type { AtlasImage, AtlasSchemaConfig } from '@/lib/atlas/types'
import type { TemplateDef } from '@/lib/templates/definition'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { atlasFieldsOfTemplate } from '@/lib/templates/render'
import { foldVh } from '@/lib/settings/theme'
import { usePersistedEnum } from '@/lib/settings/uiPrefs'
import { Button } from '@/components/common/Button'
import AtlasCard from './AtlasCard'
import AtlasDetail from './AtlasDetail'

interface Props {
  tab: TabDef
  /** 已并入草稿 + 已筛选的行（`model.filteredRows`） */
  rows: TableRow[]
  /** 内置字段的显示名覆写（fieldAlias） */
  aliases?: Record<string, string>
  /**
   * 字段配置（项目级 `atlasSchema::<tabId>`）。
   * 🔴 必须传：不传就只能看到内置字段 —— 表现是「表格里新建的字段图鉴看不见」，
   *    而且不报任何错（本轮实测就踩过一次）。
   */
  config?: AtlasSchemaConfig | null
  /**
   * 3.2.0：项目已采用的模板快照。
   * 🔴 有它 ⇒ 字段 / 分组全部按快照解析，图鉴配置只在“未采用模板”时生效。
   */
  templateDef?: TemplateDef | null
  /** 「在表格中编辑」：切回表格视图（共享草稿与保存流程不变） */
  onEditInTable: () => void
  /** 主图保存（即选即存，落库由 model 负责） */
  onSaveImage?: (rowId: string, image: AtlasImage | null) => void | Promise<void>
  /** 项目图鉴图片已用字节（两个页签合计），用于容量提示 */
  imageUsage?: number
  /** 图片总上限；`Infinity` = 本机存储不限（仅云端账号模式才有 32MiB 约束） */
  imageLimit?: number
  /** 导出图鉴资料包（字段定义 + 条目 + 图片） */
  onExportPackage?: () => void
  /** 导入资料包（父组件负责解析、预览确认与落库） */
  onImportPackage?: (file: File) => void
  /**
   * 逐字段取值（含未保存草稿）。
   * 🔴 必须传 `model.cellVal`：详情只读展示也要看得见"表格里刚改还没保存"的值，
   *    否则就是「表格改了、点开详情还是旧的」——两套口径。
   */
  cellValue?: (row: TableRow, key: string) => string
  /** 就地编辑：写入共享草稿（父级 `model.setCellDraft`） */
  onCellChange?: (rowId: string, key: string, value: string) => void
  /** 某行是否有未保存改动 */
  dirtyOf?: (rowId: string) => boolean
  /** 全局保存进行中 */
  saving?: boolean
  /** 保存（= 表格底部同一个 `saveAll`） */
  onSave?: () => void | Promise<void>
  /** 撤销详情里本次改动：交回进入编辑态时的字段值快照 */
  onRevert?: (rowId: string, values: Record<string, string>) => void
}

/** 详情侧栏默认宽度（方案 §3.1：默认 420px，允许 360～600 拖动 —— 拖动留到 F4） */
const DETAIL_W = 420
/** 主体可用宽度低于此值 ⇒ 详情覆盖主体并显示「返回」 */
const NARROW_BREAKPOINT = 960

type Density = 'compact' | 'standard' | 'loose'
/** 密度 → 卡片最小宽度（方案 §3.1 三档；网格用内联 style，避免动态 Tailwind 类名） */
const MIN_CARD_W: Record<Density, number> = { compact: 150, standard: 180, loose: 220 }
const DENSITY_LABEL: Record<Density, string> = { compact: '紧凑', standard: '标准', loose: '宽松' }

export default function AtlasView({
  tab, rows, aliases, config, templateDef, onEditInTable, onSaveImage, imageUsage = 0, imageLimit, onExportPackage, onImportPackage,
  cellValue, onCellChange, dirtyOf, saving, onSave, onRevert,
}: Props) {
  const pkgInputRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 卡片密度（本机偏好：只影响显示，不进项目配置）
  const [density, setDensity] = usePersistedEnum<Density>('atlas-density', ['compact', 'standard', 'loose'], 'standard')

  /**
   * 🔴 量 `offsetWidth` 而不是用媒体查询 / vw：
   *    本项目有「界面缩放」，vw 不随 zoom 变化（UI·布局红线），判据会失准。
   *    容器宽度才是真正决定「放不放得下侧栏」的量。
   */
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const sync = () => setNarrow(el.offsetWidth < NARROW_BREAKPOINT)
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const nameKey = templateDef
    ? templateDef.fields.find(f => f.id === templateDef.nameFieldId)?.sourceKey ?? tab.displayCol ?? '名称'
    : tab.displayCol ?? '名称'
  /** 采用模板后，图鉴字段与分组都以快照为准（图鉴配置不再参与） */
  const templateFields = useMemo(
    () => (templateDef
      ? atlasFieldsOfTemplate(resolveTemplateForTab(tab, {
        def: templateDef,
        purpose: 'detail',
        ignoreAppliesTo: true,
      }))
      : null),
    [tab, templateDef],
  )
  /**
   * 🔴 详情按**选中条目自己的类别**解析（3.1.3 · R02）。
   *    之前这里完全没传类别 ⇒ 凡是"只适用某类别"的字段在详情里一律不显示
   *    （验收实测：魔兽条目的"食性"存了值，详情里却没有这一项）。
   *    表结构仍取全量（见 `atlasColumnsOf`），这里只决定"这一条看得见哪些"。
   */
  const detailFields = useMemo(
    () => atlasFieldsForCategory(
      templateFields ?? resolveAtlasFields(tab, { aliases, config, purpose: 'detail', ignoreAppliesTo: true }),
      selectedId ? rows.find(r => r.id === selectedId)?.data?.['类别'] : undefined,
    ),
    [tab, aliases, config, templateFields, selectedId, rows],
  )
  /** 摘要候选取全量（作者在字段设置里显式挑的展示项，不受类别砍） */
  const allSummaryFields = useMemo(
    () => atlasSummaryFields(
      tab.id,
      templateDef
        ? atlasFieldsOfTemplate(resolveTemplateForTab(tab, {
          def: templateDef,
          purpose: 'export',
          ignoreAppliesTo: true,
        }))
        : resolveAtlasFields(tab, { aliases, config, purpose: 'export', ignoreAppliesTo: true }),
      config,
    ),
    [tab, aliases, config, templateDef],
  )
  const sections = useMemo(() => {
    if (!templateFields) return atlasSections(tab, detailFields, config)
    // 采用模板：分组名与顺序取快照，字段取“已按类别过滤”的详情字段
    const groups = templateDef!.groups
    const labelOf = new Map(groups.map(g => [g.id, g.label]))
    const orderOf = new Map(groups.map(g => [g.id, g.order]))
    const byGroup = new Map<string, typeof detailFields>()
    for (const f of detailFields) {
      const arr = byGroup.get(f.groupId)
      if (arr) arr.push(f)
      else byGroup.set(f.groupId, [f])
    }
    return [...byGroup.entries()]
      .map(([id, fields]) => ({ id, label: labelOf.get(id) ?? id, fields }))
      .sort((a, b) => (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0))
  }, [tab, config, detailFields, templateFields, templateDef])

  // 筛选变化把选中条目筛掉时关闭详情，**不**自动跳到别的条目（方案 §3.4）
  useEffect(() => {
    if (selectedId && !rows.some(r => r.id === selectedId)) setSelectedId(null)
  }, [rows, selectedId])

  const selected = selectedId ? rows.find(r => r.id === selectedId) ?? null : null

  return (
    <div ref={hostRef} className="relative flex gap-4 min-h-0" style={{ height: foldVh('62vh') }}>
      {/* 列表：自己滚（与右侧详情各滚各的，方案 §3.1） */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-ink-500">
              <BookOpen size={26} className="text-ink-600" />
              <span className="text-13">图鉴里还没有条目</span>
              <span className="text-11 text-ink-600">切回表格点「新增一行」，或换一个筛选条件</span>
            </div>
          </div>
        ) : (
          <>
            {/* 工具条：条数 + 密度 + 资料包（方案 §3.1 必交付项） */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-10 text-ink-500 mr-auto">共 {rows.length} 条 · 点卡片看完整资料</span>
              {onImportPackage && (
                <>
                  <button
                    type="button"
                    onClick={() => pkgInputRef.current?.click()}
                    className="text-10 px-2.5 h-8 rounded-lg border border-ink-700 bg-ink-800 text-ink-300 hover:border-amber/40 hover:text-amber transition-colors"
                    title="导入图鉴资料包（含字段定义与图片）"
                  >
                    导入资料包
                  </button>
                  <input
                    ref={pkgInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) onImportPackage(f)
                      e.target.value = ''
                    }}
                  />
                </>
              )}
              {onExportPackage && (
                <button
                  type="button"
                  onClick={onExportPackage}
                  className="text-10 px-2.5 h-8 rounded-lg border border-ink-700 bg-ink-800 text-ink-300 hover:border-amber/40 hover:text-amber transition-colors"
                  title="导出图鉴资料包：字段定义 + 全部条目 + 主图，可在别的项目导入"
                >
                  导出资料包
                </button>
              )}
              {/* 🔴 三块等高（2026-10-18 主人反馈：两小一大看着歪）：外壳统一 h-8，
                  内部按钮一律 h-full —— 高度只由外壳决定，加按钮/改字号都不会再错位。 */}
              <div className="flex items-center h-8 bg-ink-800 border border-ink-700 rounded-lg p-0.5">
                {(Object.keys(DENSITY_LABEL) as Density[]).map(k => (
                  <Button
                    key={k}
                    variant="bare"
                    onClick={() => setDensity(k)}
                    title={`卡片密度：${DENSITY_LABEL[k]}`}
                    className={`px-2 h-full rounded text-10 transition-colors ${
                      density === k ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'
                    }`}
                  >
                    {DENSITY_LABEL[k]}
                  </Button>
                ))}
              </div>
            </div>
            <div
              className="grid gap-3 pb-1"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${MIN_CARD_W[density]}px, 1fr))` }}
            >
              {rows.map(row => (
                <AtlasCard
                  key={row.id}
                  row={row}
                  nameKey={nameKey}
                  density={density}
                  image={row.atlasImage}
                  badges={atlasCardBadges(tab.id, row.data)}
                  summaryFields={atlasFieldsForCategory(allSummaryFields, row.data['类别'])}
                  selected={row.id === selectedId}
                  onOpen={() => setSelectedId(row.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* 详情：宽屏占右侧固定宽，窄屏覆盖主体（点「返回」关闭） */}
      {selected && (
        <div
          className={narrow ? 'absolute inset-0' : 'shrink-0 min-h-0'}
          style={narrow ? undefined : { width: DETAIL_W }}
        >
          <AtlasDetail
            key={selected.id}
            tabId={tab.id}
            row={selected}
            nameKey={nameKey}
            badges={atlasCardBadges(tab.id, selected.data)}
            sections={sections}
            image={selected.atlasImage}
            // 🔴 不丢 Promise（3.1.3 · R10）：详情要 await 落库结果才能提示"已更新"
            onImageChange={img => onSaveImage?.(selected.id, img)}
            projectImageBytes={imageUsage}
            imageLimit={imageLimit}
            overlay={narrow}
            onClose={() => setSelectedId(null)}
            onEditInTable={onEditInTable}
            cellValue={cellValue}
            onCellChange={onCellChange ? (k, v) => onCellChange(selected.id, k, v) : undefined}
            dirty={dirtyOf?.(selected.id) ?? false}
            saving={saving}
            onSave={onSave}
            onRevert={onRevert ? vals => onRevert(selected.id, vals) : undefined}
          />
        </div>
      )}
    </div>
  )
}

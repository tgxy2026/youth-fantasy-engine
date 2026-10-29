/**
 * 图鉴详情（3.1.3）。
 *
 * 依据：方案 §3.2「详情默认浏览，点击编辑进入表单；编辑内容沿用共享草稿机制」。
 *
 * 🔴 编辑的口径（2026-10-19 主人拍板「要」就地编辑）：
 *    · 默认仍是**只读浏览**，点「编辑」才进入表单 —— 图鉴是速查视图，误触改字代价太高；
 *    · 改动一律走 `onCellChange` 写进**表格的同一份草稿**（`useTableSheetModel.setCellDraft`），
 *      这里**不持有第二份数据** —— 否则就会出现"详情里改了、表格里没变"的两套真源；
 *    · 保存复用底部那个全局保存（`onSave` 就是 `model.saveAll`），详情不另开落库通道；
 *    · 「撤销」只回滚本次在详情里动过的栏位（`revertDraftCells`），不碰表格里其它未保存改动。
 *
 * 🔴 只读展示的值也必须**含未保存草稿**（`cellValue`）：
 *    之前这里直接读 `row.data`，导致「表格里刚改、点开详情还是旧值」—— 与图鉴视图
 *    "不自己去读库"的口径自相矛盾。现在由父级把 `model.cellVal` 传下来。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import '@/components/atlas/atlasMobile.css'
import { ArrowLeft, ImagePlus, Loader2, Save, Table2, Trash2, Undo2 } from 'lucide-react'
import type { TableRow } from '@/lib/types'
import { atlasDisplayValue } from '@/lib/atlas/schema'
import type { AtlasImage, AtlasResolvedSection, ResolvedAtlasField } from '@/lib/atlas/types'
import {
  ATLAS_IMAGE_ACCEPT,
  ATLAS_IMAGE_HINT,
  ATLAS_IMAGE_MAX_EDGE,
  ATLAS_IMAGE_MAX_INPUT_BYTES,
  readAtlasImage,
} from '@/lib/atlas/image'
import { ATLAS_TOTAL_LIMIT, atlasUsageRatio, atlasUsageText, checkAtlasBudget } from '@/lib/atlas/quota'
import { showToast } from '@/components/dialogs/dialogs'
import { getActiveOverlayScope } from '@/lib/app/overlayScope'
import { Button } from '@/components/common/Button'
import SafeImage from '@/components/common/SafeImage'
import { useImageDrop, DropOverlay } from '@/components/common/ImageDropZone'
import AtlasCellInput from './AtlasCellInput'
import { CellTextarea } from '@/components/sheets/tableSheetShared'
import { useAtlasWorkspaceOptions } from './useAtlasWorkspaceOptions'

interface Props {
  scrollRef?: RefObject<HTMLDivElement>
  /**
   * 所属页签 ID（OPT-010）：内置下拉要接「自定义选项」存储
   * （键 = customOption::<pid>::<tabId>::<列名>），必须与表格侧同一个 tabId
   * 才看得到、加得到同一批自定义值。
   */
  tabId: string
  row: TableRow
  nameKey: string
  badges: string[]
  sections: readonly AtlasResolvedSection[]
  /** 主图（`TableRow.atlasImage`） */
  image?: AtlasImage | null
  /**
   * 主图变更：null = 移除。父组件负责落库（即选即存，不进文字草稿）。
   * 🔴 返回 Promise（3.1.3 · R10）：落库是异步的，**必须等它真的写完**才能提示"已更新" ——
   *    之前这里是 `void`，父组件又把 Promise 丢掉 ⇒ 磁盘写不进去 / 云端登录过期 / 配额不足时
   *    作者看到的仍是"主图已更新"，而图其实没存上（修复前是未处理 Promise 静默失败）。
   */
  onImageChange: (image: AtlasImage | null) => void | Promise<void>
  /** 项目图鉴图片已用字节（四个图鉴页签合计），用于容量提示与硬闸 */
  projectImageBytes?: number
  /** 项目图片总上限；`Infinity` = 本机存储不限（桌面 / 便携 / 游客网页版）。默认按云端档位保守处理 */
  imageLimit?: number
  /** 窄屏：详情占满主体，头部显示「返回」 */
  overlay: boolean
  onClose: () => void
  onEditInTable: () => void
  navigation?: { index: number; count: number; move: (direction: -1 | 1) => void; focus: boolean }
  navigationGuard?: MutableRefObject<(() => boolean) | null>
  onNavigationStateChange?: () => void

  /**
   * 逐字段取值（已并入未保存草稿）。不传则退回读 `row.data` —— 只在没有表格模型的
   * 场景（例如将来的只读分享页）允许这样。
   */
  cellValue?: (row: TableRow, key: string) => string
  /** 就地编辑：写入共享草稿。不传 ⇒ 整个详情保持只读（不出现「编辑」按钮） */
  onCellChange?: (key: string, value: string) => void
  /** 本行有未保存改动（父级 `drafts[row.id]` 非空） */
  dirty?: boolean
  /** 全局保存进行中 */
  saving?: boolean
  /** 保存（= 表格底部同一个 `saveAll`） */
  onSave?: () => Promise<boolean>
  /** 撤销本次改动：把进入编辑态时的字段值快照交回去 */
  onRevert?: (values: Record<string, string>) => void
}

/**
 * 详情里**能就地改**的字段 —— 判定本身在 `lib/atlas/editability.ts`
 * （纯函数、可单测；组件这里只负责按它挂控件）。
 */
import { atlasDetailEditable } from '@/lib/atlas/editability'
import CustomSelect from '@/components/common/CustomSelect'
export { atlasDetailEditable }

/** 单个字段的编辑器：自定义字段走 `AtlasCellInput`，内置字段只用文本 / 下拉两种 */
function DetailInput({ tabId, field, value, onChange }: { tabId: string; field: ResolvedAtlasField; value: string; onChange: (v: string) => void }) {
  if (field.source === 'custom') {
    return <AtlasCellInput field={field} value={value} onChange={onChange} />
  }
  if ((field.builtinType ?? 'text') === 'select') {
    // 🔴 OPT-010（2026-10-19 主人反馈）：原先这里是原生 select、只读 schema 预设选项 ——
    //    表格模式用的 CustomSelect 能加自定义值、也能看到别人加的值，图鉴却都看不到也加不了。
    //    现统一走 CustomSelect（同一份 customOption::<pid>::<tabId>::<列名> 存储）。
    //    封闭枚举（保密等级等，被 AI 预算排序与角色视角读取）由 fixedOptions 挡住增改。
    return (
      <CustomSelect
        tabId={tabId}
        colName={field.key}
        options={field.options ?? []}
        value={value}
        onChange={onChange}
        {...(field.fixedOptions ? { fixedOptions: true } : {})}
      />
    )
  }
  return <CellTextarea value={value} onChange={onChange} title={field.description || field.label} />
}

export default function AtlasDetail({
  tabId, row, nameKey, badges, sections, image, onImageChange, projectImageBytes = 0, imageLimit = ATLAS_TOTAL_LIMIT,
  overlay, onClose, onEditInTable,
  cellValue, onCellChange, dirty = false, saving = false, onSave, onRevert,
  scrollRef, navigation, navigationGuard, onNavigationStateChange,
}: Props) {
  const name = ((cellValue ? cellValue(row, nameKey) : row.data[nameKey]) ?? '').trim() || '未命名条目'
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  /** 进入编辑态那一刻的值快照（含草稿）—— 「撤销」就回到这里 */
  const [snapshot, setSnapshot] = useState<Record<string, string>>({})
  const finishing = useRef(false)
  const [finishingEdit, setFinishingEdit] = useState(false)
  const [choosingImage, setChoosingImage] = useState(false)
  const activity = useRef({ editing: false, busy: 0, choosing: false })
  const navRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!navigationGuard) return
    const blocked = () => activity.current.editing || activity.current.busy > 0 || activity.current.choosing || dirty || saving || finishing.current
    navigationGuard.current = blocked
    return () => { if (navigationGuard.current === blocked) navigationGuard.current = null }
  }, [navigationGuard, dirty, saving])
  useEffect(() => { onNavigationStateChange?.() }, [editing, busy, choosingImage, finishingEdit, onNavigationStateChange])
  useEffect(() => {
    const input = fileRef.current
    const cancel = () => { activity.current.choosing = false; setChoosingImage(false) }
    input?.addEventListener('cancel', cancel)
    return () => input?.removeEventListener('cancel', cancel)
  }, [])
  useLayoutEffect(() => {
    if (navigation?.focus) navRef.current?.focus({ preventScroll: true })
  }, [navigation?.focus, row.id])

  /** 取值统一入口：草稿优先（父级 `cellVal`），没有模型时退回库值 */
  const valueOf = (key: string) => {
    if (cellValue) return cellValue(row, key)
    const v = row.data[key]
    return v === undefined || v === null ? '' : String(v)
  }

  const editable = !!onCellChange
  /** 本次编辑态里可改的字段（进出编辑态时重算，类别改了跟着变） */
  const editKeys = useMemo(
    () => sections.flatMap(sec => sec.fields).filter(atlasDetailEditable).map(f => f.key),
    [sections],
  )

  const startEdit = () => {
    const snap: Record<string, string> = {}
    for (const k of editKeys) snap[k] = valueOf(k)
    setSnapshot(snap)
    activity.current.editing = true; setEditing(true)
  }
  const cancelEdit = () => {
    onRevert?.(snapshot)
    activity.current.editing = false; setEditing(false)
  }
  const finishEdit = async () => {
    if (finishing.current) return
    finishing.current = true
    setFinishingEdit(true)
    try {
      if (dirty && (!onSave || !await onSave())) {
        showToast('尚有修改未提交，请核对当前草稿后重试保存。', 'error')
        return
      }
      activity.current.editing = false; setEditing(false)
    } catch {
      showToast('保存失败，请保留当前草稿并重试。', 'error')
    } finally {
      finishing.current = false
      setFinishingEdit(false)
    }
  }

  /**
   * 上传 / 移除的**串行链**（3.1.3 · R10）。
   * 作者手快连点两次"换一张"时，两次落库若并发跑，后写者可能用旧行覆盖前者的图 ⇒
   * 界面显示的与库里的不是同一张。串起来之后顺序即结果。
   */
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())

  /** 落库并**等它真的写完**再提示；失败保留原图并如实报错（不谎报成功、不静默吞错） */
  const commitImage = async (next: AtlasImage | null) => {
    activity.current.busy++
    setBusy(true)
    const run = chainRef.current.catch(() => undefined).then(() => onImageChange(next))
    // 链上存的是"已消化失败"的版本：一次失败不能堵死后续所有操作
    chainRef.current = run.then(() => undefined, () => undefined)
    try {
      await run
      return true
    } catch (e) {
      showToast(`主图保存失败（原图未改动）：${e instanceof Error ? e.message : String(e)}`, 'error')
      return false
    } finally {
      activity.current.busy--; setBusy(activity.current.busy > 0)
    }
  }

  /** 选图 → 压缩 → 容量检查 → 交给父组件落库。失败原因直接展示给作者（不吞错、不写半成品） */
  const pickImage = async (file: File | undefined) => {
    if (!file) return
    activity.current.busy++
    setBusy(true)
    try {
      const r = await readAtlasImage(file)
      if (!r.ok) { showToast(r.reason, 'error'); return }
      // 替换同一行的图按**净增量**算（先减掉本行旧图），否则换小图也会被判超限
      const before = image?.bytes ?? 0
      const check = checkAtlasBudget(projectImageBytes - before, r.image.bytes, imageLimit)
      if (check.level === 'over') {
        showToast(check.reason ?? '项目图片容量不足', 'error')
        return
      }
      // 🔴 必须 await：落库真的成功了才提示"已更新"
      const okSave = await commitImage(r.image)
      if (!okSave) return
      showToast(
        `主图已更新（${Math.round(r.image.bytes / 1024)}KB，${r.image.width}×${r.image.height}）`
        + (check.level === 'warn' ? ` · 项目图片已用 ${atlasUsageText(check.after, imageLimit)}，快满了` : ''),
        check.level === 'warn' ? 'info' : 'success',
      )
    } finally {
      activity.current.busy--; setBusy(activity.current.busy > 0)
    }
  }

  /** 移除主图：同样要等落库（移除失败时图还在，不能先说"已移除"） */
  const removeImage = async () => {
    if (await commitImage(null)) showToast('已移除主图（文字内容不受影响）')
  }

  // 3.2.0：主图可直接拖到预览框上（与「上传主图」同一个 pickImage，压缩 / 容量检查 / 串行落库全复用）
  const drop = useImageDrop({ accept: ATLAS_IMAGE_ACCEPT, onFile: pickImage, disabled: busy })

  /** 容量提示的成色：≥80% 琥珀、超限红（和方案 §6.2 的提示口径一致） */
  const usageRatio = atlasUsageRatio(projectImageBytes, imageLimit)
  const usageClass = usageRatio >= 1 ? 'text-danger' : usageRatio >= 0.8 ? 'text-amber' : 'text-ink-600'
  /**
   * 「显示未填写字段」（方案 §3.2）：默认收起未填的，减少噪音；要补全时打开它，
   * 空字段用灰色「—」占位 —— 作者能看到"这里还有一栏没写"，而不是以为字段消失了。
   */
  const [showEmpty, setShowEmpty] = useAtlasWorkspaceOptions(row.projectId, tabId, row.id)

  // 空分组不渲染（方案 §3.2：字段数为零时不出现空分组）；未填字段按开关决定去留
  const visible = sections
    .map(sec => ({
      ...sec,
      fields: sec.fields
        .map(f => ({ field: f, value: atlasDisplayValue(f, valueOf(f.key)) }))
        // 编辑态下空的也要露出来，否则"想补一栏空的"根本没入口
        .filter(x => showEmpty || editing || x.value.length > 0),
    }))
    .filter(sec => sec.fields.length > 0)
  /** 已填项数（与上面的开关无关 —— 开关只决定"空字段要不要显示"） */
  const filledCount = sections.reduce(
    (n, sec) => n + sec.fields.filter(f => atlasDisplayValue(f, valueOf(f.key)).length > 0).length,
    0,
  )

  return (
    <aside className="h-full min-h-0 flex flex-col rounded-xl border border-ink-700 bg-ink-850 overflow-hidden">
      <header className="shrink-0 border-b border-ink-700 px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-15 font-semibold text-ink-50 leading-snug break-words">{name}</h2>
            {badges.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {badges.map(b => (
                  <span
                    key={b}
                    className="text-10 px-1.5 py-0.5 rounded bg-ink-800 border border-ink-700 text-ink-300"
                  >
                    {b}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            data-atlas-close
            type="button"
            onClick={onClose}
            className="shrink-0 flex items-center gap-1 text-11 text-ink-400 hover:text-ink-100 px-2 py-1 rounded-lg border border-ink-700 hover:border-ink-600 transition-colors"
            title={overlay ? '返回图鉴列表' : '关闭详情'}
          >
            {overlay && <ArrowLeft size={12} />}
            {overlay ? '返回' : '关闭'}
          </button>
        </div>
        {navigation && <div ref={navRef} data-atlas-nav tabIndex={0} role="group"
          aria-label={navigation.index < 0 ? `图鉴详情导航：${name}，当前条目不在筛选结果中` : `图鉴详情导航：${name}，第 ${navigation.index + 1} / ${navigation.count} 条`}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
            if (event.key === 'Escape') {
              const popup = [...document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]')].some(element => element.getClientRects().length > 0)
              if (getActiveOverlayScope() || popup) return
              event.preventDefault(); onClose(); return
            }
            const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0
            if (!direction) return
            event.preventDefault()
            if (editing || dirty || saving || busy || choosingImage || finishing.current) {
              showToast('请先结束编辑并保存草稿，或等待图片处理完成，再切换条目。', 'info')
              return
            }
            navigation.move(direction)
          }}
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md text-10 text-ink-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber">
          <span aria-live="polite">{navigation.index < 0 ? '当前条目不在筛选结果中' : `第 ${navigation.index + 1} / ${navigation.count} 条`} · ↑/← 上一条，↓/→ 下一条</span>
          <Button variant="secondary" size="xs" disabled={navigation.index <= 0 || editing || dirty || saving || busy || choosingImage || finishingEdit}
            onClick={() => navigation.move(-1)}>上一条</Button>
          <Button variant="secondary" size="xs" disabled={navigation.index < 0 || navigation.index >= navigation.count - 1 || editing || dirty || saving || busy || choosingImage || finishingEdit}
            onClick={() => navigation.move(1)}>下一条</Button>
        </div>}
      </header>

      {/* 主图（方案 §3.2：详情查看大图）；3.2.0 起这块也是拖拽落点 */}
      <div className="shrink-0 border-b border-ink-700 px-4 py-3">
        <div className="relative" {...drop.dropProps}>
          {image ? (
            <div className="relative rounded-lg overflow-hidden border border-ink-700 bg-ink-900" style={{ aspectRatio: '16 / 9' }}>
              <SafeImage src={image.dataUrl} alt={name} className="absolute inset-0 w-full h-full object-contain" />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-ink-700 px-3 py-5 text-center text-11 text-ink-500">
              还没有主图 —— 点下面「上传主图」选一张，或把图片直接拖到这里
            </div>
          )}
          {drop.dragging && <DropOverlay label={image ? '松开即可换成本图' : '松开即可设为主图'} />}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => { activity.current.choosing = true; setChoosingImage(true); fileRef.current?.click() }}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-11 text-ink-200 border border-ink-700 bg-ink-800 hover:border-amber/40 hover:text-amber transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <ImagePlus size={11} />}
            {image ? '换一张' : '上传主图'}
          </button>
          {image && (
            <button
              type="button"
              onClick={() => void removeImage()}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-10 text-ink-500 hover:text-danger transition-colors disabled:opacity-50"
              title="移除主图（文字内容不受影响）"
            >
              <Trash2 size={11} /> 移除
            </button>
          )}
          <span
            className="ml-auto text-10 text-ink-600 text-right leading-tight"
            title={ATLAS_IMAGE_HINT}
          >
            {image
              ? `${Math.round(image.bytes / 1024)}KB · ${image.width}×${image.height}`
              : `PNG / JPG / WebP · ≤${ATLAS_IMAGE_MAX_INPUT_BYTES / 1024 / 1024}MB · 自动缩到 ${ATLAS_IMAGE_MAX_EDGE}px`}
            <span className={`block ${usageClass}`}>
              项目图片 {atlasUsageText(projectImageBytes, imageLimit)}
            </span>
          </span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={ATLAS_IMAGE_ACCEPT}
          className="hidden"
          onChange={e => {
            activity.current.choosing = false; setChoosingImage(false)
            void pickImage(e.target.files?.[0])
            e.target.value = ''   // 允许重复选同一张（改完图再传一次是常见操作）
          }}
        />
      </div>

      <div ref={scrollRef} data-atlas-detail className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-10 text-ink-500">
            {filledCount} 项已填
          </span>
          <label className="flex items-center gap-1 text-10 text-ink-400 cursor-pointer select-none">
            <input type="checkbox" checked={showEmpty} onChange={e => setShowEmpty(e.target.checked)} />
            显示未填写字段
          </label>
        </div>
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-ink-500 py-8">
              <Table2 size={20} className="text-ink-600" />
              <span className="text-12">这条资料还没有填写内容</span>
              <span className="text-10 text-ink-600">
                {editable ? '点底部「编辑」就能在这里填' : '回表格视图填写后，这里会按分组显示'}
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {visible.map(sec => (
              <section key={sec.id}>
                <h3 className="text-11 font-semibold text-amber/90 mb-1.5 flex items-center gap-1.5">
                  <span className="w-1 h-3 bg-amber/60 rounded-full" />
                  {sec.label}
                </h3>
                <dl className="space-y-1.5">
                  {sec.fields.map(({ field, value }) => {
                    const canEdit = editing && atlasDetailEditable(field)
                    if (canEdit) {
                      return (
                        <div key={field.key} data-workspace-field={field.key}>
                          <dt className="text-11 text-ink-500 mb-0.5 flex items-center gap-1">
                            {field.label}
                            {field.unit && <span className="text-10 text-ink-600">{field.unit}</span>}
                          </dt>
                          <dd className="text-12 text-ink-200">
                            <DetailInput
                              tabId={tabId}
                              field={field}
                              value={valueOf(field.key)}
                              onChange={v => onCellChange?.(field.key, v)}
                            />
                          </dd>
                        </div>
                      )
                    }
                    // 长内容（长文本 / 说明性字段）单独成块，短值左右并排 —— 与表格里的观感一致
                    const isLong = value.length > 40 || field.builtinType === 'textarea' || field.customType === 'longText'
                    /** 编辑态下没能改的字段，说清楚为什么 —— 否则作者会以为"这里坏了" */
                    const lockedHint = editing && editable && !atlasDetailEditable(field)
                      ? '这类字段（编号 / 引用 / 日期）请在表格里改'
                      : undefined
                    return (
                      <div key={field.key} data-workspace-field={field.key} className={isLong ? '' : 'flex gap-2 items-baseline'} title={lockedHint}>
                        <dt className={`text-11 text-ink-500 ${isLong ? 'mb-0.5' : 'shrink-0 w-20'} ${lockedHint ? 'opacity-70' : ''}`}>
                          {field.label}
                          {lockedHint && <span className="ml-1 text-9 text-ink-600">表格</span>}
                        </dt>
                        <dd className="text-12 text-ink-200 leading-relaxed whitespace-pre-wrap break-words">
                          {value || <span className="text-ink-600">—</span>}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              </section>
            ))}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-ink-700 px-4 py-2.5 flex items-center justify-between gap-2">
        <span className="text-10 text-ink-500 min-w-0 truncate">
          {editing
            ? (dirty ? '有未保存改动 · 存进表格同一份草稿' : '改哪栏写哪栏，不会覆盖别的字段')
            : '浏览模式 · 点「编辑」可就地修改'}
        </span>
        <div className="shrink-0 flex items-center gap-1.5">
          {editing ? (
            <>
              <Button variant="secondary" size="xs" onClick={cancelEdit} disabled={saving || finishingEdit} title="撤销本次在详情里做的改动">
                <Undo2 size={11} /> 撤销
              </Button>
              <Button
                variant="primary"
                solid
                size="xs"
                onClick={() => void finishEdit()}
                disabled={saving || finishingEdit}
                title="保存并退出编辑（与表格底部「保存」是同一个动作）"
              >
                {saving || finishingEdit ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                保存
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="xs" onClick={onEditInTable}>
                <Table2 size={11} /> 在表格中编辑
              </Button>
              {editable && (
                <Button variant="primary" solid size="xs" onClick={startEdit} title="在这里直接改这条资料">
                  编辑
                </Button>
              )}
            </>
          )}
        </div>
      </footer>
    </aside>
  )
}

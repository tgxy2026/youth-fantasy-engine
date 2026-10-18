/**
 * 图鉴详情（3.1.3 · 骨架版）。
 *
 * 依据：方案 §3.2「详情默认浏览，点击编辑进入表单；编辑内容沿用共享草稿机制」。
 *
 * 🔴 本轮是**只读预览**：编辑仍回表格（底栏按钮切回表格视图）。
 *    这样做的理由 —— 详情里直接编辑就必须接进 `useTableSheetModel` 的 `drafts/saveAll`
 *    那套共享草稿，否则会多出「与表格脱节的第二份资料」，而方案明令禁止。
 *    等 F3（数据流接入）把共享草稿打通后再开放就地编辑。
 */
import { useRef, useState } from 'react'
import { ArrowLeft, ImagePlus, Loader2, Table2, Trash2 } from 'lucide-react'
import type { TableRow } from '@/lib/types'
import { atlasDisplayValue } from '@/lib/atlas/schema'
import type { AtlasImage, AtlasResolvedSection } from '@/lib/atlas/types'
import { ATLAS_IMAGE_ACCEPT, readAtlasImage } from '@/lib/atlas/image'
import { ATLAS_TOTAL_LIMIT, atlasUsageRatio, atlasUsageText, checkAtlasBudget } from '@/lib/atlas/quota'
import { showToast } from '@/components/dialogs/dialogs'

interface Props {
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
  /** 项目图鉴图片已用字节（races + items 合计），用于容量提示与硬闸 */
  projectImageBytes?: number
  /** 项目图片总上限；`Infinity` = 本机存储不限（桌面 / 便携 / 游客网页版）。默认按云端档位保守处理 */
  imageLimit?: number
  /** 窄屏：详情占满主体，头部显示「返回」 */
  overlay: boolean
  onClose: () => void
  onEditInTable: () => void
}

export default function AtlasDetail({ row, nameKey, badges, sections, image, onImageChange, projectImageBytes = 0, imageLimit = ATLAS_TOTAL_LIMIT, overlay, onClose, onEditInTable }: Props) {
  const name = (row.data[nameKey] ?? '').trim() || '未命名条目'
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 上传 / 移除的**串行链**（3.1.3 · R10）。
   * 作者手快连点两次"换一张"时，两次落库若并发跑，后写者可能用旧行覆盖前者的图 ⇒
   * 界面显示的与库里的不是同一张。串起来之后顺序即结果。
   */
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())

  /** 落库并**等它真的写完**再提示；失败保留原图并如实报错（不谎报成功、不静默吞错） */
  const commitImage = async (next: AtlasImage | null) => {
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
      setBusy(false)
    }
  }

  /** 选图 → 压缩 → 容量检查 → 交给父组件落库。失败原因直接展示给作者（不吞错、不写半成品） */
  const pickImage = async (file: File | undefined) => {
    if (!file) return
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
      setBusy(false)
    }
  }

  /** 移除主图：同样要等落库（移除失败时图还在，不能先说"已移除"） */
  const removeImage = async () => {
    if (await commitImage(null)) showToast('已移除主图（文字内容不受影响）')
  }

  /** 容量提示的成色：≥80% 琥珀、超限红（和方案 §6.2 的提示口径一致） */
  const usageRatio = atlasUsageRatio(projectImageBytes, imageLimit)
  const usageClass = usageRatio >= 1 ? 'text-danger' : usageRatio >= 0.8 ? 'text-amber' : 'text-ink-600'
  /**
   * 「显示未填写字段」（方案 §3.2）：默认收起未填的，减少噪音；要补全时打开它，
   * 空字段用灰色「—」占位 —— 作者能看到"这里还有一栏没写"，而不是以为字段消失了。
   */
  const [showEmpty, setShowEmpty] = useState(false)

  // 空分组不渲染（方案 §3.2：字段数为零时不出现空分组）；未填字段按开关决定去留
  const visible = sections
    .map(sec => ({
      ...sec,
      fields: sec.fields
        .map(f => ({ field: f, value: atlasDisplayValue(f, row.data[f.key]) }))
        .filter(x => showEmpty || x.value.length > 0),
    }))
    .filter(sec => sec.fields.length > 0)
  /** 已填项数（与上面的开关无关 —— 开关只决定"空字段要不要显示"） */
  const filledCount = sections.reduce(
    (n, sec) => n + sec.fields.filter(f => atlasDisplayValue(f, row.data[f.key]).length > 0).length,
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
            type="button"
            onClick={onClose}
            className="shrink-0 flex items-center gap-1 text-11 text-ink-400 hover:text-ink-100 px-2 py-1 rounded-lg border border-ink-700 hover:border-ink-600 transition-colors"
            title={overlay ? '返回图鉴列表' : '关闭详情'}
          >
            {overlay && <ArrowLeft size={12} />}
            {overlay ? '返回' : '关闭'}
          </button>
        </div>
      </header>

      {/* 主图（方案 §3.2：详情查看大图）*/}
      <div className="shrink-0 border-b border-ink-700 px-4 py-3">
        {image ? (
          <div className="relative rounded-lg overflow-hidden border border-ink-700 bg-ink-900" style={{ aspectRatio: '16 / 9' }}>
            <img src={image.dataUrl} alt={name} className="absolute inset-0 w-full h-full object-contain" />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-ink-700 px-3 py-5 text-center text-11 text-ink-500">
            还没有主图 —— 点下面「上传主图」选一张
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
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
          <span className="ml-auto text-10 text-ink-600 text-right leading-tight">
            {image
              ? `${Math.round(image.bytes / 1024)}KB · ${image.width}×${image.height}`
              : 'PNG / JPG / WebP · ≤8MB · 自动缩到 1024px'}
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
            void pickImage(e.target.files?.[0])
            e.target.value = ''   // 允许重复选同一张（改完图再传一次是常见操作）
          }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
              <span className="text-10 text-ink-600">回表格视图填写后，这里会按分组显示</span>
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
                    // 长内容（长文本 / 说明性字段）单独成块，短值左右并排 —— 与表格里的观感一致
                    const isLong = value.length > 40 || field.builtinType === 'textarea' || field.customType === 'longText'
                    return (
                      <div key={field.key} className={isLong ? '' : 'flex gap-2 items-baseline'}>
                        <dt className={`text-11 text-ink-500 ${isLong ? 'mb-0.5' : 'shrink-0 w-20'}`}>
                          {field.label}
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
        <span className="text-10 text-ink-500">只读预览 · 编辑回表格（共用同一份草稿与保存）</span>
        <button
          type="button"
          onClick={onEditInTable}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-11 text-ink-200 border border-ink-700 bg-ink-800 hover:border-amber/40 hover:text-amber transition-colors"
        >
          <Table2 size={11} /> 在表格中编辑
        </button>
      </footer>
    </aside>
  )
}

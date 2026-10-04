import { useEffect, useState } from 'react'
import { useSaveHotkey } from '../lib/useSaveHotkey'
import { UNSAVED_CHANGES_HINT } from '../lib/constants'
import { Database, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import NumberField from './NumberField'
import {
  DEFAULT_WRITER_BASE, WRITER_BASE_LIMITS, WRITER_RECOMMEND, getWriterBudget, saveWriterBudget, previewAt,
  currentModelAdvice, budgetForKind,
} from '../lib/aiWriterBudget'

interface Props {
  /**
   * 由父级在「模型配置发生变动」时 +1（InspireTools 的 cfgVer）。
   * 🔴 换模型后本面板的推荐值必须跟着重算 —— 不传它就会停在挂载时那份快照上（看起来像"额度没跟着模型走"）。
   */
  refreshKey?: number
}

/**
 * 「正文写作 AI 额度」面板 —— 紧贴在**模型配置**下方。
 *
 * 为什么放这儿：额度该跟着模型走，配模型时就该顺手一起调（放别处作者根本想不起来）。
 *
 * 🔴 与酒馆模式的额度**互不冲突**（面板底部有明确提示，别删）：那边是「控制面板」里的
 *    `contextBudget` / `numCtx` + 记忆档，管的是角色扮演那一整条链路；
 *    这里只影响编辑器 / 颉文姬 / 检查工具 / 灵感工具这些**正文写作**的 AI 功能。
 */
export default function AIWriterBudgetPanel({ refreshKey = 0 }: Props) {
  const [base, setBase] = useState(DEFAULT_WRITER_BASE)
  const [draft, setDraft] = useState<number>(DEFAULT_WRITER_BASE)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [rec, setRec] = useState<number | null>(null)
  const [modelDesc, setModelDesc] = useState('')
  const [localModel, setLocalModel] = useState(true)
  const [autoTune, setAutoTune] = useState(true)
  const [tunedFor, setTunedFor] = useState<string | undefined>(undefined)

  useEffect(() => {
    // 🔴 竞态守卫：连点切换会并发起两次读取，**乱序返回**会把旧值盖回去
    //    （表现同样是"填进去的数跟推荐值对不上"）。只有最后一次发起的作数。
    let cancelled = false
    void (async () => {
      const st = await getWriterBudget()
      // 与「自动跟随」共用同一口径（currentModelAdvice）—— 免得面板显示的推荐值与实际套用的值算得不一样
      const info = await currentModelAdvice()
      if (cancelled) return
      // 🔴 读完**一起** setState：base 与 rec 必须来自同一次快照，分两次写会出现"旧基准 + 新推荐"的错位
      setBase(st.base)
      setDraft(st.base)
      setAutoTune(st.autoTuneByModel !== false)
      setTunedFor(st.tunedFor)
      if (info) {
        setRec(info.recommended)
        setModelDesc(info.cap.headline)
        setLocalModel(info.cap.local)
      }
    })()
    return () => { cancelled = true }
  }, [refreshKey])

  const commit = async (v: number) => {
    setSaving(true)
    try {
      // 带上 tunedFor：它是"上次给哪个模型套用过"的记录，清掉会让下次同步重新登记（无害但没必要）
      const out = await saveWriterBudget({ base: v, autoTuneByModel: autoTune, tunedFor })
      setBase(out.base)
      setDraft(out.base)
      setTunedFor(out.tunedFor)
      showToast(`正文写作额度已保存：基准 ${out.base} 字`, 'success')
    } catch (e) {
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setSaving(false) }
  }

  /** 开关是"行为开关"，立即落库（不跟基准一起等「保存」）—— 语义更清楚，也不必记草稿 */
  const toggleAutoTune = async (v: boolean) => {
    setAutoTune(v)
    setSaving(true)
    try {
      const out = await saveWriterBudget({ base, autoTuneByModel: v, tunedFor })
      setTunedFor(out.tunedFor)
      showToast(v ? '已开启：换模型时自动套用推荐额度' : '已关闭：额度完全手工设置', 'success')
    } catch (e) {
      setAutoTune(!v) // 回滚开关，别让界面显示与实际设置不一致
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setSaving(false) }
  }

  // 数值由 NumberField 保证落在 [min, max]（超范围在失焦时钳回最近的边界），这里不必再自校验
  const dirty = draft !== base
  const preview = previewAt(draft)

  // Ctrl/Cmd+S 保存额度设置（2.7.3 补）
  useSaveHotkey(() => void commit(draft), dirty && !saving)

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
      <div className="flex items-center gap-2">
        <Database size={14} className="shrink-0 text-amber" />
        <h2 className="text-13 font-semibold text-ink-100">正文写作 AI 额度</h2>
        <HelpPopover title="正文写作 AI 额度怎么用" width="23rem" size={12}>
          {`编辑器、颉文姬、检查工具、灵感工具这些「正文写作」的 AI 功能，以及设定表格的「AI 整理 / 批量导入」，会把项目里的设定资料一并发给模型做参照。
这个「基准」就是它们带多少资料的「总闸门」 —— 各功能按自己的系数取用（点下面「看各功能实际取值」有明细）。

· 调大：模型看到的设定更全，但更费 token / 更慢（云端按量计费时更贵）。
· 调小：省 token、更快，适合短篇或只想让它改文字不想让它管设定的时候。
· 基准会跟着当前模型给推荐值：云端按可用额度、本地按窗口大小折算，两边比例一致 —— 窗口大就给得多，窗口小就同步变小。

⚠️ 酒馆模式（剧情推演 / 自由对话）的上下文额度「不在这里」 —— 在「酒馆模式 → 控制面板」单独设置，
那边还有记忆档、设定层占比等一整套。两边各管各的、「互不冲突」。`}
        </HelpPopover>
        <div className="flex-1" />
        {dirty && <span className="text-11 text-amber">{UNSAVED_CHANGES_HINT}</span>}
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void commit(draft)}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>

      <p className="mt-1 text-11 text-ink-500 leading-relaxed">
        正文写作链路各 AI 功能「带多少项目设定资料」的总闸门。出厂基准 {DEFAULT_WRITER_BASE} 字 ——
        不动它时行为与以前完全一致。
      </p>

      {modelDesc && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          <div className="text-11 text-ink-200">{modelDesc}</div>
          <div className="mt-0.5 text-10 text-ink-500">
            {/* 🔴 数字一律从 WRITER_RECOMMEND 插值，禁写字面量（2026-09-22 六维审计 P1）——
                原先这里硬编码「30%、48000」，而该比例已被调过一次（注释载 2026-09-18 放宽到 30% 档），
                两处各写一份必然漂移：界面显示旧数字、实际换算已变，作者按说明估算占比就算错。
                云端分支原先还省略了比例与上限，与本地分支信息量不对称，这里一并补齐。 */}
            {rec != null
              ? (localModel
                ? `本地模型：随窗口按比例放大（推荐 ${rec} 字，资料取窗口的 ${Math.round(WRITER_RECOMMEND.local.ratio * 100)}%，其余留给正文与输出；窗口填得越大给得越多）`
                : `云端模型：按窗口放大（推荐 ${rec} 字，资料取该窗口可用额度的 ${Math.round(WRITER_RECOMMEND.cloud.ratio * 100)}%）`)
              : '未识别到当前模型'}
            {rec != null && rec !== base && <> · 当前为 {base} 字</>}
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-12 text-ink-300 cursor-pointer select-none">
          <input type="checkbox" checked={autoTune} disabled={saving}
            onChange={e => void toggleAutoTune(e.target.checked)} className="accent-amber" />
          额度跟随模型自动调整
        </label>
        <HelpPopover title="额度跟随模型自动调整" width="21rem" size={12}>
          {`开启后：「换模型时」自动把基准套用成新模型的推荐值 —— 云端大窗口模型会自动多带资料；本地模型按窗口放大，窗口小就给得少，别把正文挤没了。

⚠️ 只在「换模型」时生效 —— 换完「直接写进上面的基准并自动保存」，不用再点一下；
同一个模型下你手调的基准「不会被改回去」（想完全手工就关掉这个开关，
面板上仍可随时点「采用推荐值」手动套一次）。`}
        </HelpPopover>
        {!autoTune && <span className="text-10 text-ink-500">（当前为手工模式，换模型不会自动改）</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-12 text-ink-300">资料预算基准</label>
        <NumberField
          value={draft}
          min={WRITER_BASE_LIMITS.min}
          max={WRITER_BASE_LIMITS.max}
          step={WRITER_BASE_LIMITS.step}
          onChange={v => setDraft(v ?? base)}
          onClamped={(v, dir) => showToast(`资料预算已调回${dir === 'max' ? '上限' : '下限'} ${v} 字`, 'info')}
          className="w-28 rounded bg-ink-900 border border-ink-700 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50"
        />
        <span className="text-11 text-ink-500">字（{WRITER_BASE_LIMITS.min} ~ {WRITER_BASE_LIMITS.max}）</span>
        {rec != null && rec !== base && (
          <Button variant="secondary" size="sm" className="inline-flex items-center gap-1"
            onClick={() => setDraft(rec)} title={`按当前模型采用推荐值 ${rec} 字`}>
            <RotateCcw size={11} />采用推荐值（{rec}）
          </Button>
        )}
        {base !== DEFAULT_WRITER_BASE && (
          <Button variant="secondary" size="sm" onClick={() => setDraft(DEFAULT_WRITER_BASE)}>
            恢复出厂（{DEFAULT_WRITER_BASE}）
          </Button>
        )}
      </div>

      <div className="mt-3">
        <Button variant="bare" size="xs"
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1 px-1 py-px rounded text-11 text-ink-400 hover:text-amber hover:bg-ink-700/60 transition-colors">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {open ? '收起明细' : `看各功能实际取值（${preview.length} 项）`}
        </Button>
        {open && (
          <>
            <div className="mt-1.5 text-10 text-ink-500">
              按当前基准 {draft} 字换算
              {rec != null && rec !== draft && <> · <span className="text-amber/90">→ 为推荐基准 {rec} 字下的值</span></>}
            </div>
            <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {preview.map(x => {
                const recVal = rec != null ? budgetForKind(x.kind, rec) : null
                return (
                  <li key={x.kind} className="flex items-baseline gap-1.5 text-11">
                    <span className="text-ink-400 truncate">{x.label}</span>
                    <span className="flex-1 border-b border-dotted border-ink-700/70" />
                    <span className="text-ink-200 tabular-nums">{x.value}</span>
                    {recVal != null && recVal !== x.value && (
                      <span className="text-amber/90 tabular-nums" title={`按当前模型推荐值 ${rec} 字换算`}>→{recVal}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      {/* 🔴 必须保留：这是作者最容易混淆的一点（酒馆的额度在别处，两边不冲突） */}
      <div className="mt-3 border-t border-ink-700/70 pt-2 text-10 text-ink-500 leading-relaxed">
        这里的额度只作用于<b className="text-ink-400">正文写作链路</b>（编辑器 / 颉文姬 / 检查工具 / 灵感工具），
        以及<b className="text-ink-400">设定表格的 AI 整理 / 批量导入</b>（这两件事的「看各功能实际取值」里本就列着）。
        酒馆模式（剧情推演 / 自由对话）的上下文额度在<b className="text-ink-400">「酒馆模式 → 控制面板」</b>里单独设置，
        那边还有记忆档、设定层占比等一整套 —— <b className="text-ink-400">两边各管各的、互不冲突</b>。
      </div>
    </section>
  )
}

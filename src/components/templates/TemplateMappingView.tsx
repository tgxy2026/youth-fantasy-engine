/**
 * 3.2.0 · WT2：「兼容现有 AI」—— 语义用途映射的检查与确认。
 *
 * 方案 §3.10.2 要求作者看得到「每项功能采用哪些字段、可修复映射、仅缺哪些精确子项」。
 * 本组件只做三件事：
 *   ① 把 `buildMappingPlan` 的结论翻译成作者能判断的一行行（来源 / 歧义 / 缺失）；
 *   ② 允许指定字段、保留现有用途（自动匹配）、或明确「仅作为补充资料」；
 *   ③ 保存走 `saveDeclaredBindings` —— 只写模板的 `bindings`，不搬值、不重算语义摘要。
 *
 * 🔴 预览用的是**当前选择**（草稿），不是已保存的绑定：
 *    作者每改一项都要立刻看到「这样确认之后，自动写回会落到哪一栏」。
 * 🔴 没有采用模板时只展示建议、不允许保存：确认结果必须挂在某个模板版本上，
 *    否则换模板后这份「确认」会指向一份不存在的结构。
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Link2, Unlink } from 'lucide-react'
import type { TabDef } from '@/lib/types'
import type { TemplateDef } from '@/lib/templates/definition'
import type { EffectiveTemplate, EffectiveField } from '@/lib/templates/types'
import type { DeclaredBindings } from '@/lib/templates/mappingPlan'
import { bindingOf, buildMappingPlan } from '@/lib/templates/mappingPlan'
import { slotsForTab } from '@/lib/templates/semanticSlots'
import { canonicalBindingText, saveDeclaredBindings } from '@/lib/templates/mappingConfirm'
import { canSemanticWrite } from '@/lib/templates/fieldPolicy'
import { getCurrentProjectId } from '@/lib/db'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'

const AUTO = '__auto__'
const NONE = '__none__'
/** 已声明绑定多个字段（多字段合成用途）：本界面不拆开它，原样保留到下次保存 */
const MULTI = '__multi__'
type Choice = string

const SELECT = 'w-full text-11 px-2 py-1 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50 disabled:opacity-60'

interface Props {
  tab: TabDef
  /** 已采用的模板快照；null = 仍在用内置结构（只展示建议） */
  def: TemplateDef | null
  /** 用于映射的完整模板视图（含所有未归档字段，不受展示开关影响） */
  template: EffectiveTemplate
  onSaved: () => void
}

function choicesOf(
  def: TemplateDef | null,
  slots: readonly { slot: string }[],
  fieldById: Map<string, EffectiveField>,
): Record<string, Choice> {
  const out: Record<string, Choice> = {}
  for (const d of slots) {
    const ids = def?.bindings?.[d.slot]
    if (!Array.isArray(ids)) {
      out[d.slot] = AUTO
      continue
    }
    const first = ids[0]
    if (ids.length > 1) {
      out[d.slot] = MULTI
      continue
    }
    out[d.slot] = first && fieldById.has(first) ? first : NONE
  }
  return out
}

export default function TemplateMappingView({ tab, def, template, onSaved }: Props) {
  const slots = useMemo(() => slotsForTab(tab.id), [tab.id])
  const fieldById = useMemo(() => new Map(template.fields.map(f => [f.id, f])), [template])
  /** 已归档字段也要能显示为「原绑定已失效」，所以另存一份全量字段名 */
  const allFields = useMemo(
    () => new Map((def?.fields ?? []).map(f => [f.id, f])),
    [def],
  )
  const [choices, setChoices] = useState<Record<string, Choice>>(
    () => choicesOf(def, slots, allFields),
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<boolean | null>(null)

  const draftBindings = useMemo<DeclaredBindings>(() => {
    const out: DeclaredBindings = {}
    for (const d of slots) {
      const c = choices[d.slot] ?? AUTO
      if (c === AUTO) continue
      if (c === MULTI) {
        const ids = def?.bindings?.[d.slot]
        // 原样保留多字段声明：本界面不提供拆分，但保存时也不许悄悄收成一个
        if (Array.isArray(ids) && ids.length > 1) out[d.slot] = [...ids]
        continue
      }
      out[d.slot] = c === NONE ? [] : [c]
    }
    return out
  }, [choices, slots, def])

  /** 预览必须基于草稿：改一项就要看到写回落点怎么变 */
  const plan = useMemo(
    () => buildMappingPlan(template, slots, draftBindings),
    [template, slots, draftBindings],
  )

  const ambiguous = plan.unmapped.filter(u => u.reason === 'ambiguous').length
  const missing = plan.unmapped.filter(u => u.reason === 'no-field').length
  const declined = plan.unmapped.filter(u => u.reason === 'declined').length
  const writable = plan.bindings.filter(b => b.fieldIds.length === 1).length
  const dirty = canonicalBindingText(draftBindings) !== canonicalBindingText(def?.bindings)
  const expanded = open ?? ambiguous > 0

  if (!slots.length) {
    return (
      <section className="rounded-xl border border-ink-700 bg-ink-800/40 px-3.5 py-3">
        <h3 className="text-12 font-semibold text-ink-200">兼容现有 AI</h3>
        <p className="mt-1 text-11 text-ink-400 leading-relaxed">
          此页签不属于人物 / 势力 / 地理 / 种族 / 物品 / 术语，没有旧引擎的语义用途，不参与映射。
        </p>
      </section>
    )
  }

  const reset = () => {
    setChoices(choicesOf(def, slots, allFields))
    setErr('')
  }

  const save = async () => {
    if (!def) return
    setBusy(true)
    setErr('')
    try {
      const r = await saveDeclaredBindings(getCurrentProjectId(), tab.id, draftBindings)
      if (!r.ok) {
        setErr(r.detail)
        return
      }
      if (r.dropped.length) {
        showToast(`已保存；${r.dropped.length} 项绑定因字段已不存在或已归档被清除`, 'error', 6000)
      } else {
        showToast(r.changed ? '用途映射已保存（随项目备份 / 同步）' : '映射没有变化', 'success')
      }
      if (r.changed) onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-800/40">
      <div className="px-3.5 py-3 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-1.5">
            <Link2 size={12} className="text-info" /> 兼容现有 AI
          </h3>
          <span className="text-10 text-ink-500">
            {writable} 个用途可自动写回
            {ambiguous > 0 && <span className="text-danger"> · {ambiguous} 项语义重复待指定</span>}
            {missing > 0 && <span className="text-amber"> · {missing} 项暂无对应字段</span>}
            {declined > 0 && <span className="text-ink-400"> · {declined} 项仅作补充资料</span>}
          </span>
          <Button
            variant="bare"
            size="xs"
            className="ml-auto text-ink-400"
            onClick={() => setOpen(!expanded)}
          >
            {expanded ? '收起逐项映射' : '展开逐项映射'}
          </Button>
        </div>
        <p className="text-10 text-ink-500 leading-relaxed">
          拆书 / 设定补登等旧功能按这些用途写回。映射先看存储键、再看显示名；
          {def
            ? '确认结果随这份模板保存，改名不需要重新确认。'
            : '当前沿用内置结构，采用模板后才能保存确认。'}
        </p>
      </div>

      {expanded && (
        <ul className="divide-y divide-ink-700 border-t border-ink-700">
          {slots.map(d => {
            const choice = choices[d.slot] ?? AUTO
            const selected = fieldById.get(choice)
            const stale = choice !== AUTO && choice !== NONE && choice !== MULTI && !selected
            const staleName = stale ? allFields.get(choice)?.label : undefined
            const b = bindingOf(plan, d.slot)
            const u = plan.unmapped.find(x => x.slot === d.slot)
            const bound = (b?.fieldIds ?? []).map(id => fieldById.get(id)?.label ?? allFields.get(id)?.label ?? id)
            const multiDeclared = b?.origin === 'declared' && b.fieldIds.length > 1
            const origin = b?.origin === 'declared' ? '作者指定' : b?.origin === 'alias' ? '显示名匹配' : '存储键匹配'
            const how = b?.fieldIds.length === 1 ? origin : multiDeclared ? '多字段合成' : '语义重复'
            return (
              <li key={d.slot} className="px-3.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-12 text-ink-100">{d.label}</span>
                  <span className="text-10 text-ink-600">{d.slot}</span>
                  <span className="ml-auto text-10 text-ink-400">
                    {bound.length > 0 ? (
                      <>
                        → <span className="text-ink-200">{bound.join('、')}</span>
                        <span className={`ml-1 ${b?.fieldIds.length === 1 || multiDeclared ? 'text-ink-500' : 'text-danger'}`}>
                          （{how}）
                        </span>
                      </>
                    ) : u?.reason === 'declined' ? (
                      <span className="text-ink-500">仅作为补充资料</span>
                    ) : (
                      <span className="text-amber">暂无对应字段</span>
                    )}
                  </span>
                </div>

                <div className="mt-1.5">
                  <select
                    className={SELECT}
                    value={choice}
                    disabled={!def || busy}
                    onChange={e => setChoices(c => ({ ...c, [d.slot]: e.target.value }))}
                  >
                    <option value={AUTO}>自动匹配（存储键 → 显示名）</option>
                    <option value={NONE}>不绑定，仅作为补充资料</option>
                    {choice === MULTI && (
                      <option value={MULTI} disabled>
                        已声明绑定 {def?.bindings?.[d.slot]?.length ?? 0} 个字段（保持现状；选其他项即改为单字段）
                      </option>
                    )}
                    {stale && (
                      <option value={choice} disabled>
                        {staleName ?? choice}（已归档 / 已不在模板中）
                      </option>
                    )}
                    {template.fields.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.label}{f.source === 'custom' ? ' · 自定义' : ''}{canSemanticWrite(f) ? '' : ' · 只读'}
                      </option>
                    ))}
                  </select>
                </div>

                {stale && (
                  <p className="mt-1 text-10 text-danger leading-relaxed flex items-start gap-1">
                    <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                    原绑定字段已归档或不在模板中；保存后会改为「不绑定」，不会回落到同名字段。
                  </p>
                )}
                {selected && !canSemanticWrite(selected) && (
                  <p className="mt-1 text-10 text-amber leading-relaxed">
                    「{selected.label}」未开放 AI 写入：可用于阅读，但自动写回会被拒绝。
                  </p>
                )}
                {selected && selected.appliesTo !== '*' && (
                  <p className="mt-1 text-10 text-ink-400 leading-relaxed">
                    「{selected.label}」仅适用于 {selected.appliesTo.join('、')}；写回需要条目类别已知，否则不写。
                  </p>
                )}
                {u?.reason === 'ambiguous' && !selected && (
                  <p className="mt-1 text-10 text-danger leading-relaxed">
                    有 {u.candidateIds?.length ?? 2} 个字段都能当「{d.label}」，自动写回会拒绝；请指定一个。
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {plan.sharedFields.length > 0 && (
        <p className="px-3.5 py-2 border-t border-ink-700 text-10 text-ink-500 leading-relaxed">
          同一字段被多个用途共用（如「身份定位」同时是一句话描述与身份定位）：
          同一次写回里两个用途给出不同值时，后一个会被拒绝，不会静默覆盖。
        </p>
      )}

      {err && <div className="px-3.5 pb-2 text-11 text-danger whitespace-pre-line">{err}</div>}

      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 border-t border-ink-700">
        <Button
          variant="primary"
          solid
          size="sm"
          disabled={!def || !dirty || busy}
          onClick={() => void save()}
          className="flex items-center gap-1.5"
          title={def ? '只保存用途映射，不迁移任何值' : '先采用模板'}
        >
          {busy ? '保存中…' : <><Check size={12} /> 保存映射</>}
        </Button>
        <Button variant="secondary" size="sm" disabled={!dirty || busy} onClick={reset} className="flex items-center gap-1.5">
          <Unlink size={12} /> 撤销改动
        </Button>
        <span className="text-10 text-ink-500">
          只影响旧引擎的读写落点；字段名称 / 权限仍走模板编辑。
        </span>
      </div>
    </section>
  )
}

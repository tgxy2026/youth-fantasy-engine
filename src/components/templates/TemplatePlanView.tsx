/**
 * 模板变更计划的只读展示（3.2.0 · T1）。
 *
 * 🔴 这里只“翻译” `planTemplateChange` 的结论，不重新判定任何事：
 *    阻断项 / 提示项 / 值处置全部原样呈现，避免界面与执行层各说一套。
 */
import { AlertTriangle, ArrowRight, Ban, CircleAlert, GitCompareArrows } from 'lucide-react'
import type {
  FieldChange, FieldPlanItem, TemplateChangePlan, ValuePlan,
} from '@/lib/templates/plan'
import type { TemplateDef } from '@/lib/templates/definition'

const DISPOSITION_LABEL: Record<FieldPlanItem['disposition'], string> = {
  kept: '保留',
  'kept-modified': '有改动',
  added: '新增',
  archived: '归档',
  'suggested-map': '同名待确认',
}

const VALUE_PLAN_LABEL: Record<ValuePlan, string> = {
  keep: '旧值有效',
  'stale-flag': '旧值保留 · 标记待整理',
  convert: '自动转换',
  manual: '需人工处理',
  'archive-keep': '归档保留',
}

const ASPECT_LABEL: Record<FieldChange['aspect'], string> = {
  label: '显示名',
  type: '类型',
  options: '选项',
  permissions: '权限',
  appliesTo: '适用类别',
  unit: '单位',
  description: '说明',
  group: '分组',
  archived: '归档',
  fixedOptions: '选项锁定',
}

const WARNING_LABEL: Record<string, string> = {
  'same-label-suggestion': '同名建议',
  'ai-write-tightened': 'AI 填写收紧',
  'ai-write-opened': 'AI 填写放开',
  'ai-read-tightened': 'AI 参考收紧',
  'value-needs-conversion': '需要类型转换',
  'options-shrunk': '选项变少',
  'type-changed': '字段改义',
  'capability-tightened': '能力收紧',
  'semantic-digest-changed': '语义摘要变化',
}

function labelOf(def: TemplateDef | null, id: string | undefined): string {
  if (!id) return '—'
  return def?.fields.find(f => f.id === id)?.label ?? id
}

function dispositionTone(d: FieldPlanItem['disposition']): string {
  switch (d) {
    case 'kept': return 'border-ink-700 bg-ink-800/60 text-ink-300'
    case 'kept-modified': return 'border-amber/30 bg-amber/10 text-amber'
    case 'added': return 'border-success/30 bg-success/10 text-success'
    case 'archived': return 'border-ink-700 bg-ink-900 text-ink-400'
    case 'suggested-map': return 'border-info/30 bg-info/10 text-info'
  }
}

interface Props {
  plan: TemplateChangePlan
  from: TemplateDef | null
  to: TemplateDef
  /** 已勾选确认的同名映射（旧字段 id → 新字段 id） */
  approvedMaps: Record<string, string>
  onToggleMap: (fromId: string, toId: string, checked: boolean) => void
  /** 只读模式（预览旧计划时用） */
  readOnly?: boolean
}

export default function TemplatePlanView({ plan, from, to, approvedMaps, onToggleMap, readOnly }: Props) {
  const s = plan.summary
  return (
    <div className="space-y-3">
      {/* 规模与结论 */}
      <div className="rounded-xl border border-ink-700 bg-ink-800/50 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-12">
          <span className="text-ink-200 font-medium flex items-center gap-1.5">
            <GitCompareArrows size={13} className="text-amber" />变更概要
          </span>
          <span className="text-ink-400">保留 <b className="text-ink-200">{s.kept}</b></span>
          <span className="text-ink-400">改动 <b className="text-amber">{s.modified}</b></span>
          <span className="text-ink-400">新增 <b className="text-success">{s.added}</b></span>
          <span className="text-ink-400">归档 <b className="text-ink-300">{s.archived}</b></span>
          <span className="text-ink-400">同名建议 <b className="text-info">{s.suggestedMaps}</b></span>
        </div>
        <p className="mt-1.5 text-11 text-ink-400 leading-relaxed">
          {plan.valueScaleKnown
            ? `影响 ${plan.affectedFieldCount} 个字段、约 ${plan.affectedValueCount} 条已填内容；归档字段的值原地保留，不会删除。`
            : '值规模未知（尚未统计）；归档字段的值仍会原地保留，不会删除。'}
        </p>
      </div>

      {/* 阻断 */}
      {plan.blockers.length > 0 && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-12 font-medium text-danger">
            <Ban size={13} />有 {plan.blockers.length} 项必须先处理（暂不能采用）
          </div>
          <ul className="mt-1.5 space-y-1">
            {plan.blockers.map((b, i) => (
              <li key={`${b.code}-${i}`} className="text-11 text-ink-200 leading-relaxed">
                · {b.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 提示 */}
      {plan.warnings.length > 0 && (
        <div className="rounded-xl border border-amber/30 bg-amber/5 px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-12 font-medium text-amber">
            <CircleAlert size={13} />有 {plan.warnings.length} 项需要知情（不阻断）
          </div>
          <ul className="mt-1.5 space-y-1">
            {plan.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="text-11 text-ink-300 leading-relaxed">
                <span className="text-amber/80">[{WARNING_LABEL[w.code] ?? w.code}]</span> {w.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 字段逐项 */}
      <div className="rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-3.5 py-2 border-b border-ink-700 bg-ink-800/60 text-11 text-ink-400">
          逐字段处置（{plan.items.length} 项）
        </div>
        <ul className="divide-y divide-ink-700 max-h-72 overflow-y-auto">
          {plan.items.map((it, i) => {
            const fromLabel = labelOf(from, it.fromId)
            const toLabel = labelOf(to, it.toId)
            return (
              <li key={`${it.fromId ?? 'new'}-${it.toId ?? 'gone'}-${i}`} className="px-3.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`shrink-0 text-10 px-1.5 py-0.5 rounded border ${dispositionTone(it.disposition)}`}>
                    {DISPOSITION_LABEL[it.disposition]}
                  </span>
                  <span className="text-12 text-ink-200 truncate">
                    {it.disposition === 'added'
                      ? toLabel
                      : it.disposition === 'suggested-map'
                        ? `${fromLabel} → ${labelOf(to, it.suggestedTargetId)}`
                        : fromLabel}
                  </span>
                  {it.toId && it.fromId && it.toId !== it.fromId && (
                    <span className="text-10 text-ink-500">（{labelOf(to, it.toId)}）</span>
                  )}
                  <span className="ml-auto text-10 text-ink-500">{VALUE_PLAN_LABEL[it.valuePlan]}</span>
                </div>
                {it.changes.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-10 text-ink-500">
                    {it.changes.map((c, j) => (
                      <span key={j} className="inline-flex items-center gap-1">
                        {ASPECT_LABEL[c.aspect]}：
                        <span className="text-ink-400 line-through">{c.from}</span>
                        <ArrowRight size={9} />
                        <span className="text-ink-300">{c.to}</span>
                      </span>
                    ))}
                  </div>
                )}
                {it.note && <p className="mt-1 text-10 text-ink-500 leading-relaxed">{it.note}</p>}
                {it.disposition === 'suggested-map' && it.suggestedTargetId && (
                  <label className="mt-1.5 flex items-start gap-1.5 text-11 text-info cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      disabled={readOnly}
                      checked={approvedMaps[it.fromId!] === it.suggestedTargetId}
                      onChange={e => onToggleMap(it.fromId!, it.suggestedTargetId!, e.target.checked)}
                    />
                    <span>
                      确认把「{fromLabel}」的旧值映射到「{labelOf(to, it.suggestedTargetId)}」
                      （不勾选 ⇒ 旧字段归档、值原地保留）
                    </span>
                  </label>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {plan.semanticChanged && (
        <p className="text-10 text-ink-500 leading-relaxed flex items-start gap-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber/70" />
          语义摘要已变化：相关检索索引与 AI 候选会按失效规则处理，采用后可能需要重新整理。
        </p>
      )}
    </div>
  )
}

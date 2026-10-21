/**
 * 字段显示名 · 统一入口按钮（2.7.3）
 *
 * 表格 / 表单 / 卡片三类页签共用：各自只算一份 `targets` 传进来，
 * 按钮 + 弹窗 + 读写别名这套逻辑不重复抄（抄一份就漏一处，本项目已为此付过代价）。
 */
import { useMemo, useState } from 'react'
import { Type } from 'lucide-react'
import { Button } from '@/components/common/Button'
import FieldAliasDialog, { type AliasTarget } from '@/components/sheets/FieldAliasDialog'
import { useFieldRenames } from '@/lib/templates/useFieldRenames'

export default function FieldAliasButton({
  tabId,
  tabName,
  intro,
  targets,
  // 🔴 默认 md（h-9）：这个键永远和页头的「保存 / AI 补全 / 新建」这些 md 按钮排在同一行，
  //    之前默认 sm（h-8）比左邻右舍矮一截，看着歪（2026-10-03 反馈）。同排同 size 是本项目铁律。
  size = 'md',
  variant = 'secondary',
}: {
  tabId: string
  tabName: string
  /** 弹窗顶部那句说明 */
  intro: string
  targets: AliasTarget[]
  size?: 'xs' | 'sm' | 'md'
  variant?: 'secondary' | 'bare'
}) {
  const [open, setOpen] = useState(false)
  const keys = useMemo(() => targets.map(t => t.key), [targets])
  const { renamed, pending, save, adopted } = useFieldRenames(tabId, keys)
  const renamedCount = Object.keys(renamed).length
  const pendingCount = Object.keys(pending).length

  if (targets.length === 0) return null

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        title={adopted
          ? '本页已采用模板：改显示名与含义确认会写进模板定义，只改显示与 AI 的理解，不动已填内容与存储键'
          : '给这一页的字段起你自己看得懂的名字：只改显示与 AI 的理解，不动已填内容与存储键'}
        className="gap-1.5"
      >
        <Type size={12} /> 字段名
        {renamedCount > 0 && <span className="text-amber">{renamedCount}</span>}
        {pendingCount > 0 && (
          <span className="px-1 py-px text-10 rounded bg-amber/15 text-amber border border-amber/30" title="有待确认含义的改名">
            {pendingCount} 待确认
          </span>
        )}
      </Button>
      {open && (
        <FieldAliasDialog
          title={`字段显示名 · ${tabName}`}
          intro={adopted
            ? `${intro}（本页已采用模板：保存会写进模板定义，其它采用同一模板的页签同步生效）`
            : intro}
          targets={targets}
          initial={renamed}
          pending={pending}
          onSave={save}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** 表格页签用：列定义 → targets（无分组；提示语按是否有固定选项区分） */
export function tableAliasTargets(
  columns: { name: string; options?: string[] }[],
): AliasTarget[] {
  return columns.map(c => ({
    key: c.name,
    label: c.name,
    hint: c.options?.length ? `原本可填：${c.options.join(' / ')}` : '原本是自由填写',
  }))
}

/**
 * 表单 / 卡片页签用：模块清单 → targets（按模块分组）。
 * `excludedKeys`：内部字段（草稿箱 `__` 前缀那种）不进列表。
 */
export function moduleAliasTargets(
  modules: { name: string; fields: { name: string; desc?: string; example?: string }[] }[] | undefined,
  excludedKeys: string[] = [],
): AliasTarget[] {
  if (!modules) return []
  const skip = new Set(excludedKeys)
  const out: AliasTarget[] = []
  for (const m of modules) {
    for (const f of m.fields) {
      const key = `${m.name}::${f.name}`
      if (skip.has(key)) continue
      out.push({
        key,
        label: f.name,
        hint: f.desc ? f.desc : f.example ? `示例：${f.example}` : '原本是自由填写',
        group: m.name,
      })
    }
  }
  return out
}

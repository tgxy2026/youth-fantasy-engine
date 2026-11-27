/**
 * 页内「信息说明」折叠块（3.7.5 · Q-06 / 全站统一）
 *
 * 【为什么要有】此前全站有 **4 处** tips 渲染，三种不同做法：
 *   · `TableSheet`：上方「编号规则」details + **页面底部** tips 块（表格被两头夹住，且写死 62vh，窗口再高也只滚 62vh）
 *   · `FormSheet`：页面底部 tips 块（把表单撑长）
 *   · `CharacterSheet`：页面底部 tips 块，且 `max-h-24` 内部滚动（第三种）
 *   · `WorldSetSheet`：同 FormSheet
 * 现在统一成「顶部一块、默认收起、点开看」：编号规则与填写说明合并，正文区域（表格 / 表单）不再被底部块挤占。
 *
 * 🔴 三条纪律：
 *   ① **默认收起**：`<details>` 不带 `open`，不写进任何偏好 —— 主人定的是"全部收起"；
 *   ② 必须留可见的展开提示（文字「点击展开」+ 会翻转的箭头），否则新人不知道这里能点；
 *   ③ 只收**说明性文字**，不收错误 / 警告（编号校验失败这类必须常显，放调用方）。
 */
import { ChevronDown, Info } from 'lucide-react'

interface Props {
  /** 编号规则（表格页才有）：与 tips 合并进同一块，顺序在前 */
  codeRule?: string
  /** 填写说明 / 页脚提示 */
  tips?: string[]
  className?: string
}

export default function PageInfoNotes({ codeRule, tips, className = '' }: Props) {
  const items = [...(codeRule ? [codeRule] : []), ...(tips ?? [])].filter(text => !!text?.trim())
  if (items.length === 0) return null

  return (
    <details
      className={`group mb-3 shrink-0 rounded-lg border border-ink-700/70 bg-ink-850/75 text-11 text-ink-400 ${className}`}
    >
      <summary
        className="flex cursor-pointer select-none items-center gap-1.5 px-3.5 py-2 text-ink-300 hover:text-amber/90 [&::-webkit-details-marker]:hidden"
        title="展开查看本页的填写说明与编号规则"
      >
        <ChevronDown size={12} className="shrink-0 text-ink-500 transition-transform group-open:rotate-180" />
        <span className="font-medium text-amber/85">信息说明</span>
        <span className="ml-auto text-10 text-ink-500">点击展开</span>
      </summary>
      <div className="space-y-1.5 px-3.5 pb-2.5">
        {items.map((text, i) => (
          <p key={i} className="flex items-start gap-2 leading-relaxed">
            <Info size={11} className="mt-0.5 shrink-0 text-amber/70" />
            <span className="text-ink-300">{text}</span>
          </p>
        ))}
      </div>
    </details>
  )
}

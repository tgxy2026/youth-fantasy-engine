import HelpPopover from '@/components/common/HelpPopover'
import { Info } from 'lucide-react'

// Critical guidance stays beside the field, even when a custom template supplies a long description.
const CRITICAL_GUIDANCE = /保密|隐私|秘密|敏感|权限|必填|警告|注意|禁止|不要|不能|不可|请勿|切勿|务必|密钥|口令|密码|错误|失败|上传|外发|模型|提示词|privacy|confidential|sensitive|required|permission|warning|secret|\bAI\b/i

/**
 * 字段说明（3.5.1 · U3 渐进披露）。
 *
 * `description`：首屏提示 —— 短（≤56 字、无换行）或命中关键告知词时常驻，否则收进「填写说明」气泡。
 * `help`：可选补充口径 —— 一律收进字段旁的 ⓘ 气泡，标签列不被长文撑高。
 *   不传 help 时与改造前**完全一致**（容器不加 flex，零布局变化）。
 */
export default function FieldDescription({ label, description, help }: { label: string; description?: string; help?: string }) {
  if (!description && !help) return null
  const inline = !!description && (([...description].length <= 56 && !description.includes('\n')) || CRITICAL_GUIDANCE.test(description))
  const descNode = description ? (inline ? description : (
    <HelpPopover title={`${label} · 填写说明`} triggerTitle={`查看${label}的填写说明`}
      trigger={<span className="text-11 underline decoration-dotted underline-offset-4">填写说明</span>}
      triggerClassName="min-h-6 px-1 text-ink-300 hover:text-amber" side="right" width="24rem" pin>
      {description}
    </HelpPopover>
  )) : null
  return (
    <div className={`field-desc mt-1${help ? ' flex items-start gap-1' : ''}`} data-field-description={inline ? 'inline' : 'disclosure'}>
      {help ? <span className="min-w-0 flex-1">{descNode}</span> : descNode}
      {help && (
        <HelpPopover title={`${label} · 补充说明`} triggerTitle={`查看${label}的补充说明`}
          trigger={<Info size={12} />}
          triggerClassName="shrink-0 mt-0.5 p-1.5 rounded text-ink-500 hover:text-amber transition-colors"
          side="right" width="24rem" pin>
          {help}
        </HelpPopover>
      )}
    </div>
  )
}
import HelpPopover from '@/components/common/HelpPopover'

// Critical guidance stays beside the field, even when a custom template supplies a long description.
const CRITICAL_GUIDANCE = /保密|隐私|秘密|敏感|权限|必填|警告|注意|禁止|不要|不能|不可|请勿|切勿|务必|密钥|口令|密码|错误|失败|上传|外发|模型|提示词|privacy|confidential|sensitive|required|permission|warning|secret|\bAI\b/i

export default function FieldDescription({ label, description }: { label: string; description?: string }) {
  if (!description) return null
  const inline = ([...description].length <= 56 && !description.includes('\n')) || CRITICAL_GUIDANCE.test(description)
  return (
    <div className="field-desc mt-1" data-field-description={inline ? 'inline' : 'disclosure'}>
      {inline ? description : (
        <HelpPopover title={`${label} · 填写说明`} triggerTitle={`查看${label}的填写说明`}
          trigger={<span className="text-11 underline decoration-dotted underline-offset-4">填写说明</span>}
          triggerClassName="min-h-6 px-1 text-ink-300 hover:text-amber" side="right" width="24rem" pin>
          {description}
        </HelpPopover>
      )}
    </div>
  )
}

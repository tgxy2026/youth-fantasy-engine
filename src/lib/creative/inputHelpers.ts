import { DEAI_TEMPLATES } from '@/lib/outline/autoContinue'
import type { CreativeInputs } from '@/lib/creative/creativeSession'

export function deAiPromptOf(inp: CreativeInputs): string {
  if (inp.deAiTpl === 'custom') return inp.deAiCustom.trim()
  return DEAI_TEMPLATES.find(t => t.id === inp.deAiTpl)?.prompt ?? ''
}

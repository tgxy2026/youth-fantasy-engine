import type { ReactNode } from 'react'
import { ArrowRightLeft, ChevronDown, FileDown, FileUp, LayoutTemplate, Sparkles, Wand2 } from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import { Button } from '@/components/common/Button'

interface Props {
  noun: string
  isCharacter: boolean
  templateTitle?: string
  alias: ReactNode
  aiEnabled: boolean
  aiDisabledHint?: string
  hasSelection: boolean
  canMove: boolean
  onTemplate: () => void
  onImport: () => void
  onExport: () => void
  onCreateAI: () => void
  onFillAI: () => void
  onMove: () => void
}

export default function CharacterTools(props: Props) {
  const actionClass = 'w-full !justify-start'
  return (
    <HelpPopover title="档案工具" triggerTitle="档案工具" triggerVariant="secondary" triggerSize="md"
      trigger={<>档案工具 <ChevronDown size={12} /></>} pin focusOnOpen width="24rem">
      {close => <div role="group" aria-label="档案工具选项" className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-12 font-semibold text-ink-100">字段与模板</h3>
          {props.templateTitle && <Button variant="ghost" size="sm" className={actionClass} title={props.templateTitle}
            onClick={() => { close(); props.onTemplate() }}><LayoutTemplate size={14} /> 模板管理</Button>}
          {/* FieldAliasButton owns its dialog: retain this parent while the child modal is open. */}
          {props.alias}
        </div>
        {props.isCharacter && <div className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">导入与导出</h3>
          <Button variant="ghost" size="sm" className={actionClass} onClick={() => { close(); props.onImport() }}><FileDown size={14} /> 批量导入</Button>
          <Button variant="ghost" size="sm" className={actionClass} onClick={() => { close(); props.onExport() }}><FileUp size={14} /> 导出全部为 CSV</Button>
          <p className="text-11 text-ink-400">导出包含当前未保存的修改。</p>
        </div>}
        {props.aiEnabled && <div className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">AI 辅助</h3>
          {props.aiDisabledHint && <p className="text-11 text-ink-300">{props.aiDisabledHint}</p>}
          <Button variant="ghost" size="sm" className={actionClass} disabled={!!props.aiDisabledHint}
            onClick={() => { close(); props.onCreateAI() }}><Sparkles size={14} /> AI 新增{props.noun}</Button>
          <Button variant="ghost" size="sm" className={actionClass} disabled={!!props.aiDisabledHint || !props.hasSelection}
            onClick={() => { close(); props.onFillAI() }}><Wand2 size={14} /> AI 补全当前档案</Button>
          <p className="text-11 text-ink-400">新增会创建一张新卡；补全只填写当前卡的空白字段。</p>
        </div>}
        {props.canMove && <div className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">当前档案</h3>
          <Button variant="ghost" size="sm" className={actionClass} disabled={!props.hasSelection}
            onClick={() => { close(); props.onMove() }}><ArrowRightLeft size={14} /> 移动到其他页签</Button>
          <p className="text-11 text-ink-400">移动前会列出目标页签及不能保留的字段。</p>
        </div>}
      </div>}
    </HelpPopover>
  )
}

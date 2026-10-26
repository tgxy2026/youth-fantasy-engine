import { UserRound } from 'lucide-react'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import { copyText } from '@/components/dialogs/dialogs'
import type { CharacterProfileFact } from '@/lib/world/characterProfile'

export default function CharacterProfileHeader({ name, portrait, facts, onRename }: {
  name: string; portrait?: string; facts: readonly CharacterProfileFact[]; onRename: () => void
}) {
  return <div className="min-w-0 flex-1 flex items-start gap-3" data-character-profile>
    <div className="h-14 w-14 shrink-0 rounded-lg border border-line-subtle bg-surface-panel overflow-hidden flex items-center justify-center">
      {portrait ? <img src={portrait} alt={`${name} 的档案缩略图`} className="h-full w-full object-contain" /> : <UserRound size={24} className="text-content-muted" aria-hidden="true" />}
    </div>
    <div className="min-w-0 flex-1">
      <h2 className="text-lg font-bold text-amber break-words [overflow-wrap:anywhere]">
        <Button variant="bare" className="!block max-w-full text-left whitespace-normal" onClick={onRename} aria-label={`修改名称：${name}`} title={name}><span className="line-clamp-2">{name}</span></Button>
      </h2>
      <p className="mt-1 text-11 text-content-muted">修改后点「保存」或按 Ctrl+S</p>
      {facts.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1" aria-label="档案摘要">
        {facts.map(fact => <HelpPopover key={fact.key} title={fact.label} pin width="24rem"
          triggerTitle={`查看完整${fact.label}`} triggerClassName="min-w-0 max-w-full text-left text-12 text-content-secondary hover:text-amber"
          trigger={<span className="block max-w-64 truncate">{fact.label}：{fact.value}</span>}>
          <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{fact.value}</p>
          <Button size="sm" className="mt-3" onClick={() => void copyText(fact.value, '完整内容已复制')}>复制完整内容</Button>
        </HelpPopover>)}
      </div>}
    </div>
  </div>
}

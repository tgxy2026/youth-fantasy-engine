import type { ComponentProps } from 'react'
import CharacterPortraitSlots from './CharacterPortraitSlots'

export default function CharacterPortraitPanel(props: ComponentProps<typeof CharacterPortraitSlots>) {
  const hasAny = !!props.portrait || !!props.portrait2
  return <div className="w-[17.5rem] max-w-full shrink-0 border-l border-line-subtle px-4 py-3 flex flex-col" data-character-portraits={hasAny ? 'filled' : 'empty'}>
    <div className="flex items-center gap-2 mb-2 text-11 text-content-secondary">
      <span>人物立绘</span><span className="ml-auto text-10 text-content-muted">{hasAny ? '两张 · 完整显示' : '尚未上传 · 点击添加'}</span>
    </div>
    <CharacterPortraitSlots {...props} />
  </div>
}
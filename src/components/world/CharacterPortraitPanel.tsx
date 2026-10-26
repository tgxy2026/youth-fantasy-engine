import type { ComponentProps } from 'react'
import CharacterPortraitSlots from './CharacterPortraitSlots'

export default function CharacterPortraitPanel(props: ComponentProps<typeof CharacterPortraitSlots>) {
  if (!props.portrait && !props.portrait2) return <details className="w-full border-t border-line-subtle px-4 py-3" data-character-portraits="empty">
    <summary className="cursor-pointer text-12 text-content-secondary">人物立绘 · 尚未上传，点击添加</summary>
    <p className="mt-2 mb-3 text-11 text-content-muted">可上传或拖入两张图片；图片仅在保存后写入当前角色卡。</p>
    <CharacterPortraitSlots {...props} compact />
  </details>
  return <div className="w-[17.5rem] max-w-full shrink-0 border-l border-line-subtle px-4 py-3 flex flex-col" data-character-portraits="filled">
    <div className="flex items-center gap-2 mb-2 text-11 text-content-secondary">
      <span>人物立绘</span><span className="ml-auto text-10 text-content-muted">两张 · 完整显示</span>
    </div>
    <CharacterPortraitSlots {...props} />
  </div>
}

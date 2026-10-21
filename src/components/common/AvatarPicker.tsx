/**
 * 头像设置（批次 8）—— 上传 / 换一张 / 移除。
 *
 * 角色卡片与「我的档案」共用同一套：`FreeCharacter.avatar` 与 `profile.avatar` 都是
 * 「一个 dataURL 字符串」，交互与压缩规则完全一样，没有理由写两份。
 *
 * 两处刻意的细节：
 *   · 选完**立刻清空 input.value** —— 否则同一张图改完再选一次不会触发 onChange（浏览器认为没变）。
 *   · 成功/失败都 toast：压缩是后台行为，作者看不到过程，必须给一个明确的「成了 / 为什么没成」。
 */
import { useRef, useState, type ReactNode } from 'react'
import Avatar from '@/components/common/Avatar'
import { Button } from '@/components/common/Button'
import { useImageDrop } from '@/components/common/ImageDropZone'
import { showToast } from '@/components/dialogs/dialogs'
import { AVATAR_ACCEPT, AVATAR_HINT_SPEC, readAvatarFile } from '@/lib/media/imageAvatar'

export default function AvatarPicker({ src, name, size = 64, onChange, hint, actions }: {
  src?: string
  name: string
  /** 预览头像的边长 */
  size?: number
  /** 传出可直接存库的 dataURL；移除时传空串 */
  onChange: (dataUrl: string) => void
  hint?: string
  /**
   * 额外的操作按钮（可选）：渲染在「上传图片」那一行的**最右端**。
   *
   * 角色卡片用它把「复制为新卡 / 删除 / 保存」提到卡面顶部 —— 那张卡很长，
   * 保存按钮原先只挂在编辑区最底部，改完一处得滚到底才能存（老大 2026-09-16 反馈 #9）。
   *
   * ⚠️ 保持可选：不传时布局与历史行为**完全一致**（「我的档案」那处就不传）。
   */
  actions?: ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const pick = async (f?: File) => {
    if (!f) return
    setBusy(true)
    try {
      onChange(await readAvatarFile(f))
      showToast('头像已更新（自动裁成方形并压缩）')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '这张图不能用作头像', 'error')
    } finally {
      setBusy(false)
    }
  }

  // 3.2.0：图片可直接拖到这行任意位置 —— 与点按钮走**同一条**通路（同一个 pick），
  // 校验、裁方、压缩、toast 都复用，不存在"拖进来的和点选进来的规则不一样"。
  const drop = useImageDrop({ accept: AVATAR_ACCEPT, onFile: pick, disabled: busy })

  return (
    <div
      {...drop.dropProps}
      // 3.2.0：整行都是拖拽落点 —— 头像是 64px 的小方块，只盯着那块拖太挑手
      className={`flex items-center gap-3 rounded-xl transition-colors ${
        drop.dragging ? 'ring-2 ring-amber/60 bg-amber/5' : ''
      }`}
    >
      <Avatar src={src} name={name} size={size} title={name || '头像'} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary" size="sm" type="button" disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? '处理中…' : src ? '换一张' : '上传图片'}
          </Button>
          {src && (
            <Button variant="danger" size="sm"
              onClick={() => onChange('')}
            >
              移除
            </Button>
          )}
          {/* 调用的页面塞进来的额外按钮（角色卡片的「复制为新卡 / 删除 / 保存」）——
              `ml-auto` 把它们顶到这一行最右，与「上传图片」同一行、不用滚到底就够得着。
              `flex-wrap` 兜窄屏：挤不下时整组换行，不会把「上传图片」压扁。 */}
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        <p className="mt-1 text-10 text-ink-500 leading-relaxed">
          {drop.dragging
            ? <span className="text-amber">松开鼠标即可换上这张图</span>
            : (hint ?? '不设也能用 —— 会用名字首字代替；也可以直接把图片拖到这里。')}
        </p>
        <p className="mt-0.5 text-10 text-ink-600 leading-relaxed">{AVATAR_HINT_SPEC}</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = ''
          void pick(f)
        }}
      />
    </div>
  )
}

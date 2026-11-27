/**
 * 「阅读模式」入口按钮（3.7.5 · Q-03）
 *
 * 两个入口共用这一个组件，避免两处各写一遍状态与弹窗：
 *   · 项目管理首页卡片：`mode="text"`（打开项目 / 编辑项目 右侧第三个按钮，同高同风格）
 *   · 正文编辑页签的章节栏：`mode="icon"`（只放图标，和导入 / 新建卷 / 新建章节 同款）
 *
 * 🔴 阅读器**只读**，这里不加任何写操作；弹窗打开前不预读正文，减少无谓 IO。
 */
import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/common/Button'
import ReaderModal from '@/components/reader/ReaderModal'

interface Props {
  projectId: string
  projectName: string
  /** 从正文页进来时落在当前章；首页入口不传 */
  initialChapterId?: string | null
  mode?: 'text' | 'icon'
  label?: string
  variant?: 'secondary' | 'bare'
  size?: 'xs' | 'sm' | 'md'
  className?: string
}

export default function ReaderLaunchButton({
  projectId, projectName, initialChapterId, mode = 'text', label = '阅读模式', variant = 'secondary', size = 'md', className = '',
}: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={`whitespace-nowrap ${className}`}
        onClick={() => setOpen(true)}
        title={mode === 'icon' ? '阅读模式：像看小说一样读自己的书（只读）' : '阅读模式：像看小说一样读自己的书（只读，不会改动正文）'}
        aria-label={mode === 'icon' ? label : undefined}
      >
        <BookOpen size={mode === 'icon' ? 13 : 14} className="shrink-0" />
        {mode === 'text' && <span className="ml-1">{label}</span>}
      </Button>
      {open && (
        <ReaderModal
          open={open}
          onClose={() => setOpen(false)}
          projectId={projectId}
          projectName={projectName}
          initialChapterId={initialChapterId ?? null}
        />
      )}
    </>
  )
}

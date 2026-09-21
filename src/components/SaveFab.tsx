import { Save } from 'lucide-react'
import { Button } from './Button'
import { Z } from '../lib/zLayer'

/**
 * 页面内的「保存」悬浮球（固定在右下角）。
 *
 * 【为什么抽成组件】这套「主色 + 实心 + 脉冲动效 + Save 图标」的结构，
 * 原先在角色卡 / 表单 / 大纲 / 表格四个页签里各写了一遍 ——
 * 改样式时忘掉其中一两处是迟早的事（本轮审计就是四处里只有一处少了字号）。
 *
 * ⚠️ 位置固定右下角：项目约定「左下角只准一个 DataDock」，别往左挪。
 * ⚠️ 只在有未保存改动时渲染（由调用方判断 dirty），所以它一出现就说明"该存了"。
 */
export function SaveFab({
  label,
  onClick,
  title,
}: {
  /** 按钮文案，如「保存修改」「保存 3 行修改」 */
  label: string
  onClick: () => void
  /** 悬停说明（可选） */
  title?: string
}) {
  return (
    <div className="fixed bottom-6 right-6" style={{ zIndex: Z.fab }}>
      <Button
        onClick={onClick}
        variant="primary"
        solid
        size="md"
        title={title}
        className="flex items-center text-13 text-ink-900 transition-all animate-pulse"
      >
        <Save size={14} /> {label}
      </Button>
    </div>
  )
}

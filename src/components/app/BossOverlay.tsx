/**
 * 老板键遮挡屏（3.3.2 · 规划 §15，仅便携 / 网页）。
 *
 * 【它是什么】普通网页藏不了浏览器窗口与任务栏按钮，能做的是**用一块不透明屏盖住本页**：
 * 焦点在页面里时按老板键就盖上，点击 / Esc / 再按同一组合恢复。
 *
 * 🔴 **屏上不出现任何作品内容**：项目名、章节名、字数、保存提示全不显示 ——
 *    显示"《吞天神脉》已保存"等于把要藏的东西写在屏上。
 * 🔴 保存结果只显示成败，不显示书名 / 文件名 / 路径。
 * 🔴 层号取 `Z.boss`：必须盖住 toast 与弹窗，否则提示会从缝里漏出来。
 */
import { useEffect, useRef } from 'react'
import { EyeOff } from 'lucide-react'
import { Z } from '@/lib/app/zLayer'
import { accelDisplay, matchesAccel } from '@/lib/app/bossKey'

export interface BossOverlayProps {
  accel: string
  onRestore: () => void
  /** 保存结果（只显示成败与通用原因，不含作品信息） */
  saveOk?: boolean
  saveMessage?: string
}

export default function BossOverlay({ accel, onRestore, saveOk, saveMessage }: BossOverlayProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRestore(); return }
      if (matchesAccel(e, accel)) { e.preventDefault(); onRestore() }
    }
    // 捕获阶段：内容区若有自己的 keydown 处理，也不能把恢复键吞掉
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [accel, onRestore])

  const display = accelDisplay(accel) || accel

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="页面已遮挡"
      onClick={onRestore}
      className="fixed inset-0 flex cursor-pointer flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center outline-none"
      style={{ zIndex: Z.boss }}
    >
      <EyeOff size={34} className="text-ink-600" aria-hidden />
      <p className="text-16 text-ink-200">页面已遮挡</p>
      <p className="text-12 text-ink-500">
        点击任意处，或按 {display} / Esc 恢复
      </p>
      {saveMessage && (
        <p className={`text-11 ${saveOk === false ? 'text-rose-300' : 'text-ink-500'}`}>{saveMessage}</p>
      )}
      <p className="max-w-md text-11 leading-relaxed text-ink-600">
        浏览器标签名称、浏览器窗口与任务栏图标仍可能可见；页面没有焦点时快捷键不生效。
      </p>
    </div>
  )
}
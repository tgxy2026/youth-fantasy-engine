import { useEffect, useRef } from 'react'

/**
 * 下拉浮层打开时跟随滚动 / 窗口变化重算位置；关闭时回调 reset 清掉位置。
 *
 * 日历选择、通用下拉、表引用下拉此前各抄了一份相同的 9 行 effect —— 三处行为必须一致，
 * 收敛到这里避免改一处漏两处。`updatePos` 每次渲染都会变，用 ref 持有最新引用，
 * effect 仍只在 `open` 切换时重挂（与原实现依赖数组一致）。
 */
export function useDropdownReposition(open: boolean, updatePos: () => void, reset: () => void): void {
  const updateRef = useRef(updatePos)
  const resetRef = useRef(reset)
  updateRef.current = updatePos
  resetRef.current = reset

  useEffect(() => {
    if (!open) { resetRef.current(); return }
    updateRef.current()
    const onMove = () => updateRef.current()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])
}
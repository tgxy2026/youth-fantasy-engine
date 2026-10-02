/**
 * Ctrl/Cmd+S 保存快捷键（2.7.3 收敛为**唯一切入口**）
 *
 * ## 为什么要有这个 hook
 * 2.7.3 前，快捷键是「每个编辑面板各写一份 `window.addEventListener('keydown')`」：
 * FormSheet / CharacterSheet / OutlineSheet / useTableSheetModel / useNovelEditorModel 五处各抄一遍，
 * 而 2.4.2 新增的 `WorldSetSheet`、2.7.2 新增的 `ParallelSetSheet`、酒馆的 `TavernCard`
 * **都忘了挂** ⇒ 作者在世界设定 / 力量体系 / 政治 / 经济基础 / 信仰 / 司法 / 角色卡里按 Ctrl+S 毫无反应
 * （社区反馈，2026-10-03）。
 *
 * 抄写型代码的必然结局就是「新增面板时漏一处」，所以这里收敛成单一实现：
 * **新增任何带「保存」按钮的面板，只需一行 `useSaveHotkey(save, dirty)`。**
 *
 * ## 用法
 * ```ts
 * useSaveHotkey(() => void save(), dirty)   // 没改动时不触发（与点按钮 disabled 同口径）
 * ```
 *
 * 🔴 两条纪律：
 *   ① **回调走 ref**：依赖里不放 `save` 本体（保存函数几乎每次渲染都变），否则每次输入都重绑监听；
 *   ② **只在 dirty 时绑定**：`enabled` 为假时直接不挂监听 —— 没改动的面板不该吞掉浏览器的「保存网页」。
 */
import { useEffect, useRef } from 'react'

/**
 * @param onSave 按下快捷键时要做的事（内部始终调**最新**的那一份）
 * @param enabled 为假时不监听（默认 true）。通常传 `dirty`，与保存按钮的 disabled 保持一致。
 */
export function useSaveHotkey(onSave: () => void, enabled = true): void {
  // 🔴 用 ref 持有最新回调：既避免重复绑定，也避免闭包里抓到过期的 save（会存回旧内容）
  const cbRef = useRef(onSave)
  useEffect(() => { cbRef.current = onSave }, [onSave])

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      // 只看 Ctrl / Cmd + S；带 Alt 的组合留给系统，shift 不影响（Ctrl+Shift+S 也算保存意图）
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key?.toLowerCase() !== 's') return
      e.preventDefault()
      cbRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

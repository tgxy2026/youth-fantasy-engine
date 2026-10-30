// ============ 设定表 · 方向键的纯判据（3.3.1 · §8） ============
//
// 规划 §8：图鉴与目录要能用方向键走。图鉴卡片、角色卡与大纲目录已经接了；
// 设定表（名词术语 / 伏笔追踪 / 国家势力…）此前只能 Tab 或鼠标点格子。
//
// 🔴 这里只做**判断**，不碰 DOM：由 `TableSheet` 拿结论去移动焦点。
//    最重要的判据是「这个控件自己会不会用掉方向键」—— 会就必须让给它，
//    否则作者在数字格里按上箭头会变成跳行，而他想加一。
//
// 为什么不按列名/页签写例外表（如「内容列不跳」）：那是猜。
// 判据只看**控件此刻的事实**（折没折行、是不是数字框），与页签、列名、输入法都无关。

export type GridArrow = 'ArrowUp' | 'ArrowDown'

/** 控件的最小外观描述（从 DOM 元素取，测试里直接给对象） */
export interface ArrowTargetInfo {
  tagName: string
  /** `input.type`（仅 INPUT 有意义） */
  type?: string | null
  /** `textarea.scrollHeight` */
  scrollHeight?: number
  /** `textarea.clientHeight` */
  clientHeight?: number
  /** `getComputedStyle().lineHeight` 解析后的像素值（`normal` 请由调用方换成字号估算） */
  lineHeight?: number
  /** 上下内边距之和（像素）。🔴 必须减掉：`scrollHeight` 含 padding，`clientHeight` 不含 */
  paddingY?: number
}

/**
 * 控件自己会不会消费上下箭头。
 *
 * 会的情况（一律不抢）：
 *   · 数字 / 滑块 / 日期时间输入框 —— 上下箭头是**改值**（减一 / 加一），抢了就把值改了却不动行；
 *   · 原生 `<select>` —— 上下箭头是**换选项**；
 *   · 折了行的文本域 —— 上下箭头是在**自己的行间**移光标，抢了就没法编辑长内容。
 *
 * 不会的情况（可以接管）：
 *   · 单行输入框 / 未折行的单元格文本域（上下箭头本来什么都没做 —— 正是该拿来跳行）；
 *   · 按钮、可聚焦的自定义控件。
 */
export function nativeConsumesVerticalArrow(target: ArrowTargetInfo): boolean {
  const tag = target.tagName.toUpperCase()
  if (tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target.type ?? 'text').toLowerCase()
    return type === 'number' || type === 'range' || type === 'date' || type === 'time'
      || type === 'month' || type === 'week' || type === 'datetime-local'
  }
  if (tag === 'TEXTAREA') {
    const scroll = target.scrollHeight ?? 0
    const line = target.lineHeight ?? 0
    const padding = target.paddingY ?? 0
    if (line > 0) {
      /**
       * 🔴 判断「折行」必须**先减掉内边距**：
       *    单元格文本域是 `rows=1` + `py-1`，`scrollHeight` 含上下 8px 内边距、`clientHeight` 不含 ——
       *    直接比差会得出「已经折了 8px 行」的假结论，于是方向键全被让掉、一行都跳不动（实测抓到的就是这个）。
       *    减掉 padding 后：单行 ≈ 1 倍行高；两行 ≈ 2 倍 ⇒ 1.5 倍是稳的分界。
       */
      return scroll - padding > line * 1.5
    }
    // 拿不到行高（极端环境）时退回旧判据：差 1px 是行高取整的常态，多出更多才算折行
    return scroll > (target.clientHeight ?? 0) + 1
  }
  return false
}

/**
 * 相邻行下标。
 *
 * @param current 当前行在**已渲染**行里的下标
 * @param total   已渲染行数（表格是窗口化的，只有近处几十行在 DOM 里）
 * @returns 目标下标；到头（第一行再按上 / 最后一行再按下）返回 `null`，交回给浏览器
 */
export function neighborRowIndex(current: number, total: number, key: GridArrow): number | null {
  if (!Number.isInteger(current) || total <= 0) return null
  if (current < 0 || current >= total) return null
  const next = current + (key === 'ArrowUp' ? -1 : 1)
  return next >= 0 && next < total ? next : null
}

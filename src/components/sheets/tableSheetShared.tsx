/**
 * 表格页签的**模块级共享件**（`TableSheet` / `TableSheetRow` / `TableRelationGroups` 共用）。
 *
 * 从 `TableSheet.tsx` 拆出来是必须的：子组件若从 `TableSheet.tsx` 反向 import 这几个名字，
 * 就与「TableSheet → 子组件」形成环 —— 静态闸会红，浏览器里还会 TDZ 崩（只在运行时炸，极难查）。
 */
import { useEffect, useRef } from 'react'

/** 人物关系中内容较长的列：编辑面板中占满整行 */
export const LONG_REL_COLS = new Set([
  '关系现状', '知情度（互相知道什么）', '关系起点/契机',
  '演变轨迹（按卷）', '演变触发事件', '关系终点', '戏剧功能', '备注',
])

/** 特殊行的自动着色规则 */
export function rowBadgeClass(tabId: string, data: Record<string, string>): string | null {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const found = Object.entries(data).find(([kk]) => kk.includes(k))
      if (found) return found[1]
    }
    return ''
  }
  if (tabId === 'relations') {
    const t = get('关系类型')
    if (t.includes('敌对') || t.includes('恩怨')) return 'bg-danger/5'
    if (t.includes('CP') || t.includes('感情')) return 'bg-pink-500/5'
    if (t.includes('盟友')) return 'bg-success/5'
    if (t.includes('亲属') || t.includes('师徒')) return 'bg-info/5'
  }
  if (tabId === 'foreshadow') {
    const s = get('状态'), imp = get('重要度')
    if (s === '已回收') return 'bg-success/5'
    if (imp === '全书级') return 'bg-amber/5'
  }
  if (tabId === 'changelog') {
    const s = get('已发布章节冲突')
    if (s === '有-未处理') return 'bg-danger/10'
  }
  if (tabId === 'secrets') {
    const r = get('泄露风险')
    if (r === '高') return 'bg-danger/10'
    if (r === '中') return 'bg-amber/10'
  }
  if (tabId === 'progress') {
    const s = get('完成状态')
    if (s === '断更') return 'bg-danger/10'
    if (s === '超额') return 'bg-success/5'
  }
  return null
}

/**
 * 表格文本单元格：自动换行、随内容撑高，但最多约 3 行（≈78px）即封顶并裁切；
 * 超长内容通过原生 title 在悬停时以"小窗"展示全文，避免表格行高被无限撑大。
 */
const CELL_MAX_H = 78

/**
 * 单元格撑高时机的**全局批处理**（3.2.0 · L4 容量基准）。
 *
 * 🔴 为什么不能每个组件各自量：原实现每个 textarea 一个 effect，内部依次
 *    `height='auto'` → 读 `scrollHeight` → 写回高度。每写一次再读下一个都会强制同步布局，
 *    100 行 × 60 字段（≈5 千个 textarea）实测首屏 38 秒、清空筛选 33 秒 —— O(n²) 布局抖动。
 *    现在把同一帧内所有待测量的单元格攒起来：先全部写 auto，再一次性读，最后一次性写回
 *    ⇒ 整帧只付一次布局成本。视觉结果与逐个数完全相同（同样封顶 78px）。
 */
const pendingHeight = new Set<HTMLTextAreaElement>()
let heightRaf = 0

function flushCellHeights() {
  heightRaf = 0
  const els = [...pendingHeight].filter(el => el.isConnected)
  pendingHeight.clear()
  for (const el of els) el.style.height = 'auto'
  const heights = els.map(el => Math.min(el.scrollHeight, CELL_MAX_H))
  els.forEach((el, i) => { el.style.height = heights[i] + 'px' })
}

function scheduleCellHeight(el: HTMLTextAreaElement) {
  pendingHeight.add(el)
  if (!heightRaf) heightRaf = requestAnimationFrame(flushCellHeights)
}

export function CellTextarea({ value, onChange, invalid, title, nowrap }: {
  value: string
  onChange: (v: string) => void
  invalid?: boolean
  title?: string
  /**
   * 不折行（3.1.2 视觉巡检 G 条）：编号列（如 `G0001-001-001`）在窄列里会被折成 2-3 行，
   * 同一列各行高度参差不齐、看着像排版坏了。编号是**不可分割的标识**，折行没有任何可读性收益 ——
   * 这里让它单行显示、超出部分裁掉（全文仍在 title 里悬停可见）。
   */
  nowrap?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    scheduleCellHeight(ta)
    // 卸载早于本帧时把引用摘掉，避免批处理碰已离场的元素
    return () => { pendingHeight.delete(ta) }
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      rows={1}
      title={title ?? value}
      className={`!py-1 text-12 w-full ${nowrap ? 'whitespace-pre' : 'whitespace-pre-wrap break-words'} resize-none overflow-hidden bg-transparent ${invalid ? '!border-danger/60 text-danger' : ''}`}
    />
  )
}

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import jiewenjiPng from '../assets/jiewenji.png'
import { Button } from './Button'
import { Z } from '../lib/zLayer'

interface Props {
  /** 当前是否在正文编辑器页面：编辑器内点击唤起完整面板；其他页面弹出引导 */
  isEditor: boolean
  onNavigate?: (tabId: string) => void
}

const SPRITE = 150
const TUCK_VISIBLE = 20      // 双击收进：只露一条边
const IDLE_VISIBLE = 50      // 平时：露出小半张脸
const HOVER_VISIBLE = 124    // 悬停：几乎全出

/**
 * 颉文姬 · 桌面精灵（v1.6）
 * 全局右缘驻留：平时只露一条边，悬停探出，点击唤起 AI 编辑面板（编辑器页）或引导（其他页）。
 * 可垂直拖拽换位（localStorage 持久化）；双击收进 / 再双击展开。
 * 注：真正的"系统级桌面宠物"（跳出窗口站到系统桌面）在网页/便携版不可能，故为应用内精灵。
 */
export default function JieWenJiSprite({ isEditor, onNavigate }: Props) {
  const [topPct, setTopPct] = useState(() => {
    let v = 60
    try { v = Number(localStorage.getItem('yfe-sprite-y')) } catch { /* 存储不可用（隐私模式等）时用默认值 */ }
    return Number.isFinite(v) && v >= 8 && v <= 85 ? v : 60
  })
  const [hover, setHover] = useState(false)
  const [tucked, setTucked] = useState(false)
  const [mini, setMini] = useState(false)
  const [bounce, setBounce] = useState(false)
  const dragRef = useRef<null | { startY: number; origTop: number; moved: boolean }>(null)
  const lastClick = useRef(0)
  const clickTimer = useRef(0)
  const bounceTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    try { localStorage.setItem('yfe-sprite-y', String(topPct)) } catch { /* ignore */ }
  }, [topPct])
  // 卸载时清理延迟定时器（点击延迟 / 弹跳动画）
  useEffect(() => () => { clearTimeout(clickTimer.current); clearTimeout(bounceTimer.current) }, [])

  const visible = tucked ? TUCK_VISIBLE : hover ? HOVER_VISIBLE : IDLE_VISIBLE
  const translateX = SPRITE - visible

  const trigger = () => {
    // 编辑页：唤起完整面板（NovelEditor 监听事件）；其他页：引导气泡
    if (isEditor) {
      window.dispatchEvent(new Event('jiewenji:open'))
      setBounce(true)
      bounceTimer.current = setTimeout(() => setBounce(false), 500)
    } else {
      setMini(m => !m)
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, origTop: topPct, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    if (!d.moved && Math.abs(dy) > 3) d.moved = true
    if (d.moved) {
      setTopPct(Math.max(8, Math.min(85, d.origTop + (dy / window.innerHeight) * 100)))
    }
  }
  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved) return
    // 单击延迟 300ms 判定：双击的第一次点击不立即触发（否则双击收边会先弹面板），由 onDoubleClick 收边
    const now = Date.now()
    if (now - lastClick.current < 320) {
      // 双击的第二次点击：取消第一次的延迟触发
      clearTimeout(clickTimer.current)
      lastClick.current = now
      return
    }
    lastClick.current = now
    clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => trigger(), 300)
  }

  return (
    // 🔴 2.4.4 交互修复：事件全部绑在**平移层**上，外层 pointer-events-none ——
    // 此前外层是 150×150 的固定盒子，图片平移收进后，**视觉上看不见的那 100px 透明区
    // 也在接收鼠标**，导致"稍微挪过去就触发"（社区反馈：卡手）。现在热区 = 图片可见部分。
    <div
      className="fixed right-0 select-none"
      style={{ top: `${topPct}%`, transform: 'translateY(-50%)', zIndex: Z.sprite, pointerEvents: 'none' }}
    >
      {/* 悬停气泡 */}
      {!tucked && hover && !mini && (
        <div className="absolute right-[calc(100%+12px)] top-1/2 -translate-y-1/2 bg-ink-850 border border-ink-600 rounded-xl shadow-2xl px-3 py-2 text-11 text-ink-200 whitespace-nowrap pointer-events-none">
          {isEditor ? '主人，要校对或润色吗？' : '正文编辑器的 AI 助手，点我去编辑器～'}
        </div>
      )}

      {/* 非编辑器页面的引导面板 */}
      {!isEditor && mini && (
        <div
          className="absolute right-[calc(100%+10px)] bottom-1/2 mb-2 w-56 bg-ink-850 border border-ink-600 rounded-xl shadow-2xl p-3 pointer-events-auto"
style={{ zIndex: Z.pageTip }}
          onPointerDown={e => e.stopPropagation()}
        >
          {/* 🔴 2.4.4 六维审计：面板此前只有「前往编辑器」和双击精灵两条关闭路 —— 补一个明确的关闭键 */}
          <div className="flex items-center gap-1 mb-1">
            <div className="text-12 font-semibold text-amber flex-1">颉文姬 · AI 编辑助手</div>
            <Button variant="bare" iconOnly size="xs" onClick={() => setMini(false)} title="收起"
              className="text-ink-400 hover:text-ink-200"
            ><X size={12} /></Button>
          </div>
          <div className="text-11 text-ink-300 leading-relaxed mb-2">
            本地校对、AI 校对（文字层 / 逻辑层）、选区润色、审读建议、爽点毒点、续写方向、写作简报、本章设定补登……都在正文编辑器里。
          </div>
          <Button variant="primary" onClick={() => { onNavigate?.('editor'); setMini(false) }} className="w-full px-2 py-1.5 rounded-lg text-11 transition-colors">
            前往正文编辑器
          </Button>
        </div>
      )}

      {/* 精灵本体：横向滑出/收进 + 上下浮动 + 点击弹跳（交互热区 = 本层可见部分） */}
      <div
        className="transition-transform duration-300 ease-out pointer-events-auto"
        style={{ width: SPRITE, height: SPRITE, transform: `translateX(${translateX}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => { setTucked(t => !t); setMini(false) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); if (!mini) setMini(false) }}
        title={isEditor ? '颉文姬 · AI 编辑（点击打开 / 拖拽换位 / 双击收边）' : '颉文姬 · AI 编辑助手'}
      >
        <div
          className="w-full h-full"
          style={{ animation: bounce ? 'jwj-bounce 0.5s ease' : 'jwj-float 3.6s ease-in-out infinite' }}
        >
          <img
            src={jiewenjiPng}
            alt="颉文姬"
            draggable={false}
            className="w-full h-full object-contain drop-shadow-lg pointer-events-none select-none"
          />
        </div>
      </div>

      {/* 收边提示 */}
      {tucked && (
        <div className="absolute -top-6 right-2 text-9 text-ink-500 whitespace-nowrap pointer-events-none">双击展开</div>
      )}
    </div>
  )
}

// ⚠️ 2026-11-15：**当前没有调用点**。三个自托管页签（正文编辑 / 开书定位 / 伏笔追踪）
//   已把引导启动登记给左下角「本页指引」（见 lib/help/selfGuideRegistry），页头不再重复放按钮。
//   组件保留：将来若某页需要页内独立入口，直接复用即可。
// ============ 「本页指引」按钮（3.3.1 · P2） ============
//
// 规划 §3.1：入口或卡片提供「查看完整手册」；§3.5：页头没有统一标题区时，
// 在实际工具区放同等可达的帮助入口。
//
// 🔴 这个按钮是**主动重看**的唯一入口（卡片里的「跳过」只影响自动弹出）：
//    已看过、已跳过、关掉了自动引导，都能从这里再看一遍。
// 🔴 没有该页引导时**不渲染** —— 不摆一个点了没反应的按钮。
import { Compass } from 'lucide-react'
import { Button } from '@/components/common/Button'

export function PageGuideButton({ onStart, className = '' }: { onStart: () => void; className?: string }) {
  return (
    <Button variant="secondary" size="sm" onClick={onStart}
      title="分步认识这个页签（随时可重看，不影响任何数据）"
      className={`flex items-center gap-1.5 shrink-0 ${className}`}>
      <Compass size={12} /> 本页指引
    </Button>
  )
}

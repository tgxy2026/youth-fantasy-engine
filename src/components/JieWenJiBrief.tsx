/**
 * 颉文姬 · 简报（开写前本章待办）面板（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useJieWenJiModel（组件只收 m）。
 */
import { Loader2, Sparkles } from 'lucide-react'
import { AI_DISABLED_HINT } from '@/lib/aiScope'
import { Button } from '@/components/Button'
import { renderReport } from '@/components/jieWenJiParts'
import type { JieWenJiModel } from '@/components/useJieWenJiModel'

export default function JieWenJiBrief({ m }: { m: JieWenJiModel }) {
  const { aiReady, brief, runBrief, aiBtnCls } = m
  return (
          <>
            <Button variant="bare"
              onClick={() => void runBrief()}
              disabled={!aiReady || brief.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '基于设定资料生成「本章写作简报」：待办伏笔 / 钩子爽点 / 角色状态 / 下一章衔接'}
            >
              {brief.loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {brief.loading ? '生成中…' : '生成本章写作简报（开写前）'}
            </Button>
            <div className="text-10 text-ink-500 leading-relaxed px-1">
              写下一章之前点一下：AI 汇总未回收伏笔、可安排的钩子爽点、出场角色状态提醒与上一章衔接建议——只给方向，不代写正文。
            </div>
            {!aiReady && <div className="text-10 text-ink-500 leading-relaxed px-1">{AI_DISABLED_HINT}</div>}

            {brief.error && <div className="text-11 text-danger px-1">{brief.error}</div>}
            {brief.data && (
              <div className="rounded-lg border border-amber/25 bg-amber/5 px-3 py-2.5">
                {renderReport(brief.data.report)}
              </div>
            )}
          </>
  )
}

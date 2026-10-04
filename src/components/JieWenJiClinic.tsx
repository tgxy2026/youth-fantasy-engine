/**
 * 颉文姬 · 诊室面板（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useJieWenJiModel（组件只收 m）。
 */
import { Loader2, CheckCircle2, Sparkles, SpellCheck } from 'lucide-react'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { Button } from './Button'
import { PROOF_ORDER, PROOF_META, renderReport } from './jieWenJiParts'
import type { JieWenJiModel } from './useJieWenJiModel'

export default function JieWenJiClinic({ m }: { m: JieWenJiModel }) {
  const { aiReady, diagMode, setDiagMode, diag, runDiag, proofs, propsRunning, runProofread, stopProofread, replaceOne, aiBtnCls } = m
  return (
          <>
            {/* 校对只走完整正文：摘要定位不到原文 quote，简略模式会误替换（已移除） */}
            <div className="flex items-center gap-1.5 text-10 text-ink-500">
              <span>校对范围</span>
              <div className="flex rounded-md overflow-hidden border border-ink-700">
                <Button title="校对结果需在正文中精确定位替换，故恒校对全文" variant="bare" className="px-2 py-0.5 transition-colors bg-amber/20 text-amber cursor-default">完整（正文）</Button>
              </div>
            </div>
            {/* 两块校对：文字层（不读设定资料，更快）与逻辑层（读设定资料）。
                同一时刻只跑一块 —— 本面板所有 AI 请求共用同一个取消器（见 runProofread 的注释）。 */}
            <div className="flex flex-wrap items-center gap-1.5">
              {PROOF_ORDER.map(scope => {
                const st = proofs[scope]
                const meta = PROOF_META[scope]
                if (st.loading) {
                  return (
                    <Button key={scope} variant="bare" onClick={stopProofread}
                      className={`${aiBtnCls} bg-danger/15 border-danger/30 text-danger hover:bg-danger/25`}
                      title="点击停止（已查出的结果会保留）">
                      <Loader2 size={12} className="animate-spin" /> 停止（{st.progress.done}/{st.progress.total}）
                    </Button>
                  )
                }
                return (
                  <Button key={scope} variant="bare"
                    onClick={() => void runProofread(scope)}
                    disabled={!aiReady || propsRunning}
                    className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
                    title={!aiReady ? AI_DISABLED_HINT : meta.title}
                  >
                    <SpellCheck size={12} />
                    {st.done ? `重新${meta.label}` : meta.label}
                  </Button>
                )
              })}
            </div>
            <div className="text-10 text-ink-500 leading-relaxed">
              「查错别字与语病」不读设定资料，出结果更快；「查逻辑与设定矛盾」会读设定资料。
              两块可分别跑、分别看结果，互不覆盖。
            </div>

            {PROOF_ORDER.map(scope => {
              const st = proofs[scope]
              const meta = PROOF_META[scope]
              if (!st.loading && !st.done) return null
              return (
                <div key={scope} className="space-y-1.5">
                  <div className="text-10 font-medium text-ink-300">{meta.label}</div>
                  {st.loading && (
                    <div className="h-1 rounded bg-ink-700 overflow-hidden">
                      <div className="h-full bg-amber transition-all" style={{ width: `${st.progress.total ? (st.progress.done / st.progress.total) * 100 : 0}%` }} />
                    </div>
                  )}
                  {st.error && <div className="text-11 text-danger px-1">{st.error}</div>}
                  {st.done && st.cancelled && (
                    <div className="text-11 text-ink-300 px-1">已停止（保留已查出的 {st.issues.length} 处）</div>
                  )}
                  {st.done && !st.cancelled && (
                    <div className="text-10 text-ink-500">
                      共校对 {st.scanned} 字{st.skipped > 0 ? `，跳过 ${st.skipped} 字` : ''}，发现 {st.issues.length} 处
                    </div>
                  )}
                  {st.issues.length > 0 && (
                    <div className="space-y-1.5 max-h-56 overflow-y-auto">
                      {st.issues.map((iss, i) => (
                        <div key={i} className="rounded bg-ink-850 border border-ink-700/70 px-2 py-1.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="inline-block px-1.5 py-px rounded text-9 border bg-ink-700 text-ink-300 border-ink-600">{iss.type}</span>
                            <span className="text-11 text-danger line-through">{iss.quote}</span>
                            <span className="text-10 text-ink-500">→</span>
                            <span className="text-11 text-success">{iss.fix}</span>
                          </div>
                          {iss.why && <div className="text-10 text-ink-400 mt-0.5">{iss.why}</div>}
                          <Button variant="bare"
                            onClick={() => replaceOne(scope, iss)}
                            className="mt-1 px-2 py-0.5 rounded-md text-10 bg-success/10 text-success border border-success/25 hover:bg-success/20 transition-colors"
                          >
                            替换此条
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {st.done && !st.cancelled && st.issues.length === 0 && (
                    <div className="text-center text-11 text-success py-1">
                      <CheckCircle2 size={13} className="inline mr-1" /> 未发现问题
                    </div>
                  )}
                </div>
              )
            })}

            {/* 诊断范围：完整（正文）/ 简略（摘要） */}
            <div className="flex items-center gap-1.5 text-10 text-ink-500">
              <span>诊断范围</span>
              <div className="flex rounded-md overflow-hidden border border-ink-700">
                <Button variant="bare"
                  onClick={() => setDiagMode('full')}
                  className={`px-2 py-0.5 transition-colors ${diagMode === 'full' ? 'bg-amber/20 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
                  title="喂入本章全文：诊断最准，但耗时长、费 token"
                >完整（正文）</Button>
                <Button variant="bare"
                  onClick={() => setDiagMode('brief')}
                  className={`px-2 py-0.5 transition-colors ${diagMode === 'brief' ? 'bg-amber/20 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
                  title="只喂「章节压缩摘要」（约原文 1/10）：速度快、省 token"
                >简略（摘要）</Button>
              </div>
            </div>
            <Button variant="bare"
              onClick={() => void runDiag()}
              disabled={!aiReady || diag.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '主编视角：优先级 / 隐藏风险 / 批量建议'}
            >
              {diag.loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {diag.loading ? '诊断中…' : 'AI 综合诊断（优先级 / 隐藏风险 / 批量建议）'}
            </Button>
            {!aiReady && <div className="text-10 text-ink-500 leading-relaxed px-1">{AI_DISABLED_HINT}</div>}

            {diag.error && <div className="text-11 text-danger px-1">{diag.error}</div>}
            {diag.data && (
              <div className="rounded-lg border border-amber/25 bg-amber/5 px-3 py-2.5">
                {renderReport(diag.data.report)}
              </div>
            )}
          </>
  )
}

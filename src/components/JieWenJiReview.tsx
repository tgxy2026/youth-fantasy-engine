/**
 * 颉文姬 · 审读面板（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useJieWenJiModel（组件只收 m）。
 */
import { BookOpen, BookOpenCheck, Loader2, AlertTriangle, CheckCircle2, Sparkles, Flame } from 'lucide-react'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { Button } from './Button'
import { renderReport, SevBadge } from './jieWenJiParts'
import type { JieWenJiModel } from './useJieWenJiModel'

export default function JieWenJiReview({ m }: { m: JieWenJiModel }) {
  const { aiReady, rev, ooc, adv, plea, open, runReview, runOoc, runAdvice, runPleasure, runOpening, aiBtnCls, scoreCls } = m
  return (
          <>
            <Button variant="bare"
              onClick={() => void runReview()}
              disabled={!aiReady || rev.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {rev.loading ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
              {rev.loading ? '审读中…' : '章节编辑意见（节奏 / 钩子 / 水文 / 对话）'}
            </Button>

            {rev.error && <div className="text-11 text-danger px-1">{rev.error}</div>}
            {rev.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-15 font-bold px-2.5 py-0.5 rounded-lg border ${scoreCls(rev.data.score)}`}>{rev.data.score}</span>
                  <span className="text-11 text-ink-100 leading-snug flex-1">{rev.data.verdict}</span>
                </div>
                <div className="space-y-1.5">
                  {rev.data.dimensions.map((d, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-10 text-ink-400 w-16 shrink-0">{d.name}</span>
                      <div className="flex gap-0.5 flex-1">
                        {Array.from({ length: 10 }, (_, j) => (
                          <span key={j} className={`h-1.5 w-2 rounded-xs ${j < d.score ? 'bg-amber' : 'bg-ink-700'}`} />
                        ))}
                      </div>
                      <span className="text-10 text-ink-500 w-5 text-right">{d.score}</span>
                    </div>
                  ))}
                </div>
                {rev.data.highlights.length > 0 && (
                  <div>
                    <div className="text-10 text-success mb-1">亮点</div>
                    <ul className="space-y-1">
                      {rev.data.highlights.map((h, i) => <li key={i} className="text-11 text-ink-200 leading-snug">· {h}</li>)}
                    </ul>
                  </div>
                )}
                {rev.data.warnings.length > 0 && (
                  <div>
                    <div className="text-10 text-amber mb-1">需处理</div>
                    <ul className="space-y-1">
                      {rev.data.warnings.map((w, i) => <li key={i} className="text-11 text-ink-200 leading-snug">· {w}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runOoc()}
              disabled={!aiReady || ooc.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {ooc.loading ? <Loader2 size={12} className="animate-spin" /> : <AlertTriangle size={12} />}
              {ooc.loading ? '检查中…' : 'OOC 人设偏离检查'}
            </Button>

            {ooc.error && <div className="text-11 text-danger px-1">{ooc.error}</div>}
            {ooc.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
                {ooc.data.length === 0 ? (
                  <div className="text-center text-11 text-success py-2"><CheckCircle2 size={13} className="inline mr-1" /> 未发现明显 OOC</div>
                ) : (
                  <div className="space-y-2">
                    {ooc.data.map((f, i) => (
                      <div key={i} className="rounded bg-ink-850 border border-ink-700/70 px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <SevBadge s={f.level} />
                          <span className="text-11 font-medium text-amber">{f.character}</span>
                        </div>
                        {f.evidence && <div className="text-10 text-ink-400 mt-1">原文：{f.evidence}</div>}
                        <div className="text-11 text-ink-100 mt-0.5 leading-snug">{f.issue}</div>
                        {f.suggestion && <div className="text-10 text-amber/80 mt-0.5">→ {f.suggestion}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runAdvice()}
              disabled={!aiReady || adv.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {adv.loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {adv.loading ? '思考中…' : '续写方向（只给思路，不生成正文）'}
            </Button>

            {adv.error && <div className="text-11 text-danger px-1">{adv.error}</div>}
            {adv.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 space-y-2">
                <div>
                  <div className="text-10 text-ink-500 mb-1">方向建议</div>
                  <div className="text-11 text-ink-100 leading-relaxed">{adv.data.direction}</div>
                </div>
                {adv.data.hooks.length > 0 && (
                  <div>
                    <div className="text-10 text-ink-500 mb-1">可用钩子</div>
                    <ul className="space-y-1">
                      {adv.data.hooks.map((h, i) => <li key={i} className="text-11 text-ink-200 leading-snug">· {h}</li>)}
                    </ul>
                  </div>
                )}
                {adv.data.pitfalls.length > 0 && (
                  <div>
                    <div className="text-10 text-amber mb-1">别踩的坑</div>
                    <ul className="space-y-1">
                      {adv.data.pitfalls.map((p, i) => <li key={i} className="text-11 text-ink-200 leading-snug">· {p}</li>)}
                    </ul>
                  </div>
                )}
                {adv.data.foreshadow && (
                  <div>
                    <div className="text-10 text-ink-500 mb-1">伏笔联动</div>
                    <div className="text-11 text-ink-200 leading-snug">{adv.data.foreshadow}</div>
                  </div>
                )}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runPleasure()}
              disabled={!aiReady || plea.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '爽点供给 / 毒点预警 / 代入感与金手指 / 期待感'}
            >
              {plea.loading ? <Loader2 size={12} className="animate-spin" /> : <Flame size={12} />}
              {plea.loading ? '检查中…' : '爽点 / 毒点检查（YY·代入感·金手指）'}
            </Button>

            {plea.error && <div className="text-11 text-danger px-1">{plea.error}</div>}
            {plea.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
                {renderReport(plea.data.report)}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runOpening()}
              disabled={!aiReady || open.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '按「黄金三章」标准检查作品开头'}
            >
              {open.loading ? <Loader2 size={12} className="animate-spin" /> : <BookOpenCheck size={12} />}
              {open.loading ? '检查中…' : '黄金三章检查（开篇定生死）'}
            </Button>

            {open.error && <div className="text-11 text-danger px-1">{open.error}</div>}
            {open.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
                {renderReport(open.data.report)}
              </div>
            )}

            {!aiReady && <div className="text-10 text-ink-500 leading-relaxed px-1">{AI_DISABLED_HINT}</div>}
          </>
  )
}

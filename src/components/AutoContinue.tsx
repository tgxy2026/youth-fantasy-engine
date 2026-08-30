import { useCallback, useRef, useState } from 'react'
import { BookOpen, CheckCircle2, RefreshCw, Square, Sparkles } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import { showToast } from './dialogs'
import HelpPopover from './HelpPopover'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { runAutoContinue, type ContinueStrategy } from '../lib/autoContinue'
import { countWords } from '../lib/textStats'
import type { LedgerItem } from '../lib/settingLedger'

const STRATEGY_META: Record<ContinueStrategy, { label: string; hint: string }> = {
  'add-only': { label: '仅新增', hint: '只补登新设定，已登记的设定一律不动' },
  'confirm': { label: '候选确认', hint: '新设定与疑似重复项列出供你勾选，已登记项不改动' },
  'auto-update': { label: '自动更新', hint: '新设定自动补登，已登记实体的变化追加到备注（不覆盖属性列）' },
}
const STRATEGIES: ContinueStrategy[] = ['add-only', 'confirm', 'auto-update']

function Stepper({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] text-ink-200">{label}</span>
      <div className="flex items-center gap-1 ml-auto">
        <Button variant="toggle" onClick={() => onChange(Math.max(min, value - step))} aria-label="减少">−</Button>
        <span className="w-14 text-center text-ink-100 tabular-nums">{value}</span>
        <Button variant="toggle" onClick={() => onChange(Math.min(max, value + step))} aria-label="增加">+</Button>
      </div>
    </div>
  )
}

export default function AutoContinue() {
  const { ready: aiReady } = useAIReady()
  const [chapters, setChapters] = useState(1)
  const [targetWords, setTargetWords] = useState(4000)
  const [strategy, setStrategy] = useState<ContinueStrategy>('confirm')
  const [intent, setIntent] = useState('')

  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState('')
  const [preview, setPreview] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const [confirm, setConfirm] = useState<{ cands: LedgerItem[]; resolve: (v: LedgerItem[] | null) => void } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const start = useCallback(async () => {
    if (running) return
    if (!aiReady) { showToast('请先在「AI 辅助规划 → 模型设置」配置可用模型', 'error'); return }
    setRunning(true); setPreview(''); setLogs([]); setPhase('准备中')
    const ac = new AbortController(); abortRef.current = ac
    const res = await runAutoContinue(
      { chapters, targetWords, strategy, intent: intent.trim() || undefined },
      {
        signal: ac.signal,
        onPhase: setPhase,
        onBodyToken: (d) => setPreview(p => p + d),
        onLog: (m) => setLogs(l => [...l, m]),
        onSettingsCandidates: (cands) => new Promise<LedgerItem[] | null>((resolve) => {
          setSelected(new Set(cands.filter(c => c.status === 'new').map(c => c.key)))
          setConfirm({ cands, resolve })
        }),
      },
    ).catch((e) => { showToast(e instanceof Error ? e.message : String(e), 'error'); return { created: [] } })
    setRunning(false)
    abortRef.current = null
    if (res.created.length) showToast(`续写完成，新增 ${res.created.length} 章`, 'success')
    else if (!abortRef.current) showToast('未生成章节，请检查模型配置或日志', 'error')
  }, [running, aiReady, chapters, targetWords, strategy, intent])

  const stop = () => {
    abortRef.current?.abort()
    // 若正卡在「设定补登确认」弹窗，直接跳过以解除挂起（否则 runAutoContinue 永远 await）
    if (confirm) { confirm.resolve(null); setConfirm(null); setSelected(new Set()) }
    setPhase('已停止（正在收尾…）')
  }

  const confirmApply = () => {
    if (!confirm) return
    const chosen = confirm.cands.filter(c => selected.has(c.key))
    confirm.resolve(chosen)
    setConfirm(null); setSelected(new Set())
  }
  const confirmSkip = () => {
    if (!confirm) return
    confirm.resolve(null)
    setConfirm(null); setSelected(new Set())
  }

  return (
    <>
      <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
        <h2 className="text-[13px] font-semibold text-ink-100 mb-4 flex items-center gap-2">
          <BookOpen size={14} className="text-amber" /> AI 一键续写 + 设定补完
          <HelpPopover title="AI 一键续写怎么用" width="24rem" className="ml-auto">
            {'基于项目已有设定与正文，AI 自动续写新章节并抽取补登设定。\n\n流程：读上下文 → 续写一章 → 编辑自检（连续性/人设/伏笔，命中则改写）→ 抽取并补登设定 → 重复直到完成。\n\n· 章节数 1–5、每章 2000–8000 汉字（按汉字数计）。\n· 已有设定更新策略：仅新增（最稳）/ 候选确认（默认）/ 自动更新。\n· 选「候选确认」时，每章抽取到的待补登项会弹窗让你勾选。\n· 章节顺序由系统自动派生，与标题无关，不会串行。'}
          </HelpPopover>
        </h2>

        <div className="space-y-3">
          <Stepper label="续写章节数" value={chapters} min={1} max={5} step={1} onChange={setChapters} />
          <Stepper label="每章字数（汉字）" value={targetWords} min={2000} max={8000} step={500} onChange={setTargetWords} />

          <div>
            <div className="text-[13px] text-ink-200 mb-1.5">已有设定更新策略</div>
            <div className="flex gap-1.5">
              {STRATEGIES.map(s => (
                <Button key={s} variant="toggle" selected={strategy === s} className="flex-1"
                  onClick={() => setStrategy(s)} title={STRATEGY_META[s].hint}>
                  {STRATEGY_META[s].label}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[13px] text-ink-200 mb-1.5">情节概要（可选，不填则 AI 自由发挥）</div>
            <AutoTextarea value={intent} onChange={setIntent} minHeight={60} maxHeight={160}
              placeholder="例如：陈渊在秘境深处发现上古遗迹，意外获得一卷残破功法……" />
          </div>

          <div className="flex items-center gap-2 pt-1">
            {!running ? (
              <Button variant="primary" onClick={start} disabled={!aiReady}>
                <Sparkles size={14} className="mr-1" /> 开始续写
              </Button>
            ) : (
              <Button variant="danger" onClick={stop}>
                <Square size={13} className="mr-1" /> 停止
              </Button>
            )}
            {!aiReady && <span className="text-[11px] text-amber">{AI_DISABLED_HINT}</span>}
          </div>

          {phase && (
            <div className="flex items-center gap-2 text-[12px] text-ink-300">
              {!running ? (
                phase.startsWith('✓') ? <CheckCircle2 size={13} className="text-emerald-400 shrink-0" /> : <CheckCircle2 size={13} className="text-ink-500 shrink-0" />
              ) : (
                <RefreshCw size={12} className="animate-spin shrink-0" />
              )} {phase}
            </div>
          )}

          {preview && (
            <div className="mt-2">
              <div className="text-[12px] text-ink-400 mb-1">实时正文预览（{countWords(preview)} 字 · 汉字计）</div>
              <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 p-3 text-[13px] leading-relaxed text-ink-100">
                {preview}
              </div>
            </div>
          )}

          {logs.length > 0 && (
            <div className="mt-2 space-y-1 rounded-lg border border-ink-700 bg-ink-900 p-3">
              {logs.map((l, i) => (
                <div key={i} className="text-[12px] text-ink-300">{l}</div>
              ))}
            </div>
          )}
        </div>
      </section>

      <Modal open={!!confirm} onClose={confirmSkip} title="设定补登确认" width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={confirmSkip}>跳过</Button>
            <Button variant="primary" onClick={confirmApply}>确认补登（{selected.size}）</Button>
          </>
        }>
        <p className="text-[12px] text-ink-400 mb-3">勾选要补登到设定表 / 角色卡的条目。绿色=新设定，黄色=疑似已存在需你确认；已登记项不会改动。</p>
        <div className="max-h-80 overflow-auto space-y-2">
          {confirm?.cands.map(c => (
            <label key={c.key} className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900 p-2 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={selected.has(c.key)}
                onChange={(e) => setSelected(prev => {
                  const next = new Set(prev); e.target.checked ? next.add(c.key) : next.delete(c.key); return next
                })} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-ink-50 font-medium">{c.name}</span>
                  <span className="text-[11px] text-ink-400">{c.type}</span>
                  <span className={`text-[11px] px-1 rounded ${c.status === 'new' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'}`}>
                    {c.status === 'new' ? '新设定' : '疑似重复'}
                  </span>
                </div>
                {c.desc && <div className="text-[12px] text-ink-300 mt-0.5 break-words">{c.desc}</div>}
              </div>
            </label>
          ))}
        </div>
      </Modal>
    </>
  )
}

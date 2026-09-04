import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Check, CheckCircle2, RefreshCw, RotateCcw, Square, Sparkles } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import { showToast } from './dialogs'
import HelpPopover from './HelpPopover'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import * as db from '../lib/db'
import {
  runAutoContinue, WORD_TOLERANCE, DEAI_TEMPLATES,
  type ContinueStrategy, type ChapterDraft, type DraftDecision, type DeAiTemplate,
} from '../lib/autoContinue'
import { countWords } from '../lib/textStats'
import type { LedgerItem } from '../lib/settingLedger'

const STRATEGY_META: Record<ContinueStrategy, { label: string; hint: string }> = {
  'add-only': { label: '仅限新增', hint: '只补登新设定，已登记的设定一律不动' },
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
        <Button variant="toggle" onClick={() => onChange(Math.max(min, value - step))} aria-label="减少" className="h-7 w-7 rounded-lg text-[15px] leading-none">−</Button>
        <span className="w-14 text-center text-ink-100 tabular-nums">{value}</span>
        <Button variant="toggle" onClick={() => onChange(Math.min(max, value + step))} aria-label="增加" className="h-7 w-7 rounded-lg text-[15px] leading-none">+</Button>
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
  // 去 AI 味儿：默认开启，内置提示词库可切换，自定义时可粘贴自己的去味儿提示词
  const [deAiOn, setDeAiOn] = useState(true)
  const [deAiTpl, setDeAiTpl] = useState<DeAiTemplate['id']>('natural')
  const [deAiCustom, setDeAiCustom] = useState('')
  const deAiPrompt = deAiTpl === 'custom' ? deAiCustom.trim() : (DEAI_TEMPLATES.find(t => t.id === deAiTpl)?.prompt ?? '')

  // 永久保存：去味偏好（含自定义提示词）写入 db.meta，跨会话/跨项目保留
  const deAiLoaded = useRef(false)
  useEffect(() => {
    (async () => {
      const saved = await db.getMeta<{ enabled?: boolean; template?: DeAiTemplate['id']; custom?: string }>('deAiPrefs', {})
      if (typeof saved.enabled === 'boolean') setDeAiOn(saved.enabled)
      if (saved.template) setDeAiTpl(saved.template)
      if (typeof saved.custom === 'string') setDeAiCustom(saved.custom)
      deAiLoaded.current = true
    })()
  }, [])
  useEffect(() => {
    if (!deAiLoaded.current) return
    db.setMeta('deAiPrefs', { enabled: deAiOn, template: deAiTpl, custom: deAiCustom })
  }, [deAiOn, deAiTpl, deAiCustom])

  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState('')
  const [preview, setPreview] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const abortRef = useRef<AbortController | null>(null)

  // 每章初稿裁决弹窗
  const [draft, setDraft] = useState<{ d: ChapterDraft; resolve: (v: DraftDecision) => void } | null>(null)
  // 设定补登确认弹窗（B 策略）
  const [confirm, setConfirm] = useState<{ cands: LedgerItem[]; resolve: (v: LedgerItem[] | null) => void } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const start = useCallback(async () => {
    if (running) return
    if (!aiReady) { showToast('请先在「AI 辅助规划 → 模型设置」配置可用模型', 'error'); return }
    setRunning(true); setPreview(''); setLogs([]); setPhase('准备中')
    const ac = new AbortController(); abortRef.current = ac
    const res = await runAutoContinue(
      {
        chapters, targetWords, strategy, intent: intent.trim() || undefined,
        deAi: { enabled: deAiOn, prompt: deAiPrompt },
      },
      {
        signal: ac.signal,
        onPhase: setPhase,
        onBodyToken: (d) => setPreview(p => p + d),
        onBodyReplace: (full) => setPreview(full),
        onLog: (m) => setLogs(l => [...l, m]),
        onChapterDraft: (d) => new Promise<DraftDecision>((resolve) => setDraft({ d, resolve })),
        onSettingsCandidates: (cands) => new Promise<LedgerItem[] | null>((resolve) => {
          setSelected(new Set(cands.filter(c => c.status === 'new').map(c => c.key)))
          setConfirm({ cands, resolve })
        }),
      },
    ).catch((e) => { showToast(e instanceof Error ? e.message : String(e), 'error'); return { created: [] } })
    const wasStopped = ac.signal.aborted
    setRunning(false)
    abortRef.current = null
    if (res.created.length) showToast(`续写完成，新增 ${res.created.length} 章`, 'success')
    else if (!wasStopped) showToast('未生成章节，请检查模型配置或日志', 'error')
  }, [running, aiReady, chapters, targetWords, strategy, intent, deAiOn, deAiPrompt])

  const stop = () => {
    abortRef.current?.abort()
    // 解除所有挂起的弹窗 Promise，否则 runAutoContinue 会永远 await、按钮一直转圈
    if (draft) { draft.resolve('abort'); setDraft(null) }
    if (confirm) { confirm.resolve(null); setConfirm(null); setSelected(new Set()) }
    setPhase('已停止（正在收尾…）')
  }

  const decide = (v: DraftDecision) => {
    if (!draft) return
    draft.resolve(v)
    setDraft(null)
    if (v === 'accept') setPhase('已采纳，进入审查与设定补登…')
    else if (v === 'rewrite') setPhase('已弃用本稿，重新生成…')
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

  const dLo = draft ? draft.d.target - WORD_TOLERANCE : 0
  const dHi = draft ? draft.d.target + WORD_TOLERANCE : 0
  const dOk = draft ? draft.d.words >= dLo && draft.d.words <= dHi : false

  return (
    <>
      <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
        <h2 className="text-[13px] font-semibold text-ink-100 mb-4 flex items-center gap-2">
          <BookOpen size={14} className="text-amber" /> AI 一键续写 + 设定补完
          <HelpPopover title="AI 一键续写怎么用" width="24rem" className="ml-auto">
            {`基于项目已有设定与最新一章正文，AI 续写新章节并抽取补登设定。\n\n每章流程：读上下文（含上一章结尾）→ 续写初稿 → 字数校准 →（开启时）去 AI 味儿润色 → 你确认采纳/重写 → 编辑自检（连续性/人设/伏笔，命中则改写）→ 抽取补登设定 → 进入下一章。\n\n· 章节数 1–5、每章 2000–8000 汉字（按汉字数计，容差 ±${WORD_TOLERANCE}）。\n· 不填情节概要时，AI 会严格承接上一章结尾往下写，并参考最近 3 章的章节摘要把握整体走向，不另起新线。\n· 续写时会参考：上一章结尾（约 1200 字）+ 最近 3 章摘要 + 项目全部设定资料。\n· 去 AI 味儿：内置 3 套润色提示词（口语化 / 网文化 / 去套路，可自定义），生成初稿后自动润色再去弹窗，去掉 AI 套话。\n· 已有设定更新策略：仅限新增（最稳）/ 候选确认（默认）/ 自动更新。\n· 每章初稿会弹窗让你决定「采纳」或「重写」，重写不会留下垃圾章节。\n· 章节顺序由系统自动派生，与标题无关，不会错乱。`}
          </HelpPopover>
        </h2>

        <div className="space-y-3">
          <Stepper label="续写章节数" value={chapters} min={1} max={5} step={1} onChange={setChapters} />
          <Stepper label={`每章字数（汉字，±${WORD_TOLERANCE}）`} value={targetWords} min={2000} max={8000} step={500} onChange={setTargetWords} />

          <div>
            <div className="text-[13px] text-ink-200 mb-1.5">已有设定更新策略</div>
            <div className="flex flex-wrap gap-1.5">
              {STRATEGIES.map(s => (
                <Button key={s} variant="toggle" selected={strategy === s}
                  onClick={() => setStrategy(s)} title={STRATEGY_META[s].hint}
                  className="px-3 h-8 rounded-lg text-[12px]">
                  {STRATEGY_META[s].label}
                </Button>
              ))}
            </div>
          </div>

          {/* 去 AI 味儿：生成前的前置选项，放在策略下边，点「开始续写」前可手动调整 */}
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
            <div className="flex items-center justify-between">
              <div className="text-[13px] text-ink-200">生成后自动「去 AI 味儿」</div>
              <Button variant="toggle" selected={deAiOn} onClick={() => setDeAiOn(v => !v)}
                className="px-3 h-8 rounded-lg text-[12px]" title="开启后，AI 每章初稿会先按所选提示词润色一遍，再去弹窗交你裁决">
                {deAiOn ? '已开启' : '已关闭'}
              </Button>
            </div>
            {deAiOn && (
              <div className="mt-2.5 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {DEAI_TEMPLATES.map(t => (
                    <Button key={t.id} variant="toggle" selected={deAiTpl === t.id}
                      onClick={() => setDeAiTpl(t.id)} title={t.desc}
                      className="px-3 h-8 rounded-lg text-[12px]">
                      {t.label}
                    </Button>
                  ))}
                </div>
                {deAiTpl === 'custom' && (
                  <AutoTextarea value={deAiCustom} onChange={setDeAiCustom} minHeight={50} maxHeight={140}
                    placeholder="粘贴你自己的去 AI 味儿提示词（例如：去掉说教感，多用短句……）" />
                )}
                <p className="text-[11px] text-ink-500 leading-relaxed">
                  内置 3 套去味儿提示词（即网络上常见「去 AI 味儿 skill」的本地化版本），可切换或自定义。润色异常时自动保留原稿。
                </p>
              </div>
            )}
          </div>

          <div>
            <div className="text-[13px] text-ink-200 mb-1.5">情节概要（可选，不填则承接上一章自然延续）</div>
            <AutoTextarea value={intent} onChange={setIntent} minHeight={60} maxHeight={160}
              placeholder="例如：陈渊在秘境深处发现上古遗迹，意外获得一卷残破功法……" />
            <p className="mt-1.5 text-[11px] text-ink-500 leading-relaxed">
              小提示：续写前，若先对前几章正文通读梳理一遍（或在编辑器里重生成章节压缩摘要），能让 AI 更好地承接剧情、衔接更流畅自然。
            </p>
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
                <CheckCircle2 size={13} className={`shrink-0 ${phase.startsWith('✓') ? 'text-emerald-400' : 'text-ink-500'}`} />
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

      {/* ============ 每章初稿裁决 ============ */}
      <Modal open={!!draft} onClose={() => decide('abort')} width="2xl"
        title={draft ? `第 ${draft.d.index}/${draft.d.total} 章初稿${draft.d.attempt > 1 ? `（第 ${draft.d.attempt} 稿）` : ''}` : '本章初稿'}
        footer={
          <>
            <Button variant="ghost" onClick={() => decide('abort')}>停止任务</Button>
            <Button variant="secondary" onClick={() => decide('rewrite')}>
              <RotateCcw size={13} className="mr-1" /> 重写本章
            </Button>
            <Button variant="primary" solid onClick={() => decide('accept')}>
              <Check size={14} className="mr-1" /> 采纳本章
            </Button>
          </>
        }>
        {draft && (
          <>
            <div className="mb-3 flex items-center gap-3 text-[12px]">
              <span className={dOk ? 'text-emerald-400' : 'text-amber'}>
                {draft.d.words} 汉字 {dOk ? '· 已达标' : '· 超出容差'}
              </span>
              <span className="text-ink-500">目标 {draft.d.target} ± {WORD_TOLERANCE}（{dLo}~{dHi}）</span>
              {deAiOn && <span className="text-ink-300 border border-ink-700 rounded px-1.5 py-0.5">已去 AI 味儿</span>}
            </div>
            <p className="text-[12px] text-ink-400 mb-3">
              你看到的已是「去 AI 味儿」润色后的稿子。采纳后 AI 才会继续做编辑自检、修正与设定补登；点「重写本章」会丢弃本稿重新生成（含重新润色，不会留下垃圾章节，也不会写入数据库）。
            </p>
            <div className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 p-3.5 text-[13.5px] leading-[1.9] text-ink-100">
              {draft.d.body}
            </div>
          </>
        )}
      </Modal>

      {/* ============ 设定补登确认（候选确认策略） ============ */}
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

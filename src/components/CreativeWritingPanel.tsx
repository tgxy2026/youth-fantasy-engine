/**
 * 「创意写作」页签 —— 全自动 AI 创作工作流的界面。
 *
 * 三个可见阶段 + 两个**人工闸门**（方案见 `docs/2.2.0-全自动AI小说创作工作流方案.md`）：
 *   设定奠基 →「闸门 · 设定：勾选要落库的设定」→ 分卷大纲 →「闸门 · 大纲：确认大纲」→ 逐章连写
 *
 * 两个闸门是刻意留的：AI 生成设定/大纲的质量波动必须由人过一眼再落库 —— 人定方向，AI 跑量。
 * 闸门用 Promise 实现（编排器 await 在那里等），所以本组件只需在点击时 resolve 掉它。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Play, Sparkles, Square } from 'lucide-react'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import DraftReviewPanel from './DraftReviewPanel'
import HelpPopover from './HelpPopover'
import InterviewChat from './InterviewChat'
import WorkflowTimeline from './WorkflowTimeline'
import { showToast } from './dialogs'
import { aiChatJson, loadActiveId, loadProviders, type AIProvider } from '../lib/ai'
import { runCreativeWriting, type CreativeResume, type CreativeWritingResult } from '../lib/aiWorkflow'
import type { OutlineResult } from '../lib/aiTasks'
import { CREATIVE_SEED_SPEC, seedFromFilled } from '../lib/creativeSeed'
import type { DraftBundle, DraftRow, FlowProgress } from '../lib/flow/types'
import { adviseCapacity, type CapacityAdvice } from '../lib/modelCapacity'
import { getTavernSettings } from '../lib/tavern/settings'
import { MAX_CHAPTERS, advisePace, type PaceAdvice } from '../lib/writingPace'

const NUM_INPUT = 'w-20 rounded bg-ink-900 border border-ink-700 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50'

export default function CreativeWritingPanel() {
  const [seed, setSeed] = useState('')
  const [chapters, setChapters] = useState(10)
  const [words, setWords] = useState(2500)
  const [volumes, setVolumes] = useState(1)
  const [progress, setProgress] = useState<FlowProgress | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [bibleGate, setBibleGate] = useState<DraftBundle | null>(null)
  const [outlineGate, setOutlineGate] = useState<OutlineResult | null>(null)
  const [result, setResult] = useState<CreativeWritingResult | null>(null)
  const [interview, setInterview] = useState(false)
  const [cap, setCap] = useState<CapacityAdvice | null>(null)
  /** 被中止后拿到的续跑信息（存住它 → 显示「继续写作」；闸门处主动放弃不会产生它） */
  const [resume, setResume] = useState<CreativeResume | null>(null)
  const gateRef = useRef<((v: unknown) => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** 阶段产物摘要：detail 会在下一阶段开始时被覆盖，所以在"完成那一刻"抓一次存下来 */
  const summariesRef = useRef<Record<string, string>>({})

  const openGate = <T,>(setter: (v: T) => void) => (payload: T) =>
    new Promise<unknown>(resolve => {
      gateRef.current = resolve
      setter(payload)
    })

  // 模型能力（只读一次）：换算成「推荐章数 + 预计耗时」。
  // 🔴 口径见 writingPace.ts —— 连写是一章一次调用、单章只带设定与最近摘要，
  //    **不受模型窗口限制**，受限的是总耗时。
  useEffect(() => {
    void (async () => {
      try {
        const [providers, activeId, tav] = await Promise.all([
          loadProviders().catch(() => [] as AIProvider[]),
          loadActiveId().catch(() => null),
          getTavernSettings().catch(() => null),
        ])
        const p = providers.find(x => x.id === activeId) ?? null
        setCap(adviseCapacity(p, { numCtx: tav?.common.numCtx ?? 32768, contextBudget: tav?.common.contextBudget ?? 24000 }))
      } catch { /* 拿不到模型信息就不显示推荐，不影响创作本身 */ }
    })()
  }, [])

  const pace: PaceAdvice | null = useMemo(
    () => (cap ? advisePace(cap, { chapters, targetWords: words }) : null),
    [cap, chapters, words],
  )

  const start = async (fromScratch = false) => {
    if (!seed.trim()) { showToast('请先用一句话说清你想写什么', 'info'); return }
    const ctl = new AbortController()
    abortRef.current = ctl
    // 「从头重写」= 丢掉断点；否则有断点就从断点接着写
    const useResume = fromScratch ? null : resume
    if (fromScratch) setResume(null)
    /** 本次运行是否交回了续跑信息（用局部变量判定，setState 是异步的、闭包里的 resume 还是旧值） */
    let gotResume: CreativeResume | null = null
    setRunning(true); setResult(null); setLog([]); setProgress(null); setSummaries({})
    summariesRef.current = {}
    try {
      const res = await runCreativeWriting(seed, {
        chapters, targetWords: words, volumes,
        signal: ctl.signal,
        ...(useResume ? { resume: useResume } : {}),
        onResume: r => { gotResume = r; setResume(r) },
        onProgress: p => {
          setProgress(p)
          // 抓"刚完成那一刻"的 detail 当阶段产物摘要（下一阶段一开跑就会把它覆盖掉）
          const next = { ...summariesRef.current }
          let changed = false
          for (const s of p.stages) {
            if (s.status === 'done' && s.detail && !next[s.id]) {
              next[s.id] = s.detail.replace(/…$/, '')
              changed = true
            }
          }
          if (changed) { summariesRef.current = next; setSummaries(next) }
        },
        onBibleGate: openGate(setBibleGate) as (b: DraftBundle) => Promise<DraftRow[] | null>,
        onOutlineGate: openGate(setOutlineGate) as (o: OutlineResult) => Promise<boolean | 'outline-only'>,
        onChapterSaved: ch => setLog(l => [...l, `✅ 第${ch.no}章 ${ch.title}`]),
      })
      if (!res) {
        // 有续跑信息 = 被中止（可以接着写）；没有 = 在闸门处主动放弃，就别再劝他继续了
        showToast(
          gotResume ? '已中止 —— 可点「继续写作」接着写，已写完的章不会重写' : '已中止，未留下半成品',
          'info',
        )
        return
      }
      setResult(res)
      setResume(null) // 跑完了，断点作废（下次是从头开始的新任务）
      showToast(
        res.outlineOnly ? '大纲已保存 —— 按你的选择，没有写正文' : `创作完成：写了 ${res.chapters.length} 章`,
        'success',
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/放弃/.test(msg)) showToast('已放弃本次创作（未写入任何数据）', 'info')
      else showToast('创作失败：' + msg, 'error')
    } finally {
      setRunning(false)
      abortRef.current = null
      gateRef.current = null
      setBibleGate(null); setOutlineGate(null)
    }
  }

  /** 关掉闸门并把用户的决定交回编排器 */
  const resolveGate = (v: unknown) => {
    const r = gateRef.current
    gateRef.current = null
    setBibleGate(null); setOutlineGate(null)
    r?.(v)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-15 font-medium text-ink-100">创意写作</h1>
        <HelpPopover title="创意写作怎么用" pin>
          <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
            <p>给一句话想法，AI 依次完成：<b>设定奠基 → 分卷大纲 → 逐章连写</b>（审校闭环、伏笔自动更新在后续阶段）。</p>
            <p>两个<b>人工闸门</b>：设定草稿与大纲都必须你确认后才落库、才继续 —— 人定方向，AI 跑量。</p>
            <p>只想先要大纲、暂不写正文：在「闸门 · 大纲」选<b>「只保存大纲」</b>即可，之后正文可以自己写、也可以随时回来补写。</p>
            <p>落库只发生在闸门通过之后；在任何闸门处「放弃」，都不会留下半成品。</p>
            <p className="text-ink-500">想法还说不清时点<b>「对话引导」</b>：AI 按「题材 → 主角 → 冲突 → 世界」一路问，聊完自动把要点填回输入框。</p>
            <p className="text-ink-500">连写阶段用的是「AI 一键续写」那套（含字数校准与落库硬闸门），并按已落库的《章节细纲》逐章推进。</p>
            <AIDataSourceNote feature="creative-writing" compact />
          </div>
        </HelpPopover>
      </div>

      {/* 想法与参数 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-100">一句话想法</span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={running} onClick={() => setInterview(true)}>
            <Sparkles size={11} /> 对话引导
          </Button>
        </div>
        <textarea
          value={seed}
          onChange={e => setSeed(e.target.value)}
          disabled={running}
          spellCheck={false}
          placeholder="例：一个靠吞噬他人修为续命的少年，在正道与魔道之间越走越深。"
          className="mt-2 h-24 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-12 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-11 text-ink-400">
          <label className="flex items-center gap-1.5">卷数
            <input type="number" min={1} max={8} value={volumes} disabled={running}
              onChange={e => setVolumes(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className={NUM_INPUT} />
          </label>
          <label className="flex items-center gap-1.5">连写章数
            <input type="number" min={1} max={MAX_CHAPTERS} value={chapters} disabled={running}
              onChange={e => setChapters(Math.max(1, Math.min(MAX_CHAPTERS, Number(e.target.value) || 1)))} className={NUM_INPUT} />
          </label>
          <label className="flex items-center gap-1.5">每章目标字数
            <input type="number" min={800} max={8000} step={100} value={words} disabled={running}
              onChange={e => setWords(Math.max(800, Math.min(8000, Number(e.target.value) || 2500)))} className={NUM_INPUT} />
          </label>
        </div>
        {pace && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span title={pace.model} className={`text-10 leading-relaxed ${pace.level === 'ok' ? 'text-ink-500' : 'text-amber'}`}>
              {pace.note}
            </span>
            {chapters !== pace.recommendedChapters && (
              <Button size="xs" variant="secondary" onClick={() => setChapters(pace.recommendedChapters)}>
                用推荐值（{pace.recommendedChapters} 章）
              </Button>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={running || !seed.trim()} onClick={() => void start()}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {running ? '创作中…' : resume ? '继续写作' : '开始创作'}
          </Button>
          {!running && resume && (
            <Button size="sm" variant="secondary" onClick={() => void start(true)}>
              从头重写（丢弃断点）
            </Button>
          )}
          {running && (
            <Button size="sm" variant="danger" onClick={() => abortRef.current?.abort()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {running && <span className="text-11 text-ink-400">{progress?.message ?? ''}</span>}
        </div>
        {!running && resume && (
          <div className="mt-1 text-11 leading-relaxed text-ink-400">
            上次中止在：{resume.label}。点「继续写作」从断点接着写，
            <b className="text-ink-300">已落库的章不会重写</b>；
            <span className="text-ink-500">改了「连写章数」会令断点失效（自动从头跑），避免剩余章数算错。</span>
          </div>
        )}
        <div className="mt-1.5 text-10 leading-relaxed text-ink-500">
          连写会在当前项目的现有章节之后接着写，随时可中止；写完去「正文编辑」逐章审阅。
        </div>
      </section>

      {/* 阶段进度：竖向节点时间线（跑完保留 —— 事后能看到每一步做了什么、花了多久、产出多少） */}
      <WorkflowTimeline progress={progress} running={running} summaries={summaries} className="mt-2" />

      {/* 闸门 · 设定：设定草稿 */}
      {bibleGate && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 设定</span>
            <span className="text-13 text-ink-100">确认设定草稿</span>
            <span className="text-11 text-ink-500">
              只有勾选的条目会落库；可以改名称、也可以直接舍弃不要的
            </span>
            <div className="flex-1" />
            <Button size="xs" variant="secondary" onClick={() => resolveGate(null)}>放弃本次创作</Button>
          </div>
          <DraftReviewPanel
            bundle={bibleGate}
            onConfirm={rows => resolveGate(rows)}
            confirmText="确认设定"
          />
        </div>
      )}

      {/* 闸门 · 大纲 */}
      {outlineGate && (
        <section className="mt-4 rounded-lg border border-amber/40 bg-ink-800/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 大纲</span>
            <span className="text-13 text-ink-100">
              确认分卷大纲（{outlineGate.volumes.length} 卷 / {outlineGate.chapters.length} 章）
            </span>
            <div className="flex-1" />
            <Button size="xs" variant="secondary" onClick={() => resolveGate(false)}>放弃本次创作</Button>
            <Button size="sm" variant="secondary" onClick={() => resolveGate('outline-only')}>
              只保存大纲（不写正文）
            </Button>
            <Button size="sm" variant="primary" solid onClick={() => resolveGate(true)}>
              保存大纲并开始连写
            </Button>
          </div>

          {outlineGate.volumes.map(v => (
            <div key={v.title} className="mb-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
              <div className="text-12 text-ink-100">《{v.title}》</div>
              {v.positioning && <div className="mt-0.5 text-11 text-ink-300">{v.positioning}</div>}
              {v.events && <div className="mt-0.5 text-10 text-ink-500">事件链：{v.events}</div>}
              {v.ending && <div className="mt-0.5 text-10 text-ink-500">卷末：{v.ending}</div>}
            </div>
          ))}

          <div className="mt-2 max-h-72 overflow-y-auto rounded border border-ink-700 bg-ink-900/40">
            <ul>
              {outlineGate.chapters.map(c => (
                <li key={c.no} className="border-b border-ink-700/40 px-3 py-1.5 last:border-0">
                  <div className="text-11 text-ink-200">第{c.no}章 {c.title}</div>
                  {c.event && <div className="text-10 text-ink-400">{c.event}</div>}
                  {c.hook && <div className="text-10 text-ink-500">章末钩子：{c.hook}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-2 text-10 leading-relaxed text-ink-500">
            确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，然后按细纲逐章连写正文；同名卷/细纲不会重复创建。
          </div>
        </section>
      )}

      {/* 连写日志 */}
      {log.length > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          {log.map((l, i) => (
            <div key={i} className="text-11 text-ink-300">{l}</div>
          ))}
        </div>
      )}

      {/* 结果 */}
      {result && (
        <section className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="text-13 text-emerald-300">创作完成</div>
          <ul className="mt-1.5 space-y-0.5 text-11 text-ink-300">
            <li>设定：{result.bible.stats.total} 条草稿
              {result.bibleCommit && ` → 新建 ${result.bibleCommit.created} 条${result.bibleCommit.updated ? `、更新 ${result.bibleCommit.updated} 条` : ''}`}
            </li>
            <li>大纲：{result.outline.volumes.length} 卷 / {result.outline.chapters.length} 章
              {result.outlineCommit && ` → 新建 ${result.outlineCommit.volumesCreated} 卷、${result.outlineCommit.volumeCardsCreated} 份分卷大纲、${result.outlineCommit.chapterCardsCreated} 份章节细纲`}
            </li>
            <li>
              {result.outlineOnly
                ? '正文：按你的选择只出大纲，未写正文'
                : `正文：${result.chapters.length} 章已落库`}
            </li>
          </ul>
          <div className="mt-1.5 text-10 text-ink-500">
            {result.outlineOnly
              ? '设定与大纲已落库（角色管理 / 世界构建 / 大纲规划）；想写正文时把连写章数改成要写的量、再跑一次即可。'
              : '去「正文编辑」看正文；设定与大纲分别在对应页签（角色管理 / 世界构建 / 大纲规划）。'}
          </div>
        </section>
      )}

      {/* 对话引导：聊完把要点拼回「一句话想法」 */}
      {interview && (
        <InterviewChat
          subject={CREATIVE_SEED_SPEC.subject}
          spec={CREATIVE_SEED_SPEC}
          existing={seed.trim() || undefined}
          callChat={(msgs, opts) => aiChatJson(msgs, { signal: opts.signal })}
          onClose={() => setInterview(false)}
          onApply={filled => {
            const text = seedFromFilled(filled)
            if (text) setSeed(text)
            setInterview(false)
            showToast('已填入想法 —— 生成的是要点提纲，改完再开始创作')
          }}
          applyLabel="填入想法"
        />
      )}
    </div>
  )
}

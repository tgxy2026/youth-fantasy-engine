/**
 * 「创意写作」页签 —— 全自动 AI 创作工作流的界面。
 *
 * 三个可见阶段 + 两个**人工闸门**（方案见 `docs/2.2.0-全自动AI小说创作工作流方案.md`）：
 *   ①设定奠基 →「闸门①：勾选要落库的设定」→ ②分卷大纲 →「闸门②：确认大纲」→ ③逐章连写
 *
 * 两个闸门是刻意留的：AI 生成设定/大纲的质量波动必须由人过一眼再落库 —— 人定方向，AI 跑量。
 * 闸门用 Promise 实现（编排器 await 在那里等），所以本组件只需在点击时 resolve 掉它。
 */
import { useRef, useState } from 'react'
import { Loader2, Play, Square } from 'lucide-react'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import DraftReviewPanel from './DraftReviewPanel'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import { runCreativeWriting, type CreativeWritingResult } from '../lib/aiWorkflow'
import type { OutlineResult } from '../lib/aiTasks'
import type { DraftBundle, DraftRow, FlowProgress, StageStatus } from '../lib/flow/types'

const STAGE_MARK: Record<StageStatus, string> = {
  pending: '○', running: '◐', done: '●', skipped: '－', failed: '✕', cancelled: '×',
}
const STAGE_CLS: Record<StageStatus, string> = {
  pending: 'text-ink-600', running: 'text-amber', done: 'text-emerald-400',
  skipped: 'text-ink-600', failed: 'text-red-400', cancelled: 'text-ink-600',
}

const NUM_INPUT = 'w-20 rounded bg-ink-900 border border-ink-700 px-2 py-1 text-[12px] text-ink-100 outline-none focus:border-amber/50'

export default function CreativeWritingPanel() {
  const [seed, setSeed] = useState('')
  const [chapters, setChapters] = useState(10)
  const [words, setWords] = useState(2500)
  const [volumes, setVolumes] = useState(1)
  const [progress, setProgress] = useState<FlowProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [bibleGate, setBibleGate] = useState<DraftBundle | null>(null)
  const [outlineGate, setOutlineGate] = useState<OutlineResult | null>(null)
  const [result, setResult] = useState<CreativeWritingResult | null>(null)
  const gateRef = useRef<((v: unknown) => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const openGate = <T,>(setter: (v: T) => void) => (payload: T) =>
    new Promise<unknown>(resolve => {
      gateRef.current = resolve
      setter(payload)
    })

  const start = async () => {
    if (!seed.trim()) { showToast('请先用一句话说清你想写什么', 'info'); return }
    const ctl = new AbortController()
    abortRef.current = ctl
    setRunning(true); setResult(null); setLog([]); setProgress(null)
    try {
      const res = await runCreativeWriting(seed, {
        chapters, targetWords: words, volumes,
        signal: ctl.signal,
        onProgress: setProgress,
        onBibleGate: openGate(setBibleGate) as (b: DraftBundle) => Promise<DraftRow[] | null>,
        onOutlineGate: openGate(setOutlineGate) as (o: OutlineResult) => Promise<boolean>,
        onChapterSaved: ch => setLog(l => [...l, `✅ 第${ch.no}章 ${ch.title}`]),
      })
      if (!res) { showToast('已中止，未留下半成品', 'info'); return }
      setResult(res)
      showToast(`创作完成：写了 ${res.chapters.length} 章`, 'success')
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
        <h1 className="text-[15px] font-medium text-ink-100">创意写作</h1>
        <HelpPopover title="创意写作怎么用" pin>
          <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-300">
            <p>给一句话想法，AI 依次完成：<b>设定奠基 → 分卷大纲 → 逐章连写</b>（审校闭环、伏笔自动更新在后续阶段）。</p>
            <p>两个<b>人工闸门</b>：设定草稿与大纲都必须你确认后才落库、才继续 —— 人定方向，AI 跑量。</p>
            <p>落库只发生在闸门通过之后；在任何闸门处「放弃」，都不会留下半成品。</p>
            <p className="text-ink-500">连写阶段用的是「AI 一键续写」那套（含字数校准与落库硬闸门），并按已落库的《章节细纲》逐章推进。</p>
            <AIDataSourceNote feature="creative-writing" compact />
          </div>
        </HelpPopover>
      </div>

      {/* ① 想法与参数 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="text-[13px] text-ink-100">① 一句话想法</div>
        <textarea
          value={seed}
          onChange={e => setSeed(e.target.value)}
          disabled={running}
          spellCheck={false}
          placeholder="例：一个靠吞噬他人修为续命的少年，在正道与魔道之间越走越深。"
          className="mt-2 h-24 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-ink-400">
          <label className="flex items-center gap-1.5">卷数
            <input type="number" min={1} max={8} value={volumes} disabled={running}
              onChange={e => setVolumes(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className={NUM_INPUT} />
          </label>
          <label className="flex items-center gap-1.5">连写章数
            <input type="number" min={1} max={60} value={chapters} disabled={running}
              onChange={e => setChapters(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} className={NUM_INPUT} />
          </label>
          <label className="flex items-center gap-1.5">每章目标字数
            <input type="number" min={800} max={8000} step={100} value={words} disabled={running}
              onChange={e => setWords(Math.max(800, Math.min(8000, Number(e.target.value) || 2500)))} className={NUM_INPUT} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={running || !seed.trim()} onClick={() => void start()}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {running ? '创作中…' : '开始创作'}
          </Button>
          {running && (
            <Button size="sm" variant="danger" onClick={() => abortRef.current?.abort()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {running && <span className="text-[11px] text-ink-400">{progress?.message ?? ''}</span>}
        </div>
        <div className="mt-1.5 text-[10.5px] leading-relaxed text-ink-500">
          连写会在当前项目的现有章节之后接着写；写多少章就调多少次模型，本地模型耗时较长，可随时中止。
        </div>
      </section>

      {/* 阶段进度 */}
      {progress && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full bg-amber transition-all" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
            </div>
            <span className="text-[10.5px] tabular-nums text-ink-400">{Math.round(progress.ratio * 100)}%</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {progress.stages.map(s => (
              <span key={s.id} className={`text-[10.5px] ${STAGE_CLS[s.status]}`}>
                {STAGE_MARK[s.status]} {s.label}
                {s.status === 'running' && s.detail && <span className="text-ink-500"> · {s.detail}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 闸门①：设定草稿 */}
      {bibleGate && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-[11px] text-amber">闸门 ①</span>
            <span className="text-[13px] text-ink-100">确认设定草稿</span>
            <span className="text-[11px] text-ink-500">
              只有勾选的条目会落库；可以改名称、也可以直接舍弃不要的
            </span>
            <div className="flex-1" />
            <Button size="xs" variant="ghost" onClick={() => resolveGate(null)}>放弃本次创作</Button>
          </div>
          <DraftReviewPanel
            bundle={bibleGate}
            onConfirm={rows => resolveGate(rows)}
            confirmText="确认设定"
          />
        </div>
      )}

      {/* 闸门②：大纲 */}
      {outlineGate && (
        <section className="mt-4 rounded-lg border border-amber/40 bg-ink-800/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-[11px] text-amber">闸门 ②</span>
            <span className="text-[13px] text-ink-100">
              确认分卷大纲（{outlineGate.volumes.length} 卷 / {outlineGate.chapters.length} 章）
            </span>
            <div className="flex-1" />
            <Button size="xs" variant="ghost" onClick={() => resolveGate(false)}>放弃本次创作</Button>
            <Button size="sm" variant="primary" solid onClick={() => resolveGate(true)}>
              确认大纲，开始逐章连写
            </Button>
          </div>

          {outlineGate.volumes.map(v => (
            <div key={v.title} className="mb-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
              <div className="text-[12px] text-ink-100">《{v.title}》</div>
              {v.positioning && <div className="mt-0.5 text-[11px] text-ink-300">{v.positioning}</div>}
              {v.events && <div className="mt-0.5 text-[10.5px] text-ink-500">事件链：{v.events}</div>}
              {v.ending && <div className="mt-0.5 text-[10.5px] text-ink-500">卷末：{v.ending}</div>}
            </div>
          ))}

          <div className="mt-2 max-h-72 overflow-y-auto rounded border border-ink-700 bg-ink-900/40">
            <ul>
              {outlineGate.chapters.map(c => (
                <li key={c.no} className="border-b border-ink-700/40 px-3 py-1.5 last:border-0">
                  <div className="text-[11.5px] text-ink-200">第{c.no}章 {c.title}</div>
                  {c.event && <div className="text-[10.5px] text-ink-400">{c.event}</div>}
                  {c.hook && <div className="text-[10.5px] text-ink-500">章末钩子：{c.hook}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-2 text-[10.5px] leading-relaxed text-ink-500">
            确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，然后按细纲逐章连写正文；同名卷/细纲不会重复创建。
          </div>
        </section>
      )}

      {/* 连写日志 */}
      {log.length > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          {log.map((l, i) => (
            <div key={i} className="text-[11px] text-ink-300">{l}</div>
          ))}
        </div>
      )}

      {/* 结果 */}
      {result && (
        <section className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="text-[13px] text-emerald-300">创作完成</div>
          <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-ink-300">
            <li>设定：{result.bible.stats.total} 条草稿
              {result.bibleCommit && ` → 新建 ${result.bibleCommit.created} 条${result.bibleCommit.updated ? `、更新 ${result.bibleCommit.updated} 条` : ''}`}
            </li>
            <li>大纲：{result.outline.volumes.length} 卷 / {result.outline.chapters.length} 章
              {result.outlineCommit && ` → 新建 ${result.outlineCommit.volumesCreated} 卷、${result.outlineCommit.volumeCardsCreated} 份分卷大纲、${result.outlineCommit.chapterCardsCreated} 份章节细纲`}
            </li>
            <li>正文：{result.chapters.length} 章已落库</li>
          </ul>
          <div className="mt-1.5 text-[10.5px] text-ink-500">
            去「正文编辑」看正文；设定与大纲分别在对应页签（角色管理 / 世界构建 / 大纲规划）。
          </div>
        </section>
      )}
    </div>
  )
}

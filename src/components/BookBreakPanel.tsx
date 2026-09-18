/**
 * 「一键拆书」页签面板。
 *
 * 四步：① 贴/导入原文 → ② 开始拆解（切分→**写入正文**→逐块抽取→整理草稿，可中止）
 * → ③ 审阅草稿并勾选写入。
 *
 * 写库边界：**原文结构会写进正文编辑**（卷/章，可用下方开关关掉）；
 * **设定草稿不自动落库**，仍由用户在第 ③ 步勾选后写入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Loader2, Play, X } from 'lucide-react'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import DraftReviewPanel from './DraftReviewPanel'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import { loadActiveId, loadProviders, type AIProvider } from '../lib/ai'
import { adviseImport, type ImportAdvice } from '../lib/bookbreak/recommend'
import { estimateCalls, previewSplit, runBookBreak } from '../lib/bookbreak/run'
import type { SplitResult } from '../lib/bookbreak/split'
import { planVolumes } from '../lib/bookbreak/persist'
import type { PersistResult } from '../lib/bookbreak/persist'
import WorkflowTimeline from './WorkflowTimeline'
import type { DraftBundle, FlowProgress } from '../lib/flow/types'
import { adviseCapacity, type CapacityAdvice } from '../lib/modelCapacity'
import { getTavernSettings } from '../lib/tavern/settings'

const MAX_FILE_BYTES = 20 * 1024 * 1024

const fmtNum = (n: number) => n.toLocaleString('zh-CN')

export default function BookBreakPanel() {
  const [raw, setRaw] = useState('')
  const [preview, setPreview] = useState<SplitResult | null>(null)
  const [progress, setProgress] = useState<FlowProgress | null>(null)
  const [bundle, setBundle] = useState<DraftBundle | null>(null)
  const [running, setRunning] = useState(false)
  /** 是否把原文写进正文编辑（老大 2026-09-18 需求：切分后立刻形成卷/章框架）。默认开。 */
  const [writeToChapters, setWriteToChapters] = useState(true)
  const [cap, setCap] = useState<CapacityAdvice | null>(null)
  const [persistInfo, setPersistInfo] = useState<PersistResult | null>(null)
  /** 各阶段的产物摘要（`FlowProgress.stages[].detail` 会被下一阶段覆盖，产物摘要得自己留） */
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 切分预览防抖：粘贴几十万字时不能每敲一个键就跑一次全文正则
  useEffect(() => {
    const t = setTimeout(() => {
      setPreview(raw.trim().length >= 100 ? previewSplit(raw) : null)
    }, 350)
    return () => clearTimeout(t)
  }, [raw])

  // 模型能力（只读一次）：拿它把「预计调用次数」换算成耗时与推荐导入量。
  // 🔴 推荐口径见 recommend.ts 顶部注释 —— 拆书是逐章抽，导入量不撞窗口，受限的是调用次数与耗时。
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
      } catch { /* 拿不到模型信息就不显示推荐，不影响拆书本身 */ }
    })()
  }, [])

  const advice: ImportAdvice | null = useMemo(
    () => (preview && cap ? adviseImport(preview, cap) : null),
    [preview, cap],
  )
  /** 开跑前预览「会建成几卷几章」——与落库走的是同一个纯函数，不会与结果不一致 */
  const plan = useMemo(
    () => (preview && writeToChapters ? planVolumes(preview) : null),
    [preview, writeToChapters],
  )

  const onFile = async (f: File) => {
    if (f.size > MAX_FILE_BYTES) { showToast('文件超过 20MB，请先拆成若干份再导入', 'error'); return }
    try {
      const text = await f.text()
      setRaw(text)
      showToast(`已导入 ${f.name}（${text.length.toLocaleString()} 字）`, 'success')
    } catch {
      showToast('读取文件失败', 'error')
    }
  }

  const start = async () => {
    if (!raw.trim()) { showToast('请先粘贴或导入原文', 'info'); return }
    const ctl = new AbortController()
    abortRef.current = ctl
    setRunning(true)
    setBundle(null)
    setProgress(null)
    setPersistInfo(null)
    setSummaries({})
    try {
      const res = await runBookBreak(raw, {
        signal: ctl.signal,
        onProgress: setProgress,
        persistToChapters: writeToChapters,
      })
      // 🔴 中止时要如实说明：写入正文发生在抽取之前，中止时正文可能**已经写进去一部分**
      if (!res) {
        showToast(
          writeToChapters
            ? '已中止：设定草稿未产出；已写入的正文卷章保留在「正文编辑」里'
            : '已中止，未写入任何数据',
          'info',
        )
        return
      }
      setBundle(res.bundle)
      setPersistInfo(res.persist)
      // 阶段产物摘要：让跑完之后也看得见每一步做了什么（否则 detail 会被下一阶段覆盖）
      const sum: Record<string, string> = {
        split: `识别到 ${res.split.chapters.length} ${res.split.mode === 'chapters' ? '章' : '块'} · ${fmtNum(res.split.stats.chars)} 字`,
        extract: res.batches.length
          ? `从 ${res.batches.length} 个批次抽到 ${res.batches.reduce((n, b) => n + b.entities.length, 0)} 条实体`
          : '没有抽到实体',
        draft: `整理出 ${res.bundle.stats.total} 条草稿`,
      }
      if (res.persist) {
        sum.persist = res.persist.alreadyImported
          ? '已导入过，跳过写入'
          : res.persist.aborted
            ? `写入中止：已写入 ${res.persist.chaptersCreated} 章`
            : `写入 ${res.persist.volumes.length} 卷 ${res.persist.chaptersCreated} 章 · ${fmtNum(res.persist.words)} 字`
      }
      setSummaries(sum)
      const parts: string[] = []
      if (res.persist) {
        parts.push(res.persist.alreadyImported
          ? '正文已导入过，跳过'
          : `正文：${res.persist.volumes.length} 卷 ${res.persist.chaptersCreated} 章`)
      }
      parts.push(res.bundle.stats.total > 0 ? `设定草稿 ${res.bundle.stats.total} 条` : '未抽到可登记的实体')
      showToast(
        parts.join(' · ') + (res.bundle.stats.total > 0 ? '，请审阅后写入' : ''),
        res.bundle.stats.total > 0 ? 'success' : 'info',
      )
    } catch (e) {
      showToast('拆书失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-[15px] font-medium text-ink-100">一键拆书</h1>
        <HelpPopover title="一键拆书怎么用" pin>
          <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-300">
            <p>粘贴或导入一整本小说原文，AI 会<b>先按识别出的结构把原文写进「正文编辑」</b>（卷 / 章），再逐章抽取其中的<b>人物 / 势力 / 地点 / 种族 / 物品 / 术语</b>，并尽量补全各类的设定字段（身份定位、外貌特征、实力境界、功法技能、类别、剧情作用…），整理成草稿供你勾选。</p>
            <p>抽出的每条都带<b>原文引用</b>与<b>置信度</b>，并会与项目里已有的设定比对：已登记过的标为「疑似已有」、默认不勾选。</p>
            <p>同一实体在不同章节抽出的字段若出现<b>互相矛盾</b>的值（如境界一处是「废脉」、一处是「淬体一重」），会标为「冲突」并把两边的值都列出来，由你决定留哪个 —— 系统不替你猜。人物性格、外貌、人际关系这类可以累积的字段不做冲突判定，只取更完整的一份。</p>
            <p>两处写库要分清：<b>原文结构会直接写进正文编辑</b>（只追加、不动已有卷章，可用下方开关关掉）；<b>设定草稿不会自动落库</b>，要你点「写入项目」才写，且已有同名条目默认分毫不动。</p>
            <p className="text-ink-500">流程：切分 → 写入正文 → 逐章抽取 → 整理草稿 → 你审阅 → 写入。建议先用 5~10 万字试跑一轮，确认质量后再上整本。</p>
            <AIDataSourceNote feature="bookbreak" compact />
          </div>
        </HelpPopover>
      </div>

      {/* ① 原文 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-100">① 原文</span>
          <span className="text-[11px] text-ink-500">{raw.length.toLocaleString()} 字</span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={running} onClick={() => fileRef.current?.click()}>
            <FileUp size={12} /> 导入 .txt
          </Button>
          <Button size="xs" variant="ghost" disabled={running || !raw}
            onClick={() => { setRaw(''); setBundle(null); setPreview(null); setProgress(null); setPersistInfo(null); setSummaries({}) }}>
            <X size={12} /> 清空
          </Button>
        </div>
        <input
          ref={fileRef} type="file" accept=".txt,.md,text/plain" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }}
        />
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          disabled={running}
          spellCheck={false}
          placeholder="把小说原文粘贴到这里（支持整本），或点右上角「导入 .txt」。"
          className="mt-2 h-56 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />
        <label className="mt-2 flex items-start gap-1.5 text-[11.5px] text-ink-300">
          <input
            type="checkbox"
            checked={writeToChapters}
            disabled={running}
            onChange={e => setWriteToChapters(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            同时把原文写入<b className="text-ink-100">正文编辑</b>（按识别出的结构建卷 / 章）
            <span className="text-ink-500">—— 切分完就能在「正文写作」里翻着读；已有卷章只追加、不动。</span>
          </span>
        </label>
        {writeToChapters && (
          <div className="mt-1 text-[11px] leading-relaxed text-ink-500">
            建议在<b className="text-ink-300">新建的项目</b>里拆书：整本正文会写进「当前项目」，
            与已有内容混在一起后续不好清理。
          </div>
        )}
      </section>

      {/* 切分预览 */}
      {preview && (
        <div className="mt-2 space-y-1 rounded border border-ink-700 bg-ink-900/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink-300">
          <div>
            识别为 <b className="text-ink-100">{preview.chapters.length}</b>
            {preview.mode === 'chapters' ? ' 章' : ' 块（未识别到章节标题，已按段落分块）'}
            ，共 {fmtNum(preview.stats.chars)} 字 ≈ {fmtNum(preview.stats.estTokens)} 词元
            ，预计 <b className="text-ink-100">{estimateCalls(preview)}</b> 次模型调用。
          </div>
          {/* 导入量 / 耗时建议：口径是「逐章抽取，导入量不撞窗口，受限的是调用次数与耗时」 */}
          {advice && (
            <div className={advice.level === 'ok' ? 'text-emerald-400' : 'text-amber'}>
              {advice.level === 'ok' ? '✓ ' : '⚠️ '}{advice.note}
              <span className="text-ink-400"> 推荐单次导入不超过 {fmtNum(advice.recommendedChars)} 字（约 {advice.recommendedChapters} 章）。</span>
            </div>
          )}
          {/* 落库结构预览：开跑前就能看到会建成几卷几章、卷名是什么 */}
          {plan && (
            <div className="text-ink-400">
              将写入正文：<b className="text-ink-100">{plan.volumes.length} 卷 / {plan.chapterCount} 章</b>
              {plan.volumes.length > 0 && plan.volumes.length <= 4 && `（${plan.volumes.map(v => v.title).join('、')}）`}
            </div>
          )}
          {preview.stats.truncated && (
            <div className="text-amber">
              ⚠️ 超出处理上限，本轮只处理前 {preview.chapters.length} {preview.mode === 'chapters' ? '章' : '块'}。
            </div>
          )}
        </div>
      )}

      {/* ② 运行 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" solid disabled={running || !raw.trim()} onClick={() => void start()}>
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? '抽取中…' : '② 开始抽取'}
        </Button>
        {running && (
          <Button size="sm" variant="danger" onClick={() => abortRef.current?.abort()}>中止</Button>
        )}
        {running && <span className="text-[11px] text-ink-400">{progress?.message ?? ''}</span>}
      </div>

      {/* 进度：节点时间线（跑完保留，事后能看到每一步做了什么、花了多久） */}
      <WorkflowTimeline progress={progress} running={running} summaries={summaries} className="mt-2" />

      {/* ③ 审阅 */}
      {persistInfo && (
        <div className="mt-3 rounded border border-ink-700 bg-ink-900/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink-300">
          {persistInfo.alreadyImported ? (
            <>原文结构<b className="text-ink-100">已导入过</b>（同名卷 + 同章标题），本次跳过写入正文 —— 避免把同一本书复制成两份。</>
          ) : (
            <>
              已写入正文：<b className="text-ink-100">{persistInfo.volumes.map(v => `《${v.title}》${v.chapters} 章`).join('、')}</b>
              ，共 {fmtNum(persistInfo.words)} 字{persistInfo.aborted && <span className="text-amber">（中途中止，仅写入一部分）</span>}。
              可到「正文写作」查看。
            </>
          )}
        </div>
      )}

      {bundle && (
        <div className="mt-5">
          <div className="mb-2 text-[13px] text-ink-100">③ 审阅草稿</div>
          <DraftReviewPanel bundle={bundle} />
        </div>
      )}
    </div>
  )
}

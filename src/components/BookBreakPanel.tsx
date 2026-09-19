/**
 * 「一键拆书」页签面板。
 *
 * 四步：贴/导入原文 → 开始拆解（切分→**写入正文**→逐块抽取→整理草稿，可中止）
 * → 审阅草稿并勾选写入。
 *
 * 写库边界：**原文结构会写进正文编辑**（卷/章，可用下方开关关掉）；
 * **设定草稿不自动落库**，仍由用户在这一步勾选后写入。
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
import { estimateCalls, previewSplit, runBookBreak, type BookBreakResume } from '../lib/bookbreak/run'
import type { RelationTabOutcome } from '../lib/bookbreak/relations'
import type { SplitResult } from '../lib/bookbreak/split'
import { planVolumes } from '../lib/bookbreak/persist'
import type { PersistResult } from '../lib/bookbreak/persist'
import WorkflowTimeline from './WorkflowTimeline'
import type { DraftBundle, DraftRow, FlowProgress } from '../lib/flow/types'
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
  const [summarizeForms, setSummarizeForms] = useState(true)
  /** 末尾是否整理关系（人物关系 / 势力关系，两张表各一次调用）。默认开：关系是逐章抽取产不出来的那块。 */
  const [organizeRelations, setOrganizeRelations] = useState(true)
  /** 末尾汇总出的「全书设定」草稿行（已并入 bundle，这里单留一份只用于文案说明） */
  const [formRows, setFormRows] = useState<DraftRow[]>([])
  /** 末尾整理出的「人物关系 / 势力关系」草稿行（同样已并入 bundle，这里只用于文案说明） */
  const [relationRows, setRelationRows] = useState<DraftRow[]>([])
  /** 关系整理逐表结果（哪张表几条、有没有失败）——失败要如实说，并指向表格页的「AI 整理」 */
  const [relationTabs, setRelationTabs] = useState<RelationTabOutcome[]>([])
  /**
   * 中止后拿到的续跑信息（界面存住它 → 显示「继续」按钮）。
   * 🔴 断点装在**阶段内**：`extract` 抽到第 3 块时中止，继续时从第 4 块接着抽，
   *    前面抽好的不重跑（60 章书抽到一半中止，从阶段头重跑＝白跑 30 章）。
   */
  const [resume, setResume] = useState<BookBreakResume | null>(null)
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

  const start = async (fromScratch = false) => {
    if (!raw.trim()) { showToast('请先粘贴或导入原文', 'info'); return }
    const ctl = new AbortController()
    abortRef.current = ctl
    // 「从头重跑」= 丢掉断点；否则有断点就接着抽
    const useResume = fromScratch ? null : resume
    if (fromScratch) setResume(null)
    setRunning(true)
    setBundle(null)
    setFormRows([])
    setRelationRows([])
    setRelationTabs([])
    setProgress(null)
    setPersistInfo(null)
    setSummaries({})
    try {
      const res = await runBookBreak(raw, {
        signal: ctl.signal,
        onProgress: setProgress,
        persistToChapters: writeToChapters,
        summarizeForms,
        organizeRelations,
        // 续跑：把上次的断点原样传回（阶段内断点 + 已完成阶段的产物）
        ...(useResume ? { resume: useResume } : {}),
        onResume: r => setResume(r),
      })
      // 🔴 中止时要如实说明：写入正文发生在抽取之前，中止时正文可能**已经写进去一部分**
      if (!res) {
        showToast(
          (writeToChapters
            ? '已中止：设定草稿未产出；已写入的正文卷章保留在「正文编辑」里'
            : '已中止，未写入任何数据') + '；可点「继续抽取」接着跑，已抽过的块不会重跑',
          'info',
        )
        return
      }
      setBundle(res.bundle)
      setFormRows(res.formRows)
      setRelationRows(res.relationRows)
      setRelationTabs(res.relationTabs)
      setResume(null) // 跑完了，断点作废（下次是从头开始的新任务）
      setPersistInfo(res.persist)
      // 阶段产物摘要：让跑完之后也看得见每一步做了什么（否则 detail 会被下一阶段覆盖）
      const sum: Record<string, string> = {
        split: `识别到 ${res.split.chapters.length} ${res.split.mode === 'chapters' ? '章' : '块'} · ${fmtNum(res.split.stats.chars)} 字`,
        extract: res.batches.length
          ? `从 ${res.batches.length} 个批次抽到 ${res.batches.reduce((n, b) => n + b.entities.length, 0)} 条实体`
          : '没有抽到实体',
        // ⚠️ 扣掉全书设定那几行：它们是"汇总"出来的，不是逐章"整理"出来的，
        //    算进这里会让作者以为抽到了更多条目
        draft: `整理出 ${Math.max(0, res.bundle.stats.total - res.formRows.length)} 条草稿`,
        ...(summarizeForms
          ? { worldview: res.formRows.length ? `汇总出 ${res.formRows.length} 张表的全书设定` : '没汇总出可用的全书设定' }
          : {}),
        // 关系整理逐表交代（含失败原因）：失败了却只字不提，作者会以为"这本书没有关系"
        ...(organizeRelations && res.relationTabs.length
          ? {
              relations: res.relationTabs
                .map(t => {
                  if (t.note) return `《${t.tabName}》失败：${t.note}`
                  const discard = t.dropped + t.unproven
                  return `《${t.tabName}》${t.count} 条${discard ? `（丢弃 ${discard} 条：名字不在名单里或给不出原文依据）` : ''}`
                })
                .join(' · '),
            }
          : {}),
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
        <h1 className="text-15 font-medium text-ink-100">一键拆书</h1>
        <HelpPopover title="一键拆书怎么用" pin>
          <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
            <p>粘贴或导入一整本小说原文，AI 会<b>先按识别出的结构把原文写进「正文编辑」</b>（卷 / 章），再逐章抽取其中的<b>人物 / 势力 / 地点 / 种族 / 物品 / 术语</b>，并尽量补全各类的设定字段（身份定位、外貌特征、实力境界、功法技能、类别、剧情作用…），整理成草稿供你勾选。</p>
            <p>抽出的每条都带<b>原文引用</b>与<b>置信度</b>，并会与项目里已有的设定比对：已登记过的标为「疑似已有」、默认不勾选。</p>
            <p>同一实体在不同章节抽出的字段若出现<b>互相矛盾</b>的值（如境界一处是「废脉」、一处是「淬体一重」），会标为「冲突」并把两边的值都列出来，由你决定留哪个 —— 系统不替你猜。人物性格、外貌、人际关系这类可以累积的字段不做冲突判定，只取更完整的一份。</p>
            <p>两处写库要分清：<b>原文结构会直接写进正文编辑</b>（只追加、不动已有卷章，可用下方开关关掉）；<b>设定草稿不会自动落库</b>，要你点「写入项目」才写，且已有同名条目默认分毫不动。</p>
            <p>末尾还会做两件收尾的事（都可在下方开关关掉）：<b>汇总全书级设定</b>（作品定位 / 世界设定 / 力量体系…），以及<b>整理人物关系 / 势力关系</b>。关系之所以不逐章抽，是因为它是「两两事实」——原文写着「师父」，未必写清是谁的师父，逐章抽只会落一地的半截关系；放到末尾整本看完、对齐已有条目后一次收敛，还能顺带认出 A-B 与 B-A 是同一条。整理出的关系与实体草稿在同一个列表里勾选、一次写入。</p>
            <p className="text-ink-500">流程：切分 → 写入正文 → 逐章抽取 → 整理草稿 → 汇总全书设定 → 整理关系 → 你审阅 → 写入。建议先用 5~10 万字试跑一轮，确认质量后再上整本。</p>
            <AIDataSourceNote feature="bookbreak" compact />
          </div>
        </HelpPopover>
      </div>

      {/* 原文 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-100">原文</span>
          <span className="text-11 text-ink-500">{raw.length.toLocaleString()} 字</span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={running} onClick={() => fileRef.current?.click()}>
            <FileUp size={12} /> 导入 .txt
          </Button>
          <Button size="xs" variant="secondary" disabled={running || !raw}
            onClick={() => { setRaw(''); setBundle(null); setPreview(null); setProgress(null); setPersistInfo(null); setSummaries({}); setFormRows([]); setRelationRows([]); setRelationTabs([]) }}>
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
          className="mt-2 h-56 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-12 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />
        <label className="mt-2 flex items-start gap-1.5 text-11 text-ink-300">
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
        <label className="mt-2 flex items-start gap-1.5 text-11 text-ink-300">
          <input
            type="checkbox"
            checked={summarizeForms}
            disabled={running}
            onChange={e => setSummarizeForms(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            末尾汇总<b className="text-ink-100">全书级设定</b>（作品定位 / 世界设定 / 力量体系 等表单页签）
            <span className="text-ink-500">—— 多一次模型调用，把整本书的信息收敛成一份档案；已填过的字段只补空、不覆盖你手改过的内容。</span>
          </span>
        </label>
        <label className="mt-2 flex items-start gap-1.5 text-11 text-ink-300">
          <input
            type="checkbox"
            checked={organizeRelations}
            disabled={running}
            onChange={e => setOrganizeRelations(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            末尾整理<b className="text-ink-100">人物关系 / 势力关系</b>
            <span className="text-ink-500">
              —— 多两次模型调用（两张表各一次）。这两张表是逐章抽取产不出来的：关系是「两两事实」，
              要同时定住 A、B 两人并对齐已有条目（A-B 与 B-A 算同一条），所以放到末尾整本看完再收一次。
              整理出的关系会并进下面草稿列表，与实体一起勾选、一次写入。
            </span>
          </span>
        </label>
        {writeToChapters && (
          <div className="mt-1 text-11 leading-relaxed text-ink-500">
            建议在<b className="text-ink-300">新建的项目</b>里拆书：整本正文会写进「当前项目」，
            与已有内容混在一起后续不好清理。
          </div>
        )}
      </section>

      {/* 切分预览 */}
      {preview && (
        <div className="mt-2 space-y-1 rounded border border-ink-700 bg-ink-900/40 px-3 py-2 text-11 leading-relaxed text-ink-300">
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

      {/* 运行 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" solid disabled={running || !raw.trim()} onClick={() => void start()}>
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? '抽取中…' : resume ? '继续抽取' : '开始抽取'}
        </Button>
        {!running && resume && (
          <Button size="sm" variant="secondary" onClick={() => void start(true)}>
            从头重跑（丢弃断点）
          </Button>
        )}
        {running && (
          <Button size="sm" variant="danger" onClick={() => abortRef.current?.abort()}>中止</Button>
        )}
        {running && <span className="text-11 text-ink-400">{progress?.message ?? ''}</span>}
      </div>
      {!running && resume && (
        <div className="mt-1 text-11 leading-relaxed text-ink-400">
          上次中止在：{resume.label}。点「继续抽取」会从这里接着跑，<b className="text-ink-300">已抽过的块不会重跑</b>；
          <span className="text-ink-500">若你改过原文，断点会失效（自动从头跑），避免抽出的内容与章节错位。</span>
        </div>
      )}

      {/* 进度：节点时间线（跑完保留，事后能看到每一步做了什么、花了多久） */}
      <WorkflowTimeline progress={progress} running={running} summaries={summaries} className="mt-2" />

      {/* 审阅 */}
      {persistInfo && (
        <div className="mt-3 rounded border border-ink-700 bg-ink-900/40 px-3 py-2 text-11 leading-relaxed text-ink-300">
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
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
            <span className="text-13 text-ink-100">审阅草稿</span>
            {formRows.length > 0 && (
              <span className="text-11 text-ink-400">
                含末尾汇总的 {formRows.length} 张「全书设定」—— 已填过的字段不会被覆盖，只补空。
              </span>
            )}
            {relationRows.length > 0 && (
              <span className="text-11 text-ink-400">
                含末尾整理的 {relationRows.length} 条关系（人物关系 / 势力关系）—— 已与已有条目比对过，A-B 与 B-A 视为同一条。
              </span>
            )}
            {relationTabs.some(t => t.note) && (
              <span className="text-11 text-amber">
                {relationTabs.filter(t => t.note).map(t => `《${t.tabName}》整理失败：${t.note}`).join('；')}
                —— 可到该表用「AI 整理」自行指定章节重试。
              </span>
            )}
          </div>
          <DraftReviewPanel bundle={bundle} />
        </div>
      )}
    </div>
  )
}

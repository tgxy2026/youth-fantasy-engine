/**
 * 「一键拆书」页签面板。
 *
 * 流水线：贴/导入原文 → 开始拆解（切分 → **写入正文** → 逐块抽取 → 整理草稿 →
 * 汇总全书设定 → 整理关系，可中止）→ 审阅草稿并勾选写入。
 *
 * 写库边界：**原文结构会写进正文编辑**（卷/章，可用下方开关关掉）；
 * **设定草稿不自动落库**，仍由用户在这一步勾选后写入。
 *
 * 🔴 2.6.3 · 跨页签任务存活：**任务本体跑在 `lib/aiTaskCenter` 的模块级 store 里**，
 *    本组件只是「提交 + 订阅 + 展示」的壳。
 *    原先运行态（running / progress / bundle / resume / summaries / persistInfo）全在本组件
 *    `useState` 里，而 `App.tsx` 是「切页签即卸载组件」——切去别的页签整理设定，
 *    拆书的结果就写进了已卸载组件的 setState，白烧一次额度还拿不到东西。
 *    现在切页签不影响任务，回到本页结果与断点原样都在。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FileDown, Loader2, Play, X } from 'lucide-react'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import AutoTextarea from '@/components/common/AutoTextarea'
import { Button } from '@/components/common/Button'
import DraftReviewPanel from '@/components/editor/DraftReviewPanel'
import HelpPopover from '@/components/common/HelpPopover'
import NewProjectAdvice from '@/components/app/NewProjectAdvice'
import NumberField from '@/components/common/NumberField'
import { showToast } from '@/components/dialogs/dialogs'
import { loadActiveId, loadProviders, type AIProvider } from '@/lib/ai'
import { adviseImport, type ImportAdvice } from '@/lib/bookbreak/recommend'
import { estimateCalls, previewSplit, runBookBreak, initialBookBreakResume, bookBreakResumeIssue, bookBreakResumeOwnerCurrent, type BookBreakResume, type BookBreakFailedUnit } from '@/lib/bookbreak/run'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { getStorageContextEpoch, subscribeStorageContext } from '@/lib/storage/contextEpoch'
import { readStringPref, writeStringPref, usePersistedBool } from '@/lib/settings/uiPrefs'
import type { RelationTabOutcome } from '@/lib/bookbreak/relations'
import {
  DEFAULT_RELATION_LIMITS, RELATION_LIMIT_META, clampRelationLimits, getRelationLimits,
  isDefaultLimits, resetRelationLimits, saveRelationLimits, type RelationMaterialLimits,
} from '@/lib/bookbreak/relationMaterial'
import type { SplitResult } from '@/lib/bookbreak/split'
import { planVolumes } from '@/lib/bookbreak/persist'
import type { PersistResult } from '@/lib/bookbreak/persist'
import { isDocxFileName, isLegacyDocFileName, readDocxText } from '@/lib/storage/docxImport'
import WorkflowTimeline from '@/components/tools/WorkflowTimeline'
import type { DraftBundle, DraftRow, FlowProgress } from '@/lib/flow/types'
import { adviseCapacity, type CapacityAdvice } from '@/lib/ai/modelCapacity'
import { getTavernSettings } from '@/lib/tavern/settings'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { abortTask, dismissTask, markTaskSeen, startTask, useAiTask } from '@/lib/ai/aiTaskCenter'

const MAX_FILE_BYTES = 20 * 1024 * 1024

/** 本页签在任务中心里的身份（`ownerTab` 需与 `TABS` 里的页签 id 一致，指示器靠它跳回来） */
const OWNER_TAB = 'bookbreak'
const TASK_KIND = 'bookbreak'

/**
 * 拆书任务的**结果载荷**（只在内存里）。
 *
 * ⚠️ 这里装的是"跑完之后界面要显示的东西"——它是**任务产物**，不是输入参数；
 *    输入参数（原文 / 开关 / 材料上限）由发起时的闭包捕获，跑的过程中不再读组件状态
 *    （组件很可能已经卸载了）。
 */
interface BookBreakTaskResult {
  split: SplitResult
  /** 抽取批次（只用到条数统计，不深依赖其形状） */
  batches: { entities: unknown[] }[]
  failedUnits: BookBreakFailedUnit[]
  bundle: DraftBundle
  formRows: DraftRow[]
  relationRows: DraftRow[]
  relationTabs: RelationTabOutcome[]
  relationMaterialChars: number
  persist: PersistResult | null
  /** 各阶段的产物摘要（`FlowProgress.stages[].detail` 会被下一阶段覆盖，产物摘要得自己留） */
  summaries: Record<string, string>
  /** 完成时的一句话交代（提示文案，含"请审阅后写入"这类下一步指引） */
  doneText: string
  doneKind: 'success' | 'info'
  /** 中止时的一句话交代（如"已写入的正文卷章保留在正文编辑里"） */
  abortText: string
}

const fmtNum = (n: number) => n.toLocaleString('zh-CN')

/** 稳定的空值常量：无结果时复用同一引用，避免下游 useMemo / 依赖数组每帧白跑 */
const EMPTY_ROWS: DraftRow[] = []
const EMPTY_TABS: RelationTabOutcome[] = []
const EMPTY_SUMMARIES: Record<string, string> = {}

export default function BookBreakPanel() {
  useSyncExternalStore(subscribeStorageContext, getStorageContextEpoch)
  return <BookBreakWorkspace key={candidateApplyContext()} />
}

function BookBreakWorkspace() {
  // 🔴 未配置模型时**预先禁用**「开始抽取」（2026-09-20 六维审计 F1）。
  //    判据与真实调用一致：拆书链路（aiExtractSettingEntities / aiSummarizeFormSettings）
  //    都走 requireActiveProvider。选文件 / 预览分章是纯本地步骤，仍照常可用。
  const { ready: aiReady } = useAIReady()
  // 订阅任务中心（切页签重挂载后，任务与结果原样还在 —— 本组件不持有运行态）
  const taskSnapshot = useAiTask<BookBreakTaskResult, FlowProgress>(OWNER_TAB, TASK_KIND)
  const taskCheckpoint = (taskSnapshot?.resume ?? null) as BookBreakResume | null
  const ownerChanged = !!taskCheckpoint && !bookBreakResumeOwnerCurrent(taskCheckpoint)
  const task = ownerChanged ? null : taskSnapshot
  const running = task?.status === 'running'
  const progress = task?.progress ?? null
  const bundle = task?.result?.bundle ?? null
  const formRows = task?.result?.formRows ?? EMPTY_ROWS
  const relationRows = task?.result?.relationRows ?? EMPTY_ROWS
  const relationTabs = task?.result?.relationTabs ?? EMPTY_TABS
  const relationChars = task?.result?.relationMaterialChars ?? 0
  const persistInfo = task?.result?.persist ?? null
  const summaries = task?.result?.summaries ?? EMPTY_SUMMARIES
  /** 中断后拿到的续跑断点（沿用原语义：显示「继续抽取」按钮） */
  const resume = task?.status === 'done' ? null : (task?.resume ?? null) as BookBreakResume | null
  // 供下面那两个 effect 用的原始量：**只依赖原始值**，不依赖 task 对象本身
  // （task 的引用每次 store 变更都会换，直接当依赖会让 effect 无谓重跑）
  const taskId = task?.id ?? ''
  const taskStatus = task?.status
  const taskUnread = task?.unread ?? false

  // 结果被看到即清「未查看」标记（指示器上的「待查看 N」据此收敛）
  useEffect(() => {
    if (taskId && taskStatus === 'done' && taskUnread) markTaskSeen(taskId)
  }, [taskId, taskStatus, taskUnread])

  const [raw, setRaw] = useState(() => task && taskCheckpoint && bookBreakResumeOwnerCurrent(taskCheckpoint) ? taskCheckpoint.sourceText ?? '' : '')
  const [startError, setStartError] = useState('')
  const [preview, setPreview] = useState<SplitResult | null>(null)
  // 2.6.1 · R2：章节标题示例 —— 填了且本地规则认不出章节时，拆书先用 AI 按示例识别边界（run.ts 阶段 1）
  const [titleSamples, setTitleSamples] = useState(() => readStringPref('bookbreak-title-samples') ?? '')
  /** 是否把原文写进正文编辑（老大 2026-09-18 需求：切分后立刻形成卷/章框架）。默认开。 */
  const [writeToChapters, setWriteToChapters] = usePersistedBool('bookbreak-write-to-chapters', true)
  const [summarizeForms, setSummarizeForms] = usePersistedBool('bookbreak-summarize-forms', true)
  /** 末尾是否整理关系（人物关系 / 势力关系，两张表各一次调用）。默认开：关系是逐章抽取产不出来的那块。 */
  const [organizeRelations, setOrganizeRelations] = usePersistedBool('bookbreak-organize-relations', true)
  /** 「整理关系」的材料上限（持久保存；见 lib/bookbreak/relationMaterial.ts 里每项为什么） */
  const [limits, setLimits] = useState<RelationMaterialLimits>(DEFAULT_RELATION_LIMITS)
  const [showLimits, setShowLimits] = useState(false)
  const [cap, setCap] = useState<CapacityAdvice | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 切分预览防抖：粘贴几十万字时不能每敲一个键就跑一次全文正则
  useEffect(() => {
    const t = setTimeout(() => {
      setPreview(raw.trim().length >= 100 ? previewSplit(raw) : null)
    }, 350)
    return () => clearTimeout(t)
  }, [raw])

  // 材料上限：从全局 meta 读（读不到就用推荐值 —— 绝不因读设置失败挡住拆书）
  useEffect(() => { getRelationLimits().then(setLimits).catch(() => {}) }, [])

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
    // .doc（旧二进制）要单独劝退：不然会以「不是有效 docx」这种看不出所以然的理由失败
    if (isLegacyDocFileName(f.name)) {
      showToast('.doc 是旧版格式，请在 Word 里「另存为」.docx 或 .txt 后再导入', 'error')
      return
    }
    if (f.size > MAX_FILE_BYTES) { showToast('文件超过 20MB，请先拆成若干份再导入', 'error'); return }
    try {
      if (isDocxFileName(f.name)) {
        // 🔴 .docx 是 zip 包（里面是 XHTML 式的 XML），不能当纯文本读；走手写解析（C9）
        const { text, paragraphs, skipped } = await readDocxText(await f.arrayBuffer())
        if (!text.trim()) { showToast('这个 .docx 里没抽到正文（可能整篇都在文本框或图片里）', 'error'); return }
        setRaw(text)
        showToast(
          `已导入 ${f.name}（${paragraphs.toLocaleString()} 段 / ${text.length.toLocaleString()} 字）`
          + (skipped.length ? `　未读取：${skipped.join('、')}` : ''),
          'success',
        )
        return
      }
      const text = await f.text()
      setRaw(text)
      showToast(`已导入 ${f.name}（${text.length.toLocaleString()} 字）`, 'success')
    } catch (e) {
      // 解析失败必须把原因说出来（.doc / epub / 损坏包各有各的说法，别只说「失败」）
      showToast(e instanceof Error ? e.message : '读取文件失败', 'error')
    }
  }

  /**
   * 开始 / 继续抽取。
   *
   * 🔴 输入参数在这里**快照**进闭包：任务跑在 store 里，跑的过程中组件可能已经卸载，
   *    绝不能在 `run` 里读组件 state（那时拿到的是过期 / 已卸载的值）。
   */
  const start = (fromScratch = false) => {
    if (!raw.trim()) { showToast('请先粘贴或导入原文', 'info'); return }
    const rawText = raw
    const persistToChapters = writeToChapters
    const formsOn = summarizeForms
    const relationsOn = organizeRelations
    const samples = titleSamples
    const material = limits
    // 「从头重跑」= 丢掉断点；否则有断点就接着抽
    const useResume = fromScratch ? null : resume
    const settings = { persistToChapters, summarizeForms: formsOn, organizeRelations: relationsOn,
      ...(samples.trim() ? { titleSamples: samples } : {}), relationMaterial: material }
    if (useResume) {
      const issue = bookBreakResumeIssue(rawText, settings, useResume)
      if (issue) { setStartError(issue); return }
    }
    setStartError('')

    startTask<BookBreakTaskResult, FlowProgress>({
      ownerTab: OWNER_TAB,
      kind: TASK_KIND,
      title: '一键拆书',
      // 拆书产物最终会写进正文（勾了 persistToChapters 时）与设定草稿 ——
      // 与别的写这两处的任务撞上时，任务中心会轻提示一次（真并行的必然代价，见 3-1）
      writes: ['chapters', 'settings'],
      run: async ctx => {
        // 把原始输入留在任务内存，切页重挂后可继续；不会写入偏好或数据库。
        ctx.setResume(useResume ?? initialBookBreakResume(rawText, settings))
        const res = await runBookBreak(rawText, {
          signal: ctx.signal,
          onProgress: p => ctx.progress(p),
          ...settings,
          // 续跑：把上次的断点原样传回（阶段内断点 + 已完成阶段的产物）
          ...(useResume ? { resume: useResume } : {}),
          onResume: r => ctx.setResume(r),
        })
        // `null` = 被中止（run.ts 的约定）。抛一个 AbortError，让任务中心如实记为「已中止」
        // 而不是「完成但没结果」。
        if (!res) {
          const e = new Error('已中止')
          e.name = 'AbortError'
          throw e
        }
        // 阶段产物摘要：让跑完之后也看得见每一步做了什么（否则 detail 会被下一阶段覆盖）
        const sum: Record<string, string> = {
          split: `识别到 ${res.split.chapters.length} ${res.split.mode === 'chapters' ? '章' : '块'} · ${fmtNum(res.split.stats.chars)} 字`,
          extract: res.batches.length
            ? `从 ${res.batches.length} 个批次抽到 ${res.batches.reduce((n, b) => n + b.entities.length, 0)} 条实体${res.failedUnits.length ? `；${res.failedUnits.length} 个单元未成功` : ''}`
            : res.failedUnits.length ? `${res.failedUnits.length} 个单元未成功，不能判断是否没有实体` : '没有抽到实体',
          // ⚠️ 扣掉全书设定那几行：它们是"汇总"出来的，不是逐章"整理"出来的，
          //    算进这里会让作者以为抽到了更多条目
          draft: `整理出 ${Math.max(0, res.bundle.stats.total - res.formRows.length)} 条草稿`,
          ...(formsOn
            ? { worldview: res.formRows.length ? `汇总出 ${res.formRows.length} 张表的全书设定` : '没汇总出可用的全书设定' }
            : {}),
          // 关系整理逐表交代（含失败原因）：失败了却只字不提，作者会以为"这本书没有关系"
          ...(relationsOn && res.relationTabs.length
            ? {
                // 带上材料字数：作者刚在面板上调过上限，跑完总得看见"调完是多少字"
                relations: `材料 ${fmtNum(res.relationMaterialChars)} 字 · ` + res.relationTabs
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
        const parts: string[] = []
        if (res.persist) {
          parts.push(res.persist.alreadyImported
            ? '正文已导入过，跳过'
            : `正文：${res.persist.volumes.length} 卷 ${res.persist.chaptersCreated} 章`)
        }
        parts.push(res.bundle.stats.total > 0 ? `设定草稿 ${res.bundle.stats.total} 条` : '未抽到可登记的实体')
        if (res.failedUnits.length) parts.push(`${res.failedUnits.length} 个抽取单元未成功，请回看`)
        return {
          split: res.split,
          batches: res.batches,
          failedUnits: res.failedUnits,
          bundle: res.bundle,
          formRows: res.formRows,
          relationRows: res.relationRows,
          relationTabs: res.relationTabs,
          relationMaterialChars: res.relationMaterialChars,
          persist: res.persist,
          summaries: sum,
          doneText: parts.join(' · ') + (res.bundle.stats.total > 0 ? '，请审阅后写入' : ''),
          doneKind: res.bundle.stats.total > 0 && !res.failedUnits.length ? 'success' : 'info',
          // 🔴 中止时要如实说明：写入正文发生在抽取之前，中止时正文可能**已经写进去一部分**
          abortText:
            (persistToChapters
              ? '已中止：设定草稿未产出；已写入的正文卷章保留在「正文编辑」里'
              : '已中止，未写入任何数据') + '；可点「继续抽取」接着跑，已抽过的块不会重跑',
        }
      },
      notify: ({ status, result }) => {
        if (status === 'done' && result) return { text: `拆书完成 —— ${result.doneText}`, kind: result.doneKind }
        if (status === 'failed') return { text: '拆书未完成，请回到页面核对断点，并检查网络和模型配置。', kind: 'error' }
        if (status === 'aborted') return { text: '已中止：可点「继续抽取」接着跑', kind: 'info' }
        return null
      },
    })
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-15 font-medium text-ink-100">一键拆书</h1>
        <HelpPopover title="一键拆书怎么用" pin>
          <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
            <p>粘贴或导入一整本小说原文（文件支持 <b>.txt / .md / .docx</b>，上限 20MB；.docx 内的批注、脚注、图片、公式读不到，导入时会如实告诉你），AI 会<b>先按识别出的结构把原文写进「正文编辑」</b>（卷 / 章），再逐章抽取其中的<b>人物 / 势力 / 地点 / 种族 / 物品 / 术语</b>，并尽量补全各类的设定字段（身份定位、外貌特征、实力境界、功法技能、类别、剧情作用…），整理成草稿供你勾选。</p>
            <p>抽出的每条都带<b>原文引用</b>与<b>置信度</b>，并会与项目里已有的设定比对：已登记过的标为「疑似已有」、默认不勾选。</p>
            <p>同一实体在不同章节抽出的字段若出现<b>互相矛盾</b>的值（如境界一处是「废脉」、一处是「淬体一重」），会标为「冲突」并把两边的值都列出来，由你决定留哪个 —— 系统不替你猜。人物性格、外貌、人际关系这类可以累积的字段不做冲突判定，只取更完整的一份。</p>
            <p>两处写库要分清：<b>原文结构会直接写进正文编辑</b>（只追加、不动已有卷章，可用下方开关关掉）；<b>设定草稿不会自动落库</b>，要你点「写入项目」才写，且已有同名条目默认分毫不动。</p>
            <p>末尾还会做两件收尾的事（都可在下方开关关掉）：<b>汇总全书级设定</b>（作品信息 / 世界设定 / 力量体系…），以及<b>整理人物关系 / 势力关系</b>。关系之所以不逐章抽，是因为它是「两两事实」——原文写着「师父」，未必写清是谁的师父，逐章抽只会落一地的半截关系；放到末尾整本看完、对齐已有条目后一次收敛；并且按「有向对」处理 —— A→B 与 B→A 各算一条（视角不同），同一对还能并存多种关系类型。整理出的关系与实体草稿在同一个列表里勾选、一次写入。</p>
            <p className="text-ink-500">流程：切分 → 写入正文 → 逐章抽取 → 整理草稿 → 汇总全书设定 → 整理关系 → 你审阅 → 写入。建议先用 5~10 万字试跑一轮，确认质量后再上整本。</p>
            <AIDataSourceNote feature="bookbreak" compact />
          </div>
        </HelpPopover>
      </div>

      <NewProjectAdvice kind="bookbreak" />

      {/* 原文 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-100">原文</span>
          <span className="text-11 text-ink-500">{raw.length.toLocaleString()} 字</span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={running} onClick={() => fileRef.current?.click()}>
            <FileDown size={12} /> 导入 .txt / .md / .docx
          </Button>
          <Button size="xs" variant="secondary" disabled={running || !raw}
            onClick={() => {
              // 清空原文与预览；顺手把已结束的拆书结果记录也撤掉（结果 UI 随之消失）。
              // 🔴 只撤「已结束」的记录 —— 运行中的不允许撤（dismissTask 会拒绝）。
              setRaw(''); setPreview(null)
              if (task && task.status !== 'running') dismissTask(task.id)
            }}>
            <X size={12} /> 清空
          </Button>
        </div>
        <input
          ref={fileRef} type="file"
          accept=".txt,.md,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }}
        />
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          disabled={running}
          spellCheck={false}
          placeholder="把小说原文粘贴到这里（支持整本），或点右上角「导入 .txt / .md / .docx」。"
          className="mt-2 h-56 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-12 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />
        {/* 2.6.1 · R2：章节标题示例 —— 本地规则认不出章节时的 AI 识别引导（拍板：有示例则 AI 优先） */}
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/60 p-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-11 font-medium text-ink-200">章节标题示例</span>
            <HelpPopover title="章节标题示例怎么用" width="22rem">
              {'原文的章节标题写法不标准（如「01|风起」「风起（一）」），本地规则认不出来时在这里帮忙：照原文里的标题样式抄几行进来（一行一条，3~5 条为宜）。\n\n· 填了示例：拆书时本地规则先认一遍，认不出就交给 AI 按示例找出章节起始行（识别结果会逐字回原文核对，对不上就放弃）；\n· 不填：按原来的方式处理 —— 本地规则认不出就按字数分块；\n· 本地规则已经认出章节时示例不会被用到（不耗模型调用）。'}
            </HelpPopover>
          </div>
          {/* 2026-10-14：原为固定 h-14（约 3 行）+ 右侧滚动条，示例稍多就看不全 ⇒ 改自适应高度，
              下限 3 行（保持点击区域），上限 240px 后转内部滚动，避免长文本把面板撑得过长。 */}
          <AutoTextarea
            value={titleSamples}
            onChange={v => { setTitleSamples(v); writeStringPref('bookbreak-title-samples', v) }}
            disabled={running}
            spellCheck={false}
            minRows={3}
            maxHeight={240}
            placeholder={'一行一条，照原文里的标题样式抄，例如：\n01|风起\n02|逆流'}
            className="mt-1.5 rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
          />
          <div className="mt-1 text-10 text-ink-500">
            {preview
              ? preview.mode === 'chapters'
                ? `本地规则已识别出 ${preview.stats.count} 章，示例不会被用到。`
                : titleSamples.trim()
                  ? '本地规则未识别到章节标题——拆书时将先用 AI 按你的示例识别章节边界（识别失败自动回到按字数分块）。'
                  : '本地规则未识别到章节标题，将按字数分块。想让 AI 按章节切分？在上面照原文标题样式抄几行示例。'
              : '先在上方粘贴或导入原文，这里会告诉你切分方式。'}
          </div>
          <AIDataSourceNote feature="bookbreak-split" />
        </div>
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
            末尾汇总<b className="text-ink-100">全书级设定</b>（作品信息 / 世界设定 / 力量体系 等表单页签）
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
              要同时定住 A、B 两人并对齐已有条目（A→B 与 B→A 各算一条，同对还可并存多种关系类型），所以放到末尾整本看完再收一次。
              整理出的关系会并进下面草稿列表，与实体一起勾选、一次写入。
            </span>
          </span>
        </label>
        {organizeRelations && (
          <div className="mt-1.5 pl-5">
            <Button size="xs" variant="secondary" disabled={running} onClick={() => setShowLimits(v => !v)}>
              {showLimits ? '收起材料上限' : '调整材料上限'}
              {!isDefaultLimits(limits) && <span className="text-amber"> · 已调整</span>}
            </Button>
            {showLimits && (
              <div className="mt-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
                <p className="text-11 leading-relaxed text-ink-400">
                  材料＝<b className="text-ink-200">已抽出的实体清单 ＋ 开篇原文样本</b>，
                  是这一步唯一的输入（一次调用），因此必须有上限。下面给的是推荐值与推荐理由；
                  改成多少由你定 —— 改完立刻生效于下次运行，并会记住。
                </p>
                <div className="mt-2 space-y-2">
                  {RELATION_LIMIT_META.map(m => (
                    <label key={m.key} className="block">
                      <span className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-12 text-ink-200">{m.label}</span>
                        <NumberField
                          value={limits[m.key]}
                          min={m.min}
                          max={m.max}
                          step={m.step}
                          disabled={running}
                          title={`${m.label}：${m.min}~${m.max} ${m.unit}（超出会调回最近的边界）`}
                          onChange={v => {
                            const next = clampRelationLimits({ ...limits, [m.key]: v } as RelationMaterialLimits)
                            setLimits(next)
                            void saveRelationLimits(next)
                          }}
                          onClamped={(v, dir) => showToast(
                            `${m.label}已调整为${dir === 'max' ? '上限' : '下限'} ${v} ${m.unit}`, 'info')}
                          className="w-20 rounded border border-ink-700 bg-ink-900 px-2 py-0.5 text-12 text-ink-100 outline-none focus:border-amber/50 disabled:opacity-60"
                        />
                        <span className="text-11 text-ink-500">{m.unit} · 推荐 {DEFAULT_RELATION_LIMITS[m.key]}</span>
                      </span>
                      <span className="mt-0.5 block text-11 leading-relaxed text-ink-500">{m.why}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="xs" variant="secondary" disabled={running || isDefaultLimits(limits)}
                    onClick={() => { void resetRelationLimits().then(setLimits) }}>
                    恢复推荐值
                  </Button>
                  <span className="text-11 text-ink-500">
                    调大更准也更慢；材料到顶会截断并标注「后面已省略」，不会静默丢。
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
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
            <div className={advice.level === 'ok' ? 'text-success' : 'text-amber'}>
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
        <Button size="sm" variant="primary" solid disabled={ownerChanged || running || !raw.trim() || !aiReady} title={!aiReady ? AI_DISABLED_HINT : undefined} onClick={() => start()}>
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? '抽取中…' : resume ? '继续抽取' : '开始抽取'}
        </Button>
        {!running && resume && (
          <Button size="sm" variant="secondary" onClick={() => start(true)}>
            从头重跑（丢弃断点）
          </Button>
        )}
        {running && task && (
          <Button size="sm" variant="danger" onClick={() => abortTask(task.id)}>中止</Button>
        )}
        {running && <span className="text-11 text-ink-400">{progress?.message ?? ''}</span>}
      </div>
      {ownerChanged && <div role="alert" className="mt-2 rounded border border-amber/30 bg-amber/5 px-3 py-2 text-11 text-amber">已有拆书任务属于另一项目或存储空间，不能在当前空间查看或继续。请回到原项目核对。</div>}
      {startError && <div role="alert" className="mt-2 rounded border border-amber/30 bg-amber/5 px-3 py-2 text-11 text-amber">{startError}</div>}
      {task?.status === 'failed' && <div role="alert" className="mt-2 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-11 text-danger">上次拆书未完成，请检查网络和模型配置，并核对断点；已写入正文以实际内容为准。</div>}
      {!running && resume && (
        <div className="mt-1 text-11 leading-relaxed text-ink-400">
          {task?.status === 'failed' ? '上次失败在' : '上次中止在'}：{resume.label}。点「继续抽取」会从这里接着跑，<b className="text-ink-300">已处理的单元不会重跑</b>；
          <span className="text-ink-500">原文、项目、存储或参数改变后，须由你选择从头重跑。先前失败的单元不会在续跑时自动重试。</span>
        </div>
      )}

      {/* 进度：节点时间线（跑完保留，事后能看到每一步做了什么、花了多久） */}
      <WorkflowTimeline progress={progress} running={running} summaries={summaries} className="mt-2" />
      {!!task?.result?.failedUnits?.length && (
        <details className="mt-3 rounded border border-amber/30 bg-amber/5 px-3 py-2 text-11 text-amber" role="group">
          <summary className="cursor-pointer">{task.result.failedUnits.length} 个抽取单元未成功，查看位置</summary>
          <p className="mt-1">已生成的草稿可继续审阅。请检查网络或模型配置；可手动补充，或由你选择从头重跑，本页暂不支持只重试失败单元。</p>
          <ul className="mt-1 list-disc pl-5">{task.result.failedUnits.map(unit => <li key={unit.unit}>第 {unit.unit} 个单元：{unit.chapterTitle}</li>)}</ul>
        </details>
      )}

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
                含末尾整理的 {relationRows.length} 条关系（人物关系 / 势力关系）—— 依据 {fmtNum(relationChars)} 字的材料，
                已与已有条目比对过（有向对 + 关系类型：同对同向 + 同类型才算重复，A→B 与 B→A 各算一条）。
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

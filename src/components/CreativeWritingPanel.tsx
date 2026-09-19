/**
 * 「创意写作」页签 —— AI 创作工作流的界面（**两种起点**）。
 *
 * - **从一句话创作**：设定奠基 →「闸门 · 设定」→ 分卷大纲 →「闸门 · 大纲」→ 逐章连写
 * - **接着已有内容写**：直接逐章连写（设定补完按策略在每章末尾进行，可当"继续推进项目"用）
 *
 * 两个闸门是刻意留的：AI 生成设定/大纲的质量波动必须由人过一眼再落库 —— 人定方向，AI 跑量。
 * 闸门用 Promise 实现（编排器 await 在那里等），所以本组件只需在点击时 resolve 掉它。
 *
 * 🔴 所有会话状态都在 `lib/creativeSession` 那个模块级 store 里，本组件**只订阅与展示**：
 *    切页签会卸载组件，但任务跑在 store 里，回来时进度、日志、闸门、断点原样都在。
 *    这也是"切页签内容就没了"那个问题的根治点（原来状态全在 useState 里）。
 */
import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Loader2, PenLine, Play, Sparkles, Square, Wand2 } from 'lucide-react'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import DraftReviewPanel from './DraftReviewPanel'
import HelpPopover from './HelpPopover'
import InterviewChat from './InterviewChat'
import { Modal } from './Modal'
import NewProjectAdvice from './NewProjectAdvice'
import WorkflowTimeline from './WorkflowTimeline'
import AutoTextarea from './AutoTextarea'
import { showToast } from './dialogs'
import { useAIReady } from '../lib/useAIReady'
import { aiChatJson, loadActiveId, loadProviders, type AIProvider } from '../lib/ai'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { CREATIVE_SEED_SPEC, seedFromFilled } from '../lib/creativeSeed'
import {
  applyCandidates, applyRewrite, clearCreativeSession, consumeNotice, decideDraft,
  discardRewrite, hydrateCreativeSession, resolveGate, startChapterRewrite, startCreativeRun,
  stopChapterRewrite, stopCreativeRun, toggleCandidate,
  updateInputs, useCreativeSession, type CreativeMode, type CreativeTarget,
} from '../lib/creativeSession'
import { DEAI_TEMPLATES, WORD_TOLERANCE, type ContinueStrategy } from '../lib/autoContinue'
import { CHAPTER_REWRITE_META, type ChapterRewriteAction } from '../lib/aiTasks'
import { listRewriteCandidates, type RewriteCandidate } from '../lib/chapterRewrite'
import { countWords } from '../lib/textStats'
import { adviseCapacity, type CapacityAdvice } from '../lib/modelCapacity'
import { getTavernSettings } from '../lib/tavern/settings'
import { MAX_CHAPTERS, advisePace, type PaceAdvice } from '../lib/writingPace'
import NumberField from './NumberField'

const NUM_INPUT = 'w-20 rounded bg-ink-900 border border-ink-700 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50'

/** 两种起点的展示元数据 —— 顺序即界面顺序 */
const MODE_META: Record<CreativeMode, { label: string; icon: typeof PenLine; hint: string }> = {
  scratch: {
    label: '从一句话创作',
    icon: PenLine,
    hint: '给一句话想法，AI 依次做：设定奠基 → 分卷大纲 → 逐章连写（两个人工闸门）',
  },
  continue: {
    label: '接着已有内容写',
    icon: BookOpen,
    hint: '从项目里最后一章往下续写，并按策略补登新设定；项目已有《章节细纲》时按细纲走',
  },
}
const MODES: CreativeMode[] = ['scratch', 'continue']

/**
 * 产出目标（仅「从一句话创作」显示）。
 *
 * 老大 2026-09-19 要求：**开口就分清**「只要大纲规划」还是「连正文一起写」，
 * 而不是让作者跑到闸门②才被问「只保存大纲、还是继续写正文」。
 * 目标属于"这一次要什么"，跟起点一样该在开跑前定；闸门只做确认 / 放弃。
 */
const TARGET_META: Record<CreativeTarget, { label: string; hint: string }> = {
  outline: {
    label: '只做大纲规划',
    hint: '生成设定与分卷大纲就收工，正文一个字不写；之后用「接着已有内容写」就能按细纲把正文补上',
  },
  full: {
    label: '大纲 + 正文',
    hint: '设定 → 分卷大纲 → 按细纲逐章连写正文（完整创作）',
  },
}
const TARGETS: CreativeTarget[] = ['outline', 'full']

/** 整章改写的四种动作（顺序即界面顺序） */
const RW_ACTIONS: ChapterRewriteAction[] = ['polish', 'expand', 'condense', 'rewrite']

/**
 * 选章下拉的显示文本。
 * ⚠️ 标题里**已经带**「第N章」时不要再叠一层序号 —— 示范项目的章节标题本身就是
 * 「第21章 剑应碑醒」，直接拼会显示成「第21章 第21章 剑应碑醒」。
 */
function chapterOptionLabel(c: RewriteCandidate): string {
  const dup = c.no > 0 && new RegExp(`^\\s*第\\s*${c.no}\\s*章`).test(c.chapter.title)
  const prefix = c.no > 0 && !dup ? `第${c.no}章 ` : ''
  const tail = c.chapter.content ? `（${c.chapter.wordCount} 字）` : '（空章）'
  return `${prefix}${c.chapter.title}${tail}`
}

/** 连写时如何对待已有设定（沿用「一键续写」的三种策略，措辞按"融合后"统一） */
const STRATEGY_META: Record<ContinueStrategy, { label: string; hint: string }> = {
  'add-only': { label: '仅限新增', hint: '只补登新设定，已登记的设定一律不动（最稳）' },
  'confirm': { label: '候选确认', hint: '新设定与疑似重复项列出供你勾选，已登记项不改动' },
  'auto-update': { label: '自动更新', hint: '新设定自动补登，已登记实体的变化追加到备注（不覆盖属性列）' },
}
const STRATEGIES: ContinueStrategy[] = ['add-only', 'confirm', 'auto-update']

export default function CreativeWritingPanel() {
  const s = useCreativeSession()
  const inp = s.inputs
  const [interview, setInterview] = useState(false)
  const [cap, setCap] = useState<CapacityAdvice | null>(null)
  const { ready: aiReady } = useAIReady()
  // ── 整章改写：选章 / 选动作 / 补充要求 / 目标字数 ──
  const [cands, setCands] = useState<RewriteCandidate[]>([])
  const [rwChapter, setRwChapter] = useState('')
  const [rwAction, setRwAction] = useState<ChapterRewriteAction>('polish')
  const [rwReq, setRwReq] = useState('')
  const [rwWords, setRwWords] = useState(3000)
  /** 有长任务在跑（创作或改写）—— 互斥，避免两个任务抢模型 */
  const busy = s.running || !!s.rewrite?.running

  // 读回本项目的上次会话（模块级只读一次；切项目时会自动重置）
  useEffect(() => {
    hydrateCreativeSession()
  }, [])

  /** 整章改写的选章列表（新建 / 删除章节后点「刷新章节」重取） */
  const reloadChapters = async () => {
    try {
      const list = await listRewriteCandidates()
      setCands(list)
      // 选中的那章可能已被删掉 —— 清掉选择，别让作者对着一个不存在的章点开始
      setRwChapter(prev => (prev && list.some(c => c.chapter.id === prev) ? prev : ''))
    } catch { /* 读不到就不铺选项，不打扰作者 */ }
  }
  useEffect(() => {
    void listRewriteCandidates()
      .then(list => setCands(list))
      .catch(() => { /* 忽略：空列表就是「这项目还没章节」 */ })
  }, [])

  // store 里的提示 → 弹完即清（任务跑在 store 里，提示不能依赖本组件挂载）
  useEffect(() => {
    if (!s.notice) return
    showToast(s.notice.text, s.notice.kind)
    consumeNotice()
  }, [s.notice])

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
    () => (cap ? advisePace(cap, { chapters: inp.chapters, targetWords: inp.words }) : null),
    [cap, inp.chapters, inp.words],
  )

  /**
   * 「只做大纲规划」：不写正文，所以字数目标、去 AI 味儿、逐章确认这些连写设置都不该出现。
   * 章数此时是「规划章数」（大纲要排多少章），仍然要问。
   */
  const outlineOnlyTarget = inp.mode === 'scratch' && inp.target === 'outline'
  const chapterLabel = outlineOnlyTarget ? '规划章数' : '连写章数'

  /** 起点不同，可开始的条件不同：从零得有想法；接着写只要项目里有正文（由编排器兜底提示） */
  const canStart = aiReady && (inp.mode === 'continue' || !!inp.seed.trim())
  const startLabel = s.resume
    ? '继续写作'
    : (inp.mode === 'continue' ? '接着写' : (outlineOnlyTarget ? '开始规划' : '开始创作'))

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-15 font-medium text-ink-100">创意写作</h1>
        <HelpPopover title="创意写作怎么用" pin>
          <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
            <p>这条流水线有<b>两个起点</b>：</p>
            <p>· <b>从一句话创作</b> —— 给一句话想法，AI 依次做<b>设定奠基 → 分卷大纲 → 逐章连写</b>，适合新开一本。</p>
            <p>· <b>接着已有内容写</b> —— 从项目里最后一章往下续写，并顺手补登新设定，适合把手上的稿子推下去、或把「只做大纲规划」的项目补上正文。</p>
            <p>· 选「从一句话创作」时，先在<b>「这一次要产出什么」</b>里定目标：<b>只做大纲规划</b>（设定 + 分卷大纲就收工），或<b>大纲 + 正文</b>（完整创作）。只想先看看大纲、之后再决定写不写正文，就选前者 —— 之后切到「接着已有内容写」把正文补上即可，不必重跑设定与大纲。</p>
            <p><b>两个人工闸门</b>（仅「从一句话创作」有）：设定草稿与大纲都必须你确认后才落库、才继续 —— 人定方向，AI 跑量。</p>
            <p>落库只发生在闸门通过之后（「接着写」则是在每章初稿<b>被采纳</b>之后）；在任何闸门处「放弃」，都不会留下半成品。</p>
            <p className="text-ink-500">「接着已有内容写」的每章流程：读上下文（含上一章结尾）→ 续写初稿 → 字数校准 →（开启时）去 AI 味儿 →（开启时）你确认采纳 → 编辑自检 → 抽取补登设定 → 下一章。项目里有《章节细纲》时，会按章号取当章细纲钉进提示词末段，让正文跟着大纲走。</p>
            <p className="text-ink-500">想法还说不清时点<b>「对话引导」</b>：AI 按「题材 → 主角 → 冲突 → 世界」一路问，聊完自动把要点填回输入框。</p>
            <p className="text-ink-500">跑长任务时可以随时切去「正文编辑」看稿 —— 任务不会中断，切回来进度与断点都还在。</p>
            <AIDataSourceNote feature="creative-writing" compact />
          </div>
        </HelpPopover>
      </div>

      <NewProjectAdvice kind="creative-writing" />

      {/* 起点选择 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {MODES.map(m => {
            const Icon = MODE_META[m].icon
            return (
              <Button
                key={m}
                variant="toggle"
                selected={inp.mode === m}
                disabled={s.running}
                title={MODE_META[m].hint}
                onClick={() => updateInputs({ mode: m })}
                className="px-3 h-8 rounded-lg text-12"
              >
                <Icon size={12} className="mr-1" />
                {MODE_META[m].label}
              </Button>
            )
          })}
          <div className="flex-1" />
          {inp.mode === 'scratch' && (
            <Button size="xs" variant="secondary" disabled={s.running} onClick={() => setInterview(true)}>
              <Sparkles size={11} /> 对话引导
            </Button>
          )}
        </div>

        {/* 产出目标：只「从一句话创作」需要 —— 开跑前就分清要大纲还是要正文 */}
        {inp.mode === 'scratch' && (
          <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
            <div className="mb-1.5 text-12 text-ink-300">这一次要产出什么</div>
            <div className="flex flex-wrap gap-1.5">
              {TARGETS.map(k => (
                <Button key={k} variant="toggle" selected={inp.target === k} disabled={s.running}
                  onClick={() => updateInputs({ target: k })} title={TARGET_META[k].hint}
                  className="px-3 h-8 rounded-lg text-12">
                  {TARGET_META[k].label}
                </Button>
              ))}
            </div>
            <p className="mt-1 text-10 leading-relaxed text-ink-500">{TARGET_META[inp.target].hint}</p>
          </div>
        )}

        {/* 输入：两种起点各自的"种子" */}
        {inp.mode === 'scratch' ? (
          <textarea
            value={inp.seed}
            onChange={e => updateInputs({ seed: e.target.value })}
            disabled={s.running}
            spellCheck={false}
            placeholder="例：一个靠吞噬他人修为续命的少年，在正道与魔道之间越走越深。"
            className="mt-3 h-24 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-12 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
          />
        ) : (
          <div className="mt-3">
            <div className="mb-1.5 text-13 text-ink-200">情节概要（可选，不填则严格承接上一章往下写）</div>
            <AutoTextarea
              value={inp.intent}
              onChange={v => updateInputs({ intent: v })}
              minHeight={60}
              maxHeight={160}
              disabled={s.running}
              placeholder="例如：陈渊在秘境深处发现上古遗迹，意外获得一卷残破功法……"
            />
            <p className="mt-1.5 text-11 text-ink-500 leading-relaxed">
              小提示：续写前，若先对前几章正文通读梳理一遍（或在编辑器里重新生成章节压缩摘要），
              能让 AI 更好地承接剧情、衔接更自然流畅。
            </p>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-11 text-ink-400">
          {inp.mode === 'scratch' && (
            <label className="flex items-center gap-1.5">卷数
              <NumberField value={inp.volumes} min={1} max={8} disabled={s.running}
                title="卷数：1 ~ 8（超出范围会调回最近的边界）"
                onChange={v => updateInputs({ volumes: v ?? 1 })} className={NUM_INPUT} />
            </label>
          )}
          <label className="flex items-center gap-1.5">{chapterLabel}
            <NumberField value={inp.chapters} min={1} max={MAX_CHAPTERS} disabled={s.running}
              title={`${chapterLabel}：1 ~ ${MAX_CHAPTERS}（超出范围会调回最近的边界）`}
              onChange={v => updateInputs({ chapters: v ?? 1 })} className={NUM_INPUT} />
          </label>
          {/* 不写正文时，字数目标没有意义 —— 留着只会让人以为还要连写，收起来 */}
          {!outlineOnlyTarget && (
            <label className="flex items-center gap-1.5">每章目标字数
              <NumberField value={inp.words} min={800} max={8000} step={100} disabled={s.running}
                title="每章目标字数：800 ~ 8000（超出范围会调回最近的边界）"
                onChange={v => updateInputs({ words: v ?? 2500 })} className={NUM_INPUT} />
            </label>
          )}
        </div>
        {pace && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span title={pace.model} className={`text-10 leading-relaxed ${pace.level === 'ok' ? 'text-ink-500' : 'text-amber'}`}>
              {pace.note}
            </span>
            {inp.chapters !== pace.recommendedChapters && (
              <Button size="xs" variant="secondary" onClick={() => updateInputs({ chapters: pace.recommendedChapters })}>
                用推荐值（{pace.recommendedChapters} 章）
              </Button>
            )}
          </div>
        )}

        {/* 连写设置（两种起点共用 —— 融合点之一：从零创作现在也能去 AI 味儿 / 选补完策略）
            「只做大纲规划」不写正文，这些设置整块收起来，免得让人以为接下来还要连写 */}
        {!outlineOnlyTarget && (
        <details className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2" open={inp.mode === 'continue'}>
          <summary className="cursor-pointer text-12 text-ink-200">连写设置（去 AI 味儿 · 设定补完 · 逐章确认）</summary>
          <div className="mt-2.5 space-y-3">
            <div>
              <div className="mb-1.5 text-12 text-ink-300">已有设定的更新策略</div>
              <div className="flex flex-wrap gap-1.5">
                {STRATEGIES.map(k => (
                  <Button key={k} variant="toggle" selected={inp.strategy === k} disabled={s.running}
                    onClick={() => updateInputs({ strategy: k })} title={STRATEGY_META[k].hint}
                    className="px-3 h-8 rounded-lg text-12">
                    {STRATEGY_META[k].label}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-10 leading-relaxed text-ink-500">{STRATEGY_META[inp.strategy].hint}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="toggle" selected={inp.deAiOn} disabled={s.running}
                onClick={() => updateInputs({ deAiOn: !inp.deAiOn })}
                className="px-3 h-8 rounded-lg text-12"
                title="开启后，AI 每章初稿会先按所选提示词润色一遍，再交你裁决">
                <Wand2 size={12} className="mr-1" />
                去 AI 味儿：{inp.deAiOn ? '已开启' : '已关闭'}
              </Button>
              <Button variant="toggle" selected={inp.reviewEach} disabled={s.running}
                onClick={() => updateInputs({ reviewEach: !inp.reviewEach })}
                className="px-3 h-8 rounded-lg text-12"
                title="开启时每章初稿弹窗让你决定采纳或重写；关闭＝全自动连写">
                逐章确认初稿：{inp.reviewEach ? '已开启' : '已关闭（全自动）'}
              </Button>
              {inp.mode === 'continue' && (
                <Button variant="toggle" selected={inp.useOutline} disabled={s.running}
                  onClick={() => updateInputs({ useOutline: !inp.useOutline })}
                  className="px-3 h-8 rounded-lg text-12"
                  title="项目里存在《章节细纲》卡时，按章号取当章细纲写进提示词，让正文跟着大纲走">
                  按《章节细纲》写：{inp.useOutline ? '已开启' : '已关闭'}
                </Button>
              )}
            </div>

            {inp.deAiOn && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {DEAI_TEMPLATES.map(t => (
                    <Button key={t.id} variant="toggle" selected={inp.deAiTpl === t.id} disabled={s.running}
                      onClick={() => updateInputs({ deAiTpl: t.id })} title={t.desc}
                      className="px-3 h-8 rounded-lg text-12">
                      {t.label}
                    </Button>
                  ))}
                </div>
                {inp.deAiTpl === 'custom' && (
                  <AutoTextarea value={inp.deAiCustom} onChange={v => updateInputs({ deAiCustom: v })}
                    minHeight={50} maxHeight={140}
                    placeholder="粘贴你自己的去 AI 味儿提示词（例如：去掉说教感，多用短句……）" />
                )}
                <p className="text-10 leading-relaxed text-ink-500">
                  内置 3 套去味儿提示词（即网络常见「去 AI 味儿 skill」的本地化版本），可切换或自定义；
                  润色结果异常时自动保留原稿。
                </p>
              </div>
            )}
          </div>
        </details>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={s.running || !canStart}
            onClick={() => void startCreativeRun()}>
            {s.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {s.running ? '创作中…' : startLabel}
          </Button>
          {!s.running && s.resume && (
            <Button size="sm" variant="secondary" onClick={() => void startCreativeRun({ fromScratch: true })}>
              从头重写（丢弃断点）
            </Button>
          )}
          {s.running && (
            <Button size="sm" variant="danger" onClick={() => stopCreativeRun()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {!s.running && s.result && (
            <Button size="sm" variant="secondary" onClick={clearCreativeSession}>清空本次记录</Button>
          )}
          {s.running && <span className="text-11 text-ink-400">{s.progress?.message ?? ''}</span>}
          {!aiReady && <span className="text-11 text-amber">{AI_DISABLED_HINT}</span>}
        </div>

        {!s.running && s.resume && (
          <div className="mt-1 text-11 leading-relaxed text-ink-400">
            上次中止在：{s.resume.label}。点「继续写作」从断点接着写，
            <b className="text-ink-300">已落库的章不会重写</b>；
            <span className="text-ink-500">改了「连写章数」会令断点失效（自动从头跑），避免剩余章数算错。</span>
          </div>
        )}
        <div className="mt-1.5 text-10 leading-relaxed text-ink-500">
          {inp.mode === 'scratch'
            ? (outlineOnlyTarget
                ? '本次只做大纲规划：设定与分卷大纲确认后即收工，不写正文；随时可在两个闸门处放弃（放弃＝不留半成品）。'
                : '连写会在当前项目的现有章节之后接着写，随时可中止；写完去「正文编辑」逐章审阅。')
            : '从项目里最后一章往下写，随时可中止；已落库的章不会被改写，写完去「正文编辑」逐章审阅。'}
        </div>
      </section>

      {/* 阶段进度：竖向节点时间线（跑完保留 —— 事后能看到每一步做了什么、花了多久、产出多少） */}
      <WorkflowTimeline progress={s.progress} running={s.running} summaries={s.summaries} className="mt-2" />

      {/* 闸门 · 设定：设定草稿 */}
      {s.bibleGate && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 设定</span>
            <span className="text-13 text-ink-100">确认设定草稿</span>
            <span className="text-11 text-ink-500">
              只有勾选的条目会落库；可以改名称、也可以直接舍弃不要的
            </span>
            <div className="flex-1" />
            {/* 与下方 DraftReviewPanel 的「确认设定」（sm）同一决策组 —— 尺寸必须一致 */}
            <Button size="sm" variant="secondary" onClick={() => resolveGate(null)}>放弃本次创作</Button>
          </div>
          <DraftReviewPanel
            bundle={s.bibleGate}
            onConfirm={rows => resolveGate(rows)}
            confirmText="确认设定"
          />
        </div>
      )}

      {/* 闸门 · 大纲 */}
      {s.outlineGate && (
        <section className="mt-4 rounded-lg border border-amber/40 bg-ink-800/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 大纲</span>
            <span className="text-13 text-ink-100">
              确认分卷大纲（{s.outlineGate.volumes.length} 卷 / {s.outlineGate.chapters.length} 章）
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => resolveGate(false)}>放弃本次创作</Button>
            {/* 「要不要正文」在起点就定了，闸门只做确认 / 放弃 —— 按钮文案跟着目标变 */}
            <Button size="sm" variant="primary" solid onClick={() => resolveGate(true)}>
              {inp.target === 'outline' ? '确认大纲（不写正文）' : '保存大纲并开始连写'}
            </Button>
          </div>

          {s.outlineGate.volumes.map(v => (
            <div key={v.title} className="mb-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
              <div className="text-12 text-ink-100">《{v.title}》</div>
              {v.positioning && <div className="mt-0.5 text-11 text-ink-300">{v.positioning}</div>}
              {v.events && <div className="mt-0.5 text-10 text-ink-500">事件链：{v.events}</div>}
              {v.ending && <div className="mt-0.5 text-10 text-ink-500">卷末：{v.ending}</div>}
            </div>
          ))}

          <div className="mt-2 max-h-72 overflow-y-auto rounded border border-ink-700 bg-ink-900/40">
            <ul>
              {s.outlineGate.chapters.map(c => (
                <li key={c.no} className="border-b border-ink-700/40 px-3 py-1.5 last:border-0">
                  <div className="text-11 text-ink-200">第{c.no}章 {c.title}</div>
                  {c.event && <div className="text-10 text-ink-400">{c.event}</div>}
                  {c.hook && <div className="text-10 text-ink-500">章末钩子：{c.hook}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-2 text-10 leading-relaxed text-ink-500">
            {inp.target === 'outline'
              ? '确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，本次到此为止（你选的是「只做大纲规划」，不写正文）；之后用「接着已有内容写」就能按细纲把正文补上。'
              : '确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，然后按细纲逐章连写正文；同名卷/细纲不会重复创建。'}
          </div>
        </section>
      )}

      {/* 连写日志 */}
      {s.log.length > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          {s.log.map((l, i) => (
            <div key={i} className="text-11 text-ink-300">{l}</div>
          ))}
        </div>
      )}

      {/* 结果 */}
      {s.result && (
        <section className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="text-13 text-emerald-300">
            {s.result.wrote > 0 || s.result.outlineOnly ? '本次完成' : '本次结束'}
          </div>
          <ul className="mt-1.5 space-y-0.5 text-11 text-ink-300">
            {s.result.mode === 'scratch' && (
              <>
                <li>设定：{s.result.bibleTotal} 条草稿
                  {s.result.bibleCreated > 0 && ` → 新建 ${s.result.bibleCreated} 条`}
                </li>
                <li>大纲：{s.result.volumes} 卷 / {s.result.outlineChapters} 章</li>
              </>
            )}
            <li>
              {s.result.outlineOnly
                ? '正文：按你的选择只出大纲，未写正文'
                : `正文：${s.result.wrote} 章已落库`}
            </li>
          </ul>
          <div className="mt-1.5 text-10 text-ink-500">
            {s.result.outlineOnly
              ? '设定与大纲已落库（角色管理 / 世界构建 / 大纲规划）；想写正文时切到「接着已有内容写」，不必重跑设定与大纲。'
              : '去「正文编辑」看正文；设定与大纲分别在对应页签（角色管理 / 世界构建 / 大纲规划）。'}
          </div>
        </section>
      )}

      {/* 整章改写：对已有章节做整章级的润色 / 扩写 / 精简 / 改写 */}
      <section className="mt-4 rounded-lg border border-ink-700 bg-ink-900/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-100">整章改写</span>
          <HelpPopover title="整章改写怎么用" width="24rem" size={12}>
            <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
              <p>挑一章，对<b>整章正文</b>做润色 / 扩写 / 精简 / 改写。与颉文姬的「选区改稿」不同 —— 那边面向一段、产出叫「建议段」；这里送进去的是<b>整章</b>，产出先给你过目，确认后才替换正文。</p>
              <p>改写时会一并送<b>上一章结尾</b>（约 1200 字），保证改完仍接得上；上面那栏「补充要求」可以告诉它往哪个方向改（例如「打斗写细一点」「对话再口语些」）。</p>
              <p>点「替换该章正文」之前，旧稿会自动存进<b>「时光机 · 本章版本历史」</b>，随时能恢复。章节标题、状态、所属卷都不会被改动。</p>
              <AIDataSourceNote feature="chapter-rewrite" compact />
            </div>
          </HelpPopover>
          <span className="text-11 text-ink-500">
            挑一章做整章润色 / 扩写 / 精简 / 改写 —— 结果先给你过目，确认后才替换正文（旧稿自动留档）
          </span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => void reloadChapters()}>刷新章节</Button>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-11 text-ink-400">
          <label className="flex items-center gap-1.5">章节
            <select
              value={rwChapter}
              onChange={e => setRwChapter(e.target.value)}
              disabled={busy}
              className="max-w-[22rem] rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50 disabled:opacity-60"
            >
              <option value="">（选择一章）</option>
              {cands.map(c => (
                <option key={c.chapter.id} value={c.chapter.id}>{chapterOptionLabel(c)}</option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1.5">动作
            {RW_ACTIONS.map(k => (
              <Button key={k} variant="toggle" selected={rwAction === k} disabled={busy}
                onClick={() => setRwAction(k)} title={CHAPTER_REWRITE_META[k].hint}
                className="px-3 h-8 rounded-lg text-12">
                {CHAPTER_REWRITE_META[k].label}
              </Button>
            ))}
          </div>
          {CHAPTER_REWRITE_META[rwAction].needWords && (
            <label className="flex items-center gap-1.5">目标字数
              <NumberField value={rwWords} min={300} max={20000} step={100} disabled={busy}
                title="目标字数：300 ~ 20000（超出范围会调回最近的边界）"
                onChange={v => setRwWords(v ?? 3000)} className={NUM_INPUT} />
            </label>
          )}
        </div>
        <p className="mt-1 text-10 leading-relaxed text-ink-500">{CHAPTER_REWRITE_META[rwAction].hint}</p>

        <div className="mt-2">
          <AutoTextarea
            value={rwReq}
            onChange={setRwReq}
            minHeight={44}
            maxHeight={120}
            disabled={busy}
            placeholder="补充要求（可选）：例如「打斗写细一点」「对话再口语些」「把章末钩子改得更狠」"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={!aiReady || !rwChapter || busy}
            onClick={() => void startChapterRewrite({ chapterId: rwChapter, action: rwAction, requirement: rwReq, words: rwWords })}>
            <Wand2 size={12} /> {s.rewrite ? '重新改写' : '开始改写'}
          </Button>
          {s.rewrite?.running && (
            <Button size="sm" variant="danger" onClick={() => stopChapterRewrite()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {!aiReady && <span className="text-11 text-amber">{AI_DISABLED_HINT}</span>}
        </div>

        {s.rewrite && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2 text-11">
              <span className="text-ink-200">
                {s.rewrite.no > 0 ? `第${s.rewrite.no}章 ` : ''}{s.rewrite.title}
              </span>
              {s.rewrite.running
                ? <span className="text-ink-400"><Loader2 size={11} className="inline animate-spin" /> 正在改写…</span>
                : <span className={s.rewrite.suspect ? 'text-amber' : 'text-emerald-300'}>
                    {s.rewrite.fromWords} → {countWords(s.rewrite.text)} 字{s.rewrite.suspect ? ' · 结果异常' : ''}
                  </span>}
            </div>
            <div className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-ink-700 bg-ink-900 p-3 text-12 leading-[1.9] text-ink-200">
              {s.rewrite.text || '（等待模型输出…）'}
            </div>
            {!s.rewrite.running && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" solid disabled={!!s.rewrite.suspect}
                  onClick={() => void applyRewrite()}>替换该章正文</Button>
                <Button size="sm" variant="secondary" onClick={() => discardRewrite()}>丢弃这次结果</Button>
                {s.rewrite.suspect
                  ? <span className="text-10 text-amber">结果明显偏短（{s.rewrite.text.length} 字），已锁住替换 —— 请重新改写。</span>
                  : <span className="text-10 text-ink-500">替换前会自动把旧稿存进「时光机 · 本章版本历史」，可随时恢复。</span>}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 每章初稿裁决（逐章确认开启时） */}
      <Modal
        open={!!s.draftAsk}
        onClose={() => decideDraft('abort')}
        width="2xl"
        title={s.draftAsk ? `第 ${s.draftAsk.d.index}/${s.draftAsk.d.total} 章初稿${s.draftAsk.d.attempt > 1 ? `（第 ${s.draftAsk.d.attempt} 稿）` : ''}` : '本章初稿'}
        footer={
          <>
            <Button variant="secondary" onClick={() => decideDraft('abort')}>停止任务</Button>
            <Button variant="secondary" onClick={() => decideDraft('rewrite')}>重写本章</Button>
            <Button variant="primary" solid onClick={() => decideDraft('accept')}>采纳本章</Button>
          </>
        }
      >
        {s.draftAsk && (() => {
          const d = s.draftAsk.d
          const lo = d.target - WORD_TOLERANCE
          const hi = d.target + WORD_TOLERANCE
          const ok = d.words >= lo && d.words <= hi
          return (
            <>
              <div className="mb-3 flex items-center gap-3 text-12">
                <span className={ok ? 'text-emerald-400' : 'text-amber'}>
                  {d.words} 汉字 {ok ? '· 已达标' : '· 超出容差'}
                </span>
                <span className="text-ink-500">目标 {d.target} ± {WORD_TOLERANCE}（{lo}~{hi}）</span>
                {inp.deAiOn && <span className="text-ink-300 border border-ink-700 rounded px-1.5 py-0.5">已去 AI 味儿</span>}
              </div>
              <p className="text-12 text-ink-400 mb-3">
                采纳后 AI 才会继续做编辑自检、修正与设定补登；点「重写本章」会丢弃本稿重新生成
                （含重新润色，不会留下垃圾章节，也不会写入数据库）。
                不想每章都停一次，可关掉上面的「逐章确认初稿」。
              </p>
              <div className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 p-3.5 text-13 leading-[1.9] text-ink-100"
                style={{ maxHeight: '52vh' }}>
                {d.body}
              </div>
            </>
          )
        })()}
      </Modal>

      {/* 设定补登确认（策略选「候选确认」时） */}
      <Modal
        open={!!s.candidatesAsk}
        onClose={() => applyCandidates(null)}
        title="设定补登确认"
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => applyCandidates(null)}>跳过</Button>
            <Button variant="primary" onClick={() =>
              applyCandidates((s.candidatesAsk?.cands ?? []).filter(c => s.candidatesSelected.includes(c.key)))
            }>
              确认补登（{s.candidatesSelected.length}）
            </Button>
          </>
        }
      >
        <p className="text-12 text-ink-400 mb-3">
          勾选要补登到设定表 / 角色卡的条目。绿色=新设定，黄色=疑似已存在需你确认；已登记项不会改动。
        </p>
        <div className="max-h-80 overflow-auto space-y-2">
          {s.candidatesAsk?.cands.map(c => (
            <label key={c.key} className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900 p-2 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={s.candidatesSelected.includes(c.key)}
                onChange={e => toggleCandidate(c.key, e.target.checked)} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-13 text-ink-50 font-medium">{c.name}</span>
                  <span className="text-11 text-ink-400">{c.type}</span>
                  <span className={`text-11 px-1 rounded ${c.status === 'new' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'}`}>
                    {c.status === 'new' ? '新设定' : '疑似重复'}
                  </span>
                </div>
                {c.desc && <div className="text-12 text-ink-300 mt-0.5 break-words">{c.desc}</div>}
              </div>
            </label>
          ))}
        </div>
      </Modal>

      {/* 对话引导：聊完把要点拼回「一句话想法」 */}
      {interview && (
        <InterviewChat
          subject={CREATIVE_SEED_SPEC.subject}
          spec={CREATIVE_SEED_SPEC}
          existing={inp.seed.trim() || undefined}
          callChat={(msgs, opts) => aiChatJson(msgs, { signal: opts.signal })}
          onClose={() => setInterview(false)}
          onApply={filled => {
            const text = seedFromFilled(filled)
            if (text) updateInputs({ seed: text })
            setInterview(false)
            showToast('已填入想法 —— 生成的是要点提纲，改完再开始创作')
          }}
          applyLabel="填入想法"
        />
      )}
    </div>
  )
}

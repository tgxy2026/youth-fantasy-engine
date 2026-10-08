import Panel from './Panel'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { realVolumes } from '../lib/freeVolume'
import * as db from '../lib/db'
import type { Volume, Chapter, TableRow } from '../lib/types'
import {
  PenLine, BookOpen, Flame, Clock, GitBranch, Lightbulb, Sparkles,
  TrendingUp, FileText, ChevronRight, CalendarDays, Zap, Users, Loader2, AlertCircle
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import CharacterDistribution from './CharacterDistribution'
import WritingGoals from './WritingGoals'
import { TABS, tabVisible, type VisCtx } from '../lib/schema'
import { todayKey } from '../lib/date'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { buildProjectContext } from '../lib/aiContext'
import { aiDiagnoseProject, type ProjectDiagnosis } from '../lib/aiTasks'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import { useWordCountWithPunct } from '../lib/wordCountMode'
import { countWords } from '../lib/textStats'
import { buildWritingReview } from '../lib/writingReview'

interface Props {
  onNavigate: (id: string) => void
  refreshKey: number
  /** 项目形态：自定义项目（未启用「伏笔追踪」时）隐藏「未回收伏笔」卡与「伏笔告警」；「角色出场分布」对自定义项目同样隐藏 */
  ctx: VisCtx
}

export default function Dashboard({ onNavigate, refreshKey, ctx }: Props) {
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [foreshadows, setForeshadows] = useState<TableRow[]>([])
  const [ideas, setIdeas] = useState<TableRow[]>([])
  const [progress, setProgress] = useState<TableRow[]>([])
  const [dailyStats, setDailyStats] = useState<db.DailyStat[]>([])
  const [loaded, setLoaded] = useState(false)
  const isLite = ctx.type !== 'full'
  // 完整项目始终展示「未回收伏笔」卡；自定义项目仅在启用了「伏笔追踪」功能时展示
  const showForeshadowCard = ctx.type === 'full' || ctx.features.includes('foreshadow')
  const hiddenTabIds = useMemo(
    () => new Set(TABS.filter(t => !tabVisible(t.id, ctx)).map(t => t.id)),
    [ctx]
  )
  // #004 字数口径开关：默认「只算汉字」（老口径）；切到「汉字＋标点」＝网文平台计费口径。
  // 🔴 落库的 `wordCount` 始终是**不含标点**的口径、不改动用户数据 —— 含标点模式只在显示层
  //    用 countWords(content, 'cjk-punct') 实时重算，所以开关随时可逆、历史数据不会被打脏。
  const [withPunct, setWithPunct] = useWordCountWithPunct()
  /** B1 创作复盘：从每日字数提炼"跟之前比"的指标（纯本地） */
  const review = useMemo(() => buildWritingReview(dailyStats), [dailyStats])

  const totalWords = useMemo(
    () => (withPunct
      ? chapters.reduce((s, c) => s + countWords(c.content || '', 'cjk-punct'), 0)
      : chapters.reduce((s, c) => s + c.wordCount, 0)),
    [chapters, withPunct],
  )

  const load = useCallback(async () => {
    const [v, c, f, i, p, ds] = await Promise.all([
      db.getAllVolumes(), db.getAllChapters(),
      db.getTableRows('foreshadow'), db.getTableRows('ideas'), db.getTableRows('progress'),
      db.getDailyStats(),
    ])
    setVolumes(v); setChapters(c); setForeshadows(f); setIdeas(i); setProgress(p)
    setDailyStats(ds)
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load, refreshKey])

  // AI 健康诊断（可选增强：未配模型不调用，静态提醒照常显示）
  const { ready: aiReady } = useAIReady()
  const [diag, setDiag] = useState<ProjectDiagnosis | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)

  // 渲染期统计与筛选（2026-10-04 六维审计 A5）：数据量随项目增长（章节 / 伏笔 / 灵感表），
  // 包 useMemo 免每次渲染重算（如切换字数口径、诊断弹窗状态变化引起的重渲染）。
  // 🔴 必须放在下面 `if (!loaded) return` **之前** —— hook 不能条件调用。
  const { publishedCount, doneCount, draftCount } = useMemo(() => ({
    publishedCount: chapters.filter(c => c.status === '已发布').length,
    doneCount: chapters.filter(c => c.status === '完稿' || c.status === '已发布').length,
    draftCount: chapters.filter(c => c.status === '草稿' || c.status === '修改').length,
  }), [chapters])
  const unf = useMemo(() => foreshadows.filter(r => {
    const s = Object.entries(r.data).find(([k]) => k.includes('状态'))
    return s ? s[1] === '未回收' : true
  }), [foreshadows])
  const unusedIdeas = useMemo(() => ideas.filter(r => {
    const s = Object.entries(r.data).find(([k]) => k.includes('状态'))
    return s ? s[1] === '未用' : true
  }), [ideas])

  if (!loaded) return <LoadingState />

  // AI 健康诊断：读项目实际资料 + 关键统计，输出健康分 + 风险 + 下一步建议
  const runDiag = async () => {
    setDiagLoading(true); setDiagError(null); setDiag(null)
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('project-diagnose') })
      const r = await aiDiagnoseProject(ctx.text, {
        chapters: chapters.length,
        words: totalWords,
        volumes: volumes.length,
        unf: unf.length,
        unusedIdeas: unusedIdeas.length,
      })
      setDiag(r)
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : String(e))
    } finally {
      setDiagLoading(false)
    }
  }

  // 最近 7 天写作记录（**手工登记**视图 —— 「写作进度」表里自己填的实际字数）
  // ⚠️ 2.9.1 起这组数字只服务下方柱状图；统计卡上的「近 7 日产量」改走自动统计（见 statMap 之后）。
  const today = new Date()
  const days: { date: string; words: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const ds = todayKey(d)
    const rec = progress.find(r => r.data['日期'] === ds)
    const w = rec ? parseInt(rec.data['实际字数'] || '0', 10) || 0 : 0
    days.push({ date: ds, words: w })
  }
  const maxDay = Math.max(...days.map(d => d.words), 1)
  /** 近 7 日**手工登记**字数（只给下方柱状图用） */
  const weekTotal = days.reduce((s, d) => s + d.words, 0)

  // ---- 码字日历（自动记录）----
  const statMap = new Map(dailyStats.map(s => [s.date, s.words]))
  /**
   * 🔴 2.9.1 产量口径统一：统计卡的「近 7 日产量」改走**自动统计**（保存章节时记录的净增量），
   * 与码字日历同源即为权威口径；「写作进度」的手工登记降为参考视图（下方柱状图）。
   * 此前同一面板存在两个不同的「近 7 日」数字（一个手工、一个自动），作者无从判断该信哪个。
   */
  const autoWeekTotal = days.reduce((s, d) => s + (statMap.get(d.date) ?? 0), 0)
  const todayStr = todayKey(new Date())
  const todayWords = statMap.get(todayStr) ?? 0
  // 连续打卡：从今天（或昨天）往前数有产出的连续天数
  let streak = 0
  {
    const cur = new Date()
    if ((statMap.get(todayStr) ?? 0) === 0) cur.setDate(cur.getDate() - 1) // 今天还没写不打断打卡，从昨天起算
    for (;;) {
      const w = statMap.get(todayKey(cur)) ?? 0
      if (w > 0) { streak++; cur.setDate(cur.getDate() - 1) } else break
    }
  }
  // 热力图：近 26 周
  const heatDays: { date: string; words: number }[] = []
  {
    const start = new Date()
    start.setDate(start.getDate() - (26 * 7 - 1))
    for (let i = 0; i < 26 * 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = todayKey(d)
      heatDays.push({ date: key, words: statMap.get(key) ?? 0 })
    }
  }
  // 色阶最低档从 /20 提到 /40：浅色主题（护眼/羊皮卷）下 amber 低透明度与近白背景对比度不足 1.6:1，
  // 有产出的格子看起来和空格子一样，热力图等于失效。四档仍保留递进关系。
  const heatColor = (w: number) =>
    w === 0 ? 'bg-ink-800'
    : w < 500 ? 'bg-amber/40'
    : w < 1500 ? 'bg-amber/60'
    : w < 3000 ? 'bg-amber/80'
    : 'bg-amber'

  const statCards = [
    {
      label: '累计字数',
      value: totalWords > 10000 ? `${(totalWords / 10000).toFixed(2)} 万` : `${totalWords}`,
      sub: `${chapters.length} 章 · ${realVolumes(volumes).length} 卷`,
      icon: <BookOpen size={16} />, color: 'text-amber',
      help: withPunct
        ? '正文编辑器里全部章节的字数之和。当前口径＝汉字＋标点（网文平台计费口径），按正文实时重算，不改动已保存的数据。'
        : '正文编辑器里全部章节的字数之和（汉字按字计、英文按词计，不含标点与空格）。保存章节时自动更新，无需手工登记。',
    },
    {
      label: '完稿章节',
      value: `${doneCount}`,
      sub: `已发布 ${publishedCount} · 草稿中 ${draftCount}`,
      icon: <FileText size={16} />, color: 'text-success',
      help: '统计状态为「完稿」+「已发布」的章节数。章节状态在正文编辑器工具栏的下拉里改，会同步到章节总表。',
    },
    {
      label: '未回收伏笔',
      value: `${unf.length}`,
      sub: unf.length > 5 ? '注意点检防烂尾' : '健康范围',
      icon: <GitBranch size={16} />, color: unf.length > 5 ? 'text-danger' : 'text-info',
      help: '来自「伏笔追踪」中状态为「未回收」的条目。超过 5 条会转红提醒——挖坑速度快于填坑速度是烂尾的头号信号，可到编辑器的伏笔闭环看板逐条点检。',
    },
    {
      label: '近 7 日产量',
      value: `${(autoWeekTotal / 10000).toFixed(2)} 万`,
      sub: `日均 ${Math.round(autoWeekTotal / 7)} 字`,
      icon: <TrendingUp size={16} />, color: 'text-amber',
      help: '来自编辑器自动记录的实际码字量（近 7 天求和，与下方「码字日历」同源）。要对照你手工登记的完成情况，看下方「近 7 日写作字数」。',
    },
  ]

  const quickLinks = [
    { id: 'editor', name: '正文编辑', icon: <PenLine size={15} /> },
    { id: 'chapter-master', name: '章节总表', icon: <FileText size={15} /> },
    { id: 'foreshadow', name: '伏笔追踪', icon: <GitBranch size={15} /> },
    { id: 'timeline', name: '时间脉络', icon: <Clock size={15} /> },
    { id: 'hookpoints', name: '爽点节奏', icon: <Flame size={15} /> },
    { id: 'ideas', name: '灵感素材', icon: <Lightbulb size={15} /> },
  ]

  return (
    <div className="w-full page-enter">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">写作面板</h1>
          <HelpPopover title="写作面板怎么用" width="22rem" size={14}>
            {'全书健康度总览，所有数字都是从各页签实时汇总的，不需要手动维护。\n\n· 统计卡（最多四张）：累计字数 / 完稿章节 / 未回收伏笔 / 近 7 日产量（自定义项目未启用「伏笔追踪」时不显示「未回收伏笔」，仅三张）；\n· 码字日历：在正文编辑器写作时自动打卡，热力图看近 26 周节奏；\n· 近 7 日写作字数：来自「写作进度」手工登记的目标与实际；\n· 快捷入口：常用页签一键直达；\n· 分卷进度 / 创作健康提醒：完稿率与风险点（伏笔堆积、断更、素材闲置）。\n\n每个区块标题旁的 ? 都有更细的说明。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-13 text-ink-300">创作全景一览 · 数据实时同步自各页签</p>
      </header>

      {/* #004 字数口径切换：只影响显示，不改动已保存的数据 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-11 text-ink-500">字数口径</span>
        <Button
          variant="toggle"
          size="xs"
          selected={!withPunct}
          onClick={() => setWithPunct(false)}
          className="px-2.5 py-1 rounded-md text-11"
        >只算汉字</Button>
        <Button
          variant="toggle"
          size="xs"
          selected={withPunct}
          onClick={() => setWithPunct(true)}
          className="px-2.5 py-1 rounded-md text-11"
        >汉字 ＋ 标点</Button>
        <span className="text-10 text-ink-600">平台「作者后台」按「汉字＋标点」统计（含全角空格缩进，与你后台看到的数字对齐）；平台「实际计费字数」通常更小 —— 多会把标点与空格剔掉。切换只影响显示，不会改动已保存的数据</span>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {statCards.filter(c => !(c.label === '未回收伏笔' && !showForeshadowCard)).map(card => (
          <div key={card.label} className="bg-ink-850 border border-ink-700 rounded-xl p-4 card-hover">
            <div className={`flex items-center gap-2 ${card.color}`}>
              {card.icon}
              <span className="text-11 text-ink-400">{card.label}</span>
              <HelpPopover title={card.label} width="18rem" size={11}>
                {card.help}
              </HelpPopover>
            </div>
            <div className="mt-2 text-2xl font-bold text-ink-50 tracking-tight">{card.value}</div>
            <div className="mt-1 text-10 text-ink-500">{card.sub}</div>
          </div>
        ))}
      </div>

      {/* 码字日历 · 打卡 */}
      <Panel className="mb-6">
        <div className="flex flex-wrap items-center gap-6 mb-4">
          <h2 className="text-13 font-semibold text-ink-100 flex items-center gap-2">
            <CalendarDays size={14} className="text-amber" /> 码字日历
            <HelpPopover title="码字日历怎么看" width="21rem">
              {'完全自动记录：只要在正文编辑器里写字并保存，当天产出就会计入（删字也算变动量）。\n\n· 今日 xx 字：今天的净产出；\n· 连续码字：从今天（今天还没写则从昨天）往前数连续有产出的天数，断一天归零；\n· 热力图：近 26 周 × 7 天，颜色越亮当天写得越多（<500 / <1500 / <3000 / 3000+ 四档），鼠标悬停看具体字数。\n\n用它盯「手感」和断更风险，比看总字数更有用。'}
            </HelpPopover>
          </h2>
          {/* 今日产出 */}
          <div className="flex items-center gap-3">
            <div>
              <div className="text-12 text-ink-100 font-semibold">
                今日 {todayWords.toLocaleString()} 字
              </div>
              <div className="text-10 text-ink-500">在正文编辑器写作时自动记录</div>
            </div>
          </div>
          {/* 连续打卡 */}
          <div className="flex items-center gap-2 ml-auto">
            <Zap size={15} className={streak > 0 ? 'text-amber' : 'text-ink-600'} />
            <div>
              <div className="text-15 font-bold text-ink-50 leading-none">{streak} <span className="text-11 font-normal text-ink-400">天连续码字</span></div>
              <div className="text-10 text-ink-500 mt-0.5">{todayWords > 0 ? '今日已打卡 ✓' : '今天还没动笔，去写两章？'}</div>
            </div>
          </div>
        </div>
        {/* 热力图：26 周 × 7 天 */}
        <div className="overflow-x-auto pb-1">
          <div className="flex gap-3px min-w-max">
            {Array.from({ length: 26 }, (_, w) => (
              <div key={w} className="flex flex-col gap-3px">
                {Array.from({ length: 7 }, (_, dow) => {
                  const cell = heatDays[w * 7 + dow]
                  if (!cell) return <div key={dow} className="w-11px h-11px" />
                  return (
                    <div
                      key={dow}
                      title={`${cell.date}：${cell.words} 字`}
                      className={`w-11px h-11px rounded-2 ${heatColor(cell.words)} transition-colors hover:ring-1 hover:ring-amber/60`}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-2 text-9 text-ink-500">
          <span>少</span>
          <span className="w-11px h-11px rounded-2 bg-ink-800 inline-block" />
          <span className="w-11px h-11px rounded-2 bg-amber/40 inline-block" />
          <span className="w-11px h-11px rounded-2 bg-amber/60 inline-block" />
          <span className="w-11px h-11px rounded-2 bg-amber/80 inline-block" />
          <span className="w-11px h-11px rounded-2 bg-amber inline-block" />
          <span>多</span>
          <span className="ml-3">近 26 周 · 数据来自编辑器自动记录（进/减字数都计入当日）</span>
        </div>
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 近7日字数 */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
            <TrendingUp size={14} className="text-amber" /> 近 7 日写作字数（手工登记）
            <HelpPopover title="近 7 日写作字数（手工登记）" width="20rem">
              {'柱子高度 = 「写作进度」里当天登记的实际字数，需要手工登记（可写目标字数与实际字数做对比复盘）。\n\n· 这是「参考视图」：上方统计卡与「码字日历」走的是编辑器自动记录（权威口径），本图是你自己登记的计划完成情况 —— 两者口径不同，不必强求一致；\n· 点下方「去登记今日字数」直接跳到进度表。'}
            </HelpPopover>
          </h2>
          {weekTotal === 0 ? (
            <div className="py-12 text-center text-12 text-ink-500">
              在「写作进度」登记每日字数后，这里会出现柱状图
            </div>
          ) : (
            <div className="flex items-end gap-2 h-32">
              {days.map(d => (
                // 整列撑满 h-32：列本身若靠内容撑高，柱子的百分比高度就没有可参照的确定高度 → 塌成 0
                <div key={d.date} className="flex-1 h-full flex flex-col items-center gap-1.5 group">
                  {/* 字数常显：原先 opacity-0 要悬停才出现，配合柱子塌陷会被误判为"没数据" */}
                  <span className="text-9 text-ink-400 group-hover:text-amber transition-colors">{d.words}</span>
                  {/* 图表区撑满剩余高度，给柱子的百分比高度一个确定的参照父级 */}
                  <div className="w-full flex-1 flex items-end">
                    {/* 柱子用实心 amber：amber/40 在浅色主题（护眼/羊皮卷）下对比度仅约 1.5:1 */}
                    <div
                      className="w-full rounded-t bg-amber group-hover:bg-amber-soft transition-all duration-300"
                      style={{ height: `${Math.max((d.words / maxDay) * 100, 2)}%` }}
                    />
                  </div>
                  <span className="text-9 text-ink-500">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          <Button variant="icon-amber" onClick={() => onNavigate('progress')} className="mt-4 flex items-center gap-1 text-11">
            去登记今日字数 <ChevronRight size={11} />
          </Button>
        </Panel>

        {/* 快捷入口 */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
            <Flame size={14} className="text-amber" /> 快捷入口
            <HelpPopover title="快捷入口" width="19rem">
              {'连载期间使用频率最高的 6 个页签，点一下直达：\n\n· 正文编辑：码字主战场；\n· 章节总表：全书章节台账（字数/伏笔/出场人物）；\n· 伏笔追踪：挖坑填坑总账；\n· 时间脉络：剧情日期与事件对照，防穿帮；\n· 爽点节奏：每章爽点分布，防「太平淡」；\n· 灵感素材：素材随手入库，卡文时来翻。'}
            </HelpPopover>
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {quickLinks.filter(q => !hiddenTabIds.has(q.id)).map(q => (
              <Button variant="bare"
                key={q.id}
                onClick={() => onNavigate(q.id)}
                className="flex flex-col items-center gap-2 py-4 rounded-lg bg-ink-800 border border-ink-700 text-ink-300 hover:border-amber/40 hover:text-amber transition-all card-hover"
              >
                {q.icon}
                <span className="text-11">{q.name}</span>
              </Button>
            ))}
          </div>
        </Panel>

        {/* 卷进度 */}
        {volumes.length > 0 && (
          <Panel>
            <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
              <BookOpen size={14} className="text-amber" /> 分卷进度
              <HelpPopover title="分卷进度" width="19rem">
                {'每卷的完稿率 = （完稿 + 已发布）章节数 ÷ 该卷总章节数。\n\n卷与章在正文编辑器左侧目录里新建/改名；章节状态（构思/细纲/草稿/修改/完稿/已发布）在编辑器工具栏切换，这里会立刻反映。'}
              </HelpPopover>
            </h2>
            <div className="space-y-3">
              {volumes.map(vol => {
                const chs = chapters.filter(c => c.volumeId === vol.id)
                const done = chs.filter(c => c.status === '完稿' || c.status === '已发布').length
                const pct = chs.length ? Math.round((done / chs.length) * 100) : 0
                return (
                  <div key={vol.id}>
                    <div className="flex items-center justify-between text-11 mb-1">
                      <span className="text-ink-200">{vol.title}</span>
                      <span className="text-ink-500">{done}/{chs.length} 章 · {pct}%</span>
                    </div>
                    <div className="h-1.5 bg-ink-700 rounded-full overflow-hidden">
                      <div className="h-full bg-amber/60 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
            <Button variant="icon-amber" onClick={() => onNavigate('editor')} className="mt-4 flex items-center gap-1 text-11">
              去写作 <ChevronRight size={11} />
            </Button>
          </Panel>
        )}

        {/* 待办提醒 */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
            <Clock size={14} className="text-amber" /> 创作健康提醒
            <Button onClick={runDiag}
              disabled={!aiReady || diagLoading}
              
              title={!aiReady ? AI_DISABLED_HINT : '用 AI 基于项目实际资料做一次健康诊断（健康分 + 风险 + 下一步建议）'} variant="secondary" size="md" className="flex items-center rounded">
              {diagLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              AI 诊断
            </Button>
            <HelpPopover title="创作健康提醒" width="20rem">
              {'根据当前数据自动生成的风险清单：\n\n· 未回收伏笔 > 5 条 → 红色告警，建议点检；\n· 灵感素材有未使用素材 → 卡文时先翻它；\n· 近 7 日无产量记录 → 提醒登记进度；\n· 还没有章节 → 建议先填作品信息与全书总纲再动笔。\n\n全部指标健康时会显示「一切健康，保持节奏继续写」。'}
              <AIDataSourceNote feature="project-diagnose" />
            </HelpPopover>
          </h2>
          <div className="space-y-2.5 text-12">
            {showForeshadowCard && unf.length > 5 && (
              <div className="flex items-start gap-2 text-danger">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                <span>未回收伏笔 {unf.length} 条，超过 5 条建议点检一次防烂尾</span>
              </div>
            )}
            {showForeshadowCard && unf.length > 0 && unf.length <= 5 && (
              <div className="flex items-start gap-2 text-info">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                <span>未回收伏笔 {unf.length} 条，处于健康范围</span>
              </div>
            )}
            {unusedIdeas.length > 0 && (
              <div className="flex items-start gap-2 text-ink-300">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber shrink-0" />
                <span>灵感素材有 {unusedIdeas.length} 条未使用素材</span>
              </div>
            )}
            {autoWeekTotal === 0 && (
              <div className="flex items-start gap-2 text-ink-300">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-ink-500 shrink-0" />
                <span>近 7 日无产量记录——打开编辑器写一章，系统会自动记账</span>
              </div>
            )}
            {chapters.length === 0 && (
              <div className="flex items-start gap-2 text-ink-300">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-ink-500 shrink-0" />
                <span>{isLite ? '还没有章节——先想清楚主要人物与核心设定，再开始动笔' : '还没有章节——建议先填「作品信息」与「全书总纲」再动笔'}</span>
              </div>
            )}
            {unf.length === 0 && unusedIdeas.length === 0 && weekTotal > 0 && chapters.length > 0 && (
              <div className="flex items-start gap-2 text-success">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span>一切健康，保持节奏继续写</span>
              </div>
            )}
          </div>

          {diagError && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{diagError}</span>
            </div>
          )}
          {diag && (
            <div className="mt-3 pt-3 border-t border-ink-700 space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-12 font-semibold text-amber">AI 健康诊断</span>
                <span className="text-11 text-ink-400">健康分 <span className="text-ink-100 font-medium">{diag.score}</span>/100</span>
              </div>
              <p className="text-12 text-ink-300 leading-relaxed">{diag.summary}</p>
              {diag.risks.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-11 text-ink-500">风险提示</div>
                  {diag.risks.map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-12">
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${r.level === '严重' ? 'bg-red-400' : r.level === '中等' ? 'bg-amber' : 'bg-sky-400'}`} />
                      <span><span className="text-ink-200">{r.title}</span>{r.detail ? <span className="text-ink-400"> —— {r.detail}</span> : null}</span>
                    </div>
                  ))}
                </div>
              )}
              {diag.nextSteps.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-11 text-ink-500">下一步建议</div>
                  {diag.nextSteps.map((s, i) => (
                    <div key={i} className="flex items-start gap-2 text-12 text-ink-300">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
              )}
              <Button variant="bare" onClick={() => setDiag(null)} className="text-11 text-ink-500 hover:text-ink-300">收起诊断</Button>
            </div>
          )}
        </Panel>
      </div>

      {/* 写作目标与完稿预估 */}
      <Panel className="mt-6">
        <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
          <TrendingUp size={14} className="text-amber" /> 写作目标与完稿预估
          <HelpPopover title="写作目标与完稿预估" width="21rem">
            {'设定每日目标字数 / 全书目标字数 / 完稿截止日（自动保存），系统会：\n\n· 实时显示当前总字数、近 7 日日均、距目标差额；\n· 按「剩余字数 ÷ 近 7 日日均」预估所需天数；\n· 若按当前节奏赶不上截止日，给出红色提醒。\n\n日均取自「写作进度 / 自动码字记录」近 7 天，没有产量记录时无法预估。'}
          </HelpPopover>
        </h2>
        <WritingGoals totalWords={totalWords} dailyStats={dailyStats} />
      </Panel>

      {/* 角色出场分布 */}
      {!isLite && (
      <Panel className="mt-6">
        <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
          <Users size={14} className="text-amber" /> 角色出场分布
          <HelpPopover title="角色出场分布" width="22rem">
            {'自动扫描各章正文，统计每位角色（主要 / 次要，不含 NPC 与已退场）在每章的出现次数，用热力矩阵呈现：\n\n· 颜色越亮 = 该章出场越多；\n· 展示全部（主要 / 次要，不含 NPC 与已退场）角色与全部章节；\n· 点任意单元格直达对应章节。\n\n用来发现「某角色写了三卷没再出场」或「主角某章莫名消失」这类失衡。'}
          </HelpPopover>
        </h2>
        <CharacterDistribution onNavigate={onNavigate} />
      </Panel>
      )}

      {/* 创作复盘（B1 · 2.4.1）
          ⚠️ 刻意**不做**第三个字数图表：上方热力图与近 7 日柱状图回答的是"现在怎么样"，
          这里回答的是"**跟之前比**怎么样" —— 全是对比与记录类指标，重复画图只会更挤。 */}
      <Panel className="mt-6">
        <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
          <TrendingUp size={14} className="text-amber" /> 创作复盘
          <HelpPopover title="创作复盘怎么看" width="23rem">
            {'回顾「跟之前比」的情况，与上方热力图 / 近 7 日柱状图（看「当前状态」）互补：\n\n· 本周 vs 上周：近 7 天与前 7 天的净字数对比（上周为 0 时不编造增幅，只标「上周还没开始」）；\n· 连续写作：历史最长与当前连续天数 —— 今天还没动笔不算断，不用凌晨赶工；\n· 最高产的一天 / 本月产量。\n\n数据来自软件本就记录的每日字数净增量（增删都记，所以删字那天会显示负数，是如实的）。纯本地计算，不联网。'}
          </HelpPopover>
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* 本周 vs 上周 */}
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
            <div className="text-10 text-ink-500">本周（近 7 天）</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-16 font-bold text-ink-100 tabular-nums">{review.thisWeek.toLocaleString('zh-CN')}</span>
              <span className="text-10 text-ink-500">字</span>
            </div>
            <div className={`mt-0.5 text-10 ${
              review.weekTrend === 'up' ? 'text-rose-400'
              : review.weekTrend === 'down' ? 'text-success'
              : 'text-ink-500'
            }`}>
              {review.weekTrend === 'new' ? '上周还没开始'
                : review.weekTrend === 'none' ? '暂无对比数据'
                : review.weekDeltaPct === null ? '—'
                : `较上周 ${review.weekDeltaPct > 0 ? '+' : ''}${review.weekDeltaPct}%`}
            </div>
          </div>

          {/* 连续写作 */}
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
            <div className="text-10 text-ink-500">连续写作</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-16 font-bold text-ink-100 tabular-nums">{review.currentStreak}</span>
              <span className="text-10 text-ink-500">天</span>
            </div>
            <div className="mt-0.5 text-10 text-ink-500">
              历史最长 {review.longestStreak} 天
              {review.longestStreakRange ? `（${review.longestStreakRange.from.slice(5)} ~ ${review.longestStreakRange.to.slice(5)}）` : ''}
            </div>
          </div>

          {/* 最高产的一天 */}
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
            <div className="text-10 text-ink-500">最高产的一天</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-16 font-bold text-ink-100 tabular-nums">
                {review.bestDay ? review.bestDay.words.toLocaleString('zh-CN') : '—'}
              </span>
              {review.bestDay && <span className="text-10 text-ink-500">字</span>}
            </div>
            <div className="mt-0.5 text-10 text-ink-500">{review.bestDay ? review.bestDay.date : '还没有记录'}</div>
          </div>

          {/* 本月产量 */}
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
            <div className="text-10 text-ink-500">本月产量</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-16 font-bold text-ink-100 tabular-nums">{review.thisMonth.toLocaleString('zh-CN')}</span>
              <span className="text-10 text-ink-500">字</span>
            </div>
            <div className="mt-0.5 text-10 text-ink-500">
              {totalWords > 0 ? `占全书约 ${Math.round((review.thisMonth / totalWords) * 100)}%` : '—'}
            </div>
          </div>
        </div>

        {review.insights.length > 0 && (
          <ul className="mt-3 space-y-1">
            {review.insights.map((s, i) => (
              <li key={i} className="text-11 leading-relaxed text-ink-400">· {s}</li>
            ))}
          </ul>
        )}

        <div className="mt-3 text-10 text-ink-500">
          共动笔 {review.activeDays} 天
          {review.firstDay ? ` · 首次 ${review.firstDay}` : ''}
          {review.lastDay ? ` · 最近 ${review.lastDay}` : ''}
        </div>
      </Panel>
    </div>
  )
}

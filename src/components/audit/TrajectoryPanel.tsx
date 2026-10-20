/**
 * 创作轨迹（2.4.0 · A4）—— 「这一章是怎么写出来的」。
 *
 * 【它回答什么问题】
 * 作者要投稿、要报名、要跟编辑解释时，常需要说清"我是怎么写出来的"。
 * 本页把本机已有的三类记录摆到一条时间线上：细纲 → 各次改动 → 当前稿，
 * 外加逐日字数，并能把整份材料导成**证据包**（PDF / HTML / JSON）。
 *
 * 🔴 三条产品纪律（写在这里，改代码前先读）：
 *   ① **只如实呈现**：缺数据就写"没有"，版本被清理了就写"已清理"。
 *      绝不补全、不推测、不美化（`lib/trajectory.ts` 的 retention 就是干这个的）。
 *   ② **不做对抗检测**：本页与证据包里不出现任何「降低 AI 命中率 / 洗掉痕迹」一类说法。
 *      我们只记录过程，不参与军备竞赛。
 *   ③ **不采集输入**：所有数据都来自软件本就有的记录（时间戳 / 快照 / 每日字数），
 *      没有键盘记录，导出不联网。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileDiff, History, FileDown, FileUp, Loader2, AlertTriangle, BookOpen, BookMarked, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter, Volume, CardRecord } from '@/lib/types'
import type { Snapshot } from '@/lib/db'
import { chapterSeqMap, orphanChapters } from '@/lib/outline/chapterSeq'
import {
  buildChapterTrajectory, buildTrajectoryOverview, findOutlineCard,
  isAIVersion, type TrajectoryNode,
} from '@/lib/ai/trajectory'
import { buildEvidencePack, shortDate } from '@/lib/audit/evidencePack'
import { WEB } from '@/lib/app/platform'
import { buildBookEvidencePack } from '@/lib/audit/bookEvidence'
import { foldVh } from '@/lib/settings/theme'
import { summarizeAiAssist, AI_SOURCE_LABELS, AI_SOURCE_KINDS } from '@/lib/ai/aiAssist'
import AiDisclosureDialog from '@/components/dialogs/AiDisclosureDialog'
import HelpPopover from '@/components/common/HelpPopover'
import { Button } from '@/components/common/Button'
import SelectRow from '@/components/common/SelectRow'
import { showToast } from '@/components/dialogs/dialogs'
import EvidenceExportDialog from '@/components/audit/EvidenceExportDialog'
import RunLedgerPanel from '@/components/ai/RunLedgerPanel'
// 3.2.0 · W3：候选审阅（AI 产出、作者决定的稿子）
import CandidatePanel from '@/components/revision/CandidatePanel'
import BookVersionPanel from '@/components/app/BookVersionPanel'

const OUTLINE_TAB = 'chapter-outline'

/** 时间戳 → `M-D HH:MM`（列表里空间紧） */
function fmtShort(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 节点在时间线上的圆点配色：AI 动笔前的旧稿最值钱，用琥珀点出来 */
function dotClass(n: TrajectoryNode): string {
  if (n.stage === 'outline') return 'bg-ink-500'
  if (n.stage === 'current') return 'bg-emerald-400'
  return isAIVersion(n.source) ? 'bg-amber' : 'bg-ink-400'
}

export default function TrajectoryPanel() {
  // 3.0 · W1-1：AI 运行账本 —— 从「关于打赏」挪到本页（与「创作轨迹」同为「过程留痕」，放一起更顺）
  const [ledgerOpen, setLedgerOpen] = useState(false)
  // 3.0 · W3-1：定稿与版本 —— 同属「这本书的里程碑 / 留痕」，与账本并列
  const [versionOpen, setVersionOpen] = useState(false)
  // 3.2.0 · W3：候选审阅面板
  const [candidateOpen, setCandidateOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [projectName, setProjectName] = useState('')
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [cards, setCards] = useState<CardRecord[]>([])
  const [dailyStats, setDailyStats] = useState<{ date: string; words: number }[]>([])
  const [activeId, setActiveId] = useState('')
  /**
   * 3.0.1：章节列表按卷折叠 —— 记为「被收起的卷标题」集合（默认全展开，行为不变）。
   * 用 key 而非下标，卷重命名/增删后折叠态不会串位。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  /** 全书快照（整书证据包用；一次全表读，别对每章再查一次） */
  const [allSnapshots, setAllSnapshots] = useState<Snapshot[]>([])
  const [exportOpen, setExportOpen] = useState(false)
  /** 🔴 B3：AI 使用情况申报说明弹窗 */
  const [aiDraftOpen, setAiDraftOpen] = useState(false)
  /**
   * 🔴 B3：全书 AI 辅助占比汇总（数据源＝各章的 `aiAssist` 字段，由 AI 产出时自动记账）。
   * 口径见 `lib/aiAssist.ts`：记「累计产出量」，可能大于现存字数 ⇒ 占比封顶 100% 且如实说明。
   */
  const aiSummary = useMemo(() => summarizeAiAssist(chapters), [chapters])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const pid = db.getCurrentProjectId()
      const [pj, vols, chs, cs, ds, snaps] = await Promise.all([
        pid ? db.getProject(pid).catch(() => undefined) : Promise.resolve(undefined),
        db.getAllVolumes().catch(() => [] as Volume[]),
        db.getAllChapters().catch(() => [] as Chapter[]),
        db.getCardRecords(OUTLINE_TAB).catch(() => [] as CardRecord[]),
        db.getDailyStats().catch(() => [] as { date: string; words: number }[]),
        // 整书证据包要按章统计版本数 —— 一次全表读，不比逐章查慢
        db.getAllSnapshots().catch(() => [] as Snapshot[]),
      ])
      setProjectName(pj?.name ?? '')
      setVolumes(vols)
      setChapters(chs)
      setCards(cs)
      setDailyStats(ds)
      setAllSnapshots(snaps)
      // 默认选中：优先"已有正文的第一章"（空项目则选第一章），都没有则不选
      setActiveId(prev => {
        if (prev && chs.some(c => c.id === prev)) return prev
        const sorted = [...chs].sort((a, b) => (a.volumeId === b.volumeId ? a.order - b.order : 0))
        return (sorted.find(c => c.wordCount > 0) ?? sorted[0])?.id ?? ''
      })
    } catch (e) {
      showToast(`读取创作记录失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // 选中章节后单独取它的快照（列表里不预先查全部，避免 N 次查询）
  useEffect(() => {
    if (!activeId) { setSnapshots([]); return }
    let alive = true
    db.getSnapshots(activeId).then(s => { if (alive) setSnapshots(s) }).catch(() => { if (alive) setSnapshots([]) })
    return () => { alive = false }
  }, [activeId])

  const seqs = useMemo(() => chapterSeqMap(volumes, chapters), [volumes, chapters])
  const active = useMemo(() => chapters.find(c => c.id === activeId) ?? null, [chapters, activeId])

  const traj = useMemo(() => {
    if (!active) return null
    return buildChapterTrajectory({
      chapter: active, volumes, chapters, snapshots,
      outline: findOutlineCard(seqs.get(active.id) ?? 0, cards),
      dailyStats,
    })
  }, [active, volumes, chapters, snapshots, cards, dailyStats, seqs])

  const overview = useMemo(() => buildTrajectoryOverview(chapters, dailyStats), [chapters, dailyStats])

  const pack = useMemo(
    () => (traj ? buildEvidencePack(traj, projectName) : null),
    [traj, projectName],
  )

  /** 整书证据包（A4 遗留补全）：与本章包共用同一个导出弹窗，弹窗里切「范围」即可 */
  const bookPack = useMemo(
    () => buildBookEvidencePack({
      projectName, chapters, volumes, snapshots: allSnapshots,
      outlineCards: cards, dailyStats,
    }),
    [projectName, chapters, volumes, allSnapshots, cards, dailyStats],
  )

  // 章列表按卷分组（卷顺序即列表顺序）
  const groups = useMemo(() => {
    const out: { title: string; items: Chapter[] }[] = []
    for (const v of volumes) {
      const items = chapters.filter(c => c.volumeId === v.id).sort((a, b) => a.order - b.order)
      if (items.length) out.push({ title: v.title || '未命名卷', items })
    }
    // 孤儿章判定走唯一真源（与 flattenAll 同口径）
    const orphan = orphanChapters(volumes, chapters)
    if (orphan.length) out.push({ title: '未分卷章节', items: orphan })
    return out
  }, [volumes, chapters])

  // 3.0.1：卷折叠 —— 切换单卷 / 全部展开 / 全部收起（默认全展开）
  const toggleGroup = useCallback((title: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }, [])
  const anyExpanded = groups.some(g => !collapsed.has(g.title))
  const toggleAll = useCallback(() => {
    setCollapsed(prev => {
      const expanded = groups.filter(g => !prev.has(g.title))
      // 只要还有展开的卷 → 全部收起；否则 → 全部展开
      return expanded.length > 0 ? new Set(groups.map(g => g.title)) : new Set()
    })
  }, [groups])

  // 写作分布：最多画最近 60 天（再多柱子就糊成一片了）
  // 全部日期都显示（A4 遗留补全）：天数多时靠横向滚动看全，不再截断 —— 轨迹本就该看得完整
  const dailyShown = useMemo(() => (traj ? traj.daily : []), [traj])
  const dailyMax = useMemo(() => Math.max(1, ...dailyShown.map(d => d.words)), [dailyShown])

  if (loading) {
    return (
      <div className="w-full page-enter flex items-center justify-center gap-2 text-ink-400 text-13" style={{ height: foldVh('60vh') }}>
        <Loader2 size={14} className="animate-spin" /> 正在读取创作记录…
      </div>
    )
  }

  return (
    // 🔴 2026-10-17：根容器锁高 + 恒双栏独立滚动 —— 与 MasterDetail（角色卡 / 大纲卡）同范式
    //    （主人 3.1.2 要求主从双栏全局一致）。顶部总览 / AI 占比 shrink-0 常驻，
    //    章节列表与轨迹详情各自滚；窄窗并排挤一挤，不堆叠（堆叠必压瘪一栏）。
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* 3.0 · W1-1：AI 运行账本（只读留痕） */}
      {ledgerOpen && <RunLedgerPanel onClose={() => setLedgerOpen(false)} />}
      {versionOpen && <BookVersionPanel onClose={() => setVersionOpen(false)} onRestored={() => void load()} />}
      {candidateOpen && <CandidatePanel onClose={() => setCandidateOpen(false)} />}
      <header className="mb-5 shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">创作轨迹</h1>
          <HelpPopover title="创作轨迹怎么用" width="23rem" size={14}>
            {`按章回看「这一章是怎么写出来的」：细纲 → 各次改动 → 当前稿，附逐日字数。\n\n· 数据全部来自软件本就有的记录（章节时间戳、自动快照、每日字数），不另外采集你的操作；证据包在本机生成，保存位置由你选择；\n· 每章最多保留 12 个历史版本，超出后会自动清理最旧的 —— 若早期版本已不在，页面会如实写明，不会假装完整；\n· 可导出证据包：PDF（${WEB ? '网页版下载 HTML 后另存' : '桌面版一键保存'}）/ 单文件 HTML（可打印）/ JSON（供机器核验）。\n\n用途：投稿、报名、跟编辑说明创作过程时，用来自证。软件不做、也不参与任何「规避 AI 检测」的事情。`}
          </HelpPopover>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setCandidateOpen(true)} className="gap-1.5"
              title="查看 AI 产出的候选稿并决定是否应用到正文（会先比对正文，被改过会拒绝）">
              <FileDiff size={12} /> 候选审阅
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setVersionOpen(true)} className="gap-1.5"
              title="冻结这一版、回看版本历史（定稿快照）">
              <BookMarked size={12} /> 定稿与版本
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setLedgerOpen(true)} className="gap-1.5"
              title="回看这本书的 AI 调用留痕：跑过哪些任务、成没成、产出多少">
              <History size={12} /> AI 运行账本
            </Button>
          </div>
        </div>
        <p className="mt-1 text-13 text-ink-300">细纲 → 各次改动 → 当前稿 · 可导出证据包</p>
      </header>

      {/* 全书总览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5 shrink-0">
        <StatCard label="总字数" value={`${overview.totalWords.toLocaleString()}`} unit="字" />
        <StatCard label="章节" value={`${overview.writtenChapters}`} unit={`/ ${overview.totalChapters} 章已有正文`} />
        <StatCard label="写作天数" value={`${overview.activeDays}`} unit={`/ 跨度 ${overview.spanDays} 天`} />
        <StatCard label="最近动笔" value={overview.lastAt ? shortDate(new Date(overview.lastAt).toISOString().slice(0, 10)) : '—'} unit="" />
      </div>

      {/* 🔴 B3：AI 辅助占比 —— 如实申报的入口。
          口径刻意写成「累计产出量」：AI 写完作者常会再改，改完无法反推，
          所以这里显示的是"产出过多少"，**不是**"成稿里有多少是 AI 的"。 */}
      <section className="mb-5 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-12 text-ink-300">AI 辅助占比</span>
            <span className="text-17 font-bold text-amber tabular-nums">{aiSummary.ratioPct}%</span>
            <span className="text-11 text-ink-500">
              （累计产出 {aiSummary.aiChars.toLocaleString('zh-CN')} 字 · {aiSummary.aiChapters} 章用过 AI）
            </span>
          </div>
          <div className="ml-auto">
            <Button variant="secondary" size="sm" onClick={() => setAiDraftOpen(true)}>
              <FileDown size={12} /> 生成申报说明
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {AI_SOURCE_KINDS.map(k => (
            <span
              key={k}
              className={`rounded-md border px-2 py-0.5 text-11 ${
                aiSummary.chars[k] > 0
                  ? 'border-ink-700 bg-ink-900/60 text-ink-300'
                  : 'border-ink-700 bg-transparent text-ink-600'
              }`}
            >
              {AI_SOURCE_LABELS[k]} {aiSummary.chars[k].toLocaleString('zh-CN')}
            </span>
          ))}
        </div>

        <p className="mt-2 text-10 leading-relaxed text-ink-500">
          数字由软件在 AI 产出时自动记录（整章改写 / 自动续写 / 伴写采纳 / 创意写作 / 选区改稿），非手工填写。
          {aiSummary.cappedChapters > 0 && (
            <span className="text-amber"> 有 {aiSummary.cappedChapters} 章经人工大幅删改，实际留存比例低于此数字。</span>
          )}
        </p>
      </section>

      {/* 🔴 2026-10-17：恒双栏 + 锁高（原来是 grid 双栏、跟页滚）——
          章节列表与轨迹详情两栏各自独立滚动，互不带动 */}
      <div className="flex flex-1 min-h-0 gap-4">
        {/* 左：章节列表 */}
        <aside className="w-64 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-ink-700 text-11 text-ink-400 flex items-center justify-between gap-2">
            <span>选择章节</span>
            {groups.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                title={anyExpanded ? '全部收起' : '全部展开'}
                className="inline-flex items-center gap-1 text-10 text-ink-500 hover:text-ink-200 transition-colors"
              >
                {anyExpanded ? <ChevronsDownUp size={11} /> : <ChevronsUpDown size={11} />}
                {anyExpanded ? '收起' : '展开'}
              </button>
            )}
          </div>
          {/* 唯一滚动区：flex-1 + min-h-0 吃满左栏剩余高度（🔴 min-h-0 不能删） */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-11 text-ink-500 text-center">这个项目还没有章节</div>
            ) : groups.map(g => {
              const open = !collapsed.has(g.title)
              return (
                <div key={g.title}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.title)}
                    className="w-full px-3 pt-2.5 pb-1 flex items-center gap-1 text-10 text-ink-500 hover:text-ink-300 transition-colors"
                  >
                    <ChevronRight size={11} className={'shrink-0 transition-transform ' + (open ? 'rotate-90' : '')} />
                    <span className="truncate">{g.title}</span>
                    <span className="shrink-0 tabular-nums">{g.items.length}</span>
                  </button>
                  {open && g.items.map(ch => (
                    <SelectRow
                      key={ch.id}
                      selected={ch.id === activeId}
                      onClick={() => setActiveId(ch.id)}
                      className="px-3 py-1.5 items-center gap-2 text-12"
                    >
                      <span className="shrink-0 w-7 text-10 text-ink-500 tabular-nums">{seqs.get(ch.id) || ''}</span>
                      <span className="flex-1 truncate">{ch.title || '（未命名）'}</span>
                      <span className="shrink-0 text-10 text-ink-500 tabular-nums">{ch.wordCount}</span>
                    </SelectRow>
                  ))}
                </div>
              )
            })}
          </div>
        </aside>

        {/* 右：轨迹详情（独立滚动） */}
        <section className="min-w-0 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">
          {!traj ? (
            <div className="rounded-xl border border-ink-700 bg-ink-850/40 flex items-center justify-center text-13 text-ink-500" style={{ height: foldVh('40vh') }}>
              左侧选一章，这里显示它的创作轨迹
            </div>
          ) : (
            <div className="space-y-4">
              {/* 概况 + 导出 */}
              <div className="rounded-xl border border-ink-700 bg-ink-850/40 p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <BookOpen size={14} className="text-amber shrink-0" />
                      <span className="text-14 font-semibold text-ink-100 truncate">{traj.title}</span>
                      {traj.no > 0 && <span className="shrink-0 text-10 text-ink-500">第 {traj.no} 章</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-11 text-ink-400">
                      <span>当前 {traj.currentWords} 字</span>
                      <span>本机保留 {traj.retainedVersions} 个历史版本</span>
                      <span>跨度 {traj.spanDays} 天 · 有写作记录 {traj.activeDays} 天</span>
                      {traj.wordDelta !== null && (
                        <span>较最早版本 {traj.wordDelta >= 0 ? '+' : ''}{traj.wordDelta} 字</span>
                      )}
                    </div>
                  </div>
                  <Button variant="primary" size="sm" onClick={() => setExportOpen(true)} className="shrink-0 flex items-center gap-1.5">
                    <FileUp size={13} /> 导出证据包
                  </Button>
                </div>

                {/* 保留情况：不足时如实提醒（这是「可信」的一部分，不能藏） */}
                {traj.likelyTruncated && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2">
                    <AlertTriangle size={13} className="text-amber shrink-0 mt-0.5" />
                    <p className="text-11 text-ink-200 leading-relaxed">
                      本章更早的版本可能已被自动清理（每章最多保留 12 个）。下面的时间线是本机实际保留的部分，
                      证据包里也会如实写明这一点。
                    </p>
                  </div>
                )}
              </div>

              {/* 时间线 */}
              <div className="rounded-xl border border-ink-700 bg-ink-850/40 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <History size={13} className="text-ink-400" />
                  <span className="text-12 font-semibold text-ink-200">创作过程时间线</span>
                  <span className="text-10 text-ink-500">（细纲时间取卡片创建时间；老卡片未记录则显示「—」）</span>
                </div>
                <div className="space-y-0">
                  {traj.nodes.map((n, i) => (
                    <div key={i} className="flex gap-3">
                      <div className="w-24 shrink-0 text-right text-10 text-ink-500 pt-0.5 tabular-nums">
                        {n.at ? fmtShort(n.at) : '起点'}
                      </div>
                      <div className="relative flex flex-col items-center">
                        <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dotClass(n)}`} />
                        {i < traj.nodes.length - 1 && <span className="w-px flex-1 bg-ink-700" />}
                      </div>
                      <div className="min-w-0 flex-1 pb-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-11 ${isAIVersion(n.source) ? 'text-amber' : 'text-ink-200'}`}>{n.label}</span>
                          {n.wordCount !== undefined && <span className="text-10 text-ink-500">{n.wordCount} 字</span>}
                        </div>
                        <p className="mt-0.5 text-11 text-ink-400 leading-relaxed line-clamp-2">{n.preview || '（空）'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 写作分布 */}
              <div className="rounded-xl border border-ink-700 bg-ink-850/40 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-12 font-semibold text-ink-200">写作分布</span>
                  <span className="text-10 text-ink-500">
                    （口径：本项目当天写的总字数，软件不按章节拆分；天数多时可横向滚动看全）
                  </span>
                </div>
                {dailyShown.length === 0 ? (
                  <p className="py-6 text-11 text-ink-500 text-center">该章时间跨度内没有每日字数记录</p>
                ) : (
                  <>
                    <div className="overflow-x-auto pb-1">
                      <div className="flex items-end gap-1 h-20 mt-3" style={{ minWidth: `${dailyShown.length * 10}px` }}>
                        {dailyShown.map(d => (
                          <div
                            key={d.date}
                            className={`w-2 shrink-0 rounded-t ${d.words > 0 ? 'bg-amber/70' : 'bg-ink-700'}`}
                            style={{ height: `${Math.max(2, Math.round((d.words / dailyMax) * 76))}px` }}
                            title={`${d.date}　${d.words} 字`}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="mt-1.5 flex justify-between text-10 text-ink-500">
                      <span>{shortDate(dailyShown[0].date)}</span>
                      {dailyShown.length > 1 && <span>{shortDate(dailyShown[dailyShown.length - 1].date)}</span>}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {pack && (
        <EvidenceExportDialog
          open={exportOpen} onClose={() => setExportOpen(false)}
          pack={pack} bookPack={bookPack}
        />
      )}

      {/* 🔴 B3：AI 使用情况申报说明（数字来自软件自动记录，非手填） */}
      <AiDisclosureDialog
        open={aiDraftOpen} onClose={() => setAiDraftOpen(false)}
        summary={aiSummary} bookName={projectName}
      />
    </div>
  )
}

function StatCard({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-3">
      <div className="text-10 text-ink-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-17 font-bold text-ink-100 tabular-nums">{value}</span>
        {unit && <span className="text-10 text-ink-500">{unit}</span>}
      </div>
    </div>
  )
}

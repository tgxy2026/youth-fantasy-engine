/**
 * 市场雷达弹窗（2.8.0 · 台账 #018）。
 *
 * 【干什么】选题阶段的困惑：「这个题材现在还有没有市场？哪个平台合适？该蹭什么热点？」
 * 本弹窗把「多条检索词 → 联网查 → 模型归纳 → 结构化成报告」串成一步，挂在「作品信息」页页头。
 *
 * 🔴 三条与 lib 同源的红线（本组件只是展示层，别在界面上改口径）：
 *   ① **不静默失败**：失败一律把中文原因红框显示出来（未配置检索 / 断网 / 没查到…）；
 *   ② **口径如实**：报告恒带 `disclaimer`，界面照抄 `report.disclaimer`，不加工成结论口吻；
 *   ③ **不代写内容**：报告只给趋势与机会点，界面不提供任何「一键生成正文 / 大纲」的入口。
 *
 * 🔴 长任务走任务中心（`useTaskRunner`）：检索 + 归纳可能几十秒，切页签不中止、结果原样留着。
 *    `ownerTab` 必须是**页签 id**（`positioning`）而不是组件名 —— 任务指示器靠它跳回来。
 *
 * 🔴 本功能**只读不写项目数据**：不碰 formData / 章节表。趋势项上的「加为标签」只是把词追加到
 *    本次输入框（供下一次查得更准），**不会**替你改作品信息。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Radar, Loader2, Sparkles, ExternalLink, Copy, Square,
  TrendingUp, Compass, Lightbulb, AlertTriangle, Link2,
} from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import AIDataSourceNote from '@/components/AIDataSourceNote'
import { copyText, showToast } from '@/components/dialogs'
import { openExternalUrl } from '@/lib/desktop'
import { useAIReady } from '@/lib/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/aiScope'
import { useTaskRunner } from '@/lib/aiTaskCenter'
import {
  runMarketRadar, RADAR_DISCLAIMER, RADAR_MAX_QUERIES,
  type RadarReport, type RadarTrendItem,
} from '@/lib/aiTasks'

/** 本弹窗在任务中心里的身份（`ownerTab` 必须与 TABS 里的页签 id 一致） */
const OWNER_TAB = 'positioning'
const TASK_KIND = 'market-radar'
const TASK_TITLE = '市场雷达'

/** `runMarketRadar` **永不抛** —— 失败也 resolve 成 `{ok:false}`，故结果类型自带 ok/error */
type RadarTaskResult = { ok: boolean; report?: RadarReport; error?: string }

/** 热度档 → 中文标（🔴 与提示词里 rising|stable|cooling 三档一一对应，别自增档位） */
const HEAT_LABEL: Record<RadarTrendItem['heat'], string> = {
  rising: '升温',
  stable: '平稳',
  cooling: '降温',
}
/**
 * 热度标配色：**刻意不用红 / 绿** —— 在中文语境里红涨绿跌是股市语义，
 * 拿来标「题材热度」会被读成「该买 / 该跑」。改用中性琥珀（升温）/ 灰（平稳）/ 蓝（降温）。
 */
const HEAT_CLS: Record<RadarTrendItem['heat'], string> = {
  rising: 'border-amber/40 text-amber bg-amber/15',
  stable: 'border-ink-600 text-ink-300 bg-ink-800',
  cooling: 'border-info/30 text-info bg-info/10',
}

/** 输入框统一外观（项目内文本输入一律这个令牌组合） */
const INPUT_CLS = 'w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-12 text-ink-200 outline-none focus:border-amber placeholder:text-ink-600'

/** 逗号 / 顿号 / 空白 分隔 → 词数组（去重、去空） */
function splitWords(s: string): string[] {
  const out: string[] = []
  for (const p of s.split(/[,，、;；\s]+/)) {
    const t = p.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 报告 → 可粘贴的 Markdown（作者要发给自己 / 存进素材库时用） */
function reportToMarkdown(r: RadarReport): string {
  const L: string[] = []
  L.push('# 市场雷达报告')
  L.push(`- 生成时间：${new Date(r.generatedAt).toLocaleString()}`)
  L.push(`- 检索词：${r.queries.join(' / ') || '（无）'}`)
  L.push('')
  if (r.trend.length) {
    L.push('## 题材趋势')
    for (const t of r.trend) L.push(`- **${t.topic}**（${HEAT_LABEL[t.heat]}）${t.note ? ' —— ' + t.note : ''}`)
    L.push('')
  }
  if (r.platformFit.length) {
    L.push('## 平台适配')
    for (const p of r.platformFit) L.push(`- **${p.platform}**${p.note ? '：' + p.note : ''}`)
    L.push('')
  }
  if (r.opportunities.length) {
    L.push('## 机会点')
    for (const s of r.opportunities) L.push(`- ${s}`)
    L.push('')
  }
  if (r.risks.length) {
    L.push('## 风险点')
    for (const s of r.risks) L.push(`- ${s}`)
    L.push('')
  }
  if (r.sources.length) {
    L.push('## 来源')
    for (const s of r.sources) L.push(`- ${s.title}${s.url ? ' ' + s.url : ''}`)
    L.push('')
  }
  L.push('> ' + (r.disclaimer || RADAR_DISCLAIMER))
  return L.join('\n')
}

interface Props {
  open: boolean
  onClose: () => void
  /** 「作品信息」里已有的方向，打开时预填（作者可改；查的是公开网络，不涉及项目数据外发） */
  defaultGenre?: string
  defaultPlatform?: string
}

export default function MarketRadarDialog({ open, onClose, defaultGenre = '', defaultPlatform = '' }: Props) {
  const { ready: aiReady } = useAIReady()
  const [genre, setGenre] = useState('')
  const [platform, setPlatform] = useState('')
  const [tags, setTags] = useState('')
  const [keywords, setKeywords] = useState('')

  /**
   * 每次打开都按作品信息**重新预填**方向（作者刚改过赛道，下次打开就该看到新的）。
   * 🔴 标签 / 关键词是本次检索的临时输入，一并重置 —— 免得上一轮的词混进这一轮。
   */
  useEffect(() => {
    if (!open) return
    setGenre(defaultGenre)
    setPlatform(defaultPlatform)
    setTags('')
    setKeywords('')
  }, [open, defaultGenre, defaultPlatform])

  const tagList = useMemo(() => splitWords(tags), [tags])
  const kwList = useMemo(() => splitWords(keywords), [keywords])

  const t = useTaskRunner<RadarTaskResult>({ ownerTab: OWNER_TAB, kind: TASK_KIND, title: TASK_TITLE })
  const running = t.running
  const report = t.result?.ok ? t.result.report : undefined
  const failure = t.result && !t.result.ok ? (t.result.error || '未知原因') : ''

  const canRun = !running && (!!genre.trim() || !!platform.trim() || kwList.length > 0)

  const start = () => {
    if (running) return
    if (!aiReady) { showToast('还没接入模型，无法归纳检索结果', 'info'); return }
    const input = {
      genre: genre.trim(),
      platform: platform.trim(),
      tags: tagList,
      keywords: kwList,
    }
    if (!input.genre && !input.platform && input.keywords.length === 0) {
      showToast('先填题材、平台或关键词，雷达才有可查的方向', 'info')
      return
    }
    // 🔴 输入在此**快照**进闭包：任务跑在 store 里，跑的过程中组件可能已卸载（切页签 / 关弹窗）
    t.run(
      async ctx => runMarketRadar(input, { signal: ctx.signal }),
      ({ status, result, error }) => {
        if (status === 'failed') return { text: `市场雷达失败：${error || '未知原因'}`, kind: 'error' as const }
        // 任务「跑完了但没查成」也是失败 —— 作者可能已切走，必须说出来（结果区他此刻看不到）
        if (status === 'done' && result && !result.ok) return { text: `市场雷达没跑成：${result.error || '未知原因'}`, kind: 'error' as const }
        return null
      },
    )
  }

  const openLink = async (url: string) => {
    if (!url) return
    const r = await openExternalUrl(url)
    if (!r.ok) {
      // 没有主进程桥（浏览器 dev / 便携版）→ 降级 window.open，别让按钮点了没反应
      window.open(url, '_blank', 'noopener,noreferrer')
      showToast('已在浏览器打开（当前环境无桌面桥）', 'info')
    }
  }

  /** 「加为标签」：把趋势方向追加进本次输入框（只影响下一次检索，不改项目数据） */
  const addTag = (s: string) => {
    const next = splitWords(tags)
    if (next.includes(s)) { showToast('已经在标签里了', 'info'); return }
    next.push(s)
    setTags(next.join('、'))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="市场雷达"
      icon={<Radar size={16} />}
      width="2xl"
      maxHeight="88vh"
      footerAlign="between"
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={!report}
            title={report ? '把这份报告复制成 Markdown' : '还没生成报告'}
            onClick={() => { if (report) void copyText(reportToMarkdown(report), '报告已复制为 Markdown') }}
          >
            <Copy size={12} /> 复制报告
          </Button>
          <div className="flex items-center gap-2">
            {running && (
              <Button variant="danger" size="sm" onClick={t.stop}>
                <Square size={12} /> 中止
              </Button>
            )}
            <Button variant="secondary" size="md" onClick={onClose}>关闭</Button>
          </div>
        </>
      }
    >
      {/* 顶部口径：这是「联网检索 + 模型归纳」，不是市场结论；数据来源也在这里说清 */}
      <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
        <div className="text-11 leading-relaxed text-ink-300">
          按你给的题材 / 平台去公开网络检索，再由模型归纳成趋势与机会点 —— <b className="text-ink-200">仅供参考，不构成市场结论</b>，
          也不替你写正文或大纲。
        </div>
        <AIDataSourceNote feature="market-radar" />
      </div>

      {/* 输入区 */}
      <div className="mt-3 rounded-xl border border-ink-700 bg-ink-850/40 p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-400">题材 / 赛道</span>
            <input className={INPUT_CLS} value={genre} onChange={e => setGenre(e.target.value)}
              placeholder="如：东方玄幻 · 升级流" />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-400">目标平台</span>
            <input className={INPUT_CLS} value={platform} onChange={e => setPlatform(e.target.value)}
              placeholder="如：起点 / 番茄 / 七猫" />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-400">标签<span className="text-ink-600">（逗号分隔）</span></span>
            <input className={INPUT_CLS} value={tags} onChange={e => setTags(e.target.value)}
              placeholder="如：升级流，群像，轻松向" />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-400">关键词<span className="text-ink-600">（逗号分隔）</span></span>
            <input className={INPUT_CLS} value={keywords} onChange={e => setKeywords(e.target.value)}
              placeholder="如：吞噬体系，宗门流" />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={!canRun || !aiReady} onClick={start}
            title={!aiReady ? AI_DISABLED_HINT : `最多发出 ${RADAR_MAX_QUERIES} 条检索词，再交给模型归纳一次`}>
            {running ? <><Loader2 size={12} className="animate-spin" /> 检索归纳中…</> : <><Sparkles size={12} /> 开始检索</>}
          </Button>
          <span className="text-10 text-ink-500">
            最多 {RADAR_MAX_QUERIES} 条检索词 + 1 次归纳；切走页签不会中断，回来看结果仍在。
          </span>
        </div>
        {!aiReady && <div className="mt-2 text-10 text-ink-500">{AI_DISABLED_HINT}</div>}
      </div>

      {/* 结果区 */}
      <div className="mt-3">
        {running && (
          <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-400">
            <Loader2 size={14} className="inline animate-spin" /> 正在联网检索并归纳…
          </div>
        )}

        {!running && failure && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-11 leading-relaxed text-danger">
            没跑成：{failure}
            <div className="mt-1 text-10 text-ink-500">
              市场雷达走「搜索接口」这一档（要把检索结果交给模型，模型自带联网那档拿不到来源）—— 到「模型设置 → 联网检索」里配好后重试。
            </div>
          </div>
        )}

        {!running && !failure && !report && (
          <div className="text-11 text-ink-500">
            填好上面的方向，点「开始检索」：可可这边会把查到的公开信息整理成趋势、平台适配与机会 / 风险。
          </div>
        )}

        {!running && report && (
          <div className="space-y-3">
            {/* 检索词（让作者知道这份报告基于什么查出来的） */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Link2 size={11} className="text-ink-500" />
              <span className="text-10 text-ink-500">本次检索：</span>
              {report.queries.map(q => (
                <span key={q} className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-10 text-ink-400">{q}</span>
              ))}
            </div>

            {/* ① 题材趋势 */}
            {report.trend.length > 0 && (
              <div className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
                <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
                  <TrendingUp size={13} className="text-amber" />
                  <span className="text-12 font-medium text-ink-100">题材趋势</span>
                  <span className="text-10 text-ink-500">{report.trend.length} 条</span>
                </div>
                <div className="divide-y divide-ink-700/60">
                  {report.trend.map((it, i) => (
                    <div key={i} className="flex items-start gap-2 px-3 py-2">
                      <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-10 ${HEAT_CLS[it.heat]}`}>
                        {HEAT_LABEL[it.heat]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-12 text-ink-100">{it.topic}</div>
                        {it.note && <div className="mt-0.5 text-11 leading-relaxed text-ink-400">{it.note}</div>}
                      </div>
                      <Button variant="bare" size="xs" className="shrink-0 rounded border border-ink-700 px-1.5 text-10 text-ink-400 hover:text-amber hover:border-amber/40 transition-colors"
                        title="把这条方向加进上面的「标签」，下一次检索能查得更准（不会改作品信息）"
                        onClick={() => addTag(it.topic)}>
                        + 标签
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ② 平台适配 */}
            {report.platformFit.length > 0 && (
              <div className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
                <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
                  <Compass size={13} className="text-amber" />
                  <span className="text-12 font-medium text-ink-100">平台适配</span>
                </div>
                <div className="divide-y divide-ink-700/60">
                  {report.platformFit.map((p, i) => (
                    <div key={i} className="px-3 py-2">
                      <div className="text-12 text-ink-100">{p.platform}</div>
                      {p.note && <div className="mt-0.5 text-11 leading-relaxed text-ink-400">{p.note}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ③ 机会点 / 风险点 并排 */}
            {(report.opportunities.length > 0 || report.risks.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {report.opportunities.length > 0 && (
                  <div className="rounded-xl border border-success/30 bg-success/10 p-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-12 font-medium text-success">
                      <Lightbulb size={13} /> 机会点
                    </div>
                    <ul className="space-y-1 text-11 leading-relaxed text-ink-300">
                      {report.opportunities.map((s, i) => <li key={i}>· {s}</li>)}
                    </ul>
                  </div>
                )}
                {report.risks.length > 0 && (
                  <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-12 font-medium text-danger">
                      <AlertTriangle size={13} /> 风险点
                    </div>
                    <ul className="space-y-1 text-11 leading-relaxed text-ink-300">
                      {report.risks.map((s, i) => <li key={i}>· {s}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* ④ 来源（可点开原文） */}
            {report.sources.length > 0 && (
              <details className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
                <summary className="cursor-pointer px-3 py-2 text-12 text-ink-200 hover:text-amber transition-colors">
                  来源（{report.sources.length} 条，点开可查原文）
                </summary>
                <div className="divide-y divide-ink-700/60 border-t border-ink-700">
                  {report.sources.map((s, i) => (
                    <div key={i} className="px-3 py-2">
                      <button type="button"
                        className="flex items-start gap-1.5 text-left text-11 text-ink-200 hover:text-amber transition-colors disabled:hover:text-ink-200"
                        disabled={!s.url}
                        onClick={() => void openLink(s.url)}
                        title={s.url ? '在浏览器打开原文' : '这条没有链接'}>
                        <ExternalLink size={11} className="mt-0.5 shrink-0" />
                        <span className="min-w-0">{s.title || s.url}</span>
                      </button>
                      {s.snippet && (
                        <div className="mt-0.5 pl-4 text-10 leading-relaxed text-ink-500">{s.snippet}</div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* 口径尾注（照抄 report.disclaimer，不加工） */}
            <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-10 leading-relaxed text-ink-500">
              {report.disclaimer || RADAR_DISCLAIMER}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

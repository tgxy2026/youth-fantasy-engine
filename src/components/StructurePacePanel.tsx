/**
 * 全书结构配比对照（A2 · 2.5.0）
 *
 * 与同页其他面板的分工：
 *   · 本面板 —— **全书**卷章结构的字数配比（纯本地、零 AI）：把结构模板的理想节拍占比
 *     与实际各拍承载的字数占比对照，给三档观察（贴合 / 轻微偏移 / 明显偏移）；
 *   · 节奏与章末钩子（PaceAnalysisPanel，B5）—— **单章**内部的节奏与章末钩子，需 AI。
 *
 * 🔴 归属与度量语义见 `lib/structurePace.ts` 头注释（章数位置轴归属 + 字数 share 度量）。
 * 🔴 模板选择与创意写作**共用同一来源**（`creativeSession.inputs.structureId`）：
 *    在这里换模板，创意写作的大纲规划也跟着用同一套 —— 单一来源，不出第二个存储。
 *    挂载时先 `hydrateCreativeSession()`（幂等）：本页可能在创意写作面板从未打开过时进入。
 * 🔴 立场：只给结构观察，不给分、不排名、不判定达标；偏差列表只逐条列「非贴合」的拍。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Loader2 } from 'lucide-react'
import * as db from '../lib/db'
import type { Chapter } from '../lib/types'
import { hydrateCreativeSession, updateInputs, useCreativeSession, saveInputsQuiet } from '../lib/creativeSession'
import { getStoryTemplate } from '../lib/storyStructures'
import {
  buildChapterShares, alignBeats, PACE_MIN_CHAPTERS, PACE_LEVEL_LABEL,
  type BeatAlignment, type PaceLevel,
} from '../lib/structurePace'
import { STORY_TEMPLATES } from '../lib/storyStructures'
import HelpPopover from './HelpPopover'

/** 节拍色板（半透明叠在暗底上；与情节画布 beat 卡 #b9a7e8 同族的柔和色） */
const BEAT_COLORS = ['#b9a7e8', '#8fb8e8', '#8fd0b0', '#e0c987', '#e0a5a5', '#a5d5e0', '#c9b0d8', '#b8d0a0']
const beatColor = (i: number) => BEAT_COLORS[i % BEAT_COLORS.length]

/** 三档徽章配色（与 CheckTools 的 sevBadge 同族；文案本身是中性描述，不含判定语气） */
const levelBadge = (l: PaceLevel) =>
  l === 'notable' ? 'bg-red-500/15 text-red-300 border border-red-500/30'
  : l === 'slight' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-ink-700 text-ink-300 border border-ink-600'

/** 一条水平占比带：每拍一格，宽＝占比，窄格不写文字只留 hover 说明 */
function BandStrip({ alignments, mode }: { alignments: BeatAlignment[]; mode: 'ideal' | 'actual' }) {
  return (
    <div className="flex h-7 w-full overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
      {alignments.map((a, i) => {
        const w = mode === 'ideal' ? a.idealPct : a.actualPct
        if (w <= 0) return null
        const label = mode === 'ideal' ? `${a.idealPct}%` : `${a.actualPct}%`
        return (
          <div
            key={a.name}
            style={{ width: `${w}%`, background: `${beatColor(i)}2e`, borderRight: '1px solid rgba(255,255,255,0.06)' }}
            className="flex items-center justify-center overflow-hidden whitespace-nowrap"
            title={`${a.name}：${label}`}
          >
            {w >= 8 && <span className="px-1 text-10" style={{ color: beatColor(i) }}>{a.name}</span>}
            {w >= 4 && w < 8 && <span className="text-9" style={{ color: beatColor(i) }}>·</span>}
          </div>
        )
      })}
    </div>
  )
}

export default function StructurePacePanel() {
  const session = useCreativeSession()
  const structureId = session.inputs.structureId
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [loading, setLoading] = useState(true)

  // 先 hydrate 再读：structureId 的单一来源在 creativeSession（幂等，重复调用无害）
  useEffect(() => { hydrateCreativeSession() }, [])

  const load = useCallback(async () => {
    const chs = await db.getAllChapters().catch(() => [] as Chapter[])
    setChapters([...chs].sort((a, b) => a.order - b.order))
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const tpl = getStoryTemplate(structureId)
  const writtenCount = chapters.filter(c => (c.wordCount || 0) > 0).length
  const enough = writtenCount >= PACE_MIN_CHAPTERS

  const result = useMemo(() => {
    if (!tpl || !enough) return null
    const inputs = chapters.map(c => ({ id: c.id, title: c.title || '未命名章节', words: c.wordCount || 0 }))
    const { shares, totalWords } = buildChapterShares(inputs)
    return { shares, totalWords, alignments: alignBeats(tpl, shares) }
  }, [tpl, enough, chapters])

  const pickTemplate = (id: string) => {
    updateInputs({ structureId: id })
    void saveInputsQuiet()
  }

  const offLevel = result?.alignments.filter(a => a.level !== 'ok') ?? []

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
        <BarChart3 size={14} className="text-purple-300" />
        <span className="text-13 font-medium text-ink-100">全书结构配比</span>
        <span className="text-10 text-ink-500">卷章结构 · 纯本地 · 零 AI</span>
        <HelpPopover title="全书结构配比怎么用">
          {'把结构模板（三幕式 / 十五拍 / 起承转合 / 网文三卷式）的理想节拍占比，\n'
            + '与实际每一拍承载的字数占比对照，看哪一拍写得多、哪一拍写得少。\n\n'
            + '· 归属：按章在整个故事里的位置归到对应节拍；占比按各章字数算 —— 少数章承载了不成比例的字数时能看出来；\n'
            + '· 三档只是观察（贴合 / 轻微偏移 / 明显偏移），不是评分 —— 作者有意压缩或展开某一拍是完全正当的选择；\n'
            + '· 模板选择与创意写作共用：在这里换模板，「创意写作」的大纲规划也会用同一套；\n'
            + '· 与「节奏与章末钩子」分工：这个看全书卷章结构（纯本地），那个看单章内部节奏（需 AI）。\n\n'
            + '全书已写章节不足 10 章时只展示模板的理想占比，不硬算 —— 样本太少没有参考价值。'}
        </HelpPopover>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* 模板选择 + 样本统计 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-11">
          <select
            value={structureId}
            onChange={e => pickTemplate(e.target.value)}
            className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-11 text-ink-200 outline-none focus:border-amber"
          >
            <option value="">不使用结构模板</option>
            {STORY_TEMPLATES.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {loading ? (
            <span className="text-10 text-ink-500"><Loader2 size={10} className="inline animate-spin" /> 正在读取章节…</span>
          ) : (
            <span className="text-10 text-ink-500">
              已写正文 {writtenCount} 章{result ? ` · 共 ${result.totalWords.toLocaleString()} 字` : ''}
            </span>
          )}
          {tpl && <span className="text-10 text-ink-500">{tpl.genre} · {tpl.beats.length} 拍</span>}
        </div>

        {/* 未选模板 */}
        {!tpl && !loading && (
          <div className="text-11 text-ink-500">
            选择一套结构模板后，这里会把每拍承载的实际字数占比与模板理想占比对照（纯本地统计，不发送任何请求）。
          </div>
        )}

        {/* 选了模板但样本不足：给理想占比预览 + 引导 */}
        {tpl && !loading && !enough && (
          <div className="space-y-2">
            <div className="text-10 text-ink-500">「{tpl.name}」的理想节拍占比</div>
            <BandStrip alignments={alignBeats(tpl, [])} mode="ideal" />
            <div className="text-11 text-ink-400">
              已写正文的章节还不足 {PACE_MIN_CHAPTERS} 章，样本太少，先不硬算配比 —— 等故事铺开一些再回来看。
            </div>
          </div>
        )}

        {/* 完整对照 */}
        {result && tpl && (
          <div className="space-y-3">
            <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1.5">
              <span className="text-10 text-ink-500 text-right">理想</span>
              <BandStrip alignments={result.alignments} mode="ideal" />
              <span className="text-10 text-ink-500 text-right">实际</span>
              <BandStrip alignments={result.alignments} mode="actual" />
            </div>

            {offLevel.length === 0 ? (
              <div className="text-11 text-emerald-400">
                全部 {result.alignments.length} 拍与「{tpl.name}」的理想占比基本贴合 ✓
              </div>
            ) : (
              <div className="space-y-1.5">
                {offLevel.map(a => (
                  <div key={a.name} className="bg-ink-800 border border-ink-700 rounded-lg p-2.5">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`px-1.5 py-0.5 rounded border text-10 shrink-0 ${levelBadge(a.level)}`}>
                        {PACE_LEVEL_LABEL[a.level]}
                      </span>
                      <span className="text-12 font-semibold text-ink-100">{a.name}</span>
                      <span className="text-10 text-ink-500">
                        理想 {a.idealPct}% · 实际 {a.actualPct}%（{a.delta > 0 ? '+' : ''}{a.delta}pp）
                      </span>
                    </div>
                    <div className="text-11 text-ink-400 leading-relaxed">{a.note}</div>
                    {a.chapters.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(a.chapters.length > 8 ? a.chapters.slice(0, 8) : a.chapters).map(c => (
                          <span key={c.no} className="px-1.5 py-0.5 bg-ink-700/60 border border-ink-600 rounded text-10 text-ink-300">
                            {c.title || `第 ${c.no} 章`}
                          </span>
                        ))}
                        {a.chapters.length > 8 && (
                          <span className="px-1.5 py-0.5 text-10 text-ink-500">等 {a.chapters.length} 章</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div className="text-10 text-ink-500">
                  其余 {result.alignments.length - offLevel.length} 拍与理想占比基本贴合，未列出。
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

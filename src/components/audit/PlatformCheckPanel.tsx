/**
 * 分平台投稿预检（C4 · 2.4.2）
 *
 * 与同页其他面板的分工：
 *   · 敏感词检测 —— 全书扫描 + 可选 AI 复核（不分平台）；
 *   · 本章体检 —— 单章确定性检查；
 *   · 本面板 —— **按平台档位**看：哪些命中属于该平台重点关注的类别，分章事实如何。
 *
 * 🔴 立场：只摆事实与观察，不评分、不排优劣、不判「能不能过审」。
 *    平台规则随时会变，面板里的提示一律注明以平台后台为准。
 */
import { useCallback, useEffect, useState } from 'react'
import { Building2, Loader2, Eye } from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter } from '@/lib/types'
import { PLATFORM_RULES, platformRuleOf, type PlatformId } from '@/lib/app/platformRules'
import { NO_CHAPTERS_HINT } from '@/lib/constants'
import { precheckBook, type PlatformCheckReport } from '@/lib/audit/platformCheck'
import { getCustomSensitiveWords } from '@/lib/editor/sensitiveWords'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'

const PREFS_KEY = 'platformCheckPlatform'

export default function PlatformCheckPanel() {
  const [platform, setPlatform] = useState<PlatformId>('general')
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<PlatformCheckReport | null>(null)

  const load = useCallback(async () => {
    const [chs, saved] = await Promise.all([
      db.getAllChapters().catch(() => [] as Chapter[]),
      db.getSetting<PlatformId>(PREFS_KEY, 'general').catch(() => 'general' as PlatformId),
    ])
    setChapters([...chs].sort((a, b) => a.order - b.order))
    setPlatform(platformRuleOf(saved).id as PlatformId)
    setPrefsLoaded(true)
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  // 换平台就丢掉旧报告 —— 否则会拿 A 档的结果当 B 档看
  useEffect(() => { setReport(null) }, [platform])

  const pick = (id: PlatformId) => {
    setPlatform(id)
    void db.setSetting(PREFS_KEY, id).catch(() => {})
  }

  const run = async () => {
    if (running || chapters.length === 0) return
    setRunning(true)
    try {
      const custom = await getCustomSensitiveWords().catch(() => [] as string[])
      setReport(precheckBook(chapters, platform, custom))
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-500">
      <Loader2 size={14} className="inline animate-spin" /> 正在读取…
    </div>
  }

  const rule = platformRuleOf(platform)
  const outside = report?.facts.filter(f => f.rangeFlag !== null) ?? []
  const shown = outside.slice(0, 20)

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
        <Building2 size={14} className="text-info" />
        <span className="text-13 font-medium text-ink-100">分平台投稿预检</span>
        <span className="text-10 text-ink-500">晋江 / 起点 · 只摆事实不判定</span>
        <HelpPopover title="分平台投稿预检怎么用">
          {'挑一个目标平台，看两件事：\n\n'
            + '· 敏感词按平台档位分：属于该平台重点关注类别的会单独标出来，优先复核；\n'
            + '· 分章事实：每章字数 / 段数 / 最长段，与一个「参考区间」对照 —— 区间是给你参考的输入，落在外面不等于有问题。\n\n'
            + '只给事实与观察，不评分、不排优劣、不判「能不能过审」。\n'
            + '平台规则随时会变，下面的提示一律以平台后台与最新公告为准。\n\n'
            + '首批只收录晋江与起点两档（这两家口径通常最严），其余平台按需增补。'}
        </HelpPopover>
        <div className="ml-auto">
          <Button variant="secondary" size="sm" disabled={!chapters.length || running || !prefsLoaded} onClick={() => void run()}>
            {running ? <><Loader2 size={12} className="animate-spin" /> 预检中…</> : <><Building2 size={12} /> 预检全书</>}
          </Button>
        </div>
      </div>

      {/* 平台选择 */}
      <div className="px-4 py-3 border-b border-ink-700 flex flex-wrap items-center gap-x-4 gap-y-2 text-11">
        <div className="inline-flex rounded-lg border border-ink-700 overflow-hidden">
          {PLATFORM_RULES.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => pick(r.id as PlatformId)}
              className={`px-3 py-1.5 text-11 transition-colors ${
                r.id === platform ? 'bg-amber/15 text-amber' : 'bg-ink-900 text-ink-300 hover:bg-ink-800'
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
        <span className="text-ink-400">
          参考区间 <b className="text-ink-200 tabular-nums">{rule.suggestWordRange[0]}–{rule.suggestWordRange[1]}</b> 字/章
          {` · 共 ${chapters.length} 章`}
        </span>
      </div>

      {/* 结果区 */}
      <div className="px-4 py-3">
        {chapters.length === 0 && <div className="text-11 text-ink-500">{NO_CHAPTERS_HINT}</div>}

        {chapters.length > 0 && !report && !running && (
          <div className="text-11 text-ink-500">
            <Eye size={11} className="inline -mt-0.5 mr-1" />
            点右上「预检全书」：哪些命中属于该平台重点关注的类别，分章事实如何。
          </div>
        )}

        {report && (
          <div className="space-y-4">
            {/* ① 观察 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">观察（{report.platformName}档）</div>
              <ul className="space-y-0.5 text-11 text-ink-300">
                {report.observations.map((s, i) => <li key={i}>· {s}</li>)}
              </ul>
            </div>

            {/* ② 命中 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">敏感词命中（按关注度排序）</div>
              {report.hits.length === 0 ? <div className="text-11 text-success">未检出 ✓</div> : (
                <div className="space-y-1.5">
                  {report.hits.map(h => (
                    <div key={`${h.category}-${h.word}`} className="flex items-start gap-2 text-11">
                      <span className={`px-1.5 py-0.5 rounded shrink-0 ${
                        h.focused ? 'bg-danger/15 text-danger' : 'bg-ink-700 text-ink-300'
                      }`}>{h.category}</span>
                      <span className="px-1.5 py-0.5 bg-ink-800 border border-ink-600 rounded shrink-0 text-ink-200">{h.word} ×{h.count}</span>
                      <span className="text-ink-500 min-w-0">{h.context}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ③ 分章事实（只列区间外，避免几百章刷屏） */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">
                参考区间外的章节{outside.length > 0 ? `（${outside.length} 章${outside.length > shown.length ? `，列出前 ${shown.length} 章` : ''}）` : ''}
              </div>
              {outside.length === 0 ? <div className="text-11 text-success">全部章节都在参考区间内 ✓</div> : (
                <div className="space-y-1">
                  {shown.map(f => (
                    <div key={f.chapterId} className="flex items-center gap-2 text-11 text-ink-300">
                      <span className={`px-1.5 py-0.5 rounded shrink-0 ${
                        f.rangeFlag === 'long' ? 'bg-amber/15 text-amber' : 'bg-ink-700 text-ink-300'
                      }`}>{f.rangeFlag === 'long' ? '偏长' : '偏短'}</span>
                      <span className="min-w-0 flex-1 truncate">{f.title}</span>
                      <span className="text-ink-500 tabular-nums shrink-0">{f.words} 字 · {f.paragraphs} 段 · 最长 {f.longestParagraph} 字</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ④ 平台提示 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">平台提示</div>
              <ul className="space-y-0.5 text-11 text-ink-400">
                {rule.notes.map((s, i) => <li key={i}>· {s}</li>)}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

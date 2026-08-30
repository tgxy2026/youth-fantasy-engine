import { useEffect, useState, useCallback, useRef } from 'react'
import * as db from '../lib/db'
import { genName, type NameType, STYLES as NAME_STYLES } from '../lib/nameGen'
import {
  Sparkles, Star, Trash2, RefreshCw, Check
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import AIAssist from './AIAssist'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { aiSuggestNames } from '../lib/aiTasks'
import { buildProjectContext } from '../lib/aiContext'
import { Button } from './Button'


const NAME_TYPES: NameType[] = ['人名', '门派', '功法', '地名', '法宝', '技能', '组织', '怪物']

// 各类别默认题材
const DEFAULT_STYLE: Record<NameType, string> = {
  '人名': '仙侠', '门派': '仙侠', '组织': '科幻', '功法': '仙侠',
  '技能': '仙侠', '地名': '仙侠', '法宝': '仙侠', '怪物': '仙侠',
}

export default function InspireTools() {
  // ---- 取名 ----
  const [nameType, setNameType] = useState<NameType>('人名')
  const [style, setStyle] = useState<string>('仙侠')
  const [names, setNames] = useState<string[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [copied, setCopied] = useState('')

  // ---- AI 取名（无模型时禁用，本地能力不受影响）----
  const { ready: aiReady } = useAIReady()
  const [aiNames, setAiNames] = useState<{ name: string; meaning: string }[]>([])
  const [aiNameLoading, setAiNameLoading] = useState(false)
  const [aiNameErr, setAiNameErr] = useState('')
  const [streamText, setStreamText] = useState('')
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const load = useCallback(async () => {
    setFavorites(await db.getSetting<string[]>('nameFavorites', []))
  }, [])
  useEffect(() => { load() }, [load])

  const rollNames = () => {
    const out: string[] = []
    for (let i = 0; i < 10; i++) out.push(genName(nameType, style))
    setNames(out)
  }
  useEffect(() => { rollNames() }, []) // eslint-disable-line

  const toggleFavorite = async (name: string) => {
    const next = favorites.includes(name) ? favorites.filter(f => f !== name) : [...favorites, name]
    setFavorites(next)
    await db.setSetting('nameFavorites', next)
  }
  const copy = (name: string) => {
    navigator.clipboard?.writeText(name)
    setCopied(name)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(''), 1200)
  }

  const aiName = async () => {
    if (!aiReady || aiNameLoading) return
    setAiNameLoading(true); setAiNameErr(''); setAiNames([]); setStreamText('')
    try {
      const ctx = await buildProjectContext({ budget: 3000 }).catch(() => ({ text: '' }))
      const out = await aiSuggestNames({ target: nameType, style, extra: '', context: ctx.text, count: 10, onToken: (d) => setStreamText(prev => prev + d) })
      setAiNames(out)
    } catch (e) { setAiNameErr(e instanceof Error ? e.message : String(e)) }
    finally { setAiNameLoading(false) }
  }

  return (
    <div className="w-full page-enter">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">灵感启发</h1>
          <HelpPopover title="灵感启发怎么用" width="22rem" size={14}>
            {'随机取名生成器：按类型（人名 / 门派 / 功法 / 地名 / 法宝 / 技能 / 组织 / 怪物）× 风格批量出名字，点名字即复制，星标收藏；\n\nAI 辅助规划：多轮对话式脑暴，可结合你的世界观设定给建议，需接入 AI 模型（未接入时 AI 取名按钮禁用，本地取名不受影响）。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-[13px] text-ink-300">随机取名生成器 · AI 辅助规划</p>
      </header>

      <div className="space-y-4">
        {/* ============ 随机取名 ============ */}
        <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
          <h2 className="text-[13px] font-semibold text-ink-100 mb-4 flex items-center gap-2">
            <Sparkles size={14} className="text-amber" /> 随机取名生成器
            <HelpPopover title="随机取名怎么用" width="21rem" className="ml-auto">
              {'三步出名字：\n\n1. 选类型（人名 / 门派 / 功法 / 地名 / 法宝 / 技能 / 组织 / 怪物）；\n2. 选题材风格（仙侠、玄幻、科幻…），切换类型时会自动带上该类型的常用风格；\n3. 点「换一批」刷新 10 个候选。\n\n· 点名字本身即复制到剪贴板；\n· 点右侧星标收藏，收藏区会列在下方，可随时删除；\n· 定稿的名字记得回「名词术语」或角色卡登记，避免后面重名。'}
            </HelpPopover>
          </h2>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex gap-1 flex-wrap">
              {NAME_TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => {
                    setNameType(t)
                    setStyle(DEFAULT_STYLE[t])
                    setNames([])
                  }}
                  className={`px-3 py-1 rounded-full text-[12px] transition-colors ${nameType === t ? 'bg-amber/15 text-amber border border-amber/30' : 'bg-ink-800 text-ink-300 border border-ink-700 hover:text-ink-100'}`}
                >{t}</button>
              ))}
            </div>
            <div className="flex gap-1 flex-wrap ml-2">
              {NAME_STYLES.map(s => (
                <button
                  key={s}
                  onClick={() => setStyle(s)}
                  className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${style === s ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30' : 'bg-ink-800 text-ink-400 border border-ink-700'}`}
                >{s}</button>
              ))}
            </div>
            <Button onClick={rollNames} variant="primary" size="md" className="ml-auto flex items-center text-[12px]">
              <RefreshCw size={12} /> 换一批
            </Button>
            {aiReady ? (
              <Button onClick={aiName}
                disabled={aiNameLoading}
                
                title="让 AI 结合你的世界观设定生成更贴设定的候选名" variant="secondary" size="md" className="flex items-center text-[12px]">
                <Sparkles size={12} /> {aiNameLoading ? 'AI 取名中…' : 'AI 取名'}
              </Button>
            ) : (
              <Button disabled
                title={AI_DISABLED_HINT} variant="secondary" size="md" className="flex items-center text-[12px] cursor-not-allowed">
                <Sparkles size={12} /> AI 取名
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 2xl:grid-cols-10 gap-2">
            {names.map((n, i) => (
              <div key={`${n}-${i}`} className="group flex items-center justify-between px-3 py-2.5 bg-ink-800 border border-ink-700 rounded-lg hover:border-amber/40 transition-colors">
                <span
                  onClick={() => copy(n)}
                  className="text-[13px] text-ink-100 cursor-pointer hover:text-amber transition-colors"
                  title="点击复制"
                >
                  {copied === n ? <span className="text-emerald-400 flex items-center gap-1"><Check size={11} />已复制</span> : n}
                </span>
                <button onClick={() => toggleFavorite(n)} className={`p-0.5 transition-colors ${favorites.includes(n) ? 'text-amber' : 'text-ink-600 hover:text-amber'}`} title="收藏">
                  <Star size={12} fill={favorites.includes(n) ? 'currentColor' : 'none'} />
                </button>
              </div>
            ))}
          </div>
          {aiNameLoading && streamText && (
            <div className="mt-3">
              <div className="text-[11px] text-ink-500 mb-1">AI 实时输出</div>
              <pre className="whitespace-pre-wrap text-[11px] text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-48 overflow-auto">{streamText}</pre>
            </div>
          )}
          {favorites.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] text-ink-500 mb-1.5">已收藏（{favorites.length}）</div>
              <div className="flex flex-wrap gap-1.5">
                {favorites.map(f => (
                  <span key={f} className="inline-flex items-center gap-1 px-2 py-1 bg-ink-800 border border-ink-700 rounded-md text-[12px] text-ink-200">
                    {f}
                    <button onClick={() => toggleFavorite(f)} className="text-ink-500 hover:text-red-400"><Trash2 size={10} /></button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {aiNameErr && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[12px] text-red-300">
              <Sparkles size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{aiNameErr}</span>
            </div>
          )}
          {aiNames.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] text-ink-500 mb-1.5">AI 取名结果（{aiNames.length}，点名字复制）</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {aiNames.map((n, i) => (
                  <button key={i} onClick={() => copy(n.name)} className="text-left flex items-start justify-between gap-2 px-3 py-2 bg-ink-800 border border-ink-700 rounded-lg hover:border-amber/40 transition-colors">
                    <span>
                      <span className="text-[13px] text-ink-100">{copied === n.name ? <span className="text-emerald-400 flex items-center gap-1"><Check size={11} />已复制</span> : n.name}</span>
                      {n.meaning && <span className="block text-[10.5px] text-ink-500 mt-0.5">{n.meaning}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ============ AI 辅助规划 ============ */}
        <AIAssist />
      </div>
    </div>
  )
}

import Panel from '@/components/common/Panel'
import { useEffect, useState, useCallback, useRef } from 'react'
import { AI_STREAM_LABEL } from '@/lib/constants'
import { writerBudgetFor } from '@/lib/ai/aiWriterBudget'
import * as db from '@/lib/db'
import { genName, type NameType, STYLES as NAME_STYLES } from '@/lib/creative/nameGen'
import {
  Sparkles, Star, Trash2, RefreshCw, Check
} from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import { copyText } from '@/components/dialogs/dialogs'
import AIAssist from '@/components/ai/AIAssist'
import InspirationBox from '@/components/creative/InspirationBox'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { aiSuggestNames } from '@/lib/ai/aiTasks'
import { buildProjectContext } from '@/lib/ai/aiContext'
import { Button } from '@/components/common/Button'


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

  /**
   * 模型配置版本号：配置面板改了模型（新增 / 切换当前 / 删除）就 +1，
   * 让下方「AI 辅助规划」重读一遍活动模型 —— 否则它手里还是旧的那份。
   */

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
    void copyText(name, '已复制到剪贴板') // 走统一入口：非安全上下文有 execCommand 兜底、失败不静默
    setCopied(name)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(''), 1200)
  }

  const aiName = async () => {
    if (!aiReady || aiNameLoading) return
    setAiNameLoading(true); setAiNameErr(''); setAiNames([]); setStreamText('')
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('name-suggest') }).catch(() => ({ text: '' }))
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
          <HelpPopover title="灵感启发怎么用" width="24rem" size={14}>
            {'这一页是「灵感与创意」的三件套，都从「灵感启发」这个动作出发。\n\n【灵感夹】随手记下点子攒起来，勾选几条让 AI 融合成情节卡，直接放到推演画布上。\n\n【随机取名生成器】按类型（人名 / 门派 / 功法 / 地名 / 法宝 / 技能 / 组织 / 怪物）× 题材风格批量出名字：点名字即复制，点星标收藏；纯本地能力，没有模型也能用。\n\n【AI 辅助规划】多轮对话式脑暴（剧情 / 人物 / 世界观 / 一致性自查），可结合你的世界观设定给建议。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-13 text-ink-300">灵感夹 · 随机取名生成器 · AI 辅助规划</p>
      </header>

      <div className="space-y-4">
        {/* ============ 灵感夹（2.5.1 · A3）：记灵感 → 融合 → 落画布 ============ */}
        <InspirationBox />

        {/* ============ ③ 随机取名（本地能力，无需模型）============ */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
            <Sparkles size={14} className="text-amber" /> 随机取名生成器
            <HelpPopover title="随机取名怎么用" width="21rem">
              {'三步出名字：\n\n1. 选类型（人名 / 门派 / 功法 / 地名 / 法宝 / 技能 / 组织 / 怪物）；\n2. 选题材风格（仙侠、玄幻、科幻…），切换类型时会自动带上该类型的常用风格；\n3. 点「换一批」刷新 10 个候选。\n\n· 点名字本身即复制到剪贴板；\n· 点右侧星标收藏，收藏区会列在下方，可随时删除；\n· 定稿的名字记得回「名词术语」或角色卡登记，避免后面重名。'}
              <AIDataSourceNote feature="name-suggest" />
            </HelpPopover>
          </h2>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* 分类（人名/门派…）与风格（仙侠/古风…）为两级筛选：
                尺寸统一为 h-8 / px-3 / text-12，靠「形状 + 选中色」区分层级——
                分类 = 胶囊形 + 琥珀选中（主层级），风格 = 圆角矩形 + 天蓝选中（次层级）。 */}
            <div className="flex gap-1 flex-wrap">
              {NAME_TYPES.map(t => (
                <Button variant="toggle" selected={nameType === t}
                  key={t}
                  size="sm" shape="pill"
                  onClick={() => {
                    setNameType(t)
                    setStyle(DEFAULT_STYLE[t])
                    setNames([])
                  }}
                  className="hover:text-ink-100"
                  title={`取名类型：${t}`}
                >{t}</Button>
              ))}
            </div>
            <div className="flex gap-1 flex-wrap ml-2">
              {NAME_STYLES.map(s => (
                <Button variant="bare"
                  key={s}
                  onClick={() => setStyle(s)}
                  className={`h-8 px-3 text-12 rounded-lg transition-colors ${style === s ? 'bg-info/15 text-info border border-info/30' : 'bg-ink-800 text-ink-400 border border-ink-700'}`}
                  title={`题材风格：${s}`}
                >{s}</Button>
              ))}
            </div>
            <Button onClick={rollNames} variant="primary" size="md" className="ml-auto flex items-center">
              <RefreshCw size={12} /> 换一批
            </Button>
            {aiReady ? (
              <Button onClick={aiName}
                disabled={aiNameLoading}
                
                title="让 AI 结合你的世界观设定生成更贴设定的候选名" variant="secondary" size="md" className="flex items-center">
                <Sparkles size={12} /> {aiNameLoading ? 'AI 取名中…' : 'AI 取名'}
              </Button>
            ) : (
              <Button disabled
                title={AI_DISABLED_HINT} variant="secondary" size="md" className="flex items-center cursor-not-allowed">
                <Sparkles size={12} /> AI 取名
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 2xl:grid-cols-10 gap-2">
            {names.map((n, i) => (
              <div key={`${n}-${i}`} className="group flex items-center justify-between px-3 py-2.5 bg-ink-800 border border-ink-700 rounded-lg hover:border-amber/40 transition-colors">
                <span
                  onClick={() => copy(n)}
                  className="text-13 text-ink-100 cursor-pointer hover:text-amber transition-colors"
                  title="点击复制"
                >
                  {copied === n ? <span className="text-success flex items-center gap-1"><Check size={11} />已复制</span> : n}
                </span>
                <Button variant="bare" onClick={() => toggleFavorite(n)} className={`p-0.5 transition-colors ${favorites.includes(n) ? 'text-amber' : 'text-ink-600 hover:text-amber'}`} title="收藏">
                  <Star size={12} fill={favorites.includes(n) ? 'currentColor' : 'none'} />
                </Button>
              </div>
            ))}
          </div>
          {aiNameLoading && streamText && (
            <div className="mt-3">
              <div className="text-11 text-ink-500 mb-1">{AI_STREAM_LABEL}</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-48 overflow-auto">{streamText}</pre>
            </div>
          )}
          {favorites.length > 0 && (
            <div className="mt-4">
              <div className="text-11 text-ink-500 mb-1.5">已收藏（{favorites.length}）</div>
              <div className="flex flex-wrap gap-1.5">
                {favorites.map(f => (
                  <span key={f} className="inline-flex items-center gap-1 px-2 py-1 bg-ink-800 border border-ink-700 rounded-md text-12 text-ink-200">
                    {f}
                    {/* ⚠️ 待核（2026-09-22 审计）：图标是 Trash2（垃圾桶）但回调叫 `toggleFavorite` ——
                        两者语义对不上，可能是图标选错或函数复用。此处只补可访问性，语义问题单独记录。 */}
                    <Button variant="icon-danger" onClick={() => toggleFavorite(f)} title="删除" aria-label="删除"><Trash2 size={10} /></Button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {aiNameErr && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
              <Sparkles size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{aiNameErr}</span>
            </div>
          )}
          {aiNames.length > 0 && (
            <div className="mt-4">
              <div className="text-11 text-ink-500 mb-1.5">AI 取名结果（{aiNames.length}，点名字复制）</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {aiNames.map((n, i) => (
                  /* 🔴 同理：Button 基类 justify-center 压死普通 justify-between（className 纯字符串
                     拼接、输赢看 CSS 生成顺序），单孩也会被居中 —— 必须 `!justify-between`，
                     同 AIOrganize 的 `!justify-start` 约定，见 tests/collapseHeaderAlign.test.ts */
                  <Button variant="bare" key={i} onClick={() => copy(n.name)} className="text-left flex items-start !justify-between gap-2 px-3 py-2 bg-ink-800 border border-ink-700 rounded-lg hover:border-amber/40 transition-colors">
                    <span>
                      <span className="text-13 text-ink-100">{copied === n.name ? <span className="text-success flex items-center gap-1"><Check size={11} />已复制</span> : n.name}</span>
                      {n.meaning && <span className="block text-10 text-ink-500 mt-0.5">{n.meaning}</span>}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Panel>

        {/* ============ ④ AI 辅助规划（对话）============
             本组件只管对话；模型配置与联网检索是全局设置，不在这里。 */}
        <AIAssist />
      </div>
    </div>
  )
}

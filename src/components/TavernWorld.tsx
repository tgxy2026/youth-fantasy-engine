/**
 * 酒馆模式 · 背景设定（tavern-world，路线图第 5 批）
 *
 * 【老大定的方案】替代原先设想的 World Info：
 *   · 剧情推演模式：**从项目资料一键 AI 录入**（提炼整合，不是把资料全喂进去），再人工微调；
 *   · 自由对话模式：同一套填写框架，但要作者先填**基础信息**，AI 再据此扩写，同样可人工改。
 *
 * 【两种模式的差别只有三处】数据归属（随项目 / 跨项目）、一键录入的输入来源、页面上的措辞。
 * 所以**共用一个页面与一套字段**，切模式只是切一份数据 —— 两套页面必然漂移。
 *
 * 【为什么要显示字数与注入策略】
 * 这一层每轮都进 system。作者不看着字数，很容易一路把资料贴进来，最后把对话历史挤没
 * （表现是「它怎么忘了我刚说的话」，几乎反推不到原因）。所以字数与「关键词为空 = 每轮都注入」
 * 这一条必须显式写在界面上。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import AutoTextarea from './AutoTextarea'
import { buildProjectContext } from '../lib/aiContext'
import {
  getWorldSetting, saveWorldSetting, draftWorldSetting, worldToText,
  isEmptyWorld, WORLD_MAX_CHARS,
  type WorldScope, type WorldSetting,
} from '../lib/tavern/world'
import { uid } from '../lib/id'

const SCOPES: { id: WorldScope; name: string; hint: string }[] = [
  { id: 'plot', name: '剧情推演', hint: '描述这本书的世界。存**随项目**，换书就是另一份。' },
  { id: 'free', name: '自由对话', hint: '描述自由对话所处的世界。存**跨项目**，所有对话共用一份。' },
]

export default function TavernWorld() {
  const [scope, setScope] = useState<WorldScope>('plot')
  const [w, setW] = useState<WorldSetting | null>(null)
  const [dirty, setDirty] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (sc: WorldScope) => {
    setW(await getWorldSetting(sc))
    setDirty(false)
  }, [])

  useEffect(() => { void load(scope) }, [load, scope])

  const edit = (fn: (prev: WorldSetting) => WorldSetting) => {
    setW(prev => (prev ? fn(prev) : prev))
    setDirty(true)
  }

  const chars = useMemo(() => (w ? worldToText(w).length : 0), [w])
  const overLimit = chars > WORLD_MAX_CHARS

  const switchScope = async (next: WorldScope) => {
    if (next === scope) return
    if (dirty) {
      const okGo = await confirmDialog({
        title: '切换模式？',
        message: '当前这份背景设定有未保存的改动，切过去就丢了。',
        confirmText: '切过去',
        danger: true,
      })
      if (!okGo) return
    }
    setScope(next)
  }

  const save = async () => {
    if (!w) return
    setSaving(true)
    try {
      const saved = await saveWorldSetting(scope, w)
      setW(saved)
      setDirty(false)
      showToast('已保存 —— 下一轮对话就会用上')
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  /** 一键录入：剧情模式喂项目资料，自由模式喂作者填的基础信息 */
  const runDraft = async () => {
    if (!w) return
    setDrafting(true)
    try {
      let digest = ''
      if (scope === 'plot') {
        // 取一份「导演视角」的项目资料（作者侧照带；这里只是给 AI 提炼用，不进对话）
        const ctx = await buildProjectContext({ budget: 8000, viewMode: 'director-view', inlineDropNote: false })
        digest = ctx.text
      }
      const out = await draftWorldSetting({ scope, seed: w.seed, projectDigest: digest })
      edit(prev => ({
        ...prev,
        brief: out.brief || prev.brief,
        sections: out.sections.length ? out.sections : prev.sections,
        keywords: out.keywords.length ? out.keywords : prev.keywords,
        draftedAt: Date.now(),
      }))
      showToast(scope === 'plot'
        ? `已从项目资料提炼成 ${out.sections.length} 节 —— 过一遍再保存`
        : `已按基础信息生成 ${out.sections.length} 节 —— 过一遍再保存`)
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setDrafting(false)
    }
  }

  const scopeMeta = SCOPES.find(s => s.id === scope)!
  const injectAlways = !w || w.keywords.filter(k => k.trim()).length === 0

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50">背景设定</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          把项目资料（或你填的基础信息）**提炼**成一份精简背景。它不会每轮都塞进上下文 ——
          命中了关键词才带上，这也是「不必每次喂一大堆」的落子。
        </p>
      </header>

      {/* 模式切换 */}
      <div className="flex flex-wrap items-center gap-2 pt-3">
        {SCOPES.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => void switchScope(s.id)}
            title={`切到「${s.name}」模式的背景设定（两种模式各存一份，互不影响）`}
            className={`rounded-md border px-3 py-1.5 text-[12px] transition-colors ${scope === s.id
              ? 'border-amber/50 bg-amber/10 text-amber'
              : 'border-ink-700 text-ink-300 hover:text-amber'}`}
          >
            {s.name}
          </button>
        ))}
        <span className="text-[11px] text-ink-500">{scopeMeta.hint}</span>
      </div>

      {!w ? (
        <div className="flex-1"><LoadingState text="读取背景设定…" /></div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-3 pt-3">
          {/* 左：编辑区 */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="text-[12px] text-ink-200">一句话总纲</div>
              <p className="mt-0.5 mb-2 text-[10.5px] text-ink-500 leading-relaxed">
                时代 / 地点 / 基调。它**最先**进上下文，模型靠它抓住大感觉。
              </p>
              <AutoTextarea
                value={w.brief}
                onChange={v => edit(prev => ({ ...prev, brief: v }))}
                minRows={2}
                placeholder="例：现代都市·城南老城区，梅雨季。故事围绕一间凌晨还亮着灯的便利店发生。"
              />
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="flex items-center justify-between">
                <div className="text-[12px] text-ink-200">分节（{w.sections.length}）</div>
                <button
                  type="button"
                  className="text-[11px] text-ink-500 hover:text-amber"
                  onClick={() => edit(prev => ({ ...prev, sections: [...prev.sections, { id: uid(), title: '', body: '' }] }))}
                >
                  ＋ 加一节
                </button>
              </div>
              <p className="mt-0.5 mb-2 text-[10.5px] text-ink-500 leading-relaxed">
                建议 3–6 节、每节一百多字。**只留会影响人物言行的内容**，背景板式的描述删掉。
              </p>

              {w.sections.length === 0 ? (
                <p className="rounded border border-dashed border-ink-700 p-3 text-center text-[11.5px] text-ink-500">
                  还没有分节。可以点右边「一键录入」让 AI 起草，也可以自己一节一节写。
                </p>
              ) : (
                <div className="space-y-2">
                  {w.sections.map((s, i) => (
                    <div key={s.id} className="rounded-md border border-ink-800 bg-ink-900/40 p-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          value={s.title}
                          onChange={e => edit(prev => ({
                            ...prev,
                            sections: prev.sections.map(x => x.id === s.id ? { ...x, title: e.target.value } : x),
                          }))}
                          placeholder="小节标题（如「规矩与禁忌」）"
                          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-[12px] text-ink-100 outline-none focus:border-amber/50"
                        />
                        <button
                          type="button"
                          title="删掉这一节"
                          className="shrink-0 text-[11px] text-ink-500 hover:text-red-400"
                          onClick={() => edit(prev => ({ ...prev, sections: prev.sections.filter(x => x.id !== s.id) }))}
                        >
                          删除
                        </button>
                      </div>
                      <div className="mt-1.5">
                        <AutoTextarea
                          value={s.body}
                          onChange={v => edit(prev => ({
                            ...prev,
                            sections: prev.sections.map(x => x.id === s.id ? { ...x, body: v } : x),
                          }))}
                          minRows={3}
                          maxHeight={240}
                          placeholder={`第 ${i + 1} 节内容…`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="text-[12px] text-ink-200">关键词（命中才注入）</div>
              <p className="mt-0.5 mb-2 text-[10.5px] text-ink-500 leading-relaxed">
                逗号或换行分隔。**留空 = 每轮都注入**；填了就只在这些词出现时带上这一层。
                通常填地名、势力名、行话这类「提到就说明需要背景」的词。
              </p>
              <AutoTextarea
                value={w.keywords.join('，')}
                onChange={v => edit(prev => ({ ...prev, keywords: v.split(/[,，\n]/).map(x => x.trim()).filter(Boolean) }))}
                minRows={2}
                placeholder="例：便利店，城南，林方圆"
              />
            </div>

            <div className="flex items-center gap-2 pb-2">
              <Button variant="primary" size="md" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? '保存中…' : dirty ? '保存' : '已保存'}
              </Button>
              <Button variant="secondary" size="md" disabled={!dirty} onClick={() => void load(scope)}>
                放弃改动
              </Button>
              {dirty && <span className="text-[11px] text-amber">有未保存的改动</span>}
            </div>
          </div>

          {/* 右：一键录入 + 状态 */}
          <aside className="w-72 shrink-0 space-y-3 overflow-y-auto">
            <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
              <div className="text-[12px] text-amber">
                {scope === 'plot' ? '从项目资料提炼' : '按基础信息生成'}
              </div>
              <p className="mt-1 text-[10.5px] text-ink-400 leading-relaxed">
                {scope === 'plot'
                  ? '读项目里的世界观、势力、人物等资料，由 AI **精简整合**成上面的分节。它不会把资料原样搬过来。'
                  : 'AI 会顺着你给的基础信息扩写（地点、氛围、规矩、既有关系），**不会替你定重大设定**。'}
              </p>

              <div className="mt-2">
                <div className="text-[11px] text-ink-400">
                  {scope === 'plot' ? '额外要求（可留空）' : '基础信息（必填）'}
                </div>
                <AutoTextarea
                  value={w.seed}
                  onChange={v => edit(prev => ({ ...prev, seed: v }))}
                  minRows={scope === 'plot' ? 2 : 4}
                  maxHeight={200}
                  placeholder={scope === 'plot'
                    ? '例：这是一段双男主，世界设定从简，重点写「学园」与「契约」两条线。'
                    : '例：现代都市·城南，夏天梅雨季。主角是便利店夜班店员，独居；常客里有个每天凌晨来买烟的大学生。基调：慢、克制、生活流。'}
                />
              </div>

              <Button
                variant="primary" size="md" className="mt-2 w-full"
                disabled={drafting || (scope === 'free' && !w.seed.trim())}
                onClick={() => void runDraft()}
              >
                {drafting ? '正在生成…' : scope === 'plot' ? '一键从项目提炼' : '一键生成背景'}
              </Button>
              {scope === 'plot' && (
                <p className="mt-1.5 text-[10px] text-ink-500 leading-relaxed">
                  ⚠️ 会**覆盖**现有分节（brief 只在原来是空的时候填）。生成后请过一遍再保存。
                </p>
              )}
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="text-[12px] text-ink-200">注入情况</div>
              <div className="mt-1.5 space-y-1 text-[11px] text-ink-400">
                <div>
                  当前 <span className={overLimit ? 'text-amber' : 'text-ink-200'}>{chars}</span> 字
                  <span className="text-ink-600"> / 上限 {WORLD_MAX_CHARS}</span>
                </div>
                {overLimit && (
                  <div className="text-amber leading-relaxed">
                    超了 —— 每轮都带着它，会挤掉对话历史。建议删到 {WORLD_MAX_CHARS} 字以内。
                  </div>
                )}
                <div>
                  {injectAlways ? '每次对话都注入' : `命中这 ${w.keywords.filter(k => k.trim()).length} 个词时注入`}
                </div>
                {isEmptyWorld(w) && <div className="text-ink-600">（现在是空的，不进上下文）</div>}
                {w.draftedAt > 0 && (
                  <div className="text-ink-600">上次 AI 生成：{new Date(w.draftedAt).toLocaleString()}</div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="text-[12px] text-ink-200">注入预览</div>
              <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-[10.5px] leading-relaxed text-ink-400">
                {worldToText(w) || '（空）'}
              </pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

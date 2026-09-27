/**
 * 酒馆模式 · 背景设定（tavern-world，路线图第 5 批）
 *
 * 【老大定的方案】替代原先设想的 World Info：**从项目资料一键 AI 录入**（提炼整合，
 * 不是把资料全喂进去），再人工微调。
 *
 * 【2026-09-15 收口：只服务剧情推演】
 * 原先页头有两个模式按钮（剧情推演 / 自由对话），各存一份。自由那份已去掉，理由：
 *   · 自由对话里可能同时存在不同世界观、不同类型的角色，用一份背景把它们框住反而不对；
 *   · 每个角色的世界观已经在**角色卡第 1 章「世界」**里写过了，再来一份是重复占额度。
 * 旧库里那份数据保留不删（不动用户数据），只是界面不再到达它 —— 见 docs/酒馆模式-工程红线.md §9。
 *
 * 【为什么要显示字数与注入策略】
 * 这一层每轮都进 system。作者不看着字数，很容易一路把资料贴进来，最后把对话历史挤没
 * （表现是「它怎么忘了我刚说的话」，几乎反推不到原因）。所以字数与「关键词为空 = 每轮都注入」
 * 这一条必须显式写在界面上。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import { showToast } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import AutoTextarea from './AutoTextarea'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from './DraftBits'
import { buildProjectContext } from '../lib/aiContext'
import {
  getWorldSetting, saveWorldSetting, draftWorldSetting, worldToText,
  isEmptyWorld, WORLD_MAX_CHARS,
  type WorldSetting,
} from '../lib/tavern/world'
import { uid } from '../lib/id'
import type { DraftSource } from '../lib/tavern/draft'

export default function TavernWorld() {
  const [w, setW] = useState<WorldSetting | null>(null)
  const [dirty, setDirty] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 起草的参考素材（可空）与上一次的素材来源 */
  const [refs, setRefs] = useState('')
  const [lastSource, setLastSource] = useState<DraftSource | null>(null)
  const search = useSearchSettings()

  const load = useCallback(async () => {
    setW(await getWorldSetting())
    setDirty(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const edit = (fn: (prev: WorldSetting) => WorldSetting) => {
    setW(prev => (prev ? fn(prev) : prev))
    setDirty(true)
  }

  const chars = useMemo(() => (w ? worldToText(w).length : 0), [w])
  const overLimit = chars > WORLD_MAX_CHARS

  const save = async () => {
    if (!w) return
    setSaving(true)
    try {
      const saved = await saveWorldSetting(w)
      setW(saved)
      setDirty(false)
      showToast('已保存 —— 下一轮对话就会用上')
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  /** 一键录入：把项目资料提炼成背景设定 */
  const runDraft = async () => {
    if (!w) return
    setDrafting(true)
    try {
      // 取一份「导演视角」的项目资料（作者侧照带；这里只是给 AI 提炼用，不进对话）
      const ctx = await buildProjectContext({ budget: 8000, viewMode: 'director-view', inlineDropNote: false })
      const { fields: out, source } = await draftWorldSetting({
        seed: w.seed, projectDigest: ctx.text, refs,
        ...(search ? { searchSettings: search } : {}),
      })
      edit(prev => ({
        ...prev,
        brief: out.brief || prev.brief,
        sections: out.sections.length ? out.sections : prev.sections,
        keywords: out.keywords.length ? out.keywords : prev.keywords,
        draftedAt: Date.now(),
      }))
      setLastSource(source)
      showToast(`已从项目资料提炼成 ${out.sections.length} 节（${source.label}）—— 过一遍再保存`)
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setDrafting(false)
    }
  }

  const injectAlways = !w || w.keywords.filter(k => k.trim()).length === 0

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-800 pb-3">
        <div className="flex items-center gap-1.5">

          <h1 className="text-lg font-bold text-ink-50">背景设定</h1>

          <HelpPopover title="背景设定怎么填" width="24rem" size={14}>
  给剧情推演准备一份「作者侧资料」，用来替代每轮都塞进上下文的长文档。

  · 摘要：这个项目最关键的世界观骨架。
  · 分节 + 关键词：命中了关键词才带上这一节 —— 这是「不必每次喂一大堆」的关键。
    关键词留空 = 这一节总是注入。
  · 只对剧情推演生效，随项目（换书就是另一份）。自由对话不读它 —— 那里可能混着不同世界观的角色，
    自由对话的世界观由角色卡「所属的故事」提供（卡里只写角色与它的关系）。
  · 上限 {WORLD_MAX_CHARS} 字：它每轮都可能进上下文，写太长会把对话历史挤掉。起草时用了哪种素材来源，
    在「工作面板 → 模型设置 → 联网检索」里定。
  <AIDataSourceNote feature="tavern-world-draft" />
</HelpPopover>

        </div>
        <p className="text-12 text-ink-400 mt-1">
          把项目资料提炼成一份精简背景，供剧情推演使用。只对剧情推演生效、随项目（换书就是另一份）——
          自由对话不读它：那里可能混着不同世界观的角色。
        </p>
      </header>

      {!w ? (
        <div className="flex-1"><LoadingState text="读取背景设定…" /></div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-3 pt-3">
          {/* 左：编辑区 */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="text-12 text-ink-200">一句话总纲</div>
              <p className="mt-0.5 mb-2 text-10 text-ink-500 leading-relaxed">
                时代 / 地点 / 基调。它最先进上下文，模型靠它抓住大感觉。
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
                <div className="text-12 text-ink-200">分节（{w.sections.length}）</div>
                <Button variant="secondary" size="xs"
                  onClick={() => edit(prev => ({ ...prev, sections: [...prev.sections, { id: uid(), title: '', body: '' }] }))}
                >
                  ＋ 加一节
                </Button>
              </div>
              <p className="mt-0.5 mb-2 text-10 text-ink-500 leading-relaxed">
                建议 3–6 节、每节一百多字。只留会影响人物言行的内容，背景板式的描述删掉。
              </p>

              {w.sections.length === 0 ? (
                <p className="rounded border border-dashed border-ink-700 p-3 text-center text-11 text-ink-500">
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
                          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50"
                        />
                        <Button variant="danger" size="xs"
                          title="删掉这一节"
                          onClick={() => edit(prev => ({ ...prev, sections: prev.sections.filter(x => x.id !== s.id) }))} className="shrink-0"
                        >
                          删除
                        </Button>
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
              <div className="text-12 text-ink-200">关键词（命中才注入）</div>
              <p className="mt-0.5 mb-2 text-10 text-ink-500 leading-relaxed">
                逗号或换行分隔。留空 = 每轮都注入；填了就只在这些词出现时带上这一层。
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
              <Button variant="secondary" size="md" disabled={!dirty} onClick={() => void load()}>
                放弃改动
              </Button>
              {dirty && <span className="text-11 text-amber">有未保存的改动</span>}
            </div>
          </div>

          {/* 右：一键录入 + 状态 */}
          <aside className="w-72 shrink-0 space-y-3 overflow-y-auto">
            <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
              <div className="text-12 text-amber">从项目资料提炼</div>
              <p className="mt-1 text-10 text-ink-400 leading-relaxed">
                读项目里的世界观、势力、人物等资料，由 AI 精简整合成上面的分节。它不会把资料原样搬过来。
              </p>

              <div className="mt-2">
                <div className="text-11 text-ink-400">额外要求（可留空）</div>
                <AutoTextarea
                  value={w.seed}
                  onChange={v => edit(prev => ({ ...prev, seed: v }))}
                  minRows={2}
                  maxHeight={200}
                  placeholder="例：这是一段双男主，世界设定从简，重点写「学园」与「契约」两条线。"
                />
              </div>

              <div className="mt-2">
                <RefsField value={refs} onChange={setRefs} minRows={2} />
              </div>
              <SearchPlanLine settings={search} />

              <Button
                variant="primary" size="md" className="mt-2 w-full"
                disabled={drafting}
                onClick={() => void runDraft()}
              >
                {drafting ? '正在生成…' : '一键从项目提炼'}
              </Button>
              <p className="mt-1.5 text-10 text-ink-500 leading-relaxed">
                ⚠️ 会覆盖现有分节（brief 只在原来是空的时候填）。生成后请过一遍再保存。
              </p>
              <DraftSourceLine source={lastSource} />
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
              <div className="text-12 text-ink-200">注入情况</div>
              <div className="mt-1.5 space-y-1 text-11 text-ink-400">
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
              <div className="text-12 text-ink-200">注入预览</div>
              <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
                {worldToText(w) || '（空）'}
              </pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

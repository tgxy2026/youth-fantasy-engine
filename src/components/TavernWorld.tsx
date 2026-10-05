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
import { useSaveHotkey } from '../lib/useSaveHotkey'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import { UNSAVED_CHANGES_HINT } from '../lib/constants'
import { showToast } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import AutoTextarea from './AutoTextarea'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from './DraftBits'
import { buildProjectContext } from '../lib/aiContext'
import {
  getWorldSetting, saveWorldSetting, draftWorldSetting, worldToText,
  isEmptyWorld, worldEntriesOf, buildPlotWorldBook,
  type WorldSetting,
} from '../lib/tavern/world'
import { entryStateOf, type EntryState } from '../lib/tavern/worldBook'
import EntryStatePicker from './EntryStatePicker'
import { useTavernQuota } from './useTavernQuota'
import { fmtWindow } from '../lib/tavern/quotas'
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

  // 🔴 额度体系（2026-10-05）：上限不再写死 2400，改按**当前模型窗口**算。
  //    界面拿到的窗口与引擎同源（见 useTavernQuota 的说明）。
  const quota = useTavernQuota(undefined, undefined)

  // 一句话总纲是**每轮全量注入**的固定层，单独受固定额度约束（世界设定那一页同理）。
  const briefChars = useMemo(() => (w?.brief ?? '').trim().length, [w])
  const briefOver = briefChars > quota.fixed

  // 「整份」= 全部写下来的字（作者心里的成本）；「预计命中」= 真会进上下文的字。
  // 🔴 这两个数必须分开显示：改造前界面拿「整份」去对上限，于是出现
  //    「界面报警说超了、实际只注入了三分之一」的假警报（2026-10-05 定案修）。
  const allChars = useMemo(() => (w ? worldToText(w).length : 0), [w])
  const hitChars = useMemo(() => {
    if (!w) return 0
    // 空上下文 ⇒ 只命中的是常驻条目（brief + 无触发词的节）—— 正是「最低消耗」那一档
    // 🔴 两个 0 都是「不限额、原样返回」—— 语义是「空上下文下必带的那些的完整长度」，
    //    任一层限额都会把它量小（与 TavernScript 那处同源，改一处要改两处）。
    return buildPlotWorldBook(w, '', { maxChars: 0, fixedMaxChars: 0 }).text.length
  }, [w])
  const overLimit = hitChars > quota.dynamic

  const save = async () => {
    if (!w) return
    // 🔴 固定层超额度**不允许保存**（主人 2026-10-05 明定）：总纲每轮全量注入，
    //    超了就是实打实挤占对话历史 —— 与其让它进上下文后被取舍，不如这里就拦住。
    //    （动态层超了不拦：那部分本来就按优先级逐条取舍，是设计内的行为。）
    if (briefOver) {
      showToast(`一句话总纲 ${briefChars} 字，超过固定额度 ${quota.fixed} 字 —— 请精简后再保存`, 'error')
      return
    }
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

  // Ctrl/Cmd+S 保存世界观设定（2.7.3 补）
  useSaveHotkey(() => void save(), dirty && !saving)

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
  · 世界书（每节自己的触发词）：除了上面那组「整份关键词」，每一节还能写「自己的」触发词 ——
    提到它才带上这一条，粒度更细。命中后还过一道「概率」闸（1 = 必中，0.5 = 一半概率）。
    一条被带进来后，它正文里提到的词还能再激活别的节（递归 2 轮、不重复）。
  · 只对剧情推演生效，随项目（换书就是另一份）。自由对话不读它 —— 那里可能混着不同世界观的角色，
    自由对话的世界观由角色卡「所属的故事」提供（卡里只写角色与它的关系）。
  · 额度：上限「跟着模型窗口走」 —— 一句话总纲（每轮全量注入）现在 {quota.fixed} 字
    （按 {fmtWindow(quota.windowTokens)} 窗口 × 8%，下限 2400、上限 12000），超了不许保存；
    分节命中注入走动态层 {quota.dynamic} 字（窗口 × {quota.dynamicPct}%，可在控制面板调），
    超了按优先级「逐条取舍」（先留常驻，再留直接命中，最后才是被引荐拉进来的）；只有「单条本身就超额度」这种极端情况才会截断。
  · 四色灯：常驻（每轮都带）/ 触发（命中触发词才带）/ 引荐（只在被别的词条递归带出时出现）/ 休眠（本次不参与）。
    没显式设的按老语义推断 —— 触发词留空就是「常驻」，等于升级前的行为。
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
              <p className={`mt-1 text-10 ${briefOver ? 'text-amber' : 'text-ink-500'}`}>
                每轮全量注入，<span className={briefOver ? 'text-amber' : 'text-ink-300'}>{briefChars}</span> / {quota.fixed} 字
                {briefOver && ' —— 超了不让保存，请精简'}
              </p>
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
                      {/* 世界书（W3）：本节自己的触发词与概率 —— 留空 = 跟随上一层的整份关键词 */}
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          value={(s.keys ?? []).join('，')}
                          onChange={e => {
                            const keys = e.target.value.split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
                            edit(prev => ({
                              ...prev,
                              sections: prev.sections.map(x => x.id === s.id
                                // 清空时删键（不留空数组）：与「老数据没这个字段」保持同形
                                ? { ...x, keys: keys.length ? keys : undefined }
                                : x),
                            }))
                          }}
                          placeholder="本节触发词（留空 = 总是带上）"
                          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                        />
                        <label className="flex shrink-0 items-center gap-1 text-10 text-ink-400" title="命中后还要过这道随机闸：1 = 必中，0.5 = 一半概率">
                          <span>概率</span>
                          <input
                            type="number" min={0} max={1} step={0.1}
                            value={s.prob ?? 1}
                            onChange={e => {
                              const n = Number(e.target.value)
                              edit(prev => ({
                                ...prev,
                                sections: prev.sections.map(x => x.id === s.id
                                  ? { ...x, prob: Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined }
                                  : x),
                              }))
                            }}
                            className="w-14 rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                          />
                        </label>
                      </div>
                      {(() => {
                        const own = (s.keys ?? []).length
                        const global = w.keywords.filter(k => k.trim()).length
                        // 🔴 四色灯：显式设过就以它为准；没设过按老语义推断（触发词空 → 常驻）。
                        //    `worldEntriesOf` 里已经做了「整份闸折算」，这里取出来就是引擎实际看到的形态。
                        //
                        // 🔴🔴 **必须按 id 找本节那条，不能取 `[0]`**：`worldEntriesOf` 在 `brief`
                        //    非空时会先推入一条 `world-brief`（`constant: true`，恒 `entryStateOf === 'on'`），
                        //    于是 `[0]` 永远是总纲、不是本节 —— 界面会把每一节的灯都显示成「常驻 / 每轮都带」，
                        //    哪怕作者已经给这节填了触发词（实际引擎按 `hit` 走）。这是**界面撒谎**，
                        //    2026-10-05 实机验证抓到（`ui-tavern-quota.mjs` A5）。
                        //    这里把 `brief` 清空，再按 `s.id` 取本节，缺了才回退到首条。
                        const ownEntries = worldEntriesOf({ ...w, brief: '', sections: [s] })
                        const entry = ownEntries.find(e => e.id === s.id) ?? ownEntries[0]
                        const inferred: EntryState = entry ? entryStateOf(entry) : 'on'
                        return (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <EntryStatePicker
                              value={s.state}
                              inferred={inferred}
                              size="sm"
                              onChange={next => edit(prev => ({
                                ...prev,
                                sections: prev.sections.map(x => x.id === s.id ? { ...x, state: next } : x),
                              }))}
                            />
                            <span className="text-10 text-ink-600">
                              {inferred === 'on'
                                ? '每轮都带'
                                : own ? `本节自带 ${own} 个触发词` : global ? '跟随整份关键词' : '按触发词命中'}
                            </span>
                          </div>
                        )
                      })()}
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
              {dirty && <span className="text-11 text-amber">{UNSAVED_CHANGES_HINT}</span>}
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
                {/* 🔴 「整份」与「预计命中」必须分开显示（2026-10-05）： */}
                {/*    整份 = 作者写下来的全部（心里的成本）；预计命中 = 真进上下文的量。 */}
                <div>
                  写下来共 <span className="text-ink-200">{allChars}</span> 字
                </div>
                <div>
                  每轮最少注入 <span className={overLimit ? 'text-amber' : 'text-ink-200'}>{hitChars}</span> 字
                  <span className="text-ink-600"> / 动态额度 {quota.dynamic}</span>
                </div>
                {overLimit && (
                  <div className="text-amber leading-relaxed">
                    常驻部分已超动态额度 {quota.dynamic} 字 —— 超出部分会按优先级
                    <b>逐条取舍</b>（先留常驻、再留直接命中，最后才砍被引荐的），
                    被砍的条目在「注入预览」里不会出现。建议精简常驻条目或给它们加触发词。
                  </div>
                )}
                <div className="text-ink-600">
                  额度按 {quota.ready ? `「${quota.modelLabel || '当前模型'}」` : '当前模型'}的
                  {' '}{fmtWindow(quota.windowTokens)} 窗口算
                  {quota.windowFallback && '（模型没填窗口，按 32K 估）'}
                  {' '}· 可在控制面板调动态层比例
                </div>
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
              <div className="flex items-center gap-1.5">
                <div className="text-12 text-ink-200">注入预览</div>
                <span className="text-10 text-ink-600">（空上下文时实际会注入的部分）</span>
              </div>
              <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
                {buildPlotWorldBook(w, '', { maxChars: quota.dynamic, fixedMaxChars: quota.fixed }).text || '（空）'}
              </pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

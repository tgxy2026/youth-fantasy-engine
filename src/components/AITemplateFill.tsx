/**
 * AI 补全 / 对话引导（全局所有「按模板录入」的地方共用这一个弹窗）
 *
 * 老大的原话（2026-09-15）：「原本的 AI 补全功能还是留着的。但是我们新增一个对话引导的功能，
 * 同样是相同的工作流程，根据我们需要录入信息的模板，引导用户回答问题。」
 *
 * 所以这里有**两种模式**，同一份字段清单，两条路：
 *   · 一句话补全 —— 你已经想清楚了（甚至是照着某个已有作品填），写一句就走；
 *   · 对话引导 —— 你只是有点感觉、说不清，让 AI 按模板提纲一轮轮问出来。
 *
 * 【为什么两个模式放在同一个弹窗而不是两个入口】
 * 这两种情况的分界线连作者自己都常常事先不知道 —— 写着写着发现「我说不清」很正常。
 * 放在一起，换个模式点一下就行；做成两个入口就变成「得先判断自己属于哪种」，白费一道手续。
 * 两种模式**互不干扰**：一句话补全的输入不会带进对话引导（免得你以为带了其实没带）。
 *
 * 【联网检索】
 * 走设置里的「联网检索」档（控制面板「三、联网检索」）。素材管线的裁决与来源反馈统一由
 * `draftMaterial.ts` 出，本组件只负责显示 —— 别在这儿再判一次「查没查成」。
 *
 * 【对话引导的提纲怎么来】
 * 字段清单是动态的（表格的列、用户自定义的表单），所以提纲按字段顺序每 2 栏切一个话题
 * （`deriveTopics`）。酒馆的角色卡 / 剧本有精心排过的话题，走它们自己的 spec。
 */
import { foldVh } from '../lib/theme'
import AIDataSourceNote from './AIDataSourceNote'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Check, Loader2, AlertCircle, RefreshCw, MessagesSquare, NotebookPen } from 'lucide-react'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import { aiChatJson, aiCompleteTemplate, buildWorldContext, type TemplateField } from '../lib/ai'
import { prepareDraftMaterial, type DraftSource } from '../lib/draftMaterial'
import { deriveTopics, filledToText, type InterviewSpec } from '../lib/interview'
import { loadFreeDraft, saveFreeDraft } from '../lib/freeDraft'
import { isInternalFieldKey } from '../lib/worldSets'
import { DEFAULT_SEARCH_SETTINGS } from '../lib/webSearch'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from './DraftBits'
import InterviewChat from './InterviewChat'
import { Button } from './Button'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'

interface Props {
  /** 该实体的全部字段（key 约定见 TemplateField） */
  fields: TemplateField[]
  /** 已存在的值（表单型补全时传入）：这些字段视为已填，锁定不发给模型、不随补全写入 */
  existing?: Record<string, string>
  /** 是否提供「参照世界观」开关（默认 true） */
  withWorldContext?: boolean
  /** 草图输入框占位提示 */
  sketchPlaceholder?: string
  /**
   * 预填进「粗略设定」框的内容（2.4.4 · 设定草稿箱的「AI 整理」用）。
   *
   * 为什么走 props 而不是让它自己读草稿箱：本弹窗被全项目多处复用，
   * 让它知道「草稿箱」这个具体概念会把通用组件钉死在一处业务上；
   * 由调用方把已写好的大段草稿直接递进来，语义就只是「这次带着一段现成的材料来」。
   *
   * ⚠️ 与 `draftScope` **二选一**：传了它就不显示草稿本区块（材料已经在了，
   *    再摆一个草稿本就成了两处同质文本，作者会不知道该改哪一处）。
   */
  initialSketch?: string
  /** 「粗略设定」输入框的标题文案（默认面向"写一句话"；整理草稿时要改成"待整理的草稿"） */
  sketchLabel?: string
  /**
   * **草稿本的作用域**（2.4.4）：给了就在弹窗里挂出一块「草稿本」——
   * 一段随内容长高、自动存盘的自由文本，作者可以攒着、也可以一键带进本次补全。
   *
   * 刻意做成**全局能力**而不是世界设定页签的专属：需要"抱着一大段没整理的文字去补全"
   * 的场合到处都是（角色卡、表格行、表单页签……），把它钉死在两个页签上太可惜。
   * 调用方只需给一个稳定的 scope（页签 / 记录 / 行的维度自定），存读与口径都在本组件内。
   *
   * 存盘：`lib/freeDraft.ts`（项目级 settingsKV，随项目走）。
   */
  draftScope?: string
  /** 弹窗标题 */
  title?: string
  /** 采用时回调：仅回传 AI 补全（非锁定、非已填）字段的 key->value */
  onSubmit: (values: Record<string, string>) => void
  onClose: () => void
}

type Mode = 'fill' | 'interview'

export default function AITemplateFill({
  fields,
  existing,
  withWorldContext = true,
  sketchPlaceholder,
  initialSketch,
  sketchLabel,
  draftScope,
  title = 'AI 补全设定',
  onSubmit,
  onClose,
}: Props) {
  // 🔴 未配置模型时**预先禁用**「生成补全」（2026-09-20 六维审计 F1）。
  //    判据与真实调用一致：aiCompleteTemplate 内部走 requireActiveProvider。
  //    ⚠️ 别拿它去守卫「对话引导」那条路 —— 那个走 InterviewChat 的 callChat（调用方给的模型），
  //    判据不同，会误禁（见下条注释）。
  const { ready: aiReady } = useAIReady()
  const [mode, setMode] = useState<Mode>('fill')
  const [sketch, setSketch] = useState(initialSketch ?? '')
  const [refs, setRefs] = useState('')
  const [useCtx, setUseCtx] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, string> | null>(null)
  const [aiFilled, setAiFilled] = useState<string[]>([])
  const [source, setSource] = useState<DraftSource | null>(null)
  const search = useSearchSettings()

  // ---------- 草稿本（全局能力，见 props.draftScope） ----------
  // 只在**没传 initialSketch** 时才启用：两者都是"带进来的材料"，同时出现会变成两个同质输入框。
  const draftOn = !!draftScope && initialSketch === undefined
  const [draftText, setDraftText] = useState('')
  const [draftOpen, setDraftOpen] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const draftTimer = useRef<ReturnType<typeof setTimeout>>()
  /** 草稿是否已被带进输入框（只影响按钮文案；重复点「带入」会覆盖，不追加） */
  const [brought, setBrought] = useState(false)

  // 挂载时读一次。**刻意不自动填进输入框** —— 作者攒的草稿可能很长，
  // 每次开弹窗都静默塞进「一句话补全」的框里会污染他真正想写的那句；
  // 展开出来让他自己点「带入」，才是可预期的（且草稿本内容就在眼前，一点即可）。
  useEffect(() => {
    if (!draftOn || !draftScope) return
    let alive = true
    void loadFreeDraft(draftScope).then(t => {
      if (!alive || !t.trim()) return
      setDraftText(t)
      setDraftOpen(true)
    })
    return () => { alive = false }
  }, [draftOn, draftScope])

  // 卸载前（切走 / 关弹窗）把未落盘的草稿收尾 —— 与 TableSheet 的「卸载冲刷草稿」同范式
  useEffect(() => () => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    if (draftScope && draftText.trim()) void saveFreeDraft(draftScope, draftText)
  }, [draftScope, draftText])

  const onDraftChange = (v: string) => {
    setDraftText(v)
    setDraftSaved(false)
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      if (!draftScope) return
      void saveFreeDraft(draftScope, v).then(() => setDraftSaved(true))
    }, 600)
  }

  /** 把草稿带进「粗略设定」框：非空则换行追加（作者可能已经敲了一句） */
  const bringDraftIn = () => {
    const t = draftText.trim()
    if (!t) return
    setSketch(prev => (prev.trim() ? `${prev.trim()}\n${t}` : t))
    setBrought(true)
  }

  /**
   * 剥掉「内部字段」（`__` 前缀，如设定草稿箱）后的已填值。
   *
   * 🔴 为什么必须剥：`existing` 会被摊平进 `existingText` 发给模型（对话引导的起点、
   *    补全的"已有什么"）。草稿箱是作者明确标注「不发给 AI」的那一段，
   *    顺着这条路漏出去，界面上的承诺就成了空话 —— 且它是**静默**的，谁也看不出来。
   */
  const safeExisting = useMemo(() => {
    if (!existing) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(existing)) if (!isInternalFieldKey(k)) out[k] = v
    return out
  }, [existing])

  // 锁定 / 已填字段不发给模型；其余才是 AI 真正补全的对象
  const sendFields = useMemo(
    () => fields.filter(f => !f.locked && !(safeExisting?.[f.key]?.trim())),
    [fields, safeExisting],
  )

  /** 「主要角色」这类称谓 —— 从标题里摘出来，给对话引导当主语（标题形如 `AI 补全 · 主要角色`） */
  const subjectLabel = useMemo(() => {
    const t = title.replace(/^AI 补全(?:本行空白)?\s*·\s*/, '').trim()
    return t || '这份设定'
  }, [title])

  /** 已填字段摊平成文本：给对话引导当起点（「只追问缺口」），也给补全当「补完」依据 */
  const existingText = useMemo(() => {
    if (!safeExisting) return ''
    const labels = Object.fromEntries(fields.map(f => [f.key, f.label]))
    return filledToText(safeExisting, labels)
  }, [safeExisting, fields])

  /** 对话引导的「纲」：字段清单是动态的，所以提纲按字段顺序切话题 */
  const spec = useMemo<InterviewSpec>(() => ({
    subject: subjectLabel,
    topics: deriveTopics(sendFields.map(f => ({ key: f.key, label: f.label, desc: f.desc ?? f.example }))),
    allowedKeys: sendFields.map(f => f.key),
    labels: Object.fromEntries(sendFields.map(f => [f.key, f.label])),
  }), [sendFields, subjectLabel])

  /** 用活动模型发一轮 JSON（酒馆那边用会话指定的模型，这里用全局活动模型） */
  const callChat = useCallback(
    (msgs: Parameters<typeof aiChatJson>[0], opts: { signal?: AbortSignal }) =>
      aiChatJson(msgs, { signal: opts.signal }),
    [],
  )

  const run = async () => {
    if (sendFields.length === 0) {
      setError('没有需要补全的空字段（已全部填写或被锁定）。')
      return
    }
    setLoading(true)
    setError(null)
    setSource(null)
    try {
      let ctx = ''
      if (withWorldContext && useCtx) {
        try { ctx = await buildWorldContext() } catch { ctx = '' }
      }
      // 素材：联网检索（按设置那一档）+ 粘贴的参考 + 现有内容。
      // 查失败**不中断** —— 照样用模型知识生成，但把原因带回来如实显示。
      const material = await prepareDraftMaterial({
        idea: sketch,
        refs,
        existing: existingText,
        settings: search ?? { ...DEFAULT_SEARCH_SETTINGS },
      })
      setSource(material.source)
      const r = await aiCompleteTemplate(sendFields, sketch, {
        worldContext: ctx,
        material: material.blocks,
      })
      setResult(r.values)
      setAiFilled(r.aiFilled)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const apply = () => {
    if (!result) return
    onSubmit(result)
    onClose()
  }

  const setVal = (key: string, v: string) => setResult(prev => ({ ...(prev ?? {}), [key]: v }))

  // 对话引导：整个弹窗换成访谈界面（不套娃 —— 各用各的 Modal）
  if (mode === 'interview' && sendFields.length > 0) {
    return (
      <InterviewChat
        subject={subjectLabel}
        spec={spec}
        existing={existingText || undefined}
        callChat={callChat}
        onClose={onClose}
        onApply={onSubmit}
        applyLabel="生成草稿并填入"
      />
    )
  }

  return (
    <Modal open onClose={onClose} icon={<Sparkles size={14} />} title={title} width="xl" maxHeight="88vh">

      <div className="space-y-4">
        {/* ---------- 两种模式 ---------- */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="toggle" size="sm" selected={mode === 'fill'}
              onClick={() => setMode('fill')}
            >
              <Sparkles size={12} /> 一句话补全
            </Button>
            <Button
              variant="toggle" size="sm" selected={mode === 'interview'}
              disabled={sendFields.length === 0}
              onClick={() => setMode('interview')}
            >
              <MessagesSquare size={12} /> 对话引导
            </Button>
          </div>
          <p className="mt-1.5 text-10 leading-relaxed text-ink-500">
            想清楚了（甚至想照某个已有作品填）→ 用「一句话补全」，写一句就走；
            只有点感觉、说不清 → 用「对话引导」，AI 按模板提纲一轮轮问你，聊出来的内容最后汇总成草稿。
          </p>
        </div>

        {sendFields.length === 0 ? (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber/8 border border-amber/25 text-12 text-amber">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>没有需要补全的空字段（已全部填写或被锁定）—— 对话引导也帮不上忙，先去清掉几个再回来。</span>
          </div>
        ) : (
          <>
            {draftOn && (
              <div className="rounded-lg border border-ink-700 bg-ink-850/50">
                <button
                  type="button"
                  onClick={() => setDraftOpen(o => !o)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-12 text-ink-200 hover:text-ink-100 transition-colors"
                >
                  <NotebookPen size={12} className="shrink-0 text-ink-400" />
                  草稿本
                  {draftText.trim() && <span className="text-10 text-ink-500">（{draftText.trim().length} 字）</span>}
                  <span className="ml-auto text-10 text-ink-500">{draftOpen ? '收起' : '展开'}</span>
                </button>
                {draftOpen && (
                  <div className="px-3 pb-3">
                    <AutoTextarea
                      value={draftText}
                      onChange={onDraftChange}
                      placeholder="想到什么就往这儿丢：一段没整理的设定、聊天记录里攒的灵感、写了一半的大纲……怎么写都行，不做任何格式要求。"
                      className="text-12"
                      minRows={5}
                      maxHeight={0}
                    />
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        <span className="text-10 text-ink-400">
                        只存在本项目里、自动存盘；<b className="text-ink-300">默认不发给 AI</b>，点「带入」才会随本次请求发出。
                      </span>
                      <span className={`text-10 transition-opacity ${draftSaved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>已存</span>
                      <Button variant="secondary" size="xs" onClick={bringDraftIn} disabled={!draftText.trim()}
                        className="ml-auto"
                        title="把草稿本内容填进下方输入框（已敲过内容则追加在后面）"
                      >
                        {brought ? '重新带入' : '带入本次补全'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-12 text-ink-300 mb-1">
                {sketchLabel ?? '你的粗略设定（名字 / 身份 / 定位等，越具体补全越准）'}
              </label>
              <AutoTextarea
                value={sketch}
                onChange={setSketch}
                placeholder={sketchPlaceholder ?? '例如：一个叫叶昭的少年，是没落剑派最后一名弟子，性格倔强但重情义，想复兴门派……'}
                className="text-13"
                minHeight={64}
                maxHeight={200}
              />
            </div>

            <RefsField value={refs} onChange={setRefs} minRows={2} />

            {withWorldContext && (
              <label className="flex items-center gap-2 text-12 text-ink-300 cursor-pointer select-none">
                <input type="checkbox" checked={useCtx} onChange={e => setUseCtx(e.target.checked)} className="accent-amber" />
                参照本项目世界观（提升一致性，补全更贴合已设的世界观 / 力量体系）
              </label>
            )}
            <AIDataSourceNote feature="fill-template" />

            {!result && <SearchPlanLine settings={search} />}

            {!result && (
              <Button onClick={run}
                disabled={loading || !aiReady} title={!aiReady ? AI_DISABLED_HINT : undefined} variant="primary" size="md" className="flex items-center text-13">
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {loading ? '正在生成补全…' : '生成补全'}
              </Button>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-12 text-red-300">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {result && (
              <>
                <DraftSourceLine source={source} />
                <div className="text-12 text-ink-400">
                  预览：AI 补全的字段已高亮，你可逐条修改后再采用。带「AI补全」的即为模型生成、建议你核对。
                </div>
                <div className="space-y-3 overflow-y-auto pr-1"
style={{ maxHeight: foldVh('42vh') }}>
                  {fields.map(f => {
                    const isProduced = !f.locked && !(safeExisting?.[f.key]?.trim())
                    const val = isProduced ? (result[f.key] ?? '') : (safeExisting?.[f.key] ?? '')
                    const filled = isProduced && aiFilled.includes(f.key)
                    return (
                      <div key={f.key}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-12 font-medium text-ink-100">{f.label}</span>
                          {filled && (
                            <span className="px-1.5 py-px text-10 rounded bg-amber/15 text-amber border border-amber/30">AI补全</span>
                          )}
                          {!isProduced && f.locked && (
                            <span className="px-1.5 py-px text-10 rounded bg-ink-800 text-ink-500 border border-ink-700">锁定</span>
                          )}
                          {!isProduced && !f.locked && (
                            <span className="px-1.5 py-px text-10 rounded bg-ink-800 text-ink-500 border border-ink-700">已填</span>
                          )}
                        </div>
                        {isProduced ? (
                          <textarea
                            value={val}
                            onChange={e => setVal(f.key, e.target.value)}
                            className="w-full text-12 bg-ink-900 border border-ink-700 rounded-lg px-2 py-1.5 resize-y focus:border-amber/40 outline-none"
                            rows={2}
                          />
                        ) : (
                          <div className="text-12 text-ink-400 bg-ink-900/50 border border-ink-800 rounded-lg px-2 py-1.5 whitespace-pre-wrap break-words">
                            {val || '（空）'}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={apply} variant="primary" size="md" className="flex items-center text-13">
                    <Check size={13} /> 采用并创建
                  </Button>
                  <Button
                    onClick={() => { setResult(null); setAiFilled([]); setSource(null) }}
                    variant="secondary" size="md" className="flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} /> 重新生成
                  </Button>
                  <Button variant="secondary" size="md" onClick={onClose} className="ml-auto">
                    取消
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

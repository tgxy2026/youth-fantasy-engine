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
import { foldVh } from '@/lib/settings/theme'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Check, Loader2, AlertCircle, RefreshCw, MessagesSquare, NotebookPen } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { candidateApplyContext, useCandidateApply } from '@/components/common/useCandidateApply'
import type { CandidateSubmit } from '@/lib/ai/candidateApply'
import AutoTextarea from '@/components/common/AutoTextarea'
import { aiChatJson, aiCompleteTemplate, buildWorldContext, WORLD_CONTEXT_GROUPS, type TemplateField, type FillContext } from '@/lib/ai'
import { prepareDraftMaterial, type DraftSource } from '@/lib/editor/draftMaterial'
import { deriveTopics, filledToText, type InterviewSpec } from '@/lib/creative/interview'
import { loadFreeDraft, saveFreeDraft } from '@/lib/editor/freeDraft'
import { isInternalFieldKey } from '@/lib/world/worldSets'
import { DEFAULT_SEARCH_SETTINGS } from '@/lib/ai/webSearch'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from '@/components/editor/DraftBits'
import InterviewChat from '@/components/creative/InterviewChat'
import InterviewContextPicker, { type ContextChoice } from '@/components/creative/InterviewContextPicker'
import { Button } from '@/components/common/Button'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { applyFieldLabels } from '@/lib/templates/labels'
import { useFieldGating } from '@/lib/templates/useFieldLabels'

interface Props {
  /** 该实体的全部字段（key 约定见 TemplateField） */
  fields: TemplateField[]
  /**
   * 所属页签（3.2.0 · T3）。传了就把字段名换成**作者当前显示名**（模板 > 别名 > 原名），
   * 提示词、已填摘要与预览三处同步。`fields[].key` 仍是存储键，回填路径不变。
   */
  tabId?: string
  /**
   * 补全语境 —— 决定发哪条系统提示词（缺省 = 通用设定补全）。
   * 大纲规划三页签（全书总纲 / 分卷大纲 / 章节细纲）各传自己那条；见 `lib/ai.ts` 的 `FillContext`。
   */
  context?: FillContext
  /** 已存在的值（表单型补全时传入）：这些字段视为已填，锁定不发给模型、不随补全写入 */
  existing?: Record<string, string>
  /** 是否提供「参照世界观」开关（默认 true） */
  withWorldContext?: boolean
  /**
   * **额外可带进对话引导的设定块**（2026-10-03）—— 由调用方备好文本，本组件只负责列出来让作者勾选。
   * 典型用途：同页签**其它活跃条目**的已填摘要（多套并行时，兄弟条目之间最容易撞车）。
   * 🔴 本组件**不自己读库**：读什么、读多少、怎么截断，一律由调用方决定。
   */
  extraContextGroups?: (ContextChoice & { text: string })[]
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
  onSubmit: CandidateSubmit
  onClose: () => void
}

type Mode = 'fill' | 'interview'

export default function AITemplateFill({
  fields,
  tabId,
  context,
  existing,
  withWorldContext = true,
  extraContextGroups = [],
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
  /** 对话引导带哪些既有设定（默认只带母级世界设定 —— 最常需要保持一致的那组） */
  const [pickedCtx, setPickedCtx] = useState<string[]>(['worldbase'])
  const [interviewCtx, setInterviewCtx] = useState('')
  const [ctxBusy, setCtxBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, string> | null>(null)
  const [aiFilled, setAiFilled] = useState<string[]>([])
  const [source, setSource] = useState<DraftSource | null>(null)
  const adoption = useCandidateApply(onSubmit, onClose)
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
      // 🔴 2.4.4 六维审计 P1：保存失败（false）绝不亮「已存」—— 否则作者以为存上了，关弹窗即丢稿
      void saveFreeDraft(draftScope, v).then(ok => { if (ok) setDraftSaved(true) })
    }, 600)
  }

  /** 把草稿带进「粗略设定」框：非空则换行追加（作者可能已经敲了一句） */
  const bringDraftIn = () => {
    const t = draftText.trim()
    if (!t) return
    setSketch(prev => (prev.trim() ? `${prev.trim()}\n${t}` : t))
    setBrought(true)
  }

  // 3.2.0 · T3：作者当前显示名（改名不影响 key，回填仍按存储键）。
  // 🔴 `pending` 里的字段含义未确认（方案 §3.12.3.3）：既不当 AI 填写目标，已填值也不发给模型。
  const gating = useFieldGating(tabId)
  const labels = gating.labels
  const pendingKeys = gating.pending
  const activeFields = useMemo(
    () => (pendingKeys.size ? fields.filter(f => !pendingKeys.has(f.key)) : fields),
    [fields, pendingKeys],
  )
  const hiddenPendingCount = fields.length - activeFields.length
  const labeledFields = useMemo(() => applyFieldLabels(activeFields, labels), [activeFields, labels])

  /**
   * 剥掉「内部字段」（`__` 前缀，如设定草稿箱）与「含义未确认字段」后的已填值。
   *
   * 🔴 为什么必须剥：`existing` 会被摊平进 `existingText` 发给模型（对话引导的起点、
   *    补全的"已有什么"）。草稿箱是作者明确标注「不发给 AI」的那一段，
   *    顺着这条路漏出去，界面上的承诺就成了空话 —— 且它是**静默**的，谁也看不出来。
   * 🔴 T3：待确认字段的值同理（确认前既不能按旧名解释，也不能推断新义）。
   */
  const safeExisting = useMemo(() => {
    if (!existing) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(existing)) {
      if (isInternalFieldKey(k)) continue
      if (pendingKeys.has(k)) continue
      out[k] = v
    }
    return out
  }, [existing, pendingKeys])

  // 锁定 / 已填字段不发给模型；其余才是 AI 真正补全的对象
  const sendFields = useMemo(
    () => labeledFields.filter(f => !f.locked && !(safeExisting?.[f.key]?.trim())),
    [labeledFields, safeExisting],
  )

  /**
   * 对话引导的可选设定清单：母级三组（worldbase / power / positioning）＋ 调用方自备的额外块。
   * 组装时按勾选拼成一段文本，交给 InterviewChat 的 `context`。
   */
  const ctxChoices = useMemo<ContextChoice[]>(() => [
    ...(withWorldContext ? WORLD_CONTEXT_GROUPS.map(g => ({ key: g.key, label: g.label, hint: g.hint })) : []),
    ...extraContextGroups.map(g => ({ key: g.key, label: g.label, hint: g.hint })),
  ], [withWorldContext, extraContextGroups])

  /** 勾选变化 / 进入对话引导时重建上下文文本（读库是异步的，故单独一个 state） */
  useEffect(() => {
    if (mode !== 'interview' || !withWorldContext) { setInterviewCtx(''); return }
    let alive = true
    setCtxBusy(true)
    void (async () => {
      const parts: string[] = []
      if (pickedCtx.some(k => (WORLD_CONTEXT_GROUPS.find(g => g.key === k)))) {
        try { parts.push(await buildWorldContext(pickedCtx)) } catch { /* 读不到就当没有 */ }
      }
      for (const g of extraContextGroups) if (pickedCtx.includes(g.key) && g.text.trim()) parts.push(g.text)
      if (alive) setInterviewCtx(parts.filter(Boolean).join('\n'))
    })().finally(() => { if (alive) setCtxBusy(false) })
    return () => { alive = false }
  }, [mode, pickedCtx, withWorldContext, extraContextGroups])

  /** 「主要角色」这类称谓 —— 从标题里摘出来，给对话引导当主语（标题形如 `AI 补全 · 主要角色` / `AI 新增 · 主要角色`） */
  const subjectLabel = useMemo(() => {
    const t = title.replace(/^AI (?:补全|新增)(?:本行空白)?\s*·\s*/, '').trim()
    return t || '这份设定'
  }, [title])

  /** 已填字段摊平成文本：给对话引导当起点（「只追问缺口」），也给补全当「补完」依据 */
  const existingText = useMemo(() => {
    if (!safeExisting) return ''
    const labelOf = Object.fromEntries(labeledFields.map(f => [f.key, f.label]))
    return filledToText(safeExisting, labelOf)
  }, [safeExisting, labeledFields])

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
    if (adoption.isPending() || !adoption.reset()) return
    const owner = candidateApplyContext()
    const current = () => owner === candidateApplyContext()
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
      if (!current()) return
      // 素材：联网检索（按设置那一档）+ 粘贴的参考 + 现有内容。
      // 查失败**不中断** —— 照样用模型知识生成，但把原因带回来如实显示。
      const material = await prepareDraftMaterial({
        idea: sketch,
        refs,
        existing: existingText,
        settings: search ?? { ...DEFAULT_SEARCH_SETTINGS },
      })
      if (!current()) return
      setSource(material.source)
      const r = await aiCompleteTemplate(sendFields, sketch, {
        worldContext: ctx,
        material: material.blocks,
        context,
      })
      if (!current()) return
      setResult(r.values)
      setAiFilled(r.aiFilled)
    } catch (e) {
      if (!current()) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const apply = () => {
    if (!result) return
    void adoption.apply(result)
  }

  const setVal = (key: string, v: string) => setResult(prev => ({ ...(prev ?? {}), [key]: v }))

  // 对话引导：整个弹窗换成访谈界面（不套娃 —— 各用各的 Modal）
  if (adoption.blocked) return <Modal key="context-changed" open title="工作上下文已变化" width="sm"
    onClose={adoption.requestClose} dismissible={!adoption.pending} showCloseButton={!adoption.pending}>
    <p role="alert" className="text-13 text-ink-100">当前工作上下文已变化，此窗口不再展示或提交原目标内容。已发出的操作请到原目标核对，关闭后可在目标页重新打开。</p>
    <Button className="mt-3" disabled={adoption.pending} onClick={adoption.requestClose}>关闭</Button>
  </Modal>
  if (mode === 'interview' && sendFields.length > 0) {
    return (
      <InterviewChat
        subject={subjectLabel}
        spec={spec}
        existing={existingText || undefined}
        context={interviewCtx || undefined}
        headerSlot={
          withWorldContext ? (
            <InterviewContextPicker
              choices={ctxChoices}
              picked={pickedCtx}
              busy={ctxBusy}
              onToggle={k => setPickedCtx(prev => (prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]))}
              onAll={() => setPickedCtx(ctxChoices.map(c => c.key))}
              onNone={() => setPickedCtx([])}
            />
          ) : undefined
        }
        callChat={callChat}
        onClose={onClose}
        onApply={onSubmit}
        applyLabel="采用候选并填入"
        /**
         * 存档作用域（3.1.3）：优先复用草稿本的 `draftScope` —— 它已经是「页签 / 记录 / 行」
         * 维度的稳定值，8 个调用方都传了；没传时退回「按弹窗标题」，至少同类型弹窗能接上。
         * 🔴 这里只给**裸 scope**，`interview::` 前缀由 interviewStore 自己加（别拼两层）。
         */
        persistScope={draftScope ?? `by-title::${title}`}
        persistLabel={title.replace(/^AI (?:补全|新增)(?:本行空白)?\s*·\s*/, '').trim() || title}
      />
    )
  }

  return (
    <Modal open onClose={adoption.requestClose} dismissible={!adoption.pending} showCloseButton={!adoption.pending} icon={<Sparkles size={14} />} title={title} width="xl" maxHeight="88vh">

      <div className="space-y-4">
        {/* ---------- 两种模式 ---------- */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="toggle" size="sm" selected={mode === 'fill'}
              disabled={adoption.pending || adoption.blocked}
              onClick={() => setMode('fill')}
            >
              <Sparkles size={12} /> 一句话补全
            </Button>
            <Button
              variant="toggle" size="sm" selected={mode === 'interview'}
              disabled={sendFields.length === 0 || adoption.pending || adoption.blocked}
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

        {hiddenPendingCount > 0 && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-ink-800/60 border border-ink-700 text-11 text-ink-400">
            <AlertCircle size={13} className="mt-0.5 shrink-0 text-amber" />
            <span>
              有 {hiddenPendingCount} 个字段改了名但还没确认含义，本次不参与 AI 补全，已填的值也不会发给模型。
              先在「字段改名」里确认后再回来。
            </span>
          </div>
        )}

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
                      minRows={5}
                      maxHeight={0}
                    />
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        <span className="text-10 text-ink-400">
                        只存在本项目里、自动存盘；<b className="text-ink-300">默认不发给 AI</b>，点「带入」才会随本次请求发出。
                      </span>
                      <span className={`text-10 transition-opacity ${draftSaved ? 'opacity-100 text-success' : 'opacity-0'}`}>已存</span>
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
                textClass="text-13"
                minHeight={64}
                maxHeight={200}
              />
            </div>

            <RefsField value={refs} onChange={setRefs} minRows={2} />

            {withWorldContext && (
              <label className="flex items-center gap-2 text-12 text-ink-300 cursor-pointer select-none">
                <input type="checkbox" checked={useCtx} onChange={e => setUseCtx(e.target.checked)} className="accent-amber" />
                参照本项目世界观（提升一致性，补全更贴合已设的世界观 / 设定表）
              </label>
            )}
            <AIDataSourceNote feature="fill-template" />

            {!result && <SearchPlanLine settings={search} />}

            {!result && (
              <Button onClick={run}
                disabled={loading || adoption.pending || adoption.blocked || !aiReady} title={!aiReady ? AI_DISABLED_HINT : undefined} variant="primary" size="md" className="flex items-center">
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {loading ? '正在生成补全…' : '生成补全'}
              </Button>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {result && (
              <>
                <DraftSourceLine source={source} />
                <div className="text-12 text-ink-400">
                  预览：AI 补全的字段已高亮，你可逐条修改后再采用。带「AI补全」的即为模型生成、建议你核对。
                  候选尚未应用；采用后请在目标页核对结果和保存状态。
                </div>
                {adoption.error && <p role="alert" className="rounded-lg border border-danger/40 bg-surface-panel p-2 text-12 text-danger">{adoption.error}</p>}
                <div className="space-y-3 overflow-y-auto pr-1"
style={{ maxHeight: foldVh('42vh') }}>
                  {labeledFields.map(f => {
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
                            disabled={adoption.pending || adoption.blocked}
                            data-candidate-field={f.key}
                            value={val}
                            onChange={e => setVal(f.key, e.target.value)}
                            className="w-full text-12 bg-ink-900 border border-ink-700 rounded-lg px-2 py-1.5 resize-y focus:border-amber/40 outline-none"
                            rows={2}
                          />
                        ) : (
                          <div className="text-12 text-ink-400 bg-ink-900/50 border border-ink-700 rounded-lg px-2 py-1.5 whitespace-pre-wrap break-words">
                            {val || '（空）'}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={apply} disabled={adoption.pending || adoption.blocked} variant="primary" size="md" className="flex items-center">
                    <Check size={13} /> {adoption.pending ? '正在采用…' : '采用候选'}
                  </Button>
                  <Button
                    onClick={() => { if (!adoption.reset()) return; setResult(null); setAiFilled([]); setSource(null) }}
                    disabled={adoption.pending || adoption.blocked}
                    variant="secondary" size="md" className="flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} /> 重新生成
                  </Button>
                  <Button variant="secondary" size="md" disabled={adoption.pending} onClick={adoption.requestClose} className="ml-auto">
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

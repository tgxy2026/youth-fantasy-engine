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
import { useCallback, useMemo, useState } from 'react'
import { Sparkles, Check, Loader2, AlertCircle, RefreshCw, MessagesSquare } from 'lucide-react'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import { aiChatJson, aiCompleteTemplate, buildWorldContext, type TemplateField } from '../lib/ai'
import { prepareDraftMaterial, type DraftSource } from '../lib/draftMaterial'
import { deriveTopics, filledToText, type InterviewSpec } from '../lib/interview'
import { DEFAULT_SEARCH_SETTINGS } from '../lib/webSearch'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from './DraftBits'
import InterviewChat from './InterviewChat'
import { Button } from './Button'

interface Props {
  /** 该实体的全部字段（key 约定见 TemplateField） */
  fields: TemplateField[]
  /** 已存在的值（表单型补全时传入）：这些字段视为已填，锁定不发给模型、不随补全写入 */
  existing?: Record<string, string>
  /** 是否提供「参照世界观」开关（默认 true） */
  withWorldContext?: boolean
  /** 草图输入框占位提示 */
  sketchPlaceholder?: string
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
  title = 'AI 补全设定',
  onSubmit,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>('fill')
  const [sketch, setSketch] = useState('')
  const [refs, setRefs] = useState('')
  const [useCtx, setUseCtx] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, string> | null>(null)
  const [aiFilled, setAiFilled] = useState<string[]>([])
  const [source, setSource] = useState<DraftSource | null>(null)
  const search = useSearchSettings()

  // 锁定 / 已填字段不发给模型；其余才是 AI 真正补全的对象
  const sendFields = useMemo(
    () => fields.filter(f => !f.locked && !(existing?.[f.key]?.trim())),
    [fields, existing],
  )

  /** 「主要角色」这类称谓 —— 从标题里摘出来，给对话引导当主语（标题形如 `AI 补全 · 主要角色`） */
  const subjectLabel = useMemo(() => {
    const t = title.replace(/^AI 补全(?:本行空白)?\s*·\s*/, '').trim()
    return t || '这份设定'
  }, [title])

  /** 已填字段摊平成文本：给对话引导当起点（「只追问缺口」），也给补全当「补完」依据 */
  const existingText = useMemo(() => {
    if (!existing) return ''
    const labels = Object.fromEntries(fields.map(f => [f.key, f.label]))
    return filledToText(existing, labels)
  }, [existing, fields])

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
            <div>
              <label className="block text-12 text-ink-300 mb-1">
                你的粗略设定（名字 / 身份 / 定位等，越具体补全越准）
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
                disabled={loading} variant="primary" size="md" className="flex items-center text-13">
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
                    const isProduced = !f.locked && !(existing?.[f.key]?.trim())
                    const val = isProduced ? (result[f.key] ?? '') : (existing?.[f.key] ?? '')
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

import { useState, useMemo } from 'react'
import { Sparkles, Check, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import { aiCompleteTemplate, buildWorldContext, type TemplateField } from '../lib/ai'
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

export default function AITemplateFill({
  fields,
  existing,
  withWorldContext = true,
  sketchPlaceholder,
  title = 'AI 补全设定',
  onSubmit,
  onClose,
}: Props) {
  const [sketch, setSketch] = useState('')
  const [useCtx, setUseCtx] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, string> | null>(null)
  const [aiFilled, setAiFilled] = useState<string[]>([])

  // 锁定 / 已填字段不发给模型；其余才是 AI 真正补全的对象
  const sendFields = useMemo(
    () => fields.filter(f => !f.locked && !(existing?.[f.key]?.trim())),
    [fields, existing],
  )

  const run = async () => {
    if (sendFields.length === 0) {
      setError('没有需要补全的空字段（已全部填写或被锁定）。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      let ctx = ''
      if (withWorldContext && useCtx) {
        try { ctx = await buildWorldContext() } catch { ctx = '' }
      }
      const r = await aiCompleteTemplate(sendFields, sketch, ctx)
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

  return (
    <Modal open onClose={onClose} icon={<Sparkles size={14} />} title={title} width="xl" maxHeight="88vh">

        <div className="space-y-4">
          <div>
            <label className="block text-[12px] text-ink-300 mb-1">
              你的粗略设定（名字 / 身份 / 定位等，越具体补全越准）
            </label>
            <AutoTextarea
              value={sketch}
              onChange={setSketch}
              placeholder={sketchPlaceholder ?? '例如：一个叫叶昭的少年，是没落剑派最后一名弟子，性格倔强但重情义，想复兴门派……'}
              className="text-[13px]"
              minHeight={64}
              maxHeight={200}
            />
          </div>

          {withWorldContext && (
            <label className="flex items-center gap-2 text-[12px] text-ink-300 cursor-pointer select-none">
              <input type="checkbox" checked={useCtx} onChange={e => setUseCtx(e.target.checked)} className="accent-amber" />
              参照本项目世界观（提升一致性，补全更贴合已设的世界观 / 力量体系）
            </label>
          )}

          {!result && (
            <Button onClick={run}
              disabled={loading} variant="primary" size="md" className="flex items-center text-[13px]">
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {loading ? '正在生成补全…' : '生成补全'}
            </Button>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[12px] text-red-300">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <>
              <div className="text-[12px] text-ink-400">
                预览：AI 补全的字段已高亮，你可逐条修改后再采用。带「AI补全」的即为模型生成、建议你核对。
              </div>
              <div className="space-y-3 max-h-[42vh] overflow-y-auto pr-1">
                {fields.map(f => {
                  const isProduced = !f.locked && !(existing?.[f.key]?.trim())
                  const val = isProduced ? (result[f.key] ?? '') : (existing?.[f.key] ?? '')
                  const filled = isProduced && aiFilled.includes(f.key)
                  return (
                    <div key={f.key}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[12px] font-medium text-ink-100">{f.label}</span>
                        {filled && (
                          <span className="px-1.5 py-px text-[10px] rounded bg-amber/15 text-amber border border-amber/30">AI补全</span>
                        )}
                        {!isProduced && f.locked && (
                          <span className="px-1.5 py-px text-[10px] rounded bg-ink-800 text-ink-500 border border-ink-700">锁定</span>
                        )}
                        {!isProduced && !f.locked && (
                          <span className="px-1.5 py-px text-[10px] rounded bg-ink-800 text-ink-500 border border-ink-700">已填</span>
                        )}
                      </div>
                      {isProduced ? (
                        <textarea
                          value={val}
                          onChange={e => setVal(f.key, e.target.value)}
                          className="w-full text-[12px] bg-ink-900 border border-ink-700 rounded px-2 py-1.5 resize-y focus:border-amber/40 outline-none"
                          rows={2}
                        />
                      ) : (
                        <div className="text-[12px] text-ink-400 bg-ink-900/50 border border-ink-800 rounded px-2 py-1.5 whitespace-pre-wrap break-words">
                          {val || '（空）'}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button onClick={apply} variant="primary" size="md" className="flex items-center text-[13px]">
                  <Check size={13} /> 采用并创建
                </Button>
                <Button
                  onClick={() => { setResult(null); setAiFilled([]) }}
                  variant="secondary" size="md"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] hover:bg-ink-600"
                >
                  <RefreshCw size={12} /> 重新生成
                </Button>
                <Button variant="ghost" onClick={onClose} className="ml-auto px-3 py-2 text-[12px]">
                  取消
                </Button>
              </div>
            </>
          )}
        </div>
    </Modal>
  )
}

/**
 * 首启向导 · 第二步：AI 模型配置（2.4.0 · A1 首启闭环）
 *
 * 【为什么要有这一步】
 * 新装的软件里所有 AI 按钮都是灰的，而新用户并不知道「为什么灰」「灰了还能不能写」。
 * 所以把「配一个模型」提到首启流程里，并把话说明白：**手动写作不依赖 AI** ——
 * 不配也能立刻开始写第一段；配了只是让续写 / 校对 / 取名这些按钮亮起来。
 *
 * 【为什么「测试并启用」只有一个按钮】
 * 别处是「测试 → 保存 → 设为当前」三步，向导里合成一步：测试真发一次最小对话，
 * 通过了就顺手存成当前模型、并按该模型把写作额度调成推荐值。
 * 首启场景下「测通了」基本就等于「我要用它」，少一次点击。测不通则不落库。
 *
 * 【额度不是算给你看的】
 * 回显的可用额度取自 `currentModelAdvice()` 的真实推荐值，并且**确实写进了设置**
 * —— 显示与实际生效值保持同一个来源，不出现「面板说 2 万、实际还是 8 千」。
 */
import { useState } from 'react'
import {
  Cpu, Globe, Loader2, CheckCircle2, AlertCircle, FlaskConical, RefreshCw, Lightbulb,
} from 'lucide-react'
import { Button } from './Button'
import AIDisabledNotice from './AIDisabledNotice'
import { showToast } from './dialogs'
import {
  type AIProvider, type AITestResult, type PlatformPreset,
  testProvider, providerFromPreset, listOllamaModels,
  loadProviders, saveProviders, saveActiveId,
  LOCAL_PRESETS, ONLINE_PRESETS,
} from '../lib/ai'
import { currentModelAdvice, getWriterBudget, saveWriterBudget } from '../lib/aiWriterBudget'
import { syncTuningWithModel } from '../lib/tavern/settings'

/**
 * 向导只摆最常用的几家 —— 首屏摆 14 个平台会变成一张让人不想看的清单。
 * 其余（豆包 / MiniMax / 混元 / Groq / OpenRouter…）在「模型设置 → 模型配置」里都有。
 */
const QUICK_CLOUD = ['DeepSeek', '硅基流动 SiliconFlow', '通义千问 Qwen', '智谱 GLM', 'Kimi 月之暗面']
const QUICK_LOCAL = ['Ollama（本地）', 'LM Studio（本地）']

interface Props {
  /** 配好并启用后继续 */
  onDone: () => void
  /** 不配了，直接开始写作 */
  onSkip: () => void
  /** 回到上一步 */
  onBack: () => void
}

export default function WelcomeAISetup({ onDone, onSkip, onBack }: Props) {
  const [mode, setMode] = useState<'local' | 'cloud' | null>(null)
  const [draft, setDraft] = useState<AIProvider | null>(null)
  /** 当前选中的平台预设标签：另存一份供按钮高亮 —— 拿 draft 反推名字不可靠 */
  const [pickedLabel, setPickedLabel] = useState('')
  /** 本地 Ollama 拉到的模型名清单（点「获取本地模型」后填充） */
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AITestResult | null>(null)
  /** 测试通过后按模型套用的写作额度基准（字）；null = 尚未测通 */
  const [budget, setBudget] = useState<number | null>(null)
  /** 测试通过并已启用 */
  const [enabled, setEnabled] = useState(false)

  // 云端「自定义」预设没被 QUICK_CLOUD 命中，单独补一个（放在最后）
  const cloudPresets: PlatformPreset[] = [
    ...ONLINE_PRESETS.filter(p => QUICK_CLOUD.includes(p.label)),
    { label: '自定义', baseUrl: '' },
  ]
  const localPresets = LOCAL_PRESETS.filter(p => QUICK_LOCAL.includes(p.label))

  /** 选平台预设 → 生成一份草稿（类型 / 本地标记由 providerFromPreset 带好） */
  const pick = (p: PlatformPreset) => {
    setPickedLabel(p.label)
    setDraft(providerFromPreset(p))
    setOllamaModels([])
    setResult(null)
    setBudget(null)
    setEnabled(false)
  }

  const patch = (v: Partial<AIProvider>) => setDraft(d => (d ? { ...d, ...v } : d))

  /** 本地 Ollama 专用：把本机已 pull 的模型列出来，省得手打模型名 */
  const fetchModels = async () => {
    if (!draft) return
    setFetching(true)
    try {
      const models = await listOllamaModels(draft.baseUrl)
      setOllamaModels(models)
      if (models.length === 0) {
        setResult({
          ok: false, latencyMs: 0, loadMs: 0, reply: '',
          error: 'Ollama 已连接，但本机还没有任何模型：请先在终端执行 ollama pull <模型名> 拉取一个。',
        })
        return
      }
      setResult(null)
      if (!draft.model) patch({ model: models[0] })
    } catch (e) {
      setResult({
        ok: false, latencyMs: 0, loadMs: 0, reply: '',
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setFetching(false)
    }
  }

  /**
   * 测试并启用：真发一次最小对话 → 通过则保存为当前模型 → 按模型套用写作额度。
   * 失败只展示原因、不落库，用户改完配置可以重测。
   */
  const testAndEnable = async () => {
    if (!draft) return
    setTesting(true)
    setResult(null)
    setBudget(null)
    setEnabled(false)
    const r = await testProvider(draft)
    setResult(r)
    if (r.ok) {
      try {
        const list = await loadProviders()
        const exists = list.some(p => p.id === draft.id)
        await saveProviders(exists ? list.map(p => (p.id === draft.id ? draft : p)) : [...list, draft])
        await saveActiveId(draft.id)
        // 与「模型设置」里换模型走同一条路径：酒馆模式的上下文预算 / 记忆档也跟新模型走。
        // 它按**模型指纹**判定（同模型不动用户手调的值），失败也会自己吞掉，不拦首启。
        void syncTuningWithModel()
        // 额度跟随模型：取真实推荐值，并**真的写进设置**（与回显同一个来源）
        const info = await currentModelAdvice()
        if (info) {
          const st = await getWriterBudget()
          if (st.autoTuneByModel !== false) {
            await saveWriterBudget({ ...st, base: info.recommended, tunedFor: info.fingerprint })
          }
          setBudget(info.recommended)
        }
        setEnabled(true)
      } catch (e) {
        showToast('保存模型配置失败：' + (e instanceof Error ? e.message : String(e)), 'error')
      }
    }
    setTesting(false)
  }

  const isLocalOpenAI = !!draft && draft.type === 'openai' && !!draft.local
  const isOllama = !!draft && draft.type === 'ollama'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-16 font-semibold text-ink-50">顺手配一个 AI 模型</h2>
        <p className="mt-1.5 text-12 text-ink-400 leading-relaxed">
          配好后，AI 续写、校对、取名这些按钮才会亮起来。
          <span className="text-ink-300">不配也不影响写正文</span>
          —— 手动写作从来不用等 AI，随时可以在「模型设置 → 模型配置」里补上。
        </p>
      </div>

      {/* 无 AI 时「哪些入口会灰、为什么灰」的完整清单（A1 遗留补全）。
          向导里原先只有一句笼统说明；这里把确切范围摆出来，作者才知道"不配到底少什么"。
          AI 就绪后组件自己返回 null，不用额外判断。 */}
      <AIDisabledNotice />

      {/* ── 第一步：本地还是云端 ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Button
          variant="toggle"
          selected={mode === 'local'}
          onClick={() => { setMode('local'); setDraft(null); setResult(null); setEnabled(false); setPickedLabel('') }}
          className="flex-col items-start gap-1 p-4 h-auto text-left"
        >
          <span className="flex items-center gap-1.5 text-13 font-medium">
            <Cpu size={14} className="text-success" /> 本地模型
          </span>
          <span className="text-11 text-ink-400 leading-relaxed whitespace-normal">
            跑在你自己机器上（Ollama / LM Studio）。一般免密钥、不用联网，数据不出本机。
          </span>
        </Button>
        <Button
          variant="toggle"
          selected={mode === 'cloud'}
          onClick={() => { setMode('cloud'); setDraft(null); setResult(null); setEnabled(false); setPickedLabel('') }}
          className="flex-col items-start gap-1 p-4 h-auto text-left"
        >
          <span className="flex items-center gap-1.5 text-13 font-medium">
            <Globe size={14} className="text-info" /> 云端模型
          </span>
          <span className="text-11 text-ink-400 leading-relaxed whitespace-normal">
            国内主流平台（DeepSeek / 硅基流动 / 通义 / 智谱 / Kimi）。需要 API 密钥，按量计费。
          </span>
        </Button>
      </div>

      {/* ── 第二步：选平台 ── */}
      {mode && (
        <div className="rounded-xl border border-ink-700 bg-ink-850/50 p-4 space-y-4 page-enter">
          <div>
            <div className="text-11 text-ink-400 mb-1.5">选择平台</div>
            <div className="flex flex-wrap gap-2">
              {(mode === 'local' ? localPresets : cloudPresets).map(p => (
                <Button
                  key={p.label}
                  variant="secondary"
                  size="sm"
                  onClick={() => pick(p)}
                  className={`flex items-center gap-1.5 ${pickedLabel === p.label ? 'border-amber/40 text-amber' : ''}`}
                >
                  {mode === 'local' ? <Cpu size={12} className="text-success" /> : <Globe size={12} className="text-info" />}
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          {/* ── 第三步：填参数 ── */}
          {draft && (
            <div className="space-y-3 pt-1 page-enter">
              <div>
                <label className="block text-11 text-ink-400 mb-1">接口地址</label>
                <div className="flex gap-2">
                  <input
                    value={draft.baseUrl}
                    onChange={e => patch({ baseUrl: e.target.value })}
                    placeholder={isOllama ? 'http://localhost:11434' : 'https://api.deepseek.com/v1'}
                    className="w-full text-12 font-mono"
                  />
                  {isOllama && (
                    <Button variant="secondary" size="sm" onClick={fetchModels} disabled={fetching} className="shrink-0">
                      {fetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      {fetching ? '获取中…' : '获取本地模型'}
                    </Button>
                  )}
                </div>
              </div>

              {!isOllama && (
                <div>
                  <label className="block text-11 text-ink-400 mb-1">
                    API 密钥{isLocalOpenAI && <span className="text-ink-600"> · 本地服务一般免填</span>}
                  </label>
                  <input
                    type="password"
                    value={draft.apiKey}
                    onChange={e => patch({ apiKey: e.target.value })}
                    placeholder={isLocalOpenAI ? '本地服务通常不需要' : '粘贴平台给你的 API Key'}
                    className="w-full text-12 font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-11 text-ink-400 mb-1">模型名称</label>
                {ollamaModels.length > 0 ? (
                  <select
                    value={draft.model}
                    onChange={e => patch({ model: e.target.value })}
                    className="w-full text-12"
                  >
                    <option value="">— 请选择 —</option>
                    {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    value={draft.model}
                    onChange={e => patch({ model: e.target.value })}
                    placeholder={isOllama ? '如 qwen2.5:14b（需本机已 ollama pull）' : '如 deepseek-chat / qwen-plus / glm-4-flash'}
                    className="w-full text-12 font-mono"
                  />
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button variant="primary" size="md" onClick={testAndEnable} disabled={testing}>
                  {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
                  {testing ? '测试中…' : '测试并启用'}
                </Button>
                <span className="text-11 text-ink-500">
                  会真发一次最小对话验证配置，本地大模型首次调用要加载进显存，可能等几十秒。
                </span>
              </div>

              {testing && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-11 bg-ink-800 border border-ink-700 text-ink-300">
                  <Loader2 size={12} className="animate-spin text-amber shrink-0" />
                  正在调用「{draft.model || '未设置模型'}」…
                </div>
              )}

              {!testing && result && (
                <div
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg text-11 ${
                    result.ok
                      ? 'bg-success/10 border border-success/25 text-success'
                      : 'bg-danger/10 border border-danger/25 text-danger'
                  }`}
                >
                  {result.ok
                    ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                    : <AlertCircle size={12} className="mt-0.5 shrink-0" />}
                  {result.ok ? (
                    <span className="leading-relaxed">
                      配置可用 · 模型 <span className="text-emerald-200">{draft.model}</span> · 耗时{' '}
                      {result.latencyMs >= 1000 ? `${(result.latencyMs / 1000).toFixed(1)}s` : `${result.latencyMs}ms`}
                      {budget !== null && (
                        <> · 已按该模型把写作额度设为 <span className="text-emerald-200">{budget}</span> 字</>
                      )}
                      <span className="block mt-0.5 text-success/80">
                        已保存为当前使用的模型，可在「模型设置」里随时增删改。
                      </span>
                    </span>
                  ) : (
                    <span className="whitespace-pre-wrap leading-relaxed">{result.error}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 未配置时的一句兜底说明：避免新用户以为「没配就什么都干不了」 */}
      {!enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-850/40 px-3.5 py-2.5 text-11 text-ink-400 leading-relaxed">
          <Lightbulb size={13} className="mt-0.5 shrink-0 text-amber/70" />
          <span>
            没有 AI 也能正常写作：正文、设定表、大纲、角色卡全是本地保存、手动可填。
            AI 只是把重复劳动变快，你随时可以在「模型设置 → 模型配置」里补上。
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="md" onClick={onBack}>上一步</Button>
        <Button
          variant="primary"
          solid
          size="md"
          className="ml-auto"
          onClick={enabled ? onDone : onSkip}
        >
          {enabled ? '开始写作' : '跳过，直接开始'}
        </Button>
      </div>
    </div>
  )
}

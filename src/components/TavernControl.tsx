/**
 * 酒馆模式 · 控制面板
 *
 * 【它解决什么问题】
 * 原先这些「接进 AI 的参数与提示词」散落在代码各处（`types.ts` 的 TAVERN_DEFAULTS、
 * `prompt.ts` 的 TONE_HINT、`memory.ts` 的记忆阈值、`engine.ts` 的超时…），
 * 想调一个数就得改代码 + 重新构建。这个页签把它们全部搬到前台，改完点保存即生效。
 *
 * 【三段的划分依据】
 *   · 通用控制 —— 不管哪种模式都要用的：模型、上下文预算、超时、上下文窗口、通用补充要求
 *   · 剧情推演 —— 只对剧情模式生效的：叙事向采样参数与风格、专属补充要求
 *   · 自由对话 —— 只对自由模式生效的：聊天向采样参数与风格、专属补充要求、记忆与日常阈值
 * 采样参数之所以**分成两段而不是放通用段**：两种模式的默认值本来就不同
 * （剧情 0.85 / 自由 0.9，叙事要稳、陪伴要松），合成一个会把这个差异抹平。
 *
 * 【默认值】全部等于原来的硬编码值（见 settings.ts 的 DEFAULT_TAVERN_SETTINGS），
 * 所以打开这个页面之前与之后，行为完全一致 —— 不存在"升个版本悄悄变了风格"。
 *
 * 【协议本身】按作者此前的决定：内置常量、不在界面上开放编辑，这里只做只读展示，
 * 便于对着它调上下两段提示词。要改协议内容得替换 `lib/tavern/protocol.ts` 里的常量。
 */
import { useEffect, useState } from 'react'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import { PROTOCOL_CORE, PROTOCOL_VERSION } from '../lib/tavern/protocol'
import {
  getTavernSettings, saveTavernSettings, resetTavernSettings, DEFAULT_TAVERN_SETTINGS,
  type TavernSettings,
} from '../lib/tavern/settings'

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50'

/** 分组外壳 */
function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-ink-800 bg-ink-850/30">
      <div className="px-4 py-3 border-b border-ink-800">
        <h3 className="text-[13.5px] text-amber">{title}</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">{desc}</p>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </section>
  )
}

/** 数值输入：本地留着正在输入的字，避免「打成 0.」时被立刻纠正 */
function NumField({ label, hint, value, min, max, step = 1, suffix, onCommit }: {
  label: string; hint?: string; value: number; min: number; max: number; step?: number
  suffix?: string; onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <label className="block">
      <div className="text-[11.5px] text-ink-200">{label}{suffix ? <span className="text-ink-500">（{suffix}）</span> : null}</div>
      {hint && <div className="mt-0.5 mb-1 text-[10.5px] text-ink-500 leading-relaxed">{hint}</div>}
      <input
        type="number" min={min} max={max} step={step} value={draft}
        onChange={e => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n)) {
            onCommit(Math.min(max, Math.max(min, n)))
          }
        }}
        onBlur={() => setDraft(String(value))}
        className={inputCls}
      />
    </label>
  )
}

/** 文本输入 */
function TextField({ label, hint, value, rows = 3, placeholder, onChange }: {
  label: string; hint?: string; value: string; rows?: number; placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <div className="text-[11.5px] text-ink-200">{label}</div>
      {hint && <div className="mt-0.5 mb-1 text-[10.5px] text-ink-500 leading-relaxed">{hint}</div>}
      <textarea
        value={value} rows={rows} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={`${inputCls} resize-y leading-relaxed`}
      />
    </label>
  )
}

/** 数值组渲染的小工具：读 s[sec][k] */
function numOf<T extends Record<string, unknown>>(sec: T, k: keyof T): number {
  const v = sec[k]
  return typeof v === 'number' ? v : Number(v) || 0
}

export default function TavernControl() {
  const [s, setS] = useState<TavernSettings | null>(null)
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showProtocol, setShowProtocol] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [st, ps] = await Promise.all([
          getTavernSettings(),
          loadProviders().catch(() => [] as AIProvider[]),
        ])
        setS(st)
        setProviders(ps)
      } catch (e) {
        showToast(`读取设置失败：${e instanceof Error ? e.message : String(e)}`, 'error')
        setS(DEFAULT_TAVERN_SETTINGS)
      }
    })()
  }, [])

  const edit = (fn: (prev: TavernSettings) => TavernSettings) => {
    setS(prev => (prev ? fn(prev) : prev))
    setDirty(true)
  }

  const save = async () => {
    if (!s) return
    setSaving(true)
    try {
      const saved = await saveTavernSettings(s)
      setS(saved)
      setDirty(false)
      showToast('已保存，下一轮对话即生效')
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    const okGo = await confirmDialog({
      title: '恢复出厂设置？',
      message: '三段里的所有参数与提示词都会回到内置默认值（就是代码里原本写死的那些）。\n保存后不可撤销。',
      confirmText: '恢复默认',
      danger: true,
    })
    if (!okGo) return
    const def = await resetTavernSettings()
    setS(def)
    setDirty(false)
    showToast('已恢复出厂默认')
  }

  if (!s) return <LoadingState />

  const c = s.common
  const pl = s.plot
  const fr = s.free
  const providerName = (id: string) => providers.find(p => p.id === id)?.name ?? '（已删除的模型）'

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[16px] text-ink-100">控制面板</h1>
          <p className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            酒馆模式全部「接进 AI 的参数与提示词」都在这里，改完点保存即可生效（下一轮对话开始时读取）。
            <br />
            默认值就是内置的出厂值，所以不动它时行为与之前完全一致。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && <span className="text-[11px] text-amber">有未保存的改动</span>}
          <Button variant="secondary" size="sm" onClick={() => void reset()}>恢复默认</Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {/* ==================== 一、通用控制 ==================== */}
      <Section
        title="一、通用控制"
        desc="两种模式都生效。模型与上下文这些「跟谁说、说多长」的事在这里定；具体的采样手感与提示词按模式分在下面两段。"
      >
        <label className="block">
          <div className="text-[11.5px] text-ink-200">默认模型</div>
          <div className="mt-0.5 mb-1 text-[10.5px] text-ink-500 leading-relaxed">
            留空则跟随「模型设置」里选中的全局活动模型。会话里还能单独改这一场的模型（优先级更高）。
          </div>
          <select
            value={c.defaultProviderId}
            onChange={e => edit(prev => ({ ...prev, common: { ...prev.common, defaultProviderId: e.target.value } }))}
            className={inputCls}
          >
            <option value="">（跟随全局活动模型）</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
          </select>
          {c.defaultProviderId && (
            <div className="mt-1 text-[10.5px] text-ink-500">
              当前：{providerName(c.defaultProviderId)}
            </div>
          )}
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumField
            label="上下文预算" suffix="字" min={1000} max={100000} step={500}
            hint="一轮请求里「设定 + 记忆 + 历史」加起来的上限。超了先裁最早的对话轮次（开场永不被裁）。"
            value={numOf(c, 'contextBudget')}
            onCommit={v => edit(prev => ({ ...prev, common: { ...prev.common, contextBudget: v } }))}
          />
          <NumField
            label="请求超时" suffix="秒" min={10} max={900} step={10}
            hint="本地模型慢就调大。联网模型一般 60–180 够用。"
            value={numOf(c, 'timeoutSec')}
            onCommit={v => edit(prev => ({ ...prev, common: { ...prev.common, timeoutSec: v } }))}
          />
          <NumField
            label="上下文窗口 num_ctx" suffix="token" min={2048} max={131072} step={1024}
            hint="显式传给 Ollama。不传它会按全局值（可能 128K）加载，显存占用远超预期。"
            value={numOf(c, 'numCtx')}
            onCommit={v => edit(prev => ({ ...prev, common: { ...prev.common, numCtx: v } }))}
          />
        </div>

        <TextField
          label="通用补充要求"
          hint="两种模式都会带上，排在协议之前。默认这条是「标点适用范围」—— 角色卡的示例常是手机消息体风格，模型容易把「少标点」泛化到整篇。"
          rows={4}
          value={c.extraPrompt}
          onChange={v => edit(prev => ({ ...prev, common: { ...prev.common, extraPrompt: v } }))}
        />
      </Section>

      {/* ==================== 二、剧情推演控制 ==================== */}
      <Section
        title="二、剧情推演的控制"
        desc="只对「剧情推演」生效。叙事向要的是稳 —— 角色反应得站得住，所以温度默认比自由对话低。"
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <NumField label="温度" min={0} max={2} step={0.05} hint="越高越放飞"
            value={numOf(pl, 'temperature')}
            onCommit={v => edit(prev => ({ ...prev, plot: { ...prev.plot, temperature: v } }))} />
          <NumField label="top_p" min={0} max={1} step={0.01}
            value={numOf(pl, 'topP')}
            onCommit={v => edit(prev => ({ ...prev, plot: { ...prev.plot, topP: v } }))} />
          <NumField label="top_k" min={0} max={200} step={1}
            value={numOf(pl, 'topK')}
            onCommit={v => edit(prev => ({ ...prev, plot: { ...prev.plot, topK: v } }))} />
          <NumField label="重复惩罚" min={0.5} max={2} step={0.01} hint="Ollama 侧叫 repeat_penalty"
            value={numOf(pl, 'repeatPenalty')}
            onCommit={v => edit(prev => ({ ...prev, plot: { ...prev.plot, repeatPenalty: v } }))} />
          <NumField label="presence_penalty" min={-2} max={2} step={0.05}
            value={numOf(pl, 'presencePenalty')}
            onCommit={v => edit(prev => ({ ...prev, plot: { ...prev.plot, presencePenalty: v } }))} />
        </div>

        <TextField
          label="叙事向风格追加"
          hint="默认留空 —— 不追加就走协议默认的写法（这本来就是方案 §5.2 的原意）。填了会追加在档位那一层。"
          rows={2}
          placeholder="例：多用白描，少用形容词；每轮至少给出一个具体的环境细节。"
          value={pl.styleHint}
          onChange={v => edit(prev => ({ ...prev, plot: { ...prev.plot, styleHint: v } }))}
        />
        <TextField
          label="剧情推演补充要求"
          hint="只对剧情推演生效，排在协议之前。"
          rows={3}
          placeholder="例：作者扮演的角色一律不要代写；不确定的地方宁可留白，也不要替作者做决定。"
          value={pl.extraPrompt}
          onChange={v => edit(prev => ({ ...prev, plot: { ...prev.plot, extraPrompt: v } }))}
        />
      </Section>

      {/* ==================== 三、自由对话控制 ==================== */}
      <Section
        title="三、自由对话的控制"
        desc="只对「自由对话」生效。陪伴要松弛感，所以温度默认更高；下面还有记忆引擎与日常推进的一组阈值。"
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <NumField label="温度" min={0} max={2} step={0.05} hint="越高越松"
            value={numOf(fr, 'temperature')}
            onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, temperature: v } }))} />
          <NumField label="top_p" min={0} max={1} step={0.01}
            value={numOf(fr, 'topP')}
            onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, topP: v } }))} />
          <NumField label="top_k" min={0} max={200} step={1}
            value={numOf(fr, 'topK')}
            onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, topK: v } }))} />
          <NumField label="重复惩罚" min={0.5} max={2} step={0.01} hint="她的口头禅多，防复读要求更高"
            value={numOf(fr, 'repeatPenalty')}
            onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, repeatPenalty: v } }))} />
          <NumField label="presence_penalty" min={-2} max={2} step={0.05}
            value={numOf(fr, 'presencePenalty')}
            onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, presencePenalty: v } }))} />
        </div>

        <TextField
          label="聊天向风格提示"
          hint="自由对话的档位层。默认是「现代日常场景、短句为主、最多连发 2 条」。"
          rows={2}
          value={fr.styleHint}
          onChange={v => edit(prev => ({ ...prev, free: { ...prev.free, styleHint: v } }))}
        />
        <TextField
          label="自由对话补充要求"
          hint="只对自由对话生效，排在协议之前。"
          rows={3}
          placeholder="例：不要替作者的角色做决定；她不确定的事就写不确定。"
          value={fr.extraPrompt}
          onChange={v => edit(prev => ({ ...prev, free: { ...prev.free, extraPrompt: v } }))}
        />

        <div className="pt-1">
          <div className="mb-2 text-[11.5px] text-ink-200">记忆引擎</div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <NumField label="触发整理" suffix="条" min={2} max={50} step={1}
              hint="未整理的消息达到这么多条，就自动整理一次。"
              value={numOf(fr, 'triggerMessages')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, triggerMessages: v } }))} />
            <NumField label="记忆软上限" suffix="字" min={200} max={10000} step={100}
              hint="超过会在界面上提醒（不硬截）。"
              value={numOf(fr, 'softLimit')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, softLimit: v } }))} />
            <NumField label="记忆硬上限" suffix="字" min={200} max={20000} step={100}
              hint="超过就按「长期摘要 → 纪念日 → 关系状态」依次压缩，关键事实与未爆的雷不动。"
              value={numOf(fr, 'hardLimit')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, hardLimit: v } }))} />
            <NumField label="长期摘要上限" suffix="字" min={100} max={2000} step={50}
              value={numOf(fr, 'longTermLimit')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, longTermLimit: v } }))} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <NumField label="日记保留" suffix="条" min={1} max={30} step={1}
              hint="硬性滚动，新的在上。"
              value={numOf(fr, 'diaryDays')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, diaryDays: v } }))} />
            <NumField label="自动整理最小间隔" suffix="分钟" min={0} max={1440} step={10}
              hint="时间节流：两次自动整理之间至少隔这么久。手动点「立即整理」不受它限制。"
              value={numOf(fr, 'summaryMinIntervalMin')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, summaryMinIntervalMin: v } }))} />
            <NumField label="日常推进间隔" suffix="小时" min={1} max={168} step={1}
              hint="距上次活跃超过这么久，才补写一段「这几天的生活」。没有常驻进程，只能这样推进。"
              value={numOf(fr, 'dailyAdvanceHours')}
              onCommit={v => edit(prev => ({ ...prev, free: { ...prev.free, dailyAdvanceHours: v } }))} />
          </div>
        </div>
      </Section>

      {/* ==================== 协议（只读） ==================== */}
      <Section
        title="四、扮演协议（只读）"
        desc={`内置常量 ${PROTOCOL_VERSION}，两种模式共用，按作者决定不在界面上开放编辑。放在这里是为了让你对着它调上面两段的补充要求。`}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-ink-500">
            全文 {PROTOCOL_CORE.length} 字，注入时钉在 system 的**最末尾**（其「最后提醒」要紧贴生成点）。
          </span>
          <Button variant="ghost" size="sm" onClick={() => setShowProtocol(v => !v)}>
            {showProtocol ? '收起协议' : '查看协议全文'}
          </Button>
        </div>
        {showProtocol && (
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-800 bg-ink-900/60 p-3 text-[11.5px] leading-relaxed text-ink-300">
            {PROTOCOL_CORE}
          </pre>
        )}
      </Section>
    </div>
  )
}

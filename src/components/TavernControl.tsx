/**
 * 酒馆模式 · 控制面板
 *
 * 【它解决什么问题】
 * 原先这些「接进 AI 的参数与提示词」散落在代码各处（`types.ts` 的 TAVERN_DEFAULTS、
 * `prompt.ts` 的 TONE_HINT、`memory.ts` 的记忆阈值、`engine.ts` 的超时…），
 * 想调一个数就得改代码 + 重新构建。这个页签把它们全部搬到前台，改完点保存即生效。
 *
 * 【四段的划分依据】
 *   · 通用设置 —— 不管哪种模式都要用的：模型、上下文预算、超时、上下文窗口、通用补充要求
 *   · 扮演协议 —— 两种模式共用的格式契约（钉在提示词末尾）
 *   · 剧情推演 —— 只对剧情模式生效的：叙事向采样参数与风格、专属补充要求
 *   · 自由对话 —— 只对自由模式生效的：聊天向采样参数与风格、专属补充要求、记忆与日常阈值
 * 采样参数之所以**分成两段而不是放通用段**：两种模式的默认值本来就不同
 * （剧情 0.85 / 自由 0.9，叙事要稳、陪伴要松），合成一个会把这个差异抹平。
 *
 * 【两列布局的划分依据（2026-09-14 第二轮调整）】
 *   左列 = 通用设置 + 扮演协议 —— 「全局的、一次调好就不动的」：跟谁说、说多长、什么格式契约。
 *   右列 = 剧情推演控制 + 自由对话控制 —— 「分模式的手感」：温度、采样、记忆阈值。
 * 序号按**阅读顺序**重排（左列自上而下 一 → 二，再到右列 三 → 四），不按历史顺序。
 *
 * 【排版约定】每项一律「标题 →（可选）输入区 → 说明文字」。说明放在**下面**，
 * 这样长短不一的解释不会把输入框顶得高低起伏 —— 输入框永远在同一水平线上。
 * 列宽的纪律：外层两列在 `xl` 断点才分（更窄时保持单列，免得每列挤成 100px 的条），
 * 段内的数值组在 `sm` 先 2 列、`2xl` 才回到 3 列，保证输入框始终有可读宽度。
 * 两列等高：网格默认 `stretch`，左列用 flex 把「扮演协议」吃满剩余高度（协议正文跟着长），
 * 否则左列会比右列短一大截。⚠️ 协议段一旦改成 `items-start`，这个等高就没了。
 *
 * 【默认值】全部等于原来的硬编码值（见 settings.ts 的 DEFAULT_TAVERN_SETTINGS），
 * 所以打开这个页面之前与之后，行为完全一致 —— 不存在"升个版本悄悄变了风格"。
 */
import { useEffect, useState } from 'react'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import AutoTextarea from './AutoTextarea'
import { PROTOCOL_VERSION } from '../lib/tavern/protocol'
import {
  getTavernSettings, saveTavernSettings, resetTavernSettings,
  DEFAULT_TAVERN_SETTINGS, DEFAULT_PROTOCOL,
  type TavernSettings,
} from '../lib/tavern/settings'

/** 输入框外观（不含字号——字号由 AutoTextarea 的 textClass / input 自己带，避免两处各写一个 size 类打架） */
const BOX = 'bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50'
const NUM = `${BOX} w-full`

/** 段内数值组：窄屏 1 列 → sm 2 列 → 2xl 3 列（两列布局下，只有超宽屏才装得下 3 列） */
const GRID3 = 'grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3'
const GRID2 = 'grid grid-cols-1 gap-4 sm:grid-cols-2'

/**
 * 分组外壳。
 * `className` / `bodyClassName` 是给「需要被拉伸到与对侧等高的那一段」用的（扮演协议）：
 * 外层网格默认 `align-items: stretch`，两列等高；协议段作为左列最后一个子项吃满剩余高度，
 * 内容区（pre）再 `flex-1` 跟着长 —— 否则左列会比右列短一大截。
 */
function Section({ title, desc, children, className = '', bodyClassName = '' }: {
  title: string; desc: string; children: React.ReactNode
  className?: string; bodyClassName?: string
}) {
  return (
    <section className={`rounded-lg border border-ink-800 bg-ink-850/30 ${className}`}>
      <div className="shrink-0 px-4 py-3 border-b border-ink-800">
        <h3 className="text-[13.5px] text-amber">{title}</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-500 leading-relaxed">{desc}</p>
      </div>
      <div className={`p-4 space-y-4 ${bodyClassName}`}>{children}</div>
    </section>
  )
}

/**
 * 单项：标题 → 输入区 → 说明。
 * 说明放下面（不是中间），长短不一时输入框仍然对齐。
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-200 leading-5">{label}</div>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-[10.5px] text-ink-500 leading-relaxed">{hint}</p>}
    </div>
  )
}

/** 数值输入：本地留着正在输入的字，避免「打成 0.」时被立刻纠正 */
function NumField({ label, hint, value, min, max, step = 1, unit, onCommit }: {
  label: string; hint?: string; value: number; min: number; max: number
  step?: number; unit?: string; onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <Field label={unit ? `${label}（${unit}）` : label} hint={hint}>
      <input
        type="number" min={min} max={max} step={step} value={draft} className={NUM}
        onChange={e => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)))
        }}
        onBlur={() => setDraft(String(value))}
      />
    </Field>
  )
}

/** 多行文字输入（自动延展） */
function TextField({ label, hint, value, minRows = 3, placeholder, onChange }: {
  label: string; hint?: string; value: string; minRows?: number; placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <AutoTextarea
        className={BOX} textClass="text-[12.5px]" minRows={minRows} maxHeight={420}
        placeholder={placeholder} value={value} onChange={onChange}
      />
    </Field>
  )
}

/** 下拉选择 */
function SelectField({ label, hint, value, options, emptyLabel, onChange }: {
  label: string; hint?: string; value: string
  options: { id: string; label: string }[]; emptyLabel: string
  onChange: (v: string) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <select value={value} className={`${NUM} w-full`} onChange={e => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </Field>
  )
}

/** 开关 */
function ToggleField({ label, hint, value, onChange }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <button
        type="button" onClick={() => onChange(!value)}
        className={`h-8 w-full rounded-md border text-[12px] transition-colors ${
          value ? 'border-amber/50 bg-amber/15 text-amber' : 'border-ink-700 bg-ink-900 text-ink-400 hover:bg-ink-800'
        }`}
      >
        {value ? '已关闭（推荐）' : '未关闭 —— 模型会先想再答'}
      </button>
    </Field>
  )
}

export default function TavernControl() {
  const [s, setS] = useState<TavernSettings | null>(null)
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [protocolEditing, setProtocolEditing] = useState(false)

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
  const setCommon = (k: keyof TavernSettings['common'], v: number | string | boolean) =>
    edit(prev => ({ ...prev, common: { ...prev.common, [k]: v } as TavernSettings['common'] }))
  const setPlot = (k: keyof TavernSettings['plot'], v: number | string) =>
    edit(prev => ({ ...prev, plot: { ...prev.plot, [k]: v } as TavernSettings['plot'] }))
  const setFree = (k: keyof TavernSettings['free'], v: number | string) =>
    edit(prev => ({ ...prev, free: { ...prev.free, [k]: v } as TavernSettings['free'] }))

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
      message: '四段（通用设置 / 扮演协议 / 剧情推演 / 自由对话）里的所有参数与提示词，都会回到内置默认值。\n保存后不可撤销。',
      confirmText: '恢复默认',
      danger: true,
    })
    if (!okGo) return
    const def = await resetTavernSettings()
    setS(def)
    setDirty(false)
    setProtocolEditing(false)
    showToast('已恢复出厂默认')
  }

  // 打开协议编辑前弹窗提醒（协议是两种模式共用的格式契约，改坏会让输出格式全线崩）
  const startEditProtocol = async () => {
    const okGo = await confirmDialog({
      title: '要编辑扮演协议吗？',
      message: [
        '⚠️ 协议是**剧情推演与自由对话共用**的格式契约，改坏了两种模式的输出格式会一起乱。',
        '',
        '建议：',
        '· 只想调风格/语气 → 用上面的「补充要求」，不必动协议；',
        '· 真要改协议 → 只做小幅增删，别删掉 O1 的格式规定与末尾的「最后提醒」；',
        '· 改错了随时可以点「恢复出厂协议」，或整体「恢复默认」。',
      ].join('\n'),
      confirmText: '我知道了，开始编辑',
      danger: true,
    })
    if (okGo) setProtocolEditing(true)
  }

  if (!s) return <LoadingState />

  const c = s.common
  const pl = s.plot
  const fr = s.free
  const modelOptions = providers.map(p => ({ id: p.id, label: `${p.name} · ${p.model}` }))

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[16px] text-ink-100">控制面板</h1>
          <p className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            酒馆模式全部「接进 AI 的参数与提示词」都在这里，改完点保存即可生效（下一轮对话开始时读取）。
            <br />
            左列是通用的「跟谁说、说多长」与两种模式共用的格式契约，右列是两种模式各自的手感 ——
            建议先把左边看过一遍，再去跑剧情推演或自由对话。
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

      {/* ==================== 两列：左＝通用与契约；右＝分模式的手感 ====================
          网格默认 align-items:stretch → 两列等高；左列再靠 flex 把「扮演协议」撑到与右列平齐。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">

        {/* ========== 左列 ========== */}
        <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-col">

          {/* ---------- 一、通用设置 ---------- */}
          <Section
            title="一、通用设置"
            desc="两种模式都生效。模型与上下文这些「跟谁说、说多长」的事在这里定；具体的采样手感与提示词在右边两段。"
          >
            <SelectField
              label="默认模型"
              hint="留空则跟随「模型设置」里选中的全局活动模型。两个模式都用它；会话里不再单独选择模型。"
              value={c.defaultProviderId}
              options={modelOptions}
              emptyLabel="（跟随全局活动模型）"
              onChange={v => setCommon('defaultProviderId', v)}
            />

            <div className={GRID3}>
              <NumField
                label="上下文预算" unit="字" min={1000} max={100000} step={500}
                hint="一轮请求里「设定 + 记忆 + 对话历史」加起来的上限。超了先裁最早的对话轮次（开场永不被裁）。"
                value={c.contextBudget} onCommit={v => setCommon('contextBudget', v)}
              />
              <NumField
                label="固定开销预留" unit="字" min={500} max={20000} step={100}
                hint="给提示词骨架与协议留的位置。它不算进「可分配给对话历史」的额度里，调大它就等于压缩历史。"
                value={c.fixedOverheadChars} onCommit={v => setCommon('fixedOverheadChars', v)}
              />
              <NumField
                label="请求超时" unit="秒" min={10} max={900} step={10}
                hint="超过这个时间就中断并报错。本地模型慢就调大；联网模型一般 60～180 够用。"
                value={c.timeoutSec} onCommit={v => setCommon('timeoutSec', v)}
              />
            </div>

            <div className={GRID2}>
              <NumField
                label="上下文窗口长度" unit="词元" min={2048} max={131072} step={1024}
                hint="显式告诉本地模型能装多少内容。不指定的话它会按全局设置（可能 128K）加载，显存占用会远超预期。"
                value={c.numCtx} onCommit={v => setCommon('numCtx', v)}
              />
              <ToggleField
                label="关闭思考链"
                hint="开启时模型直接说话，不再先写一段分析。角色扮演要「像人说话」而不是「想得深」，所以默认关闭；只有本地模型认这个开关。"
                value={c.disableThink} onChange={v => setCommon('disableThink', v)}
              />
            </div>

            <TextField
              label="通用补充要求"
              hint="两种模式都会带上，排在协议之前。默认这条是「标点适用范围」—— 角色卡的示例常是手机消息体风格，模型容易把「少标点」泛化到整篇。"
              minRows={4}
              value={c.extraPrompt}
              onChange={v => setCommon('extraPrompt', v)}
            />
          </Section>

          {/* ---------- 二、扮演协议 ---------- */}
          <Section
            title="二、扮演协议"
            desc={`两种模式共用的格式契约，内置版本 ${PROTOCOL_VERSION}。注入时钉在提示词的最末尾（它自带的「最后提醒」要紧贴生成点）。`}
            className="xl:min-h-0 xl:flex xl:flex-1 xl:flex-col"
            bodyClassName="xl:min-h-0 xl:flex-1 xl:flex xl:flex-col"
          >
            {!protocolEditing ? (
              <>
                <div className="flex shrink-0 items-center justify-between gap-3">
                  <span className="text-[11.5px] text-ink-500">
                    当前 {s.protocol.length} 字
                    {s.protocol !== DEFAULT_PROTOCOL && <span className="text-amber"> · 已被你改过（与出厂版本不同）</span>}
                  </span>
                  <div className="flex shrink-0 gap-2">
                    {s.protocol !== DEFAULT_PROTOCOL && (
                      <Button variant="secondary" size="sm"
                        onClick={() => { edit(prev => ({ ...prev, protocol: DEFAULT_PROTOCOL })); setProtocolEditing(true) }}>
                        恢复出厂协议
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void startEditProtocol()}>编辑协议</Button>
                  </div>
                </div>
                <pre className="max-h-80 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-800 bg-ink-900/60 p-3 text-[11.5px] leading-relaxed text-ink-300 xl:max-h-none xl:min-h-[12rem]">
                  {s.protocol}
                </pre>
              </>
            ) : (
              <>
                <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[11.5px] text-amber leading-relaxed">
                  正在编辑协议。改完记得点右上角「保存」才生效；改坏了可以点「恢复出厂协议」，或整体「恢复默认」。
                </div>
                <Field label="协议全文" hint="建议只做小幅增删。别删掉「写成什么样」里的格式规定与末尾的「最后提醒」—— 那两处是格式契约的核心。">
                  <AutoTextarea
                    className={BOX} textClass="text-[11.5px]" minRows={14} maxHeight={720}
                    value={s.protocol}
                    onChange={v => edit(prev => ({ ...prev, protocol: v }))}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm"
                    onClick={() => edit(prev => ({ ...prev, protocol: DEFAULT_PROTOCOL }))}>
                    恢复出厂协议
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setProtocolEditing(false)}>收起编辑</Button>
                </div>
              </>
            )}
          </Section>
        </div>

        {/* ========== 右列 ========== */}
        <div className="space-y-4">

          {/* ---------- 三、剧情推演控制 ---------- */}
          <Section
            title="三、剧情推演控制"
            desc="只对「剧情推演」生效。叙事向要的是稳 —— 角色反应得站得住，所以默认温度比自由对话低。"
          >
            <div className={GRID3}>
              <NumField
                label="温度" min={0} max={2} step={0.05}
                hint="越高越随机、越有意外之喜，也越容易跑偏。叙事推演要稳，默认 0.85。"
                value={pl.temperature} onCommit={v => setPlot('temperature', v)}
              />
              <NumField
                label="核采样阈值" min={0} max={1} step={0.01}
                hint="每一步只从「累积概率达到这个值」的候选词里挑。越低越保守死板，通常 0.9。"
                value={pl.topP} onCommit={v => setPlot('topP', v)}
              />
              <NumField
                label="候选词上限" min={0} max={200} step={1}
                hint="每一步只在概率最高的这么多个词里挑，填 0 表示不限制。通常 40。"
                value={pl.topK} onCommit={v => setPlot('topK', v)}
              />
            </div>
            <div className={GRID3}>
              <NumField
                label="重复惩罚" min={0.5} max={2} step={0.01}
                hint="高于 1 会压制重复用词。越高越不容易复读，但太高会让句子发硬、用词别扭。通常 1.05。"
                value={pl.repeatPenalty} onCommit={v => setPlot('repeatPenalty', v)}
              />
              <NumField
                label="新话题倾向" min={-2} max={2} step={0.05}
                hint="正数鼓励模型引入新内容，负数让它更愿意围着当前话题说。通常 0.4。"
                value={pl.presencePenalty} onCommit={v => setPlot('presencePenalty', v)}
              />
              <NumField
                label="设定层占比" unit="%" min={10} max={95} step={5}
                hint="上下文预算里分给「项目设定」的比例，剩下的留给长期记忆与对话历史。默认 60%。"
                value={Math.round(pl.settingRatio * 100)} onCommit={v => setPlot('settingRatio', v / 100)}
              />
            </div>

            <TextField
              label="叙事向风格追加"
              hint="默认留空 —— 不追加就走协议默认的写法（这本来就是方案的原意）。填了会追加在档位那一层。"
              minRows={2}
              placeholder="例：多用白描，少用形容词；每轮至少给出一个具体的环境细节。"
              value={pl.styleHint}
              onChange={v => setPlot('styleHint', v)}
            />
            <TextField
              label="剧情推演补充要求"
              hint="只对剧情推演生效，排在协议之前。"
              minRows={3}
              placeholder="例：作者扮演的角色一律不要代写；不确定的地方宁可留白，也不要替作者做决定。"
              value={pl.extraPrompt}
              onChange={v => setPlot('extraPrompt', v)}
            />
          </Section>

          {/* ---------- 四、自由对话控制 ---------- */}
          <Section
            title="四、自由对话控制"
            desc="只对「自由对话」生效。陪伴要松弛感，所以温度默认更高；下面还有记忆引擎与日常推进的一组阈值。"
          >
            <div className={GRID3}>
              <NumField
                label="温度" min={0} max={2} step={0.05}
                hint="越高越松、越随性。陪伴向对话默认 0.9，比剧情推演更放得开。"
                value={fr.temperature} onCommit={v => setFree('temperature', v)}
              />
              <NumField
                label="核采样阈值" min={0} max={1} step={0.01}
                hint="每一步只从「累积概率达到这个值」的候选词里挑。越低越保守，通常 0.9。"
                value={fr.topP} onCommit={v => setFree('topP', v)}
              />
              <NumField
                label="候选词上限" min={0} max={200} step={1}
                hint="每一步只在概率最高的这么多个词里挑，填 0 表示不限制。通常 40。"
                value={fr.topK} onCommit={v => setFree('topK', v)}
              />
            </div>
            <div className={GRID2}>
              <NumField
                label="重复惩罚" min={0.5} max={2} step={0.01}
                hint="高于 1 会压制重复用词。角色的口头禅多，所以这一项比剧情模式更值得调。通常 1.05。"
                value={fr.repeatPenalty} onCommit={v => setFree('repeatPenalty', v)}
              />
              <NumField
                label="新话题倾向" min={-2} max={2} step={0.05}
                hint="正数鼓励模型引入新内容，负数让它更愿意围着当前话题说。通常 0.45。"
                value={fr.presencePenalty} onCommit={v => setFree('presencePenalty', v)}
              />
            </div>

            <SelectField
              label="整理记忆用的模型"
              hint="记忆压缩不需要创意，越快越省越好，可以单独指一个便宜的小模型。留空则跟随上面的默认模型。"
              value={fr.summaryProviderId}
              options={modelOptions}
              emptyLabel="（跟随默认模型）"
              onChange={v => setFree('summaryProviderId', v)}
            />

            <TextField
              label="聊天向风格提示"
              hint="自由对话的档位层。默认是「现代日常场景、短句为主、最多连发 2 条」。"
              minRows={2}
              value={fr.styleHint}
              onChange={v => setFree('styleHint', v)}
            />
            <TextField
              label="自由对话补充要求"
              hint="只对自由对话生效，排在协议之前。"
              minRows={3}
              placeholder="例：不要替作者的角色做决定；她不确定的事就写不确定。"
              value={fr.extraPrompt}
              onChange={v => setFree('extraPrompt', v)}
            />

            <div className="pt-1">
              <div className="mb-3 text-[12px] text-ink-200 border-t border-ink-800 pt-3">记忆引擎</div>
              <div className={GRID3}>
                <NumField
                  label="触发整理" unit="条" min={2} max={50} step={1}
                  hint="没整理过的新消息攒到这么多条，就自动整理一次记忆。"
                  value={fr.triggerMessages} onCommit={v => setFree('triggerMessages', v)}
                />
                <NumField
                  label="记忆软上限" unit="字" min={200} max={10000} step={100}
                  hint="超过只在界面上提醒，不会硬截断。"
                  value={fr.softLimit} onCommit={v => setFree('softLimit', v)}
                />
                <NumField
                  label="记忆硬上限" unit="字" min={200} max={20000} step={100}
                  hint="超过就按「长期摘要 → 纪念日 → 关系状态」的顺序压缩；关键事实与未爆的雷不动。"
                  value={fr.hardLimit} onCommit={v => setFree('hardLimit', v)}
                />
                <NumField
                  label="长期摘要上限" unit="字" min={100} max={2000} step={50}
                  hint="「长期摘要」这一栏单独的字数上限，也是最优先被压缩的一栏。"
                  value={fr.longTermLimit} onCommit={v => setFree('longTermLimit', v)}
                />
                <NumField
                  label="日记保留" unit="条" min={1} max={30} step={1}
                  hint="「最近日记」保留几条，新的在上、旧的自动滚动掉。"
                  value={fr.diaryDays} onCommit={v => setFree('diaryDays', v)}
                />
                <NumField
                  label="自动整理最小间隔" unit="分钟" min={0} max={1440} step={10}
                  hint="两次自动整理之间至少隔这么久，避免刚聊两句就反复压缩。手动点「立即整理」不受它限制。"
                  value={fr.summaryMinIntervalMin} onCommit={v => setFree('summaryMinIntervalMin', v)}
                />
                <NumField
                  label="整理锁有效期" unit="分钟" min={1} max={1440} step={10}
                  hint="防止两个窗口同时整理记忆。上次整理跑到一半崩了，超过这个时间就可以被接管。"
                  value={fr.summaryLockTtlMin} onCommit={v => setFree('summaryLockTtlMin', v)}
                />
              </div>
            </div>

            <div className="pt-1">
              <div className="mb-3 text-[12px] text-ink-200 border-t border-ink-800 pt-3">日常推进</div>
              <div className={GRID2}>
                <NumField
                  label="推进间隔" unit="小时" min={1} max={168} step={1}
                  hint="距上次活跃超过这么久，才补写一段「这几天的生活」。没有常驻进程，只能靠打开界面时推进。"
                  value={fr.dailyAdvanceHours} onCommit={v => setFree('dailyAdvanceHours', v)}
                />
                <NumField
                  label="生活记录保留" unit="条" min={1} max={30} step={1}
                  hint="「这几天的生活」保留几条（一天一条），新的在上。"
                  value={fr.dailyLogKeep} onCommit={v => setFree('dailyLogKeep', v)}
                />
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

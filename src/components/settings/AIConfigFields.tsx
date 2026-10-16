/**
 * 「模型设置」面板的三个**内聚字段块**（2026-10-17 · 第四轮审计 §六：`AIConfigPanel` 876 行踩软上限）。
 *
 * 拆出来的判据不是「行数」，而是**它们本来就不依赖面板状态机**：
 *   · `TestResultBar`      —— 只吃一个 `AITestResult`，纯展示（编辑态与列表态**两处共用**）；
 *   · `ContextWindowField` —— 上下文窗口（必填 + K/token 换算 + 越界提示），受控值 + onChange；
 *   · `TemperatureField`   —— 采样温度档位，受控值 + onChange。
 *
 * 留在 `AIConfigPanel` 里的仍是「面板本体」：provider 列表 / 路由 / 超时 / 拉取模型这些
 * **有状态编排**。两者的边界很清楚：这里是「给我值、告诉你怎么改」的哑组件，一分状态都不持有。
 *
 * 🔴 抽出来时**行为一个字符都没动**：校验仍走 `checkContextWindow`，`min={1}` 的注释级理由、
 *    「按 ×1024 换算」按钮的文案、温度档位的 platform 初值兜底，全部照搬。
 */
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import NumberField from '@/components/common/NumberField'
import { showToast } from '@/components/dialogs/dialogs'
import { checkContextWindow, MAX_WINDOW } from '@/lib/ai/modelCapacity'
import {
  TEMPERATURE_TIERS, LOCAL_DEFAULT_TEMPERATURE, CLOUD_DEFAULT_TEMPERATURE,
} from '@/lib/ai'
import type { AITestResult } from '@/lib/ai'

function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 测试结果条：成功显示耗时与模型回文，失败显示中文原因 */
export function TestResultBar({ r }: { r: AITestResult }) {
  const cost = fmtMs(r.latencyMs)
  // 本地模型首次调用大头在「搬进显存」，标出来避免误判为响应慢
  const loadHint = r.loadMs > 500 ? `（其中模型加载 ${fmtMs(r.loadMs)}）` : ''
  return (
    <div
      className={`flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-11 ${
        r.ok
          ? 'bg-success/10 border border-success/25 text-success'
          : 'bg-danger/10 border border-danger/25 text-danger'
      }`}
    >
      {r.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> : <AlertCircle size={12} className="mt-0.5 shrink-0" />}
      {r.ok ? (
        <span>
          配置可用 · 耗时 {cost}
          {loadHint && <span className="text-success/70">{loadHint}</span>}
          {' · 模型回复「'}
          <span className="text-emerald-200">{r.reply.slice(0, 40)}</span>
          {r.reply.length > 40 ? '…' : ''}」
        </span>
      ) : (
        <span className="whitespace-pre-wrap">{r.error}</span>
      )}
    </div>
  )
}

/** 「正在测试」提示条（编辑态 / 列表态共用同一文案，避免两处各写一遍） */
export function TestingBar({ model }: { model: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-12 bg-ink-800 border border-ink-700 text-ink-300">
      <Loader2 size={13} className="animate-spin text-amber shrink-0" />
      正在测试「{model || '未设置模型'}」…本地大模型首次调用需加载进显存，请稍候。
    </div>
  )
}

/**
 * 上下文窗口（tokens）· **必填**（2026-10-04 老大定案，校验见 `lib/modelCapacity.checkContextWindow`）：
 * 原先选填、留空时按模型名去识别表里猜 —— 但那张表得跟着各家发布节奏常年维护，
 * 本地 / 自建 / 冷门模型更永远认不出。改成必填 + 强制换算提示后，作者按自己的部署填一次
 * （1K = 1024 tokens），全项目读同一个数，"猜错"这条路就没了。
 * ⚠️ 数据层仍允许缺失（老库里的模型没这个字段）：`adviseCapacity` 保留兜底只为不把老配置一夜塌成 32K，
 *   界面上则以「未填窗口」标出、引导补填。
 */
export function ContextWindowField({ value, local, onChange }: {
  value: number | undefined
  /** 是否本地平台（ollama / 本地部署）：决定提示里「显存占用」那半句 */
  local: boolean
  onChange: (v: number | undefined) => void
}) {
  const cwText = typeof value === 'number' ? String(value) : ''
  const check = checkContextWindow(value)
  /** 疑似「把 K 当词元数」⇒ 给一键换算；其余不合法情形只说明原因 */
  const sug = check.suggest
  const kSlip = !check.ok && typeof sug === 'number'
  const hint = check.ok
    ? `${cwText} tokens —— 换算：K × 1024（128K 填 131072、96K 填 98304）。${local
        ? '酒馆的「上下文窗口长度」与「上下文预算」跟着它走：填大了预算变松、显存占用同步上升，跑不动就调小。'
        : '酒馆控制面板会按它算上下文预算与记忆档的建议值。'}`
    : check.error
  return (
    <div>
      <label className="block text-11 text-ink-500 mb-1">
        上下文窗口（tokens）<span className="text-ink-600"> · 必填</span>
      </label>
      {/* 🔴 min 保持 1（2026-10-04）：填「128」若被静默钳成 2000，作者看到的是一个
          「合法却完全不对」的值，反而失去纠错机会。现在让它留在框里被看见，
          再由下面的琥珀条给出换算与一键修正；能不能保存由 checkContextWindow 把关。 */}
      <NumberField
        value={value}
        min={1} max={MAX_WINDOW} step={1024}
        className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
        onChange={v => onChange(v)}
        onClamped={v => showToast(`上下文窗口已调回边界 ${v} tokens`, 'info')}
        placeholder="填 token 数：128K 写 131072"
      />
      {kSlip && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded border border-amber/40 bg-amber/10 px-2 py-1">
          <span className="text-10 text-amber">看着像把「K」写成了词元数？{cwText}K 应为 {sug}</span>
          <Button variant="secondary" size="xs" onClick={() => onChange(sug)}>
            按 ×1024 换算为 {sug}
          </Button>
        </div>
      )}
      <p className={`text-10 mt-1 leading-relaxed ${check.ok ? 'text-ink-500' : 'text-amber'}`}>{hint}</p>
    </div>
  )
}

/**
 * 采样温度档位（2.4.0 · A1 遗留补全）：**按 provider 存、随模型走**。
 * 本地小模型与云端大模型合适的温度差别很大，做成全局常量必然两头都不合适
 * （见 `lib/ai` 的 AIProvider.temperature 与 TEMPERATURE_TIERS）。
 * ⚠️ 只影响创意生成；结构化任务固定低温，不受这一项影响。
 */
export function TemperatureField({ value, local, onChange }: {
  value: number | undefined
  local: boolean
  onChange: (v: number) => void
}) {
  return (
    <div>
      <label className="block text-11 text-ink-500 mb-1">
        采样温度<span className="text-ink-600"> · 影响续写 / 取名这类创意生成</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {TEMPERATURE_TIERS.map(tier => (
          <Button
            key={tier.label}
            variant="toggle"
            selected={value === tier.value}
            size="sm"
            onClick={() => onChange(tier.value)}
            title={`${tier.value} —— ${tier.hint}`}
          >
            {tier.label}
          </Button>
        ))}
        <span className="text-10 text-ink-500">
          {TEMPERATURE_TIERS.find(x => x.value === value)?.hint
            ?? `当前未设：创意生成按平台初值 ${local ? LOCAL_DEFAULT_TEMPERATURE : CLOUD_DEFAULT_TEMPERATURE}`}
        </span>
      </div>
      <p className="text-10 text-ink-600 mt-1 leading-relaxed">
        校对、抽取这类结构化任务固定用 0.3 低温，不受这一项影响。
      </p>
    </div>
  )
}

/**
 * 酒馆模式 · 控制面板
 *
 * 【它解决什么问题】
 * 原先这些「接进 AI 的参数与提示词」散落在代码各处（`types.ts` 的 TAVERN_DEFAULTS、
 * `prompt.ts` 的 TONE_HINT、`memory.ts` 的记忆阈值、`engine.ts` 的超时…），
 * 想调一个数就得改代码 + 重新构建。这个页签把它们全部搬到前台，改完点保存即生效。
 *
 * 【九段的划分依据】
 *   · 通用设置 —— 不管哪种模式都要用的：模型、上下文预算、超时、上下文窗口、通用补充要求
 *   · 我的档案 —— **用户本人是谁**（全局、跨项目）。自由对话里「我演」留空时，
 *     它就是 AI 眼中「屏幕后面那个人」；详见 settings.ts 的 TavernProfile。
 *   · 联网检索 —— 「AI 起草」那一步的素材从哪来（全局，与对话本身无关）
 *   · 预设方案 —— 把整套设置存成命名快照，一键切换 / 导出分享
 *   · 输出后处理 —— 两种模式共用的兜底修正规则
 *   · 本场数值 —— 好感 / 信任等五项数值的更新频率与幅度（自由对话里生效）
 *   · 扮演协议 —— 两种模式共用的格式契约（钉在提示词末尾）
 *   · 剧情推演 —— 只对剧情模式生效的：叙事向采样参数与风格、专属补充要求
 *   · 自由对话 —— 只对自由模式生效的：聊天向采样参数与风格、专属补充要求、记忆与日常阈值
 * 采样参数之所以**分成两段而不是放通用段**：两种模式的默认值本来就不同
 * （剧情 0.85 / 自由 0.9，叙事要稳、陪伴要松），合成一个会把这个差异抹平。
 *
 * 【两列布局的划分依据（2026-09-15 第二轮：按实测高度配平）】
 *   左列 = 通用设置 + 我的档案 + 联网检索 + 预设方案 + 输出后处理 + 扮演协议
 *          —— 「不分局部的设置」+ 「两种模式共用的契约」；
 *   右列 = 剧情推演控制 + 自由对话控制 + 本场数值 —— 「两种模式各自的手感」。
 * 分列标准只有一条：**左右两列的内容高度要接近**（否则矮的那列底部会留一大片空白）。
 * ⚠️ 这不是拍脑袋分的，是量出来的（2026-09-15 实测，视口 1600×1000）：
 *   右列 剧情推演 1876 + 自由对话 3767 + 本场数值 788 ≈ 6463px；左列其余各段合计 ≈ 3852px。
 *   差值 ≈ 2611px，正好由协议窗吃满 —— 而协议正文实测约 2189px，**刚好整篇装得下、不用内部滚动**，
 *   底部只剩约 400px 余量（原先协议窗被撑到 4949px，正文之外空了 2700px）。
 *   反例：只把「联网检索 + 预设方案」（合计 511px）挪过来时，协议窗仍被撑到 4949px、
 *   正文只有约 900px，等于把一个 4000px 高的空文本域摆在眼前。
 * 序号按**阅读顺序**重排（左列自上而下 一 → 七，再到右列 八 → 九），不按历史顺序。
 *
 * 【排版约定】每项一律「标题 →（可选）输入区 → 说明文字」。说明放在**下面**，
 * 这样长短不一的解释不会把输入框顶得高低起伏 —— 输入框永远在同一水平线上。
 * 列宽的纪律：外层两列在 `xl` 断点才分（更窄时保持单列，免得每列挤成 100px 的条），
 * 段内的数值组在 `sm` 先 2 列、`2xl` 才回到 3 列，保证输入框始终有可读宽度。
 * 两列等高：网格默认 `stretch`，左列用 flex 把「扮演协议」（左列最后一个子项）吃满剩余高度，
 * 否则左列会比右列短一大截。⚠️ 协议段一旦改成 `items-start`，这个等高就没了。
 * ⚠️ 高度同步用的是「左列**除协议段以外**的全部子项」这个切片 —— 所以左列再加段也不用改逻辑，
 *    但**协议段必须始终是左列最后一个子项**。
 *
 * 【默认值】全部等于原来的硬编码值（见 settings.ts 的 DEFAULT_TAVERN_SETTINGS），
 * 所以打开这个页面之前与之后，行为完全一致 —— 不存在"升个版本悄悄变了风格"。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import HelpPopover from './HelpPopover'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import AvatarPicker from './AvatarPicker'
import PromptModal from './PromptModal'
import { LoadingState } from './LoadingState'
import AutoTextarea from './AutoTextarea'
import { PROTOCOL_VERSION } from '../lib/tavern/protocol'
import * as presets from '../lib/tavern/presets'
import type { TavernPreset } from '../lib/tavern/presets'
import { PARAM_GUIDES, GUIDE_SAMPLING, bandOf, type ParamGuide } from '../lib/tavern/paramGuide'
import { VAR_DEFS, type VarKey } from '../lib/tavern/types'
import { DEFAULT_POST_RULES, previewPostRules, type PostRule } from '../lib/tavern/postRules'
import {
  getTavernSettings, saveTavernSettings, resetTavernSettings,
  DEFAULT_TAVERN_SETTINGS, DEFAULT_PROTOCOL,
  type TavernSettings, type TavernProfile,
} from '../lib/tavern/settings'
import { displayProtocol } from '../lib/tavern/protocol'

/** 输入框外观（不含字号——字号由 AutoTextarea 的 textClass / input 自己带，避免两处各写一个 size 类打架） */
const BOX = 'bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50'
const NUM = `${BOX} w-full`

/**
 * 段内数值组。
 *
 * ⚠️ **只用 2 列，不再有 3 列**：每个数值项下面都挂一张「取值范围 + 分段影响」表（见 RangeGuide），
 * 3 列时每格只有约 226px，长一点的说明会被挤成七八行，反而看不清。2 列约 345px 才读得顺。
 */
const GRID2 = 'grid grid-cols-1 gap-4 sm:grid-cols-2'

/**
 * 「是否展开每个数值项下面的分段说明」。
 * 24 个数值项全摊开会把页面拉到 3000px 以上，所以页头给了一个总开关（默认展开 —— 说明本来就该先看到）。
 * 用 context 而不是逐项传 prop：开关是**全局的**，24 处各传一遍只会多出 24 个噪音。
 */
const ShowBands = createContext(true)
/** 两列之间的间距（= 外层 grid 的 gap-4），算协议窗高度时要扣掉 */
const COL_GAP = 16
/** 协议窗的最低高度：低于它就没法读了（窄窗口下宁可让左列略高一点） */
const PROTO_MIN_HEIGHT = 240

/**
 * 客观描写档位（自由对话）。
 * 每一档都是**真值**，所以不传 emptyLabel（否则会多出一个空选项）。
 */
const SCENE_DESC_OPTIONS = [
  { id: 'off', label: '关闭 —— 只写对白与动作' },
  { id: 'light', label: '轻 —— 出场与转场时补一句' },
  { id: 'standard', label: '标准（推荐）—— 出场 / 环境 / 情绪都落到具体细节' },
  { id: 'rich', label: '丰富 —— 每回合都带一句环境或身体细节' },
]

/** 展示用的示例正则（收成常量 —— 反斜杠在 JSX 属性里转义最容易出错，只写一处） */
const RULE_EXAMPLE = '\*([^*\n]+)\*'

/** 剧情推演：设定层从哪来（A 档） */
const CONTEXT_SOURCE_OPTIONS = [
  { id: 'both', label: '项目资料 + 背景设定（默认）' },
  { id: 'digest', label: '只用背景设定 —— 省字数，长篇推荐' },
  { id: 'raw', label: '只用项目资料 —— 不注入背景设定' },
]

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
function Field({ label, hint, footer, children }: {
  label: React.ReactNode; hint?: string; footer?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-200 leading-5">{label}</div>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-[10.5px] text-ink-500 leading-relaxed">{hint}</p>}
      {footer}
    </div>
  )
}

/**
 * 数值项的「取值范围 + 分段影响」表，**高亮当前值落在的那一段**。
 *
 * 【为什么要有它】以前每个框旁边只有一句「通常 1.05」—— 用户知道了默认值，却不知道**这一段意味着什么**，
 * 想按自己的需求微调时无从下手。这里把区间摊开分段，写清每一段对模型输入输出的影响。
 *
 * 【为什么数字也在这张表里出】范围与文案收在 `paramGuide.ts`，min/max/step 也由它给 ——
 * 说明与输入框范围若各写一份，日子久了就会对不上，而**说明写错比没写更坏**（测试锁了分段完整性）。
 */
function RangeGuide({ guide, value }: { guide: ParamGuide; value: number }) {
  const show = useContext(ShowBands)
  if (!show) return null
  const cur = bandOf(guide, value)
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-ink-800 bg-ink-900/40">
      <div className="border-b border-ink-800 px-2 py-1 text-[10px] text-ink-600">
        取值范围 {guide.min} ~ {guide.max}{guide.unit ? `（${guide.unit}）` : ''} · 步进 {guide.step}
      </div>
      <ul>
        {guide.bands.map(b => {
          const on = b.from === cur.from && b.to === cur.to
          return (
            <li
              key={`${b.from}-${b.to}`}
              className={`border-t border-ink-800/60 px-2 py-1.5 text-[10.5px] leading-relaxed first:border-t-0 ${
                on ? 'bg-amber/10' : ''
              }`}
            >
              <span className={`tabular-nums ${on ? 'text-amber' : 'text-ink-500'}`}>
                {b.from === b.to ? b.from : `${b.from} ~ ${b.to}`}
              </span>
              <span className={`ml-1.5 ${on ? 'text-amber' : 'text-ink-300'}`}>{b.name}</span>
              {b.recommended && <span className="ml-1 text-[9.5px] text-ink-600">默认</span>}
              <span className={`ml-1.5 ${on ? 'text-ink-200' : 'text-ink-500'}`}>{b.effect}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 数值输入：本地留着正在输入的字，避免「打成 0.」时被立刻纠正。
 *
 * `guide` 同时给出 min / max / step / 单位与分段说明 —— **上界下界与说明同源**，
 * 不会出现「表里说 0~2、输入框只让填到 1」这种自相矛盾（见 paramGuide.ts 顶部注释）。
 */
function NumField({ label, hint, guide, value, onCommit }: {
  label: string; hint?: string; guide: ParamGuide
  value: number; onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const band = bandOf(guide, value)
  return (
    <Field
      label={
        <span className="flex items-baseline justify-between gap-2">
          <span>{guide.unit ? `${label}（${guide.unit}）` : label}</span>
          <span className="shrink-0 tabular-nums text-[10px] text-ink-600">{guide.min} ~ {guide.max}</span>
        </span>
      }
      hint={hint}
      footer={<RangeGuide guide={guide} value={value} />}
    >
      <input
        type="number" min={guide.min} max={guide.max} step={guide.step} value={draft} className={NUM}
        onChange={e => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n)) {
            onCommit(Math.min(guide.max, Math.max(guide.min, n)))
          }
        }}
        onBlur={() => setDraft(String(value))}
      />
      {/* 这一行**常驻**（表格收起时它是唯一线索）：当前值 → 落在哪一段、那一段的范围 */}
      <div className="mt-1 text-[10px] text-ink-600">
        当前 {value} → <span className="text-amber">{band.name}</span>
        <span className="tabular-nums">（{band.from === band.to ? band.from : `${band.from} ~ ${band.to}`}）</span>
      </div>
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

/** 下拉选择。`emptyLabel` 不传就不渲染那个空选项（用于「每一档都是真值」的档位选择） */
function SelectField({ label, hint, footer, value, options, emptyLabel, onChange }: {
  label: string; hint?: string; footer?: React.ReactNode; value: string
  options: { id: string; label: string }[]; emptyLabel?: string
  onChange: (v: string) => void
}) {
  return (
    <Field label={label} hint={hint} footer={footer}>
      <select value={value} className={`${NUM} w-full`} onChange={e => onChange(e.target.value)}>
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
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
      <Button
        variant="toggle" size="md" selected={value}
        className="w-full" onClick={() => onChange(!value)}
      >
        {value ? '已关闭（推荐）' : '未关闭 —— 模型会先想再答'}
      </Button>
    </Field>
  )
}

export default function TavernControl() {
  const [s, setS] = useState<TavernSettings | null>(null)
  /** 是否展开所有数值项的分段说明（默认展开） */
  const [showBands, setShowBands] = useState(true)
  const [providers, setProviders] = useState<AIProvider[]>([])
  /** B3：输出后处理规则的「试一段」输入（只用于预览，不进设置） */
  const [ruleTry, setRuleTry] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [protocolEditing, setProtocolEditing] = useState(false)
  /** 预设方案（A4）：整套设置（含协议全文）的命名快照，全局存放 */
  const [presetList, setPresetList] = useState<TavernPreset[]>([])
  const [presetNaming, setPresetNaming] = useState(false)
  const presetFileRef = useRef<HTMLInputElement>(null)

  /**
   * 协议窗高度同步。
   *
   * 【为什么必须用 JS 量，而不是纯 CSS】
   * 协议正文是个「可滚动块」，它的**内容高度**会参与外层网格 auto 行的尺寸计算：
   * 一旦正文比右列还高，行高就被左列撑大 → 左列反而比右列长。
   *
   * 【⚠️ 必须量「右列内容高」，不能量右列元素高】
   * 网格默认 `align-items: stretch`：右列元素会被**撑到行高**，而行高又受左列影响 ——
   * 一旦拿它的 `getBoundingClientRect().height` 去算，就会形成正反馈：
   * 量到的是被撑大的高度 → 协议窗跟着变大 → 行更高 → 永远差一截，且**稳定不自愈**。
   * 所以这里用「右列两个 section 各自的高度 + 它们之间的间距」，与行高无关。
   * （这个坑是 2026-09-14 老大反馈「左边还是比右边长一大截」时揪出来的。）
   */
  const leftColRef = useRef<HTMLDivElement>(null)
  const rightColRef = useRef<HTMLDivElement>(null)
  const [protoH, setProtoH] = useState<number | null>(null)
  const layoutReady = s !== null

  useEffect(() => {
    if (!layoutReady) return
    const leftCol = leftColRef.current
    const rightCol = rightColRef.current
    if (!leftCol || !rightCol) return

    // 只在两列布局下同步（与 Tailwind 的 xl 断点一致）；单列时让它自然高
    const mq = window.matchMedia('(min-width: 1280px)')
    const sync = () => {
      if (!mq.matches) { setProtoH(null); return }
      // 协议段是左列**最后一个**子项；它上面那些（通用设置 / 我的档案 …）都要先让出位置。
      // ⚠️ 别把「左列第一段」写死 —— 用切片就天然适应以后再加段。
      const above = [...leftCol.children].slice(0, -1) as HTMLElement[]
      const kids = [...rightCol.children] as HTMLElement[]
      // 🔴 必须用 offsetHeight（CSS 像素），**不能用 getBoundingClientRect()**：
      //    <html> 上有界面缩放（zoom: 1.08），rect 返回的是缩放后的**视觉像素**，
      //    而 style.height 收的是 CSS 像素 —— 混用会让算出来的高度恒定偏大 8%
      //    （表现就是"设了定高却总是差一截"，且怎么调都调不平）。
      const rightH = kids.reduce((n, el) => n + el.offsetHeight, 0)
        + COL_GAP * Math.max(0, kids.length - 1)
      // 左列「上面那些」占的高度 = 各自高度 + 每一个后面跟的间距（含它与协议段之间那一份）
      const usedH = above.reduce((n, el) => n + el.offsetHeight, 0) + COL_GAP * above.length
      if (!rightH || !usedH) { setProtoH(null); return }
      setProtoH(Math.max(PROTO_MIN_HEIGHT, Math.round(rightH - usedH)))
    }
    const ro = new ResizeObserver(sync)
    // 观察「右列每个 section」与「左列协议段以上的每个 section」——
    // 它们的盒子高与行高无关；观察列容器本身会形成正反馈（见上面注释）
    for (const el of [...rightCol.children]) ro.observe(el)
    for (const el of [...leftCol.children].slice(0, -1)) ro.observe(el)
    mq.addEventListener('change', sync)
    sync()
    return () => { ro.disconnect(); mq.removeEventListener('change', sync) }
  }, [layoutReady])

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

  // ---------- 预设方案（A4）：整套设置（含协议）的命名快照 ----------
  useEffect(() => {
    void presets.listPresets().then(setPresetList).catch(() => setPresetList([]))
  }, [])

  const storePresetAs = async (name: string) => {
    if (!s) return
    const n = name.trim()
    if (!n) return
    const exist = presetList.find(p => p.name === n)
    if (exist) {
      const okGo = await confirmDialog({
        title: '已有同名预设',
        message: '「' + n + '」已存在，要用当前设置覆盖它吗？',
        confirmText: '覆盖',
        danger: true,
      })
      if (!okGo) return
    }
    try {
      setPresetList(await presets.savePreset({ id: exist?.id, name: n, data: s }))
      showToast(exist ? '已覆盖预设「' + n + '」' : '已存为预设「' + n + '」')
    } catch (e) {
      showToast('保存预设失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const applyPreset = async (p: TavernPreset) => {
    const okGo = await confirmDialog({
      title: '应用预设「' + p.name + '」？',
      message: [
        '当前所有设置（通用 / 我的档案 / 预设方案 / 输出后处理 / 协议 / 剧情推演 / 自由对话 / 本场数值）都会被这套预设替换 ——',
        '包括协议全文。未保存的改动会丢失。',
      ].join('\n'),
      confirmText: '应用',
    })
    if (!okGo) return
    try {
      // 一律走 saveTavernSettings：它内部与默认值深合并，老预设缺的新字段会自动补上
      const merged = await saveTavernSettings(p.data)
      setS(merged)
      setDirty(false)
      showToast('已应用预设，下一轮对话即生效')
    } catch (e) {
      showToast('应用失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const overwritePreset = async (p: TavernPreset) => {
    if (!s) return
    const okGo = await confirmDialog({
      title: '用当前设置覆盖「' + p.name + '」？',
      message: '这份预设里原来的参数与协议会被替换掉，预设本身保留。',
      confirmText: '覆盖',
      danger: true,
    })
    if (!okGo) return
    try {
      setPresetList(await presets.savePreset({ id: p.id, name: p.name, data: s }))
      showToast('已覆盖')
    } catch (e) {
      showToast('覆盖失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const dropPreset = async (p: TavernPreset) => {
    const okGo = await confirmDialog({
      title: '删除预设「' + p.name + '」？',
      message: '只删掉这份快照，当前正在用的设置不受影响。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    try {
      setPresetList(await presets.deletePreset(p.id))
      showToast('已删除预设')
    } catch (e) {
      showToast('删除失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const exportPreset = (p: TavernPreset) => {
    try {
      const blob = new Blob([presets.presetFileText(p)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = presets.presetFileName(p.name)
      a.click()
      URL.revokeObjectURL(url)
      showToast('已导出预设文件')
    } catch (e) {
      showToast('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const importPresetFile = async (file: File) => {
    try {
      const r = presets.parsePresetFile(await file.text())
      if (r.error || !r.preset) {
        showToast('导入失败：' + (r.error ?? '文件内容无法识别'), 'error')
        return
      }
      const p = r.preset
      const okGo = await confirmDialog({
        title: '导入预设「' + p.name + '」？',
        message: '导入会立刻把当前所有设置替换成这份文件里的内容（含协议），并把它存进预设列表。',
        confirmText: '导入并应用',
      })
      if (!okGo) return
      const merged = await saveTavernSettings(p.data)
      setS(merged)
      setDirty(false)
      setPresetList(await presets.savePreset({ name: p.name, data: p.data }))
      showToast('已导入并应用预设')
    } catch (e) {
      showToast('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const edit = (fn: (prev: TavernSettings) => TavernSettings) => {
    setS(prev => (prev ? fn(prev) : prev))
    setDirty(true)
  }
  const setCommon = (k: keyof TavernSettings['common'], v: number | string | boolean) =>
    edit(prev => ({ ...prev, common: { ...prev.common, [k]: v } as TavernSettings['common'] }))
  /** 「我的档案」三栏都是文本 */
  const setProfile = (k: keyof TavernProfile, v: string) =>
    edit(prev => ({ ...prev, profile: { ...prev.profile, [k]: v } }))
  const setPlot = (k: keyof TavernSettings['plot'], v: number | string) =>
    edit(prev => ({ ...prev, plot: { ...prev.plot, [k]: v } as TavernSettings['plot'] }))
  const setFree = (k: keyof TavernSettings['free'], v: number | string) =>
    edit(prev => ({ ...prev, free: { ...prev.free, [k]: v } as TavernSettings['free'] }))
  /** 本场数值（C2 第二步）：开关 / 逐项关闭 / 频率 / 幅度 */
  const setVars = (patch: Partial<TavernSettings['vars']>) =>
    edit(prev => ({ ...prev, vars: { ...prev.vars, ...patch } }))
  const toggleVarKey = (k: VarKey) =>
    edit(prev => {
      const off = prev.vars.off ?? []
      return { ...prev, vars: { ...prev.vars, off: off.includes(k) ? off.filter(x => x !== k) : [...off, k] } }
    })

  // ---------- 输出后处理（B3）：规则是数组，所以不能用上面那套 [k]: v ----------
  const setPostFlag = (patch: Partial<Pick<TavernSettings, 'postRulesEnabled' | 'postRuleNotice'>>) =>
    edit(prev => ({ ...prev, ...patch }))
  const setRule = (i: number, patch: Partial<PostRule>) =>
    edit(prev => ({ ...prev, postRules: prev.postRules.map((r, k) => (k === i ? { ...r, ...patch } : r)) }))
  const addRule = () =>
    edit(prev => ({
      ...prev,
      postRules: [...prev.postRules, {
        id: `pr-${Date.now()}`, name: '新规则', pattern: '', replacement: '', flags: 'gm', enabled: true,
      }],
    }))
  const dropRule = (i: number) =>
    edit(prev => ({ ...prev, postRules: prev.postRules.filter((_, k) => k !== i) }))
  const resetRules = () =>
    edit(prev => ({ ...prev, postRules: DEFAULT_POST_RULES.map(r => ({ ...r })) }))

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
      message: [
        '八段设置（通用设置 / 我的档案 / 预设方案 / 输出后处理 / 扮演协议 / 剧情推演 / 自由对话 / 本场数值）里的所有参数与提示词，都会回到内置默认值。',
        '联网检索不在其中 —— 它已搬到「灵感工具 → 灵感启发」，属于全局设置，恢复出厂不会动它。',
        '已存的预设方案不受影响 —— 那是独立的快照，要用它随时点「应用」即可。',
        '保存后不可撤销。',
      ].join('\n'),
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
        '⚠️ 协议是剧情推演与自由对话共用的格式契约，改坏了两种模式的输出格式会一起乱。',
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

  // 后处理规则预览：**必须放在早退之前** —— hook 不能条件调用（eslint rules-of-hooks 会直接报错）。
  // `s` 就是依赖项之一，加载完成后自然重算。
  const rulePreview = useMemo(
    () => (s ? previewPostRules(ruleTry, s.postRules) : { text: '', applied: [] as { name: string; count: number }[], errors: [] as string[] }),
    [ruleTry, s],
  )

  if (!s) return <LoadingState />

  const c = s.common
  const pr = s.profile
  const pl = s.plot
  const fr = s.free
  const modelOptions = providers.map(p => ({ id: p.id, label: `${p.name} · ${p.model}` }))

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[16px] text-ink-100">控制面板</h1>

          <HelpPopover title="控制面板怎么用" width="24rem" size={14}>
  酒馆模式全部「接进 AI 的参数与提示词」都在这里。改完点右上「保存」，下一轮对话开始时生效。

  • 左列是「全局的、一次调好就不动的」：跟谁说、我是谁、素材从哪来、整套怎么存，以及两种模式共用的格式契约。
  • 右列是「分模式的手感与输出规则」：剧情推演 / 自由对话各自的采样参数与阈值、本场数值、输出后处理。
  • 每个数值都标了取值范围；「显示分段说明」打开后，还能看到「调大 / 调小分别会怎样」。
  • 「四、预设方案」可以把整套设置存成快照，一键切换或导出分享。
  • 默认值就是出厂值：不动它时行为与之前完全一致。
</HelpPopover>
          <p className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            酒馆模式全部「接进 AI 的参数与提示词」都在这里。改完点右上「保存」，下一轮对话开始时生效。
            <br />
            默认值就是内置的出厂值 —— 不动它时行为与之前完全一致。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && <span className="text-[11px] text-amber">有未保存的改动</span>}
          <Button
            variant="secondary" size="sm" onClick={() => setShowBands(v => !v)}
            title="每个数值项下面的「取值范围 + 分段影响」表。全部摊开页面会很长，可以一键收起（当前值的档位仍会显示）"
          >
            {showBands ? '收起分段说明' : '显示分段说明'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void reset()}>恢复默认</Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {/* ==================== 两列：左＝通用与契约；右＝分模式的手感 ====================
          网格默认 align-items:stretch → 两列等高；左列的协议窗高度由 JS 同步（见 PROTO 注释）。 */}
      <ShowBands.Provider value={showBands}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">

        {/* ========== 左列 ========== */}
        <div ref={leftColRef} className="space-y-4 xl:flex xl:min-h-0 xl:flex-col">

          {/* ---------- 一、通用设置 ---------- */}
          <div>
          <Section
            title="一、通用设置"
            desc="两种模式都生效。模型与上下文这些「跟谁说、说多长」的事在这里定；具体的采样手感与提示词在下面几段。"
          >
            <SelectField
              label="默认模型"
              hint="留空则跟随「灵感启发 → 模型配置」里选中的全局活动模型。两个模式都用它；会话里不再单独选择模型。"
              value={c.defaultProviderId}
              options={modelOptions}
              emptyLabel="（跟随全局活动模型）"
              onChange={v => setCommon('defaultProviderId', v)}
            />

            <div className={GRID2}>
              <NumField
                label="上下文预算" guide={PARAM_GUIDES.contextBudget}
                hint="一轮请求里「设定 + 记忆 + 对话历史」加起来的上限。超了先裁最早的对话轮次（开场永不被裁）。"
                value={c.contextBudget} onCommit={v => setCommon('contextBudget', v)}
              />
              <NumField
                label="固定开销预留" guide={PARAM_GUIDES.fixedOverheadChars}
                hint="给提示词骨架与协议留的位置。它不算进「可分配给对话历史」的额度里，调大它就等于压缩历史。"
                value={c.fixedOverheadChars} onCommit={v => setCommon('fixedOverheadChars', v)}
              />
              <NumField
                label="请求超时" guide={PARAM_GUIDES.timeoutSec}
                hint="超过这个时间就中断并报错。本地模型慢就调大；联网模型一般 60～180 够用。"
                value={c.timeoutSec} onCommit={v => setCommon('timeoutSec', v)}
              />
            </div>

            <div className={GRID2}>
              <NumField
                label="上下文窗口长度" guide={PARAM_GUIDES.numCtx}
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
          </div>

          {/* ---------- 二、我的档案（全局，跨项目） ---------- */}
          <div>
          <Section
            title="二、我的档案"
            desc="你本人是谁 —— 全局设置，跨项目、跨会话生效，每轮都进 system。自由对话里 AI 靠它知道屏幕后面是谁（称呼、亲疏、语气都照它来）；剧情推演不用它 —— 那边你在每场推演里已经选定了自己演的角色，AI 以角色卡为准。三栏全留空 = 整段不注入，行为与以前完全一样。"
          >
            <div className="mb-1">
              <AvatarPicker
                src={pr.avatar}
                name={pr.name || '我'}
                size={64}
                onChange={v => setProfile('avatar', v)}
                hint="只影响界面：自由对话里 AI 那侧是角色头像，你这一侧就是你 —— 留空用名字首字。"
              />
            </div>
            <div className={GRID2}>
              <TextField
                label="你的名字"
                hint="AI 会按这个名字想到你。"
                minRows={1}
                placeholder="例：老巴迪"
                value={pr.name}
                onChange={v => setProfile('name', v)}
              />
              <TextField
                label="希望被怎么称呼"
                hint="留空就直呼名字。想让 AI 用某个叫法（外号、称呼）就写在这里。"
                minRows={1}
                placeholder="例：巴迪哥"
                value={pr.address}
                onChange={v => setProfile('address', v)}
              />
            </div>
            <TextField
              label="一句话自我设定"
              hint="身份、年纪、与对方的关系……越短越有效（这段每轮都进上下文，写长了会挤占对话历史）。例：三十出头的编剧，跟洛汐是同事，嘴硬心软。"
              minRows={3}
              placeholder="例：三十出头的编剧，跟洛汐是同事，嘴硬心软。"
              value={pr.persona}
              onChange={v => setProfile('persona', v)}
            />
          </Section>
          </div>

          {/* ---------- 三、预设方案（A4） ---------- */}
          <Section
            title="三、预设方案"
            desc="把整套设置存成命名快照，一键切换。预设包含协议全文，所以换预设等于把参数与格式契约一起换掉 —— 只换一半的话，格式规则还是上一套的。"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="md" onClick={() => setPresetNaming(true)}>＋ 存为预设</Button>
              <Button variant="secondary" size="md" onClick={() => presetFileRef.current?.click()}>从文件导入</Button>
              <input
                ref={presetFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) void importPresetFile(f)
                  e.target.value = '' // 允许连续导入同一个文件
                }}
              />
            </div>
            <p className="text-[11px] text-ink-500 leading-relaxed">
              建议按工作模式分：例如「快速脑暴」（温度高、篇幅短、脑洞优先）与「精修成稿」（温度低、
              篇幅长、一致性优先）。应用预设会整体替换当前设置，未保存的改动会被覆盖。
            </p>

            {presetList.length === 0 ? (
              <p className="text-[11.5px] text-ink-600 leading-relaxed">
                还没有预设。把当前这套存一个，以后切回来只要点一下 —— 也能导出去分享给别人。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {presetList.map(p => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] text-ink-100">{p.name}</div>
                      <div className="text-[10.5px] text-ink-500">
                        {new Date(p.updatedAt).toLocaleString()}
                        {' · 叙事温度 '}{p.data.plot.temperature}{' · 聊天温度 '}{p.data.free.temperature}
                      </div>
                    </div>
                    <Button
                      variant="primary" size="xs" className="shrink-0"
                      onClick={() => void applyPreset(p)}
                      title="把当前设置整体换成这套预设（含协议）"
                    >应用</Button>
                    <Button
                      variant="secondary" size="xs" className="shrink-0"
                      onClick={() => void overwritePreset(p)}
                      title="用当前设置覆盖这份预设"
                    >覆盖</Button>
                    <Button
                      variant="secondary" size="xs" className="shrink-0"
                      onClick={() => exportPreset(p)}
                      title="导出成文件，可备份或分享"
                    >导出</Button>
                    <Button
                      variant="danger" size="xs" className="shrink-0"
                      onClick={() => void dropPreset(p)}
                      title="只删这份快照，当前设置不受影响"
                    >删除</Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ---------- 四、输出后处理（B3） ---------- */}
          <Section
            title="四、输出后处理"
            desc="生成后按下面的规则从上到下修一遍再落库。协议已经把格式写死了，实测却总有模型不听话 —— 用规则兜住，比重跑一次去赌划算。顺序有意义：先去 markdown 再处理单星号动作，否则「动作」会被拆成 *（动作）*。"
          >
            <ToggleField
              label="启用输出后处理"
              hint="关掉就完全不跑规则（排查格式问题时用这一档，先排除规则本身的影响）。"
              value={s.postRulesEnabled}
              onChange={v => setPostFlag({ postRulesEnabled: v })}
            />
            <ToggleField
              label="命中时在对话页提示"
              hint="关掉 = 静默修正：规则照跑，只是不在输入框上方告诉你改了哪几条。正则写错仍会提示 —— 那是配置问题，不该被静默。"
              value={s.postRuleNotice}
              onChange={v => setPostFlag({ postRuleNotice: v })}
            />

            <div className="space-y-2">
              {s.postRules.map((r, i) => (
                <div key={r.id} className="rounded-md border border-ink-800 bg-ink-900/40 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox" className="shrink-0 accent-amber" checked={r.enabled}
                      onChange={e => setRule(i, { enabled: e.target.checked })}
                      title="关掉这一条（其余规则照跑）"
                    />
                    <span className="shrink-0 text-[10.5px] text-ink-600">{i + 1}</span>
                    <input
                      value={r.name} onChange={e => setRule(i, { name: e.target.value })}
                      className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11.5px] text-ink-100 outline-none focus:border-amber/50"
                      placeholder="规则名（对话页提示里显示的就是它）"
                    />
                    <Button variant="danger" size="xs" className="shrink-0" onClick={() => dropRule(i)}>
                      删除
                    </Button>
                  </div>
                  <input
                    value={r.pattern} onChange={e => setRule(i, { pattern: e.target.value })}
                    className="mt-1.5 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 font-mono text-[11px] text-ink-200 outline-none focus:border-amber/50"
                    placeholder={`正则源码，例：${RULE_EXAMPLE}`}
                  />
                  <input
                    value={r.replacement} onChange={e => setRule(i, { replacement: e.target.value })}
                    className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 font-mono text-[11px] text-ink-200 outline-none focus:border-amber/50"
                    placeholder="替换成（$1 = 第一个捕获组；留空 = 直接删掉）"
                  />
                  {r.note && (
                    <p className={`mt-1 text-[10px] leading-relaxed ${r.enabled ? 'text-ink-600' : 'text-amber/80'}`}>
                      {r.note}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={addRule}>＋ 新增规则</Button>
              <Button variant="secondary" size="sm" onClick={resetRules}>恢复出厂四条</Button>
              <span className="text-[10.5px] text-ink-500">
                共 {s.postRules.length} 条 · 启用 {s.postRules.filter(r => r.enabled).length} 条
              </span>
            </div>
            <p className="text-[10.5px] text-ink-600 leading-relaxed">
              正则写法提示：$1 / $2 是捕获组（例：星号动作那条的正则是 {RULE_EXAMPLE}）；
              flags 固定 gm（m 让 ^ 匹配每一行，行首说话人标签那条要用）。
            </p>

            {/* 试一段：正则最容易写错，给个立刻能看到结果的入口（比「改完去聊一句看效果」省事） */}
            <div>
              <div className="text-[11.5px] text-ink-200">试一段</div>
              <AutoTextarea
                className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-[11.5px] font-mono"
                minRows={2}
                maxHeight={140}
                placeholder="贴一段模型输出，例：（她点头。） / （他把烟按灭） / 洛汐：你来了。"
                value={ruleTry}
                onChange={setRuleTry}
              />
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-[11px] leading-relaxed text-ink-300">{rulePreview.text || '（上面输入内容就能看到结果）'}</pre>
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink-500">
                {rulePreview.errors.length > 0
                  ? <span className="text-amber">⚠️ 正则无效、已跳过：{rulePreview.errors.join('、')}</span>
                  : rulePreview.applied.length > 0
                    ? `命中：${rulePreview.applied.map(a => `${a.name} ×${a.count}`).join('、')}`
                    : '没命中任何规则（上面的输入已符合协议，或规则没写对）'}
              </p>
            </div>
          </Section>
          {/* ---------- 五、扮演协议（高度同步到与右列底部平齐；正文超出走内部滚动条） ----------
              🔴 两条都是踩出来的，别删：
              ① **不能写 `xl:flex-1`** —— 主轴是高度，flex-basis 会压过下面那个 inline `height`，
                 包装层被"填充剩余空间"接管，设多少高度都无效；
              ② **必须带 `xl:overflow-hidden`** —— flex item 的 `min-height: auto` 等于**内容高度**，
                 正文一长就把 1452px 的定高顶回 1568px（规范里唯一的例外就是 overflow≠visible）。
                 同理，里面那个 Section 也要 overflow-hidden，否则它自己又被内容顶高、底部边框被裁掉。 */}
          <div
            className="xl:min-h-0 xl:shrink-0 xl:flex xl:flex-col xl:overflow-hidden"
            style={protoH === null ? undefined : { height: protoH }}
          >
          <Section
            title="五、扮演协议"
            desc={`两种模式共用的格式契约，内置版本 ${PROTOCOL_VERSION}。注入时钉在提示词的最末尾（它自带的「最后提醒」要紧贴生成点）。`}
            className="xl:h-full xl:min-h-0 xl:flex xl:flex-col xl:overflow-hidden"
            bodyClassName="xl:min-h-0 xl:flex-1 xl:flex xl:flex-col xl:overflow-hidden"
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
                    <Button variant="secondary" size="sm" onClick={() => void startEditProtocol()}>编辑协议</Button>
                  </div>
                </div>
                <pre className="max-h-80 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-800 bg-ink-900/60 p-3 text-[11.5px] leading-relaxed text-ink-300 xl:max-h-none xl:min-h-[12rem]">
                  {displayProtocol(s.protocol)}
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
                  <Button variant="secondary" size="sm" onClick={() => setProtocolEditing(false)}>收起编辑</Button>
                </div>
              </>
            )}
          </Section>
          </div>
        </div>

        {/* ========== 右列（它的高度是协议窗高度的基准） ========== */}
        <div ref={rightColRef} className="space-y-4">

          {/* ---------- 六、剧情推演控制 ---------- */}
          <Section
            title="六、剧情推演控制"
            desc="只对「剧情推演」生效。叙事向要的是稳 —— 角色反应得站得住，所以默认温度比自由对话低。"
          >
            <div className={GRID2}>
              <NumField
                label="温度" guide={GUIDE_SAMPLING.temperature}
                hint="叙事推演要稳 —— 角色反应得站得住，所以默认比自由对话低（0.85）。"
                value={pl.temperature} onCommit={v => setPlot('temperature', v)}
              />
              <NumField
                label="核采样阈值" guide={GUIDE_SAMPLING.topP}
                hint="每一步只从「累积概率达到这个值」的候选词里挑。越低候选面越窄。"
                value={pl.topP} onCommit={v => setPlot('topP', v)}
              />
              <NumField
                label="候选词上限" guide={GUIDE_SAMPLING.topK}
                hint="每一步只在概率最高的这么多个词里挑，填 0 表示不限制。"
                value={pl.topK} onCommit={v => setPlot('topK', v)}
              />
              <NumField
                label="重复惩罚" guide={GUIDE_SAMPLING.repeatPenalty}
                hint="高于 1 会压制重复用词；太高会让句子发硬、用词别扭。"
                value={pl.repeatPenalty} onCommit={v => setPlot('repeatPenalty', v)}
              />
              <NumField
                label="新话题倾向" guide={GUIDE_SAMPLING.presencePenalty}
                hint="正数鼓励引入新内容，负数让它更愿意围着当前话题说。推演要线索连贯，所以默认偏保守（0.4）。"
                value={pl.presencePenalty} onCommit={v => setPlot('presencePenalty', v)}
              />
              <NumField
                label="设定层占比" guide={PARAM_GUIDES.plotSettingRatio}
                hint="上下文预算里分给「项目设定」的比例，剩下的留给长期记忆与对话历史。"
                value={Math.round(pl.settingRatio * 100)} onCommit={v => setPlot('settingRatio', v / 100)}
              />
            </div>

            <SelectField
              label="设定来源"
              hint="决定「世界与角色设定」这一层从哪来 —— 它每轮都进 system，是预算里最大的一块。"
              footer={(
                <div className="mt-1.5 space-y-1 text-[10.5px] text-ink-600 leading-relaxed">
                  <p>· 两者（默认）：项目原始资料 + 你提炼的背景设定。资料最全，但项目原始资料本身就有四千六百字以上（示范项目实测还会丢 11 段），加上协议 3244 字 —— 16000 的预算里一半以上被 system 吃掉。</p>
                  <p>· 只用背景设定：设定层只留「作品概览 + 章节清单」（约 2200 字），世界规则靠你提炼的那份，省下的全给对话历史。代价是没在场配角的卡、名词 / 地理 / 历史细节不再注入 —— 所以背景设定里建议把「主要人物关系」写成一节，并让关键词留空（始终注入）。</p>
                  <p>· 只用项目资料：不注入背景设定那一层。</p>
                </div>
              )}
              value={pl.contextSource}
              options={CONTEXT_SOURCE_OPTIONS}
              onChange={v => setPlot('contextSource', v)}
            />

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

          {/* ---------- 七、自由对话控制 ---------- */}
          <Section
            title="七、自由对话控制"
            desc="只对「自由对话」生效。陪伴要松弛感，所以温度默认更高；下面还有记忆引擎与日常推进的一组阈值。"
          >
            <div className={GRID2}>
              <NumField
                label="温度" guide={GUIDE_SAMPLING.temperature}
                hint="陪伴要松弛感，默认 0.9 —— 比剧情推演更放得开。"
                value={fr.temperature} onCommit={v => setFree('temperature', v)}
              />
              <NumField
                label="核采样阈值" guide={GUIDE_SAMPLING.topP}
                hint="每一步只从「累积概率达到这个值」的候选词里挑。越低候选面越窄。"
                value={fr.topP} onCommit={v => setFree('topP', v)}
              />
              <NumField
                label="候选词上限" guide={GUIDE_SAMPLING.topK}
                hint="每一步只在概率最高的这么多个词里挑，填 0 表示不限制。"
                value={fr.topK} onCommit={v => setFree('topK', v)}
              />
              <NumField
                label="重复惩罚" guide={GUIDE_SAMPLING.repeatPenalty}
                hint="角色的口头禅多，所以这一项比剧情模式更值得调。"
                value={fr.repeatPenalty} onCommit={v => setFree('repeatPenalty', v)}
              />
              <NumField
                label="新话题倾向" guide={GUIDE_SAMPLING.presencePenalty}
                hint="正数鼓励引入新内容 —— 日常聊天靠它才有「日子在往前走」的感觉。默认 0.45。"
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


            <SelectField
              label="客观描写"
              hint="只写对白与动作，画面是空的 —— 这一项决定要不要写「Ta 穿什么、屋里什么光、外面什么天气」。写法固定：用【】包住、独立成行。标准档：出场交代穿着与姿态、转场补一句环境、情绪用外在细节表示（都只写观察得到的东西，不写任何人的心理 —— 那是代写）。描写算在协议那 60–160 字里，别指望它长篇铺陈。"
              value={fr.sceneDescription}
              options={SCENE_DESC_OPTIONS}
              onChange={v => setFree('sceneDescription', v)}
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
              placeholder="例：不要替作者的角色做决定；Ta不确定的事就写不确定。"
              value={fr.extraPrompt}
              onChange={v => setFree('extraPrompt', v)}
            />

            <div className="pt-1">
              <div className="mb-3 text-[12px] text-ink-200 border-t border-ink-800 pt-3">记忆引擎</div>
              <div className={GRID2}>
                <NumField
                  label="触发整理" guide={PARAM_GUIDES.triggerMessages}
                  hint="没整理过的新消息攒到这么多条，就自动整理一次记忆。"
                  value={fr.triggerMessages} onCommit={v => setFree('triggerMessages', v)}
                />
                <NumField
                  label="记忆软上限" guide={PARAM_GUIDES.softLimit}
                  hint="超过只在界面上提醒，不会硬截断。"
                  value={fr.softLimit} onCommit={v => setFree('softLimit', v)}
                />
                <NumField
                  label="记忆硬上限" guide={PARAM_GUIDES.hardLimit}
                  hint="超过就按「长期摘要 → 纪念日 → 关系状态」的顺序压缩；关键事实与未爆的雷不动。"
                  value={fr.hardLimit} onCommit={v => setFree('hardLimit', v)}
                />
                <NumField
                  label="长期摘要上限" guide={PARAM_GUIDES.longTermLimit}
                  hint="「长期摘要」这一栏单独的字数上限，也是最优先被压缩的一栏。"
                  value={fr.longTermLimit} onCommit={v => setFree('longTermLimit', v)}
                />
                <NumField
                  label="日记保留" guide={PARAM_GUIDES.diaryKeep}
                  hint="「最近日记」保留几条，新的在上、旧的自动滚动掉。"
                  value={fr.diaryDays} onCommit={v => setFree('diaryDays', v)}
                />
                <NumField
                  label="自动整理最小间隔" guide={PARAM_GUIDES.summaryInterval}
                  hint="两次自动整理之间至少隔这么久，避免刚聊两句就反复压缩。手动点「立即整理」不受它限制。"
                  value={fr.summaryMinIntervalMin} onCommit={v => setFree('summaryMinIntervalMin', v)}
                />
                <NumField
                  label="整理锁有效期" guide={PARAM_GUIDES.summaryLock}
                  hint="防止两个窗口同时整理记忆。上次整理跑到一半崩了，超过这个时间就可以被接管。"
                  value={fr.summaryLockTtlMin} onCommit={v => setFree('summaryLockTtlMin', v)}
                />
              </div>
            </div>

            <div className="pt-1">
              <div className="mb-3 text-[12px] text-ink-200 border-t border-ink-800 pt-3">日常推进</div>
              <div className={GRID2}>
                <NumField
                  label="推进间隔" guide={PARAM_GUIDES.dailyAdvance}
                  hint="距上次活跃超过这么久，才补写一段「这几天的生活」。没有常驻进程，只能靠打开界面时推进。"
                  value={fr.dailyAdvanceHours} onCommit={v => setFree('dailyAdvanceHours', v)}
                />
                <NumField
                  label="生活记录保留" guide={PARAM_GUIDES.dailyKeep}
                  hint="「这几天的生活」保留几条（一天一条），新的在上。"
                  value={fr.dailyLogKeep} onCommit={v => setFree('dailyLogKeep', v)}
                />
              </div>
            </div>
          </Section>
          {/* ---------- 八、本场数值（C2 第二步） ---------- */}
          <Section
            title="八、本场数值"
            desc="只对「自由对话」生效。让 AI 每隔几轮给一次数值变化（好感 / 信任 / 剧情进度 / 心情 / 当前地点），你也能随时手改。数值属于这一场，换一场戏重新算 —— 角色卡管「这个人是谁」，数值管「这一场走到哪了」。"
          >
            <ToggleField
              label="启用本场数值"
              hint="关掉 = 提示词里一个字都不出现（0 字成本），状态栏也不再显示数值。"
              value={s.vars.enabled}
              onChange={v => setVars({ enabled: v })}
            />

            <Field
              label={`启用哪几项（已启用 ${VAR_DEFS.filter(d => !(s.vars.off ?? []).includes(d.key)).length} / ${VAR_DEFS.length}）`}
              hint="点一下切换。关掉的项不会进提示词；「剧情进度」配合剧本的「这一场的目标」用最有意义。"
            >
              <div className="flex flex-wrap gap-2">
                {VAR_DEFS.map(d => {
                  const on = !(s.vars.off ?? []).includes(d.key)
                  return (
                    <Button
                      key={d.key} variant="toggle" size="sm"
                      selected={on} onClick={() => toggleVarKey(d.key)}
                    >
                      {on ? '✓ ' : ''}{d.label}
                      <span className="ml-1 text-[10px] text-ink-500">
                        {d.kind === 'num' ? `${d.min}–${d.max}` : `≤${d.maxLen} 字`}
                      </span>
                    </Button>
                  )
                })}
              </div>
            </Field>

            <NumField
              label="单次变化幅度" guide={PARAM_GUIDES.varMaxStep}
              hint="模型给出的增量超过这个值就按这个值取（它是刹车，不是目标值）。"
              value={s.vars.maxStep} onCommit={v => setVars({ maxStep: Math.max(1, Math.round(v)) })}
            />

            <p className="text-[10.5px] text-ink-600 leading-relaxed">
              数值**不靠模型每轮记账**：整理记忆时（自动触发或点「立即整理记忆」）会单开一次小调用，
              把这几轮里真的变了的项算出来，写进角色状态。写进提示词的只有「当前值多少、一次能改多少」。
              算不出来时**一个字段都不动** —— 绝不会为了记账改错你要看的内容。
            </p>
          </Section>


        </div>
      </div>
      </ShowBands.Provider>

      <PromptModal
        open={presetNaming}
        title="存为预设"
        label="预设名"
        placeholder="例：快速脑暴 / 精修成稿 / 慢节奏日常"
        onSubmit={n => {
          // ⚠️ 必须在这里关弹窗：PromptModal 自己不关，全靠调用方 ——
          //    漏掉这一步的表现是「点了确定，弹窗不走、还把后面的点击全挡住」（实机抓到）
          setPresetNaming(false)
          void storePresetAs(n)
        }}
        onCancel={() => setPresetNaming(false)}
      />
    </div>
  )
}

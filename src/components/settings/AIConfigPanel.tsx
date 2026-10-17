/**
 * AI 模型配置（**全局**）—— 挂在「工作面板 → 模型设置」最上边，紧随其下是「联网检索」。
 *
 * 【为什么从弹窗改成页面上的独立面板】
 * 它原本是藏在「AI 辅助规划」卡片右上角一个「模型设置」按钮后面的弹窗，和对话窗口挤在同一张卡里。
 * 两件事其实完全不同：**配模型**是全局的一次性设置，**对话**是随手用的工具；挤在一起的结果是
 * 想改模型得先找到那个对话卡片、点开右上角的小按钮（老大 2026-09-15 要求拆分）。
 * 拆开之后：模型配置 + 联网检索这两件「配置」并肩放在页面最上边，下面才是真正干活的三个功能。
 *
 * 【为什么自包含、改完即存】
 * 它原先活在弹窗里，由父组件的 onClose 负责「关掉后刷新」。现在它是页面上的独立卡片，
 * 必须自己读写、自己落库 —— 保存即生效，没有「确定 / 取消」这一层。
 * 模型配置变动会影响全应用的 AI 就绪状态，所以每次落库后调一次 `onChange?.()`
 * 让上层通知「AI 辅助规划」重新读一遍活动模型（否则它手里还是旧的那份）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Cpu, Globe, Loader2, CheckCircle2, FlaskConical,
  Pencil, Trash2, Check,
} from 'lucide-react'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import EmbeddingIndexPanel from '@/components/settings/EmbeddingIndexPanel'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { syncTuningWithModel } from '@/lib/tavern/settings'
import { SELECT_PLACEHOLDER } from '@/lib/constants'
import { SAMPLING_FIELDS, isOllamaSamplingChannel } from '@/lib/ai/modelSampling'
import { filterModels } from '@/lib/ai/modelFilter'
import SamplingUnavailable from '@/components/common/SamplingUnavailable'
import CustomHeadersEditor from '@/components/settings/CustomHeadersEditor'
import { syncWriterBudgetToModel } from '@/lib/ai/aiWriterBudget'
import {
  type AIProvider, type AITestResult, type PlatformPreset,
  LOCAL_PRESETS, ONLINE_PRESETS, LOCAL_OPENAI_PRESETS, providerFromPreset, OPENCODE_GO_BASE,
  headersForPresetSwitch,
  listOllamaModels, listOpenAIModels, testProvider,
  loadProviders, saveProviders, loadActiveId, saveActiveId, typeLabel,
  TASK_ROLES, ROLE_LABEL, ROLE_HINT, DEFAULT_ROUTING, loadRouting, saveRouting, rolesOf,
  type TaskRole, type RoutingMap,
  loadAiTimeoutSec, saveAiTimeoutSec,
  AI_TIMEOUT_MIN_SEC, AI_TIMEOUT_MAX_SEC, AI_TIMEOUT_DEFAULT_SEC,
} from '@/lib/ai'
import { checkContextWindow } from '@/lib/ai/modelCapacity'
import NumberField from '@/components/common/NumberField'
import { TestResultBar, TestingBar, ContextWindowField, TemperatureField } from '@/components/settings/AIConfigFields'

/**
 * 编辑表单 / 列表区的统一宽度：页面很宽，铺满会显得松散难读。
 *
 * 🔴 2026-10-12 主人反馈「内容全挤在左边、右侧完全空白」：原先这里只给了 `max-w-3xl`，
 *    在宽屏下（实测 section 1289px）右侧留下 **440px 死区**。
 *    现改为**列表态两栏**：左栏放「模型列表 + 添加 + 语义检索」（需要宽度的内容），
 *    右栏放「AI 用途路由 + 请求超时」（定宽表单，本来就窄）。
 *    窄屏自动回落单栏（`xl:` 断点），高度随内容自适应（不写死高度 ⇒ 配 N 个模型时自然变高）。
 *
 *    编辑表单仍用 `max-w-3xl` 单栏 —— 表单是逐项纵向走查的，拉两栏反而打断视线。
 */
const BODY = 'max-w-3xl'

/** 列表态两栏：左「列表/添加」（自适应，minmax(0,1fr) 防长模型名撑破）｜右「路由/超时」（定宽 20rem） */
const LIST_GRID = 'grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_20rem] gap-x-6 gap-y-5 items-start'

export default function AIConfigPanel({ onChange }: { onChange?: () => void }) {
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<AIProvider | null>(null)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [openaiModels, setOpenaiModels] = useState<string[]>([])
  const [fetchingOpenAI, setFetchingOpenAI] = useState(false)
  /**
   * 模型清单的**筛选关键词**（2.9.2 · ①）。
   * 为什么需要：中转站的可用模型常有几百项，原生 select 的「键入前缀跳转」根本不够用。
   * 🔴 两处列表各一份 state —— 作者在端点与 Ollama 之间来回切时，互不干扰。
   */
  const [ollamaFilter, setOllamaFilter] = useState('')
  const [openaiFilter, setOpenaiFilter] = useState('')
  const [testing, setTesting] = useState(false)
  const [editResult, setEditResult] = useState<AITestResult | null>(null)
  const [saving, setSaving] = useState(false)
  /** 列表页：正在测试的模型 id（全局单测，避免多个大模型同时抢显存） */
  const [testingId, setTestingId] = useState<string | null>(null)
  /** 列表页：添加模型的平台选择态——none 显示两个大按钮；local/online 显示对应平台预设 */
  const [pickMode, setPickMode] = useState<'none' | 'local' | 'online'>('none')
  /** 列表页：各模型最近一次测试结果 */
  const [rowResults, setRowResults] = useState<Record<string, AITestResult>>({})
  /** AI 用途路由（2.8.0 · #014）：三格留空 = 全部跟随当前模型 */
  const [routing, setRouting] = useState<RoutingMap>({ ...DEFAULT_ROUTING })
  /** 「请求超时」（秒 · 2.9.0）：全局设置，与模型配置同层（超时是模型的属性，不随小说项目走） */
  const [timeoutSec, setTimeoutSec] = useState(AI_TIMEOUT_DEFAULT_SEC)

  const fail = (msg: string): AITestResult => ({ ok: false, latencyMs: 0, loadMs: 0, reply: '', error: msg })

  const refresh = useCallback(async () => {
    const list = await loadProviders()
    const aid = await loadActiveId()
    const rt = await loadRouting()
    setProviders(list)
    setActiveId(list.some(p => p.id === aid) ? aid : (list[0]?.id ?? null))
    setRouting(rt)
    setTimeoutSec(await loadAiTimeoutSec())
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /**
   * 换过模型后，把酒馆模式的「上下文预算 + 记忆档」同步成新模型的推荐值。
   *
   * 🔴🔴 2026-10-04（2.8.0 补）：**必须 await 到落盘之后，调用方才能触发界面刷新（`onChange`）**。
   *    原先这里 fire-and-forget 地与 `onChange()` 并发：额度面板在写盘**之前**就重读了设置，
   *    读到的是**上一个模型**的基准，而推荐值已按新模型算好 —— 于是界面出现
   *    「自动填的数是上一个模型的、推荐值反而是当前模型的」这种**看着像反了**的倒挂，
   *    且「采用推荐值」按钮一直亮着（因为 base !== rec）。数值本身没错，是读写竞态。
   *
   * 为什么两条链路**串行**而不是 Promise.all：它们读写**同一份**酒馆设置
   *    （酒馆那条还会把窗口写回 `numCtx`），并发会互相覆盖；串行后正文那条也能读到同步后的状态。
   *
   * 其余安全性仍由 sync 自己保证：按**模型指纹**判定，"没换模型"时什么都不做
   *   （同模型下用户手调的值不会被改回去），异常也已吞掉；「额度跟随模型自动调整」可关闭。
   */
  const syncTavernTuning = async (): Promise<void> => {
    // 两条链路各按自己的口径算，但**只弹一条** toast —— 换一次模型连弹两条太吵（2.8.0）
    const tav = await syncTuningWithModel()
    const w = await syncWriterBudgetToModel()
    const parts: string[] = []
    if (tav.changed) parts.push('酒馆额度（上下文预算 / 记忆档 / 固定开销）')
    if (w.changed) parts.push(`正文写作基准 ${w.base} 字`)
    if (parts.length) showToast(`已按新模型套用：${parts.join('；')}`, 'success')
  }

  /**
   * 改「请求超时」：落库并**立即生效**，不需要重载。
   * 原理：AI 层的 `CHAT_TIMEOUT_MS` 是模块级 `let`，`saveAiTimeoutSec` 内部调 setter 改写它；
   * ES module 的 import 是活绑定 ⇒ `aiTasks/**` 那些调用点下一次请求就用上新值。
   */
  const changeTimeout = async (sec: number) => {
    setTimeoutSec(await saveAiTimeoutSec(sec))
  }

  const persist = async (list: AIProvider[], aid: string | null) => {
    await saveProviders(list)
    if (aid !== null) await saveActiveId(aid)
    setProviders(list)
    setActiveId(aid)
    // 🔴 先落盘、再刷新：编辑 provider 时可能改过 model / 上下文窗口（两者都在指纹里）。
    //    若先 onChange，额度面板会读到写盘前的旧基准（详见 syncTavernTuning 的注释）。
    await syncTavernTuning()
    onChange?.()
  }

  const setActive = async (id: string) => {
    await saveActiveId(id)
    setActiveId(id)
    // 🔴 先落盘、再刷新（同上）：否则额度面板显示的是上一个模型的基准
    await syncTavernTuning()
    onChange?.()
  }

  /**
   * 改某一用途的路由（2.8.0 · #014）。
   * 🔴 与「换模型」同一套时序：**先落盘、再刷新界面**，否则额度面板会读到写盘前的旧基准。
   *    「创作」用途直接决定正文写作额度的口径（见 `aiWriterBudget.currentModelAdvice`），
   *    改完顺带同步一次正文基准；审校 / 整理不参与正文额度，无需同步。
   */
  const changeRouting = async (role: TaskRole, id: string) => {
    const next: RoutingMap = { ...routing, [role]: id }
    setRouting(next)
    await saveRouting(next)
    if (role === 'create') {
      const w = await syncWriterBudgetToModel()
      if (w.changed) showToast(`正文写作基准已按「创作」模型调整为 ${w.base} 字`, 'success')
    }
    onChange?.()
  }

  /** 配置变动后旧测试结论即失效，清掉避免误导 */
  const dropResult = (id: string) => {
    setRowResults(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const removeProvider = async (id: string) => {
    if (!await confirmDialog({ title: '删除模型配置', message: '确定删除该模型配置？', danger: true })) return
    const next = providers.filter(p => p.id !== id)
    const nextActive = activeId === id ? (next[0]?.id ?? null) : activeId
    try {
      await persist(next, nextActive)
      dropResult(id)
    } catch (e) {
      // 🔴 写盘失败不得静默（2026-10-10 六维审计 P1）
      showToast('删除模型配置失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  /** 由平台预设开始新增一条模型配置（未保存） */
  const startAddPreset = (p: PlatformPreset) => {
    setEditResult(null)
    setEditing(providerFromPreset(p))
    setPickMode('none')
  }

  const fetchModels = async (baseUrl: string) => {
    try {
      const models = await listOllamaModels(baseUrl)
      setOllamaModels(models)
      if (models.length === 0) {
        setEditResult(fail('Ollama 已连接，但本机还没有任何模型：请先执行 ollama pull <模型名> 拉取。'))
        return
      }
      setEditResult(null)
      if (editing && !editing.model) setEditing({ ...editing, model: models[0] })
    } catch (e) {
      setEditResult(fail(e instanceof Error ? e.message : String(e)))
    }
  }

  /** 2.5.2：拉 OpenAI 兼容端点（官方 / 中转站 / 本地兼容服务）的可用模型清单。失败只报原因，不破坏手动填写。 */
  const fetchOpenAIModels = async () => {
    if (!editing) return
    setFetchingOpenAI(true)
    try {
      const models = await listOpenAIModels(editing)
      setOpenaiModels(models)
      if (models.length === 0) {
        setEditResult(fail('端点已连通，但模型列表为空：请核对该接口地址是否正确，或手动填写模型名。'))
        return
      }
      setEditResult(null)
      if (!editing.model) setEditing({ ...editing, model: models[0] })
    } catch (e) {
      setEditResult(fail(e instanceof Error ? e.message : String(e)))
    } finally {
      setFetchingOpenAI(false)
    }
  }

  /** 编辑态：测试当前草稿配置（未保存也能测） */
  const runTest = async () => {
    if (!editing) return
    setTesting(true)
    setEditResult(null)
    setEditResult(await testProvider(editing))
    setTesting(false)
  }

  /** 列表态：测试某个已保存的模型配置 */
  const runRowTest = async (p: AIProvider) => {
    setTestingId(p.id)
    dropResult(p.id)
    const r = await testProvider(p)
    setRowResults(prev => ({ ...prev, [p.id]: r }))
    setTestingId(null)
  }

  const saveEdit = async () => {
    if (!editing) return
    if (!editing.name.trim()) { setEditResult(fail('请填写显示名称。')); return }
    if (!editing.model.trim()) { setEditResult(fail('请选择 / 填写模型名称。')); return }
    // 🔴 上下文窗口**必填**（2026-10-04）：额度、记忆档、酒馆窗口全按它推算，
    //    没有它整个预算体系就只能瞎猜。校验与提示文案统一走 modelCapacity（单一真源）。
    const winCheck = checkContextWindow(editing.contextWindow)
    if (!winCheck.ok) { setEditResult(fail(winCheck.error ?? '请填写上下文窗口（tokens）。')); return }
    setSaving(true)
    const exists = providers.some(p => p.id === editing.id)
    const next = exists ? providers.map(p => p.id === editing.id ? editing : p) : [...providers, editing]
    const nextActive = activeId ?? (!exists ? editing.id : activeId)
    try {
      await persist(next, nextActive)
      dropResult(editing.id)
      setEditing(null)
      setEditResult(null)
    } catch (e) {
      // 🔴 写盘失败必须复位 saving，否则保存键永久 disabled（2026-10-10 六维审计 P1）
      setEditResult(fail(e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  /** 编辑态（openai 类型）平台预设下拉：本地 / 联网各自只列本组 */
  const presetList =
    editing && editing.type === 'openai'
      ? editing.local
        ? [...LOCAL_OPENAI_PRESETS, { label: '自定义', baseUrl: '' }]
        : ONLINE_PRESETS
      : ONLINE_PRESETS

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-850/30">
      <div className="shrink-0 px-4 py-3 border-b border-ink-700">
        <div className="flex items-center gap-1.5">
          <h2 className="text-13 text-amber">模型配置</h2>
          <HelpPopover title="模型配置怎么用" width="24rem" size={14}>
            <p>全应用共用这一份模型配置 —— AI 辅助规划、逐章连写（创意写作）、取名、校对、设定补全都按这里选中的「当前」模型走；下方「AI 用途路由」还能给创作 / 审校 / 整理三类任务分别指定模型，留空即跟随当前模型；酒馆模式默认也跟随它，但可在酒馆「控制面板」里单独指定（含「整理记忆用的模型」）。</p>
            <p className="mt-1.5">两类平台：</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>本地模型</b>：Ollama / LM Studio 等，跑在你自己机器（或局域网内你自己的机器）上，一般免密钥、不需要联网；请求只发给这个地址，不经过任何第三方。</li>
              <li><b>联网模型</b>：硅基流动 / DeepSeek / 通义 / 智谱 等，需要 API 密钥，只有填了才发出请求。</li>
            </ul>
            <p className="mt-1.5">
              每行都有「测试」：会真实发起一次最小对话，确认这个配置能不能用（本地大模型首次调用要加载进显存，
              等几十秒是正常的）。密钥只存在本机数据文件里、不随云盘同步；发起请求时会随该请求发给对应的模型服务商。
            </p>
            <p className="mt-1.5">
              没配模型也不影响任何手动填写功能 —— 只是各处 AI 按钮会禁用并给出提示。
            </p>
            <p className="mt-1.5">
              每条配置都要填「上下文窗口（tokens）」—— 酒馆的上下文预算、记忆档、正文写作额度都按它推算。
              <b>1K = 1024 tokens</b>：模型标称 128K 就填 131072、96K 填 98304。
              填错的后果不是报错，而是所有推荐值一起偏大或偏小，所以这一栏不让留空。
            </p>
          </HelpPopover>
        </div>
        <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">
          全局设置：全应用的 AI 功能都按这里选中的「当前」模型执行。改完即存，不需要另找保存按钮。
          每条配置必填「上下文窗口（tokens）」（1K = 1024）—— 额度与记忆档都按它推算。
        </p>
      </div>

      <div className="p-4">
        {/* 🔴 列表态**不套 BODY**：`max-w-3xl`(≈768px) 会把两栏一起卡在左半边，
            右侧仍是死区（实测两栏总宽只有 794px，section 有 1289px）。
            编辑态是逐项纵向表单，才需要收窄到易读行宽。 */}
        <div className={editing === null ? '' : BODY}>
          {editing === null ? (
            /* 列表态两栏：xs–lg 单栏堆叠，xl+ 左「列表/添加/语义检索」右「路由/超时」。
               高度不写死 ⇒ 配置 N 个模型时左栏自然变长（自适应要求）。 */
            <div className={LIST_GRID}>
              {/* ---- 左栏：模型列表 + 添加 + 语义检索（需宽度的内容）---- */}
              <div>
                {providers.length === 0 ? (
                  <div className="text-12 text-ink-500 mb-3">还没有任何模型，先添加一个：</div>
                ) : (
                  <p className="text-11 text-ink-500 mb-2.5 leading-relaxed">
                    配置好模型后点该行「测试」，会真实发起一次最小对话来验证是否能正常调用。
                    <span className="text-ink-600">本地大参数模型首次调用需加载进显存，可能等待数十秒，属正常现象。</span>
                  </p>
                )}
                <div className="space-y-2 mb-4">
                  {providers.map(p => (
                    <div key={p.id} className="rounded-lg bg-ink-800 border border-ink-700">
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-10 ${p.type === 'ollama' || p.local ? 'bg-success/15 text-success' : 'bg-info/15 text-info'}`}>
                          {typeLabel(p)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-12 text-ink-100 truncate">{p.name}</div>
                          <div className="text-11 text-ink-500 font-mono truncate">{p.model || '（未设置模型）'}</div>
                        </div>
                        {/* 用途徽标（2.8.0 · #014）：一眼看出这条配置被哪些用途指定了 */}
                        {rolesOf(routing, p.id).map(r => (
                          <span
                            key={r}
                            className="shrink-0 px-1.5 py-0.5 rounded text-10 bg-info/15 text-info"
                            title={`被「${ROLE_LABEL[r]}」用途指定 —— ${ROLE_HINT[r]}`}
                          >
                            {ROLE_LABEL[r]}
                          </span>
                        ))}
                        {!checkContextWindow(p.contextWindow).ok && (
                          <span
                            className="shrink-0 px-1.5 py-0.5 rounded text-10 bg-amber/15 text-amber"
                            title="这条配置还没填「上下文窗口」—— 额度与记忆档会按保守值估算。点右侧铅笔补填（1K = 1024 tokens）。"
                          >
                            未填窗口
                          </span>
                        )}
                        {activeId === p.id ? (
                          <span className="shrink-0 flex items-center gap-1 text-11 text-success"><CheckCircle2 size={12} /> 当前</span>
                        ) : (
                          <Button variant="bare" onClick={() => setActive(p.id)} className="shrink-0 text-11 px-2 py-1 rounded bg-ink-700 text-ink-200 hover:bg-ink-600">设为当前</Button>
                        )}
                        <Button variant="bare"
                          onClick={() => runRowTest(p)}
                          disabled={testingId !== null}
                          title={testingId !== null ? '有测试正在进行中，请稍候' : '发起一次最小对话，验证该模型能否正常调用'}
                          className="shrink-0 flex items-center gap-1 text-11 px-2 py-1 rounded bg-ink-700 text-ink-200 hover:bg-ink-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {testingId === p.id ? <Loader2 size={11} className="animate-spin" /> : <FlaskConical size={11} />}
                          {testingId === p.id ? '测试中…' : '测试'}
                        </Button>
                        <Button variant="bare" iconOnly size="xs" onClick={() => { setEditResult(null); setEditing(p) }} title="编辑" className="shrink-0 text-ink-500 hover:text-amber"><Pencil size={12} /></Button>
                        {/* 🔴 2026-09-22 六维审计 P2：原来没传 size ⇒ `icon-danger` 走 ICON_SIZE.sm = h-8(32px)，
                            与同排的编辑键（`iconOnly size="xs"` = h-6/24px）**差 8px**，违反「同排同 size」。
                            补 `iconOnly size="xs"` 对齐；顺带去掉 `p-1`（ICON_SIZE 已定宽高，再加 padding 只会挤压图标）。 */}
                        {/* 🔴 2026-09-22 六维审计 P2：原来没传 size ⇒ `icon-danger` 走 ICON_SIZE.sm = h-8(32px)，
                            与同排的编辑键（`iconOnly size="xs"` = h-6/24px）**差 8px**，违反「同排同 size」。
                            补 `iconOnly size="xs"` 对齐；顺带去掉 `p-1`（ICON_SIZE 已定宽高，再加 padding 只会挤压图标）。 */}
                        <Button variant="icon-danger" iconOnly size="xs" onClick={() => removeProvider(p.id)} title="删除" className="shrink-0"><Trash2 size={12} /></Button>
                      </div>
                      {testingId === p.id && (
                        <div className="px-3 pb-2 text-11 text-ink-400 flex items-center gap-1.5">
                          <Loader2 size={11} className="animate-spin text-amber" /> 正在调用「{p.model}」，本地大模型可能需要数十秒…
                        </div>
                      )}
                      {testingId !== p.id && rowResults[p.id] && (
                        <div className="px-3 pb-2"><TestResultBar r={rowResults[p.id]} /></div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button variant="bare" onClick={() => setPickMode('local')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-success/10 text-success border border-success/25 rounded-lg text-12 hover:bg-success/20 transition-colors" title="Ollama 与本地 OpenAI 兼容服务（LM Studio / LocalAI 等），跑在本机，一般免密钥、免联网">
                    <Cpu size={13} /> 添加本地模型
                  </Button>
                  <Button variant="bare" onClick={() => setPickMode('online')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-info/10 text-info border border-info/25 rounded-lg text-12 hover:bg-info/20 transition-colors" title="联网平台（硅基流动 / DeepSeek / 通义 / 智谱 等），需填 API 密钥">
                    <Globe size={13} /> 添加联网模型
                  </Button>
                </div>
                {pickMode !== 'none' && (
                  <div className="mt-3 rounded-lg border border-ink-700 bg-ink-800/40 p-3">
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="text-12 font-medium text-ink-200">
                        {pickMode === 'local' ? '选择本地平台' : '选择联网平台'}
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => setPickMode('none')} className="ml-auto">返回</Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {(pickMode === 'local' ? LOCAL_PRESETS : ONLINE_PRESETS).map(p => (
                        <Button variant="secondary" key={p.label} onClick={() => startAddPreset(p)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border-ink-700 hover:text-success hover:border-success/40 transition-colors text-left">
                          {pickMode === 'local'
                            ? <Cpu size={12} className="text-success shrink-0" />
                            : <Globe size={12} className="text-info shrink-0" />}
                          <span className="truncate">{p.label}</span>
                        </Button>
                      ))}
                    </div>
                    <p className="text-11 text-ink-500 mt-2 leading-relaxed">
                      {pickMode === 'local'
                        ? '本地平台运行在本机 / 局域网，一般免密钥、无需联网；Ollama 需先「ollama pull」拉取模型。'
                        : '联网平台需要 API 密钥，按预设填好接口地址后填入密钥与模型名即可。'}
                    </p>
                  </div>
                )}

                {/* 语义检索（2.8.0 · 台账 #013）：嵌入模型 + 向量索引状态。
                    与「AI 用途路由」同属**模型能力的分配** —— 走同一份 providers，
                    只是换个用途（向量化而非对话）；故并列放在「模型配置」块内，不另开页签。
                    左栏收尾（宽度需求大，跟列表同栏）。 */}
                <EmbeddingIndexPanel providers={providers} />
            </div>

            {/* ---- 右栏：定宽分配表单（用途路由 / 请求超时）---- */}
            <div>
              {/* AI 用途路由（2.8.0 · #014）：三类任务各指定模型，留空 = 跟随当前模型。
                  刻意放在模型列表旁边 —— 它是「模型配置」的延伸（同一份 providers 的分配），
                  不另开页签（新增页签要四处同步，得不偿失）。
                  🔴 2026-10-12 移到右栏：三格下拉本就窄，放左栏会与 440px 死区一起显空。 */}
              {/* 右栏首块不加上边框：单栏堆叠时它上方是左栏尾（语义检索已有上边框），
                  双线叠在一起会显得脏；两栏并列时更需要「并列声明」而非「延续」的视觉。 */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <h3 className="text-12 text-ink-200">AI 用途路由</h3>
                  <HelpPopover title="AI 用途路由怎么用" width="23rem" size={13}>
                    <p>给不同用途的 AI 任务分别指定模型：<b>创作</b>写好正文、<b>审校</b>材料读得多、<b>整理</b>调用最频繁。</p>
                    <p className="mt-1.5">三格全部留空 ⇒ 所有功能都跟随上面的「当前模型」，与你从没设过它时完全一样。</p>
                    <p className="mt-1.5">指定的模型被删除、或没填全配置 ⇒ 自动回落到当前模型，不会报错。</p>
                    <p className="mt-1.5">典型用法：正文用质量最好的模型，「整理」指向一个便宜 / 快的模型，几十次整理调用就不必都烧大模型。</p>
                  </HelpPopover>
                </div>
                <p className="text-11 text-ink-500 mb-2.5 leading-relaxed">
                  留空即跟随当前模型。悬停每一项可看它在管哪些功能。
                </p>
                <div className="space-y-2">
                  {TASK_ROLES.map(role => {
                    // 指向已删除的模型时，界面按「跟随当前模型」显示 —— 与真实解析行为一致（回落）
                    const val = providers.some(p => p.id === routing[role]) ? routing[role] : ''
                    return (
                      <div key={role} className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-12 text-ink-300">{ROLE_LABEL[role]}</span>
                        <select
                          className="min-w-0 flex-1 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40"
                          value={val}
                          onChange={e => void changeRouting(role, e.target.value)}
                          title={ROLE_HINT[role]}
                        >
                          <option value="">（跟随当前模型）</option>
                          {providers.map(p => (
                            <option key={p.id} value={p.id}>{p.name} · {p.model || '未设模型'}</option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 请求超时（2.9.0）：全应用共用的单次请求等待上限。
                  此前这里没有任何可调项 —— 慢模型跑结构化任务只能干等（硬编码 180s），而酒馆那边
                  早就有同名设置。刻意与「模型配置」同面板：超时是模型 / 网络的属性，不是某个功能的属性。
                  🔴 2026-10-12 与「AI 用途路由」同置右栏 —— 两者都是窄表单，左栏留给需宽度的列表。 */}
              <div className="mt-5 pt-4 border-t border-ink-700">
                <div className="flex items-center gap-1.5 mb-1">
                  <h3 className="text-12 text-ink-200">请求超时</h3>
                  <HelpPopover title="请求超时怎么用" width="23rem" size={13}>
                    <p>单次 AI 请求最多等多久。超时就中断并报错（不会自动重试）。</p>
                    <p className="mt-1.5"><b>长文生成不受它限制</b>：续写 / 校对 / 拆书这类走流式，模型一开始出字就一直等；这条管的是<b>结构化任务</b>（设定抽取、审核、汇总、取名这类要一次性拿到完整结果的）。</p>
                    <p className="mt-1.5">本地大模型首次调用要加载进显存、慢机器跑长任务，都可能超过默认值 —— 报「请求超时」就把它调大。</p>
                    <p className="mt-1.5">酒馆模式有自己的「请求超时」（在酒馆控制面板里），两者互不影响。</p>
                  </HelpPopover>
                </div>
                <p className="text-11 text-ink-500 mb-2.5 leading-relaxed">
                  结构化任务（设定抽取 / 审核 / 汇总 / 取名等）的单次等待上限；流式长文不受它限制。
                  <span className="text-ink-600">只影响主应用，酒馆模式另有设置。</span>
                </p>
                <div className="flex items-center gap-2">
                  <NumberField
                    value={timeoutSec}
                    min={AI_TIMEOUT_MIN_SEC} max={AI_TIMEOUT_MAX_SEC} step={10}
                    className="w-24 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40"
                    onChange={v => { if (v !== undefined) void changeTimeout(v) }}
                    onClamped={v => showToast(`请求超时已调回边界 ${v} 秒`, 'info')}
                  />
                  <span className="text-11 text-ink-500">秒（{AI_TIMEOUT_MIN_SEC}–{AI_TIMEOUT_MAX_SEC}）</span>
                  {timeoutSec !== AI_TIMEOUT_DEFAULT_SEC && (
                    <Button variant="secondary" size="xs" className="ml-auto" onClick={() => void changeTimeout(AI_TIMEOUT_DEFAULT_SEC)}>
                      恢复默认 {AI_TIMEOUT_DEFAULT_SEC} 秒
                    </Button>
                  )}
                </div>
              </div>
            </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-12">
                {editing.type === 'ollama' ? (
                  <span className="flex items-center gap-1 text-success"><Cpu size={13} /> 本地 Ollama</span>
                ) : editing.local ? (
                  <span className="flex items-center gap-1 text-success"><Cpu size={13} /> 本地 OpenAI 兼容</span>
                ) : (
                  <span className="flex items-center gap-1 text-info"><Globe size={13} /> 联网 OpenAI 兼容</span>
                )}
              </div>

              <div>
                <label className="block text-11 text-ink-500 mb-1">显示名称</label>
                <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="如：本地 llama3 / DeepSeek" />
              </div>

              <div>
                <label className="block text-11 text-ink-500 mb-1">自定义系统提示词（可选 · 全局生效）</label>
                <textarea
                  className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600 resize-none"
                  rows={3}
                  value={editing.systemPrompt ?? ''}
                  onChange={e => setEditing({ ...editing, systemPrompt: e.target.value })}
                  placeholder="对所有调用此模型的功能追加一段总体指令（如写作风格、人称、禁忌）。留空则按系统预设。"
                />
                <p className="text-11 text-amber mt-1 leading-relaxed">
                  ⚠️ 这段提示词是「全局」的 —— 对所有调用该模型的 AI 功能一并生效（酒馆模式默认不接，需要时可在酒馆控制面板单独开启）。
                  如果只想调整某一个具体功能，请到「模型设置 → AI 提示词」里改那个功能自己的提示词，不要写在这里。
                  它会附加在各功能自带提示词之后，不覆盖、不影响原有的格式约束。
                </p>
              </div>

              {/* 2.9.2 · 文本生成微调（参照酒馆控制面板搬迁，说明另写为**写作向**）。
                  🔴 留空 ＝ 不下发：一个都不填时请求体与改动前**逐字节一致**。
                  🔴 三项 Ollama 专有参数（候选词上限 / 重复惩罚 / 惩罚回看窗口）在云端模型下**灰显** ——
                     否则作者调了以为生效，实际会被 openaiSampling 白名单静默丢弃（酒馆那边此前正是漏了这一步）。 */}
              <div>
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                  <label className="block text-11 text-ink-500">文本生成微调（选填 · 全局生效）</label>
                  <span className="text-11 text-ink-600">全部留空 ＝ 不下发，行为与原来完全一致</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {SAMPLING_FIELDS.map(f => {
                    // Ollama 专有的三项：非 Ollama 端点（云端 **＋ 本地 OpenAI 兼容**）不可用
                    // ⇒ 灰显占位。🔴 判据与下发同源（`isOllamaSamplingChannel`），不用 `local`
                    //   —— LM Studio 那种本地 OpenAI 兼容服务也是 local，但它认不了这三个键。
                    const usable = f.cloud || isOllamaSamplingChannel(editing)
                    const val = editing.sampling?.[f.key]
                    return (
                      <div key={f.key}
                        className={`rounded-lg border px-2.5 py-2 ${usable ? 'border-ink-700 bg-ink-900/40' : 'border-ink-700 bg-ink-900/20'}`}>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className={`text-11 ${usable ? 'text-ink-300' : 'text-ink-600'}`}>{f.label}</span>
                          <span className="text-11 text-ink-600">推荐 {f.recommend}</span>
                          {/* 「仅本地」改成「仅 Ollama」（2026-10-10 审计）：灰显判据是 isOllamaSamplingChannel（type==='ollama'），
                              本地 OpenAI 兼容（LM Studio / LocalAI）同样被灰显 ⇒ 写「仅本地」会让人以为本地就能用。 */}
                          {!f.cloud && <span className="text-11 text-ink-600">仅 Ollama</span>}
                        </div>
                        {usable ? (
                          // 🔴 必须走 NumberField（本地 text 态 + 失焦提交 + 钳制）：
                          //    原来那个受控 `type=number` 在输入「0.」这种中间态时，浏览器把 `.value`
                          //    sanitize 成空串 ⇒ 立即被当成「清空」⇒ **小数点根本打不进去**
                          //    （六项里有四项是小数）。NumberField 同时补上范围钳制，
                          //    这与 2.6.0 巡检在酒馆那边踩的同一个坑是同一条判据。
                          <NumberField
                            className="mt-1 w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-2 py-1 outline-none focus:border-amber/40 placeholder:text-ink-600"
                            value={val}
                            min={f.min} max={f.max} step={f.step}
                            precision={String(f.step).includes('.') ? String(f.step).split('.')[1].length : 0}
                            allowEmpty
                            placeholder="留空 ＝ 不下发"
                            onChange={v => setEditing(prev => {
                              if (!prev) return prev
                              const cur = { ...(prev.sampling ?? {}) }
                              if (v === undefined || !Number.isFinite(v)) delete cur[f.key]
                              else cur[f.key] = v
                              return { ...prev, sampling: Object.keys(cur).length ? cur : undefined }
                            })}
                          />
                        ) : (
                          <SamplingUnavailable className="mt-1" />
                        )}
                        <p className="mt-1 text-11 leading-relaxed text-ink-600">{f.effect}</p>
                      </div>
                    )
                  })}
                </div>
                <p className="mt-1 text-11 leading-relaxed text-ink-600">
                  温度另有独立入口（上面的「生成温度」档位）。这些参数只影响<b>文本生成效果</b>、不改动任何项目数据；
                  结构化任务（需要解析成 JSON 的那些）不受影响 —— 那类固定走低温，且不使用这里的参数，以保证解析稳定。
                  酒馆模式有自己的一套参数（控制面板里调），不受这里影响。
                </p>
              </div>

              {editing.type === 'ollama' ? (
                <>
                  <div>
                    <label className="block text-11 text-ink-500 mb-1">Ollama 地址</label>
                    <div className="flex gap-2">
                      <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="http://localhost:11434" />
                      <Button variant="secondary" size="sm" onClick={() => fetchModels(editing.baseUrl)} className="shrink-0">获取本地模型</Button>
                    </div>
                  </div>
                  {ollamaModels.length > 0 && (() => {
                    // 2.9.2 · ①：先筛再用 —— 本机 pull 多了同样会翻半天
                    const shown = filterModels(ollamaModels, ollamaFilter)
                    return (
                    <div>
                      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                        <label className="block text-11 text-ink-500">选择模型</label>
                        {ollamaFilter.trim() && (
                          <span className="text-11 text-ink-500">命中 {shown.length} / 共 {ollamaModels.length}</span>
                        )}
                      </div>
                      <input
                        className="mb-1 w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
                        value={ollamaFilter}
                        onChange={e => setOllamaFilter(e.target.value)}
                        placeholder="筛选模型名（空格分隔可多词，如 qwen 8b）"
                      />
                      <select className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40" value={shown.includes(editing.model) ? editing.model : ''} onChange={e => setEditing({ ...editing, model: e.target.value })}>
                        <option value="">{SELECT_PLACEHOLDER}</option>
                        {shown.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      {shown.length === 0 && (
                        <p className="text-11 text-ink-500 mt-1">没有匹配的模型 —— 换个关键词，或在下方手动填写。</p>
                      )}
                    </div>
                    )
                  })()}
                  <div>
                    <label className="block text-11 text-ink-500 mb-1">或手动填写模型名</label>
                    <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} placeholder="需本机已 ollama pull" />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-11 text-ink-500 mb-1">平台预设</label>
                    <select
                      className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40"
                      value={presetList.find(p => p.baseUrl === editing.baseUrl)?.label ?? '自定义'}
                      onChange={e => {
                        const pre = presetList.find(p => p.label === e.target.value)
                        // 🔴 切换预设必须一并算 headers（独立复核 P2）：从普通模型切到 OpenCode Go
                        //    若不补 `x-opencode-session`，要等真发请求才 400，界面上看不出问题。
                        if (pre && pre.baseUrl !== '') setEditing({ ...editing, baseUrl: pre.baseUrl, local: !!pre.local, name: editing.name || pre.label, headers: headersForPresetSwitch(pre, editing.headers) })
                        else if (pre && pre.baseUrl === '') setEditing({ ...editing, baseUrl: '', local: editing.local, name: editing.name, headers: headersForPresetSwitch(pre, editing.headers) })
                      }}
                    >
                      {presetList.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
                    </select>
                    <p className="text-11 text-ink-500 mt-1">本地平台（LM Studio / LocalAI 等）一般免密钥、无需联网；联网平台需填写 API 密钥。选「自定义」可手填接口地址。</p>
                  </div>
                  <div>
                    <label className="block text-11 text-ink-500 mb-1">API 接口地址（baseUrl）</label>
                    <div className="flex gap-2">
                      <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
                      <Button variant="secondary" size="sm" disabled={fetchingOpenAI || !editing.baseUrl.trim()} onClick={() => void fetchOpenAIModels()} className="shrink-0" title="按当前接口地址拉取该端点可用的模型清单（官方平台 / 中转站 / 本地兼容服务均支持）">{fetchingOpenAI ? '获取中…' : '获取可用模型'}</Button>
                    </div>
                  </div>
                  {/* 3.1.1 第 4 项 · 自定义请求头：给「要求额外请求头才认」的订阅 / 网关用
                      （代表场景：OpenCode Go 的 x-opencode-session，缺了直接 400）。
                      编辑器自成一组件（自带行状态）—— 取消 / 保存后随表单卸载，草稿自然复位。 */}
                  <CustomHeadersEditor
                    providerId={editing.id}
                    headers={editing.headers}
                    isOpencodeGo={editing.baseUrl === OPENCODE_GO_BASE}
                    onChange={headers => setEditing(prev => (prev ? { ...prev, headers } : prev))}
                  />
                  {openaiModels.length > 0 && (() => {
                    // 2.9.2 · ①：中转站动辄几百个模型，靠 select 的「键入前缀跳转」不够用
                    const shown = filterModels(openaiModels, openaiFilter)
                    return (
                    <div>
                      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                        <label className="block text-11 text-ink-500">从端点获取的可用模型（{openaiModels.length} 个）</label>
                        {openaiFilter.trim() && (
                          <span className="text-11 text-ink-500">命中 {shown.length} / 共 {openaiModels.length}</span>
                        )}
                      </div>
                      <input
                        className="mb-1 w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
                        value={openaiFilter}
                        onChange={e => setOpenaiFilter(e.target.value)}
                        placeholder="筛选模型名（空格分隔可多词，如 qwen 32b）"
                      />
                      <select className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40" value={shown.includes(editing.model) ? editing.model : ''} onChange={e => setEditing({ ...editing, model: e.target.value })}>
                        <option value="">{SELECT_PLACEHOLDER}</option>
                        {shown.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      {shown.length === 0 && (
                        <p className="text-11 text-ink-500 mt-1">没有匹配的模型 —— 换个关键词，或在下方手动填写。</p>
                      )}
                      <p className="text-11 text-ink-500 mt-1">清单较长时用上面的筛选框按名字定位最快；也可在下方手动填写。</p>
                    </div>
                    )
                  })()}
                  <div>
                    <label className="block text-11 text-ink-500 mb-1">API 密钥</label>
                    <input type="password" className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 font-mono placeholder:text-ink-600" value={editing.apiKey} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} placeholder="密钥只存本机，不随云盘同步" />
                  </div>
                  <div>
                    <label className="block text-11 text-ink-500 mb-1">模型名称</label>
                    <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} placeholder="如 deepseek-chat / qwen-plus / glm-4-flash" />
                  </div>
                </>
              )}

              {/* 上下文窗口（必填 + K/token 换算 + 越界提示）—— 实现在 AIConfigFields.tsx */}
              <ContextWindowField
                value={editing.contextWindow}
                local={editing.type === 'ollama' || !!editing.local}
                onChange={v => setEditing(prev => (prev ? { ...prev, contextWindow: v } : prev))}
              />

              {/* 采样温度档位（按 provider 存、随模型走）—— 实现在 AIConfigFields.tsx */}
              <TemperatureField
                value={editing.temperature}
                local={editing.type === 'ollama' || !!editing.local}
                onChange={v => setEditing(prev => (prev ? { ...prev, temperature: v } : prev))}
              />

              {testing && <TestingBar model={editing.model} />}
              {!testing && editResult && <TestResultBar r={editResult} />}

              <div className="flex items-center gap-2 pt-1">
                <Button onClick={saveEdit} disabled={saving || testing} variant="primary" size="md">
                  <Check size={12} /> 保存
                </Button>
                <Button onClick={runTest}
                  disabled={testing}
                  title="不必先保存，直接用当前填写的配置发起一次最小对话" variant="secondary" size="md">
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                  {testing ? '测试中…' : '测试此配置'}
                </Button>
                <Button variant="secondary" size="md" onClick={() => { setEditing(null); setEditResult(null); setPickMode('none') }} className="ml-auto">取消</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

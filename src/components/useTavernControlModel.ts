/**
 * 酒馆控制面板 · 状态与派生（C1 · 2.4.2 自 TavernControl.tsx 拆出）
 *
 * 🔴 纯搬家：state / handler / 派生值一字未改，只是把「组件体」搬成了 hook。
 *    组件侧 `const m = useTavernControlModel()`；左列三个子组件只收 `m`。
 *    右列 TavernControlModes 保持既有 props 接口不动（它是上一轮拆出去的，本轮不碰）。
 *    两列等高的高度同步 effect 留在这里 —— 它量的 `leftColRef` / `rightColRef` 是主组件的 DOM。
 *
 * 🔴 唯一的结构适配：原先组件体的 early return 写的是 `return <LoadingState />`，
 *    这里改成 `return null`（hook 在 .ts 里写不了 JSX）；主组件接 `if (!m) return <LoadingState />`。
 *    所有 hooks 仍在该行之前，调用顺序与拆分前完全一致。
 */
import * as presets from '../lib/tavern/presets'
import { useEffect, useMemo, useRef, useState } from 'react'
import { loadProviders, loadActiveId, AIProvider } from '../lib/ai'
import { adviseCapacity, modelFingerprintOf } from '../lib/modelCapacity'
import { showToast, confirmDialog } from './dialogs'
import { TavernPreset } from '../lib/tavern/presets'
import { dynamicGuide } from '../lib/tavern/paramGuide'
import { VarKey } from '../lib/tavern/types'
import { DEFAULT_POST_RULES, previewPostRules, PostRule } from '../lib/tavern/postRules'
import { getTavernSettings, saveTavernSettings, resetTavernSettings, DEFAULT_TAVERN_SETTINGS, TavernSettings, TavernProfile } from '../lib/tavern/settings'
import { COL_GAP, PROTO_MIN_HEIGHT } from './tavernControlParts'
import { DYNAMIC_QUOTA_PCT } from '../lib/tavern/quotas'

export function useTavernControlModel() {
  const [s, setS] = useState<TavernSettings | null>(null)
  /** 是否展开所有数值项的分段说明（默认展开） */
  const [showBands, setShowBands] = useState(true)
  const [providers, setProviders] = useState<AIProvider[]>([])
  /** 全局活动模型 id —— 本场未指定模型时，实际生效的就是它（用于推断上下文能力） */
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
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
        const [st, ps, actId] = await Promise.all([
          getTavernSettings(),
          loadProviders().catch(() => [] as AIProvider[]),
          loadActiveId().catch(() => null),
        ])
        setS(st)
        setProviders(ps)
        setActiveProviderId(actId)
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
  // 自由段里也有开关键（#11 的「卸载本地模型」），所以取值放宽到 boolean（与 setCommon 一致）
  const setFree = (k: keyof TavernSettings['free'], v: number | string | boolean) =>
    edit(prev => ({ ...prev, free: { ...prev.free, [k]: v } as TavernSettings['free'] }))
  /** 本场数值（C2 第二步）：开关 / 逐项关闭 / 单次幅度（刷新时机固定为「每轮回复后」，没有旋钮） */
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
  /** T3 多候选开关（与输出后处理同层，都是「生成后怎么处理」的开关） */
  const setMultiVariant = (v: boolean) => edit(prev => ({ ...prev, multiVariant: v }))
  /** 世界书动态层额度（占窗口百分比，5~35）。超范围的值在读取侧（quotas）还会再夹一次，这里先夹住避免界面显示越界值。 */
  const setDynamicQuotaPct = (v: number) => edit(prev => ({
    ...prev,
    dynamicQuotaPct: Math.max(DYNAMIC_QUOTA_PCT.min, Math.min(DYNAMIC_QUOTA_PCT.max, Math.round(v))),
  }))
  // 🔴 按规则 **id** 定位，不按数组下标：规则可增可删，面板拿到的下标只是渲染那一刻的快照 ——
  //    一次删除 / 重排之后它就可能指向另一条（「点 A 改到 B」「点 A 删 B」同一族坑）。
  const setRule = (id: string, patch: Partial<PostRule>) =>
    edit(prev => ({ ...prev, postRules: prev.postRules.map(r => (r.id === id ? { ...r, ...patch } : r)) }))
  const addRule = () =>
    edit(prev => ({
      ...prev,
      postRules: [...prev.postRules, {
        id: `pr-${Date.now()}`, name: '新规则', pattern: '', replacement: '', flags: 'gm', enabled: true,
      }],
    }))
  const dropRule = (id: string) =>
    edit(prev => ({ ...prev, postRules: prev.postRules.filter(r => r.id !== id) }))
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
        '联网检索属于全局设置，不在这八段里，恢复出厂不会动它。',
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

  // 🔴 early return 只出数据、不出 JSX：hook 在 .ts 里写不了 JSX，渲染决策交主组件
  if (!s) return null

  const c = s.common
  const pr = s.profile
  const pl = s.plot
  const fr = s.free
  const modelOptions = providers.map(p => ({ id: p.id, label: `${p.name} · ${p.model}` }))

  // 2.2.0：解析「当前实际生效的模型」—— 本场指定优先，否则跟随全局活动模型。
  // 为什么要它：numCtx 32768 / contextBudget 24000 是为本地 5090 + 27B q6_K 算的，
  // 而 num_ctx 是 Ollama 专有字段 —— 云端端点不认它。不区分的话，接上 256K 窗口的云端模型
  // 仍会被"本地算出来的数"锁死，且面板上毫无提示（见 lib/modelCapacity.ts）。
  // ⚠️ 刻意**不用 useMemo**：本组件在 `if (!s) return null` 处有 early return，
  // 而 c 依赖 s —— Hook 写在 return 之后会违反"每次渲染调用顺序一致"的规则（lint 报过）。
  // 这里只是几次正则匹配 + 算术，每次渲染重算的成本可以忽略。
  const activeProvider = (() => {
    const id = c.defaultProviderId || activeProviderId
    return providers.find(p => p.id === id) ?? null
  })()
  const cap = adviseCapacity(activeProvider, { numCtx: c.numCtx, contextBudget: c.contextBudget })

  // 「跟着模型走」的推荐值：预算 / 窗口（本地）/ 记忆三项 / 日记保留
  const rec = cap.suggest
  // 🔴 2.8.0：档位不再固定 —— 以「当前模型的推荐值」为中心、上下各两档，
  //    换模型时整条刻度一起平移（出厂那几档是按本地 32K 定的，大窗口模型会被永远判成「拉过头」）。
  //    min / step 沿用静态表，只有上界与分段被重算；推荐值永远落在「推荐」那一段里。
  const gBudget = dynamicGuide('contextBudget', rec.contextBudget)
  // 窗口的推荐值 = 模型配置里的窗口（手填 > 识别）；云端 `numCtx` 为 null 时退回识别到的窗口值
  const gNumCtx = dynamicGuide('numCtx', rec.numCtx ?? cap.windowTokens)
  const gSoft = dynamicGuide('softLimit', rec.softLimit)
  const gHard = dynamicGuide('hardLimit', rec.hardLimit)
  const gLong = dynamicGuide('longTermLimit', rec.longTermLimit)
  const gDiary = dynamicGuide('diaryKeep', rec.diaryDays)
  const gFixed = dynamicGuide('fixedOverheadChars', rec.fixedOverhead)

  /**
   * 当前值里有几项偏离推荐（用于「采用推荐值」按钮的提示与禁用态）。
   *
   * ⚠️ 只数**能代为更改**的项：
   *  · 窗口（numCtx）不计入 —— 本地由显存决定、云端由服务商决定，系统不该替用户改；
   *    硬给「推荐值」只会是把当前值原样念回来的自指，按钮会永远停在「已是推荐值」。
   *  · 预算（contextBudget）**计入**：云端总能算出建议；本地只有在"超窗口"时
   *    推荐值才不同于现值（见 modelCapacity 的超窗口保护），低于上限时两者相等、自然不计入。
   */
  const drift = [
    c.contextBudget !== rec.contextBudget,
    c.fixedOverheadChars !== rec.fixedOverhead,
    fr.softLimit !== rec.softLimit,
    fr.hardLimit !== rec.hardLimit,
    fr.longTermLimit !== rec.longTermLimit,
    fr.diaryDays !== rec.diaryDays,
  ].filter(Boolean).length

  /** 一键把这一整批数值都设成当前模型的推荐值（只改这几项，其余设置一律不动） */
  const applyRecommended = () => {
    // 预算：云端总是改；本地只在**超窗口**时回落 —— 本地窗口由显存决定，
    // 不该被"推荐"推着放大（放大就跑不动）。
    if (!cap.local || cap.overWindow) setCommon('contextBudget', rec.contextBudget)
    setCommon('fixedOverheadChars', rec.fixedOverhead)
    setFree('softLimit', rec.softLimit)
    setFree('hardLimit', rec.hardLimit)
    setFree('longTermLimit', rec.longTermLimit)
    setFree('diaryDays', rec.diaryDays)
  }

  /**
   * 换「默认模型」时，**就地**把额度改成新模型的推荐值。
   *
   * ⚠️ 这里只改本地草稿、**不写盘** —— 控制面板的契约是"改完点右上「保存」"。
   *    直接写盘会让面板显示的值与草稿不一致，且用户点保存时会把同步结果覆盖回去。
   *    在别处换模型（模型配置页「设为当前」）走的是 `syncTuningWithModel()` 那条写盘路径。
   */
  const onDefaultModelChange = async (v: string) => {
    if (c.autoTuneByModel === false) {
      setCommon('defaultProviderId', v)
      return
    }
    // 解析口径必须与上面的 activeProvider 一致：留空 = 跟随全局活动模型
    const p = providers.find(x => x.id === (v || activeProviderId)) ?? null
    const adv = adviseCapacity(p, { numCtx: c.numCtx, contextBudget: c.contextBudget })
    const r = adv.suggest
    const nextCommon = { ...s.common, defaultProviderId: v, tunedFor: modelFingerprintOf(p) }
    // 预算：云端总是跟随；本地只在「手填了窗口」或「已超窗口」时落 —— 未手填时窗口本就是面板现值，
    // 该配比多少交给作者自己掌握（想让预算随模型放大，去模型配置里手填窗口）。
    if (!adv.local || adv.overWindow || adv.numCtxFromUserWindow) nextCommon.contextBudget = r.contextBudget
    if (adv.numCtxFromUserWindow && r.numCtx && r.numCtx !== c.numCtx) nextCommon.numCtx = r.numCtx
    nextCommon.fixedOverheadChars = r.fixedOverhead
    const nextFree = {
      ...s.free,
      softLimit: r.softLimit,
      hardLimit: r.hardLimit,
      longTermLimit: r.longTermLimit,
      diaryDays: r.diaryDays,
    }
    try {
      const saved = await saveTavernSettings({ ...s, common: nextCommon, free: nextFree })
      setS(saved)
      setDirty(false)
      showToast('已按新模型套用额度并保存（上下文预算 / 记忆档 / 固定开销）')
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  return {
    s, setS, showBands, setShowBands, providers, setProviders, activeProviderId, setActiveProviderId, ruleTry, setRuleTry, dirty, setDirty, saving, setSaving, protocolEditing, setProtocolEditing, presetList, setPresetList, presetNaming, setPresetNaming, presetFileRef, leftColRef, rightColRef, protoH, setProtoH, layoutReady, storePresetAs, applyPreset, overwritePreset, dropPreset, exportPreset, importPresetFile, edit, setCommon, setProfile, setPlot, setFree, setVars, toggleVarKey, setPostFlag, setMultiVariant, setDynamicQuotaPct, setRule, addRule, dropRule, resetRules, save, reset, startEditProtocol, rulePreview, c, pr, pl, fr, modelOptions, activeProvider, cap, rec, gBudget, gNumCtx, gSoft, gHard, gLong, gDiary, gFixed, drift, applyRecommended, onDefaultModelChange,
  }
}

/** 🔴 NonNullable：hook 可能在前置数据未就绪时返回 null（见上面的 early return） */
export type TavernControlModel = NonNullable<ReturnType<typeof useTavernControlModel>>

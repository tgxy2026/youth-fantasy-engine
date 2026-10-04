import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Z } from '../lib/zLayer'
import type { TabDef } from '../lib/types'
import { getFormData, saveFormData } from '../lib/db'
import { Save, RotateCcw, Info, Check, Sparkles, Radar } from 'lucide-react'
import HelpPopover from './HelpPopover'
import { isNumericPowerField } from '../lib/schema'
import SchemaFieldGrid from './SchemaFieldGrid'
import AITemplateFill from './AITemplateFill'
import type { TemplateField, FillContext } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { useSaveHotkey } from '../lib/useSaveHotkey'
import { AI_DISABLED_HINT, aiCapabilityOf } from '../lib/aiScope'
import { confirmDialog, showToast } from './dialogs'
import { Button } from './Button'
import FieldAliasButton, { moduleAliasTargets } from './FieldAliasButton'
import { SaveFab } from './SaveFab'
import { LoadingState } from './LoadingState'
import MarketRadarDialog from './MarketRadarDialog'

// 力量体系是升级流的"宪法"：境界/数值类字段绝不能让 AI 凭空编造 ——
// 常量已提到 lib/schema（C10 起母子面板共用同一套锁定判据，见 POWER_NUMERIC_HINTS 注释）。

interface Props {
  tab: TabDef
}

export default function FormSheet({ tab }: Props) {
  const [data, setData] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  // dirty = 是否有未保存的修改；saving = 保存中；saved = 刚保存完
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  // AI 补全设定弹窗（只补空字段，已填保留）
  const [showFill, setShowFill] = useState(false)
  // AI 新增弹窗（仅「全书总纲」：起草一整份新总纲，会替换已填内容 —— 见下方 openFillNew）
  const [showFillNew, setShowFillNew] = useState(false)
  // 市场雷达弹窗（仅「作品信息」：联网检索 + 模型归纳，给选题做参考 —— 台账 #018）
  const [showRadar, setShowRadar] = useState(false)
  const formFields = useMemo<TemplateField[]>(
    () => (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
      // 力量体系：数值/境界类字段锁定，避免 AI 编崩"宪法"
      locked: tab.id === 'power' && isNumericPowerField(f),
    }))),
    // 🔴 同 CharacterSheet：读 tab.modules 就得依赖 tab 本身，只写 tab.id 会在
    //    字段结构变化时沿用旧字段表。
    [tab],
  )

  /** 仅「作品信息」页提供市场雷达（选题阶段的功能，挂到别的表单页没有意义） */
  const isPositioning = tab.id === 'positioning'

  /**
   * 「作品信息」里已有的方向 → 市场雷达的预填。
   * 🔴 按**字段名含关键词**取（「类型赛道」/「目标平台」），不写死「模块::字段」全称 ——
   *    模块名改过一次（「作品定位」→「作品信息」），写死就会静默取空。
   */
  const radarDefaults = useMemo(() => {
    const pick = (kw: string) => {
      for (const m of tab.modules ?? []) {
        for (const f of m.fields) {
          if (!f.name.includes(kw)) continue
          const v = data[`${m.name}::${f.name}`]
          if (v && v.trim()) return v.trim()
        }
      }
      return ''
    }
    return { genre: pick('赛道'), platform: pick('平台') }
  }, [tab, data])

  // AI 入口：本页签适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()
  /**
   * 「全书总纲」是**单份表单**（不像分卷 / 章节那样一条一张卡），所以这里的「AI 新增」不是
   * 「新建一条」，而是「让 AI 起草一整份新总纲」—— 与「AI 补全」的差别只在**已填字段会不会被替换**
   * （补全：不动已填；新增：整体替换，故点按钮前先确认一次）。
   * 🔴 只放 `master` 一个 id：其余表单页（作品信息 / 世界设定 / 力量体系 / 写作规范）维持原样，
   *    它们没有「一整份都推倒重来」的语义。
   */
  const isOutlineMaster = tab.id === 'master'
  const fillContext: FillContext = isOutlineMaster ? 'outline-master' : 'template'

  // 用 ref 持有最新状态，避免切换页签时因 effect 闭包过期而丢失未保存草稿
  const dataRef = useRef(data)
  const dirtyRef = useRef(dirty)
  const tabIdRef = useRef(tab.id)
  useEffect(() => { dataRef.current = data }, [data])
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  /**
   * 🔴 卸载时冲刷未保存修改。原因同 TableSheet：`App.tsx` 的「key={tab.id}」会让下面那个
   * [tab.id] 守卫里的 tabIdRef 初值即新 id，分支永不执行。
   */
  useEffect(() => () => {
    if (dirtyRef.current) void saveFormData(tabIdRef.current, dataRef.current)
  }, [])

  useEffect(() => {
    // 切到别的页签前，先把当前页签未保存的修改落库（之前会静默丢弃）
    const prevId = tabIdRef.current
    if (dirtyRef.current && prevId && prevId !== tab.id) {
      void saveFormData(prevId, dataRef.current)
    }
    tabIdRef.current = tab.id
    getFormData(tab.id).then(d => {
      setData(d)
      setLoaded(true)
      setDirty(false)
    })
  }, [tab.id])

  const setField = (path: string, value: string) => {
    setData(prev => ({ ...prev, [path]: value }))
    setDirty(true)
    setSaved(false)
  }

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await saveFormData(tab.id, data)
      setDirty(false)
      setSaved(true)
      savedTimer.current = setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setSaving(false)
    }
  }, [tab.id, data])

  // 离开页签前若有未保存，提示
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Ctrl/Cmd+S 触发保存（2.7.3：收敛到 useSaveHotkey —— 世界设定一类面板此前漏挂，按了没反应）
  useSaveHotkey(() => void save(), dirty)

  const clearAll = useCallback(() => {
    void (async () => {
      if (!await confirmDialog({ title: `清空「${tab.name}」`, message: `确定清空「${tab.name}」的全部填写内容？`, danger: true })) return
      setData({})
      setDirty(true)
    })()
  }, [tab.name])

  // AI 补全：模型只补空字段（existing 传入已填的），采用后逐字段写入
  const handleFill = (values: Record<string, string>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v && v.trim()) setField(k, v)
    }
    setShowFill(false)
  }

  /**
   * AI 新增（起草全份）：产出字段**整体写入**（已填的也会被替换）—— 与 handleFill 的差别就在这里。
   * 采用后同样只是进本地草稿（要再点「保存」才落库），但切走页签会自动冲刷，所以点按钮前先确认一次。
   */
  const handleFillNew = (values: Record<string, string>) => {
    const produced = Object.entries(values).filter(([, v]) => v && v.trim())
    if (produced.length > 0) {
      setData(prev => ({ ...prev, ...Object.fromEntries(produced) }))
      setDirty(true)
      setSaved(false)
    }
    setShowFillNew(false)
  }

  /** 已填内容非空时先确认（起草全份会替换它们，且本页没有撤销） */
  const openFillNew = async () => {
    const filled = Object.values(data).filter(v => v && v.trim()).length
    if (filled > 0 && !await confirmDialog({
      title: `AI 新增 · ${tab.name}`,
      message: `AI 会起草一整份新的${tab.name}，采用后本页已填的 ${filled} 项内容会被替换（没有撤销）。继续？`,
    })) return
    setShowFillNew(true)
  }

  if (!loaded) return <LoadingState />

  const filledCount = Object.values(data).filter(v => v && v.trim()).length
  const totalFields = tab.modules?.reduce((s, m) => s + m.fields.length, 0) ?? 0

  // 开书定位 / 大纲规划（章节总表为表格类型不受影响）模块并排铺开；其余表单在超宽屏才分两列
  const fullWidth = tab.group === '开书定位' || tab.group === '大纲规划'

  return (
    // 所有表单页一律 100% 宽度，跟随窗口自适应（模块列数按断点变化）
    <div className="w-full page-enter">
      {/* 头部 */}
      <header className="mb-5 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
              <HelpPopover title={`${tab.name} · 怎么填`} width="23rem" size={14}>
                {`${tab.description}\n\n填写要点：\n· 左侧是字段名与说明，右侧输入框直接填，内容长会自动变高；\n· 未填时下方会给出「示例：…」参考，照着改成自己的设定即可；\n· 顶部进度条显示已填 / 总项数，不必一次填满，随写随补；\n· Ctrl+S 或点「保存」落库，右下角出现浮动按钮说明还有未保存的改动；\n· 「清空」会清掉本页全部内容（不可撤销，慎用）。\n\n填完的内容会自动进入正文编辑器左侧的设定检索栏，写作时可随时速查与就地修改。`}
              </HelpPopover>
            </div>
            <p className="mt-1.5 text-13 text-ink-300 leading-relaxed max-w-3xl">{tab.description}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            <span className={`text-11 transition-opacity duration-300 ${saved ? 'opacity-100 text-success' : 'opacity-0'}`}>
              <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
            </span>
            <FieldAliasButton
              tabId={tab.id}
              tabName={tab.name}
              intro="给这一页的字段起你自己看得懂的名字。"
              targets={moduleAliasTargets(tab.modules)}
            />
            <Button onClick={clearAll} variant="danger" size="md" className="flex items-center text-danger">
              <RotateCcw size={12} /> 清空
            </Button>
          <Button variant="toggle" selected={dirty}
            onClick={save}
            disabled={!dirty || saving}
            className="font-medium hover:bg-amber/25"
            title={dirty ? '保存（Ctrl+S）' : '无未保存的改动'}
          >
            <Save size={13} /> {saving ? '保存中…' : (dirty ? '保存' : '已保存')}
          </Button>
          {aiCap !== 'none' && (
            <>
              {/* 「全书总纲」多一个「AI 新增」（起草全份）—— 单份表单没有「新建一条」的语义，
                  它与「AI 补全」的区别只在**已填字段会不会被替换**（见 openFillNew / handleFillNew）。 */}
              {isOutlineMaster && (
                <Button variant="secondary" onClick={() => void openFillNew()} disabled={!aiReady} className="flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : `提供粗略想法，让 AI 起草一整份新的${tab.name}（采用后替换本页已填内容）`}>
                  <Sparkles size={12} /> AI 新增
                </Button>
              )}
              <Button variant="secondary" onClick={() => setShowFill(true)} disabled={!aiReady} className="flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '提供粗略设定，让 AI 补全本页未填写的字段（已填的会保留）'}>
                <Sparkles size={12} /> AI 补全
              </Button>
            </>
          )}
          {/* 市场雷达（2.8.0 · 台账 #018）：选题参考工具 —— 只查公开网络 + 模型归纳，只读不写项目数据。
              不放进 aiCap 分支：它不看「本页签是否接 AI 填写」，只看模型是否已配置（弹窗内自行判断）。 */}
          {isPositioning && (
            <Button variant="secondary" onClick={() => setShowRadar(true)} className="flex items-center gap-1.5 font-medium" title="按题材 / 平台去公开网络检索，归纳趋势与机会点（仅供参考，不代写内容）">
              <Radar size={12} /> 市场雷达
            </Button>
          )}
          </div>
        </div>
        {/* 进度条 */}
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-1 bg-ink-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber/70 rounded-full transition-all duration-500"
              style={{ width: `${totalFields ? (filledCount / totalFields) * 100 : 0}%` }}
            />
          </div>
          <span className="text-10 text-ink-400 shrink-0">{filledCount} / {totalFields} 项已填</span>
        </div>
      </header>

      {/* 模块（C10：抽成 SchemaFieldGrid —— 母级表单与子世界表单共用同一份渲染，避免漂移） */}
      <SchemaFieldGrid
        modules={tab.modules!}
        data={data}
        onFieldChange={setField}
        twoColumn={fullWidth}
        tabId={tab.id}
      />

      {/* 底部提示 */}
      {tab.tips && tab.tips.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber/20 bg-amber/5 p-4">
          {tab.tips.map((tip, i) => (
            <div key={i} className="text-12 text-amber/80 leading-relaxed flex items-start gap-2">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      )}

      {/* 底部浮动保存按钮（页面很长时方便） */}
      {dirty && <SaveFab onClick={save} label="保存修改" />}

      {showFill && (
        <AITemplateFill
          fields={formFields}
          context={fillContext}
          existing={data}
          draftScope={`form::${tab.id}`}
          title={`AI 补全 · ${tab.name}`}
          sketchPlaceholder="例如：这是一个以「灵气复苏」为背景的东方玄幻世界，主角走吞噬进化路线……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}

      {showFillNew && (
        <AITemplateFill
          fields={formFields}
          context={fillContext}
          // 🔴 刻意**不传 existing** —— 这就是「起草全份」与「补全」的分界：
          //    不传 ⇒ 全部字段都由模型产出，采用时整体写入（已填的会被替换；点按钮前 openFillNew 已确认过）。
          draftScope={`form::${tab.id}`}
          title={`AI 新增 · ${tab.name}`}
          sketchPlaceholder="例如：一个废脉少年吞噬神体、逆天改命的故事，三卷走完「觉醒—复仇—封神」，反派按宗门 → 世家 → 神族逐层升级……"
          onSubmit={handleFillNew}
          onClose={() => setShowFillNew(false)}
        />
      )}

      {/* 市场雷达：输入预填作品信息已有的赛道 / 平台（打开后作者仍可改） */}
      {isPositioning && (
        <MarketRadarDialog
          open={showRadar}
          onClose={() => setShowRadar(false)}
          defaultGenre={radarDefaults.genre}
          defaultPlatform={radarDefaults.platform}
        />
      )}
    </div>
  )
}

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { TabDef } from '../lib/types'
import { getFormData, saveFormData } from '../lib/db'
import { Save, RotateCcw, Info, Check, Sparkles } from 'lucide-react'
import HelpPopover from './HelpPopover'
import AutoTextarea from './AutoTextarea'
import AITemplateFill from './AITemplateFill'
import type { TemplateField } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT, aiCapabilityOf } from '../lib/aiScope'
import { confirmDialog } from './dialogs'
import { Button } from './Button'
import { SaveFab } from './SaveFab'
import { LoadingState } from './LoadingState'

// 力量体系是升级流的"宪法"：下面这些字段是境界/数值类，绝不能让 AI 凭空编造，
// AI 补全时锁定它们，只补全文本型字段（体系名称/来源/限制规则等）。
const POWER_NUMERIC_HINTS = ['境界', '等级', '战力', '寿元', '量化', '成本', '年龄', '人口', '金字塔', '时长', '年份', '倍率', '数量', '上限', '百分比', '价格']

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
  // AI 补全设定弹窗
  const [showFill, setShowFill] = useState(false)
  const formFields = useMemo<TemplateField[]>(
    () => (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
      // 力量体系：数值/境界类字段锁定，避免 AI 编崩"宪法"
      locked: tab.id === 'power' && POWER_NUMERIC_HINTS.some(h => f.name.includes(h)),
    }))),
    // 🔴 同 CharacterSheet：读 tab.modules 就得依赖 tab 本身，只写 tab.id 会在
    //    字段结构变化时沿用旧字段表。
    [tab],
  )

  // AI 入口：本页签适用哪种能力（补全 / 整理 / 不接），以及模型是否已配置
  const aiCap = aiCapabilityOf(tab)
  const { ready: aiReady } = useAIReady()

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
    await saveFormData(tab.id, data)
    setSaving(false)
    setDirty(false)
    setSaved(true)
    savedTimer.current = setTimeout(() => setSaved(false), 1500)
  }, [tab.id, data])

  // 离开页签前若有未保存，提示
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Ctrl/Cmd+S 触发保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, save])

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

  if (!loaded) return <LoadingState />

  const filledCount = Object.values(data).filter(v => v && v.trim()).length
  const totalFields = tab.modules?.reduce((s, m) => s + m.fields.length, 0) ?? 0

  // 开书定位 / 大纲规划（章节总表为表格类型不受影响）模块并排铺开；其余表单在超宽屏才分两列
  const fullWidth = tab.group === '开书定位' || tab.group === '大纲规划'

  return (
    // 所有表单页一律 100% 宽度，跟随窗口自适应（模块列数按断点变化）
    <div className="w-full page-enter">
      {/* 头部 */}
      <header className="mb-5 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
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
            <span className={`text-11 transition-opacity duration-300 ${saved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>
              <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
            </span>
            <Button onClick={clearAll} variant="danger" size="md" className="flex items-center text-13 text-red-400">
              <RotateCcw size={12} /> 清空
            </Button>
          <Button variant="toggle" selected={dirty}
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium hover:bg-amber/25"
            title={dirty ? '保存（Ctrl+S）' : '无未保存修改'}
          >
            <Save size={13} /> {saving ? '保存中…' : (dirty ? '保存' : '已保存')}
          </Button>
          {aiCap !== 'none' && (
            <Button variant="secondary" onClick={() => setShowFill(true)} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '提供粗略设定，让 AI 补全本页未填写的字段（已填的会保留）'}>
              <Sparkles size={12} /> AI 补全
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

      {/* 模块 */}
      <div className={fullWidth
        ? 'grid grid-cols-1 xl:grid-cols-2 gap-5 items-start'
        : 'grid grid-cols-1 2xl:grid-cols-2 gap-5 items-start'}>
        {tab.modules!.map(mod => (
          <section key={mod.name} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden h-full">
            <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
              <span className="w-1 h-3.5 rounded-full bg-amber/70" />
              <h2 className="text-13 font-semibold text-ink-100">{mod.name}</h2>
              <span className="text-10 text-ink-500 ml-auto">{mod.fields.length} 项</span>
            </div>
            <div className="divide-y divide-ink-700/60">
              {mod.fields.map(field => {
                const key = `${mod.name}::${field.name}`
                const val = data[key] ?? ''
                return (
                  <div key={key} className="px-5 py-4 grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] gap-2 md:gap-4 hover:bg-ink-800/40 transition-colors">
                    <div>
                      <div className="text-13 font-medium text-ink-100">{field.name}</div>
                      {field.desc && <div className="field-desc mt-1">{field.desc}</div>}
                    </div>
                    <div>
                              <AutoTextarea
                                value={val}
                                onChange={v => setField(key, v)}
                                placeholder="点击填写…"
                                className="text-13"
                                minHeight={36}
                              />
                      {!val && field.example && (
                        <div className="field-example flex items-start gap-1 mt-1">
                          <Info size={10} className="mt-0.5 shrink-0" />
                          <span>示例：{field.example}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

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
          existing={data}
          title={`AI 补全 · ${tab.name}`}
          sketchPlaceholder="例如：这是一个以「灵气复苏」为背景的东方玄幻世界，主角走吞噬进化路线……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}
    </div>
  )
}

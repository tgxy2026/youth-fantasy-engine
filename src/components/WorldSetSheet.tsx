/**
 * 世界观 · 力量体系的「**母子结构**」面板（C10 · 2.4.2）
 *
 * 母级＝全书统一那一份（就是原来那份 `formData`，**永远喂给 AI**）；
 * 子级＝副本 / 剧本各自一套（可建多项），每项一个「活跃 / 已完结」开关，
 * **只有活跃的子世界才进 AI 上下文**（已完结的留着可查，但不再发给模型）。
 *
 * 布局：左列＝层选择（母级固定项 + 子世界列表），右列＝选中那一层的字段表单。
 * 字段渲染与母级表单共用 `SchemaFieldGrid`，所以两层样式与口径完全一致。
 *
 * 🔴 三条容易做错的地方：
 *   ① **切层前必须先把当前层的草稿落库**（与 FormSheet「切页签先保存」同范式）——
 *      漏了就是「在母级改了字，点去子世界，回来发现改动没了」；
 *   ② **始终标出"现在在编辑哪一层"**（右列头部 + 左列高亮 + 两层不同底色边框）——
 *      母级与子级有同名字段（如两边都有「世界名称」），不标清楚作者必然填错层；
 *   ③ 子项的活跃开关照旧走 `db.setSubActive`（**不要自己拼 settingsKV**）——
 *      删除子项时清理活跃列表的逻辑在存储层，绕过去就会留下幽灵 id。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, Globe2, Layers, Pencil, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import type { CardRecord, TabDef } from '../lib/types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { splitActive } from '../lib/worldSets'
import { POWER_NUMERIC_HINTS } from '../lib/schema'
import { useAIReady } from '../lib/useAIReady'
import type { TemplateField } from '../lib/ai'
import { confirmDialog, showToast } from './dialogs'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import PromptModal from './PromptModal'
import SchemaFieldGrid from './SchemaFieldGrid'
import AITemplateFill from './AITemplateFill'
import AIDataSourceNote from './AIDataSourceNote'
import { LoadingState } from './LoadingState'
// 界面缩放（<html> zoom）下 vh 不缩水 ⇒ 内联长度一律走 foldVh（项目红线）
import { foldVh } from '../lib/theme'

/** 选中「母级」的哨兵值（子项用的是真实 id） */
const MAIN = '__main__'

interface Props {
  tab: TabDef
}

export default function WorldSetSheet({ tab }: Props) {
  const { ready: aiReady } = useAIReady()
  const [loading, setLoading] = useState(true)
  const [main, setMain] = useState<Record<string, string>>({})
  const [subs, setSubs] = useState<CardRecord[]>([])
  const [activeIds, setActiveIds] = useState<string[]>([])
  const [sel, setSel] = useState<string>(MAIN)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null)
  const [showFill, setShowFill] = useState(false)

  // 包一层 useMemo：`tab.modules ?? []` 每次渲染都是新数组，直接当下游 useMemo 的依赖会次次失效
  const modules = useMemo(() => tab.modules ?? [], [tab.modules])
  const templates = useMemo<TemplateField[]>(
    () => modules.flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
      // 与母级同一套判据：境界/数值类字段锁死（见 lib/schema 的 POWER_NUMERIC_HINTS）
      locked: tab.id === 'power' && POWER_NUMERIC_HINTS.some(h => f.name.includes(h)),
    }))),
    [modules, tab.id],
  )
  const totalFields = templates.length
  const filledCount = Object.values(draft).filter(v => v && v.trim()).length

  const load = useCallback(async () => {
    const [m, s, a] = await Promise.all([
      db.getFormData(tab.id).catch(() => ({})),
      db.getSubSets(tab.id).catch(() => [] as CardRecord[]),
      db.getActiveSubIds(tab.id).catch(() => []),
    ])
    setMain(m)
    setSubs(s)
    setActiveIds(a)
    setDraft(m)
    setLoading(false)
  }, [tab.id])
  useEffect(() => { void load() }, [load])

  /**
   * 🔴 离开页签时把未保存的草稿落库（与 FormSheet 的 tabIdRef 范式同构）。
   *
   * 为什么必须有：本组件比 FormSheet 更容易丢字 —— 作者在子世界里写了一段，
   * 直接点左侧别的页签，组件卸载 ⇒ 只存在 state 里的草稿就没了（实机抓到过：
   * 在子世界填了内容 → 切页签 → 回来发现子世界还是空的）。
   * 用 ref 持有最新值，是因为 cleanup 闭包里的 state 是**挂载那一刻**的旧值。
   */
  const dirtyRef = useRef(dirty)
  const draftRef = useRef(draft)
  const selRef = useRef(sel)
  const subsRef = useRef(subs)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { selRef.current = sel }, [sel])
  useEffect(() => { subsRef.current = subs }, [subs])
  useEffect(() => () => {
    if (!dirtyRef.current) return
    const d = draftRef.current
    const cur = selRef.current
    if (cur === MAIN) void db.saveFormData(tab.id, d)
    else {
      const sub = subsRef.current.find(s => s.id === cur)
      if (sub) void db.saveSubSet(tab.id, { ...sub, data: d })
    }
  }, [tab.id])

  const isMain = sel === MAIN
  const selSub = useMemo(() => subs.find(s => s.id === sel), [subs, sel])
  // 活跃列表里可能残留已删除子项的 id（跨设备删除）⇒ 一律经 splitActive 过滤后再用
  const { active } = useMemo(() => splitActive(subs, activeIds), [subs, activeIds])

  /** 把当前层的草稿落库（切层 / 点保存 / 卸载前都走它） */
  const flush = useCallback(async (silent = false) => {
    if (!dirty) return
    setSaving(true)
    try {
      if (isMain) {
        await db.saveFormData(tab.id, draft)
        setMain(draft)
      } else if (selSub) {
        await db.saveSubSet(tab.id, { ...selSub, data: draft })
        setSubs(prev => prev.map(s => (s.id === sel ? { ...s, data: draft } : s)))
      }
      setDirty(false)
      if (!silent) { setSaved(true); setTimeout(() => setSaved(false), 1500) }
    } catch {
      showToast('保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }, [dirty, isMain, selSub, sel, draft, tab.id])

  const selectLayer = async (key: string) => {
    if (key === sel) return
    await flush(true)     // 🔴 先落库再切（否则这一层刚改的字会丢）
    setSel(key)
    setDraft(key === MAIN ? main : (subs.find(s => s.id === key)?.data ?? {}))
    setDirty(false)
  }

  const setField = (key: string, value: string) => {
    setDraft(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const addSub = async (name: string) => {
    const n = name.trim()
    if (!n) return
    const rec: CardRecord = {
      id: uid(), projectId: '', tabId: '', name: n, data: {}, order: subs.length,
    } as CardRecord
    await db.saveSubSet(tab.id, rec)
    // 🔴 新建即设为「活跃」：作者刚建一个子世界，显然是要写它。
    //    默认给「已完结」的话，他填了半天字却发现 AI 根本没读（提示条还写着"没有活跃子世界"）。
    await db.setSubActive(tab.id, rec.id, true)
    setSubs(prev => [...prev, rec])
    setActiveIds(await db.getActiveSubIds(tab.id))
    setSel(rec.id)
    setDraft({})
    setDirty(false)
    showToast(`已新增子世界「${n}」（已设为活跃，会一起发给 AI）`, 'success')
  }

  const renameSub = async (name: string) => {
    const n = name.trim()
    if (!n || !selSub) return
    const next = { ...selSub, name: n }
    await db.saveSubSet(tab.id, next)
    setSubs(prev => prev.map(s => (s.id === sel ? next : s)))
  }

  const dropSub = async () => {
    if (!selSub) return
    const yes = await confirmDialog({
      title: '删除子世界',
      message: `确定删除「${selSub.name}」？\n它的全部设定会一起删掉，且不可撤销。`,
      confirmText: '删除',
      danger: true,
    })
    if (!yes) return
    await db.deleteSubSet(tab.id, selSub.id)     // 存储层同时清活跃列表
    setSubs(prev => prev.filter(s => s.id !== selSub.id))
    setActiveIds(await db.getActiveSubIds(tab.id))
    setSel(MAIN)
    setDraft(main)
    setDirty(false)
  }

  const toggleActive = async (id: string, on: boolean) => {
    await db.setSubActive(tab.id, id, on)
    setActiveIds(await db.getActiveSubIds(tab.id))
  }

  if (loading) return <LoadingState />
  if (!modules.length) return <div className="p-8 text-13 text-ink-400">这个页签没有可填的字段。</div>

  return (
    <div className="w-full page-enter">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
          <HelpPopover title={`${tab.name} · 母子结构怎么用`} width="24rem" size={14}>
            {`这个页签分两层：\n\n`
              + `· 【母级】全书统一 —— 整本书只有一个，写这套设定的顶层规则（世界底层法则 / 统一等级总纲）。`
              + `它永远会发给 AI。\n`
              + `· 【子世界】—— 每个副本 / 剧本 / 世界线一套，可以建多项。每项有一个开关：`
              + `「活跃」（当前故事聚焦在它）或「已完结」（写过、不再聚焦）。\n`
              + `· 🔴 只有活跃的子世界才会发给 AI。已完结的留在库里随时可查，但不再占用模型的注意力 ——`
              + `这就是"多套设定互相打架"的防法。\n`
              + `· 左列点一下就切换编辑对象；右列表单顶部始终标着你现在在填哪一层，`
              + `两层的字段是一样的，别填错层。\n\n`
              + `${tab.description ?? ''}`}
            <AIDataSourceNote feature={tab.id} />
          </HelpPopover>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="toggle" selected={dirty} disabled={!dirty || saving}
              onClick={() => void flush()} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium hover:bg-amber/25"
              title={dirty ? '保存（先落库再切换层，不怕丢）' : '无未保存的改动'}
            >
              <Save size={13} /> {saving ? '保存中…' : saved ? <><Check size={13} /> 已保存</> : '保存'}
            </Button>
            <Button variant="secondary" onClick={() => setShowFill(true)} disabled={!aiReady}
              className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium disabled:opacity-40"
              title={aiReady ? '提供粗略设定，让 AI 补全当前这一层未填的字段' : '还没接入模型'}
            >
              <Sparkles size={12} /> AI 补全
            </Button>
          </div>
        </div>

        {/* AI 会读到什么（把"只有活跃的才喂"摆到明面） */}
        <div className="mt-2">
          {active.length >= 3 ? (
            <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-11 leading-relaxed text-ink-200">
              当前有 <b className="text-amber">{active.length}</b> 个子世界处于活跃状态，会一起发给 AI。
              套数越多越容易写串 —— 写完这一卷，记得把已完结的关掉。
            </div>
          ) : (
            <div className="text-11 text-ink-500">
              {active.length === 0
                ? '当前没有活跃子世界，AI 只会读到「全书统一」这一层。'
                : `AI 会读到：全书统一 + 当前活跃的 ${active.length} 个子世界（${active.map(s => s.name).join('、')}）。`}
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        {/* ---------- 左列：层选择 ----------
            ⚠️ 刻意用 div 而不是 aside：页面里已经有一个 aside（左侧主导航栏），
            再来一个同为 aside 的容器，无论是无障碍语义还是脚本/调试都会互相混淆。 */}
        <div className="w-full lg:w-56 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
          <div className="px-3 py-2 text-10 text-ink-500 border-b border-ink-700">全书统一（母级）</div>
          <button
            onClick={() => void selectLayer(MAIN)}
            title="编辑全书统一的设定（这一层永远发给 AI）"
            className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-12 transition-colors ${
              isMain ? 'bg-amber/10 text-amber' : 'text-ink-200 hover:bg-ink-800'
            }`}
          >
            <BookOpen size={13} className="shrink-0" />
            <span className="truncate">{tab.name}</span>
            <span className="ml-auto shrink-0 rounded border border-amber/40 bg-amber/10 px-1 text-9 text-amber">全书</span>
          </button>

          <div className="px-3 py-2 text-10 text-ink-500 border-y border-ink-700 flex items-center gap-1">
            子世界
            <span className="text-ink-600">（{subs.length}）</span>
            <span className="ml-auto text-ink-600">活跃 {active.length}</span>
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: foldVh('46vh') }}>
            {subs.length === 0 && (
              <div className="px-3 py-3 text-11 text-ink-600 leading-relaxed">
                还没有子世界。<br />如果这本书只在一个世界里发生，就不用建。
              </div>
            )}
            {subs.map(s => {
              const on = activeIds.includes(s.id)
              const isSel = sel === s.id
              return (
                <div key={s.id}
                  className={`group flex items-center gap-1.5 px-3 py-2 text-12 transition-colors ${
                    isSel ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-800/60'
                  }`}
                >
                  {/* 活跃开关（点它切状态；点名字切编辑对象） */}
                  <button
                    onClick={() => void toggleActive(s.id, !on)}
                    title={on ? '活跃中（点一下标为已完结，AI 就不再读它）' : '已完结（点一下改为活跃）'}
                    className={`shrink-0 w-3 h-3 rounded-full border transition-colors ${
                      on ? 'bg-amber border-amber' : 'border-ink-500 hover:border-amber'
                    }`}
                  />
                  <button onClick={() => void selectLayer(s.id)}
                    title={`编辑子世界「${s.name}」（${on ? '活跃 · 会发给 AI' : '已完结 · 不发给 AI'}）`}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className={`block truncate ${isSel ? 'text-ink-100' : ''}`}>{s.name}</span>
                    <span className="text-10 text-ink-600">{on ? '活跃' : '已完结'}</span>
                  </button>
                </div>
              )
            })}
          </div>

          <button onClick={() => setNaming('new')}
            className="w-full flex items-center gap-1.5 px-3 py-2.5 text-12 text-ink-300 hover:bg-ink-800 border-t border-ink-700 transition-colors"
          >
            <Plus size={12} /> 新增子世界
          </button>
        </div>

        {/* ---------- 右列：当前层的表单 ---------- */}
        <div className="flex-1 min-w-0">
          <div className={`mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 ${
            isMain ? 'border-amber/30 bg-amber/5' : 'border-ink-600 bg-ink-800/40'
          }`}>
            {isMain ? <BookOpen size={12} className="text-amber" /> : <Globe2 size={12} className="text-ink-300" />}
            <span className="text-11 text-ink-200">
              {isMain ? <>正在填：<b className="text-amber">【母级】全书统一</b>（永远发给 AI）</> : <>正在填：<b className="text-ink-100">【子世界】{selSub?.name}</b>（{activeIds.includes(sel || '') ? '活跃 · 会发给 AI' : '已完结 · 不发给 AI'}）</>}
            </span>
            <span className="ml-auto text-10 text-ink-500 tabular-nums">{filledCount} / {totalFields} 项已填</span>
            {!isMain && selSub && (
              <>
                <Button variant="icon-muted" size="sm" onClick={() => setNaming('rename')} title="改名字">
                  <Pencil size={11} />
                </Button>
                <Button variant="icon-danger" size="sm" onClick={() => void dropSub()} title="删除这个子世界">
                  <Trash2 size={11} />
                </Button>
              </>
            )}
          </div>

          {!isMain && selSub && !activeIds.includes(selSub.id) && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2 text-11 text-ink-400">
              <Layers size={11} className="shrink-0" />
              这个子世界是「已完结」——留档可查，但不会发给 AI。要让它参与，点左列它左边的圆点。
            </div>
          )}

          <div className={isMain ? 'border-l-2 border-amber/40 pl-3' : 'border-l-2 border-ink-600 pl-3'}>
            <SchemaFieldGrid modules={modules} data={draft} onFieldChange={setField} />
          </div>

          {tab.tips && tab.tips.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber/20 bg-amber/5 p-4">
              <div className="text-11 text-ink-300 leading-relaxed">
                {tab.tips.map((t, i) => <div key={i}>· {t}</div>)}
              </div>
            </div>
          )}
        </div>
      </div>

      <PromptModal
        open={naming !== null}
        title={naming === 'rename' ? '改子世界名字' : '新增子世界'}
        label="子世界名称"
        defaultValue={naming === 'rename' ? selSub?.name ?? '' : ''}
        placeholder="例：主神空间 / 三国乱世 / 末日废土"
        onSubmit={name => {
          // ⚠️ PromptModal 自己不关弹窗，必须在这里关（漏了会挡住后续点击）
          const mode = naming
          setNaming(null)
          if (mode === 'rename') void renameSub(name)
          else void addSub(name)
        }}
        onCancel={() => setNaming(null)}
      />

      {showFill && (
        <AITemplateFill
          fields={templates}
          existing={draft}
          title={`AI 补全 · ${isMain ? '全书统一（母级）' : `子世界「${selSub?.name ?? ''}」`}`}
          sketchPlaceholder={isMain
            ? '例如：这是一个以「灵气复苏」为背景的东方玄幻世界，主角走吞噬进化路线……'
            : '例如：这个副本是一个三国背景的武侠世界，主角在此只能动用肉身武力……'}
          onSubmit={values => {
            // 与 FormSheet 同款：只采纳非空值（AI 没填的字段保持原样）
            for (const [k, v] of Object.entries(values)) if (v && v.trim()) setField(k, v)
            setShowFill(false)
          }}
          onClose={() => setShowFill(false)}
        />
      )}
    </div>
  )
}

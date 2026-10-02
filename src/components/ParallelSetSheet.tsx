/**
 * 制度四页签（政治 / 经济 / 信仰 / 司法）的「**并列结构**」面板（2.7.2 · 主人定案）
 *
 * ## 与 WorldSetSheet 的关系
 * 两者**共用同一套存储与机制**（`cardRecords` 的 `<tabId>-sub` + `worldSubActive::<tabId>` 活跃态
 * + 每条一份草稿箱），差别只有一处，但那一处是本质的：
 *
 * | | WorldSetSheet（母子） | 本组件（并列） |
 * |---|---|---|
 * | 左列第一行 | 「全书统一（母级）」——图钉死、不可删、永远发 AI | **没有这一行** |
 * | 条目身份 | 母级的子级 | **平铺的一条**，彼此无隶属 |
 * | 母级 formData | 读写 `db.getFormData(tabId)` | **完全不碰**（本结构没有母级） |
 * | 「新增」按钮 | 新增子世界 / 新增子体系 | **「新增」**（条目不再从属于什么） |
 * | AI 段标题 | `〖全书统一〗` ＋ `〖子世界（活跃 x/y）〗` | 只有 `〖政权（活跃 x/y）〗`（无「全书统一」层） |
 *
 * 🔴 **为什么单独建组件而不是给 WorldSetSheet 加个 prop**：
 *   母级那一层渗透在**读取、保存、切层、卸载落库、右列头部、AI 段拼接**六处，
 *   塞布尔开关会得到一个到处 `if (hasMain)` 的组件 —— 比复制一份更难读也更容易漏。
 *   机制共用（存储 / 活跃态 / 草稿箱 / 数值锁定都已参数化），复制的只有**界面骨架**。
 *
 * ## 保留的能力（主人明确要求）
 * · **活跃开关**：每条一个圆点，「活跃 / 已完结」控制是否发给 AI（并列下同样有用 ——
 *   「已完结的政权不再发 AI」这条能力不因扁平化而消失）。
 * · **草稿箱**：每条一份，切条 / 卸载前自动落库。
 * · **数值字段锁定**：power 页的数值锁定逻辑对本结构无意义（制度页本就无 numeric 字段），故不接。
 * · **AI 补全 / AI 数据源说明**：都在，照挂。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Globe2, Layers, NotebookPen, Pencil, Plus, Save, Trash2, Wand2 } from 'lucide-react'
import type { CardRecord, TabDef } from '../lib/types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { FREE_DRAFT_KEY, isInternalFieldKey, splitActive } from '../lib/worldSets'
import { addButtonLabel, modulesFor, subItemLabel, getActivePack } from '../lib/schemaTemplates'
import AutoTextarea from './AutoTextarea'
import HelpPopover from './HelpPopover'
import PromptModal from './PromptModal'
import SchemaFieldGrid from './SchemaFieldGrid'
import AITemplateFill from './AITemplateFill'
import AIDataSourceNote from './AIDataSourceNote'
import { LoadingState } from './LoadingState'
import { confirmDialog, showToast } from './dialogs'
import { Button } from './Button'
import { useAIReady } from '../lib/useAIReady'
import type { TemplateField } from '../lib/ai'
import { foldVh } from '../lib/theme'

export default function ParallelSetSheet({ tab }: { tab: TabDef }) {
  const [subs, setSubs] = useState<CardRecord[]>([])
  const [activeIds, setActiveIds] = useState<string[]>([])
  /** 当前选中的条目 id（空串 = 还没选，界面给一个引导态） */
  const [sel, setSel] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [naming, setNaming] = useState<'new' | 'rename' | ''>('')
  const [showFill, setShowFill] = useState(false)
  // 🔴 2.7.2：题材改在**新建项目**时选，页签内不再提供切换 ⇒ 不需要 setState，
  //    `getActivePack()` 读一次即可（App 打开项目时会按 `Project.genre` 设好全局值）。
  const pack = getActivePack()
  const aiReady = useAIReady()

  /** 条目总称（政治页→「政权」、经济→「行业」…）—— 用于列表标题、AI 段标题、帮助文案 */
  const subLabel = subItemLabel(tab.id, pack)
  /** 「新增」按钮文案：制度四页签一律「新增」（主人 2.7.2 定案） */
  const addLabel = addButtonLabel(tab.id)
  /** 新建时的输入框举例（按条目总称给 Examples，避免笼统的「名称」） */
  const namePlaceholder = `例：${tab.id === 'politics' ? '大燕 / 魏 / 蜀' : tab.id === 'economy' ? '江南商会 / 北境盐业' : tab.id === 'belief' ? '正一教 / 影宗' : '大魏律 / 宗族法'}`
  /**
   * 问号气泡里的举例句（2.7.2）：原先硬编码「政治页可以建魏蜀吴」，
   * 拿到经济 / 信仰 / 司法页就不贴切了 ⇒ 改成**按页签**各给一句。
   */
  const itemExample = tab.id === 'politics' ? '比如建「魏」「蜀」「吴」，各自写自己的权力结构。'
    : tab.id === 'economy' ? '比如建「江南商会」「北境盐业」，各自写自己的生意与盘子。'
    : tab.id === 'belief' ? '比如建「正一教」「影宗」，各自写自己的教义与组织。'
    : '比如建「大魏律」「某宗族法」，各自写自己那套规矩。'

  // 包一层 useMemo：模块随题材包变，依赖 [tab.id, pack]（不是 `tab.modules` —— 那是个 getter，每次读都是活值）
  // 🔴 `?? []` 兜底：`modulesFor` 返回 `FormModule[] | undefined`（页面下方另有「没有可填字段」的空态）
  const modules = useMemo(() => modulesFor(tab.id, pack) ?? [], [tab.id, pack])
  /** AI 补全用的字段模板（key = `模块::字段`，与表单落库的键同名） */
  const templates = useMemo<TemplateField[]>(
    () => modules.flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
    }))),
    [modules],
  )

  const load = useCallback(async () => {
    const s = await db.getSubSets(tab.id)
    const a = await db.getActiveSubIds(tab.id)
    setSubs(s)
    setActiveIds(a)
    setLoading(false)
  }, [tab.id])
  useEffect(() => { void load() }, [load])

  /**
   * 🔴 离开页签时把未保存的草稿落库（与 WorldSetSheet / FormSheet 同一范式）。
   * 这里比母子版更必要 —— 制度页签动辄三四条，作者填一条、切页签是常态。
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
    const cur = selRef.current
    const sub = subsRef.current.find(s => s.id === cur)
    if (sub) void db.saveSubSet(tab.id, { ...sub, data: draftRef.current })
  }, [tab.id])

  const selSub = useMemo(() => subs.find(s => s.id === sel), [subs, sel])
  // 活跃列表里可能残留已删除条目的 id（跨设备删除）⇒ 一律经 splitActive 过滤后再用
  const { active } = useMemo(() => splitActive(subs, activeIds), [subs, activeIds])

  /** 把当前条目的草稿落库（切条 / 点保存 / 卸载前都走它） */
  const flush = useCallback(async (silent = false) => {
    if (!dirty || !selSub) return
    setSaving(true)
    try {
      await db.saveSubSet(tab.id, { ...selSub, data: draft })
      setSubs(prev => prev.map(s => (s.id === sel ? { ...s, data: draft } : s)))
      setDirty(false)
      if (!silent) { setSaved(true); setTimeout(() => setSaved(false), 1500) }
    } catch {
      showToast('保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }, [dirty, selSub, sel, draft, tab.id])

  const setField = (key: string, value: string) => {
    setDraft(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const selectSub = async (id: string) => {
    if (id === sel) return
    await flush(true)                 // 🔴 先落库再切（否则刚改的字会丢）
    setSel(id)
    setDraft(subs.find(s => s.id === id)?.data ?? {})
    setDirty(false)
  }

  /** 新建一条（并列结构：没有母级，创建后即选中并可编辑） */
  const addSub = async (name: string) => {
    const n = name.trim()
    if (!n) return
    const rec: CardRecord = { id: uid(), projectId: '', tabId: '', name: n, data: {}, order: subs.length } as CardRecord
    await db.saveSubSet(tab.id, rec)
    await db.setSubActive(tab.id, rec.id, true)   // 新建即活跃
    setSubs(prev => [...prev, rec])
    setActiveIds(await db.getActiveSubIds(tab.id))
    setSel(rec.id)
    setDraft({})
    setDirty(false)
    showToast(`已新增「${n}」（已设为活跃，会一起发给 AI）`, 'success')
  }

  const renameSub = async (name: string) => {
    const n = name.trim()
    if (!n || !selSub) return
    await db.saveSubSet(tab.id, { ...selSub, name: n })
    setSubs(prev => prev.map(s => (s.id === selSub.id ? { ...s, name: n } : s)))
    showToast(`已改名为「${n}」`, 'success')
  }

  const delSub = async () => {
    if (!selSub) return
    const ok = await confirmDialog({
      title: `删除「${selSub.name}」`,
      message: [
        `删掉之后这一条的设定内容也会一起没了，且无法撤销。`,
        `（如果只是想让它不再发给 AI，把它标成「已完结」就够了 —— 内容还留着。）`,
      ].join('\n'),
      danger: true,
    })
    if (!ok) return
    await flush(true)                              // 🔴 先把草稿落库（它即将随这条一起被删）
    await db.deleteSubSet(tab.id, selSub.id)
    const rest = await db.getSubSets(tab.id)
    setSubs(rest)
    setActiveIds(await db.getActiveSubIds(tab.id))
    setSel(rest[0]?.id ?? '')
    setDraft(rest[0]?.data ?? {})
    setDirty(false)
    showToast(`已删除「${selSub.name}」`, 'success')
  }

  const toggleActive = async (id: string, on: boolean) => {
    await db.setSubActive(tab.id, id, on)
    setActiveIds(await db.getActiveSubIds(tab.id))
  }

  /**
   * 「从《世界设定》新建」（2.7.2 · 由原「同步子项清单」改名并改语义）。
   *
   * 🔴 改名理由：原按钮做的是**双向对齐**（名称/顺序/活跃态都跟着基准走），
   *   而那套语义依赖「母级 + 子项」的层级感。改成并列后，页签之间的层级关系没了，
   *   「对齐」变成一个容易误伤的批量操作（会把作者手动排的顺序改回去）。
   *   现在的定位更清晰：**只补缺**（把《世界设定》里有的条目在这里建出空壳，内容各填各的），
   *   绝不改动已存在的条目，也不覆盖活跃态。
   */
  const createFromWorldbase = async () => {
    const base = await db.getSubSets('worldbase').catch(() => [] as CardRecord[])
    if (!base.length) {
      showToast('《世界设定》还没有子项 —— 先在那里把清单建好，再来新建', 'info')
      return
    }
    const byName = new Map(subs.map(s => [s.name, s]))
    let created = 0
    for (const b of base) {
      if (byName.has(b.name)) continue          // 同名已存在 ⇒ 绝不动它
      const rec = { id: uid(), projectId: '', tabId: '', name: b.name, data: {}, order: subs.length + created } as CardRecord
      await db.saveSubSet(tab.id, rec)
      byName.set(b.name, rec)
      created++
    }
    setSubs(await db.getSubSets(tab.id))
    setActiveIds(await db.getActiveSubIds(tab.id))
    showToast(
      created > 0
        ? `已从《世界设定》新建 ${created} 个条目（内容还是空的，逐个填）`
        : '这里的条目都齐了，没有需要新建的',
      'success',
    )
  }

  if (loading) return <LoadingState />
  if (!modules.length) return <div className="p-8 text-13 text-ink-400">这个页签没有可填的字段。</div>

  return (
    <div className="w-full page-enter">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
          <HelpPopover title={`${tab.name} · 怎么用`} width="24rem" size={14}>
            {`这个页签是**并列**结构 —— 没有「全书统一」那一层，直接一条一条建：\n\n`
              + `· 点下面的「${addLabel}」新建一条，每条一个名称 + 一份表单。`
              + `${itemExample}各自写各自的。\n`
              + `· 每条有一个开关：「活跃」（当前故事聚焦在它）或「已完结」（写过、不再聚焦）。\n`
              + `· 🔴 只有活跃的条目才会发给 AI。已完结的留在库里随时可查，但不再占用模型的注意力 —— `
              + `多条设定就不会互相打架。\n`
              + `· 左列点一下切换编辑对象，右列表单顶部标着你现在在填哪一条。\n\n`
              + `📌 字段说明与示例会随你在新建项目时选的**作品题材**变化（现在这套是「${pack}」）。\n\n`
              + `${tab.description ?? ''}\n\n`
              /* 🔴 2.7.2：把 INSTITUTION_META.tips 真正显示出来（此前它挂在 TabDef 上却没人读） */
              + (tab.tips ?? []).map(t => `${t}\n`).join('\n')}
            <AIDataSourceNote feature={tab.id} />
          </HelpPopover>
        </div>
      </header>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        {/* ---------- 左列：条目列表（🔴 没有母级行，第一行就是列表标题）---------- */}
        <div className="w-full lg:w-56 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
          <div className="px-3 py-2 text-10 text-ink-500 border-b border-ink-700 flex items-center gap-1">
            {subLabel}
            <span className="text-ink-600">（{subs.length}）</span>
            <span className="ml-auto text-ink-600">活跃 {active.length}</span>
          </div>

          <button onClick={() => void createFromWorldbase()}
            title="把《世界设定》里已有的条目在这里建出空壳（只补缺，不动已有条目，内容各自填）"
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-10 text-ink-400 hover:bg-ink-800 border-b border-ink-700 transition-colors"
          >
            <Layers size={11} /> 从《世界设定》新建
          </button>

          <div className="overflow-y-auto" style={{ maxHeight: foldVh('52vh') }}>
            {subs.length === 0 && (
              <div className="px-3 py-3 text-11 text-ink-600 leading-relaxed">
                还没有{subLabel}。<br />点下面的「{addLabel}」建第一条。
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
                  <button onClick={() => void selectSub(s.id)}
                    title={`编辑「${s.name}」（${on ? '活跃 · 会发给 AI' : '已完结 · 不发给 AI'}）`}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="block truncate">{s.name}</span>
                  </button>
                  {/* U-4 · 2.6.0：hover 显形的一组行内小按钮（对齐 SelectRow 的做法） */}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button onClick={() => setNaming('rename')}
                      title="改名"
                      className="rounded p-0.5 text-ink-500 hover:text-ink-200"
                    >
                      <Pencil size={11} />
                    </button>
                    <button onClick={() => void delSub()}
                      title="删除这一条"
                      className="rounded p-0.5 text-ink-500 hover:text-red-400"
                    >
                      <Trash2 size={11} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>

          <button onClick={() => setNaming('new')}
            className="w-full flex items-center gap-1.5 px-3 py-2.5 text-12 text-ink-300 hover:bg-ink-800 border-t border-ink-700 transition-colors"
          >
            <Plus size={12} /> {addLabel}
          </button>
        </div>

        {/* ---------- 右列：当前条目的表单 ---------- */}
        <div className="flex-1 min-w-0">
          {!selSub ? (
            <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-8 text-center text-12 text-ink-500">
              左边点一条来编辑，或点「{addLabel}」新建一条。
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-800/40 px-3 py-2">
                <Globe2 size={12} className="text-ink-300" />
                <span className="text-12 text-ink-200">正在填：{selSub.name}</span>
                {!activeIds.includes(selSub.id) && (
                  <span className="rounded border border-ink-600 px-1 text-9 text-ink-400">已完结 · 不发 AI</span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <Button size="xs" variant="secondary"
                    onClick={() => setNaming('rename')}
                    title="给这一条改名"
                  >
                    <Pencil size={11} /> 改名
                  </Button>
                  <Button size="xs" variant="secondary"
                    onClick={() => void delSub()}
                    title="删除这一条"
                  >
                    <Trash2 size={11} /> 删除
                  </Button>
                </span>
              </div>

              <SchemaFieldGrid modules={modules} data={draft} onFieldChange={setField} />

              {/* 草稿箱（每条一份，与母子版同机制） */}
              <div className="mt-4 rounded-xl border border-ink-700 bg-ink-850/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-11 text-ink-400">
                  <NotebookPen size={12} />
                  <span>设定草稿箱</span>
                  <span className="text-ink-600">（这一条里没填完的零碎，先存这儿；不发给 AI）</span>
                </div>
                <AutoTextarea
                  value={draft[FREE_DRAFT_KEY] ?? ''}
                  onChange={v => setField(FREE_DRAFT_KEY, v)}
                  placeholder="随手记点还没想好怎么归类的设定…"
                  minRows={4}
                />
                {Object.keys(draft).filter(k => !isInternalFieldKey(k)).length > 0 && (
                  <div className="mt-1.5 text-10 text-ink-600">
                    已填 {Object.keys(draft).filter(k => !isInternalFieldKey(k)).length} 项
                  </div>
                )}
              </div>

              {/* 底部：AI 补全 + 保存 */}
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="secondary"
                  onClick={() => setShowFill(true)}
                  disabled={!aiReady}
                  title={aiReady ? '让 AI 按字段模板给这一条补一份草稿' : '还没配置可用的模型'}
                >
                  <Wand2 size={12} /> AI 补全
                </Button>
                <Button size="sm" variant="primary"
                  onClick={() => void flush()}
                  disabled={!dirty || saving}
                  title="把这一条的改动存进库"
                >
                  {saving ? <Save size={12} /> : saved ? <Check size={12} /> : <Save size={12} />}
                  {saved ? '已保存' : dirty ? '保存这一条' : '已存'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* AI 补全（弹窗式：与 WorldSetSheet 同款用法） */}
      {showFill && selSub && (
        <AITemplateFill
          fields={templates}
          existing={draft}
          title={`AI 补全 · 「${selSub.name}」`}
          sketchPlaceholder={`例如：这是一个${subLabel}，它的权力结构、关键人物、与相邻${subLabel}的关系……`}
          onSubmit={values => {
            // 与 FormSheet 同款：只采纳非空值（AI 没填的字段保持原样）
            for (const [k, v] of Object.entries(values)) if (v && v.trim()) setField(k, v)
            setShowFill(false)
          }}
          onClose={() => setShowFill(false)}
        />
      )}

      <PromptModal
        open={naming !== ''}
        title={naming === 'rename' ? `给「${selSub?.name ?? ''}」改名` : addLabel}
        label="名称"
        defaultValue={naming === 'rename' ? selSub?.name ?? '' : ''}
        placeholder={namePlaceholder}
        onSubmit={name => {
          // ⚠️ PromptModal 自己不关弹窗，必须在这里关（漏了会挡住后续点击）
          const mode = naming
          setNaming('')
          if (mode === 'rename') void renameSub(name)
          else void addSub(name)
        }}
        onCancel={() => setNaming('')}
      />
    </div>
  )
}

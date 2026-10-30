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
import { BookOpen, Copy, Globe2, Layers, NotebookPen, Pencil, Plus, Save, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { useManualDraftSave } from '@/components/common/useManualDraftSave'
import DraftSaveFeedback from '@/components/common/DraftSaveFeedback'
import { captureStorageWriteOwner } from '@/lib/storage/writeOwner'
import { captureCandidateOwner } from '@/lib/ai/candidateContext'
import type { CardRecord, TabDef } from '@/lib/types'
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { FREE_DRAFT_KEY, isInternalFieldKey, splitActive } from '@/lib/world/worldSets'
import { isNumericPowerField } from '@/lib/schema'
import { addButtonLabel, getActivePack, modulesFor, subItemLabel } from '@/lib/schemaTemplates/index'
import { useAIReady } from '@/lib/ai/useAIReady'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import type { TemplateField } from '@/lib/ai'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { useFrozenDetailScroll } from '@/components/common/useFrozenDetailScroll'
import AutoTextarea from '@/components/common/AutoTextarea'
import HelpPopover from '@/components/common/HelpPopover'
import PromptModal from '@/components/dialogs/PromptModal'
import SchemaFieldGrid from '@/components/common/SchemaFieldGrid'
import FieldAliasButton, { moduleAliasTargets } from '@/components/sheets/FieldAliasButton'
import { buildSiblingContext } from '@/lib/creative/interview'
import AITemplateFill from '@/components/ai/AITemplateFill'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import { LoadingState } from '@/components/common/LoadingState'
import SelectRow from '@/components/common/SelectRow'

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
  const pidRef = useRef(db.getCurrentProjectId())
  const [storageOwner] = useState(() => captureStorageWriteOwner(pidRef.current))
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null)
  const [showFill, setShowFill] = useState(false)
  /** 「AI 整理」= 拿草稿箱里那一段去填上方字段（与 showFill 的区别只是草稿已备好） */
  const [showOrganize, setShowOrganize] = useState(false)
  /**
   * 当前项目的题材包（2.7.2 起**只读**）。
   *
   * 🔴 题材改在「新建小说项目」时选，页签里不再提供切换 —— 所以这里不需要 setState，
   *    `getActivePack()` 读一次即可（App 打开项目时会按 `Project.genre` 设好全局值）。
   *    下面 `subLabel`（子项称谓）与 `modules`（字段模板）都按它取，与 `tab.name`
   *    走 getter 读的是同一份 pack，不会漂移。
   */
  const pack = getActivePack()
  /** 子项称谓随题材（Q15）：修真包→「子世界」、历史包→「政权」、武侠包→「门派」…纯文案层 */
  const subLabel = subItemLabel(tab.id, pack)
  /**
   * 「新增」按钮文案（2.7.2 · 主人定案）：worldbase→「新增子世界」、power→「新增子体系」。
   * 🔴 不再用 `新增{subLabel}` —— 那样历史包下会变成「新增政权」，而条目是**子级**、不是政权本身。
   */
  const addLabel = addButtonLabel(tab.id)
  /** 母级说明里的举例随页签给（worldbase→世界底层法则；power→统一等级总纲） */
  const masterHint = tab.id === 'worldbase' ? '世界底层法则' : '统一等级总纲'

  // 包一层 useMemo：模块随题材包变，依赖 [tab.id, pack]（不是 `tab.modules` —— 那是个 getter，每次读都是活值）
  const modules = useMemo(() => modulesFor(tab.id, pack) ?? [], [tab.id, pack])
  const templates = useMemo<TemplateField[]>(
    () => modules.flatMap(m => m.fields.map(f => ({
      key: `${m.name}::${f.name}`,
      label: f.name,
      desc: f.desc,
      example: f.example,
      // 与母级同一套判据：数值类字段锁死（kind 显式声明 or 关键字兜底，见 lib/schema）
      locked: tab.id === 'power' && isNumericPowerField(f),
    }))),
    [modules, tab.id],
  )
  const totalFields = templates.length
  // 草稿箱是内部字段（__` 前缀），不算"已填"——它本来就不是这张表要填的东西
  const filledCount = Object.entries(draft)
    .filter(([k, v]) => !isInternalFieldKey(k) && v && v.trim()).length
  /** 当前层的草稿箱文本 */
  const freeDraft = draft[FREE_DRAFT_KEY] ?? ''
  const freeDraftChars = freeDraft.trim().length

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
  /** 右栏冻结（3.3.1 回归修复）：切子项时右栏停在原处，不跳回顶部 */
  const detailScrollRef = useRef<HTMLDivElement>(null)
  useFrozenDetailScroll(detailScrollRef, sel)
  const subsRef = useRef(subs)
  /** 本面板属于哪个项目 —— 挂载时绑定（换项目会因 App 的 key 整体重挂，见 FormSheet 同名说明） */
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { selRef.current = sel }, [sel])
  useEffect(() => { subsRef.current = subs }, [subs])
  useEffect(() => () => {
    if (!dirtyRef.current || !storageOwner.current()) return
    const d = draftRef.current
    const cur = selRef.current
    // 🔴 3.2.2（审计 C3 同族）：卸载补存必须带**挂载时绑定的项目 id**。
    //    `exitProject()` 会先把全局 currentProjectId 清成 ''，此刻再让存储层去读全局，
    //    写进去的就是无归属记录 —— 重开原书这层改动会消失。
    if (!pidRef.current) return
    const pending = cur === MAIN ? db.saveFormDataFor(pidRef.current, tab.id, d) : (() => {
      const sub = subsRef.current.find(s => s.id === cur)
      return sub ? db.saveSubSetFor(pidRef.current, tab.id, { ...sub, data: d }) : Promise.resolve()
    })()
    void pending.catch(() => showToast('离开前保存设定失败，请回到原页面核对草稿', 'error'))
  }, [tab.id, storageOwner])

  const isMain = sel === MAIN
  /**
   * **其它活跃子世界**的已填摘要（2026-10-03）—— 多套并行时兄弟条目最容易撞车，
   * 补全当前这条时把它们作为**可选项**交给作者挑（默认不带，勾了才进对话上下文）。
   */
  const siblingCtx = useMemo(
    () => buildSiblingContext(
      subs.filter(s => s.id !== sel && activeIds.includes(s.id)).map(s => ({ name: s.name, data: s.data })),
      { itemLabel: subLabel },
    ),
    [subs, activeIds, sel, subLabel],
  )
  const selSub = useMemo(() => subs.find(s => s.id === sel), [subs, sel])
  // 活跃列表里可能残留已删除子项的 id（跨设备删除）⇒ 一律经 splitActive 过滤后再用
  const { active } = useMemo(() => splitActive(subs, activeIds), [subs, activeIds])

  /** 把当前层的草稿落库（切层 / 点保存 / 卸载前都走它） */
  const saveState = useManualDraftSave({
    read: () => ({ value: { id: selRef.current, data: draftRef.current }, dirty: dirtyRef.current }),
    write: async value => {
      if (value.id === MAIN) await db.saveFormDataFor(pidRef.current, tab.id, value.data)
      else {
        const sub = subsRef.current.find(s => s.id === value.id)
        if (!sub) throw new Error('当前子项已不存在')
        await db.saveSubSetFor(pidRef.current, tab.id, { ...sub, data: value.data })
      }
    },
    committed: value => {
      if (value.id === MAIN) setMain(value.data)
      else setSubs(prev => prev.map(s => s.id === value.id ? { ...s, data: value.data } : s))
      if (selRef.current === value.id && draftRef.current === value.data) {
        dirtyRef.current = false; setDirty(false)
        return true
      }
      return false
    },
  })
  const { save: flush, saving } = saveState

  // 🔴 2.7.2：原先这里有 `onPackSwitched`（题材切换后换模板）——
  //    题材改到「新建项目」时选了，页签里不再提供切换入口，该回调随之移除。
  //    `pack` state 本身**保留**：`subLabel` 与 `modules` 的 useMemo 仍按它取当前项目的题材。

  // 🔴 Ctrl/Cmd+S 保存当前层（2.7.3 补：本面板此前压根没挂快捷键 ——
  //    作者在世界设定 / 力量体系里按 Ctrl+S 毫无反应，只能去点按钮）
  useSaveHotkey(() => void flush(), dirty)

  const selectLayer = async (key: string) => {
    if (key === sel) return
    if (!await flush()) return
    selRef.current = key; dirtyRef.current = false
    draftRef.current = key === MAIN ? main : (subsRef.current.find(s => s.id === key)?.data ?? {})
    setSel(key)
    setDraft(draftRef.current)
    setDirty(false)
  }

  const setField = (key: string, value: string) => {
    draftRef.current = { ...draftRef.current, [key]: value }; dirtyRef.current = true
    setDraft(draftRef.current)
    setDirty(true)
  }

  const addSub = async (name: string) => {
    const n = name.trim()
    if (!n) return
    const owner = captureCandidateOwner()
    if (!await flush() || !owner.current()) return
    const rec: CardRecord = {
      id: uid(), projectId: '', tabId: '', name: n, data: {}, order: subs.length,
    } as CardRecord
    await db.saveSubSetFor(pidRef.current, tab.id, rec)
    if (!owner.current()) return
    // 🔴 新建即设为「活跃」：作者刚建一个子世界，显然是要写它。
    //    默认给「已完结」的话，他填了半天字却发现 AI 根本没读（提示条还写着"没有活跃子世界"）。
    await db.setSubActive(tab.id, rec.id, true)
    if (!owner.current()) return
    setSubs(prev => [...prev, rec])
    setActiveIds(await db.getActiveSubIds(tab.id))
    setSel(rec.id)
    setDraft({})
    setDirty(false)
    showToast(`已新增${subLabel}「${n}」（已设为活跃，会一起发给 AI）`, 'success')
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
      title: `删除${subLabel}`,
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

  /**
   * 「从《世界设定》新建」（2.7.2 · 主人定案；原名「同步子项清单」，2.7.1 为 Q14 缓解措施）。
   *
   * 🔴 **为什么收窄语义**（这是个真实的坑，本轮改掉）：
   *   原实现做的是**双向对齐** —— 名称 / 顺序 / 活跃态全都跟着基准走。
   *   在「制度四页签 = 母级 + 子项」的年代这看着合理（那套结构的本意就是「多政权要对齐」）；
   *   但 2.7.2 制度页签改成**并列**之后，作者完全可能自己排了一套顺序、标了一组活跃态
   *   （比如「魏蜀吴里只激活吴」），此时点一下同步按钮会被**静默改回基准的顺序与活跃态**。
   *   ⇒ 现在只做**补缺**：把《世界设定》里本页签还没有的子项建出空壳（内容各存各），
   *   已有子项一个都不碰（含它的名字、顺序、活跃态）。
   */
  const syncFromWorldbase = async () => {
    const base = await db.getSubSets('worldbase').catch(() => [] as CardRecord[])
    if (!base.length) {
      showToast('《世界设定》还没有子项 —— 先在那里把清单建好，再来新建', 'info')
      return
    }
    const byName = new Map(subs.map(s => [s.name, s]))
    let created = 0
    for (const b of base) {
      if (byName.has(b.name)) continue          // 同名已存在 ⇒ 一个字节都不动它
      const rec = { id: uid(), projectId: '', tabId: '', name: b.name, data: {}, order: subs.length + created } as CardRecord
      await db.saveSubSet(tab.id, rec)
      byName.set(b.name, rec)
      created++
    }
    setSubs(await db.getSubSets(tab.id))
    setActiveIds(await db.getActiveSubIds(tab.id))
    showToast(
      created > 0
        ? `已从《世界设定》新建 ${created} 个子项（内容还是空的，逐个填）`
        : '这里的子项都齐了，没有需要新建的',
      'success',
    )
  }

  if (loading) return <LoadingState />
  if (!modules.length) return <div className="p-8 text-13 text-ink-400">这个页签没有可填的字段。</div>

  return (
    // 🔴 2026-10-17：根容器锁高（`flex h-full flex-col overflow-hidden`）——
    //    与角色卡 / 大纲卡 / 酒馆各页签统一为「两栏各自独立滚动」（主人 3.1.2 要求全局一致，
    //    不能再有的页签改了有的没改）。此前是 `w-full` 跟页滚：右栏表单被整页拖着滚，
    //    左栏层目录滚出视野后想切层得先滚回顶部。
    <div data-adaptive-master="world" className="page-enter flex h-full flex-col overflow-hidden">
      <header className="mb-4 shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
          <HelpPopover title={`${tab.name} · 母子结构怎么用`} width="24rem" size={14}>
            {`这个页签分两层：\n\n`
              + `· 【母级】全书统一 —— 整本书只有一个，写这套设定的顶层规则（${masterHint}）。`
              + `它永远会发给 AI。\n`
              + `· 【${subLabel}】—— 每个副本 / 剧本 / 世界线一套，可以建多项。每项有一个开关：`
              + `「活跃」（当前故事聚焦在它）或「已完结」（写过、不再聚焦）。\n`
              + `· 只有活跃的${subLabel}才会发给 AI。已完结的留在库里随时可查，但不再占用模型的注意力 —— 多套设定就不会互相打架。\n`
              + `· 左列点一下就切换编辑对象；右列表单顶部始终标着你现在在填哪一层，`
              + `两层的字段是一样的，别填错层。\n\n`
              + `${tab.description ?? ''}`}
            <AIDataSourceNote feature={tab.id} />
          </HelpPopover>
          {/*
            🔴 2.7.2 主人定案：**题材切换与页签勾选都不再放在这一页**。
              · 题材改到「新建小说项目」时选（ProjectHub 表单 + 首启向导都已有该下拉），
                进来之后题材是**只读**的 —— 页签里再放一个能改题材的控件，等于两个真相源。
              · 页签显隐也不由这里管了：**完整项目全部显示**（不再按题材隐藏），
                **自定义项目**在建项目时于「功能模块」弹窗里勾选。
            ⇒ 原先挂在这里的 `GenrePackSwitcher` + `TabVisibilityControl` 已整体移除。
          */}
          <div className="ml-auto flex items-center gap-2">
            <FieldAliasButton
              tabId={tab.id}
              tabName={tab.name}
              intro="给这一页的字段起你自己看得懂的名字（母级与每个子项用的是同一套字段）。"
              targets={moduleAliasTargets(modules)}
            />
            <Button variant="toggle" selected={dirty} disabled={!dirty || saving}
              onClick={() => void flush()} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium hover:bg-amber/25"
              title={dirty ? '保存（先落库再切换层，不怕丢）' : '无未保存的改动'}
            >
              <Save size={13} /> {saving ? '提交中…' : !dirty && saveState.submitted ? '已提交' : '保存'}
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
              当前有 <b className="text-amber">{active.length}</b> 个{subLabel}处于活跃状态，会一起发给 AI。
              套数越多越容易写串 —— 写完这一卷，记得把已完结的关掉。
            </div>
          ) : (
            <div className="text-11 text-ink-500">
              {active.length === 0
                ? `当前没有活跃${subLabel}，AI 只会读到「全书统一」这一层。`
                : `AI 会读到：全书统一 + 当前活跃的 ${active.length} 个${subLabel}（${active.map(s => s.name).join('、')}）。`}
            </div>
          )}
        </div>
        <DraftSaveFeedback state={saveState} dirty={dirty} onRetry={() => void flush()} />
      </header>

      {/* 🔴 2026-10-17：恒双栏 + 锁高（不再堆叠）—— 与 MasterDetail（角色卡 / 大纲卡）同范式：
          窗口再窄也是并排挤一挤，两栏各自滚；堆叠模式下必有一栏被压瘪，反而不一致。
          左栏层目录自滚、右栏表单自滚，页头（保存 / AI 补全）常驻可见。 */}
      <div className="flex flex-1 min-h-0 gap-4">
        {/* ---------- 左列：层选择 ----------
            ⚠️ 刻意用 div 而不是 aside：页面里已经有一个 aside（左侧主导航栏），
            再来一个同为 aside 的容器，无论是无障碍语义还是脚本/调试都会互相混淆。 */}
        <div className="w-56 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden flex flex-col min-h-0">
          <div className="px-3 py-2 text-10 text-ink-500 border-b border-ink-700">全书统一（母级）</div>
          {/* U-4 · 2.6.0：母级行改 SelectRow（行选择收编件，选中态令牌 /15 与 Button toggle 真源一致） */}
          <SelectRow
            selected={isMain}
            onClick={() => void selectLayer(MAIN)}
            title="编辑全书统一的设定（这一层永远发给 AI）"
            className="items-center gap-2 px-3 py-2.5 text-12"
          >
            <BookOpen size={13} className="shrink-0" />
            <span className="truncate">{tab.name}</span>
            <span className="ml-auto shrink-0 rounded border border-amber/40 bg-amber/10 px-1 text-9 text-amber">全书</span>
          </SelectRow>

          <div className="px-3 py-2 text-10 text-ink-500 border-y border-ink-700 flex items-center gap-1">
            {subLabel}
            <span className="text-ink-600">（{subs.length}）</span>
            <span className="ml-auto text-ink-600">活跃 {active.length}</span>
          </div>

          {/* 🔴 2.7.2：制度四页签已改为并列结构、移到 `ParallelSetSheet` 渲染，
              所以走到这里的只剩「力量体系」—— 按钮文案随之从「同步子项」改为「从《世界设定》新建」，
              语义也从「双向对齐清单」收窄为「只补缺」（对齐会改回作者手动排过的顺序）。 */}
          {tab.id !== 'worldbase' && (
            <button onClick={() => void syncFromWorldbase()}
              title="把《世界设定》里已有的子项在这里建出空壳（只补缺，不动已有子项，也不改它们的活跃态）"
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-10 text-ink-400 hover:bg-ink-800 border-b border-ink-700 transition-colors"
            >
              <Copy size={11} /> 从《世界设定》新建
            </button>
          )}

          {/* 唯一滚动区：flex-1 + min-h-0 吃满左栏剩余高度（🔴 min-h-0 不能删——
              flex 子项默认 min-height:auto，会撑破锁高把两栏一起顶变形） */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {subs.length === 0 && (
              <div className="px-3 py-3 text-11 text-ink-600 leading-relaxed">
                还没有{subLabel}。<br />如果这本书只在一个世界里发生，就不用建。
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
            className="w-full shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-12 text-ink-300 hover:bg-ink-800 border-t border-ink-700 transition-colors"
          >
            <Plus size={12} /> {addLabel}
          </button>
        </div>

        {/* ---------- 右列：当前层的表单（独立滚动） ---------- */}
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1" ref={detailScrollRef} data-set-detail>
          <div className={`mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 ${
            isMain ? 'border-amber/30 bg-amber/5' : 'border-ink-600 bg-ink-800/40'
          }`}>
            {isMain ? <BookOpen size={12} className="text-amber" /> : <Globe2 size={12} className="text-ink-300" />}
            <span className="text-11 text-ink-200">
              {isMain ? <>正在填：<b className="text-amber">【母级】全书统一</b>（永远发给 AI）</> : <>正在填：<b className="text-ink-100">【{subLabel}】{selSub?.name}</b>（{activeIds.includes(sel || '') ? '活跃 · 会发给 AI' : '已完结 · 不发给 AI'}）</>}
            </span>
            <span className="ml-auto text-10 text-ink-500 tabular-nums">{filledCount} / {totalFields} 项已填</span>
            {!isMain && selSub && (
              <>
                <Button variant="icon-muted" size="sm" onClick={() => setNaming('rename')} title="改名字">
                  <Pencil size={11} />
                </Button>
                <Button variant="icon-danger" size="sm" onClick={() => void dropSub()} title={`删除这个${subLabel}`}>
                  <Trash2 size={11} />
                </Button>
              </>
            )}
          </div>

          {!isMain && selSub && !activeIds.includes(selSub.id) && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2 text-11 text-ink-400">
              <Layers size={11} className="shrink-0" />
              这个{subLabel}是「已完结」——留档可查，但不会发给 AI。要让它参与，点左列它左边的圆点。
            </div>
          )}

          <div className={isMain ? 'border-l-2 border-amber/40 pl-3' : 'border-l-2 border-ink-600 pl-3'}>
            <SchemaFieldGrid modules={modules} data={draft} onFieldChange={setField} tabId={tab.id} />
          </div>

          {/* ---------- 设定草稿箱（本层一份，不发给 AI） ---------- */}
          <div className="mt-4 overflow-hidden rounded-xl border border-ink-600 bg-ink-850/40">
            <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
              <NotebookPen size={12} className="shrink-0 text-ink-300" />
              <span className="text-12 text-ink-100">设定草稿箱</span>
              <span className="rounded border border-ink-600 bg-ink-800 px-1 py-px text-10 text-ink-300"
                title="这块内容不会进入 AI 上下文，也不会进设定集导出"
              >不发给 AI</span>
              <HelpPopover title="设定草稿箱 · 怎么用" width="22rem" size={13}>
                {`还没想好上面那些字段怎么填时，先把想法堆在这儿 —— 一句话、一大段、杂乱无章都行，不做任何格式要求，框子会跟着文字一路长高。\n\n`
                  + `· 🔴 这块内容「不发给 AI」：它只是你自己的落档处，不会进模型上下文、也不会进设定集导出。\n`
                  + `· 想让它变成真正的设定 → 点「AI 整理到上方字段」：AI 读这段草稿，把内容整理进上面还没填的字段（已填的不动），你可以逐条改完再采用。\n`
                  + `· 母级与每个子世界「各有一份」草稿箱，切层时各自独立保存。\n`
                  + `· 整理进字段之后，那份内容才会被 AI 读到 —— 所以「填了草稿箱但 AI 不知道」是正常的。\n`}
              </HelpPopover>
              <span className="ml-auto text-10 text-ink-500 tabular-nums">{freeDraftChars} 字</span>
              <Button variant="secondary" size="xs"
                onClick={() => setShowOrganize(true)}
                disabled={!aiReady || freeDraftChars === 0}
                className="flex items-center gap-1"
                title={aiReady
                  ? (freeDraftChars === 0 ? '先在草稿箱里写点什么，再让 AI 整理' : '让 AI 读这段草稿，整理进上方未填的字段')
                  : '还没接入模型'}
              >
                <Wand2 size={11} /> AI 整理到上方字段
              </Button>
            </div>
            <div className="p-3">
              <AutoTextarea
                value={freeDraft}
                onChange={v => setField(FREE_DRAFT_KEY, v)}
                placeholder="想到什么就往这儿丢：一段没理顺的世界规则、几个互相打架的点子、跟朋友聊出来的碎片……先落档，之后再整理成上面那些字段。"
                className="text-13 leading-relaxed"
                minRows={7}
                maxHeight={0}
              />
              <div className="mt-1.5 text-10 leading-relaxed text-ink-400">
                随内容自动增高，无字数上限；改完点顶部的「保存」落库（切层 / 离开页签也会自动保存）。
              </div>
            </div>
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
        title={naming === 'rename' ? `改${subLabel}名字` : `新增${subLabel}`}
        label={`${subLabel}名称`}
        defaultValue={naming === 'rename' ? selSub?.name ?? '' : ''}
        placeholder="例：大燕 / 主神空间 / 玄天宗 / 末日废土"
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
          tabId={tab.id}
          existing={draft}
          extraContextGroups={siblingCtx ? [{
            key: 'siblings',
            label: `其它活跃${subLabel}（${activeIds.filter(id => id !== sel).length} 个）`,
            hint: '同名条目之间最容易撞车 —— 勾上它，AI 会照着兄弟条目已有的设定来问',
            text: siblingCtx,
          }] : []}
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

      {showOrganize && (
        <AITemplateFill
          fields={templates}
          tabId={tab.id}
          // 已填字段照样发给模型当"别再生成一遍"的依据，但弹窗里会标成「已填」不可改
          existing={draft}
          initialSketch={freeDraft}
          sketchLabel="待整理的草稿（来自草稿箱，可随手改）"
          title={`AI 整理 · ${isMain ? '全书统一（母级）' : `子世界「${selSub?.name ?? ''}」`}`}
          onSubmit={values => {
            // 与 FormSheet 同款：只采纳非空值（AI 没填的字段保持原样）
            for (const [k, v] of Object.entries(values)) if (v && v.trim()) setField(k, v)
            setShowOrganize(false)
          }}
          onClose={() => setShowOrganize(false)}
        />
      )}
    </div>
  )
}

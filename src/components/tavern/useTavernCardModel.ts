/**
 * 角色卡片页 · **全部状态与动作**（2026-09-19 D4-4，从 `TavernCard.tsx` 拆出）。
 *
 * 【为什么整层搬走】卡面 JSX 直接用到 60+ 个组件作用域名字（状态 / setter / 派生 / 动作）。
 *   整层收进来、视图侧按名解构接回去，页面文件就只剩「页头 + 左栏 + 卡面各区块 + 弹窗」的装配；
 *   而这块真正复杂的东西（三套脏标记、切卡守卫、批量导入、AI 转换）集中在一处，好审。
 *
 * 【这页有三套各自独立的「脏」与生命周期，别混】
 *   · 卡面：`draft` / `dirty` / `saving` —— 保存走 `store.saveFreeChar`；
 *   · 记忆：`mem` / `memDirty` / `savingMem` / `seedingMem` —— 六栏，作者可手改；
 *   · 日记：`journal` —— 只读、只增、**不参与 AI 上下文**。
 *
 * 🔴 切卡前先把上一张**未保存**的改动落库（`open()` 开头那一段）：原实现直接换 draft，
 *   旧卡改了没保存就点另一张 = 改动静默消失（审计 2026-09-18 P1-4）。
 *
 * 🔴 导入（`importCards`）与 AI 转换（`convert`）**都不逐张调 AI**：先用离线摘录
 *   （`draftMemoryFromCard`）兜底，之后可在每张卡上点「生成初版记忆」升级成 AI 整理版 ——
 *   N 张卡就是 N 次模型调用，慢且费额度。
 *
 * ⚠️ 本文件里的实现**逐行来自原 `TavernCard.tsx`**（除下面两处已登记的定点修补），
 *   所以注释里的行内说明仍按当时的上下文写，读起来是连续的。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import * as store from '@/lib/tavern/store'
import * as db from '@/lib/db'
import { normalizeStructMarkup, structSpecOf } from '@/lib/tavern/cardFields'
import { listStories } from '@/lib/tavern/story'
import {
  MEMORY_SOFT_LIMIT, cardStoryId,
  type FreeCharacter, type FreeMemory, type TavernCharIndexItem, type TavernStoryIndexItem,
  type CharJournal, type CharJournalEntry,
} from '@/lib/tavern/types'
import { isMemoryEmpty } from '@/lib/tavern/memory'
import {
  toCardFile, toCardBundle, parseCardFile, parseCardBundle, cardFileName,
  CARD_BUNDLE_SUFFIX, describeWarnings, type CardBundleItem,
} from '@/lib/tavern/cardFile'
import { convertNovelChar } from '@/lib/tavern/import'
import { coldStartMemory, draftMemoryFromCard } from '@/lib/tavern/summarize'
import { renderFreeCharacter } from '@/lib/tavern/engine'
import { getTavernSettings, memoryLimitsOf } from '@/lib/tavern/settings'
import { readSetPref, writeSetPref, expandedIdsOf, collapsedIdsOf } from '@/lib/settings/uiPrefs'
import { type CardDraft } from '@/lib/tavern/draft'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import { FREE_GROUP } from '@/components/tavern/TavernCardList'

/**
 * 角色卡分组折叠状态的持久化键（localStorage，经 `lib/settings/uiPrefs`）。
 * 存的是「**已收起**的故事 id」—— 默认全展开，见 `openIds` 的注释。
 */
const CARD_COLLAPSED_KEY = 'tavern-card-collapsed'

/** 从小说角色导入弹窗的分组页签 */
export type NovelTab = 'all' | 'char-main' | 'char-secondary' | 'char-npc'

/**
 * 复制卡时的命名：加「（副本）」，重名就往后排（副本2、副本3…）。
 * 不加序号的话右栏会立刻出现两张同名卡 —— 那正是我们想替作者避免的困惑。
 */

function copyName(base: string, taken: Set<string>): string {
  const n = base.trim() || '未命名角色'
  let cand = `${n}（副本）`
  let i = 2
  while (taken.has(cand)) cand = `${n}（副本${i++}）`
  return cand
}

export function useTavernCardModel() {
  const [list, setList] = useState<TavernCharIndexItem[]>([])
  const [draft, setDraft] = useState<FreeCharacter | null>(null)
  /** 两个 AI 入口：一句话起草 / 对话引导 */
  const [aiDraftOpen, setAiDraftOpen] = useState(false)
  const [interviewOpen, setInterviewOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** AI 转换出来的草稿欠着哪些信息（界面必须显示，方案 §7.6 硬要求） */
  const [gaps, setGaps] = useState<string[]>([])
  const [importOpen, setImportOpen] = useState(false)
  /**
   * 记忆（六栏）：AI 会整理它，但作者必须能**直接改** ——
   * 整理是压缩，压错的地方只有作者知道；只读的话就只能删卡重来。
   */
  const [mem, setMem] = useState<FreeMemory | null>(null)
  const [memDirty, setMemDirty] = useState(false)
  const [showMem, setShowMem] = useState(false)
  /**
   * 记忆软上限（控制面板）。
   * 🔴 审计 P1-1：这个旋钮以前**全库无消费者** —— 面板上写「超过只在界面上提醒」，
   *    而那句提醒从来没实现过。这里把它接上（只提醒，不做硬截断；硬截断归 hardLimit）。
   */
  const [softLimit, setSoftLimit] = useState(MEMORY_SOFT_LIMIT)
  useEffect(() => {
    void getTavernSettings()
      .then(st => setSoftLimit(st.free.softLimit))
      .catch(() => { /* 读不到就按内置默认，不打断卡片页 */ })
  }, [])
  const [savingMem, setSavingMem] = useState(false)
  const [seedingMem, setSeedingMem] = useState(false)
  /**
   * 日记：每场对话结束时记一段「这一场发生了什么」，**只给作者回顾，不进 AI 上下文**。
   * 与记忆第六栏「最近日记」的区别见 types.ts 的 CharJournalEntry 注释。
   */
  const [journal, setJournal] = useState<CharJournal | null>(null)
  const [showJournal, setShowJournal] = useState(false)
  const [novelChars, setNovelChars] = useState<{ id: string; name: string; tabId: string }[]>([])
  const [converting, setConverting] = useState(false)
/** 导入弹窗的筛选态：角色多时靠它定位。每次打开重置，免得留下上次的关键字 */
  const [nq, setNq] = useState('')
  const [ntab, setNtab] = useState<NovelTab>('all')
  const fileRef = useRef<HTMLInputElement>(null)

  /** 故事列表（角色卡左栏按故事分组；老大 2026-09-16 定：卡必须归属故事） */
  const [stories, setStories] = useState<TavernStoryIndexItem[]>([])
  /**
   * 树展开态：**当前展开着**的故事 id 集合。默认全展开 —— 卡不多时先让作者看见全貌，
   * 嫌占地方再自己收。
   *
   * 🔴 **落盘的却是"已收起"的那一份**（`collapsedRef` / `CARD_COLLAPSED_KEY`）——
   *    这是 `lib/settings/uiPrefs` 的铁律「存偏离默认的那一侧」：
   *    默认是展开的，所以要存已收起的，这样**以后新建的故事**在老用户的记录里没有它
   *    ⇒ 天然落到默认（展开），而不是"记录里没它所以默认收起"。
   *
   *    （2026-10-11 修复：此前 `openIds` 是纯内存态，`load()` 每次都把"没见过的故事"
   *     全部补进展开集合 —— 于是切走页签再切回来（组件重挂、state 归零）就把作者
   *     手动收起的分组统统重新展开。作者原话：「折叠状态并不能常驻」。）
   */
  const [openIds, setOpenIdsState] = useState<string[]>([])
  /**
   * 当前**全部可折叠分组**的 id（故事 id + 「未归属」抽屉）。
   * 它是「展开集合 ↔ 已收起集合」互相换算的参照物 —— 切换折叠时拿它取补集。
   * 由 `load()` 随故事列表一起刷新；不在渲染期算，免得两个集合的更新时机错位。
   */
  const groupIdsRef = useRef<string[]>([])
  /** 已收起的分组 id（持久化的那一份；同时镜像进 ref，供 setter 同步读） */
  const collapsedRef = useRef<Set<string>>(new Set(readSetPref(CARD_COLLAPSED_KEY) ?? []))
  /** 新建卡的第一步：先问它属于哪个故事 */
  const [pickOpen, setPickOpen] = useState(false)
  const [pickStoryId, setPickStoryId] = useState('')

  /**
   * 展开态 setter 的持久化包装。
   * 🔴 签名保持 `Dispatch<SetStateAction<string[]>>` 不变 —— 子组件（`TavernCardList`）
   *    与它里面的搜索 / 展开逻辑一个字都不用改，持久化完全收在这一层。
   * 写盘规则：`已收起 = 全集 − 展开集合`（空集合也是合法状态，见 uiPrefs 用例）。
   */
  const setOpenIds: Dispatch<SetStateAction<string[]>> = useCallback(action => {
    setOpenIdsState(prev => {
      const next = typeof action === 'function' ? action(prev) : action
      const collapsed = collapsedIdsOf(groupIdsRef.current, next)
      collapsedRef.current = new Set(collapsed)
      writeSetPref(CARD_COLLAPSED_KEY, collapsed)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    try {
      const [cs, ss] = await Promise.all([store.listFreeChars(), listStories()])
      setList(cs)
      setStories(ss)
      // 全集：故事 id + 有自由状态的卡时补上「未归属」抽屉（别让它们藏起来没人管）
      const universe = ss.map(s => s.id)
      const hasFree = cs.some(c => !cardStoryId(c))
      if (hasFree) universe.push(FREE_GROUP)
      groupIdsRef.current = universe
      // 顺手剪掉已不存在分组（故事被删）的残留记录，免得它在 localStorage 里越攒越多
      const known = new Set(universe)
      const kept = [...collapsedRef.current].filter(id => known.has(id))
      if (kept.length !== collapsedRef.current.size) {
        collapsedRef.current = new Set(kept)
        writeSetPref(CARD_COLLAPSED_KEY, kept)
      }
      // 展开 = 全集 − 已收起 ⇒ 新故事（不在"已收起"里）自动展开，作者收起的仍收起
      setOpenIdsState(expandedIdsOf(universe, collapsedRef.current))
    } catch {
      setList([])
      setStories([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const open = async (id: string) => {
    // 🔴 审计 2026-09-18（P1-4）：切卡前先把上一张**未保存**的改动落库。
    //    原实现直接 setDraft(新卡) + setDirty(false)，旧卡改了没保存就点另一张 = 改动静默消失
    //    （界面上只有一句「有未保存的改动」，点下去等于放弃）。与 CharacterSheet 的切卡守卫同型。
    if (dirty && draft && draft.id !== id) {
      try { await store.saveFreeChar(draft) } catch { /* 落库失败不阻断切卡，脏标记仍在界面上 */ }
    }
    const [c, m] = await Promise.all([
      store.getFreeChar(id),
      store.getMemory(id).catch(() => null),
    ])
    setDraft(c)
    setMem(m)
    setMemDirty(false)
    setShowMem(false)
    setDirty(false)
    // 日记单独取：它跟记忆是两套东西，取不到也不该拖累整张卡打不开
    void store.getJournal(id).then(j => setJournal(j)).catch(() => setJournal(null))
    setShowJournal(false)
  }

  /** 保存手工改过的记忆（与 AI 整理走同一个存储口，更新 updatedAt） */
  const saveMem = async () => {
    if (!draft || !mem) return
    setSavingMem(true)
    try {
      await store.saveMemory({ ...mem, charId: draft.id })
      setMem(await store.getMemory(draft.id))
      setMemDirty(false)
      showToast('记忆已保存（下次点「结束本轮对话」整理时会在此基础上压缩）')
    } catch (e) {
      showToast(`记忆保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSavingMem(false)
    }
  }

  /**
   * 一键清空这张卡的角色记忆（六栏全空）。
   *
   * 🔴 必须弹窗说清严重性：这是**不可撤销**的（记忆没有备份），而且清掉之后 AI 只会从
   *    水位线之后的**新内容**重新长记忆 —— 之前的对话原文还在，但总结出来的事回不来。
   *    所以弹窗里要把「想微调就展开编辑」这条退路一起写清楚，别让作者误点。
   */
  const clearMem = async () => {
    if (!draft || !mem || isMemoryEmpty(mem)) return
    const go = await confirmDialog({
      title: '清空 Ta 的角色记忆？',
      message: [
        '会把六栏记忆全部清空：长期摘要、关键事实、关系状态、未爆的雷、纪念日、日常片段。',
        '',
        '⚠️ 这个操作不可撤销 —— 记忆没有备份，清掉就找不回来了。',
        '· 之前的对话原文仍然在，但 Ta 会忘掉从那些内容里总结出来的事；',
        '· 之后继续聊，记忆会从新的内容重新长出来，旧对话不会自动回填。',
        '',
        '只想微调几条 → 点「取消」，改用「展开编辑」。',
      ].join('\n'),
      confirmText: '清空记忆',
      danger: true,
    })
    if (!go) return
    try {
      await store.saveMemory(store.emptyMemory(draft.id))
      setMem(await store.getMemory(draft.id))
      setMemDirty(false)
      setShowMem(false)
      showToast('记忆已清空 —— 之后会从新的对话重新长出来')
    } catch (e) {
      showToast(`清空失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /**
   * 清空日记。比清空记忆温和得多 —— 日记本来就不参与上下文，删了只影响作者自己的回顾，
   * 但同样是不可撤销的，所以照样弹窗（全清比逐条删更需要拦一下）。
   */
  const clearJournal = async () => {
    if (!draft || !journal?.entries.length) return
    const go = await confirmDialog({
      title: '清空这本日记？',
      message: [
        `会删掉这 ${journal.entries.length} 条场记（每场对话结束写的那段回顾）。`,
        '',
        '⚠️ 不可撤销 —— 日记没有备份。',
        '· 它不参与 AI 上下文，所以删掉不会让 Ta 失忆；',
        '· 想只删某一条，直接点那一条右边的「删除」就行。',
      ].join('\n'),
      confirmText: '清空日记',
      danger: true,
    })
    if (!go) return
    try {
      await store.clearJournal(draft.id)
      setJournal(await store.getJournal(draft.id))
      showToast('日记已清空')
    } catch (e) {
      showToast(`清空失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /**
   * 删单条日记（记错了、或者那一场作者不想要了）。
   *
   * 🔴 **必须弹窗**：日记没有备份、也**不支持编辑** —— 删掉就是永久没了。
   *    弹窗里要把「它不参与 AI 上下文、删了不会让 Ta 失忆」与「想留就先自己复制」一起讲清，
   *    否则作者会以为删日记会伤到角色，或者以为可以回头再改。
   */
  const dropJournal = async (entry: CharJournalEntry) => {
    if (!draft) return
    const go = await confirmDialog({
      title: '删掉这一条日记？',
      message: [
        entry.sessionTitle
          ? `会删掉「${entry.sessionTitle}」那一场记下的回顾。`
          : '会删掉这一条场记。',
        '',
        '⚠️ 日记没有备份 —— 删掉就找不回来了。',
        '· 它从来不参与 AI 上下文，所以删掉不会让 Ta 失忆；',
        '· 日记也不支持编辑：想留下内容，请先自己复制一份。',
      ].join('\n'),
      confirmText: '删掉这条',
      danger: true,
    })
    if (!go) return
    try {
      setJournal(await store.dropJournalEntry(draft.id, entry.id))
      showToast('已删掉这条日记')
    } catch (e) {
      showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /**
   * 新建角色卡 —— **先选故事，再建卡**（老大 2026-09-16 定）。
   *
   * 为什么必须先选：卡里不再写完整世界设定，世界观由它归属的故事提供；
   * 没有归属的卡在对话时拿不到「这个世界什么样」，演出来就是悬空的。
   * 所以入口直接拦一道，而不是先造一张孤儿卡再让用户回头补。
   */
  const openCreatePicker = () => {
    if (!stories.length) {
      showToast('先去「故事剧本」创建一个故事 —— 角色卡要挂在故事下面', 'info')
      return
    }
    setPickStoryId(stories[0].id)
    setPickOpen(true)
  }

  const confirmCreate = async () => {
    if (!pickStoryId) { showToast('请先选择一个故事', 'error'); return }
    setPickOpen(false)
    try {
      const c = await store.createFreeChar({
        ...store.emptyFreeCharacter(), storyId: pickStoryId, name: '未命名角色',
      })
      await load()
      await open(c.id)
      setDirty(true)
      showToast('已新建角色卡，填完记得保存')
    } catch (e) {
      showToast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /** 改一张卡的归属（含「不归属任何故事」）—— 解除后它会落到「未归属」分组，随时能再挂回去 */
  const changeStory = async (storyId: string) => {
    if (!draft) return
    setDraft({ ...draft, storyId })
    setDirty(true)
  }

  const save = async () => {
    if (!draft) return
    if (!draft.name.trim()) { showToast('角色名不能为空', 'error'); return }
    setSaving(true)
    try {
      const saved = await store.saveFreeChar(draft)
      setDraft(saved)
      setDirty(false)
      await load()
      showToast('已保存')
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  /**
   * 初版记忆：导入 / 新建一张卡之后**立刻**给它一版记忆（老大 2026-09-14 定）。
   *
   * 优先让 AI 依据角色卡整理（那才是「整理总结」该有的样子）；没有可用模型或调用失败时，
   * 回落到 draftMemoryFromCard 的确定性摘录 —— 空记忆是最差的结果。
   * @returns 'ai' | 'draft'（调用方据此提示来源，别让用户以为「AI 整理了」）
   */
  const seedMemory = async (card: FreeCharacter): Promise<'ai' | 'draft'> => {
    try {
      const st = await getTavernSettings()
      const lim = memoryLimitsOf(st)
      const m = await coldStartMemory({
        charId: card.id,
        charName: card.name,
        charContext: renderFreeCharacter(card),
        providerId: st.free.summaryProviderId || undefined,
        // 🔴 limits 必须传（2026-09-20 六维审计 P1-4）：不传就永远走内置 3000 ——
        //    面板上那三个数（长期摘要上限 / 日记保留天数 / 记忆硬上限）在这条路径上是死的。
        //    写法与 useFreeRoundEnd 对齐（那边的注释就是「不传就永远走内置 3000，面板调的是死的」）。
        limits: { longTermLimit: lim.longTermLimit, diaryDays: lim.diaryDays, hardLimit: lim.hardLimit },
      })
      await store.saveMemory(m)
      return 'ai'
    } catch {
      await store.saveMemory(draftMemoryFromCard(card))
      return 'draft'
    }
  }

  /** 手动生成初版记忆（只在记忆还空着时露出按钮，避免覆盖真实记忆） */
  const genMemory = async () => {
    if (!draft) return
    setSeedingMem(true)
    try {
      const how = await seedMemory(draft)
      setMem(await store.getMemory(draft.id))
      setMemDirty(false)
      showToast(
        how === 'ai' ? '初版记忆已生成（AI 依据角色卡整理）' : '初版记忆已生成（直接摘录角色卡，未接模型）',
        how === 'ai' ? 'success' : 'info')
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSeedingMem(false)
    }
  }

  const remove = async () => {

    if (!draft) return
    const okGo = await confirmDialog({
      title: `删除角色卡「${draft.name}」？`,
      message: '这张卡、它的长期记忆、日常状态，以及以它为唯一参演的会话都会一起删掉。\n这个操作不可撤销。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    try {
      await store.deleteFreeChar(draft.id)
      setDraft(null)
      setMem(null)
      setMemDirty(false)
      setDirty(false)
      await load()
      showToast('已删除')
    } catch (e) {
      showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /**
   * 复制当前卡为新卡（在现成卡的基础上改，比从零填快得多）。
   *
   * 三处刻意决定：
   *   · 名称加「（副本）」并自动避重 —— 否则右栏立刻出现两张同名卡，正是要避免的困惑；
   *   · **不复制记忆与日常状态**：那是「那个人经历过的事」，搬过来等于凭空给新角色一段
   *     不属于他的过去，也正是同名不同人最容易串味的地方；
   *   · 复制**屏幕上这一份**（含未保存的改动）—— 作者心里想的就是眼前看到的这张。
   */
  const duplicate = async () => {
    if (!draft) return
    try {
      const taken = new Set(list.map(i => i.name.trim()))
      const created = await store.createFreeChar({
        name: copyName(draft.name, taken),
        storyId: cardStoryId(draft),
        avatar: draft.avatar,
        world: draft.world,
        profile: { ...draft.profile },
        conduct: { ...draft.conduct },
        examples: draft.examples,
      })
      await load()
      await open(created.id)
      showToast(`${dirty ? "已复制（含未保存的改动）" : "已复制为新卡"}：记忆与日常状态不随卡复制`)
    } catch (e) {
      showToast(`复制失败：${e instanceof Error ? e.message : String(e)}`, "error")
    }
  }

  // ---------- 导入 / 导出（方案 §7.7） ----------
  const exportCard = () => {
    if (!draft) return
    try {
      const blob = new Blob([toCardFile(draft)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = cardFileName(draft.name)
      a.click()
      URL.revokeObjectURL(url)
      showToast('已导出角色卡文件')
    } catch (e) {
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /**
   * 导出**全部**角色卡到一个文件。
   * 与「导入 JSON」的批量入口对称 —— 整批导进来的，也该能整批带走（备份 / 分享给同好）。
   */
  const exportAll = async () => {
    try {
      const cards: FreeCharacter[] = []
      for (const it of list) {
        const c = await store.getFreeChar(it.id)
        if (c) cards.push(c)
      }
      if (!cards.length) { showToast('还没有可导出的角色卡', 'info'); return }
      const blob = new Blob([toCardBundle(cards, `${cards.length} 张角色卡`)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `角色卡全集-${new Date().toISOString().slice(0, 10)}${CARD_BUNDLE_SUFFIX}`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`已导出 ${cards.length} 张角色卡到一个文件`)
    } catch (e) {
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  /**
   * 导入角色卡 —— 三种情形一次搞定：
   *   ① 一个文件里一张卡（老的 `.taverncard.json`）
   *   ② 一个文件里整批（`.taverncards`，同一世界观的角色常是一起建的）
   *   ③ 一次选中多个文件（逐个按上面两种识别）
   *
   * 失败项照实报出，但**不影响其余卡入库** —— 作者填一次表不容易，
   * 不该因为第 3 张坏了把前两张也丢掉（与解析层「能救的救」同一条纪律）。
   */
  const importCards = async (picked: File[]) => {
    if (!picked.length) return
    try {
      const batch: CardBundleItem[] = []
      const failed: string[] = []
      for (const f of picked) {
        let text = ''
        try { text = await f.text() } catch { failed.push(`${f.name}：读不出来`); continue }
        // 先按批量文件试（format 标记能认出来），不认再按单卡处理
        const many = parseCardBundle(text)
        if (many.ok) {
          batch.push(...many.items)
          for (const x of many.failed) failed.push(`${f.name} 第 ${x.index + 1} 张：${x.reason}`)
          continue
        }
        const one = parseCardFile(text)
        if (one.ok) batch.push({ name: one.card.name, card: one.card, warnings: one.warnings })
        else failed.push(`${f.name}：${one.error}`)
      }

      if (!batch.length) {
        showToast(failed[0] ?? '没有可导入的角色卡', 'error')
        return
      }

      const created: FreeCharacter[] = []
      const warnOf = new Map<string, string[]>()
      for (const it of batch) {
        try {
          const c = await store.createFreeChar(it.card)
          // 批量导入**不逐张调 AI**：N 张就是 N 次模型调用，慢且费额度。
          // 先用离线摘录兜底，导入后可在每张卡上点「生成初版记忆」升级成 AI 整理版。
          await store.saveMemory(draftMemoryFromCard(c))
          warnOf.set(c.id, it.warnings)
          created.push(c)
        } catch {
          failed.push(`${it.name}：写库失败`)
        }
      }

      await load()
      const last = created[created.length - 1]
      if (last) {
        await open(last.id)
        setGaps(warnOf.get(last.id) ?? [])
      }

      const warnCount = created.filter(c => (warnOf.get(c.id) ?? []).length > 0).length
      if (created.length === 1) {
        const w = warnOf.get(created[0].id) ?? []
        showToast(
          w.length ? `已导入，但${describeWarnings(w)}` : '已导入，结构完整 · 初版记忆已按角色卡摘录',
          w.length ? 'info' : 'success')
      } else {
        const bits = [`已导入 ${created.length} 张`]
        if (warnCount) bits.push(`${warnCount} 张结构有缺（导入后可补）`)
        if (failed.length) bits.push(`${failed.length} 项失败`)
        bits.push('初版记忆已按角色卡摘录，可在每张卡上点「生成初版记忆」升级')
        // 导入的卡 storyId 为空（文件里没有故事这一层）—— 不说清的话，作者只会觉得「卡不见了」（审计 P1-4）
        bits.push('都落在「未归属」里：逐张选归属故事后才能用于对话')
        showToast(bits.join(' · '), failed.length ? 'info' : 'success')
      }
      if (failed.length) console.warn('[tavern] 角色卡导入失败明细：', failed)
    } catch (e) {
      showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  // ---------- 从小说角色 AI 转换（方案 §7.6） ----------
  const openNovelPicker = async () => {
    const out: { id: string; name: string; tabId: string }[] = []
    for (const tabId of ['char-main', 'char-secondary', 'char-npc']) {
      try {
        for (const r of await db.getCardRecords(tabId)) out.push({ id: r.id, name: r.name, tabId })
      } catch { /* 该表读不到就跳过 */ }
    }
    setNovelChars(out)
    setNq('')
    setNtab('all')
    setImportOpen(true)
    if (out.length === 0) showToast('当前项目里没有已建档的角色', 'info')
  }

  const convert = async (cardId: string, tabId: string) => {
    setConverting(true)
    try {
      const rec = (await db.getCardRecords(tabId)).find(r => r.id === cardId)
      if (!rec) { showToast('读不到该角色卡', 'error'); return }
      const { draft: d, gaps: g } = await convertNovelChar({
        name: rec.name,
        data: rec.data,
        source: { projectId: db.getCurrentProjectId(), cardId: rec.id },
      })
      const created = await store.createFreeChar({ ...d, name: `${d.name}（导入）` })
      // 初版记忆：导入的卡直接带着「Ta 是谁、跟谁什么关系」进来，不该从零开始
      const how = await seedMemory(created)
      await load()
      await open(created.id)
      setGaps(g)
      setImportOpen(false)
      const tip = g.length ? `草稿已生成，有 ${g.length} 处待补` : '草稿已生成，请审一遍再改'
      showToast(
        `${tip} · 初版记忆已生成（${how === 'ai' ? 'AI 整理' : '直接摘录'}）· 还没有归属故事，在卡里选一个才能用于对话`,
        g.length ? 'info' : 'success')
    } catch (e) {
      showToast(`转换失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setConverting(false)
    }
  }

  /**
   * 把当前卡面摊成文本，交给「补完」模式当起点。
   * 只给非空的栏 —— 空栏写了反而会诱导 AI 去「填空」，而我们希望它只补真正缺的。
   */
  const flattenCard = (c: FreeCharacter): string => ([
    ['名字', c.name],
    ['第 1 章 · 角色与设定的关系', c.world ?? ''],
    ['外在', c.profile?.externals ?? ''],
    ['内核', c.profile?.core ?? ''],
    ['语言特征', c.profile?.speech ?? ''],
    ['关系', c.profile?.relations ?? ''],
    ['做不到的事', c.profile?.cannot ?? ''],
    ['知识边界', c.profile?.knowledge ?? ''],
    ['视角与人称', c.conduct?.perspective ?? ''],
    ['底线清单', c.conduct?.bottomLine ?? ''],
    ['进度锁', c.conduct?.paceLock ?? ''],
    ['尺度', c.conduct?.rating ?? ''],
    ['示例对话', c.examples ?? ''],
  ] as [string, string][])
    .filter(([, v]) => String(v).trim())
    .map(([k, v]) => `〖${k}〗${String(v).trim()}`)
    .join('\n')

  /**
   * 把起草结果并进卡面。**空栏不覆盖**（AI 拿不准会留空，那是好事，别把作者写的冲掉）。
   * 改完只标记「未保存」—— 与其它字段一致，作者自己点保存。
   */
  const applyCardDraft = (f: CardDraft, label: string) => {
    setDraft(d => {
      if (!d) return d
      /**
       * 起草 / 小说角色转换 / 对话引导产出的都是 **AI 文本**，落库前先把
       * 「小项名: 内容」的**半角冒号**归成全角 —— 否则那一行认不出标签，
       * 会整行落进「其他」（`cardFields.normalizeStructMarkup`）。
       * 只有「这一栏有细字段模板」时才规范化，world / examples 是自由文本，原样收。
       */
      const pick = (v: string, cur: string, path: string) => {
        const t = v.trim()
        if (!t) return cur
        const spec = structSpecOf(path)
        return spec ? normalizeStructMarkup(t, spec) : t
      }
      return {
        ...d,
        name: pick(f.name, d.name, ''),
        world: pick(f.world, d.world ?? '', ''),
        profile: {
          ...d.profile,
          externals: pick(f.externals, d.profile?.externals ?? '', 'profile.externals'),
          core: pick(f.core, d.profile?.core ?? '', 'profile.core'),
          speech: pick(f.speech, d.profile?.speech ?? '', 'profile.speech'),
          relations: pick(f.relations, d.profile?.relations ?? '', 'profile.relations'),
          cannot: pick(f.cannot, d.profile?.cannot ?? '', 'profile.cannot'),
          knowledge: pick(f.knowledge, d.profile?.knowledge ?? '', 'profile.knowledge'),
        },
        conduct: {
          ...d.conduct,
          perspective: pick(f.perspective, d.conduct?.perspective ?? '', 'conduct.perspective'),
          bottomLine: pick(f.bottomLine, d.conduct?.bottomLine ?? '', 'conduct.bottomLine'),
          paceLock: pick(f.paceLock, d.conduct?.paceLock ?? '', 'conduct.paceLock'),
          rating: pick(f.rating, d.conduct?.rating ?? '', 'conduct.rating'),
        },
        examples: pick(f.examples, d.examples ?? '', ''),
      }
    })
    setDirty(true)
    showToast(`已填入卡面（${label}）—— 逐栏核对后点「保存」`)
  }

  const up = <K extends keyof FreeCharacter>(k: K, v: FreeCharacter[K]) => {
    setDraft(d => (d ? { ...d, [k]: v } : d))
    setDirty(true)
  }
  // 注：第 2、3 章改走 `TavernCardStructField`（细字段模板），不再需要整段 set 的小工具；
  //     它们写回库里仍是原有那十二个字符串字段（`writeCardField`）。

  /**
   * 与当前卡**同名**的其它卡。
   * 同名不等于同一人：记忆按角色 id 存，各存各的 —— 这里只是提前把这件事告诉作者，
   * 免得看到两张同名的卡就以为新卡抢走了老卡的记忆。
   */
  const sameNameOthers = draft && draft.name.trim()
    ? list.filter(i => i.id !== draft.id && i.name.trim() === draft.name.trim())
    : []

  return {
    // 左栏 / 页级
    loading, list, stories, draft, openIds, setOpenIds, gaps, setGaps, dirty,
    open, openCreatePicker, setAiDraftOpen, setInterviewOpen, openNovelPicker,
    fileRef, exportCard, exportAll, importCards,
    pickOpen, setPickOpen, pickStoryId, setPickStoryId, confirmCreate,
    aiDraftOpen, interviewOpen, flattenCard, applyCardDraft,
    duplicate, remove, save, saving,
    // 卡面 · 基本（Basics 要 draft / up / setDirty / stories / changeStory / sameNameOthers）
    up, setDraft, setDirty, changeStory, sameNameOthers,
    // 卡面 · Ta 的记忆
    mem, setMem, memDirty, setMemDirty, showMem, setShowMem,
    softLimit, savingMem, seedingMem, genMemory, saveMem, clearMem,
    // 卡面 · Ta 的日记
    journal, showJournal, setShowJournal, clearJournal, dropJournal,
    // 从小说角色导入弹窗（可见列表 novelRows / novelCount 已随弹窗走）
    importOpen, setImportOpen, novelChars, nq, setNq, ntab, setNtab, converting, convert,
  }
}

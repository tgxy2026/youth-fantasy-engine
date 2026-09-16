/**
 * 酒馆模式 · 角色卡片（tavern-card）
 *
 * 自由模式的角色卡管理：四章模板（世界 / 人物档案 / 行为规范 / 示例对话），分区块表单编辑。
 *
 * 【为什么是「分区块表单」而不是一个大文本框】
 * 四章是给模型的**不同层**用的：第 2 章管「Ta是谁」、第 3 章管「怎么演」、
 * 第 4 章管「照着这个说话」。合成一坨，作者一定会漏掉最关键的第四章。
 *
 * 【第 4 章「示例对话」是杠杆最高、也最容易被跳过的一章】
 * 手册实测：模型会**直接吸收**示例里的应对话术与格式。所以它在这一页拿到的是
 * 醒目位置（amber 边框）+ 三条硬规矩（踩过坑的），而不是和别的字段一样一个普通输入框：
 *   ① 格式必须与期望输出完全一致 —— 示例里写「角色名：台词」，正式输出就会照做
 *      （曾因此把人称带偏成第三人称）。**只给对方加标记（用输入侧符号 〖对方〗，不占输出字母表），角色那一侧不加任何前缀。**
 *   ② 三段覆盖不同侧面（常态 / 应激 / 松动），别都是同一情绪
 *   ③ 别写长 —— 三段短来回足够，写成整段剧情既费上下文又容易被照搬
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 *
 * 阶段：本页是 P2 范围（CRUD + 表单）。「从小说角色 AI 转换」与「导入导出 JSON」属 P3，
 * 页面上留了入口但**明确置灰并说明**，不假装能用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import HelpPopover from './HelpPopover'
import * as store from '../lib/tavern/store'
import * as db from '../lib/db'
import TavernCardStructField from './TavernCardStructField'
import { PROFILE_SPECS, CONDUCT_SPECS } from '../lib/tavern/cardFields'
import { listStories, storyDisplayName } from '../lib/tavern/story'
import { MEMORY_SOFT_LIMIT, JOURNAL_KEEP, cardStoryId, readCardField, writeCardField, type TavernStoryIndexItem } from '../lib/tavern/types'
import { charTag, VAR_DEFS, type FreeCharacter, type FreeMemory, type TavernCharIndexItem, type CharJournal, type CharJournalEntry, type CharVars } from '../lib/tavern/types'
import { MEMORY_SECTIONS, memoryChars, isMemoryEmpty } from '../lib/tavern/memory'
import { toCardFile, toCardBundle, parseCardFile, parseCardBundle, cardFileName, CARD_BUNDLE_SUFFIX, describeWarnings, type CardBundleItem } from '../lib/tavern/cardFile'
import { convertNovelChar } from '../lib/tavern/import'
import { coldStartMemory, draftMemoryFromCard } from '../lib/tavern/summarize'
import { renderFreeCharacter } from '../lib/tavern/engine'
import { getTavernSettings } from '../lib/tavern/settings'

import { Button } from './Button'
import Avatar from './Avatar'
import AvatarPicker from './AvatarPicker'
import TavernCardDraftDialog from './TavernCardDraftDialog'
import TavernInterviewDialog from './TavernInterviewDialog'
import { type CardDraft } from '../lib/tavern/draft'
import { interviewToCard } from '../lib/tavern/interview'
import { Modal } from './Modal'
import { showToast, confirmDialog } from './dialogs'
import { LoadingState } from './LoadingState'
import AutoTextarea from './AutoTextarea'


/** 单个字段（标题 + 说明 + 输入区）。说明写的是「填什么」，不是「这一栏是什么」。 */
function Field({ label, hint, value, onChange, rows = 3, ph }: {
  label: string; hint: string; value: string
  onChange: (v: string) => void; rows?: number; ph?: string
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] text-ink-200">{label}</span>
        <span className="text-[11px] text-ink-500">{hint}</span>
      </div>
      <AutoTextarea
        className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
        textClass="text-[12.5px]"
        minRows={rows}
        maxHeight={420}
        placeholder={ph}
        value={value}
        onChange={onChange}
      />
    </div>
  )
}

function SectionTitle({ children, sub }: { children: string; sub?: string }) {
  return (
    <div className="border-b border-ink-800 pb-1.5 mb-3">
      <h3 className="text-[13px] font-semibold text-amber/90">{children}</h3>
      {sub && <p className="mt-0.5 text-[11px] text-ink-500 leading-relaxed">{sub}</p>}
    </div>
  )
}

/** 从小说角色导入弹窗的分组页签 */
type NovelTab = 'all' | 'char-main' | 'char-secondary' | 'char-npc'
const NOVEL_TABS: { id: NovelTab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'char-main', label: '主要' },
  { id: 'char-secondary', label: '次要' },
  { id: 'char-npc', label: 'NPC' },
]
const NOVEL_TAB_LABEL: Record<string, string> = {
  'char-main': '主要', 'char-secondary': '次要', 'char-npc': 'NPC',
}

/**
 * 复制卡时的命名：加「（副本）」，重名就往后排（副本2、副本3…）。
 * 不加序号的话右栏会立刻出现两张同名卡 —— 那正是我们想替作者避免的困惑。
 */
/** 「未归属」分组的虚拟 id —— 它不是真故事，只是给自由状态的卡一个落脚的抽屉 */
const FREE_GROUP = '__free__'

function copyName(base: string, taken: Set<string>): string {
  const n = base.trim() || '未命名角色'
  let cand = `${n}（副本）`
  let i = 2
  while (taken.has(cand)) cand = `${n}（副本${i++}）`
  return cand
}

export default function TavernCard() {
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
  /** 树展开态：故事 id 集合。默认全展开 —— 卡不多时先让作者看见全貌，嫌占地方再自己收 */
  const [openIds, setOpenIds] = useState<string[]>([])
  /** 新建卡的第一步：先问它属于哪个故事 */
  const [pickOpen, setPickOpen] = useState(false)
  const [pickStoryId, setPickStoryId] = useState('')

  const load = useCallback(async () => {
    try {
      const [cs, ss] = await Promise.all([store.listFreeChars(), listStories()])
      setList(cs)
      setStories(ss)
      setOpenIds(prev => {
        const known = new Set(prev)
        const fresh = ss.map(s => s.id).filter(id => !known.has(id))
        // 有自由状态的卡 → 默认展开「未归属」，别让它们藏起来没人管
        if (cs.some(c => !cardStoryId(c)) && !known.has(FREE_GROUP)) fresh.push(FREE_GROUP)
        return fresh.length ? [...prev, ...fresh] : prev
      })
    } catch {
      setList([])
      setStories([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const open = async (id: string) => {
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
      const m = await coldStartMemory({
        charId: card.id,
        charName: card.name,
        charContext: renderFreeCharacter(card),
        providerId: st.free.summaryProviderId || undefined,
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
      const pick = (v: string, cur: string) => (v.trim() ? v.trim() : cur)
      return {
        ...d,
        name: pick(f.name, d.name),
        world: pick(f.world, d.world ?? ''),
        profile: {
          ...d.profile,
          externals: pick(f.externals, d.profile?.externals ?? ''),
          core: pick(f.core, d.profile?.core ?? ''),
          speech: pick(f.speech, d.profile?.speech ?? ''),
          relations: pick(f.relations, d.profile?.relations ?? ''),
          cannot: pick(f.cannot, d.profile?.cannot ?? ''),
          knowledge: pick(f.knowledge, d.profile?.knowledge ?? ''),
        },
        conduct: {
          ...d.conduct,
          perspective: pick(f.perspective, d.conduct?.perspective ?? ''),
          bottomLine: pick(f.bottomLine, d.conduct?.bottomLine ?? ''),
          paceLock: pick(f.paceLock, d.conduct?.paceLock ?? ''),
          rating: pick(f.rating, d.conduct?.rating ?? ''),
        },
        examples: pick(f.examples, d.examples ?? ''),
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

/** 导入弹窗的可见列表：分组页签 + 关键字（按名字） */
  const novelRows = useMemo(() => {
    const kw = nq.trim().toLowerCase()
    return novelChars.filter(c =>
      (ntab === 'all' || c.tabId === ntab) && (!kw || c.name.toLowerCase().includes(kw)))
  }, [novelChars, nq, ntab])
  const novelCount = (id: NovelTab) =>
    id === 'all' ? novelChars.length : novelChars.filter(c => c.tabId === id).length

  /**
   * 与当前卡**同名**的其它卡。
   * 同名不等于同一人：记忆按角色 id 存，各存各的 —— 这里只是提前把这件事告诉作者，
   * 免得看到两张同名的卡就以为新卡抢走了老卡的记忆。
   */
  const sameNameOthers = draft && draft.name.trim()
    ? list.filter(i => i.id !== draft.id && i.name.trim() === draft.name.trim())
    : []

  /**
   * 角色卡按故事分组（老大 2026-09-16 定：树状结构，卡归属于故事）。
   *
   * 🔴 **`unbound` 是必须的兜底分组**：删故事时角色卡**不删，只解除归属** ——
   *    这些卡要有地方落脚，且必须能在编辑时重新归类到别的故事下。
   *    顺带把「索引里挂着已不存在故事的孤儿卡」也收进来，否则那批卡会凭空消失在列表里。
   */
  const groups = useMemo(() => {
    const byStory = new Map<string, TavernCharIndexItem[]>()
    const free: TavernCharIndexItem[] = []
    for (const c of list) {
      const sid = cardStoryId(c)
      if (!sid) { free.push(c); continue }
      const arr = byStory.get(sid) ?? []
      arr.push(c)
      byStory.set(sid, arr)
    }
    const knownIds = new Set(stories.map(s => s.id))
    const known = stories.map(s => ({ id: s.id, name: s.name, chars: byStory.get(s.id) ?? [] }))
    const orphan: TavernCharIndexItem[] = []
    for (const [sid, arr] of byStory) if (!knownIds.has(sid)) orphan.push(...arr)
    return { known, unbound: [...free, ...orphan] }
  }, [list, stories])

  const toggleStory = (id: string) =>
    setOpenIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  /**
   * 「复制为新卡 / 删除 / 保存」——卡面顶部（头像右侧）与编辑区底部**各放一份**
   * （老大 2026-09-16 反馈 #9：这张卡很长，这三个按钮原先只挂在最底部，
   *  改完一处得一路滚到底才存得上，来回很别扭）。
   *
   * 🔴 抽成**一个变量渲染两处**，而不是复制两段 JSX：
   *    ① 复制逻辑最容易出现「同一个动作、两个按钮行为不一致」；
   *    ② 两处必须共享同一份状态 —— `dirty`（没改动时一起变灰）与 `saving`（保存中一起变「保存中…」）。
   */
  const actionButtons = (
    <>
      <Button
        variant="secondary" size="md" onClick={() => void duplicate()}
        title="四章照抄一份新卡，可在它基础上改；记忆与日常状态不复制"
      >
        复制为新卡
      </Button>
      <Button variant="danger" size="md" onClick={remove}>删除</Button>
      <Button variant="primary" size="md" disabled={!dirty || saving} onClick={save}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </>
  )

  /** 左栏的一张卡（不管挂在哪个分组下，长相一致 —— 免得作者以为两种卡不一样） */
  const charRow = (c: TavernCharIndexItem) => (
    <li key={c.id}>
      <button
        type="button"
        onClick={() => void open(c.id)}
        className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
          draft?.id === c.id ? 'bg-amber/15 border border-amber/30' : 'border border-transparent hover:bg-ink-800/60'
        }`}
      >
        <Avatar src={c.avatar} name={c.name} size={24} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.name || '未命名角色'}</span>
      </button>
    </li>
  )

  return (
    /* 固定头部 + 下方独立滚动区：滚动只发生在标题条**下面**，
       内容不会再滑到条子后面被半透明条盖住（原先 sticky + bg-ink-900/95 的观感问题）。 */
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-800 pb-3">
        <div className="flex items-center gap-1.5">

          <h1 className="text-xl font-bold text-ink-50">角色卡片</h1>

          <HelpPopover title="角色卡片怎么填" width="24rem" size={14}>
  一张卡 = AI 的「人设说明书」：写得越具体，演得越像。四章模板：

  • 归属故事：决定这张卡用哪一套世界观 —— 世界设定写在「故事剧本」页的故事里，这里不再重复。
  • 第 1 章 角色与设定的关系：不写世界本身（世界观在「故事剧本」的故事里），只写身份、处境、常去的地方。
  • 第 2 章 人物档案 / 第 3 章 行为规范：都是按小项分条填的表格（如「外貌：短发」一行一项），
    模板没覆盖到的写进该栏的「其他」。不确定怎么填就先看每格的灰字例句。
  • 第 4 章 示例对话：AI 会照着它的格式与语气模仿，所以按输出规范写（对白不带名字、除对白外一律套（ ））。

  两种起手方式（右上「AI 起草」）：已经想清楚了 → 一句话补全；只有点感觉、说不清 → 对话引导，
  让 AI 按上面的模板一轮轮问你，边聊边成形。
  卡片是全局的（跨项目、换书照样在），也能导出成文件发给别人。
</HelpPopover>

        </div>
        <p className="text-[12px] text-ink-400 mt-1">
          自由模式的角色卡片：四章模板 + 归属故事（世界观在故事里，不用重复写）。
          左栏按故事分组，「未归属」抽屉存放暂时不属于任何故事的卡。
        </p>

      </header>

      {loading ? <div className="min-h-0 flex-1 overflow-y-auto pt-3"><LoadingState /></div> : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
        <div className="flex gap-4 min-h-0">
          {/* 左：角色列表 */}
          <aside className="w-56 shrink-0 space-y-2">
            <Button variant="primary" size="md" className="w-full" onClick={openCreatePicker}>新建角色卡</Button>

            {/* 两个 AI 入口：想清楚了用一句话起草，只有个感觉就用对话引导 */}
            <div className="flex gap-1.5">
              <Button
                variant="secondary" size="sm" className="flex-1 text-[11.5px]"
                disabled={!draft} onClick={() => setAiDraftOpen(true)}
                title="一句话（或粘一段素材）→ AI 按四章模板填写"
              >
                AI 起草
              </Button>
              <Button
                variant="secondary" size="sm" className="flex-1 text-[11.5px]"
                disabled={!draft} onClick={() => setInterviewOpen(true)}
                title="AI 按模板提纲一轮一轮地问，边聊边把这张卡塑出来"
              >
                对话引导
              </Button>
            </div>

            {list.length === 0 ? (
              <p className="text-[11.5px] text-ink-500 leading-relaxed px-1 pt-1">
                还没有角色卡。点上面「新建」开始 —— 新建时要先选这张卡属于哪个故事。
              </p>
            ) : (
              <div className="space-y-1">
                {groups.known.map(g => {
                  const open = openIds.includes(g.id)
                  return (
                    <div key={g.id}>
                      <button
                        type="button"
                        onClick={() => toggleStory(g.id)}
                        className="w-full flex items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-ink-800/60 transition-colors"
                        title={open ? '收起这个故事下的角色卡' : '展开这个角色下的角色卡'}
                      >
                        <span className={`text-[10px] text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-200">{storyDisplayName(g)}</span>
                        <span className="text-[10.5px] text-ink-500 shrink-0">{g.chars.length}</span>
                      </button>
                      {open && (
                        <ul className="ml-2 pl-1.5 border-l border-ink-800 space-y-0.5 mt-0.5">
                          {g.chars.length
                            ? g.chars.map(charRow)
                            : <li className="px-2 py-1 text-[11px] text-ink-600">这个故事下还没有角色卡</li>}
                        </ul>
                      )}
                    </div>
                  )
                })}

                {/* 未归属（自由状态）：删故事留下的卡都在这儿，等着被重新归类 —— 不能让它凭空没地方去 */}
                {groups.unbound.length > 0 && (() => {
                  const open = openIds.includes(FREE_GROUP)
                  return (
                    <div>
                      <button
                        type="button"
                        onClick={() => toggleStory(FREE_GROUP)}
                        className="w-full flex items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-ink-800/60 transition-colors"
                        title="不属于任何故事的角色卡（通常是故事被删了）—— 打开卡片可以在「归属故事」里重新归类"
                      >
                        <span className={`text-[10px] text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-amber/80">未归属</span>
                        <span className="text-[10.5px] text-ink-500 shrink-0">{groups.unbound.length}</span>
                      </button>
                      {open && (
                        <ul className="ml-2 pl-1.5 border-l border-amber/25 space-y-0.5 mt-0.5">
                          {groups.unbound.map(charRow)}
                        </ul>
                      )}
                    </div>
                  )
                })()}
              </div>
            )}

            <div className="pt-2 border-t border-ink-800 space-y-1.5">
              <Button variant="secondary" size="sm" className="w-full text-[11.5px]" onClick={() => void openNovelPicker()}>
                从小说角色导入
              </Button>
              <div className="flex gap-1.5">
                <Button
                  variant="secondary" size="sm" className="flex-1 text-[11.5px]"
                  onClick={() => fileRef.current?.click()}
                  title="支持单卡文件、整批文件（一个文件里多张卡），也可以一次选中多个文件"
                >
                  导入 JSON
                </Button>
                <Button variant="secondary" size="sm" className="flex-1 text-[11.5px]" disabled={!draft} onClick={exportCard}>
                  导出 JSON
                </Button>
              </div>
              <Button
                variant="secondary" size="sm" className="w-full text-[11.5px]"
                disabled={list.length === 0}
                onClick={() => void exportAll()}
                title="把全部角色卡打包成一个文件（整批备份 / 分享给同好），与「导入 JSON」的批量入口对称"
              >
                导出全部（{list.length} 张）
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                multiple
                className="hidden"
                onChange={e => {
                  const picked = Array.from(e.target.files ?? [])
                  if (picked.length) void importCards(picked)
                  e.target.value = '' // 允许连续导入同一批文件
                }}
              />
              <p className="text-[10.5px] text-ink-600 leading-relaxed px-1">
                「从小说角色导入」是 AI 转换，结果只是草稿，必须审。
              </p>
            </div>
          </aside>

          {/* 右：编辑区 */}
          <div className="flex-1 min-w-0">
            {!draft ? (
              <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-12 text-center">
                <p className="text-[13px] text-ink-300">选一张角色卡开始编辑</p>
                <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                  四章模板里，<span className="text-amber">第 4 章「示例对话」最影响演出效果</span> ——
                  模型会直接照着你给的示例说话。
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-4 space-y-6">
                {/* 草稿待补提示（AI 转换/导入后必须让作者看见） */}
                {gaps.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11.5px] text-ink-300 leading-relaxed">
                        <span className="text-amber/90">这张卡有 {gaps.length} 处还需要你补：</span>
                        {gaps.join('、')}
                        {gaps.some(g => g.includes('示例对话')) && '（示例对话通常是模型编的，最该改）'}
                      </p>
                      <Button variant="secondary" size="xs" onClick={() => setGaps([])} className="shrink-0">
                        知道了
                      </Button>
                    </div>
                  </div>
                )}

                {/* 未归属提示（审计 P1-4）：导入 / AI 转换进来的卡 storyId 是空的。
                    旧流程里作者只会看到左栏多一张卡，根本不知道"还要归类" ——
                    而没归属的卡在「新建对话」的角色列表里根本选不到（角色按故事过滤），
                    表现就是「这张卡怎么不出现」，却看不出原因。 */}
                {!cardStoryId(draft) && stories.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2">
                    <p className="text-[11.5px] text-ink-300 leading-relaxed">
                      <span className="text-amber/90">这张卡还没有归属故事</span> —— 没有归属，
                      对话时拿不到世界观，也不会出现在「新建对话」的角色列表里。
                      在下面「归属故事」里选一个，它就能用了。
                    </p>
                  </div>
                )}

                {/* 基本 */}
                <div>
                  {/* 头像（批次 8）：角色卡片、自由对话气泡、状态栏、在场者一览共用同一张图 */}
                  <div className="mb-3">
                    <AvatarPicker
                      src={draft.avatar}
                      name={draft.name}
                      size={64}
                      onChange={v => up('avatar', v)}
                      hint="不设也能用 —— 会话气泡与列表会用名字首字代替。头像随卡片一起存进数据文件。"
                      /* 复制 / 删除 / 保存 提到这儿：与「上传图片」同一行，不用滚到底（反馈 #9） */
                      actions={actionButtons}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Avatar src={draft.avatar} name={draft.name} size={36} />
                    <input
                      className="flex-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-2 text-[15px] font-semibold text-ink-50 outline-none focus:border-amber/50"
                      value={draft.name}
                      placeholder="角色名"
                      onChange={e => up('name', e.target.value)}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-500">
                    角色卡是 AI 的「人设说明书」—— 写得越具体，演得越像。
                  </p>

                  {/* 归属故事（老大 2026-09-16）：世界观交给故事层，卡里只写角色自己 */}
                  <div className="mt-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] text-ink-200">归属故事</span>
                      <span className="text-[11px] text-ink-500">决定对话时用哪一套世界观</span>
                    </div>
                    <select
                      className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none focus:border-amber/50"
                      value={cardStoryId(draft)}
                      onChange={e => void changeStory(e.target.value)}
                    >
                      <option value="">（不归属任何故事）</option>
                      {stories.map(s => <option key={s.id} value={s.id}>{storyDisplayName(s)}</option>)}
                    </select>
                    <p className="mt-1 text-[11px] leading-relaxed">
                      {cardStoryId(draft) ? (
                        <span className="text-ink-500">世界设定由这个故事提供，卡里不用再写一遍。</span>
                      ) : (
                        <span className="text-amber/80">
                          这张卡现在是「自由状态」—— 不属于任何故事，对话时会拿不到世界观。在上面选一个故事就能归类。
                        </span>
                      )}
                    </p>
                  </div>
                  {/* 本卡数值状态（老大 2026-09-16 反馈 #4）：持久、跨会话累积，存角色卡 */}
                  <div className="mt-3 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] text-ink-200">本卡数值状态</span>
                      <span className="text-[11px] text-ink-500">持久保存 · 跨会话累积 · 模型每轮读取并改写</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                      好感 / 信任 / 精神 / 心情 / 地点：对话里被模型按剧情推进，也随时可手改。
                      每项可附一句备注（模型会读取、数值变化时会一并改写，如「好感 45 → 从陌生到熟悉的朋友」）。
                    </p>
                    <div className="mt-2 space-y-2">
                      {VAR_DEFS.map(def => {
                        const cv = draft.vars
                        const val = cv?.values?.[def.key]
                        const note = cv?.notes?.[def.key] ?? ''
                        const setVal = (raw: string) => {
                          const cur: CharVars = cv ?? { values: {}, notes: {} }
                          const values = { ...cur.values }
                          if (def.kind === 'num') {
                            const n = Number(raw.trim())
                            values[def.key] = raw.trim() === '' || !Number.isFinite(n) ? (def.init as number) : n
                          } else {
                            values[def.key] = raw
                          }
                          up('vars', { values, notes: { ...cur.notes } })
                          setDirty(true)
                        }
                        const setNote = (text: string) => {
                          const cur: CharVars = cv ?? { values: {}, notes: {} }
                          const notes = { ...cur.notes }
                          if (text.trim()) notes[def.key] = text.trim()
                          else delete notes[def.key]
                          up('vars', { values: { ...cur.values }, notes })
                          setDirty(true)
                        }
                        return (
                          <div key={def.key} className="rounded-md border border-ink-800 bg-ink-900/60 p-2">
                            <div className="flex items-center gap-2">
                              <span className="w-12 shrink-0 text-[11px] text-ink-300">{def.label}</span>
                              <input
                                key={`val-${def.key}-${String(val ?? 'empty')}`}
                                defaultValue={val === undefined || val === '' ? (def.kind === 'num' ? String(def.init) : '') : String(val)}
                                onBlur={e => setVal(e.target.value)}
                                inputMode={def.kind === 'num' ? 'numeric' : undefined}
                                placeholder={def.kind === 'num' ? String(def.init) : '（未填）'}
                                className="w-24 min-w-0 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11.5px] text-ink-100 outline-none focus:border-amber/50"
                              />
                              {def.kind === 'num' && (
                                <span className="text-[10px] text-ink-600">{def.min}–{def.max}</span>
                              )}
                            </div>
                            <input
                              key={`note-${def.key}-${note}`}
                              defaultValue={note}
                              onBlur={e => setNote(e.target.value)}
                              placeholder="备注（模型会读取 / 改写，如：从陌生到熟悉的朋友）"
                              className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-300 outline-none focus:border-amber/40"
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>

                {sameNameOthers.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-[11.5px] text-ink-300 leading-relaxed">
                    ⚠️ 已有 {sameNameOthers.length} 张卡也叫「{draft.name.trim()}」。
                    <span className="text-ink-100">同名不等于同一个人</span>：记忆、日常状态、聊天记录都各存各的
                    （记忆按角色 id 绑定），新建或复制同名卡不会抢走那一张的记忆。
                    同一场对话里同时出现时，提示词会给它们挂稳定短码区分 —— 这张是
                    <span className="text-amber"> #{charTag(draft.id)}</span>，另一张是
                    <span className="text-amber"> #{charTag(sameNameOthers[0].id)}</span>。
                    想少混淆，建议改名加区别（如「小满（旧版）」）。
                  </div>
                )}

                {/* 第 1 章 */}
                <section>
                  <SectionTitle sub="世界设定写在「故事剧本」页的故事里 —— 这里只写角色在世界里的位置（不重复写世界本身）。">
                    第 1 章 · 角色与设定的关系
                  </SectionTitle>
                  <Field label="角色与设定的关系" hint="Ta的身份、处境、常去的地方，以及这个世界如何影响Ta" rows={3}
                    value={draft.world} onChange={v => up('world', v)}
                    ph="例：这家便利店的夜班店员，欠着债所以不能辞；认识附近多半的老顾客。" />
                </section>

                {/* 第 2 章 */}
                <section>
                  <SectionTitle sub="Ta是谁 —— 这一章决定角色立不立得住。">
                    第 2 章 · 人物档案
                  </SectionTitle>
                  <div className="space-y-3">
                    {PROFILE_SPECS.map(spec => (
                      <TavernCardStructField
                        key={spec.path}
                        spec={spec}
                        label={spec.label}
                        value={readCardField(draft, spec.path)}
                        onChange={v => {
                          setDraft(prev => (prev ? writeCardField(prev, spec.path, v) : prev))
                          setDirty(true)
                        }}
                      />
                    ))}
                  </div>
                </section>

                {/* 第 3 章 */}
                <section>
                  <SectionTitle sub="怎么演Ta —— 这一章防 OOC（演崩）。">
                    第 3 章 · 行为规范
                  </SectionTitle>
                  <div className="space-y-3">
                    {CONDUCT_SPECS.map(spec => (
                      <TavernCardStructField
                        key={spec.path}
                        spec={spec}
                        label={spec.label}
                        value={readCardField(draft, spec.path)}
                        onChange={v => {
                          setDraft(prev => (prev ? writeCardField(prev, spec.path, v) : prev))
                          setDirty(true)
                        }}
                      />
                    ))}
                  </div>
                </section>

                {/* 第 4 章：醒目 */}
                <section className="rounded-lg border border-amber/35 bg-amber/5 p-3">
                  <SectionTitle sub="模型会直接照着你给的示例说话 —— 这一章比上面三章加起来还影响效果。">
                    第 4 章 · 示例对话（杠杆最高）
                  </SectionTitle>
                  <div className="mb-2.5 rounded-md bg-ink-900/60 border border-ink-700 px-3 py-2">
                    <p className="text-[11.5px] text-ink-300 font-medium">四条硬规矩（前两条是踩过的坑）</p>
                    <ul className="mt-1 space-y-1 text-[11px] text-ink-400 leading-relaxed">
                      <li>
                        <span className="text-amber/90">① 格式必须和你要的输出完全一致。</span>
                        示例里若写「名字：台词」，正式输出也会带上名字前缀 —— <span className="text-ink-200">把名字单独起一行同样算</span>，人称甚至被带偏成第三人称。
                        <span className="text-ink-200">正确做法：对方的台词用 〖对方〗 标出来（这是给模型看的输入侧标注，不在输出字母表里），你这侧的对白不加任何前缀。</span>
                      </li>
                      <li>
                        <span className="text-amber/90">② 只有两种标记。</span>
                        对白＝纯文本（正常标点）；动作、神态、心理、环境＝（ ）独立成行。
                        除对白之外的一切都用（ ），一件事一个括号。示例里怎么标，输出就得怎么标。
                      </li>
                      <li><span className="text-amber/90">③ 三段覆盖不同侧面</span>（常态 / 被戳到时 / 松动时），别都是同一种情绪。</li>
                      <li><span className="text-amber/90">④ 别写长。</span>三段短来回就够 —— 写成整段剧情既费上下文，又容易被照搬。</li>
                    </ul>
                  </div>
                  <AutoTextarea
                    className="bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                    textClass="text-[12.5px]"
                    minRows={8}
                    maxHeight={520}
                    placeholder={[
                      '〖对方〗这么晚还不下班？',
                      '（把找零推过去，没抬头）',
                      '灯还亮着。',
                      '',
                      '（门外下着雨，玻璃上蒙了一层水汽）',
                      '〖对方〗你一个人看店不怕吗？',
                      '（停了一下，把手里的抹布搭在台面上）',
                      '惯了。',
                      '',
                      '〖对方〗……谢谢。',
                      '（背过身去理货架，声音很轻）',
                      '伞在门后。',
                    ].join('\n')}
                    value={draft.examples}
                    onChange={v => up('examples', v)}
                  />
                </section>

                {/* 记忆：AI 会整理，但作者也该能直接改（否则压错了只能删卡重来） */}
                <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="flex flex-wrap items-center gap-x-2 text-[13px] font-semibold text-amber/90">
                        Ta的记忆（可手动编辑）
                        {mem && !isMemoryEmpty(mem) && (
                          <span
                            className={`text-[10.5px] font-normal ${memoryChars(mem) > softLimit ? 'text-amber' : 'text-ink-600'}`}
                            title={`记忆软上限 ${softLimit} 字（控制面板 → 七、自由对话控制）：超过只提醒，不会硬截断`}
                          >
                            {memoryChars(mem)} / {softLimit} 字
                            {memoryChars(mem) > softLimit ? ' · 偏长，整理时会先压「长期摘要」' : ''}
                          </span>
                        )}
                      </h3>
                      <p className="mt-0.5 text-[11px] text-ink-500 leading-relaxed">
                        六栏记忆就在这里。AI 整理时会在此基础上压缩；你也可以直接改，改完点「保存记忆」。
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {memDirty && <span className="text-[11px] text-amber">有未保存的改动</span>}
                      {(!mem || isMemoryEmpty(mem)) && (
                        <Button variant="secondary" size="sm" disabled={seedingMem} onClick={() => void genMemory()}
                          title="依据这张角色卡生成第一版六栏记忆（AI 优先，失败则直接摘录角色卡）">
                          {seedingMem ? '生成中…' : '依据角色卡生成初版记忆'}
                        </Button>
                      )}
                      {showMem && (
                        <Button variant="primary" size="sm" disabled={!memDirty || savingMem} onClick={() => void saveMem()}>
                          {savingMem ? '保存中…' : '保存记忆'}
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={() => setShowMem(v => !v)}>
                        {showMem ? '收起' : '展开编辑'}
                      </Button>
                      {mem && !isMemoryEmpty(mem) && (
                        <Button variant="danger" size="sm" onClick={() => void clearMem()}
                          title="把六栏记忆全部清空（不可撤销，会先弹窗确认）">
                          清空记忆
                        </Button>
                      )}
                    </div>
                  </div>

                  {!showMem ? (
                    <p className="mt-2 text-[11.5px] text-ink-400">
                      当前 {mem ? memoryChars(mem) : 0} 字 ·
                      更新于 {mem ? new Date(mem.updatedAt).toLocaleString('zh-CN') : '（还没有记忆）'}
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 rounded-md border border-amber/25 bg-amber/8 px-2.5 py-2 text-[11px] text-ink-300 leading-relaxed">
                        ⚠️ 六栏的行为不一样：<span className="text-ink-100">长期摘要</span>会被压缩、
                        <span className="text-ink-100">关键事实</span>与<span className="text-ink-100">未爆的雷</span>只增不改、
                        <span className="text-ink-100">关系状态</span>每次整理重写、
                        <span className="text-ink-100">最近日记</span>只留最近几天。
                        手改时别把「只增」的两栏清空 —— 那等于让Ta失忆。
                      </p>
                      <div className="mt-3 space-y-3">
                        {MEMORY_SECTIONS.map(sec => (
                          <div key={sec.key}>
                            <div className="text-[11.5px] text-ink-200">{sec.title}</div>
                            <AutoTextarea
                              className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                              textClass="text-[12px]" minRows={2} maxHeight={360}
                              value={String(mem?.[sec.key] ?? '')}
                              onChange={v => {
                                setMem(m => (m ? { ...m, [sec.key]: v } : m))
                                setMemDirty(true)
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {/* 日记：每场对话结束时写的一条回顾（老大 2026-09-16 定）
                    🔴 与记忆的根本区别：日记**不进 AI 上下文**。所以它可以写细、
                       可以让人读，而记忆必须压成干巴巴的条目。界面上必须把这点讲清，
                       否则作者会以为「日记也喂给 AI」而不敢写长。 */}
                <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-amber/90">Ta的日记</h3>
                      <p className="mt-0.5 text-[11px] text-ink-500 leading-relaxed">
                        每次点「结束本轮对话」时，由 Ta 以<span className="text-ink-400">第一人称</span>写一段 ——
                        记这一场发生了什么，以及 Ta 自己的感受。
                      </p>
                      <p className="mt-1 text-[10.5px] text-ink-600 leading-relaxed">
                        🔒 <span className="text-ink-500">只读</span>（日记是 Ta 的，不给改）；
                        它<span className="text-ink-400">从来不参与 AI 上下文</span>，随便翻、随便删都不会影响 Ta 的记忆。
                        只有「删除」一个操作 —— 删掉不可恢复。
                      </p>
                      <p className="mt-1 text-[10.5px] text-ink-600 leading-relaxed">
                        注意别和记忆里那一栏搞混：记忆的「六、最近日记」是给 AI 看的，每轮都进上下文、只能一行一事；
                        这里是给「你」看的回顾，写得越细越好。
                      </p>
                      {!!journal?.entries.length && (
                        <p className="mt-1 text-[10.5px] text-ink-600">
                          共 {journal.entries.length} 条
                          {journal.entries.length >= JOURNAL_KEEP
                            ? `（已到上限 ${JOURNAL_KEEP} 条：再写新的会滚掉最老的一条）`
                            : `（最多留 ${JOURNAL_KEEP} 条，超出滚掉最老的）`}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setShowJournal(v => !v)}>
                        {showJournal ? '收起' : '展开'}
                      </Button>
                      {!!journal?.entries.length && (
                        <Button variant="danger" size="sm" onClick={() => void clearJournal()}
                          title="删掉这本日记的全部条目（不可撤销，会先弹窗确认）">
                          清空日记
                        </Button>
                      )}
                    </div>
                  </div>

                  {!journal?.entries.length ? (
                    <p className="mt-2 text-[11.5px] text-ink-500">
                      还没有日记。去「自由对话」聊一场，点「结束本轮对话」就会记下第一段。
                    </p>
                  ) : !showJournal ? (
                    <p className="mt-2 text-[11.5px] text-ink-400">
                      共 {journal.entries.length} 条 ·
                      最近一次 {new Date(journal.entries[0].at).toLocaleString('zh-CN')} ·
                      「{journal.entries[0].sessionTitle}」
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2.5">
                      {journal.entries.map(e => (
                        <li key={e.id} className="rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 text-[10.5px] text-ink-500">
                              <span>{new Date(e.at).toLocaleString('zh-CN')}</span>
                              {e.sessionTitle && <span className="ml-1.5 text-ink-400">「{e.sessionTitle}」</span>}
                              {e.cast.length > 0 && <span className="ml-1.5">在场：{e.cast.join('、')}</span>}
                            </div>
                            <Button
                              variant="secondary" size="xs" className="shrink-0"
                              title="删掉这一条（不可恢复，会先弹窗确认）"
                              onClick={() => void dropJournal(e)}
                            >
                              删除
                            </Button>
                          </div>
                          <p className="mt-1 text-[12px] text-ink-200 whitespace-pre-wrap leading-relaxed">{e.text}</p>
                          <p className="mt-1 text-[10px] text-ink-600">（Ta 的第一人称回顾 · 只读）</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* 操作 */}
                <div className="flex items-center justify-between border-t border-ink-800 pt-3">
                  <span className="text-[11px] text-ink-500">
                    {dirty ? '有未保存的改动' : `上次保存：${new Date(draft.updatedAt).toLocaleString('zh-CN')}`}
                  </span>
                  {/* 与卡面顶部那组是**同一份 JSX**（`actionButtons`）—— 两处按钮不可能走样 */}
                  <div className="flex gap-2">{actionButtons}</div>
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      )}

      {/* 从小说角色导入：选一个角色 */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="从小说角色导入" width="lg">
        <div className="space-y-3">
          <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-[11.5px] text-ink-300 leading-relaxed">
            AI 会把这个角色改写成角色扮演用的四章卡片：设定翻译成行为倾向、剧情走向丢掉。
            <span className="text-amber/90"> 结果只是一份草稿 —— 尤其第 4 章示例对话通常是它编的，务必自己改。</span>
          </div>
          {novelChars.length > 0 && (
            <>
              <input
                className="w-full bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-100 outline-none focus:border-amber/50"
                placeholder="搜索角色（按名字）"
                value={nq}
                onChange={e => setNq(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {NOVEL_TABS.map(t => (
                  <Button
                    key={t.id} variant="toggle" size="xs"
                    selected={ntab === t.id}
                    onClick={() => setNtab(t.id)}
                  >
                    {t.label} {novelCount(t.id)}
                  </Button>
                ))}
              </div>
            </>
          )}
          {novelChars.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-ink-500">
              当前项目里没有已建档的角色。先去小说项目填几张角色卡再来。
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto space-y-1">
              {novelRows.map(c => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={converting}
                    onClick={() => void convert(c.id, c.tabId)}
                    className="w-full flex items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-ink-800/60 disabled:opacity-50"
                  >
                    <Avatar name={c.name} size={24} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.name}</span>
                    <span className="shrink-0 text-[10.5px] text-ink-600">
                      {NOVEL_TAB_LABEL[c.tabId] ?? c.tabId}
                    </span>
                  </button>
                </li>
              ))}
              {novelRows.length === 0 && (
                <li className="px-3 py-6 text-center text-[12px] text-ink-500">没有匹配的角色</li>
              )}
            </ul>
          )}
          <div className="flex items-center justify-between border-t border-ink-800 pt-2">
            <span className="text-[11px] text-ink-500">
              {converting
                ? '正在转换（要读一遍角色卡，可能要十几秒）…'
                : `共 ${novelChars.length} 个角色${novelRows.length === novelChars.length ? "" : ` · 命中 ${novelRows.length} 个`}`}
            </span>
            <Button variant="secondary" size="md" onClick={() => setImportOpen(false)} disabled={converting}>关闭</Button>
          </div>
        </div>
      </Modal>

      {/* 新建角色卡第一步：选归属故事。为什么不在卡里填完再回头补 —— 没归属的卡对话时是悬空的 */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="这张卡属于哪个故事？" width="md">
        <div className="space-y-3">
          <p className="text-[12px] text-ink-300 leading-relaxed">
            故事决定「这个世界什么样」；角色卡只写角色自己。选一个故事之后，这张卡对话时就用它的世界观。
          </p>
          <select
            className="w-full bg-ink-900 border border-ink-700 rounded-md px-2.5 py-2 text-[12.5px] text-ink-100 outline-none focus:border-amber/50"
            value={pickStoryId}
            onChange={e => setPickStoryId(e.target.value)}
          >
            {stories.map(s => <option key={s.id} value={s.id}>{storyDisplayName(s)}</option>)}
          </select>
          <p className="text-[11px] text-ink-500 leading-relaxed">
            想在另一个世界里用同一个角色 —— 复制这张卡再改归属就行，两张卡的记忆互不干扰。
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setPickOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" onClick={() => void confirmCreate()}>创建角色卡</Button>
          </div>
        </div>
      </Modal>

      <TavernCardDraftDialog
        open={aiDraftOpen}
        {...(draft ? { existing: flattenCard(draft) } : {})}
        onClose={() => setAiDraftOpen(false)}
        onApply={(fields, source) => applyCardDraft(fields, source.label)}
      />

      <TavernInterviewDialog
        open={interviewOpen}
        kind="card"
        subject="角色卡"
        {...(draft ? { existing: flattenCard(draft) } : {})}
        onClose={() => setInterviewOpen(false)}
        onApply={filled => applyCardDraft(interviewToCard(filled), '对话引导')}
      />
    </div>
  )
}

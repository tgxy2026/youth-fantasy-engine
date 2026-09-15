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
import TavernEchoHints from './TavernEchoHints'
import * as store from '../lib/tavern/store'
import * as db from '../lib/db'
import { charTag, type FreeCharacter, type FreeMemory, type TavernCharIndexItem } from '../lib/tavern/types'
import { MEMORY_SECTIONS, memoryChars, isMemoryEmpty } from '../lib/tavern/memory'
import { toCardFile, parseCardFile, cardFileName, describeWarnings } from '../lib/tavern/cardFile'
import { convertNovelChar } from '../lib/tavern/import'
import { isSeedCard, resetCardToSeed } from '../lib/tavern/seedCards'
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
  const [savingMem, setSavingMem] = useState(false)
  const [seedingMem, setSeedingMem] = useState(false)
  const [novelChars, setNovelChars] = useState<{ id: string; name: string; tabId: string }[]>([])
  const [converting, setConverting] = useState(false)
/** 导入弹窗的筛选态：角色多时靠它定位。每次打开重置，免得留下上次的关键字 */
  const [nq, setNq] = useState('')
  const [ntab, setNtab] = useState<NovelTab>('all')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setList(await store.listFreeChars())
    } catch {
      setList([])
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
  }

  /** 保存手工改过的记忆（与 AI 整理走同一个存储口，更新 updatedAt） */
  const saveMem = async () => {
    if (!draft || !mem) return
    setSavingMem(true)
    try {
      await store.saveMemory({ ...mem, charId: draft.id })
      setMem(await store.getMemory(draft.id))
      setMemDirty(false)
      showToast('记忆已保存（AI 下次整理会在此基础上压缩）')
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

  const create = async () => {
    try {
      const c = await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '未命名角色' })
      await load()
      await open(c.id)
      setDirty(true)
      showToast('已新建角色卡，填完记得保存')
    } catch (e) {
      showToast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
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

  /** 恢复内置示范版本（只覆盖四章，不动记忆与日常） */
  const resetSeed = async () => {
    if (!draft) return
    const okGo = await confirmDialog({
      title: `把「${draft.name}」恢复成内置示范版本？`,
      message: '会用内置的最新版覆盖这四章（世界 / 人物档案 / 行为规范 / 示例对话），你在这一页上未保存的改动会丢失。\n\n记忆与日常状态不受影响。',
      confirmText: '恢复',
      danger: true,
    })
    if (!okGo) return
    try {
      const name = await resetCardToSeed(draft.id)
      if (!name) { showToast('这张卡不在内置示范卡里', 'info'); return }
      const c = await store.getFreeChar(draft.id)
      setDraft(c)
      setDirty(false)
      setGaps([])
      showToast(`已恢复为内置的「${name}」`)
    } catch (e) {
      showToast(`恢复失败：${e instanceof Error ? e.message : String(e)}`, 'error')
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

  const importCard = async (file: File) => {
    try {
      const r = parseCardFile(await file.text())
      if (!r.ok) { showToast(r.error, 'error'); return }
      // 导入时已重生成新 id，不会覆盖已有卡
      const created = await store.createFreeChar(r.card)
      // 导入的卡不该是空记忆：立刻依据卡片生成一版初版
      const how = await seedMemory(created)
      await load()
      await open(created.id)
      setGaps(r.warnings)
      const base = r.warnings.length ? `已导入，但${describeWarnings(r.warnings)}` : '已导入，结构完整'
      showToast(`${base} · 初版记忆已生成（${how === 'ai' ? 'AI 整理' : '直接摘录'}）`, r.warnings.length ? 'info' : 'success')
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
      showToast(`${tip} · 初版记忆已生成（${how === 'ai' ? 'AI 整理' : '直接摘录'}）`, g.length ? 'info' : 'success')
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
    ['第 1 章 · 世界', c.world ?? ''],
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
  const upProfile = (k: keyof FreeCharacter['profile'], v: string) => {
    setDraft(d => (d ? { ...d, profile: { ...d.profile, [k]: v } } : d))
    setDirty(true)
  }
  const upConduct = (k: keyof FreeCharacter['conduct'], v: string) => {
    setDraft(d => (d ? { ...d, conduct: { ...d.conduct, [k]: v } } : d))
    setDirty(true)
  }

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

  return (
    /* 固定头部 + 下方独立滚动区：滚动只发生在标题条**下面**，
       内容不会再滑到条子后面被半透明条盖住（原先 sticky + bg-ink-900/95 的观感问题）。 */
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-800 pb-3">
        <div className="flex items-center gap-1.5">

          <h1 className="text-xl font-bold text-ink-50">角色卡片</h1>

          <HelpPopover title="角色卡片怎么填" width="24rem" size={14}>
  一张卡 = AI 的「人设说明书」：写得越具体，演得越像。四章模板：

  • 第 1 章 世界：只写会影响 Ta 言行的东西 —— 这是唯一该写世界的地方。
  • 第 2 章 人物档案：外在 / 内核 / 语言特征 / 关系 / 做不到的事 / 知识边界。
    其中「做不到的事」与「知识边界」是防角色崩坏最关键的两栏 —— 写清 Ta 不会什么、不知道什么。
  • 第 3 章 行为规范：视角与人称 / 底线 / 关系推进节奏 / 尺度。
  • 第 4 章 示例对话：AI 会照着它的格式与语气模仿，所以按输出规范写（对白不带名字、除对白外一律套（ ））。

  两种起手方式（右上「AI 起草」）：已经想清楚了 → 一句话补全；只有点感觉、说不清 → 对话引导，
  让 AI 按上面的模板一轮轮问你，边聊边成形。
  卡片是全局的（跨项目、换书照样在），也能导出成文件发给别人。
</HelpPopover>

        </div>
        <p className="text-[12px] text-ink-400 mt-1">
          自由模式的角色卡片：四章模板，与小说项目相互独立（换书照样在）。
          右上「AI 起草」可以从一句话起手，也可以让 AI 按模板一轮轮问你。
        </p>

        {/* 元指令速查：卡配好之后「怎么跟 Ta 说话」才是作者最常卡住的一步 */}
        <TavernEchoHints className="mt-2" />
      </header>

      {loading ? <div className="min-h-0 flex-1 overflow-y-auto pt-3"><LoadingState /></div> : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
        <div className="flex gap-4 min-h-0">
          {/* 左：角色列表 */}
          <aside className="w-56 shrink-0 space-y-2">
            <Button variant="primary" size="md" className="w-full" onClick={create}>新建角色卡</Button>

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
                还没有角色卡。点上面「新建」开始 —— 也可以先去「自由对话」看看引导。
              </p>
            ) : (
              <ul className="space-y-1">
                {list.map(c => (
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
                ))}
              </ul>
            )}

            <div className="pt-2 border-t border-ink-800 space-y-1.5">
              <Button variant="secondary" size="sm" className="w-full text-[11.5px]" onClick={() => void openNovelPicker()}>
                从小说角色导入
              </Button>
              <div className="flex gap-1.5">
                <Button variant="secondary" size="sm" className="flex-1 text-[11.5px]" onClick={() => fileRef.current?.click()}>
                  导入 JSON
                </Button>
                <Button variant="secondary" size="sm" className="flex-1 text-[11.5px]" disabled={!draft} onClick={exportCard}>
                  导出 JSON
                </Button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) void importCard(f)
                  e.target.value = '' // 允许连续导入同一个文件
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
                </div>

                {sameNameOthers.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-[11.5px] text-ink-300 leading-relaxed">
                    ⚠️ 已有 {sameNameOthers.length} 张卡也叫「{draft.name.trim()}」。
                    <span className="text-ink-100">同名不等于同一个人</span>：记忆、日常状态、聊天记录都各存各的
                    （记忆按角色 id 绑定），新建或复制同名卡不会抢走那一张的记忆。
                    同一场对话里同时出现时，提示词会给它们挂稳定短码区分 —— 这张是
                    <span className="text-amber"> #{charTag(draft.id)}</span>，另一张是
                    <span className="text-amber"> #{charTag(sameNameOthers[0].id)}</span>。
                    想少混淆，建议改名加区别（如「洛汐（旧版）」）。
                  </div>
                )}

                {/* 第 1 章 */}
                <section>
                  <SectionTitle sub="Ta活在一个什么样的世界里（时代 / 地点 / 规则）—— 故事发生的舞台。">
                    第 1 章 · 世界
                  </SectionTitle>
                  <Field label="世界设定" hint="时代、地点、社会规则、与用户的初始关系" rows={3}
                    value={draft.world} onChange={v => up('world', v)}
                    ph="例：现代都市，老城区一间凌晨还亮着灯的便利店。Ta是店员，你是常来的顾客。" />
                </section>

                {/* 第 2 章 */}
                <section>
                  <SectionTitle sub="Ta是谁 —— 这一章决定角色立不立得住。">
                    第 2 章 · 人物档案
                  </SectionTitle>
                  <div className="space-y-3">
                    <Field label="2.1 外在" hint="外貌、穿着、有记忆点的小特征" rows={2}
                      value={draft.profile.externals} onChange={v => upProfile('externals', v)}
                      ph="例：短发，总穿同一件洗旧的灰色围裙，左手腕有道旧疤。" />
                    <Field label="2.2 内核" hint="性格、在乎的东西、内在矛盾" rows={3}
                      value={draft.profile.core} onChange={v => upProfile('core', v)}
                      ph="例：外冷内热。嘴上不留情，但会记得你爱吃什么。" />
                    <Field label="2.3 语言特征" hint="怎么说话：句子长短、口头禅、语气习惯" rows={2}
                      value={draft.profile.speech} onChange={v => upProfile('speech', v)}
                      ph="例：句子短，习惯用反问，从不说软话。" />
                    <Field label="2.4 关系" hint="Ta与其他角色的关系（没有可留空）" rows={2}
                      value={draft.profile.relations} onChange={v => upProfile('relations', v)} />
                    <Field label="2.5 做不到的事" hint="能力与性格上的硬限制 —— 写了它就不会突然全能" rows={2}
                      value={draft.profile.cannot} onChange={v => upProfile('cannot', v)}
                      ph="例：说不出关心的话，只能换成别的方式表达。" />
                    <Field label="2.6 知识边界" hint="哪些事Ta不知道 —— 写了它就不会「恰好知道」" rows={2}
                      value={draft.profile.knowledge} onChange={v => upProfile('knowledge', v)}
                      ph="例：不知道顾客的职业与过去。" />
                  </div>
                </section>

                {/* 第 3 章 */}
                <section>
                  <SectionTitle sub="怎么演Ta —— 这一章防 OOC（演崩）。">
                    第 3 章 · 行为规范
                  </SectionTitle>
                  <div className="space-y-3">
                    <Field label="视角与人称" hint="以什么视角叙述（第一人称最稳）" rows={2}
                      value={draft.conduct.perspective} onChange={v => upConduct('perspective', v)}
                      ph="例：第一人称，只描写Ta自己的动作与感官。" />
                    <Field label="底线清单" hint="碰到会怎样 —— 写反应，不写理由" rows={2}
                      value={draft.conduct.bottomLine} onChange={v => upConduct('bottomLine', v)}
                      ph="例：不越界打听私事；被追问会转移话题，不会发火。" />
                    <Field label="进度锁" hint="关系推进的速度（防一下子自来熟）" rows={2}
                      value={draft.conduct.paceLock} onChange={v => upConduct('paceLock', v)}
                      ph="例：关系推进要慢，至少十几次交谈才到熟络。" />
                    <Field label="尺度" hint="内容尺度边界" rows={1}
                      value={draft.conduct.rating} onChange={v => upConduct('rating', v)}
                      ph="例：日常向，不写亲密场面。" />
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
                      <h3 className="text-[13px] font-semibold text-amber/90">Ta的记忆（可手动编辑）</h3>
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

                {/* 操作 */}
                <div className="flex items-center justify-between border-t border-ink-800 pt-3">
                  <span className="text-[11px] text-ink-500">
                    {dirty ? '有未保存的改动' : `上次保存：${new Date(draft.updatedAt).toLocaleString('zh-CN')}`}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary" size="md" onClick={() => void duplicate()}
                      title="四章照抄一份新卡，可在它基础上改；记忆与日常状态不复制"
                    >
                      复制为新卡
                    </Button>
                    {isSeedCard(draft) && (
                      <Button
                        variant="secondary" size="md" onClick={() => void resetSeed()}
                        title="用内置的最新版覆盖这四章（记忆与日常不受影响）—— 内置示范卡随版本更新时用它取回新版"
                      >
                        恢复内置版本
                      </Button>
                    )}
                    <Button variant="danger" size="md" onClick={remove}>删除</Button>
                    <Button variant="primary" size="md" disabled={!dirty || saving} onClick={save}>
                      {saving ? '保存中…' : '保存'}
                    </Button>
                  </div>
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
                  <button
                    key={t.id} type="button" onClick={() => setNtab(t.id)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      ntab === t.id ? 'border-amber/40 bg-amber/12 text-amber' : 'border-ink-700 text-ink-400 hover:bg-ink-800/60'
                    }`}
                  >
                    {t.label} {novelCount(t.id)}
                  </button>
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
                    <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center">
                      {c.name.trim().slice(0, 1) || '?'}
                    </span>
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

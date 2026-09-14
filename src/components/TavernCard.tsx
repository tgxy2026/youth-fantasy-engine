/**
 * 酒馆模式 · 角色卡片（tavern-card）
 *
 * 自由模式的角色卡管理：四章模板（世界 / 人物档案 / 行为规范 / 示例对话），分区块表单编辑。
 *
 * 【为什么是「分区块表单」而不是一个大文本框】
 * 四章是给模型的**不同层**用的：第 2 章管「她是谁」、第 3 章管「怎么演」、
 * 第 4 章管「照着这个说话」。合成一坨，作者一定会漏掉最关键的第四章。
 *
 * 【第 4 章「示例对话」是杠杆最高、也最容易被跳过的一章】
 * 手册实测：模型会**直接吸收**示例里的应对话术与格式。所以它在这一页拿到的是
 * 醒目位置（amber 边框）+ 三条硬规矩（踩过坑的），而不是和别的字段一样一个普通输入框：
 *   ① 格式必须与期望输出完全一致 —— 示例里写「角色名：台词」，正式输出就会照做
 *      （曾因此把人称带偏成第三人称）。**只给对方加标记，角色那一侧不加任何前缀。**
 *   ② 三段覆盖不同侧面（常态 / 应激 / 松动），别都是同一情绪
 *   ③ 别写长 —— 三段短来回足够，写成整段剧情既费上下文又容易被照搬
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 *
 * 阶段：本页是 P2 范围（CRUD + 表单）。「从小说角色 AI 转换」与「导入导出 JSON」属 P3，
 * 页面上留了入口但**明确置灰并说明**，不假装能用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as store from '../lib/tavern/store'
import * as db from '../lib/db'
import type { FreeCharacter, FreeMemory, TavernCharIndexItem } from '../lib/tavern/types'
import { MEMORY_SECTIONS, memoryChars } from '../lib/tavern/memory'
import { toCardFile, parseCardFile, cardFileName, describeWarnings } from '../lib/tavern/cardFile'
import { convertNovelChar } from '../lib/tavern/import'
import { Button } from './Button'
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

export default function TavernCard() {
  const [list, setList] = useState<TavernCharIndexItem[]>([])
  const [draft, setDraft] = useState<FreeCharacter | null>(null)
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
  const [novelChars, setNovelChars] = useState<{ id: string; name: string; tabId: string }[]>([])
  const [converting, setConverting] = useState(false)
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
      await load()
      await open(created.id)
      setGaps(r.warnings)
      showToast(r.warnings.length ? `已导入，但${describeWarnings(r.warnings)}` : '已导入，结构完整', r.warnings.length ? 'info' : 'success')
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
      await load()
      await open(created.id)
      setGaps(g)
      setImportOpen(false)
      showToast(g.length ? `草稿已生成，有 ${g.length} 处待补` : '草稿已生成，请审一遍再改', g.length ? 'info' : 'success')
    } catch (e) {
      showToast(`转换失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setConverting(false)
    }
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

  return (
    /* 固定头部 + 下方独立滚动区：滚动只发生在标题条**下面**，
       内容不会再滑到条子后面被半透明条盖住（原先 sticky + bg-ink-900/95 的观感问题）。 */
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-800 pb-3">
        <h1 className="text-xl font-bold text-ink-50">角色卡片</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          自由模式的角色卡片：四章模板（世界 / 人物档案 / 行为规范 / 示例对话），与小说项目相互独立。
        </p>
      </header>

      {loading ? <div className="min-h-0 flex-1 overflow-y-auto pt-3"><LoadingState /></div> : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
        <div className="flex gap-4 min-h-0">
          {/* 左：角色列表 */}
          <aside className="w-56 shrink-0 space-y-2">
            <Button variant="primary" size="md" className="w-full" onClick={create}>新建角色卡</Button>

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
                      <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center">
                        {c.name.trim().slice(0, 1) || '?'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.name || '未命名角色'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="pt-2 border-t border-ink-800 space-y-1.5">
              <Button variant="ghost" size="sm" className="w-full text-[11.5px]" onClick={() => void openNovelPicker()}>
                从小说角色导入
              </Button>
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" className="flex-1 text-[11.5px]" onClick={() => fileRef.current?.click()}>
                  导入 JSON
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 text-[11.5px]" disabled={!draft} onClick={exportCard}>
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
                「从小说角色导入」是 AI 转换，**结果只是草稿，必须审**。
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
                      <button type="button" className="shrink-0 text-[11px] text-ink-500 hover:text-ink-200" onClick={() => setGaps([])}>
                        知道了
                      </button>
                    </div>
                  </div>
                )}

                {/* 基本 */}
                <div>
                  <div className="flex items-center gap-3">
                    <span className="w-9 h-9 shrink-0 rounded-full bg-ink-700 text-ink-200 flex items-center justify-center">
                      {draft.name.trim().slice(0, 1) || '?'}
                    </span>
                    <input
                      className="flex-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-2 text-[15px] font-semibold text-ink-50 outline-none focus:border-amber/50"
                      value={draft.name}
                      placeholder="角色名"
                      onChange={e => up('name', e.target.value)}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-500">
                    头像暂未开放（用名字首字代替）。角色卡是 AI 的「人设说明书」—— 写得越具体，演得越像。
                  </p>
                </div>

                {/* 第 1 章 */}
                <section>
                  <SectionTitle sub="她活在一个什么样的世界里（时代 / 地点 / 规则）—— 故事发生的舞台。">
                    第 1 章 · 世界
                  </SectionTitle>
                  <Field label="世界设定" hint="时代、地点、社会规则、与用户的初始关系" rows={3}
                    value={draft.world} onChange={v => up('world', v)}
                    ph="例：现代都市，老城区一间凌晨还亮着灯的便利店。她是店员，你是常来的顾客。" />
                </section>

                {/* 第 2 章 */}
                <section>
                  <SectionTitle sub="她是谁 —— 这一章决定角色立不立得住。">
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
                    <Field label="2.4 关系" hint="她与其他角色的关系（没有可留空）" rows={2}
                      value={draft.profile.relations} onChange={v => upProfile('relations', v)} />
                    <Field label="2.5 做不到的事" hint="能力与性格上的硬限制 —— 写了它就不会突然全能" rows={2}
                      value={draft.profile.cannot} onChange={v => upProfile('cannot', v)}
                      ph="例：说不出关心的话，只能换成别的方式表达。" />
                    <Field label="2.6 知识边界" hint="哪些事她不知道 —— 写了它就不会「恰好知道」" rows={2}
                      value={draft.profile.knowledge} onChange={v => upProfile('knowledge', v)}
                      ph="例：不知道顾客的职业与过去。" />
                  </div>
                </section>

                {/* 第 3 章 */}
                <section>
                  <SectionTitle sub="怎么演她 —— 这一章防 OOC（演崩）。">
                    第 3 章 · 行为规范
                  </SectionTitle>
                  <div className="space-y-3">
                    <Field label="视角与人称" hint="以什么视角叙述（第一人称最稳）" rows={2}
                      value={draft.conduct.perspective} onChange={v => upConduct('perspective', v)}
                      ph="例：第一人称，只描写她自己的动作与感官。" />
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
                    <p className="text-[11.5px] text-ink-300 font-medium">三条硬规矩（都是踩过的坑）</p>
                    <ul className="mt-1 space-y-1 text-[11px] text-ink-400 leading-relaxed">
                      <li>
                        <span className="text-amber/90">① 格式必须和你要的输出完全一致。</span>
                        示例里若写「苏念：台词」，正式输出也会带上名字前缀，人称甚至被带偏成第三人称。
                        <span className="text-ink-200">正确做法：只给对方加标记，她那一侧不加任何前缀。</span>
                      </li>
                      <li><span className="text-amber/90">② 三段覆盖不同侧面</span>（常态 / 被戳到时 / 松动时），别都是同一种情绪。</li>
                      <li><span className="text-amber/90">③ 别写长。</span>三段短来回就够 —— 写成整段剧情既费上下文，又容易被照搬。</li>
                    </ul>
                  </div>
                  <AutoTextarea
                    className="bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                    textClass="text-[12.5px]"
                    minRows={8}
                    maxHeight={520}
                    placeholder={'对方：这么晚还不下班？\n她把找零推过去，没抬头：\n「灯还亮着。」\n\n对方：你一个人看店不怕吗？\n她停了一下，把烟按灭。\n「惯了。」\n\n对方：……谢谢。\n她背过身去理货架，声音很轻：\n「伞在门后。」'}
                    value={draft.examples}
                    onChange={v => up('examples', v)}
                  />
                </section>

                {/* 记忆：AI 会整理，但作者也该能直接改（否则压错了只能删卡重来） */}
                <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-amber/90">她的记忆（可手动编辑）</h3>
                      <p className="mt-0.5 text-[11px] text-ink-500 leading-relaxed">
                        六栏记忆就在这里。AI 整理时会在此基础上压缩；你也可以直接改，改完点「保存记忆」。
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {memDirty && <span className="text-[11px] text-amber">有未保存的改动</span>}
                      {showMem && (
                        <Button variant="primary" size="sm" disabled={!memDirty || savingMem} onClick={() => void saveMem()}>
                          {savingMem ? '保存中…' : '保存记忆'}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setShowMem(v => !v)}>
                        {showMem ? '收起' : '展开编辑'}
                      </Button>
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
                        手改时别把「只增」的两栏清空 —— 那等于让她失忆。
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
            AI 会把这个角色**改写成角色扮演用的四章卡片**：设定翻译成行为倾向、剧情走向丢掉。
            <span className="text-amber/90"> 结果只是一份草稿 —— 尤其第 4 章示例对话通常是它编的，务必自己改。</span>
          </div>
          {novelChars.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-ink-500">
              当前项目里没有已建档的角色。先去小说项目填几张角色卡再来。
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto space-y-1">
              {novelChars.map(c => (
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
                      {{ 'char-main': '主要', 'char-secondary': '次要', 'char-npc': 'NPC' }[c.tabId] ?? c.tabId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between border-t border-ink-800 pt-2">
            <span className="text-[11px] text-ink-500">
              {converting ? '正在转换（要读一遍角色卡，可能要十几秒）…' : `共 ${novelChars.length} 个角色`}
            </span>
            <Button variant="secondary" size="md" onClick={() => setImportOpen(false)} disabled={converting}>关闭</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

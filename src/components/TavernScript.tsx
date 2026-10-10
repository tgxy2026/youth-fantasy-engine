/**
 * 酒馆模式 · 故事剧本（tavern-script）
 *
 * 【这个页签解决什么】
 * 角色卡只回答了「这个人是谁」；一场戏还需要「此刻在哪、为什么在这儿、这一场想干嘛」。
 * 而再往上还有一层 ——「这个世界什么样」。
 *
 * 【三层分工（老大 2026-09-16 定）】
 *   故事 Story  → 这个世界的基本设定（规则 / 地理 / 势力 / 常识）
 *   剧本 Script → 这一个场景发生什么事（六栏）
 *   故事与剧本是**父子结构**，一个故事下可挂多份剧本，树状展现。
 *   角色也归属故事（P0-B），扮演时套用该故事的世界观。
 *
 * 【为什么世界设定不再写在角色卡里】
 * 原先每张卡都抄一份世界：N 张卡 N 份，改一处要改 N 处，还容易互相打架。
 * 现在故事层只写一份，卡片里**只留「角色与设定的关系」**。
 *
 * 【数据归属】
 * 🔴 故事与剧本都是**全局**（`db.getMeta`，跨项目）—— 与角色卡同性质：玩法模板，不绑某一本书。
 * 🔴 会话引用剧本时存的是**快照**：后来改剧本，历史会话不会跟着变。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSaveHotkey } from '../lib/useSaveHotkey'
import HelpPopover from './HelpPopover'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import AutoTextarea from './AutoTextarea'
import NumberField from './NumberField'
import { UNSAVED_CHANGES_HINT } from '../lib/constants'
import { uid } from '../lib/id'
import TavernScriptFields from './TavernScriptFields'
import TavernInterviewDialog from './TavernInterviewDialog'
import TavernScriptImportDialog from './TavernScriptImportDialog'
import { serializeStoryImport } from '../lib/tavern/storyImport'
import { downloadText } from '../lib/zip'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from './DraftBits'
import { interviewToScript, interviewToStory } from '../lib/tavern/interview'
import {
  listScripts, getScript, saveScript, createScript, deleteScript, draftScript,
  scriptToText, snapshotOf, mergeScriptDraft, isEmptyScriptFields, firstLine, scriptDisplayName,
  flattenScriptFields,
  SCRIPT_MAX_CHARS, EMPTY_SCRIPT_FIELDS, isEmptySnapshot, type ScriptDraftFields,
} from '../lib/tavern/script'
import {
  listStories, getStory, saveStory, createStory, deleteStory, storyDisplayName,
  draftStory, flattenStoryFields, mergeStoryDraft, isEmptyStoryFields,
  EMPTY_STORY_FIELDS, STORY_NAME_MAX, buildStoryWorldBook,
  type StoryDraftFields,
} from '../lib/tavern/story'
import { listCharsByStory } from '../lib/tavern/store'
import { emptyWorldEntry, entryStateOf } from '../lib/tavern/worldBook'
import EntryStatePicker from './EntryStatePicker'
import { useTavernQuota } from './useTavernQuota'
import { fmtWindow } from '../lib/tavern/quotas'
import type { DraftSource } from '../lib/tavern/draft'
import type { TavernScript, TavernScriptIndexItem, TavernStory, TavernStoryIndexItem } from '../lib/tavern/types'

/** 中间面板当前在编辑谁：故事 / 剧本 / 谁都没选 */
type EditingKind = 'story' | 'script' | null

export default function TavernScript() {
  const [stories, setStories] = useState<TavernStoryIndexItem[]>([])
  const [scripts, setScripts] = useState<TavernScriptIndexItem[]>([])
  /** 左栏展开着的故事 id —— 树是受控的，刷新后不至于收回去让人以为数据没了 */
  const [openIds, setOpenIds] = useState<string[]>([])
  const [story, setStory] = useState<TavernStory | null>(null)
  const [cur, setCur] = useState<TavernScript | null>(null)
  const [kind, setKind] = useState<EditingKind>(null)
  const [storyDirty, setStoryDirty] = useState(false)
  const [scriptDirty, setScriptDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)
  /** AI 起草的输入（作者的粗略想法 + 粘贴的参考素材）—— 只存在于界面，不落库 */
  const [seed, setSeed] = useState('')
  const [refs, setRefs] = useState('')
  /** 上一次起草实际用的素材来源（如实回显给作者） */
  const [lastSource, setLastSource] = useState<DraftSource | null>(null)
  /** 对话引导弹窗（边聊边写，适合还没想清楚的时候） */
  const [interviewOpen, setInterviewOpen] = useState(false)
  /** 导入 / 追加弹窗：按模板的文本建成新故事，或把词条与剧本补进已有故事（2026-10-09 加追加） */
  const [importOpen, setImportOpen] = useState(false)
  /** 当前故事下的角色卡张数（右栏显示用 —— 让作者知道删故事会影响到多少卡） */
  const [storyCharCount, setStoryCharCount] = useState(0)
  const search = useSearchSettings()
  // 🔴 额度体系（2026-10-05）：世界设定是**每轮全量注入**的固定层 ⇒ 受固定额度约束；
  //    世界书词条是动态层 ⇒ 受动态额度约束、超了逐条取舍。窗口与引擎同源（见 useTavernQuota）。
  const quota = useTavernQuota(undefined, undefined)

  const refresh = useCallback(async () => {
    const [sts, scs] = await Promise.all([listStories(), listScripts()])
    setStories(sts)
    setScripts(scs)
  }, [])

  useEffect(() => { void (async () => { await refresh() })() }, [refresh])

  // 故事挂了几张卡 —— 异步查，故独立成一个 effect（故事换了才重查，不是每敲一个字都查）
  const storyIdForCount = story?.id ?? ''
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const n = storyIdForCount ? (await listCharsByStory(storyIdForCount)).length : 0
        if (alive) setStoryCharCount(n)
      } catch {
        if (alive) setStoryCharCount(0)
      }
    })()
    return () => { alive = false }
  }, [storyIdForCount])

  // 当前是否有未保存改动 —— 切换 / 删除前用它拦一道
  const dirty = kind === 'story' ? storyDirty : scriptDirty

  const guard = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true
    return confirmDialog({
      title: '切换？',
      message: '当前这份有未保存的改动，切过去就丢了。',
      confirmText: '切过去',
      danger: true,
    })
  }, [dirty])

  const toggleOpen = (id: string) => {
    setOpenIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  const openStory = async (id: string) => {
    if (story?.id === id && kind === 'story') return
    if (!(await guard())) return
    const st = await getStory(id)
    setStory(st)
    setCur(null)
    setKind(st ? 'story' : null)
    setStoryDirty(false)
    setScriptDirty(false)
  }

  const openScript = async (id: string) => {
    if (cur?.id === id && kind === 'script') return
    if (!(await guard())) return
    const sc = await getScript(id)
    setCur(sc)
    setStory(null)
    setKind(sc ? 'script' : null)
    setStoryDirty(false)
    setScriptDirty(false)
  }

  const createStoryNow = async () => {
    const s = await createStory({ name: '' })
    await refresh()
    setStory(s)
    setCur(null)
    setKind('story')
    setStoryDirty(true)
    setScriptDirty(false)
    setOpenIds(prev => [...prev, s.id])
    showToast('已新建一个故事 —— 先写世界设定，再往下挂剧本')
  }

  /** 剧本必须挂在某个故事下：没选故事时不允许新建（这是必要的前置步骤） */
  const createScriptUnder = async (storyId: string) => {
    if (!(await guard())) return
    const sc = await createScript({ ...EMPTY_SCRIPT_FIELDS, name: '', storyId })
    await refresh()
    setCur(sc)
    setStory(null)
    setKind('script')
    setStoryDirty(false)
    setScriptDirty(false)
    setOpenIds(prev => (prev.includes(storyId) ? prev : [...prev, storyId]))
    showToast('已新建一份空剧本 —— 六栏填完记得保存')
  }

  /**
   * 导出选中的故事 + 它的全部词条 + 挂在这个故事下的全部剧本。
   * 🔴 与导入**同一套标记**（`serializeStoryImport`）⇒ 导出的文件能原样导回来，也能直接贴给 AI。
   * 有未保存改动时先拦一下：否则导出的还是上一次保存的版本，跟眼前看到的对不上。
   */
  const doExport = async () => {
    const sid = activeStoryId
    if (!sid) { showToast('先选中一个故事，再导出', 'error'); return }
    if (dirty) { showToast('有未保存的改动 —— 先点「保存」，再导出', 'error'); return }
    const s = await getStory(sid)
    if (!s) { showToast('这个故事已经不存在了', 'error'); return }
    const scs = await listScripts()
    const full: ScriptDraftFields[] = []
    for (const it of scs.filter(x => x.storyId === sid)) {
      const sc = await getScript(it.id)
      if (sc) {
        full.push({
          name: sc.name, situation: sc.situation, opening: sc.opening,
          playerRole: sc.playerRole, goal: sc.goal, taboo: sc.taboo,
        })
      }
    }
    const text = serializeStoryImport({
      name: s.name, setting: s.setting, entries: s.entries ?? [], scripts: full,
    })
    downloadText(`${storyDisplayName(s)}.txt`, text)
    showToast(`已导出「${storyDisplayName(s)}」—— 词条 ${s.entries?.length ?? 0} 条 · 剧本 ${full.length} 份`)
  }

  const save = async () => {
    // 🔴 世界设定超固定额度**不允许保存**（主人 2026-10-05 明定）：它是每轮全量注入的定调内容，
    //    超额度就是实打实挤占对话历史。只有一个例外 —— **已拆成词条**时上面那段只是"素材"，
    //    实际注入走词条（动态层、逐条取舍），此时不再拿固定额度卡它。
    if (kind === 'story' && story && !(story.entries ?? []).length
      && story.setting.trim().length > quota.fixed) {
      showToast(`世界设定 ${story.setting.trim().length} 字，超过固定额度 ${quota.fixed} 字 —— `
        + '请精简，或拆成带触发词的「世界书词条」（那样按命中注入、还能逐条取舍）', 'error')
      return
    }
    setSaving(true)
    try {
      if (kind === 'story' && story) {
        const saved = await saveStory(story)
        setStory(saved)
        setStoryDirty(false)
        await refresh()
        showToast('故事已保存 —— 接着在它下面新建剧本')
      } else if (kind === 'script' && cur) {
        const saved = await saveScript(cur)
        setCur(saved)
        setScriptDirty(false)
        await refresh()
        showToast('已保存 —— 新建对话时就能选到它')
      }
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (kind === 'story' && story) {
      const under = scripts.filter(s => s.storyId === story.id).length
      const okGo = await confirmDialog({
        title: `删掉「${storyDisplayName(story)}」？`,
        message: under > 0
          ? `它下面的 ${under} 份剧本会一并删除（角色卡不删，会解除归属）。此操作不可撤销。`
          : '这个故事会被删除，此操作不可撤销。',
        confirmText: '删除',
        danger: true,
      })
      if (!okGo) return
      const { reboundChars } = await deleteStory(story.id)
      await refresh()
      setStory(null)
      setKind(null)
      setStoryDirty(false)
      // 解绑了卡要说清楚去向 —— 不说的话作者会以为那几张卡跟着没了
      showToast(
        reboundChars
          ? `已删除故事 · ${reboundChars} 张角色卡已移到「未归属」，可在角色卡片里重新归类`
          : '已删除故事')
      return
    }
    if (kind === 'script' && cur) {
      const okGo = await confirmDialog({
        title: `删掉「${scriptDisplayName(cur)}」？`,
        message: '用过的会话不受影响 —— 它们保存的是加载时的快照，剧本删了这一场照样能跑。\n但这份剧本列表里就没了，不可撤销。',
        confirmText: '删除',
        danger: true,
      })
      if (!okGo) return
      await deleteScript(cur.id)
      await refresh()
      setCur(null)
      setKind(null)
      setScriptDirty(false)
      showToast('已删除剧本')
    }
  }

  const runDraft = async () => {
    if (!cur) return
    setDrafting(true)
    try {
      const curFields: ScriptDraftFields = {
        name: cur.name, situation: cur.situation, opening: cur.opening,
        playerRole: cur.playerRole, goal: cur.goal, taboo: cur.taboo,
      }
      const { fields: out, source } = await draftScript({
        seed, refs,
        // 已有内容一并给过去：这是「补完」而不是从零重写（AI 空着的栏也不会覆盖作者写的）
        existing: flattenScriptFields(curFields),
        ...(search ? { searchSettings: search } : {}),
      })
      const merged = mergeScriptDraft(curFields, out)
      setCur(prev => (prev ? { ...prev, ...merged, draftedAt: Date.now() } : prev))
      setScriptDirty(true)
      setLastSource(source)
      showToast(`已生成六栏（${source.label}）—— 过一遍再保存`)
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setDrafting(false)
    }
  }

  /** 注入预览（情境 / 你的位置 / 目标 / 不要发生 —— 开场白不进这里） */
  const preview = useMemo(() => {
    if (!cur) return ''
    return scriptToText(snapshotOf({ ...cur, id: cur.id || 'preview' }))
  }, [cur])

  const fields: ScriptDraftFields = cur
    ? {
      name: cur.name, situation: cur.situation, opening: cur.opening,
      playerRole: cur.playerRole, goal: cur.goal, taboo: cur.taboo,
    }
    : EMPTY_SCRIPT_FIELDS

  /** 「新建剧本」必须知道挂在哪个故事下：以当前编辑中的故事为准，没有就禁用 */
  const activeStoryId = kind === 'story' ? story?.id ?? '' : cur?.storyId ?? ''

  /** 故事的两栏（与剧本六栏同理，给起草 / 引导当输入） */
  const storyFields: StoryDraftFields = story
    ? { name: story.name, setting: story.setting }
    : EMPTY_STORY_FIELDS

  /** 起草故事的世界设定 —— 同样把已有内容给过去，AI 空着就不动 */
  const runStoryDraft = async () => {
    if (!story) return
    setDrafting(true)
    try {
      const { fields: out, source } = await draftStory({
        seed, refs,
        existing: flattenStoryFields(storyFields),
        ...(search ? { searchSettings: search } : {}),
      })
      const merged = mergeStoryDraft(storyFields, out)
      setStory(prev => (prev ? { ...prev, ...merged, draftedAt: Date.now() } : prev))
      setStoryDirty(true)
      setLastSource(source)
      showToast(`已生成世界设定（${source.label}）—— 过一遍再保存`)
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setDrafting(false)
    }
  }

  // Ctrl/Cmd+S 保存剧本 / 故事（2.7.3 补）
  useSaveHotkey(() => void save(), dirty && !saving)

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-700 pb-3">
        <div className="flex items-center gap-1.5">

          <h1 className="text-lg font-bold text-ink-50">故事剧本</h1>

          <HelpPopover title="故事与剧本怎么配合" width="26rem" size={14}>
  先有「故事」，再有「剧本」 —— 一个故事下可以有多份剧本，左边树里折叠展示。

  · 故事写「这个世界什么样」：规则、地理、势力、常识。它取代了原先角色卡第1章的世界设定 ——
    以前每张卡抄一份，改一处要改 N 处；现在只写这一份，卡片里只留「角色与设定的关系」。
  · 世界书词条：把整段设定拆成若干条，每条留自己的触发词 —— 提到才带上，不再整段每轮都占额度。
    没有词条时，整段设定按「总是注入」处理（跟以前一样）。
  · 剧本写「这一场发生什么事」：六栏（名称 / 情境 / 开场白 / 你的位置 / 目标 / 不要发生）。
    情境只管此刻，别把历史重抄一遍。
  · 角色卡必须归属某个故事，对话时才有世界观可用 —— 所以「建故事」是使用自由对话的第一步。

  写不动就点「AI 起草」：一句话生成剧本六栏，或让 AI 引导你一轮轮聊出来。
</HelpPopover>

        </div>
        <p className="text-12 text-ink-400 mt-1">
          故事决定世界什么样，剧本决定这一场发生什么事。故事与剧本存在全局（跨项目），先建故事，再往下挂剧本。
        </p>
      </header>

      <div className="flex items-center gap-2 pt-3">
        <Button variant="primary" size="md" onClick={() => void createStoryNow()}>＋ 新建故事</Button>
        <Button
          variant="secondary" size="md"
          disabled={!activeStoryId}
          title={activeStoryId ? '在选中/所属的故事下新建一份剧本' : '先选中一个故事，才能在它下面新建剧本'}
          onClick={() => void createScriptUnder(activeStoryId)}
        >
          ＋ 新建剧本
        </Button>
        <Button variant="secondary" size="md" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </Button>
        <Button
          variant="secondary" size="md"
          title="从文本导入：建成一个新故事，或把词条 / 剧本追加到已有故事"
          onClick={() => setImportOpen(true)}
        >
          导入 / 追加
        </Button>
        <Button
          variant="secondary" size="md"
          disabled={!activeStoryId}
          title={activeStoryId
            ? '导出这个故事 + 它的词条 + 挂在这里的剧本（可原样导回来，也能直接贴给 AI）'
            : '先选中一个故事，再导出'}
          onClick={() => void doExport()}
        >
          导出
        </Button>
        <span className="flex-1" />
        {dirty && <span className="text-11 text-amber">{UNSAVED_CHANGES_HINT}</span>}
        {kind && <Button variant="danger" size="md" onClick={() => void remove()}>删除这份</Button>}
      </div>

      {/* 导入 / 追加：把按模板写好的文本建成一个新故事，或补进选中的那个故事（2026-10-09 加追加） */}
      <TavernScriptImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        defaultStoryId={activeStoryId}
        onImported={id => { void (async () => { await refresh(); await openStory(id) })() }}
      />

      {/* 对话引导：故事与剧本共用这一个弹窗，靠当前编辑对象切换提纲 */}
      <TavernInterviewDialog
        open={interviewOpen}
        kind={kind === 'story' ? 'story' : 'script'}
        subject={kind === 'story' ? '故事' : '剧本'}
        {...(cur || story
          ? { existing: kind === 'story' ? flattenStoryFields(storyFields) : flattenScriptFields(fields) }
          : {})}
        onClose={() => setInterviewOpen(false)}
        onApply={filled => {
          if (kind === 'story' && story) {
            const merged = mergeStoryDraft(storyFields, interviewToStory(filled))
            setStory(prev => (prev ? { ...prev, ...merged, draftedAt: Date.now() } : prev))
            setStoryDirty(true)
            showToast('已填入故事设定（对话引导）—— 核对后点「保存」')
            return
          }
          const out = interviewToScript(filled)
          const merged = mergeScriptDraft(fields, out)
          setCur(prev => (prev ? { ...prev, ...merged, draftedAt: Date.now() } : prev))
          setScriptDirty(true)
          showToast('已填入六栏（对话引导）—— 逐栏核对后点「保存」')
        }}
      />

      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左：故事 → 剧本 树状列表 */}
        <aside className="w-56 shrink-0 overflow-y-auto">
          {stories.length === 0 ? (
            <p className="rounded-lg border border-dashed border-ink-700 p-3 text-center text-11 text-ink-500">
              还没有故事。点上面「新建故事」，先把这个世界写下来 —— 这是使用自由对话的第一步。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {stories.map(st => {
                const under = scripts.filter(s => s.storyId === st.id)
                const isOpen = openIds.includes(st.id)
                return (
                  <li key={st.id}>
                    <div className="flex items-stretch gap-1">
                      <button
                        type="button"
                        onClick={() => toggleOpen(st.id)}
                        title={isOpen ? '收起剧本' : '展开剧本'}
                        className="shrink-0 rounded-md border border-ink-700 bg-ink-850/30 px-1.5 text-11 text-ink-400 hover:border-ink-600"
                      >
                        {isOpen ? '▾' : '▸'}
                      </button>
                      <button
                        type="button" onClick={() => void openStory(st.id)}
                        title={st.settingBrief || '（还没写世界设定）'}
                        className={`min-w-0 flex-1 rounded-md border px-2.5 py-2 text-left transition-colors ${st.id === story?.id && kind === 'story'
                          ? 'border-amber/50 bg-amber/15'
                          : 'border-ink-700 bg-ink-850/30 hover:border-ink-600'}`}
                      >
                        <div className={`truncate text-12 ${st.id === story?.id && kind === 'story' ? 'text-amber' : 'text-ink-200'}`}>
                          {st.name}
                        </div>
                        <div className="mt-0.5 truncate text-10 text-ink-500">
                          {st.settingBrief || '（还没写世界设定）'}
                        </div>
                      </button>
                    </div>

                    {isOpen && (
                      <ul className="mt-1 ml-4 space-y-1 border-l border-ink-700 pl-2">
                        {under.length === 0 ? (
                          <li className="py-1 text-10 text-ink-600">（还没有剧本）</li>
                        ) : under.map(sc => (
                          <li key={sc.id}>
                            <button
                              type="button" onClick={() => void openScript(sc.id)}
                              title={sc.goalBrief || '（还没写目标）'}
                              className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${sc.id === cur?.id && kind === 'script'
                                ? 'border-amber/50 bg-amber/15'
                                : 'border-ink-700 bg-ink-850/20 hover:border-ink-600'}`}
                            >
                              <div className={`truncate text-12 ${sc.id === cur?.id && kind === 'script' ? 'text-amber' : 'text-ink-200'}`}>
                                {sc.name}
                              </div>
                              <div className="truncate text-10 text-ink-500">{sc.goalBrief || '（还没写目标）'}</div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="mt-2 text-10 leading-relaxed text-ink-600">
            {stories.length} 个故事 · {scripts.length} 份剧本 · 跨项目共用（换本书也还在）
          </p>
        </aside>

        {/* 中：故事设定 / 剧本六栏 */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {kind === 'story' && story ? (
            <div className="space-y-3">
              <div>
                <div className="text-12 text-ink-200">故事名称</div>
                <input
                  value={story.name}
                  maxLength={STORY_NAME_MAX}
                  onChange={e => { setStory({ ...story, name: e.target.value }); setStoryDirty(true) }}
                  placeholder="例：云州江湖"
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850/60 px-2.5 py-1.5 text-12 text-ink-100 placeholder:text-ink-600 focus:border-amber/50 focus:outline-none"
                />
                <p className="mt-1 text-10 text-ink-600">
                  只用于列表展示，不进上下文。最多 {STORY_NAME_MAX} 字
                  {story.name.length >= STORY_NAME_MAX && <span className="ml-1 text-amber/80">已到上限</span>}
                </p>
              </div>
              <div>
                <div className="text-12 text-ink-200">世界设定</div>
                <p className="mt-0.5 text-10 leading-relaxed text-ink-500">
                  这个世界的基本设定：规则、地理、势力、常识。角色卡不再重复写它 —— 卡片里只留「角色与设定的关系」。
                </p>
                <div className="mt-1">
                  <AutoTextarea
                    value={story.setting}
                    onChange={v => { setStory({ ...story, setting: v }); setStoryDirty(true) }}
                    minRows={14}
                    maxHeight={460}
                    placeholder={'例：\n云州多山，灵脉自北向南枯竭已有百年。\n修行者分三派：守脉、夺脉、弃脉。\n凡人不知灵脉之事，只说山上的人都不下山。'}
                  />
                </div>

                {/* 世界书（W3）：把整段设定拆成词条 —— 每条自己的触发词，提到才带上 */}
                <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-12 text-ink-200">世界书词条（{(story.entries ?? []).length}）</div>
                    <Button variant="secondary" size="xs"
                      onClick={() => {
                        setStory({
                          ...story,
                          entries: [...(story.entries ?? []), { ...emptyWorldEntry(), id: uid() }],
                        })
                        setStoryDirty(true)
                      }}
                    >
                      ＋ 加词条
                    </Button>
                  </div>
                  <p className="mt-0.5 mb-2 text-10 text-ink-500 leading-relaxed">
                    把上面那段拆成若干词条：每条留自己的触发词，只有提到它时才带上这一条。
                    <span className="text-ink-600">没有词条时，上面整段设定按「总是注入」处理。</span>
                  </p>

                  {(story.entries ?? []).length === 0 ? (
                    <p className="rounded border border-dashed border-ink-700 p-2.5 text-center text-11 text-ink-500">
                      还没有词条 —— 上面整段设定会一直带上。想省额度就拆成词条。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {(story.entries ?? []).map((e, i) => (
                        <div key={e.id} className="rounded-md border border-ink-700 bg-ink-900/40 p-2.5">
                          <div className="flex items-center gap-2">
                            <input
                              value={e.title}
                              onChange={ev => {
                                const v = ev.target.value
                                setStory(prev => prev ? {
                                  ...prev,
                                  entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, title: v } : x),
                                } : prev)
                                setStoryDirty(true)
                              }}
                              placeholder="词条名（如「守脉三派」）"
                              className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50"
                            />
                            <Button variant="danger" size="xs" title="删掉这一条" className="shrink-0"
                              onClick={() => {
                                setStory(prev => prev ? {
                                  ...prev,
                                  entries: (prev.entries ?? []).filter(x => x.id !== e.id),
                                } : prev)
                                setStoryDirty(true)
                              }}
                            >
                              删除
                            </Button>
                          </div>
                          <div className="mt-1.5">
                            <AutoTextarea
                              value={e.body}
                              onChange={v => {
                                setStory(prev => prev ? {
                                  ...prev,
                                  entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, body: v } : x),
                                } : prev)
                                setStoryDirty(true)
                              }}
                              minRows={2}
                              maxHeight={200}
                              placeholder={`第 ${i + 1} 条内容…`}
                            />
                          </div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <input
                              value={e.keys.join('，')}
                              onChange={ev => {
                                const keys = ev.target.value.split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
                                setStory(prev => prev ? {
                                  ...prev,
                                  entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, keys } : x),
                                } : prev)
                                setStoryDirty(true)
                              }}
                              placeholder="触发词（留空 = 总是带上）"
                              className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                            />
                            <label className="flex shrink-0 items-center gap-1 text-10 text-ink-400" title="命中后还要过这道随机闸：1 = 必中，0.5 = 一半概率">
                              <span>概率</span>
                              {/* 🔴 走 NumberField（2026-10-10 六维审计）：原来的受控 `type=number` 在输入「0.」这种中间态时
                                  Number('0.') === 0 ⇒ 父值被同步成 0、输入框回写成「0」，**小数点根本打不出来** ——
                                  概率只能填 0 或 1，引擎侧 prob 语义形同虚设。NumberField 有本地文本态，编辑期不被外部值回写。 */}
                              <NumberField
                                value={e.prob}
                                onChange={v => {
                                  const prob = typeof v === 'number' ? v : 1
                                  setStory(prev => prev ? {
                                    ...prev,
                                    entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, prob } : x),
                                  } : prev)
                                  setStoryDirty(true)
                                }}
                                min={0} max={1} step={0.1} precision={2}
                                className="w-14 rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                              />
                            </label>
                          </div>
                          {/* 四色灯（2026-10-05）：显式设过就以它为准，没设过按老语义推断 */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <EntryStatePicker
                              value={e.state}
                              inferred={entryStateOf(e)}
                              size="sm"
                              onChange={next => {
                                setStory(prev => prev ? {
                                  ...prev,
                                  entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, state: next } : x),
                                } : prev)
                                setStoryDirty(true)
                              }}
                            />
                            <span className="text-10 text-ink-600">
                              {entryStateOf(e) === 'on' ? '每轮都带' : e.keys.length ? `自带 ${e.keys.length} 个触发词` : '按触发词命中'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : kind === 'script' && cur ? (
            <TavernScriptFields
              value={fields}
              onChange={patch => {
                setCur(prev => (prev ? { ...prev, ...patch } : prev))
                setScriptDirty(true)
              }}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-12 text-ink-500">
              左边选一个故事看它的设定，或展开它选一份剧本。
              <p className="mt-2 text-11 leading-relaxed text-ink-600">
                故事管「世界」，剧本管「这一场」。人物的身世与性格放角色卡 —— 三处别互相抄。
              </p>
            </div>
          )}
        </div>

        {/* 右：AI 起草（剧本） / 故事信息 */}
        <aside className="w-72 shrink-0 space-y-3 overflow-y-auto">
          {kind === 'story' && story ? (
            <>
              <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
                <div className="text-12 text-amber">AI 起草世界设定</div>
                <p className="mt-1 text-10 text-ink-400 leading-relaxed">
                  写一句这个世界大概什么样，AI 补全名称与设定。已有内容一并交给它做「补完」——
                  它写不出来就不会动你写的部分，生成后请照例审一遍。
                </p>
                <div className="mt-2">
                  <div className="text-11 text-ink-400">一句话想法</div>
                  <AutoTextarea
                    value={seed}
                    onChange={setSeed}
                    minRows={3}
                    maxHeight={200}
                    placeholder="例：现代都市但有低阶术法，术士受牌照管制，普通人不知道灵脉存在。江湖与官面井水不犯河水。"
                  />
                </div>
                <div className="mt-2">
                  <RefsField value={refs} onChange={setRefs} />
                </div>
                <div className="mt-1.5">
                  <SearchPlanLine settings={search} />
                </div>
                <Button
                  variant="primary" size="md" className="mt-2 w-full"
                  disabled={drafting || (!seed.trim() && !refs.trim() && isEmptyStoryFields(storyFields))}
                  onClick={() => void runStoryDraft()}
                >
                  {drafting ? '正在生成…' : '一键起草（缺的补上）'}
                </Button>
                <div className="mt-1.5">
                  <Button variant="secondary" size="md" className="w-full" onClick={() => setInterviewOpen(true)}>
                    对话引导（边聊边写）
                  </Button>
                </div>
                <DraftSourceLine source={lastSource} />
                {story.draftedAt ? (
                  <p className="mt-1.5 text-10 text-ink-500">
                    上次生成：{new Date(story.draftedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="text-12 text-ink-200">注入情况</div>
                {(() => {
                  // 🔴 两种形态分开算（2026-10-05）：
                  //   · 没有词条 ⇒ 整段世界设定退化成一个常驻词条，受**固定额度**约束（这里是"全量注入"）
                  //   · 有词条   ⇒ 逐条按触发词命中，受**动态额度**约束、超了逐条取舍
                  const hasEntries = (story.entries ?? []).length > 0
                  const settingChars = story.setting.trim().length
                  const cap = hasEntries ? quota.dynamic : quota.fixed
                  // 「本轮最少注入」= 空上下文下必带的那些（常驻词条 / 整段设定）
                  // 🔴 两个 0 都是「不限额、原样返回」（见 worldBook.renderEntries 的 `max <= 0` 分支）——
                  //    这一行的语义是「空上下文下**必带的那些**的完整长度」。
                  //    漏传 `fixedMaxChars` 会让固定层回落到 2400 而把整段设定截断，
                  //    于是 `over` 恒为 false、「超额度」告警永不出现（2026-10-05 实机 audit-q D2 抓到）。
                  const minChars = buildStoryWorldBook(
                    hasEntries ? { setting: '', entries: story.entries } : { setting: story.setting },
                    '', { maxChars: 0, fixedMaxChars: 0 },
                  ).text.length
                  const over = minChars > cap
                  return (
                    <div className="mt-1.5 space-y-1 text-11 text-ink-400">
                      <div>
                        {hasEntries ? '词条写下来共 ' : '世界设定 '}
                        <span className="text-ink-200">{(story.entries ?? []).reduce((n, x) => n + (x.body ?? '').length + (x.title ?? '').length, 0) || settingChars}</span> 字
                      </div>
                      <div>
                        每轮最少注入 <span className={over ? 'text-amber' : 'text-ink-200'}>{minChars}</span> 字
                        <span className="text-ink-600"> / {hasEntries ? `动态额度 ${quota.dynamic}` : `固定额度 ${quota.fixed}`}</span>
                      </div>
                      {over && (
                        <div className="text-amber leading-relaxed">
                          {hasEntries
                            ? `常驻词条已超动态额度 ${quota.dynamic} 字 —— 超出部分按优先级逐条取舍（先留常驻、再留直接命中，最后才砍被引荐的）。给它们加触发词最省。`
                            : `世界设定已超固定额度 ${quota.fixed} 字，保存会被拦下 —— 请精简，或拆成带触发词的「世界书词条」（那样按命中注入、更省）。`}
                        </div>
                      )}
                      <div className="text-ink-600">
                        额度按 {quota.ready ? `「${quota.modelLabel || '当前模型'}」` : '当前模型'}的
                        {' '}{fmtWindow(quota.windowTokens)} 窗口算
                        {quota.windowFallback && '（模型没填窗口，按 32K 估）'}
                      </div>
                      <div className="leading-relaxed">
                        旗下剧本 <span className="text-ink-200">{scripts.filter(s => s.storyId === story.id).length}</span> 份，
                        角色卡 <span className="text-ink-200">{storyCharCount}</span> 张
                      </div>
                      {!settingChars && !hasEntries && <div className="text-ink-600">（还没写设定，扮演时会缺世界观）</div>}
                    </div>
                  )
                })()}
              </div>
            </>
          ) : kind === 'script' && cur ? (
            <>
              <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
                <div className="text-12 text-amber">AI 起草剧本六栏</div>
                <p className="mt-1 text-10 text-ink-400 leading-relaxed">
                  写一句你想要的戏（越具体越好），AI 补全六栏。它空着的栏不会覆盖你已写的内容，
                  生成后过一遍再保存。
                </p>
                <div className="mt-2">
                  <div className="text-11 text-ink-400">一句话想法</div>
                  <AutoTextarea
                    value={seed}
                    onChange={setSeed}
                    minRows={3}
                    maxHeight={200}
                    placeholder="例：雨夜便利店，她是夜班店员，我是每天来买烟的人，今天她忽然锁了烟柜。我想让她说出为什么。
也可以点名已有作品：例：按《梁山伯与祝英台》设计一场楼台会的戏。"
                  />
                </div>
                <div className="mt-2">
                  <RefsField value={refs} onChange={setRefs} />
                </div>
                <div className="mt-1.5">
                  <SearchPlanLine settings={search} />
                </div>
                <Button
                  variant="primary" size="md" className="mt-2 w-full"
                  disabled={drafting || (!seed.trim() && !refs.trim() && isEmptyScriptFields(fields))}
                  onClick={() => void runDraft()}
                >
                  {drafting ? '正在生成…' : '一键起草（缺的栏补上）'}
                </Button>
                <div className="mt-1.5">
                  <Button variant="secondary" size="md" className="w-full" onClick={() => setInterviewOpen(true)}>
                    对话引导（边聊边写）
                  </Button>
                </div>
                <DraftSourceLine source={lastSource} />
                {cur.draftedAt ? (
                  <p className="mt-1.5 text-10 text-ink-500">
                    上次生成：{new Date(cur.draftedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="text-12 text-ink-200">注入情况</div>
                <div className="mt-1.5 space-y-1 text-11 text-ink-400">
                  <div>
                    每轮注入 <span className={preview.length > SCRIPT_MAX_CHARS ? 'text-amber' : 'text-ink-200'}>{preview.length}</span>
                    <span className="text-ink-600"> / 上限 {SCRIPT_MAX_CHARS} 字</span>
                  </div>
                  {preview.length > SCRIPT_MAX_CHARS && (
                    <div className="text-amber leading-relaxed">
                      超了 —— 它每轮都进上下文，会挤掉对话历史。建议精简情境与目标。
                    </div>
                  )}
                  <div>开场白单列一条消息，不占这 {SCRIPT_MAX_CHARS} 字</div>
                  {isEmptyScriptFields(fields) && <div className="text-ink-600">（六栏全空，不进上下文）</div>}
                </div>
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="text-12 text-ink-200">注入预览</div>
                <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
                  {preview || '（空）'}
                </pre>
                {!isEmptyScriptFields(fields) && (
                  <>
                    <div className="mt-2 text-10 text-ink-500">
                      开场白（在对话里作为「开场」单独显示，示例）：
                    </div>
                    <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
                      {cur.opening.trim() || '（没写开场白 → 没有第一条消息，你直接开口）'}
                    </pre>
                  </>
                )}
                {!isEmptySnapshot(snapshotOf(cur)) && (
                  <p className="mt-2 text-10 leading-relaxed text-ink-600">
                    这段在会话里以「这一场」为标题注入，排在角色卡之后、记忆之前。
                    开头那句是 {firstLine(cur.situation, 24) || '（没写情境）'}。
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
              <div className="text-12 text-ink-200">故事设定</div>
              <p className="mt-1.5 text-10 leading-relaxed text-ink-400">
                世界设定「每轮都要给模型看」，写太长会挤掉对话历史；建议 400–1200 字，
                把「不写出来模型就会瞎编」的那几件大事写清楚即可。
                细节让背景设定（关键词触发）去扛 —— 它命中才注入，不占常驻额度。
              </p>
              {story && (
                <div className="mt-2 space-y-1 text-11 text-ink-400">
                  <div>
                    当前字数 <span className="text-ink-200">{story.setting.trim().length}</span>
                    <span className="text-ink-600"> 字</span>
                  </div>
                  <div>
                    旗下剧本 <span className="text-ink-200">{scripts.filter(s => s.storyId === story.id).length}</span>
                    <span className="text-ink-600"> 份</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

    </div>
  )
}

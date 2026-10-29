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
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { usePersistedSet } from '@/lib/settings/uiPrefs'
import HelpPopover from '@/components/common/HelpPopover'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import TavernInterviewDialog from '@/components/tavern/TavernInterviewDialog'
import TavernScriptImportDialog from '@/components/tavern/TavernScriptImportDialog'
import TavernScriptTree from '@/components/tavern/TavernScriptTree'
import TavernScriptEditor, { type EditingKind } from '@/components/tavern/TavernScriptEditor'
import TavernScriptAside from '@/components/tavern/TavernScriptAside'
import { serializeStoryImport } from '@/lib/tavern/storyImport'
import { downloadText } from '@/lib/storage/zip'
import { useSearchSettings } from '@/components/editor/DraftBits'
import { interviewToScript, interviewToStory } from '@/lib/tavern/interview'
import {
  listScripts, getScript, saveScript, createScript, deleteScript, draftScript,
  mergeScriptDraft, scriptDisplayName,
  flattenScriptFields,
  EMPTY_SCRIPT_FIELDS, type ScriptDraftFields,
} from '@/lib/tavern/script'
import {
  listStories, getStory, saveStory, createStory, deleteStory, storyDisplayName,
  draftStory, flattenStoryFields, mergeStoryDraft,
  EMPTY_STORY_FIELDS,
  type StoryDraftFields,
} from '@/lib/tavern/story'
import { listCharsByStory } from '@/lib/tavern/store'
import { useTavernQuota } from '@/components/tavern/useTavernQuota'
import type { DraftSource } from '@/lib/tavern/draft'
import type { TavernScript, TavernScriptIndexItem, TavernStory, TavernStoryIndexItem } from '@/lib/tavern/types'

export default function TavernScript() {
  const [stories, setStories] = useState<TavernStoryIndexItem[]>([])
  const [scripts, setScripts] = useState<TavernScriptIndexItem[]>([])
  /**
   * 左栏展开着的故事 id。**持久化**（localStorage，经 `lib/settings/uiPrefs`）——
   * 树是受控的，作者展开过哪个故事，切走页签再回来（组件重挂、state 归零）也要还在；
   * 否则界面一刷新全收起来，让人以为数据没了。
   *
   * 🔴 存的是「**已展开**的」（本页默认全收起）—— 符合 `uiPrefs` 的铁律「存偏离默认的那一侧」。
   *    ⚠️ 与角色卡页正相反（角色卡默认全展开、存的是已收起），两处别抄错。
   */
  const [openSet, updateOpenSet] = usePersistedSet('tavern-script-open')
  /** 给只读左栏树用（它与角色卡左栏一样，只读 + 发回调，不碰写操作） */
  const openIds = useMemo(() => [...openSet], [openSet])
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
    updateOpenSet(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
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
    updateOpenSet(prev => new Set(prev).add(s.id))
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
    updateOpenSet(prev => (prev.has(storyId) ? prev : new Set(prev).add(storyId)))
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

  /** 注入预览（情境 / 你的位置 / 目标 / 不要发生 —— 开场白不进这里）
   *  ⚠️ 预览已随右栏下沉到 `TavernScriptAside`（3.0 · W3-3 收尾），此处不再重复计算。 */

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
      <header data-guide="page-header" className="shrink-0 border-b border-ink-700 pb-3">
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
        {/* 左：故事 → 剧本 树状列表（3.0 · W3-3 · §11.1 L5：抽成独立组件，props 面最窄的一头） */}
        <TavernScriptTree
          stories={stories} scripts={scripts} openIds={openIds}
          story={story} cur={cur} kind={kind}
          onToggleOpen={toggleOpen}
          onOpenStory={(id) => void openStory(id)}
          onOpenScript={(id) => void openScript(id)}
        />

        {/* 中：故事设定 / 剧本六栏（3.0 · G4 · §11.1 L5：抽成独立组件，纯受控、不持状态） */}
        <TavernScriptEditor
          kind={kind} story={story} setStory={setStory} setStoryDirty={setStoryDirty}
          fields={fields} cur={cur} setCur={setCur} setScriptDirty={setScriptDirty}
        />

        {/* 右：AI 起草（剧本） / 故事信息（3.0 · W3-3 · §11.1 L5 收尾：抽成受控展示组件） */}
        <TavernScriptAside
          kind={kind} story={story} cur={cur}
          storyFields={storyFields} fields={fields} scripts={scripts}
          storyCharCount={storyCharCount} quota={quota} search={search}
          drafting={drafting} seed={seed} setSeed={setSeed} refs={refs} setRefs={setRefs}
          lastSource={lastSource}
          onOpenInterview={() => setInterviewOpen(true)}
          runStoryDraft={() => void runStoryDraft()}
          runDraft={() => void runDraft()}
        />
      </div>

    </div>
  )
}

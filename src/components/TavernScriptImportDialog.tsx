/**
 * 故事剧本 · **「导入 / 追加」弹窗**（2026-10-06 建；2026-10-09 加追加模式）
 *
 * 【为什么是「粘贴 + 解析」而不是「AI 整理」】
 * 主人拍板：**给规定模板、要求按模板导**（不做 AI 兜底）——
 * 模板由 `storyImport.ts` 的 `IMPORT_TEMPLATE` 提供（唯一真源，改格式只动那一处），
 * 认不出来就**如实报第几行缺什么**，绝不猜。
 *
 * 【两种落地方式（2026-10-09 加第二种）】
 *   · **建为新故事**：一份文本＝一个新故事（含它的全部词条与剧本）——
 *     所以文本里出现第二个 `〖故事〗` 是硬错（解析层直接报）。
 *   · **追加到已有故事**：只把**词条与剧本**补进选中的那个故事去。两条拍板：
 *     ① 文本里的 `〖世界设定〗` 一律**忽略**（已有故事的世界观是它自己的，并进去只会打架）；
 *     ② 撞上目标故事里同名的剧本 / 词条 → **当场拦下**，由作者改名后重来（不自动加序号，
 *        那样会悄悄造出一个他没写过的名字）。
 *
 * 本组件只负责「搬运 + 确认 + 选择落点」，正确性全在 `lib/tavern/storyImport.ts`（有全量单测）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import AutoTextarea from '@/components/AutoTextarea'
import { showToast, copyText } from '@/components/dialogs'
import { uid } from '@/lib/id'
import {
  parseStoryImport, IMPORT_TEMPLATE, findAppendConflicts, conflictText,
  entriesToAppend, willMigrateSetting, draftEntryToWorldEntry, type ParseResult,
} from '@/lib/tavern/storyImport'
import {
  createStory, saveStory, getStory, listStories, storyDisplayName,
  STORY_NAME_MAX, STORY_SETTING_MAX,
} from '@/lib/tavern/story'
import { createScript, listScriptsByStory } from '@/lib/tavern/script'
import type { TavernStoryIndexItem } from '@/lib/tavern/types'
import { pickImportTargetId } from '@/lib/viewSelectors'

type Mode = 'create' | 'append'

interface Props {
  open: boolean
  onClose: () => void
  /** 落地成功后：刷新列表并打开目标故事（由父级承接） */
  onImported: (storyId: string) => void
  /** 追加模式的默认目标 —— 界面当前选中的那个故事 */
  defaultStoryId?: string
}

export default function TavernScriptImportDialog({ open, onClose, onImported, defaultStoryId }: Props) {
  const [mode, setMode] = useState<Mode>('create')
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  /** 追加模式的目标故事列表 */
  const [stories, setStories] = useState<TavernStoryIndexItem[]>([])
  const [targetId, setTargetId] = useState('')
  /** 目标故事里已经占着的名字（冲突检测用；由界面读库，纯函数只比对） */
  const [taken, setTaken] = useState<{ scriptNames: string[]; entryTitles: string[] }>({ scriptNames: [], entryTitles: [] })
  /**
   * 目标故事是不是「整段世界设定」的老形态。
   * 🔴 追加词条会把那段设定搬成一条常驻词条（不搬就静默失效）—— 必须提前告知作者。
   */
  const [migrates, setMigrates] = useState(false)

  // 打开时拉故事列表；目标默认选「界面上当前那个故事」，否则列表第一个
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      try {
        const list = await listStories()
        if (!alive) return
        setStories(list)
        setTargetId(prev => pickImportTargetId(prev, list.map(s => s.id), defaultStoryId))
      } catch {
        if (alive) setStories([])
      }
    })()
    // 切走 / 关闭后不再 setState（异步回来的数据可能属于上一轮）
    return () => { alive = false }
  }, [open, defaultStoryId])

  // 追加模式：读目标故事的「已占名字」与形态
  useEffect(() => {
    if (!open || mode !== 'append' || !targetId) {
      setTaken({ scriptNames: [], entryTitles: [] })
      setMigrates(false)
      return
    }
    let alive = true
    void (async () => {
      try {
        const [st, scs] = await Promise.all([getStory(targetId), listScriptsByStory(targetId)])
        if (!alive) return
        setTaken({ scriptNames: scs.map(s => s.name), entryTitles: (st?.entries ?? []).map(e => e.title) })
        setMigrates(willMigrateSetting(st))
      } catch {
        if (!alive) return
        setTaken({ scriptNames: [], entryTitles: [] })
        setMigrates(false)
      }
    })()
    return () => { alive = false }
  }, [open, mode, targetId])

  /**
   * 实时解析（空文本不解析，免得一开弹窗就先报一串错）。
   * ⚠️ 追加模式放宽「必须写 〖故事〗」—— 目标故事上面已经选了，再抄一遍名字没意义。
   */
  const parsed: ParseResult | null = useMemo(
    () => (raw.trim() ? parseStoryImport(raw, { allowNoStoryName: mode === 'append' }) : null),
    [raw, mode],
  )

  /** 追加模式的重名冲突（撞已有 + 本份文本内自撞）—— 非空就禁用「追加」 */
  const conflicts = useMemo(
    () => (mode === 'append' && parsed?.ok ? findAppendConflicts(parsed.data, taken) : []),
    [mode, parsed, taken],
  )

  const targetStory = stories.find(s => s.id === targetId) ?? null

  /** 文本里的故事名与所选目标不一致 —— 只提醒，不拦（以所选为准） */
  const nameMismatch = mode === 'append' && parsed?.ok && !!parsed.data.storyName
    && !!targetStory && parsed.data.storyName !== targetStory.name

  /** 追加模式下这份文本还有没有能追加的东西（世界设定不导入 ⇒ 只有设定就等于没内容） */
  const nothingToAppend = mode === 'append' && !!parsed?.ok
    && parsed.data.entries.length === 0 && parsed.data.scripts.length === 0

  const ignoredSettingChars = mode === 'append' && parsed?.ok ? parsed.data.setting.trim().length : 0

  const canGo = !!parsed?.ok && !busy && (mode === 'create'
    || (!!targetId && conflicts.length === 0 && !nothingToAppend))

  const copyTemplate = async () => {
    await copyText(IMPORT_TEMPLATE, '模板已复制 —— 直接粘给 AI，或填好后粘回上面的框里')
  }

  const doCreate = async () => {
    if (!parsed?.ok) return
    setBusy(true)
    try {
      const d = parsed.data

      // ① 故事（同名加序号 —— 不覆盖，也不让列表里出现两个一模一样的名字）
      const stories0 = await listStories()
      const base = (d.storyName || '未命名故事').slice(0, STORY_NAME_MAX)
      let name = base
      if (stories0.some(s => s.name === name)) {
        let n = 2
        while (stories0.some(s => s.name === `${base} (${n})`)) n++
        name = `${base} (${n})`
      }
      const story = await createStory({ name })

      // ② 词条（逐个补 id；空名给个占位，免得列表里全是空白条目）
      const entries = d.entries.map(e => draftEntryToWorldEntry(e, uid()))
      await saveStory({
        ...story,
        name,
        setting: d.setting.slice(0, STORY_SETTING_MAX),
        entries,
      })

      // ③ 剧本（逐个建在这个故事下；各栏超上限时截断，预览里已提前告知过）
      for (const sc of d.scripts) {
        await createScript({ ...sc, storyId: story.id })
      }

      showToast(`已导入「${name}」：词条 ${entries.length} 条 · 剧本 ${d.scripts.length} 份`)
      setRaw('')
      onImported(story.id)
      onClose()
    } catch (e) {
      showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 追加：只补词条与剧本，世界设定一概不动。
   * 🔴 词条走 `entriesToAppend`（内部先把老形态的整段设定搬成常驻词条）——
   *    直接 `[...story.entries, ...新增]` 会让那段设定**静默失效**（详见 storyImport.ts）。
   */
  const doAppend = async () => {
    if (!parsed?.ok || !targetId) return
    setBusy(true)
    try {
      const d = parsed.data
      const st = await getStory(targetId)
      if (!st) throw new Error('目标故事已经不在了（可能刚被删掉）—— 请重新选一个')

      if (d.entries.length) {
        await saveStory({ ...st, entries: entriesToAppend(st, d.entries) })
      }
      for (const sc of d.scripts) {
        await createScript({ ...sc, storyId: st.id })
      }

      showToast(`已追加到「${storyDisplayName(st)}」：词条 ${d.entries.length} 条 · 剧本 ${d.scripts.length} 份`
        + (ignoredSettingChars ? '（文本里的世界设定已忽略）' : ''))
      setRaw('')
      onImported(st.id)
      onClose()
    } catch (e) {
      showToast(`追加失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const goTitle = () => {
    if (!parsed?.ok) return '先粘贴符合模板的文本'
    if (mode === 'create') return '把上面解析出来的内容建成一个新故事'
    if (!targetId) return '先选一个目标故事'
    if (conflicts.length) return '先按上面的清单改名，再追加'
    if (nothingToAppend) return '这份文本里没有可追加的内容'
    return `把这些词条与剧本补进「${targetStory ? storyDisplayName(targetStory) : ''}」`
  }

  const errors = parsed && !parsed.ok ? parsed.issues.filter(i => i.level === 'error') : []
  const warns = parsed?.issues.filter(i => i.level === 'warn') ?? []

  return (
    <Modal open={open} onClose={onClose} title="导入故事 / 剧本" width="lg">
      <div className="space-y-3">
        {/* ---------- 落地方式（2026-10-09 加「追加」） ---------- */}
        <div className="flex gap-1 rounded-lg border border-ink-700 p-0.5">
          {([['create', '建为新故事'], ['append', '追加到已有故事']] as [Mode, string][]).map(([m, label]) => (
            <Button
              key={m} variant="bare" disabled={busy} onClick={() => setMode(m)}
              className={`flex-1 rounded-md px-2 py-1.5 text-12 transition-colors ${mode === m
                ? 'bg-amber/15 text-amber'
                : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'}`}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* ---------- 追加：先选落在哪个故事 ---------- */}
        {mode === 'append' && (stories.length === 0 ? (
          <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-11 leading-relaxed text-ink-300">
            还没有故事可以追加 —— 先回列表建一个，或改用上面的「建为新故事」。
          </div>
        ) : (
          <div>
            <div className="text-12 text-ink-200">追加到哪个故事</div>
            <select
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-12 text-ink-100 outline-none focus:border-amber/50 disabled:opacity-60"
            >
              {stories.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <p className="mt-1 text-10 leading-relaxed text-ink-500">
              只补<b className="text-ink-400">词条与剧本</b>，文本里的〖世界设定〗会被忽略 —— 已有故事的世界观不动。
              <span className="text-ink-600"> 撞上同名的剧本 / 词条会拦下，改个名再来。</span>
            </p>
          </div>
        ))}

        {/* ---------- 说明条（按模式换文案） ---------- */}
        <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-11 leading-relaxed text-ink-300">
          {mode === 'create' ? (
            <>
              把按模板写好的文本粘进来。一份文本＝<b className="text-ink-200">一个故事</b>
              （含它下面的全部词条与剧本）—— 多个故事请分开导入。
              <span className="text-amber/90"> 认不出标记就会报「第几行缺什么」，绝不猜。</span>
            </>
          ) : (
            <>
              把要补的<b className="text-ink-200">词条与剧本</b>粘进来（可以带〖故事〗，也可以不带 —— 目标上面已经选了）。
              <span className="text-amber/90"> 世界设定不导入；重名的当场拦下，绝不悄悄改名。</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copyTemplate()}>复制模板</Button>
          {raw && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRaw('')}>清空</Button>}
          <span className="flex-1" />
          <span className="text-11 text-ink-500">{raw.trim() ? `${raw.length} 字` : '还没粘贴内容'}</span>
        </div>

        <AutoTextarea
          value={raw}
          onChange={setRaw}
          minRows={9}
          maxHeight={300}
          disabled={busy}
          placeholder={mode === 'create'
            ? '把文本粘贴到这里 —— 先点「复制模板」拿格式，填好后整段粘回来。'
            : '把要补的剧本（可带词条）粘贴到这里 —— 故事名可写可不写，世界设定会忽略。'}
          className="w-full resize-none rounded-md border border-ink-700 bg-ink-900 px-2.5 py-2 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />

        {/* ---------- 解析结果 ---------- */}
        {parsed && (
          <div className="rounded-md border border-ink-700 bg-ink-900/60 px-3 py-2">
            {parsed.ok ? (
              <div className="space-y-1 text-12 text-ink-300">
                {mode === 'create' ? (
                  <div className="text-ink-100">
                    将导入：<b>{parsed.data.storyName || '（未命名故事）'}</b>
                  </div>
                ) : (
                  <div className="text-ink-100">
                    将追加到：<b>{targetStory ? storyDisplayName(targetStory) : '（还没选故事）'}</b>
                  </div>
                )}
                <div>
                  世界设定 {parsed.data.setting.length} 字 · 词条 {parsed.data.entries.length} 条 ·
                  剧本 {parsed.data.scripts.length} 份
                </div>
                {parsed.data.entries.length > 0 && (
                  <div className="text-11 text-ink-500">
                    词条：{parsed.data.entries.map(e => e.title || '（未命名）').join(' / ').slice(0, 80)}
                  </div>
                )}
                {parsed.data.scripts.length > 0 && (
                  <div className="text-11 text-ink-500">
                    剧本：{parsed.data.scripts.map(s => s.name || '（未命名）').join(' / ').slice(0, 80)}
                  </div>
                )}

                {/* ---- 追加模式专属提示 ---- */}
                {mode === 'append' && ignoredSettingChars > 0 && (
                  <div className="text-11 text-amber">
                    文本里的世界设定（{ignoredSettingChars} 字）已忽略 —— 追加不改已有故事的设定。
                  </div>
                )}
                {mode === 'append' && migrates && parsed.data.entries.length > 0 && (
                  <div className="text-11 leading-relaxed text-amber">
                    这个故事的世界设定目前是「整段」形态 —— 追加词条后它会变成第一条常驻词条（内容不变），
                    之后按词条逐条注入。
                  </div>
                )}
                {nameMismatch && (
                  <div className="text-11 text-ink-500">
                    文本里写的故事名是「{parsed.data.storyName}」，与所选不一致 —— 以所选故事为准。
                  </div>
                )}
                {nothingToAppend && (
                  <div className="text-11 text-danger">
                    这份文本里没有可追加的内容（世界设定不导入）—— 至少给它一份剧本或一条词条。
                  </div>
                )}
              </div>
            ) : (
              <ul className="space-y-1 text-12 text-danger">
                {errors.map((e, i) => (
                  <li key={i}>{e.line ? `第 ${e.line} 行：` : ''}{e.message}</li>
                ))}
              </ul>
            )}

            {/* 重名拦下（2026-10-09）：红字列出到底是哪一个撞了，不自动改名 */}
            {conflicts.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-ink-700 pt-2 text-12 text-danger">
                {conflicts.map((c, i) => <li key={i}>{conflictText(c)}</li>)}
              </ul>
            )}

            {warns.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-ink-700 pt-2 text-11 leading-relaxed text-amber">
                {warns.map((w, i) => (
                  <li key={i}>{w.line ? `第 ${w.line} 行：` : ''}{w.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <span className="flex-1" />
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>取消</Button>
          <Button
            variant="primary" size="md"
            disabled={!canGo}
            title={goTitle()}
            onClick={() => void (mode === 'create' ? doCreate() : doAppend())}
          >
            {busy ? (mode === 'create' ? '导入中…' : '追加中…') : (mode === 'create' ? '导入' : '追加')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

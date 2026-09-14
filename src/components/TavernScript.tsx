/**
 * 酒馆模式 · 剧本编辑（tavern-script）
 *
 * 【这个页签解决什么】
 * 角色卡只回答了「这个人是谁」；一场戏还需要「此刻在哪、为什么在这儿、这一场想干嘛」。
 * 原先这些内容散在「新建对话」弹窗里手填、填完就丢 —— 现在抽成一份**可复用、可命名**的剧本。
 *
 * 【六栏 = 调研结论】
 * 与 SillyTavern 的 `scenario` + `first_mes` 同构，另加「目标 / 边界」两栏：
 * 场景只管此刻（背景归角色卡与背景设定）、开场白是杠杆最高的字段、一场戏要有意图与禁区。
 * 详见 docs/剧本与变量-设计方案-讨论稿.md §1–§2。
 *
 * 【数据归属】
 * 🔴 剧本库是**全局**（`db.getMeta`，跨项目）—— 与角色卡同性质：它是「玩法模板」，不绑某一本书。
 * 🔴 会话引用它时存的是**快照**：作者后来改剧本，历史会话不会跟着变（否则「上周那场戏的设定
 *    今天自己变了」这种问题根本查不出来）。
 *
 * 【AI 起草沿用「背景设定」那一套】
 * 一键生成 → 人工微调 → 再保存。AI 空着的栏不覆盖你已经写好的内容（起草是补，不是重写）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import AutoTextarea from './AutoTextarea'
import TavernScriptFields from './TavernScriptFields'
import {
  listScripts, getScript, saveScript, createScript, deleteScript, draftScript,
  scriptToText, snapshotOf, mergeScriptDraft, isEmptyScriptFields, firstLine, scriptDisplayName,
  SCRIPT_MAX_CHARS, EMPTY_SCRIPT_FIELDS, isEmptySnapshot, type ScriptDraftFields,
} from '../lib/tavern/script'
import type { TavernScript, TavernScriptIndexItem } from '../lib/tavern/types'

export default function TavernScript() {
  const [list, setList] = useState<TavernScriptIndexItem[]>([])
  const [cur, setCur] = useState<TavernScript | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)
  /** AI 起草的输入（作者的粗略想法）—— 只存在于界面，不落库 */
  const [seed, setSeed] = useState('')

  const load = useCallback(async (id?: string) => {
    const l = await listScripts()
    setList(l)
    const pick = id ?? l[0]?.id
    setCur(pick ? await getScript(pick) : null)
    setDirty(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const edit = (patch: Partial<ScriptDraftFields>) => {
    setCur(prev => (prev ? { ...prev, ...patch } : prev))
    setDirty(true)
  }

  const openScript = async (id: string) => {
    if (id === cur?.id) return
    if (dirty) {
      const okGo = await confirmDialog({
        title: '切换剧本？',
        message: '当前这份有未保存的改动，切过去就丢了。',
        confirmText: '切过去',
        danger: true,
      })
      if (!okGo) return
    }
    setCur(await getScript(id))
    setDirty(false)
  }

  const createNew = async () => {
    const s = await createScript({ ...EMPTY_SCRIPT_FIELDS, name: '' })
    await load(s.id)
    showToast('已新建一份空剧本 —— 六栏填完记得保存')
  }

  const save = async () => {
    if (!cur) return
    setSaving(true)
    try {
      const saved = await saveScript(cur)
      setCur(saved)
      setDirty(false)
      setList(await listScripts())
      showToast('已保存 —— 新建对话时就能选到它')
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!cur) return
    const okGo = await confirmDialog({
      title: `删掉「${scriptDisplayName(cur)}」？`,
      message: '用过的会话不受影响 —— 它们保存的是加载时的快照，剧本删了这一场照样能跑。\n但这份剧本列表里就没了，不可撤销。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    await deleteScript(cur.id)
    setCur(null)
    setDirty(false)
    await load()
    showToast('已删除剧本')
  }

  const runDraft = async () => {
    if (!cur) return
    setDrafting(true)
    try {
      const out = await draftScript({ seed })
      const merged = mergeScriptDraft(
        {
          name: cur.name, situation: cur.situation, opening: cur.opening,
          playerRole: cur.playerRole, goal: cur.goal, taboo: cur.taboo,
        },
        out,
      )
      setCur(prev => (prev ? { ...prev, ...merged, draftedAt: Date.now() } : prev))
      setDirty(true)
      showToast('已生成六栏 —— 过一遍再保存（AI 没写的栏保留了你的原文）')
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

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50">剧本编辑</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          给自由对话准备一场戏：此刻在哪、你演谁、这一场想干嘛、什么不要发生。
          新建对话时可以选一份剧本，也可以留空直接开口聊。剧本存在全局（跨项目），
          引用它的会话保存的是当时的快照 —— 你后来改剧本，不会把老会话的设定悄悄改掉。
        </p>
      </header>

      <div className="flex items-center gap-2 pt-3">
        <Button variant="primary" size="md" onClick={() => void createNew()}>＋ 新建剧本</Button>
        <Button variant="secondary" size="md" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </Button>
        {cur && (
          <Button variant="secondary" size="md" disabled={!dirty} onClick={() => void openScript(cur.id)}>放弃改动</Button>
        )}
        <span className="flex-1" />
        {dirty && <span className="text-[11px] text-amber">有未保存的改动</span>}
        {cur && <Button variant="ghost" size="md" onClick={() => void remove()}>删除这份</Button>}
      </div>

      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左：剧本列表 */}
        <aside className="w-52 shrink-0 overflow-y-auto">
          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-ink-700 p-3 text-center text-[11.5px] text-ink-500">
              还没有剧本。点上面「新建剧本」，或让 AI 按你的一句话起草。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {list.map(it => (
                <li key={it.id}>
                  <button
                    type="button" onClick={() => void openScript(it.id)}
                    title={it.goalBrief || '（还没写目标）'}
                    className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${it.id === cur?.id
                      ? 'border-amber/50 bg-amber/10'
                      : 'border-ink-800 bg-ink-850/30 hover:border-ink-600'}`}
                  >
                    <div className={`truncate text-[12.5px] ${it.id === cur?.id ? 'text-amber' : 'text-ink-200'}`}>
                      {it.name}
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-ink-500">
                      {it.goalBrief || '（还没写目标）'}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10.5px] leading-relaxed text-ink-600">
            共 {list.length} 份 · 跨项目共用（换本书也还在）
          </p>
        </aside>

        {/* 中：六栏编辑 */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {!cur ? (
            <div className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-[12px] text-ink-500">
              左边选一份，或新建一份剧本。
              <p className="mt-2 text-[11px] leading-relaxed text-ink-600">
                剧本只管「这一场」：此刻的处境、你的位置、这一场的目标与禁区。
                人物的身世与性格放角色卡，世界的规矩放背景设定 —— 三处别互相抄。
              </p>
            </div>
          ) : (
            <TavernScriptFields value={fields} onChange={edit} />
          )}
        </div>

        {/* 右：AI 起草 + 注入预览 */}
        <aside className="w-72 shrink-0 space-y-3 overflow-y-auto">
          <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
            <div className="text-[12px] text-amber">AI 起草六栏</div>
            <p className="mt-1 text-[10.5px] text-ink-400 leading-relaxed">
              写一句你想要的戏（越具体越好），AI 补全六栏。它空着的栏不会覆盖你已写的内容，
              生成后过一遍再保存。
            </p>
            <div className="mt-2">
              <div className="text-[11px] text-ink-400">一句话想法</div>
              <AutoTextarea
                value={seed}
                onChange={setSeed}
                minRows={3}
                maxHeight={200}
                placeholder="例：雨夜便利店，她是夜班店员，我是每天来买烟的人，今天她忽然锁了烟柜。我想让她说出为什么。"
              />
            </div>
            <Button
              variant="primary" size="md" className="mt-2 w-full"
              disabled={drafting || !cur || !seed.trim()}
              onClick={() => void runDraft()}
            >
              {drafting ? '正在生成…' : '一键起草'}
            </Button>
            {cur?.draftedAt ? (
              <p className="mt-1.5 text-[10px] text-ink-500">
                上次生成：{new Date(cur.draftedAt).toLocaleString()}
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
            <div className="text-[12px] text-ink-200">注入情况</div>
            <div className="mt-1.5 space-y-1 text-[11px] text-ink-400">
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
              {cur && isEmptyScriptFields(fields) && <div className="text-ink-600">（六栏全空，不进上下文）</div>}
            </div>
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
            <div className="text-[12px] text-ink-200">注入预览</div>
            <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-[10.5px] leading-relaxed text-ink-400">
              {preview || '（空）'}
            </pre>
            {cur && !isEmptyScriptFields(fields) && (
              <>
                <div className="mt-2 text-[10.5px] text-ink-500">
                  开场白（对话第一条消息，示例）：
                </div>
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-[10.5px] leading-relaxed text-ink-400">
                  {cur.opening.trim() || '（没写开场白 → 没有第一条消息，你直接开口）'}
                </pre>
              </>
            )}
            {cur && !isEmptySnapshot(snapshotOf(cur)) && (
              <p className="mt-2 text-[10px] leading-relaxed text-ink-600">
                这段在会话里以「这一场」为标题注入，排在角色卡之后、记忆之前。
                开头那句是 {firstLine(cur.situation, 24) || '（没写情境）'}。
              </p>
            )}
          </div>
        </aside>
      </div>

    </div>
  )
}

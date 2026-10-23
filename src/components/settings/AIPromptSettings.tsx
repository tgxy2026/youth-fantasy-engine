import Panel from '@/components/common/Panel'
import { useEffect, useMemo, useState } from 'react'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import { MessageSquareCode, RotateCcw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import { showToast } from '@/components/dialogs/dialogs'
import { foldVh } from '@/lib/settings/theme'
import { usePersistedSet } from '@/lib/settings/uiPrefs'
import {
  listPrompts, savePromptOverride, resetPromptOverride, resetAllPromptOverrides,
  PROMPT_GROUPS, type PromptEntry, type PromptGroup,
} from '@/lib/ai/promptSettings'

/**
 * 「AI 提示词」设置板块（2026-09-19 新增，老大要求）：
 * 把项目里各 AI 功能的内置提示词全部摆到前台，逐条可改、可存、可一键还原。
 *
 * 【为什么不做"改了就立刻生效"的即时保存】
 * 提示词是**影响全局 AI 行为**的东西，改一半错一半会让所有功能一起跑偏。
 * 所以每一条都是「草稿 → 保存」，还有显式的「还原出厂」；底部另给「全部还原」。
 *
 * 【排序】按功能板块（正文写作 / 编辑与审校 / 设定与资料 / 项目诊断 / 灵感工具 / 酒馆模式），
 * 组内按登记顺序 —— 与侧栏的功能分区一致，作者按"我刚在用哪个功能"就能找到。
 */
export default function AIPromptSettings({ refreshKey = 0 }: { refreshKey?: number }) {
  const [entries, setEntries] = useState<PromptEntry[]>(() => listPrompts())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // 提示词条目的展开状态跨会话记忆（见 lib/uiPrefs）：存「已展开的条目」，
  // 空集合 = 全部收起（默认观感：一屏能扫到全部提示词的名字，想看哪条点哪条）。
  const [expandedPrompts, updateExpandedPrompts] = usePersistedSet('prompt-expanded')
  const [busy, setBusy] = useState(false)
  /** 最近动过的那条提示词的 id —— Ctrl+S 就存它（本页是一条一条存，没有「全部保存」键） */
  const [editingId, setEditingId] = useState('')

  // 重新读一遍（保存/还原后、或模型配置变了之后）
  /**
   * 🔴 3.2.2 · 审计 A9（P2）：**不能一保存就清空全部草稿**。
   *
   * 现场：展开两条提示词、各改一段，只点第一条「保存」 ⇒ 第二条的未保存文本被还原成原值。
   * 根因是保存后统一 `reload()`，而它内部 `setDrafts({})` 把**所有**条目的草稿都清了。
   * 现在默认保留其它草稿，只有显式「全部还原」才清全场。
   */
  const reload = (opts?: { dropAllDrafts?: boolean }) => {
    setEntries(listPrompts())
    if (opts?.dropAllDrafts) setDrafts({})
  }

  /** 只丢掉某一条的草稿（它自己的值已经落库/还原，留着会顶着旧文本） */
  const dropDraft = (id: string) => {
    setDrafts((d) => {
      if (!(id in d)) return d
      const next = { ...d }
      delete next[id]
      return next
    })
  }
  useEffect(() => { reload() }, [refreshKey])

  const grouped = useMemo(() => {
    const map = new Map<PromptGroup, PromptEntry[]>()
    for (const g of PROMPT_GROUPS) {
      const list = entries.filter(e => e.group === g)
      if (list.length) map.set(g, list)
    }
    return [...map.entries()]
  }, [entries])

  const changedCount = entries.filter(e => e.overridden).length

  const save = async (e: PromptEntry) => {
    const text = drafts[e.id] ?? e.text
    if (!text.trim()) { showToast('提示词不能为空', 'error'); return }
    setBusy(true)
    try {
      await savePromptOverride(e.id, text)
      // 只清这一条的草稿；别的条目正在改的内容原样保留（审计 A9）
      dropDraft(e.id)
      reload()
      showToast('已保存，下一次调用即生效')
    } catch (err) {
      showToast('保存失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally { setBusy(false) }
  }

  const reset = async (e: PromptEntry) => {
    setBusy(true)
    try {
      await resetPromptOverride(e.id)
      dropDraft(e.id)
      reload()
      showToast(`「${e.name}」已还原为出厂设置`)
    } catch (err) {
      showToast('还原失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally { setBusy(false) }
  }

  const resetAll = async () => {
    setBusy(true)
    try {
      await resetAllPromptOverrides()
      // 全部还原是显式全局操作 ⇒ 这里才清全场草稿
      reload({ dropAllDrafts: true })
      showToast('全部提示词已还原为出厂设置')
    } catch (err) {
      showToast('还原失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally { setBusy(false) }
  }

  // 🔴 本页是「一条一条存」（没有全局保存键）⇒ Ctrl+S 存**最近动过**的那条。
  //    作者改完提示词顺手按 Ctrl+S 是极自然的动作，此前毫无反应。
  const editingEntry = editingId ? entries.find(e => e.id === editingId) : undefined
  const editingDirty = !!editingEntry
    && drafts[editingEntry.id] !== undefined
    && drafts[editingEntry.id] !== editingEntry.text
  useSaveHotkey(() => { if (editingEntry) void save(editingEntry) }, editingDirty && !busy)

  return (
    <Panel>
      <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
        <MessageSquareCode size={14} className="text-amber" /> AI 提示词
        {changedCount > 0 && (
          <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">
            已改 {changedCount} 条
          </span>
        )}
        <HelpPopover title="AI 提示词怎么改" width="24rem">
          {'这里列出各 AI 功能「内置的提示词全文」 —— 它们原本写死在程序里，现在可以直接改。\n\n【能改什么】语气、称呼、输出详略、额外的禁忌与偏好。比如让「章节审读」多说节奏、少说人设；让「AI 整理」只登记重要条目。\n\n【改完怎么生效】点该条的「保存」后，下一次调用该功能即生效，不用重启。\n\n【改坏了怎么办】每条都有「还原出厂」；右上「全部还原」一次恢复所有。保存的只是「你改过的那些」，出厂原文永远在程序里，不会被覆盖。\n\n⚠️ 两件事别在这里改：\n· 「酒馆模式的扮演协议」 —— 在「酒馆模式 → 控制面板」里改（那边有版本与出厂对照）；\n· 「提示词的骨架结构」（比如要求返回 JSON 的格式约定）—— 那与解析代码是绑定的，改坏了会解析不出结果。想大改先小步试一次。'}
        </HelpPopover>
      </h2>

      <div className="space-y-4">
        {grouped.map(([group, list]) => (
          <div key={group}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-12 font-semibold text-ink-200">{group}</h3>
              <span className="text-11 text-ink-500">{list.length} 条</span>
            </div>
            <div className="space-y-2">
              {list.map(e => {
                const draft = drafts[e.id] ?? e.text
                const dirty = draft !== e.text
                const isCollapsed = !expandedPrompts.has(e.id)
                return (
                  <div key={e.id} className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-12 font-medium text-ink-100">{e.name}</span>
                      {e.overridden && (
                        <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-10 text-amber">已改过</span>
                      )}
                      <div className="flex-1" />
                      {/* 🔴 用 secondary 而不是 bare（2026-09-19 六维审计 P2-12）：`bare` 会**丢弃 sizeCls**
                          （size="xs" 实际无效）且静止无框无内边距，与「文字按钮用 secondary、
                          行内小操作 xs」的按钮约定不一致。 */}
                      <Button size="xs" variant="secondary"
                        onClick={() => updateExpandedPrompts(prev => {
                          const n = new Set(prev)
                          if (n.has(e.id)) n.delete(e.id); else n.add(e.id)
                          return n
                        })}
                        title={isCollapsed ? '展开看提示词全文' : '收起'}>
                        {isCollapsed ? '展开全文' : '收起'}
                      </Button>
                    </div>
                    {e.note && <p className="mt-1 text-11 text-ink-500 leading-relaxed">{e.note}</p>}

                    {!isCollapsed && (
                      <>
                        <textarea
                          value={draft}
                          onChange={ev => { setEditingId(e.id); setDrafts(d => ({ ...d, [e.id]: ev.target.value })) }}
                          spellCheck={false}
                          className="mt-2 w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-2 text-12 text-ink-100 leading-relaxed outline-none focus:border-amber/50 font-mono"
                          style={{ height: foldVh('32vh'), minHeight: 140 }}
                        />
                        <div className="mt-2 flex items-center gap-2">
                          {/* U-10 · 2.6.0：保存是主操作，xs→sm（xs 只给行内工具键） */}
                          <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => void save(e)}>
                            保存
                          </Button>
                          {/* 🔴 2026-10-12 主人反馈「还原出厂比保存矮一截」：两者同排 = 同一决策组，
                              必须同 size（原为 xs=h-6/26px，与 sm=h-8/35px 差 9px）。
                              「同排同 size」是项目按钮红线，见 Button.tsx 的 SIZE 基线。 */}
                          <Button size="sm" variant="secondary" disabled={!e.overridden || busy}
                            onClick={() => void reset(e)}>
                            <RotateCcw size={11} /> 还原出厂
                          </Button>
                          {dirty && <span className="text-11 text-amber">{UNSAVED_CHANGES_HINT}</span>}
                          <div className="flex-1" />
                          <span className="text-10 text-ink-600">
                            {draft.length} 字 · 出厂 {e.defaultText.length} 字
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {entries.length === 0 && (
          <p className="text-12 text-ink-500">暂无可编辑的提示词（尚未登记）。</p>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-ink-700 pt-3">
        <Button size="sm" variant="secondary" disabled={changedCount === 0 || busy} onClick={() => void resetAll()}>
          全部还原出厂
        </Button>
        <span className="text-11 text-ink-500">
          共 {entries.length} 条提示词；保存的只有你改动过的那些，出厂原文始终保留在程序内。
        </span>
      </div>
    </Panel>
  )
}

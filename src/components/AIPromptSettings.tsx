import { useEffect, useMemo, useState } from 'react'
import { MessageSquareCode, RotateCcw } from 'lucide-react'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import { foldVh } from '../lib/theme'
import {
  listPrompts, savePromptOverride, resetPromptOverride, resetAllPromptOverrides,
  PROMPT_GROUPS, type PromptEntry, type PromptGroup,
} from '../lib/promptSettings'

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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  // 重新读一遍（保存/还原后、或模型配置变了之后）
  const reload = () => {
    setEntries(listPrompts())
    setDrafts({})
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
      reload()
      showToast('全部提示词已还原为出厂设置')
    } catch (err) {
      showToast('还原失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally { setBusy(false) }
  }

  return (
    <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
      <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
        <MessageSquareCode size={14} className="text-amber" /> AI 提示词
        {changedCount > 0 && (
          <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">
            已改 {changedCount} 条
          </span>
        )}
        <HelpPopover title="AI 提示词怎么改" width="24rem" className="ml-auto">
          {'这里列出各 AI 功能**内置的提示词全文** —— 它们原本写死在程序里，现在可以直接改。\n\n【能改什么】语气、称呼、输出详略、额外的禁忌与偏好。比如让「章节审读」多说节奏、少说人设；让「AI 整理」只登记重要条目。\n\n【改完怎么生效】点该条的「保存」后，下一次调用该功能即生效，不用重启。\n\n【改坏了怎么办】每条都有「还原出厂」；右上「全部还原」一次恢复所有。保存的只是**你改过的那些**，出厂原文永远在程序里，不会被覆盖。\n\n⚠️ 两件事别在这里改：\n· **酒馆模式的扮演协议** —— 在「酒馆模式 → 控制面板」里改（那边有版本与出厂对照）；\n· **提示词的骨架结构**（比如要求返回 JSON 的格式约定）—— 那与解析代码是绑定的，改坏了会解析不出结果。想大改先小步试一次。'}
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
                const isCollapsed = collapsed[e.id] ?? true
                return (
                  <div key={e.id} className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-12 font-medium text-ink-100">{e.name}</span>
                      {e.overridden && (
                        <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-10 text-amber">已改过</span>
                      )}
                      <div className="flex-1" />
                      <Button size="xs" variant="bare"
                        onClick={() => setCollapsed(c => ({ ...c, [e.id]: !isCollapsed }))}
                        title={isCollapsed ? '展开看提示词全文' : '收起'}>
                        {isCollapsed ? '展开全文' : '收起'}
                      </Button>
                    </div>
                    {e.note && <p className="mt-1 text-11 text-ink-500 leading-relaxed">{e.note}</p>}

                    {!isCollapsed && (
                      <>
                        <textarea
                          value={draft}
                          onChange={ev => setDrafts(d => ({ ...d, [e.id]: ev.target.value }))}
                          spellCheck={false}
                          className="mt-2 w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-2 text-12 text-ink-100 leading-relaxed outline-none focus:border-amber/50 font-mono"
                          style={{ height: foldVh('32vh'), minHeight: 140 }}
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <Button size="xs" variant="primary" disabled={!dirty || busy} onClick={() => void save(e)}>
                            保存
                          </Button>
                          <Button size="xs" variant="secondary" disabled={!e.overridden || busy}
                            onClick={() => void reset(e)}>
                            <RotateCcw size={11} /> 还原出厂
                          </Button>
                          {dirty && <span className="text-11 text-amber">未保存</span>}
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
    </section>
  )
}

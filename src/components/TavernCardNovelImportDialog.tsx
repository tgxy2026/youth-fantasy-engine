/**
 * 角色卡片 · **「从小说角色导入」弹窗**（2026-09-19 D4-4，从 `TavernCard.tsx` 拆出）。
 *
 * 【这是一个「一次性转换」，不是同步】AI 把小说角色改写成角色扮演用的四章卡片：
 *   设定翻译成行为倾向、剧情走向丢掉。所以文案必须写明**结果只是一份草稿** ——
 *   尤其第 4 章示例对话通常是模型编的。
 *
 * 【筛选态与派生列表为什么跟着搬进来】`nq` / `ntab` 的声明留在父级（父级还会在打开时重置它们、
 *   并把读到的角色塞进 `novelChars`），但 `novelRows`（过滤结果）与 `novelCount`（页签计数）
 *   只有这个弹窗用 —— 让父级替子区域保管派生值没有意义，一起搬走（逐行未改）。
 *
 * ⚠️ props 名与原局部变量**同名**（含 `importOpen` / `setImportOpen` 这对略直白的名字）
 *   ⇒ 内部 JSX 逐字未改（缩进保留原样，6 / 8 空格）。
 *
 * ⚠️ 唯一一处非逐字的改动：原件在 `return (` 之前那句 JSX 注释（花括号包着的那种）
 *   改成了普通块注释 —— `return (` 里不能再放一个「只有注释、没有元素」的表达式容器。
 */
import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { Button } from './Button'
import Avatar from './Avatar'
import { Modal } from './Modal'
import { type NovelTab } from './useTavernCardModel'

const NOVEL_TABS: { id: NovelTab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'char-main', label: '主要' },
  { id: 'char-secondary', label: '次要' },
  { id: 'char-npc', label: 'NPC' },
]
const NOVEL_TAB_LABEL: Record<string, string> = {
  'char-main': '主要', 'char-secondary': '次要', 'char-npc': 'NPC',
}

interface Props {
  /** 弹窗开着没有 */
  importOpen: boolean
  setImportOpen: Dispatch<SetStateAction<boolean>>
  /** 当前项目里已建档的小说角色（读三张表汇总；打开时由父级填） */
  novelChars: { id: string; name: string; tabId: string }[]
  /** 弹窗内的搜索词（打开时由父级重置） */
  nq: string
  setNq: Dispatch<SetStateAction<string>>
  /** 分组页签（打开时由父级重置为 all） */
  ntab: NovelTab
  setNtab: Dispatch<SetStateAction<NovelTab>>
  /** 转换中：这段时间里列表按钮与「关闭」都要禁用 */
  converting: boolean
  convert: (cardId: string, tabId: string) => Promise<void>
}

export default function TavernCardNovelImportDialog({
  importOpen, setImportOpen, novelChars, nq, setNq, ntab, setNtab, converting, convert,
}: Props) {
  /** 导入弹窗的可见列表：分组页签 + 关键字（按名字） */
  const novelRows = useMemo(() => {
    const kw = nq.trim().toLowerCase()
    return novelChars.filter(c =>
      (ntab === 'all' || c.tabId === ntab) && (!kw || c.name.toLowerCase().includes(kw)))
  }, [novelChars, nq, ntab])
  const novelCount = (id: NovelTab) =>
    id === 'all' ? novelChars.length : novelChars.filter(c => c.tabId === id).length

  /* 从小说角色导入：选一个角色 */
  return (
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="从小说角色导入" width="lg">
        <div className="space-y-3">
          <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-11 text-ink-300 leading-relaxed">
            AI 会把这个角色改写成角色扮演用的四章卡片：设定翻译成行为倾向、剧情走向丢掉。
            <span className="text-amber/90"> 结果只是一份草稿 —— 尤其第 4 章示例对话通常是它编的，务必自己改。</span>
          </div>
          {novelChars.length > 0 && (
            <>
              <input
                className="w-full bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-12 text-ink-100 outline-none focus:border-amber/50"
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
            <p className="py-6 text-center text-12 text-ink-500">
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
                    <span className="min-w-0 flex-1 truncate text-12 text-ink-100">{c.name}</span>
                    <span className="shrink-0 text-10 text-ink-600">
                      {NOVEL_TAB_LABEL[c.tabId] ?? c.tabId}
                    </span>
                  </button>
                </li>
              ))}
              {novelRows.length === 0 && (
                <li className="px-3 py-6 text-center text-12 text-ink-500">没有匹配的角色</li>
              )}
            </ul>
          )}
          <div className="flex items-center justify-between border-t border-ink-800 pt-2">
            <span className="text-11 text-ink-500">
              {converting
                ? '正在转换（要读一遍角色卡，可能要十几秒）…'
                : `共 ${novelChars.length} 个角色${novelRows.length === novelChars.length ? "" : ` · 命中 ${novelRows.length} 个`}`}
            </span>
            <Button variant="secondary" size="md" onClick={() => setImportOpen(false)} disabled={converting}>关闭</Button>
          </div>
        </div>
      </Modal>
  )
}

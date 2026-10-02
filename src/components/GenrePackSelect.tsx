/**
 * 「题材包」选择 / 切换控件（2.7.1）。
 *
 * 两个角色：
 *  ① `GenrePackSelect`   —— **纯受控下拉**，给「新建项目 / 首启向导」用（此时还没有项目，只取值）。
 *  ② `GenrePackSwitcher` —— **带落库与联动的切换器**，给世界设定等页签头部用（老项目事后改题材）。
 *
 * ## 🔴 切换三件事必须一起做（少一件就是静默 bug）
 *   ① `db.updateProject({ genre })` —— 把题材**落到项目上**（下次打开才知道用哪套模板）；
 *   ② `setActivePack(pack)` —— 落模块级状态（TABS 里那六个页签的 name/modules 是 getter，读它）；
 *   ③ 派发 `yfe:pack-changed` —— 让 App 更新 `visCtx.pack`（tabVisible 读它）并 bump refreshKey。
 *
 * 漏 ①：切完能用，重开项目又变回旧题材。
 * 漏 ②：侧栏/表单当场不换模板（读到的是旧包的模块）。
 * 漏 ③：制度页签的显隐不更新（历史项目切回修真后，政治/经济页签还挂在那儿）。
 *
 * ## §4.7 定案：换包**只隐藏不删除**
 * 数据键是 `模块名::字段名`，换包后旧键不消失，只是不再渲染 ⇒ 切回即完整恢复。
 * 切换时给**一次性提示**，说清「保留了多少、多少项当前不适用」——否则作者会以为切包把内容删了。
 */
import { useState } from 'react'
import * as db from '../lib/db'
import { GENRE_PACKS, getActivePack, setActivePack, PACK_TAB_IDS, type GenrePack } from '../lib/schemaTemplates'
import { getTab } from '../lib/schema'
import { isInternalFieldKey } from '../lib/worldSets'
import { showToast } from './dialogs'

const SELECT_CLS =
  'bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-2.5 py-1.5 outline-none focus:border-amber/40'

/** 纯受控下拉（新建项目 / 向导用） */
export function GenrePackSelect({
  value, onChange, className = '',
}: {
  value: GenrePack
  onChange: (pack: GenrePack) => void
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as GenrePack)}
      className={`${SELECT_CLS} ${className}`}
      title="选择作品题材：决定「世界设定 / 力量体系 / 制度页签」用哪一套模板、默认显示哪几个；事后可改。"
    >
      {GENRE_PACKS.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  )
}

/** 当前题材包下，六个受题材驱动页签的**全部合法字段键** */
function validKeysOf(): Set<string> {
  const out = new Set<string>()
  for (const id of PACK_TAB_IDS) {
    const tab = getTab(id)
    for (const m of tab?.modules ?? []) for (const f of m.fields) out.add(`${m.name}::${f.name}`)
  }
  return out
}

/** 统计：切到新包后，仍在字段表内的内容 N 项、不再适用的 M 项（都留在库里） */
async function retainedCounts(): Promise<{ kept: number; hidden: number }> {
  const valid = validKeysOf()   // 🔴 必须在 setActivePack 之后调用（getTab 的 getter 读 activePack）
  let kept = 0, hidden = 0
  for (const id of PACK_TAB_IDS) {
    const d = await db.getFormData(id).catch(() => ({} as Record<string, string>))
    for (const [k, v] of Object.entries(d)) {
      if (isInternalFieldKey(k)) continue          // 草稿箱等内部键不计
      if (!v || !String(v).trim()) continue
      if (valid.has(k)) kept++
      else hidden++
    }
  }
  return { kept, hidden }
}

/** 带落库与联动的题材包切换器（页签头部用） */
export function GenrePackSwitcher({ onSwitched }: { onSwitched?: (pack: GenrePack) => void }) {
  const [pack, setPack] = useState<GenrePack>(getActivePack())
  const [busy, setBusy] = useState(false)

  async function switchTo(next: GenrePack) {
    if (next === pack || busy) return
    const pid = db.getCurrentProjectId?.()
    if (!pid) { showToast('尚未打开项目', 'error'); return }
    setBusy(true)
    try {
      // 先落模块级状态，好让 retainedCounts 按新包算「哪些不再适用」
      setActivePack(next)
      const { kept, hidden } = await retainedCounts()
      await db.updateProject({ id: pid, genre: next })
      window.dispatchEvent(new CustomEvent('yfe:pack-changed', { detail: next }))
      setPack(next)
      if (kept + hidden === 0) {
        showToast(`已切换到「${next}」`, 'success')
      } else {
        showToast(
          `已切换到「${next}」：${kept} 项内容随之保留；另有 ${hidden} 项在当前题材下不适用`
          + `（都留在库里，切回原题材即恢复）。`,
          'info',
        )
      }
      onSwitched?.(next)
    } catch {
      setActivePack(pack)   // 落库失败 → 回滚模块级状态，避免"界面换了、库里没换"
      showToast('切换题材失败，请重试', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <label className="flex items-center gap-1.5" title="切换作品题材：同时决定用哪套模板与默认显示哪几个页签；换模板只隐藏、不删除，切回即恢复。">
      <span className="text-10 text-ink-500">题材</span>
      <select
        value={pack}
        disabled={busy}
        onChange={e => void switchTo(e.target.value as GenrePack)}
        className={`${SELECT_CLS} disabled:opacity-50`}
      >
        {GENRE_PACKS.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
    </label>
  )
}

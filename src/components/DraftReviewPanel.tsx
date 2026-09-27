/**
 * 通用草稿审阅面板（域中立）。
 *
 * 「一键拆书」与「创意写作」共用同一套审阅交互：分组 → 勾选 → 行内改 → 写入（带确认）。
 * 本组件只管「呈现 + 收集用户决定」，落库逻辑全在 `lib/flow/commit`。
 *
 * 🔴 写入前必须弹确认并列出「将新建 N 条 / 更新 M 条 / 跳过 K 条」——
 *    「绝不静默覆盖」这条红线要在用户点下按钮**之前**就让他看清将要发生什么。
 */
import { useEffect, useMemo, useState } from 'react'
import { CheckSquare, ChevronDown, ChevronRight, Square } from 'lucide-react'
import { Button } from './Button'
import { confirmDialog, showToast } from './dialogs'
import { commitDraftRows, previewCommit, type ConflictPolicy } from '../lib/flow/commit'
import { usePersistedSet } from '../lib/uiPrefs'
import { DRAFT_PICK_THRESHOLD, defaultPicked, pickableAsNew } from '../lib/flow/draft'
import type { CommitOutcome, DraftBundle, DraftRow } from '../lib/flow/types'

interface Props {
  /**
   * 草稿包。⚠️ 调用方必须保证**引用稳定**（放 state，别在 render 里现造）——
   * 本组件按引用变化重置内部编辑态与勾选态。
   */
  bundle: DraftBundle
  /** 已有同名条目时的策略（默认 keep-existing：已有数据分毫不动） */
  conflict?: ConflictPolicy
  onCommitted?: (out: CommitOutcome) => void
  /**
   * 自定义「写入」动作。给了它，本组件就**不再自己落库**，而是把用户勾选的行交回调用方。
   * 「创意写作」的闸门①用它 —— 那边落库时机必须由编排器统一掌握
   * （用户在闸门处放弃时，绝不能已经写了一半进库）。
   */
  onConfirm?: (picked: DraftRow[]) => void | Promise<void>
  /** 写入按钮文案（配合 onConfirm 用，如「确认设定，继续生成大纲」） */
  confirmText?: string
}

const STATUS_TAG: Record<DraftRow['status'], { text: string; cls: string }> = {
  new: { text: '新建', cls: 'border-success/30 bg-success/15 text-success' },
  duplicate: { text: '疑似已有', cls: 'border-ink-600 bg-ink-700/60 text-ink-300' },
  conflict: { text: '冲突', cls: 'border-amber/30 bg-amber/15 text-amber' },
}

function confCls(c: number): string {
  return c >= 0.8 ? 'text-success' : c >= DRAFT_PICK_THRESHOLD ? 'text-ink-300' : 'text-amber'
}

const EDIT_INPUT = 'w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-11 text-ink-100 outline-none hover:border-ink-700 focus:border-amber/50 focus:bg-ink-900'

export default function DraftReviewPanel({
  bundle, conflict = 'keep-existing', onCommitted, onConfirm, confirmText,
}: Props) {
  const [rows, setRows] = useState<DraftRow[]>(bundle.rows)
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(bundle.rows.filter(defaultPicked).map(r => r.key)),
  )
  // 分组折叠状态跨会话记忆（见 lib/uiPrefs）：拆书与创意写作共用本组件，
  // 按目标表 id 记 —— 「我每次都想先看角色那组」这类习惯不该每次都重新点一遍。
  const [collapsed, setCollapsed] = usePersistedSet('draft-review-collapsed')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // bundle 换了（重跑拆书）→ 重置编辑态与勾选态
  useEffect(() => {
    setRows(bundle.rows)
    setPicked(new Set(bundle.rows.filter(defaultPicked).map(r => r.key)))
    setExpanded(null)
  }, [bundle])

  const stat = useMemo(() => {
    const s = { new: 0, duplicate: 0, conflict: 0 }
    for (const r of rows) s[r.status]++
    return s
  }, [rows])

  const togglePick = (key: string) => {
    setPicked(p => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n })
  }
  const toggleGroup = (tabId: string) => {
    setCollapsed(c => { const n = new Set(c); if (n.has(tabId)) n.delete(tabId); else n.add(tabId); return n })
  }
  const pickGroup = (rowsOfGroup: DraftRow[], on: boolean) => {
    setPicked(p => {
      const n = new Set(p)
      for (const r of rowsOfGroup) { if (on) n.add(r.key); else n.delete(r.key) }
      return n
    })
  }
  /** 改字段；若改的正是主名键，同步 row.name（否则落库写的还是旧名） */
  const editField = (rowKey: string, fieldKey: string, value: string) => {
    setRows(rs => rs.map(r => {
      if (r.key !== rowKey) return r
      const fields = r.fields.map(f => (f.key === fieldKey ? { ...f, value } : f))
      return { ...r, fields, name: fieldKey === r.nameKey ? value : r.name }
    }))
  }

  // 「全选新建」用 pickableAsNew：它会排除「疑似同一对象的另一种写法」，
  // 否则作者一点全选就把刚标好的去重提示撤销了（见该函数的注释）
  const pickNew = () => setPicked(new Set(rows.filter(pickableAsNew).map(r => r.key)))
  const pickHigh = () => setPicked(new Set(rows.filter(defaultPicked).map(r => r.key)))
  const clearPick = () => setPicked(new Set())

  const doCommit = async () => {
    const chosen = rows.filter(r => picked.has(r.key))
    if (!chosen.length) { showToast('请先勾选要写入的条目', 'info'); return }
    // 调用方接管落库（创意写作的闸门①）：这里不 commit、也不弹确认 —— 由调用方的流程决定落库时机
    if (onConfirm) {
      setBusy(true)
      try { await onConfirm(chosen) } catch { /* 调用方自行提示错误 */ } finally { setBusy(false) }
      return
    }
    setBusy(true)
    try {
      const pv = await previewCommit(chosen, conflict)
      const policyNote = conflict === 'keep-existing'
        ? '已有条目不会被修改（当前策略：保留已有）。'
        : conflict === 'fill-empty'
          ? '已有条目只补空字段，非空字段一律不动。'
          : '⚠️ 当前策略会用新值覆盖已有条目的字段。'
      const okGo = await confirmDialog({
        title: '写入项目设定',
        message: [
          `将处理 ${chosen.length} 条：新建 ${pv.create} 条，更新 ${pv.update} 条，跳过 ${pv.skip} 条（已存在同名）。`,
          policyNote,
        ].join('\n'),
        confirmText: '确认写入',
      })
      if (!okGo) return
      const out = await commitDraftRows(chosen, { conflict })
      const parts = [`新建 ${out.created} 条`]
      if (out.updated) parts.push(`更新 ${out.updated} 条`)
      if (out.failed.length) parts.push(`失败 ${out.failed.length} 条（${out.failed.slice(0, 3).join('、')}${out.failed.length > 3 ? '…' : ''}）`)
      showToast(`已写入：${parts.join('、')}`, out.failed.length ? 'error' : 'success')
      onCommitted?.(out)
    } catch (e) {
      showToast('写入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-800/40 p-4 text-12 text-ink-400">
        没有可审阅的草稿。
      </div>
    )
  }

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-13 text-ink-100">共 <b>{rows.length}</b> 条草稿</span>
        <span className="text-11 text-ink-500">
          新建 {stat.new} · 疑似已有 {stat.duplicate}{stat.conflict ? ` · 冲突 ${stat.conflict}` : ''}
        </span>
        {(bundle.stats.folded > 0 || bundle.stats.variants > 0) && (
          <span className="text-11 text-ink-500"
            title="同一实体的多种写法（如「吞天诀」与「混沌吞天诀」）已自动归并成一条；疑似同物的只标注、默认不勾，不会被删除">
            · 已归并 {bundle.stats.folded} 条同物写法
            {bundle.stats.variants > 0 ? ` · ${bundle.stats.variants} 条疑似同物（默认不勾）` : ''}
          </span>
        )}
        <div className="flex-1" />
        <Button size="xs" variant="secondary" onClick={pickNew}>全选新建</Button>
        <Button size="xs" variant="secondary" onClick={pickHigh}>仅高可信</Button>
        <Button size="xs" variant="secondary" onClick={clearPick}>全不选</Button>
      </div>

      <div className="mt-3 space-y-2">
        {bundle.groups.map(g => {
          const sel = g.rows.filter(r => picked.has(r.key)).length
          const isCollapsed = collapsed.has(g.tabId)
          return (
            <div key={g.tabId} className="rounded border border-ink-700 bg-ink-900/40">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Button variant="bare" size="xs" className="shrink-0 text-ink-400" onClick={() => toggleGroup(g.tabId)}
                  title={isCollapsed ? '展开' : '收起'}>
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </Button>
                <span className="text-12 text-ink-200">写入「{g.tabName}」</span>
                <span className="text-11 text-ink-500">{g.rows.length} 条 · 已选 {sel}</span>
                <div className="flex-1" />
                <Button size="xs" variant="secondary" onClick={() => pickGroup(g.rows, true)}>本组全选</Button>
                <Button size="xs" variant="secondary" onClick={() => pickGroup(g.rows, false)}>本组清空</Button>
              </div>

              {!isCollapsed && (
                <ul className="border-t border-ink-700/70">
                  {g.rows.map(r => {
                    const tag = STATUS_TAG[r.status]
                    const desc = r.descKey ? r.fields.find(f => f.key === r.descKey)?.value : ''
                    const open = expanded === r.key
                    return (
                      <li key={r.key} className="border-b border-ink-700/40 last:border-0">
                        <div className="flex items-start gap-2 px-2 py-1.5">
                          <Button variant="bare" size="xs" className="mt-0.5 shrink-0" onClick={() => togglePick(r.key)}
                            title={picked.has(r.key) ? '取消勾选' : '勾选'}>
                            {picked.has(r.key)
                              ? <CheckSquare size={14} className="text-amber" />
                              : <Square size={14} className="text-ink-500" />}
                          </Button>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <input value={r.name} onChange={e => editField(r.key, r.nameKey, e.target.value)}
                                className={`${EDIT_INPUT} min-w-[6rem] flex-1`} />
                              <span className={`shrink-0 rounded border px-1 py-px text-10 ${tag.cls}`}>{tag.text}</span>
                              <span className={`shrink-0 text-10 tabular-nums ${confCls(r.confidence)}`}
                                title="置信度：原文有据 +0.2，多章一致 +0.2，冲突 −0.3">
                                {r.confidence.toFixed(2)}
                              </span>
                              {r.matched && (
                                <span className="shrink-0 text-10 text-ink-500">已有「{r.matched.name}」</span>
                              )}
                              {!!r.foldedNames?.length && (
                                <span className="shrink-0 text-10 text-ink-500"
                                  title={`已把同一对象的其他写法并入本行：${r.foldedNames.join('、')}（都进了别称，未丢弃）`}>
                                  已并入 {r.foldedNames.length} 个写法
                                </span>
                              )}
                              {r.variantOf && (
                                <span className="shrink-0 text-10 text-amber"
                                  title={`疑似与「${r.variantOf}」为同一对象（名称是同一核心词的另一种写法）——默认不勾，若确为两个对象请直接勾上`}>
                                  疑似同物「{r.variantOf}」
                                </span>
                              )}
                              <Button variant="secondary" size="xs" className="shrink-0 text-10"
                                onClick={() => setExpanded(open ? null : r.key)}>
                                {open ? '收起' : '详情'}
                              </Button>
                            </div>
                            {!open && desc && <div className="mt-0.5 truncate text-11 text-ink-400">{desc}</div>}
                          </div>
                        </div>

                        {open && (
                          <div className="mx-2 mb-2 rounded border border-ink-700 bg-ink-900/60 px-2 py-1.5">
                            {r.fields.map(f => (
                              <div key={f.key} className="flex items-start gap-2 py-0.5">
                                <span className="w-20 shrink-0 pt-0.5 text-10 text-ink-500">{f.label}</span>
                                <input value={f.value} onChange={e => editField(r.key, f.key, e.target.value)}
                                  className={EDIT_INPUT} />
                              </div>
                            ))}
                            {r.quotes.length > 0 && (
                              <div className="mt-1.5 border-t border-ink-700/60 pt-1">
                                <div className="text-10 text-ink-500">原文引用</div>
                                {r.quotes.slice(0, 3).map((q, i) => (
                                  <div key={i} className="text-10 leading-relaxed text-ink-400">「{q}」</div>
                                ))}
                              </div>
                            )}
                            {r.chapters.length > 1 && (
                              <div className="mt-1 text-10 text-ink-500">出现在第 {r.chapters.join('、')} 章（已合并为一条）</div>
                            )}
                            {!!r.foldedNames?.length && (
                              <div className="mt-1 text-10 text-ink-400">
                                已并入同一对象的其他写法：{r.foldedNames.join('、')}（都写进了别称，没有丢弃任何名字）
                              </div>
                            )}
                            {r.variantOf && (
                              <div className="mt-1 text-10 leading-relaxed text-amber">
                                疑似与「{r.variantOf}」为同一对象（名称是同一核心词的另一种写法），默认不勾选 ——
                                若两者确实是不同对象，直接勾上即可。
                              </div>
                            )}
                            {r.matched && (
                              <div className="mt-1 text-10 text-amber">
                                项目里已有「{r.matched.name}」——若不是同一对象，请改名后再写入。
                              </div>
                            )}
                            {r.conflicts?.map((c, i) => (
                              // 两种冲突的**问法不同**，别共用一套话术：
                              //  · 「实体类型」冲突（同名被抽成不同类型）→ 问「是不是同一个对象，二选一」
                              //  · 字段值冲突（B2：同一字段在不同章给出互不包含的值）→ 问「哪个值对」
                              //    且**不能写「默认不勾选」** —— 字段冲突只扣置信度、未必掉到阈值以下，
                              //    写成不勾是误导（2026-09-18 实机验收时发现文案照搬了上面那套）
                              <div key={i} className="mt-1 text-10 leading-relaxed text-amber">
                                {c.field === '实体类型'
                                  ? `⚠️ ${c.field}不一致：这条按「${c.incoming}」抽出，但同名实体已按「${c.existing}」抽出过。默认不勾选 —— 请确认它们是不是同一个对象，再二选一。`
                                  : `⚠️ ${c.field}前后不一致：一处写「${c.existing}」、一处写「${c.incoming}」。本行暂取更完整的那份，写入前请确认哪个对。`}
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
        <span className="text-11 text-ink-400">
          已勾选 <b className="text-ink-200">{picked.size}</b> 条
          {conflict === 'keep-existing' && <span className="text-ink-500"> · 已有同名条目不会被改动</span>}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="primary" solid disabled={busy || picked.size === 0} onClick={doCommit}>
          {busy ? '处理中…' : `${confirmText ?? '写入项目'}（${picked.size}）`}
        </Button>
      </div>
    </section>
  )
}

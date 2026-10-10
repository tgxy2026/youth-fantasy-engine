/**
 * 人物关系 · **按人物分组的文件夹视图**（从 `TableSheet.tsx` 拆出，2026-09-19）。
 *
 * 与表格视图并列的一个渲染分支：`tab.id === 'relations'` 时走这里 ——
 * 把「人物A / 人物B」两列折成「以某人为文件夹」的卡片，方便按人查阅自己的关系网。
 *
 * 状态一律来自 `model`（同名解构，JSX 保持原样）；本组件不持有任何状态。
 */
import { useMemo } from 'react'
import type { VisCtx } from '@/lib/schema'
import { useFieldAliases } from '@/lib/fieldAlias'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import type { TabDef } from '@/lib/types'
import { SABC_LABELS } from '@/lib/schema'
import { Button } from '@/components/Button'
import CustomSelect from '@/components/CustomSelect'
import CharacterSelect from '@/components/CharacterSelect'
import TableRefSelect from '@/components/TableRefSelect'
import { ChevronDown, ChevronRight, Sparkles, Trash2, Users } from 'lucide-react'
import { LONG_REL_COLS, rowBadgeClass } from '@/components/tableSheetShared'
import type { TableSheetModel } from '@/components/useTableSheetModel'

export default function TableRelationGroups({ tab, model, ctx }: {
  tab: TabDef
  model: TableSheetModel
  /** 可见性上下文：透传给角色选择 / 跨表引用下拉 */
  ctx: VisCtx
}) {
  const {
    rows,
    relationGroups,
    relGroupOpen,
    setRelGroupOpen,
    relRowOpen,
    setRelRowOpen,
    cellVal,
    setCellDraft,
    removeRow,
    isRowDirty,
    aiCap,
    aiReady,
    setFillRow,
  } = model

  /** 字段显示名（2.7.3）：与表格视图共用同一份别名映射 */
  const aliasCols = useMemo(() => (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name), [tab])
  const { labels: aliasLabels } = useFieldAliases(tab.id, aliasCols)

  return (
    <div className="space-y-2.5">
      {rows.length === 0 && (
        <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-16 text-center text-ink-500">
          <div className="flex flex-col items-center gap-2">
            <Users size={20} className="text-ink-600" />
            <span>还没有人物关系，点击右上角「新增一行」开始</span>
          </div>
        </div>
      )}
      {relationGroups.map(g => {
        const gOpen = relGroupOpen.has(g.key)
        return (
          <div key={g.key} className={`rounded-xl border overflow-hidden ${g.unnamed ? 'border-dashed border-ink-600 bg-ink-850/50' : 'border-ink-700 bg-ink-850'}`}>
            <Button variant="bare"
              onClick={() => {
                const next = new Set(relGroupOpen)
                if (next.has(g.key)) next.delete(g.key); else next.add(g.key)
                setRelGroupOpen(next)
              }}
              className="w-full !flex items-center gap-2 px-3.5 py-2.5 hover:bg-ink-800/60 transition-colors text-left !justify-start"
            >
              <span className="text-ink-500">{gOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
              <Users size={12} className="text-amber/80 shrink-0" />
              <span className="text-13 font-semibold text-ink-100 truncate">{g.name}</span>
              <span className="text-10 text-ink-500 shrink-0">{g.rows.length} 条关系</span>
            </Button>
            {gOpen && (
              <div className="border-t border-ink-700/60 px-3 py-2.5 space-y-2">
                {g.rows.map(row => {
                  const a = (row.data['人物A'] ?? '').trim()
                  const other = a === g.name ? (row.data['人物B'] ?? '').trim() : a
                  const type = row.data['关系类型'] ?? ''
                  const status = row.data['关系现状'] ?? ''
                  const rOpen = relRowOpen.has(row.id)
                  const bg = rowBadgeClass(tab.id, row.data)
                  const dirty = isRowDirty(row)
                  return (
                    <div key={row.id} className={`group rounded-lg border ${bg ?? ''} ${dirty ? 'border-amber/40' : 'border-ink-700/70'} hover:border-ink-600 transition-colors`}>
                      <div className="flex items-center gap-2 px-3 py-2">
                        <Button variant="bare"
                          onClick={() => {
                            const next = new Set(relRowOpen)
                            if (next.has(row.id)) next.delete(row.id); else next.add(row.id)
                            setRelRowOpen(next)
                          }}
                          className="flex-1 !flex items-center gap-2 min-w-0 text-left !justify-start"
                        >
                          <span className="text-ink-500 shrink-0">{rOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                          <span className="text-12 text-ink-100 font-medium truncate">↔ {other || '（未填写对方人物）'}</span>
                          {type && (
                            <span className="px-1.5 py-px text-10 rounded bg-ink-800 text-ink-300 border border-ink-700 shrink-0">{type}</span>
                          )}
                          {!rOpen && status && <span className="text-11 text-ink-500 truncate">{status}</span>}
                          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" title={UNSAVED_CHANGES_HINT} />}
                        </Button>
                        <Button variant="icon-danger" onClick={() => removeRow(row.id)} className="opacity-40 group-hover:opacity-100 transition-all p-1 shrink-0" title="删除此条关系">
                          <Trash2 size={12} />
                        </Button>
                        {aiCap !== 'none' && (
                          <Button variant="bare" iconOnly size="xs"
                            onClick={() => setFillRow(row)}
                            disabled={!aiReady}
                            className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="AI 补全本行空白：只填这一行未填写的字段，不影响其他行 / 表"
                          >
                            <Sparkles size={12} />
                          </Button>
                        )}
                      </div>
                      {rOpen && (
                            <div className="px-3 pb-3 pt-1 border-t border-ink-700/50 mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2.5">
                              {tab.columns!.filter(col => !col.hidden).map(col => {
                            const val = cellVal(row, col.name)
                            const long = LONG_REL_COLS.has(col.name)
                            return (
                              <div key={col.name} className={long ? 'md:col-span-2' : ''}>
                                <div className="text-10 text-ink-500 mb-1" title={aliasLabels[col.name] === col.name ? undefined : `${col.name}（原字段名）`}>{aliasLabels[col.name]}</div>
                                {col.type === 'tableRef' ? (
                                  /* 跨表引用：从来源设定表取值，禁止手动输入 */
                                  <TableRefSelect
                                    refTabId={col.refTab!}
                                    refCol={col.refCol!}
                                    value={val}
                                    onChange={v => setCellDraft(row.id, col.name, v)}
                                    placeholder={col.name}
                                  />
                                ) : col.type === 'select' && col.options ? (
                                  <CustomSelect
                                    tabId={tab.id}
                                    colName={col.name}
                                    options={col.options}
                                    value={val}
                                    onChange={v => setCellDraft(row.id, col.name, v)}
                                    labelMap={col.name === '保密等级' ? SABC_LABELS : undefined}
                                    fixedOptions={col.fixedOptions}
                                  />
                                ) : col.type === 'character' ? (
                                  /* 人物A / 人物B：从已创建角色卡选择，禁止手动输入 */
                                  <CharacterSelect
                                    value={val}
                                    onChange={v => setCellDraft(row.id, col.name, v)}
                                    placeholder={col.name}
                                    ctx={ctx}
                                  />
                                ) : (
                                  <input
                                    type={col.type === 'number' ? 'number' : 'text'}
                                    value={val}
                                    onChange={e => setCellDraft(row.id, col.name, e.target.value)}
                                    placeholder={col.name}
                                    className="!py-1 text-12 w-full"
                                  />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

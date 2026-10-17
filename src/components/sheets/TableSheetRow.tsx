/**
 * 表格**单行**（从 `TableSheet.tsx` 拆出，2026-09-19）。
 *
 * 一行 225 行 JSX：序号格 + 操作列（打开正文 / 删除 / AI 补全本行 / 新增子条目 / 树形折叠）+
 * 按列类型分派单元格（tableRef / select / character / calendar / date / 编号联动 / 普通文本）。
 * 塞在主文件里时，表格骨架与单元格细节互相淹没。
 *
 * 状态一律来自 `model`（同名解构，JSX 保持原样）；本组件不持有任何状态。
 * ⚠️ 唯一改动：原来的 `i`（map 下标）改名为 `index` —— 单字符参数名做 props 太容易读错。
 */
import { ChevronDown, ChevronRight, GitBranch, Link2, PenLine, Search, Sparkles, Trash2 } from 'lucide-react'
import type { TabDef, TableRow } from '@/lib/types'
import { SABC_LABELS, isVolumeLedgerTab } from '@/lib/schema'
import type { VisCtx } from '@/lib/schema'
import { Button } from '@/components/common/Button'
import CalendarPicker from '@/components/common/CalendarPicker'
import CustomSelect from '@/components/common/CustomSelect'
import CharacterSelect from '@/components/world/CharacterSelect'
import TableRefSelect from '@/components/sheets/TableRefSelect'
import CalendarSelect from '@/components/common/CalendarSelect'
import NumberField from '@/components/common/NumberField'
import StoryDateInput from '@/components/common/StoryDateInput'
import { CellTextarea, rowBadgeClass } from '@/components/sheets/tableSheetShared'
import { ROW_ACTION_COL_W, type TableSheetModel } from '@/components/sheets/useTableSheetModel'
import { readAliases } from '@/lib/settings/aliases'

/**
 * 「资料提及」入口适用的资料表（3.1 P1）。
 *
 * 🔴 判据＝该表的 displayCol 是不是**能被正文自然引用的实体名称**。
 *    日志流水型表（progress 写作进度 / feedback 读者反馈 / changelog 设定变更 /
 *    ideas 灵感素材 / secrets 知情权限）与内容描述型表（foreshadow 伏笔内容 /
 *    hookpoints 爽点内容 / timeline·chapter-master 章节标题）的 displayCol 是日期、
 *    整句话或章节标题 —— 拿它检索正文只会空结果或误报，属幽灵入口，故不渲染。
 * 新增资料表时记得登记进来（漏登记只是少一个入口，不会出错）。
 */
const MENTION_TABS = new Set<string>([
  'relations', 'nations', 'faction-rels', 'geography', 'races', 'items', 'history', 'terms', 'subplots',
])

export default function TableSheetRow({ tab, model, entry, index, onNavigate, onOpenMentions, ctx }: {
  tab: TabDef
  model: TableSheetModel
  /** 一行 + 它在树形层级里的位置（父组件负责排列） */
  entry: { row: TableRow; depth: number; hasChildren: boolean }
  index: number
  onNavigate?: (id: string, chapterId?: string) => void
  /** 打开「资料提及」面板（3.1 P1）：主名称 + readAliases 别称列表 */
  onOpenMentions?: (name: string, aliases: string[]) => void
  ctx: VisCtx
}) {
  const {
    rowRefs,
    hlRowId,
    codeCol,
    isMaster,
    aiCap,
    aiReady,
    widthOf,
    setCellDraft,
    removeRow,
    cellVal,
    parentCol,
    toggleCollapse,
    tree,
    addChild,
    isRowDirty,
    isInvalidCode,
    calendars,
    collapsed,
    setFillRow,
    calendarRule,
  } = model

    const row = entry.row
    const depth = entry.depth
    const hasChildren = entry.hasChildren
    // 合并 draft 后的最终数据，用于行底色
    const bg = rowBadgeClass(tab.id, row.data)
    const rowDirty = isRowDirty(row)
    // 章节总表 / 各卷台账联动行：id 形如 ch-<chapterId>，提供直达写作入口
    const chapterLink = (tab.id === 'chapter-master' || isVolumeLedgerTab(tab.id)) && row.id.startsWith('ch-')
      ? row.id.slice(3) : null
    // 资料提及（3.1 P1）：只对「displayCol 是实体名称」的资料表渲染入口。
    // 🔴 白名单理由：日志流水型表（写作进度 / 读者反馈 / 设定变更 / 灵感素材 / 知情权限）
    //    与内容描述型表（伏笔追踪 / 爽点节奏 / 时间脉络 / 章节总表）的 displayCol 是日期、
    //    整句话或章节标题，拿它去检索正文只会得到空结果或误报 —— 那是个幽灵入口。
    // relations 行只对「人物A」生效（一行两个资料，避免按钮语义分裂，2026-10-15 主人拍板）。
    // 卷台账（isMaster）是章节联动行、无资料语义，不渲染。
    const mentionName = !isMaster && MENTION_TABS.has(tab.id)
      ? (tab.id === 'relations' ? String(row.data['人物A'] ?? '') : (tab.displayCol ? cellVal(row, tab.displayCol) : '')).trim()
      : ''
    return (
      <tr
        key={row.id}
        ref={el => { rowRefs.current[row.id] = el }}
        className={`group hover:bg-ink-800/60 transition-colors ${bg ?? ''} ${rowDirty ? 'bg-amber/5' : ''} ${hlRowId === row.id ? 'ring-2 ring-success/80 bg-success/10' : ''}`}
      >
        <td className="px-2 py-1 text-center text-ink-500 text-10 relative">
          {index + 1}
          {rowDirty && <span className="absolute left-0 top-1 w-0.5 h-5 bg-amber rounded-r" />}
        </td>
        {/* 🔴 行首操作列 2×2（OPT-008，主人 2026-10-17）：原为 w-7(28px) 窄列 flex-col 竖排，
            4 个图标钮把每一行撑高约 100px（「页面变得很长、很难看」）。改为可换行居中：
            列宽走 ROW_ACTION_COL_W(64px，与表头 th / totalWidth 同源)，恰好容两枚 24px 钮
            ⇒ 4 钮即 2×2；3 钮 2+1、2 钮 1 行、1 钮单枚，都由 flex-wrap + justify-center
            自动收窄居中，不会为凑 2×2 把简单表撑宽或留下空位。 */}
        <td className="px-1 py-1 align-middle" style={{ width: ROW_ACTION_COL_W }}>
          <div className="flex flex-wrap items-center justify-center content-center gap-0.5 h-full">
          {chapterLink && (
            <Button variant="bare" iconOnly size="xs"
              onClick={() => onNavigate?.('editor', chapterLink)}
              className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
              title="打开本章正文编辑"
            >
              <PenLine size={12} />
            </Button>
          )}
          {mentionName && (
            <Button variant="bare" iconOnly size="xs"
              onClick={() => onOpenMentions?.(mentionName, readAliases(tab.id, row.data))}
              className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
              title={`查看「${mentionName}」在正文中的提及`}
            >
              <Search size={12} />
            </Button>
          )}
          {!isMaster && (
          <Button variant="icon-danger" size="xs" onClick={() => removeRow(row.id)} className="opacity-40 group-hover:opacity-100 transition-all" title="删除此行">
            <Trash2 size={12} />
          </Button>
          )}
          {aiCap !== 'none' && !isMaster && (
            <Button variant="bare" iconOnly size="xs"
              onClick={() => setFillRow(row)}
              disabled={!aiReady}
              className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title="AI 补全本行空白：只填这一行未填写的字段，不影响其他行 / 表"
            >
              <Sparkles size={12} />
            </Button>
          )}
          {parentCol && tree && (
            <Button variant="bare" iconOnly size="xs"
              onClick={() => addChild(tree.nameOf(row))}
              className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
              title={`在「${tree.nameOf(row) || '该项'}」下新增子条目`}
            >
              <GitBranch size={12} />
            </Button>
          )}
          </div>
        </td>
        {tab.columns!.filter(col => !col.hidden).map(col => {
          const val = cellVal(row, col.name)
          if (isMaster) {
            const fh = (tab.id !== 'foreshadow' && tab.id !== 'history' && val.match(/[FH]\d+/g)) || null
            return (
              <td key={col.name} className="px-1 py-1 align-middle" style={{ width: widthOf(col.name) }}>
                <div className="px-2 py-1 text-12 text-ink-200 whitespace-pre-wrap break-words leading-relaxed">
                  {val ? val : <span className="text-ink-600">—</span>}
                </div>
                {fh && (
                  <div className="flex flex-wrap gap-1 mt-0.5 px-2">
                    {fh.map(code => (
                      <Button variant="bare"
                        key={code}
                        onClick={() => onNavigate?.(code.startsWith('F') ? 'foreshadow' : 'history')}
                        className="inline-flex items-center gap-0.5 px-1.5 py-px text-11 rounded bg-amber/10 text-amber/90 border border-amber/25 hover:bg-amber/25 transition-colors"
                        title={`查看 ${code}（跳转${code.startsWith('F') ? '伏笔追踪' : '历史事件'}）`}
                      >
                        <Link2 size={9} />{code}
                      </Button>
                    ))}
                  </div>
                )}
              </td>
            )
          }
          return (
            <td key={col.name} className="px-1 py-1 align-middle" style={{ width: widthOf(col.name) }}>
              {col.type === 'date' ? (
                /* 严格"某年某月某日"日期输入（月/日候选按项目历法规则生成） */
                <StoryDateInput
                  value={val}
                  rule={calendarRule}
                  onChange={v => setCellDraft(row.id, col.name, v)}
                />
              ) : col.type === 'calendar' ? (
                /* 真实日历日期：弹出月历选择 */
                <CalendarPicker
                  value={val}
                  onChange={v => setCellDraft(row.id, col.name, v)}
                />
              ) : col.type === 'character' ? (
                /* 角色卡单选：从已创建角色中选，禁止手动输入 */
                <CharacterSelect
                  value={val}
                  onChange={v => setCellDraft(row.id, col.name, v)}
                  placeholder={col.name}
                  ctx={ctx}
                />
              ) : col.type === 'characters' ? (
                /* 角色卡多选：从已创建角色中选，禁止手动输入 */
                <CharacterSelect
                  multi
                  value={val}
                  onChange={v => setCellDraft(row.id, col.name, v)}
                  placeholder={col.name}
                  ctx={ctx}
                />
              ) : col.calendar ? (
                /* 历法列：只从项目级历法配置里选（新增/改名/删除都在页头「历法规则」弹窗，见 CalendarSelect 头注） */
                <CalendarSelect
                  value={val}
                  onChange={v => setCellDraft(row.id, col.name, v)}
                  calendars={calendars}
                />
              ) : col.type === 'tableRef' ? (
                /* 跨表引用：从来源设定表取值，禁止手动输入；自引用父级列排除自身+子孙防成环 */
                <TableRefSelect
                  refTabId={col.refTab!}
                  refCol={col.refCol!}
                  value={val}
                  onChange={v => setCellDraft(row.id, col.name, v)}
                  placeholder={col.name}
                  excludeNames={
                    parentCol && col.name === parentCol && tree
                      ? (() => {
                          const s = new Set<string>()
                          const n = tree.nameOf(row)
                          if (n) s.add(n)
                          tree.descendantNames(row.id, s)
                          return [...s]
                        })()
                      : undefined
                  }
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
              ) : col.type === 'number' ? (
                /* U-1 · 2.6.0：数值格改走 NumberField（提交时钳制/回车失焦提交），替换手写 type=number。
                   allowEmpty 与原手写 input 的「可清空」对齐（审计 P2：不传则清空不可达）；
                   precision=2：数值格允许小数（原 input 不 round） */
                <NumberField
                  value={Number.isFinite(Number(val)) && val !== '' ? Number(val) : undefined}
                  onChange={v => setCellDraft(row.id, col.name, v === undefined ? '' : String(v))}
                  allowEmpty
                  precision={2}
                  className="!py-1 text-12 w-full bg-ink-900 border border-ink-700 rounded px-2 outline-none focus:border-amber/50"
                />
              ) : (
                col.name === tab.displayCol && parentCol ? (
                  <div className="flex items-start gap-1" style={{ paddingLeft: depth * 14 }}>
                    {hasChildren ? (
                      <Button variant="icon-amber" type="button" onClick={() => toggleCollapse(row.id)} className="mt-1 shrink-0" title={collapsed.has(row.id) ? '展开子条目' : '折叠子条目'}>
                        {collapsed.has(row.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </Button>
                    ) : (
                      <span className="mt-1 w-11px shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <CellTextarea
                        value={val}
                        onChange={v => setCellDraft(row.id, col.name, v)}
                        invalid={col.name === codeCol && isInvalidCode(row)}
                        title={col.name === codeCol && isInvalidCode(row) ? '编号与同表其它行重复，保存前请修改' : undefined}
                      />
                      {/* 编号联动：F01 → 伏笔追踪，H01 → 历史事件 */}
                      {tab.id !== 'foreshadow' && tab.id !== 'history' && val.match(/[FH]\d+/) && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {val.match(/[FH]\d+/g)!.map(code => (
                            <Button variant="bare"
                              key={code}
                              onClick={() => onNavigate?.(code.startsWith('F') ? 'foreshadow' : 'history')}
                              className="inline-flex items-center gap-0.5 px-1.5 py-px text-11 rounded bg-amber/10 text-amber/90 border border-amber/25 hover:bg-amber/25 transition-colors"
                              title={`查看 ${code}（跳转${code.startsWith('F') ? '伏笔追踪' : '历史事件'}）`}
                            >
                              <Link2 size={9} />{code}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                <>
                  <CellTextarea
                    value={val}
                    onChange={v => setCellDraft(row.id, col.name, v)}
                    invalid={col.name === codeCol && isInvalidCode(row)}
                    title={col.name === codeCol && isInvalidCode(row) ? '编号与同表其它行重复，保存前请修改' : undefined}
                  />
                  {/* 编号联动：F01 → 伏笔追踪，H01 → 历史事件 */}
                  {tab.id !== 'foreshadow' && tab.id !== 'history' && val.match(/[FH]\d+/) && (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {val.match(/[FH]\d+/g)!.map(code => (
                        <Button variant="bare"
                          key={code}
                          onClick={() => onNavigate?.(code.startsWith('F') ? 'foreshadow' : 'history')}
                          className="inline-flex items-center gap-0.5 px-1.5 py-px text-11 rounded bg-amber/10 text-amber/90 border border-amber/25 hover:bg-amber/25 transition-colors"
                          title={`查看 ${code}（跳转${code.startsWith('F') ? '伏笔追踪' : '历史事件'}）`}
                        >
                          <Link2 size={9} />{code}
                        </Button>
                      ))}
                    </div>
                  )}
                </>
                )
              )}
            </td>
          )
        })}
      </tr>
    )
}

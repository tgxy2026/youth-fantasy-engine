/**
 * 表格页签（世界构建 / 创作管理 / 运营维护各表的通用编辑器）。
 *
 * 本文件**只负责长相**：状态、effect、派生值与动作全部在 `useTableSheetModel()`（2026-09-19 拆出）。
 * 下面那行同名解构是刻意的 —— 让 JSX 保持原样、零改动，把「搬家」与「改造」分开做。
 */
import type { TabDef } from '../lib/types'
import { Z } from '../lib/zLayer'
import { deleteTableRow } from '../lib/db'
import { SABC_LABELS, type VisCtx } from '../lib/schema'
import { Plus, Trash2, Info, Save, Check, Calendar, Table2, Hash, AlertTriangle, Network, Sparkles, GitBranch } from 'lucide-react'
import HistoryTimeline from './HistoryTimeline'
import StoryTimeline from './StoryTimeline'
import StorylineView from './StorylineView'
import RelationGraph from './RelationGraph'
import FactionGraph from './FactionGraph'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import AITemplateFill from './AITemplateFill'
import AIOrganize from './AIOrganize'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import FeedbackAIPanel from './FeedbackAIPanel'
import TermDedupPanel from './TermDedupPanel'
import { confirmDialog } from './dialogs'
import { Button } from './Button'
import { SaveFab } from './SaveFab'
import { LoadingState } from './LoadingState'
import TableSheetRow from './TableSheetRow'
import TableRelationGroups from './TableRelationGroups'
import { useTableSheetModel } from './useTableSheetModel'

interface Props {
  tab: TabDef
  onNavigate?: (id: string, chapterId?: string) => void
  /** 可见性上下文：透传给角色选择下拉 / AI 整理，控制 NPC 角色卡与跨表引用范围 */
  ctx: VisCtx
  /** 数据体检 / 跨组件跳转带下来的目标行 id：挂载后滚动并高亮该行 */
  focusRowId?: string | null
  /** 高亮消费完毕后回调，用于清除上层 focusRowId 以便重复跳转 */
  onFocusConsumed?: () => void
}


export default function TableSheet({ tab, onNavigate, ctx = { type: 'full', features: [] }, focusRowId, onFocusConsumed }: Props) {
  const model = useTableSheetModel({ tab, focusRowId, onFocusConsumed })

  const {
    // 落库与装载
    rows, setRows, setDrafts, saving, saved, dirtyKeys, saveAll, loaded,
    // 行编辑
    addRow, 
    // 排序与筛选
    sortedRows, filteredRows, colFilters, setColFilters, filterOptionsOf,
    // 列宽与拖拽
    widthOf, onResizeStart, totalWidth,
    // 树形层级
    bodyRows, 
    // 编号
    retireCodes, codeError,
    // 视图与高亮
    viewMode, setViewMode, isTimelineCapable, isGraphCapable, isStorylineCapable, isMaster, aiCap, aiReady, 
    // 人物关系分组
    relationGroups, 
    // 历法
    calendars, 
    // AI 入口
    tableFields, showFill, setShowFill, showOrganize, setShowOrganize, fillRow, setFillRow, showFeedbackAI, setShowFeedbackAI, showDedupAI, setShowDedupAI, handleFill, handleFillRow, handleOrganize,
  } = model

  if (!loaded) return <LoadingState />

  return (
    <div className="page-enter">
      {/* 头部 */}
      <header className="mb-5 flex items-start justify-between gap-4 sticky top-0 bg-ink-900/95 backdrop-blur py-3" style={{ zIndex: Z.pageBase }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-ink-50">{tab.name}</h1>
            <HelpPopover title={`${tab.name} · 怎么用`} width="23rem" size={13}>{`这是「${tab.name}」数据表，常见操作：

• 右上「新增一行」添加记录；表格内直接点单元格编辑，改完点「保存」（或 Ctrl+S）。
• 列宽可拖拽：拖动列标题右缘的分隔条调整宽度，只改当前列、不挤压其他列；整体超出页面时表格底部出现横向滑条。
• 表头筛选（v1.9.1）：每列标题下方都有筛选框——文本列输入关键字按「包含」匹配；下拉列点开选值按「精确」匹配，候选值与行内下拉完全一致（含你自己新增的自定义值，以及被隐藏 / 改名后的内置项），在行内改动选项后表头会立即同步。
• 下拉类型的列（如状态、关系类型）点击即弹出选项，可自定义 / 重命名。
• 部分列是专用控件：真实日期列（如发布日期、写作进度日期）点开弹出月历选择；人物关系的「人物A / 人物B」从已创建角色卡中选择、不可手填。
• 带「编号 / 章节号」的表按编号自动排序，空白沉底（章节总表例外：按创建时间倒序，最新写的章节在最上面）；编号不可重复、删除后不复用。
• 单元格里出现 F01 / H01 这类编号，会自动生成跳转按钮，直达伏笔表 / 历史事件。
• 历史事件、时间脉络页签可在右上「表格 ⇄ 时间轴」切换视图；时间轴按「历法」列的数值判定跨历法先后顺序，可在表格的「历法」列填写（项目级多历法配置，支持新增 / 改名 / 改数值）。
• 人物关系按「人物A / 人物B」自动归入双方文件夹，便于按人查阅；右上「表格 ⇄ 关系图」可切换关系图。
• 关系图交互（v1.6）：「拖动节点」微调布局、「拖拽空白处平移」画布、「滚轮缩放」（0.4x–3x）、「点击节点收起/展开」其关系边；工具栏有放大/缩小/重置视图；底部图例按关系类型着色——自定义的关系类型也有专属颜色。
• 伏笔追踪可切到「剧情线」视图（v1.6.1）：自动聚合伏笔（埋设/回收）、爽点、时间脉络事件，按章节串成一条叙事主线；顶部统计悬空伏笔与「已到点未回收」的警示。
• 带「上级 / 层级归属」列的表（国家势力、地理风物、种族生物、物品资源、历史事件、名词术语等）支持「树形层级」：按隶属关系折叠 / 展开，行首的树形图标按钮可在某条下新增子条目（编号形如「父编号-001」，父级顺序号不变），父级下拉自动排除自身与子孙防成环。
• 行首三个小按钮：删除此行、AI 补全本行空白（只填当前行未填字段，不影响其他行 / 表）、新增子条目；章节总表行首另有「打开正文」按钮。
• 批量：右上角的 AI 按钮（不同表显示为「AI 整理」或「AI 补全」，部分表没有这个按钮）从章节正文 / 已有设定批量整理出尚未登记的条目并落盘（不重复生成）；人物关系 / 历史事件支持「清空全部」批量删除。`}
            <AIDataSourceNote feature="organize-rows" />
          </HelpPopover>
          </div>
          <p className="mt-1.5 text-13 text-ink-300 leading-relaxed max-w-3xl">{tab.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-11 transition-opacity ${saved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>
            <Check size={11} className="inline -mt-0.5 mr-0.5" />已保存
          </span>
          <span className="text-10 text-ink-500">
            {tab.id === 'relations'
              ? `共 ${rows.length} 条关系 · ${relationGroups.filter(g => !g.unnamed).length} 位人物`
              : tab.newestFirst
                ? `共 ${filteredRows.length} 行 · 按创建时间倒序`
                : tab.columns?.some(c => c.name === '编号' || c.name === '章节号')
                  ? `共 ${filteredRows.length} 行 · 按编号排序`
                  : `共 ${filteredRows.length} 行 · 按编辑时间排序`}
          </span>
          {!isMaster && (
          <Button variant="bare"
            onClick={saveAll}
            disabled={dirtyKeys.length === 0 || saving}
            className={`flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium border transition-colors
              ${dirtyKeys.length > 0
                ? 'bg-amber/15 text-amber border-amber/40 hover:bg-amber/25'
                : 'bg-ink-800 text-ink-500 border-ink-700 cursor-not-allowed'}`}
            title={dirtyKeys.length > 0 ? '保存全部（Ctrl+S）' : '无未保存的改动'}
          >
            <Save size={13} /> {saving ? '保存中…' : '保存'}
          </Button>
          )}
          {/* 多行批量删除按钮（人物关系 / 历史事件支持） */}
          {['relations', 'history'].includes(tab.id) && rows.length > 0 && (
            <Button variant="danger" // 破坏性操作用 danger 令牌（原为 bare + 手写红样式，与 danger 输出等价）
              onClick={async () => {
                if (!await confirmDialog({ title: `清空「${tab.name}」`, message: `确定清空「${tab.name}」中所有 ${rows.length} 条记录？`, danger: true })) return
                retireCodes(rows).then(() => {  // 全部编号登记进退役池，防止复用
                  rows.forEach(row => { void deleteTableRow(row.id) })
                })
                setRows([])
                setDrafts({})
              }}
              className="font-medium"
            >
              <Trash2 size={14} /> 清空全部
            </Button>
          )}
          {isTimelineCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('timeline')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'timeline' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Calendar size={11} /> 时间轴
              </Button>
            </div>
          )}
          {isGraphCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'graph' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Network size={11} /> 关系图
              </Button>
            </div>
          )}
          {isStorylineCapable && (
            <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5">
              <Button variant="bare"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'table' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <Table2 size={11} /> 表格
              </Button>
              <Button variant="bare"
                onClick={() => setViewMode('storyline')}
                className={`flex items-center gap-1 px-3 h-8 rounded text-12 transition-colors
                  ${viewMode === 'storyline' ? 'bg-amber/15 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
              >
                <GitBranch size={11} /> 剧情线
              </Button>
            </div>
          )}
          {!isMaster && (
          <Button onClick={addRow} variant="primary" size="md" className="flex items-center text-13 shrink-0">
            <Plus size={14} /> {tab.id === 'relations' ? '新增一条关系' : '新增一行'}
          </Button>
          )}
          {aiCap !== 'none' && !isMaster && (
            <Button variant="secondary" onClick={() => (aiCap === 'organize' ? setShowOrganize(true) : setShowFill(true))} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={ !aiReady ? AI_DISABLED_HINT : aiCap === 'organize' ? '让 AI 从章节正文 / 已有设定中整理出尚未登记的条目（不会重复生成）' : '新建一行，并提供粗略设定由 AI 补全（不影响已有行 / 其他表）' }>
              <Sparkles size={14} /> {aiCap === 'organize' ? 'AI 整理' : 'AI 补全'}
            </Button>
          )}
          {/* 读者反馈：AI 分析（运营维护组，不接补全/整理，单独开分析入口） */}
          {tab.id === 'feedback' && (
            <Button variant="secondary" onClick={() => setShowFeedbackAI(true)} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '用 AI 分析读者反馈数据：流失归因 + 应对建议'}>
              <Sparkles size={14} /> AI 分析反馈
            </Button>
          )}
          {/* 名词术语：AI 查重（在「AI 补全」之外，额外提供同义/重复归一入口） */}
          {tab.id === 'terms' && (
            <Button variant="secondary" onClick={() => setShowDedupAI(true)} disabled={!aiReady} className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-13 font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ink-800" title={!aiReady ? AI_DISABLED_HINT : '用 AI 查找同义/重复的术语，建议合并归一'}>
              <Sparkles size={14} /> AI 查重
            </Button>
          )}
        </div>
      </header>

      {/* 编号规则说明（有编号列的表格展示，防止编号混乱无法识别） */}
      {tab.codeRule && (
        <div className="mb-4 rounded-lg border border-amber/20 bg-amber/5 px-3.5 py-2.5 flex items-start gap-2">
          <Hash size={12} className="mt-0.5 shrink-0 text-amber/80" />
          <span className="text-11 text-amber/80 leading-relaxed">{tab.codeRule}</span>
        </div>
      )}

      {/* 编号校验错误：存在重复/退役编号时阻止保存并提示修改 */}
      {codeError && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 flex items-start gap-2 animate-pulse">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red-400" />
          <span className="text-11 text-red-300 leading-relaxed">
            <b>编号校验未通过，无法保存：</b>{codeError}。请修改编号后重新保存。
          </span>
        </div>
      )}

      {/* history / timeline 页签可切到时间轴视图；人物关系可切到关系图 */}
      {viewMode === 'graph' ? (
        tab.id === 'faction-rels' ? <FactionGraph rows={rows} onNavigate={onNavigate} /> : <RelationGraph rows={rows} />
      ) : viewMode === 'storyline' && tab.id === 'foreshadow' ? (
        <StorylineView />
      ) : viewMode === 'timeline' && tab.id === 'history' ? (
        <HistoryTimeline rows={rows} tab={tab} calendars={calendars} />
      ) : viewMode === 'timeline' && tab.id === 'timeline' ? (
        <StoryTimeline rows={rows} tab={tab} calendars={calendars} />
      ) : tab.id === 'relations' ? (
        /* ============ 人物关系：按人物分组的文件夹视图（实现已拆到 TableRelationGroups） ============ */
        <TableRelationGroups tab={tab} model={model} ctx={ctx} />
      ) : (
        <>
      {/* 表格 */}
      <div className="rounded-xl border border-ink-700 bg-ink-850 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-12 table-fixed" style={{ width: totalWidth || undefined, minWidth: '100%' }}>
            <thead>
              <tr className="bg-ink-800 border-b border-ink-700">
                <th className="w-10 px-2 py-2.5 align-middle text-ink-500 text-10 font-medium">#</th>
                <th className="w-7 px-1 py-2.5 align-middle" />
                {tab.columns!.filter(col => !col.hidden).map(col => (
                  <th key={col.name} className="px-3 py-2 align-middle text-left text-ink-200 font-semibold whitespace-nowrap relative" style={{ width: widthOf(col.name) }}>
                    <div className="truncate">{col.name}</div>
                    {col.type === 'select' && col.options ? (
                      <select
                        value={colFilters[col.name] ?? ''}
                        onChange={e => setColFilters(prev => ({ ...prev, [col.name]: e.target.value }))}
                        className="mt-1 w-full text-10 px-1 py-0.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 outline-none focus:border-amber/40"
                      >
                        <option value="">全部</option>
                        {/* 与行内下拉同口径：内置（去隐藏/应用改名）+ 用户自定义项 */}
                        {filterOptionsOf(col).map(opt => (
                          <option key={opt} value={opt}>{SABC_LABELS[opt] ?? opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={colFilters[col.name] ?? ''}
                        onChange={e => setColFilters(prev => ({ ...prev, [col.name]: e.target.value }))}
                        placeholder="筛选"
                        className="mt-1 w-full text-10 px-1.5 py-0.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 placeholder:text-ink-600 outline-none focus:border-amber/40"
                      />
                    )}
                    <div
                      onMouseDown={e => onResizeStart(e, col.name)}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-amber/30 transition-colors"
                      title="拖拽调整列宽"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/50">
              {(rows.length === 0 || bodyRows.length === 0) && (
                <tr>
                  <td colSpan={tab.columns!.filter(c => !c.hidden).length + 2} className="px-4 py-16 text-center text-ink-500">
                    <div className="flex flex-col items-center gap-2">
                      <Plus size={20} className="text-ink-600" />
                      <span>{rows.length === 0 ? (isMaster ? '各卷台账还没有章节，去左侧各卷「章节台账」表录入即可在此汇总显示' : '还没有记录，点击右上角「新增一行」开始') : '没有符合筛选条件的记录'}</span>
                    </div>
                  </td>
                </tr>
              )}
              {bodyRows.map((entry, i) => (
                <TableSheetRow
                  key={entry.row.id}
                  tab={tab}
                  model={model}
                  entry={entry}
                  index={i}
                  onNavigate={onNavigate}
                  ctx={ctx}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}

      {/* 底部提示 */}
      {tab.tips && tab.tips.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber/20 bg-amber/5 p-4 space-y-1.5">
          {tab.tips.map((tip, i) => (
            <div key={i} className="text-12 text-amber/80 leading-relaxed flex items-start gap-2">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      )}

      {dirtyKeys.length > 0 && !isMaster && (
        <SaveFab onClick={saveAll} label={`保存 ${dirtyKeys.length} 行修改`} />
      )}

      {showFill && (
        <AITemplateFill
          fields={tableFields}
          title={`AI 补全 · ${tab.name}`}
          sketchPlaceholder="例如：北境最大的商盟，掌控三条主干商路，与皇室关系微妙，暗中资助主角……"
          onSubmit={handleFill}
          onClose={() => setShowFill(false)}
        />
      )}

      {fillRow && (
        <AITemplateFill
          fields={tableFields}
          existing={fillRow.data}
          title={`AI 补全本行空白 · ${tab.name}`}
          sketchPlaceholder="补充这一行已填内容的背景 / 细节，让 AI 补全其余空白字段（已填的不会动）…"
          onSubmit={values => handleFillRow(fillRow, values)}
          onClose={() => setFillRow(null)}
        />
      )}

      {showOrganize && (
        <AIOrganize
          tab={tab}
          existing={sortedRows.map(r => r.data)}
          calendars={calendars}
          ctx={ctx}
          onAdd={handleOrganize}
          onClose={() => setShowOrganize(false)}
        />
      )}
      {showFeedbackAI && (
        <FeedbackAIPanel rows={rows.map(r => r.data)} onClose={() => setShowFeedbackAI(false)} />
      )}
      {showDedupAI && (
        <TermDedupPanel rows={rows.map(r => r.data)} onClose={() => setShowDedupAI(false)} />
      )}
    </div>
  )
}


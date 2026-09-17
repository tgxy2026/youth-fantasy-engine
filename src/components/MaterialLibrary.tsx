import { useState, useMemo } from 'react'
import { Search, ChevronDown } from 'lucide-react'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import {
  type Block,
  type CharType,
  type ComboItem,
  type RoleItem,
  type TagGroup,
  type AttrItem,
  type ToolboxSection,
} from '../lib/materialRef'
import { MATERIAL_CATEGORIES } from '../lib/materialData'

export default function MaterialLibrary() {
  const [catId, setCatId] = useState(MATERIAL_CATEGORIES[0].id)
  const cat = MATERIAL_CATEGORIES.find(c => c.id === catId) ?? MATERIAL_CATEGORIES[0]
  const [blockId, setBlockId] = useState(cat.blocks[0].id)
  const activeBlock = cat.blocks.find(b => b.id === blockId) ?? cat.blocks[0]

  return (
    <div className="w-full page-enter">
      <header className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">素材资料</h1>
          <span className="text-[12px] text-ink-400">内置写作参考素材库 · 只读</span>
          <HelpPopover title="素材资料怎么用" side="right">
            {'这里是一份\u300c只读\u300d的写作参考，卡壳时翻一翻：\n\n· 五类素材：人物设计 / 故事结构 / 世界框架 / 情绪爽点 / 描写笔法；\n· 上方切换分类，左侧选条目，右侧读全文；\n· 内容为内置素材，不能编辑 —— 想沉淀属于你自己作品的设定，' +
              '请用「世界构建」「创作管理」下的正式表格（它们才会进 AI 的上下文）。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-[13px] text-ink-300">
          收录可直接借鉴的写作参考（人物设计 / 故事结构 / 世界框架 / 情绪爽点 / 描写笔法）；内容仅供阅读，不支持编辑。
        </p>
      </header>

      {/* 分类子页签：点开素材资料后出现，类似灵感工具下的子页签（灵感启发 / 检查工具 / 素材资料） */}
      <div className="flex gap-1 flex-wrap mb-3">
        {MATERIAL_CATEGORIES.map(c => (
          <Button
            key={c.id}
            variant="toggle"
            shape="pill"
            size="sm"
            selected={c.id === catId}
            onClick={() => { setCatId(c.id); setBlockId(c.blocks[0].id) }}
          >
            {c.name}
          </Button>
        ))}
      </div>

      {/* 板块页签（分类内） */}
      <div className="flex gap-1 flex-wrap mb-4">
        {cat.blocks.map(b => (
          <Button
            key={b.id}
            variant="toggle"
            size="sm"
            selected={b.id === activeBlock.id}
            onClick={() => setBlockId(b.id)}
          >
            {b.title}
          </Button>
        ))}
      </div>

      <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
        <BlockView block={activeBlock} />
      </div>
    </div>
  )
}

function BlockView({ block }: { block: Block }) {
  return renderBlock(block)
}

function renderBlock(block: Block) {
  switch (block.kind) {
    case 'charGrid': return <CharGrid types={block.data as CharType[]} />
    case 'list': return <NumberedList items={block.data as string[]} />
    case 'combo': return <ComboList items={block.data as ComboItem[]} />
    case 'table': return <TableView data={block.data as { head: string[]; rows: string[][] }} />
    case 'tagGroups': return <TagGroups groups={block.data as TagGroup[]} />
    case 'attrs': return <AttrList items={block.data as AttrItem[]} />
    case 'roles': return <RoleList items={block.data as RoleItem[]} />
    case 'groupedList': return <GroupedList data={block.data as { groups: { title: string; items: { name: string; text: string }[] }[] }} />
    case 'toolbox': return <Toolbox sections={block.data as ToolboxSection[]} />
    case 'mixed': return <MixedView blocks={block.data as Block[]} />
    default: return <div className="text-ink-400 text-[13px]">未知板块类型</div>
  }
}

/* ---------- 复合页签：内部多个子区块，各自保留原生排版 ---------- */
function MixedView({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-6">
      {blocks.map((b, i) => (
        <div key={b.id ?? i}>
          <div className="text-[13px] font-semibold text-ink-100 mb-3 pb-1.5 border-b border-ink-700">{b.title}</div>
          {renderBlock(b)}
        </div>
      ))}
    </div>
  )
}

/* ---------- 性格类型卡片网格 ---------- */
function CharGrid({ types }: { types: CharType[] }) {
  const [gender, setGender] = useState<'all' | '女' | '男'>('all')
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return types.filter(t => {
      if (gender !== 'all' && t.gender !== gender) return false
      if (!kw) return true
      const hay = [t.name, t.tagline, ...t.fit, ...t.dims.map(d => d.value + d.label)]
        .join(' ').toLowerCase()
      return hay.includes(kw)
    })
  }, [types, gender, q])

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1">
          {(['all', '女', '男'] as const).map(g => (
            <Button
              key={g}
              variant="toggle"
              shape="pill"
              size="sm"
              selected={gender === g}
              onClick={() => setGender(g)}
            >
              {g === 'all' ? '全部' : g}
            </Button>
          ))}
        </div>
        <div className="relative ml-auto" style={{ minWidth: 220 }}>
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索类型名 / 适配定位 / 关键词…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-ink-950 border border-ink-700 text-ink-200 text-[12px] outline-none focus:border-amber placeholder:text-ink-600"
          />
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="text-center text-ink-500 text-[13px] py-10">没有匹配「{q}」的性格类型</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.map(t => {
          const open = expanded === t.id
          return (
            <div
              key={t.id}
              className="bg-ink-800 border border-ink-700 rounded-lg overflow-hidden"
            >
              <button
                onClick={() => setExpanded(open ? null : t.id)}
                className="w-full text-left px-3.5 py-3 flex items-start justify-between gap-2 hover:bg-ink-800/60 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink-50">{t.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-700 text-ink-300">{t.gender}</span>
                  </div>
                  <div className="text-[11px] text-ink-400 mt-0.5">{t.tagline}</div>
                </div>
                <ChevronDown
                  size={15}
                  className={`shrink-0 text-ink-500 transition-transform duration-200 mt-1 ${open ? '' : '-rotate-90'}`}
                />
              </button>

              <div className="flex flex-wrap gap-1 px-3.5 pb-2.5">
                {t.fit.map(f => (
                  <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-amber/10 text-amber border border-amber/20">
                    {f}
                  </span>
                ))}
              </div>

              {open && (
                <div className="px-3.5 pb-3.5 pt-1 border-t border-ink-700">
                  {t.dims.map(d => (
                    <div key={d.label} className="flex gap-2.5 py-1.5">
                      <span className="w-[68px] shrink-0 text-[11px] text-amber/90 font-medium">{d.label}</span>
                      <span className="text-[12px] leading-relaxed text-ink-200">{d.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 text-[11px] text-ink-500">
        共 {types.length} 个类型 · 当前显示 {filtered.length} 个 · 点卡片展开 9 维详情
      </div>
    </div>
  )
}

/* ---------- 编号列表 ---------- */
function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3">
          <span className="shrink-0 w-5 h-5 rounded-full bg-amber/15 text-amber text-[11px] flex items-center justify-center mt-0.5">
            {i + 1}
          </span>
          <span className="text-[13px] leading-relaxed text-ink-200">{it}</span>
        </li>
      ))}
    </ol>
  )
}

/* ---------- 混搭组合 ---------- */
function ComboList({ items }: { items: ComboItem[] }) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 text-[13px] bg-ink-800 border border-ink-700 rounded-lg px-3.5 py-2.5">
          <span className="px-2 py-0.5 rounded bg-ink-700 text-ink-100">{it.a}</span>
          <span className="text-ink-500">×</span>
          <span className="px-2 py-0.5 rounded bg-ink-700 text-ink-100">{it.b}</span>
          <span className="text-ink-500">=</span>
          <span className="px-2 py-0.5 rounded bg-amber/10 text-amber border border-amber/20">{it.result}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------- 表格 ----------
 * 列式标准（素材资料全局统一）：
 *  - 采用 table-fixed 布局，列宽由首行/colgroup 决定，不再随内容浮动；
 *  - 首列（键/标签列）统一锁定 160px 定宽，保证所有表格首列视觉对齐、不再参差；
 *  - 其余列均分剩余宽度（table-fixed 下未指定宽度的列等分剩余空间）。 */
function TableView({ data }: { data: { head: string[]; rows: string[][] } }) {
  const restCols = Math.max(data.head.length - 1, 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-[12px]">
        <colgroup>
          <col style={{ width: '160px' }} />
          {Array.from({ length: restCols }).map((_, i) => (
            <col key={i} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-ink-800">
            {data.head.map((h, i) => (
              <th key={i} className={`text-left font-medium text-ink-200 px-3 py-2 border-b border-ink-700 ${i === 0 ? 'whitespace-nowrap' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, ri) => (
            <tr key={ri} className={`hover:bg-ink-800/60 ${ri % 2 === 1 ? 'bg-ink-800/30' : ''}`}>
              {r.map((c, ci) => (
                <td key={ci} className={`px-3 py-2 border-b border-ink-700/60 align-top break-words ${ci === 0 ? 'text-ink-100 font-medium' : 'text-ink-300'}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- 标签分组云 ---------- */
function TagGroups({ groups }: { groups: TagGroup[] }) {
  return (
    <div className="space-y-4">
      {groups.map(g => (
        <div key={g.group}>
          <div className="text-[12px] font-medium text-ink-100 mb-2">{g.group}</div>
          <div className="flex flex-wrap gap-1.5">
            {g.tags.map(t => (
              <span key={t} className="text-[12px] px-2.5 py-1 rounded-full bg-ink-800 border border-ink-700 text-ink-200">
                {t}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------- 萌属性 ---------- */
function AttrList({ items }: { items: AttrItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={i} className="bg-ink-800 border border-ink-700 rounded-lg px-3.5 py-3">
          <div className="text-[13px] font-semibold text-amber mb-1">{it.name}</div>
          <div className="text-[12px] leading-relaxed text-ink-200">{it.desc}</div>
        </div>
      ))}
    </div>
  )
}

/* ---------- 故事功能角色 ---------- */
function RoleList({ items }: { items: RoleItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={i} className="flex gap-3">
          <span className="shrink-0 w-5 h-5 rounded-full bg-amber/15 text-amber text-[11px] flex items-center justify-center mt-0.5">
            {i + 1}
          </span>
          <div>
            <div className="text-[13px] font-semibold text-ink-100">{it.name}</div>
            <div className="text-[12px] leading-relaxed text-ink-300 mt-0.5">{it.desc}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------- 分组列表（补充类型） ---------- */
function GroupedList({ data }: { data: { groups: { title: string; items: { name: string; text: string }[] }[] } }) {
  return (
    <div className="space-y-5">
      {data.groups.map(g => (
        <div key={g.title}>
          <div className="text-[12px] font-medium text-ink-100 mb-2 pb-1 border-b border-ink-700">{g.title}</div>
          <div className="space-y-2.5">
            {g.items.map((it, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-[12px] font-medium text-amber w-[7.5rem]">{it.name}</span>
                <span className="text-[12px] leading-relaxed text-ink-200">{it.text}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------- 工具箱 ---------- */
function Toolbox({ sections }: { sections: ToolboxSection[] }) {
  return (
    <div className="space-y-5">
      {sections.map((s, i) => (
        <div key={i}>
          <div className="text-[13px] font-semibold text-ink-100 mb-2">{s.title}</div>
          {s.formula && (
            <div className="bg-amber/10 border border-amber/25 rounded-lg px-3.5 py-2.5 text-[12px] leading-relaxed text-amber mb-2">
              {s.formula}
            </div>
          )}
          {s.example && (
            <div className="text-[12px] leading-relaxed text-ink-300 mb-2 pl-3 border-l-2 border-ink-700">
              例：{s.example}
            </div>
          )}
          {s.items && (
            <div className="space-y-2">
              {s.items.map((it, j) => (
                <div key={j} className="flex gap-2 text-[12px] leading-relaxed text-ink-200">
                  {it.label
                    ? <span className="shrink-0 text-ink-100 font-medium w-[6.5rem]">{it.label}</span>
                    : <span className="shrink-0 text-amber/80">·</span>}
                  <span>{it.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

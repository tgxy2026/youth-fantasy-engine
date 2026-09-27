/**
 * 地图编辑的展示件（2026-09-19 从 GeoMapEditor.tsx 抽出，D4 组件拆分收尾）。
 * 纯搬家：7 个组件语句一字未改，只给被主文件直接渲染的 4 件补了 export；
 * MapInfoModal / Field / LinkedListItem 仍是本文件内部件，不外泄。
 */
import { foldVh } from '../lib/theme'
import { useEffect, useMemo, useState } from 'react'
import { Layers, Plus, Trash2, ExternalLink, MapPin, Eraser, Pencil } from 'lucide-react'
import * as db from '../lib/db'
import type { TableRow } from '../lib/types'
import { uid } from '../lib/id'
import { showToast, confirmDialog } from './dialogs'
import CustomSelect from './CustomSelect'
import { Modal } from './Modal'
import { Button } from './Button'
import { LAYER_COLORS, type Marker, type Linked } from './geoMapGeometry'

/** 「绘制地图」选择弹窗：按「层级归属」缩进展示所有地理范围，提醒从最大范围开始绘制 */
/**
 * 左侧地图列表（多地图 · 方案 B）。
 *
 * 每张地图 = 一块独立画布（各自坐标系 + 格子档位），通过《地理风物》的「所属地图」把地点挂上去。
 * 🔴 删除地图**不删地点数据**：把它们退回第一张地图，作者可再指派 —— 地图只是「呈现方式」。
 */
export function GeoMapList({ maps, mapId, onPick, rowCountOf, onChanged, disabled }: {
  maps: TableRow[]
  mapId: string
  onPick: (id: string) => void
  rowCountOf: (name: string) => number
  onChanged: () => void
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  /** 弹窗意图：新建 / 重命名（null = 关闭） */
  const [ask, setAsk] = useState<{ mode: 'add' | 'rename'; target?: TableRow } | null>(null)

  const submitName = async (name: string, note: string) => {
    const intent = ask
    setAsk(null)
    if (!intent) return
    if (maps.some(m => (m.data['名称'] || '') === name && m.id !== intent.target?.id)) {
      showToast('已有同名地图，换个名字', 'error')
      return
    }
    setBusy(true)
    try {
      if (intent.mode === 'add') {
        await db.saveTableRow({
          id: uid(), projectId: db.getCurrentProjectId(), tabId: 'geomaps', order: maps.length,
          data: { '编号': '', '名称': name, '每格公里': '1', '说明': note },
        })
        showToast('已新建地图「' + name + '」', 'success')
      } else if (intent.target) {
        const old = intent.target.data['名称'] || ''
        // ⚠️ 名称是《地理风物》「所属地图」的引用值：改名必须连带改归属，否则那些地点会集体从画布上消失
        await db.saveTableRow({ ...intent.target, data: { ...intent.target.data, '名称': name, '说明': note } })
        for (const r of await db.getTableRows('geography')) {
          if ((r.data['所属地图'] || '') === old) {
            await db.saveTableRow({ ...r, data: { ...r.data, '所属地图': name } })
          }
        }
        showToast('已改名为「' + name + '」', 'success')
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const delMap = async (m: TableRow) => {
    if (maps.length <= 1) {
      showToast('至少要保留一张地图', 'error')
      return
    }
    const name = m.data['名称'] || ''
    const n = rowCountOf(name)
    if (!await confirmDialog({
      title: '删除地图',
      message: n > 0
        ? '「' + name + '」上有 ' + n + ' 个地点。删除地图不会删除地点数据 —— 它们会退回第一张地图，可再次指派。确定删除？'
        : '确定删除空地图「' + name + '」？',
      danger: true,
    })) return
    setBusy(true)
    try {
      const fallback = maps.find(x => x.id !== m.id)?.data['名称'] || ''
      for (const r of await db.getTableRows('geography')) {
        if ((r.data['所属地图'] || '') === name) {
          await db.saveTableRow({ ...r, data: { ...r.data, '所属地图': fallback } })
        }
      }
      await db.deleteTableRow(m.id)
      showToast('已删除「' + name + '」', 'success')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="w-40 shrink-0 border-r border-ink-700 flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-ink-700 shrink-0">
        <Layers size={12} className="text-amber" />
        <span className="text-11 font-medium text-ink-200">地图</span>
        <button type="button" disabled={disabled || busy} onClick={() => setAsk({ mode: 'add' })}
          title="新建一张独立画布"
          className="ml-auto inline-flex items-center justify-center h-6 w-6 rounded-md border border-ink-700 text-ink-300 hover:text-amber hover:border-amber/40 disabled:opacity-40 transition-colors">
          <Plus size={11} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {maps.map(m => {
          const nm = m.data['名称'] || '未命名'
          const on = m.id === mapId
          return (
            <div key={m.id}
              className={'group flex items-center gap-0.5 rounded-md border px-1.5 py-1 transition-colors ' + (on ? 'border-amber/40 bg-amber/15' : 'border-ink-700 hover:border-ink-600')}>
              <button type="button" onClick={() => onPick(m.id)}
                title={'切到「' + nm + '」（' + rowCountOf(nm) + ' 个地点）'}
                className={'flex-1 min-w-0 text-left text-11 truncate ' + (on ? 'text-amber' : 'text-ink-300')}>
                {nm}
                <span className="ml-1 text-10 text-ink-500">{rowCountOf(nm)}</span>
              </button>
              <button type="button" disabled={busy} onClick={() => setAsk({ mode: 'rename', target: m })}
                title="地图信息：改名称与说明（改名会连带更新地点的归属）"
                className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded text-ink-500 opacity-0 group-hover:opacity-100 hover:text-amber transition-opacity">
                <Pencil size={10} />
              </button>
              <button type="button" disabled={busy} onClick={() => void delMap(m)}
                title="删除这张地图（地点不会被删，会退回第一张图）"
                className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded text-ink-500 opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity">
                <Trash2 size={10} />
              </button>
            </div>
          )
        })}
      </div>
      <MapInfoModal
        open={!!ask}
        title={ask?.mode === 'add' ? '新建地图' : '地图信息'}
        name={ask?.mode === 'rename' ? (ask.target?.data['名称'] || '') : ''}
        note={ask?.mode === 'rename' ? (ask.target?.data['说明'] || '') : ''}
        onSubmit={(n, d) => void submitName(n, d)}
        onCancel={() => setAsk(null)}
      />
    </aside>
  )
}

/**
 * 地图信息弹窗（新建 / 编辑共用）：名称 + 说明两个字段。
 * 说明会显示在地图编辑页右侧面板（非编辑状态下），故编辑入口放在这里，与改名同一处。
 */
function MapInfoModal({ open, title, name, note, onSubmit, onCancel }: {
  open: boolean; title: string; name: string; note: string
  onSubmit: (name: string, note: string) => void; onCancel: () => void
}) {
  const [n, setN] = useState(name)
  const [d, setD] = useState(note)
  useEffect(() => { if (open) { setN(name); setD(note) } }, [open, name, note])
  if (!open) return null
  return (
    <Modal open onClose={onCancel} title={title} icon={<MapPin size={16} />} width={440}>
      <div className="space-y-3">
        <Field label="地图名称">
          <input autoFocus value={n} onChange={e => setN(e.target.value)}
            placeholder="如：九州大陆图 / 王城平面图"
            className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50" />
        </Field>
        <Field label="地图说明（显示在右侧面板）">
          <textarea value={d} onChange={e => setD(e.target.value)} rows={5}
            placeholder="这张图画的是哪片区域、有哪些约定、画到哪一步了…"
            className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-12 text-ink-100 outline-none focus:border-amber/50 resize-y leading-relaxed" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onCancel} variant="secondary" size="md">取消</Button>
          <Button onClick={() => { if (n.trim()) onSubmit(n.trim(), d.trim()) }} disabled={!n.trim()}
            variant="bare"
            className="px-3 py-1.5 rounded-md bg-amber/20 text-amber border border-amber/40 text-12 hover:bg-amber/30 disabled:opacity-40 transition-colors">
            保存
          </Button>
        </div>
        <p className="text-10 text-ink-500 leading-relaxed">
          改名会连带更新《地理风物》里地点的「所属地图」，不会丢数据。
        </p>
      </div>
    </Modal>
  )
}

/**
 * 「绘制地图」选择器。
 *
 * 🔴 旧实现的树是**按深度排序**（`.sort((a,b) => a.depth - b.depth)`）—— 那会把父子拆散：
 *    同一层的所有节点被排到一起，父与子不相邻，看起来完全不成树。
 *    现改为按父子关系做 DFS，保证**每棵子树连续**。
 */
export function DrawDialog({ rows, drawnCells, onPick, onClose }: {
  rows: TableRow[]; drawnCells: Map<string, number>
  onPick: (id: string) => void; onClose: () => void
}) {
  const [q, setQ] = useState('')

  /** DFS 展开成有序列表（子树连续），每项带 depth 与已画格数 */
  const tree = useMemo(() => {
    const byName = new Map<string, TableRow>()
    for (const r of rows) byName.set(r.data['名称'] || '', r)
    const children = new Map<string, TableRow[]>()
    for (const r of rows) {
      const p = r.data['层级归属'] || ''
      const key = p && byName.has(p) && p !== (r.data['名称'] || '') ? p : ''
      const arr = children.get(key) ?? []
      arr.push(r)
      children.set(key, arr)
    }
    const out: { id: string; name: string; category: string; depth: number; drawn: number }[] = []
    const walk = (parent: string, depth: number) => {
      if (depth > 12) return
      for (const r of children.get(parent) ?? []) {
        const nm = r.data['名称'] || '(未命名)'
        out.push({ id: r.id, name: nm, category: r.data['类别'] || '区域', depth, drawn: drawnCells.get(r.id) ?? 0 })
        walk(nm, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [rows, drawnCells])

  /** 搜索：命中的条目 + 其**祖先链**（保住层级上下文，否则搜出来的子项看不出归属） */
  const items = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return tree
    const keep = new Set<number>()
    tree.forEach((it, idx) => {
      if (!it.name.toLowerCase().includes(kw) && !it.category.toLowerCase().includes(kw)) return
      keep.add(idx)
      // 向上找祖先：DFS 序里，它之前最近的 depth 更小的节点即其父
      let d = it.depth
      let i = idx - 1
      while (d > 0 && i >= 0) {
        if (tree[i].depth < d) { keep.add(i); d = tree[i].depth }
        i--
      }
    })
    return tree.filter((_, i) => keep.has(i))
  }, [q, tree])

  return (
    <Modal
      open
      onClose={onClose}
      title="绘制地图 · 选择一个地理范围"
      icon={<Pencil size={16} />}
      width={460}
      maxHeight="80vh"
      bodyClassName="p-0"
    >
      <div className="px-3 pt-3 pb-2 border-b border-ink-700">
        <input autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder="搜索地点名称或类别…"
          className="w-full bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-12 text-ink-100 outline-none focus:border-amber/50" />
        <div className="mt-2 text-10 text-ink-500 leading-relaxed">
          建议<strong className="text-amber">从最大的范围开始画</strong>（大陆 → 区域 → 城市），后画的叠在先画的之上。
          共 {tree.length} 个地点{q.trim() ? '，匹配 ' + items.length + ' 个' : ''}。
        </div>
      </div>
      <div className="overflow-y-auto p-1.5"
style={{ maxHeight: foldVh('52vh') }}>
        {items.length === 0 && (
          <div className="text-center text-ink-500 text-12 py-6">
            {tree.length === 0 ? '《地理风物》还没有条目，请先去登记。' : '没有匹配「' + q.trim() + '」的地点。'}
          </div>
        )}
        {items.map(it => (
          <button type="button" key={it.id} onClick={() => onPick(it.id)} title={'绘制「' + it.name + '」'}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-ink-800 transition-colors text-left">
            <span className="shrink-0" style={{ width: it.depth * 14 }} />
            {it.depth > 0 && <span className="shrink-0 text-10 text-ink-600">└</span>}
            <span className="text-12 text-ink-100 truncate">{it.name}</span>
            <span className="shrink-0 text-10 text-ink-500">{it.category}</span>
            {it.drawn > 0
              ? <span className="ml-auto shrink-0 text-10 text-success/90">已画 {it.drawn} 格</span>
              : <span className="ml-auto shrink-0 text-10 text-ink-600">未画</span>}
          </button>
        ))}
      </div>
    </Modal>
  )
}

export function AddMarkerForm({ categories, parentOptions, onCancel, onCreate }: {
  categories: string[]; parentOptions: string[];
  onCancel: () => void; onCreate: (name: string, category: string, parent: string) => void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(categories[1] ?? categories[0] ?? '区域')
  const [parent, setParent] = useState('')
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-ink-100 font-medium"><Plus size={14} className="text-amber" /> 就地新增地理范围</div>
      <Field label="名称"><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && name.trim()) onCreate(name, category, parent) }} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50" placeholder="如：南荒秘境" /></Field>
      <Field label="类别（可在下拉里新增自定义类别）">
        <CustomSelect tabId="geography" colName="类别" options={categories} value={category} onChange={setCategory} />
      </Field>
      <Field label="层级归属（可选，父级区域；选后会被包进其父框）">
        <select value={parent} onChange={e => setParent(e.target.value)} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50">
          <option value="">（无 / 顶级）</option>
          {parentOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      <div className="flex gap-2 pt-1">
        <Button variant="bare" disabled={!name.trim()} onClick={() => onCreate(name, category, parent)} className="flex-1 px-3 py-1.5 rounded-md bg-amber/20 text-amber border border-amber/40 text-12 hover:bg-amber/30 disabled:opacity-40 transition-colors">新增地点</Button>
        <Button onClick={onCancel} variant="secondary" size="md">取消</Button>
      </div>
      <p className="text-10 text-ink-500 leading-relaxed">新增后会同时出现在《地理风物》里，其余字段（地貌、势力归属、行程时间等）可到表格补全。</p>
    </div>
  )
}

export function DetailPanel({ marker, linked, cells, categories, parentOptions, painting, onPatch, onClearPainted, onPaint, onDelete, onGotoTable }: {
  marker: Marker; linked: Linked | undefined; cells: number; categories: string[]; parentOptions: string[];
  painting: boolean; onPatch: (patch: Record<string, string>) => void; onClearPainted: () => void; onPaint: () => void; onDelete: () => void; onGotoTable: () => void
}) {
  const [name, setName] = useState(marker.name)
  const [category, setCategory] = useState(marker.category)
  const [parent, setParent] = useState(marker.parent)
  useEffect(() => { setName(marker.name); setCategory(marker.category); setParent(marker.parent) }, [marker])

  const commit = (patch: Record<string, string>) => onPatch(patch)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-ink-100 font-medium"><MapPin size={14} className="text-amber" /> {marker.name}</div>
      <div className="text-11 text-ink-400">当前形状：<span className="text-amber">{cells} 格</span>{painting && <span className="text-ink-500">（绘制中：左键涂/擦 · 右键退出）</span>}</div>
      <Button onClick={onPaint}
        disabled={painting} variant="primary" size="md" className="w-full flex items-center justify-center">
        <Pencil size={12} /> {cells > 0 ? '继续绘制此范围' : '绘制此范围'}
      </Button>
      <Field label="名称"><input value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== marker.name && commit({ '名称': name.trim() })} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50" /></Field>
      <Field label="类别（可在下拉里新增自定义类别）">
        <CustomSelect
          tabId="geography" colName="类别" options={categories} value={category}
          onChange={v => { setCategory(v); commit({ '类别': v }) }}
        />
      </Field>
      <Field label="层级归属（父级区域；选后会被包进其父框）">
        <select value={parent} onChange={e => { setParent(e.target.value); commit({ '层级归属': e.target.value }) }} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50">
          <option value="">（无 / 顶级）</option>
          {parentOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      <Button variant="bare" onClick={() => commit({ '地图格子': '' })} title="清掉这个范围画好的所有格子，《地理风物》档案保留" className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-ink-700 text-12 text-ink-200 hover:text-amber hover:border-amber/40 transition-colors"><Eraser size={12} /> 清空此范围的绘制</Button>
      <Button onClick={onGotoTable} variant="secondary" size="md" className="w-full flex items-center justify-center"><ExternalLink size={12} /> 在《地理风物》中编辑</Button>

      {/* 关联列表 */}
      {linked && (linked.foreshadow.length > 0 || linked.character.length > 0 || linked.timeline.length > 0) && (
        <div className="pt-1 space-y-2">
          <div className="text-11 text-ink-500 uppercase tracking-wider">关联（按「地理位置」字段联动）</div>
          {linked.foreshadow.length > 0 && <LinkedList title="伏笔" color={LAYER_COLORS.foreshadow} items={linked.foreshadow.map(r => r.data['伏笔内容'] || r.data['编号'] || '（未命名）')} />}
          {linked.character.length > 0 && <LinkedList title="角色" color={LAYER_COLORS.character} items={linked.character.map(r => r.name)} />}
          {linked.timeline.length > 0 && <LinkedList title="时间脉络" color={LAYER_COLORS.timeline} items={linked.timeline.map(r => `${r.data['章节标题'] || r.data['章节号'] || ''}：${r.data['重要人物位置与状态'] || ''}`)} />}
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-ink-700">
        <Button onClick={onClearPainted} title="清掉这个范围画好的所有格子，《地理风物》档案保留" variant="danger" size="md" className="flex-1 flex items-center justify-center text-11"><Eraser size={11} /> 清空绘制</Button>
        <Button onClick={onDelete} title="连《地理风物》档案一起删除，不可撤销" variant="danger" size="md" className="flex-1 flex items-center justify-center text-11"><Trash2 size={11} /> 删除地点</Button>
      </div>
      <p className="text-10 text-ink-500 leading-relaxed">「清空绘制」= 只擦掉画好的格子，档案保留；「删除地点」= 《地理风物》条目连档案一起删除，不可撤销。</p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-11 text-ink-400 mb-1">{label}</div>
      {children}
    </label>
  )
}

function LinkedListItem({ title, color, items }: { title: string; color: string; items: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-11 text-ink-300 mb-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />{title}（{items.length}）</div>
      <ul className="space-y-0.5 pl-3.5">
        {items.slice(0, 12).map((it, i) => <li key={i} className="text-11 text-ink-400 truncate" title={it}>{it}</li>)}
        {items.length > 12 && <li className="text-11 text-ink-600">…还有 {items.length - 12} 条</li>}
      </ul>
    </div>
  )
}
const LinkedList = LinkedListItem

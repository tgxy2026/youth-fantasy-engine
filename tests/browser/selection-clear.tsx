import { useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import TableRefSelect from '@/components/sheets/TableRefSelect'
import CustomSelect from '@/components/common/CustomSelect'
import CharacterSelect from '@/components/world/CharacterSelect'
import AtlasCellInput from '@/components/atlas/AtlasCellInput'
import type { ResolvedAtlasField } from '@/lib/atlas/types'
import { setCurrentProject, saveCardRecord, addCustomItem, getCustomOptions } from '@/lib/db'
import '@/index.css'

const projectId = 'selection-clear-fixture'
setCurrentProject(projectId)
const names = ['候选甲', '候选乙'], none: string[] = []
const ctx = { type: 'full' as const, features: [] }
const field: ResolvedAtlasField = { key: 'cf_fixture', label: '图鉴多选', source: 'custom', customType: 'multiSelect',
  groupId: 'fixture', order: 1, appliesTo: '*', tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true, options: names }
let submits = 0
declare global {
  interface Window { __selectionClear: { catalogue(): ReturnType<typeof getCustomOptions>; submits(): number } }
}
window.__selectionClear = { catalogue: () => getCustomOptions('fixture', '类别'), submits: () => submits }
function Section({ name, value, children }: { name: string; value: string; children: ReactNode }) {
  return <section aria-label={name} className="w-full min-w-0 rounded border border-ink-600 p-3 space-y-2">
    <h2>{name}</h2>{children}<output data-value={value}>{value || '空值'}</output>
  </section>
}
function Fixture() {
  const [multi, setMulti] = useState('候选甲'), [single, setSingle] = useState('旧的手动输入')
  const [empty, setEmpty] = useState(''), [custom, setCustom] = useState('已删除选项')
  const [sibling, setSibling] = useState('共享自定义'), [fixed, setFixed] = useState('S')
  const [characters, setCharacters] = useState('已有角色，已删除角色')
  const [atlas, setAtlas] = useState('["候选甲","旧手动标签","候选乙"]')
  const [fallback, setFallback] = useState(''), [configured, setConfigured] = useState(false)
  return <form onSubmit={e => { e.preventDefault(); submits++ }} className="max-w-xl mx-auto p-3 space-y-4 text-ink-100">
    <Section name="引用多选" value={multi}><TableRefSelect value={multi} onChange={setMulti} refTabId="fixture" refCol="名称" options={names} multi /></Section>
    <Section name="引用单选" value={single}><TableRefSelect value={single} onChange={setSingle} refTabId="fixture" refCol="名称" options={names} /></Section>
    <Section name="空候选" value={empty}><TableRefSelect value={empty} onChange={setEmpty} refTabId="fixture" refCol="名称" options={none} multi /></Section>
    <Section name="可扩展选项" value={custom}><CustomSelect tabId="fixture" colName="类别" options={names} value={custom} onChange={setCustom} /></Section>
    <Section name="同列其他字段" value={sibling}><CustomSelect tabId="fixture" colName="类别" options={names} value={sibling} onChange={setSibling} /></Section>
    <Section name="固定档位" value={fixed}><CustomSelect tabId="fixture" colName="保密等级" options={['S', 'A']} value={fixed} onChange={setFixed} fixedOptions /></Section>
    <Section name="角色引用" value={characters}><CharacterSelect value={characters} onChange={setCharacters} ctx={ctx} multi /></Section>
    <Section name="图鉴多选" value={atlas}><AtlasCellInput field={field} value={atlas} onChange={setAtlas} /></Section>
    <Section name="图鉴补配候选" value={fallback}><AtlasCellInput field={{ ...field, options: configured ? names : none }} value={fallback} onChange={setFallback} />
      <button type="button" onClick={() => setConfigured(true)}>加载候选</button></Section>
  </form>
}
async function main() {
  await saveCardRecord({ id: 'selection-clear-character', projectId, tabId: 'char-main', name: '已有角色', data: {}, order: 0 })
  await addCustomItem('fixture', '类别', '共享自定义')
  createRoot(document.getElementById('fixture-root')!).render(<Fixture />)
}
void main()

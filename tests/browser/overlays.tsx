import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import { Button } from '../../src/components/common/Button'
import { Modal } from '../../src/components/dialogs/Modal'
import CustomSelect from '../../src/components/common/CustomSelect'
import CalendarPicker from '../../src/components/common/CalendarPicker'
import HelpPopover from '../../src/components/common/HelpPopover'
import CalendarSelect from '../../src/components/common/CalendarSelect'
import CharacterSelect from '../../src/components/world/CharacterSelect'
import TableRefSelect from '../../src/components/sheets/TableRefSelect'
import { confirmDialog } from '../../src/components/dialogs/dialogs'

initializeAppearance()
const payload = { items: [], hidden: [] }
const calendars = [{ name: '测试历', value: 365 }]
const context = { type: 'full' as const, features: [] }
const references = ['宗门甲', '宗门乙']

function Fixture() {
  const nested = new URLSearchParams(location.search).has('nested')
  const [parent, setParent] = useState(nested)
  const [child, setChild] = useState(nested)
  const [locked, setLocked] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [value, setValue] = useState('甲')
  const [date, setDate] = useState('')
  const closeParent = () => { setParent(false); setChild(false) }
  return <main style={{ padding: 24 }}>
    <Button onClick={() => setParent(true)}>打开父弹窗</Button>
    <Button onClick={() => setHidden(true)}>打开隐藏标题弹窗</Button>
    <HelpPopover title="页面帮助" pin><Button onClick={() => setParent(true)}>从页面帮助打开父弹窗</Button></HelpPopover>
    <Modal open={parent} onClose={closeParent} title="父弹窗" width="xl">
      <div style={{ display: 'grid', gap: 16 }}>
        <CustomSelect tabId="fixture" colName="选项" options={['甲', '乙']} value={value} onChange={setValue} fixedOptions payload={payload} />
        <CalendarPicker value={date} onChange={setDate} />
        <CalendarSelect calendars={calendars} value="测试历" onChange={() => {}} />
        <CharacterSelect value="" onChange={() => {}} ctx={context} />
        <TableRefSelect value="" onChange={() => {}} refTabId="fixture" refCol="名称" options={references} placeholder="选择宗门" />
        <CustomSelect tabId="fixture" colName="可编辑选项" options={['丙']} value="丙" onChange={() => {}} payload={payload} />
        <HelpPopover title="浮层帮助" pin><Button onClick={() => { setLocked(false); setChild(true) }}>从帮助打开子弹窗</Button></HelpPopover>
        <Button onClick={() => { setLocked(false); setChild(true) }}>打开子弹窗</Button>
        <Button onClick={() => { setLocked(true); setChild(true) }}>打开禁止Esc的子弹窗</Button>
        <Button onClick={() => void confirmDialog({ title: '独立确认', message: '验证独立 React 根的层级与焦点' })}>打开独立确认</Button>
        <input aria-label="父弹窗输入" />
        <output aria-label="选项结果">{value}</output>
      </div>
      <Modal open={child} onClose={() => setChild(false)} title="子弹窗" closeOnEsc={!locked}>
        <input aria-label="子弹窗输入" />
        <HelpPopover title="子层帮助" pin>这里是子弹窗帮助。</HelpPopover>
      </Modal>
    </Modal>
    <Modal open={hidden} onClose={() => setHidden(false)} hideHeader title="隐藏标题检索">
      <input aria-label="隐藏标题输入" />
      <Button onClick={() => setHidden(false)}>关闭检索</Button>
    </Modal>
  </main>
}

createRoot(document.getElementById('fixture-root')!).render(<Fixture />)

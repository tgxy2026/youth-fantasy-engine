// Isolated real-browser fixture. Not imported by the application or included in release assets.
import { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import DensityControl from '../../src/components/settings/DensityControl'
import { Button } from '../../src/components/common/Button'
import Panel from '../../src/components/common/Panel'
import PageHeader from '../../src/components/common/PageHeader'
import { useRowWindow } from '../../src/components/sheets/useRowWindow'

initializeAppearance()

function VirtualRows() {
  const ids = useMemo(() => Array.from({ length: 300 }, (_, i) => `fixture-${i}`), [])
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useRowWindow({ ids, rowRefs, scrollRef, enabled: true, estimate: 36 })
  return <div ref={scrollRef} data-fixture-scroll style={{ height: 240, overflow: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
      <tr aria-hidden style={{ height: rows.topPad }}><td colSpan={2} /></tr>
      {ids.slice(rows.start, rows.end).map(id => <tr key={id} data-fixture-row={id} ref={node => { rowRefs.current[id] = node }}>
        <td>{id}</td><td><Button size="sm">行操作</Button></td>
      </tr>)}
      <tr aria-hidden style={{ height: rows.bottomPad }}><td colSpan={2} /></tr>
    </tbody></table>
  </div>
}

function Fixture() {
  const [second, setSecond] = useState(true)
  return <main style={{ padding: 24, maxWidth: 900, margin: 'auto' }}>
    <PageHeader title="外观交互夹具" description="仅合成界面，不访问书库或模型。" />
    <Panel><DensityControl />{second && <DensityControl />}
      <Button onClick={() => setSecond(v => !v)}>{second ? '暂时关闭第二组设置' : '重新打开第二组设置'}</Button>
      <Button variant="primary" size="md">示例主操作</Button>
      <Button variant="bare">内容型操作</Button>
      <textarea aria-label="正文排版样本" className="novel-textarea" style={{ fontSize: 23 }} defaultValue="这段正文的字号与密度无关。" />
    </Panel>
    <VirtualRows />
  </main>
}

createRoot(document.getElementById('fixture-root')!).render(<Fixture />)

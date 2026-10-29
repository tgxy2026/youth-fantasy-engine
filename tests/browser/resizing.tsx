import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import { useResizable } from '../../src/lib/app/useResizable'
import ResizeHandle from '../../src/components/common/ResizeHandle'
import { Button } from '../../src/components/common/Button'

initializeAppearance()
function Pane() {
  const pane = useResizable({ key: 'fixture-panel-width', initial: 240, min: 160, max: 420 })
  return <div style={{ display: 'flex', height: 320, margin: 24 }}>
    <section style={{ width: pane.size, position: 'relative', flexShrink: 0 }}>
      <p>面板内容</p><output aria-label="宽度">{pane.size}</output><output aria-label="拖拽状态">{String(pane.dragging)}</output>
      <ResizeHandle pane={pane} label="测试分栏宽度" />
    </section>
    <article style={{ flex: 1, background: 'rgb(var(--ink-850))', padding: 24 }}>正文保留原生选择和滚动。<textarea aria-label="正文内容" defaultValue="不可改变的稿件" /></article>
  </div>
}
function Fixture() {
  const [show, setShow] = useState(true)
  return <><Button onClick={() => setShow(value => !value)}>切换挂载</Button>{show && <Pane />}</>
}
createRoot(document.getElementById('fixture-root')!).render(<Fixture />)

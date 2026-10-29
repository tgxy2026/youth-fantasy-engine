import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import ErrorBoundary from '../../src/components/common/ErrorBoundary'
import { Button } from '../../src/components/common/Button'
import { Modal } from '../../src/components/dialogs/Modal'

initializeAppearance()
function Fault({ broken }: { broken: boolean }) {
  if (broken) {
    const primitive = new URLSearchParams(location.search).get('primitive')
    // Deliberately exercise JavaScript's non-Error thrown values.
    if (primitive === 'null') throw null
    if (primitive === 'empty') throw ''
    const error = new TypeError('故障注入-仅夹具 private-manuscript apiKey=private-token')
    error.stack = 'TypeError: private-manuscript apiKey=private-token\n at render (C:\\Users\\private-user\\projects\\FailureFixture.tsx:15:9)'
    throw error
  }
  return <p>当前页面重试成功</p>
}
function Fixture() {
  const inModal = new URLSearchParams(location.search).has('modal')
  const [broken, setBroken] = useState(!inModal)
  return <><Button onClick={() => setBroken(false)}>修复夹具故障条件</Button><ErrorBoundary>
    {inModal ? <Modal open onClose={() => {}} title="故障前模态">
      <Button onClick={() => setBroken(true)}>触发模态内渲染故障</Button><Fault broken={broken} />
    </Modal> : <Fault broken={broken} />}
  </ErrorBoundary></>
}
createRoot(document.getElementById('fixture-root')!).render(<Fixture />)

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import StorageWriteStatus from '@/components/common/StorageWriteStatus'
import {DesktopDataBar} from '@/components/app/Desktop'
import {PortableDataBar} from '@/components/app/Portable'
import {WebDataBar} from '@/components/app/Web'
import type { StorageWriteFacts } from '@/lib/app/storageWriteStatus'
import '@/index.css'

let writes = 0
declare global {
  interface Window {
    __storageStatusProbe: { update(facts: StorageWriteFacts): void; writes(): number }
  }
}
function Fixture() {
  const [facts,setFacts]=useState<StorageWriteFacts>({connected:false,dirty:false,saving:false,lastError:'',lastSavedAt:0})
  window.__storageStatusProbe={update:setFacts,writes:()=>writes}
  return <main className="max-w-full p-4 bg-surface-app min-h-screen">
    <section aria-label="存储状态测试" className="w-52 max-w-full p-2 bg-surface-panel border border-line-subtle">
      <StorageWriteStatus facts={facts} onSave={()=>writes++} title="当前隔离测试存储，点击保存" />
    </section>
    <input aria-label="仍可编辑的草稿" defaultValue="未提交的测试输入" />
    <section data-status-adapter="desktop" className="w-56 max-w-full"><DesktopDataBar /></section>
    <section data-status-adapter="portable" className="w-56 max-w-full"><PortableDataBar /></section>
    <section data-status-adapter="web" className="w-56 max-w-full"><WebDataBar /></section>
  </main>
}
createRoot(document.getElementById('fixture-root')!).render(<Fixture />)

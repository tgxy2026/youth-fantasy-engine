import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AtlasDetail from '../../src/components/atlas/AtlasDetail'
const field = { key:'名称', label:'名称', source:'builtin', builtinType:'text', groupId:'basic', order:0, tableVisible:true, detailVisible:true, searchable:true, aiReadable:true, aiWritable:false, appliesTo:'*' }
const row = { id:'a', projectId:'p', tabId:'races', data:{名称:'原名'}, order:0, createdAt:0 }
function Fixture() {
  const [value,setValue]=useState('原名')
  const [dirty,setDirty]=useState(false)
  const save=()=>new Promise<boolean>(resolve=>{
    const host = window as unknown as { finishSave: (ok: boolean) => void; saveCount?: number }
    host.finishSave=(ok:boolean)=>{ if(ok) setDirty(false); resolve(ok) }; host.saveCount=(host.saveCount||0)+1
  })
  return <AtlasDetail tabId="races" row={row as never} nameKey="名称" badges={[]} sections={[{id:'basic',label:'基础',fields:[field]}] as never}
    overlay={false} onClose={()=>{}} onEditInTable={()=>{}} onImageChange={()=>{}}
    cellValue={()=>value} onCellChange={(_key,v)=>{setValue(v);setDirty(true)}} dirty={dirty} onSave={save}/>
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)

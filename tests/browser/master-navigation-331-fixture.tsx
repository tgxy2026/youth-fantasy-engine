import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useMasterRecordNavigation } from '../../src/components/common/useMasterRecordNavigation'
const host = window as unknown as { resolveSelection: (ok: boolean) => void; selectionCount: number }
function Fixture() {
  const [selected,setSelected]=useState('a')
  const [ids,setIds]=useState(['a','b','c'])
  const select=(id:string,valid:()=>boolean)=>new Promise<boolean>(resolve=>{
    host.selectionCount=(host.selectionCount||0)+1
    host.resolveSelection=ok=>{const accepted=ok&&valid();if(accepted)setSelected(id);resolve(accepted)}
  })
  const key=useMasterRecordNavigation(ids,select,()=>true)
  return <><button onClick={()=>setIds(['a','c'])}>筛掉 b</button><input aria-label="输入框" />
    <div data-master-scroll style={{height:100,overflow:'auto'}}>{ids.map(id=><button key={id} data-master-choice={id}
      aria-pressed={selected===id} onKeyDown={event=>key(event,id)}>{id}</button>)}</div></>
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)

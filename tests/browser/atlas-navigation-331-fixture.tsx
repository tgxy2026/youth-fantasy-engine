import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AtlasView from '../../src/components/atlas/AtlasView'
import { getTab } from '../../src/lib/schema'
const rows=['甲','乙','丙'].map((name,i)=>({id:`row${i+1}`,projectId:'fixture',tabId:'races',order:i,data:{编号:`R000${i+1}`,名称:name,类别:'人族'},createdAt:0,updatedAt:i,...(i===0?{atlasImage:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx2cAAAAASUVORK5CYII=',mime:'image/png',width:1,height:1,bytes:68}}:{})}))
function Fixture(){
  const [drafts,setDrafts]=useState<Record<string,string>>({})
  const [filtered,setFiltered]=useState(false)
  return <><button onClick={()=>setFiltered(true)}>筛掉乙</button><AtlasView projectId="fixture" tab={getTab('races')!} rows={(filtered?rows.filter(r=>r.id!=='row2'):rows) as never} onEditInTable={()=>{}}
    cellValue={(row,key)=>key==='名称' ? drafts[row.id]??row.data[key] : row.data[key]??''}
    onCellChange={(id,key,v)=>{if(key==='名称')setDrafts(prev=>({...prev,[id]:v}))}}
    dirtyOf={id=>drafts[id]!==undefined} onSave={async()=>false} onRevert={()=>{}}
    onSaveImage={()=>new Promise<void>(resolve=>{(window as unknown as {finishImage: () => void}).finishImage=resolve})} /></>
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)

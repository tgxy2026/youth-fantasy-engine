import assert from 'node:assert/strict'
import * as db from '../src/lib/db'
import { candidateApplyContext } from '../src/lib/ai/candidateContext'
import { createTableImageWriter } from '../src/lib/atlas/writeImage'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'
import { saveAtlasSchema } from '../src/lib/atlas/persistence'
import type { AtlasImage } from '../src/lib/atlas/types'
import type { TableRow } from '../src/lib/types'
import { KEY_PATHS, memoryOps } from './mock-memory'
import type { StoreOps } from '../src/lib/storage/storeOps'

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes});return {promise,resolve}}
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
function backend(readPause?:Promise<void>,writePause?:Promise<void>){
  const records=new Map<string,unknown>(),writes:Array<{store:string;value:unknown}>=[]
  const ops:StoreOps={...memoryOps,
    get:async<T>(store:string,key:string)=>{if(store==='settingsKV'&&readPause)await readPause;return records.get(store+':'+key) as T|undefined},
    put:async(store,value)=>{if(store==='tableRows'&&writePause)await writePause;writes.push({store,value});records.set(store+':'+String((value as Record<string,unknown>)[KEY_PATHS[store]??'id']),value)},
  }
  return {records,writes,ops}
}
const row:TableRow={id:'same-id',projectId:'owner-a',tabId:'races',data:{名称:'original'},order:1}
const image:AtlasImage={dataUrl:'data:image/png;base64,aXNvbGF0ZWQ=',mime:'image/png',width:1,height:1,bytes:8}
let passed=0
async function test(name:string,fn:()=>void|Promise<void>){await fn();passed++;console.log('PASS '+name)}
await test('a retained image callback rejects replacement before reading a same-ID row from a new backend',async()=>{
  const old=backend(),next=backend();db.setStoreOps(old.ops);db.setCurrentProject('owner-a')
  const context=candidateApplyContext();let reads=0,receipts=0
  let rows=[row]
  const write=createTableImageWriter({projectId:'owner-a',tabId:'races',current:()=>context===candidateApplyContext(),
    read:()=>{reads++;return rows},committed:()=>{receipts++}})
  db.setStoreOps(next.ops);rows=[{...row,data:{名称:'new private library'}}]
  await assert.rejects(write(row.id,image),/上下文已改变/)
  assert.equal(reads,0);assert.equal(receipts,0);assert.equal(old.writes.length,0);assert.equal(next.writes.length,0)
})
await test('a late image receipt cannot update the replacement owner while an issued write stays on its original store',async()=>{
  const pause=deferred(),old=backend(undefined,pause.promise),next=backend();db.setStoreOps(old.ops);db.setCurrentProject('owner-a')
  const context=candidateApplyContext();let receipts=0
  const write=createTableImageWriter({projectId:'owner-a',tabId:'races',current:()=>context===candidateApplyContext(),read:()=>[row],committed:()=>{receipts++}})
  const pending=write(row.id,image);await settle();db.setStoreOps(next.ops);pause.resolve()
  await assert.rejects(pending,/上下文已改变/);await settle()
  assert.equal(old.writes.filter(w=>w.store==='tableRows').length,1);assert.equal(next.writes.length,0);assert.equal(receipts,0)
})
await test('normal image replace/remove preserves row fields and emits a receipt only after real storage success',async()=>{
  const store=backend();db.setStoreOps(store.ops);db.setCurrentProject('owner-a');let current=row,receipts=0
  const write=createTableImageWriter({projectId:'owner-a',tabId:'races',current:()=>true,read:()=>[current],committed:value=>{current=value;receipts++}})
  await write(row.id,image);assert.equal(current.atlasImage,image);assert.equal(current.data,row.data)
  await write(row.id,null);assert.equal('atlasImage' in current,false);assert.equal(receipts,2)
  assert.equal(store.writes.filter(w=>w.store==='tableRows').length,2);assert.equal('atlasImage' in row,false)
})
for(const invalid of ['missing','project','tab','empty'] as const)await test(`invalid image target ${invalid} never writes or falsely succeeds`,async()=>{
  const store=backend();db.setStoreOps(store.ops);db.setCurrentProject('owner-a')
  const rows=invalid==='missing'?[]:[{...row,projectId:invalid==='project'?'other':row.projectId,tabId:invalid==='tab'?'items':row.tabId}]
  const write=createTableImageWriter({projectId:invalid==='empty'?'':'owner-a',tabId:'races',current:()=>true,read:()=>rows,committed:()=>{throw Error('unexpected receipt')}})
  await assert.rejects(write(row.id,image));assert.equal(store.writes.length,0)
})
const optionActions=[
  ()=>db.addCustomItem('races','类别','new'),()=>db.hideBuiltinItem('races','类别','alpha'),
  ()=>db.restoreBuiltinItem('races','类别','hidden'),()=>db.renameBuiltinItem('races','类别','old','new'),
  ()=>db.removeCustomItem('races','类别','alpha'),
]
for(const [index,action] of optionActions.entries())for(const replace of [false,true])await test(`option mutation ${index} keeps its read/write owner across ${replace?'backend':'project'} replacement`,async()=>{
  const pause=deferred(),old=backend(pause.promise),next=backend()
  old.records.set('settingsKV:customOption::owner-a::races::类别',{key:'customOption::owner-a::races::类别',value:{items:['alpha'],hidden:['hidden'],renamed:{old:'alias'}}})
  db.setStoreOps(old.ops);db.setCurrentProject('owner-a');const pending=action();await settle()
  if(replace)db.setStoreOps(next.ops);else db.setCurrentProject('owner-b')
  pause.resolve()
  if(replace)await assert.rejects(pending,/存储或账号已改变/)
  else {await pending;assert.equal((old.writes[0].value as {key:string}).key,'customOption::owner-a::races::类别')}
  assert.equal(next.writes.length,0);if(replace)assert.equal(old.writes.length,0)
})
for(const replace of [false,true])await test(`schema read/write retains original ownership across ${replace?'backend':'project'} replacement`,async()=>{
  const pause=deferred(),old=backend(pause.promise),next=backend();db.setStoreOps(old.ops);db.setCurrentProject('owner-a')
  const pending=saveAtlasSchema('owner-a','races',emptyAtlasSchema());await settle()
  if(replace)db.setStoreOps(next.ops);else db.setCurrentProject('owner-b');pause.resolve()
  if(replace)await assert.rejects(pending,/上下文已改变/)
  else {await pending;assert.equal((old.writes[0].value as {key:string}).key,'owner-a::atlasSchema::races')}
  assert.equal(next.writes.length,0);if(replace)assert.equal(old.writes.length,0)
})
db.setStoreOps(memoryOps);db.setCurrentProject('')
console.log(`${passed} groups passed`)

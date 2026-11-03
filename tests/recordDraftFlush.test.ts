import assert from 'node:assert/strict'
import { createRecordDraftFlusher } from '../src/lib/editor/recordDraftFlush'
import * as db from '../src/lib/db'
import { touchProject } from '../src/lib/db/core'
import type { CardRecord } from '../src/lib/types'
import type { StoreOps } from '../src/lib/storage/storeOps'
import { memoryOps } from './mock-memory'

const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r});return {resolve,promise} }
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
let count=0
const check=async(name:string,run:()=>void|Promise<void>)=>{await run();count++;console.log('PASS '+name)}
await check('local save and page leave serialize and write the latest draft after a slow older write',async()=>{
  const first=deferred<void>();let draft={id:'a',body:'old'},dirty=true,concurrent=0,maxConcurrent=0,authoritative=''
  const writes:string[]=[]
  const flush=createRecordDraftFlusher({current:()=>true,read:()=>({record:draft,dirty}),
    write:async value=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);writes.push(value.body);if(writes.length===1)await first.promise;authoritative=value.body;concurrent--},
    saved:value=>{if(value===draft)dirty=false},
  })
  const local=flush();await settle();draft={id:'a',body:'new'};const leave=flush();await settle()
  assert.deepEqual(writes,['old']);first.resolve();assert.ok((await local).ok);assert.ok((await leave).ok)
  assert.deepEqual(writes,['old','new']);assert.equal(authoritative,'new');assert.equal(maxConcurrent,1);assert.equal(dirty,false)
})
await check('a failed queued write neither marks saved nor poisons a later explicit retry',async()=>{
  let attempts=0,dirty=true,saved=0
  const flush=createRecordDraftFlusher({current:()=>true,read:()=>({record:{id:'a'},dirty}),write:async()=>{if(++attempts===1)throw Error('fixture')},saved:()=>{saved++;dirty=false}})
  const first=await flush();assert.equal(first.ok,false);if(!first.ok)assert.equal(first.scope,'record')
  assert.equal(saved,0);assert.equal(dirty,true);assert.ok((await flush()).ok);assert.equal(saved,1)
})
await check('unmounted or replaced owners reject queued work and never start a second late write',async()=>{
  const first=deferred<void>();let owned=true,writes=0,saved=0
  const flush=createRecordDraftFlusher({current:()=>owned,read:()=>({record:{id:'a'},dirty:true}),write:async()=>{writes++;await first.promise},saved:()=>{saved++}})
  const active=flush();await settle();const queued=flush();owned=false;first.resolve()
  assert.equal((await active).ok,false);assert.equal((await queued).ok,false);assert.equal(writes,1);assert.equal(saved,0)
})
await check('a clean queued job performs no redundant write after the preceding job saved it',async()=>{
  let dirty=true,writes=0
  const flush=createRecordDraftFlusher({current:()=>true,read:()=>({record:{id:'a'},dirty}),write:async()=>{writes++},saved:()=>{dirty=false}})
  await Promise.all([flush(),flush(),flush()]);assert.equal(writes,1)
})
function storeFixture(block?:{store:string;wait:Promise<void>}) {
  const records=new Map<string,unknown>(),writes:Array<{store:string;value:unknown}>=[]
  const store:StoreOps={...memoryOps,
    get:async<T>(name:string,key:string)=>{if(block?.store===name)await block.wait;return records.get(name+':'+key) as T|undefined},
    put:async(name,value)=>{writes.push({store:name,value});records.set(name+':'+(value as {id:string}).id,value)},
  }
  return {store,records,writes}
}
await check('legacy card timestamp lookup and its project touch stay on the original backend and project',async()=>{
  const pause=deferred<void>(),old=storeFixture({store:'cardRecords',wait:pause.promise}),next=storeFixture()
  old.records.set('cardRecords:card',{id:'card',createdAt:17});old.records.set('projects:project-a',{id:'project-a',updatedAt:1})
  next.records.set('projects:project-b',{id:'project-b',updatedAt:1})
  db.setStoreOps(old.store);db.setCurrentProject('project-a')
  const record:CardRecord={id:'card',tabId:'chapter-outline',name:'fixture',data:{},order:0,projectId:'project-a'}
  const save=db.saveCardRecord(record);await settle()
  db.setStoreOps(next.store);db.setCurrentProject('project-b');pause.resolve();await save;await settle()
  const got=old.records.get('cardRecords:card') as CardRecord
  assert.equal(got.projectId,'project-a');assert.equal(got.createdAt,17);assert.equal(next.writes.length,0)
  assert.ok(old.writes.some(write=>write.store==='projects'&&(write.value as {id:string}).id==='project-a'))
})
await check('project metadata reads cannot resume into a replaced backend either',async()=>{
  const pause=deferred<void>(),old=storeFixture({store:'projects',wait:pause.promise}),next=storeFixture()
  old.records.set('projects:project-a',{id:'project-a',updatedAt:1})
  db.setStoreOps(old.store);const touch=touchProject('project-a');await settle();db.setStoreOps(next.store)
  pause.resolve();await touch;assert.equal(next.writes.length,0);assert.equal(old.writes.length,1)
})
console.log('recordDraftFlush '+count+' passed')

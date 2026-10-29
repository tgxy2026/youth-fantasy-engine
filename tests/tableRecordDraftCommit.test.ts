import assert from 'node:assert/strict'
import { commitTableDrafts, type DraftMap } from '../src/components/sheets/tableSheetDraftOps'
import { createRecordDraftFlusher } from '../src/lib/editor/recordDraftFlush'
import type { TableRow } from '../src/lib/types'

const row=(id:string,data:Record<string,string>):TableRow=>({id,projectId:'owner',tabId:'races',data,order:0})
let passed=0
const test=async(name:string,fn:()=>void|Promise<void>)=>{await fn();passed++;console.log('PASS '+name)}
await test('a receipt commits submitted cells while retaining newer cells rows and unrelated drafts',()=>{
  const rows=[row('a',{name:'old',note:'old note'}),row('b',{name:'other'})]
  const submitted={a:{name:'submitted',note:'submitted note'}},current={a:{name:'newer',note:'submitted note',extra:'new'},b:{name:'new row edit'}}
  const before=JSON.stringify({rows,current,submitted}),result=commitTableDrafts(rows,current,submitted)
  assert.deepEqual(result.rows[0].data,{name:'submitted',note:'submitted note'})
  assert.deepEqual(result.drafts,{a:{name:'newer',extra:'new'},b:{name:'new row edit'}})
  assert.equal(result.rows[1],rows[1]);assert.equal(JSON.stringify({rows,current,submitted}),before)
})
await test('returning to the original value during an old write remains a real pending edit',()=>{
  const result=commitTableDrafts([row('a',{name:'original'})],{a:{name:'original'}},{a:{name:'in flight'}})
  assert.equal(result.rows[0].data.name,'in flight');assert.equal(result.drafts.a.name,'original')
})
await test('matched cells become clean without resurrecting deleted records',()=>{
  const result=commitTableDrafts([row('a',{name:'old'})],{a:{name:'new'},gone:{name:'deleted'}},{a:{name:'new'},gone:{name:'deleted'}})
  assert.equal(result.rows.length,1);assert.deepEqual(result.drafts,{})
})
await test('manual and leave saves serialize snapshots and persist the newer draft last',async()=>{
  let release!:()=>void
  const pause=new Promise<void>(resolve=>{release=resolve})
  let rows=[row('a',{name:'old'})],drafts:DraftMap={a:{name:'first'}}
  const writes:string[]=[]
  const flush=createRecordDraftFlusher({current:()=>true,
    read:()=>({record:{rows,drafts},dirty:Object.keys(drafts).length>0}),
    write:async snapshot=>{writes.push(snapshot.drafts.a.name);if(writes.length===1)await pause},
    saved:snapshot=>{const result=commitTableDrafts(rows,drafts,snapshot.drafts);rows=result.rows;drafts=result.drafts} })
  const manual=flush();for(let i=0;i<5;i++)await Promise.resolve()
  drafts={a:{name:'latest'}};const leave=flush();release()
  assert.equal((await manual).ok,true);assert.equal((await leave).ok,true)
  assert.deepEqual(writes,['first','latest']);assert.equal(rows[0].data.name,'latest');assert.deepEqual(drafts,{})
})
console.log(`${passed} groups passed`)

import assert from 'node:assert/strict'
import * as db from '../src/lib/db'
import { captureCandidateOwner } from '../src/lib/ai/candidateContext'
import type { StoreOps } from '../src/lib/storage/storeOps'
import { KEY_PATHS, memoryOps } from './mock-memory'

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve()}
function backend(pause?:{store:string;promise:Promise<void>}){
  const data=new Map<string,unknown>(),writes:Array<{store:string;value:unknown}>=[]
  const ops:StoreOps={...memoryOps,
    get:async<T>(store:string,key:string)=>data.get(`${store}:${key}`) as T|undefined,
    put:async(store,value)=>{
      if(pause?.store===store)await pause.promise
      writes.push({store,value});const key=String((value as Record<string,unknown>)[KEY_PATHS[store]??'id'])
      data.set(`${store}:${key}`,value)
    },
  }
  for(const id of ['owner-a','owner-b'])data.set('projects:'+id,{id,updatedAt:1})
  return {ops,data,writes}
}
let passed=0
const test=async(name:string,fn:()=>void|Promise<void>)=>{await fn();passed++;console.log('PASS '+name)}
const row={id:'row',tabId:'races',projectId:'owner-a',data:{名称:'isolated'},order:0}
await test('explicit table ownership controls the project touch even when another project is active',async()=>{
  const old=backend();db.setStoreOps(old.ops);db.setCurrentProject('owner-b')
  await db.saveTableRow(row);await settle()
  assert.equal((old.writes.find(w=>w.store==='tableRows')?.value as typeof row).projectId,'owner-a')
  assert.deepEqual(old.writes.filter(w=>w.store==='projects').map(w=>(w.value as {id:string}).id),['owner-a'])
  assert.equal((old.data.get('projects:owner-b') as {updatedAt:number}).updatedAt,1)
})
await test('a delayed table put and subsequent touch stay on their original backend and project',async()=>{
  const pause=deferred(),old=backend({store:'tableRows',promise:pause.promise}),next=backend()
  db.setStoreOps(old.ops);db.setCurrentProject('owner-a')
  const pending=db.saveTableRow({...row,projectId:''});await settle()
  db.setCurrentProject('owner-b');db.setStoreOps(next.ops);pause.resolve();await pending;await settle()
  assert.equal((old.writes.find(w=>w.store==='tableRows')?.value as typeof row).projectId,'owner-a')
  assert.deepEqual(old.writes.filter(w=>w.store==='projects').map(w=>(w.value as {id:string}).id),['owner-a'])
  assert.equal(next.writes.length,0)
})
for(const explicit of [false,true])await test(`${explicit?'explicit':'current'} form write retains its original key, store and touch after a delayed put`,async()=>{
  const pause=deferred(),old=backend({store:'formData',promise:pause.promise}),next=backend()
  db.setStoreOps(old.ops);db.setCurrentProject(explicit?'owner-b':'owner-a')
  const pending=explicit?db.saveFormDataFor('owner-a','positioning',{field:'draft'}):db.saveFormData('positioning',{field:'draft'})
  await settle();db.setStoreOps(next.ops);db.setCurrentProject('owner-b');pause.resolve();await pending;await settle()
  assert.equal((old.writes.find(w=>w.store==='formData')?.value as {tabId:string}).tabId,'owner-a::positioning')
  assert.deepEqual(old.writes.filter(w=>w.store==='projects').map(w=>(w.value as {id:string}).id),['owner-a'])
  assert.equal(next.writes.length,0)
})
await test('rejected writes do not touch another project or hide their failure',async()=>{
  const old=backend();let touches=0
  db.setStoreOps({...old.ops,put:async(store)=>{if(store==='projects'){touches++;return}throw Error('isolated failure')}})
  db.setCurrentProject('owner-a')
  await assert.rejects(db.saveTableRow(row),/isolated failure/)
  await assert.rejects(db.saveFormData('positioning',{}),/isolated failure/)
  await assert.rejects(db.saveFormDataFor('owner-a','positioning',{}),/isolated failure/)
  await settle();assert.equal(touches,0)
})
await test('A to B to A invalidates an old candidate owner even when the active project ID matches again',()=>{
  db.setCurrentProject('owner-a');const old=captureCandidateOwner()
  assert.equal(old.current(),true)
  db.setCurrentProject('owner-b');db.setCurrentProject('owner-a')
  assert.equal(old.current(),false);assert.equal(old.projectId,'owner-a')
})
await test('same-project assignment is idempotent while backend replacement invalidates ownership',()=>{
  db.setCurrentProject('owner-a');const old=captureCandidateOwner(),epoch=db.getProjectContextEpoch()
  db.setCurrentProject('owner-a');assert.equal(db.getProjectContextEpoch(),epoch);assert.equal(old.current(),true)
  db.setStoreOps(backend().ops);assert.equal(old.current(),false)
})
await test('same-project account replacement invalidates ownership and empty projects never authorize writes',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window')
  const testWindow=Object.assign(new EventTarget(),{__YFE_USER__:{id:'identity-a'}})
  Object.defineProperty(globalThis,'window',{configurable:true,value:testWindow})
  try{
    db.setCurrentProject('owner-a');const old=captureCandidateOwner()
    assert.equal(old.current(),true);testWindow.__YFE_USER__={id:'identity-b'};assert.equal(old.current(),false)
    db.setCurrentProject('');assert.equal(captureCandidateOwner().current(),false)
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window')}
})
db.setStoreOps(memoryOps);db.setCurrentProject('')
console.log(`${passed} groups passed`)
